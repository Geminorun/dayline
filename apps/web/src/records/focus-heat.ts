/** Fixed counts keep heat levels comparable while zooming and filtering. */
export const FOCUS_HEAT_STEPS = [
  { level: 1, from: 1, label: '1 天' },
  { level: 2, from: 2, label: '2–3 天' },
  { level: 3, from: 4, label: '4–7 天' },
  { level: 4, from: 8, label: '8 天及以上' },
] as const;

export function focusHeatLevel(count: number): number {
  let level = 1;
  for (const step of FOCUS_HEAT_STEPS)
    if (count >= step.from) level = step.level;
  return level;
}
