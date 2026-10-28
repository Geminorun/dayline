import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { mount, flushPromises } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../src/App.vue';
import IdentityPage from '../src/IdentityPage.vue';
import { api } from '../src/api';
import { useWorkspace } from '../src/records/workspace';
import { useAccount } from '../src/account';
afterEach(() => {
  useWorkspace().lifecycle(false);
  useAccount().clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
});
it('keeps an anonymous binding-link result while startup resolves an anonymous session without /me', async () => {
  const id = randomUUID(),
    token = 'x'.repeat(43),
    path = `/auth/email-binding?id=${id}&token=${token}`;
  history.replaceState(
    { current: path, back: path, forward: path, position: 4 },
    '',
    path,
  );
  sessionStorage.removeItem('dayline:storage-mode');
  let release: ((response: Response) => void) | undefined;
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      if (url === '/api/v1/auth/session')
        return Response.json({
          data: { authenticated: false },
          meta: {
            requestId: 'session',
            serverTime: '2026-10-26T20:00:00.000Z',
          },
        });
      if (url === '/api/v1/me')
        return Response.json(
          { error: { code: 'UNAUTHENTICATED' } },
          { status: 401 },
        );
      if (url === '/api/v1/me/email-binding-requests/verify')
        return new Promise<Response>((resolve) => (release = resolve));
      throw new Error('Unexpected network request');
    }),
  );
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/auth/email-binding', component: IdentityPage },
      { path: '/day', component: { template: '<div>day</div>' } },
    ],
  });
  await router.push(path);
  await router.isReady();
  const generation = api.getGeneration(),
    wrapper = mount(App, { global: { plugins: [router] } });
  try {
    await flushPromises();
    expect(calls).toContain('/api/v1/auth/session');
    expect(calls).not.toContain('/api/v1/me');
    expect(calls).toContain('/api/v1/me/email-binding-requests/verify');
    expect(api.getGeneration()).toBe(generation);
    expect(release).toBeTypeOf('function');
    expect(JSON.stringify(history.state)).not.toContain(token);
    release?.(
      Response.json({
        data: { success: true },
        meta: {
          requestId: 'public-verify',
          serverTime: '2026-10-26T20:00:00.000Z',
        },
      }),
    );
    await flushPromises();
    expect(wrapper.text()).toContain(
      '邮箱已验证；此页面不会登录或变更身份。请回原设备、原账号继续添加邮箱。',
    );
    expect(wrapper.find('input[type=password]').exists()).toBe(false);
    expect(wrapper.find('input[type=email]').exists()).toBe(false);
    expect(new URL(location.href).search).toBe('');
  } finally {
    wrapper.unmount();
  }
});
