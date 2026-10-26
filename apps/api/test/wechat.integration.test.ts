import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/app.factory.js';
import { parseEnvironment } from '../src/config/environment.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { AuthAdapter } from '../src/auth/adapter/auth-adapter.js';
import { WechatService } from '../src/wechat/wechat.service.js';
import { AppError } from '../src/common/app-error.js';
import type { WechatAdapter } from '../src/wechat/wechat-adapter.js';
import { testDatabaseUrl } from './database-url.js';

const runId = randomUUID();
const origin = 'http://localhost:5173';
const appId = `test-${runId}`;
const scenes: string[] = [];
const adapter: WechatAdapter = {
  async exchangeCode(code) {
    if (code === 'invalid')
      throw new AppError(401, 'WECHAT_CODE_INVALID', 'invalid');
    return { appId, openid: `${runId}-${code}`, unionid: 'private-unionid' };
  },
  async createMiniappCode(scene) {
    scenes.push(scene);
    return 'test-adapter-image-only';
  },
};
let app: NestExpressApplication;
let database: PrismaService;
const userIds = new Set<string>();
const qrIds: string[] = [];
function post(path: string) {
  return request(app.getHttpServer()).post(path).set('Origin', origin);
}
function secretCookie(response: { headers: Record<string, unknown> }) {
  return z
    .array(z.string())
    .parse(response.headers['set-cookie'])
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}
async function qr(purpose = 'login') {
  const id = randomUUID();
  qrIds.push(id);
  const result = await post('/api/v1/auth/qr-requests')
    .send({ id, purpose })
    .expect(201);
  return {
    id,
    cookie: secretCookie(result),
    scene: z.string().parse(scenes.at(-1)),
  };
}
async function resolve(scene: string, code: string) {
  const result = await post('/api/v1/auth/qr-requests/resolve')
    .send({ scene, code })
    .expect(200);
  return z
    .object({ data: z.object({ id: z.uuid(), scannerProof: z.string() }) })
    .parse(result.body).data;
}
async function confirm(id: string, scannerProof: string) {
  return post(`/api/v1/auth/qr-requests/${id}/confirm`)
    .send({ scannerProof })
    .expect(200);
}
async function login(code: string) {
  const result = await post('/api/v1/auth/wechat/login')
    .send({ code })
    .expect(200);
  const id = z
    .object({ data: z.object({ user: z.object({ id: z.uuid() }) }) })
    .parse(result.body).data.user.id;
  userIds.add(id);
  return {
    id,
    result,
    token: z.string().parse(result.headers['set-auth-token']),
  };
}

beforeAll(async () => {
  app = await createApp(
    parseEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: testDatabaseUrl(),
      AUTH_BASE_URL: 'http://localhost:3000',
      WEB_BASE_URL: origin,
      AUTH_TRUSTED_ORIGINS: `${origin},http://localhost:3000`,
      BETTER_AUTH_SECRET:
        'integration-test-only-secret-with-at-least-32-characters',
      MAIL_TRANSPORT: 'file',
      MAIL_PREVIEW_DIR: '.local/test-wechat-mail',
      MAIL_FROM: 'Dayline <noreply@example.com>',
    }),
    adapter,
  );
  await app.init();
  database = app.get(PrismaService);
});
afterAll(async () => {
  try {
    if (database) {
      const identities = await database.wechatIdentity.findMany({
        where: { appId },
        select: { userId: true },
      });
      identities.forEach((identity) => userIds.add(identity.userId));
      await database.qrRequest.deleteMany({ where: { id: { in: qrIds } } });
      await database.user.deleteMany({ where: { id: { in: [...userIds] } } });
    }
  } finally {
    await app?.close();
  }
});

