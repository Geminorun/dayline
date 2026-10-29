import { mount, flushPromises } from '@vue/test-utils';
import { expect, it } from 'vitest';
import TimelineView from '../src/records/TimelineView.vue';
import EntryDetails from '../src/records/EntryDetails.vue';
import { recordView, resetRecordView } from '../src/records/view-state';
import { dateOrdinal, timelineCanvasWindow } from '@dayline/core';
import type { EntryDto } from '@dayline/contracts';
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

it('packs ended history into shared tracks and links list hover without coupling scroll positions', async () => {
  resetRecordView();
  const entries = Array.from({ length: 12 }, (_, i) =>
    entry(
      String(i),
      `2026-10-${String(i + 1).padStart(2, '0')}`,
      `2026-10-${String(i + 1).padStart(2, '0')}`,
    ),
  );
  // Provide a real width so one-day hit targets fit without artificial jsdom collisions.
  const width = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'clientWidth',
  );
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    value: 930,
  });
  const w = mount(TimelineView, {
    props: {
      entries,
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
  });
  try {
    await flushPromises();
    expect(w.findAll('.timeline-lane')).toHaveLength(1);
    expect(w.findAll('.timeline-packed-item')).toHaveLength(12);
    const list = w.get<HTMLElement>('.timeline-entry-list');
    const plot = w.get<HTMLElement>('.timeline-viewport');
    list.element.scrollTop = 336;
    await list.trigger('scroll');
    expect(plot.element.scrollTop).toBe(0);
    await w
      .get('.timeline-packed-item[data-entry-id="0"]')
      .trigger('pointerenter');
    expect(list.element.scrollTop).toBe(0);
    expect(
      w.get('.timeline-list-entry[data-entry-id="0"]').classes(),
    ).toContain('is-highlighted');
    await w.get('.timeline-packed-item[data-entry-id="11"]').trigger('focusin');
    expect(list.element.scrollTop).toBe(504);
    expect(
      w.get('.timeline-list-entry[data-entry-id="11"]').classes(),
    ).toContain('is-highlighted');
    await w
      .get('.timeline-list-entry[data-entry-id="11"]')
      .trigger('pointerenter');
    expect(
      w.get('.timeline-packed-item[data-entry-id="11"]').classes(),
    ).toContain('is-highlighted');
    await w
      .get('.timeline-packed-item[data-entry-id="11"] .gantt-bar')
      .trigger('click');
    expect(w.emitted('view')?.at(-1)?.[0]).toMatchObject({ id: '11' });
    expect(w.emitted('finish')).toBeUndefined();
  } finally {
    w.unmount();
    if (width)
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', width);
    else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
    resetRecordView();
  }
});

it('brings the corresponding packed track into view from the independently scrolled list', async () => {
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
    list.element.scrollTop = 15 * 56;
    await list.trigger('scroll');
    await w
      .get('.timeline-list-entry[data-entry-id="19"]')
      .trigger('pointerenter');
    expect(w.get<HTMLElement>('.timeline-viewport').element.scrollTop).toBe(
      20 * 56 - 336,
    );
    expect(
      w.get('.timeline-packed-item[data-entry-id="19"]').classes(),
    ).toContain('is-highlighted');
    await w.setProps({ entries: entries.slice(0, 1) });
    await flushPromises();
    expect(list.element.scrollTop).toBe(0);
    expect(w.get<HTMLElement>('.timeline-viewport').element.scrollTop).toBe(0);
  } finally {
    w.unmount();
    resetRecordView();
  }
});

it('restores list and plot positions separately, clamps stale positions and clears them on identity reset', async () => {
  resetRecordView();
  recordView.timelineTop = 168;
  recordView.timelineListTop = 336;
  const entries = Array.from({ length: 20 }, (_, i) =>
    entry(String(i), '2026-10-01', null),
  );
  const w = mount(TimelineView, {
    props: { entries, focusDays: [], today, scale: 'month', anchor: today },
  });
  try {
    await flushPromises();
    expect(w.get<HTMLElement>('.timeline-viewport').element.scrollTop).toBe(
      168,
    );
    expect(w.get<HTMLElement>('.timeline-entry-list').element.scrollTop).toBe(
      336,
    );
  } finally {
    w.unmount();
  }
  expect(recordView.timelineTop).toBe(168);
  expect(recordView.timelineListTop).toBe(336);
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
    expect(short.get<HTMLElement>('.timeline-viewport').element.scrollTop).toBe(
      0,
    );
    expect(
      short.get<HTMLElement>('.timeline-entry-list').element.scrollTop,
    ).toBe(0);
  } finally {
    short.unmount();
    resetRecordView();
  }
  expect(recordView.timelineTop).toBe(0);
  expect(recordView.timelineListTop).toBe(0);
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
