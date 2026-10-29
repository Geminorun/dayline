import { mount, flushPromises } from '@vue/test-utils';
import { expect, it } from 'vitest';
import TimelineView from '../src/records/TimelineView.vue';
const now = '2026-10-28T00:00:00.000Z';
const entry = {
  id: 'entry',
  title: '一段经历',
  categoryId: 'reading',
  startDate: '2026-01-01',
  endDate: null,
  version: 1,
  focusVersion: 1,
  deletedAt: null,
  purgeAfter: null,
  createdAt: now,
  updatedAt: now,
};
it('shows lifetime counts separately from visible dots and opens only the selected exact dates', async () => {
  const focusDays = [
    '2026-09-01',
    '2026-10-03',
    '2026-10-12',
    '2026-10-28',
  ].map((date) => ({ entryId: entry.id, date, focused: true, version: 1 }));
  const w = mount(TimelineView, {
    props: {
      entries: [entry],
      focusDays: [
        ...focusDays,
        { entryId: entry.id, date: '2026-10-25', focused: false, version: 1 },
      ],
      today: '2026-10-28',
      scale: 'month',
      anchor: '2026-10-28',
    },
    attachTo: document.body,
    global: { stubs: { Teleport: true } },
  });
  try {
    await flushPromises();
    expect(w.get('.gantt-focus-total').text()).toBe('累计重点 4 天');
    expect(w.findAll('.timeline-focus-marker')).toHaveLength(2);
    const cluster = w.get('.timeline-focus-marker.is-cluster');
    expect(cluster.get('.timeline-focus-dot').text()).toBe('2');
    expect(cluster.attributes('title')).toContain('2 个重点日');
    expect(
      w
        .findAll('.focus-marker')
        .every((marker) => !marker.text().includes('★')),
    ).toBe(true);
    await cluster.trigger('click');
    await flushPromises();
    expect(w.get('[role=dialog]').text()).toContain('重点日期 · 2 天');
    expect(
      w.findAll('[data-focus-date]').map((button) => button.text()),
    ).toEqual(['2026-10-03', '2026-10-12']);
    expect(cluster.attributes('aria-expanded')).toBe('true');
    await w.setProps({ entries: [{ ...entry }], focusDays: [...focusDays] });
    expect(cluster.attributes('aria-expanded')).toBe('true');
    expect(w.findAll('[data-focus-date]')).toHaveLength(2);
    await w.get('[aria-label="关闭重点详情"]').trigger('click');
    expect(document.activeElement).toBe(cluster.element);
    const single = w.get('.timeline-focus-marker:not(.is-cluster)');
    expect(single.get('.timeline-focus-dot').text()).toBe('');
    expect(single.attributes('aria-label')).toContain('2026-10-28');
    await single.trigger('click');
    await flushPromises();
    await w.get('[aria-label="回看 2026-10-28"]').trigger('click');
    expect(w.emitted('day')).toEqual([['2026-10-28']]);
    expect(w.findAll('[data-focus-date]')).toHaveLength(0);
    expect(w.emitted('camera')).toBeUndefined();
    expect(w.emitted('view')).toBeUndefined();
    await cluster.trigger('click');
    await flushPromises();
    await w.setProps({ focusDays: [] });
    expect(w.get('.gantt-focus-total').text()).toBe('累计重点 0 天');
    expect(w.findAll('.timeline-focus-marker')).toHaveLength(0);
    expect(w.findAll('[data-focus-date]')).toHaveLength(0);
  } finally {
    w.unmount();
  }
});
