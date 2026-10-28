import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  entryResultSchema,
  importJobSchema,
  snapshotDtoSchema,
} from '@dayline/contracts';
import { backupSchema } from '@dayline/contracts/files';
import { createApp } from '../src/app.factory.js';
import { parseEnvironment } from '../src/config/environment.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Clock } from '../src/records/clock.js';
import { testDatabaseUrl } from './database-url.js';
const runId = randomUUID();
const appId = `files-${runId}`;
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
  vi.spyOn(clock, 'now').mockReturnValue(new Date(now));
});
afterAll(async () => {
  try {
    await database?.user.deleteMany({ where: { id: { in: [...userIds] } } });
  } finally {
    await app?.close();
  }
});
const now = new Date().toISOString();
async function preview(
  user: Login,
  text: string,
  format: 'csv' | 'json' = 'csv',
  operation: string = randomUUID(),
) {
  const response = await call(user, 'post', '/imports/preview')
    .set('Content-Type', 'application/octet-stream')
    .set('X-Dayline-File-Format', format)
    .set('X-Dayline-Operation-ID', operation)
    .send(Buffer.from(text))
    .expect(201);
  return importJobSchema.parse(response.body.data);
}
async function commitFile(
  user: Login,
  p: ReturnType<typeof importJobSchema.parse>,
) {
  const response = await call(user, 'post', `/imports/${p.id}/commit`)
    .send({ expectedPlanRevision: p.planRevision, planDigest: p.planDigest })
    .expect(201);
  return importJobSchema.parse(response.body.data);
}
const csv = (title = '文件新建') =>
  `title,start_date,end_date,category_name,category_color,focus_dates\r\n${title},2026-10-01,,游戏,#8B80D8,2026-10-20`;
