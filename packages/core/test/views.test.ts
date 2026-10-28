import { describe, expect, it } from 'vitest';
import {
  dateOrdinal,
  ordinalDate,
  weekDates,
  shiftMonth,
  emptyFilter,
  selectEntries,
  summarizeEntries,
  timelineWindow,
  timelineBar,
  timelineFocusGroups,
  spanLabel,
  visibleRows,
} from '../src/index.js';
const today = '2026-10-26';
const entry = {
  id: 'a',
  categoryId: 'reading',
  title: '  阅读ABC ',
  startDate: '2026-10-01',
  endDate: null,
};
describe('complete shared view rules', () => {
  it('round trips extreme Gregorian dates and natural month/quarter transitions', () => {
    for (const date of [
      '0001-01-01',
      '0099-02-28',
      '0400-02-29',
      '1900-03-01',
      '2000-02-29',
      '9999-12-31',
    ])
      expect(ordinalDate(dateOrdinal(date))).toBe(date);
    expect(weekDates('0001-01-01')).toHaveLength(7);
    expect(weekDates('2026-10-28')[0]).toBe('2026-10-26');
    expect(weekDates('9999-12-31').at(-1)).toBe('9999-12-31');
    expect(shiftMonth('0099-12-31', 1)).toBe('0100-01-01');
    expect(shiftMonth('0001-01-01', -3)).toBe('0001-01-01');
  });
  it('combines case-insensitive trimmed title/category/state filters with stable start/ID ordering and whole-result statistics', () => {
    const entries = [
      { ...entry, id: 'b' },
      { ...entry, id: 'a' },
      { ...entry, id: 'future', startDate: '2027-01-01' },
      { ...entry, id: 'trash', deletedAt: 'now' },
      { ...entry, id: 'ended', endDate: '2026-10-01' },
    ];
    const selected = selectEntries(entries, today, {
      search: ' abc ',
      categoryId: 'reading',
      status: 'ongoing',
      sort: 'desc',
    });
    expect(selected.map((e) => e.id)).toEqual(['future', 'a', 'b']);
    expect(summarizeEntries(selected, today)).toMatchObject({
      count: 3,
      ongoing: 3,
      categoryCount: 1,
      categories: { reading: 3 },
    });
    expect(spanLabel(entries[2] ?? entry, today)).toBe('从 2027-01-01 开始');
  });
  it('uses inclusive planned end and bounded open intervals, clips bars, and has all four windows', () => {
    expect(timelineWindow([], today, 'all', '0001-01-01').start).toBe(
      dateOrdinal('2026-10-01'),
    );
    const planned = { ...entry, endDate: '2026-12-31' };
    for (const scale of ['month', 'quarter', 'year', 'all'] as const) {
      const window = timelineWindow([planned], today, scale, today);
      expect(window.ticks.length).toBeLessThanOrEqual(80);
      expect(timelineBar(planned, today, window)?.width).toBeGreaterThan(0);
    }
    const month = timelineWindow([entry], today, 'month', today);
    expect(timelineBar(entry, today, month)?.width).toBe(26 * 34);
    const clipped = timelineBar(
      { ...entry, startDate: '2026-09-01', endDate: '2026-12-31' },
      today,
      month,
    );
    expect(clipped).toMatchObject({
      left: 0,
      width: 31 * 34,
      continuesBefore: true,
      continuesAfter: true,
    });
    expect(
      timelineBar({ ...entry, startDate: '2026-10-30' }, today, month)?.width,
    ).toBe(34);
    expect(
      selectEntries([entry], today, emptyFilter(), {
        start: dateOrdinal('2026-11-01'),
        endExclusive: dateOrdinal('2026-12-01'),
      }),
    ).toEqual([]);
  });
  it('groups quarter focus weeks Monday-first and year focus months while excluding false/trash/out-of-range/future dates', () => {
    const entries = [entry, { ...entry, id: 'trash', deletedAt: 'now' }],
      focus = [
        { entryId: 'a', date: '2026-10-05', focused: true },
        { entryId: 'a', date: '2026-10-11', focused: true },
        { entryId: 'a', date: '2026-10-12', focused: true },
        { entryId: 'a', date: '2026-10-13', focused: false },
        { entryId: 'trash', date: '2026-10-05', focused: true },
        { entryId: 'a', date: '2026-11-01', focused: true },
      ];
    const quarter = timelineFocusGroups(
      entries,
      focus,
      today,
      timelineWindow(entries, today, 'quarter', today),
    );
    expect(quarter.map((g) => g.dates.length)).toEqual([2, 1]);
    expect(quarter[0]?.left).toBe(
      (dateOrdinal('2026-10-05') - dateOrdinal('2026-10-01') + 0.5) * 12,
    );
    const year = timelineFocusGroups(
      entries,
      focus,
      today,
      timelineWindow(entries, today, 'year', today),
    );
    expect(year).toHaveLength(1);
    expect(year[0]?.dates).toEqual(['2026-10-05', '2026-10-11', '2026-10-12']);
  });
  it('bounds 0001–9999 ticks, visible rows and non-overlapping focus markers with 1000 entries / 10000 focus days', () => {
    const entries = Array.from({ length: 1000 }, (_, i) => ({
      ...entry,
      id: String(i),
      startDate: '0001-01-01',
      endDate: '9999-12-31',
    }));
    const focus = Array.from({ length: 10000 }, (_, i) => ({
      entryId: '0',
      date: ordinalDate(i * 365 + 1),
      focused: true,
    }));
    const window = timelineWindow(
        entries,
        '9999-12-31',
        'all',
        '9999-12-31',
        900,
      ),
      groups = timelineFocusGroups(entries, focus, '9999-12-31', window);
    expect(window.ticks.length).toBeLessThanOrEqual(80);
    expect(groups.length).toBeLessThanOrEqual(80);
    expect(groups.flatMap((g) => g.dates)).toHaveLength(10000);
    for (let i = 1; i < groups.length; i++)
      expect(
        (groups[i]?.left ?? 0) - (groups[i - 1]?.left ?? 0),
      ).toBeGreaterThanOrEqual(44);
    expect(visibleRows(1, 28000, 420, 56)).toEqual({
      start: 0,
      end: 1,
      before: 0,
      after: 0,
    });
    expect(visibleRows(0, 28000, 420, 56)).toEqual({
      start: 0,
      end: 0,
      before: 0,
      after: 0,
    });
    expect(visibleRows(1000, 28000, 420, 56)).toEqual({
      start: 490,
      end: 518,
      before: 27440,
      after: 26992,
    });
  });
});

