import { afterEach, expect, it, vi } from 'vitest';
import { cookieTransport } from '../src/api';
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function aborting(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () =>
      reject(new DOMException('aborted', 'AbortError')),
    );
  });
}
it('bounds a hanging fetch and keeps the batch budget distinct without retrying', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn((_path: unknown, options?: RequestInit) =>
    aborting(options?.signal),
  );
  vi.stubGlobal('fetch', fetch);
  const ordinary = cookieTransport({
    path: '/api/v1/me/deletion',
    method: 'POST',
    headers: {},
    body: {},
  });
  const checked = expect(ordinary).rejects.toMatchObject({
    name: 'AbortError',
  });
  await vi.advanceTimersByTimeAsync(20000);
  await checked;
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  const batch = cookieTransport({
    path: '/api/v1/account-merges/id/commit',
    method: 'POST',
    headers: {},
  });
  const batchChecked = expect(batch).rejects.toMatchObject({
    name: 'AbortError',
  });
  await vi.advanceTimersByTimeAsync(20000);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(45000);
  await batchChecked;
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
it('retains the same deadline while reading a stalled body and clears it after a completed response', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn((_path: unknown, options?: RequestInit) =>
      Promise.resolve({
        status: 200,
        ok: true,
        headers: new Headers(),
        json: () => aborting(options?.signal),
      }),
    ),
  );
  const pending = cookieTransport({
    path: '/api/v1/me',
    method: 'GET',
    headers: {},
  });
  const checked = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(20000);
  await checked;
  expect(vi.getTimerCount()).toBe(0);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ data: {} })),
  );
  await cookieTransport({ path: '/api/v1/me', method: 'GET', headers: {} });
  expect(vi.getTimerCount()).toBe(0);
});

it('treats a stalled or failed download body as a network failure, reserving encoding errors for bytes that were actually received', async () => {
  vi.useFakeTimers();
  const headers = new Headers({
    'content-disposition': 'attachment; filename="dayline.json"',
    'content-type': 'application/json',
  });
  vi.stubGlobal(
    'fetch',
    vi.fn((_path: unknown, options?: RequestInit) =>
      Promise.resolve({
        status: 200,
        ok: true,
        headers,
        arrayBuffer: () => aborting(options?.signal),
      }),
    ),
  );
  const pending = cookieTransport({
    path: '/api/v1/exports/json',
    method: 'GET',
    headers: {},
  });
  const checked = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(20000);
  await checked;
  expect(vi.getTimerCount()).toBe(0);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      status: 200,
      ok: true,
      headers,
      arrayBuffer: async () => {
        throw new TypeError('connection lost');
      },
    })),
  );
  await expect(
    cookieTransport({
      path: '/api/v1/exports/json',
      method: 'GET',
      headers: {},
    }),
  ).rejects.toBeInstanceOf(TypeError);
  expect(vi.getTimerCount()).toBe(0);
});
