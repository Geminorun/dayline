import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { mount, flushPromises } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../src/App.vue';
import DeletionPage from '../src/DeletionPage.vue';
import DataPage from '../src/DataPage.vue';
import { api } from '../src/api';
import { useAccount } from '../src/account';
import { useWorkspace } from '../src/records/workspace';
import { localRepository } from '../src/adapters/local-repository';
let wrapper: ReturnType<typeof mount> | undefined;
afterEach(() => {
  wrapper?.unmount();
  useWorkspace().lifecycle(false);
  useAccount().clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('cold pending login skips ordinary snapshots and private cache, routes to deletion, and exports without a snapshot', async () => {
  const id = randomUUID(),
    paths: string[] = [],
    cache = vi.spyOn(localRepository, 'read').mockResolvedValue(null);
  vi.spyOn(localRepository, 'drafts').mockResolvedValue([]);
  sessionStorage.removeItem('dayline:storage-mode');
  api.invalidate();
  const now = new Date().toISOString();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      paths.push(path);
      if (path === '/api/v1/me')
        return Response.json({
          data: {
            id,
            displayName: '待注销',
            profileVersion: 1,
            email: null,
            emailVerified: false,
            passwordEnabled: false,
            wechatBound: true,
            status: 'pending_deletion',
            deletionDueAt: new Date(Date.now() + 7 * 86400000).toISOString(),
            timeZone: 'Asia/Shanghai',
          },
          meta: { requestId: 'pending-space', serverTime: now },
        });
      if (path === '/api/v1/exports/json')
        return new Response('{"format":"dayline-backup"}', {
          headers: {
            'content-type': 'application/json',
            'content-disposition': 'attachment; filename="dayline.json"',
          },
        });
      throw new Error('Unexpected private read ' + path);
    }),
  );
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/day', component: { template: '<div>business</div>' } },
      { path: '/account-deletion', component: DeletionPage },
      { path: '/data', component: DataPage },
      { path: '/:pathMatch(.*)*', component: { template: '<div />' } },
    ],
  });
  await router.push('/day');
  await router.isReady();
  wrapper = mount(App, { global: { plugins: [router] } });
  await flushPromises();
  expect(router.currentRoute.value.path).toBe('/account-deletion');
  expect(useWorkspace().snapshot.value).toBeNull();
  expect(cache).not.toHaveBeenCalled();
  expect(paths.every((path) => path === '/api/v1/me')).toBe(true);
  await router.push('/data');
  await flushPromises();
  expect(wrapper.text()).toContain('导出已保存记录');
  expect(wrapper.text()).not.toContain('导入预览');
  expect(
    wrapper
      .findAll('button')
      .some(
        (b) =>
          b.text() === '导出完整 JSON' &&
          b.attributes('disabled') === undefined,
      ),
  ).toBe(true);
  const objectUrl = vi.fn(() => 'blob:pending-export');
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: objectUrl,
      revokeObjectURL: vi.fn(),
    }),
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await wrapper
    .findAll('button')
    .find((b) => b.text() === '导出完整 JSON')
    ?.trigger('click');
  await flushPromises();
  expect(paths).toContain('/api/v1/exports/json');
  expect(objectUrl).toHaveBeenCalledOnce();
  vi.mocked(localRepository.drafts).mockRejectedValueOnce(
    new Error('private-corrupt-draft'),
  );
  await wrapper
    .findAll('button')
    .find((b) => b.text() === '导出完整 JSON')
    ?.trigger('click');
  await flushPromises();
  expect(wrapper.text()).toContain('本机草稿暂时无法读取');
  expect(wrapper.text()).not.toContain('private-corrupt-draft');
  await wrapper
    .findAll('button')
    .find((b) => b.text() === '继续只导出云端记录')
    ?.trigger('click');
  await flushPromises();
  expect(objectUrl).toHaveBeenCalledTimes(2);
  expect(paths).not.toContain('/api/v1/snapshot');
});
