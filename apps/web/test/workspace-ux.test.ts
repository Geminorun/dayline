import 'fake-indexeddb/auto';
import { mount, flushPromises } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, expect, it, vi } from 'vitest';
import { createGuestPackage, guestSnapshot } from '@dayline/contracts';
import App from '../src/App.vue';
import { routes } from '../src/routes';
import { useAccount } from '../src/account';
import { useWorkspace } from '../src/records/workspace';
import {
  localEnvironment,
  localRepository,
} from '../src/adapters/local-repository';
let wrapper: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  wrapper?.unmount();
  wrapper = undefined;
  useWorkspace().lifecycle(false);
  useAccount().clear();
  await flushPromises();
  sessionStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('opens separate import/export dialogs without changing the current record route', async () => {
  await useWorkspace().switchMode('guest');
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push('/day');
  await router.isReady();
  wrapper = mount(App, { global: { plugins: [router] } });
  await flushPromises();
  await wrapper.get('button[aria-label="导出记录"]').trigger('click');
  await vi.waitFor(() =>
    expect(wrapper?.find('dialog h1').text()).toBe('导出记录'),
  );
  expect(wrapper.find('dialog input[type="file"]').exists()).toBe(false);
  expect(wrapper.get('dialog').text()).toContain('导出 CSV');
  await wrapper.get('button[aria-label="关闭数据工具"]').trigger('click');
  await wrapper.get('button[aria-label="导入记录"]').trigger('click');
  await vi.waitFor(() =>
    expect(wrapper?.find('dialog input[type="file"]').exists()).toBe(true),
  );
  expect(wrapper.get('dialog').text()).not.toContain('导出 CSV');
  expect(router.currentRoute.value.path).toBe('/day');
});
it('keeps refresh feedback outside record flow and preserves existing content while reading', async () => {
  const workspace = useWorkspace();
  await workspace.switchMode('guest');
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push('/day');
  await router.isReady();
  wrapper = mount(App, { global: { plugins: [router] } });
  await flushPromises();
  const snapshot = workspace.snapshot.value;
  vi.useFakeTimers();
  workspace.loading.value = true;
  await vi.advanceTimersByTimeAsync(170);
  expect(wrapper.find('.sync-working').exists()).toBe(true);
  expect(wrapper.find('.records-skeleton').exists()).toBe(false);
  expect(wrapper.text()).not.toContain('正在完整读取');
  expect(wrapper.find('.date-panel').exists()).toBe(true);
  workspace.loading.value = false;
  await flushPromises();
  expect(wrapper.find('.sync-done').exists()).toBe(true);
  expect(workspace.snapshot.value).toEqual(snapshot);
});
it('shows only current-owner pending edits and logs out from below trash while retaining drafts', async () => {
  await localRepository.database.table('values').clear();
  const id = crypto.randomUUID(),
    now = new Date().toISOString();
  const data = createGuestPackage(() => crypto.randomUUID(), now);
  const snapshot = { ...guestSnapshot(data, now.slice(0, 10)), userId: id };
  const requests: string[] = [];
  const profile = {
    locale: 'zh-CN',
    id,
    displayName: '测试账号',
    profileVersion: 1,
    email: 'preview@example.com',
    emailVerified: true,
    passwordEnabled: true,
    wechatBound: false,
    status: 'active',
    deletionDueAt: null,
    timeZone: 'Asia/Shanghai',
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: RequestInfo | URL) => {
      const url = String(path);
      requests.push(url);
      const response =
        url === '/api/v1/auth/session'
          ? { authenticated: true }
          : url === '/api/v1/me'
            ? profile
            : url === '/api/v1/snapshot'
              ? snapshot
              : { success: true };
      return Response.json({
        data: response,
        meta: { requestId: 'ux', serverTime: now },
      });
    }),
  );
  sessionStorage.setItem('dayline:storage-mode', 'guest');
  useAccount().clear();
  await useWorkspace().ensure();
  expect(useWorkspace().mode.value).toBe('account');
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push('/day');
  await router.isReady();
  wrapper = mount(App, { global: { plugins: [router] } });
  await flushPromises();
  expect(wrapper.find('.account-menu a[href="/drafts"]').exists()).toBe(false);
  expect(wrapper.get('.account-actions').text()).not.toContain('继续游客');
  const draftId = crypto.randomUUID();
  await localRepository.putDraft({
    environment: localEnvironment,
    userId: id,
    format: 'dayline-draft',
    localSchemaVersion: 1,
    draftId,
    entryId: crypto.randomUUID(),
    baseEntryVersion: null,
    baseEntry: null,
    inputRevision: 1,
    persistedRevision: 1,
    savedLocallyAt: now,
    fields: {
      title: '待提交',
      startDate: now.slice(0, 10),
      endDate: null,
      categoryId: data.categories[0]?.id ?? '',
    },
  });
  await vi.waitFor(() =>
    expect(wrapper?.get('.account-menu a[href="/drafts"]').text()).toContain(
      '1',
    ),
  );
  const original = await localRepository.draft(id, draftId);
  if (!original) throw new Error('Expected own pending edit');
  await localRepository.putDraft({
    ...original,
    userId: crypto.randomUUID(),
    draftId: crypto.randomUUID(),
  });
  await flushPromises();
  expect(wrapper.get('.draft-count').text()).toBe('1');
  await localRepository.database.table('values').put({
    key: `${id}:draft:${crypto.randomUUID()}`,
    value: { private: '不可展示的损坏内容' },
  });
  await vi.waitFor(() => expect(wrapper?.get('.draft-count').text()).toBe('!'));
  expect(wrapper.text()).not.toContain('不可展示的损坏内容');
  const items = wrapper
    .get('.account-actions')
    .findAll('a,button')
    .map((item) => item.text());
  expect(items.at(-2)).toBe('回收站');
  expect(items.at(-1)).toBe('退出登录');
  await wrapper.get('.account-logout').trigger('click');
  await flushPromises();
  expect(requests).toContain('/api/v1/auth/logout');
  expect(useAccount().current.value).toBeNull();
  expect(wrapper.find('.account-menu a[href="/drafts"]').exists()).toBe(false);
  expect(await localRepository.draft(id, draftId)).not.toBeNull();
});

it('separates appearance from account settings without storage toggles or file links', async () => {
  await useWorkspace().switchMode('guest');
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push('/settings');
  await router.isReady();
  wrapper = mount(App, { global: { plugins: [router] } });
  await flushPromises();
  expect(wrapper.get('h1').text()).toBe('设置');
  expect(wrapper.findAll('input[name="theme-style"]')).toHaveLength(7);
  expect(wrapper.find('a[href="/data"]').exists()).toBe(false);
  await wrapper.get('#settings-tab-account').trigger('click');
  expect(wrapper.get('[role="tabpanel"]').text()).toContain('登录后管理账号');
  expect(wrapper.text()).not.toContain('当前数据空间');
  expect(wrapper.text()).not.toContain('继续使用游客');
  await wrapper
    .get('#settings-tab-account')
    .trigger('keydown', { key: 'ArrowLeft' });
  expect(
    wrapper.get('#settings-tab-appearance').attributes('aria-selected'),
  ).toBe('true');
});
