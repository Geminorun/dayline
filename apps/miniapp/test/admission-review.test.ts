import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { importReviewSchema } from '@dayline/contracts';
import type { ImportJobDto } from '@dayline/contracts';
vi.mock('../src/admission', async () => {
  const { ref } = await import('vue');
  const state = {
    job: ref<ImportJobDto | null>(null),
    operation: ref(null),
    error: ref(''),
    busy: ref(false),
    begin: vi.fn(),
    action: vi.fn(),
  };
  return { useAdmission: () => state };
});
vi.mock('../src/workspace', async () => {
  const { ref } = await import('vue');
  return {
    useWorkspace: () => ({ snapshot: ref({ categories: [] }), load: vi.fn() }),
  };
});
import AdmissionReview from '../src/components/AdmissionReview.vue';
import { useAdmission } from '../src/admission';
afterEach(() => {
  useAdmission().job.value = null;
  useAdmission().busy.value = false;
  vi.resetAllMocks();
});
it('requires review after choosing skip, keeps failed choices and locks all selections while a write is pending', async () => {
  const now = '2026-10-26T20:00:00.000Z',
    categoryId = randomUUID();
  const plan: ImportJobDto = {
    id: randomUUID(),
    clientOperationId: randomUUID(),
    kind: 'guest',
    status: 'preview',
    disposition: 'preview_required',
    inputDigest: 'input',
    planDigest: 'plan',
    planRevision: 1,
    baseDataVersion: '1',
    expiresAt: now,
    canCommit: true,
    sourceSummary: { entries: 1, categories: 1, focusDays: 0 },
    targetSummary: { entries: 0, categories: 0, focusDays: 0 },
    categoryMappings: [
      {
        sourceId: categoryId,
        candidateId: randomUUID(),
        targetId: null,
        name: '原分类',
        color: '#123456',
        seedKey: null,
        needsReview: false,
      },
    ],
    rows: [
      {
        sourceKey: 'source',
        sourceDigest: 'digest',
        candidateId: randomUUID(),
        source: {
          id: randomUUID(),
          title: '待接入记录',
          categoryId,
          startDate: '2026-10-01',
          endDate: null,
          version: 1,
          focusVersion: 1,
          deletedAt: null,
          purgeAfter: null,
          createdAt: now,
          updatedAt: now,
        },
        focusDays: [],
        action: 'create_copy',
        previousTargetId: null,
        reason: null,
      },
    ],
    result: null,
  };
  const state = useAdmission();
  state.job.value = plan;
  let finish: (() => void) | undefined,
    fail = true;
  vi.mocked(state.action).mockImplementation(async (kind, input) => {
    if (kind !== 'review') return;
    const selection = importReviewSchema.parse(input);
    expect(selection.rows[0]?.action).toBe('skip');
    state.busy.value = true;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    if (fail) state.error.value = 'controlled review failure';
    else
      state.job.value = {
        ...plan,
        planRevision: 2,
        rows: plan.rows.map((row) => ({ ...row, action: 'skip' })),
      };
    state.busy.value = false;
  });
  const w = mount(AdmissionReview);
  const find = (label: string) => {
    const b = w.findAll('button').find((button) => button.text() === label);
    if (!b) throw new Error(label);
    return b;
  };
  const commit = find('确认接入');
  expect(commit.attributes('disabled')).toBeUndefined();
  const row = w.findAll('picker')[1];
  if (!row) throw new Error('row picker');
  await row.trigger('change', { detail: { value: 0 } });
  expect(commit.attributes('disabled')).toBeDefined();
  await commit.trigger('click');
  expect(state.action).not.toHaveBeenCalled();
  await find('更新并核对计划').trigger('click');
  await flushPromises();
  expect(commit.attributes('disabled')).toBeDefined();
  for (const control of w.findAll('input, picker'))
    expect(control.attributes('disabled')).toBeDefined();
  finish?.();
  await flushPromises();
  expect(row.text()).toContain('跳过来源');
  expect(commit.attributes('disabled')).toBeDefined();
  // Reading the same server revision must not silently discard the failed local choice.
  state.job.value = { ...plan };
  await flushPromises();
  expect(row.text()).toContain('跳过来源');
  fail = false;
  await find('更新并核对计划').trigger('click');
  await flushPromises();
  finish?.();
  await flushPromises();
  expect(commit.attributes('disabled')).toBeUndefined();
  state.busy.value = true;
  await flushPromises();
  await commit.trigger('click');
  expect(state.action).toHaveBeenCalledTimes(2);
  w.unmount();
});
