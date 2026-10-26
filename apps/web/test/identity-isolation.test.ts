import { mount, flushPromises } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mergeReviewSchema } from '@dayline/contracts';
import type { MergePlan } from '@dayline/contracts';
vi.mock('../src/records/workspace', async () => {
  const { ref } = await import('vue');
  const mode = ref('account');
  return {
    useWorkspace: () => ({
      mode,
      ensure: async () => {},
      generation: () => (mode.value === 'account' ? 1 : 2),
      identityWrite: async (work: () => Promise<unknown>) => work(),
    }),
  };
});
import DraftsPage from '../src/DraftsPage.vue';
import { localRepository } from '../src/adapters/local-repository';
import type { EntryDraft } from '@dayline/contracts';
import IdentityPage from '../src/IdentityPage.vue';
import { useAccount } from '../src/account';
import { api } from '../src/api';
import { useWorkspace } from '../src/records/workspace';
const user = {
  id: randomUUID(),
  displayName: '当前身份',
  profileVersion: 1,
  email: 'first@example.com',
  emailVerified: true,
  passwordEnabled: true,
  wechatBound: true,
  status: 'active',
  deletionDueAt: null,
  timeZone: 'Asia/Shanghai',
};
const meta = {
  requestId: 'identity-isolation',
  serverTime: '2026-10-26T20:00:00.000Z',
};
const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => {
  wrappers.forEach((w) => w.unmount());
  wrappers.length = 0;
  useAccount().clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
  useWorkspace().mode.value = 'account';
});
async function mountPage(path = '/identity') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/identity', component: IdentityPage },
      { path: '/auth/email-binding', component: IdentityPage },
      { path: '/auth/login', component: { template: '<div>login</div>' } },
    ],
  });
  await router.push(path);
  await router.isReady();
  const wrapper = mount(IdentityPage, { global: { plugins: [router] } });
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}
function committed(): MergePlan {
  const entryId = randomUUID(),
    categoryId = randomUUID(),
    sourceId = randomUUID(),
    id = randomUUID();
  const summary = {
    userId: sourceId,
    displayName: '受证来源',
    email: null,
    entries: 1,
    trash: 0,
    categories: 1,
    focusDays: 0,
  };
  return {
    id,
    operationId: randomUUID(),
    status: 'committed',
    planRevision: 1,
    planDigest: 'sha256:x',
    expiresAt: meta.serverTime,
    sourceSummary: summary,
    targetSummary: {
      ...summary,
      userId: user.id,
      displayName: user.displayName,
    },
    sourceDataVersion: '1',
    targetDataVersion: '1',
    targetCategories: [],
    categoryMappings: [],
    entries: [
      {
        id: entryId,
        title: '只能本人看到的来源标题',
        categoryId,
        startDate: '2026-10-01',
        endDate: null,
        version: 1,
        focusVersion: 1,
        deletedAt: null,
        purgeAfter: null,
        createdAt: meta.serverTime,
        updatedAt: meta.serverTime,
      },
    ],
    targetEntries: [],
    focusDays: [],
    targetFocusDays: [],
    canCommit: false,
    conflicts: [],
    counts: { retained: 1, reusedCategories: 0, newCategories: 0 },
    displayNameFrom: 'target',
    result: {
      targetUserId: user.id,
      sourceUserId: sourceId,
      dataVersion: '2',
      committedAt: meta.serverTime,
      reauthenticate: true,
    },
  };
}
it('a completed private plan is cleared synchronously on identity loss or switching to guest and never shown for an unrelated actor', async () => {
  const plan = committed();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: RequestInfo | URL) =>
      Response.json({
        data:
          path === '/api/v1/me'
            ? user
            : path === '/api/v1/account-merges'
              ? [
                  {
                    id: plan.id,
                    operationId: plan.operationId,
                    status: 'committed',
                    sourceUserId: plan.sourceSummary.userId,
                    targetUserId: user.id,
                    createdAt: meta.serverTime,
                    completedAt: meta.serverTime,
                  },
                ]
              : path === '/api/v1/me/email-binding-requests'
                ? []
                : plan,
        meta,
      }),
    ),
  );
  await useAccount().refresh();
  const wrapper = await mountPage();
  await wrapper
    .findAll('button')
    .find((b) => b.text().includes('查询原合并'))
    ?.trigger('click');
  await flushPromises();
  expect(wrapper.text()).toContain('只能本人看到的来源标题');
  await useAccount().refresh();
  await flushPromises();
  expect(wrapper.text()).toContain('只能本人看到的来源标题');
  expect(wrapper.text()).not.toContain('确认当前空间并恢复任务');
  useWorkspace().mode.value = 'guest';
  await flushPromises();
  expect(wrapper.text()).not.toContain('只能本人看到的来源标题');
  useWorkspace().mode.value = 'account';
  await flushPromises();
  api.setAccount(randomUUID());
  await flushPromises();
  expect(wrapper.text()).not.toContain('受证来源');
  expect(wrapper.text()).not.toContain('first@example.com');
});
it('an email link clears token from URL and all Vue history paths before verification, and displays only a mail-result page', async () => {
  const id = randomUUID(),
    token = 'x'.repeat(43),
    url = `/auth/email-binding?id=${id}&token=${token}`;
  window.history.replaceState(
    { current: url, back: url, forward: url, scroll: { top: 10 } },
    '',
    url,
  );
  const fetch = vi.fn(async (path: RequestInfo | URL) => {
    expect(window.location.search).toBe('');
    expect(JSON.stringify(window.history.state)).not.toContain(token);
    expect(path).toBe('/api/v1/me/email-binding-requests/verify');
    return Response.json({ data: { success: true }, meta });
  });
  vi.stubGlobal('fetch', fetch);
  const wrapper = await mountPage(url);
  expect(wrapper.text()).toContain('邮箱已验证');
  expect(wrapper.find('input[type=password]').exists()).toBe(false);
  expect(wrapper.find('input[type=email]').exists()).toBe(false);
  expect(window.history.state.scroll).toEqual({ top: 10 });
});

