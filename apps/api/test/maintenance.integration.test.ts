import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { z } from 'zod';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  importJobSchema,
  mergePlanSchema,
  actionProofDtoSchema,
  deletionResultSchema,
  snapshotDtoSchema,
} from '@dayline/contracts';
import { createApp } from '../src/app.factory.js';
import { parseEnvironment } from '../src/config/environment.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Clock } from '../src/records/clock.js';
import { MaintenanceService } from '../src/maintenance/maintenance.service.js';
import { AUTH_INSTANCE } from '../src/auth/create-auth.js';
import type { DaylineAuth } from '../src/auth/create-auth.js';
import { testDatabaseUrl } from './database-url.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { requestBudget } from '../src/common/request-budget.js';
const origin = 'http://localhost:5173',
  appId = 'maintenance-' + randomUUID(),
  password = 'Stage-seven-password-24!';
const ids = new Set<string>(),
  codes = new Map<string, string>(),
  scenes: string[] = [];
let app: NestExpressApplication,
  db: PrismaService,
  clock: Clock,
  maintenance: MaintenanceService,
  mailDir: string;
let config: ReturnType<typeof parseEnvironment>;
type Login = { id: string; token: string; code: string };
const data = (r: { body: unknown }) =>
  z.object({ data: z.unknown() }).parse(r.body).data;
