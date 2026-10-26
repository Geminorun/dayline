import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createGuestPackage, mutateGuest } from '../src/index.js';
import {
  exportCsv,
  exportJson,
  parseImportFile,
  createLocalFilePlan,
  guestFileCommit,
  reviewLocalFilePlan,
  csvTemplate,
  FileError,
  MAX_FILE_BYTES,
} from '../src/files.js';
const now = '2026-10-26T04:00:00.000Z';
function fixture(title = '阅读') {
  const initial = createGuestPackage(randomUUID, now);
  const categoryId = initial.categories[0]?.id ?? '';
  const id = randomUUID();
  const data = mutateGuest(
    initial,
    {
      kind: 'create',
      input: {
        id,
        categoryId,
        title,
        startDate: '2026-10-01',
        endDate: '2026-10-24',
      },
    },
    now,
  );
  return { data, id, categoryId };
}
const plan = (text: string, format: 'csv' | 'json', data = fixture().data) =>
  createLocalFilePlan(
    parseImportFile(text, format, now),
    data,
    String(data.packageRevision),
    randomUUID,
    now,
    new Map(),
  );
describe('portable CSV and complete JSON files', () => {
  it('round trips all twelve columns, BOM/CRLF, Chinese, comma, quotes, newlines, apostrophes and formula protection reversibly', () => {
    for (const title of [
      '中文, "引号"\n第二行',
      '=SUM(A1:A2)',
      '+加号',
      '-负号',
      '@提及',
      "'原始引号",
      '替换符�',
    ]) {
      const { data } = fixture(title);
      const text = exportCsv(data);
      expect(text.startsWith('\ufeff')).toBe(true);
      expect(text).toContain('text_escape');
      const source = parseImportFile(text, 'csv', now);
      expect(source.entries[0]?.title).toBe(title);
      expect(source.file?.rows[0]?.entryVersion).toBe(1);
      const p = plan(text, 'csv', data);
      expect(p.rows[0]?.action).toBe('unchanged');
    }
    const p = parseImportFile(
      "title,start_date,category_name,category_color\r\n'保留,2026-10-01,游戏,#8B80D8",
      'csv',
      now,
    );
    expect(p.entries[0]?.title).toBe("'保留");
    expect(csvTemplate().split('\r\n')[0]?.split(',')).toHaveLength(12);
  });
  it('distinguishes missing optional columns from blank values and validates retained dates/focus', () => {
    const { data, id } = fixture();
    const omitted = plan(
      `entry_id,entry_version,title,start_date\n${id},1,改名,2026-10-01`,
      'csv',
      data,
    );
    expect(omitted.canCommit).toBe(true);
    expect(guestFileCommit(data, omitted, now).entries[0]?.endDate).toBe(
      '2026-10-24',
    );
    const blank = plan(
      `entry_id,entry_version,title,start_date,end_date\n${id},1,改名,2026-10-01,`,
      'csv',
      data,
    );
    expect(guestFileCommit(data, blank, now).entries[0]?.endDate).toBeNull();
    for (const text of [
      `entry_id,entry_version,title,start_date\n${id},1,改名,2026-10-25`,
      `entry_id,entry_version,focus_version,title,start_date,focus_dates\n${id},1,1,阅读,2026-10-01,2026-10-25`,
    ]) {
      const p = plan(text, 'csv', data);
      expect(p.canCommit).toBe(false);
      expect(p.rows[0]?.file?.errors.length).toBeGreaterThan(0);
    }
  });
  it('requires explicit current version review for missing versions and stale focus collections, with no force mode', () => {
    const { data, id } = fixture();
    const p = plan(
      `entry_id,title,start_date\n${id},新名称,2026-10-01`,
      'csv',
      data,
    );
    expect(p.canCommit).toBe(false);
    expect(p.rows[0]?.code).toBe('UPDATE_VERSION_REQUIRED');
    const row = p.rows[0];
    if (!row) throw new Error('row');
    expect(() =>
      reviewLocalFilePlan(
        p,
        data,
        {
          expectedPlanRevision: 1,
          categories: [],
          rows: [
            {
              sourceKey: row.sourceKey,
              action: 'apply_update',
              expectedEntryVersion: 2,
              expectedFocusVersion: 1,
            },
          ],
        },
        String(data.packageRevision),
        now,
      ),
    ).toThrow('新变化');
    const reviewed = reviewLocalFilePlan(
      p,
      data,
      {
        expectedPlanRevision: 1,
        categories: [],
        rows: [
          {
            sourceKey: row.sourceKey,
            action: 'apply_update',
            expectedEntryVersion: 1,
            expectedFocusVersion: 1,
          },
        ],
      },
      String(data.packageRevision),
      now,
    );
    expect(guestFileCommit(data, reviewed, now).entries[0]?.title).toBe(
      '新名称',
    );
    expect(() =>
      guestFileCommit({ ...data, packageRevision: 99 }, reviewed, now),
    ).toThrow('重新预览');
  });
  it('uses known category IDs safely without name/color, reviews conflicting names, and cannot resolve foreign IDs', () => {
    const { data, categoryId } = fixture();
    const text = `title,start_date,category_id\n新增,2026-10-01,${categoryId}`;
    const p = plan(text, 'csv', data);
    expect(p.categoryMappings[0]?.targetId).toBe(categoryId);
    expect(p.canCommit).toBe(true);
    const conflict = plan(
      `title,start_date,category_id,category_name\n新增,2026-10-01,${categoryId},别的名称`,
      'csv',
      data,
    );
    expect(conflict.canCommit).toBe(false);
    expect(conflict.categoryMappings[0]?.needsReview).toBe(true);
    const foreign = plan(
      `title,start_date,category_id\n新增,2026-10-01,${randomUUID()}`,
      'csv',
      data,
    );
    expect(foreign.canCommit).toBe(false);
  });
  it('reports row errors, duplicates, unsupported headers, formats, nested JSON and size without partial application', () => {
    const { data, id } = fixture();
    const p = plan(
      `entry_id,title,start_date,category_name,category_color\n${id},有效,2026-10-01,游戏,#8B80D8\n${id},坏日期,2026-02-30,游戏,#8B80D8`,
      'csv',
      data,
    );
    expect(p.canCommit).toBe(false);
    expect(p.rows[1]?.file?.location).toBe('行 3');
    expect(p.rows[1]?.file?.errors).toContain('同一文件重复更新相同 ID');
    expect(() => guestFileCommit(data, p, now)).toThrow();
    for (const [text, format] of [
      ['title,start_date,other\nx,2026-10-01,y', 'csv'],
      ['{"format":"dayline-draft","schemaVersion":1}', 'json'],
      ['['.repeat(13) + '0' + ']'.repeat(13), 'json'],
    ] as const)
      expect(() => parseImportFile(text, format, now)).toThrow(FileError);
    expect(() =>
      parseImportFile('x'.repeat(MAX_FILE_BYTES + 1), 'csv', now),
    ).toThrow('10 MiB');
    expect(() =>
      parseImportFile(
        'title,start_date\n' +
          Array.from({ length: 10001 }, () => `a,2026-01-01`).join('\n'),
        'csv',
        now,
      ),
    ).toThrow('10,000');
  });
  it('keeps two identical no-ID rows as separate stable candidates and skips persistent sources on repeated or reordered files', () => {
    const cloud = createGuestPackage(randomUUID, now);
    const text =
      'title,start_date,category_name,category_color\n同内容,2026-10-01,游戏,#8B80D8\n同内容,2026-10-01,游戏,#8B80D8';
    const p = plan(text, 'csv', cloud);
    expect(p.rows[0]?.sourceKey).not.toBe(p.rows[1]?.sourceKey);
    const next = guestFileCommit(cloud, p, now);
    expect(next.entries).toHaveLength(2);
    const processed = new Map(
      p.rows.map((r) => [
        r.sourceKey,
        { sourceDigest: r.sourceDigest, targetId: r.candidateId },
      ]),
    );
    const again = createLocalFilePlan(
      parseImportFile(text, 'csv', now),
      next,
      String(next.packageRevision),
      randomUUID,
      now,
      processed,
    );
    expect(again.rows.every((r) => r.action === 'skip')).toBe(true);
    const rechecked = reviewLocalFilePlan(
      again,
      next,
      { expectedPlanRevision: again.planRevision, categories: [], rows: [] },
      String(next.packageRevision),
      now,
    );
    expect(rechecked.rows.every((r) => r.action === 'skip')).toBe(true);
    const processedRow = again.rows[0];
    if (!processedRow) throw new Error('row');
    expect(() =>
      reviewLocalFilePlan(
        again,
        next,
        {
          expectedPlanRevision: again.planRevision,
          categories: [],
          rows: [{ sourceKey: processedRow.sourceKey, action: 'create_copy' }],
        },
        String(next.packageRevision),
        now,
      ),
    ).toThrow('此来源已处理');
    const changed = createLocalFilePlan(
      parseImportFile(text.replace('同内容', '修改内容'), 'csv', now),
      next,
      String(next.packageRevision),
      randomUUID,
      now,
      processed,
    );
    expect(changed.rows[0]?.action).toBe('create_copy');
    expect(next.entries).toHaveLength(2);
  });
  it('preserves JSON categories, false focus and exact remaining trash retention with normalized no-millisecond instants', () => {
    const { data, id } = fixture();
    const focused = mutateGuest(
      data,
      {
        kind: 'focus',
        id,
        date: '2026-10-20',
        input: {
          focused: true,
          expectedEntryVersion: 1,
          expectedFocusVersion: 0,
        },
      },
      now,
    );
    const unfocused = mutateGuest(
      focused,
      {
        kind: 'focus',
        id,
        date: '2026-10-20',
        input: {
          focused: false,
          expectedEntryVersion: 1,
          expectedFocusVersion: 1,
        },
      },
      now,
    );
    const trash = mutateGuest(
      unfocused,
      { kind: 'remove', id, expectedVersion: 1 },
      now,
    );
    const text = exportJson(trash, now).replaceAll('00.000Z', '00Z');
    const source = parseImportFile(text, 'json', now);
    expect(source.entries[0]?.deletedAt).toBe(now);
    expect(source.focusDays[0]).toMatchObject({ focused: false, version: 2 });
    const target = createGuestPackage(randomUUID, now);
    const p = plan(text, 'json', target),
      restored = guestFileCommit(target, p, now);
    expect(restored.entries[0]?.purgeAfter).toBe(trash.entries[0]?.purgeAfter);
    expect(restored.focusDays[0]?.focused).toBe(false);
    expect(restored.categories).toHaveLength(6);
    expect(text).not.toMatch(/token|password|openid|session/i);
    expect(() =>
      parseImportFile(
        text.replace('2026-11-25T04:00:00Z', '2026-11-26T04:00:00Z'),
        'json',
        now,
      ),
    ).toThrow('30 天');
    expect(() =>
      parseImportFile(
        text.replace('"timeZone":', '"password":"secret","timeZone":'),
        'json',
        now,
      ),
    ).toThrow();
  });
  it('never restores current trash implicitly and never extends an expired backup', () => {
    const { data, id } = fixture();
    const active = exportJson(data, now);
    const deleted = mutateGuest(
      data,
      { kind: 'remove', id, expectedVersion: 1 },
      now,
    );
    const p = plan(active, 'json', deleted);
    expect(p.canCommit).toBe(false);
    const row = p.rows[0];
    if (!row) throw new Error('row');
    const reviewed = reviewLocalFilePlan(
      p,
      deleted,
      {
        expectedPlanRevision: 1,
        categories: [],
        rows: [
          {
            sourceKey: row.sourceKey,
            action: 'restore',
            expectedEntryVersion: 2,
            expectedFocusVersion: 1,
          },
        ],
      },
      String(deleted.packageRevision),
      now,
    );
    expect(
      guestFileCommit(deleted, reviewed, now).entries[0]?.deletedAt,
    ).toBeNull();
    const expired = createLocalFilePlan(
      parseImportFile(exportJson(deleted, now), 'json', '2026-11-26T04:00:00Z'),
      createGuestPackage(randomUUID, now),
      '1',
      randomUUID,
      '2026-11-26T04:00:00Z',
      new Map(),
    );
    expect(expired.rows[0]?.action).toBe('skip');
  });
});
describe('category restoration and idempotent provenance', () => {
  it('restores renamed default seeds including swapped names into an empty target, preserving custom categories occupying old names', () => {
    const source = createGuestPackage(randomUUID, now),
      target = createGuestPackage(randomUUID, now);
    const game = source.categories.find((c) => c.seedKey === 'game'),
      reading = source.categories.find((c) => c.seedKey === 'reading');
    if (!game || !reading) throw new Error('defaults');
    [game.name, reading.name] = [reading.name, game.name];
    reading.color = '#123456';
    const p = plan(exportJson(source, now), 'json', target);
    expect(p.canCommit).toBe(true);
    expect(p.categoryMappings.filter((c) => c.restoreDefault)).toHaveLength(6);
    const after = guestFileCommit(target, p, now);
    expect(
      after.categories.map((c) => [c.seedKey, c.name, c.color]).sort(),
    ).toEqual(
      source.categories.map((c) => [c.seedKey, c.name, c.color]).sort(),
    );
    expect(after.categories.filter((c) => c.version === 2)).toHaveLength(2);
  });
  it('never recreates CSV categories after a processed target was renamed, and supports class-only JSON independently', () => {
    const target = createGuestPackage(randomUUID, now),
      text =
        'title,start_date,category_name,category_color\n来源,2026-10-01,游戏,#8B80D8';
    const p = plan(text, 'csv', target);
    const first = guestFileCommit(target, p, now);
    const c = first.categories.find((c) => c.seedKey === 'game');
    if (!c) throw new Error('category');
    const renamed = mutateGuest(
      first,
      {
        kind: 'updateCategory',
        id: c.id,
        input: { expectedVersion: c.version, name: '已改名', color: '#123456' },
      },
      now,
    );
    const category = p.categoryMappings[0];
    if (!category) throw new Error('mapping');
    const processed = new Map([
      ...p.rows.map(
        (r) =>
          [
            r.sourceKey,
            { sourceDigest: r.sourceDigest, targetId: r.candidateId },
          ] as const,
      ),
      [
        category.sourceKey ?? '',
        {
          sourceDigest: category.sourceDigest ?? '',
          targetId: category.targetId ?? category.candidateId,
        },
      ] as const,
    ]);
    const again = createLocalFilePlan(
      parseImportFile(text, 'csv', now),
      renamed,
      String(renamed.packageRevision),
      randomUUID,
      now,
      processed,
    );
    expect(again.rows[0]?.action).toBe('skip');
    expect(again.categoryMappings[0]?.action).toBe('skip');
    expect(guestFileCommit(renamed, again, now)).toEqual(renamed);
    const only = createGuestPackage(randomUUID, now);
    only.categories.push({
      id: randomUUID(),
      name: '仅分类',
      color: '#ABCDEF',
      seedKey: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const json = plan(
      exportJson(only, now),
      'json',
      createGuestPackage(randomUUID, now),
    );
    expect(json.canCommit).toBe(true);
    expect(json.rows).toHaveLength(0);
    expect(
      json.categoryMappings.some(
        (m) => m.name === '仅分类' && m.action === 'apply',
      ),
    ).toBe(true);
  });
});
