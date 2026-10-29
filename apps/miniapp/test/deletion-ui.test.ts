import { randomUUID } from 'node:crypto';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import type { UserDto } from '@dayline/contracts';
const hooks = vi.hoisted(() => ({
  show: undefined as undefined | (() => Promise<void>),
  unload: undefined as undefined | (() => void),
  generation: 1,
}));
const request = vi.hoisted(() => vi.fn());
const code = vi.hoisted(() => vi.fn());
vi.mock('@dcloudio/uni-app', () => ({
  onShow: (work: typeof hooks.show) => {
    hooks.show = work;
  },
  onUnload: (work: typeof hooks.unload) => {
    hooks.unload = work;
  },
}));
vi.mock('../src/api', () => ({
  api: { request, getGeneration: () => hooks.generation, invalidate: vi.fn() },
  wechatCode: code,
}));
vi.mock('../src/adapters/uuid', () => ({ newId: async () => randomUUID() }));
vi.mock('../src/workspace', async () => {
  const { ref } = await import('vue');
  const value = {
    current: ref<UserDto | null>(null),
    mode: ref('account'),
    generation: () => (value.mode.value === 'account' ? 1 : 2),
    ensure: async () => {},
    restoreSession: async () => {},
    identityWrite: async (work: () => Promise<unknown>) => work(),
  };
  return { useWorkspace: () => value, message: () => '身份验证未完成' };
});
import Page from '../src/pages/account/deletion.vue';
import { useWorkspace } from '../src/workspace';
let wrapper: ReturnType<typeof mount> | undefined;
afterEach(() => {
  hooks.unload?.();
  wrapper?.unmount();
  request.mockReset();
  code.mockReset();
  hooks.generation++;
});
function button(text: string) {
  const b = wrapper?.findAll('button').find((b) => b.text() === text);
  if (!b) throw new Error(text);
  return b;
}
it('shows pending Beijing deadline, preserves same-UUID confirmation, and drops a delayed fresh code after guest switch', async () => {
  const w = useWorkspace();
  Object.assign(w.current, {
    value: {
      locale: 'zh-CN',
      id: randomUUID(),
      displayName: '微信账号',
      profileVersion: 1,
      email: null,
      emailVerified: false,
      passwordEnabled: false,
      wechatBound: true,
      status: 'pending_deletion',
      deletionDueAt: '2026-11-02T00:00:00.000Z',
      timeZone: 'Asia/Shanghai',
    },
  });
  w.mode.value = 'account';
  wrapper = mount(Page);
  await hooks.show?.();
  await flushPromises();
  expect(wrapper.text()).toContain('2026-11-02 08:00:00（北京时间）');
  await button('我明确撤销本次注销').trigger('click');
  Object.assign(w.current, { value: { ...w.current.value } });
  await flushPromises();
  expect(wrapper.text()).toContain('使用当前微信重新验证');
  let release: ((v: string) => void) | undefined;
  code.mockImplementation(
    () =>
      new Promise<string>((r) => {
        release = r;
      }),
  );
  await button('使用当前微信重新验证').trigger('click');
  await flushPromises();
  w.mode.value = 'guest';
  await flushPromises();
  release?.('fresh-code');
  await flushPromises();
  expect(request).not.toHaveBeenCalled();
  expect(wrapper.text()).not.toContain('2026-11-02');
  expect(wrapper.text()).not.toContain('身份验证未完成');
});
