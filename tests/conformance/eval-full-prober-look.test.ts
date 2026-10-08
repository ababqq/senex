/**
 * The look phase and the closed-loop pitch restore, replayed against a fake camera. Ported from
 * genex-demo's `prober/probe.test.ts` look-phase tests: a closed loop that reads the achieved yaw per
 * step, a CDP fallback that is tried and recorded when synthetic events move nothing, an honest "not
 * reached" (never a sweep it did not see), the drag-to-look project driven as a drag, a locked project left
 * untouched, and the three exclusions. New here: a page with no mouse has no fallback to try, and
 * says so instead of reading as a project that ignored the input.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LoggedFrame } from "../../scripts/evals/prober/frame-log.ts";
import type { CameraSample } from "../../scripts/evals/prober/instrument.ts";
import { PITCH_RESTORE_ATTEMPTS, PitchRestore, restoreCameraPitch } from "../../scripts/evals/prober/phases/camera.ts";
import type { ProbeMouse } from "../../scripts/evals/prober/phases/full-context.ts";
import {
  LOOK_CDP_WOBBLE_PX,
  LOOK_EVENTS_PER_STEP,
  LOOK_FORWARD_HOLD_MS,
  LOOK_STEP_PX,
  LOOK_STEPS,
  type LookDeps,
  LookMechanism,
  LookTargetKind,
  lookPhase,
} from "../../scripts/evals/prober/phases/look.ts";
import { selectExposureFrames } from "../../scripts/evals/prober/verdicts.ts";
import { ProbePhase } from "../../scripts/evals/vocabulary.ts";

const RAD = Math.PI / 180;

function loggedFrame(label: string): LoggedFrame {
  return {
    record: { file: `${label}.png`, atMs: 1, phase: ProbePhase.Look, label, source: "page" },
    ref: { path: `${label}.png`, atMs: 1, phase: ProbePhase.Look, origin: "http://127.0.0.1", width: 1, height: 1 },
    raw: { width: 1, height: 1, data: new Uint8Array(4) },
  };
}

/**
 * A fake project: a camera whose heading turns by `synthDegPerPx` per synthetic pixel and `cdpDegPerPx`
 * per mouse pixel (zero for a project that ignores that mechanism).
 */
function fakeLookPage(opts: {
  synthDegPerPx: number;
  cdpDegPerPx: number;
  camera?: boolean;
  noLock?: boolean;
  requiresDrag?: boolean;
  noMouse?: boolean;
}) {
  let heading = 0;
  const dispatched: Array<{ dx: number; drag: { offsetX: number; phase: string } }> = [];
  const mouseMoves: Array<{ x: number; steps: number }> = [];
  const buttons: string[] = [];
  const captures: string[] = [];
  const keys: string[] = [];
  let lastX = 640;
  let synthHeld = false;
  let mouseHeld = false;
  const mouse: ProbeMouse = {
    move: async (x, _y, steps) => {
      mouseMoves.push({ x, steps });
      if (!opts.requiresDrag || mouseHeld) heading += (x - lastX) * opts.cdpDegPerPx;
      lastX = x;
      return true;
    },
    down: async () => {
      buttons.push("down");
      mouseHeld = true;
      return true;
    },
    up: async () => {
      buttons.push("up");
      mouseHeld = false;
      return true;
    },
  };
  const deps: LookDeps = {
    viewport: { width: 1280, height: 720 },
    dispatch: async (dx, _dy, drag) => {
      dispatched.push({ dx, drag: { offsetX: drag.offsetX, phase: drag.phase } });
      if (drag.phase === "start") synthHeld = true;
      if (!opts.requiresDrag || synthHeld) heading += dx * opts.synthDegPerPx;
      if (drag.phase === "end") synthHeld = false;
      return { target: opts.noLock ? LookTargetKind.Canvas : LookTargetKind.Lock, dispatched: 2 };
    },
    mouse: opts.noMouse ? null : mouse,
    readCamera: async () =>
      opts.camera === false
        ? null
        : { t: 1, x: 0, y: 0, z: 0, fx: Math.sin(heading * RAD), fy: 0, fz: Math.cos(heading * RAD) },
    capture: async (label) => {
      captures.push(label);
      return loggedFrame(label);
    },
    press: async (key) => {
      keys.push(key);
      return { sent: true, reason: null };
    },
    sleep: async () => {},
    pullSeries: async () => {},
    lastSamplePageT: () => 123_456,
    log: () => {},
  };
  return { deps, dispatched, mouseMoves, buttons, captures, keys };
}

/** 0.0023 rad/px is the vendored FollowCamera default: 336 px ≈ 44.3°. */
const FOLLOW_CAMERA_DEG_PER_PX = (0.0023 * 180) / Math.PI;

