import { mount, flushPromises } from '@vue/test-utils';
import { expect, it, vi } from 'vitest';
import TimelineView from '../src/records/TimelineView.vue';
import EntryDetails from '../src/records/EntryDetails.vue';
import { recordView, resetRecordView } from '../src/records/view-state';
import { dateOrdinal, timelineCanvasWindow } from '@dayline/core';
import type { EntryDto } from '@dayline/contracts';
import { changeLanguage } from '../src/i18n';
const laneHeight = 72;
const today = '2026-10-29',
  now = `${today}T00:00:00.000Z`;
const entry = (
  id: string,
  startDate: string,
  endDate: string | null,
): EntryDto => ({
  id,
  title: id,
  categoryId: 'c',
  startDate,
  endDate,
  deletedAt: null,
  version: 1,
  focusVersion: 1,
  purgeAfter: null,
  createdAt: now,
  updatedAt: now,
});

it('uses matching track cells for single entries regardless of input order', async () => {
  resetRecordView();
  const entries = [
    entry('middle', '2026-10-15', null),
    entry('first', '2026-10-01', null),
    entry('last', '2026-10-20', null),
  ];
  const w = mount(TimelineView, {
    props: { entries, focusDays: [], today, scale: 'month', anchor: today },
  });
  try {
    await flushPromises();
    for (const cell of w.findAll('.timeline-list-lane')) {
      const id = cell.get('.timeline-list-entry').attributes('data-entry-id');
      const lane = w.get(
        `.timeline-lane[data-lane="${cell.attributes('data-lane')}"]`,
      );
      expect(
        lane
          .findAll('.timeline-packed-item')
          .map((item) => item.attributes('data-entry-id')),
      ).toEqual([id]);
    }
    await w
      .get('.timeline-packed-item[data-entry-id="middle"]')
      .trigger('pointerenter');
    expect(
      w.get('.timeline-list-entry[data-entry-id="middle"]').classes(),
    ).toContain('is-highlighted');
  } finally {
    w.unmount();
    resetRecordView();
  }
});

it('keeps status, duration and focus summaries for each packed entry and localizes them without losing the track', async () => {
  resetRecordView();
  const entries = [
    entry('first', '2026-10-01', '2026-10-05'),
    entry('second', '2026-10-08', '2026-10-12'),
  ];
  const w = mount(TimelineView, {
    props: {
      entries,
      focusDays: [
        { entryId: 'first', date: '2026-10-03', focused: true, version: 1 },
      ],
      today,
      scale: 'month',
      anchor: today,
    },
  });
  try {
    await flushPromises();
    expect(w.findAll('.timeline-list-lane')).toHaveLength(1);
    const first = w.get('.timeline-list-entry[data-entry-id="first"]');
    const second = w.get('.timeline-list-entry[data-entry-id="second"]');
    expect(first.get('.event-status').text()).toBe('已结束');
    expect(first.get('.timeline-entry-duration').text()).toBe('历时 5 天');
    expect(first.get('.gantt-focus-total').text()).toBe('重点 1 天');
    expect(second.get('.timeline-entry-duration').text()).toBe('历时 5 天');
    expect(second.find('.gantt-focus-total').exists()).toBe(false);
    expect(second.get('.gantt-row-title button').attributes('title')).toContain(
      '累计重点 0 天',
    );
    changeLanguage('en', false);
    await flushPromises();
    expect(first.get('.event-status').text()).toBe('Ended');
    expect(first.get('.timeline-entry-duration').text()).toBe('5 days');
    expect(first.get('.gantt-focus-total').text()).toBe('1 focus day');
    await first.trigger('pointerenter');
    expect(
      w.get('.timeline-packed-item[data-entry-id="first"]').classes(),
    ).toContain('is-highlighted');
    expect(second.classes()).not.toContain('is-highlighted');
    await first.get('.gantt-row-title button').trigger('click');
    expect(w.emitted('view')?.at(-1)?.[0]).toMatchObject({ id: 'first' });
  } finally {
    w.unmount();
    resetRecordView();
    changeLanguage('zh-CN', false);
  }
});

