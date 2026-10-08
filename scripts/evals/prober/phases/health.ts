/**
 * The machine-health rows only the full prober answers: `l1.no_errors_60s` over its real 60 s window
 * (the quick probe answers a short-window variant), `l1.frame_rate_floor` and `l3.assets_usable`.
 *
 * Errors are UNIONED across every snapshot, because "did anything throw during the run" is a question
 * about the run, not about whichever document it ended on. A pass needs a page that ran through the
 * window: zero errors is also what a page that never scheduled a frame produces.
 *
 * The frame rate is a LOWER BOUND (screenshots and the mirror readback steal time from the render
 * loop) and never a quality score. On a software rasteriser it cannot be attributed to the project, so
 * the row never gates there (`fpsRowsGate`).
 */
import { SECOND_MS } from "../../../../src/shared/duration.ts";
import { CheckResult, ProbeRow, type RendererMode } from "../../vocabulary.ts";
import { classifyContextLosses, ContextEventKind } from "../context-loss.ts";
import { type InstrumentSnapshot, type PageEvents, rafOf } from "../driver.ts";
import { percentile } from "../frames.ts";
import { fpsRowsGate } from "../renderer.ts";
import type { Check } from "../types.ts";
import { loaderFailureCount, type PageRan, pageRan } from "../verdicts.ts";
import { machineRow } from "./row.ts";

/** The window `l1.no_errors_60s` is defined against. */
export const SPEC_ERROR_WINDOW_MS = 60 * SECOND_MS;
/** The frame-rate floor the row reads. */
export const FPS_FLOOR = 15;
/** rAF gaps outside (0, this) are a paused document, not a frame. */
export const MAX_FRAME_GAP_MS = 5 * SECOND_MS;
const MEDIAN = 0.5;
const P95 = 0.95;

const lastOf = <T>(list: readonly T[]): T | null => (list.length ? list[list.length - 1] : null);

/** Keep the first of each key across lists. */
function unionBy<T>(lists: ReadonlyArray<readonly T[]>, key: (v: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const list of lists) for (const item of list) if (!seen.has(key(item))) seen.set(key(item), item);
  return [...seen.values()];
}

/** Whether the page ran, over an optional window. */
export function ranOver(snapshots: readonly InstrumentSnapshot[], events: PageEvents, windowMs?: number): PageRan {
  const raf = rafOf(lastOf(snapshots));
  return pageRan({
    rafFrames: raf.distinctFrames,
    requests: events.network.length,
    lastRafPageMs: raf.lastT,
    windowMs,
  });
}

/** Uncaught errors, rejections and unsurvived context losses in the first `windowMs` of page time. */
export function errorsWithin(snapshots: readonly InstrumentSnapshot[], windowMs: number) {
  const within = (t: number) => t <= windowMs;
  const byMessage = (e: { t: number; message: string }) => `${Math.round(e.t)}:${e.message}`;
  const uncaught = unionBy(
    snapshots.map((s) => s.errors ?? []),
    byMessage,
  );
  const rejections = unionBy(
    snapshots.map((s) => s.rejections ?? []),
    byMessage,
  );
  const losses = unionBy(
    snapshots.map((s) => (s.contextLost ?? []).filter((e) => e.kind !== ContextEventKind.CreationError)),
    (e) => `${Math.round(e.t)}:${e.kind}`,
  );
  const fatal = classifyContextLosses(losses, rafOf(lastOf(snapshots)).lastT).fatal;
  return {
    uncaught: uncaught.filter((e) => within(e.t)).length,
    rejections: rejections.filter((e) => within(e.t)).length,
    contextLost: fatal.filter((e) => within(e.t)).length,
    first: uncaught.find((e) => within(e.t))?.message ?? null,
  };
}

