import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { WebLocalRepository } from '../src/adapters/local-repository';
import {
  createGuestPackage,
  guestSnapshot,
  draftSchema,
} from '@dayline/contracts';
import type {
  EntryDraft,
  AdmissionOperation,
  SnapshotEnvelope,
} from '@dayline/contracts';
const user = '63a561bd-2302-485d-8d89-cea248ffbdf1',
  other = '63a561bd-2302-485d-8d89-cea248ffbdf2',
  time = '2026-10-26T04:00:00.000Z';
const source = () => createGuestPackage(randomUUID, time);
function draft(environment: string): EntryDraft {
  return {
    environment,
    userId: user,
    format: 'dayline-draft',
    localSchemaVersion: 1,
    draftId: randomUUID(),
    entryId: randomUUID(),
    baseEntryVersion: null,
    baseEntry: null,
    inputRevision: 1,
    persistedRevision: 1,
    savedLocallyAt: time,
    fields: {
      title: '未完成输入',
      startDate: '尚未填完',
      endDate: null,
      categoryId: '',
    },
  };
}
describe('account storage scope and draft provenance', () => {
  it('rejects an otherwise valid B draft under an A key for listing, reading, overwriting and deletion, preserving raw contents', async () => {
    const environment = randomUUID(),
      repo = new WebLocalRepository(environment),
      original = { ...draft(environment), userId: other },
      key = `${user}:draft:${original.draftId}`;
    try {
      await repo.database.table('values').put({ key, value: original });
      await expect(repo.drafts(user)).rejects.toThrow();
      await expect(repo.draft(user, original.draftId)).rejects.toThrow();
      await expect(repo.removeDraft(user, original.draftId)).rejects.toThrow();
      await expect(
        repo.putDraft({ ...original, userId: user }),
      ).rejects.toThrow();
      expect((await repo.database.table('values').get(key)).value).toEqual(
        original,
      );
    } finally {
      await repo.database.delete();
    }
  });
  it('checks environment, payload owner, and operation IDs before mounting or changing stored snapshots/operations', async () => {
    const environment = randomUUID(),
      repo = new WebLocalRepository(environment),
      guest = source(),
      payload = { ...guestSnapshot(guest, '2026-10-26'), userId: user };
    const envelope: SnapshotEnvelope = {
      environment: 'wrong',
      localSchemaVersion: 1,
      scope: 'account',
      userId: user,
      complete: true,
      savedAt: time,
      serverTime: time,
      etag: null,
      payload,
    };
    const operation: AdmissionOperation = {
      environment,
      userId: other,
      clientOperationId: randomUUID(),
      package: guest,
      jobId: null,
      status: 'pending',
      result: null,
    };
    try {
      await repo.database
        .table('values')
        .put({ key: `${user}:snapshot`, value: envelope });
      await expect(repo.read(user)).rejects.toThrow();
      await expect(repo.write({ ...envelope, environment })).rejects.toThrow();
      await repo.database.table('values').put({
        key: `${user}:operation:${operation.clientOperationId}`,
        value: operation,
      });
      await expect(repo.operations(user)).rejects.toThrow();
      await expect(
        repo.putOperation({ ...operation, userId: user }),
      ).rejects.toThrow();
    } finally {
      await repo.database.delete();
    }
  });
  it('keeps incomplete input recoverable while rejecting mismatched entry/base version provenance', () => {
    const value = draft('test');
    expect(draftSchema.safeParse(value).success).toBe(true);
    expect(
      draftSchema.safeParse({ ...value, baseEntryVersion: 1 }).success,
    ).toBe(false);
  });
});
