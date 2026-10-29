import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { defineComponent } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGuestPackage, guestSnapshot } from '@dayline/contracts';
import DataPage from '../src/DataPage.vue';
import { api } from '../src/api';
import { useAccount } from '../src/account';
import { useWorkspace } from '../src/records/workspace';
import {
  localEnvironment,
  localRepository,
} from '../src/adapters/local-repository';
import { guestRepository } from '../src/adapters/guest-repository';
const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount());
  useWorkspace().lifecycle(false);
  useAccount().clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function deferred() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function button(w: ReturnType<typeof mount>, label: string) {
  const found = w
    .findAll('button')
    .find((b) => b.text() === label || b.attributes('aria-label') === label);
  if (!found) throw new Error('Missing ' + label);
  return found;
}
describe('routed data management startup readiness', () => {
  it('disables space-dependent actions during delayed /me and task recovery, then shows drafts and downloads on the first enabled export click', async () => {
    useAccount().clear();
    sessionStorage.setItem('dayline:storage-mode', 'account');
    await localRepository.database.table('values').clear();
    await guestRepository.database.table('packages').clear();
    const id = randomUUID(),
      now = new Date().toISOString(),
      source = createGuestPackage(randomUUID, now),
      snapshot = { ...guestSnapshot(source, '2026-10-26'), userId: id };
    await localRepository.putDraft({
      environment: localEnvironment,
      userId: id,
      format: 'dayline-draft',
      localSchemaVersion: 1,
      draftId: randomUUID(),
      entryId: randomUUID(),
      baseEntryVersion: null,
      baseEntry: null,
      inputRevision: 1,
      persistedRevision: 1,
      savedLocallyAt: now,
      fields: {
        title: '启动前已持久草稿',
        startDate: '2026-10-01',
        endDate: null,
        categoryId: source.categories[0]?.id ?? '',
      },
    });
    const identity = deferred(),
      recovery = deferred(),
      readOperation = localRepository.fileOperation.bind(localRepository);
    vi.spyOn(localRepository, 'fileOperation').mockImplementation(
      async (user) => {
        await recovery.promise;
        return readOperation(user);
      },
    );
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: RequestInfo | URL) => {
        const route = String(path);
        requests.push(route);
        if (route === '/api/v1/auth/session')
          return Response.json({
            data: { authenticated: true },
            meta: { requestId: 'session', serverTime: now },
          });
        if (route === '/api/v1/me') {
          await identity.promise;
          return Response.json({
            data: {
              locale: 'zh-CN',
              id,
              displayName: '已验证账号',
              profileVersion: 1,
              email: null,
              emailVerified: false,
              passwordEnabled: false,
              wechatBound: true,
              status: 'active',
              deletionDueAt: null,
              timeZone: 'Asia/Shanghai',
            },
            meta: { requestId: 'startup-me', serverTime: now },
          });
        }
        if (route === '/api/v1/snapshot')
          return Response.json(
            {
              data: snapshot,
              meta: { requestId: 'startup-snapshot', serverTime: now },
            },
            { headers: { ETag: '"startup-complete"' } },
          );
        if (route === '/api/v1/exports/json')
          return new Response(
            JSON.stringify({
              format: 'dayline-backup',
              schemaVersion: 1,
              exportedAt: now,
              timeZone: 'Asia/Shanghai',
              categories: source.categories,
              entries: [],
              focusDays: [],
            }),
            {
              headers: {
                'Content-Type': 'application/json',
                'Content-Disposition': 'attachment; filename="dayline.json"',
              },
            },
          );
        throw new Error('Unexpected route');
      }),
    );
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/data', component: DataPage },
        { path: '/settings', component: { template: '<p>设置</p>' } },
      ],
    });
    await router.push('/data');
    await router.isReady();
    const w = mount(defineComponent({ template: '<RouterView />' }), {
      global: { plugins: [router] },
    });
    wrappers.push(w);
    await flushPromises();
    expect(w.text()).toContain('正在确认数据空间');
    expect(button(w, '导出完整 JSON').attributes('disabled')).toBeDefined();
    expect(button(w, '导出 CSV').attributes('disabled')).toBeDefined();
    expect(w.get<HTMLInputElement>('input[type=file]').element.disabled).toBe(
      true,
    );
    expect(w.find('[aria-label="查询或恢复原任务"]').exists()).toBe(false);
    await button(w, '导出完整 JSON').trigger('click');
    expect(requests.filter((p) => p.startsWith('/api/v1/exports'))).toEqual([]);
    identity.release();
    await vi.waitFor(() => expect(w.text()).toContain('正在恢复上次导入'));
    expect(api.getAccount()).toBe(id);
    expect(button(w, '导出完整 JSON').attributes('disabled')).toBeDefined();
    expect(w.get<HTMLInputElement>('input[type=file]').element.disabled).toBe(
      true,
    );
    recovery.release();
    await vi.waitFor(() =>
      expect(button(w, '导出完整 JSON').attributes('disabled')).toBeUndefined(),
    );
    await button(w, '导出完整 JSON').trigger('click');
    await vi.waitFor(() => expect(w.text()).toContain('有尚未提交的本机修改'));
    expect(requests.filter((p) => p.startsWith('/api/v1/exports'))).toEqual([]);
    const createObjectURL = vi.fn(() => 'blob:startup'),
      revokeObjectURL = vi.fn();
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = createObjectURL;
        static revokeObjectURL = revokeObjectURL;
      },
    );
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await button(w, '继续只导出云端记录').trigger('click');
    await vi.waitFor(() => expect(w.text()).toContain('文件已生成'));
    expect(requests.filter((p) => p.startsWith('/api/v1/exports'))).toEqual([
      '/api/v1/exports/json',
    ]);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 1050));
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    // Remounting through the actual router must recover its scope before accepting another action.
    const nextRecovery = deferred();
    vi.spyOn(localRepository, 'fileOperation').mockImplementation(
      async (user) => {
        await nextRecovery.promise;
        return readOperation(user);
      },
    );
    await router.push('/settings');
    await router.push('/data');
    await flushPromises();
    expect(button(w, '导出完整 JSON').attributes('disabled')).toBeDefined();
    nextRecovery.release();
    await vi.waitFor(() =>
      expect(button(w, '导出完整 JSON').attributes('disabled')).toBeUndefined(),
    );
    await button(w, '导出完整 JSON').trigger('click');
    await vi.waitFor(() => expect(w.text()).toContain('有尚未提交的本机修改'));
    expect(
      requests.filter((p) => p.startsWith('/api/v1/exports')),
    ).toHaveLength(1);
  }, 15000);
});
