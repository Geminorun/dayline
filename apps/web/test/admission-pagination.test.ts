import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { mount } from '@vue/test-utils';
import { afterEach, describe, it, expect } from 'vitest';
import AdmissionReview from '../src/AdmissionReview.vue';
import { useAdmission } from '../src/admission';
import { createGuestPackage, mutateGuest } from '@dayline/contracts';
import type { ImportJobDto } from '@dayline/contracts';
afterEach(() => {
  useAdmission().job.value = null;
});
describe('bounded complete import preview', () => {
  it('renders at most 50 rows out of 10000 and retains choices across pages', async () => {
    const source = createGuestPackage(randomUUID, '2026-10-26T04:00:00.000Z'),
      category = source.categories[0];
    if (!category) throw new Error('category');
    const data = mutateGuest(
        source,
        {
          kind: 'create',
          input: {
            id: randomUUID(),
            title: '预览行',
            categoryId: category.id,
            startDate: '2026-10-01',
            endDate: null,
          },
        },
        source.savedAt,
      ),
      entry = data.entries[0];
    if (!entry) throw new Error('entry');
    const job: ImportJobDto = {
      id: randomUUID(),
      clientOperationId: randomUUID(),
      kind: 'guest',
      status: 'preview',
      disposition: 'preview_required',
      inputDigest: 'digest',
      planDigest: 'digest',
      planRevision: 1,
      baseDataVersion: '1',
      expiresAt: source.savedAt,
      canCommit: false,
      sourceSummary: { entries: 10000, categories: 1, focusDays: 0 },
      targetSummary: { entries: 1, categories: 6, focusDays: 0 },
      categoryMappings: [],
      rows: Array.from({ length: 10000 }, (_, index) => ({
        sourceKey: String(index),
        sourceDigest: 'digest',
        candidateId: randomUUID(),
        source: { ...entry, title: `预览行${index}` },
        focusDays: [],
        action: 'needs_review',
        previousTargetId: null,
        reason: null,
      })),
      result: null,
    };
    useAdmission().job.value = job;
    const w = mount(AdmissionReview);
    expect(w.findAll('details')).toHaveLength(50);
    expect(w.text()).toContain('共 10000 条');
    await w.findAll('details')[0]?.get('select').setValue('skip');
    const next = w
      .findAll('button')
      .find((b) => b.attributes('aria-label') === '下一页记录');
    await next?.trigger('click');
    expect(w.findAll('details')).toHaveLength(50);
    expect(w.text()).toContain('预览行50');
    const previous = w
      .findAll('button')
      .find((b) => b.attributes('aria-label') === '上一页记录');
    await previous?.trigger('click');
    expect(w.findAll('details')[0]?.get('select').element.value).toBe('skip');
    w.unmount();
  });
});
