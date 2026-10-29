import { expect, it } from 'vitest';
import {
  dateOrdinal,
  ordinalDate,
  packTimelineLanes,
  timelineCanvasWindow,
} from '../src/index.js';
import type { ViewEntry } from '../src/index.js';

const today = '2026-10-29';
const entry = (id: string, start: string, end: string | null): ViewEntry => ({
  id,
  title: id,
  categoryId: 'c',
  startDate: start,
  endDate: end,
});
const range = {
  start: dateOrdinal('2026-10-01'),
  endExclusive: dateOrdinal('2026-11-01'),
  width: 930,
  pixelsPerDay: 30,
  ticks: [],
  todayX: null,
  focusUnit: 'day' as const,
};

it('reuses tracks after inclusive end dates, but keeps same-day overlaps apart', () => {
  const result = packTimelineLanes(
    [
      entry('a', '2026-10-01', '2026-10-03'),
      entry('b', '2026-10-04', '2026-10-06'),
      entry('c', '2026-10-06', '2026-10-07'),
    ],
    today,
    range,
  );
  expect(result).toHaveLength(2);
  expect(result[0]?.map((p) => p.entry.id)).toEqual(['a', 'b']);
  expect(result[1]?.map((p) => p.entry.id)).toEqual(['c']);
});

it('keeps adjacent days on one track with fractional camera positions and pixel widths', () => {
  const entries = Array.from({ length: 31 }, (_, i) =>
    entry(
      String(i),
      ordinalDate(range.start + i),
      ordinalDate(range.start + i),
    ),
  );
  for (const width of [931, 947, 1001, 1025, 1100, 875.5]) {
    const camera = {
      ...range,
      start: range.start + 0.12,
      endExclusive: range.endExclusive + 0.12,
      width,
      pixelsPerDay: width / 31,
    };
    expect(packTimelineLanes(entries, '2026-10-31', camera)).toHaveLength(1);
  }
});

it('gives simultaneous ongoing entries separate tracks and fills their earlier gaps', () => {
  const result = packTimelineLanes(
    [
      entry('ongoing-a', '2026-10-20', null),
      entry('ongoing-b', '2026-10-25', null),
      entry('history-a', '2026-10-01', '2026-10-10'),
      entry('history-b', '2026-10-08', '2026-10-18'),
    ],
    today,
    range,
  );
  expect(result).toHaveLength(2);
  expect(result.every((lane) => lane.length === 2)).toBe(true);
  const historicalPeak = packTimelineLanes(
    [
      entry('ongoing', '2026-10-20', null),
      ...['a', 'b', 'c'].map((id) => entry(id, '2026-10-01', '2026-10-10')),
    ],
    today,
    range,
  );
  expect(historicalPeak).toHaveLength(3);
});

it('includes short bar hit targets and focus circles in collision checks', () => {
  const narrow = { ...range, width: 93, pixelsPerDay: 3 };
  const entries = [
    entry('a', '2026-10-01', '2026-10-01'),
    entry('b', '2026-10-02', '2026-10-02'),
  ];
  expect(packTimelineLanes(entries, today, narrow)).toHaveLength(2);
  const marks = [
    { entryId: 'a', key: 'focus', left: 28, dates: ['2026-10-01'] },
  ];
  const marked = packTimelineLanes(entries, today, range, marks);
  expect(marked).toHaveLength(2);
  expect(
    marked.flat().every((p) => p.left >= 0 && p.right <= range.width),
  ).toBe(true);
});

it('preserves track choices on refresh and sorting while keeping the minimum track count', () => {
  const entries = [
    entry('a', '2026-10-01', '2026-10-02'),
    entry('b', '2026-10-01', '2026-10-04'),
    entry('c', '2026-10-08', '2026-10-09'),
  ];
  const previous = new Map([
    ['a', 1],
    ['b', 0],
    ['c', 1],
  ]);
  const result = packTimelineLanes(entries, today, range, [], previous);
  const positions = new Map(result.flat().map((p) => [p.entry.id, p.lane]));
  expect(positions.get('b')).toBe(0);
  expect(positions.get('a')).toBe(1);
  expect(positions.get('c')).toBe(1);
  expect(
    packTimelineLanes([...entries].reverse(), today, range, [], positions).map(
      (lane) => lane.map((p) => p.entry.id),
    ),
  ).toEqual(result.map((lane) => lane.map((p) => p.entry.id)));
  expect(result).toHaveLength(2);
});

it('matches the maximum visible overlap for 1,000 mixed intervals without collisions', () => {
  const entries = Array.from({ length: 1000 }, (_, i) => {
    const start = range.start + ((i * 13) % 28);
    return entry(
      String(i),
      ordinalDate(start),
      ordinalDate(Math.min(start + (i % 9), range.endExclusive - 1)),
    );
  });
  const result = packTimelineLanes(entries, today, range);
  const events = result
    .flat()
    .flatMap((p) => [
      { x: p.left, delta: 1 },
      { x: p.right, delta: -1 },
    ])
    .sort((a, b) => a.x - b.x || a.delta - b.delta);
  let depth = 0,
    maximum = 0;
  for (const event of events) {
    depth += event.delta;
    maximum = Math.max(maximum, depth);
  }
  expect(result).toHaveLength(maximum);
  expect(result.flat()).toHaveLength(1000);
  for (const lane of result)
    for (let i = 1; i < lane.length; i++)
      expect(lane[i - 1]?.right).toBeLessThanOrEqual(lane[i]?.left ?? 0);
});

it('clips extreme dates and excludes offscreen or deleted records', () => {
  const all = timelineCanvasWindow([], today, 'all');
  const result = packTimelineLanes(
    [
      entry('extreme', '0001-01-01', '9999-12-31'),
      entry('outside', '0001-01-01', '0001-01-01'),
      { ...entry('deleted', '2026-10-01', null), deletedAt: '2026-10-29' },
    ],
    today,
    all,
  );
  expect(result.flat().map((p) => p.entry.id)).toEqual(['extreme']);
  expect(result[0]?.[0]?.bar.continuesBefore).toBe(true);
  expect(result[0]?.[0]?.bar.continuesAfter).toBe(true);
});
