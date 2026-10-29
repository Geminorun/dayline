import { afterEach, expect, it, vi } from 'vitest';
import { ClientError } from '@dayline/api-client';
import { useWorkspace, message } from '../src/workspace';
import { api } from '../src/api';
afterEach(() => {
  useWorkspace().lifecycle(false);
  api.invalidate();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('counts down from Retry-After using elapsed time and does not refresh during the cooldown', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('uni', {});
  const w = useWorkspace();
  w.error.value = message(
    new ClientError('RATE_LIMITED', '过于频繁', 429, undefined, 3),
  );
  const request = vi.spyOn(api, 'request');
  expect(w.retrySeconds.value).toBe(3);
  await w.load();
  expect(request).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(w.retrySeconds.value).toBe(2);
  w.lifecycle(false);
  await vi.advanceTimersByTimeAsync(5000);
  w.lifecycle(true);
  expect(w.retrySeconds.value).toBe(0);
  request.mockRestore();
});