/** `l1.no_errors_60s` over its full window, unioned across snapshots. */
export function noErrors60sRow(snapshots: readonly InstrumentSnapshot[], events: PageEvents): Check {
  const id = ProbeRow.L1NoErrors60s;
  const counts = errorsWithin(snapshots, SPEC_ERROR_WINDOW_MS);
  const value = { windowMs: SPEC_ERROR_WINDOW_MS, quickWindow: false, ...counts };
  if (counts.uncaught + counts.rejections + counts.contextLost > 0) {
    const first = counts.first ? ` First: ${counts.first}` : "";
    const detail = `In the first 60s: ${counts.uncaught} uncaught error(s), ${counts.rejections} unhandled rejection(s), ${counts.contextLost} unsurvived WebGL context loss(es).${first}`;
    return machineRow(id, CheckResult.Fail, detail, value);
  }
  const ran = ranOver(snapshots, events, SPEC_ERROR_WINDOW_MS);
  if (!ran.ran) {
    const detail = `No error was recorded in the first 60s, but ${ran.why}, so zero errors is what a page that did not run would also produce.`;
    return machineRow(id, CheckResult.Unknown, detail, value);
  }
  const detail =
    "Zero uncaught exceptions, unhandled rejections and unsurvived WebGL context losses in the first 60s, on a page that ran through the window. Console noise is recorded, not gated.";
  return machineRow(id, CheckResult.Pass, detail, value);
}

/** `l1.frame_rate_floor`: from the page's own rAF cadence; never gating on a software rasteriser. */
export function frameRateRow(snap: InstrumentSnapshot | null, mode: RendererMode, floor = FPS_FLOOR): Check {
  const id = ProbeRow.L1FrameRateFloor;
  const gates = fpsRowsGate(mode);
  const intervals = rafOf(snap).intervals.filter((v) => v > 0 && v < MAX_FRAME_GAP_MS);
  const median = intervals.length ? percentile(intervals, MEDIAN) : null;
  const p95 = intervals.length ? percentile(intervals, P95) : null;
  const fps = median ? SECOND_MS / median : null;
  const p05Fps = p95 ? SECOND_MS / p95 : null;
  const renderer = snap?.gl?.renderer ?? null;
  const value = {
    fps,
    p05Fps,
    floor,
    rendererMode: mode,
    renderer,
    samples: intervals.length,
    measurementIsLowerBound: true,
  };
  if (fps === null) {
    const detail = "The page scheduled no animation frame callbacks, so there is no frame cadence to measure.";
    return machineRow(id, CheckResult.Unknown, detail, value, gates);
  }
  const figures = `${fps.toFixed(1)} fps median (5th percentile ${(p05Fps ?? 0).toFixed(1)} fps) from the page's own rAF cadence`;
  if (fps >= floor) return machineRow(id, CheckResult.Pass, `${figures}.`, value, gates);
  if (!gates) {
    const detail = `${figures}, below the ${floor} fps floor, but WebGL ran on a software rasteriser (${renderer ?? "unnamed"}): faithful per frame and slow per second, so this number cannot be attributed to the project.`;
    return machineRow(id, CheckResult.Unknown, detail, value, false);
  }
  const detail = `${figures}, below the ${floor} fps floor on ${renderer ?? "an unnamed renderer"}.`;
  return machineRow(id, CheckResult.Fail, detail, value, gates);
}

/**
 * `l3.assets_usable`: the other half of `assets_arrived`. That row reads network status; this one
 * reads whether the project could use the bytes (every GLB HTTP 200, every one thrown away by a loader).
 * Fails only on positive evidence and only when the page ran; L3, so it never un-scores a run.
 */
export function assetsUsableRow(events: PageEvents, ran: PageRan): Check {
  const id = ProbeRow.L3AssetsUsable;
  const failures = loaderFailureCount(events.console);
  const value = { failures, pageRan: ran.ran, consoleLines: events.console.length };
  if (!ran.ran) {
    return machineRow(
      id,
      CheckResult.Unknown,
      `The page did not run (${ran.why}), so nothing observed whether its assets were usable.`,
      value,
    );
  }
  if (failures === 0) return machineRow(id, CheckResult.Pass, "No loader reported an asset it could not use.", value);
  const detail = `${failures} console line(s) report an asset that ARRIVED and could not be used (a loader that gave up, or a non-drawable passed to a 2D canvas). Their bytes were HTTP 200, so \`assets_arrived\` cannot see them.`;
  return machineRow(id, CheckResult.Fail, detail, value);
}
