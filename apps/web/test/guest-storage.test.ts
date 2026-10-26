import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGuestPackage, mutateGuest } from '@dayline/contracts';
import { WebGuestRepository } from '../src/adapters/guest-repository';
const databases: WebGuestRepository[] = [];
const now = '2026-10-26T04:00:00.000Z';
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((repo) => repo.database.delete()));
});
function repository(name = randomUUID()) {
  const repo = new WebGuestRepository(name);
  databases.push(repo);
  return repo;
}
describe('IndexedDB durable guest commit', () => {
  it('atomically compares revision across two database connections and retains the winner', async () => {
    const name = randomUUID(),
      first = repository(name),
      second = repository(name),
      data = createGuestPackage(randomUUID, now);
    await first.commit(data, null);
    const categoryId = data.categories[0]?.id ?? '';
    const a = mutateGuest(
        data,
        {
          kind: 'create',
          input: {
            id: randomUUID(),
            title: 'A',
            categoryId,
            startDate: '0001-01-01',
            endDate: null,
          },
        },
        now,
      ),
      b = mutateGuest(
        data,
        {
          kind: 'create',
          input: {
            id: randomUUID(),
            title: 'B',
            categoryId,
            startDate: '9999-12-31',
            endDate: null,
          },
        },
        now,
      );
    const results = await Promise.allSettled([
      first.commit(a, 1),
      second.commit(b, 1),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await first.read())?.entries).toHaveLength(1);
    second.database.close();
  });
  it('rolls back a transaction whose write succeeds but aborts before transaction complete', async () => {
    const repo = repository(),
      data = createGuestPackage(randomUUID, now);
    await repo.commit(data, null);
    const table = repo.database.table('packages'),
      original = table.put.bind(table);
    vi.spyOn(table, 'put').mockImplementation(
      (...args: Parameters<typeof table.put>) =>
        original(...args).then((value) => {
          throw new Error(`abort after ${typeof value}`);
        }),
    );
    await expect(
      repo.commit({ ...data, packageRevision: 2 }, 1),
    ).rejects.toMatchObject({ code: 'LOCAL_WRITE_FAILED' });
    expect((await repo.read())?.packageRevision).toBe(1);
  });
  it('preserves unsupported or damaged packages and never replaces them with fresh defaults', async () => {
    const repo = repository(),
      raw = { localSchemaVersion: 99, privateData: 'preserve' };
    await repo.database.table('packages').put({ key: 'current', value: raw });
    await expect(repo.read()).rejects.toMatchObject({
      code: 'LOCAL_RECOVERY_REQUIRED',
    });
    await expect(
      repo.commit(createGuestPackage(randomUUID, now), null),
    ).rejects.toMatchObject({ code: 'LOCAL_RECOVERY_REQUIRED' });
    expect(
      (await repo.database.table('packages').get('current')).value,
    ).toEqual(raw);
  });
});
