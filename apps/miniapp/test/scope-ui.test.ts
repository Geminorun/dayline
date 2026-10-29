import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  logout: vi.fn(),
  request: vi.fn(),
}));
vi.mock('@dcloudio/uni-app', () => ({ onShow: () => {} }));
vi.mock('../src/api', () => ({
  api: { getGeneration: () => 1, request: mocks.request },
}));
vi.mock('../src/admission', async () => {
  const { ref } = await import('vue');
  return { useAdmission: () => ({ operation: ref(null) }) };
});
vi.mock('../src/workspace', async () => {
  const { ref } = await import('vue');
  const w = {
    current: ref(null),
    mode: ref('guest'),
    credentialWarning: ref(''),
    identityState: ref('guest'),
    busy: ref(false),
    loading: ref(false),
    error: ref(''),
    notice: ref(''),
    retrySeconds: ref(0),
    ensure: async () => {},
    load: async () => {},
    switchMode: async () => {},
    login: mocks.login,
    restoreSession: async () => {},
    logout: mocks.logout,
    dismissNotice: () => {},
  };
  return { useWorkspace: () => w, message: () => '' };
});
import Page from '../src/pages/me/index.vue';
import { useWorkspace } from '../src/workspace';
let wrapper: ReturnType<typeof mount> | undefined;
afterEach(() => {
  wrapper?.unmount();
  useWorkspace().current.value = null;
  mocks.login.mockClear();
  mocks.request.mockClear();
  vi.unstubAllGlobals();
});
it('offers guest recording and only WeChat authentication, with no email or file settings', async () => {
  vi.stubGlobal('uni', { getSystemInfoSync: () => ({ theme: 'light' }) });
  wrapper = mount(Page);
  await flushPromises();
  const login = wrapper.findAll('button').find((b) => b.text() === '微信登录');
  expect(login).toBeDefined();
  await login?.trigger('click');
  expect(mocks.login).toHaveBeenCalledOnce();
  expect(wrapper.text()).not.toMatch(/邮箱|密码|导入|导出|语言|English/);
});
it('keeps the Chinese interface without overwriting an English Web profile and hides guest switching after login', async () => {
  vi.stubGlobal('uni', { getSystemInfoSync: () => ({ theme: 'light' }) });
  const w = useWorkspace();
  w.current.value = {
    id: 'f9ccdb10-8078-4a4a-b14f-3c7bb98cc888',
    displayName: 'Name',
    locale: 'en',
    profileVersion: 1,
    email: 'private@example.com',
    emailVerified: true,
    passwordEnabled: true,
    wechatBound: true,
    status: 'active',
    deletionDueAt: null,
    timeZone: 'Asia/Shanghai',
  };
  w.mode.value = 'account';
  wrapper = mount(Page);
  await flushPromises();
  expect(wrapper.text()).toContain('微信账号');
  expect(wrapper.text()).not.toMatch(
    /继续游客|邮箱|private@example.com|English/,
  );
  expect(mocks.request).not.toHaveBeenCalled();
  expect(w.current.value.locale).toBe('en');
});
it('registers only the three primary tabs and retains explicit web scan confirmation', () => {
  const pages = JSON.parse(readFileSync('src/pages.json', 'utf8'));
  expect(
    pages.tabBar.list.map((p: { pagePath: string }) => p.pagePath),
  ).toEqual(['pages/day/index', 'pages/timeline/index', 'pages/me/index']);
  expect(
    pages.pages.some((p: { path: string }) => p.path === 'pages/scan/confirm'),
  ).toBe(true);
  expect(
    pages.pages.some((p: { path: string }) => /entries|identity/.test(p.path)),
  ).toBe(false);
});
