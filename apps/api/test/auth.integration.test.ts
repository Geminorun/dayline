import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/app.factory.js';
import { parseEnvironment } from '../src/config/environment.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { testDatabaseUrl } from './database-url.js';

const runId = randomUUID();
const origin = 'http://localhost:5173';
const password = 'Test-password-42!';
const newPassword = 'Changed-password-73!';
const userIdSchema = z.object({ user: z.object({ id: z.uuid() }) });
const meSchema = z.object({
  data: z.object({
    id: z.uuid(),
    email: z.email(),
    emailVerified: z.boolean(),
  }),
});
const previewSchema = z.object({
  to: z.string(),
  subject: z.string(),
  text: z.string(),
});
let app: NestExpressApplication;
let database: PrismaService;
let previewDirectory: string;

function post(path: string) {
  return request(app.getHttpServer()).post(path).set('Origin', origin);
}

async function mailUrl(email: string, subject: string): Promise<URL> {
  for (const name of (await readdir(previewDirectory)).sort().reverse()) {
    const mail = previewSchema.parse(
      JSON.parse(await readFile(join(previewDirectory, name), 'utf8')),
    );
    if (mail.to !== email || mail.subject !== subject) continue;
    const match = mail.text.match(/https?:\/\/\S+/);
    if (match) return new URL(match[0]);
  }
  throw new Error('Expected authentication email was not generated.');
}

async function register(label: string, verify = true) {
  const email = `${label}-${runId}@example.com`;
  const response = await post('/api/auth/sign-up/email')
    .send({
      email,
      password,
      name: `用户 ${label}`,
      callbackURL: `${origin}/verified`,
    })
    .expect(200);
  const id = userIdSchema.parse(response.body).user.id;
  expect(response.body.token).toBeNull();
  // Both the library's user INSERT transaction and the shared default initializer
  // must commit before any later login can issue a usable session.
  expect(await database.category.count({ where: { userId: id } })).toBe(6);
  expect(
    (await database.user.findUniqueOrThrow({ where: { id } })).initializedAt,
  ).not.toBeNull();
  if (verify) {
    const url = await mailUrl(email, '验证日序邮箱');
    const verification = await request(app.getHttpServer())
      .get(url.pathname + url.search)
      .expect(302);
    expect(verification.headers.location).toBe(`${origin}/verified`);
  }
  return { id, email };
}

async function login(email: string, currentPassword = password) {
  const response = await post('/api/auth/sign-in/email')
    .send({ email, password: currentPassword })
    .expect(200);
  return sessionFrom(response.headers);
}

function sessionFrom(headers: Record<string, unknown>) {
  const cookies = z.array(z.string()).parse(headers['set-cookie']);
  const token = z.string().parse(headers['set-auth-token']);
  expect(
    cookies.some(
      (cookie) => /HttpOnly/i.test(cookie) && /SameSite=Lax/i.test(cookie),
    ),
  ).toBe(true);
  return {
    cookie: cookies.map((cookie) => cookie.split(';')[0]).join('; '),
    token,
  };
}

beforeAll(async () => {
  previewDirectory = await mkdtemp(join(tmpdir(), 'dayline-auth-'));
  const config = parseEnvironment({
    NODE_ENV: 'test',
    DATABASE_URL: testDatabaseUrl(),
    AUTH_BASE_URL: 'http://localhost:3000',
    WEB_BASE_URL: origin,
    AUTH_TRUSTED_ORIGINS: `${origin},http://localhost:3000`,
    BETTER_AUTH_SECRET:
      'integration-test-only-secret-with-at-least-32-characters',
    MAIL_TRANSPORT: 'file',
    MAIL_PREVIEW_DIR: previewDirectory,
    MAIL_FROM: 'Dayline <noreply@example.com>',
  });
  app = await createApp(config);
  await app.init();
  database = app.get(PrismaService);
});

afterAll(async () => {
  try {
    if (database) {
      const users = await database.user.findMany({
        where: { email: { contains: runId } },
        select: { id: true },
      });
      await database.verification.deleteMany({
        where: { value: { in: users.map((user) => user.id) } },
      });
      await database.user.deleteMany({ where: { email: { contains: runId } } });
    }
  } finally {
    await app?.close();
    if (previewDirectory)
      await rm(previewDirectory, { recursive: true, force: true });
  }
});

