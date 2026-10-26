import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGuestPackage, mutateGuest } from '@dayline/contracts';
import { createLocalFilePlan, parseImportFile } from '@dayline/contracts/files';
import type { FileOperation } from '@dayline/contracts';
import { WebGuestRepository } from '../src/adapters/guest-repository';
import { WebLocalRepository } from '../src/adapters/local-repository';
const now = '2026-10-26T04:00:00.000Z',
  env = 'files-test';
const repos: WebGuestRepository[] = [];
const accounts: WebLocalRepository[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    [...repos.splice(0), ...accounts.splice(0)].map((r) => r.database.delete()),
  );
});
async function fixture() {
  const repo = new WebGuestRepository(randomUUID(), env);
  repos.push(repo);
  const data = createGuestPackage(randomUUID, now);
  await repo.commit(data, null);
  const text =
    'title,start_date,category_name,category_color\n文件记录,2026-10-01,游戏,#8B80D8';
  const plan = createLocalFilePlan(
    parseImportFile(text, 'csv', now),
    data,
    String(data.packageRevision),
    randomUUID,
    now,
    new Map(),
  );
  const op: FileOperation = {
    environment: env,
    scope: 'guest',
    ownerId: data.guestDatasetId,
    clientOperationId: plan.clientOperationId,
    jobId: plan.id,
    format: 'csv',
    text,
    status: 'pending',
    localPlan: plan,
  };
  await repo.putFileOperation(op);
  return { repo, data, plan, op };
}
describe('durable file operations and atomic guest provenance', () => {
  it('commits package, receipt and durable result together and replays without duplicating', async () => {
    const { repo, data, plan, op } = await fixture();
    const done = await repo.commitFile(op, plan, now);
    expect(done?.status).toBe('committed');
    expect((await repo.read())?.entries).toHaveLength(1);
    expect((await repo.fileMappings(data.guestDatasetId)).size).toBe(4);
    expect((await repo.fileOperation(data.guestDatasetId))?.text).toBe(op.text);
    expect((await repo.commitFile(op, plan, now))?.result).toEqual(
      done?.result,
    );
    expect((await repo.read())?.entries).toHaveLength(1);
  });
  it('rolls back package and result when provenance storage fails after the package put', async () => {
    const { repo, data, plan, op } = await fixture();
    const table = repo.database.table('packages'),
      put = table.put.bind(table);
    vi.spyOn(table, 'put').mockImplementation(
      (...args: Parameters<typeof table.put>) => {
        const value = args[0] as { key: string };
        if (value.key.startsWith('file-receipts:')) throw new Error('quota');
        return put(...args);
      },
    );
    await expect(repo.commitFile(op, plan, now)).rejects.toThrow('quota');
    expect(await repo.read()).toEqual(data);
    expect((await repo.fileOperation(data.guestDatasetId))?.status).toBe(
      'pending',
    );
    expect((await repo.fileMappings(data.guestDatasetId)).size).toBe(0);
  });
  it('rejects frozen revision changes and expiry, leaving the original package and input', async () => {
    const { repo, data, plan, op } = await fixture();
    const next = mutateGuest(
      data,
      {
        kind: 'create',
        input: {
          id: randomUUID(),
          title: '另一标签',
          categoryId: data.categories[0]?.id ?? '',
          startDate: '2026-10-01',
          endDate: null,
        },
      },
      now,
    );
    await repo.commit(next, data.packageRevision);
    await expect(repo.commitFile(op, plan, now)).rejects.toMatchObject({
      code: 'PREVIEW_STALE',
    });
    expect(await repo.read()).toEqual(next);
    expect((await repo.fileOperation(data.guestDatasetId))?.text).toBe(op.text);
  });
  it('validates incoming and stored environment/scope/owner/plan identities, immutable original format and receipts, preserving corrupt values', async () => {
    const { repo, data, op } = await fixture();
    for (const damaged of [
      { ...op, environment: 'other' },
      { ...op, scope: 'account' as const },
      { ...op, ownerId: randomUUID() },
      { ...op, jobId: randomUUID() },
      { ...op, text: op.text + 'changed' },
      { ...op, format: 'json' as const },
    ])
      await expect(repo.putFileOperation(damaged)).rejects.toThrow();
    const table = repo.database.table('packages');
    const damaged = { ...op, environment: 'other' };
    await table.put({ key: 'file:' + data.guestDatasetId, value: damaged });
    await expect(repo.fileOperation(data.guestDatasetId)).rejects.toThrow();
    await expect(
      repo.putFileOperation({
        ...op,
        clientOperationId: randomUUID(),
        localPlan: null,
        jobId: null,
      }),
    ).rejects.toThrow();
    expect((await table.get('file:' + data.guestDatasetId)).value).toEqual(
      damaged,
    );
    await table.put({
      key: 'file-receipts:' + data.guestDatasetId,
      value: {
        environment: 'other',
        ownerId: data.guestDatasetId,
        receipts: [],
      },
    });
    await expect(repo.fileMappings(data.guestDatasetId)).rejects.toThrow();
  });
  it('keeps cloud operation original text scoped to its verified owner and never persists a cloud preview as authorization', async () => {
    const repo = new WebLocalRepository(env);
    accounts.push(repo);
    const op: FileOperation = {
      environment: env,
      scope: 'account',
      ownerId: randomUUID(),
      clientOperationId: randomUUID(),
      jobId: null,
      format: 'csv',
      text: 'immutable',
      status: 'pending',
      localPlan: null,
    };
    await repo.putFileOperation(op);
    await expect(
      repo.putFileOperation({ ...op, text: 'replacement' }),
    ).rejects.toThrow();
    await expect(
      repo.putFileOperation({ ...op, environment: 'other' }),
    ).rejects.toThrow();
    const table = repo.database.table('values'),
      bad = { ...op, ownerId: randomUUID() };
    await table.put({ key: op.ownerId + ':file', value: bad });
    await expect(repo.fileOperation(op.ownerId)).rejects.toThrow();
    await expect(
      repo.putFileOperation({ ...op, clientOperationId: randomUUID() }),
    ).rejects.toThrow();
    expect((await table.get(op.ownerId + ':file')).value).toEqual(bad);
  });
});