it.each(['success', 'failure'])(
  'fences a late %s from source draft storage after the user chooses another authorized merge',
  async (outcome) => {
    const first = committed(),
      second = committed(),
      source = first.sourceSummary.userId;
    let finish: ((value: EntryDraft[]) => void) | undefined,
      rejectRead: ((cause: Error) => void) | undefined;
    const draft: EntryDraft = {
      format: 'dayline-draft',
      localSchemaVersion: 1,
      environment: 'test',
      userId: source,
      draftId: randomUUID(),
      entryId: randomUUID(),
      baseEntryVersion: null,
      baseEntry: null,
      inputRevision: 1,
      persistedRevision: 1,
      savedLocallyAt: meta.serverTime,
      fields: {
        title: '旧选择的私密草稿',
        startDate: '2026-10-01',
        endDate: null,
        categoryId: randomUUID(),
      },
    };
    vi.spyOn(localRepository, 'drafts').mockImplementation((owner) =>
      owner === user.id
        ? Promise.resolve([])
        : new Promise<EntryDraft[]>((resolve, reject) => {
            finish = resolve;
            rejectRead = reject;
          }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: RequestInfo | URL) =>
        Response.json({
          data:
            path === '/api/v1/me'
              ? user
              : path === '/api/v1/account-merges'
                ? [first, second].map((p) => ({
                    id: p.id,
                    operationId: p.operationId,
                    status: 'committed',
                    sourceUserId: p.sourceSummary.userId,
                    targetUserId: user.id,
                    createdAt: meta.serverTime,
                    completedAt: meta.serverTime,
                  }))
                : {
                    mergeId: first.id,
                    sourceUserId: source,
                    targetUserId: user.id,
                    entries: [],
                    categories: [],
                  },
          meta,
        }),
      ),
    );
    await useAccount().refresh();
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/drafts', component: DraftsPage }],
    });
    await router.push('/drafts');
    await router.isReady();
    const wrapper = mount(DraftsPage, {
      global: {
        plugins: [router],
        stubs: {
          ReauthForm: {
            template:
              "<button @click=\"$emit('verified','controlled-proof')\">授权恢复</button>",
          },
        },
      },
    });
    wrappers.push(wrapper);
    await flushPromises();
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '查询已完成合并')
      ?.trigger('click');
    await flushPromises();
    const select = wrapper.get('select');
    await select.setValue(first.id);
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '授权恢复')
      ?.trigger('click');
    await flushPromises();
    expect(localRepository.drafts).toHaveBeenCalledWith(source);
    expect(finish).toBeTypeOf('function');
    await useAccount().refresh();
    await flushPromises();
    expect((select.element as HTMLSelectElement).value).toBe(first.id);
    await select.setValue(second.id);
    if (outcome === 'success') finish?.([draft]);
    else rejectRead?.(new Error('old storage failure'));
    await flushPromises();
    expect(wrapper.text()).not.toContain('旧选择的私密草稿');
    expect(wrapper.text()).not.toContain('无法授权恢复');
    expect((select.element as HTMLSelectElement).value).toBe(second.id);
  },
);

