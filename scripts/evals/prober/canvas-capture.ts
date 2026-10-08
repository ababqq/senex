/**
 * Frame capture that cannot pile up. A capture deadline does not cancel the Playwright promise
 * behind it, so the lane stays busy until the real work settles, even after it has returned a
 * timeout to the probe; a second capture asked for meanwhile is refused as in flight.
 */
import { setTimeout as delay } from "node:timers/promises";

/** Why a capture returned no value. */
export const CaptureFailure = {
  InFlight: "capture-in-flight",
  Rejected: "capture-rejected",
  Timeout: "capture-timeout",
} as const;
export type CaptureFailure = (typeof CaptureFailure)[keyof typeof CaptureFailure];

/** One capture's outcome: a value, or the reason there is none. */
export interface CaptureOutcome<T> {
  value: T | null;
  failure: CaptureFailure | null;
}

/** A capture lane: runs one piece of work at a time under a deadline. */
export type CaptureLane = <T>(work: () => Promise<T>, timeoutMs: number) => Promise<CaptureOutcome<T>>;

/** Create a lane that runs one capture at a time. */
export function createCaptureLane(): CaptureLane {
  let busy = false;
  return async function run<T>(work: () => Promise<T>, timeoutMs: number): Promise<CaptureOutcome<T>> {
    if (busy) return { value: null, failure: CaptureFailure.InFlight };
    busy = true;
    const pending: Promise<CaptureOutcome<T>> = Promise.resolve()
      .then(work)
      .then(
        (value) => ({ value, failure: null }),
        () => ({ value: null, failure: CaptureFailure.Rejected }),
      )
      .finally(() => {
        busy = false;
      });
    const deadline = new AbortController();
    const timeout = delay(timeoutMs, { value: null, failure: CaptureFailure.Timeout }, { signal: deadline.signal });
    try {
      return await Promise.race([pending, timeout.catch(() => ({ value: null, failure: CaptureFailure.Timeout }))]);
    } finally {
      deadline.abort();
    }
  };
}

/** A canvas readback: a PNG data URL and its size. */
export interface CanvasPixels {
  png: string;
  width: number;
  height: number;
  capturedAt: number;
}

/**
 * Read the largest visible canvas as a PNG data URL, scaled to at most 1280x720. Runs inside the
 * project document from its own source text, so it names only page globals.
 */
export function readCanvasPixels(): CanvasPixels | null {
  const MAX_WIDTH = 1280;
  const MAX_HEIGHT = 720;
  const visible = (c: HTMLCanvasElement) => {
    const r = c.getBoundingClientRect();
    const s = getComputedStyle(c);
    return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
  };
  const canvas = Array.from(document.querySelectorAll("canvas"))
    .filter(visible)
    .sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!canvas || canvas.width < 2 || canvas.height < 2) return null;
  const scale = Math.min(1, MAX_WIDTH / canvas.width, MAX_HEIGHT / canvas.height);
  const copy = document.createElement("canvas");
  copy.width = Math.max(1, Math.round(canvas.width * scale));
  copy.height = Math.max(1, Math.round(canvas.height * scale));
  const ctx = copy.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0, copy.width, copy.height);
  return { png: copy.toDataURL("image/png"), width: copy.width, height: copy.height, capturedAt: Date.now() };
}
