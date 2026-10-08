/**
 * What the full prober's phases share beyond the quick probe's `PhaseContext`: the accumulated
 * page-side series, the capture breaker, the responsiveness record, a timeline, and the pointer the
 * page may offer. Every input still goes through the quick probe's guards (`context.ts`): a key the
 * focus guard refuses is not sent, a click the chrome guard refuses is not sent, and both say why.
 *
 * THE POINTER. `ProbePage` has clicks and key presses; a drag, a hover move and the look phase's CDP
 * fallback need a real mouse (`ProbePage.mouse`, a `ProbeMouse`), which a page MAY carry. Without one a drag goes out as
 * synthetic pointer events (`dispatchLookDeltasInPage`, the quick probe's own drag), a hover move is
 * skipped and counted, and the look phase records that it had no fallback to try, so a missing
 * mechanism never reads as a project that ignored input.
 */
import type { ProbePhase } from "../../vocabulary.ts";
import {
  type CaptureBreakerState,
  captureBreakerSentence,
  createCaptureBreaker,
  recordShot,
  shouldAttempt,
} from "../capture-breaker.ts";
import type { ProbePage } from "../driver.ts";
import type { LoggedFrame } from "../frame-log.ts";
import { createResponsiveness, recordRead, type Responsiveness } from "../probe-budget.ts";
import { dispatchLookDeltasInPage } from "../start-control.ts";
import { ShotKind } from "../types.ts";
import { captureFrame, clickRefusal, keyRefusal, type PhaseContext } from "./context.ts";
import { createSeriesLog, pullSeries, type SeriesLog } from "./series.ts";

/** The most frames one probe writes; the soak alone could otherwise fill a disk. */
export const MAX_FRAMES = 300;
/** Drag steps and the pause between them, sized so a per-frame delta reader sees a gesture. */
export const DRAG_STEPS = 12;
export const DRAG_STEP_MS = 30;

export type { ProbeMouse } from "../driver.ts";

/** A probe page, which may carry a real mouse (`ProbePage.mouse`). */
export type FullProbePage = ProbePage;

/** One line of the probe's own timeline, run-clock ms. */
export interface TimelineEvent {
  atMs: number;
  phase: ProbePhase;
  event: string;
  detail: unknown;
}

/** The shared state of one full probe run. */
export interface FullPhaseContext extends PhaseContext {
  page: FullProbePage;
  series: SeriesLog;
  breaker: CaptureBreakerState;
  resp: Responsiveness;
  timeline: TimelineEvent[];
  /** Inputs the pointer could not send because the page has no mouse. */
  pointerSkips: number;
}

/** Extend a quick-probe context for the full probe. */
export function fullContext(ctx: PhaseContext): FullPhaseContext {
  return {
    ...ctx,
    series: createSeriesLog(),
    breaker: createCaptureBreaker(),
    resp: createResponsiveness(),
    timeline: [],
    pointerSkips: 0,
  };
}

/** Append a timeline line. */
export function logEvent(ctx: FullPhaseContext, phase: ProbePhase, event: string, detail: unknown = null): void {
  ctx.timeline.push({ atMs: ctx.page.elapsedMs(), phase, event, detail });
}

/** Pull the series and feed the responsiveness record: an unanswered read counts against the page. */
export async function pull(ctx: FullPhaseContext): Promise<boolean> {
  const answered = await pullSeries(ctx, ctx.series);
  recordRead(ctx.resp, answered, ctx.page.elapsedMs());
  return answered;
}

/**
 * A page frame behind the capture breaker and the frame cap: a suspended capture path is skipped and
 * counted instead of costing the probe its timeout again.
 */
export async function shoot(ctx: FullPhaseContext, phase: ProbePhase, label: string): Promise<LoggedFrame | null> {
  if (ctx.frames.frames.length >= MAX_FRAMES) return null;
  const startedMs = ctx.page.elapsedMs();
  const gate = shouldAttempt(ctx.breaker, ShotKind.Page, startedMs);
  if (!gate.attempt) {
    logEvent(ctx, phase, "screenshot.skipped", { label, why: gate.why });
    return null;
  }
  const frame = await captureFrame(ctx, phase, label);
  const ok = frame !== null || ctx.frames.firstRenderMs === null;
  recordShot(ctx.breaker, ShotKind.Page, ok, ctx.page.elapsedMs(), ctx.page.elapsedMs() - startedMs);
  if (!ok) logEvent(ctx, phase, "screenshot.failed", { label });
  return frame;
}

