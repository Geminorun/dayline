import { mount } from '@vue/test-utils';
import { expect, it } from 'vitest';
import EntryCard from '../src/components/EntryCard.vue';
import type { EntryDto } from '@dayline/contracts';
it('keeps a future-ending entry ongoing and allows explicitly ending it today', () => {
  const entry: EntryDto = {
    id: 'future',
    title: '阶段计划',
    categoryId: 'c',
    startDate: '2026-10-01',
    endDate: '2026-11-01',
    version: 1,
    focusVersion: 1,
    deletedAt: null,
    purgeAfter: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
  const w = mount(EntryCard, {
    props: {
      entry,
      category: '工作',
      color: '#6C9BCE',
      today: '2026-10-29',
      date: '2026-10-29',
      focused: false,
      busy: false,
      readonly: false,
    },
  });
  try {
    expect(w.text()).toContain('进行中');
    expect(w.find('[aria-label="今天结束"]').exists()).toBe(true);
  } finally {
    w.unmount();
  }
});
