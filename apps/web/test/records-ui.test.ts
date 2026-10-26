import { mount, flushPromises } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientError } from '@dayline/api-client';
import type {
  CreateEntryInput,
  PatchEntryInput,
  SnapshotDto,
} from '@dayline/contracts';
import EntryEditor from '../src/records/EntryEditor.vue';
import RecordsPage from '../src/records/RecordsPage.vue';
import { records } from '../src/records/record-service';
import { useAccount } from '../src/account';
const userId = '63a561bd-2302-485d-8d89-cea248ffbdf1';
const categoryId = '76c7987d-aadb-4001-922f-26ea52d9f0e8';
const entryId = '8215ed08-99a1-460d-a4da-3e4fa674245f';
const date = '2026-10-26';
const time = `${date}T04:00:00.000Z`;
const category = {
  id: categoryId,
  name: '阅读',
  color: '#6C9BCE',
  seedKey: 'reading',
  version: 1,
  createdAt: time,
  updatedAt: time,
};
const entry = {
  id: entryId,
  categoryId,
  title: '阅读三体',
  startDate: '2026-10-01',
  endDate: null,
  version: 1,
  focusVersion: 1,
  deletedAt: null,
  purgeAfter: null,
  createdAt: time,
  updatedAt: time,
};
const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => {
  wrappers.forEach((wrapper) => wrapper.unmount());
  wrappers.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useAccount().clear();
});
function editor(
  save: (
    id: string,
    input: CreateEntryInput | PatchEntryInput,
    creating: boolean,
  ) => Promise<void>,
  editing = false,
) {
  const wrapper = mount(EntryEditor, {
    props: {
      entry: editing ? entry : null,
      categories: [category],
      today: date,
      save,
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}
const button = (wrapper: ReturnType<typeof mount>, text: string) => {
  const result = wrapper
    .findAll('button')
    .find((button) => button.text() === text);
  if (!result) throw new Error(`Missing button ${text}`);
  return result;
};
describe('minimal record interface', () => {
  it('retains new input and stable ID through a failed save, and waits for server confirmation', async () => {
    let resolve: (() => void) | undefined;
    const save = vi.fn(
      async (
        id: string,
        input: CreateEntryInput | PatchEntryInput,
        creating: boolean,
      ) => {
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
        expect(input.title).toBe('我的记录');
        expect(creating).toBe(true);
        if (save.mock.calls.length === 1)
          throw new ClientError('NETWORK_ERROR', '网络请求失败');
        await new Promise<void>((done) => {
          resolve = done;
        });
      },
    );
    const wrapper = editor(save);
    await wrapper.get('input').setValue('我的记录');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('input').element.value).toBe('我的记录');
    expect(wrapper.emitted('saved')).toBeUndefined();
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('正在请求服务器');
    expect(wrapper.emitted('saved')).toBeUndefined();
    expect(save.mock.calls[0]?.[0]).toBe(save.mock.calls[1]?.[0]);
    resolve?.();
    await flushPromises();
    expect(wrapper.emitted('saved')).toHaveLength(1);
  });
  it('requires a separate exact-date focus removal confirmation and keeps the frozen content version', async () => {
    const affected = [{ date: '2026-10-25', version: 2 }];
    const save = vi.fn(
      async (_id: string, input: CreateEntryInput | PatchEntryInput) => {
        if (!('focusRemovalAcknowledgement' in input))
          throw new ClientError(
            'FOCUS_REMOVAL_CONFIRMATION_REQUIRED',
            '请确认',
            409,
            { currentVersion: 1, affectedFocusDays: affected },
          );
      },
    );
    const wrapper = editor(save, true);
    await wrapper.findAll('input[type="date"]')[1]?.setValue('2026-10-20');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('2026-10-25');
    expect(wrapper.emitted('saved')).toBeUndefined();
    await button(wrapper, '确认移除这些重点并保存').trigger('click');
    await flushPromises();
    expect(save.mock.calls[1]?.[1]).toMatchObject({
      expectedVersion: 1,
      endDate: '2026-10-20',
      focusRemovalAcknowledgement: affected,
    });
    expect(wrapper.emitted('saved')).toHaveLength(1);
  });
  it('refuses a record write without the committed dataVersion instead of reporting a saved result', async () => {
    useAccount().clear();
    const { api } = await import('../src/api');
    api.setAccount(userId);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: { entry, focusDays: [] },
          meta: { requestId: 'missing-version', serverTime: time },
        }),
      ),
    );
    await expect(
      records.create({
        id: entryId,
        categoryId,
        title: '阅读三体',
        startDate: '2026-10-01',
        endDate: null,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('loads real-shaped snapshots and shows saves only after a successful response, with explicit deletion and restore', async () => {
    const state: SnapshotDto = {
      schemaVersion: 1,
      userId,
      dataVersion: '1',
      timeZone: 'Asia/Shanghai',
      businessToday: date,
      complete: true,
      categories: [category],
      entries: [entry],
      trashEntries: [],
      focusDays: [],
    };
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, options?: RequestInit) => {
        requests.push(path);
        if (path === '/api/v1/me')
          return Response.json({
            data: {
              id: userId,
              displayName: '测试用户',
              profileVersion: 1,
              email: 'test@example.com',
              emailVerified: true,
              passwordEnabled: true,
              wechatBound: false,
              status: 'active',
              deletionDueAt: null,
              timeZone: 'Asia/Shanghai',
            },
            meta: { requestId: 'me', serverTime: time },
          });
        if (path === '/api/v1/snapshot')
          return Response.json({
            data: state,
            meta: { requestId: 'snapshot', serverTime: time },
          });
        expect(options?.headers).toMatchObject({
          'x-dayline-expected-user': userId,
        });
        if (
          path === `/api/v1/entries/${entryId}` &&
          options?.method === 'DELETE'
        ) {
          state.entries = [];
          state.trashEntries = [
            {
              ...entry,
              version: 2,
              deletedAt: time,
              purgeAfter: '2026-11-25T04:00:00.000Z',
            },
          ];
          state.dataVersion = '2';
          return Response.json({
            data: { entry: state.trashEntries[0], focusDays: [] },
            meta: { requestId: 'delete', serverTime: time, dataVersion: '2' },
          });
        }
        if (path === `/api/v1/trash/${entryId}/restore`) {
          state.entries = [{ ...entry, version: 3 }];
          state.trashEntries = [];
          state.dataVersion = '3';
          return Response.json({
            data: { entry: state.entries[0], focusDays: [] },
            meta: { requestId: 'restore', serverTime: time, dataVersion: '3' },
          });
        }
        throw new Error('Unexpected request');
      }),
    );
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: RecordsPage },
        { path: '/login', component: { template: '<div>登录</div>' } },
      ],
    });
    await router.push('/');
    await router.isReady();
    const wrapper = mount(RecordsPage, { global: { plugins: [router] } });
    wrappers.push(wrapper);
    await flushPromises();
    expect(wrapper.text()).toContain('阅读三体');
    expect(wrapper.text()).not.toContain('服务器已确认保存');
    await button(wrapper, '移入回收站').trigger('click');
    expect(requests.filter((path) => path.endsWith(entryId))).toHaveLength(0);
    await button(wrapper, '确认移入回收站').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('服务器已确认保存');
    await button(wrapper, '回收站').trigger('click');
    expect(wrapper.text()).toContain('阅读三体');
    await button(wrapper, '恢复事项').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('回收站为空');
    await button(wrapper, '每日回看').trigger('click');
    expect(wrapper.text()).toContain('阅读三体');
  });
});
