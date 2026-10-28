import 'fake-indexeddb/auto';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.vue';
import AuthPage from '../src/AuthPage.vue';
import TimelineView from '../src/records/TimelineView.vue';
import RecordsPage from '../src/records/RecordsPage.vue';
import { useWorkspace } from '../src/records/workspace';
import { recordView } from '../src/records/view-state';
beforeEach(() => vi.spyOn(window, 'scrollTo').mockImplementation(() => {}));
const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function button(wrapper: ReturnType<typeof mount>, text: string) {
  const found = wrapper.findAll('button').find((b) => b.text() === text);
  if (!found) throw new Error('Missing ' + text);
  return found;
}
describe('routed auth and complete timeline accessibility', () => {
  it('remounts authentication modes through real RouterView, clears credentials and cancels QR timers', async () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        requests.push(path);
        if (path === '/api/v1/auth/session')
          return Response.json({
            data: { authenticated: false },
            meta: {
              requestId: 'session',
              serverTime: '2026-10-26T04:00:00.000Z',
            },
          });
        if (path === '/api/v1/me')
          return Response.json(
            { error: { code: 'UNAUTHENTICATED' } },
            { status: 401 },
          );
        return Response.json({
          data: {
            id: '63a561bd-2302-485d-8d89-cea248ffbdf1',
            purpose: 'login',
            status: 'pending',
            expiresAt: '2026-10-26T23:59:59.000Z',
            ...(path === '/api/v1/auth/qr-requests'
              ? { miniappCode: 'data:image/png;base64,iVBORw0KGgo=' }
              : {}),
          },
          meta: { requestId: 'qr', serverTime: '2026-10-26T04:00:00.000Z' },
        });
      }),
    );
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/auth/:mode', component: AuthPage },
        { path: '/day', component: { template: '<div>day</div>' } },
        { path: '/settings', component: { template: '<div>settings</div>' } },
      ],
    });
    await router.push('/auth/login');
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });
    wrappers.push(wrapper);
    await wrapper
      .get<HTMLInputElement>('input[name="email"]')
      .setValue('private@example.com');
    await wrapper
      .get<HTMLInputElement>('input[name="password"]')
      .setValue('secret-password');
    await button(wrapper, '生成小程序码').trigger('click');
    await flushPromises();
    const count = requests.length;
    await router.push('/auth/register');
    await flushPromises();
    expect(
      wrapper.get<HTMLInputElement>('input[name="email"]').element.value,
    ).toBe('');
    expect(
      wrapper.get<HTMLInputElement>('input[name="password"]').element.value,
    ).toBe('');
    await vi.advanceTimersByTimeAsync(10000);
    expect(requests).toHaveLength(count);
    await router.push('/auth/verify-email');
    await flushPromises();
    expect(wrapper.text()).toContain('验证邮箱');
    expect(wrapper.find('input[name="email"]').exists()).toBe(true);
  });
  it('virtualizes thousand rows and exposes exact grouped focus dates by click without daily grids', async () => {
    const entries = Array.from({ length: 1000 }, (_, i) => ({
      id: String(i),
      title: '事项 ' + i,
      categoryId: 'c',
      startDate: '0001-01-01',
      endDate: '9999-12-31',
      version: 1,
      focusVersion: 1,
      deletedAt: null,
      purgeAfter: null,
      createdAt: '2026-10-26T04:00:00.000Z',
      updatedAt: '2026-10-26T04:00:00.000Z',
    }));
    const focusDays = Array.from({ length: 10000 }, (_, i) => ({
      entryId: '0',
      date: `${String(Math.floor(i / 12) + 1).padStart(4, '0')}-${String((i % 12) + 1).padStart(2, '0')}-01`,
      focused: true,
      version: 1,
    }));
    const wrapper = mount(TimelineView, {
      props: {
        entries,
        focusDays,
        today: '9999-12-31',
        scale: 'all',
        anchor: '2026-10-26',
      },
    });
    wrappers.push(wrapper);
    expect(wrapper.findAll('.timeline-row').length).toBeLessThan(30);
    expect(wrapper.findAll('.timeline-tick').length).toBeLessThanOrEqual(80);
    const markers = wrapper.findAll('.focus-marker');
    expect(markers.length).toBeLessThanOrEqual(80);
    await markers[0]?.trigger('click');
    expect(wrapper.text()).toContain('重点日期');
    const first = wrapper.findAll('.date-list button')[0];
    await first?.trigger('click');
    expect(wrapper.emitted('day')?.[0]?.[0]).toBe(focusDays[0]?.date);
    await wrapper.findAll('.timeline-name')[1]?.get('button').trigger('click');
    expect(wrapper.emitted('view')?.[0]?.[0]).toMatchObject({ id: '0' });
    const viewport = wrapper.get('.timeline-viewport');
    viewport.element.scrollTop = 28000;
    await viewport.trigger('scroll');
    await wrapper.setProps({ entries: entries.slice(0, 1) });
    await flushPromises();
    expect(wrapper.findAll('.timeline-row')).toHaveLength(1);
    await wrapper.setProps({ entries: [] });
    await flushPromises();
    expect(wrapper.findAll('.timeline-row')).toHaveLength(0);
  });
  it('opens a fresh edit deep link and uses a safe internal return instead of browser history', async () => {
    const workspace = useWorkspace();
    recordView.filter.search = '上一空间的私人标题';
    await workspace.switchMode('guest');
    expect(recordView.filter.search).toBe('');
    const categoryId = workspace.snapshot.value?.categories[0]?.id;
    if (!categoryId) throw new Error('Missing defaults');
    const id = '8215ed08-99a1-460d-a4da-3e4fa674245f';
    await workspace.mutate(
      {
        kind: 'create',
        input: {
          id,
          categoryId,
          title: '深链事项',
          startDate: '2026-10-01',
          endDate: null,
        },
      },
      async () => {
        throw new Error('Guest must not call server');
      },
    );
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/entries/:id', component: RecordsPage },
        { path: '/entries', component: RecordsPage },
        { path: '/day', component: RecordsPage },
        {
          path: '/:pathMatch(.*)*',
          component: { template: '<div>other</div>' },
        },
      ],
    });
    await router.push('/entries/' + id + '?edit=1');
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });
    wrappers.push(wrapper);
    await flushPromises();
    expect(
      wrapper.get<HTMLInputElement>('dialog form input').element.value,
    ).toBe('深链事项');
    await wrapper
      .get<HTMLInputElement>('dialog form input')
      .setValue('尚未提交的深链输入');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await button(wrapper, '取消').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/entries/' + id);
    expect(
      wrapper.get<HTMLInputElement>('dialog form input').element.value,
    ).toBe('尚未提交的深链输入');
    await wrapper.get('dialog form').trigger('submit');
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/day'));
    await flushPromises();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(
      workspace.snapshot.value?.entries.find((e) => e.id === id)?.title,
    ).toBe('尚未提交的深链输入');
  });
});
