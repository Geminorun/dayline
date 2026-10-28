import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { createGuestPackage, guestSnapshot } from '@dayline/contracts';
import { localRepository } from '../src/adapters/local-repository';
import { useAccount } from '../src/account';
import { useWorkspace } from '../src/records/workspace';
const now = '2026-10-28T03:00:00.000Z';
afterEach(() => {
  useWorkspace().lifecycle(false);
  useAccount().clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('coalesces foreground reads, honors snapshot Retry-After and retains the last complete records', async () => {
  vi.spyOn(localRepository, 'read').mockResolvedValue(null);
  vi.spyOn(localRepository, 'write').mockResolvedValue(undefined);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const id = crypto.randomUUID(),
    data = createGuestPackage(() => crypto.randomUUID(), now);
  const snapshot = { ...guestSnapshot(data, '2026-10-28'), userId: id };
  const profile = {
    id,
    displayName: '读取测试',
    profileVersion: 1,
    email: null,
    emailVerified: false,
    passwordEnabled: false,
    wechatBound: true,
    status: 'active',
    deletionDueAt: null,
    timeZone: 'Asia/Shanghai',
  };
  let reads = 0;
  const fetch = vi.fn(async (path: RequestInfo | URL) => {
    const meta = { requestId: 'budget', serverTime: now };
    if (path === '/api/v1/auth/session')
      return Response.json({ data: { authenticated: true }, meta });
    if (path === '/api/v1/me') return Response.json({ data: profile, meta });
    if (path !== '/api/v1/snapshot') throw new Error('Unexpected path');
    reads++;
    if (reads === 2)
      return Response.json(
        { error: { code: 'RATE_LIMITED' } },
        { status: 429, headers: { 'Retry-After': '7' } },
      );
    return Response.json({ data: snapshot, meta });
  });
  vi.stubGlobal('fetch', fetch);
  const workspace = useWorkspace();
  await workspace.switchMode('account', false);
  expect(reads).toBe(1);
  workspace.lifecycle(true);
  await workspace.reprobe();
  expect(reads).toBe(1);
  await workspace.load();
  expect(reads).toBe(2);
  expect(workspace.retrySeconds.value).toBe(7);
  expect(workspace.snapshot.value?.userId).toBe(id);
  for (let i = 0; i < 4; i++) {
    workspace.lifecycle(true);
    await workspace.load();
  }
  expect(reads).toBe(2);
  await vi.advanceTimersByTimeAsync(3000);
  expect(workspace.retrySeconds.value).toBe(4);
  expect(workspace.error.value).toContain('4 秒');
  await vi.advanceTimersByTimeAsync(4000);
  expect(workspace.retrySeconds.value).toBe(0);
  await workspace.load();
  expect(reads).toBe(3);
});