function call(u: Login, method: 'get' | 'post' | 'delete', path: string) {
  return request(app.getHttpServer())
    [method]('/api/v1' + path)
    .set('Authorization', 'Bearer ' + u.token)
    .set('X-Dayline-Expected-User', u.id)
    .set('Origin', origin);
}
async function wx(code: string = randomUUID()): Promise<Login> {
  const r = await request(app.getHttpServer())
    .post('/api/v1/auth/wechat/login')
    .send({ code })
    .expect(200);
  const id = z.object({ user: z.object({ id: z.uuid() }) }).parse(data(r))
    .user.id;
  ids.add(id);
  codes.set(code, id);
  return { id, token: z.string().parse(r.headers['set-auth-token']), code };
}
async function proof(u: Login, cancel = false, operationId = randomUUID()) {
  const r = await call(u, 'post', '/auth/reauth')
    .send({
      purpose: cancel ? 'cancel_deletion' : 'delete_account',
      operationId,
      target: u.id,
      code: u.code,
    })
    .expect(200);
  return { operationId, proof: actionProofDtoSchema.parse(data(r)).proof };
}
async function apply(u: Login) {
  const p = await proof(u);
  const r = await call(u, 'post', '/me/deletion').send(p).expect(200);
  return deletionResultSchema.parse(data(r));
}
async function snap(u: Login) {
  return snapshotDtoSchema.parse(
    data(await call(u, 'get', '/snapshot').expect(200)),
  );
}
async function entry(u: Login, deleted = false) {
  const c = (await snap(u)).categories[0];
  if (!c) throw new Error('category');
  const id = randomUUID();
  await db.entry.create({
    data: {
      id,
      userId: u.id,
      categoryId: c.id,
      title: '私人标题不会进日志',
      startDate: new Date('2026-01-01'),
      ...(deleted
        ? {
            deletedAt: new Date(Date.now() - 31 * 86400000),
            purgeAfter: new Date(Date.now() - 86400000),
          }
        : {}),
    },
  });
  await db.entryFocusDay.create({
    data: { entryId: id, date: new Date('2026-01-01'), focused: true },
  });
  return id;
}
async function register(email: string) {
  const r = await request(app.getHttpServer())
    .post('/api/auth/sign-up/email')
    .set('Origin', origin)
    .send({ email, password, name: '注销验证账号' })
    .expect(200);
  const id = z.object({ user: z.object({ id: z.uuid() }) }).parse(r.body)
    .user.id;
  ids.add(id);
  return id;
}
async function verificationUrl(email: string) {
  for (const file of await readdir(mailDir)) {
    const mail = z
      .object({ to: z.string(), text: z.string() })
      .parse(JSON.parse(await readFile(join(mailDir, file), 'utf8')));
    if (mail.to === email)
      return new URL(z.string().parse(mail.text.match(/https?:[^\s]+/)?.[0]));
  }
  throw new Error('mail missing');
}
beforeAll(async () => {
  mailDir = await mkdtemp(join(tmpdir(), 'dayline-stage7-'));
  const original = testDatabaseUrl(),
    isolated = new URL(original),
    databaseName =
      'dayline_maintenance_' + randomUUID().replaceAll('-', '') + '_test';
  isolated.pathname = '/' + databaseName;
  const admin = new Client({ connectionString: original });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
  await promisify(execFile)(
    'pnpm',
    [
      'exec',
      'prisma',
      'migrate',
      'deploy',
      '--config',
      'prisma.test.config.ts',
    ],
    { env: { ...process.env, TEST_DATABASE_URL: isolated.toString() } },
  );
  config = parseEnvironment({
    NODE_ENV: 'test',
    DATABASE_URL: isolated.toString(),
    AUTH_BASE_URL: 'http://localhost:3000',
    WEB_BASE_URL: origin,
    AUTH_TRUSTED_ORIGINS: origin + ',http://localhost:3000',
    BETTER_AUTH_SECRET: 'stage7-auth-secret-at-least-32-characters',
    ACTION_PROOF_SECRET: 'stage7-proof-secret-at-least-32-characters',
    MAIL_TRANSPORT: 'file',
    MAIL_PREVIEW_DIR: mailDir,
    MAIL_FROM: 'Dayline <noreply@example.com>',
    MAINTENANCE_ENABLED: 'false',
  });
  app = await createApp(config, {
    async exchangeCode(code) {
      return { appId, openid: code };
    },
    async createMiniappCode(scene) {
      scenes.push(scene);
      return 'data:image/png;base64,aW1hZ2U=';
    },
  });
  await app.init();
  db = app.get(PrismaService);
  clock = app.get(Clock);
  maintenance = app.get(MaintenanceService);
});
afterEach(() => {
  vi.restoreAllMocks();
  config.rateLimitEnabled = false;
});
afterAll(async () => {
  if (db) {
    await db.qrRequest.deleteMany({
      where: {
        OR: [{ initiatorUserId: { in: [...ids] } }, { scannerAppId: appId }],
      },
    });
    await db.verification.deleteMany({
      where: {
        OR: [...ids].flatMap((id) => [
          { value: { contains: id } },
          { identifier: { contains: id } },
        ]),
      },
    });
    await db.user.deleteMany({ where: { id: { in: [...ids] } } });
  }
  await app?.close();
  await rm(mailDir, { recursive: true, force: true });
});
describe('deletion, maintenance and operating boundaries', () => {
  it('requires exact purpose/operation/actor/Origin, records exactly seven days and revokes all old sessions', async () => {
    const u = await wx(),
      second = await wx(u.code),
      p = await proof(u),
      now = new Date();
    await call(u, 'delete', '/me/deletion').send(p).expect(403);
    await call(u, 'post', '/me/deletion')
      .send({ ...p, operationId: randomUUID() })
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/me/deletion')
      .set('Authorization', 'Bearer ' + u.token)
      .send(p)
      .expect(400);
    vi.spyOn(clock, 'now').mockReturnValue(now);
    const result = deletionResultSchema.parse(
      data(await call(u, 'post', '/me/deletion').send(p).expect(200)),
    );
    expect(
      Date.parse(result.dueAt ?? '') - Date.parse(result.requestedAt ?? ''),
    ).toBe(7 * 86400000);
    await call(u, 'get', '/me').expect(401);
    await call(second, 'get', '/me').expect(401);
    const relogin = await wx(u.code);
    expect(relogin.id).toBe(u.id);
    const repeat = await apply(relogin);
    expect(repeat.dueAt).toBe(result.dueAt);
    await call(relogin, 'get', '/me').expect(200);
    for (const path of [
      '/snapshot',
      '/categories',
      '/trash',
      '/entries/' + randomUUID(),
    ])
      await call(relogin, 'get', path).expect(403);
    await call(relogin, 'post', '/categories')
      .send({ id: randomUUID(), name: '拒写', color: '#123456' })
      .expect(403);
    await call(relogin, 'post', '/guest-admissions/prepare')
      .send({})
      .expect(403);
    await call(relogin, 'post', '/me/wechat-binding').send({}).expect(403);
    await call(relogin, 'get', '/exports/json').expect(200);
    const cp = await proof(relogin, true);
    await call(relogin, 'delete', '/me/deletion').send(cp).expect(200);
    await call(relogin, 'get', '/me').expect(401);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: u.id } })).status,
    ).toBe('active');
  });
  it('pending-only Web WeChat QR can issue a fresh cancellation proof; other purposes remain restricted', async () => {
    const original = await wx();
    await apply(original);
    const u = await wx(original.code),
      operationId: string = randomUUID(),
      id = randomUUID();
    await call(u, 'post', '/auth/reauth')
      .send({
        purpose: 'bind_wechat',
        operationId,
        target: 'wechat',
        code: u.code,
      })
      .expect(403);
    const action = { purpose: 'cancel_deletion', operationId, target: u.id };
    const created = await call(u, 'post', '/auth/qr-requests')
      .send({ id, purpose: 'reauth', action })
      .expect(201);
    const cookie = z
      .array(z.string())
      .parse(created.headers['set-cookie'])
      .map((v) => v.split(';')[0])
      .join('; ');
    const scene = scenes.at(-1);
    if (!scene) throw new Error('scene');
    const resolved = await request(app.getHttpServer())
      .post('/api/v1/auth/qr-requests/resolve')
      .send({ scene, code: u.code })
      .expect(200);
    const scannerProof = z
      .object({ scannerProof: z.string() })
      .parse(data(resolved)).scannerProof;
    await request(app.getHttpServer())
      .post(`/api/v1/auth/qr-requests/${id}/confirm`)
      .send({ scannerProof })
      .expect(200);
    const consumed = await call(u, 'post', `/auth/qr-requests/${id}/consume`)
      .set('Cookie', cookie)
      .send({})
      .expect(200);
    await call(u, 'delete', '/me/deletion')
      .send({
        operationId,
        proof: actionProofDtoSchema.parse(data(consumed)).proof,
      })
      .expect(200);
  });
  it('strict due time blocks sessions and cancellation even before the next sweep; cleanup allows a new UUID', async () => {
    const u = await wx(),
      e = await entry(u);
    const result = await apply(u),
      pending = await wx(u.code),
      cp = await proof(pending, true);
    const due = new Date(z.string().parse(result.dueAt));
    vi.spyOn(clock, 'now').mockReturnValue(due);
    await call(pending, 'get', '/me').expect(401);
    await call(pending, 'delete', '/me/deletion').send(cp).expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/wechat/login')
      .send({ code: u.code })
      .expect(403);
    expect(await db.entry.findUnique({ where: { id: e } })).not.toBeNull();
    await maintenance.run(true);
    expect(await db.user.findUnique({ where: { id: u.id } })).toBeNull();
    const fresh = await wx(u.code);
    expect(fresh.id).not.toBe(u.id);
    expect((await snap(fresh)).entries).toHaveLength(0);
  });
  it('rechecks final time after a cancellation waits for the user lock', async () => {
    const u = await wx(),
      result = await apply(u),
      pending = await wx(u.code),
      p = await proof(pending, true);
    const due = new Date(z.string().parse(result.dueAt));
    let unlock: (() => void) | undefined, locked: (() => void) | undefined;
    const ready = new Promise<void>((r) => {
        locked = r;
      }),
      release = new Promise<void>((r) => {
        unlock = r;
      });
    const hold = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id=${u.id}::uuid FOR UPDATE`;
      locked?.();
      await release;
    });
    await ready;
    const resultRequest = call(pending, 'delete', '/me/deletion')
      .send(p)
      .then((r) => r);
    await new Promise((r) => setTimeout(r, 30));
    vi.spyOn(clock, 'now').mockReturnValue(due);
    unlock?.();
    await hold;
    expect((await resultRequest).status).toBe(401);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: u.id } })).status,
    ).toBe('pending_deletion');
    await maintenance.run(true);
  });
  it('purges bounded trash batches atomically, increments dataVersion and remains idempotent across overlapping ticks', async () => {
    const u = await wx(),
      c = (await snap(u)).categories[0];
    if (!c) throw new Error('category');
    const before = (await snap(u)).dataVersion;
    await db.entry.createMany({
      data: Array.from({ length: 205 }, () => ({
        id: randomUUID(),
        userId: u.id,
        categoryId: c.id,
        title: '到期回收站',
        startDate: new Date('2026-01-01'),
        deletedAt: new Date(Date.now() - 31 * 86400000),
        purgeAfter: new Date(Date.now() - 86400000),
      })),
    });
    await Promise.all([maintenance.run(true), maintenance.run(true)]);
    expect(await db.entry.count({ where: { userId: u.id } })).toBe(0);
    const after = (await snap(u)).dataVersion;
    expect(BigInt(after)).toBeGreaterThan(BigInt(before));
    await maintenance.run(true);
    expect((await snap(u)).dataVersion).toBe(after);
  });
  it('rolls cleanup failures back and retries without losing locator or unrelated users', async () => {
    const u = await wx(),
      unrelated = await wx();
    await entry(u);
    await entry(unrelated);
    const result = await apply(u);
    vi.spyOn(clock, 'now').mockReturnValue(
      new Date(z.string().parse(result.dueAt)),
    );
    const fail = vi
      .spyOn(db, 'transaction')
      .mockRejectedValueOnce(
        new Error('private SQL and token must not be returned'),
      );
    await expect(maintenance.run(true)).rejects.toMatchObject({
      code: 'MAINTENANCE_FAILED',
    });
    fail.mockRestore();
    expect(await db.user.findUnique({ where: { id: u.id } })).not.toBeNull();
    await maintenance.run(true);
    expect(await db.user.findUnique({ where: { id: u.id } })).toBeNull();
    expect(await db.entry.count({ where: { userId: unrelated.id } })).toBe(1);
  });
  it('erases target, flattened and historical source shells plus credentials, tasks and sensitive QR without affecting independent users', async () => {
    const target = await wx(),
      source = await wx(),
      old = await wx(),
      independent = await wx();
    await db.user.update({
      where: { id: source.id },
      data: { status: 'merged', mergedIntoUserId: target.id },
    });
    await db.user.update({
      where: { id: old.id },
      data: { status: 'merged', mergedIntoUserId: source.id },
    });
    await entry(target);
    await entry(independent);
    await db.qrRequest.create({
      data: {
        id: randomUUID(),
        purpose: 'login',
        browserSecretHash: 'x',
        sceneHash: randomUUID(),
        scannerAppId: appId,
        scannerOpenid: source.code,
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    await db.verification.create({
      data: {
        identifier: 'password-reset:' + source.id,
        value: source.id,
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    const result = await apply(target);
    vi.spyOn(clock, 'now').mockReturnValue(
      new Date(z.string().parse(result.dueAt)),
    );
    await maintenance.run(true);
    expect(
      await db.user.count({
        where: { id: { in: [target.id, source.id, old.id] } },
      }),
    ).toBe(0);
    expect(
      await db.qrRequest.count({ where: { scannerOpenid: source.code } }),
    ).toBe(0);
    expect(await db.verification.count({ where: { value: source.id } })).toBe(
      0,
    );
    expect(await db.entry.count({ where: { userId: independent.id } })).toBe(1);
  });
  it('drains more than 100 due accounts before bootstrap readiness and tolerates independent scanner instances', async () => {
    const due = new Date(Date.now() - 1000),
      requested = new Date(due.getTime() - 7 * 86400000);
    const ownIds = Array.from({ length: 205 }, () => randomUUID());
    ownIds.forEach((id) => ids.add(id));
    await db.user.createMany({
      data: ownIds.map((id) => ({
        id,
        name: '到期启动样本',
        email: `startup-${id}@identity.dayline.invalid`,
        emailKind: 'internal',
        status: 'pending_deletion',
        deletionRequestedAt: requested,
        deletionDueAt: due,
      })),
    });
    const scanner = new MaintenanceService(db, clock, config),
      second = new MaintenanceService(db, clock, config);
    expect(scanner.ready).toBe(false);
    await Promise.all([scanner.onApplicationBootstrap(), second.run(true)]);
    expect(scanner.ready).toBe(true);
    expect(await db.user.count({ where: { id: { in: ownIds } } })).toBe(0);
    await scanner.onModuleDestroy();
  });
  it('scrubs expired import input and both merge private copies while retaining minimal committed receipts and mappings', async () => {
    const a = await wx(),
      b = await wx(),
      snapshot = await snap(a),
      first = snapshot.categories[0];
    if (!first) throw new Error('category');
    const id = randomUUID(),
      e = {
        id: randomUUID(),
        categoryId: first.id,
        title: '必须删除的私密副本',
        startDate: '2026-01-01',
        endDate: null,
        version: 1,
        focusVersion: 1,
        deletedAt: null,
        purgeAfter: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    const expired = new Date(Date.now() - 1000),
      result = {
        dataVersion: '2',
        created: 1,
        skipped: 0,
        mappings: [
          { sourceKey: 'entry:source', sourceDigest: 'digest', targetId: e.id },
        ],
        committedAt: expired.toISOString(),
      };
    const plan = importJobSchema.parse({
      id,
      clientOperationId: randomUUID(),
      kind: 'csv',
      status: 'committed',
      disposition: 'committed',
      inputDigest: 'digest',
      planDigest: 'digest',
      planRevision: 1,
      baseDataVersion: '1',
      expiresAt: expired.toISOString(),
      canCommit: false,
      sourceSummary: { entries: 1, categories: 1, focusDays: 0 },
      targetSummary: { entries: 0, categories: 6, focusDays: 0 },
      categoryMappings: [],
      rows: [
        {
          sourceKey: 'entry:source',
          sourceDigest: 'digest',
          candidateId: e.id,
          source: e,
          focusDays: [],
          action: 'create_copy',
          previousTargetId: null,
          reason: null,
        },
      ],
      result,
    });
    const json = (value: unknown): Prisma.InputJsonValue =>
      JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
    await db.importJob.create({
      data: {
        id,
        userId: a.id,
        kind: 'csv',
        clientOperationId: plan.clientOperationId,
        authEpoch: 1,
        inputDigest: 'digest',
        status: 'committed',
        expiresAt: expired,
        input: json({ entries: [e] }),
        plan: json(plan),
        receipt: json(result),
      },
    });
    const mergeId = randomUUID(),
      summary = {
        userId: b.id,
        displayName: '私密显示名',
        email: 'private@example.com',
        entries: 1,
        trash: 0,
        categories: 1,
        focusDays: 0,
      };
    const merge = mergePlanSchema.parse({
      id: mergeId,
      operationId: randomUUID(),
      status: 'committed',
      planRevision: 1,
      planDigest: 'digest',
      expiresAt: expired.toISOString(),
      sourceSummary: summary,
      targetSummary: { ...summary, userId: a.id },
      sourceDataVersion: '1',
      targetDataVersion: '1',
      targetCategories: snapshot.categories,
      categoryMappings: [],
      entries: [e],
      targetEntries: [e],
      targetFocusDays: [],
      focusDays: [],
      canCommit: false,
      conflicts: [],
      counts: { retained: 1, reusedCategories: 0, newCategories: 0 },
      displayNameFrom: 'target',
      result: {
        targetUserId: a.id,
        sourceUserId: b.id,
        dataVersion: '2',
        committedAt: expired.toISOString(),
        reauthenticate: true,
      },
    });
    // An already-cleared recoverySnapshot must not leave the second full copy in plan behind.
    await db.accountMerge.create({
      data: {
        id: mergeId,
        initiatorUserId: a.id,
        sourceUserId: b.id,
        targetUserId: a.id,
        operationId: merge.operationId,
        contextId: randomUUID(),
        sourceEpoch: 1,
        targetEpoch: 1,
        sourceDataVersion: 1n,
        targetDataVersion: 1n,
        status: 'committed',
        expiresAt: expired,
        recoveryExpiresAt: expired,
        recoverySnapshot: Prisma.DbNull,
        plan: json(merge),
        mapping: {
          create: {
            mappings: json({ entries: [{ oldId: e.id, newId: e.id }] }),
          },
        },
      },
    });
    await maintenance.run(true);
    const saved = await db.importJob.findUniqueOrThrow({ where: { id } });
    expect(saved.input).toBeNull();
    expect(JSON.stringify(saved.plan)).not.toContain(e.title);
    expect(saved.receipt).toEqual(result);
    expect(importJobSchema.parse(saved.plan).rows).toHaveLength(0);
    const history = await db.accountMerge.findUniqueOrThrow({
      where: { id: mergeId },
      include: { mapping: true },
    });
    expect(history.recoverySnapshot).toBeNull();
    expect(JSON.stringify(history.plan)).not.toContain(e.title);
    expect(JSON.stringify(history.plan)).not.toContain(summary.email);
    expect(mergePlanSchema.parse(history.plan).result).toEqual(merge.result);
    expect(history.mapping).not.toBeNull();
    await maintenance.run(true);
    expect(await db.importJob.count({ where: { id } })).toBe(1);
  });
  it('does not return an HTTP timeout while a transaction continues; an exceeded deadline rolls back', async () => {
    const u = await wx(),
      prior = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    await expect(
      requestBudget.run({ deadline: Date.now() + 25 }, () =>
        db.transaction(async (tx) => {
          await tx.user.update({
            where: { id: u.id },
            data: { name: '不得提交' },
          });
          await new Promise((r) => setTimeout(r, 40));
        }),
      ),
    ).rejects.toBeDefined();
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: u.id } })).name,
    ).toBe(prior.name);
  });
  it('keeps the old verification token bound to UUID during a delete/re-register race at the final BA update', async () => {
    const email = 'delete-race-' + randomUUID() + '@example.com',
      ownerId = await register(email),
      url = await verificationUrl(email);
    const auth = app.get<DaylineAuth>(AUTH_INSTANCE),
      context = await auth.$context;
    const original = context.internalAdapter.updateUserByEmail.bind(
      context.internalAdapter,
    );
    let resume: (() => void) | undefined, reached: (() => void) | undefined;
    const paused = new Promise<void>((r) => {
        reached = r;
      }),
      release = new Promise<void>((r) => {
        resume = r;
      });
    vi.spyOn(context.internalAdapter, 'updateUserByEmail').mockImplementation(
      async (address, update) => {
        reached?.();
        await release;
        return original(address, update);
      },
    );
    const verification = request(app.getHttpServer())
      .get(url.pathname + url.search)
      .then((r) => r);
    await paused;
    // Simulate the same cleanup ownership transition after all preliminary token checks.
    await db.user.update({
      where: { id: ownerId },
      data: {
        email: `gone-${ownerId}@identity.dayline.invalid`,
        emailKind: 'internal',
        status: 'pending_deletion',
      },
    });
    const newId = await register(email);
    resume?.();
    const outcome = await verification;
    expect(outcome.status).toBeGreaterThanOrEqual(400);
    expect(outcome.status).toBeLessThan(500);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: newId } })).emailVerified,
    ).toBe(false);
  });
  it('allows repeated successful logins/reauth; five failures enforce Retry-After despite spoofed forwarding', async () => {
    const email = 'limit-' + randomUUID() + '@example.com',
      id = await register(email);
    await db.user.update({ where: { id }, data: { emailVerified: true } });
    config.rateLimitEnabled = true;
    for (let i = 0; i < 7; i++)
      await request(app.getHttpServer())
        .post('/api/auth/sign-in/email')
        .set('Origin', origin)
        .set('X-Forwarded-For', '10.1.1.' + i)
        .send({ email, password })
        .expect(200);
    for (let i = 0; i < 5; i++)
      await request(app.getHttpServer())
        .post('/api/auth/sign-in/email')
        .set('Origin', origin)
        .set('X-Forwarded-For', '10.2.1.' + i)
        .send({ email, password: 'wrong-password' })
        .expect(401);
    const limited = await request(app.getHttpServer())
      .post('/api/auth/sign-in/email')
      .set('Origin', origin)
      .set('X-Forwarded-For', '10.3.1.9')
      .send({ email, password })
      .expect(429);
    expect(limited.headers['retry-after']).toBe('600');
    config.rateLimitEnabled = false;
    const u = await wx();
    for (let i = 0; i < 7; i++) await proof(u);
    for (let i = 0; i < 5; i++)
      await call(u, 'post', '/auth/reauth')
        .send({
          purpose: 'delete_account',
          operationId: randomUUID(),
          target: u.id,
          code: randomUUID(),
        })
        .expect(403);
    const r = await call(u, 'post', '/auth/reauth')
      .send({
        purpose: 'delete_account',
        operationId: randomUUID(),
        target: u.id,
        code: u.code,
      })
      .expect(429);
    expect(r.headers['retry-after']).toBe('600');
  });
});
