import { ref } from 'vue';
import { ApiClient, ClientError } from '@dayline/api-client';
import type { Transport } from '@dayline/api-client';
export const credentialWarning = ref('');
const baseUrl = import.meta.env.VITE_API_BASE_URL ?? '';
const tokenKey = `dayline:${import.meta.env.MODE}:${encodeURIComponent(baseUrl)}:auth:signed-token:v1`;
let token: string | null = null;
let tokenLoaded = false;
function loadToken() {
  if (!tokenLoaded) {
    try {
      const saved: unknown = uni.getStorageSync(tokenKey);
      token = typeof saved === 'string' && saved ? saved : null;
      tokenLoaded = true;
    } catch {
      throw new ClientError(
        'STORAGE_ERROR',
        '无法读取登录凭据，请检查本机存储。',
      );
    }
  }
  return token;
}
export function hasCredential() {
  return loadToken() !== null;
}
export function clearCredential() {
  token = null;
  tokenLoaded = true;
  try {
    uni.removeStorageSync(tokenKey);
  } catch {
    throw new ClientError(
      'STORAGE_ERROR',
      '登录凭据清理失败，请检查本机存储。',
    );
  }
}
export const bearerTransport: Transport = (request) =>
  new Promise((resolve, reject) => {
    if (!/^https:\/\//.test(baseUrl) && !import.meta.env.DEV) {
      reject(new ClientError('API_NOT_CONFIGURED', '服务地址须使用 HTTPS。'));
      return;
    }
    if (!baseUrl) {
      reject(
        new ClientError(
          'API_NOT_CONFIGURED',
          '服务地址尚未配置，请联系服务维护者。',
        ),
      );
      return;
    }
    let credential: string | null;
    try {
      credential = loadToken();
    } catch (error) {
      reject(error);
      return;
    }
    uni.request({
      url: baseUrl.replace(/\/$/, '') + request.path,
      method: request.method === 'PATCH' ? 'POST' : request.method,
      header: {
        ...request.headers,
        ...(request.method === 'PATCH'
          ? { 'X-Dayline-Method-Override': 'PATCH' }
          : {}),
        'content-type': 'application/json',
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      },
      ...(request.body === undefined
        ? {}
        : { data: request.body as Record<string, unknown> }),
      timeout: 10000,
      success(response) {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.header))
          if (typeof value === 'string') headers[key.toLowerCase()] = value;
        resolve({ status: response.statusCode, headers, body: response.data });
      },
      fail() {
        reject(new Error('Network request failed'));
      },
    });
  });
export const api = new ApiClient(bearerTransport, (headers) => {
  const signed = headers['set-auth-token'];
  if (!signed) return;
  token = signed;
  tokenLoaded = true;
  try {
    uni.setStorageSync(tokenKey, signed);
    credentialWarning.value = '';
  } catch {
    credentialWarning.value =
      '云端请求已确认，但登录凭据未能持久保存；当前会话仅在内存，请检查空间后重新登录。';
  }
});
api.onIdentityChange(() => {
  if (!api.getAccount()) {
    try {
      clearCredential();
    } catch {
      /* in-memory credential is cleared first */
    }
  }
});
export function wechatCode(): Promise<string> {
  return new Promise((resolve, reject) =>
    uni.login({
      provider: 'weixin',
      success(result) {
        if (result.code) resolve(result.code);
        else
          reject(
            new ClientError('WECHAT_CODE_INVALID', '未取得微信凭据，请重试。'),
          );
      },
      fail() {
        reject(
          new ClientError(
            'WECHAT_UNAVAILABLE',
            '无法取得微信登录凭据，请重试。',
          ),
        );
      },
    }),
  );
}
