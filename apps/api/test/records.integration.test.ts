import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DEFAULT_CATEGORIES } from '@dayline/core';
import {
  categoryResultSchema,
  entryResultSchema,
  focusResultSchema,
  snapshotDtoSchema,
} from '@dayline/contracts';
import { createApp } from '../src/app.factory.js';
import { parseEnvironment } from '../src/config/environment.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Clock } from '../src/records/clock.js';
import { testDatabaseUrl } from './database-url.js';
const runId = randomUUID();
const appId = `records-${runId}`;
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
describe('record core: real PostgreSQL and protected HTTP', () => {
  it('initializes once in the user INSERT transaction; constants match migration and rollback is complete', async () => {
    const users = await Promise.all(
      Array.from({ length: 5 }, () => login('concurrent')),
    );
    const user = users[0];
    if (!user) throw new Error('No user');
    expect(new Set(users.map((value) => value.id)).size).toBe(1);
    const initial = await snapshot(user);
    expect(initial.data.categories).toHaveLength(6);
    expect(
      initial.data.categories
        .map(({ seedKey, name, color }) => ({ seedKey, name, color }))
        .sort((a, b) => String(a.seedKey).localeCompare(String(b.seedKey))),
    ).toEqual(
      [...DEFAULT_CATEGORIES].sort((a, b) =>
        a.seedKey.localeCompare(b.seedKey),
      ),
    );
    expect(
      (await database.user.findUniqueOrThrow({ where: { id: user.id } }))
        .initializedAt,
    ).not.toBeNull();
    const sql = await readFile(
      new URL(
        '../prisma/migrations/20261026162718_record_core/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );
    for (const value of DEFAULT_CATEGORIES)
      expect(sql).toContain(
        `('${value.seedKey}','${value.name}','${value.color}')`,
      );
    const rollbackId = randomUUID();
    await expect(
      database.$transaction(async (tx) => {
        await tx.user.create({
          data: {
            id: rollbackId,
            name: '回滚',
            email: `${rollbackId}@example.com`,
          },
        });
        expect(await tx.category.count({ where: { userId: rollbackId } })).toBe(
          6,
        );
        expect(
          (await tx.user.findUniqueOrThrow({ where: { id: rollbackId } }))
            .initializedAt,
        ).not.toBeNull();
        throw new Error('injected before commit');
      }),
    ).rejects.toThrow('injected');
    expect(await database.user.count({ where: { id: rollbackId } })).toBe(0);
    expect(
      await database.category.count({ where: { userId: rollbackId } }),
    ).toBe(0);
    const first = initial.data.categories[0],
      target = initial.data.categories[1];
    if (!first || !target) throw new Error('Missing defaults');
    await call(user, 'patch', `/categories/${first.id}`)
      .send({ expectedVersion: 1, name: '已改名' })
      .expect(200);
    await call(user, 'delete', `/categories/${target.id}`)
      .send({
        expectedVersion: 1,
        transferToCategoryId: first.id,
        expectedTargetVersion: 2,
      })
      .expect(200);
    await login('concurrent');
    const after = (await snapshot(user)).data;
    expect(after.categories).toHaveLength(5);
    expect(after.categories.some((value) => value.name === '已改名')).toBe(
      true,
    );
  });
  it('isolates two users, rejects ownership injection and tests the real uni PATCH override guard', async () => {
    const a = await login(),
      b = await login();
    const entry = (await create(a)).entry;
    for (const path of [`/entries/${entry.id}`, `/entries/${randomUUID()}`])
      await call(b, 'get', path).expect(404);
    await call(b, 'patch', `/entries/${entry.id}`)
      .send({ expectedVersion: 1, title: '越权' })
      .expect(404);
    await call(b, 'delete', `/entries/${entry.id}`)
      .send({ expectedVersion: 1 })
      .expect(404);
    await call(b, 'put', `/entries/${entry.id}/focus-days/2026-10-25`)
      .send({ focused: true, expectedEntryVersion: 1, expectedFocusVersion: 0 })
      .expect(404);
    await call(b, 'post', '/entries')
      .send({
        id: randomUUID(),
        title: 'wrong category',
        startDate: '2026-10-01',
        endDate: null,
        categoryId: entry.categoryId,
      })
      .expect(404);
    const override = () =>
      request(app.getHttpServer())
        .post(`/api/v1/entries/${entry.id}`)
        .set('X-Dayline-Method-Override', 'PATCH');
    await override()
      .set('Authorization', `Bearer ${a.token}`)
      .send({ title: 'x', expectedVersion: 1 })
      .expect(400);
    await override()
      .set('Authorization', `Bearer ${a.token}`)
      .set('X-Dayline-Expected-User', b.id)
      .send({ title: 'x', expectedVersion: 1 })
      .expect(409);
    await override()
      .set('Cookie', a.cookie)
      .set('X-Dayline-Expected-User', a.id)
      .send({ title: 'x', expectedVersion: 1 })
      .expect(403);
    await override()
      .set('Authorization', `Bearer ${b.token}`)
      .set('X-Dayline-Expected-User', b.id)
      .send({ title: 'x', expectedVersion: 1 })
      .expect(404);
    const success = await override()
      .set('Authorization', `Bearer ${a.token}`)
      .set('X-Dayline-Expected-User', a.id)
      .send({ title: '原生微信PATCH', expectedVersion: 1 })
      .expect(200);
    expect(entryResultSchema.parse(success.body.data).entry.title).toBe(
      '原生微信PATCH',
    );
    await call(a, 'post', '/entries')
      .send({
        id: randomUUID(),
        userId: b.id,
        title: 'injected',
        startDate: '2026-10-01',
        endDate: null,
        categoryId: entry.categoryId,
      })
      .expect(422);
    const collision = await call(b, 'post', '/entries')
      .send({
        id: entry.id,
        title: 'collision',
        startDate: '2026-10-01',
        endDate: null,
        categoryId: (await category(b)).id,
      })
      .expect(409);
    expect(JSON.stringify(collision.body)).not.toContain('原生微信PATCH');
  });
  it('validates calendar boundaries, Unicode limits, ranges, future starts and finish idempotency', async () => {
    const user = await login();
    const categoryId = (await category(user)).id;
    for (const startDate of [
      '0000-01-01',
      '2026-02-29',
      '1900-02-29',
      '2026-04-31',
      '2026-1-01',
      '10000-01-01',
    ])
      await call(user, 'post', '/entries')
        .send({
          id: randomUUID(),
          categoryId,
          title: 'a',
          startDate,
          endDate: null,
        })
        .expect(422);
    for (const startDate of [
      '0001-01-01',
      '0099-12-31',
      '2000-02-29',
      '9999-12-31',
    ])
      await create(user, { startDate, title: '😀'.repeat(100) });
    await call(user, 'post', '/entries')
      .send({
        id: randomUUID(),
        categoryId,
        title: '😀'.repeat(101),
        startDate: '2026-01-01',
        endDate: null,
      })
      .expect(422);
    await call(user, 'post', '/entries')
      .send({
        id: randomUUID(),
        categoryId,
        title: 'a',
        startDate: '2026-01-02',
        endDate: '2026-01-01',
      })
      .expect(422);
    const future = await create(user, { startDate: '2026-10-27' });
    await call(user, 'post', `/entries/${future.entry.id}/finish`)
      .send({ expectedVersion: 1 })
      .expect(422);
    const historical = await create(user, { endDate: '2026-10-20' });
    await call(user, 'post', `/entries/${historical.entry.id}/finish`)
      .send({ expectedVersion: 1 })
      .expect(409);
    const current = await create(user, { endDate: '2026-11-01' });
    const finished = await call(
      user,
      'post',
      `/entries/${current.entry.id}/finish`,
    )
      .send({ expectedVersion: 1 })
      .expect(201);
    expect(entryResultSchema.parse(finished.body.data).entry.endDate).toBe(
      '2026-10-26',
    );
    const again = await call(
      user,
      'post',
      `/entries/${current.entry.id}/finish`,
    )
      .send({ expectedVersion: 2 })
      .expect(201);
    expect(again.body.meta.dataVersion).toBe(finished.body.meta.dataVersion);
  });
  it('retries stable IDs without duplicate/overwrite and permits one content CAS winner', async () => {
    const user = await login();
    const first = await create(user);
    const retry = await call(user, 'post', '/entries')
      .send(first.input)
      .expect(201);
    expect(entryResultSchema.parse(retry.body.data).alreadyExists).toBe(true);
    expect(retry.body.meta.dataVersion).toBe(
      first.response.body.meta.dataVersion,
    );
    await call(user, 'post', '/entries')
      .send({ ...first.input, title: 'changed after lost response' })
      .expect(409);
    const results = await Promise.all(
      ['A', 'B'].map((title) =>
        call(user, 'patch', `/entries/${first.entry.id}`).send({
          expectedVersion: 1,
          title,
        }),
      ),
    );
    expect(results.map((value) => value.status).sort()).toEqual([200, 409]);
    const saved = await call(user, 'get', `/entries/${first.entry.id}`).expect(
      200,
    );
    expect(entryResultSchema.parse(saved.body.data).entry.version).toBe(2);
    expect((await snapshot(user)).data.entries).toHaveLength(1);
  });
  it('keeps focus content version independent, preserves false versions, and confirms exact removal sets', async () => {
    const user = await login();
    const { entry } = await create(user);
    const put = (
      date: string,
      focused: boolean,
      expectedFocusVersion: number,
    ) =>
      call(user, 'put', `/entries/${entry.id}/focus-days/${date}`).send({
        focused,
        expectedEntryVersion: 1,
        expectedFocusVersion,
      });
    const states = await Promise.all(
      ['2026-10-24', '2026-10-25'].map((date) => put(date, true, 0)),
    );
    expect(states.map((value) => value.status)).toEqual([200, 200]);
    const before = await call(user, 'get', `/entries/${entry.id}`).expect(200);
    expect(entryResultSchema.parse(before.body.data).entry).toMatchObject({
      version: 1,
      focusVersion: 3,
    });
    const same = await put('2026-10-24', true, 1).expect(200);
    expect(focusResultSchema.parse(same.body.data).focusVersion).toBe(3);
    await put('2026-10-24', true, 0).expect(409);
    await put('2026-10-27', true, 0).expect(422);
    await put('2026-09-30', true, 0).expect(422);
    const preview = await call(user, 'patch', `/entries/${entry.id}`)
      .send({ expectedVersion: 1, endDate: '2026-10-23' })
      .expect(409);
    expect(preview.body.error.code).toBe('FOCUS_REMOVAL_CONFIRMATION_REQUIRED');
    expect((await snapshot(user)).data.entries[0]?.version).toBe(1);
    await put('2026-10-26', true, 0).expect(200);
    await call(user, 'patch', `/entries/${entry.id}`)
      .send({
        expectedVersion: 1,
        endDate: '2026-10-23',
        focusRemovalAcknowledgement:
          preview.body.error.details.affectedFocusDays,
      })
      .expect(409);
    const currentPreview = await call(user, 'patch', `/entries/${entry.id}`)
      .send({ expectedVersion: 1, endDate: '2026-10-23' })
      .expect(409);
    const changed = await call(user, 'patch', `/entries/${entry.id}`)
      .send({
        expectedVersion: 1,
        endDate: '2026-10-23',
        focusRemovalAcknowledgement:
          currentPreview.body.error.details.affectedFocusDays,
      })
      .expect(200);
    const result = entryResultSchema.parse(changed.body.data);
    expect(result.entry).toMatchObject({ version: 2, focusVersion: 5 });
    expect(result.focusDays).toHaveLength(3);
    expect(
      result.focusDays.every((focus) => !focus.focused && focus.version === 2),
    ).toBe(true);
    const competing = await create(user);
    const competition = await Promise.all(
      [true, true].map((focused) =>
        call(
          user,
          'put',
          `/entries/${competing.entry.id}/focus-days/2026-10-25`,
        ).send({ focused, expectedEntryVersion: 1, expectedFocusVersion: 0 }),
      ),
    );
    expect(competition.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
  });
  it('confirms 10,000 focus states through bounded large PATCH bodies, keeping exact versions and ordinary limits', async () => {
    const user = await login();
    const { entry } = await create(user, { startDate: '1990-01-01' });
    const dates = Array.from(
      { length: 10_000 },
      (_, index) => new Date(Date.UTC(1990, 0, 1) + index * 86400000),
    );
    await database.entryFocusDay.createMany({
      data: dates.map((date) => ({ entryId: entry.id, date, focused: true })),
    });
    await database.entry.update({
      where: { id: entry.id },
      data: { focusVersion: 10001 },
    });
    await database.user.update({
      where: { id: user.id },
      data: { dataVersion: { increment: 1 } },
    });
    const preview = await call(user, 'patch', `/entries/${entry.id}`)
      .send({ expectedVersion: 1, endDate: '1990-01-01' })
      .expect(409);
    const acknowledgement = z
      .array(z.object({ date: z.string(), version: z.number() }))
      .parse(preview.body.error.details.affectedFocusDays);
    expect(acknowledgement).toHaveLength(9999);
    expect(Buffer.byteLength(JSON.stringify(acknowledgement))).toBeGreaterThan(
      64 * 1024,
    );
    const before = (await snapshot(user)).data;
    expect(before.entries[0]?.version).toBe(1);
    expect(before.focusDays.filter((focus) => focus.focused)).toHaveLength(
      10_000,
    );
    const date = acknowledgement[0]?.date;
    if (!date) throw new Error('No focus date');
    for (const [focused, expectedFocusVersion] of [
      [false, 1],
      [true, 2],
    ] as const)
      await call(user, 'put', `/entries/${entry.id}/focus-days/${date}`)
        .send({ focused, expectedEntryVersion: 1, expectedFocusVersion })
        .expect(200);
    const stale = await call(user, 'patch', `/entries/${entry.id}`)
      .send({
        expectedVersion: 1,
        endDate: '1990-01-01',
        focusRemovalAcknowledgement: acknowledgement,
      })
      .expect(409);
    expect(stale.body.error.code).toBe('FOCUS_REMOVAL_CONFIRMATION_REQUIRED');
    const latest = stale.body.error.details.affectedFocusDays;
    await call(user, 'patch', `/entries/${entry.id}`)
      .send({
        expectedVersion: 1,
        endDate: '1990-01-01',
        focusRemovalAcknowledgement: Array.from({ length: 20001 }, () => ({
          date: '1990-01-02',
          version: 1,
        })),
      })
      .expect(422);
    await call(user, 'patch', `/entries/${entry.id}`)
      .send({ expectedVersion: 1, title: 'x'.repeat(70 * 1024) })
      .expect(413);
    await call(user, 'post', '/entries')
      .send({
        id: randomUUID(),
        title: 'x'.repeat(70 * 1024),
        categoryId: entry.categoryId,
        startDate: '1990-01-01',
        endDate: null,
      })
      .expect(413);
    await call(user, 'patch', `/entries/${entry.id}`)
      .send({
        expectedVersion: 1,
        title: 'x'.repeat(1024 * 1024),
        focusRemovalAcknowledgement: [],
      })
      .expect(413);
    const confirmed = await request(app.getHttpServer())
      .post(`/api/v1/entries/${entry.id}`)
      .set('X-Dayline-Method-Override', 'PATCH')
      .set('Authorization', `Bearer ${user.token}`)
      .set('X-Dayline-Expected-User', user.id)
      .send({
        expectedVersion: 1,
        endDate: '1990-01-01',
        focusRemovalAcknowledgement: latest,
      })
      .expect(200);
    const result = entryResultSchema.parse(confirmed.body.data);
    expect(result.entry).toMatchObject({
      version: 2,
      focusVersion: 10004,
      endDate: '1990-01-01',
    });
    expect(result.focusDays.filter((focus) => focus.focused)).toHaveLength(1);
    expect(result.focusDays.find((focus) => focus.date === date)).toMatchObject(
      { focused: false, version: 4 },
    );
    expect(BigInt(confirmed.body.meta.dataVersion)).toBe(
      BigInt(before.dataVersion) + 3n,
    );
    const targets = Array.from({ length: 1000 }, () => ({
      id: randomUUID(),
      expectedVersion: 2147483647,
    }));
    expect(
      Buffer.byteLength(JSON.stringify({ entries: targets })),
    ).toBeGreaterThan(64 * 1024);
    await database.entry.createMany({
      data: targets.map((target) => ({
        id: target.id,
        userId: user.id,
        categoryId: entry.categoryId,
        title: '批量回收站',
        startDate: new Date('2026-10-01T00:00:00.000Z'),
        version: target.expectedVersion,
        deletedAt: new Date('2026-10-26T04:00:00.000Z'),
        purgeAfter: new Date('2026-11-25T04:00:00.000Z'),
      })),
    });
    await database.user.update({
      where: { id: user.id },
      data: { dataVersion: { increment: 1 } },
    });
    await call(user, 'post', '/trash/purge')
      .send({ entries: [...targets, { id: randomUUID(), expectedVersion: 1 }] })
      .expect(422);
    const purged = await call(user, 'post', '/trash/purge')
      .send({ entries: targets })
      .expect(201);
    expect(purged.body.data.purgedCount).toBe(1000);
    expect(
      await database.entry.count({
        where: { userId: user.id, deletedAt: { not: null } },
      }),
    ).toBe(0);
  });
  it('refuses uninitialized business data without masking partial state as complete or blocking /me', async () => {
    const user = await login();
    const { entry } = await create(user);
    const before = await snapshot(user);
    const etag = z.string().parse(before.response.headers.etag);
    await database.user.update({
      where: { id: user.id },
      data: { initializedAt: null },
    });
    for (const path of [
      '/snapshot',
      '/categories',
      '/trash',
      `/entries/${entry.id}`,
    ]) {
      const response = await call(user, 'get', path)
        .set('If-None-Match', etag)
        .expect(503);
      expect(response.body.error.code).toBe('ACCOUNT_NOT_INITIALIZED');
      expect(response.body.data).toBeUndefined();
    }
    await call(user, 'patch', `/entries/${entry.id}`)
      .send({ expectedVersion: 1, title: 'must not save' })
      .expect(503);
    await call(user, 'get', '/me').expect(200);
    const state = await database.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(state.dataVersion.toString()).toBe(before.data.dataVersion);
    expect(
      (await database.entry.findUniqueOrThrow({ where: { id: entry.id } }))
        .title,
    ).toBe(entry.title);
    await database.user.update({
      where: { id: user.id },
      data: { initializedAt: new Date() },
    });
    expect((await snapshot(user)).data.entries).toHaveLength(1);
  });
  it('moves active and trash entries atomically on category deletion and enforces category boundaries', async () => {
    const user = await login(),
      other = await login();
    const source = await category(user);
    const target = (await snapshot(user)).data.categories[1];
    if (!target) throw new Error('No target');
    const active = await create(user),
      trash = await create(user);
    await call(user, 'delete', `/entries/${trash.entry.id}`)
      .send({ expectedVersion: 1 })
      .expect(200);
    await call(user, 'delete', `/categories/${source.id}`)
      .send({
        expectedVersion: 1,
        transferToCategoryId: (await category(other)).id,
        expectedTargetVersion: 1,
      })
      .expect(404);
    await call(user, 'delete', `/categories/${source.id}`)
      .send({
        expectedVersion: 2,
        transferToCategoryId: target.id,
        expectedTargetVersion: 1,
      })
      .expect(409);
    const before = (await snapshot(user)).data.dataVersion;
    const moved = await call(user, 'delete', `/categories/${source.id}`)
      .send({
        expectedVersion: 1,
        transferToCategoryId: target.id,
        expectedTargetVersion: 1,
      })
      .expect(200);
    expect(BigInt(moved.body.meta.dataVersion)).toBe(BigInt(before) + 1n);
    const state = (await snapshot(user)).data;
    expect(
      state.entries.find((entry) => entry.id === active.entry.id),
    ).toMatchObject({ categoryId: target.id, version: 2 });
    expect(state.trashEntries[0]).toMatchObject({
      categoryId: target.id,
      version: 3,
    });
    const unique = await call(user, 'post', '/categories')
      .send({ id: randomUUID(), name: '😀'.repeat(12), color: '#abcdef' })
      .expect(201);
    expect(categoryResultSchema.parse(unique.body.data).category.color).toBe(
      '#ABCDEF',
    );
    await call(user, 'post', '/categories')
      .send({ id: randomUUID(), name: '😀'.repeat(13), color: '#abcdef' })
      .expect(422);
    await call(user, 'post', '/categories')
      .send({ id: randomUUID(), name: target.name, color: '#abcdef' })
      .expect(409);
    for (let index = 6; index < 20; index++)
      await call(user, 'post', '/categories')
        .send({ id: randomUUID(), name: `额外${index}`, color: '#ABCDEF' })
        .expect(201);
    await call(user, 'post', '/categories')
      .send({ id: randomUUID(), name: '超过上限', color: '#ABCDEF' })
      .expect(422);
  });
  it('rolls back transferred entries and dataVersion when category deletion fails after the transfer', async () => {
    const user = await login();
    const source = await category(user),
      target = (await snapshot(user)).data.categories[1];
    if (!target) throw new Error('Missing target');
    await call(user, 'patch', `/categories/${source.id}`)
      .send({ expectedVersion: 1, name: '阶段2失败注入' })
      .expect(200);
    await create(user);
    const before = (await snapshot(user)).data;
    // Fixed SQL on the guarded dedicated test database. The trigger fails only the
    // unique test category after the service already transferred its entries.
    await database.$executeRaw`CREATE FUNCTION dayline_stage2_fail_category_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.name = '阶段2失败注入' THEN RAISE EXCEPTION 'injected category failure'; END IF; RETURN OLD; END; $$`;
    await database.$executeRaw`CREATE TRIGGER dayline_stage2_fail_category_delete BEFORE DELETE ON categories FOR EACH ROW EXECUTE FUNCTION dayline_stage2_fail_category_delete()`;
    try {
      const response = await call(user, 'delete', `/categories/${source.id}`)
        .send({
          expectedVersion: 2,
          transferToCategoryId: target.id,
          expectedTargetVersion: 1,
        })
        .expect(500);
      expect(response.body.error.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(response.body)).not.toMatch(/injected|Prisma|SQL/);
      expect((await snapshot(user)).data).toEqual(before);
    } finally {
      await database.$executeRaw`DROP TRIGGER dayline_stage2_fail_category_delete ON categories`;
      await database.$executeRaw`DROP FUNCTION dayline_stage2_fail_category_delete()`;
    }
  });
  it('serializes restore versus permanent purge without resurrecting the losing operation', async () => {
    const user = await login();
    for (let iteration = 0; iteration < 4; iteration++) {
      const { entry } = await create(user);
      await call(user, 'delete', `/entries/${entry.id}`)
        .send({ expectedVersion: 1 })
        .expect(200);
      const responses = await Promise.all([
        call(user, 'post', `/trash/${entry.id}/restore`).send({
          expectedVersion: 2,
        }),
        call(user, 'post', '/trash/purge').send({
          entries: [{ id: entry.id, expectedVersion: 2 }],
        }),
      ]);
      expect(
        responses.filter((response) => response.status === 201),
      ).toHaveLength(1);
      expect(
        responses.filter((response) => [404, 409].includes(response.status)),
      ).toHaveLength(1);
      const current = await database.entry.findUnique({
        where: { id: entry.id },
      });
      if (responses[0]?.status === 201)
        expect(current).toMatchObject({ version: 3, deletedAt: null });
      else expect(current).toBeNull();
    }
  });
  it('rejects the last category with the stable error and enforces database ownership/deletion/date constraints', async () => {
    const user = await login(),
      other = await login();
    const categories = (await snapshot(user)).data.categories;
    const keep = categories[0];
    if (!keep) throw new Error('No category');
    for (const source of categories.slice(1))
      await call(user, 'delete', `/categories/${source.id}`)
        .send({
          expectedVersion: 1,
          transferToCategoryId: keep.id,
          expectedTargetVersion: 1,
        })
        .expect(200);
    for (const transferToCategoryId of [keep.id, randomUUID()]) {
      const result = await call(user, 'delete', `/categories/${keep.id}`)
        .send({
          expectedVersion: 1,
          transferToCategoryId,
          expectedTargetVersion: 1,
        })
        .expect(409);
      expect(result.body.error.code).toBe('LAST_CATEGORY');
    }
    const { entry } = await create(user);
    await expect(
      database.entry.update({
        where: { id: entry.id },
        data: { categoryId: (await category(other)).id },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      database.entry.update({
        where: { id: entry.id },
        data: { endDate: new Date('2026-09-30T00:00:00.000Z') },
      }),
    ).rejects.toThrow();
    await expect(
      database.entry.update({
        where: { id: entry.id },
        data: { deletedAt: new Date(), purgeAfter: null },
      }),
    ).rejects.toThrow();
    expect((await snapshot(user)).data.entries[0]).toMatchObject({
      categoryId: keep.id,
      endDate: null,
      deletedAt: null,
      version: 1,
    });
  });
  it('retains focuses on restore, rejects expiration at exact boundary, and requires current clear confirmation', async () => {
    const user = await login();
    const { entry } = await create(user);
    await call(user, 'put', `/entries/${entry.id}/focus-days/2026-10-25`)
      .send({ focused: true, expectedEntryVersion: 1, expectedFocusVersion: 0 })
      .expect(200);
    const deleted = await call(user, 'delete', `/entries/${entry.id}`)
      .send({ expectedVersion: 1 })
      .expect(200);
    const trashEntry = entryResultSchema.parse(deleted.body.data).entry;
    expect(trashEntry.purgeAfter).toBe('2026-11-25T04:00:00.000Z');
    await call(user, 'delete', `/entries/${entry.id}`)
      .send({ expectedVersion: 1 })
      .expect(409);
    await call(user, 'patch', `/entries/${entry.id}`)
      .send({ expectedVersion: 2, title: 'must not revive' })
      .expect(409);
    const restored = await call(user, 'post', `/trash/${entry.id}/restore`)
      .send({ expectedVersion: 2 })
      .expect(201);
    expect(entryResultSchema.parse(restored.body.data)).toMatchObject({
      entry: { version: 3, deletedAt: null },
      focusDays: [{ focused: true, version: 1 }],
    });
    await call(user, 'delete', `/entries/${entry.id}`)
      .send({ expectedVersion: 3 })
      .expect(200);
    const before = (await snapshot(user)).data.dataVersion;
    const newEntry = (await create(user)).entry;
    await call(user, 'delete', `/entries/${newEntry.id}`)
      .send({ expectedVersion: 1 })
      .expect(200);
    await call(user, 'post', '/trash/purge')
      .send({ expectedDataVersion: before })
      .expect(409);
    await call(user, 'post', '/trash/purge')
      .send({
        entries: [
          { id: entry.id, expectedVersion: 4 },
          { id: newEntry.id, expectedVersion: 1 },
        ],
      })
      .expect(409);
    expect((await snapshot(user)).data.trashEntries).toHaveLength(2);
    await call(user, 'post', '/trash/purge')
      .send({ entries: [{ id: newEntry.id, expectedVersion: 2 }] })
      .expect(201);
    vi.mocked(clock.now).mockReturnValue(new Date('2026-11-25T03:59:59.999Z'));
    expect(
      (await call(user, 'get', '/trash').expect(200)).body.data,
    ).toHaveLength(1);
    vi.mocked(clock.now).mockReturnValue(new Date('2026-11-25T04:00:00.000Z'));
    await call(user, 'post', `/trash/${entry.id}/restore`)
      .send({ expectedVersion: 4 })
      .expect(410);
    expect(
      (await call(user, 'get', '/trash').expect(200)).body.data,
    ).toHaveLength(0);
    const current = await snapshot(user);
    expect(current.data.trashEntries).toHaveLength(1);
    await call(user, 'post', '/trash/purge')
      .send({ expectedDataVersion: current.data.dataVersion })
      .expect(201);
    expect(
      await database.entryFocusDay.count({ where: { entryId: entry.id } }),
    ).toBe(0);
    await call(user, 'patch', `/entries/${entry.id}`)
      .send({ expectedVersion: 4, title: 'gone' })
      .expect(404);
    vi.mocked(clock.now).mockReturnValue(new Date('2026-10-26T04:00:00.000Z'));
  });
  it('uses an authenticated per-user/day ETag and returns consistent references under writes', async () => {
    const a = await login(),
      b = await login();
    await database.user.update({
      where: { id: a.id },
      data: { dataVersion: 9007199254740993n },
    });
    const first = await snapshot(a);
    expect(first.data.dataVersion).toBe('9007199254740993');
    const etag = z.string().parse(first.response.headers.etag);
    const unchanged = await call(a, 'get', '/snapshot')
      .set('If-None-Match', etag)
      .expect(304);
    expect(unchanged.text).toBe('');
    expect(unchanged.headers['cache-control']).toBe('private, no-cache');
    const varied = await call(a, 'get', '/snapshot')
      .set('Origin', origin)
      .expect(200);
    expect(String(varied.headers.vary).split(/,\s*/).sort()).toEqual([
      'Authorization',
      'Cookie',
      'Origin',
    ]);
    await call(b, 'get', '/snapshot').set('If-None-Match', etag).expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/snapshot')
      .set('If-None-Match', etag)
      .expect(401);
    const entry = (await create(a)).entry;
    await call(a, 'put', `/entries/${entry.id}/focus-days/2026-10-25`)
      .send({ focused: true, expectedEntryVersion: 1, expectedFocusVersion: 0 })
      .expect(200);
    const categories = (await snapshot(a)).data.categories;
    const source = categories.find(
        (category) => category.id === entry.categoryId,
      ),
      target = categories.find((category) => category.id !== entry.categoryId);
    if (!source || !target) throw new Error('No categories');
    const [reads, deletion] = await Promise.all([
      Promise.all(Array.from({ length: 12 }, () => snapshot(a))),
      call(a, 'delete', `/categories/${source.id}`).send({
        expectedVersion: 1,
        transferToCategoryId: target.id,
        expectedTargetVersion: 1,
      }),
    ]);
    expect(deletion.status).toBe(200);
    for (const state of reads.map((value) => value.data)) {
      expect(
        state.entries.every((entry) =>
          state.categories.some((category) => category.id === entry.categoryId),
        ),
      ).toBe(true);
      expect(
        state.focusDays.every((focus) =>
          [...state.entries, ...state.trashEntries].some(
            (entry) => entry.id === focus.entryId,
          ),
        ),
      ).toBe(true);
    }
    const latest = await snapshot(a);
    vi.mocked(clock.now).mockReturnValue(new Date('2026-10-26T16:00:00.000Z'));
    const nextDay = await call(a, 'get', '/snapshot')
      .set('If-None-Match', z.string().parse(latest.response.headers.etag))
      .expect(200);
    expect(snapshotDtoSchema.parse(nextDay.body.data).businessToday).toBe(
      '2026-10-27',
    );
    await database.user.update({
      where: { id: a.id },
      data: { status: 'pending_deletion' },
    });
    await call(a, 'get', '/snapshot')
      .set('If-None-Match', z.string().parse(nextDay.headers.etag))
      .expect(403);
    await call(a, 'patch', `/entries/${entry.id}`)
      .send({ expectedVersion: 2, title: 'blocked' })
      .expect(403);
    await database.user.update({
      where: { id: a.id },
      data: { authEpoch: { increment: 1 } },
    });
    await call(a, 'get', '/snapshot')
      .set('If-None-Match', z.string().parse(nextDay.headers.etag))
      .expect(401);
    vi.mocked(clock.now).mockReturnValue(new Date('2026-10-26T04:00:00.000Z'));
  });
});

describe('profile versioned writes through the same protected route', () => {
  it('compares profile versions atomically, validates Unicode, and leaves business dataVersion alone', async () => {
    const user = await login();
    const before = (await snapshot(user)).data.dataVersion;
    const responses = await Promise.all([
      call(user, 'patch', '/me').send({
        displayName: '😀'.repeat(40),
        expectedProfileVersion: 1,
      }),
      call(user, 'patch', '/me').send({
        displayName: '另一个名称',
        expectedProfileVersion: 1,
      }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const profile = await call(user, 'get', '/me').expect(200);
    expect(profile.body.data.profileVersion).toBe(2);
    expect(profile.body.data.displayName).toBe(
      responses.find((r) => r.status === 200)?.body.data.displayName,
    );
    await call(user, 'patch', '/me')
      .send({ displayName: '😀'.repeat(41), expectedProfileVersion: 2 })
      .expect(422);
    await call(user, 'patch', '/me')
      .send({
        displayName: '非法字段',
        expectedProfileVersion: 2,
        status: 'active',
      })
      .expect(422);
    expect((await snapshot(user)).data.dataVersion).toBe(before);
  });
  it('enforces expected actor, Origin, epoch and pending status on direct and miniapp-override PATCH', async () => {
    const user = await login(),
      other = await login(),
      input = { displayName: '受保护显示名', expectedProfileVersion: 1 };
    await request(app.getHttpServer())
      .post('/api/v1/me')
      .set('X-Dayline-Method-Override', 'PATCH')
      .set('Authorization', `Bearer ${user.token}`)
      .send(input)
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/me')
      .set('X-Dayline-Method-Override', 'PATCH')
      .set('Authorization', `Bearer ${user.token}`)
      .set('X-Dayline-Expected-User', other.id)
      .send(input)
      .expect(409);
    await request(app.getHttpServer())
      .post('/api/v1/me')
      .set('X-Dayline-Method-Override', 'PATCH')
      .set('Cookie', user.cookie)
      .set('X-Dayline-Expected-User', user.id)
      .send(input)
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/me')
      .set('X-Dayline-Method-Override', 'PATCH')
      .set('Cookie', user.cookie)
      .set('Origin', origin)
      .set('X-Dayline-Expected-User', user.id)
      .send(input)
      .expect(200);
    await database.user.update({
      where: { id: user.id },
      data: { status: 'pending_deletion' },
    });
    await call(user, 'patch', '/me')
      .send({ ...input, expectedProfileVersion: 2 })
      .expect(403);
    await database.user.update({
      where: { id: user.id },
      data: { status: 'active', authEpoch: { increment: 1 } },
    });
    await call(user, 'patch', '/me')
      .send({ ...input, expectedProfileVersion: 2 })
      .expect(401);
    expect(
      (await database.user.findUniqueOrThrow({ where: { id: other.id } }))
        .profileVersion,
    ).toBe(1);
  });
});
