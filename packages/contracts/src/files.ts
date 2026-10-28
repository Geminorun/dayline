import { importSourceReceipt } from './imports.js';
import Papa from 'papaparse';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';
import {
  businessToday,
  DEFAULT_CATEGORIES,
  nextCategoryColor,
} from '@dayline/core';
import {
  categoryDtoSchema,
  entryDtoSchema,
  focusDayDtoSchema,
  dateSchema,
  titleSchema,
  categoryNameSchema,
  colorSchema,
  versionSchema,
} from './records.js';
import type { CategoryDto, EntryDto, FocusDayDto } from './records.js';
import type {
  ImportJobDto,
  ImportReviewInput,
  ImportRow,
  NormalizedImportSource,
} from './imports.js';
import { guestPackageSchema, GuestError } from './guest.js';
import type { GuestPackage } from './guest.js';
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const CSV_COLUMNS = [
  'schema_version',
  'entry_id',
  'entry_version',
  'focus_version',
  'title',
  'start_date',
  'end_date',
  'category_id',
  'category_name',
  'category_color',
  'focus_dates',
  'text_escape',
] as const;
export const fileHash = (value: unknown) =>
  'sha256:' + bytesToHex(sha256(utf8ToBytes(JSON.stringify(value))));
const stableId = (value: unknown) => {
  const h = fileHash(value).slice(7);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export class FileError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message);
  }
}
export const backupSchema = z
  .object({
    format: z.literal('dayline-backup'),
    schemaVersion: z.literal(1),
    exportedAt: z.iso.datetime(),
    timeZone: z.literal('Asia/Shanghai'),
    userId: z.uuid().optional(),
    categories: z
      .array(
        categoryDtoSchema.strict().extend({
          seedKey: z
            .enum(['game', 'reading', 'work', 'sport', 'life', 'other'])
            .nullable(),
        }),
      )
      .min(1)
      .max(20),
    entries: z.array(entryDtoSchema.strict()).max(10_000),
    focusDays: z.array(focusDayDtoSchema.strict()).max(100_000),
  })
  .strict();
