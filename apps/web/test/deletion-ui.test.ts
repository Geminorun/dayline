import { randomUUID } from 'node:crypto';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import type { UserDto } from '@dayline/contracts';
const requests = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  generation: 1,
  gate: undefined as undefined | Promise<void>,
}));
vi.mock('../src/api', () => ({
  api: { request: requests, getGeneration: () => state.generation },
}));
vi.mock('../src/account', async () => {
  const { ref } = await import('vue');
  const current = ref<UserDto | null>(null);
  return {
    useAccount: () => ({
      current,
      refresh: async () => {},
      clear: () => {
        state.generation++;
        current.value = null;
      },
    }),
  };
});
vi.mock('../src/records/workspace', async () => {
  const { ref } = await import('vue');
  const mode = ref('account');
  return {
    useWorkspace: () => ({
      mode,
      generation: () => (mode.value === 'account' ? 1 : 2),
      ensure: async () => {},
      switchMode: async () => {},
      identityWrite: async (work: () => Promise<unknown>) => {
        await state.gate;
        return work();
      },
    }),
  };
});
vi.mock('../src/ReauthForm.vue', () => ({
  default: {
    props: ['action'],
    emits: ['verified'],
    template:
      "<button @click=\"$emit('verified', 'fresh-proof')\">完成受控重新验证</button>",
  },
}));
vi.mock('../src/AccountExports.vue', () => ({
  default: { template: '<div />' },
}));
import Page from '../src/DeletionPage.vue';
import CategoryManager from '../src/records/CategoryManager.vue';
import { useAccount } from '../src/account';
import { useWorkspace } from '../src/records/workspace';
const wrappers: ReturnType<typeof mount>[] = [];
const actor = (): UserDto => ({
  id: randomUUID(),
  displayName: '当前身份',
  profileVersion: 1,
  email: 'account@example.com',
  emailVerified: true,
  passwordEnabled: true,
  wechatBound: false,
  status: 'active',
  deletionDueAt: null,
  timeZone: 'Asia/Shanghai',
});
function setup() {
  const account = useAccount();
  Object.assign(account.current, { value: actor() });
  useWorkspace().mode.value = 'account';
  const w = mount(Page, {
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  });
  wrappers.push(w);
  return w;
}
function button(w: ReturnType<typeof mount>, text: string) {
  const found = w.findAll('button').find((b) => b.text() === text);
  if (!found) throw new Error(text);
  return found;
}
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount());
  requests.mockReset();
  state.gate = undefined;
  state.generation++;
});
it('preserves a same-UUID refresh but fences a queued submit on guest switch and clears all previous private feedback', async () => {
  const w = setup();
  await flushPromises();
  await w.get('input[type=checkbox]').setValue(true);
  await button(w, '完成受控重新验证').trigger('click');
  const current = useAccount().current;
  Object.assign(current, { value: { ...current.value } });
  await flushPromises();
  expect(
    button(w, '确认申请七天后注销').attributes('disabled'),
  ).toBeUndefined();
  let release: (() => void) | undefined;
  state.gate = new Promise<void>((r) => {
    release = r;
  });
  await button(w, '确认申请七天后注销').trigger('click');
  useWorkspace().mode.value = 'guest';
  await flushPromises();
  release?.();
  await flushPromises();
  expect(requests).not.toHaveBeenCalled();
  expect(w.text()).not.toContain('当前账号密码');
  expect(w.text()).not.toContain('注销已申请');
});
it('drops an old committed response after another actor enters and retains the new actor operation', async () => {
  const w = setup();
  await flushPromises();
  await w.get('input[type=checkbox]').setValue(true);
  await button(w, '完成受控重新验证').trigger('click');
  let resolve: ((v: unknown) => void) | undefined;
  requests.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await button(w, '确认申请七天后注销').trigger('click');
  await flushPromises();
  state.generation++;
  Object.assign(useAccount().current, { value: actor() });
  await flushPromises();
  await w.get('input[type=checkbox]').setValue(true);
  await button(w, '完成受控重新验证').trigger('click');
  resolve?.({
    data: {
      status: 'pending_deletion',
      requestedAt: '2026-10-26T00:00:00.000Z',
      dueAt: '2026-11-02T00:00:00.000Z',
      reauthenticate: true,
    },
  });
  await flushPromises();
  expect(useAccount().current.value).not.toBeNull();
  expect(w.text()).not.toContain('注销已申请');
  expect(
    button(w, '确认申请七天后注销').attributes('disabled'),
  ).toBeUndefined();
});
it('accepts twelve emoji category codepoints through the actual form and rejects thirteen without mutating', async () => {
  const mutate = vi.fn(async () => {}),
    w = mount(CategoryManager, {
      props: { categories: [], entries: [], busy: false, mutate },
    });
  wrappers.push(w);
  const name = w.get('input:not([type=color])');
  await name.setValue('😀'.repeat(12));
  await w.get('form').trigger('submit');
  expect(mutate).toHaveBeenCalledOnce();
  mutate.mockClear();
  await name.setValue('😀'.repeat(13));
  await w.get('form').trigger('submit');
  expect(mutate).not.toHaveBeenCalled();
  expect(w.text()).toContain('1–12');
});
