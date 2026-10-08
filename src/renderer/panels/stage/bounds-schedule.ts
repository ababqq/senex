/** When the native project view's rectangle is re-read while its slot keeps moving. */

/** The browser's animation frames, injectable so a test can drive them. */
export interface BoundsClock {
  requestAnimationFrame(callback: () => void): number;
  cancelAnimationFrame(handle: number): void;
}

/**
 * Re-read the slot in the next frame, once however many layout signals arrive before it; `stop`
 * drops a pending read. A drag of the window's edge or the chat handle signals every frame, and
 * the project follows it frame by frame as a browser page would: a settle delay held the project still
 * until the drag paused.
 */
export function scheduleBounds(report: () => void, clock: BoundsClock): { signal(): void; stop(): void } {
  let frame = 0;
  return {
    signal: () => {
      if (frame) return;
      frame = clock.requestAnimationFrame(() => {
        frame = 0;
        report();
      });
    },
    stop: () => {
      clock.cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}