it('packs unlimited ended entries into one matching cell and exposes collapsed entries without expanding the track', async () => {
  resetRecordView();
  const entries = Array.from({ length: 12 }, (_, i) =>
    entry(
      String(i),
      `2026-10-${String(i + 1).padStart(2, '0')}`,
      `2026-10-${String(i + 1).padStart(2, '0')}`,
    ),
  );
  const w = mount(TimelineView, {
    props: {
      entries: [...entries].reverse(),
      focusDays: [],
      today,
      scale: 'month',
      anchor: today,
      range: timelineCanvasWindow(
        entries,
        today,
        'month',
        dateOrdinal('2026-10-01') + 31 * 0.85,
        930,
        31,
      ),
    },
    attachTo: document.body,
    global: { stubs: { Teleport: true } },
  });
  try {
    await flushPromises();
    const height = w.get('.packed-timeline').attributes('style');
    expect(w.findAll('.timeline-lane')).toHaveLength(1);
    expect(w.findAll('.timeline-packed-item')).toHaveLength(12);
    expect(
      w
        .findAll('.timeline-entry-list .timeline-list-entry')
        .map((item) => item.attributes('data-entry-id')),
    ).toEqual(['0', '1']);
    const more = w.get('.timeline-lane-more');
    expect(more.text()).toBe('+10');
    await more.trigger('click');
    await flushPromises();
    expect(more.attributes('aria-expanded')).toBe('true');
    expect(
      w.findAll('.timeline-lane-popover .timeline-list-entry'),
    ).toHaveLength(12);
    await w
      .get('.timeline-lane-popover .timeline-list-entry[data-entry-id="11"]')
      .trigger('pointerenter');
    expect(
      w.get('.timeline-packed-item[data-entry-id="11"]').classes(),
    ).toContain('is-highlighted');
    expect(w.get('.packed-timeline').attributes('style')).toBe(height);
    await w.get('[aria-label="关闭轨道事项"]').trigger('click');
    expect(document.activeElement).toBe(more.element);
    await more.trigger('click');
    await flushPromises();
    await w
      .get(
        '.timeline-lane-popover .timeline-list-entry[data-entry-id="11"] button',
      )
      .trigger('click');
    expect(w.emitted('view')?.at(-1)?.[0]).toMatchObject({ id: '11' });
    expect(w.find('.timeline-lane-popover').exists()).toBe(false);
  } finally {
    w.unmount();
    resetRecordView();
  }
});

it('synchronizes virtualized track scrolling and clamps both sides after filtering', async () => {
  resetRecordView();
  const entries = Array.from({ length: 20 }, (_, i) =>
    entry(String(i).padStart(2, '0'), '2026-10-01', null),
  );
  const w = mount(TimelineView, {
    props: { entries, focusDays: [], today, scale: 'month', anchor: today },
  });
  try {
    await flushPromises();
    const list = w.get<HTMLElement>('.timeline-entry-list');
    const plot = w.get<HTMLElement>('.timeline-viewport');
    const height = Number.parseInt(
      w
        .get<HTMLElement>('.packed-timeline')
        .element.style.getPropertyValue('--timeline-body-height'),
    );
    list.element.scrollTop = 19 * laneHeight;
    await list.trigger('scroll');
    expect(plot.element.scrollTop).toBe(20 * laneHeight - height);
    expect(list.element.scrollTop).toBe(plot.element.scrollTop);
    plot.element.scrollTop = 168;
    await plot.trigger('scroll');
    expect(list.element.scrollTop).toBe(168);
    await w.setProps({ entries: entries.slice(0, 1) });
    await flushPromises();
    expect(list.element.scrollTop).toBe(0);
    expect(plot.element.scrollTop).toBe(0);
  } finally {
    w.unmount();
    resetRecordView();
  }
});

it('restores a single vertical position for both columns and resets stale positions', async () => {
  resetRecordView();
  recordView.timelineTop = 168;
  recordView.timelineListTop = 336;
  const entries = Array.from({ length: 20 }, (_, i) =>
    entry(String(i), '2026-10-01', null),
  );
  const w = mount(TimelineView, {
    props: { entries, focusDays: [], today, scale: 'month', anchor: today },
  });
  await flushPromises();
  expect(w.get<HTMLElement>('.timeline-viewport').element.scrollTop).toBe(168);
  expect(w.get<HTMLElement>('.timeline-entry-list').element.scrollTop).toBe(
    168,
  );
  w.unmount();
  expect(recordView.timelineListTop).toBe(168);
  const short = mount(TimelineView, {
    props: {
      entries: entries.slice(0, 1),
      focusDays: [],
      today,
      scale: 'month',
      anchor: today,
    },
  });
  try {
    await flushPromises();
    expect(
      short.get<HTMLElement>('.timeline-entry-list').element.scrollTop,
    ).toBe(0);
    expect(short.get<HTMLElement>('.timeline-viewport').element.scrollTop).toBe(
      0,
    );
  } finally {
    short.unmount();
    resetRecordView();
  }
});