describe('CSV/JSON raw file round trips through durable imports', () => {
  it('provides a public twelve-column BOM template and private typed attachments with complete JSON/active CSV scope', async () => {
    const template = await request(app.getHttpServer())
      .get('/api/v1/exports/csv-template')
      .expect(200);
    expect(template.text).toContain('text_escape');
    expect(template.headers['content-disposition']).toContain('.csv');
    const user = await login();
    const a = await create(user, { title: '=公式,"中文"\n😀�' });
    await call(user, 'put', `/entries/${a.entry.id}/focus-days/2026-10-20`)
      .send({ focused: true, expectedEntryVersion: 1, expectedFocusVersion: 0 })
      .expect(200);
    await call(user, 'put', `/entries/${a.entry.id}/focus-days/2026-10-20`)
      .send({
        focused: false,
        expectedEntryVersion: 1,
        expectedFocusVersion: 1,
      })
      .expect(200);
    await call(user, 'delete', `/entries/${a.entry.id}`)
      .send({ expectedVersion: 1 })
      .expect(200);
    const json = await call(user, 'get', '/exports/json').expect(200);
    expect(json.headers['content-type']).toContain('application/json');
    expect(json.headers['cache-control']).toContain('private');
    expect(json.body.entries[0].deletedAt).toBe(now);
    expect(json.body.focusDays[0].focused).toBe(false);
    expect(json.text).not.toMatch(/token|password|openid|session/i);
    const active = await call(user, 'get', '/exports/csv').expect(200);
    expect(active.text).not.toContain('公式');
    await request(app.getHttpServer()).get('/api/v1/exports/json').expect(401);
  });
  it('previews without business writes, commits atomic new rows, persists operation replay and repeated normalized files without duplicate no-ID candidates', async () => {
    const user = await login(),
      before = (await snapshot(user)).data;
    const p = await preview(user, csv());
    expect(p.canCommit).toBe(true);
    expect((await snapshot(user)).data).toEqual(before);
    const done = await commitFile(user, p);
    expect(done.result?.created).toBe(1);
    expect((await snapshot(user)).data.entries).toHaveLength(1);
    expect(
      (await preview(user, csv(), 'csv', p.clientOperationId)).result,
    ).toEqual(done.result);
    expect((await commitFile(user, p)).result).toEqual(done.result);
    const again = await preview(user, csv());
    expect(again.rows[0]?.action).toBe('skip');
    const checked = importJobSchema.parse(
      (
        await call(user, 'post', `/imports/${again.id}/review`)
          .send({
            expectedPlanRevision: again.planRevision,
            categories: [],
            rows: [],
          })
          .expect(201)
      ).body.data,
    );
    expect(checked.rows[0]?.action).toBe('skip');
    await commitFile(user, checked);
    expect((await snapshot(user)).data.entries).toHaveLength(1);
    const changed = await preview(user, csv('修改无ID行'));
    await commitFile(user, changed);
    expect((await snapshot(user)).data.entries).toHaveLength(2);
    await call(user, 'post', '/imports/preview')
      .set('Content-Type', 'application/octet-stream')
      .set('X-Dayline-File-Format', 'csv')
      .set('X-Dayline-Operation-ID', p.clientOperationId)
      .send(Buffer.from(csv('换文件')))
      .expect(409);
  });
  it('enforces ownership, Cookie Origin, expected user, UTF8, byte/count/depth limits and leaves ordinary requests bounded', async () => {
    const user = await login(),
      other = await login(),
      p = await preview(user, csv());
    await call(other, 'get', `/imports/${p.id}`).expect(404);
    const upload = () =>
      request(app.getHttpServer())
        .post('/api/v1/imports/preview')
        .set('Content-Type', 'application/octet-stream')
        .set('X-Dayline-File-Format', 'csv')
        .set('X-Dayline-Operation-ID', randomUUID());
    await upload()
      .set('Cookie', user.cookie)
      .set('X-Dayline-Expected-User', user.id)
      .send(Buffer.from(csv()))
      .expect(403);
    await upload()
      .set('Authorization', `Bearer ${user.token}`)
      .send(Buffer.from(csv()))
      .expect(400);
    await upload()
      .set('Authorization', `Bearer ${user.token}`)
      .set('X-Dayline-Expected-User', other.id)
      .send(Buffer.from(csv()))
      .expect(409);
    await upload()
      .set('Authorization', `Bearer ${user.token}`)
      .set('X-Dayline-Expected-User', user.id)
      .send(Buffer.from([0xff, 0xfe]))
      .expect(422);
    await upload()
      .set('Authorization', `Bearer ${user.token}`)
      .set('X-Dayline-Expected-User', user.id)
      .send(Buffer.alloc(10 * 1024 * 1024 + 1, 32))
      .expect(413);
    await call(user, 'post', '/entries')
      .send({ padding: 'x'.repeat(65537) })
      .expect(413);
    await call(user, 'post', '/imports/preview')
      .set('X-Dayline-File-Format', 'json')
      .set('X-Dayline-Operation-ID', randomUUID())
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('['.repeat(13) + '0' + ']'.repeat(13)))
      .expect(422);
    const invalid = await preview(
      user,
      'title,start_date,category_name,category_color\n合法,2026-10-01,游戏,#8B80D8\n无效,2026-02-30,游戏,#8B80D8',
    );
    expect(invalid.canCommit).toBe(false);
    expect(invalid.rows[1]?.file?.location).toBe('行 3');
    await call(user, 'post', `/imports/${invalid.id}/commit`)
      .send({ expectedPlanRevision: 1, planDigest: invalid.planDigest })
      .expect(409);
    expect((await snapshot(user)).data.entries).toHaveLength(0);
  });
  it('updates IDs and explicit focus collections by version, keeps absent rows/columns and rejects retained-range errors', async () => {
    const user = await login();
    const a = await create(user, { title: '原记录', endDate: '2026-10-24' }),
      b = await create(user, { title: '缺行保留' });
    const s = (await snapshot(user)).data;
    const update = `entry_id,entry_version,title,start_date\n${a.entry.id},1,已修改,2026-10-01`;
    const p = await preview(user, update);
    expect(p.rows[0]?.action).toBe('apply_update');
    await commitFile(user, p);
    const after = (await snapshot(user)).data;
    expect(after.entries.find((e) => e.id === a.entry.id)?.endDate).toBe(
      '2026-10-24',
    );
    expect(after.entries.some((e) => e.id === b.entry.id)).toBe(true);
    const bad = await preview(
      user,
      `entry_id,entry_version,focus_version,title,start_date,focus_dates\n${a.entry.id},2,1,已修改,2026-10-01,2026-10-25`,
    );
    expect(bad.canCommit).toBe(false);
    expect(bad.rows[0]?.file?.errors.length).toBeGreaterThan(0);
    expect(s.entries).toHaveLength(2);
  });
  it('requires current-version review, rejects stale review and focus races, and changes the plan revision without changing input', async () => {
    const user = await login();
    const a = await create(user);
    await call(user, 'put', `/entries/${a.entry.id}/focus-days/2026-10-20`)
      .send({ focused: true, expectedEntryVersion: 1, expectedFocusVersion: 0 })
      .expect(200);
    const p = await preview(
      user,
      `entry_id,entry_version,focus_version,title,start_date,end_date,focus_dates\n${a.entry.id},1,1,文件修改,2026-10-01,,`,
    );
    expect(p.canCommit).toBe(false);
    const row = p.rows[0];
    if (!row) throw new Error('row');
    const review = {
      expectedPlanRevision: 1,
      categories: [],
      rows: [
        {
          sourceKey: row.sourceKey,
          action: 'apply_update',
          expectedEntryVersion: 1,
          expectedFocusVersion: 2,
        },
      ],
    };
    await call(user, 'put', `/entries/${a.entry.id}/focus-days/2026-10-21`)
      .send({ focused: true, expectedEntryVersion: 1, expectedFocusVersion: 0 })
      .expect(200);
    await call(user, 'post', `/imports/${p.id}/review`)
      .send(review)
      .expect(409);
    const choice = review.rows[0];
    if (!choice) throw new Error('choice');
    choice.expectedFocusVersion = 3;
    const reviewed = importJobSchema.parse(
      (
        await call(user, 'post', `/imports/${p.id}/review`)
          .send(review)
          .expect(201)
      ).body.data,
    );
    expect(reviewed.inputDigest).toBe(p.inputDigest);
    expect(reviewed.planRevision).toBe(2);
    expect(reviewed.rows[0]?.candidateId).toBe(row.candidateId);
    await call(user, 'post', `/imports/${p.id}/commit`)
      .send({ expectedPlanRevision: 1, planDigest: p.planDigest })
      .expect(409);
    await commitFile(user, reviewed);
    const after = (await snapshot(user)).data;
    expect(after.entries[0]?.title).toBe('文件修改');
    expect(after.focusDays.every((f) => !f.focused)).toBe(true);
  });
  it('retains exact trash expiration and falsefocus on JSON restore into a new actor, ignores file owner and requires explicit restore for old active backups', async () => {
    const user = await login();
    const a = await create(user);
    const active = await call(user, 'get', '/exports/json').expect(200);
    await call(user, 'put', `/entries/${a.entry.id}/focus-days/2026-10-20`)
      .send({ focused: true, expectedEntryVersion: 1, expectedFocusVersion: 0 })
      .expect(200);
    await call(user, 'put', `/entries/${a.entry.id}/focus-days/2026-10-20`)
      .send({
        focused: false,
        expectedEntryVersion: 1,
        expectedFocusVersion: 1,
      })
      .expect(200);
    await call(user, 'delete', `/entries/${a.entry.id}`)
      .send({ expectedVersion: 1 })
      .expect(200);
    const backup = await call(user, 'get', '/exports/json').expect(200),
      target = await login();
    const imported = await preview(target, backup.text, 'json');
    await commitFile(target, imported);
    const restored = (await snapshot(target)).data;
    expect(restored.entries).toHaveLength(0);
    expect(restored.trashEntries[0]?.purgeAfter).toBe(
      new Date(Date.parse(now) + 30 * 86400000).toISOString(),
    );
    expect(restored.focusDays[0]?.focused).toBe(false);
    expect(restored.categories).toHaveLength(6);
    expect(restored.trashEntries[0]?.id).not.toBe(a.entry.id);
    const p = await preview(
      user,
      JSON.stringify({ ...active.body, userId: target.id }),
      'json',
    );
    expect(p.canCommit).toBe(false);
    const row = p.rows[0];
    if (!row) throw new Error('row');
    const reviewed = importJobSchema.parse(
      (
        await call(user, 'post', `/imports/${p.id}/review`)
          .send({
            expectedPlanRevision: 1,
            categories: [],
            rows: [
              {
                sourceKey: row.sourceKey,
                action: 'restore',
                expectedEntryVersion: 2,
                expectedFocusVersion: 3,
              },
            ],
          })
          .expect(201)
      ).body.data,
    );
    await commitFile(user, reviewed);
    expect((await snapshot(user)).data.entries[0]?.deletedAt).toBeNull();
    expect((await snapshot(target)).data.trashEntries).toHaveLength(1);
  });
  it('rejects stale snapshots, atomically rolls back mid-write failure, and concurrent commits have one durable effect', async () => {
    const user = await login();
    const p = await preview(user, csv());
    await create(user);
    await call(user, 'post', `/imports/${p.id}/commit`)
      .send({ expectedPlanRevision: 1, planDigest: p.planDigest })
      .expect(409);
    const fresh = await preview(user, csv('失败回滚'));
    const before = (await snapshot(user)).data;
    const target = fresh.rows[0]?.candidateId;
    if (!target) throw new Error('target');
    const fn = 'fail_file_' + runId.replaceAll('-', '');
    await database.$executeRawUnsafe(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${target}'::uuid THEN RAISE EXCEPTION 'injected file failure'; END IF; RETURN NEW; END $$`,
    );
    await database.$executeRawUnsafe(
      `CREATE TRIGGER ${fn} BEFORE INSERT ON entries FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    );
    try {
      await call(user, 'post', `/imports/${fresh.id}/commit`)
        .send({ expectedPlanRevision: 1, planDigest: fresh.planDigest })
        .expect(500);
    } finally {
      await database.$executeRawUnsafe(`DROP TRIGGER ${fn} ON entries`);
      await database.$executeRawUnsafe(`DROP FUNCTION ${fn}()`);
    }
    expect((await snapshot(user)).data).toEqual(before);
    const results = await Promise.all([
      commitFile(user, fresh),
      commitFile(user, fresh),
    ]);
    expect(results[0]?.result).toEqual(results[1]?.result);
    expect((await snapshot(user)).data.entries).toHaveLength(2);
  });
  it('keeps duplicate no-ID input rows distinct, permits safe current category ID matching, expires and cancels previews without writes', async () => {
    const user = await login(),
      c = await category(user);
    const p = await preview(
      user,
      `title,start_date,category_id\n相同,2026-10-01,${c.id}\n相同,2026-10-01,${c.id}`,
    );
    expect(p.canCommit).toBe(true);
    await commitFile(user, p);
    expect((await snapshot(user)).data.entries).toHaveLength(2);
    const cancelled = await preview(user, csv('取消'));
    await call(user, 'delete', `/imports/${cancelled.id}`).expect(200);
    await call(user, 'post', `/imports/${cancelled.id}/commit`)
      .send({ expectedPlanRevision: 1, planDigest: cancelled.planDigest })
      .expect(409);
    const expired = await preview(user, csv('到期'));
    await database.importJob.update({
      where: { id: expired.id },
      data: { expiresAt: new Date('2026-10-25T04:00:00Z') },
    });
    expect(
      importJobSchema.parse(
        (await call(user, 'get', `/imports/${expired.id}`).expect(200)).body
          .data,
      ).status,
    ).toBe('expired');
    expect((await snapshot(user)).data.entries).toHaveLength(2);
  });
  it('accepts an actual 10 MiB raw file without JSON expansion and a valid worst-case 10000-choice review over 2 MiB', async () => {
    const user = await login();
    const base = csv('最大文件') + '\n';
    const large = base + ' '.repeat(10 * 1024 * 1024 - Buffer.byteLength(base));
    expect(Buffer.byteLength(large)).toBe(10 * 1024 * 1024);
    const max = await preview(user, large);
    expect(max.canCommit).toBe(true);
    await call(user, 'delete', `/imports/${max.id}`).expect(200);
    const text =
      'title,start_date,category_name,category_color\n' +
      Array.from(
        { length: 10000 },
        (_, i) => `容量${i},2026-10-01,游戏,#8B80D8`,
      ).join('\n');
    const p = await preview(user, text);
    expect(p.rows).toHaveLength(10000);
    // The persisted protocol allows source keys up to 160 characters. Exercise that public maximum,
    // including version acknowledgements, without requiring a 10000-record business write.
    p.rows.forEach((row, i) => {
      row.sourceKey = String(i).padEnd(160, 'x');
    });
    await database.importJob.update({
      where: { id: p.id },
      data: { plan: JSON.parse(JSON.stringify(p)) },
    });
    const input = {
      expectedPlanRevision: 1,
      categories: [],
      rows: p.rows.map((row) => ({
        sourceKey: row.sourceKey,
        action: 'create_copy',
        expectedEntryVersion: 2147483647,
        expectedFocusVersion: 2147483647,
      })),
    };
    const bytes = Buffer.byteLength(JSON.stringify(input));
    expect(bytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(bytes).toBeLessThan(4 * 1024 * 1024);
    const reviewed = importJobSchema.parse(
      (
        await call(user, 'post', `/imports/${p.id}/review`)
          .send(input)
          .expect(201)
      ).body.data,
    );
    expect(reviewed.canCommit).toBe(true);
    expect(reviewed.rows).toHaveLength(10000);
    console.info(
      'file bounds',
      JSON.stringify({
        fileBytes: Buffer.byteLength(large),
        reviewBytes: bytes,
        rows: reviewed.rows.length,
      }),
    );
  }, 60000);
  it('restores renamed and swapped default category seeds atomically into an empty account, replays class-only JSON and preserves later user edits', async () => {
    const owner = await login(),
      target = await login();
    const backup = backupSchema.parse(
      JSON.parse((await call(owner, 'get', '/exports/json').expect(200)).text),
    );
    const game = backup.categories.find((c) => c.seedKey === 'game'),
      reading = backup.categories.find((c) => c.seedKey === 'reading');
    if (!game || !reading) throw new Error('defaults');
    [game.name, reading.name] = [reading.name, game.name];
    reading.color = '#123456';
    backup.categories.push({
      id: randomUUID(),
      name: '仅分类',
      color: '#ABCDEF',
      seedKey: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const text = JSON.stringify(backup),
      before = (await snapshot(target)).data,
      p = await preview(target, text, 'json');
    expect(p.canCommit).toBe(true);
    expect((await snapshot(target)).data).toEqual(before);
    await commitFile(target, p);
    const after = (await snapshot(target)).data;
    expect(
      after.categories.map((c) => [c.seedKey, c.name, c.color]).sort(),
    ).toEqual(
      backup.categories.map((c) => [c.seedKey, c.name, c.color]).sort(),
    );
    expect(after.categories.filter((c) => c.version === 2)).toHaveLength(2);
    const edited = after.categories.find((c) => c.seedKey === 'reading');
    if (!edited) throw new Error('reading');
    await call(target, 'patch', `/categories/${edited.id}`)
      .send({
        expectedVersion: edited.version,
        name: '用户后来改名',
        color: '#654321',
      })
      .expect(200);
    const modified = (await snapshot(target)).data;
    const again = await preview(target, text, 'json');
    expect(again.categoryMappings.every((c) => c.action === 'skip')).toBe(true);
    await commitFile(target, again);
    expect((await snapshot(target)).data).toEqual(modified);
  });
  it('requires explicit custom/default mapping for nonempty targets and rolls back a failed category restore before retrying', async () => {
    const owner = await login(),
      target = await login(),
      nonempty = await login();
    const backup = backupSchema.parse(
      JSON.parse((await call(owner, 'get', '/exports/json').expect(200)).text),
    );
    const changed = backup.categories.find((c) => c.seedKey === 'reading');
    if (!changed) throw new Error('reading');
    changed.name = '阅览';
    changed.color = '#123456';
    const text = JSON.stringify(backup);
    await create(nonempty);
    const conflict = await preview(nonempty, text, 'json');
    expect(conflict.canCommit).toBe(false);
    const mapping = conflict.categoryMappings.find(
      (c) => c.seedKey === 'reading',
    );
    if (!mapping) throw new Error('mapping');
    await call(nonempty, 'post', `/imports/${conflict.id}/review`)
      .send({
        expectedPlanRevision: 1,
        categories: [
          {
            sourceId: mapping.sourceId,
            targetId: null,
            name: '阅览',
            color: '#123456',
          },
        ],
        rows: [],
      })
      .expect(409);
    const reviewed = importJobSchema.parse(
      (
        await call(nonempty, 'post', `/imports/${conflict.id}/review`)
          .send({
            expectedPlanRevision: 1,
            categories: [
              {
                sourceId: mapping.sourceId,
                targetId: null,
                name: '阅览',
                color: '#123456',
                asCustom: true,
              },
            ],
            rows: [],
          })
          .expect(201)
      ).body.data,
    );
    expect(reviewed.canCommit).toBe(true);
    await commitFile(nonempty, reviewed);
    expect(
      (await snapshot(nonempty)).data.categories.find((c) => c.name === '阅览')
        ?.seedKey,
    ).toBeNull();
    const p = await preview(target, text, 'json'),
      before = (await snapshot(target)).data,
      fn = 'fail_catfile_' + runId.replaceAll('-', '');
    const baseline = p.categoryMappings.find(
      (c) => c.restoreDefault?.seedKey === 'reading',
    )?.restoreDefault;
    if (!baseline) throw new Error('baseline');
    await database.$executeRawUnsafe(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${baseline.id}'::uuid AND NEW.name = '阅览' THEN RAISE EXCEPTION 'injected category restore failure'; END IF; RETURN NEW; END $$`,
    );
    await database.$executeRawUnsafe(
      `CREATE TRIGGER ${fn} BEFORE UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    );
    try {
      await call(target, 'post', `/imports/${p.id}/commit`)
        .send({ expectedPlanRevision: 1, planDigest: p.planDigest })
        .expect(500);
    } finally {
      await database.$executeRawUnsafe(`DROP TRIGGER ${fn} ON categories`);
      await database.$executeRawUnsafe(`DROP FUNCTION ${fn}()`);
    }
    expect((await snapshot(target)).data).toEqual(before);
    await commitFile(target, p);
    expect(
      (await snapshot(target)).data.categories.find(
        (c) => c.seedKey === 'reading',
      )?.name,
    ).toBe('阅览');
    const staleTarget = await login(),
      stale = await preview(staleTarget, text, 'json'),
      category = (await snapshot(staleTarget)).data.categories.find(
        (c) => c.seedKey === 'reading',
      );
    if (!category) throw new Error('category');
    await call(staleTarget, 'patch', `/categories/${category.id}`)
      .send({ expectedVersion: category.version, color: '#111111' })
      .expect(200);
    await call(staleTarget, 'post', `/imports/${stale.id}/commit`)
      .send({ expectedPlanRevision: 1, planDigest: stale.planDigest })
      .expect(409);
  });
  it('does not recreate old CSV categories or advance dataVersion after an imported target category is renamed', async () => {
    const user = await login(),
      p = await preview(user, csv('已处理来源'));
    await commitFile(user, p);
    const s = (await snapshot(user)).data,
      c = s.categories.find((c) => c.name === '游戏');
    if (!c) throw new Error('category');
    await call(user, 'patch', `/categories/${c.id}`)
      .send({
        expectedVersion: c.version,
        name: '修改后的分类',
        color: '#123456',
      })
      .expect(200);
    const before = (await snapshot(user)).data;
    const again = await preview(user, csv('已处理来源'));
    expect(again.rows[0]?.action).toBe('skip');
    expect(again.categoryMappings[0]?.action).toBe('skip');
    await commitFile(user, again);
    expect((await snapshot(user)).data).toEqual(before);
  });
  it('indexes every historical content digest and prevents different pre-created tasks from copying a completed source again', async () => {
    const owner = await login(),
      target = await login(),
      entry = await create(owner, { title: '历史原版' });
    const original = (await call(owner, 'get', '/exports/json').expect(200))
      .text;
    const first = await preview(target, original, 'json'),
      racing = await preview(target, original, 'json');
    const done = await commitFile(target, first);
    const row = racing.rows[0];
    if (!row) throw new Error('row');
    const revised = importJobSchema.parse(
      (
        await call(target, 'post', `/imports/${racing.id}/review`)
          .send({
            expectedPlanRevision: 1,
            categories: [],
            rows: [{ sourceKey: row.sourceKey, action: 'create_copy' }],
          })
          .expect(201)
      ).body.data,
    );
    await call(target, 'post', `/imports/${racing.id}/commit`)
      .send({
        expectedPlanRevision: revised.planRevision,
        planDigest: revised.planDigest,
      })
      .expect(409);
    expect((await snapshot(target)).data.entries).toHaveLength(1);
    await call(owner, 'patch', `/entries/${entry.entry.id}`)
      .send({ expectedVersion: 1, title: '历史修改版' })
      .expect(200);
    const modified = (await call(owner, 'get', '/exports/json').expect(200))
      .text;
    await commitFile(target, await preview(target, modified, 'json'));
    expect((await snapshot(target)).data.entries).toHaveLength(2);
    const oldTarget = done.result?.mappings[0]?.targetId;
    if (!oldTarget) throw new Error('target');
    await call(target, 'delete', `/entries/${oldTarget}`)
      .send({ expectedVersion: 1 })
      .expect(200);
    await call(target, 'post', '/trash/purge')
      .send({ entries: [{ id: oldTarget, expectedVersion: 2 }] })
      .expect(201);
    const before = (await snapshot(target)).data;
    const oldAgain = await preview(target, original, 'json');
    expect(oldAgain.rows[0]?.action).toBe('skip');
    expect(oldAgain.rows[0]?.previousTargetId).toBe(oldTarget);
    await commitFile(target, oldAgain);
    expect((await snapshot(target)).data).toEqual(before);
  });
  it('preserves a valid new-epoch session when an older task is stale and accepts only a new operation for repreview', async () => {
    const identity = randomUUID(),
      old = await login(identity),
      p = await preview(old, csv('旧任务原文件'));
    await database.user.update({
      where: { id: old.id },
      data: { authEpoch: { increment: 1 } },
    });
    const fresh = await login(identity);
    expect(fresh.id).toBe(old.id);
    await call(old, 'get', `/imports/${p.id}`).expect(401);
    const response = await call(fresh, 'get', `/imports/${p.id}`).expect(409);
    expect(response.body.error.code).toBe('PREVIEW_STALE');
    await call(fresh, 'get', '/me').expect(200);
    await call(fresh, 'post', '/imports/preview')
      .set('Content-Type', 'application/octet-stream')
      .set('X-Dayline-File-Format', 'csv')
      .set('X-Dayline-Operation-ID', p.clientOperationId)
      .send(Buffer.from(csv('旧任务原文件')))
      .expect(409);
    const next = await preview(fresh, csv('旧任务原文件'));
    expect(next.clientOperationId).not.toBe(p.clientOperationId);
    await commitFile(fresh, next);
    expect((await snapshot(fresh)).data.entries).toHaveLength(1);
  });
});

it('auto-matches owned categories and freezes distinct default colors for CSV without color, including durable reimport after rename', async () => {
  const user = await login();
  const old = await snapshot(user);
  const text =
    'title,start_date,category_name\n现有分类,2026-10-01,游戏\n新分类一,2026-10-01,旅行\n新分类二,2026-10-02,摄影';
  const p = await preview(user, text);
  expect(p.canCommit).toBe(true);
  const newlyMapped = p.categoryMappings.filter((c) =>
    ['旅行', '摄影'].includes(c.name),
  );
  expect(new Set(newlyMapped.map((c) => c.color)).size).toBe(2);
  expect(
    newlyMapped.every(
      (c) => !old.data.categories.some((owned) => owned.color === c.color),
    ),
  ).toBe(true);
  const committed = await commitFile(user, p);
  expect(committed.result?.created).toBe(3);
  const after = await snapshot(user);
  const travel = after.data.categories.find((c) => c.name === '旅行');
  if (!travel) throw new Error('category');
  await call(user, 'patch', `/categories/${travel.id}`)
    .send({
      expectedVersion: travel.version,
      name: '新旅行名称',
      color: '#123456',
    })
    .expect(200);
  const again = await preview(user, text);
  expect(again.canCommit).toBe(true);
  expect(again.rows.every((r) => r.action === 'skip')).toBe(true);
  await commitFile(user, again);
  const final = await snapshot(user);
  expect(final.data.entries).toHaveLength(3);
  expect(final.data.categories).toHaveLength(after.data.categories.length);
  expect(final.data.categories.find((c) => c.id === travel.id)).toMatchObject({
    name: '新旅行名称',
    color: '#123456',
  });
});