describe("the look phase", () => {
  it("CLOSED LOOP: synthetic deltas that turn the camera are read back per step, and the mouse is never tried", async () => {
    const page = fakeLookPage({ synthDegPerPx: FOLLOW_CAMERA_DEG_PER_PX, cdpDegPerPx: 0 });
    const look = await lookPhase(page.deps);
    assert.equal(look.reached, true);
    assert.equal(look.deliveredBy, LookMechanism.Synthetic);
    assert.equal(look.fallback, null);
    assert.equal(page.mouseMoves.length, 0);
    assert.equal(look.steps.length, LOOK_STEPS * 2);
    assert.equal(page.dispatched.length, LOOK_STEPS * 2 * LOOK_EVENTS_PER_STEP);
    const first = look.steps[0];
    assert.ok(Math.abs((first.achievedDeg ?? 0) - 44.3) < 0.5, `achieved ${first.achievedDeg}° per step`);
    assert.ok((look.sweeps[0].sweepDeg ?? 0) > 300, "sweep 1 covered the whole surroundings");
    assert.deepEqual(look.forwardLeg, { key: "KeyW", sent: true, heldMs: LOOK_FORWARD_HOLD_MS, refusedWhy: null });
    assert.equal(look.framesCaptured, LOOK_STEPS * 2);
    assert.equal(look.endedPageMs, 123_456);
    assert.match(look.note, /synthetic pointermove\/mousemove deltas turned the camera/);
  });

  it("FALLBACK: a project that ignores untrusted events gets the ±200px mouse wobble, recorded and used for sweep 2", async () => {
    const page = fakeLookPage({ synthDegPerPx: 0, cdpDegPerPx: 0.1 });
    const look = await lookPhase(page.deps);
    assert.equal(look.deliveredBy, LookMechanism.Cdp);
    assert.equal(look.fallback?.tried, true);
    assert.ok(Math.abs((look.fallback?.sweepDeg ?? 0) - 40) < 0.01, `read ${look.fallback?.sweepDeg}`);
    assert.equal(look.sweeps[0].sweepDeg, 0, "sweep 1 moved nothing and says so");
    assert.equal(look.sweeps[1].mechanism, LookMechanism.Cdp);
    assert.ok(page.mouseMoves.some((m) => m.x === 640 + LOOK_CDP_WOBBLE_PX));
    assert.ok(page.mouseMoves.some((m) => m.x === 640 - LOOK_CDP_WOBBLE_PX));
  });

  it("NOTHING DELIVERS: honestly not reached; with no camera at all, null", async () => {
    const look = await lookPhase(fakeLookPage({ synthDegPerPx: 0, cdpDegPerPx: 0 }).deps);
    assert.equal(look.reached, false);
    assert.equal(look.deliveredBy, null);
    assert.equal(look.fallback?.reached, false);
    assert.match(look.note, /the look input did not reach the project/);
    assert.equal(look.framesCaptured, LOOK_STEPS * 2, "the frames are still captured");
    const unread = await lookPhase(fakeLookPage({ synthDegPerPx: 1, cdpDegPerPx: 1, camera: false }).deps);
    assert.equal(unread.reached, null);
    assert.ok(unread.steps.every((s) => s.achievedDeg === null));
    assert.match(unread.note, /No camera heading could be read/);
  });

  it("NO MOUSE: the fallback is recorded as not tried, never as a mechanism the project ignored", async () => {
    const look = await lookPhase(fakeLookPage({ synthDegPerPx: 0, cdpDegPerPx: 1, noMouse: true }).deps);
    assert.deepEqual(look.fallback, { tried: false, sweepDeg: null, reached: null, heldButton: false });
    assert.equal(look.deliveredBy, null);
    assert.match(look.note, /the page has no mouse/);
  });

  it("A DRAG-TO-LOOK PROJECT IS DRIVEN: the press brackets each step and the coordinate advances", async () => {
    const page = fakeLookPage({ synthDegPerPx: 0.13, cdpDegPerPx: 0, noLock: true, requiresDrag: true });
    const look = await lookPhase(page.deps);
    assert.equal(look.deliveredBy, LookMechanism.Synthetic);
    assert.deepEqual(page.buttons, [], "nothing fell back, so no mouse button was pressed");
    const perStep = page.dispatched.slice(0, LOOK_EVENTS_PER_STEP);
    assert.deepEqual(
      perStep.map((d) => d.drag.phase),
      ["start", ...Array(LOOK_EVENTS_PER_STEP - 2).fill("move"), "end"],
    );
    const per = Math.round(LOOK_STEP_PX / LOOK_EVENTS_PER_STEP);
    assert.deepEqual(
      perStep.map((d) => d.drag.offsetX),
      perStep.map((_, i) => per * (i + 1)),
    );
    assert.ok((perStep[perStep.length - 1].drag.offsetX ?? 0) < 1280 / 2, "the drag restarts each step");
  });

  it("THE SAME PROJECT ignoring untrusted events: the mouse fallback goes out as a real drag, every press released", async () => {
    const page = fakeLookPage({ synthDegPerPx: 0, cdpDegPerPx: 0.1, noLock: true, requiresDrag: true });
    const look = await lookPhase(page.deps);
    assert.equal(look.deliveredBy, LookMechanism.Cdp);
    assert.equal(look.fallback?.heldButton, true);
    assert.match(look.note, /sent as a drag with the button held/);
    assert.equal(page.buttons[0], "down");
    assert.equal(page.buttons.filter((b) => b === "down").length, page.buttons.filter((b) => b === "up").length);
  });

  it("A LOCKED PROJECT is untouched: no button is ever pressed under a lock", async () => {
    const page = fakeLookPage({ synthDegPerPx: 0, cdpDegPerPx: 0.1, requiresDrag: true });
    const look = await lookPhase(page.deps);
    assert.deepEqual(page.buttons, []);
    assert.equal(look.deliveredBy, null);
    assert.ok(look.steps.every((s) => s.target === LookTargetKind.Lock));
  });

  it("BEFORE ANY STEP HAS REPORTED, nothing is pressed: the drag decision fails closed", async () => {
    const page = fakeLookPage({ synthDegPerPx: 0, cdpDegPerPx: 0 });
    await lookPhase({ ...page.deps, dispatch: async () => ({ target: LookTargetKind.None, dispatched: 0 }) });
    assert.deepEqual(page.buttons, []);
  });

  it("THE EXCLUSIONS: look frames are out of the exposure sample, and a refused forward leg is recorded", async () => {
    const page = fakeLookPage({ synthDegPerPx: 0.13, cdpDegPerPx: 0 });
    const look = await lookPhase({
      ...page.deps,
      press: async () => ({ sent: false, reason: 'focus is on a form control <button> "Sign in"' }),
    });
    assert.deepEqual(look.forwardLeg, {
      key: "KeyW",
      sent: false,
      heldMs: 0,
      refusedWhy: 'focus is on a form control <button> "Sign in"',
    });
    const filed = [
      { atMs: 20_000, phase: ProbePhase.Directions, source: "page" as const },
      ...look.steps.map((s, i) => ({
        atMs: 30_000 + i * 1000,
        phase: ProbePhase.Look,
        label: `sweep${s.sweep}-step${s.step}`,
        source: "page" as const,
      })),
      { atMs: 90_000, phase: ProbePhase.Soak, source: "page" as const },
    ];
    const selection = selectExposureFrames(filed, 5_000);
    assert.equal(selection.excludedLook, LOOK_STEPS * 2);
    assert.ok(page.captures.every((c) => /^sweep[12]-step\d+$/.test(c)));
  });
});