export type FileCloud = {
  categories: CategoryDto[];
  entries: EntryDto[];
  focusDays: FocusDayDto[];
};
function fail(message: string, issues: FileError['issues'] = []): never {
  throw new FileError('IMPORT_INVALID', message, issues);
}
function boundedText(text: string) {
  if (utf8ToBytes(text).length > MAX_FILE_BYTES)
    throw new FileError('FILE_TOO_LARGE', '文件不能超过 10 MiB。');
  if (text.includes('\u0000')) fail('文件必须是有效 UTF-8 文本。');
}
function checkDepth(text: string) {
  let depth = 0,
    quoted = false,
    escaped = false;
  for (const ch of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '{' || ch === '[') {
      if (++depth > 12) fail('JSON 嵌套过深。');
    } else if (ch === '}' || ch === ']') depth--;
  }
}
function info(
  location: string,
  requestedId: string | null,
): NonNullable<ImportRow['file']> {
  return {
    location,
    requestedId,
    entryVersion: null,
    focusVersion: null,
    endPresent: true,
    categoryPresent: true,
    focusPresent: true,
    errors: [],
    current: null,
    differences: [],
    categoryAmbiguous: false,
  };
}
function validateSource(source: NormalizedImportSource, now: string) {
  // Source has additional provenance keys; validate the business graph separately.
  const graph = guestPackageSchema.safeParse({
    format: 'dayline-guest',
    schemaVersion: 1,
    localSchemaVersion: 1,
    guestDatasetId: stableId('validation'),
    packageRevision: 1,
    timeZone: 'Asia/Shanghai',
    savedAt: now,
    categories: source.categories,
    entries: source.entries,
    focusDays: source.focusDays,
  });
  if (!graph.success)
    fail(
      '文件引用、重复标识、日期范围或重点无效。',
      graph.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    );
  const seeds = source.categories.flatMap((c) =>
    c.seedKey ? [c.seedKey] : [],
  );
  if (new Set(seeds).size !== seeds.length)
    fail('默认分类标识重复。', [
      { path: 'categories', message: '重复默认分类标识' },
    ]);
  const today = businessToday(new Date(now));
  if (Date.parse(source.savedAt) > Date.parse(now) + 300_000)
    fail('导出时间晚于当前时间，请校准后核对原文件。', [
      { path: 'exportedAt', message: '导出时间无效' },
    ]);
  for (const [i, e] of source.entries.entries()) {
    if (
      Date.parse(e.createdAt) > Date.parse(now) + 300_000 ||
      Date.parse(e.updatedAt) > Date.parse(now) + 300_000
    )
      fail('来源时间晚于当前时间，请核对原文件。', [
        { path: `entries.${i}.updatedAt`, message: '来源时间无效' },
      ]);
    if (
      e.deletedAt &&
      (Date.parse(e.purgeAfter ?? '') - Date.parse(e.deletedAt) !==
        30 * 86400000 ||
        Date.parse(e.deletedAt) > Date.parse(now) + 300_000)
    )
      fail('回收站期限必须保留原连续 30 天。', [
        { path: `entries.${i}.purgeAfter`, message: '删除时间或到期时间无效' },
      ]);
  }
  if (source.focusDays.some((f) => f.focused && f.date > today))
    fail('重点不能晚于今天。');
}
export function parseImportFile(
  text: string,
  format: 'csv' | 'json',
  now: string,
): NormalizedImportSource {
  boundedText(text);
  text = text.replace(/^\ufeff/, '');
  const digest = fileHash({ format, text });
  if (format === 'json') {
    checkDepth(text);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      fail('JSON 语法无效。');
    }
    if (
      typeof raw === 'object' &&
      raw !== null &&
      'format' in raw &&
      (raw.format !== 'dayline-backup' ||
        !('schemaVersion' in raw) ||
        raw.schemaVersion !== 1)
    )
      throw new FileError(
        'FORMAT_VERSION_UNSUPPORTED',
        '仅支持 Dayline 完整备份 v1。',
      );
    const checked = backupSchema.safeParse(raw);
    if (!checked.success)
      fail(
        'JSON 备份格式无效。',
        checked.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      );
    const b = checked.data;
    const source: NormalizedImportSource = {
      sourceNamespace: 'file-json',
      sourceRevision: digest,
      savedAt: new Date(b.exportedAt).toISOString(),
      categories: b.categories.map((c) => ({
        ...c,
        createdAt: new Date(c.createdAt).toISOString(),
        updatedAt: new Date(c.updatedAt).toISOString(),
      })),
      entries: b.entries.map((e) => ({
        ...e,
        createdAt: new Date(e.createdAt).toISOString(),
        updatedAt: new Date(e.updatedAt).toISOString(),
        deletedAt: e.deletedAt ? new Date(e.deletedAt).toISOString() : null,
        purgeAfter: e.purgeAfter ? new Date(e.purgeAfter).toISOString() : null,
      })),
      focusDays: b.focusDays,
      file: {
        digest,
        rows: b.entries.map((e, i) => ({
          ...info(`entries[${i}]`, e.id),
          entryVersion: e.version,
          focusVersion: e.focusVersion,
        })),
      },
    };
    validateSource(source, now);
    return source;
  }
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' });
  if (parsed.errors.length)
    fail(
      'CSV 引号或行格式无效。',
      parsed.errors.map((e) => ({
        path: `行 ${(e.row ?? 0) + 1}`,
        message: e.message,
      })),
    );
  const header = parsed.data[0];
  if (!header?.length || new Set(header).size !== header.length)
    fail('CSV 表头缺失或重复。');
  const unknown = header.filter(
    (h) => !CSV_COLUMNS.includes(h as (typeof CSV_COLUMNS)[number]),
  );
  if (unknown.length)
    fail(
      'CSV 包含未知列。',
      unknown.map((h) => ({ path: '表头', message: h })),
    );
  if (!header.includes('title') || !header.includes('start_date'))
    fail('CSV 必须包含 title 和 start_date。');
  if (parsed.data.length - 1 > 10_000)
    throw new FileError('FILE_TOO_LARGE', '一次最多导入 10,000 条事项。');
  const categories: CategoryDto[] = [],
    entries: EntryDto[] = [],
    focusDays: FocusDayDto[] = [],
    rows: NonNullable<ImportRow['file']>[] = [],
    occurrences = new Map<string, number>(),
    ids = new Set<string>();
  for (const [index, cells] of parsed.data.slice(1).entries()) {
    const row: Record<string, string> = Object.fromEntries(
      header.map((h, i) => [h, cells[i] ?? '']),
    );
    const meta = info(`行 ${index + 2}`, row.entry_id?.trim() || null);
    if (cells.length !== header.length) meta.errors.push('列数与表头不一致');
    if (row.schema_version && row.schema_version !== '1')
      meta.errors.push('不支持的 schema_version');
    if (row.text_escape && row.text_escape !== 'apostrophe-v1')
      meta.errors.push('不支持的 text_escape');
    if (row.text_escape === 'apostrophe-v1')
      for (const key of ['title', 'category_name'])
        if (row[key]?.startsWith("'")) row[key] = row[key].slice(1);
    const value = <T>(
      schema: z.ZodType<T>,
      v: unknown,
      label: string,
      fallback: T,
    ): T => {
      const r = schema.safeParse(v);
      if (!r.success) {
        meta.errors.push(label);
        return fallback;
      }
      return r.data;
    };
    const title = value(titleSchema, row.title, '名称须为 1–100 字', '待修正'),
      startDate = value(
        dateSchema,
        row.start_date,
        '开始日期无效',
        '1970-01-01',
      );
    const endDate = row.end_date
      ? value(dateSchema, row.end_date, '结束日期无效', startDate)
      : null;
    if (endDate && endDate < startDate)
      meta.errors.push('结束日期早于开始日期');
    meta.endPresent = header.includes('end_date');
    meta.focusPresent = header.includes('focus_dates');
    meta.categoryPresent =
      header.includes('category_name') || header.includes('category_id');
    if (row.entry_version)
      meta.entryVersion = value(
        versionSchema,
        Number(row.entry_version),
        '事项版本无效',
        1,
      );
    if (row.focus_version)
      meta.focusVersion = value(
        versionSchema,
        Number(row.focus_version),
        '重点集合版本无效',
        1,
      );
    const name = row.category_name
      ? value(
          categoryNameSchema,
          row.category_name,
          '分类名须为 1–12 字',
          '待映射',
        )
      : '待映射';
    const color = row.category_color
      ? value(colorSchema, row.category_color, '分类颜色无效', '#A0A4B3')
      : '#A0A4B3';
    const categoryId = stableId({
      category: row.category_id || null,
      name,
      color,
    });
    if (!categories.some((c) => c.id === categoryId))
      categories.push({
        id: categoryId,
        name,
        color,
        seedKey: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    meta.categoryAmbiguous = !row.category_color;
    // Keep the original category ID for a safe actor-local match; no global lookup.
    meta.categoryReference = row.category_id || null;
    meta.categoryName = row.category_name || null;
    const normalized = {
      title,
      startDate,
      endDate,
      category: row.category_id || name,
      color,
      focus: row.focus_dates || '',
      presence: [meta.endPresent, meta.categoryPresent, meta.focusPresent],
    };
    const key = fileHash(normalized),
      occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    const id =
      meta.requestedId && z.uuid().safeParse(meta.requestedId).success
        ? meta.requestedId
        : stableId({ normalized, occurrence });
    if (meta.requestedId && ids.has(meta.requestedId))
      meta.errors.push('同一文件重复更新相同 ID');
    if (meta.requestedId) ids.add(meta.requestedId);
    const e: EntryDto = {
      id,
      categoryId,
      title,
      startDate,
      endDate,
      version: meta.entryVersion ?? 1,
      focusVersion: meta.focusVersion ?? 1,
      deletedAt: null,
      purgeAfter: null,
      createdAt: now,
      updatedAt: now,
    };
    const dates = row.focus_dates
      ? row.focus_dates.split(';').map((d) => d.trim())
      : [];
    if (new Set(dates).size !== dates.length) meta.errors.push('重点日期重复');
    for (const date of dates) {
      if (
        !dateSchema.safeParse(date).success ||
        date < startDate ||
        (endDate && date > endDate) ||
        date > businessToday(new Date(now))
      )
        meta.errors.push('重点日期无效或超出范围');
      else focusDays.push({ entryId: id, date, focused: true, version: 1 });
    }
    entries.push(e);
    rows.push(meta);
  }
  if (focusDays.length > 100_000)
    throw new FileError('FILE_TOO_LARGE', '一次最多导入 100,000 个重点状态。');
  if (categories.length > 20) fail('文件包含超过 20 个分类。');
  // Empty CSV still has a safe mapping placeholder, never deletes business data.
  if (!categories.length)
    categories.push({
      id: stableId('empty'),
      name: '其他',
      color: '#A0A4B3',
      seedKey: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  return {
    sourceNamespace: 'file-csv',
    sourceRevision: digest,
    savedAt: now,
    categories,
    entries,
    focusDays,
    file: { digest, rows },
  };
}
export function fileRowDigest(row: ImportRow) {
  const e = row.source;
  return fileHash({
    id: row.file?.requestedId,
    title: e.title,
    start: e.startDate,
    end: e.endDate,
    category: e.categoryId,
    deletedAt: e.deletedAt,
    purgeAfter: e.purgeAfter,
    focus: row.focusDays.map((f) => ({ date: f.date, focused: f.focused })),
    presence: row.file
      ? [row.file.endPresent, row.file.categoryPresent, row.file.focusPresent]
      : null,
  });
}
export function fileRowKey(row: ImportRow, occurrence: number) {
  return row.file?.requestedId
    ? `file:id:${fileHash(row.file.requestedId)}`
    : `file:noid:${fileRowDigest(row)}:${occurrence}`;
}
export function desiredEntry(
  row: ImportRow,
  current: EntryDto,
  categoryId: string,
): EntryDto {
  return {
    ...current,
    title: row.source.title,
    startDate: row.source.startDate,
    endDate: row.file?.endPresent ? row.source.endDate : current.endDate,
    categoryId: row.file?.categoryPresent ? categoryId : current.categoryId,
  };
}
function fileIndex(cloud: FileCloud) {
  const focus = new Map<string, FocusDayDto[]>();
  for (const f of cloud.focusDays) {
    const a = focus.get(f.entryId) ?? [];
    a.push(f);
    focus.set(f.entryId, a);
  }
  return {
    states: new Map(
      [...focus].map(([id, days]) => [
        id,
        new Map(days.map((f) => [f.date, f.focused])),
      ]),
    ),
    entries: new Map(cloud.entries.map((e) => [e.id, e])),
    focus,
    similar: new Set(
      cloud.entries
        .filter((e) => !e.deletedAt)
        .map((e) => JSON.stringify([e.title, e.startDate, e.endDate])),
    ),
  };
}
export function assessFileRow(
  row: ImportRow,
  cloud: FileCloud,
  mappings: ImportJobDto['categoryMappings'],
  now: string,
  index = fileIndex(cloud),
) {
  const file = row.file;
  if (!file) return;
  const current = index.entries.get(file.requestedId ?? '') ?? null;
  file.current = current;
  file.currentCategory = cloud.categories.find(
    (c) => c.id === current?.categoryId,
  );
  file.currentFocusDays = current
    ? (index.focus.get(current.id) ?? []).map((f) => ({ ...f }))
    : [];
  file.differences = [];
  if (file.errors.length) {
    row.action = 'needs_review';
    row.reason = file.errors.join('；');
    return;
  }
  if (
    row.source.purgeAfter &&
    Date.parse(row.source.purgeAfter) <= Date.parse(now)
  ) {
    row.action = 'skip';
    row.reason = '回收站来源已到期，跳过且不延长期限';
    return;
  }
  if (!current) {
    const duplicate = index.similar.has(
      JSON.stringify([
        row.source.title,
        row.source.startDate,
        row.source.endDate,
      ]),
    );
    row.action = duplicate ? 'needs_review' : 'create_copy';
    row.reason = duplicate
      ? '与当前事项相似，请明确保留副本或跳过'
      : file.requestedId
        ? 'ID 无法在当前空间匹配，将分配新 ID'
        : null;
    return;
  }
  row.previousTargetId = current.id;
  const mapping = mappings.find((c) => c.sourceId === row.source.categoryId),
    desired = desiredEntry(
      row,
      current,
      mapping?.targetId ?? mapping?.candidateId ?? '',
    );
  if (desired.endDate && desired.endDate < desired.startDate)
    file.errors.push('开始日期晚于保留的结束日期，请明确结束日期后重新预览');
  if (
    file.focusPresent &&
    row.focusDays.some(
      (f) =>
        f.focused &&
        (f.date < desired.startDate ||
          (desired.endDate && f.date > desired.endDate)),
    )
  )
    file.errors.push('重点日期超出保留字段后的事项区间');
  if (file.errors.length) {
    row.action = 'needs_review';
    row.reason = file.errors.join('；');
    return;
  }
  for (const field of ['title', 'startDate', 'endDate', 'categoryId'] as const)
    if (desired[field] !== current[field]) file.differences.push(field);
  const currentFocus = (index.focus.get(current.id) ?? [])
    .filter((f) => f.focused)
    .map((f) => f.date)
    .sort();
  const sourceFocus = row.focusDays
    .filter((f) => f.focused)
    .map((f) => f.date)
    .sort();
  if (
    file.focusPresent &&
    (JSON.stringify(currentFocus) !== JSON.stringify(sourceFocus) ||
      row.focusDays.some(
        (f) => index.states.get(current.id)?.get(f.date) !== f.focused,
      ))
  )
    file.differences.push('focusDays');
  if (
    current.deletedAt &&
    row.source.deletedAt &&
    current.deletedAt === row.source.deletedAt &&
    current.purgeAfter === row.source.purgeAfter &&
    !file.differences.length
  ) {
    row.action = 'unchanged';
    row.reason = null;
    return;
  }
  if (current.deletedAt) {
    row.action = 'needs_review';
    row.reason = '目标在回收站，请明确恢复、保留副本或跳过';
    return;
  }
  if (row.source.deletedAt) {
    row.action = 'needs_review';
    row.reason = '备份是回收站状态，当前事项保持活动；请选择副本或跳过';
    return;
  }
  const focusInvalid =
    !file.focusPresent &&
    (index.focus.get(current.id) ?? []).some(
      (f) =>
        f.focused &&
        (f.date < desired.startDate ||
          (desired.endDate && f.date > desired.endDate)),
    );
  if (focusInvalid) {
    file.errors.push(
      '缩短范围会移除当前重点，请在文件明确提供重点集合并重新预览',
    );
    row.action = 'needs_review';
    return;
  }
  if (
    (file.differences.some((f) => f !== 'focusDays') &&
      file.entryVersion !== current.version) ||
    (file.differences.includes('focusDays') &&
      (file.entryVersion !== current.version ||
        file.focusVersion !== current.focusVersion))
  ) {
    row.action = 'needs_review';
    row.code =
      file.entryVersion === null
        ? 'UPDATE_VERSION_REQUIRED'
        : 'VERSION_CONFLICT';
    row.reason =
      file.entryVersion === null
        ? '缺少更新版本，请核对当前内容'
        : '内容或重点集合已有更新，请核对当前内容';
    return;
  }
  row.action = file.differences.length ? 'apply_update' : 'unchanged';
  row.reason = null;
}
export function assessFileRows(
  rows: ImportRow[],
  cloud: FileCloud,
  mappings: ImportJobDto['categoryMappings'],
  now: string,
) {
  const index = fileIndex(cloud);
  for (const row of rows) assessFileRow(row, cloud, mappings, now, index);
}
export function reconcileFileCategories(plan: ImportJobDto, cloud: FileCloud) {
  for (const mapping of plan.categoryMappings) {
    const used = plan.rows.some(
      (r) =>
        r.source.categoryId === mapping.sourceId &&
        (r.action === 'create_copy' ||
          ((r.action === 'apply_update' || r.action === 'restore') &&
            r.file?.categoryPresent)),
    );
    if (plan.kind === 'csv' && !used) {
      mapping.action = 'skip';
      mapping.needsReview = false;
    } else if (mapping.action === 'skip' && used) {
      const target = cloud.categories.find(
        (c) => c.id === (mapping.previousTargetId ?? mapping.targetId),
      );
      if (target) {
        mapping.targetId = target.id;
        mapping.name = target.name;
        mapping.color = target.color;
        mapping.needsReview = false;
        mapping.action = 'apply';
      } else {
        mapping.targetId = null;
        mapping.action = 'apply';
        mapping.needsReview = true;
      }
    }
  }
}
export function reassessFilePlan(
  plan: ImportJobDto,
  cloud: FileCloud,
  now: string,
) {
  const index = fileIndex(cloud);
  for (const row of plan.rows) {
    if (!row.file) continue;
    if (row.processed) {
      row.action = 'skip';
      continue;
    }
    const previous = row.file.current;
    assessFileRow(row, cloud, plan.categoryMappings, now, index);
    if (row.file.errors.length) continue;
    if (row.choice === 'skip') row.action = 'skip';
    if (
      row.choice === 'create_copy' &&
      (!row.source.purgeAfter ||
        Date.parse(row.source.purgeAfter) > Date.parse(now))
    )
      row.action = 'create_copy';
    if (
      row.choice === 'restore' &&
      previous &&
      row.file.current?.version === previous.version &&
      row.file.current.focusVersion === previous.focusVersion &&
      row.file.current.deletedAt
    )
      row.action = 'restore';
  }
}
export function fileMappingsValid(
  plan: ImportJobDto,
  categories: CategoryDto[],
) {
  const names = new Map(categories.map((c) => [c.id, c.name]));
  for (const c of plan.categoryMappings) {
    if (c.action === 'skip') continue;
    if (c.restoreDefault && c.targetId) names.set(c.targetId, c.name);
    if (!c.targetId) {
      names.set(c.candidateId, c.name);
      if (
        c.seedKey &&
        !c.asCustom &&
        categories.some((v) => v.seedKey === c.seedKey)
      )
        return false;
    }
  }
  return names.size <= 20 && new Set(names.values()).size === names.size;
}
export function reviewFileCategory(
  mapping: ImportJobDto['categoryMappings'][number],
  choice: ImportReviewInput['categories'][number],
  cloud: FileCloud,
  mappings: ImportJobDto['categoryMappings'] = [],
) {
  if (
    mapping.action === 'skip' &&
    choice.targetId === mapping.targetId &&
    choice.name === mapping.name &&
    choice.color === mapping.color
  )
    return;
  const target = cloud.categories.find((c) => c.id === choice.targetId);
  const restoring =
    mapping.restoreDefault &&
    choice.targetId === mapping.restoreDefault.id &&
    choice.name === mapping.name &&
    choice.color === mapping.color;
  if (
    restoring &&
    target &&
    (target.version !== mapping.restoreDefault?.version ||
      target.name !== mapping.restoreDefault.name ||
      target.color !== mapping.restoreDefault.color)
  )
    throw new GuestError('PREVIEW_STALE', '默认分类已变化，请重新预览。');
  if (choice.targetId && !target)
    throw new GuestError('PREVIEW_STALE', '分类已变化，请重新核对。');
  if (
    target &&
    !restoring &&
    (target.name !== choice.name || target.color !== choice.color)
  )
    throw new GuestError('PREVIEW_STALE', '分类已变化，请重新核对。');
  if (
    !target &&
    (cloud.categories.some(
      (c) =>
        c.name === choice.name &&
        !mappings.some(
          (m) => m.restoreDefault && m.targetId === c.id && m.name !== c.name,
        ),
    ) ||
      (!choice.asCustom &&
        mapping.seedKey &&
        cloud.categories.some((c) => c.seedKey === mapping.seedKey)))
  )
    throw new GuestError(
      'IMPORT_REVIEW_REQUIRED',
      '请明确复用已有分类或作为自定义分类保留。',
    );
  Object.assign(mapping, choice, { needsReview: false, action: 'apply' });
  if (!restoring) delete mapping.restoreDefault;
}
export function updateFileCounts(plan: ImportJobDto) {
  plan.counts = {
    create: 0,
    update: 0,
    unchanged: 0,
    needsReview: 0,
    errors: 0,
    skip: 0,
  };
  for (const r of plan.rows) {
    if (r.file?.errors.length) plan.counts.errors++;
    else if (r.action === 'needs_review') plan.counts.needsReview++;
    else if (r.action === 'create_copy') plan.counts.create++;
    else if (r.action === 'apply_update' || r.action === 'restore')
      plan.counts.update++;
    else if (r.action === 'unchanged') plan.counts.unchanged++;
    else plan.counts.skip++;
  }
}
export function exportCsv(cloud: FileCloud) {
  const categories = new Map(cloud.categories.map((c) => [c.id, c]));
  const focus = new Map<string, string[]>();
  for (const f of cloud.focusDays)
    if (f.focused) {
      const a = focus.get(f.entryId) ?? [];
      a.push(f.date);
      focus.set(f.entryId, a);
    }
  const safe = (s: string) => (/^[=+\-@\t\r\n']/.test(s) ? "'" + s : s);
  return (
    '\ufeff' +
    Papa.unparse(
      {
        fields: [...CSV_COLUMNS],
        data: cloud.entries
          .filter((e) => !e.deletedAt)
          .map((e) => {
            const c = categories.get(e.categoryId);
            return [
              '1',
              e.id,
              e.version,
              e.focusVersion,
              safe(e.title),
              e.startDate,
              e.endDate ?? '',
              e.categoryId,
              safe(c?.name ?? ''),
              c?.color ?? '',
              (focus.get(e.id) ?? []).sort().join(';'),
              'apostrophe-v1',
            ];
          }),
      },
      { newline: '\r\n' },
    )
  );
}
export function exportJson(cloud: FileCloud, now: string) {
  return JSON.stringify(
    backupSchema
      .extend({
        entries: z.array(entryDtoSchema.strict()),
        focusDays: z.array(focusDayDtoSchema.strict()),
      })
      .parse({
        format: 'dayline-backup',
        schemaVersion: 1,
        exportedAt: now,
        timeZone: 'Asia/Shanghai',
        categories: cloud.categories,
        entries: cloud.entries,
        focusDays: cloud.focusDays,
      }),
    null,
    2,
  );
}
export function csvTemplate() {
  return (
    '\ufeff' +
    Papa.unparse(
      {
        fields: [...CSV_COLUMNS],
        data: [
          [
            '1',
            '',
            '',
            '',
            '阅读示例',
            '2026-01-01',
            '',
            '',
            '阅读',
            '#6C9BCE',
            '',
            '',
          ],
        ],
      },
      { newline: '\r\n' },
    )
  );
}
/** Applies only a reviewed immutable plan. Used by both server transaction and local CAS. */
export function applyFilePlan(
  cloud: FileCloud,
  plan: ImportJobDto,
  now: string,
): {
  cloud: FileCloud;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  mappings: { sourceKey: string; sourceDigest: string; targetId: string }[];
  categoryMappings: {
    sourceKey: string;
    sourceDigest: string;
    targetId: string;
  }[];
} {
  const next: FileCloud = {
    categories: cloud.categories.map((c) => ({ ...c })),
    entries: cloud.entries.map((e) => ({ ...e })),
    focusDays: cloud.focusDays.map((f) => ({ ...f })),
  };
  const categoryIds = new Map<string, string>();
  for (const c of plan.categoryMappings) {
    const id = c.targetId ?? c.previousTargetId ?? c.candidateId;
    if (c.action === 'skip') {
      if (c.targetId || c.previousTargetId) categoryIds.set(c.sourceId, id);
      continue;
    }
    categoryIds.set(c.sourceId, id);
    if (c.targetId) {
      const target = next.categories.find((v) => v.id === id);
      if (c.restoreDefault) {
        const base = c.restoreDefault;
        if (
          !target ||
          target.id !== base.id ||
          target.version !== base.version ||
          target.name !== base.name ||
          target.color !== base.color ||
          target.seedKey !== base.seedKey
        )
          throw new GuestError(
            'PREVIEW_STALE',
            '默认分类已有变化，请重新核对。',
          );
        if (target.name !== c.name || target.color !== c.color) {
          target.name = c.name;
          target.color = c.color;
          target.version++;
          target.updatedAt = now;
        }
      } else if (!target || target.name !== c.name || target.color !== c.color)
        throw new GuestError('PREVIEW_STALE', '分类已变化，请重新核对。');
    } else
      next.categories.push({
        id,
        name: c.name,
        color: c.color,
        seedKey: c.asCustom ? null : c.seedKey,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
  }
  const index = fileIndex(next);
  const result = {
    cloud: next,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    categoryMappings: plan.categoryMappings.flatMap((c) =>
      c.sourceKey &&
      c.sourceDigest &&
      (c.action !== 'skip' || c.targetId || c.previousTargetId)
        ? [
            {
              sourceKey: c.sourceKey,
              sourceDigest: c.sourceDigest,
              targetId: c.targetId ?? c.previousTargetId ?? c.candidateId,
            },
          ]
        : [],
    ),
    mappings: [] as {
      sourceKey: string;
      sourceDigest: string;
      targetId: string;
    }[],
  };
  for (const row of plan.rows) {
    if (row.processed && row.action !== 'skip')
      throw new GuestError(
        'IMPORT_REVIEW_REQUIRED',
        '此来源已完成处理，不重复新增；如需新内容请修改文件后建立新预览。',
      );
    if (row.file?.errors.length)
      throw new GuestError('IMPORT_INVALID', '请先修正所有错误。');
    if (row.action === 'skip') {
      result.skipped++;
      if (row.previousTargetId)
        result.mappings.push({
          sourceKey: row.sourceKey,
          sourceDigest: row.sourceDigest,
          targetId: row.previousTargetId,
        });
      continue;
    }
    if (row.action === 'unchanged') {
      const current = index.entries.get(row.file?.current?.id ?? '');
      if (
        !current ||
        current.version !== row.file?.current?.version ||
        current.focusVersion !== row.file.current.focusVersion
      )
        throw new GuestError('PREVIEW_STALE', '事项已有变化。');
      result.unchanged++;
      result.mappings.push({
        sourceKey: row.sourceKey,
        sourceDigest: row.sourceDigest,
        targetId: current.id,
      });
      continue;
    }
    const categoryId = categoryIds.get(row.source.categoryId);
    if (!categoryId) throw new GuestError('IMPORT_INVALID', '分类映射缺失。');
    let targetId = row.candidateId;
    if (row.action === 'create_copy') {
      if (
        row.source.purgeAfter &&
        Date.parse(row.source.purgeAfter) <= Date.parse(now)
      )
        throw new GuestError('PREVIEW_STALE', '回收站来源已到期。');
      next.entries.push({
        ...row.source,
        id: targetId,
        categoryId,
        version: 1,
        focusVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      next.focusDays.push(
        ...row.focusDays.map((f) => ({ ...f, entryId: targetId, version: 1 })),
      );
      result.created++;
    } else if (row.action === 'apply_update' || row.action === 'restore') {
      const current = index.entries.get(row.file?.current?.id ?? '');
      if (
        !current ||
        current.version !== row.file?.current?.version ||
        current.focusVersion !== row.file.current.focusVersion
      )
        throw new GuestError(
          'PREVIEW_STALE',
          '事项或重点已有变化，请重新核对。',
        );
      targetId = current.id;
      {
        const desired = desiredEntry(row, current, categoryId);
        if (row.action === 'restore') {
          if (
            !current.purgeAfter ||
            Date.parse(current.purgeAfter) <= Date.parse(now)
          )
            throw new GuestError('TRASH_EXPIRED', '已超过恢复期限。');
          desired.deletedAt = null;
          desired.purgeAfter = null;
        }
        if (row.action === 'apply_update' && current.deletedAt)
          throw new GuestError('PREVIEW_STALE', '目标已删除。');
        const contentChanged = [
          'title',
          'startDate',
          'endDate',
          'categoryId',
          'deletedAt',
          'purgeAfter',
        ].some(
          (k) => current[k as keyof EntryDto] !== desired[k as keyof EntryDto],
        );
        if (contentChanged) {
          desired.version++;
          desired.updatedAt = now;
        }
        let focusChanged = false;
        if (row.file?.focusPresent) {
          const source = new Map(row.focusDays.map((f) => [f.date, f]));
          for (const f of index.focus.get(targetId) ?? []) {
            const s = source.get(f.date);
            const wanted = s?.focused ?? false;
            if (f.focused !== wanted) {
              f.focused = wanted;
              f.version++;
              focusChanged = true;
            }
            source.delete(f.date);
          }
          for (const f of source.values()) {
            next.focusDays.push({ ...f, entryId: targetId, version: 1 });
            focusChanged = true;
          }
        }
        if (focusChanged) desired.focusVersion++;
        Object.assign(current, desired);
        if (contentChanged || focusChanged) result.updated++;
        else result.unchanged++;
      }
    } else throw new GuestError('IMPORT_REVIEW_REQUIRED', '请先核对所有选择。');
    result.mappings.push({
      sourceKey: row.sourceKey,
      sourceDigest: row.sourceDigest,
      targetId,
    });
  }
  if (
    next.categories.length > 20 ||
    new Set(next.categories.map((c) => c.name)).size !==
      next.categories.length ||
    new Set(next.categories.flatMap((c) => (c.seedKey ? [c.seedKey] : [])))
      .size !== next.categories.filter((c) => c.seedKey).length
  )
    throw new GuestError('CATEGORY_LIMIT_EXCEEDED', '请整理分类映射。');
  const graph = guestPackageSchema.safeParse({
    format: 'dayline-guest',
    schemaVersion: 1,
    localSchemaVersion: 1,
    guestDatasetId: stableId('applied'),
    packageRevision: 1,
    timeZone: 'Asia/Shanghai',
    savedAt: now,
    ...next,
  });
  if (!graph.success)
    throw new GuestError(
      'IMPORT_INVALID',
      '计划中的日期、重点或引用无效，请修正后重新预览。',
    );
  return result;
}
export function guestFileCommit(
  current: GuestPackage,
  plan: ImportJobDto,
  now: string,
): GuestPackage {
  if (
    Date.parse(plan.expiresAt) <= Date.parse(now) ||
    String(current.packageRevision) !== plan.baseDataVersion ||
    !plan.canCommit ||
    plan.status !== 'preview'
  )
    throw new GuestError('PREVIEW_STALE', '本机记录已变化，请重新预览。');
  const result = applyFilePlan(current, plan, now);
  if (
    !result.created &&
    !result.updated &&
    JSON.stringify(result.cloud.categories) ===
      JSON.stringify(current.categories)
  )
    return current;
  return guestPackageSchema.parse({
    ...current,
    ...result.cloud,
    packageRevision: current.packageRevision + 1,
    savedAt: now,
  });
}

export function initializeFilePlan(
  plan: ImportJobDto,
  source: NormalizedImportSource,
  cloud: FileCloud,
  processed: Map<string, { sourceDigest: string; targetId: string }>,
  now: string,
) {
  const occurrences = new Map<string, number>(),
    index = fileIndex(cloud);
  const empty =
    cloud.entries.length === 0 &&
    cloud.focusDays.length === 0 &&
    cloud.categories.length === DEFAULT_CATEGORIES.length &&
    DEFAULT_CATEGORIES.every((seed) =>
      cloud.categories.some(
        (c) =>
          c.seedKey === seed.seedKey &&
          c.name === seed.name &&
          c.color === seed.color,
      ),
    );
  for (const mapping of plan.categoryMappings) {
    const original = source.categories.find((c) => c.id === mapping.sourceId);
    if (!original) continue;
    mapping.sourceKey = `file:${plan.kind}:category:${original.id}`;
    mapping.sourceDigest = fileHash({
      name: original.name,
      color: original.color,
      seedKey: original.seedKey,
    });
    const prior = importSourceReceipt(
      processed,
      mapping.sourceKey,
      mapping.sourceDigest,
    );
    if (prior?.sourceDigest === mapping.sourceDigest) {
      mapping.previousTargetId = prior.targetId;
      const current = cloud.categories.find((c) => c.id === prior.targetId);
      if (current) {
        mapping.targetId = current.id;
        mapping.name = current.name;
        mapping.color = current.color;
        mapping.needsReview = false;
      }
      mapping.action = 'skip';
      continue;
    }
    mapping.action = 'apply';
    if (plan.kind === 'json' && mapping.seedKey) {
      const sameSeed = cloud.categories.find(
        (c) => c.seedKey === mapping.seedKey,
      );
      if (empty && sameSeed) {
        mapping.targetId = sameSeed.id;
        mapping.restoreDefault = { ...sameSeed };
        mapping.needsReview = false;
      } else if (sameSeed && mapping.targetId !== sameSeed.id)
        mapping.needsReview = true;
    }
    if (plan.kind === 'json' && !empty) {
      const byId = cloud.categories.find((c) => c.id === mapping.sourceId);
      if (byId && (byId.name !== mapping.name || byId.color !== mapping.color))
        mapping.needsReview = true;
    }
  }
  if (plan.kind === 'csv') {
    // Allocate only in the plan: parsed IDs/digests remain stable across palette usage
    // changes, renames, retries and reimports. Explicit file colors reserve their slot.
    const missingColor = new Set(
      source.categories
        .filter(
          (category) =>
            source.entries.filter((entry) => entry.categoryId === category.id)
              .length > 0 &&
            source.entries.every(
              (entry, i) =>
                entry.categoryId !== category.id ||
                source.file?.rows[i]?.categoryAmbiguous,
            ),
        )
        .map((category) => category.id),
    );
    const used = cloud.categories.map((c) => c.color);
    for (const mapping of plan.categoryMappings) {
      if (mapping.action === 'skip') continue;
      const row = source.entries.findIndex(
        (e) => e.categoryId === mapping.sourceId,
      );
      const reference = source.file?.rows[row]?.categoryReference;
      const sameName =
        cloud.categories.find((c) => c.id === reference) ??
        cloud.categories.find((c) => c.name === mapping.name);
      if (sameName) {
        mapping.targetId = sameName.id;
        mapping.color = sameName.color;
        mapping.needsReview = false;
      } else if (!missingColor.has(mapping.sourceId)) used.push(mapping.color);
    }
    for (const mapping of plan.categoryMappings) {
      if (mapping.action === 'skip') continue;
      if (!mapping.targetId && missingColor.has(mapping.sourceId)) {
        mapping.color = nextCategoryColor(used);
        used.push(mapping.color);
        mapping.needsReview = false;
      }
    }
  }
  if (plan.kind === 'json' && empty) {
    const reserved = new Set(
      plan.categoryMappings.filter((c) => c.seedKey).map((c) => c.targetId),
    );
    for (const mapping of plan.categoryMappings)
      if (
        !mapping.seedKey &&
        mapping.targetId &&
        reserved.has(mapping.targetId)
      ) {
        mapping.targetId = null;
        mapping.needsReview = false;
      }
  }
  for (const [i, row] of plan.rows.entries()) {
    row.file = source.file?.rows[i];
    if (!row.file) continue;
    const digest = fileRowDigest(row),
      occurrence = (occurrences.get(digest) ?? 0) + 1;
    occurrences.set(digest, occurrence);
    row.sourceDigest = digest;
    row.sourceKey = fileRowKey(row, occurrence);
    const mapping = plan.categoryMappings.find(
      (c) => c.sourceId === row.source.categoryId,
    );
    if (mapping && plan.kind === 'csv' && mapping.action !== 'skip') {
      const byId = cloud.categories.find(
        (c) => c.id === row.file?.categoryReference,
      );
      if (byId) {
        mapping.targetId = byId.id;
        mapping.name = byId.name;
        mapping.color = byId.color;
        mapping.needsReview =
          !!row.file.categoryName && row.file.categoryName !== byId.name;
      } else if (!row.file.categoryName && !mapping.targetId)
        mapping.needsReview = true;
      if (!row.file.categoryPresent && row.file.requestedId) {
        const target = cloud.entries.find(
          (e) => e.id === row.file?.requestedId,
        );
        const category = cloud.categories.find(
          (c) => c.id === target?.categoryId,
        );
        if (category) {
          mapping.targetId = category.id;
          mapping.name = category.name;
          mapping.color = category.color;
          mapping.needsReview = false;
        }
      }
      if (
        !row.file.requestedId &&
        !row.file.categoryName &&
        !byId &&
        plan.kind === 'csv'
      )
        row.file.errors.push('新事项必须提供分类名称或当前分类 ID');
    }
    assessFileRow(row, cloud, plan.categoryMappings, now, index);
    const prior = importSourceReceipt(processed, row.sourceKey, digest);
    if (prior?.sourceDigest === digest && !row.file.errors.length) {
      row.action = 'skip';
      row.processed = true;
      row.previousTargetId = prior.targetId;
      row.reason = '此来源已处理，跳过（包括已清理目标）';
    }
  }
  reconcileFileCategories(plan, cloud);
  updateFileCounts(plan);
}
export function createLocalFilePlan(
  source: NormalizedImportSource,
  cloud: FileCloud,
  revision: string,
  uuid: () => string,
  now: string,
  processed: Map<string, { sourceDigest: string; targetId: string }>,
): ImportJobDto {
  const focus = new Map<string, FocusDayDto[]>();
  for (const f of source.focusDays) {
    const a = focus.get(f.entryId) ?? [];
    a.push(f);
    focus.set(f.entryId, a);
  }
  const plan: ImportJobDto = {
    id: uuid(),
    clientOperationId: uuid(),
    kind: source.sourceNamespace === 'file-csv' ? 'csv' : 'json',
    status: 'preview',
    disposition: 'preview_required',
    inputDigest: source.file?.digest ?? '',
    planDigest: '',
    planRevision: 1,
    baseDataVersion: revision,
    expiresAt: new Date(Date.parse(now) + 86400000).toISOString(),
    canCommit: false,
    sourceSummary: {
      entries: source.entries.length,
      categories: source.categories.length,
      focusDays: source.focusDays.length,
    },
    targetSummary: {
      entries: cloud.entries.length,
      categories: cloud.categories.length,
      focusDays: cloud.focusDays.length,
    },
    categoryMappings: source.categories.map((c) => {
      const same = cloud.categories.find(
        (t) =>
          t.name === c.name &&
          t.color === c.color &&
          (!c.seedKey || t.seedKey === c.seedKey),
      );
      return {
        sourceId: c.id,
        candidateId: uuid(),
        targetId: same?.id ?? null,
        name: c.name,
        color: c.color,
        seedKey: c.seedKey,
        needsReview: !same && cloud.categories.some((t) => t.name === c.name),
      };
    }),
    rows: source.entries.map((e) => ({
      sourceKey: e.id,
      sourceDigest: '',
      candidateId: uuid(),
      source: e,
      focusDays: focus.get(e.id) ?? [],
      action: 'create_copy',
      previousTargetId: null,
      reason: null,
    })),
    result: null,
  };
  initializeFilePlan(plan, source, cloud, processed, now);
  finishLocalPlan(plan, cloud.categories);
  return plan;
}
export function finishLocalPlan(plan: ImportJobDto, categories: CategoryDto[]) {
  updateFileCounts(plan);
  const names = plan.categoryMappings
    .filter((c) => !c.targetId && c.action !== 'skip')
    .map((c) => c.name);
  plan.canCommit =
    plan.status === 'preview' &&
    !plan.categoryMappings.some((c) => c.action !== 'skip' && c.needsReview) &&
    !plan.rows.some(
      (r) => r.action === 'needs_review' || r.file?.errors.length,
    ) &&
    fileMappingsValid(plan, categories) &&
    new Set(names).size === names.length;
  plan.planDigest = fileHash({ ...plan, planDigest: '' });
}
export function reviewLocalFilePlan(
  plan: ImportJobDto,
  cloud: FileCloud,
  input: ImportReviewInput,
  revision: string,
  now: string,
): ImportJobDto {
  if (
    plan.status !== 'preview' ||
    Date.parse(plan.expiresAt) <= Date.parse(now) ||
    input.expectedPlanRevision !== plan.planRevision
  )
    throw new GuestError('PREVIEW_STALE', '计划已变化或到期，请重新预览。');
  const next = JSON.parse(JSON.stringify(plan)) as ImportJobDto,
    index = fileIndex(cloud),
    rowsByKey = new Map<string, ImportRow>();
  for (const row of next.rows) rowsByKey.set(row.sourceKey, row);
  if (
    new Set(input.rows.map((r) => r.sourceKey)).size !== input.rows.length ||
    new Set(input.categories.map((c) => c.sourceId)).size !==
      input.categories.length
  )
    throw new GuestError('IMPORT_INVALID', '选择重复。');
  for (const c of input.categories) {
    const mapping = next.categoryMappings.find(
      (v) => v.sourceId === c.sourceId,
    );
    if (!mapping) throw new GuestError('PREVIEW_STALE', '分类来源已变化。');
    reviewFileCategory(mapping, c, cloud, next.categoryMappings);
  }
  reassessFilePlan(next, cloud, now);
  for (const choice of input.rows) {
    const row = rowsByKey.get(choice.sourceKey);
    if (row?.processed && choice.action !== 'skip')
      throw new GuestError(
        'IMPORT_REVIEW_REQUIRED',
        '此来源已处理，请保持跳过。',
      );
    if (!row || row.file?.errors.length)
      throw new GuestError('IMPORT_INVALID', '请修正文件后重新预览。');
    if (choice.action === 'apply_update' || choice.action === 'restore') {
      const current = index.entries.get(row.file?.requestedId ?? '');
      if (
        !row.file ||
        !current ||
        current.version !== choice.expectedEntryVersion ||
        current.focusVersion !== choice.expectedFocusVersion ||
        (choice.action === 'apply_update' &&
          (current.deletedAt || row.source.deletedAt)) ||
        (choice.action === 'restore' &&
          (!current.deletedAt || row.source.deletedAt))
      )
        throw new GuestError(
          'PREVIEW_STALE',
          '当前内容已有新变化，请重新核对。',
        );
      row.file.current = current;
      row.file.currentFocusDays = (index.focus.get(current.id) ?? []).map(
        (f) => ({ ...f }),
      );
      row.file.entryVersion = current.version;
      row.file.focusVersion = current.focusVersion;
      row.previousTargetId = current.id;
    }
    row.choice = choice.action;
    row.action =
      choice.action === 'apply_update' && !row.file?.differences.length
        ? 'unchanged'
        : choice.action;
  }
  reconcileFileCategories(next, cloud);
  next.baseDataVersion = revision;
  next.planRevision++;
  finishLocalPlan(next, cloud.categories);
  return next;
}
