import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { z } from 'zod';
import {
  actionProofDtoSchema,
  bindingResultSchema,
  mergePlanSchema,
  snapshotDtoSchema,
  mergeMappingsSchema,
  importJobSchema,
} from '@dayline/contracts';
import { decodeJwt } from 'jose';
import { createApp } from '../src/app.factory.js';
import { parseEnvironment } from '../src/config/environment.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Clock } from '../src/records/clock.js';
import { AuthAdapter } from '../src/auth/adapter/auth-adapter.js';
import { AppError } from '../src/common/app-error.js';
import { testDatabaseUrl } from './database-url.js';
const runId = randomUUID(),
  origin = 'http://localhost:5173',
  appId = `merge-${runId}`,
  mailDir = join(process.cwd(), '../../.local', `stage6-${runId}`),
  password = 'Stage-six-password-24!';
let app: NestExpressApplication, db: PrismaService, clock: Clock;
const ids = new Set<string>(),
  qrIds: string[] = [];
const scenes: string[] = [];
type Login = { id: string; token: string; code?: string; email?: string };
const bodyData = (r: { body: unknown }) =>
  z.object({ data: z.unknown() }).parse(r.body).data;
function call(
  u: Login,
  method: 'get' | 'post' | 'delete' | 'patch' | 'put',
  path: string,
) {
  return request(app.getHttpServer())
    [method](`/api/v1${path}`)
    .set('Authorization', `Bearer ${u.token}`)
    .set('X-Dayline-Expected-User', u.id)
    .set('Origin', origin);
}
async function wx(code: string = randomUUID()): Promise<Login> {
  const r = await request(app.getHttpServer())
    .post('/api/v1/auth/wechat/login')
    .send({ code })
    .expect(200);
  const id = z.object({ user: z.object({ id: z.uuid() }) }).parse(bodyData(r))
    .user.id;
  ids.add(id);
  return { id, token: z.string().parse(r.headers['set-auth-token']), code };
}
async function emailUser(): Promise<Login> {
  const email = `merge-${randomUUID()}@example.com`;
  const r = await request(app.getHttpServer())
    .post('/api/auth/sign-up/email')
    .set('Origin', origin)
    .send({ email, password, name: '邮箱目标' })
    .expect(200);
  const id = z.object({ user: z.object({ id: z.uuid() }) }).parse(r.body)
    .user.id;
  ids.add(id);
  await db.user.update({ where: { id }, data: { emailVerified: true } });
  return emailLogin(email);
}
async function emailLogin(email: string): Promise<Login> {
  const r = await request(app.getHttpServer())
    .post('/api/auth/sign-in/email')
    .set('Origin', origin)
    .send({ email, password })
    .expect(200);
  const id = z.object({ user: z.object({ id: z.uuid() }) }).parse(r.body)
    .user.id;
  return { id, token: z.string().parse(r.headers['set-auth-token']), email };
}
async function proof(
  u: Login,
  purpose = 'bind_wechat',
  operationId: string = randomUUID(),
  target = 'wechat',
) {
  const r = await call(u, 'post', '/auth/reauth')
    .send({
      purpose,
      operationId,
      target,
      ...(u.code ? { code: u.code } : { password }),
    })
    .expect(200);
  return { ...actionProofDtoSchema.parse(bodyData(r)), operationId };
}
async function binding(
  u: Login,
  code: string,
  operationId: string = randomUUID(),
) {
  const p = await proof(u, 'bind_wechat', operationId);
  const r = await call(u, 'post', '/me/wechat-binding')
    .send({ code, operationId, proof: p.proof })
    .expect(200);
  return { data: bindingResultSchema.parse(bodyData(r)), operationId };
}
async function preview(a: Login, b: Login, operationId: string = randomUUID()) {
  if (!b.code) throw new Error('wx required');
  const context = await binding(a, b.code, operationId);
  const r = await call(a, 'post', '/account-merges/preview')
    .send({ contextId: context.data.mergeContext, operationId })
    .expect(200);
  return mergePlanSchema.parse(bodyData(r));
}
async function snap(u: Login) {
  const r = await call(u, 'get', '/snapshot').expect(200);
  return snapshotDtoSchema.parse(bodyData(r));
}
async function entry(u: Login, title = '同名事项') {
  const s = await snap(u),
    c = s.categories[0];
  if (!c) throw new Error('category');
  const id = randomUUID();
  await call(u, 'post', '/entries')
    .send({
      id,
      title,
      categoryId: c.id,
      startDate: '2026-10-01',
      endDate: null,
    })
    .expect(201);
  return id;
}
async function startQr(
  u: Login,
  purpose: 'reauth' | 'bind_wechat',
  action: {
    purpose: string;
    operationId: string;
    target: string;
    proof?: string;
  },
) {
  const id = randomUUID();
  qrIds.push(id);
  const r = await call(u, 'post', '/auth/qr-requests')
    .send({ id, purpose, action })
    .expect(201);
  return {
    id,
    scene: z.string().parse(scenes.at(-1)),
    cookie: z
      .array(z.string())
      .parse(r.headers['set-cookie'])
      .map((c) => c.split(';')[0])
      .join('; '),
  };
}
async function scan(q: { scene: string }, code: string, status = 200) {
  const r = await request(app.getHttpServer())
    .post('/api/v1/auth/qr-requests/resolve')
    .send({ scene: q.scene, code })
    .expect(status);
  return status === 200
    ? z.object({ scannerProof: z.string() }).parse(bodyData(r)).scannerProof
    : '';
}
async function confirm(q: { id: string }, scannerProof: string) {
  await request(app.getHttpServer())
    .post(`/api/v1/auth/qr-requests/${q.id}/confirm`)
    .send({ scannerProof })
    .expect(200);
}
async function mailToken(id: string) {
  for (const f of await readdir(mailDir)) {
    const mail = z
      .object({ text: z.string() })
      .parse(JSON.parse(await readFile(join(mailDir, f), 'utf8')));
    const link = mail.text.match(/http[^\s]+/u)?.[0];
    if (link) {
      const url = new URL(link);
      if (url.searchParams.get('id') === id)
        return z.string().parse(url.searchParams.get('token'));
    }
  }
  throw new Error('missing binding mail');
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
        'stage6-integration-only-auth-secret-at-least-32-chars',
      ACTION_PROOF_SECRET:
        'stage6-integration-only-proof-secret-at-least-32-chars',
      MAIL_TRANSPORT: 'file',
      MAIL_PREVIEW_DIR: mailDir,
      MAIL_FROM: 'Dayline <noreply@example.com>',
    }),
    {
      async exchangeCode(code) {
        if (code === 'invalid')
          throw new AppError(401, 'WECHAT_CODE_INVALID', 'bad');
        return { appId, openid: code };
      },
      async createMiniappCode(scene) {
        scenes.push(scene);
        return 'data:image/png;base64,aW1hZ2U=';
      },
    },
  );
  await app.init();
  db = app.get(PrismaService);
  clock = app.get(Clock);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  try {
    if (db) {
      const list = [...ids];
      const merges = await db.accountMerge.findMany({
        where: { initiatorUserId: { in: list } },
        select: { id: true },
      });
      await db.mergeRecordMapping.deleteMany({
        where: { mergeId: { in: merges.map((m) => m.id) } },
      });
      await db.accountMerge.deleteMany({
        where: { initiatorUserId: { in: list } },
      });
      await db.mergeContext.deleteMany({
        where: { initiatorUserId: { in: list } },
      });
      await db.emailBindingRequest.deleteMany({
        where: { userId: { in: list } },
      });
      await db.qrRequest.deleteMany({ where: { id: { in: qrIds } } });
      await db.user.deleteMany({ where: { id: { in: list } } });
    }
  } finally {
    await app?.close();
    await rm(mailDir, { recursive: true, force: true });
  }
});
describe('identity binding and atomic account merges with real PostgreSQL HTTP', () => {
  it('issues purpose/session/operation/target/epoch-bound proofs, hides credentials and rejects bad reauth without killing a valid session', async () => {
    const a = await emailUser(),
      b = await wx();
    const p = await proof(a);
    expect(decodeJwt(p.proof)).not.toHaveProperty('password');
    expect(decodeJwt(p.proof)).not.toHaveProperty('code');
    await call(a, 'post', '/auth/reauth')
      .send({
        purpose: 'bind_wechat',
        operationId: p.operationId,
        target: 'wechat',
        password: 'wrong',
      })
      .expect(403);
    await call(a, 'post', '/auth/reauth')
      .send({
        purpose: 'bind_wechat',
        operationId: p.operationId,
        target: 'wechat',
        code: 'invalid',
      })
      .expect(403);
    await call(a, 'get', '/me').expect(200);
    for (const [user, operationId, token] of [
      [a, randomUUID(), p.proof],
      [b, p.operationId, p.proof],
    ] as const) {
      await call(user, 'post', '/me/wechat-binding')
        .send({ code: randomUUID(), operationId, proof: token })
        .expect(403);
    }
    const otherSession = await emailLogin(z.string().parse(a.email));
    await call(otherSession, 'post', '/me/wechat-binding')
      .send({ code: randomUUID(), operationId: p.operationId, proof: p.proof })
      .expect(403);
    const expired = new Date(Date.now() + 300001);
    vi.spyOn(clock, 'now').mockReturnValue(expired);
    await call(a, 'post', '/me/wechat-binding')
      .send({ code: randomUUID(), operationId: p.operationId, proof: p.proof })
      .expect(403);
    await call(a, 'get', '/me').expect(200);
  });
  it('provides a purpose-only Web WeChat reauth QR, rejects wrong scanner, needs explicit confirmation and original session/secret, and creates no user', async () => {
    const a = await wx(),
      before = await db.user.count();
    const operationId: string = randomUUID(),
      action = {
        purpose: 'bind_email',
        operationId,
        target: 'fresh@example.com',
      };
    const q = await startQr(a, 'reauth', action);
    await scan(q, randomUUID(), 409);
    const sp = await scan(q, z.string().parse(a.code));
    await call(a, 'post', `/auth/qr-requests/${q.id}/consume`)
      .set('Cookie', q.cookie)
      .send({})
      .expect(409);
    await confirm(q, sp);
    const other = await wx(z.string().parse(a.code));
    await call(other, 'post', `/auth/qr-requests/${q.id}/consume`)
      .set('Cookie', q.cookie)
      .send({})
      .expect(403);
    await call(a, 'post', `/auth/qr-requests/${q.id}/consume`)
      .send({})
      .expect(404);
    const r = await call(a, 'post', `/auth/qr-requests/${q.id}/consume`)
      .set('Cookie', q.cookie)
      .send({})
      .expect(200);
    expect(
      decodeJwt(actionProofDtoSchema.parse(bodyData(r)).proof),
    ).toMatchObject({
      purpose: 'bind_email',
      target: 'fresh@example.com',
      operationId,
    });
    expect(await db.user.count()).toBe(before);
    await call(a, 'post', `/auth/qr-requests/${q.id}/consume`)
      .set('Cookie', q.cookie)
      .send({})
      .expect(409);
  });
  it('binds a previously unused WeChat directly to email A after QR confirmation/consume, cancels without creating B, and revokes only after committed binding', async () => {
    const a = await emailUser(),
      p = await proof(a),
      before = await db.user.count(),
      q = await startQr(a, 'bind_wechat', {
        purpose: 'bind_wechat',
        operationId: p.operationId,
        target: 'wechat',
        proof: p.proof,
      });
    const code = randomUUID(),
      sp = await scan(q, code);
    expect(await db.user.count()).toBe(before);
    await confirm(q, sp);
    await request(app.getHttpServer())
      .delete(`/api/v1/auth/qr-requests/${q.id}`)
      .set('X-Dayline-Scanner-Proof', sp)
      .expect(200);
    await call(a, 'post', `/auth/qr-requests/${q.id}/consume`)
      .set('Cookie', q.cookie)
      .send({})
      .expect(409);
    expect(
      await db.wechatIdentity.count({ where: { appId, openid: code } }),
    ).toBe(0);
    const q2 = await startQr(a, 'bind_wechat', {
      purpose: 'bind_wechat',
      operationId: p.operationId,
      target: 'wechat',
      proof: p.proof,
    });
    await confirm(q2, await scan(q2, code));
    await call(a, 'post', `/auth/qr-requests/${q2.id}/consume`)
      .set('Cookie', q2.cookie)
      .send({})
      .expect(200);
    await call(a, 'get', '/me').expect(401);
    expect((await wx(code)).id).toBe(a.id);
    expect(await db.user.count()).toBe(before);
    expect((await emailLogin(z.string().parse(a.email))).id).toBe(a.id);
  });
  it('email link only marks verified across devices; completion requires original account, purpose proof, and binds new credential while preserving UUID', async () => {
    const a = await wx(),
      email = `new-${runId}@example.com`,
      p = await proof(a, 'bind_email', randomUUID(), email);
    const send = await call(a, 'post', '/me/email-binding-requests')
        .send({ email, operationId: p.operationId, proof: p.proof })
        .expect(202),
      id = z.string().parse(bindingResultSchema.parse(bodyData(send)).id);
    await call(a, 'post', `/me/email-binding-requests/${id}/complete`)
      .send({ operationId: p.operationId, proof: p.proof, password })
      .expect(403);
    const token = await mailToken(id);
    await request(app.getHttpServer())
      .post('/api/v1/me/email-binding-requests/verify')
      .send({ id, token })
      .expect(200);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: a.id } })).emailKind,
    ).toBe('internal');
    const b = await wx();
    await call(b, 'post', `/me/email-binding-requests/${id}/complete`)
      .send({ operationId: p.operationId, proof: p.proof, password })
      .expect(404);
    await call(a, 'post', `/me/email-binding-requests/${id}/complete`)
      .send({ operationId: p.operationId, proof: p.proof, password })
      .expect(200);
    await call(a, 'get', '/me').expect(401);
    expect((await emailLogin(email)).id).toBe(a.id);
    expect((await wx(z.string().parse(a.code))).id).toBe(a.id);
  });
  it('occupied email gives no other-account information until email verified and fresh current password; merges email credential into original WeChat UUID', async () => {
    const a = await wx(),
      b = await emailUser(),
      p = await proof(a, 'bind_email', randomUUID(), z.string().parse(b.email));
    const send = await call(a, 'post', '/me/email-binding-requests')
      .send({ email: b.email, operationId: p.operationId, proof: p.proof })
      .expect(202);
    expect(
      Object.keys(
        z.object({ data: z.record(z.string(), z.unknown()) }).parse(send.body)
          .data,
      ).sort(),
    ).toEqual(['id', 'status']);
    const id = z.string().parse(bindingResultSchema.parse(bodyData(send)).id);
    await call(a, 'post', `/me/email-binding-requests/${id}/complete`)
      .send({
        operationId: p.operationId,
        proof: p.proof,
        otherPassword: password,
      })
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/me/email-binding-requests/verify')
      .send({ id, token: await mailToken(id) })
      .expect(200);
    await call(a, 'post', `/me/email-binding-requests/${id}/complete`)
      .send({
        operationId: p.operationId,
        proof: p.proof,
        otherPassword: 'bad',
      })
      .expect(403);
    await call(a, 'get', '/me').expect(200);
    const r = await call(a, 'post', `/me/email-binding-requests/${id}/complete`)
      .send({
        operationId: p.operationId,
        proof: p.proof,
        otherPassword: password,
      })
      .expect(200);
    const contextId = bindingResultSchema.parse(bodyData(r)).mergeContext;
    const view = await call(a, 'post', '/account-merges/preview')
        .send({ contextId, operationId: p.operationId })
        .expect(200),
      plan = mergePlanSchema.parse(bodyData(view));
    await call(a, 'post', `/account-merges/${plan.id}/commit`)
      .send({
        expectedPlanRevision: plan.planRevision,
        planDigest: plan.planDigest,
      })
      .expect(200);
    expect((await emailLogin(z.string().parse(b.email))).id).toBe(a.id);
    expect(
      (
        await db.account.findFirstOrThrow({
          where: { userId: a.id, providerId: 'credential' },
        })
      ).accountId,
    ).toBe(a.id);
    expect((await wx(z.string().parse(a.code))).id).toBe(a.id);
  });
  it('keeps same-title entries, trash expiry and false focus, proposes distinct category names and commits both identities with authorized draft mappings', async () => {
    const a = await emailUser(),
      b = await wx(),
      aEntry = await entry(a),
      bEntry = await entry(b);
    const old = await snap(b),
      cat = old.categories.find(
        (c) => old.entries.find((e) => e.id === bEntry)?.categoryId === c.id,
      );
    if (!cat) throw new Error('cat');
    await call(b, 'patch', `/categories/${cat.id}`)
      .send({ expectedVersion: cat.version, color: '#123456' })
      .expect(200);
    await call(b, 'put', `/entries/${bEntry}/focus-days/2026-10-10`)
      .send({ focused: true, expectedEntryVersion: 1, expectedFocusVersion: 0 })
      .expect(200);
    await call(b, 'put', `/entries/${bEntry}/focus-days/2026-10-10`)
      .send({
        focused: false,
        expectedEntryVersion: 1,
        expectedFocusVersion: 1,
      })
      .expect(200);
    await call(b, 'delete', `/entries/${bEntry}`)
      .send({ expectedVersion: 1 })
      .expect(200);
    const original = await snap(b),
      p = await preview(a, b);
    expect(p.entries).toHaveLength(1);
    expect(
      p.categoryMappings.some(
        (c) =>
          c.sourceName === cat.name &&
          c.name !== cat.name &&
          [...c.name].length <= 12,
      ),
    ).toBe(true);
    const r = await call(a, 'post', `/account-merges/${p.id}/review`)
      .send({
        expectedPlanRevision: p.planRevision,
        categories: p.categoryMappings.map((c) => ({
          sourceId: c.sourceId,
          targetId: c.targetId,
          name: c.name,
          color: c.color,
        })),
        displayNameFrom: 'source',
      })
      .expect(200);
    const reviewed = mergePlanSchema.parse(bodyData(r));
    const outsider = await wx();
    await call(outsider, 'get', `/account-merges/${p.id}`).expect(404);
    await call(a, 'post', `/account-merges/${p.id}/commit`)
      .send({
        expectedPlanRevision: reviewed.planRevision,
        planDigest: reviewed.planDigest,
      })
      .expect(200);
    await call(a, 'get', '/me').expect(401);
    await call(b, 'get', '/me').expect(401);
    const target = await wx(z.string().parse(b.code));
    expect(target.id).toBe(a.id);
    const s = await snap(target);
    expect(s.entries.map((e) => e.id)).toContain(aEntry);
    expect(s.trashEntries.find((e) => e.id === bEntry)?.purgeAfter).toBe(
      original.trashEntries[0]?.purgeAfter,
    );
    expect(s.focusDays).toContainEqual({
      entryId: bEntry,
      date: '2026-10-10',
      focused: false,
      version: 2,
    });
    const recover = await proof(target, 'recover_drafts', randomUUID(), p.id);
    const mapping = await call(
      target,
      'post',
      `/account-merges/${p.id}/mappings`,
    )
      .send({ proof: recover.proof, operationId: recover.operationId })
      .expect(200);
    expect(mergeMappingsSchema.parse(bodyData(mapping)).entries).toContainEqual(
      { oldId: bEntry, newId: bEntry },
    );
    await call(outsider, 'post', `/account-merges/${p.id}/mappings`)
      .send({ proof: recover.proof, operationId: recover.operationId })
      .expect(403);
    await call(target, 'post', `/account-merges/${p.id}/commit`)
      .send({
        expectedPlanRevision: reviewed.planRevision,
        planDigest: reviewed.planDigest,
      })
      .expect(200);
  });
  it('cancels with zero business changes, rejects preview data-version staleness, and does not make proofs into login tokens', async () => {
    const a = await emailUser(),
      b = await wx(),
      beforeA = await snap(a),
      beforeB = await snap(b),
      p = await preview(a, b);
    await call(a, 'delete', `/account-merges/${p.id}`).expect(200);
    expect(await snap(a)).toEqual(beforeA);
    expect(await snap(b)).toEqual(beforeB);
    await call(a, 'post', `/account-merges/${p.id}/commit`)
      .send({ expectedPlanRevision: p.planRevision, planDigest: p.planDigest })
      .expect(409);
    const p2 = await preview(a, b);
    await entry(b, '稍后修改');
    await call(a, 'post', `/account-merges/${p2.id}/commit`)
      .send({
        expectedPlanRevision: p2.planRevision,
        planDigest: p2.planDigest,
      })
      .expect(409);
    const token = await proof(a);
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token.proof}`)
      .expect(401);
  });
  it('renewed fresh bilateral context resumes an unexpired saved plan after five-minute expiration without resetting category decisions', async () => {
    const a = await emailUser(),
      b = await wx(),
      p = await preview(a, b);
    const reviewed = mergePlanSchema.parse(
      bodyData(
        await call(a, 'post', `/account-merges/${p.id}/review`)
          .send({
            expectedPlanRevision: 1,
            categories: [],
            displayNameFrom: 'source',
          })
          .expect(200),
      ),
    );
    const now = new Date(Date.now() + 301000);
    vi.spyOn(clock, 'now').mockReturnValue(now);
    await call(a, 'get', `/account-merges/${p.id}`).expect(403);
    const again = await preview(a, b, p.operationId);
    expect(again.id).toBe(p.id);
    expect(again.planRevision).toBe(reviewed.planRevision);
    expect(again.displayNameFrom).toBe('source');
    await call(a, 'post', `/account-merges/${again.id}/commit`)
      .send({
        expectedPlanRevision: again.planRevision,
        planDigest: again.planDigest,
      })
      .expect(200);
  });
  it('rejects two emails or two WeChats before exposing a merge plan and retains independent users', async () => {
    const a = await wx(),
      b = await wx(),
      r = await binding(a, z.string().parse(b.code));
    await call(a, 'post', '/account-merges/preview')
      .send({ contextId: r.data.mergeContext, operationId: r.operationId })
      .expect(409);
    await call(a, 'get', '/me').expect(200);
    await call(b, 'get', '/me').expect(200);
    const emailA = await emailUser(),
      emailB = await emailUser();
    const id = randomUUID();
    await db.mergeContext.create({
      data: {
        id,
        initiatorUserId: emailA.id,
        otherUserId: emailB.id,
        sessionId: (
          await db.session.findFirstOrThrow({ where: { userId: emailA.id } })
        ).id,
        operationId: id,
        initiatorEpoch: 1,
        otherEpoch: 1,
        expiresAt: new Date(Date.now() + 300000),
      },
    });
    await call(emailA, 'post', '/account-merges/preview')
      .send({ contextId: id, operationId: id })
      .expect(409);
  });
  it('rolls back every business and identity change on a mid-transaction adapter failure and concurrent commit has exactly one effect', async () => {
    const a = await emailUser(),
      b = await wx();
    await entry(b);
    const p = await preview(a, b),
      beforeA = await snap(a),
      beforeB = await snap(b);
    const adapter = app.get(AuthAdapter),
      migrate = adapter.migrateCredentials.bind(adapter),
      spy = vi
        .spyOn(adapter, 'migrateCredentials')
        .mockImplementationOnce(async (...args) => {
          await migrate(...args);
          throw new Error('controlled post-identity fault');
        });
    await call(a, 'post', `/account-merges/${p.id}/commit`)
      .send({ expectedPlanRevision: p.planRevision, planDigest: p.planDigest })
      .expect(500);
    expect(await snap(a)).toEqual(beforeA);
    expect(await snap(b)).toEqual(beforeB);
    expect(
      (await db.accountMerge.findUniqueOrThrow({ where: { id: p.id } })).status,
    ).toBe('preview');
    spy.mockRestore();
    const results = await Promise.all(
      [1, 2].map(() =>
        call(a, 'post', `/account-merges/${p.id}/commit`).send({
          expectedPlanRevision: p.planRevision,
          planDigest: p.planDigest,
        }),
      ),
    );
    expect(
      results.filter((r) => r.status === 200).length,
    ).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => [200, 401].includes(r.status))).toBe(true);
    const fresh = await wx(z.string().parse(b.code));
    expect((await snap(fresh)).entries).toHaveLength(1);
  });
  it('carries completed file-source history across a merge without exposing source private import plans or duplicating a repeat file', async () => {
    const a = await emailUser(),
      b = await wx(),
      csv =
        'title,start_date,category_name,category_color\n来源文件,2026-10-01,阅读,#6C9BCE\n';
    async function upload(u: Login) {
      return importJobSchema.parse(
        bodyData(
          await call(u, 'post', '/imports/preview')
            .set('Content-Type', 'application/octet-stream')
            .set('X-Dayline-File-Format', 'csv')
            .set('X-Dayline-Operation-ID', randomUUID())
            .send(csv)
            .expect(201),
        ),
      );
    }
    const file = await upload(b);
    await call(b, 'post', `/imports/${file.id}/commit`)
      .send({
        expectedPlanRevision: file.planRevision,
        planDigest: file.planDigest,
      })
      .expect(201);
    const p = await preview(a, b);
    await call(a, 'post', `/account-merges/${p.id}/commit`)
      .send({ expectedPlanRevision: p.planRevision, planDigest: p.planDigest })
      .expect(200);
    const target = await wx(z.string().parse(b.code));
    await call(target, 'get', `/imports/${file.id}`).expect(404);
    const again = await upload(target);
    expect(again.rows.every((r) => r.action === 'skip')).toBe(true);
    const before = await snap(target);
    await call(target, 'post', `/imports/${again.id}/commit`)
      .send({
        expectedPlanRevision: again.planRevision,
        planDigest: again.planDigest,
      })
      .expect(201);
    expect((await snap(target)).dataVersion).toBe(before.dataVersion);
    expect((await snap(target)).entries).toHaveLength(1);
  });
  it('blocks a 21-category merge until explicit category mapping, with all source entries retained', async () => {
    const a = await emailUser(),
      b = await wx();
    for (let i = 0; i < 14; i++)
      await call(a, 'post', '/categories')
        .send({ id: randomUUID(), name: `目标${i}`, color: '#123456' })
        .expect(201);
    const c = (await snap(b)).categories[0];
    if (!c) throw new Error('category');
    await call(b, 'patch', `/categories/${c.id}`)
      .send({ expectedVersion: c.version, name: '独有来源分类' })
      .expect(200);
    const e = await entry(b),
      p = await preview(a, b);
    expect(p.canCommit).toBe(false);
    expect(p.conflicts.join('')).toContain('20');
    const target = p.targetCategories[0],
      mapping = p.categoryMappings.find((m) => !m.targetId);
    if (!target || !mapping) throw new Error('mapping');
    const r = await call(a, 'post', `/account-merges/${p.id}/review`)
      .send({
        expectedPlanRevision: p.planRevision,
        categories: [
          {
            sourceId: mapping.sourceId,
            targetId: target.id,
            name: target.name,
            color: target.color,
          },
        ],
        displayNameFrom: 'target',
      })
      .expect(200);
    const plan = mergePlanSchema.parse(bodyData(r));
    expect(plan.canCommit).toBe(true);
    await call(a, 'post', `/account-merges/${p.id}/commit`)
      .send({
        expectedPlanRevision: plan.planRevision,
        planDigest: plan.planDigest,
      })
      .expect(200);
    const fresh = await wx(z.string().parse(b.code));
    expect((await snap(fresh)).entries.some((item) => item.id === e)).toBe(
      true,
    );
    expect((await snap(fresh)).categories).toHaveLength(20);
  });
  it('rejects wrong target/purpose proofs, expires cancelled QR rights, and rejects a scanner epoch changed after scan', async () => {
    const a = await emailUser(),
      b = await wx(),
      operationId = randomUUID(),
      wrongPurpose = await proof(a, 'recover_drafts', operationId, 'wechat');
    await call(a, 'post', '/me/wechat-binding')
      .send({ code: b.code, operationId, proof: wrongPurpose.proof })
      .expect(403);
    const wrongTarget = await proof(
      a,
      'bind_wechat',
      operationId,
      'another-target',
    );
    await call(a, 'post', '/me/wechat-binding')
      .send({ code: b.code, operationId, proof: wrongTarget.proof })
      .expect(403);
    const p = await proof(a),
      q = await startQr(a, 'bind_wechat', {
        purpose: 'bind_wechat',
        operationId: p.operationId,
        target: 'wechat',
        proof: p.proof,
      });
    const sp = await scan(q, z.string().parse(b.code));
    await db.user.update({
      where: { id: b.id },
      data: { authEpoch: { increment: 1 } },
    });
    await request(app.getHttpServer())
      .post(`/api/v1/auth/qr-requests/${q.id}/confirm`)
      .send({ scannerProof: sp })
      .expect(409);
    await db.qrRequest.update({
      where: { id: q.id },
      data: { expiresAt: new Date(0) },
    });
    await call(a, 'post', `/auth/qr-requests/${q.id}/consume`)
      .set('Cookie', q.cookie)
      .send({})
      .expect(410);
    await call(a, 'get', '/me').expect(200);
    const freshA = await emailLogin(z.string().parse(a.email)),
      freshProof = await proof(freshA);
    const active = await startQr(freshA, 'bind_wechat', {
      purpose: 'bind_wechat',
      operationId: freshProof.operationId,
      target: 'wechat',
      proof: freshProof.proof,
    });
    const scanner = await scan(active, z.string().parse(b.code));
    await db.session.deleteMany({ where: { userId: a.id } });
    await request(app.getHttpServer())
      .post(`/api/v1/auth/qr-requests/${active.id}/confirm`)
      .send({ scannerProof: scanner })
      .expect(409);
    await call(freshA, 'get', '/me').expect(401);
  });
  it('invalidates old source reset verification and all source sessions while both migrated login methods enter the target UUID', async () => {
    const a = await wx(),
      b = await emailUser(),
      operationId = randomUUID(),
      p = await proof(a, 'bind_email', operationId, z.string().parse(b.email));
    await request(app.getHttpServer())
      .post('/api/auth/request-password-reset')
      .set('Origin', origin)
      .send({ email: b.email, redirectTo: origin + '/auth/reset-password' })
      .expect(200);
    const reset = await db.verification.findFirstOrThrow({
      where: { value: b.id, identifier: { startsWith: 'reset-password:' } },
    });
    const send = await call(a, 'post', '/me/email-binding-requests')
      .send({ email: b.email, operationId, proof: p.proof })
      .expect(202);
    const id = z.string().parse(bindingResultSchema.parse(bodyData(send)).id);
    await request(app.getHttpServer())
      .post('/api/v1/me/email-binding-requests/verify')
      .send({ id, token: await mailToken(id) })
      .expect(200);
    const bound = bindingResultSchema.parse(
      bodyData(
        await call(a, 'post', `/me/email-binding-requests/${id}/complete`)
          .send({ operationId, proof: p.proof, otherPassword: password })
          .expect(200),
      ),
    );
    const view = mergePlanSchema.parse(
      bodyData(
        await call(a, 'post', '/account-merges/preview')
          .send({ contextId: bound.mergeContext, operationId })
          .expect(200),
      ),
    );
    await call(a, 'post', `/account-merges/${view.id}/commit`)
      .send({
        expectedPlanRevision: view.planRevision,
        planDigest: view.planDigest,
      })
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/auth/reset-password')
      .set('Origin', origin)
      .send({
        token: reset.identifier.slice('reset-password:'.length),
        newPassword: 'Must-not-change-24!',
      })
      .expect(400);
    expect((await emailLogin(z.string().parse(b.email))).id).toBe(a.id);
    expect((await wx(z.string().parse(a.code))).id).toBe(a.id);
    expect(await db.account.count({ where: { userId: b.id } })).toBe(0);
    expect(await db.session.count({ where: { userId: b.id } })).toBe(0);
  });
  it('fresh exact binding-mail evidence promotes an unverified occupied email only at merge commit, never at anonymous link verification', async () => {
    const a = await wx(),
      email = `unverified-${randomUUID()}@example.com`;
    const signup = await request(app.getHttpServer())
      .post('/api/auth/sign-up/email')
      .set('Origin', origin)
      .send({ email, password, name: '未验证邮箱' })
      .expect(200);
    const sourceId = z
      .object({ user: z.object({ id: z.uuid() }) })
      .parse(signup.body).user.id;
    ids.add(sourceId);
    await request(app.getHttpServer())
      .post('/api/auth/sign-in/email')
      .set('Origin', origin)
      .send({ email, password })
      .expect(403);
    const operationId = randomUUID(),
      p = await proof(a, 'bind_email', operationId, email);
    const send = await call(a, 'post', '/me/email-binding-requests')
        .send({ email, operationId, proof: p.proof })
        .expect(202),
      id = z.string().parse(bindingResultSchema.parse(bodyData(send)).id);
    await request(app.getHttpServer())
      .post('/api/v1/me/email-binding-requests/verify')
      .send({ id, token: await mailToken(id) })
      .expect(200);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: sourceId } }))
        .emailVerified,
    ).toBe(false);
    const context = bindingResultSchema.parse(
      bodyData(
        await call(a, 'post', `/me/email-binding-requests/${id}/complete`)
          .send({ operationId, proof: p.proof, otherPassword: password })
          .expect(200),
      ),
    );
    const view = mergePlanSchema.parse(
      bodyData(
        await call(a, 'post', '/account-merges/preview')
          .send({ contextId: context.mergeContext, operationId })
          .expect(200),
      ),
    );
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: sourceId } }))
        .emailVerified,
    ).toBe(false);
    await call(a, 'post', `/account-merges/${view.id}/commit`)
      .send({
        expectedPlanRevision: view.planRevision,
        planDigest: view.planDigest,
      })
      .expect(200);
    expect((await emailLogin(email)).id).toBe(a.id);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: a.id } })).emailVerified,
    ).toBe(true);
  });
  it('opposite-direction concurrent merges use one UUID lock order and converge both real login methods on exactly one committed target', async () => {
    const a = await emailUser(),
      b = await wx();
    await entry(a, 'A独有');
    await entry(b, 'B独有');
    const first = await preview(a, b);
    const operationId = randomUUID(),
      p = await proof(b, 'bind_email', operationId, z.string().parse(a.email));
    const send = await call(b, 'post', '/me/email-binding-requests')
        .send({ email: a.email, operationId, proof: p.proof })
        .expect(202),
      id = z.string().parse(bindingResultSchema.parse(bodyData(send)).id);
    await request(app.getHttpServer())
      .post('/api/v1/me/email-binding-requests/verify')
      .send({ id, token: await mailToken(id) })
      .expect(200);
    const context = bindingResultSchema.parse(
      bodyData(
        await call(b, 'post', `/me/email-binding-requests/${id}/complete`)
          .send({ operationId, proof: p.proof, otherPassword: password })
          .expect(200),
      ),
    );
    const second = mergePlanSchema.parse(
      bodyData(
        await call(b, 'post', '/account-merges/preview')
          .send({ contextId: context.mergeContext, operationId })
          .expect(200),
      ),
    );
    const results = await Promise.all(
      [
        { u: a, v: first },
        { u: b, v: second },
      ].map(async ({ u, v }) => {
        return call(u, 'post', `/account-merges/${v.id}/commit`).send({
          expectedPlanRevision: v.planRevision,
          planDigest: v.planDigest,
        });
      }),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.every((r) => [200, 401, 409].includes(r.status))).toBe(true);
    const fresh = await wx(z.string().parse(b.code)),
      byEmail = await emailLogin(z.string().parse(a.email));
    expect(fresh.id).toBe(byEmail.id);
    expect((await snap(fresh)).entries).toHaveLength(2);
    const success = results.find((r) => r.status === 200);
    expect(
      z
        .object({ meta: z.object({ dataVersion: z.string() }) })
        .parse(success?.body).meta.dataVersion,
    ).toBe((await snap(fresh)).dataVersion);
  });
  it('resumes an already verified email request after the original account logs out and returns with a new SID and fresh proof, without resending mail', async () => {
    const a = await wx(),
      email = `resume-${randomUUID()}@example.com`,
      operationId = randomUUID(),
      old = await proof(a, 'bind_email', operationId, email);
    const response = await call(a, 'post', '/me/email-binding-requests')
        .send({ email, operationId, proof: old.proof })
        .expect(202),
      id = z.string().parse(bindingResultSchema.parse(bodyData(response)).id);
    await request(app.getHttpServer())
      .post('/api/v1/me/email-binding-requests/verify')
      .send({ id, token: await mailToken(id) })
      .expect(200);
    await call(a, 'post', '/auth/logout').send({}).expect(200);
    const fresh = await wx(z.string().parse(a.code));
    expect(fresh.id).toBe(a.id);
    await call(fresh, 'post', `/me/email-binding-requests/${id}/complete`)
      .send({ operationId, proof: old.proof, password })
      .expect(403);
    await call(fresh, 'get', '/me').expect(200);
    const next = await proof(fresh, 'bind_email', operationId, email);
    await call(fresh, 'post', `/me/email-binding-requests/${id}/complete`)
      .send({ operationId, proof: next.proof, password })
      .expect(200);
    expect(
      (await db.emailBindingRequest.findUniqueOrThrow({ where: { id } }))
        .sessionId,
    ).toBe(decodeJwt(next.proof).sid);
    expect((await emailLogin(email)).id).toBe(a.id);
  });
  it('a bind QR consume/cancel race has one outcome and never creates an extra WeChat user', async () => {
    const a = await emailUser(),
      p = await proof(a),
      code = randomUUID(),
      q = await startQr(a, 'bind_wechat', {
        purpose: 'bind_wechat',
        operationId: p.operationId,
        target: 'wechat',
        proof: p.proof,
      });
    const scanner = await scan(q, code);
    await confirm(q, scanner);
    const before = await db.user.count();
    const [consumed, cancelled] = await Promise.all([
      call(a, 'post', `/auth/qr-requests/${q.id}/consume`)
        .set('Cookie', q.cookie)
        .send({}),
      request(app.getHttpServer())
        .delete(`/api/v1/auth/qr-requests/${q.id}`)
        .set('X-Dayline-Scanner-Proof', scanner),
    ]);
    expect(await db.user.count()).toBe(before);
    if (consumed.status === 200) {
      expect(cancelled.status).toBe(409);
      expect((await wx(code)).id).toBe(a.id);
    } else {
      expect(consumed.status).toBe(409);
      expect(cancelled.status).toBe(200);
      expect(
        await db.wechatIdentity.count({ where: { appId, openid: code } }),
      ).toBe(0);
      await call(a, 'get', '/me').expect(200);
    }
  });
});
