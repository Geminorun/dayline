import { mount, flushPromises } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AuthPage from '../src/AuthPage.vue';
import { api } from '../src/api';
import { useAccount } from '../src/account';
import { takeAuthCallback } from '../src/callback';

const wrappers: ReturnType<typeof mount>[] = [];
async function page(mode: string) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/:mode', component: AuthPage },
      { path: '/account', component: { template: '<div>account</div>' } },
    ],
  });
  await router.push(`/${mode}`);
  await router.isReady();
  const wrapper = mount(AuthPage, { global: { plugins: [router] } });
  wrappers.push(wrapper);
  return wrapper;
}
afterEach(() => {
  wrappers.forEach((wrapper) => wrapper.unmount());
  wrappers.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  useAccount().clear();
  window.history.replaceState(null, '', '/');
});
describe('email and QR interfaces', () => {
  it('keeps registration validation and success states explicit and clears passwords', async () => {
    const fetch = vi.fn(
      async (path: RequestInfo | URL, options?: RequestInit) => {
        expect(path).toBe('/api/auth/sign-up/email');
        expect(options?.credentials).toBe('include');
        return Response.json({
          user: { id: '63a561bd-2302-485d-8d89-cea248ffbdf1' },
          token: null,
        });
      },
    );
    vi.stubGlobal('fetch', fetch);
    const wrapper = await page('register');
    await wrapper.get('input[name="name"]').setValue('小序');
    await wrapper.get('input[name="email"]').setValue('user@example.com');
    const passwords = wrapper.findAll('input[type="password"]');
    await passwords[0]?.setValue('Register-password!');
    await passwords[1]?.setValue('different');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.get('[role="alert"]').text()).toContain('不一致');
    expect(fetch).not.toHaveBeenCalled();
    await passwords[1]?.setValue('Register-password!');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[role="status"]').text()).toContain('验证后再登录');
    expect(
      (wrapper.get('input[name="password"]').element as HTMLInputElement).value,
    ).toBe('');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'include',
      method: 'POST',
    });
  });
  it('consumes reset token from query before requests, reports invalid links and never trusts a URL success label', async () => {
    window.history.replaceState(
      null,
      '',
      '/reset-password?token=private-reset-token&error=INVALID_TOKEN',
    );
    const wrapper = await page('reset-password');
    expect(window.location.search).toBe('');
    expect(wrapper.get('[role="status"]').text()).toContain('链接已失效');
    wrapper.unmount();
    const verified = await page('verified');
    expect(verified.text()).toContain('服务器确认验证状态');
    expect(verified.text()).not.toContain('验证已完成');
    const history = { replaceState: vi.fn() };
    expect(
      takeAuthCallback(
        { href: 'https://web.example/reset-password?token=one-time#form' },
        history,
      ).token,
    ).toBe('one-time');
    expect(history.replaceState).toHaveBeenCalledWith(
      null,
      '',
      '/reset-password#form',
    );
  });
  it('preserves router navigation metadata while scrubbing callback secrets from history URL fields', () => {
    const history = {
      state: {
        current: '/reset-password?token=private',
        back: '/login?token=old&view=mail',
        forward: '/account?error=expired',
        position: 4,
        replaced: false,
        scroll: { top: 120, left: 0 },
      },
      replaceState: vi.fn(),
    };
    takeAuthCallback(
      { href: 'https://web.example/reset-password?token=private' },
      history,
    );
    const state = history.replaceState.mock.calls[0]?.[0];
    expect(state).toMatchObject({
      current: '/reset-password',
      back: '/login?view=mail',
      forward: '/account',
      position: 4,
      replaced: false,
      scroll: { top: 120, left: 0 },
    });
    expect(JSON.stringify(state)).not.toMatch(/token|private|expired/);
  });
  it('shows email login failures without exposing provider messages or logging out an existing actor', async () => {
    api.setAccount('existing-user');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            code: 'INVALID_EMAIL_OR_PASSWORD',
            message: 'secret@example.invalid',
          },
          { status: 401 },
        ),
      ),
    );
    const wrapper = await page('login');
    await wrapper.get('input[name="email"]').setValue('user@example.com');
    await wrapper.get('input[name="password"]').setValue('Wrong-password!');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('邮箱或密码不正确。');
    expect(wrapper.text()).not.toContain('secret@example');
    expect(api.getAccount()).toBe('existing-user');
  });
  it('stops QR polling when leaving the page and requires explicit browser consumption', async () => {
    vi.useFakeTimers();
    const id = '63a561bd-2302-485d-8d89-cea248ffbdf1';
    const fetch = vi.fn(async (path: string) =>
      Response.json({
        meta: { requestId: 'qr-test', serverTime: '2026-10-26T04:00:00.000Z' },
        data: {
          id,
          purpose: 'login',
          status: 'pending',
          expiresAt: '2026-10-26T23:59:59.000Z',
          ...(path === '/api/v1/auth/qr-requests'
            ? { miniappCode: 'data:image/png;base64,iVBORw0KGgo=' }
            : {}),
        },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const wrapper = await page('login');
    const generate = wrapper
      .findAll('button')
      .find((button) => button.text() === '生成小程序码');
    await generate?.trigger('click');
    await flushPromises();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain('请用微信扫描');
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.some(([path]) => path.includes('/consume'))).toBe(
      false,
    );
  });
});

it('uses server Retry-After for email resend, disables repeated requests, then permits an explicit retry and clears its timer on leave', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () =>
    Response.json(
      { code: 'TOO_MANY_REQUESTS', message: 'private provider value' },
      { status: 429, headers: { 'Retry-After': '2' } },
    ),
  );
  vi.stubGlobal('fetch', fetch);
  const wrapper = await page('verify');
  await wrapper.get('input[name="email"]').setValue('test@example.com');
  await wrapper.get('form').trigger('submit');
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain('等待 2 秒');
  expect(wrapper.get('form button').text()).toBe('2 秒后可重试');
  expect(wrapper.get('form button').attributes('disabled')).toBeDefined();
  await wrapper.get('form').trigger('submit');
  expect(fetch).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1000);
  expect(wrapper.get('[role="alert"]').text()).toContain('等待 1 秒');
  expect(wrapper.text()).not.toContain('等待 2 秒');
  expect(wrapper.get('form button').text()).toBe('1 秒后可重试');
  await vi.advanceTimersByTimeAsync(1000);
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  expect(wrapper.get('[role="status"]').text()).toContain('可以重新提交');
  expect(wrapper.get('form button').text()).toBe('重发验证邮件');
  expect(wrapper.get('form button').attributes('disabled')).toBeUndefined();
  await wrapper.get('form').trigger('submit');
  await flushPromises();
  expect(fetch).toHaveBeenCalledTimes(2);
  wrapper.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  {
    status: 429,
    code: 'RATE_LIMITED',
    tip: '操作过于频繁，请稍后重试。',
  },
  {
    status: 503,
    code: 'MAIL_UNAVAILABLE',
    tip: '邮件暂时无法发送，请稍后重新申请。',
  },
])(
  'shows $code without an invented wait or successful delivery message',
  async ({ status, code, tip }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { code, message: 'private provider details' },
          { status },
        ),
      ),
    );
    const wrapper = await page('verify');
    await wrapper.get('input[name="email"]').setValue('test@example.com');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe(tip);
    expect(wrapper.text()).not.toContain('private provider');
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.get('form button').text()).toBe('重发验证邮件');
    expect(wrapper.get('form button').attributes('disabled')).toBeUndefined();
  },
);