describe('authentication foundation with real PostgreSQL and HTTP', () => {
  it('serves health checks and OpenAPI while keeping private routes protected', async () => {
    const live = await request(app.getHttpServer())
      .get('/health/live')
      .expect(200);
    expect(live.body.data.status).toBe('ok');
    expect(live.headers['x-request-id']).toBeDefined();
    expect(live.headers['cache-control']).toBe('no-store');
    await request(app.getHttpServer()).get('/health/ready').expect(200);
    await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    const anonymous = await request(app.getHttpServer())
      .get('/api/v1/me')
      .expect(401);
    expect(anonymous.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('keeps exactly one initialized default set during concurrent first email logins', async () => {
    const user = await register('concurrent-first-login');
    const sessions = await Promise.all(
      Array.from({ length: 4 }, () => login(user.email)),
    );
    expect(sessions).toHaveLength(4);
    expect(await database.category.count({ where: { userId: user.id } })).toBe(
      6,
    );
    const state = await database.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(state.initializedAt).not.toBeNull();
    expect(state.dataVersion).toBe(1n);
    const first = await database.category.findFirstOrThrow({
      where: { userId: user.id },
    });
    await database.category.update({
      where: { id: first.id },
      data: { name: '邮箱自定分类' },
    });
    await login(user.email);
    expect(
      (await database.category.findUniqueOrThrow({ where: { id: first.id } }))
        .name,
    ).toBe('邮箱自定分类');
    expect(await database.category.count({ where: { userId: user.id } })).toBe(
      6,
    );
  });
  it('requires verification, resends email, and accepts Cookie and signed Bearer sessions', async () => {
    const user = await register('verification', false);
    await post('/api/auth/sign-in/email')
      .send({ email: user.email, password })
      .expect(403);
    await post('/api/auth/send-verification-email')
      .send({ email: user.email, callbackURL: `${origin}/verified` })
      .expect(200);
    const url = await mailUrl(user.email, '验证日序邮箱');
    const verification = await request(app.getHttpServer())
      .get(url.pathname + url.search)
      .expect(302);
    expect(verification.headers.location).toBe(`${origin}/verified`);
    const session = await login(user.email);
    for (const headers of [
      { Cookie: session.cookie },
      { Authorization: `Bearer ${session.token}` },
    ]) {
      const response = await request(app.getHttpServer())
        .get('/api/v1/me')
        .set(headers)
        .expect(200);
      expect(meSchema.parse(response.body).data).toMatchObject({
        id: user.id,
        email: user.email,
        emailVerified: true,
      });
      expect(JSON.stringify(response.body)).not.toMatch(
        /authEpoch|sessionId|passwordHash|accessToken/,
      );
    }
    await request(app.getHttpServer())
      .get('/api/auth/get-session')
      .set('Authorization', `Bearer ${session.token}`)
      .expect(200);
    const rawToken = decodeURIComponent(session.token).split('.')[0];
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${rawToken}`)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${session.token}tampered`)
      .expect(401);
  });

  it('resets passwords once and revokes all previously issued sessions', async () => {
    const user = await register('reset');
    const session = await login(user.email);
    await post('/api/auth/request-password-reset')
      .send({ email: user.email, redirectTo: `${origin}/reset-password` })
      .expect(200);
    const url = await mailUrl(user.email, '重置日序密码');
    const redirect = await request(app.getHttpServer())
      .get(url.pathname + url.search)
      .expect(302);
    const location = new URL(z.string().parse(redirect.headers.location));
    expect(location.origin).toBe(origin);
    const token = z.string().parse(location.searchParams.get('token'));
    await post('/api/auth/reset-password')
      .send({ token, newPassword })
      .expect(200);
    await post('/api/auth/reset-password')
      .send({ token, newPassword: password })
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Cookie', session.cookie)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${session.token}`)
      .expect(401);
    await post('/api/auth/sign-in/email')
      .send({ email: user.email, password })
      .expect(401);
    await login(user.email, newPassword);
    expect(
      (await database.user.findUniqueOrThrow({ where: { id: user.id } }))
        .authEpoch,
    ).toBe(2);
  });

  it('checks actor context on native writes, changes passwords, and logs out', async () => {
    const user = await register('password-change');
    const current = await login(user.email);
    const other = await login(user.email);
    const input = {
      currentPassword: password,
      newPassword,
      revokeOtherSessions: true,
    };
    await post('/api/auth/change-password')
      .set('Cookie', current.cookie)
      .send(input)
      .expect(400);
    await post('/api/auth/change-password')
      .set('Cookie', current.cookie)
      .set('X-Dayline-Expected-User', randomUUID())
      .send(input)
      .expect(409);
    const changed = await post('/api/auth/change-password')
      .set('Cookie', current.cookie)
      .set('X-Dayline-Expected-User', user.id)
      .send(input)
      .expect(200);
    const renewed = sessionFrom(changed.headers);
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Cookie', other.cookie)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Cookie', current.cookie)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Cookie', renewed.cookie)
      .expect(200);
    await post('/api/auth/sign-out')
      .set('Cookie', renewed.cookie)
      .set('X-Dayline-Expected-User', user.id)
      .send({})
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${renewed.token}`)
      .expect(401);
  });

  it('rejects conflicting identities and blocks stale account context without logging out another user', async () => {
    const first = await register('first');
    const second = await register('second');
    const a = await login(first.email);
    const b = await login(second.email);
    for (const path of ['/api/v1/me', '/api/auth/get-session']) {
      await request(app.getHttpServer())
        .get(path)
        .set('Cookie', a.cookie)
        .set('Authorization', `Bearer ${b.token}`)
        .expect(401);
    }
    await post('/api/v1/auth/logout')
      .set('Cookie', b.cookie)
      .set('X-Dayline-Expected-User', first.id)
      .send({})
      .expect(409);
    await post('/api/v1/auth/logout')
      .set('Cookie', b.cookie)
      .set('X-Dayline-Expected-User', second.id)
      .set('Origin', 'https://untrusted.example')
      .send({})
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Cookie', b.cookie)
      .expect(200);
    await post('/api/v1/auth/logout')
      .set('Cookie', b.cookie)
      .set('X-Dayline-Expected-User', second.id)
      .send({})
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Cookie', b.cookie)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Cookie', a.cookie)
      .expect(200);
  });

  it('rejects expired sessions and epoch-revoked sessions', async () => {
    const user = await register('revocation');
    const expired = await login(user.email);
    await database.session.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(0) },
    });
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Cookie', expired.cookie)
      .expect(401);
    const revoked = await login(user.email);
    await database.user.update({
      where: { id: user.id },
      data: { authEpoch: { increment: 1 } },
    });
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${revoked.token}`)
      .expect(401);
    const renewed = await login(user.email);
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Cookie', renewed.cookie)
      .expect(200);
  });

  it('renews sliding sessions and forwards the refreshed credentials to both HTTP entry points', async () => {
    const user = await register('sliding');
    const session = await login(user.email);
    const day = 24 * 60 * 60 * 1000;
    for (const path of ['/api/v1/me', '/api/auth/get-session']) {
      await database.session.updateMany({
        where: { userId: user.id },
        data: { expiresAt: new Date(Date.now() + 5 * day) },
      });
      const response = await request(app.getHttpServer())
        .get(path)
        .set('Cookie', session.cookie)
        .expect(200);
      const renewed = sessionFrom(response.headers);
      await request(app.getHttpServer())
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${renewed.token}`)
        .expect(200);
      const row = await database.session.findFirstOrThrow({
        where: { userId: user.id },
      });
      expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * day);
    }
  });

  it('limits native PATCH tunnelling to exact POST /api/v1 requests without bypassing auth', async () => {
    await post('/api/v1/auth/logout').send({}).expect(401);
    await post('/api/v1/auth/logout')
      .set('X-Dayline-Method-Override', 'GET')
      .send({})
      .expect(401);
    await post('/api/v1/auth/logout')
      .set('X-Dayline-Method-Override', 'PATCH')
      .send({})
      .expect(404);
    const user = await register('method-override');
    const session = await login(user.email);
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Cookie', session.cookie)
      .set('X-Dayline-Method-Override', 'PATCH')
      .expect(200);
    await post('/api/v1/auth/logout')
      .set('Cookie', session.cookie)
      .set('X-Dayline-Method-Override', 'PATCH')
      .set('X-Dayline-Expected-User', user.id)
      .send({})
      .expect(404);
    await post('/api/auth/sign-out')
      .set('Cookie', session.cookie)
      .set('X-Dayline-Method-Override', 'PATCH')
      .send({})
      .expect(400);
    await post('/api/auth/sign-out')
      .set('Cookie', session.cookie)
      .set('X-Dayline-Method-Override', 'PATCH')
      .set('X-Dayline-Expected-User', user.id)
      .send({})
      .expect(200);
  });

  it('parses ordinary JSON safely, blocks native bypasses and requires the business profile version', async () => {
    await post('/api/v1/auth/logout')
      .set('Content-Type', 'application/json')
      .send('{"broken"')
      .expect(400);
    await post('/api/v1/auth/logout')
      .send({ oversized: 'x'.repeat(70 * 1024) })
      .expect(413);
    for (const path of [
      '/update-user',
      '/delete-user',
      '/change-email',
      '/link-social',
    ]) {
      await post(`/api/auth${path}`).send({ name: 'forbidden' }).expect(404);
    }
    const preflight = await request(app.getHttpServer())
      .options('/api/v1/me')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'PATCH')
      .set(
        'Access-Control-Request-Headers',
        'content-type,x-dayline-expected-user',
      )
      .expect(204);
    expect(preflight.headers['access-control-allow-methods']).toContain(
      'PATCH',
    );
    const user = await register('read-only');
    const session = await login(user.email);
    await request(app.getHttpServer())
      .patch('/api/v1/me')
      .set('Origin', origin)
      .set('Cookie', session.cookie)
      .set('X-Dayline-Expected-User', user.id)
      .send({ displayName: '缺少资料版本' })
      .expect(422);
  });
});
