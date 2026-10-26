let sequence = 0;
const randomUUID = () =>
  `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
import { describe, expect, it } from 'vitest';
import {
  createGuestPackage,
  mutateGuest,
  readGuestPackage,
  commitGuestMutation,
  loadGuest,
} from '../src/index.js';
import type { GuestRepository, GuestPackage } from '../src/index.js';
const now = '2026-10-26T04:00:00.000Z';
function fixture() {
  const data = createGuestPackage(randomUUID, now),
    categoryId = data.categories[0]?.id ?? '',
    id = randomUUID();
  return {
    data: mutateGuest(
      data,
      {
        kind: 'create',
        input: {
          id,
          categoryId,
          title: '阅读',
          startDate: '2026-10-01',
          endDate: null,
        },
      },
      now,
    ),
    id,
    categoryId,
  };
}
describe('guest immutable business package', () => {
  it('initializes UUID defaults exactly once and commits before exposing successful data', async () => {
    let stored: GuestPackage | null = null;
    const repository: GuestRepository = {
      read: async () => stored,
      commit: async (next) => {
        stored = next;
      },
    };
    const one = await loadGuest(repository, randomUUID, now),
      two = await loadGuest(repository, randomUUID, now);
    expect(two).toEqual(one);
    expect(two.categories).toHaveLength(6);
    const { data, id } = fixture();
    let release: () => void = () => {};
    repository.commit = () =>
      new Promise<void>((resolve) => (release = resolve));
    let done = false;
    const pending = commitGuestMutation(
      repository,
      data,
      { kind: 'remove', id, expectedVersion: 1 },
      now,
    ).then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    expect(data.entries[0]?.deletedAt).toBeNull();
    release();
    await pending;
    expect(done).toBe(true);
  });
  it('keeps false focus versions, exact range acknowledgement and atomic category transfer including trash', () => {
    const { data, id } = fixture();
    const focused = mutateGuest(
      data,
      {
        kind: 'focus',
        id,
        date: '2026-10-25',
        input: {
          focused: true,
          expectedEntryVersion: 1,
          expectedFocusVersion: 0,
        },
      },
      now,
    );
    const mutation = {
      kind: 'update' as const,
      id,
      input: { expectedVersion: 1, endDate: '2026-10-20' },
    };
    expect(() => mutateGuest(focused, mutation, now)).toThrow('确认具体日期');
    expect(focused.entries[0]?.endDate).toBeNull();
    expect(() =>
      mutateGuest(
        focused,
        {
          ...mutation,
          input: {
            ...mutation.input,
            focusRemovalAcknowledgement: [{ date: '2026-10-25', version: 2 }],
          },
        },
        now,
      ),
    ).toThrow();
    const shortened = mutateGuest(
      focused,
      {
        ...mutation,
        input: {
          ...mutation.input,
          focusRemovalAcknowledgement: [{ date: '2026-10-25', version: 1 }],
        },
      },
      now,
    );
    expect(shortened.focusDays[0]).toMatchObject({
      focused: false,
      version: 2,
    });
    expect(() =>
      mutateGuest(
        shortened,
        {
          kind: 'focus',
          id,
          date: '2026-10-25',
          input: {
            focused: true,
            expectedEntryVersion: 2,
            expectedFocusVersion: 1,
          },
        },
        now,
      ),
    ).toThrow('更新');
    const deleted = mutateGuest(
        shortened,
        { kind: 'remove', id, expectedVersion: 2 },
        now,
      ),
      source = deleted.categories[0],
      target = deleted.categories[1];
    if (!source || !target) throw new Error('Missing defaults');
    const moved = mutateGuest(
      deleted,
      {
        kind: 'deleteCategory',
        id: source.id,
        input: {
          expectedVersion: source.version,
          transferToCategoryId: target.id,
          expectedTargetVersion: target.version,
        },
      },
      now,
    );
    expect(moved.entries[0]).toMatchObject({
      categoryId: target.id,
      version: 4,
      deletedAt: now,
    });
    expect(moved.focusDays[0]?.version).toBe(2);
  });
  it('enforces expiry boundary, no restoration by stale content, and revision-controlled cleanup', () => {
    const { data, id } = fixture(),
      deleted = mutateGuest(
        data,
        { kind: 'remove', id, expectedVersion: 1 },
        now,
      ),
      expiry = '2026-11-25T04:00:00.000Z';
    expect(() =>
      mutateGuest(deleted, { kind: 'restore', id, expectedVersion: 2 }, expiry),
    ).toThrow('恢复期限');
    expect(() =>
      mutateGuest(
        deleted,
        { kind: 'update', id, input: { expectedVersion: 1, title: '旧输入' } },
        now,
      ),
    ).toThrow('回收站');
    expect(() =>
      mutateGuest(
        deleted,
        {
          kind: 'purge',
          input: { expectedDataVersion: String(data.packageRevision) },
        },
        now,
      ),
    ).toThrow('重新确认');
    const expired = mutateGuest(deleted, { kind: 'expire' }, expiry);
    expect(expired.entries).toEqual([]);
    expect(expired.packageRevision).toBe(deleted.packageRevision + 1);
  });
  it('rejects corrupt references, duplicate identities, unknown schema and true focus outside ranges without modifying originals', () => {
    const { data, id } = fixture();
    for (const damaged of [
      { ...data, localSchemaVersion: 2 },
      { ...data, entries: [...data.entries, ...data.entries] },
      { ...data, categories: data.categories.slice(1) },
      {
        ...data,
        focusDays: [
          { entryId: id, date: '2026-09-01', focused: true, version: 1 },
        ],
      },
    ])
      expect(() => readGuestPackage(damaged)).toThrow('原始数据已保留');
    expect(data.entries).toHaveLength(1);
  });
  it('preserves caller data when durable storage rejects and validates Unicode code points / future start', async () => {
    const { data, id } = fixture(),
      repository: GuestRepository = {
        read: async () => data,
        commit: async () => {
          throw new Error('disk full');
        },
      };
    await expect(
      commitGuestMutation(
        repository,
        data,
        { kind: 'remove', id, expectedVersion: 1 },
        now,
      ),
    ).rejects.toThrow('disk full');
    expect(data.entries[0]?.deletedAt).toBeNull();
    expect(
      mutateGuest(
        data,
        {
          kind: 'update',
          id,
          input: { expectedVersion: 1, title: '😀'.repeat(100) },
        },
        now,
      ).entries[0]?.title,
    ).toBe('😀'.repeat(100));
    expect(() =>
      mutateGuest(
        data,
        {
          kind: 'update',
          id,
          input: { expectedVersion: 1, title: '😀'.repeat(101) },
        },
        now,
      ),
    ).toThrow();
    const future = mutateGuest(
      data,
      {
        kind: 'update',
        id,
        input: { expectedVersion: 1, startDate: '9999-12-31' },
      },
      now,
    );
    expect(() =>
      mutateGuest(future, { kind: 'finish', id, expectedVersion: 2 }, now),
    ).toThrow('尚未开始');
  });
});
