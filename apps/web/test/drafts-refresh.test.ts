import 'fake-indexeddb/auto';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import EntryEditor from '../src/records/EntryEditor.vue';
import { useAccount } from '../src/account';
import { api } from '../src/api';
import {
  localEnvironment,
  localRepository,
} from '../src/adapters/local-repository';
import { useWorkspace } from '../src/records/workspace';
import type {
  CreateEntryInput,
  PatchEntryInput,
  EntryDraft,
} from '@dayline/contracts';
const userId = '63a561bd-2302-485d-8d89-cea248ffbdf1',
  categoryId = '76c7987d-aadb-4001-922f-26ea52d9f0e8',
  entryId = '8215ed08-99a1-460d-a4da-3e4fa674245f',
  time = '2026-10-26T04:00:00.000Z';
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
  title: '旧标题',
  startDate: '2026-10-01',
  endDate: null,
  version: 1,
  focusVersion: 1,
  deletedAt: null,
  purgeAfter: null,
  createdAt: time,
  updatedAt: time,
};
const profile = {
  id: userId,
  displayName: '测试',
  profileVersion: 1,
  email: 'test@example.com',
  emailVerified: true,
  passwordEnabled: true,
  wechatBound: false,
  status: 'active',
  deletionDueAt: null,
  timeZone: 'Asia/Shanghai',
};
const wrappers: ReturnType<typeof mount>[] = [];
function deferred<T>() {
  let resolve: (v: T) => void = () => {};
  return {
    promise: new Promise<T>((r) => (resolve = r)),
    resolve: (v: T) => resolve(v),
  };
}
beforeEach(async () => {
  sessionStorage.clear();
  await localRepository.database.table('values').clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        data: profile,
        meta: { requestId: 'me', serverTime: time },
      }),
    ),
  );
  await useAccount().refresh(true);
});
afterEach(async () => {
  wrappers.splice(0).forEach((w) => w.unmount());
  await flushPromises();
  useAccount().clear();
  useWorkspace().lifecycle(false);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function editor(
  save: (
    id: string,
    input: CreateEntryInput | PatchEntryInput,
    creating: boolean,
  ) => Promise<unknown>,
) {
  const w = mount(EntryEditor, {
    props: { entry, categories: [category], today: '2026-10-26', save },
  });
  wrappers.push(w);
  return w;
}
describe('durable manual drafts and identity transitions', () => {
  it('flushes the last input to its original account when identity expires before debounce and never exposes it as another account draft', async () => {
    const w = editor(async () => {});
    await w.get('input').setValue('失效前最后输入');
    api.invalidate();
    w.unmount();
    wrappers.length = 0;
    await vi.waitFor(async () =>
      expect((await localRepository.drafts(userId)).at(-1)?.fields.title).toBe(
        '失效前最后输入',
      ),
    );
    expect(
      await localRepository.drafts('63a561bd-2302-485d-8d89-cea248ffbdf2'),
    ).toEqual([]);
  });
  it('retains input typed during delayed cleanup and rebases only on its own confirmed save response', async () => {
    const cleanup = deferred<void>(),
      realRemove = localRepository.removeDraft.bind(localRepository);
    vi.spyOn(localRepository, 'removeDraft').mockImplementation(
      async (...args) => {
        await cleanup.promise;
        await realRemove(...args);
      },
    );
    const save = vi.fn(
      async (_id: string, _input: CreateEntryInput | PatchEntryInput) => {
        void _id;
        void _input;
        return {
          data: {
            entry: { ...entry, title: '请求输入', version: 2 },
            focusDays: [],
          },
        };
      },
    );
    const w = editor(save);
    await w.get('input').setValue('请求输入');
    await w.get('form').trigger('submit');
    await vi.waitFor(() =>
      expect(localRepository.removeDraft).toHaveBeenCalled(),
    );
    await w.get('input').setValue('清理期间新输入');
    cleanup.resolve();
    await flushPromises();
    await vi.waitFor(async () =>
      expect((await localRepository.drafts(userId)).at(-1)?.fields.title).toBe(
        '清理期间新输入',
      ),
    );
    expect(w.emitted('saved')).toBeUndefined();
    expect(
      (await localRepository.drafts(userId)).at(-1)?.baseEntryVersion,
    ).toBe(2);
    await vi.waitFor(() =>
      expect(
        w.get('button[type=submit]').attributes('disabled'),
      ).toBeUndefined(),
    );
    await w.setProps({ entry: { ...entry, title: '外部刷新', version: 99 } });
    await w.get('form').trigger('submit');
    await flushPromises();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]?.[1]).toMatchObject({
      expectedVersion: 2,
      title: '清理期间新输入',
    });
  });
  it('keeps two editor branches independent and exposes a persistent storage error without redundant file actions', async () => {
    const first = editor(async () => {}),
      second = editor(async () => {});
    await first.get('input').setValue('标签甲');
    await second.get('input').setValue('标签乙');
    await first.get('form').trigger('focusout');
    await second.get('form').trigger('focusout');
    await vi.waitFor(async () =>
      expect((await localRepository.drafts(userId)).length).toBe(2),
    );
    vi.spyOn(localRepository, 'putDraft').mockRejectedValue(new Error('quota'));
    await first.get('input').setValue('尚未写入');
    await first.get('form').trigger('focusout');
    await flushPromises();
    expect(first.text()).toContain('本机草稿暂存失败');
    expect(first.find('button[aria-label="下载草稿"]').exists()).toBe(false);
    expect(first.text()).toContain('手动保留输入');
    expect(first.get('input').element.value).toBe('尚未写入');
  });
  it('ignores an account-switch intent when the user selected guest while /me was pending', async () => {
    const pending = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => pending.promise),
    );
    const workspace = useWorkspace(),
      entering = workspace.switchMode('account');
    await workspace.switchMode('guest');
    pending.resolve(
      Response.json({
        data: profile,
        meta: { requestId: 'me', serverTime: time },
      }),
    );
    await entering;
    expect(workspace.mode.value).toBe('guest');
    expect(workspace.snapshot.value?.userId).not.toBe(userId);
  });
});

