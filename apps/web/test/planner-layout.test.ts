import 'fake-indexeddb/auto';
import { mount, flushPromises } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, expect, it, vi } from 'vitest';
import { shiftDate } from '@dayline/core';
import App from '../src/App.vue';
import { routes } from '../src/routes';
import { useWorkspace } from '../src/records/workspace';
import { useAccount } from '../src/account';

let wrapper: ReturnType<typeof mount> | undefined;
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  useAccount().clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('keeps only two primary tabs and redirects old record-list links with the date preserved', async () => {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push('/entries?date=2026-10-20');
  await router.isReady();
  expect(router.currentRoute.value.path).toBe('/day');
  expect(router.currentRoute.value.query.date).toBe('2026-10-20');
  const workspace = useWorkspace();
  await workspace.switchMode('guest');
  wrapper = mount(App, { global: { plugins: [router] } });
  await flushPromises();
  expect(
    wrapper.findAll('nav[aria-label="主导航"] a').map((link) => link.text()),
  ).toEqual(['每日回看', '时间轴']);
  expect(wrapper.findAll('.mini-days button')).toHaveLength(42);
  expect(wrapper.find('.stats-row').exists()).toBe(true);
  expect(wrapper.find('.distribution-panel').exists()).toBe(true);
  expect(wrapper.find('.account-menu a[href="/data"]').exists()).toBe(false);
  expect(wrapper.find('.account-menu a[href="/drafts"]').exists()).toBe(false);
  expect(wrapper.find('button[aria-label="导入记录"]').exists()).toBe(true);
  expect(wrapper.find('button[aria-label="导出记录"]').exists()).toBe(true);
});

it('connects the reference calendar, modal editor, daily focus, categories and timeline to real guest data', async () => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const workspace = useWorkspace();
  await workspace.switchMode('guest');
  const snapshot = workspace.snapshot.value;
  const category = snapshot?.categories[0];
  if (!snapshot || !category) throw new Error('Missing guest defaults');
  const today = snapshot.businessToday;
  const date = shiftDate(today, -1);
  const id = crypto.randomUUID();
  await workspace.mutate(
    {
      kind: 'create',
      input: {
        id,
        categoryId: category.id,
        title: '原站布局中的真实事项',
        startDate: shiftDate(date, -5),
        endDate: null,
      },
    },
    async () => {
      throw new Error('Guest must not call the server');
    },
  );
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push('/day');
  await router.isReady();
  wrapper = mount(App, { global: { plugins: [router] } });
  await flushPromises();
  // Navigate to the current month first if a previous view selected another one.
  await wrapper.get('.today-btn').trigger('click');
  await flushPromises();
  await wrapper.get(`.mini-days button[aria-label="${date}"]`).trigger('click');
  await flushPromises();
  expect(router.currentRoute.value.query.date).toBe(date);
  expect(wrapper.text()).toContain('原站布局中的真实事项');
  await wrapper.get('.focus-toggle').trigger('click');
  await flushPromises();
  await vi.waitFor(() => {
    expect(
      workspace.snapshot.value?.focusDays.some(
        (focus) => focus.entryId === id && focus.date === date && focus.focused,
      ),
    ).toBe(true);
  });
  await wrapper.get('.event-actions button[title="编辑"]').trigger('click');
  await flushPromises();
  expect(wrapper.get('dialog[open]').attributes('aria-label')).toBe('事项编辑');
  await wrapper.get('dialog form input').setValue('修改后仍保存原来的事项');
  await wrapper.get('dialog form').trigger('submit');
  await flushPromises();
  await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/day'));
  expect(
    workspace.snapshot.value?.entries.find((entry) => entry.id === id)?.title,
  ).toBe('修改后仍保存原来的事项');
  const create = wrapper
    .findAll('button')
    .find((button) => button.text() === '新建事项');
  if (!create) throw new Error('Missing create action');
  await create.trigger('click');
  await flushPromises();
  expect(
    (wrapper.get('dialog input[type="date"]').element as HTMLInputElement)
      .value,
  ).toBe(date);
  await wrapper.get('dialog button[aria-label="关闭编辑"]').trigger('click');
  await flushPromises();
  await wrapper
    .get('.side-category-row a[aria-label^="编辑分类"]')
    .trigger('click');
  await flushPromises();
  expect(
    (
      wrapper.get('dialog form input:not([type="color"])')
        .element as HTMLInputElement
    ).value,
  ).toBe(category.name);
  await wrapper.get('button[aria-label="关闭分类管理"]').trigger('click');
  await flushPromises();
  await wrapper
    .get('nav[aria-label="主导航"] a[href="/timeline"]')
    .trigger('click');
  await flushPromises();
  expect(wrapper.find('.timeline-panel .gantt-bar').exists()).toBe(true);
  await wrapper
    .get('input[aria-label="搜索时间轴事项"]')
    .setValue('不存在的筛选词');
  await flushPromises();
  expect(wrapper.get('.timeline-empty').text()).toContain('还没有匹配的记录');
  vi.useFakeTimers();
  const accountMenu = wrapper.get('details.account-menu');
  await accountMenu.trigger('pointerenter', { pointerType: 'mouse' });
  expect(accountMenu.attributes('open')).toBeDefined();
  await accountMenu.trigger('pointerleave', { pointerType: 'mouse' });
  await vi.advanceTimersByTimeAsync(60);
  await accountMenu.trigger('pointerenter', { pointerType: 'mouse' });
  await vi.advanceTimersByTimeAsync(120);
  expect(accountMenu.attributes('open')).toBeDefined();
  await accountMenu.trigger('pointerleave', { pointerType: 'mouse' });
  await vi.advanceTimersByTimeAsync(120);
  expect(accountMenu.attributes('open')).toBeUndefined();
  vi.useRealTimers();
  expect(
    wrapper.findAll('.account-actions a').map((link) => link.text()),
  ).toContain('登录·注册');
  expect(
    wrapper
      .findAll('.account-actions a')
      .filter((link) => ['登录', '注册'].includes(link.text())),
  ).toHaveLength(0);
  await wrapper.get('.account-actions a[href="/login"]').trigger('click');
  await flushPromises();
  expect(router.currentRoute.value.path).toBe('/login');
  expect(wrapper.get('.auth-tabs button[aria-pressed="true"]').text()).toBe(
    '登录',
  );
});
