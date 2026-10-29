import { afterEach, describe, expect, it, vi } from 'vitest';
import { userDtoSchema } from '@dayline/contracts';
const user = {
  locale: 'zh-CN',
  id: '63a561bd-2302-485d-8d89-cea248ffbdf1',
  displayName: '微信用户',
  profileVersion: 1,
  email: null,
  emailVerified: false,
  passwordEnabled: false,
  wechatBound: true,
  status: 'active',
  deletionDueAt: null,
  timeZone: 'Asia/Shanghai',
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});
describe('uni native request and isolated credential storage', () => {
  it('does no automatic login and uses signed header credentials with expected actor and PATCH override', async () => {
    const requests: UniApp.RequestOptions[] = [];
    const storage = new Map<string, unknown>();
    const login = vi.fn();
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test');
    vi.stubGlobal('uni', {
      login,
      getStorageSync: (key: string) => storage.get(key),
      setStorageSync: (key: string, value: unknown) => storage.set(key, value),
      removeStorageSync: (key: string) => storage.delete(key),
      request(options: UniApp.RequestOptions) {
        requests.push(options);
        options.success?.({
          data: {
            data: user,
            meta: {
              requestId: 'uni-test',
              serverTime: '2026-10-26T04:00:00.000Z',
            },
          },
          statusCode: 200,
          header: { 'Set-Auth-Token': 'signed.session.value' },
          cookies: [],
        });
      },
    });
    const { api, clearCredential } = await import('../src/api');
    expect(login).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
    await api.request('/api/v1/me', { decode: userDtoSchema.parse });
    api.setAccount(user.id);
    await api.request('/api/v1/me', {
      method: 'PATCH',
      account: true,
      body: { displayName: '改名' },
      decode: userDtoSchema.parse,
    });
    expect(requests[1]).toMatchObject({
      url: 'https://api.example.test/api/v1/me',
      method: 'POST',
      header: {
        Authorization: 'Bearer signed.session.value',
        'x-dayline-expected-user': user.id,
        'X-Dayline-Method-Override': 'PATCH',
      },
    });
    expect(storage.size).toBe(1);
    clearCredential();
    expect(storage.size).toBe(0);
  });
  it('does not persist credentials from a malformed account response', async () => {
    const save = vi.fn();
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test');
    vi.stubGlobal('uni', {
      getStorageSync: () => null,
      setStorageSync: save,
      request(options: UniApp.RequestOptions) {
        options.success?.({
          data: {
            data: { id: user.id },
            meta: {
              requestId: 'invalid-dto',
              serverTime: '2026-10-26T04:00:00.000Z',
            },
          },
          statusCode: 200,
          header: { 'set-auth-token': 'must-not-store' },
          cookies: [],
        });
      },
    });
    const { api } = await import('../src/api');
    await expect(
      api.request('/api/v1/me', { decode: userDtoSchema.parse }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(save).not.toHaveBeenCalled();
  });
  it('reports storage failure explicitly and obtains fresh WeChat code only on demand', async () => {
    const login = vi.fn((options: UniApp.LoginOptions) =>
      options.success?.({
        code: 'fresh-one-time-code',
        errMsg: 'login:ok',
        authResult: '',
      }),
    );
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test');
    vi.stubGlobal('uni', {
      login,
      getStorageSync() {
        throw new Error('quota');
      },
      request: vi.fn(),
    });
    const { api, wechatCode } = await import('../src/api');
    expect(login).not.toHaveBeenCalled();
    expect(await wechatCode()).toBe('fresh-one-time-code');
    await expect(api.request('/api/v1/me')).rejects.toMatchObject({
      code: 'STORAGE_ERROR',
    });
  });
});

it('a failed purpose-specific reauth does not remove the current signed credential or actor', async () => {
  const storage = new Map<string, unknown>();
  let status = 200;
  vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test');
  vi.stubGlobal('uni', {
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    removeStorageSync: (key: string) => storage.delete(key),
    request(options: UniApp.RequestOptions) {
      options.success?.({
        data:
          status === 200
            ? {
                data: user,
                meta: {
                  requestId: 'proof',
                  serverTime: '2026-10-26T04:00:00.000Z',
                },
              }
            : { error: { code: 'REAUTH_REQUIRED' } },
        statusCode: status,
        header:
          status === 200
            ? { 'Set-Auth-Token': 'current-signed-credential' }
            : {},
        cookies: [],
      });
    },
  });
  const { api } = await import('../src/api');
  await api.request('/api/v1/me', { decode: userDtoSchema.parse });
  api.setAccount(user.id);
  const before = [...storage.entries()],
    generation = api.getGeneration();
  status = 403;
  await expect(
    api.request('/api/v1/auth/reauth', {
      method: 'POST',
      account: true,
      body: { password: 'wrong' },
    }),
  ).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });
  expect(api.getAccount()).toBe(user.id);
  expect(api.getGeneration()).toBe(generation);
  expect([...storage.entries()]).toEqual(before);
});