describe('wechat identity and QR with real PostgreSQL and HTTP', () => {
  it('converges concurrent first logins, keeps unverified internal email private and requires a signed session', async () => {
    const logins = await Promise.all(
      Array.from({ length: 6 }, () => login('concurrent')),
    );
    expect(new Set(logins.map((value) => value.id)).size).toBe(1);
    const first = z
      .object({ id: z.string(), token: z.string() })
      .parse(logins[0]);
    expect(
      await database.wechatIdentity.count({
        where: { appId, openid: `${runId}-concurrent` },
      }),
    ).toBe(1);
    const user = await database.user.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(user).toMatchObject({ emailKind: 'internal', emailVerified: false });
    for (const value of logins) {
      expect(value.result.body.data.user).toMatchObject({
        email: null,
        emailVerified: false,
        passwordEnabled: false,
        wechatBound: true,
      });
      expect(JSON.stringify(value.result.body)).not.toMatch(
        /identity\.dayline|session_key|openid|unionid|authEpoch|token/,
      );
    }
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${first.token}`)
      .expect(200);
    const raw = decodeURIComponent(first.token).split('.')[0];
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${raw}`)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${first.token}x`)
      .expect(401);
    const native = await request(app.getHttpServer())
      .get('/api/auth/get-session')
      .set('Authorization', `Bearer ${first.token}`)
      .expect(403);
    // Native SDK endpoint is deliberately disabled for internal identities below.
    expect(JSON.stringify(native.body)).not.toMatch(/identity\.dayline/);
  });

  it('rejects failed code and client-supplied identities without creating users', async () => {
    const before = await database.wechatIdentity.count({ where: { appId } });
    await post('/api/v1/auth/wechat/login')
      .send({ code: 'invalid' })
      .expect(401);
    await post('/api/v1/auth/wechat/login')
      .send({ code: 'valid', openid: 'forged' })
      .expect(400);
    await post('/api/auth/create-dayline-session')
      .send({ userId: randomUUID() })
      .expect(404);
    expect(await database.wechatIdentity.count({ where: { appId } })).toBe(
      before,
    );
  });

  it('preserves the internal user ID when adding a verified real email and Better Auth password', async () => {
    const current = await login('email-upgrade');
    const email = `wechat-${runId}@example.com`;
    await app
      .get(AuthAdapter)
      .setVerifiedEmailAndPassword(current.id, email, 'Gate-A-password-24!');
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${current.token}`)
      .expect(401);
    const result = await post('/api/auth/sign-in/email')
      .send({ email, password: 'Gate-A-password-24!' })
      .expect(200);
    expect(result.body.user.id).toBe(current.id);
    const newSession = await login('email-upgrade');
    expect(newSession.id).toBe(current.id);
    expect(newSession.result.body.data.user).toMatchObject({
      email,
      emailVerified: true,
      passwordEnabled: true,
      wechatBound: true,
    });
  });

  it('separates scanning, explicit confirmation and original-browser single consumption', async () => {
    const created = await qr();
    const before = await database.wechatIdentity.count({
      where: { appId, openid: `${runId}-scan-new` },
    });
    const scanned = await resolve(created.scene, 'scan-new');
    expect(
      await database.wechatIdentity.count({
        where: { appId, openid: `${runId}-scan-new` },
      }),
    ).toBe(before);
    await post(`/api/v1/auth/qr-requests/${created.id}/consume`)
      .set('Cookie', created.cookie)
      .send({})
      .expect(409);
    await request(app.getHttpServer())
      .get(`/api/v1/auth/qr-requests/${created.id}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1/auth/qr-requests/${created.id}`)
      .set('Cookie', `dayline_qr_${created.id}=${created.scene}`)
      .expect(404);
    await confirm(created.id, scanned.scannerProof);
    const status = await request(app.getHttpServer())
      .get(`/api/v1/auth/qr-requests/${created.id}`)
      .set('Cookie', created.cookie)
      .expect(200);
    expect(status.body.data.status).toBe('confirmed');
    expect(JSON.stringify(status.body)).not.toMatch(
      /openid|scannerProof|token|email|userId/,
    );
    await post(`/api/v1/auth/qr-requests/${created.id}/consume`)
      .send({ scannerProof: scanned.scannerProof })
      .expect(404);
    const consumes = await Promise.all(
      [0, 1].map(() =>
        post(`/api/v1/auth/qr-requests/${created.id}/consume`)
          .set('Cookie', created.cookie)
          .send({}),
      ),
    );
    expect(consumes.map((value) => value.status).sort()).toEqual([200, 409]);
    const success = consumes.find((value) => value.status === 200);
    if (!success) throw new Error('No successful consume');
    userIds.add(z.string().parse(success.body.data.user.id));
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Cookie', secretCookie(success))
      .expect(200);
    await post(`/api/v1/auth/qr-requests/${created.id}/confirm`)
      .send({ scannerProof: scanned.scannerProof })
      .expect(409);
    await request(app.getHttpServer())
      .delete(`/api/v1/auth/qr-requests/${created.id}`)
      .set('X-Dayline-Scanner-Proof', scanned.scannerProof)
      .expect(409);
  });

  it('locks scanner identity and handles cancellation, expiry and disabled binding without new accounts', async () => {
    const before = await database.wechatIdentity.count({ where: { appId } });
    await post('/api/v1/auth/qr-requests')
      .send({ id: randomUUID(), purpose: 'bind_wechat' })
      .expect(409);
    await post('/api/v1/auth/qr-requests')
      .send({ id: randomUUID(), purpose: 'unknown' })
      .expect(400);
    const created = await qr();
    const scanned = await resolve(created.scene, 'candidate-A');
    await post('/api/v1/auth/qr-requests/resolve')
      .send({ scene: created.scene, code: 'candidate-B' })
      .expect(409);
    await post(`/api/v1/auth/qr-requests/${created.id}/confirm`)
      .send({ scannerProof: created.scene })
      .expect(400);
    await request(app.getHttpServer())
      .delete(`/api/v1/auth/qr-requests/${created.id}`)
      .set('X-Dayline-Scanner-Proof', scanned.scannerProof)
      .expect(200);
    await post(`/api/v1/auth/qr-requests/${created.id}/confirm`)
      .send({ scannerProof: scanned.scannerProof })
      .expect(404);
    await post(`/api/v1/auth/qr-requests/${created.id}/consume`)
      .set('Cookie', created.cookie)
      .send({})
      .expect(409);
    const expired = await qr();
    const expScan = await resolve(expired.scene, 'expires');
    await database.qrRequest.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(0) },
    });
    await post(`/api/v1/auth/qr-requests/${expired.id}/confirm`)
      .send({ scannerProof: expScan.scannerProof })
      .expect(410);
    const state = await request(app.getHttpServer())
      .get(`/api/v1/auth/qr-requests/${expired.id}`)
      .set('Cookie', expired.cookie)
      .expect(200);
    expect(state.body.data.status).toBe('expired');
    expect(await database.wechatIdentity.count({ where: { appId } })).toBe(
      before,
    );
  });

  it('rolls back identity creation if confirmation loses expiry and rejects superseded proof', async () => {
    const created = await qr();
    const old = await resolve(created.scene, 'expiry-during-confirm');
    const fresh = await resolve(created.scene, 'expiry-during-confirm');
    await post(`/api/v1/auth/qr-requests/${created.id}/confirm`)
      .send({ scannerProof: old.scannerProof })
      .expect(404);
    const identities = app.get(WechatService);
    const original = identities.findOrCreateInTransaction.bind(identities);
    const spy = vi
      .spyOn(identities, 'findOrCreateInTransaction')
      .mockImplementationOnce(async (identity, transaction) => {
        const id = await original(identity, transaction);
        await transaction.qrRequest.update({
          where: { id: created.id },
          data: { expiresAt: new Date(0) },
        });
        return id;
      });
    try {
      await post(`/api/v1/auth/qr-requests/${created.id}/confirm`)
        .send({ scannerProof: fresh.scannerProof })
        .expect(409);
      expect(
        await database.wechatIdentity.count({
          where: { appId, openid: `${runId}-expiry-during-confirm` },
        }),
      ).toBe(0);
      expect(
        (
          await database.qrRequest.findUniqueOrThrow({
            where: { id: created.id },
          })
        ).status,
      ).toBe('scanned');
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps concurrent confirm/cancel atomic without orphan identities when cancellation wins', async () => {
    for (let index = 0; index < 8; index++) {
      const created = await qr();
      const code = `confirm-cancel-race-${index}`;
      const scanned = await resolve(created.scene, code);
      const [confirmation, cancellation] = await Promise.all([
        post(`/api/v1/auth/qr-requests/${created.id}/confirm`).send({
          scannerProof: scanned.scannerProof,
        }),
        request(app.getHttpServer())
          .delete(`/api/v1/auth/qr-requests/${created.id}`)
          .set('Origin', origin)
          .set('Cookie', created.cookie),
      ]);
      expect(cancellation.status).toBe(200);
      expect([200, 404, 409]).toContain(confirmation.status);
      expect(
        (
          await database.qrRequest.findUniqueOrThrow({
            where: { id: created.id },
          })
        ).status,
      ).toBe('cancelled');
      expect(
        await database.wechatIdentity.count({
          where: { appId, openid: `${runId}-${code}` },
        }),
      ).toBe(confirmation.status === 200 ? 1 : 0);
    }
  });

  it('allows restricted pending-deletion sessions, rejects merged identities, and reports duplicate QR IDs', async () => {
    const pending = await login('pending');
    await database.user.update({
      where: { id: pending.id },
      data: { status: 'pending_deletion' },
    });
    const again = await login('pending');
    expect(again.id).toBe(pending.id);
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${again.token}`)
      .expect(200);
    await post('/api/auth/change-password')
      .set('Authorization', `Bearer ${again.token}`)
      .set('X-Dayline-Expected-User', again.id)
      .send({ currentPassword: 'unused', newPassword: 'unused-new-password' })
      .expect(403);
    await database.user.update({
      where: { id: pending.id },
      data: { status: 'merged' },
    });
    await post('/api/v1/auth/wechat/login')
      .send({ code: 'pending' })
      .expect(403);
    const created = await qr();
    const duplicate = await post('/api/v1/auth/qr-requests')
      .send({ id: created.id, purpose: 'login' })
      .expect(409);
    expect(duplicate.body.error.code).toBe('QR_REQUEST_EXISTS');
  });

  it('validates reserved emails after normalization and makes email competition atomic', async () => {
    const a = await login('email-race-A');
    const b = await login('email-race-B');
    const auth = app.get(AuthAdapter);
    for (const email of [
      'invalid',
      ' WX@IDENTITY.DAYLINE.INVALID ',
      'a@@example.com',
    ]) {
      await expect(
        auth.setVerifiedEmailAndPassword(a.id, email, 'Valid-password-24!'),
      ).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' });
    }
    const email = `race-${runId}@example.com`;
    const results = await Promise.allSettled(
      [a.id, b.id].map((id) =>
        auth.setVerifiedEmailAndPassword(id, email, 'Valid-password-24!'),
      ),
    );
    expect(
      results.filter((value) => value.status === 'fulfilled'),
    ).toHaveLength(1);
    const remaining = await database.user.findFirstOrThrow({
      where: { id: { in: [a.id, b.id] }, emailKind: 'internal' },
    });
    expect(remaining.authEpoch).toBe(1);
    expect(
      await database.account.count({ where: { userId: remaining.id } }),
    ).toBe(0);
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set(
        'Authorization',
        `Bearer ${remaining.id === a.id ? a.token : b.token}`,
      )
      .expect(200);
  });

  it('burns a consumed grant when session creation fails and allows scanner cancellation after confirmation', async () => {
    const cancelled = await qr();
    const scanner = await resolve(cancelled.scene, 'cancel-after-confirm');
    await confirm(cancelled.id, scanner.scannerProof);
    await request(app.getHttpServer())
      .delete(`/api/v1/auth/qr-requests/${cancelled.id}`)
      .set('X-Dayline-Scanner-Proof', scanner.scannerProof)
      .expect(200);
    await post(`/api/v1/auth/qr-requests/${cancelled.id}/consume`)
      .set('Cookie', cancelled.cookie)
      .send({})
      .expect(409);
    const created = await qr();
    const scanned = await resolve(created.scene, 'failed-grant');
    await confirm(created.id, scanned.scannerProof);
    const spy = vi
      .spyOn(app.get(AuthAdapter), 'createWechatSession')
      .mockRejectedValueOnce(
        new AppError(503, 'AUTH_UNAVAILABLE', 'private-internal-error'),
      );
    try {
      const failed = await post(
        `/api/v1/auth/qr-requests/${created.id}/consume`,
      )
        .set('Cookie', created.cookie)
        .send({})
        .expect(503);
      expect(failed.headers['set-auth-token']).toBeUndefined();
      await post(`/api/v1/auth/qr-requests/${created.id}/consume`)
        .set('Cookie', created.cookie)
        .send({})
        .expect(409);
      expect(
        (
          await database.qrRequest.findUniqueOrThrow({
            where: { id: created.id },
          })
        ).status,
      ).toBe('consumed');
    } finally {
      spy.mockRestore();
    }
  });

  it('retains expected-account checks for WeChat sessions', async () => {
    const a = await login('actor-A');
    const b = await login('actor-B');
    await post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${a.token}`)
      .send({})
      .expect(400);
    await post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${b.token}`)
      .set('X-Dayline-Expected-User', a.id)
      .send({})
      .expect(409);
    await post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${a.token}`)
      .set('X-Dayline-Expected-User', a.id)
      .send({})
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${a.token}`)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${b.token}`)
      .expect(200);
  });
});
