import { expect, it } from 'vitest';
import {
  dateOrdinal,
  ordinalDate,
  projectTimelineLanes,
  timelineCategoryLanes,
} from '../src/index.js';
import type { ViewEntry } from '../src/index.js';

const today = '2026-11-26';
const entry = (
  id: string,
  categoryId: string,
  startDate: string,
  endDate: string | null,
): ViewEntry => ({
  id,
  categoryId,
  title: id,
  startDate,
  endDate,
});

it('uses the supplied category order and omits empty categories', () => {
  const categories = [{ id: 'reading' }, { id: 'games' }, { id: 'other' }];
  const entries = [
    entry('game', 'games', '2026-01-01', '2026-01-02'),
    entry('book', 'reading', '2026-10-01', '2026-10-02'),
  ];
  const lanes = timelineCategoryLanes(entries, categories, today);
  expect(
    lanes.map((lane) => [
      lane.categoryId,
      lane.index,
      lane.entries.map((e) => e.id),
    ]),
  ).toEqual([
    ['reading', 0, ['book']],
    ['games', 0, ['game']],
  ]);
  expect(
    timelineCategoryLanes([...entries].reverse(), categories, today),
  ).toEqual(lanes);
  expect(
    timelineCategoryLanes(entries, [...categories].reverse(), today).map(
      (lane) => lane.categoryId,
    ),
  ).toEqual(['games', 'reading']);
});

it('only reuses ended intervals within their own category and keeps inclusive overlaps separate', () => {
  const lanes = timelineCategoryLanes(
    [
      entry('a', 'reading', '2026-10-01', '2026-10-03'),
      entry('b', 'reading', '2026-10-04', '2026-10-06'),
      entry('overlap', 'reading', '2026-10-03', '2026-10-05'),
      entry('game', 'games', '2026-10-20', '2026-10-25'),
    ],
    [{ id: 'reading' }, { id: 'games' }],
    today,
  );
  expect(lanes.map((lane) => lane.entries.map((e) => e.id))).toEqual([
    ['a', 'b'],
    ['overlap'],
    ['game'],
  ]);
  expect(lanes.map((lane) => lane.index)).toEqual([0, 1, 0]);
});

it('keeps all slots across camera changes and excludes deleted entries from allocation', () => {
  const entries = [
    entry('ongoing', 'reading', '2026-11-20', null),
    entry('old', 'reading', '2020-01-01', '2020-01-03'),
    { ...entry('deleted', 'games', '2020-01-01', null), deletedAt: today },
  ];
  const lanes = timelineCategoryLanes(
    entries,
    [{ id: 'reading' }, { id: 'games' }],
    today,
  );
  const membership = lanes.map((lane) => lane.entries);
  for (const [start, days, width] of [
    ['2020-01-01', 31, 930],
    ['2026-11-01', 31, 80],
    ['2030-01-01', 366, 1024],
  ] as const) {
    const projected = projectTimelineLanes(membership, today, {
      start: dateOrdinal(start),
      endExclusive: dateOrdinal(start) + days,
      width,
      pixelsPerDay: width / days,
      ticks: [],
      todayX: null,
      focusUnit: 'day',
    });
    expect(projected).toHaveLength(1);
    expect(projected.flat().some((item) => item.entry.id === 'deleted')).toBe(
      false,
    );
  }
  expect(lanes.map((lane) => lane.entries.map((e) => e.id))).toEqual([
    ['old', 'ongoing'],
  ]);
});

it('does not lose entries when category metadata is incomplete', () => {
  const entries = [
    entry('b', 'b', '2026-01-01', null),
    entry('a', 'a', '2026-01-01', null),
  ];
  expect(
    timelineCategoryLanes(
      entries,
      [{ id: 'known' }, { id: 'known' }],
      today,
    ).map((lane) => lane.categoryId),
  ).toEqual(['a', 'b']);
});

it('packs historical, ongoing and planned entries together when their true dates do not overlap', () => {
  const entries = [
    entry('past', 'work', '2026-10-01', '2026-10-05'),
    entry('past-next', 'work', '2026-10-06', '2026-10-10'),
    entry('ongoing', 'work', '2026-11-10', null),
    entry('planned', 'work', '2026-12-01', '2026-12-10'),
    entry('future-open', 'work', '2026-12-11', null),
  ];
  const lanes = timelineCategoryLanes(entries, [{ id: 'work' }], today);
  expect(lanes).toHaveLength(1);
  expect(lanes[0]?.entries.map((e) => e.id)).toEqual([
    'past',
    'past-next',
    'ongoing',
    'planned',
    'future-open',
  ]);
  expect(
    timelineCategoryLanes([...entries].reverse(), [{ id: 'work' }], today),
  ).toEqual(lanes);
});

it('only separates actual overlapping dates and compacts again after an explicit status filter', () => {
  const entries = [
    entry('a', 'work', '2026-10-01', '2026-10-05'),
    entry('b', 'work', '2026-10-03', '2026-10-05'),
    entry('c', 'work', '2026-10-05', '2026-10-08'),
    entry('ongoing', 'work', '2026-11-01', null),
  ];
  const categories = [{ id: 'work' }, { id: 'empty' }];
  expect(timelineCategoryLanes(entries, categories, today)).toHaveLength(3);
  const ongoing = entries.filter((entry) => entry.endDate === null);
  expect(timelineCategoryLanes(ongoing, categories, today)).toHaveLength(1);
  expect(timelineCategoryLanes([], categories, today)).toEqual([]);
});

it('uses exactly the maximum concurrent interval count for mixed-status categories', () => {
  const firstDay = dateOrdinal('2026-10-01');
  const entries = Array.from({ length: 200 }, (_, index) => {
    const start = firstDay + ((index * 17) % 80);
    return entry(
      String(index),
      'work',
      ordinalDate(start),
      index % 4 ? ordinalDate(start + (index % 13)) : null,
    );
  });
  const events = new Map<number, number>();
  for (const item of entries) {
    const start = dateOrdinal(item.startDate);
    const end = Math.max(start, dateOrdinal(item.endDate ?? today)) + 1;
    events.set(start, (events.get(start) ?? 0) + 1);
    events.set(end, (events.get(end) ?? 0) - 1);
  }
  let concurrent = 0,
    peak = 0;
  for (const [, delta] of [...events].sort((a, b) => a[0] - b[0])) {
    concurrent += delta;
    peak = Math.max(peak, concurrent);
  }
  const lanes = timelineCategoryLanes(entries, [{ id: 'work' }], today);
  expect(lanes).toHaveLength(peak);
  for (const lane of lanes)
    for (let index = 1; index < lane.entries.length; index++) {
      const previous = lane.entries[index - 1];
      const next = lane.entries[index];
      if (!previous || !next) throw new Error('Missing lane entry');
      expect(
        Math.max(
          dateOrdinal(previous.startDate),
          dateOrdinal(previous.endDate ?? today),
        ),
      ).toBeLessThan(dateOrdinal(next.startDate));
    }
  expect(
    timelineCategoryLanes([...entries].reverse(), [{ id: 'work' }], today),
  ).toEqual(lanes);
});