describe('draft-list account space isolation', () => {
  it('hides drafts immediately when switching to guest and refuses direct guest loading even with a valid Cookie identity', async () => {
    const { default: DraftsPage } = await import('../src/DraftsPage.vue');
    const workspace = useWorkspace();
    workspace.mode.value = 'account';
    const draft = {
      environment: (await import('../src/adapters/local-repository'))
        .localEnvironment,
      userId,
      format: 'dayline-draft' as const,
      localSchemaVersion: 1 as const,
      draftId: crypto.randomUUID(),
      entryId: entryId,
      baseEntryVersion: null,
      baseEntry: null,
      inputRevision: 1,
      persistedRevision: 1,
      savedLocallyAt: time,
      fields: {
        title: 'A私人草稿',
        startDate: '2026-10-01',
        endDate: null,
        categoryId,
      },
    };
    await localRepository.putDraft(draft);
    const w = mount(DraftsPage, { global: { stubs: { RouterLink: true } } });
    wrappers.push(w);
    await vi.waitFor(() => expect(w.text()).toContain('A私人草稿'));
    await workspace.switchMode('guest');
    await flushPromises();
    expect(w.text()).not.toContain('A私人草稿');
    expect(w.text()).toContain('请先明确进入');
    const direct = mount(DraftsPage, {
      global: { stubs: { RouterLink: true } },
    });
    wrappers.push(direct);
    await flushPromises();
    expect(direct.text()).not.toContain('A私人草稿');
    expect(direct.text()).toContain('请先明确进入');
  });
});

