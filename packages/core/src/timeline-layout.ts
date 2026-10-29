import { MinPriorityQueue } from '@datastructures-js/priority-queue';
import { entryStatus } from './index.js';
import { timelineBar } from './views.js';
import type { TimelineFocusGroup, TimelineWindow, ViewEntry } from './views.js';

export interface TimelinePlacement<T extends ViewEntry = ViewEntry> {
  entry: T;
  lane: number;
  left: number;
  right: number;
  bar: NonNullable<ReturnType<typeof timelineBar>>;
  hitLeft: number;
  hitWidth: number;
  groups: TimelineFocusGroup[];
}

/** Pack the visible hit targets, including focus marks, without changing dates. */
export function packTimelineLanes<T extends ViewEntry>(
  entries: readonly T[],
  today: string,
  window: TimelineWindow,
  groups: readonly TimelineFocusGroup[] = [],
  previous: ReadonlyMap<string, number> = new Map(),
): TimelinePlacement<T>[][] {
  const byEntry = new Map<string, TimelineFocusGroup[]>();
  for (const group of groups) {
    const list = byEntry.get(group.entryId) ?? [];
    list.push(group);
    byEntry.set(group.entryId, list);
  }
  const placements: TimelinePlacement<T>[] = [];
  for (const entry of entries) {
    if (entry.deletedAt) continue;
    const bar = timelineBar(entry, today, window);
    if (!bar) continue;
    const hitWidth = Math.min(window.width, Math.max(24, bar.width));
    const hitLeft = Math.max(
      0,
      Math.min(window.width - hitWidth, bar.left - (hitWidth - bar.width) / 2),
    );
    const marks = byEntry.get(entry.id) ?? [];
    let left = hitLeft,
      right = hitLeft + hitWidth;
    for (const mark of marks) {
      left = Math.min(left, Math.max(0, mark.left - 14));
      right = Math.max(right, Math.min(window.width, mark.left + 14));
    }
    placements.push({
      entry,
      lane: 0,
      left,
      right,
      bar,
      hitLeft,
      hitWidth,
      groups: marks,
    });
  }
  placements.sort(
    (a, b) =>
      a.left - b.left ||
      (previous.get(a.entry.id) ?? Number.MAX_SAFE_INTEGER) -
        (previous.get(b.entry.id) ?? Number.MAX_SAFE_INTEGER) ||
      a.entry.startDate.localeCompare(b.entry.startDate) ||
      a.entry.id.localeCompare(b.entry.id),
  );
  const active = new MinPriorityQueue<{ right: number; lane: number }>(
    (item) => item.right,
  );
  const free = new MinPriorityQueue<number>();
  const available = new Set<number>();
  const ongoingLanes = new Set<number>();
  const lanes: TimelinePlacement<T>[][] = [];
  for (const placement of placements) {
    // End dates are inclusive in timelineBar; touching pixel edges may share a lane.
    // Subpixel arithmetic can put mathematically touching edges a few ulps apart.
    while (
      !active.isEmpty() &&
      (active.front()?.right ?? Infinity) <= placement.left + 1e-7
    ) {
      const released = active.dequeue();
      if (released && !ongoingLanes.has(released.lane)) {
        available.add(released.lane);
        free.enqueue(released.lane);
      }
    }
    let lane = previous.get(placement.entry.id);
    if (lane === undefined || !available.delete(lane)) {
      lane = undefined;
      while (!free.isEmpty() && lane === undefined) {
        const candidate = free.dequeue();
        if (candidate !== null && available.delete(candidate)) lane = candidate;
      }
    }
    if (lane === undefined) {
      lane = lanes.length;
      lanes.push([]);
    }
    // Each ongoing entry keeps its own lane, including future-starting entries.
    if (entryStatus(placement.entry, today) === 'ongoing')
      ongoingLanes.add(lane);
    placement.lane = lane;
    lanes[lane]?.push(placement);
    active.enqueue({ right: placement.right, lane });
  }
  return lanes;
}
