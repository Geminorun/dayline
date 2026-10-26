import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { MergePlan, UserDto } from '@dayline/contracts';
import { mergeReviewSchema } from '@dayline/contracts';
const hooks = vi.hoisted(() => ({
  show: undefined as undefined | (() => Promise<void>),
  unload: undefined as undefined | (() => void),
}));
const request = vi.hoisted(() => vi.fn());
vi.mock('@dcloudio/uni-app', () => ({
  onShow(callback: typeof hooks.show) {
    hooks.show = callback;
  },
  onUnload(callback: typeof hooks.unload) {
    hooks.unload = callback;
  },
}));
vi.mock('../src/api', () => ({
  api: { request, getGeneration: () => 1, onIdentityChange: () => () => {} },
  wechatCode: async () => 'fresh-code',
}));
vi.mock('../src/adapters/uuid', () => ({
  newId: async () => 'a79b45dc-b6b9-4ee3-bfda-ff17b24c9bb1',
}));
vi.mock('../src/workspace', async () => {
  const { ref } = await import('vue');
  const state = {
    current: ref<UserDto | null>(null),
    mode: ref<'guest' | 'account'>('account'),
    generation: () => 1,
    ensure: async () => {},
    identityWrite: async (work: () => Promise<unknown>) => work(),
    login: vi.fn(),
  };
  return {
    useWorkspace: () => state,
    message: () => 'controlled review failure',
  };
});
import IdentityPage from '../src/pages/account/identity.vue';
import { useWorkspace } from '../src/workspace';
afterEach(() => {
  hooks.unload?.();
  hooks.show = undefined;
  hooks.unload = undefined;
  request.mockReset();
});
it('preserves the same actor refresh, requires saved merge selections, retains failed review and clears private state on guest or another actor', async () => {
  const now = '2026-10-26T20:00:00.000Z';
  const actor: UserDto = {
    id: randomUUID(),
    displayName: '目标账号',
    email: null,
    emailVerified: false,
    passwordEnabled: false,
    wechatBound: true,
    status: 'active',
    profileVersion: 1,
    deletionDueAt: null,
    timeZone: 'Asia/Shanghai',
  };
  const summary = {
    userId: randomUUID(),
    displayName: '来源账号',
    email: 'source@example.com',
    entries: 0,
    trash: 0,
    categories: 1,
    focusDays: 0,
  };
  const plan: MergePlan = {
    id: randomUUID(),
    operationId: randomUUID(),
    status: 'preview',
    planRevision: 1,
    planDigest: 'plan',
    expiresAt: now,
    sourceSummary: summary,
    targetSummary: {
      ...summary,
      userId: actor.id,
      displayName: actor.displayName,
      email: null,
    },
    sourceDataVersion: '1',
    targetDataVersion: '1',
    targetCategories: [],
    categoryMappings: [
      {
        sourceId: randomUUID(),
        sourceName: '来源分类',
        sourceColor: '#123456',
        targetId: null,
        name: '来源分类',
        color: '#123456',
        needsReview: false,
      },
    ],
    entries: [],
    targetEntries: [],
    focusDays: [],
    targetFocusDays: [],
    canCommit: true,
    conflicts: [],
    counts: { retained: 0, reusedCategories: 0, newCategories: 1 },
    displayNameFrom: 'target',
    result: null,
  };
  let finish: (() => void) | undefined,
    fail = true;
  request.mockImplementation(
    async (path: string, options?: { body?: unknown }) => {
      if (path.endsWith('/review')) {
        const input = mergeReviewSchema.parse(options?.body);
        expect(input.categories[0]?.name).toBe('保留核对名称');
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        if (fail) throw new Error('controlled failure');
        return {
          data: {
            ...plan,
            planRevision: 2,
            categoryMappings: plan.categoryMappings.map((c) => ({
              ...c,
              name: '保留核对名称',
            })),
          },
        };
      }
      return {
        data:
          path === '/api/v1/account-merges'
            ? [{ id: plan.id, status: 'preview', createdAt: now }]
            : path.endsWith('email-binding-requests')
              ? []
              : plan,
      };
    },
  );
  const workspace = useWorkspace();
  workspace.mode.value = 'account';
  workspace.current.value = actor;
  const w = mount(IdentityPage);
  await hooks.show?.();
  await flushPromises();
  const button = (label: string) => {
    const b = w.findAll('button').find((b) => b.text().includes(label));
    if (!b) throw new Error(label);
    return b;
  };
  await button('查询合并').trigger('click');
  await flushPromises();
  const commit = button('确认合并并保留双方');
  expect(commit.attributes('disabled')).toBeUndefined();
  workspace.current.value = { ...actor };
  await flushPromises();
  expect(w.text()).toContain('来源账号');
  expect(w.text()).not.toContain('确认当前空间并恢复任务');
  const name = w.get('input[placeholder="新分类名称（最多12字）"]');
  await name.setValue('保留核对名称');
  expect(commit.attributes('disabled')).toBeDefined();
  await commit.trigger('click');
  expect(
    request.mock.calls.some((call) => String(call[0]).endsWith('/commit')),
  ).toBe(false);
  await button('保存核对并更新预览').trigger('click');
  await flushPromises();
  expect(name.attributes('disabled')).toBeDefined();
  expect(
    w.findAll('picker').every((p) => p.attributes('disabled') !== undefined),
  ).toBe(true);
  finish?.();
  await flushPromises();
  expect((name.element as HTMLInputElement).value).toBe('保留核对名称');
  expect(commit.attributes('disabled')).toBeDefined();
  fail = false;
  await button('保存核对并更新预览').trigger('click');
  await flushPromises();
  finish?.();
  await flushPromises();
  expect(commit.attributes('disabled')).toBeUndefined();
  workspace.mode.value = 'guest';
  await flushPromises();
  expect(w.text()).not.toContain('来源账号');
  workspace.mode.value = 'account';
  workspace.current.value = { ...actor, id: randomUUID() };
  await flushPromises();
  expect(w.text()).not.toContain('保留核对名称');
  expect(w.text()).not.toContain('source@example.com');
  w.unmount();
});
