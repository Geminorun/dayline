import { randomUUID } from 'node:crypto';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ClientError } from '@dayline/api-client';
const mocks = vi.hoisted(() => ({ reorder: vi.fn(), remove: vi.fn() }));
vi.mock('@dcloudio/uni-app', () => ({ onShow: () => {} }));
vi.mock('../src/adapters/uuid', () => ({ newId: async () => randomUUID() }));
vi.mock('../src/workspace', async () => {
  const { ref } = await import('vue');
  const time = '2026-10-29T00:00:00.000Z',
    categories = Array.from({ length: 3 }, (_, i) => ({
      id: randomUUID(),
      name: ['阅读', '运动', '生活'][i] ?? '',
      color: '#6CA58A',
      seedKey: null,
      version: 1,
      createdAt: time,
      updatedAt: time,
    }));
  const w = {
    snapshot: ref({
      categories,
      dataVersion: '7',
      entries: [{ categoryId: categories[0]?.id }],
      trashEntries: [],
    }),
    busy: ref(false),
    loading: ref(false),
    error: ref(''),
    notice: ref(''),
    mode: ref('account'),
    retrySeconds: ref(0),
    spaceRevision: ref(1),
    readonly: ref(false),
    ensure: async () => {},
    generation: () => 1,
    load: async () => {},
    dismissNotice: () => {},
    mutate: async (_input: unknown, cloud: () => Promise<unknown>) => cloud(),
  };
  return {
    useWorkspace: () => w,
    message: (error: unknown) =>
      error instanceof Error ? error.message : '失败',
    records: { reorderCategories: mocks.reorder, deleteCategory: mocks.remove },
  };
});
import Page from '../src/pages/categories/index.vue';
import { useWorkspace } from '../src/workspace';
beforeEach(() => vi.stubGlobal('uni', { vibrateShort: vi.fn() }));
let wrapper: ReturnType<typeof mount> | undefined;
afterEach(() => {
  wrapper?.unmount();
  vi.unstubAllGlobals();
  mocks.reorder.mockReset();
  mocks.remove.mockReset();
});
it('submits the complete long-pressed order with its original data version', async () => {
  const w = useWorkspace(),
    before = w.snapshot.value?.categories.map((c) => c.id) ?? [];
  mocks.reorder.mockResolvedValue({});
  wrapper = mount(Page);
  const handle = wrapper.findAll('.drag-handle')[0];
  if (!handle) throw new Error('No handle');
  await handle.trigger('touchstart', { touches: [{ clientY: 100 }] });
  await handle.trigger('longpress');
  await handle.trigger('touchmove', { touches: [{ clientY: 245 }] });
  await handle.trigger('touchend');
  await flushPromises();
  expect(mocks.reorder).toHaveBeenCalledWith({
    categoryIds: [before[1], before[2], before[0]],
    expectedDataVersion: '7',
  });
});
it('restores the authoritative category order on conflict and does not retry automatically', async () => {
  mocks.reorder.mockRejectedValue(
    new ClientError(
      'DATA_VERSION_CONFLICT',
      '记录已有变化，请重新确认删除。',
      409,
    ),
  );
  wrapper = mount(Page);
  const handle = wrapper.findAll('.drag-handle')[0];
  if (!handle) throw new Error('No handle');
  await handle.trigger('touchstart', { touches: [{ clientY: 100 }] });
  await handle.trigger('longpress');
  await handle.trigger('touchmove', { touches: [{ clientY: 245 }] });
  await handle.trigger('touchend');
  await flushPromises();
  expect(mocks.reorder).toHaveBeenCalledOnce();
  expect(wrapper.findAll('.category-name').map((c) => c.text())).toEqual([
    '● 阅读',
    '● 运动',
    '● 生活',
  ]);
});
it('freezes deletion count and versions before showing confirmation and sends trash mode', async () => {
  const w = useWorkspace(),
    category = w.snapshot.value?.categories[0];
  if (!category) throw new Error('No category');
  mocks.remove.mockResolvedValue({});
  wrapper = mount(Page);
  await wrapper.get('[aria-label="删除 阅读"]').trigger('click');
  expect(wrapper.text()).toContain('共 1 条记录');
  const confirm = wrapper
    .findAll('button')
    .find((b) => b.text() === '删除分类及记录');
  await confirm?.trigger('click');
  await flushPromises();
  expect(mocks.remove).toHaveBeenCalledWith(
    category.id,
    expect.objectContaining({
      mode: 'trash',
      expectedVersion: 1,
      expectedDataVersion: '7',
    }),
  );
});
