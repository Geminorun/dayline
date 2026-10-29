/** Fixed bands preserve meaning across platforms, zoom levels and themes. */
export const FOCUS_HEAT_BANDS = [
  { level: 1, from: 1 },
  { level: 2, from: 2 },
  { level: 3, from: 4 },
  { level: 4, from: 8 },
] as const;
export function focusHeatLevel(count: number): number {
  let level = 1;
  for (const band of FOCUS_HEAT_BANDS)
    if (count >= band.from) level = band.level;
  return level;
}
