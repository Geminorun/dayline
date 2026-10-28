import { nextTick } from 'vue';
import { randomUUID } from 'node:crypto';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test');
  return {
    show: [] as (() => Promise<void> | void)[],
    load: undefined as
      undefined | ((query: Record<string, string>) => Promise<void> | void),
  };
});
vi.mock('@dcloudio/uni-app', () => ({
  onShow(callback: () => Promise<void> | void) {
    hooks.show.push(callback);
  },
  onLoad(callback: typeof hooks.load) {
    hooks.load = callback;
  },
}));
import RecordsScreen from '../src/components/RecordsScreen.vue';
import EntryEdit from '../src/pages/entry/edit.vue';
import TimelinePage from '../src/pages/timeline/index.vue';
import { useWorkspace } from '../src/workspace';
import { api } from '../src/api';
const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount());
  hooks.show = [];
  hooks.load = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function button(wrapper: ReturnType<typeof mount>, text: string) {
  const result = wrapper.findAll('button').find((b) => b.text() === text);
  if (!result) throw new Error('Missing ' + text);
  return result;
}
describe('independent miniapp business controls', () => {
  it('persists a guest entry, marks a historical day, confirms deletion and preserves the active date', async () => {
    const storage = new Map<string, string>(),
      navigate = vi.fn(),
      cloud = vi.fn();
    vi.stubGlobal('wx', {
      getRandomValues(options: {
        length: number;
        success: (result: { randomValues: ArrayBuffer }) => void;
      }) {
        const data = Uint8Array.from(
          { length: options.length },
          (_, i) => (i * 13) % 256,
        );
        options.success({ randomValues: data.buffer });
      },
    });
    vi.stubGlobal('uni', {
      getStorageSync: (k: string) => storage.get(k),
      setStorageSync: (k: string, v: string) => storage.set(k, v),
      removeStorageSync: (k: string) => storage.delete(k),
      getStorageInfoSync: () => ({
        keys: [...storage.keys()],
        currentSize: Math.ceil([...storage.values()].join('').length / 1024),
        limitSize: 10240,
      }),
      navigateTo: navigate,
      navigateBack: navigate,
      request: cloud,
    });
    // Use genuine distinct UUID bytes, including generations and record IDs.
    vi.stubGlobal('wx', {
      getRandomValues(options: {
        length: number;
        success: (result: { randomValues: ArrayBuffer }) => void;
      }) {
        const data = new Uint8Array(options.length);
        for (let i = 0; i < data.length; i += 16) {
          const hex = randomUUID().replaceAll('-', '');
          for (let j = 0; j < 16; j++)
            data[i + j] = parseInt(hex.slice(j * 2, j * 2 + 2), 16);
        }
        options.success({ randomValues: data.buffer });
      },
    });
    const screen = mount(RecordsScreen, { props: { kind: 'day' } });
    wrappers.push(screen);
    await hooks.show[0]?.();
    await flushPromises();
    expect(screen.text()).toContain('游客');
    await button(screen, '＋ 新建事项').trigger('click');
    expect(navigate).toHaveBeenCalledWith({ url: '/pages/entry/edit' });
    const editor = mount(EntryEdit);
    wrappers.push(editor);
    await hooks.load?.({});
    await flushPromises();
    const inputs = editor.findAll('input');
    await inputs[0]?.setValue('小程序本机经历');
    await inputs[1]?.setValue('2026-10-01');
    await button(editor, '保存到本机').trigger('click');
    await flushPromises();
    expect(cloud).not.toHaveBeenCalled();
    expect(screen.text()).toContain('小程序本机经历');
    expect(storage.size).toBeGreaterThan(1);
    await screen.get('input').setValue('2026-10-25');
    await flushPromises();
    await button(screen, '标记 2026-10-25 重点').trigger('click');
    await flushPromises();
    expect(useWorkspace().snapshot.value?.focusDays[0]).toMatchObject({
      focused: true,
      version: 1,
    });
    await button(screen, '移入回收站').trigger('click');
    expect(useWorkspace().snapshot.value?.entries).toHaveLength(1);
    await button(screen, '确认移入回收站').trigger('click');
    await flushPromises();
    expect(useWorkspace().snapshot.value?.trashEntries).toHaveLength(1);
    expect(screen.get('input').element.value).toBe('2026-10-25');
    const workspace = useWorkspace(),
      userId = randomUUID(),
      guestSnapshot = workspace.snapshot.value;
    const archived = guestSnapshot?.trashEntries[0];
    if (!archived || !guestSnapshot) throw new Error('Missing guest record');
    workspace.current.value = {
      id: userId,
      displayName: '云端用户',
      profileVersion: 1,
      email: null,
      emailVerified: false,
      passwordEnabled: false,
      wechatBound: true,
      status: 'active',
      deletionDueAt: null,
      timeZone: 'Asia/Shanghai',
    };
    workspace.mode.value = 'account';
    workspace.snapshot.value = {
      ...guestSnapshot,
      userId,
      entries: [
        {
          ...archived,
          title: '私人云端记录',
          deletedAt: null,
          purgeAfter: null,
        },
      ],
      trashEntries: [],
    };
    api.setAccount(userId);
    cloud.mockImplementation((options: UniApp.RequestOptions) =>
      options.success?.({
        statusCode: 200,
        header: {},
        cookies: [],
        data: {
          data: { success: true },
          meta: { requestId: 'logout', serverTime: '2026-10-26T04:00:00.000Z' },
        },
      }),
    );
    await workspace.logout();
    await flushPromises();
    expect(workspace.current.value).toBeNull();
    expect(workspace.mode.value).toBe('guest');
    expect(
      workspace.snapshot.value?.entries.some((e) => e.title === '私人云端记录'),
    ).toBe(false);
    expect(workspace.snapshot.value?.trashEntries[0]?.title).toBe(
      '小程序本机经历',
    );
    expect(api.getAccount()).toBeNull();
  });
  it('keeps name and graph rows aligned, synchronizes horizontal headers and opens grouped focus details with bounded nodes', async () => {
    const workspace = useWorkspace(),
      now = '2026-10-26T04:00:00.000Z';
    workspace.snapshot.value = {
      schemaVersion: 1,
      userId: randomUUID(),
      dataVersion: '1',
      timeZone: 'Asia/Shanghai',
      businessToday: '9999-12-31',
      complete: true,
      categories: [],
      entries: Array.from({ length: 1000 }, (_, i) => ({
        id: String(i),
        categoryId: 'c',
        title: '事项 ' + i,
        startDate: '0001-01-01',
        endDate: '9999-12-31',
        version: 1,
        focusVersion: 1,
        deletedAt: null,
        purgeAfter: null,
        createdAt: now,
        updatedAt: now,
      })),
      trashEntries: [],
      focusDays: Array.from({ length: 10000 }, (_, i) => ({
        entryId: '0',
        date: `${String(Math.floor(i / 12) + 1).padStart(4, '0')}-${String((i % 12) + 1).padStart(2, '0')}-01`,
        focused: true,
        version: 1,
      })),
    };
    const navigate = vi.fn();
    vi.stubGlobal('uni', { navigateTo: navigate, switchTab: vi.fn() });
    const wrapper = mount(TimelinePage);
    wrappers.push(wrapper);
    await hooks.show[0]?.();
    await flushPromises();
    wrapper
      .findAll('picker')[2]
      ?.element.dispatchEvent(
        new CustomEvent('change', { detail: { value: 3 } }),
      );
    await nextTick();
    await flushPromises();
    const statusPicker = wrapper
      .findAll('picker')
      .find((p) => p.attributes('range')?.includes('已结束'));
    statusPicker?.element.dispatchEvent(
      new CustomEvent('change', { detail: { value: 2 } }),
    );
    await nextTick();
    await flushPromises();
    // Choose the scale picker by its range, independently from filter pickers.
    const scalePicker = wrapper
      .findAll('picker')
      .find((p) => p.attributes('range')?.includes('季度'));
    scalePicker?.element.dispatchEvent(
      new CustomEvent('change', { detail: { value: 3 } }),
    );
    await nextTick();
    await flushPromises();
    expect(wrapper.findAll('.name-row').length).toBe(
      wrapper.findAll('.track').length,
    );
    expect(wrapper.findAll('.track').length).toBeLessThan(30);
    expect(wrapper.findAll('.tick').length).toBeLessThanOrEqual(80);
    wrapper
      .get('.date-body')
      .element.dispatchEvent(
        new CustomEvent('scroll', { detail: { scrollLeft: 125 } }),
      );
    await nextTick();
    expect(wrapper.get('.date-header').attributes('scroll-left')).toBe('125');
    await wrapper.findAll('.focus')[0]?.trigger('click');
    expect(wrapper.text()).toContain('个重点日');
    await wrapper.findAll('.name-row')[0]?.trigger('click');
    expect(navigate).toHaveBeenCalledWith({ url: '/pages/entry/edit?id=0' });
  });
});
