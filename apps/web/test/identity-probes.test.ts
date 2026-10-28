import { afterEach, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { randomUUID } from 'node:crypto';
import { useAccount } from '../src/account';
import { useWorkspace } from '../src/records/workspace';
import { api } from '../src/api';
const user = {
  id: randomUUID(),
  displayName: '当前身份',
  profileVersion: 1,
  email: 'current@example.com',
  emailVerified: true,
  passwordEnabled: true,
  wechatBound: false,
  status: 'active',
  deletionDueAt: null,
  timeZone: 'Asia/Shanghai',
};
const meta = {
  requestId: 'identity-probes',
  serverTime: '2026-10-26T20:00:00.000Z',
};
afterEach(() => {
  useAccount().clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('resolves an anonymous session normally without requesting protected /me or invalidating a guest generation', async () => {
  useAccount().clear();
  const generation = api.getGeneration();
  const fetch = vi.fn(async (path: RequestInfo | URL) => {
    expect(path).toBe('/api/v1/auth/session');
    return Response.json({ data: { authenticated: false }, meta });
  });
  vi.stubGlobal('fetch', fetch);
  await expect(useAccount().refresh()).rejects.toMatchObject({
    code: 'UNAUTHENTICATED',
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(api.getGeneration()).toBe(generation);
});
it('drains an existing /me before an identity write and prevents new focus probes until the operation result is known', async () => {
  let finishProbe: ((r: Response) => void) | undefined,
    finishWrite: (() => void) | undefined;
  let meCalls = 0;
  const fetch = vi.fn(async (path: RequestInfo | URL) => {
    expect(path).toBe('/api/v1/me');
    meCalls++;
    if (meCalls === 1) return Response.json({ data: user, meta });
    return new Promise<Response>((resolve) => {
      finishProbe = resolve;
    });
  });
  vi.stubGlobal('fetch', fetch);
  const account = useAccount(),
    workspace = useWorkspace();
  await account.refresh(true);
  const existing = account.refresh();
  let entered = false;
  const operation = workspace.identityWrite(async () => {
    entered = true;
    await new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    return 'committed';
  });
  await flushPromises();
  expect(entered).toBe(false);
  await workspace.reprobe();
  expect(meCalls).toBe(2);
  finishProbe?.(Response.json({ data: user, meta }));
  await existing;
  await flushPromises();
  expect(entered).toBe(true);
  await expect(account.refresh()).rejects.toMatchObject({
    code: 'OPERATION_BUSY',
  });
  await workspace.reprobe();
  workspace.lifecycle(true);
  expect(meCalls).toBe(2);
  finishWrite?.();
  expect(await operation).toBe('committed');
  workspace.lifecycle(false);
});