/** The breaker's sentence for the scorecard, or `null` when it never tripped. */
export function captureSentence(ctx: FullPhaseContext): string | null {
  return captureBreakerSentence(ctx.breaker);
}

/** A key through the focus guard: whether it went out, and the guard's reason when it did not. */
export async function sendKey(
  ctx: FullPhaseContext,
  phase: ProbePhase,
  key: string,
  holdMs: number,
): Promise<{ sent: boolean; reason: string | null }> {
  const reason = await keyRefusal(ctx);
  if (reason !== null) {
    logEvent(ctx, phase, "key.refused", { key, reason });
    return { sent: false, reason };
  }
  const sent = await ctx.page.press(key, holdMs);
  return { sent, reason: sent ? null : "the key press did not settle" };
}

/** A click at (x, y) through the chrome guard: whether it went out, and the guard's reason when it did not. */
export async function sendClick(
  ctx: FullPhaseContext,
  phase: ProbePhase,
  x: number,
  y: number,
): Promise<{ sent: boolean; reason: string | null }> {
  const reason = await clickRefusal(ctx, x, y);
  if (reason !== null) {
    logEvent(ctx, phase, "click.refused", { x, y, reason });
    return { sent: false, reason };
  }
  const sent = await ctx.page.clickAt(x, y);
  return { sent, reason: sent ? null : "the click did not settle" };
}

/** The viewport centre. */
export function centreOf(ctx: PhaseContext): { x: number; y: number } {
  const { width, height } = ctx.page.viewport();
  return { x: Math.floor(width / 2), y: Math.floor(height / 2) };
}

/** Which part of a drag a step is. */
function dragStep(step: number): "start" | "move" | "end" {
  if (step === 0) return "start";
  return step === DRAG_STEPS - 1 ? "end" : "move";
}

/** A synthetic drag of (dx, dy) from the largest canvas's centre: press, stepped moves, release. */
async function syntheticDrag(ctx: FullPhaseContext, dx: number, dy: number): Promise<boolean> {
  let dispatched = 0;
  for (let step = 0; step < DRAG_STEPS; step++) {
    const fraction = (step + 1) / DRAG_STEPS;
    const moved = await ctx.page.evaluate(dispatchLookDeltasInPage, {
      dx: dx / DRAG_STEPS,
      dy: dy / DRAG_STEPS,
      offsetX: Math.round(dx * fraction),
      offsetY: Math.round(dy * fraction),
      phase: dragStep(step),
    });
    dispatched += moved?.dispatched ?? 0;
    await ctx.sleep(DRAG_STEP_MS);
  }
  return dispatched > 0;
}

/**
 * Press at the viewport centre, move by (dx, dy), release: the one gesture a putt, a slingshot, a
 * swipe and a drag-to-look camera all read. A real mouse when the page has one, else synthetic events.
 */
export async function dragFromCentre(ctx: FullPhaseContext, dx: number, dy: number): Promise<boolean> {
  const mouse = ctx.page.mouse;
  if (!mouse) return syntheticDrag(ctx, dx, dy);
  const { x, y } = centreOf(ctx);
  const moved = await mouse.move(x, y, 1);
  const down = await mouse.down();
  const dragged = await mouse.move(x + dx, y + dy, DRAG_STEPS);
  const up = await mouse.up();
  return moved && down && dragged && up;
}

/** A hover move to (x, y); skipped and counted when the page has no mouse. */
export async function hoverTo(ctx: FullPhaseContext, x: number, y: number, steps: number): Promise<boolean> {
  const mouse = ctx.page.mouse;
  if (!mouse) {
    ctx.pointerSkips++;
    return false;
  }
  return mouse.move(x, y, steps);
}