it('requires saving edited merge categories before commit and preserves the selection when review fails', async () => {
  const plan = committed(),
    sourceId = plan.entries[0]?.categoryId;
  if (!sourceId) throw new Error('source category');
  plan.status = 'preview';
  plan.result = null;
  plan.canCommit = true;
  plan.targetSummary.entries = 0;
  plan.targetSummary.categories = 0;
  plan.categoryMappings = [
    {
      sourceId,
      sourceName: '原分类',
      sourceColor: '#123456',
      targetId: null,
      name: '原分类',
      color: '#123456',
      needsReview: false,
    },
  ];
  let fail = true;
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: RequestInfo | URL, options?: RequestInit) => {
      calls.push(String(path));
      if (String(path).endsWith('/review')) {
        const input = mergeReviewSchema.parse(
          JSON.parse(String(options?.body)),
        );
        expect(input.categories[0]?.name).toBe('重新核对分类');
        if (fail)
          return Response.json(
            { error: { code: 'PREVIEW_STALE' } },
            { status: 409 },
          );
        return Response.json({
          data: {
            ...plan,
            planRevision: 2,
            planDigest: 'sha256:reviewed',
            categoryMappings: plan.categoryMappings.map((c) => ({
              ...c,
              name: '重新核对分类',
            })),
          },
          meta,
        });
      }
      return Response.json({
        data:
          path === '/api/v1/me'
            ? user
            : path === '/api/v1/account-merges'
              ? [
                  {
                    id: plan.id,
                    operationId: plan.operationId,
                    status: 'preview',
                    sourceUserId: plan.sourceSummary.userId,
                    targetUserId: user.id,
                    createdAt: meta.serverTime,
                    completedAt: null,
                  },
                ]
              : path === '/api/v1/me/email-binding-requests'
                ? []
                : plan,
        meta,
      });
    }),
  );
  await useAccount().refresh();
  const wrapper = await mountPage();
  await wrapper
    .findAll('button')
    .find((b) => b.text().includes('查询原合并'))
    ?.trigger('click');
  await flushPromises();
  const commit = wrapper
    .findAll('button')
    .find((b) => b.text() === '确认合并并保留双方');
  if (!commit) throw new Error('commit button');
  expect(commit.attributes('disabled')).toBeUndefined();
  const name = wrapper.get('[aria-label="合并分类名称"]');
  await name.setValue('重新核对分类');
  expect(commit.attributes('disabled')).toBeDefined();
  await commit.trigger('click');
  expect(calls.some((c) => c.endsWith('/commit'))).toBe(false);
  await wrapper
    .findAll('button')
    .find((b) => b.text() === '保存核对并更新预览')
    ?.trigger('click');
  await flushPromises();
  expect((name.element as HTMLInputElement).value).toBe('重新核对分类');
  expect(commit.attributes('disabled')).toBeDefined();
  fail = false;
  await wrapper
    .findAll('button')
    .find((b) => b.text() === '保存核对并更新预览')
    ?.trigger('click');
  await flushPromises();
  expect(commit.attributes('disabled')).toBeUndefined();
});
