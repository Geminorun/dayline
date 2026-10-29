import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import LanguageSettings from '../src/i18n/LanguageSettings.vue';
import { changeLanguage, locale } from '../src/i18n';
import { useAccount } from '../src/account';
import { api } from '../src/api';

let wrapper: ReturnType<typeof mount> | undefined;
const profile = () => ({
  id: randomUUID(),
  displayName: 'Private user name',
  locale: 'zh-CN' as 'zh-CN' | 'en',
  profileVersion: 1,
  email: null,
  emailVerified: false,
  passwordEnabled: false,
  wechatBound: true,
  status: 'active',
  deletionDueAt: null,
  timeZone: 'Asia/Shanghai',
});
const response = (data: unknown) =>
  Response.json({
    data,
    meta: { requestId: randomUUID(), serverTime: new Date().toISOString() },
  });
afterEach(() => {
  wrapper?.unmount();
  useAccount().clear();
  changeLanguage('zh-CN');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('applies guest language locally without making an account request', async () => {
  useAccount().clear();
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  wrapper = mount(LanguageSettings);
  await wrapper.get('select').setValue('en');
  await flushPromises();
  expect(locale.value).toBe('en');
  expect(wrapper.text()).toContain('this device');
  expect(localStorage.getItem('dayline:locale:v1')).toBe('en');
  expect(fetcher).not.toHaveBeenCalled();
});

it('refreshes a conflicting profile before an explicit retry and never overwrites its display name', async () => {
  let stored = profile();
  const writes: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_path: string, options: RequestInit) => {
      expect(new Headers(options.headers).get('Accept-Language')).toBe(
        locale.value,
      );
      if (options.method === 'PATCH') {
        writes.push(JSON.parse(String(options.body)));
        if (writes.length === 1) {
          stored = {
            ...stored,
            displayName: 'Name changed elsewhere',
            profileVersion: 2,
          };
          return Response.json(
            { error: { code: 'VERSION_CONFLICT' } },
            { status: 409 },
          );
        }
        stored = { ...stored, locale: 'en', profileVersion: 3 };
      }
      return response(stored);
    }),
  );
  api.confirmAccount(stored.id);
  await useAccount().refresh();
  wrapper = mount(LanguageSettings);
  await wrapper.get('select').setValue('en');
  await flushPromises();
  expect(locale.value).toBe('en');
  expect(writes).toEqual([{ locale: 'en', expectedProfileVersion: 1 }]);
  expect(wrapper.get('[role=alert]').text()).toContain('not saved');
  expect(useAccount().current.value?.profileVersion).toBe(2);
  await wrapper.get('button').trigger('click');
  await flushPromises();
  expect(writes).toEqual([
    { locale: 'en', expectedProfileVersion: 1 },
    { locale: 'en', expectedProfileVersion: 2 },
  ]);
  expect(useAccount().current.value?.displayName).toBe(
    'Name changed elsewhere',
  );
  expect(wrapper.get('[role=status]').text()).toContain('saved');
});

it('ignores a previous account language save that finishes after switching accounts', async () => {
  let stored = profile();
  let complete: ((value: Response) => void) | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_path: string, options: RequestInit) => {
      if (options.method === 'PATCH')
        return new Promise<Response>((resolve) => {
          complete = resolve;
        });
      return response(stored);
    }),
  );
  api.confirmAccount(stored.id);
  await useAccount().refresh();
  wrapper = mount(LanguageSettings);
  await wrapper.get('select').setValue('en');
  await flushPromises();
  const old = stored;
  stored = profile();
  api.setAccount(stored.id);
  await useAccount().refresh();
  complete?.(response({ ...old, locale: 'en', profileVersion: 2 }));
  await flushPromises();
  expect(useAccount().current.value?.id).toBe(stored.id);
  expect(locale.value).toBe('zh-CN');
  expect(wrapper.find('[role=status]').exists()).toBe(false);
});
