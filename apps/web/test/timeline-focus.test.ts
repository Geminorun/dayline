import { mount, flushPromises } from '@vue/test-utils';
import { expect, it, vi } from 'vitest';
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
it.each([
  [1, 1],
  [2, 2],
  [3, 2],
  [4, 3],
  [7, 3],
  [8, 4],
  [28, 4],
])(
  'maps %i focused days to contribution level %i without visible numbers',
  async (count, level) => {
    const focusDays = Array.from({ length: count }, (_, i) => ({
      entryId: entry.id,
      date: `2026-10-${String(i + 1).padStart(2, '0')}`,
      focused: true,
      version: 1,
    }));
    const w = mount(TimelineView, {
      props: {
        entries: [entry],
        focusDays,
        today: '2026-10-28',
        scale: 'year',
        anchor: '2026-10-28',
      },
    });
    try {
      await flushPromises();
      const marker = w.get('.timeline-focus-marker');
      expect(marker.get('.focus-heat-cell').attributes('data-level')).toBe(
        String(level),
      );
      expect(marker.text()).toBe('');
      expect(marker.attributes('aria-label')).toContain(
        count === 1 ? '重点日' : `${count} 个重点日`,
      );
    } finally {
      w.unmount();
    }
  },
);
it('shows uniform contribution cells and opens only the selected exact dates', async () => {
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
    const cluster = w
      .findAll('.timeline-focus-marker')
      .find(
        (button) =>
          button.get('.focus-heat-cell').attributes('data-level') === '2',
      );
    if (!cluster) throw new Error('Missing grouped focus cell');
    expect(cluster.text()).toBe('');
    expect(cluster.attributes('aria-label')).toContain('2 个重点日');
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
    await w.get('.timeline-entry-list').trigger('scroll');
    expect(cluster.attributes('aria-expanded')).toBe('true');
    await w.setProps({ entries: [{ ...entry }], focusDays: [...focusDays] });
    expect(cluster.attributes('aria-expanded')).toBe('true');
    expect(w.findAll('[data-focus-date]')).toHaveLength(2);
    await w.get('[aria-label="关闭重点详情"]').trigger('click');
    expect(document.activeElement).toBe(cluster.element);
    const single = w
      .findAll('.timeline-focus-marker')
      .find(
        (button) =>
          button.get('.focus-heat-cell').attributes('data-level') === '1',
      );
    if (!single) throw new Error('Missing daily focus cell');
    expect(single.text()).toBe('');
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

it('shows a compact tip on hover or keyboard focus and dismisses stale or pending tips', async () => {
  vi.useFakeTimers();
  const dates = ['2026-10-26', '2026-10-27', '2026-10-28'];
  const w = mount(TimelineView, {
    props: {
      entries: [entry],
      focusDays: dates.map((date) => ({
        entryId: entry.id,
        date,
        focused: true,
        version: 1,
      })),
      today: '2026-10-28',
      scale: 'year',
      anchor: '2026-10-28',
    },
    attachTo: document.body,
    global: { stubs: { Teleport: true } },
  });
  try {
    await flushPromises();
    const marker = w.get('.timeline-focus-marker');
    await marker.trigger('pointerenter');
    await marker.trigger('pointerleave');
    await vi.advanceTimersByTimeAsync(200);
    expect(w.find('[role=tooltip]').exists()).toBe(false);
    await marker.trigger('pointerenter');
    await vi.advanceTimersByTimeAsync(200);
    await flushPromises();
    const tip = w.get('[role=tooltip]');
    expect(tip.text()).toContain('3 个重点日');
    expect(tip.text()).toContain('2026-10-26、2026-10-27、2026-10-28');
    expect(marker.attributes('aria-describedby')).toBe(tip.attributes('id'));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();
    expect(w.find('[role=tooltip]').exists()).toBe(false);
    await marker.trigger('focus');
    await flushPromises();
    expect(w.find('[role=tooltip]').exists()).toBe(true);
    await marker.trigger('click');
    await flushPromises();
    expect(w.find('[role=tooltip]').exists()).toBe(false);
    expect(w.get('[role=dialog]').text()).toContain('重点日期 · 3 天');
    await w.get('[aria-label="关闭重点详情"]').trigger('click');
    await marker.trigger('focus');
    await flushPromises();
    await w.setProps({ focusDays: [] });
    await flushPromises();
    expect(w.find('[role=tooltip]').exists()).toBe(false);
  } finally {
    w.unmount();
    vi.useRealTimers();
  }
});
