import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../src/api';
import { useWorkspace } from '../src/workspace';
import { localRepository } from '../src/adapters/local-repository';
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test');
});
afterEach(() => {
  useWorkspace().lifecycle(false);
  api.invalidate();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('restores pending with GET me only, never mounts private cache, preserves the explicit scan confirmation route, then opens deletion for ordinary business routes', async () => {
  const userId = randomUUID(),
    calls: string[] = [],
    navigate = vi.fn((input: { complete?: () => void }) => input.complete?.()),
    repository = localRepository,
    cache = vi.spyOn(repository, 'read').mockResolvedValue(null);
  let route = 'pages/scan/confirm';
  vi.stubGlobal('getCurrentPages', () => [{ route }]);
  vi.stubGlobal('uni', {
    getStorageSync: (key: string) =>
      key.endsWith(':auth:signed-token:v1')
        ? 'signed-fixture-token'
        : undefined,
    setStorageSync: vi.fn(),
    removeStorageSync: vi.fn(),
    navigateTo: navigate,
    request: (options: {
      url: string;
      method: string;
      success: (result: unknown) => void;
    }) => {
      calls.push(options.method + ' ' + options.url);
      expect(options.url.endsWith('/me')).toBe(true);
      options.success({
        statusCode: 200,
        header: {},
        data: {
          data: {
            locale: 'zh-CN',
            id: userId,
            displayName: '待注销微信',
            profileVersion: 1,
            email: null,
            emailVerified: false,
            passwordEnabled: false,
            wechatBound: true,
            status: 'pending_deletion',
            deletionDueAt: new Date(Date.now() + 7 * 86400000).toISOString(),
            timeZone: 'Asia/Shanghai',
          },
          meta: {
            requestId: 'pending-mini',
            serverTime: new Date().toISOString(),
          },
        },
      });
    },
  });
  await useWorkspace().ensure();
  expect(useWorkspace().mode.value).toBe('account');
  expect(useWorkspace().snapshot.value).toBeNull();
  expect(cache).not.toHaveBeenCalled();
  expect(calls).toHaveLength(1);
  expect(navigate).not.toHaveBeenCalled();
  route = 'pages/day/index';
  await useWorkspace().ensure();
  expect(navigate).toHaveBeenCalledWith(
    expect.objectContaining({ url: '/pages/account/deletion' }),
  );
});
