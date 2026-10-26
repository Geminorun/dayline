import { z } from 'zod';
import { businessToday, DEFAULT_CATEGORIES, TIME_ZONE } from '@dayline/core';
import {
  categoryDtoSchema,
  entryDtoSchema,
  focusDayDtoSchema,
  createEntrySchema,
  patchEntrySchema,
  createCategorySchema,
  patchCategorySchema,
  deleteCategorySchema,
  setFocusSchema,
  purgeTrashSchema,
  dateSchema,
  expectedVersionSchema,
} from './records.js';
import type { EntryDto, SnapshotDto } from './records.js';
export const guestPackageSchema = z
  .object({
    format: z.literal('dayline-guest'),
    schemaVersion: z.literal(1),
    localSchemaVersion: z.literal(1),
    guestDatasetId: z.uuid(),
    packageRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    timeZone: z.literal(TIME_ZONE),
    savedAt: z.iso.datetime(),
    categories: z.array(categoryDtoSchema).min(1).max(20),
    entries: z.array(entryDtoSchema),
    focusDays: z.array(focusDayDtoSchema),
  })
  .strict()
  .superRefine((data, ctx) => {
    const categories = new Set(data.categories.map((c) => c.id)),
      names = new Set(data.categories.map((c) => c.name)),
      entries = new Map(data.entries.map((e) => [e.id, e])),
      focus = new Set<string>();
    if (
      categories.size !== data.categories.length ||
      names.size !== data.categories.length ||
      entries.size !== data.entries.length
    )
      ctx.addIssue({ code: 'custom', message: '重复标识或分类名' });
    for (const entry of data.entries) {
      if (
        !categories.has(entry.categoryId) ||
        (entry.endDate !== null && entry.endDate < entry.startDate) ||
        (entry.deletedAt === null) !== (entry.purgeAfter === null) ||
        (entry.deletedAt &&
          entry.purgeAfter &&
          Date.parse(entry.purgeAfter) <= Date.parse(entry.deletedAt))
      )
        ctx.addIssue({
          code: 'custom',
          message: '事项引用、区间或回收站状态损坏',
        });
    }
    const savedToday = businessToday(new Date(data.savedAt));
    for (const day of data.focusDays) {
      const key = day.entryId + day.date,
        entry = entries.get(day.entryId);
      if (
        focus.has(key) ||
        !entry ||
        day.version < 1 ||
        (day.focused &&
          (day.date < entry.startDate ||
            (entry.endDate !== null && day.date > entry.endDate) ||
            day.date > savedToday))
      )
        ctx.addIssue({ code: 'custom', message: '重点引用、版本或日期损坏' });
      focus.add(key);
    }
  });
export type GuestPackage = z.infer<typeof guestPackageSchema>;
export class GuestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
export function readGuestPackage(value: unknown): GuestPackage {
  const parsed = guestPackageSchema.safeParse(value);
  if (!parsed.success)
    throw new GuestError(
      'LOCAL_RECOVERY_REQUIRED',
      '本机记录损坏或版本不兼容，原始数据已保留，请恢复后重试。',
    );
  return parsed.data;
}
export function createGuestPackage(
  uuid: () => string,
  now: string,
): GuestPackage {
  return readGuestPackage({
    format: 'dayline-guest',
    schemaVersion: 1,
    localSchemaVersion: 1,
    guestDatasetId: uuid(),
    packageRevision: 1,
    timeZone: TIME_ZONE,
    savedAt: now,
    entries: [],
    focusDays: [],
    categories: DEFAULT_CATEGORIES.map((c) => ({
      ...c,
      id: uuid(),
      version: 1,
      createdAt: now,
      updatedAt: now,
    })),
  });
}
export function guestSnapshot(data: GuestPackage, today: string): SnapshotDto {
  return {
    schemaVersion: 1,
    userId: data.guestDatasetId,
    dataVersion: String(data.packageRevision),
    timeZone: TIME_ZONE,
    businessToday: today,
    complete: true,
    categories: data.categories,
    entries: data.entries.filter((e) => !e.deletedAt),
    trashEntries: data.entries.filter((e) => e.deletedAt),
    focusDays: data.focusDays,
  };
}
export type GuestMutation =
  | { kind: 'create'; input: unknown }
  | { kind: 'update'; id: string; input: unknown }
  | {
      kind: 'finish' | 'remove' | 'restore';
      id: string;
      expectedVersion: number;
    }
  | { kind: 'focus'; id: string; date: string; input: unknown }
  | { kind: 'createCategory'; input: unknown }
  | { kind: 'updateCategory' | 'deleteCategory'; id: string; input: unknown }
  | { kind: 'purge'; input: unknown }
  | { kind: 'expire' };