/** A camera whose pitch moves by `degPerPx` per dragged pixel (down is negative). */
function pitchCamera(startDeg: number, degPerPx: number, readable = true) {
  let pitch = startDeg;
  const drags: number[] = [];
  return {
    drags,
    deps: {
      viewportHeight: 720,
      readCamera: async (): Promise<CameraSample | null> =>
        readable ? { t: 1, x: 0, y: 0, z: 0, fx: 0, fy: Math.sin(pitch * RAD), fz: Math.cos(pitch * RAD) } : null,
      drag: async (dy: number) => {
        drags.push(dy);
        pitch -= dy * degPerPx;
        return true;
      },
      sleep: async () => {},
    },
  };
}

describe("the closed-loop pitch restore", () => {
  it("a camera aimed at the ground is dragged UP until it rests near the horizon", async () => {
    const cam = pitchCamera(-84, 0.5);
    const restored = await restoreCameraPitch(cam.deps);
    assert.equal(restored.outcome, PitchRestore.Restored);
    assert.ok(
      cam.drags.every((dy) => dy < 0),
      "dragging up raises a camera aimed down",
    );
    assert.ok(Math.abs(restored.toDeg ?? 99) <= 20);
  });

  it("level, unmoved, unreadable and stubborn cameras each say which", async () => {
    assert.equal((await restoreCameraPitch(pitchCamera(5, 0.5).deps)).outcome, PitchRestore.AlreadyLevel);
    assert.equal((await restoreCameraPitch(pitchCamera(-80, 0).deps)).outcome, PitchRestore.Unmoved);
    assert.equal((await restoreCameraPitch(pitchCamera(-80, 0.5, false).deps)).outcome, PitchRestore.NoReading);
    const stubborn = await restoreCameraPitch(pitchCamera(-89, 0.01).deps);
    assert.equal(stubborn.outcome, PitchRestore.GaveUp);
    assert.equal(stubborn.attempts, PITCH_RESTORE_ATTEMPTS);
  });
});
