declare const wx: { getPerformance?: () => { now: () => number } };
export function monotonicNow() {
  return typeof wx !== 'undefined' && typeof wx.getPerformance === 'function'
    ? wx.getPerformance().now()
    : Date.now();
}
