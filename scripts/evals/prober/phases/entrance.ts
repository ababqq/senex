/**
 * The entrance phase: get past the title screen through the doors a player has, and judge whether
 * the probe got in from WITNESSES only: the start control it clicked is gone, the press-any-key line
 * is gone, a pointer lock is held, or the camera moved (and was not already moving on its own).
 * Never a pixel diff. The start control and press-any-key finders run in the page; every key goes
 * through the focus guard and the centre click through the chrome guard.
 */
import { SECOND_MS } from "../../../../src/shared/duration.ts";
import type { CameraSample } from "../instrument.ts";
import {
  fullscreenOf,
  type InstrumentSnapshot,
  lastCameraSample,
  pointerLockOf,
  readProbeSnapshotInPage,
} from "../driver.ts";
import { findPressAnyKeyInPage, findStartControlInPage, readOccludedStartControlInPage } from "../start-control.ts";
import {
  CHROME_DENY_SOURCE,
  cameraHeadingDeg,
  type EnterableVerdict,
  type EntranceSignals,
  type EntranceVerdict,
  enterableVerdict,
  headingStepDeg,
  judgeEntrance,
  MIN_LOOK_YAW_DEG,
  namedKeysIn,
  type PressAnyKeySignal,
  type StartControlSignal,
} from "../verdicts.ts";
import { guardedCentreClick, guardedKey, keyRefusal, type PhaseContext } from "./context.ts";

/** How long the page gets to react to an entrance input before it is looked at again. */
export const ENTRANCE_SETTLE_MS = 1.5 * SECOND_MS;
/** The keys sent for a "press any key" title, in order, each through the focus guard. */
export const PRESS_ANY_KEYS = ["Enter", "Space"] as const;
/** How long an entrance key is held. */
export const ENTRANCE_KEY_HOLD_MS = 120;
/** A camera displacement under this (world units) is float noise, not travel. */
export const MIN_CAMERA_TRAVEL = 0.25;

/** How far the camera moved between two readings, by position and by heading. */
export interface CameraMovement {
  distance: number | null;
  headingDeltaDeg: number | null;
  moved: boolean | null;
}

/** Did the camera move between two readings? `null` when either reading is missing. */
export function cameraMovement(a: CameraSample | null, b: CameraSample | null): CameraMovement {
  if (!a || !b) return { distance: null, headingDeltaDeg: null, moved: null };
  const distance = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const ha = cameraHeadingDeg(a);
  const hb = cameraHeadingDeg(b);
  const headingDeltaDeg = ha !== null && hb !== null ? headingStepDeg(ha, hb) : null;
  const turned = headingDeltaDeg !== null && Math.abs(headingDeltaDeg) > MIN_LOOK_YAW_DEG;
  return { distance, headingDeltaDeg, moved: distance > MIN_CAMERA_TRAVEL || turned };
}

/** What the entrance phase did and concluded. */
export interface EntranceObservation {
  signals: EntranceSignals;
  verdict: EntranceVerdict;
  enterable: EnterableVerdict;
  keysRefused: string[];
  centreClicked: boolean;
  snapshot: InstrumentSnapshot | null;
}

async function snapshot(ctx: PhaseContext): Promise<InstrumentSnapshot | null> {
  return ctx.page.evaluate(readProbeSnapshotInPage, undefined);
}

function parseOccluded(json: string | null): StartControlSignal["occluded"] {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { text?: unknown; by?: unknown };
    return typeof parsed.text === "string" && typeof parsed.by === "string"
      ? { text: parsed.text, by: parsed.by }
      : null;
  } catch {
    return null;
  }
}

/** Find, click and re-check the project's own start control. */
async function tryStartControl(ctx: PhaseContext): Promise<StartControlSignal> {
  const found = await ctx.page.evaluate(findStartControlInPage, CHROME_DENY_SOURCE);
  if (!found) {
    const occluded = parseOccluded(await ctx.page.evaluate(readOccludedStartControlInPage, undefined));
    return { found: null, clicked: false, gone: null, occluded };
  }
  const clicked = await ctx.page.click("[data-genex-probe-start]");
  if (!clicked) return { found, clicked, gone: null };
  await ctx.sleep(ENTRANCE_SETTLE_MS);
  const again = await ctx.page.evaluate(findStartControlInPage, CHROME_DENY_SOURCE);
  return { found, clicked, gone: again !== found };
}

