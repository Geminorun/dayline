import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { MiniLocalRepository } from '../src/adapters/local-repository';
import { createGuestPackage, guestSnapshot } from '@dayline/contracts';
import type { SnapshotEnvelope } from '@dayline/contracts';
import type { KeyStorage } from '../src/adapters/guest-repository';
const user = '63a561bd-2302-485d-8d89-cea248ffbdf1',
  other = '63a561bd-2302-485d-8d89-cea248ffbdf2',
  time = '2026-10-26T04:00:00.000Z';
function memory() {
  const data = new Map<string, string>();
  let fail = false;
  const storage: KeyStorage = {
    get: (k) => data.get(k),
    set: (k, v) => {
      if (fail && k.endsWith(':manifest')) throw new Error('interrupted');
      data.set(k, v);
    },
    remove: (k) => {
      data.delete(k);
    },
    keys: () => [...data.keys()],
    capacityBytes: () => 100 * 1024 * 1024,
    usedBytes: () => 0,
  };
  return {
    data,
    storage,
    setFailure: () => {
      fail = true;
    },
  };
}
function envelope(userId = user): SnapshotEnvelope {
  const guest = createGuestPackage(randomUUID, time);
  return {
    environment: 'test',
    localSchemaVersion: 1,
    scope: 'account',
    userId,
    complete: true,
    savedAt: time,
    serverTime: time,
    etag: null,
    payload: { ...guestSnapshot(guest, '2026-10-26'), userId },
  };
}
describe('miniapp immutable account cache manifests', () => {
  it('preserves the previous complete generation when the final manifest fails, and rejects B payload moved into A namespace', async () => {
    const m = memory(),
      repo = new MiniLocalRepository(
        m.storage,
        async () => randomUUID(),
        'test',
      ),
      first = envelope();
    await repo.write(first);
    m.setFailure();
    await expect(
      repo.write({ ...first, payload: { ...first.payload, dataVersion: '2' } }),
    ).rejects.toThrow();
    expect((await repo.read(user))?.payload.dataVersion).toBe('1');
    const moved = memory(),
      otherRepo = new MiniLocalRepository(
        moved.storage,
        async () => randomUUID(),
        'test',
      );
    await otherRepo.write(envelope(other));
    for (const [key, value] of [...moved.data])
      moved.data.set(key.replace(other, user), value);
    await expect(otherRepo.read(user)).rejects.toThrow();
    await expect(otherRepo.write(envelope(user))).rejects.toThrow();
  });
  it('rejects wrong-environment writes without generating a valid new manifest', async () => {
    const m = memory(),
      repo = new MiniLocalRepository(
        m.storage,
        async () => randomUUID(),
        'test',
      );
    await expect(
      repo.write({ ...envelope(), environment: 'wrong' }),
    ).rejects.toThrow();
    expect(m.data.size).toBe(0);
  });
});
