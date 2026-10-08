/**
 * One structured look at a loaded build: does the simulation move, and is anything drawn?
 *
 * The two checks cover each other's blind spots. `__studio.state()` can report a healthy
 * frame counter over a screen that renders nothing, and a project without the studio contract
 * can still be visibly alive. So a missing `__studio` alone never fails the probe, headless
 * runs (no pixel capability) never earn a black verdict, and a black canvas fails
 * regardless of what the contract claims.
 */
import type { PreviewPort } from "./preview-port.ts";
import { isEffectivelyBlack, LUMA_THRESHOLD } from "./pixel-stats.ts";
import type { BuildObservation } from "../shared/preview-contract.ts";

export type { BuildObservation };

/** Frames each of the probe's two steps advances the simulation. */
const STEP_FRAMES = 32;
/** JPEG quality of the probe's screenshot: only its pixel statistics are read. */
const PROBE_SCREENSHOT_QUALITY = 60;

const MESSAGE = {
  BlackCanvas: (litFraction: number, meanLuma: number) =>
    `black canvas: ${(litFraction * 100).toFixed(2)}% of pixels above luma ${LUMA_THRESHOLD} (mean ${meanLuma.toFixed(1)})`,
  StuckFrame: (frame: number) => `frame does not advance (stuck at ${frame})`,
} as const;

function frameOf(state: unknown): number | null {
  const frame = (state as { frame?: unknown } | null | undefined)?.frame;
  return typeof frame === "number" && Number.isFinite(frame) ? frame : null;
}

export async function observeBuild(preview: PreviewPort): Promise<BuildObservation> {
  const state0 = await preview.studioState();
  const studioMissing = Boolean((state0 as { __missing?: unknown } | null | undefined)?.__missing);
  const frameBefore = frameOf(state0);

  let state1 = state0;
  if (!studioMissing) {
    // Two steps, not one: the first can be swallowed by a reset-on-seed or a lazy first
    // render, and a genuinely stuck loop is stuck either way.
    await preview.studioCall("step", STEP_FRAMES);
    await preview.studioCall("step", STEP_FRAMES);
    state1 = await preview.studioState();
  }
  const frameAfter = frameOf(state1);
  const frameAdvanced = frameBefore !== null && frameAfter !== null && frameAfter > frameBefore;

  // Captured after stepping — step() renders even while paused, so a working build has had
  // its chance to put pixels on screen before being judged for blackness.
  const pixels = preview.screenshotWithStats
    ? (await preview.screenshotWithStats(PROBE_SCREENSHOT_QUALITY)).stats
    : null;

  const reasons: string[] = [];
  if (pixels?.canvas && isEffectivelyBlack(pixels)) {
    reasons.push(MESSAGE.BlackCanvas(pixels.litFraction, pixels.meanLuma));
  }
  // A headless run (no pixels) still judges the counter; a page with no canvas does not.
  const judgesCanvas = pixels?.canvas ?? true;
  const bothFramesRead = frameBefore !== null && frameAfter !== null;
  if (!studioMissing && bothFramesRead && !frameAdvanced && judgesCanvas) {
    reasons.push(MESSAGE.StuckFrame(frameAfter));
  }

  const running = (state1 as { running?: unknown } | null | undefined)?.running;
  const fps = (state1 as { fps?: unknown } | null | undefined)?.fps;
  return {
    ok: reasons.length === 0,
    reasons,
    pixels,
    studioMissing,
    frameBefore,
    frameAfter,
    frameAdvanced,
    running: typeof running === "boolean" ? running : null,
    fps: typeof fps === "number" && Number.isFinite(fps) ? fps : null,
  };
}