/** Send the keys a "press any key" line asks for, through the focus guard, and re-check the line. */
async function tryPressAnyKey(ctx: PhaseContext, refused: string[]): Promise<PressAnyKeySignal | null> {
  const affordance = await ctx.page.evaluate(findPressAnyKeyInPage, undefined);
  if (!affordance) return null;
  const keys = [...new Set([...namedKeysIn(affordance), ...PRESS_ANY_KEYS])];
  const keysSent: string[] = [];
  for (const key of keys) {
    if (await guardedKey(ctx, key, ENTRANCE_KEY_HOLD_MS)) keysSent.push(key);
    else refused.push(key);
    await ctx.sleep(ENTRANCE_SETTLE_MS);
    const still = await ctx.page.evaluate(findPressAnyKeyInPage, undefined);
    if (still !== affordance) return { affordance, keysSent, gone: true };
  }
  return { affordance, keysSent, gone: keysSent.length ? false : null };
}

/**
 * A clicked start control that is still on screen may name the key that opens it ("Esc resumes"):
 * send those keys (the entrance is the one place Escape may go out) and look again.
 */
async function tryNamedKeys(
  ctx: PhaseContext,
  control: StartControlSignal,
  refused: string[],
): Promise<StartControlSignal> {
  if (!control.found || control.gone !== false) return control;
  let sent = 0;
  for (const key of namedKeysIn(control.found)) {
    const allowed = (await keyRefusal(ctx)) === null;
    if (allowed && (await ctx.page.press(key, ENTRANCE_KEY_HOLD_MS))) sent++;
    else refused.push(key);
  }
  if (sent === 0) return control;
  await ctx.sleep(ENTRANCE_SETTLE_MS);
  const again = await ctx.page.evaluate(findStartControlInPage, CHROME_DENY_SOURCE);
  return { ...control, gone: again !== control.found };
}

/**
 * Run the entrance: the start control, else a press-any-key line, then a guarded centre click (the
 * gesture a click-to-lock door or an audio unlock needs), and judge it. `idleMoved` is whether the
 * camera already moved during the no-input idle: then camera motion is no witness.
 */
export async function entrancePhase(ctx: PhaseContext, idleMoved: boolean | null): Promise<EntranceObservation> {
  const before = lastCameraSample(await snapshot(ctx));
  const keysRefused: string[] = [];
  const control = await tryNamedKeys(ctx, await tryStartControl(ctx), keysRefused);
  const pressAnyKey = control.found ? null : await tryPressAnyKey(ctx, keysRefused);
  // The centre click is the gesture a click-to-lock door or an audio unlock needs; a door already
  // seen to open does not get a stray click into the project.
  const alreadyIn = control.gone === true || pressAnyKey?.gone === true;
  const centreClicked = alreadyIn ? false : await guardedCentreClick(ctx);
  await ctx.sleep(ENTRANCE_SETTLE_MS);
  const after = await snapshot(ctx);
  const lock = pointerLockOf(after);
  const fullscreen = fullscreenOf(after);
  const movement = cameraMovement(before, lastCameraSample(after));
  const signals: EntranceSignals = {
    startControl: control,
    pressAnyKey,
    cameraMoved: idleMoved === true ? null : movement.moved,
    pointerLockEngaged: lock ? Boolean(lock.locked || lock.grantedNatively) : null,
    pointerLockRequested: (lock?.requested ?? 0) > 0,
  };
  const verdict = judgeEntrance(signals);
  const enterable = enterableVerdict({
    ...verdict,
    startControl: control,
    pressAnyKey: pressAnyKey ? { ...pressAnyKey, keysRefused } : null,
    pointerLock: { requested: signals.pointerLockRequested, engaged: signals.pointerLockEngaged },
    fullscreen: {
      requested: (fullscreen?.requested ?? 0) > 0,
      granted: fullscreen ? fullscreen.granted === true : null,
    },
  });
  return { signals, verdict, enterable, keysRefused, centreClicked, snapshot: after };
}
