import { TIMELINE_RECENT_POSITION } from '@dayline/core';
import type { TimelineCanvasWindow } from '@dayline/core';
export interface TouchPoint {
  clientX: number;
  clientY: number;
}
export interface CameraChange {
  day: number;
  days: number;
}
interface Baseline {
  points: TouchPoint[];
  window: TimelineCanvasWindow;
  left: number;
  top: number;
  scroll: number;
}
/** Native touch coordinates are pixels. Zoom preserves the date under the midpoint. */
export class TimelineGesture {
  private base: Baseline | null = null;
  private direction: 'x' | 'y' | null = null;
  moved = false;
  start(
    points: readonly TouchPoint[],
    window: TimelineCanvasWindow,
    left: number,
    top: number,
    scroll: number,
  ) {
    this.base = {
      points: points.slice(0, 2).map((p) => ({ ...p })),
      window,
      left,
      top,
      scroll,
    };
    this.direction = null;
    this.moved = false;
  }
  rebase(
    points: readonly TouchPoint[],
    window: TimelineCanvasWindow,
    scroll: number,
  ) {
    const b = this.base;
    if (!b) return;
    const moved = this.moved;
    this.start(points, window, b.left, b.top, scroll);
    this.moved = moved;
  }
  move(
    points: readonly TouchPoint[],
  ): { camera?: CameraChange; scroll?: number } | null {
    const b = this.base,
      a = b?.points[0],
      p = points[0];
    if (!b || !a || !p) return null;
    const q = points[1],
      second = b.points[1];
    if (q && second) {
      const before = Math.hypot(
          second.clientX - a.clientX,
          second.clientY - a.clientY,
        ),
        after = Math.hypot(q.clientX - p.clientX, q.clientY - p.clientY);
      if (before < 8 || after < 8) return null;
      this.moved = true;
      const days = Math.max(
        31,
        Math.min(
          b.window.maxDays,
          ((b.window.endExclusive - b.window.start) * before) / after,
        ),
      );
      const oldMiddle =
          ((a.clientX + second.clientX) / 2 - b.left) / b.window.width,
        newMiddle = ((p.clientX + q.clientX) / 2 - b.left) / b.window.width;
      const date =
        b.window.start + oldMiddle * (b.window.endExclusive - b.window.start);
      return {
        camera: {
          day: date - newMiddle * days + days * TIMELINE_RECENT_POSITION,
          days,
        },
      };
    }
    if (q || second) return null;
    const dx = p.clientX - a.clientX,
      dy = p.clientY - a.clientY;
    if (!this.direction) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 6) return null;
      this.direction = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    this.moved = true;
    return this.direction === 'x'
      ? {
          camera: {
            day:
              b.window.start -
              dx / b.window.pixelsPerDay +
              (b.window.endExclusive - b.window.start) *
                TIMELINE_RECENT_POSITION,
            days: b.window.endExclusive - b.window.start,
          },
        }
      : { scroll: Math.max(0, b.scroll - dy) };
  }
  end() {
    const moved = this.moved;
    this.base = null;
    this.direction = null;
    return moved;
  }
}
