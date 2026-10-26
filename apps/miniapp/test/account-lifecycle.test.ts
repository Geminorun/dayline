import { randomUUID, randomBytes } from 'node:crypto';
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, describe, it, expect, vi } from 'vitest';
const hooks = vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test');
  return {
    show: undefined as undefined | (() => void),
    hide: undefined as undefined | (() => void),
    launch: undefined as undefined | (() => void),
  };
});
vi.mock('@dcloudio/uni-app', () => ({
  onShow: (cb: () => void) => (hooks.show = cb),
  onHide: (cb: () => void) => (hooks.hide = cb),
  onLaunch: (cb: () => void) => (hooks.launch = cb),
}));
import App from '../src/App.vue';
import { useWorkspace } from '../src/workspace';
import { createGuestPackage, guestSnapshot } from '@dayline/contracts';
const userId = '63a561bd-2302-485d-8d89-cea248ffbdf1',
  time = '2026-10-26T04:00:00.000Z';
afterEach(() => {
  useWorkspace().lifecycle(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('miniapp account cold restore and foreground truth', () => {
  it('restores a persisted Bearer with GET only, stays stopped after hide+reconnect, and refreshes on show with a single timer', async () => {
    vi.useFakeTimers();
    const storage = new Map<string, string>(),
      calls: string[] = [];
    let network: ((status: { isConnected: boolean }) => void) | undefined;
    const source = createGuestPackage(randomUUID, time),
      snapshot = { ...guestSnapshot(source, '2026-10-26'), userId };
    vi.stubGlobal('wx', {
      getRandomValues: (options: {
        length: number;
        success: (value: { randomValues: ArrayBuffer }) => void;
      }) =>
        options.success({
          randomValues: Uint8Array.from(randomBytes(options.length)).buffer,
        }),
    });
    vi.stubGlobal('uni', {
      getStorageSync: (key: string) =>
        key.endsWith(':auth:signed-token:v1')
          ? 'signed-test-token'
          : storage.get(key),
      setStorageSync: (key: string, value: string) => storage.set(key, value),
      removeStorageSync: (key: string) => storage.delete(key),
      getStorageInfoSync: () => ({
        keys: [...storage.keys()],
        currentSize: 0,
        limitSize: 10240,
      }),
      onNetworkStatusChange: (cb: typeof network) => (network = cb),
      request: (options: {
        url: string;
        method: string;
        success: (value: unknown) => void;
      }) => {
        calls.push(options.method + ' ' + options.url);
        const data = options.url.endsWith('/me')
          ? {
              id: userId,
              displayName: '原账号',
              profileVersion: 1,
              email: null,
              emailVerified: false,
              passwordEnabled: false,
              wechatBound: true,
              status: 'active',
              deletionDueAt: null,
              timeZone: 'Asia/Shanghai',
            }
          : snapshot;
        options.success({
          statusCode: 200,
          header: { etag: 'test' },
          data: { data, meta: { requestId: 'test', serverTime: time } },
        });
      },
    });
    const wrapper = mount(App);
    hooks.launch?.();
    await useWorkspace().ensure();
    expect(useWorkspace().mode.value).toBe('account');
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.startsWith('GET '))).toBe(true);
    hooks.hide?.();
    network?.({ isConnected: true });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(calls).toHaveLength(2);
    hooks.show?.();
    await flushPromises();
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(30_000);
    await flushPromises();
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.startsWith('GET '))).toBe(true);
    hooks.hide?.();
    wrapper.unmount();
  });
});
