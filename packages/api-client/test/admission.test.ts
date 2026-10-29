import { fallbackText } from '@dayline/locales';
import { describe, it, expect, vi } from 'vitest';
import { AdmissionCoordinator } from '../src/admission-coordinator.js';
import { ApiClient } from '../src/index.js';
import type { TransportRequest, TransportResponse } from '../src/index.js';
import { createGuestPackage, mutateGuest } from '@dayline/contracts';
import type {
  AdmissionOperation,
  GuestPackage,
  ImportJobDto,
} from '@dayline/contracts';
const user = '63a561bd-2302-485d-8d89-cea248ffbdf1',
  id = '8215ed08-99a1-460d-a4da-3e4fa674245f',
  category = '76c7987d-aadb-4001-922f-26ea52d9f0e8',
  time = '2026-10-26T04:00:00.000Z';
function source() {
  let counter = 10;
  const base = createGuestPackage(
    () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`,
    time,
  );
  const first = base.categories[0];
  if (!first) throw new Error('category');
  first.id = category;
  base.categories = base.categories.slice(0, 1);
  return mutateGuest(
    base,
    {
      kind: 'create',
      input: {
        id,
        categoryId: category,
        title: '冻结原输入',
        startDate: '2026-10-01',
        endDate: null,
      },
    },
    time,
  );
}
function plan(
  operation: AdmissionOperation,
  status: ImportJobDto['status'] = 'preview',
): ImportJobDto {
  return {
    id,
    clientOperationId: operation.clientOperationId,
    kind: 'guest',
    status,
    disposition: status === 'committed' ? 'committed' : 'preview_required',
    inputDigest: 'digest',
    planDigest: 'plan',
    planRevision: 1,
    baseDataVersion: '1',
    expiresAt: time,
    canCommit: status === 'preview',
    sourceSummary: { entries: 1, categories: 1, focusDays: 0 },
    targetSummary: { entries: 1, categories: 6, focusDays: 0 },
    categoryMappings: [],
    rows: [],
    result:
      status === 'committed'
        ? {
            created: 1,
            skipped: 0,
            dataVersion: '2',
            mappings: [],
            committedAt: time,
          }
        : null,
  };
}
function frozen(value = source()): AdmissionOperation {
  return {
    environment: 'test',
    userId: user,
    clientOperationId: id,
    package: value,
    jobId: null,
    status: 'pending',
    result: null,
  };
}
function fixture(
  old: AdmissionOperation[] = [],
  live: GuestPackage = source(),
) {
  const operations = new Map(old.map((o) => [o.clientOperationId, o]));
  const transport = vi.fn(
    async (request: TransportRequest): Promise<TransportResponse> => {
      const operation =
        [...operations.values()].find(
          (o) =>
            request.path.endsWith(o.clientOperationId) ||
            request.path.endsWith(o.jobId ?? 'none'),
        ) ?? [...operations.values()].at(-1);
      if (!operation) throw new Error('no operation');
      return {
        status: 200,
        headers: {},
        body: {
          data: plan(operation),
          meta: { requestId: 'test', serverTime: time },
        },
      };
    },
  );
  const api = new ApiClient(transport);
  api.setAccount(user);
  let counter = 1;
  const observed: {
    state:
      | Parameters<ConstructorParameters<typeof AdmissionCoordinator>[5]>[0]
      | null;
  } = { state: null };
  const repository = {
    operations: async () => [...operations.values()],
    putOperation: vi.fn(async (o: AdmissionOperation) => {
      operations.set(o.clientOperationId, structuredClone(o));
    }),
  };
  const coordinator = new AdmissionCoordinator(
    api,
    'test',
    repository,
    async () => live,
    async () =>
      `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`,
    (state) => (observed.state = state),
  );
  return { api, coordinator, observed, transport, operations, repository };
}
describe('explicit admission recovery without background upload', () => {
  it('recovers an older frozen pending revision before considering newly edited live data', async () => {
    const old = frozen(),
      live = { ...source(), packageRevision: 99 },
      f = fixture([old], live);
    await f.coordinator.begin(true);
    expect(f.transport.mock.calls[0]?.[0].path).toBe(
      `/api/v1/imports/by-operation/${old.clientOperationId}`,
    );
    expect(f.observed.state?.operation?.package.packageRevision).toBe(
      old.package.packageRevision,
    );
    expect(f.transport).toHaveBeenCalledOnce();
  });
  it('retries a missing unacknowledged prepare with the exact immutable original operation/input', async () => {
    const old = frozen(),
      f = fixture([old], { ...source(), packageRevision: 99 });
    f.transport.mockResolvedValueOnce({
      status: 404,
      headers: {},
      body: { error: { code: 'RESOURCE_NOT_FOUND' } },
    });
    await f.coordinator.begin(true);
    expect(f.transport.mock.calls[1]?.[0]).toMatchObject({
      path: '/api/v1/guest-admissions/prepare',
      body: { clientOperationId: old.clientOperationId, package: old.package },
    });
  });
  it('marks expiry separately and only creates a new operation after an explicit restart', async () => {
    const old = { ...frozen(), jobId: id },
      f = fixture([old]);
    f.transport.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: {
        data: plan(old, 'expired'),
        meta: { requestId: 'test', serverTime: time },
      },
    });
    await f.coordinator.begin(true);
    expect(f.observed.state?.operation?.status).toBe('expired');
    expect(f.transport).toHaveBeenCalledOnce();
    await f.coordinator.begin(true, true);
    expect(f.transport.mock.calls[1]?.[0].path).toBe(
      '/api/v1/guest-admissions/prepare',
    );
    expect(f.operations.size).toBe(2);
    expect(f.operations.get(old.clientOperationId)?.package).toEqual(
      old.package,
    );
  });
  it('does not let a local committed marker permanently suppress recovery when its server task is missing', async () => {
    const old: AdmissionOperation = {
        ...frozen(),
        status: 'committed',
        jobId: id,
      },
      f = fixture([old]);
    f.transport.mockResolvedValueOnce({
      status: 404,
      headers: {},
      body: { error: { code: 'RESOURCE_NOT_FOUND' } },
    });
    await f.coordinator.begin(true);
    expect(f.observed.state?.operation?.status).toBe('missing');
    expect(fallbackText(f.observed.state?.error ?? '')).toContain(
      '服务器未找到原任务',
    );
    expect(f.transport).toHaveBeenCalledOnce();
    await f.coordinator.begin(true, true);
    expect(f.operations.size).toBe(2);
  });
  it('never sends prepare when the immutable package could not be made durable', async () => {
    const f = fixture();
    f.repository.putOperation.mockRejectedValueOnce(new Error('quota'));
    await f.coordinator.begin(true);
    expect(f.transport).not.toHaveBeenCalled();
    expect(fallbackText(f.observed.state?.error ?? '')).toContain('保留');
  });
  it('ignores old account results after identity invalidation', async () => {
    const f = fixture();
    f.transport.mockImplementationOnce(async () => {
      f.api.invalidate();
      return {
        status: 200,
        headers: {},
        body: {
          data: plan(frozen()),
          meta: { requestId: 'test', serverTime: time },
        },
      };
    });
    await f.coordinator.begin(true);
    expect(f.observed.state?.job).toBeNull();
    expect(f.observed.state?.operation).toBeNull();
  });
});