function valid<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new GuestError(
      'VALIDATION_ERROR',
      '请检查名称长度、合法日期、分类和版本。',
    );
  return parsed.data;
}
function fail(code: string, message: string, details?: unknown): never {
  throw new GuestError(code, message, details);
}
function version(expected: number, current: number) {
  if (expected !== current)
    fail('VERSION_CONFLICT', '记录已有更新，请重新读取并核对输入。', {
      expectedVersion: expected,
      currentVersion: current,
    });
}
/** Immutable local business transaction. Adapter must CAS and durably commit the result. */
export function mutateGuest(
  previous: GuestPackage,
  mutation: GuestMutation,
  now: string,
): GuestPackage {
  const data: GuestPackage = {
    ...previous,
    categories: previous.categories.map((c) => ({ ...c })),
    entries: previous.entries.map((e) => ({ ...e })),
    focusDays: previous.focusDays.map((f) => ({ ...f })),
  };
  let changed = false;
  const today = businessToday(new Date(now));
  const category = (id: string) =>
    data.categories.find((c) => c.id === id) ??
    fail('RESOURCE_NOT_FOUND', '分类已不存在，请重新选择。');
  const entry = (id: string, active = true) => {
    const found =
      data.entries.find((e) => e.id === id) ??
      fail('RESOURCE_NOT_FOUND', '事项已不存在。');
    if (active && found.deletedAt) fail('ENTRY_DELETED', '事项已在回收站。');
    return found;
  };
  const bump = (e: EntryDto) => {
    e.version++;
    e.updatedAt = now;
    changed = true;
  };
  switch (mutation.kind) {
    case 'create': {
      const input = valid(createEntrySchema, mutation.input);
      category(input.categoryId);
      if (input.endDate && input.endDate < input.startDate)
        fail('VALIDATION_ERROR', '结束日期不能早于开始日期。');
      const old = data.entries.find((e) => e.id === input.id);
      if (old) {
        if (
          old.deletedAt ||
          old.title !== input.title ||
          old.startDate !== input.startDate ||
          old.endDate !== input.endDate ||
          old.categoryId !== input.categoryId
        )
          fail('IDEMPOTENCY_KEY_REUSED', '此标识已保存其他内容。');
        break;
      }
      data.entries.push({
        ...input,
        version: 1,
        focusVersion: 1,
        deletedAt: null,
        purgeAfter: null,
        createdAt: now,
        updatedAt: now,
      });
      changed = true;
      break;
    }
    case 'update': {
      const input = valid(patchEntrySchema, mutation.input),
        e = entry(mutation.id);
      version(input.expectedVersion, e.version);
      if (input.categoryId) category(input.categoryId);
      const start = input.startDate ?? e.startDate,
        end = input.endDate === undefined ? e.endDate : input.endDate;
      if (end && end < start)
        fail('VALIDATION_ERROR', '结束日期不能早于开始日期。');
      const affected = data.focusDays
        .filter(
          (f) =>
            f.entryId === e.id &&
            f.focused &&
            (f.date < start || (end !== null && f.date > end)),
        )
        .sort((a, b) => a.date.localeCompare(b.date));
      const ack = input.focusRemovalAcknowledgement;
      if (
        (affected.length || ack !== undefined) &&
        (!ack ||
          ack.length !== affected.length ||
          [...ack]
            .sort((a, b) => a.date.localeCompare(b.date))
            .some(
              (f, i) =>
                f.date !== affected[i]?.date ||
                f.version !== affected[i]?.version,
            ))
      )
        fail(
          'FOCUS_REMOVAL_CONFIRMATION_REQUIRED',
          '日期范围变化将移除重点，请确认具体日期。',
          {
            currentVersion: e.version,
            affectedFocusDays: affected.map(({ date, version }) => ({
              date,
              version,
            })),
          },
        );
      if (
        e.title === (input.title ?? e.title) &&
        e.categoryId === (input.categoryId ?? e.categoryId) &&
        e.startDate === start &&
        e.endDate === end
      )
        break;
      e.title = input.title ?? e.title;
      e.categoryId = input.categoryId ?? e.categoryId;
      e.startDate = start;
      e.endDate = end;
      for (const f of affected) {
        f.focused = false;
        f.version++;
      }
      if (affected.length) e.focusVersion++;
      bump(e);
      break;
    }
    case 'finish':
    case 'remove':
    case 'restore': {
      valid(expectedVersionSchema, {
        expectedVersion: mutation.expectedVersion,
      });
      const e = entry(mutation.id, mutation.kind !== 'restore');
      version(mutation.expectedVersion, e.version);
      if (mutation.kind === 'finish') {
        if (e.startDate > today) fail('VALIDATION_ERROR', '未来事项尚未开始。');
        if (e.endDate && e.endDate < today)
          fail('ENTRY_ALREADY_ENDED', '事项已在历史日期结束。');
        if (e.endDate === today) break;
        e.endDate = today;
      } else if (mutation.kind === 'remove') {
        e.deletedAt = now;
        e.purgeAfter = new Date(Date.parse(now) + 30 * 86400000).toISOString();
      } else {
        if (!e.deletedAt || !e.purgeAfter)
          fail('ENTRY_NOT_DELETED', '事项不在回收站。');
        if (Date.parse(e.purgeAfter) <= Date.parse(now))
          fail('TRASH_EXPIRED', '事项已超过恢复期限。');
        e.deletedAt = null;
        e.purgeAfter = null;
      }
      bump(e);
      break;
    }
    case 'focus': {
      valid(dateSchema, mutation.date);
      const input = valid(setFocusSchema, mutation.input),
        e = entry(mutation.id);
      version(input.expectedEntryVersion, e.version);
      const old = data.focusDays.find(
        (f) => f.entryId === e.id && f.date === mutation.date,
      );
      version(input.expectedFocusVersion, old?.version ?? 0);
      if (
        input.focused &&
        (mutation.date > today ||
          mutation.date < e.startDate ||
          (e.endDate && mutation.date > e.endDate))
      )
        fail('VALIDATION_ERROR', '重点须在事项范围内且不晚于今天。');
      if (input.focused === (old?.focused ?? false)) break;
      if (old) {
        old.focused = input.focused;
        old.version++;
      } else
        data.focusDays.push({
          entryId: e.id,
          date: mutation.date,
          focused: input.focused,
          version: 1,
        });
      e.focusVersion++;
      changed = true;
      break;
    }
    case 'createCategory': {
      const input = valid(createCategorySchema, mutation.input);
      const old = data.categories.find((c) => c.id === input.id);
      if (old) {
        if (old.name !== input.name || old.color !== input.color)
          fail('IDEMPOTENCY_KEY_REUSED', '此标识已保存其他内容。');
        break;
      }
      if (data.categories.length >= 20)
        fail('CATEGORY_LIMIT_EXCEEDED', '最多 20 个分类。');
      if (data.categories.some((c) => c.name === input.name))
        fail('CATEGORY_NAME_EXISTS', '分类名称已存在。');
      data.categories.push({
        ...input,
        seedKey: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      changed = true;
      break;
    }
    case 'updateCategory': {
      const input = valid(patchCategorySchema, mutation.input),
        c = category(mutation.id);
      version(input.expectedVersion, c.version);
      if (
        data.categories.some(
          (other) => other.id !== c.id && other.name === (input.name ?? c.name),
        )
      )
        fail('CATEGORY_NAME_EXISTS', '分类名称已存在。');
      if (
        c.name === (input.name ?? c.name) &&
        c.color === (input.color ?? c.color)
      )
        break;
      c.name = input.name ?? c.name;
      c.color = input.color ?? c.color;
      c.version++;
      c.updatedAt = now;
      changed = true;
      break;
    }
    case 'deleteCategory': {
      const input = valid(deleteCategorySchema, mutation.input),
        c = category(mutation.id);
      if (data.categories.length <= 1)
        fail('LAST_CATEGORY', '至少保留一个分类。');
      const target = category(input.transferToCategoryId);
      version(input.expectedVersion, c.version);
      version(input.expectedTargetVersion, target.version);
      if (c.id === target.id) fail('VALIDATION_ERROR', '请选择另一个分类。');
      for (const e of data.entries)
        if (e.categoryId === c.id) {
          e.categoryId = target.id;
          bump(e);
        }
      data.categories = data.categories.filter((v) => v.id !== c.id);
      changed = true;
      break;
    }
    case 'purge':
    case 'expire': {
      let ids: Set<string>;
      if (mutation.kind === 'expire')
        ids = new Set(
          data.entries
            .filter(
              (e) =>
                e.purgeAfter !== null &&
                Date.parse(e.purgeAfter) <= Date.parse(now),
            )
            .map((e) => e.id),
        );
      else {
        const input = valid(purgeTrashSchema, mutation.input);
        if ('expectedDataVersion' in input) {
          if (input.expectedDataVersion !== String(data.packageRevision))
            fail('DATA_VERSION_CONFLICT', '本机记录已变化，请重新确认清理。');
          ids = new Set(
            data.entries.filter((e) => e.deletedAt).map((e) => e.id),
          );
        } else {
          ids = new Set(input.entries.map((e) => e.id));
          if (ids.size !== input.entries.length)
            fail('VALIDATION_ERROR', '清理目标不能重复。');
          for (const target of input.entries) {
            const e = entry(target.id, false);
            version(target.expectedVersion, e.version);
            if (!e.deletedAt) fail('ENTRY_NOT_DELETED', '事项不在回收站。');
          }
        }
      }
      if (ids.size) {
        data.entries = data.entries.filter((e) => !ids.has(e.id));
        data.focusDays = data.focusDays.filter((f) => !ids.has(f.entryId));
        changed = true;
      }
      break;
    }
  }
  if (!changed) return previous;
  data.packageRevision++;
  data.savedAt = now;
  return readGuestPackage(data);
}
export interface GuestRepository {
  read(): Promise<GuestPackage | null>;
  commit(next: GuestPackage, expectedRevision: number | null): Promise<void>;
}
export async function loadGuest(
  repository: GuestRepository,
  uuid: () => string,
  now: string,
) {
  let data = await repository.read();
  if (!data) {
    data = createGuestPackage(uuid, now);
    await repository.commit(data, null);
  }
  const clean = mutateGuest(data, { kind: 'expire' }, now);
  if (clean !== data) await repository.commit(clean, data.packageRevision);
  return clean;
}
export async function commitGuestMutation(
  repository: GuestRepository,
  current: GuestPackage,
  mutation: GuestMutation,
  now: string,
) {
  const next = mutateGuest(current, mutation, now);
  if (next !== current) await repository.commit(next, current.packageRevision);
  return next;
}

export function isDefaultGuestEmpty(data: GuestPackage): boolean {
  return (
    !data.entries.length &&
    !data.focusDays.length &&
    data.categories.length === DEFAULT_CATEGORIES.length &&
    DEFAULT_CATEGORIES.every((seed) =>
      data.categories.some(
        (c) =>
          c.seedKey === seed.seedKey &&
          c.name === seed.name &&
          c.color === seed.color,
      ),
    )
  );
}
