import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGuestPackage,
  guestSnapshot,
  mutateGuest,
} from '@dayline/contracts';
import { createLocalFilePlan, parseImportFile } from '@dayline/contracts/files';
import DataPage from '../src/DataPage.vue';
import { useWorkspace } from '../src/records/workspace';
import { guestRepository } from '../src/adapters/guest-repository';
import {
  localRepository,
  localEnvironment,
} from '../src/adapters/local-repository';
import { api, cookieTransport } from '../src/api';
vi.mock('../src/records/workspace', async () => {
  const { ref } = await import('vue');
  const state = {
    mode: ref('guest'),
    identityState: ref('guest'),
    snapshot: ref(null),
    guest: ref(null),
    readonly: ref(false),
    generation: () => 0,
    ensure: async () => {},
    reload: vi.fn(),
  };
  return { useWorkspace: () => state };
});
const now = new Date().toISOString(),
  space = useWorkspace();
const wrappers: ReturnType<typeof mount>[] = [];
beforeEach(async () => {
  api.invalidate();
  space.mode.value = 'guest';
  space.identityState.value = 'guest';
  space.guest.value = createGuestPackage(randomUUID, now);
  space.snapshot.value = guestSnapshot(space.guest.value, '2026-10-26');
  await guestRepository.database.table('packages').clear();
  await guestRepository.commit(space.guest.value, null);
  await localRepository.database.table('values').clear();
});
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  api.invalidate();
});
const button = (w: ReturnType<typeof mount>, name: string) => {
  const b = w
    .findAll('button')
    .find((b) => b.text() === name || b.attributes('aria-label') === name);
  if (!b) throw new Error('missing ' + name);
  return b;
};
function page() {
  const w = mount(DataPage, {
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  });
  wrappers.push(w);
  return w;
}
async function pending(text: string) {
  const data = space.guest.value;
  if (!data) throw new Error('guest');
  const p = createLocalFilePlan(
    parseImportFile(text, 'csv', now),
    data,
    String(data.packageRevision),
    randomUUID,
    now,
    new Map(),
  );
  await guestRepository.putFileOperation({
    environment: localEnvironment,
    scope: 'guest',
    ownerId: data.guestDatasetId,
    clientOperationId: p.clientOperationId,
    jobId: p.id,
    format: 'csv',
    text,
    status: 'pending',
    localPlan: p,
  });
  return p;
}
describe('Web file preview and explicit confirmation', () => {
  it('bounds 10000 preview rows to 50, keeps page choices, and applies only after review and final confirmation', async () => {
    await pending(
      'title,start_date,category_name,category_color\n' +
        Array.from(
          { length: 10000 },
          (_, i) => `候选${i},2026-10-01,游戏,#8B80D8`,
        ).join('\n'),
    );
    const w = page();
    await flushPromises();
    expect(w.findAll('.file-row')).toHaveLength(0);
    await button(w, '查看详情').trigger('click');
    expect(w.findAll('.file-row')).toHaveLength(50);
    expect(w.text()).toContain('候选0');
    expect((await guestRepository.read())?.entries).toHaveLength(0);
    await button(w, '跳过此项').trigger('click');
    await button(w, '下一页').trigger('click');
    expect(w.text()).toContain('候选50');
    await button(w, '上一页').trigger('click');
    expect(w.findAll('.file-row')[0]?.text()).toContain('已选择');
    await button(w, '返回摘要').trigger('click');
    expect(button(w, '导入 10000 条').attributes('disabled')).toBeDefined();
  }, 20000);
  it('shows actual current/desired field and focus values, requires explicit current version review, and keeps local source intact on CAS failure', async () => {
    let data = space.guest.value;
    if (!data) throw new Error('guest');
    const id = randomUUID();
    data = mutateGuest(
      data,
      {
        kind: 'create',
        input: {
          id,
          title: '当前名称',
          categoryId: data.categories[0]?.id ?? '',
          startDate: '2026-10-01',
          endDate: null,
        },
      },
      now,
    );
    data = mutateGuest(
      data,
      {
        kind: 'focus',
        id,
        date: '2026-10-20',
        input: {
          focused: true,
          expectedEntryVersion: 1,
          expectedFocusVersion: 0,
        },
      },
      now,
    );
    await guestRepository.commit(data, 1);
    space.guest.value = data;
    space.snapshot.value = guestSnapshot(data, '2026-10-26');
    await pending(
      `entry_id,title,start_date,focus_dates,category_id\n${id},文件名称,2026-10-01,,${data.categories[0]?.id}`,
    );
    const w = page();
    await flushPromises();
    await button(w, '处理待确认内容').trigger('click');
    expect(w.get('.file-diff').text()).toContain('当前名称');
    expect(w.get('.file-diff').text()).toContain('文件名称');
    expect(w.get('.file-diff').text()).toContain('游戏');
    expect(w.get('.file-row details').text()).toContain('2026-10-20');
    await button(w, '已核对当前内容，更新此项').trigger('click');
    await button(w, '保存处理结果').trigger('click');
    await flushPromises();
    await vi.waitFor(() =>
      expect(
        button(w, '导入 1 条').attributes('disabled'),
        w.text(),
      ).toBeUndefined(),
    );
    await guestRepository.commit(
      { ...data, packageRevision: data.packageRevision + 1 },
      data.packageRevision,
    );
    await button(w, '导入 1 条').trigger('click');
    await flushPromises();
    await vi.waitFor(() =>
      expect(w.get('[role="alert"]').text()).toContain('重新预览'),
    );
    expect((await guestRepository.read())?.entries[0]?.title).toBe('当前名称');
    expect(w.text()).not.toContain('正在整体保存');
    expect(
      (await guestRepository.fileOperation(data.guestDatasetId))?.text,
    ).toContain('文件名称');
  });
  it('prompts for drafts without automatic writes and blocks a late download after account generation changes', async () => {
    const id = randomUUID();
    api.setAccount(id);
    space.mode.value = 'account';
    space.identityState.value = 'verified';
    if (space.snapshot.value)
      space.snapshot.value = { ...space.snapshot.value, userId: id };
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
        title: '私人草稿',
        startDate: '',
        endDate: null,
        categoryId: '',
      },
    });
    const w = page();
    await flushPromises();
    let resolve: (v: Response) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const createObjectURL = vi.fn(() => 'blob:test');
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = createObjectURL;
        static revokeObjectURL = vi.fn();
      },
    );
    await button(w, '导出完整 JSON').trigger('click');
    await flushPromises();
    expect(w.text()).toContain('有尚未提交');
    expect(fetchMock).not.toHaveBeenCalled();
    await button(w, '继续只导出云端记录').trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    api.setAccount(randomUUID());
    resolve(
      new Response('{}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': 'attachment; filename="dayline.json"',
        },
      }),
    );
    await flushPromises();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(w.text()).not.toContain('私人草稿');
  });
  it('preserves the CSV BOM in an actual download response and keeps HTTP error JSON as an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('\ufeffschema_version,title\r\n1,中文', {
            headers: {
              'Content-Type': 'text/csv; charset=utf-8',
              'Content-Disposition': 'attachment; filename="dayline.csv"',
            },
          }),
      ),
    );
    const response = await cookieTransport({
      path: '/api/v1/exports/csv',
      method: 'GET',
      headers: {},
    });
    expect(
      typeof response.body === 'string' && response.body.charCodeAt(0),
    ).toBe(0xfeff);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    const error = await cookieTransport({
      path: '/api/v1/exports/csv',
      method: 'GET',
      headers: {},
    });
    expect(error.status).toBe(401);
    expect(error.body).toEqual({ error: { code: 'UNAUTHENTICATED' } });
  });
  it('recovers stale old-epoch tasks without clearing the valid actor and explicitly creates a new operation from the preserved original file', async () => {
    const id = randomUUID(),
      oldOperation = randomUUID(),
      text =
        'title,start_date,category_name,category_color\n原始文件,2026-10-01,游戏,#8B80D8';
    api.setAccount(id);
    space.mode.value = 'account';
    space.identityState.value = 'verified';
    if (space.snapshot.value)
      space.snapshot.value = { ...space.snapshot.value, userId: id };
    await localRepository.putFileOperation({
      environment: localEnvironment,
      scope: 'account',
      ownerId: id,
      clientOperationId: oldOperation,
      jobId: randomUUID(),
      format: 'csv',
      text,
      status: 'pending',
      localPlan: null,
    });
    const fetchMock = vi.fn(
      async (path: RequestInfo | URL, init?: RequestInit) => {
        if (String(path).includes('/imports/preview')) {
          expect(init?.body).toBe(text);
          const cloud = space.guest.value;
          if (!cloud) throw new Error('guest');
          const p = createLocalFilePlan(
            parseImportFile(text, 'csv', now),
            cloud,
            '1',
            randomUUID,
            now,
            new Map(),
          );
          p.clientOperationId =
            new Headers(init?.headers).get('X-Dayline-Operation-ID') ?? '';
          return new Response(
            JSON.stringify({
              data: p,
              meta: { requestId: 'fresh-preview', serverTime: now },
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            error: { code: 'PREVIEW_STALE' },
            meta: { requestId: 'old-task', serverTime: now },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    const w = page();
    await vi.waitFor(() =>
      expect(w.find('[role="alert"]').text()).toContain('重新建立预览'),
    );
    expect(api.getAccount()).toBe(id);
    await button(w, '保留原文件，重新建立预览').trigger('click');
    await vi.waitFor(async () => {
      const saved = await localRepository.fileOperation(id);
      expect(saved?.clientOperationId).not.toBe(oldOperation);
      expect(saved?.jobId).not.toBeNull();
      expect(saved?.text).toBe(text);
    });
    expect(api.getAccount()).toBe(id);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

it('requires category edits to be reviewed, keeps failed review input and locks category controls during commit', async () => {
  await pending(
    'title,start_date,category_name,category_color\n分类核对,2026-10-01,新增分类,#123456\n',
  );
  const w = page();
  await flushPromises();
  expect(button(w, '导入 1 条').attributes('disabled')).toBeUndefined();
  await button(w, '查看详情').trigger('click');
  const name = w.get('.file-category input');
  await name.setValue('已核对新分类');
  await button(w, '返回摘要').trigger('click');
  expect(button(w, '导入 1 条').attributes('disabled')).toBeDefined();
  const originalCommit = guestRepository.commitFile.bind(guestRepository),
    write = vi.spyOn(guestRepository, 'commitFile');
  await button(w, '导入 1 条').trigger('click');
  expect(write).not.toHaveBeenCalled();
  await button(w, '查看详情').trigger('click');
  vi.spyOn(guestRepository, 'read').mockRejectedValueOnce(
    new Error('controlled read failure'),
  );
  await button(w, '保存处理结果').trigger('click');
  await flushPromises();
  expect(
    (w.get('.file-category input').element as HTMLInputElement).value,
  ).toBe('已核对新分类');
  await button(w, '保存处理结果').trigger('click');
  await flushPromises();
  await vi.waitFor(() =>
    expect(
      button(w, '导入 1 条').attributes('disabled'),
      w.text(),
    ).toBeUndefined(),
  );
  let finish: (() => void) | undefined;
  write.mockImplementationOnce(async (...args) => {
    await new Promise<void>((resolve) => (finish = resolve));
    return originalCommit(...args);
  });
  await button(w, '导入 1 条').trigger('click');
  await flushPromises();
  expect(w.get('input[type=file]').attributes('disabled')).toBeDefined();
  expect(button(w, '查看详情').attributes('disabled')).toBeDefined();
  expect(finish).toBeTypeOf('function');
  finish?.();
  await flushPromises();
  expect(
    (await guestRepository.read())?.categories.some(
      (c) => c.name === '已核对新分类',
    ),
  ).toBe(true);
  expect(write).toHaveBeenCalledTimes(1);
});

it('imports a clean missing-color file in one click without opening details or submitting a review', async () => {
  await pending(
    'title,start_date,category_name\n旅行记录,2026-10-01,旅行\n第二条,2026-10-02,摄影',
  );
  const w = page();
  await flushPromises();
  expect(w.find('.file-category').exists()).toBe(false);
  expect(w.find('.file-row').exists()).toBe(false);
  expect(w.text()).toContain('共 2 条记录');
  await button(w, '导入 2 条').trigger('click');
  await vi.waitFor(async () =>
    expect((await guestRepository.read())?.entries).toHaveLength(2),
  );
  const data = await guestRepository.read();
  const created =
    data?.categories.filter((c) => ['旅行', '摄影'].includes(c.name)) ?? [];
  expect(created).toHaveLength(2);
  expect(new Set(created.map((c) => c.color)).size).toBe(2);
  expect(w.text()).toContain('导入完成');
});
