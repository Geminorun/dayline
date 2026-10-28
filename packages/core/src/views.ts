import {
  dateOrdinal,
  durationDays,
  entryStatus,
  isCalendarDate,
} from './index.js';
export const MIN_DAY = 1;
export const MAX_DAY = 3652059;
/** Binary year search avoids Date's 0–99 year special case. */
export function ordinalDate(ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < MIN_DAY || ordinal > MAX_DAY)
    throw new RangeError('Date outside 0001–9999');
  let low = 1,
    high = 9999;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (dateOrdinal(`${String(mid).padStart(4, '0')}-01-01`) <= ordinal)
      low = mid;
    else high = mid - 1;
  }
  let month = 1;
  while (
    month < 12 &&
    dateOrdinal(
      `${String(low).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-01`,
    ) <= ordinal
  )
    month++;
  const first = `${String(low).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
  return (
    first.slice(0, 8) +
    String(ordinal - dateOrdinal(first) + 1).padStart(2, '0')
  );
}
export function shiftDate(date: string, amount: number): string {
  return ordinalDate(
    Math.max(MIN_DAY, Math.min(MAX_DAY, dateOrdinal(date) + amount)),
  );
}
export function shiftMonth(date: string, amount: number): string {
  const index = Math.max(
    0,
    Math.min(
      119987,
      (Number(date.slice(0, 4)) - 1) * 12 +
        Number(date.slice(5, 7)) -
        1 +
        amount,
    ),
  );
  return `${String(Math.floor(index / 12) + 1).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}-01`;
}
export function weekDates(date: string): string[] {
  const day = dateOrdinal(date),
    start = day - ((day - 1) % 7);
  return Array.from({ length: Math.min(7, MAX_DAY - start + 1) }, (_, i) =>
    ordinalDate(start + i),
  );
}
export interface ViewEntry {
  id: string;
  categoryId: string;
  title: string;
  startDate: string;
  endDate: string | null;
  deletedAt?: string | null;
}
export interface EntryFilter {
  search: string;
  categoryId: string;
  status: 'all' | 'ongoing' | 'ended';
  sort: 'asc' | 'desc';
}
export const emptyFilter = (): EntryFilter => ({
  search: '',
  categoryId: '',
  status: 'ongoing',
  sort: 'desc',
});
export function selectEntries<T extends ViewEntry>(
  entries: readonly T[],
  today: string,
  filter: EntryFilter,
  range?: { start: number; endExclusive: number },
): T[] {
  const search = filter.search.trim().toLocaleLowerCase('en-US');
  return entries
    .filter(
      (e) =>
        !e.deletedAt &&
        (!search || e.title.toLocaleLowerCase('en-US').includes(search)) &&
        (!filter.categoryId || e.categoryId === filter.categoryId) &&
        (filter.status === 'all' || entryStatus(e, today) === filter.status) &&
        (!range ||
          (dateOrdinal(e.startDate) < range.endExclusive &&
            Math.max(
              dateOrdinal(e.startDate),
              dateOrdinal(e.endDate ?? today),
            ) >= range.start)),
    )
    .sort(
      (a, b) =>
        (filter.sort === 'asc' ? 1 : -1) *
          a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id),
    );
}
export function spanLabel(entry: ViewEntry, today: string): string {
  if (entry.startDate > today) return `从 ${entry.startDate} 开始`;
  return `${entry.endDate ? '跨度' : '已持续'} ${durationDays(entry, today)} 天`;
}
export type TimelineScale = 'month' | 'quarter' | 'year' | 'all';
export interface TimelineWindow {
  start: number;
  endExclusive: number;
  width: number;
  pixelsPerDay: number;
  ticks: { day: number; x: number; label: string }[];
  focusUnit: 'day' | 'week' | 'month';
  todayX: number | null;
}
export function timelineWindow(
  entries: readonly ViewEntry[],
  today: string,
  scale: TimelineScale,
  anchor: string,
  availableWidth = 900,
  mobile = false,
): TimelineWindow {
  if (!isCalendarDate(anchor)) anchor = today;
  const year = anchor.slice(0, 4),
    month = Number(anchor.slice(5, 7));
  let first =
    scale === 'year'
      ? `${year}-01-01`
      : scale === 'quarter'
        ? `${year}-${String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, '0')}-01`
        : `${anchor.slice(0, 7)}-01`;
  if (scale === 'all' && !entries.length) first = today.slice(0, 7) + '-01';
  let lastMonth = shiftMonth(
    first,
    scale === 'year' ? 11 : scale === 'quarter' ? 2 : 0,
  );
  if (scale === 'all' && entries.length) {
    first =
      entries
        .reduce(
          (min, e) => (e.startDate < min ? e.startDate : min),
          '9999-12-31',
        )
        .slice(0, 7) + '-01';
    const last = entries.reduce((max, e) => {
      const end = e.endDate ?? (e.startDate > today ? e.startDate : today);
      return end > max ? end : max;
    }, '0001-01-01');
    lastMonth = last.slice(0, 7) + '-01';
  }
  const start = dateOrdinal(first),
    endExclusive =
      lastMonth === '9999-12-01'
        ? MAX_DAY + 1
        : dateOrdinal(shiftMonth(lastMonth, 1));
  const days = endExclusive - start;
  const pixelsPerDay =
    scale === 'all'
      ? Math.max(availableWidth, 600) / days
      : scale === 'month'
        ? mobile
          ? 28
          : 34
        : scale === 'quarter'
          ? mobile
            ? 10
            : 12
          : 4;
  const width = days * pixelsPerDay;
  const ticks: TimelineWindow['ticks'] = [];
  if (scale === 'month')
    for (let day = start; day < endExclusive; day++)
      ticks.push({
        day,
        x: (day - start) * pixelsPerDay,
        label: ordinalDate(day).slice(8),
      });
  else if (scale === 'quarter') {
    ticks.push({ day: start, x: 0, label: ordinalDate(start).slice(5) });
    for (
      let day = start + (7 - ((start - 1) % 7));
      day < endExclusive;
      day += 7
    )
      ticks.push({
        day,
        x: (day - start) * pixelsPerDay,
        label: ordinalDate(day).slice(5),
      });
  } else if (scale === 'year') {
    for (let index = 0; index < 12; index++) {
      const date = shiftMonth(first, index),
        day = dateOrdinal(date);
      ticks.push({
        day,
        x: (day - start) * pixelsPerDay,
        label: date.slice(5, 7) + '月',
      });
    }
  } else {
    // Full-date labels get a bounded pixel budget, even for a 9,999-year interval.
    const budget = Math.max(2, Math.min(80, Math.floor(width / 100))),
      step = Math.max(1, Math.ceil(days / budget));
    for (let day = start; day < endExclusive; day += step)
      ticks.push({
        day,
        x: (day - start) * pixelsPerDay,
        label: ordinalDate(day),
      });
  }
  const t = dateOrdinal(today);
  return {
    start,
    endExclusive,
    width,
    pixelsPerDay,
    ticks,
    focusUnit:
      scale === 'month' || days <= 31
        ? 'day'
        : scale === 'quarter' || days <= 120
          ? 'week'
          : 'month',
    todayX:
      t >= start && t < endExclusive ? (t - start + 0.5) * pixelsPerDay : null,
  };
}
export function timelineBar(
  entry: ViewEntry,
  today: string,
  window: TimelineWindow,
) {
  const start = dateOrdinal(entry.startDate),
    end = Math.max(start, dateOrdinal(entry.endDate ?? today)) + 1;
  if (start >= window.endExclusive || end <= window.start) return null;
  return {
    left: (Math.max(start, window.start) - window.start) * window.pixelsPerDay,
    width: Math.max(
      4,
      (Math.min(end, window.endExclusive) - Math.max(start, window.start)) *
        window.pixelsPerDay,
    ),
    continuesBefore: start < window.start,
    continuesAfter: end > window.endExclusive,
  };
}
export interface ViewFocus {
  entryId: string;
  date: string;
  focused: boolean;
}
export function timelineFocusGroups(
  entries: readonly ViewEntry[],
  focusDays: readonly ViewFocus[],
  today: string,
  window: TimelineWindow,
) {
  const active = new Map(
    entries.filter((e) => !e.deletedAt).map((e) => [e.id, e]),
  );
  const groups = new Map<
    string,
    { entryId: string; key: string; left: number; dates: string[] }
  >();
  for (const focus of focusDays) {
    const entry = active.get(focus.entryId);
    if (
      !entry ||
      !focus.focused ||
      focus.date > today ||
      focus.date < entry.startDate ||
      (entry.endDate && focus.date > entry.endDate)
    )
      continue;
    const day = dateOrdinal(focus.date);
    if (day < window.start || day >= window.endExclusive) continue;
    const grouped =
      window.focusUnit === 'day'
        ? day
        : window.focusUnit === 'week'
          ? day - ((day - 1) % 7)
          : dateOrdinal(focus.date.slice(0, 7) + '-01');
    const key = `${entry.id}:${grouped}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        entryId: entry.id,
        key,
        left:
          (Math.max(grouped, window.start) - window.start + 0.5) *
          window.pixelsPerDay,
        dates: [],
      };
      groups.set(key, group);
    }
    group.dates.push(focus.date);
  }
  // On very long all-time windows, several months can share a pixel. Merge their
  // exact date lists into a deterministic visible group, never choose a random day.
  const visibleGroups: {
    entryId: string;
    key: string;
    left: number;
    dates: string[];
  }[] = [];
  const ordered = [...groups.values()].sort(
    (a, b) => a.entryId.localeCompare(b.entryId) || a.left - b.left,
  );
  const minimumDistance = Math.max(44, window.width / 80);
  for (const group of ordered) {
    const previous = visibleGroups.at(-1);
    if (
      previous?.entryId === group.entryId &&
      group.left - previous.left < minimumDistance
    )
      previous.dates.push(...group.dates);
    else visibleGroups.push({ ...group, dates: [...group.dates] });
  }
  return visibleGroups.map((g) => ({ ...g, dates: g.dates.sort() }));
}
export function visibleRows(
  count: number,
  scrollTop: number,
  height: number,
  rowHeight: number,
  overscan = 10,
) {
  const effectiveTop = Math.max(
    0,
    Math.min(scrollTop, Math.max(0, count * rowHeight - height)),
  );
  const start = Math.min(
      count,
      Math.max(0, Math.floor(effectiveTop / rowHeight) - overscan),
    ),
    end = Math.min(
      count,
      Math.ceil((effectiveTop + height) / rowHeight) + overscan,
    );
  return {
    start,
    end,
    before: start * rowHeight,
    after: (count - end) * rowHeight,
  };
}
