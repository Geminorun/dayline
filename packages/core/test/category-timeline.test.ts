import { expect, it } from 'vitest';
import {
  dateOrdinal,
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

it('uses the supplied category order and reserves one slot for empty categories', () => {
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
    ['other', 0, []],
  ]);
  expect(
    timelineCategoryLanes([...entries].reverse(), categories, today),
  ).toEqual(lanes);
  expect(
    timelineCategoryLanes(entries, [...categories].reverse(), today).map(
      (lane) => lane.categoryId,
    ),
  ).toEqual(['other', 'games', 'reading']);
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
    expect(projected).toHaveLength(3);
    expect(projected.flat().some((item) => item.entry.id === 'deleted')).toBe(
      false,
    );
  }
  expect(lanes.map((lane) => lane.entries.map((e) => e.id))).toEqual([
    ['ongoing'],
    ['old'],
    [],
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
  ).toEqual(['known', 'a', 'b']);
});
