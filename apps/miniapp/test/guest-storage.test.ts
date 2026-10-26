import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createGuestPackage,
  mutateGuest,
  readGuestPackage,
} from '@dayline/contracts';
import {
  MiniGuestRepository,
  CHUNK_CHARACTERS,
} from '../src/adapters/guest-repository';
import type { KeyStorage } from '../src/adapters/guest-repository';
const now = '2026-10-26T04:00:00.000Z';
class Storage implements KeyStorage {
  data = new Map<string, string>();
  limit = 10 * 1024 * 1024;
  failure: ((key: string) => boolean) | null = null;
  get(key: string) {
    return this.data.get(key);
  }
  set(key: string, value: string) {
    if (this.failure?.(key)) throw new Error('Interrupted write');
    if (value.length * 3 > 1024 * 1024) throw new Error('Single key limit');
    this.data.set(key, value);
  }
  remove(key: string) {
    this.data.delete(key);
  }
  keys() {
    return [...this.data.keys()];
  }
  capacityBytes() {
    return this.limit;
  }
  usedBytes() {
    return [...this.data.values()].reduce(
      (sum, value) => sum + value.length * 3,
      0,
    );
  }
}
describe('miniapp immutable sharded generations', () => {
  it('writes and recovers real 1000-entry / 10000-focus packages across bounded keys', async () => {
    const storage = new Storage(),
      repo = new MiniGuestRepository(storage, randomUUID, 'test:guest'),
      data = createGuestPackage(randomUUID, now),
      categoryId = data.categories[0]?.id ?? '';
    const entries = Array.from({ length: 1000 }, () => ({
      id: randomUUID(),
      categoryId,
      title: '经历😀'.repeat(15),
      startDate: '2026-10-01',
      endDate: null,
      version: 1,
      focusVersion: 11,
      deletedAt: null,
      purgeAfter: null,
      createdAt: now,
      updatedAt: now,
    }));
    const focusDays = entries.flatMap((entry) =>
      Array.from({ length: 10 }, (_, i) => ({
        entryId: entry.id,
        date: `2026-10-${String(i + 1).padStart(2, '0')}`,
        focused: true,
        version: 1,
      })),
    );
    const large = readGuestPackage({ ...data, entries, focusDays });
    expect(JSON.stringify(large).length).toBeGreaterThan(CHUNK_CHARACTERS * 5);
    await repo.commit(large, null);
    const restored = await new MiniGuestRepository(
      storage,
      randomUUID,
      'test:guest',
    ).read();
    expect(restored?.entries).toHaveLength(1000);
    expect(restored?.focusDays).toHaveLength(10000);
    const first = large.entries[0];
    if (!first) throw new Error('Missing fixture');
    const updated = mutateGuest(
      large,
      {
        kind: 'update',
        id: first.id,
        input: { expectedVersion: 1, title: '大包原子修改' },
      },
      now,
    );
    await repo.commit(updated, 1);
    expect((await repo.read())?.entries[0]).toMatchObject({
      title: '大包原子修改',
      version: 2,
    });
    expect((await repo.read())?.focusDays).toHaveLength(10000);

    expect(
      storage.keys().filter((k) => k.includes(':chunk:')).length,
    ).toBeGreaterThan(5);
    expect(
      Math.max(...[...storage.data.values()].map((value) => value.length * 3)),
    ).toBeLessThan(1024 * 1024);
  });
  it('retains a complete prior generation on chunk or final-manifest failure and never touches credentials / other environments', async () => {
    for (const at of ['chunk', 'manifest']) {
      const storage = new Storage();
      storage.data.set('auth:token', 'secret');
      storage.data.set('production:guest:chunk:other:0', 'unrelated');
      const repo = new MiniGuestRepository(storage, randomUUID, 'test:guest'),
        data = createGuestPackage(randomUUID, now);
      await repo.commit(data, null);
      const next = mutateGuest(
        data,
        {
          kind: 'create',
          input: {
            id: randomUUID(),
            categoryId: data.categories[0]?.id,
            title: '保存中断',
            startDate: '2026-10-01',
            endDate: null,
          },
        },
        now,
      );
      storage.failure = (key) => key.includes('test:guest:' + at);
      await expect(repo.commit(next, 1)).rejects.toMatchObject({
        code: 'LOCAL_WRITE_FAILED',
      });
      expect(await repo.read()).toEqual(data);
      expect(storage.data.get('auth:token')).toBe('secret');
      expect(storage.data.get('production:guest:chunk:other:0')).toBe(
        'unrelated',
      );
    }
  });
  it('refuses insufficient total capacity before commit and can retry without changing original revision', async () => {
    const storage = new Storage(),
      repo = new MiniGuestRepository(storage, randomUUID, 'test:guest'),
      data = createGuestPackage(randomUUID, now);
    await repo.commit(data, null);
    storage.limit = storage.usedBytes() + 100;
    await expect(
      repo.commit({ ...data, packageRevision: 2 }, 1),
    ).rejects.toMatchObject({ code: 'LOCAL_CAPACITY' });
    expect((await repo.read())?.packageRevision).toBe(1);
    storage.limit = 10 * 1024 * 1024;
    await repo.commit({ ...data, packageRevision: 2 }, 1);
    expect((await repo.read())?.packageRevision).toBe(2);
  });
  it('detects orphaned fragments, unsupported manifests, corrupt chunks and stale competing writers without empty replacement', async () => {
    const storage = new Storage(),
      repo = new MiniGuestRepository(storage, randomUUID, 'test:guest'),
      data = createGuestPackage(randomUUID, now);
    storage.data.set('test:guest:chunk:orphan:0', 'private');
    await expect(repo.read()).rejects.toMatchObject({
      code: 'LOCAL_RECOVERY_REQUIRED',
    });
    expect(storage.data.size).toBe(1);
    storage.data.clear();
    storage.data.set('test:guest:manifest', '{"schema":99}');
    await expect(repo.read()).rejects.toMatchObject({
      code: 'LOCAL_RECOVERY_REQUIRED',
    });
    storage.data.clear();
    await repo.commit(data, null);
    const concurrent = await Promise.allSettled([
      repo.commit({ ...data, packageRevision: 2 }, 1),
      new MiniGuestRepository(storage, randomUUID, 'test:guest').commit(
        { ...data, packageRevision: 2 },
        1,
      ),
    ]);
    expect(concurrent.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const key = storage.keys().find((k) => k.includes(':chunk:'));
    if (!key) throw new Error('Missing chunk');
    storage.data.set(key, 'broken');
    await expect(repo.read()).rejects.toMatchObject({
      code: 'LOCAL_RECOVERY_REQUIRED',
    });
    expect(storage.data.get(key)).toBe('broken');
  });
});
