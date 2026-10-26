import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  entryResultSchema,
  createGuestPackage,
  mutateGuest,
  importJobSchema,
  snapshotDtoSchema,
} from '@dayline/contracts';
import { createApp } from '../src/app.factory.js';
import { parseEnvironment } from '../src/config/environment.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Clock } from '../src/records/clock.js';
import { testDatabaseUrl } from './database-url.js';
const runId = randomUUID();
const appId = `imports-${runId}`;
const origin = 'http://localhost:5173';
let app: NestExpressApplication;
let database: PrismaService;
let clock: Clock;
const userIds = new Set<string>();
type Login = { id: string; token: string; cookie: string };
async function login(code: string = randomUUID()): Promise<Login> {
  const result = await request(app.getHttpServer())
    .post('/api/v1/auth/wechat/login')
    .send({ code })
    .expect(200);
  const id = z
    .object({ data: z.object({ user: z.object({ id: z.uuid() }) }) })
    .parse(result.body).data.user.id;
  userIds.add(id);
  return {
    id,
    token: z.string().parse(result.headers['set-auth-token']),
    cookie: z
      .array(z.string())
      .parse(result.headers['set-cookie'])
      .map((value) => value.split(';')[0])
      .join('; '),
  };
}
function call(
  user: Login,
  method: 'get' | 'post' | 'patch' | 'put' | 'delete',
  path: string,
) {
  return request(app.getHttpServer())
    [method](`/api/v1${path}`)
    .set('Authorization', `Bearer ${user.token}`)
    .set('X-Dayline-Expected-User', user.id);
}
async function snapshot(user: Login) {
  const response = await call(user, 'get', '/snapshot').expect(200);
  return { response, data: snapshotDtoSchema.parse(response.body.data) };
}
async function category(user: Login) {
  const value = (await snapshot(user)).data.categories[0];
  if (!value) throw new Error('No category');
  return value;
}
async function create(user: Login, fields: Record<string, unknown> = {}) {
  const input = {
    id: randomUUID(),
    categoryId: (await category(user)).id,
    title: '测试记录',
    startDate: '2026-10-01',
    endDate: null,
    ...fields,
  };
  const response = await call(user, 'post', '/entries').send(input).expect(201);
  return { ...entryResultSchema.parse(response.body.data), response, input };
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
        'records-integration-only-secret-at-least-32-characters',
      MAIL_TRANSPORT: 'file',
      MAIL_PREVIEW_DIR: '.local/test-records-mail',
      MAIL_FROM: 'Dayline <noreply@example.com>',
    }),
    {
      async exchangeCode(code) {
        return { appId, openid: `${runId}-${code}` };
      },
      async createMiniappCode() {
        return 'test-only';
      },
    },
  );
  await app.listen(0, '127.0.0.1');
  database = app.get(PrismaService);
  clock = app.get(Clock);
  vi.spyOn(clock, 'now').mockReturnValue(new Date('2026-10-26T04:00:00.000Z'));
});
afterAll(async () => {
  try {
    await database?.user.deleteMany({ where: { id: { in: [...userIds] } } });
  } finally {
    await app?.close();
  }
});
function guest(title = '游客记录') {
  const initial = createGuestPackage(
    () => randomUUID(),
    '2026-10-26T04:00:00.000Z',
  );
  const categoryId = initial.categories[0]?.id;
  if (!categoryId) throw new Error('category');
  return mutateGuest(
    initial,
    {
      kind: 'create',
      input: {
        id: randomUUID(),
        title,
        categoryId,
        startDate: '2026-10-01',
        endDate: null,
      },
    },
    '2026-10-26T04:00:00.000Z',
  );
}
async function prepare(
  user: Login,
  source = guest(),
  operation = randomUUID(),
) {
  const response = await call(user, 'post', '/guest-admissions/prepare')
    .send({ clientOperationId: operation, package: source })
    .expect(201);
  return {
    job: importJobSchema.parse(response.body.data),
    source,
    operation,
    response,
  };
}
async function commit(
  user: Login,
  job: ReturnType<typeof importJobSchema.parse>,
) {
  const response = await call(user, 'post', `/imports/${job.id}/commit`)
    .send({
      expectedPlanRevision: job.planRevision,
      planDigest: job.planDigest,
    })
    .expect(201);
  return importJobSchema.parse(response.body.data);
}
describe('durable guest admissions and shared import transactions', () => {
  it('automatically admits only an actually empty account, reuses six categories, and replays a lost response by operation', async () => {
    const user = await login(),
      { job, source, operation } = await prepare(user);
    expect(job.status).toBe('committed');
    expect(job.result?.created).toBe(1);
    expect((await snapshot(user)).data.categories).toHaveLength(6);
    const query = await call(
      user,
      'get',
      `/imports/by-operation/${operation}`,
    ).expect(200);
    expect(importJobSchema.parse(query.body.data).result).toEqual(job.result);
    expect((await prepare(user, source, operation)).job).toEqual(job);
    await call(user, 'post', '/guest-admissions/prepare')
      .send({
        clientOperationId: operation,
        package: { ...source, packageRevision: 3 },
      })
      .expect(409);
    expect((await snapshot(user)).data.entries).toHaveLength(1);
  });
  it('does no business writes for a nonempty account or a custom category-only account; stale commit rejects and explicit review establishes a new plan', async () => {
    const user = await login();
    await create(user);
    const before = (await snapshot(user)).data;
    const { job } = await prepare(user);
    expect(job.status).toBe('preview');
    expect((await snapshot(user)).data).toEqual(before);
    await create(user, { title: '另一端新增' });
    await call(user, 'post', `/imports/${job.id}/commit`)
      .send({
        expectedPlanRevision: job.planRevision,
        planDigest: job.planDigest,
      })
      .expect(409);
    const review = await call(user, 'post', `/imports/${job.id}/review`)
      .send({
        expectedPlanRevision: job.planRevision,
        categories: [],
        rows: [],
      })
      .expect(201);
    const revised = importJobSchema.parse(review.body.data);
    expect(revised.planRevision).toBe(2);
    expect(revised.rows[0]?.candidateId).toBe(job.rows[0]?.candidateId);
    await commit(user, revised);
    expect((await snapshot(user)).data.entries).toHaveLength(3);
    const other = await login(),
      c = await category(other);
    await call(other, 'patch', `/categories/${c.id}`)
      .send({ expectedVersion: c.version, name: '改过分类' })
      .expect(200);
    expect((await prepare(other)).job.status).toBe('preview');
  });
  it('isolates task ownership, Origin/expected user and revoked epochs, and rejects corrupted references, clocks and oversized bodies', async () => {
    const user = await login(),
      other = await login();
    await create(user);
    const { job, source } = await prepare(user);
    await call(other, 'get', `/imports/${job.id}`).expect(404);
    await request(app.getHttpServer())
      .post('/api/v1/guest-admissions/prepare')
      .set('Cookie', user.cookie)
      .set('X-Dayline-Expected-User', user.id)
      .send({ clientOperationId: randomUUID(), package: source })
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/guest-admissions/prepare')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ clientOperationId: randomUUID(), package: source })
      .expect(400);
    await call(user, 'post', '/guest-admissions/prepare')
      .send({
        clientOperationId: randomUUID(),
        package: { ...source, savedAt: '2099-01-01T00:00:00.000Z' },
      })
      .expect(422);
    await call(user, 'post', '/guest-admissions/prepare')
      .send({
        clientOperationId: randomUUID(),
        package: {
          ...source,
          entries: source.entries.map((e) => ({
            ...e,
            categoryId: randomUUID(),
          })),
        },
      })
      .expect(422);
    await call(user, 'post', '/guest-admissions/prepare')
      .send({ padding: 'x'.repeat(10 * 1024 * 1024) })
      .expect(413);
    await database.user.update({
      where: { id: user.id },
      data: { authEpoch: { increment: 1 } },
    });
    await call(user, 'get', `/imports/${job.id}`).expect(401);
  });
  it('preserves stable source receipts across later revisions: unchanged skips; changed requires explicit copy and never overwrites cloud', async () => {
    const user = await login(),
      first = await prepare(user),
      target = first.job.result?.mappings[0]?.targetId;
    if (!target) throw new Error('target');
    await call(user, 'patch', `/entries/${target}`)
      .send({ expectedVersion: 1, title: '云端另外修改' })
      .expect(200);
    const sourceEntry = first.source.entries[0];
    if (!sourceEntry) throw new Error('source');
    const changed = mutateGuest(
      first.source,
      {
        kind: 'update',
        id: sourceEntry.id,
        input: { expectedVersion: 1, title: '本机后来修改' },
      },
      '2026-10-26T04:01:00.000Z',
    );
    const added = mutateGuest(
      changed,
      {
        kind: 'create',
        input: {
          id: randomUUID(),
          title: '本机新增',
          categoryId: sourceEntry.categoryId,
          startDate: '2026-10-01',
          endDate: null,
        },
      },
      '2026-10-26T04:02:00.000Z',
    );
    const second = await prepare(user, added);
    expect(
      second.job.rows.find((r) => r.source.id === sourceEntry.id)?.action,
    ).toBe('needs_review');
    expect(second.job.canCommit).toBe(false);
    const review = await call(user, 'post', `/imports/${second.job.id}/review`)
      .send({
        expectedPlanRevision: 1,
        categories: [],
        rows: [
          {
            sourceKey: second.job.rows.find(
              (r) => r.source.id === sourceEntry.id,
            )?.sourceKey,
            action: 'create_copy',
          },
        ],
      })
      .expect(201);
    await commit(user, importJobSchema.parse(review.body.data));
    const entries = (await snapshot(user)).data.entries;
    expect(entries.map((e) => e.title).sort()).toEqual(
      ['云端另外修改', '本机后来修改', '本机新增'].sort(),
    );
    const third = await prepare(user, added);
    expect(third.job.rows.every((r) => r.action === 'skip')).toBe(true);
    await commit(user, third.job);
    expect((await snapshot(user)).data.entries).toHaveLength(3);
    const original = await prepare(user, first.source);
    expect(original.job.rows.every((row) => row.action === 'skip')).toBe(true);
    await commit(user, original.job);
    expect((await snapshot(user)).data.entries).toHaveLength(3);
  });
  it('requires explicit same-name/color mapping and enforces the 20-category boundary without dropping source categories', async () => {
    const user = await login();
    for (let i = 0; i < 14; i++)
      await call(user, 'post', '/categories')
        .send({ id: randomUUID(), name: `分类${i}`, color: '#112233' })
        .expect(201);
    const source = guest(),
      c = source.categories[0];
    if (!c) throw new Error('category');
    c.color = '#123456';
    const { job } = await prepare(user, source);
    expect(job.canCommit).toBe(false);
    expect(
      job.categoryMappings.find((m) => m.sourceId === c.id)?.needsReview,
    ).toBe(true);
    const cloud = (await snapshot(user)).data.categories.find(
      (t) => t.seedKey === c.seedKey,
    );
    if (!cloud) throw new Error('cloud');
    const review = await call(user, 'post', `/imports/${job.id}/review`)
      .send({
        expectedPlanRevision: 1,
        rows: [],
        categories: [
          {
            sourceId: c.id,
            targetId: cloud.id,
            name: cloud.name,
            color: cloud.color,
          },
        ],
      })
      .expect(201);
    const revised = importJobSchema.parse(review.body.data);
    expect(revised.canCommit).toBe(true);
    await commit(user, revised);
    expect((await snapshot(user)).data.categories).toHaveLength(20);
  });
  it('rolls back category, entries, focus, version and receipt together after a database failure; concurrent commits have one effect', async () => {
    const user = await login();
    await create(user);
    const { job } = await prepare(user);
    const before = (await snapshot(user)).data;
    const target = job.rows[0]?.candidateId;
    if (!target) throw new Error('target');
    const fn = 'fail_import_' + runId.replaceAll('-', '');
    await database.$executeRawUnsafe(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${target}'::uuid THEN RAISE EXCEPTION 'injected import failure'; END IF; RETURN NEW; END $$`,
    );
    await database.$executeRawUnsafe(
      `CREATE TRIGGER ${fn} BEFORE INSERT ON entries FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    );
    try {
      await call(user, 'post', `/imports/${job.id}/commit`)
        .send({ expectedPlanRevision: 1, planDigest: job.planDigest })
        .expect(500);
    } finally {
      await database.$executeRawUnsafe(`DROP TRIGGER ${fn} ON entries`);
      await database.$executeRawUnsafe(`DROP FUNCTION ${fn}()`);
    }
    expect((await snapshot(user)).data).toEqual(before);
    expect(
      importJobSchema.parse(
        (await call(user, 'get', `/imports/${job.id}`).expect(200)).body.data,
      ).status,
    ).toBe('preview');
    const results = await Promise.all([commit(user, job), commit(user, job)]);
    expect(results[0]?.result).toEqual(results[1]?.result);
    expect((await snapshot(user)).data.entries).toHaveLength(2);
  });
  it('expires and cancels previews without changing business data, while committed receipts survive their preview expiry', async () => {
    const user = await login();
    await create(user);
    const { job } = await prepare(user);
    await database.importJob.update({
      where: { id: job.id },
      data: { expiresAt: new Date('2020-01-01') },
    });
    expect(
      importJobSchema.parse(
        (await call(user, 'get', `/imports/${job.id}`).expect(200)).body.data,
      ).status,
    ).toBe('expired');
    await call(user, 'post', `/imports/${job.id}/commit`)
      .send({ expectedPlanRevision: 1, planDigest: job.planDigest })
      .expect(409);
    const other = await prepare(user);
    await call(user, 'delete', `/imports/${other.job.id}`).expect(200);
    expect((await snapshot(user)).data.entries).toHaveLength(1);
    const owner = await login(),
      committed = await prepare(owner);
    await database.importJob.update({
      where: { id: committed.job.id },
      data: { expiresAt: new Date('2020-01-01') },
    });
    const restored = importJobSchema.parse(
      (await call(owner, 'get', `/imports/${committed.job.id}`).expect(200))
        .body.data,
    );
    expect(restored.result).toEqual(committed.job.result);
    expect(
      (await prepare(owner, committed.source, committed.operation)).job.result,
    ).toEqual(restored.result);
    expect(
      importJobSchema.parse(
        (
          await call(
            owner,
            'get',
            `/imports/by-operation/${committed.operation}`,
          ).expect(200)
        ).body.data,
      ).status,
    ).toBe('committed');
    expect((await snapshot(owner)).data.entries).toHaveLength(1);
  });
});

describe('bounded admission capacity', () => {
  it('accepts 1000 entries/10000 focus and 10000-entry engineering limit with linear source planning and bounded bulk writes', async () => {
    for (const [entriesCount, focusPerEntry] of [
      [1000, 10],
      [10000, 0],
    ] as const) {
      const user = await login(),
        source = guest('容量样本'),
        example = source.entries[0];
      if (!example) throw new Error('source');
      source.entries = Array.from({ length: entriesCount }, (_, index) => ({
        ...example,
        id: randomUUID(),
        title: `容量${index}`,
      }));
      source.focusDays = source.entries.flatMap((e) =>
        Array.from({ length: focusPerEntry }, (_, index) => ({
          entryId: e.id,
          date: `2026-10-${String(index + 1).padStart(2, '0')}`,
          focused: true,
          version: 1,
        })),
      );
      const started = performance.now(),
        { job } = await prepare(user, source);
      expect(job.status).toBe('committed');
      expect(job.result?.created).toBe(entriesCount);
      expect(await database.entry.count({ where: { userId: user.id } })).toBe(
        entriesCount,
      );
      expect(
        await database.entryFocusDay.count({
          where: { entry: { userId: user.id } },
        }),
      ).toBe(entriesCount * focusPerEntry);
      source.packageRevision++;
      source.entries = source.entries.map((e) => ({
        ...e,
        title: e.title + '修改',
        version: e.version + 1,
      }));
      const updated = await prepare(user, source);
      expect(
        updated.job.rows.every((row) => row.action === 'needs_review'),
      ).toBe(true);
      const reviewBody = {
        expectedPlanRevision: 1,
        categories: [],
        rows: updated.job.rows.map((row) => ({
          sourceKey: row.sourceKey,
          action: 'create_copy',
        })),
      };
      expect(Buffer.byteLength(JSON.stringify(reviewBody))).toBeGreaterThan(
        64 * 1024,
      );
      const reviewed = importJobSchema.parse(
        (
          await call(user, 'post', `/imports/${updated.job.id}/review`)
            .send(reviewBody)
            .expect(201)
        ).body.data,
      );
      expect(reviewed.canCommit).toBe(true);
      expect(reviewed.rows).toHaveLength(entriesCount);
      await call(user, 'post', `/imports/${updated.job.id}/review`)
        .send({
          expectedPlanRevision: reviewed.planRevision,
          categories: [],
          rows: Array.from({ length: 10001 }, () => reviewBody.rows[0]),
        })
        .expect(422);
      await call(user, 'post', `/imports/${updated.job.id}/review`)
        .send({ padding: 'x'.repeat(4 * 1024 * 1024) })
        .expect(413);
      await call(user, 'post', `/imports/${updated.job.id}/review`)
        .send({
          expectedPlanRevision: reviewed.planRevision,
          categories: [],
          rows: [{ sourceKey: 'x'.repeat(161), action: 'skip' }],
        })
        .expect(422);
      console.info(
        'admission capacity',
        JSON.stringify({
          entries: entriesCount,
          focusDays: entriesCount * focusPerEntry,
          elapsedMs: Math.round(performance.now() - started),
        }),
      );
    }
  }, 60_000);
});