it('anchors rolling month, quarter and year windows at today and keeps full history bounded', async () => {
  const { timelineCanvasWindow, timelineBar, dateOrdinal } =
    await import('../src/index.js');
  const today = '2026-10-28';
  const entries = [
    {
      id: 'recent',
      title: '最近的事',
      categoryId: 'c',
      startDate: '2026-10-26',
      endDate: null,
    },
  ];
  for (const scale of ['month', 'quarter', 'year'] as const) {
    const w = timelineCanvasWindow(entries, today, scale, undefined, 1000);
    expect(w.todayX).toBeCloseTo(850, 5);
    expect(
      timelineBar(
        {
          id: 'recent',
          title: '',
          categoryId: 'c',
          startDate: '2026-10-26',
          endDate: null,
        },
        today,
        w,
      )?.left,
    ).toBeLessThan(850);
    expect(
      timelineBar(
        {
          id: 'recent',
          title: '',
          categoryId: 'c',
          startDate: '2026-10-26',
          endDate: null,
        },
        today,
        w,
      )?.width,
    ).toBeGreaterThan(0);
  }
  const all = timelineCanvasWindow(
    [
      {
        id: 'full',
        title: '',
        categoryId: 'c',
        startDate: '0001-01-01',
        endDate: '9999-12-31',
      },
    ],
    today,
    'all',
  );
  expect(all.start).toBe(1);
  expect(all.endExclusive).toBe(3652060);
  expect(all.ticks.length).toBeLessThan(45);
  const shifted = timelineCanvasWindow(
    entries,
    today,
    'month',
    dateOrdinal('2026-05-01'),
    1000,
    60,
  );
  expect(shifted.endExclusive - shifted.start).toBe(60);
  expect(
    timelineBar(
      {
        id: 'recent',
        title: '',
        categoryId: 'c',
        startDate: '2026-10-26',
        endDate: null,
      },
      today,
      shifted,
    ),
  ).toBeNull();
  for (const boundary of ['0001-01-01', '9999-12-31']) {
    const w = timelineCanvasWindow([], boundary, 'year');
    expect(w.start).toBeGreaterThanOrEqual(1);
    expect(w.endExclusive).toBeLessThanOrEqual(3652060);
    expect(w.ticks.every((t) => Number.isFinite(t.x))).toBe(true);
  }
});

it('keeps inclusive end dates visible when a panned window starts partway through their last day', () => {
  const entry = {
    id: 'last-day',
    title: '当天结束',
    categoryId: 'c',
    startDate: '2026-09-01',
    endDate: '2026-10-01',
  };
  const lastDay = dateOrdinal('2026-10-01');
  const filter = { ...emptyFilter(), status: 'all' as const };
  expect(
    selectEntries([entry], '2026-10-28', filter, {
      start: lastDay + 0.75,
      endExclusive: lastDay + 31,
    }),
  ).toEqual([entry]);
  expect(
    selectEntries([entry], '2026-10-28', filter, {
      start: lastDay + 1,
      endExclusive: lastDay + 32,
    }),
  ).toEqual([]);
});