it('keeps viewport height and existing tracks during zoom, then preserves the visible track anchor', async () => {
  vi.useFakeTimers();
  resetRecordView();
  const entries = [
    entry('recent', '2026-10-01', null),
    ...Array.from({ length: 10 }, (_, i) =>
      entry(`old-${i}`, '2026-05-01', '2026-05-02'),
    ),
  ];
  const month = timelineCanvasWindow(entries, today, 'month');
  const w = mount(TimelineView, {
    props: {
      entries,
      focusDays: [],
      today,
      scale: 'month',
      anchor: today,
      range: month,
    },
  });
  try {
    await flushPromises();
    const height = w.get('.packed-timeline').attributes('style');
    const firstTrack = w
      .get('.timeline-list-lane')
      .get('.timeline-list-entry')
      .attributes('data-entry-id');
    w.get('.timeline-viewport').element.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 100, clientX: 40, cancelable: true }),
    );
    await w.setProps({ range: timelineCanvasWindow(entries, today, 'year') });
    expect(w.findAll('.timeline-lane')).toHaveLength(1);
    expect(
      w
        .get('.timeline-list-lane')
        .get('.timeline-list-entry')
        .attributes('data-entry-id'),
    ).toBe(firstTrack);
    await vi.advanceTimersByTimeAsync(200);
    await flushPromises();
    expect(w.findAll('.timeline-lane').length).toBeGreaterThan(1);
    expect(w.get('.packed-timeline').attributes('style')).toBe(height);
    await w.setProps({
      range: {
        ...month,
        start: dateOrdinal('2027-01-01'),
        endExclusive: dateOrdinal('2027-02-01'),
      },
    });
    await flushPromises();
    expect(w.findAll('.timeline-lane')).toHaveLength(0);
    expect(w.get('.packed-timeline').attributes('style')).toBe(height);
  } finally {
    w.unmount();
    resetRecordView();
    vi.useRealTimers();
  }
});

it('preserves the top visible track when zoom reveals earlier tracks above it', async () => {
  resetRecordView();
  const entries = [
    ...Array.from({ length: 10 }, (_, i) =>
      entry(`recent-${i}`, `2026-10-${String(i + 1).padStart(2, '0')}`, null),
    ),
    ...Array.from({ length: 8 }, (_, i) =>
      entry(`old-${i}`, '2026-05-01', '2026-05-10'),
    ),
  ];
  const w = mount(TimelineView, {
    props: {
      entries,
      focusDays: [],
      today,
      scale: 'month',
      anchor: today,
      sort: 'asc',
      range: timelineCanvasWindow(entries, today, 'month'),
    },
  });
  try {
    await flushPromises();
    const plot = w.get<HTMLElement>('.timeline-viewport');
    plot.element.scrollTop = 3 * laneHeight;
    await plot.trigger('scroll');
    await w.setProps({ range: timelineCanvasWindow(entries, today, 'year') });
    await flushPromises();
    expect(plot.element.scrollTop).toBe(11 * laneHeight);
    expect(w.get<HTMLElement>('.timeline-entry-list').element.scrollTop).toBe(
      11 * laneHeight,
    );
    expect(
      w
        .get('.timeline-list-lane[data-lane="11"] [data-entry-id]')
        .attributes('data-entry-id'),
    ).toBe('recent-3');
  } finally {
    w.unmount();
    resetRecordView();
  }
});

it('shows a compact read-only date range and metrics with an explicit edit action only when allowed', async () => {
  const w = mount(EntryDetails, {
    props: {
      entry: entry('紧凑详情', '2026-10-01', null),
      categories: [],
      today,
      focusDays: [
        { entryId: '紧凑详情', date: '2026-10-29', focused: true, version: 1 },
      ],
      readonly: true,
    },
  });
  try {
    expect(w.get('.entry-detail-range').text()).toContain('2026-10-01 — 至今');
    expect(w.text()).toContain('29 天');
    expect(w.text()).toContain('重点日期1 天');
    expect(w.find('[aria-label="编辑事项"]').exists()).toBe(false);
    expect(w.find('input,form').exists()).toBe(false);
    expect(w.get('details').attributes('open')).toBeUndefined();
    await w.setProps({ readonly: false });
    await w.get('[aria-label="编辑事项"]').trigger('click');
    expect(w.emitted('edit')).toHaveLength(1);
  } finally {
    w.unmount();
  }
});
