import { describe, it, expect, vi } from 'vitest';
import { SnapshotCoordinator } from '../src/snapshot-coordinator.js';
import { snapshotDtoSchema, compareDataVersions } from '@dayline/contracts';
import type { SnapshotDto, SnapshotEnvelope } from '@dayline/contracts';
const userId = '63a561bd-2302-485d-8d89-cea248ffbdf1',
  other = '63a561bd-2302-485d-8d89-cea248ffbdf2',
  categoryId = '76c7987d-aadb-4001-922f-26ea52d9f0e8',
  entryId = '8215ed08-99a1-460d-a4da-3e4fa674245f',
  time = '2026-10-26T04:00:00.000Z';
const category = {
  id: categoryId,
  name: '阅读',
  color: '#6C9BCE',
  seedKey: 'reading',
  version: 1,
  createdAt: time,
  updatedAt: time,
};
const entry = {
  id: entryId,
  categoryId,
  title: '已保存',
  startDate: '2026-10-01',
  endDate: null,
  version: 1,
  focusVersion: 1,
  deletedAt: null,
  purgeAfter: null,
  createdAt: time,
  updatedAt: time,
};
function snapshot(version = '10', id = userId): SnapshotDto {
  return {
    schemaVersion: 1,
    userId: id,
    dataVersion: version,
    timeZone: 'Asia/Shanghai',
    businessToday: '2026-10-26',
    complete: true,
    categories: [category],
    entries: [entry],
    trashEntries: [],
    focusDays: [],
  };
}
function envelope(value = snapshot()): SnapshotEnvelope {
  return {
    environment: 'test',
    localSchemaVersion: 1,
    scope: 'account',
    userId: value.userId,
    complete: true,
    savedAt: time,
    serverTime: time,
    etag: 'old',
    payload: value,
  };
}
function deferred<T>() {
  let resolve: (v: T) => void = () => {
    throw new Error('not ready');
  };
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
function response(value = snapshot()) {
  return {
    status: 200,
    data: value,
    headers: { etag: 'new' },
    serverTime: time,
  };
}
function observe(value: SnapshotDto | null): SnapshotDto | null {
  return value;
}
describe('complete snapshots, acknowledged writes and authenticated spaces', () => {
  it('compares decimal versions beyond safe integers and validates UUID/reference/partition integrity', () => {
    expect(
      compareDataVersions('999999999999999999', '1000000000000000000'),
    ).toBe(-1);
    const value = snapshot();
    expect(
      snapshotDtoSchema.safeParse({ ...value, entries: [entry, entry] })
        .success,
    ).toBe(false);
    expect(
      snapshotDtoSchema.safeParse({
        ...value,
        entries: [],
        trashEntries: [entry],
      }).success,
    ).toBe(false);
    expect(
      snapshotDtoSchema.safeParse({
        ...value,
        focusDays: [
          { entryId: other, date: '2026-10-01', focused: true, version: 1 },
        ],
      }).success,
    ).toBe(false);
  });
  it('keeps a V12 write visible while a delayed V11 GET is rejected, without persisting a fabricated complete V12', async () => {
    let visible: SnapshotDto | null = null;
    const delayed = deferred<ReturnType<typeof response>>(),
      write = vi.fn(async (_v: SnapshotEnvelope) => {
        void _v;
      }),
      fetch = vi
        .fn()
        .mockResolvedValueOnce(response())
        .mockImplementationOnce(() => delayed.promise);
    const c = new SnapshotCoordinator(
      'test',
      { read: async () => null, write },
      fetch,
      (v) => (visible = v),
      () => {},
      () => 0,
    );
    c.reset(userId);
    await c.refresh();
    const reading = c.refresh();
    c.written(
      { entry: { ...entry, title: '我已确认', version: 3 }, focusDays: [] },
      '12',
      time,
    );
    expect(observe(visible)?.entries[0]?.title).toBe('我已确认');
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0].payload.dataVersion).toBe('10');
    c.written(
      { entry: { ...entry, title: '迟到回执', version: 2 }, focusDays: [] },
      '11',
      time,
    );
    delayed.resolve(response(snapshot('11')));
    await reading;
    expect(observe(visible)?.entries[0]?.title).toBe('我已确认');
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('does not accept a late cache after GET, and uses a fresh server baseline after relogin', async () => {
    let visible: SnapshotDto | null = null;
    const cache = deferred<SnapshotEnvelope | null>();
    const c = new SnapshotCoordinator(
      'test',
      { read: () => cache.promise, write: async () => {} },
      async () => response(snapshot('2')),
      (v) => (visible = v),
      () => {},
      () => 0,
    );
    c.reset(userId);
    const loading = c.cache();
    await c.refresh();
    cache.resolve(envelope(snapshot('999999999999999999')));
    await loading;
    expect(observe(visible)?.dataVersion).toBe('2');
    c.reset(userId);
    await c.cache();
    expect(observe(visible)?.dataVersion).toBe('999999999999999999');
    await c.refresh();
    expect(observe(visible)?.dataVersion).toBe('2');
  });
  it('discards old account GET and old local async completions after a space reset', async () => {
    let visible: SnapshotDto | null = null;
    const pending = deferred<ReturnType<typeof response>>();
    const c = new SnapshotCoordinator(
      'test',
      { read: async () => null, write: async () => {} },
      () => pending.promise,
      (v) => (visible = v),
      () => {},
      () => 0,
    );
    c.reset(userId);
    const reading = c.refresh();
    c.reset(other);
    pending.resolve(response());
    await reading;
    expect(visible).toBeNull();
  });
  it('retries bodyless 304 without usable data and reports damaged cache without overwriting it', async () => {
    const failure = vi.fn(),
      write = vi.fn(async () => {}),
      fetch = vi
        .fn()
        .mockResolvedValueOnce({ status: 304, data: undefined, headers: {} })
        .mockResolvedValueOnce(response());
    const c = new SnapshotCoordinator(
      'test',
      {
        read: async () =>
          ({ ...envelope(), complete: false }) as unknown as SnapshotEnvelope,
        write,
      },
      fetch,
      () => {},
      failure,
      () => 0,
    );
    c.reset(userId);
    await c.cache();
    expect(failure).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    await c.refresh();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toBeUndefined();
    expect(fetch.mock.calls[1]?.[0]).toBeUndefined();
  });
  it('calibrates old cache with current /me time, advances midnight, resets clock and keeps successful GET on storage rejection', async () => {
    let visible: SnapshotDto | null = null,
      tick = 0;
    const failure = vi.fn();
    const cached = snapshot();
    cached.businessToday = '2026-10-24';
    const c = new SnapshotCoordinator(
      'test',
      {
        read: async () => envelope(cached),
        write: async () => {
          throw new Error('quota');
        },
      },
      async () => response(),
      (v) => (visible = v),
      failure,
      () => tick,
    );
    c.reset(userId);
    c.setServerTime('2026-10-26T15:59:59.000Z');
    await c.cache();
    expect(observe(visible)?.businessToday).toBe('2026-10-26');
    tick = 2000;
    c.tick();
    expect(observe(visible)?.businessToday).toBe('2026-10-27');
    c.reset(userId);
    await c.cache();
    expect(observe(visible)?.businessToday).toBe('2026-10-24');
    await c.refresh();
    expect(failure).toHaveBeenCalledOnce();
    expect(observe(visible)?.entries).toHaveLength(1);
  });
});

it('keeps bulk-write reconciliation pending through later individual updates until a complete GET', async () => {
  const c = new SnapshotCoordinator(
    'test',
    { read: async () => null, write: async () => {} },
    vi
      .fn()
      .mockResolvedValueOnce(response(snapshot('12')))
      .mockResolvedValueOnce(response(snapshot('12')))
      .mockResolvedValue(response(snapshot('14'))),
    () => {},
    () => {},
    () => 0,
  );
  c.reset(userId);
  await c.refresh();
  expect(c.requiresFullRefresh()).toBe(false);
  c.written({ categories: [category] }, '13', time);
  expect(c.requiresFullRefresh()).toBe(true);
  c.written({ entry: { ...entry, version: 2 }, focusDays: [] }, '14', time);
  expect(c.requiresFullRefresh()).toBe(true);
  // An older read cannot satisfy the acknowledged bulk write.
  await c.refresh();
  expect(c.requiresFullRefresh()).toBe(true);
  await c.refresh();
  expect(c.requiresFullRefresh()).toBe(false);
  c.reset(userId);
  expect(c.requiresFullRefresh()).toBe(false);
});
