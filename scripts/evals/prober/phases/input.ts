/**
 * The input phase: short bursts of the inputs a player tries first (movement keys, jump, a mouse
 * drag), each measured in its own sampler window against the no-input baseline, with the camera read
 * before and after. A frame is taken after every burst; those are the quick probe's interaction frames.
 */
import { SECOND_MS } from "../../../../src/shared/duration.ts";
import { ProbePhase } from "../../vocabulary.ts";
import { lastCameraSample, readProbeSnapshotInPage } from "../driver.ts";
import { dispatchLookDeltasInPage } from "../start-control.ts";
import { pullSeries, type SeriesCursor } from "./baseline.ts";
import { captureFrame, guardedKey, type PhaseContext } from "./context.ts";
import { cameraMovement } from "./entrance.ts";

/** The keys a player tries first, one burst each. */
export const BURST_KEYS = ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "Space"] as const;
/** The burst name of the mouse drag. */
export const DRAG_BURST = "drag";
/** How long each key is held. */
export const KEY_HOLD_MS = 0.6 * SECOND_MS;
/** How long the window stays open after the input, for a slow render loop's next sample. */
export const BURST_TAIL_MS = 1 * SECOND_MS;
/** The drag: steps and pixels per step, sized to turn a mouse-look camera by tens of degrees. */
export const DRAG_STEPS = 12;
export const DRAG_STEP_PX = 24;
/** The pause between drag steps. */
export const DRAG_STEP_MS = 30;

/** One burst: what went out and what the page did inside its window. */
export interface BurstObservation {
  input: string;
  sent: boolean;
  /** Sampler readings inside the window; 0 means the burst was never observed. */
  samples: number;
  /** The largest page-side diff inside the window, or `null` without samples. */
  maxDiff: number | null;
  cameraMoved: boolean | null;
}

async function cameraNow(ctx: PhaseContext) {
  return lastCameraSample(await ctx.page.evaluate(readProbeSnapshotInPage, undefined));
}

/** Which part of the drag a step is: the press, a move, or the release. */
function dragPhase(step: number): "start" | "move" | "end" {
  if (step === 0) return "start";
  return step === DRAG_STEPS - 1 ? "end" : "move";
}

/** A drag across the canvas as synthetic look deltas: press, move, release. */
async function drag(ctx: PhaseContext): Promise<boolean> {
  let dispatched = 0;
  for (let step = 0; step < DRAG_STEPS; step++) {
    const phase = dragPhase(step);
    const moved = await ctx.page.evaluate(dispatchLookDeltasInPage, {
      dx: DRAG_STEP_PX,
      dy: 0,
      offsetX: DRAG_STEP_PX * (step + 1),
      offsetY: 0,
      phase,
    });
    dispatched += moved?.dispatched ?? 0;
    await ctx.sleep(DRAG_STEP_MS);
  }
  return dispatched > 0;
}

async function burst(ctx: PhaseContext, cursor: SeriesCursor, input: string): Promise<BurstObservation> {
  await pullSeries(ctx, cursor);
  const before = await cameraNow(ctx);
  const sent = input === DRAG_BURST ? await drag(ctx) : await guardedKey(ctx, input, KEY_HOLD_MS);
  await ctx.sleep(BURST_TAIL_MS);
  const diffs = (await pullSeries(ctx, cursor)).map((s) => s.d);
  const after = await cameraNow(ctx);
  await captureFrame(ctx, ProbePhase.InputBurst, `after-${input}`);
  return {
    input,
    sent,
    samples: diffs.length,
    maxDiff: diffs.length ? Math.max(...diffs) : null,
    cameraMoved: cameraMovement(before, after).moved,
  };
}

/** Run every burst in order. */
export async function inputPhase(ctx: PhaseContext, cursor: SeriesCursor): Promise<BurstObservation[]> {
  const bursts: BurstObservation[] = [];
  for (const input of [...BURST_KEYS, DRAG_BURST]) bursts.push(await burst(ctx, cursor, input));
  return bursts;
}
