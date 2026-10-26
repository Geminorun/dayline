import { describe, expect, it } from 'vitest';
import { userDtoSchema } from '@dayline/contracts';
import { ApiClient, ClientError } from '../src/index.js';
import type { TransportResponse } from '../src/index.js';

describe('platform-free account-aware transport', () => {
  it('sends the expected user and preserves empty 304 responses', async () => {
    const client = new ApiClient(async (request) => {
      expect(request.headers['x-dayline-expected-user']).toBe('A');
      return { status: 304, headers: {} };
    });
    client.setAccount('A');
    expect(await client.request('/snapshot', { account: true })).toMatchObject({
      status: 304,
      data: undefined,
    });
  });
  it('rejects a late response without accepting another account credential', async () => {
    let complete: ((value: TransportResponse) => void) | undefined;
    const credentials: string[] = [];
    const client = new ApiClient(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
      (headers) => credentials.push(headers.token ?? ''),
    );
    client.setAccount('A');
    const pending = client.request('/me', { account: true });
    client.setAccount('B');
    complete?.({
      status: 200,
      headers: { token: 'private-A' },
      body: { data: { id: 'A' } },
    });
    await expect(pending).rejects.toMatchObject({ code: 'STALE_RESPONSE' });
    expect(credentials).toEqual([]);
  });
  it('normalizes native errors, clears identity and never echoes internal values', async () => {
    const client = new ApiClient(async () => ({
      status: 409,
      headers: {},
      body: {
        error: {
          code: 'ACTOR_CONTEXT_MISMATCH',
          message: 'wx-secret@identity.dayline.invalid',
        },
      },
    }));
    client.setAccount('A');
    await expect(
      client.request('/logout', { method: 'POST', account: true }),
    ).rejects.toThrow('当前账号已变化');
    expect(client.getAccount()).toBeNull();
    expect(new ClientError('error', 'safe')).toBeInstanceOf(Error);
  });
  it('requires a known actor before private writes and never retries failures', async () => {
    let calls = 0;
    const client = new ApiClient(async () => {
      calls++;
      throw new Error('secret');
    });
    await expect(
      client.request('/write', { account: true }),
    ).rejects.toMatchObject({ code: 'ACTOR_CONTEXT_REQUIRED' });
    await expect(client.request('/read')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      message: '网络请求失败，请检查连接后重试。',
    });
    expect(calls).toBe(1);
  });
  it('validates responses before credentials and keeps a current actor after anonymous login rejection', async () => {
    let accept = 0;
    const invalid = new ApiClient(
      async () => ({
        status: 200,
        headers: { 'set-auth-token': 'private' },
        body: { data: { id: 'missing-fields' } },
      }),
      () => accept++,
    );
    await expect(
      invalid.request('/me', { decode: userDtoSchema.parse }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(accept).toBe(0);
    const anonymous = new ApiClient(async () => ({
      status: 401,
      headers: {},
      body: { code: 'INVALID_EMAIL_OR_PASSWORD' },
    }));
    anonymous.setAccount('A');
    await expect(
      anonymous.request('/sign-in', { native: true, method: 'POST' }),
    ).rejects.toMatchObject({ code: 'INVALID_EMAIL_OR_PASSWORD' });
    expect(anonymous.getAccount()).toBe('A');
    await expect(
      anonymous.request('/write', { account: true, method: 'POST' }),
    ).rejects.toMatchObject({ status: 401 });
    expect(anonymous.getAccount()).toBeNull();
  });
});
