import { expect, it } from 'vitest';
import {
  dateOrdinal,
  timelineCanvasWindow,
  TIMELINE_RECENT_POSITION,
} from '@dayline/core';
import { TimelineGesture } from '../src/timeline/gestures';
const today = '2026-10-29';
const range = () => timelineCanvasWindow([], today, 'year', undefined, 300);
it('keeps the date under the pinch midpoint while zooming and moving the midpoint', () => {
  const w = range(),
    g = new TimelineGesture();
  g.start(
    [
      { clientX: 150, clientY: 200 },
      { clientX: 250, clientY: 200 },
    ],
    w,
    100,
    0,
    0,
  );
  const change = g.move([
    { clientX: 100, clientY: 200 },
    { clientX: 300, clientY: 200 },
  ]);
  const c = change?.camera;
  if (!c) throw new Error('No zoom');
  expect(c.days).toBeCloseTo(183);
  const next = timelineCanvasWindow([], today, 'year', c.day, 300, c.days);
  expect(next.start + (100 / 300) * c.days).toBeCloseTo(
    w.start + (100 / 300) * 366,
  );
  expect(g.end()).toBe(true);
});
it('locks one-finger movement to horizontal dates or vertical items', () => {
  const w = range(),
    g = new TimelineGesture();
  g.start([{ clientX: 100, clientY: 100 }], w, 0, 0, 70);
  const c = g.move([{ clientX: 140, clientY: 102 }]);
  expect(c?.scroll).toBeUndefined();
  expect(c?.camera?.day).toBeCloseTo(
    w.start - 40 / w.pixelsPerDay + 366 * TIMELINE_RECENT_POSITION,
  );
  g.start([{ clientX: 100, clientY: 100 }], w, 0, 0, 70);
  expect(g.move([{ clientX: 102, clientY: 60 }])).toEqual({ scroll: 110 });
  expect(g.move([{ clientX: 103, clientY: 400 }])).toEqual({ scroll: 0 });
});
it('rebases a remaining finger without jumping and respects zoom limits', () => {
  const w = range(),
    g = new TimelineGesture();
  g.start(
    [
      { clientX: 100, clientY: 0 },
      { clientX: 200, clientY: 0 },
    ],
    w,
    0,
    0,
    0,
  );
  const zoom = g.move([
    { clientX: 0, clientY: 0 },
    { clientX: 3000, clientY: 0 },
  ])?.camera;
  if (!zoom) throw new Error('No zoom');
  expect(zoom.days).toBe(31);
  const next = timelineCanvasWindow(
    [],
    today,
    'month',
    zoom.day,
    300,
    zoom.days,
  );
  g.rebase([{ clientX: 200, clientY: 0 }], next, 0);
  expect(g.move([{ clientX: 200, clientY: 0 }])).toBeNull();
  expect(g.moved).toBe(true);
  expect(g.end()).toBe(true);
  g.start(
    [
      { clientX: 0, clientY: 0 },
      { clientX: 3000, clientY: 0 },
    ],
    w,
    0,
    0,
    0,
  );
  expect(
    g.move([
      { clientX: 100, clientY: 0 },
      { clientX: 110, clientY: 0 },
    ])?.camera?.days,
  ).toBe(w.maxDays);
});
it('uses the shared recent window and clamps dates at both calendar boundaries', () => {
  const w = timelineCanvasWindow([], today, 'month', undefined, 300);
  expect(w.todayX).toBeCloseTo(300 * 0.85);
  expect(timelineCanvasWindow([], '0001-01-01', 'month', -100, 300).start).toBe(
    1,
  );
  expect(
    timelineCanvasWindow(
      [],
      '9999-12-31',
      'month',
      dateOrdinal('9999-12-31') + 100,
      300,
    ).endExclusive,
  ).toBe(dateOrdinal('9999-12-31') + 1);
});
