export const TIME_ZONE = 'Asia/Shanghai' as const;
export const BUSINESS_TIME_ZONE = TIME_ZONE;
export const DEFAULT_CATEGORIES = [
  { seedKey: 'game', name: '游戏', color: '#8B80D8' },
  { seedKey: 'reading', name: '阅读', color: '#6C9BCE' },
  { seedKey: 'work', name: '工作', color: '#D6A063' },
  { seedKey: 'sport', name: '运动', color: '#6CA58A' },
  { seedKey: 'life', name: '生活', color: '#B88EAA' },
  { seedKey: 'other', name: '其他', color: '#A0A4B3' },
] as const;
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (days[month - 1] ?? 0)
  );
}
/** Gregorian day ordinal, independent of device timezone and DST. */
export function dateOrdinal(value: string): number {
  if (!isCalendarDate(value)) throw new RangeError('Invalid calendar date');
  const year = Number(value.slice(0, 4)) - 1;
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8));
  const leap =
    (year + 1) % 4 === 0 && ((year + 1) % 100 !== 0 || (year + 1) % 400 === 0);
  const cumulative = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  return (
    year * 365 +
    Math.floor(year / 4) -
    Math.floor(year / 100) +
    Math.floor(year / 400) +
    (cumulative[month - 1] ?? 0) +
    (leap && month > 2 ? 1 : 0) +
    day
  );
}
export function businessToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) =>
    parts.find((value) => value.type === type)?.value ?? '';
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
}
export interface DateRange {
  startDate: string;
  endDate: string | null;
}
export function entryStatus(
  entry: DateRange,
  today: string,
): 'not_started' | 'ongoing' | 'ended' {
  if (entry.startDate > today) return 'not_started';
  return entry.endDate !== null && entry.endDate <= today ? 'ended' : 'ongoing';
}
export function coversDate(
  entry: DateRange,
  date: string,
  today: string,
): boolean {
  return date >= entry.startDate && date <= (entry.endDate ?? today);
}
export function durationDays(entry: DateRange, today: string): number {
  return Math.max(
    0,
    dateOrdinal(entry.endDate ?? today) - dateOrdinal(entry.startDate) + 1,
  );
}
export function intersectsRange(
  entry: DateRange,
  start: string,
  end: string,
  today: string,
): boolean {
  return entry.startDate <= end && (entry.endDate ?? today) >= start;
}
export function summarizeEntries<T extends DateRange & { categoryId: string }>(
  entries: readonly T[],
  today: string,
) {
  const categories: Record<string, number> = {};
  for (const entry of entries)
    categories[entry.categoryId] = (categories[entry.categoryId] ?? 0) + 1;
  return {
    count: entries.length,
    ongoing: entries.filter((entry) => entryStatus(entry, today) === 'ongoing')
      .length,
    categoryCount: Object.keys(categories).length,
    categories,
  };
}