describe('restored draft route guards with real RouterView', () => {
  it('finishes /drafts navigation after a delayed flush, even when that destination discovers an expired session', async () => {
    const { default: DraftsPage } = await import('../src/DraftsPage.vue'),
      { localEnvironment } = await import('../src/adapters/local-repository');
    const workspace = useWorkspace();
    workspace.mode.value = 'account';
    const restored: EntryDraft = {
      environment: localEnvironment,
      userId,
      format: 'dayline-draft',
      localSchemaVersion: 1,
      draftId: crypto.randomUUID(),
      entryId,
      baseEntryVersion: 1,
      baseEntry: entry,
      inputRevision: 1,
      persistedRevision: 1,
      savedLocallyAt: time,
      fields: {
        title: '恢复的原草稿',
        startDate: entry.startDate,
        endDate: null,
        categoryId,
      },
    };
    await localRepository.putDraft(restored);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: '/entries/:id',
          component: EntryEditor,
          props: () => ({
            entry,
            categories: [category],
            today: '2026-10-26',
            draft: restored,
            save: async () => {},
          }),
        },
        { path: '/drafts', component: DraftsPage },
      ],
    });
    await router.push({
      path: `/entries/${entryId}`,
      query: { draftId: restored.draftId },
    });
    await router.isReady();
    const w = mount(
      defineComponent({
        components: { RouterView },
        template: '<RouterView/>',
      }),
      { global: { plugins: [router] } },
    );
    wrappers.push(w);
    const gate = deferred<void>(),
      put = localRepository.putDraft.bind(localRepository);
    vi.spyOn(localRepository, 'putDraft').mockImplementationOnce(
      async (value) => {
        await gate.promise;
        await put(value);
      },
    );
    const replace = vi.spyOn(router, 'replace');
    await w.get('input').setValue('路由离开前最后输入');
    await w.get('form').trigger('focusout');
    const navigation = router.push('/drafts');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 }),
      ),
    );
    gate.resolve();
    await navigation;
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/drafts');
    expect(replace).not.toHaveBeenCalled();
    await vi.waitFor(async () =>
      expect(
        (await localRepository.drafts(userId)).some(
          (d) => d.fields.title === '路由离开前最后输入',
        ),
      ).toBe(true),
    );
    expect(
      await localRepository.draft(userId, restored.draftId),
    ).not.toBeNull();
    expect(w.text()).not.toContain('路由离开前最后输入');
    expect(workspace.mode.value).toBe('guest');
  });
});

describe('acknowledged baseline while draft storage is pending', () => {
  it('rewrites the same input revision with its own newly confirmed baseline after an older local write completes', async () => {
    const response = deferred<unknown>(),
      save = vi.fn(() => response.promise),
      w = editor(save);
    await w.get('input').setValue('请求中的字段');
    await w.get('form').trigger('submit');
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    const local = deferred<void>(),
      put = localRepository.putDraft.bind(localRepository);
    vi.spyOn(localRepository, 'putDraft').mockImplementationOnce(
      async (draft) => {
        await local.promise;
        await put(draft);
      },
    );
    await w.get('input').setValue('已开始本机写入的新字段');
    await w.get('form').trigger('focusout');
    await vi.waitFor(() =>
      expect(localRepository.putDraft).toHaveBeenCalledOnce(),
    );
    response.resolve({
      data: {
        entry: { ...entry, title: '请求中的字段', version: 2 },
        focusDays: [],
      },
    });
    await flushPromises();
    local.resolve();
    await vi.waitFor(async () =>
      expect(
        (await localRepository.drafts(userId)).some(
          (d) =>
            d.fields.title === '已开始本机写入的新字段' &&
            d.baseEntryVersion === 2 &&
            d.baseEntry?.title === '请求中的字段',
        ),
      ).toBe(true),
    );
    expect(w.emitted('saved')).toBeUndefined();
  });
});

describe('acknowledged restored edits', () => {
  it.each([false, true])(
    'cleans only the restored revision after saving, preserving newer source edits: %s',
    async (changedElsewhere) => {
      const restored: EntryDraft = {
        environment: localEnvironment,
        userId,
        format: 'dayline-draft',
        localSchemaVersion: 1,
        draftId: crypto.randomUUID(),
        entryId,
        baseEntryVersion: entry.version,
        baseEntry: entry,
        inputRevision: 1,
        persistedRevision: 1,
        savedLocallyAt: time,
        fields: {
          title: '恢复后保存',
          startDate: entry.startDate,
          endDate: entry.endDate,
          categoryId,
        },
      };
      await localRepository.putDraft(restored);
      const save = vi.fn(async () => {
        if (changedElsewhere)
          await localRepository.putDraft({
            ...restored,
            inputRevision: 2,
            persistedRevision: 2,
            fields: { ...restored.fields, title: '另一个窗口的更新' },
          });
        return {
          data: {
            entry: { ...entry, title: '恢复后保存', version: 2 },
            alreadyExists: false,
          },
        };
      });
      const wrapper = mount(EntryEditor, {
        props: {
          entry,
          categories: [category],
          today: '2026-10-26',
          draft: restored,
          save,
        },
      });
      wrappers.push(wrapper);
      await wrapper.get('form').trigger('submit');
      await vi.waitFor(() => expect(wrapper.emitted('saved')).toHaveLength(1));
      const source = await localRepository.draft(userId, restored.draftId);
      if (changedElsewhere)
        expect(source?.fields.title).toBe('另一个窗口的更新');
      else expect(source).toBeNull();
    },
  );
});
