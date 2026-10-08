/**
 * The prober's pure verdicts (`scripts/evals/prober/verdicts.ts`), replayed with no browser. Ported
 * from genex-demo's `prober/verdicts.test.ts` and its `test/{gate,loader-failures,renderer-defects,
 * pitch}.test.ts`, with hosted hostnames rewritten to `*.example.test`, the hosted-only rules dropped
 * (embed SDK markers, the demo template's optional probes) and `stayedOnProject` allowing no bounce.
 * Every row here is a verdict that once mis-scored a run by a confident, wrong reading.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { Check } from "../../scripts/evals/prober/types.ts";
import {
  CHROME_DENY_SOURCE,
  CHROME_NAME_MAX,
  type CameraYawSample,
  cameraHeadingDeg,
  cameraPitchDeg,
  cameraSanity,
  chooseEvidenceFrame,
  chromeNameRefusal,
  classifyFailure,
  demoteForFullscreen,
  demoteForLookInput,
  demoteForNoInteraction,
  demoteForPointerLock,
  directionPairVerdict,
  EXPOSURE_SAMPLE,
  type EntranceSignals,
  enterableVerdict,
  evidenceScore,
  fullscreenBlocked,
  interactionReached,
  gateFor,
  gatingRows,
  headingStepDeg,
  headingSweepDeg,
  isLoaderFailureLine,
  isRendererDefectLine,
  isScored,
  judgeEntrance,
  judgeEvidence,
  keyFocusRefusal,
  ktx2FallbackUrls,
  type LookRecord,
  loaderFailureCount,
  lookInputVerdict,
  MIN_CAMERA_SANITY_SAMPLES,
  MIN_EXPOSURE_FRAMES,
  MIN_FAIL_MOTION_COLUMNS,
  MIN_JUDGE_FRAMES,
  MIN_LOOK_YAW_DEG,
  namedKeysIn,
  PITCH_RUINED_DEG,
  POST_GESTURE_PHASES,
  pageRan,
  pickEvidenceSnapshot,
  pitchRuined,
  pointerLockBlocked,
  RAN_REQUEST_FLOOR,
  rendererDefects,
  restoreDragTargetY,
  selectExposureFrames,
  shouldDemoteForCamera,
  stayedOnProject,
  verbPixelExceededControl,
  worstResult,
  yawSweepDeg,
} from "../../scripts/evals/prober/verdicts.ts";
import { type ProbePhase, ProbeRow } from "../../scripts/evals/vocabulary.ts";

const PROJECT = "https://quiet-village.example.test";
const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/evals/prober");
const fixture = <T>(name: string): T => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8")) as T;

describe("classifyFailure", () => {
  it("a same-origin 4xx or 5xx is the project's asset", () => {
    assert.equal(classifyFailure(`${PROJECT}/assets/house.glb`, PROJECT).blame, "asset");
    assert.equal(classifyFailure(`${PROJECT}/api/whatever`, PROJECT).blame, "asset", "same origin, any shape");
  });

  it("third-party: asset-shaped is blamed, non-asset is benign, telemetry and favicons are benign", () => {
    assert.equal(classifyFailure("https://cdn.example.test/models/tree.glb", PROJECT).blame, "asset");
    assert.equal(classifyFailure("https://api.example.test/api/embed/session", PROJECT).blame, "benign");
    assert.equal(classifyFailure("https://o123.ingest.us.sentry.io/api/1/envelope/", PROJECT).blame, "benign");
    assert.equal(classifyFailure(`${PROJECT}/favicon.ico`, PROJECT).blame, "benign");
    assert.equal(classifyFailure("not a url", PROJECT).blame, "benign");
  });

  it("a failed .ktx2 sibling is benign when its universal fallback loaded, and an asset failure otherwise", () => {
    const ktx = "https://assets.example.test/generations/g1/model-glb@2048.ktx2";
    assert.deepEqual(ktx2FallbackUrls(ktx), [
      "https://assets.example.test/generations/g1/model-glb@2048",
      "https://assets.example.test/generations/g1/model-glb",
    ]);
    const ok = new Set(["https://assets.example.test/generations/g1/model-glb@2048"]);
    assert.equal(classifyFailure(ktx, PROJECT, ok).blame, "benign");
    assert.equal(classifyFailure(ktx, PROJECT, new Set()).blame, "asset", "no fallback loaded: a missing asset");
    assert.equal(classifyFailure(ktx, PROJECT).blame, "asset");
    assert.equal(ktx2FallbackUrls("https://x.example.test/y/model-glb@2048").length, 0);
  });
});

describe("pickEvidenceSnapshot", () => {
  const snap = (
    href: string | null,
    score: { contexts?: number; canvases?: number; colors?: number; raf?: number },
    takenAtMs?: number,
  ): Record<string, unknown> => ({
    ...(href === null ? {} : { href }),
    ...(takenAtMs === undefined ? {} : { takenAtMs }),
    audio: { contexts: Array.from({ length: score.contexts ?? 0 }, () => ({})) },
    liveCanvases: Array.from({ length: score.canvases ?? 0 }, () => ({})),
    frames: { mirrorBestColors: score.colors ?? 0 },
    raf: { distinctFrames: score.raf ?? 0 },
  });

  it("a foreign page out-scores the project on evidence and still loses on origin", () => {
    const project = snap(`${PROJECT}/`, { canvases: 1, colors: 40, raf: 900 }, 12_000);
    const login = snap(
      "https://login.example.test/login?next=%2Fplay",
      { contexts: 1, canvases: 1, colors: 200, raf: 5000 },
      305_000,
    );
    assert.ok(evidenceScore(login) > evidenceScore(project), "the premise: on evidence alone the foreign page wins");
    const pick = pickEvidenceSnapshot([project, login], PROJECT);
    assert.equal(pick.snapshot, project);
    assert.equal(pick.sameOrigin, 1);
    assert.equal(pick.foreign, 1);
    assert.match(pick.notes[0] ?? "", /1 of 2 page-state snapshot\(s\) were taken on a foreign origin/);
    assert.match(
      pick.notes[0] ?? "",
      /https:\/\/login\.example\.test at 305000ms/,
      "the note names the origin and when",
    );
  });

  it("every snapshot foreign: falls back to the best of them and says the run left the project", () => {
    const a = snap("https://auth.example.test/authorize", { raf: 10 }, 3_000);
    const b = snap("https://login.example.test/login", { contexts: 1, canvases: 1, colors: 200, raf: 5000 }, 300_000);
    const pick = pickEvidenceSnapshot([a, b], PROJECT);
    assert.equal(pick.snapshot, b);
    assert.equal(pick.sameOrigin, 0);
    assert.equal(pick.foreign, 2);
    assert.match(pick.notes[0] ?? "", /^every snapshot was taken on a foreign origin .* — the run left the project/);
    assert.match(pick.notes[0] ?? "", /contaminated/);
  });

  it("no foreign snapshot: the best by evidence, no notes; an unreadable href is never foreign", () => {
    const early = snap(`${PROJECT}/`, { canvases: 1, colors: 10, raf: 100 });
    const late = snap(`${PROJECT}/`, { contexts: 1, canvases: 1, colors: 60, raf: 4000 });
    assert.deepEqual(pickEvidenceSnapshot([early, late], PROJECT).notes, []);
    assert.equal(pickEvidenceSnapshot([early, late], PROJECT).snapshot, late);
    const noHref = snap(null, { contexts: 1, canvases: 1, colors: 100, raf: 1000 });
    assert.equal(pickEvidenceSnapshot([noHref, early], PROJECT).snapshot, noHref);
    const login = snap("https://login.example.test/login", { contexts: 1, canvases: 1, colors: 200, raf: 5000 });
    assert.equal(pickEvidenceSnapshot([early, login], "").foreign, 0, "no origin to compare: nothing is foreign");
    assert.deepEqual(pickEvidenceSnapshot([], PROJECT), { snapshot: null, notes: [], sameOrigin: 0, foreign: 0 });
  });
});

describe("shouldDemoteForCamera", () => {
  it("demotes only when the hook could have seen a view matrix and none came", () => {
    assert.equal(shouldDemoteForCamera({ webglContexts: 2, camera: { seen: false, hooks: 0, viewLocs: 5 } }), false);
    assert.equal(shouldDemoteForCamera({ webglContexts: 1, camera: { seen: false, hooks: 1, viewLocs: 0 } }), false);
    assert.equal(shouldDemoteForCamera({ webglContexts: 1, camera: { seen: false, hooks: 1, viewLocs: 3 } }), true);
    assert.equal(shouldDemoteForCamera({ webglContexts: 1, camera: { seen: true, hooks: 1, viewLocs: 3 } }), false);
    assert.equal(shouldDemoteForCamera({ webglContexts: 0, camera: { seen: false, hooks: 1, viewLocs: 3 } }), false);
    assert.equal(shouldDemoteForCamera({ webglContexts: 1, camera: undefined }), false);
    assert.equal(shouldDemoteForCamera({ webglContexts: 1, camera: null }), false);
  });
});

describe("pointer-lock and look-input demotions", () => {
  it("asked, refused, unshimmed: fail becomes unknown, and nothing else moves", () => {
    const blocked = { requested: 17, grantedNatively: false, shimmed: false };
    assert.equal(pointerLockBlocked(blocked), true);
    const input = demoteForPointerLock("fail", blocked);
    assert.equal(input.result, "unknown");
    assert.match(String(input.why), /could not ENTER/);
    assert.deepEqual(demoteForPointerLock("pass", blocked), { result: "pass", why: null });
    assert.deepEqual(demoteForPointerLock("unknown", blocked), { result: "unknown", why: null });
  });

  it("a granted or shimmed lock, a project that never asked, and an absent record are never blocked", () => {
    for (const state of [
      { requested: 3, grantedNatively: true, shimmed: false },
      { requested: 3, grantedNatively: false, shimmed: true },
      { requested: 0, grantedNatively: false, shimmed: false },
      {},
      null,
      undefined,
    ]) {
      assert.equal(pointerLockBlocked(state), false, JSON.stringify(state));
      assert.deepEqual(demoteForPointerLock("fail", state), { result: "fail", why: null });
    }
  });

  interface LockFixture {
    pointerLock: {
      requested: number;
      grantedNatively: boolean;
      shimmed: boolean;
      engagedAtMs: number;
      movesRouted: number;
    };
    cameraSamples: CameraYawSample[];
  }
  const bareLock = fixture<LockFixture>("pointer-lock-shimmed.json");
  const look = (over: Partial<LookRecord>): LookRecord => ({
    windowMs: 500,
    samples: 1200,
    headings: 1200,
    firstT: 255231,
    lastT: 315196,
    sweepDeg: 157.9,
    mouseSweepDeg: 60,
    mouseSteps: 40,
    mouseStepsUnattributable: 0,
    lastMoveT: 300000,
    ...over,
  });
  const shimmedLock = { requested: 1, grantedNatively: false, shimmed: true, engagedAtMs: 26881.2 };

  it("a shimmed entry whose instrument kept no post-lock record is UNOBSERVED, never inferred from a slice", () => {
    const sweep = yawSweepDeg(bareLock.cameraSamples) ?? 0;
    assert.ok(sweep > 150 && sweep < 165, `sweep ${sweep}`);
    const v = lookInputVerdict(bareLock.pointerLock);
    assert.equal(v.applicable, true);
    assert.equal(v.delivered, null);
    assert.match(String(v.why), /kept no post-lock heading record/);
    assert.match(String(v.why), /UNOBSERVED/);
    assert.equal(demoteForLookInput("fail", v).result, "unknown");
  });

  it("a mouse-attributed sweep at or over the floor is DELIVERED, and a real fail behind that door stands", () => {
    const v = lookInputVerdict({ ...shimmedLock, look: look({}) });
    assert.equal(v.delivered, true);
    assert.equal(v.yawSweepDeg, 157.9);
    assert.equal(v.mouseYawSweepDeg, 60);
    assert.deepEqual(v.window, { firstT: 255231, lastT: 315196, windowMs: 500 });
    assert.equal(v.why, null);
    assert.deepEqual(demoteForLookInput("fail", v), { result: "fail", why: null });
  });

  it("a heading that swept on the keys and not inside the mouse windows is NOT delivery", () => {
    const v = lookInputVerdict({ ...shimmedLock, look: look({ sweepDeg: 90, mouseSweepDeg: 0.4, mouseSteps: 3 }) });
    assert.equal(v.delivered, false);
    assert.match(
      String(v.why),
      /asked for pointer lock 1 time\(s\), the browser refused, and the probe entered through its synthetic lock at 26881ms/,
    );
    assert.match(
      String(v.why),
      /swept 90\.0° in total but only 0\.4° inside the 500ms windows .* \(3 attributed step\(s\)\)/,
    );
    assert.match(String(v.why), /under the 5°/);
    assert.equal(demoteForLookInput("fail", v).result, "unknown");
    assert.deepEqual(demoteForLookInput("pass", v), { result: "pass", why: null });
  });

  it("steps a slow sampler could not attribute are named; fewer than two headings is unobserved", () => {
    const slow = lookInputVerdict({
      ...shimmedLock,
      look: look({ sweepDeg: 40, mouseSweepDeg: 0, mouseSteps: 0, mouseStepsUnattributable: 7 }),
    });
    assert.match(String(slow.why), /7 step\(s\) followed a move but spanned more than the window/);
    const none = lookInputVerdict({
      ...shimmedLock,
      look: look({ samples: 60, headings: 0, sweepDeg: 0, mouseSweepDeg: 0 }),
    });
    assert.equal(none.delivered, null);
    assert.match(
      String(none.why),
      /of the 60 camera sample\(s\) flushed after the lock engaged .* only 0 carried a readable ground heading/,
    );
  });

  it("the verdict applies only to a shimmed entry, and the floor is exactly 5°", () => {
    for (const state of [null, undefined, { requested: 0 }, { requested: 2, grantedNatively: true, shimmed: false }]) {
      assert.equal(lookInputVerdict(state).applicable, false);
    }
    assert.equal(MIN_LOOK_YAW_DEG, 5);
    assert.equal(lookInputVerdict({ ...shimmedLock, look: look({ mouseSweepDeg: 4.9 }) }).delivered, false);
    assert.equal(lookInputVerdict({ ...shimmedLock, look: look({ mouseSweepDeg: 5 }) }).delivered, true);
  });
});

describe("camera geometry", () => {
  const at = (deg: number, t: number) => ({
    t,
    fx: Math.sin((deg * Math.PI) / 180),
    fz: Math.cos((deg * Math.PI) / 180),
  });
  const aimed = (deg: number) => {
    const r = (deg * Math.PI) / 180;
    return { t: 0, fx: 0, fy: Math.sin(r), fz: -Math.cos(r) };
  };
  const pinnedAt = (deg: number, n: number) => Array.from({ length: n }, () => aimed(deg));

  it("yawSweepDeg unwraps: a full turn is 360°, a wobble across the ±180° seam is small", () => {
    const turn = Array.from({ length: 37 }, (_, i) => at(i * 10, i));
    assert.ok(Math.abs((yawSweepDeg(turn) ?? 0) - 360) < 1e-6);
    assert.ok((yawSweepDeg([at(178, 0), at(-178, 1), at(178, 2), at(-179, 3)]) ?? 0) < 5);
    assert.equal(yawSweepDeg([]), null);
    assert.equal(yawSweepDeg([at(0, 0)]), null);
  });

  it("heading helpers go the short way round, and a straight-down camera has no heading but has a pitch", () => {
    assert.equal(cameraHeadingDeg({ fx: 0, fz: 1 }), 0);
    assert.equal(Math.round(cameraHeadingDeg({ fx: 1, fz: 0 }) ?? 0), 90);
    assert.equal(cameraHeadingDeg({ fx: 0, fz: 0 }), null);
    assert.equal(headingStepDeg(170, -170), 20);
    assert.equal(headingStepDeg(-170, 170), -20);
    assert.equal(headingSweepDeg([0, 45, 90, 135, 180, -135, -90, -45, 0]), 360);
    assert.equal(headingSweepDeg([10, null, 20]), 10);
    assert.equal(headingSweepDeg([null, null]), null);
    assert.equal(cameraHeadingDeg({ fx: 0, fy: -1, fz: 0 }), null);
    assert.equal(cameraPitchDeg({ fx: 0, fy: -1, fz: 0 }), -90);
  });

  it("pitch: a camera pinned at the ground reads as ruined; a project that started steep was not ruined by the probe", () => {
    const got = cameraPitchDeg(aimed(-84.27)) ?? 0;
    assert.ok(Math.abs(got - -84.27) < 0.01);
    assert.ok(Math.abs(got) > PITCH_RUINED_DEG);
    assert.equal(cameraPitchDeg({ t: 0, fx: 0, fz: -1 }), null, "no fy is not measurable");
    assert.equal(pitchRuined(aimed(-2), aimed(-84.27)), true);
    assert.equal(pitchRuined(aimed(-70), aimed(-72)), false);
    assert.equal(pitchRuined(aimed(0), aimed(-18)), false);
    assert.equal(pitchRuined(null, null), false);
  });

  it("THE SIGN: a camera aimed DOWN is raised by dragging UP, whatever sign the caller's leg has", () => {
    assert.equal(restoreDragTargetY(360, 129, -84.27), 360 - 129);
    assert.equal(restoreDragTargetY(360, 129, 70), 360 + 129);
    assert.equal(restoreDragTargetY(360, -129, -84.27), 360 - 129);
  });

  it("camera sanity withholds only a majority aimed away; a frozen level camera is a note; too few is never a refusal", () => {
    const pinned = cameraSanity(pinnedAt(-84.27, 1200));
    assert.equal(pinned.severity, "withhold");
    assert.equal(pinned.orientationFrozen, true);
    assert.match(pinned.why ?? "", /aimed more than 60° off the horizon/);
    assert.equal(cameraSanity(Array.from({ length: 200 }, (_, i) => aimed(-8 + (i % 5)))).severity, "ok");
    const iso = cameraSanity(pinnedAt(-35, 300));
    assert.equal(iso.severity, "note");
    assert.match(iso.why ?? "", /isometric or side-on follow camera/);
    const half = cameraSanity([...pinnedAt(-84, 50), ...Array.from({ length: 50 }, (_, i) => aimed(-4 + i * 0.1))]);
    assert.equal(half.severity, "ok");
    const majority = cameraSanity([...pinnedAt(-84, 51), ...Array.from({ length: 49 }, (_, i) => aimed(-4 + i * 0.1))]);
    assert.equal(majority.severity, "withhold");
    assert.equal(cameraSanity(pinnedAt(-84.27, MIN_CAMERA_SANITY_SAMPLES - 1)).severity, "ok");
    assert.equal(cameraSanity(null).severity, "ok");
    assert.equal(cameraSanity(Array.from({ length: 500 }, () => ({ t: 0, fx: 0, fz: -1 }))).severity, "ok");
  });
});

describe("judgeEvidence", () => {
  interface EvidenceInput {
    frames: Array<{ atMs: number; phase: ProbePhase; label: string; source: "page" | "element" }>;
    firstRafPageMs: number;
    firstRenderRunMs: number | null;
    pageToRunOffsetMs: number;
    mirrorFirstDrawPageMs: number | null;
    firstCameraSamplePageMs: number | null;
  }
  const slices = fixture<{ slowBoot: EvidenceInput; healthy: EvidenceInput }>("judge-evidence.json");
  const framesFrom = (startMs: number, count: number, everyMs = 1000, phase: ProbePhase = "soak") =>
    Array.from({ length: count }, (_, i) => ({ atMs: startMs + i * everyMs, phase, source: "page" as const }));

  it("THE SLOW BOOT: 14 frames, all boot or idle, measured offset +2586 — INSUFFICIENT in one clock", () => {
    const f = slices.slowBoot;
    assert.equal(f.frames.length, 14);
    const v = judgeEvidence(f);
    assert.equal(v.sufficient, false);
    assert.equal(v.by, null);
    assert.match(String(v.reason), /0 of 14 page frame\(s\) were taken after the page's first animation frame/);
    assert.match(
      String(v.reason),
      /12193ms of page time, 14779ms of run time with the measured \+2586ms page→run offset/,
    );
    assert.match(String(v.reason), /mirror first read a non-degenerate frame at 18560ms of page time/);
    assert.match(String(v.reason), /neither figure gates/);
  });

  it("the slow boot compared UNCORRECTED (offset unmeasured) counts four frames and STILL refuses", () => {
    const v = judgeEvidence({ ...slices.slowBoot, pageToRunOffsetMs: null });
    assert.equal(v.sufficient, false);
    assert.match(String(v.reason), /4 of 14 page frame\(s\) postdate .* compared UNCORRECTED/);
  });

  it("THE HEALTHY RUN: 52 frames, 45 post-gesture — sufficient by the clock, and by phase without an offset", () => {
    const f = slices.healthy;
    assert.equal(f.frames.filter((fr) => POST_GESTURE_PHASES.has(fr.phase)).length, 45);
    assert.deepEqual(judgeEvidence(f), { sufficient: true, reason: null, by: "clock" });
    assert.deepEqual(judgeEvidence({ ...f, pageToRunOffsetMs: null }), { sufficient: true, reason: null, by: "phase" });
    const stripped = judgeEvidence({
      ...f,
      pageToRunOffsetMs: null,
      frames: f.frames.map((fr) => ({ atMs: fr.atMs, source: fr.source })),
    });
    assert.equal(stripped.sufficient, false, "an offset we did not measure passes nothing on its own");
  });

  it("element-source frames count for neither clause, and exactly three drawing frames clear the floor", () => {
    const frames = [
      { atMs: 100, phase: "boot" as const, source: "page" as const },
      { atMs: 200, phase: "idle-baseline" as const, source: "page" as const },
      ...framesFrom(5000, 3).map((f) => ({ ...f, source: "element" as const })),
    ];
    const v = judgeEvidence({ frames, firstRafPageMs: 1000, firstRenderRunMs: 300, pageToRunOffsetMs: 0 });
    assert.match(String(v.reason), /only 2 page frame\(s\) were captured \(3 canvas-element frame\(s\) are excluded/);
    const exactly = judgeEvidence({
      frames: [{ atMs: 100 }, { atMs: 200 }, { atMs: 5000 }, { atMs: 6000 }, { atMs: 7000 }],
      firstRafPageMs: 1000,
      firstRenderRunMs: 300,
      pageToRunOffsetMs: 0,
    });
    assert.equal(exactly.sufficient, true);
    assert.equal(MIN_JUDGE_FRAMES, 3);
  });

  it("the phase clause is post-gesture, never 'not idle', and cannot count from an unwitnessed draw", () => {
    const after = [
      ...framesFrom(2000, 2, 500, "directions"),
      ...framesFrom(4000, 1, 500, "ack"),
      ...framesFrom(5000, 1, 500, "input-burst"),
    ];
    assert.deepEqual(
      judgeEvidence({ frames: after, firstRafPageMs: 10, firstRenderRunMs: 1500, pageToRunOffsetMs: null }),
      {
        sufficient: true,
        reason: null,
        by: "phase",
      },
    );
    const idle = after.map((f) => ({ ...f, phase: "idle-baseline" as const }));
    assert.equal(
      judgeEvidence({ frames: idle, firstRafPageMs: 10, firstRenderRunMs: 1500, pageToRunOffsetMs: null }).sufficient,
      false,
    );
    const unwitnessed = judgeEvidence({
      frames: after,
      firstRafPageMs: 10,
      firstRenderRunMs: null,
      pageToRunOffsetMs: null,
    });
    assert.match(String(unwitnessed.reason), /no capture ever witnessed a non-degenerate draw/);
  });

  it("no rAF is insufficient with its own reason, unless the phase clause photographed the page drawing anyway", () => {
    const v = judgeEvidence({
      frames: framesFrom(0, 30, 5000, "idle-baseline"),
      firstRafPageMs: null,
      firstRenderRunMs: 800,
      pageToRunOffsetMs: 0,
    });
    assert.match(String(v.reason), /never scheduled an animation frame/);
    assert.deepEqual(
      judgeEvidence({
        frames: framesFrom(0, 30, 5000),
        firstRafPageMs: null,
        firstRenderRunMs: 800,
        pageToRunOffsetMs: 0,
      }),
      {
        sufficient: true,
        reason: null,
        by: "phase",
      },
    );
    const early = judgeEvidence({
      frames: framesFrom(0, 6, 100),
      firstRafPageMs: 10,
      firstRenderRunMs: 4000,
      pageToRunOffsetMs: 0,
    });
    assert.match(String(early.reason), /every frame predates the moment anything was drawn/);
  });

  it("the judge is withheld from a screen the probe never got past, and from a camera aimed at the ground", () => {
    const frames = framesFrom(20_000, 71, 6_000);
    const base = { frames, firstRafPageMs: 11_250, firstRenderRunMs: 8_037, pageToRunOffsetMs: 3_562 };
    const stuck = judgeEvidence({
      ...base,
      interactionReached: { reached: false, why: 'the page still read "Loading 11/12"' },
    });
    assert.match(stuck.reason ?? "", /interaction was never reached/);
    assert.equal(judgeEvidence({ ...base, interactionReached: { reached: true, why: "entered" } }).sufficient, true);
    assert.equal(judgeEvidence(base).sufficient, true, "absent gates nothing");
    const aimedDown = cameraSanity(Array.from({ length: 1200 }, () => ({ t: 0, fx: 0, fy: -0.995, fz: -0.1 })));
    assert.match(
      judgeEvidence({ ...base, cameraSanity: aimedDown }).reason ?? "",
      /camera was not pointing at the project/,
    );
  });
});

describe("chrome and focus guards", () => {
  it("the deny list refuses sign-in and close chrome and allows a fiction's own start label", () => {
    const deny = new RegExp(CHROME_DENY_SOURCE, "i");
    for (const label of ["Sign in", "SIGN IN", "×", "✕", "x", "Log in", "Login", "Settings", "Credits", "Close"]) {
      assert.ok(deny.test(label), `must deny ${JSON.stringify(label)}`);
    }
    for (const label of [
      "DEPLOY",
      "DEPLOY TO COMBAT",
      "PLAY THE HOLE",
      "Start",
      "Continue",
      "New project",
      "Jump in",
    ]) {
      assert.ok(!deny.test(label), `must allow ${JSON.stringify(label)}`);
    }
  });

  it('"Start Options" is a row, never consulted: Start clicks, Options refuses', () => {
    assert.equal(chromeNameRefusal({ interactive: true, name: "Start" }), null);
    assert.match(chromeNameRefusal({ interactive: true, name: "Options" }) ?? "", /control named "Options"/);
    assert.match(
      chromeNameRefusal({ interactive: false, name: "Start Options" }) ?? "",
      /matches the chrome deny list/,
    );
    assert.equal(chromeNameRefusal(null), null);
    assert.equal(chromeNameRefusal({ interactive: true, name: "" }), null);
    assert.equal(chromeNameRefusal({ interactive: false, name: "Sign in\nto save progress" }), null);
    const long = "Click here to open the options menu and then close it";
    assert.ok(long.length > CHROME_NAME_MAX);
    assert.equal(chromeNameRefusal({ interactive: true, name: long }), null);
  });

  it("a link, a form control, an activatable role and an editable region refuse a key; body, canvas and a container do not", () => {
    assert.match(keyFocusRefusal({ tag: "A", href: true }) ?? "", /link/);
    assert.equal(keyFocusRefusal({ tag: "A", href: false }), null);
    assert.match(keyFocusRefusal({ tag: "BUTTON", name: "PLAY" }) ?? "", /form control <button>/);
    assert.match(keyFocusRefusal({ tag: "INPUT", type: "text" }) ?? "", /<input type=text>/);
    assert.match(keyFocusRefusal({ tag: "DIV", role: "button" }) ?? "", /role="button"/);
    assert.match(keyFocusRefusal({ tag: "DIV", contentEditable: true }) ?? "", /editable/);
    assert.match(keyFocusRefusal({ tag: "IFRAME" }) ?? "", /iframe/);
    assert.equal(keyFocusRefusal({ tag: "BODY" }), null);
    assert.equal(keyFocusRefusal({ tag: "CANVAS" }), null);
    assert.equal(keyFocusRefusal({ tag: "DIV", role: "application" }), null);
    assert.equal(keyFocusRefusal(null), null, "a page that did not answer is fail-open");
  });
});

describe("stayedOnProject (no bounce allowed)", () => {
  const nav = (atMs: number, url: string) => ({ atMs, url });

  it("a departure that never came back fails, and the detail lists where it went", () => {
    const v = stayedOnProject({
      navigations: [
        nav(300, `${PROJECT}/`),
        nav(174_339, "https://login.example.test/authorize"),
        nav(175_575, "https://login.example.test/login"),
      ],
      projectOrigin: PROJECT,
      foreignSnapshots: 0,
      sameOriginSnapshots: 3,
      endAtMs: 394_551,
    });
    assert.equal(v.result, "fail");
    assert.equal(v.excursions.length, 1);
    assert.equal(v.excursions[0].returned, false);
    assert.equal(v.excursions[0].toMs, 394_551, "closed at the run end");
    assert.equal(v.foreignNavigations, 2);
    assert.match(v.detail, /never came back/);
    assert.match(v.detail, /\/login/);
  });

  it("even a short round trip off the origin fails: a local snapshot has no identity bounce", () => {
    const v = stayedOnProject({
      navigations: [
        nav(300, `${PROJECT}/`),
        nav(1245, "https://auth.example.test/authorize"),
        nav(3428, `${PROJECT}/?r=1`),
      ],
      projectOrigin: PROJECT,
      foreignSnapshots: 0,
      sameOriginSnapshots: 3,
      endAtMs: 900_000,
    });
    assert.equal(v.result, "fail");
    assert.equal(v.excursions[0].returned, true);
    assert.equal(v.excursions[0].durationMs, 3428 - 1245);
    assert.match(v.detail, /no bounce is allowed/);
  });

  it("staying on the origin passes; a foreign snapshot fails alone; no origin or no navigation is unknown", () => {
    const home = [nav(858, `${PROJECT}/index.html`)];
    assert.equal(
      stayedOnProject({
        navigations: home,
        projectOrigin: PROJECT,
        foreignSnapshots: 0,
        sameOriginSnapshots: 3,
        endAtMs: 1,
      }).result,
      "pass",
    );
    const snap = stayedOnProject({
      navigations: home,
      projectOrigin: PROJECT,
      foreignSnapshots: 1,
      sameOriginSnapshots: 2,
      endAtMs: 1,
    });
    assert.equal(snap.result, "fail");
    assert.match(snap.detail, /1 of 3 page-state snapshot\(s\) were read off the origin/);
    assert.equal(
      stayedOnProject({ navigations: home, projectOrigin: "", foreignSnapshots: 0, sameOriginSnapshots: 0, endAtMs: 1 })
        .result,
      "unknown",
    );
    assert.equal(
      stayedOnProject({
        navigations: [],
        projectOrigin: PROJECT,
        foreignSnapshots: 0,
        sameOriginSnapshots: 0,
        endAtMs: 1,
      }).result,
      "unknown",
    );
  });

  it("an unreadable URL neither opens nor closes an excursion", () => {
    const v = stayedOnProject({
      navigations: [nav(300, `${PROJECT}/`), nav(1200, "https://login.example.test/login"), nav(2000, "")],
      projectOrigin: PROJECT,
      foreignSnapshots: 0,
      sameOriginSnapshots: 1,
      endAtMs: 90_000,
    });
    assert.equal(v.result, "fail", "an unreadable URL is not a return to the project");
    assert.equal(v.foreignNavigations, 1);
    const only = stayedOnProject({
      navigations: [nav(300, "")],
      projectOrigin: PROJECT,
      foreignSnapshots: 0,
      sameOriginSnapshots: 1,
      endAtMs: 90_000,
    });
    assert.equal(only.result, "pass");
  });
});

describe("chooseEvidenceFrame", () => {
  it("a cross-origin frame holding the largest canvas is REFUSED; reads stay on the top frame", () => {
    const choice = chooseEvidenceFrame(
      [
        { url: `${PROJECT}/`, isTop: true, canvasArea: 0 },
        { url: "https://ads.example.test/unit.html", isTop: false, canvasArea: 300 * 250 },
      ],
      PROJECT,
    );
    assert.deepEqual([choice.routed, choice.index, choice.sameOrigin], [false, null, false]);
    assert.match(choice.why, /CROSS-ORIGIN/);
  });

  it("a same-origin canvas frame is routed to only when the top frame has none; an origin-less frame stays eligible", () => {
    const routed = chooseEvidenceFrame(
      [
        { url: `${PROJECT}/`, isTop: true, canvasArea: 0 },
        { url: `${PROJECT}/project/`, isTop: false, canvasArea: 1280 * 720 },
        { url: `${PROJECT}/minimap/`, isTop: false, canvasArea: 200 * 200 },
      ],
      PROJECT,
    );
    assert.deepEqual([routed.routed, routed.index, routed.sameOrigin], [true, 1, true]);
    const topWins = chooseEvidenceFrame(
      [
        { url: `${PROJECT}/`, isTop: true, canvasArea: 640 * 480 },
        { url: `${PROJECT}/project/`, isTop: false, canvasArea: 1280 * 720 },
      ],
      PROJECT,
    );
    assert.deepEqual([topWins.routed, topWins.index], [false, 0]);
    const srcdoc = chooseEvidenceFrame(
      [
        { url: `${PROJECT}/`, isTop: true, canvasArea: 0 },
        { url: "about:srcdoc", isTop: false, canvasArea: 100 },
      ],
      PROJECT,
    );
    assert.deepEqual([srcdoc.routed, srcdoc.sameOrigin], [true, null]);
    assert.match(
      chooseEvidenceFrame([{ url: `${PROJECT}/`, isTop: true, canvasArea: 0 }], PROJECT).why,
      /no frame holds a canvas/,
    );
  });
});

describe("fullscreen", () => {
  it("a refused request demotes a fail to unknown, naming the door and the activation state", () => {
    const refused = {
      requested: 2,
      granted: false,
      userActivationAtRequest: false,
      lastRefusal: "Permissions check failed",
    };
    assert.equal(fullscreenBlocked(refused), true);
    const d = demoteForFullscreen("fail", refused);
    assert.equal(d.result, "unknown");
    assert.match(String(d.why), /asked for fullscreen 2 time\(s\) with NO user activation live/);
    assert.match(String(d.why), /Permissions check failed/);
    assert.match(
      String(demoteForFullscreen("fail", { requested: 1, granted: false, userActivationAtRequest: true }).why),
      /with user activation live at the first call and never got it;/,
    );
  });

  it("granted, never asked, or no record moves nothing, and the demotion is one-directional", () => {
    for (const state of [{ requested: 3, granted: true }, { requested: 0, granted: false }, {}, null, undefined]) {
      assert.equal(fullscreenBlocked(state), false);
      assert.deepEqual(demoteForFullscreen("fail", state), { result: "fail", why: null });
    }
    const blocked = { requested: 1, granted: false };
    assert.deepEqual(demoteForFullscreen("pass", blocked), { result: "pass", why: null });
    assert.deepEqual(demoteForFullscreen("unknown", blocked), { result: "unknown", why: null });
  });
});

describe("the entrance", () => {
  interface Observation {
    frames: Array<{ file: string; atMs: number; phase: ProbePhase; label: string; source: "page" | "element" }>;
    raf: { distinctFrames: number; firstT: number; lastT: number };
    network: { requests: number };
    firstNonDegenerateMs: number;
    entrance: EntranceSignals;
    exposureChosen: string[];
  }
  const { healthy, stuck } = fixture<{ healthy: Observation; stuck: Observation }>("observations.json");
  const NO_DOOR: EntranceSignals = {
    startControl: { found: null, clicked: false, gone: null },
    pressAnyKey: null,
    cameraMoved: null,
    pointerLockEngaged: false,
    pointerLockRequested: false,
  };

  it("a synthetic lock held after the gesture confirms the entrance, whatever the finder clicked", () => {
    const v = judgeEntrance(healthy.entrance);
    assert.deepEqual([v.confirmed, v.by, v.doorObserved], [true, "pointer-lock", true]);
    assert.equal(healthy.entrance.startControl.found, "Run");
  });

  it("a start control clicked and STILL on screen is a door never seen to open", () => {
    const v = judgeEntrance(stuck.entrance);
    assert.deepEqual([v.confirmed, v.by, v.doorObserved], [false, "none", true]);
    assert.match(v.why, /"Enter the village" was clicked and was STILL on screen afterwards/);
    assert.match(v.why, /no camera could be read/);
  });

  it("entry is judged by a control disappearing or a camera moving, never by a pixel change", () => {
    assert.equal(
      judgeEntrance({ ...NO_DOOR, startControl: { found: "DEPLOY", clicked: true, gone: true } }).by,
      "start-control",
    );
    const pak = judgeEntrance({
      ...NO_DOOR,
      pressAnyKey: { affordance: "Press any key to start", keysSent: ["Enter", "Space"], gone: true },
    });
    assert.equal(pak.by, "press-any-key");
    assert.match(pak.why, /after Enter then Space went out/);
    const refused = judgeEntrance({
      ...NO_DOOR,
      pressAnyKey: { affordance: "Press any key to start", keysSent: [], gone: null },
    });
    assert.match(refused.why, /no key went out for it/);
    assert.equal(judgeEntrance({ ...NO_DOOR, cameraMoved: true }).by, "camera-moved");
    const both = { ...NO_DOOR, startControl: { found: "PLAY", clicked: true, gone: true }, cameraMoved: true };
    assert.equal(judgeEntrance(both).by, "start-control", "the stronger witness wins");
    assert.ok(!Object.keys(NO_DOOR).some((k) => /pixel|diff|frame/i.test(k)), "no pixel signal exists");
    assert.equal(
      judgeEntrance({ ...NO_DOOR, startControl: { found: "PLAY", clicked: true, gone: null } }).confirmed,
      false,
    );
    const none = judgeEntrance({ ...NO_DOOR, cameraMoved: false });
    assert.deepEqual([none.confirmed, none.doorObserved], [false, false]);
    assert.match(none.why, /^no door was observed/);
  });

  it("an occluded start control is a door observed, and the reason names the cover", () => {
    const v = judgeEntrance({
      ...NO_DOOR,
      startControl: {
        found: null,
        clicked: false,
        gone: null,
        occluded: { text: "Walk in", by: "div#pause (effective opacity 0.00)" },
      },
      cameraMoved: false,
      pointerLockEngaged: null,
    });
    assert.equal(v.doorObserved, true);
    assert.match(v.why, /"Walk in" is covered by an invisible element/);
  });

  it("interaction is reached through a confirmed entrance or no door; a door never opened or a loader at the end is not", () => {
    const post = (o: Observation) => o.frames.filter((f) => POST_GESTURE_PHASES.has(f.phase)).length;
    assert.equal(
      interactionReached({ entrance: judgeEntrance(healthy.entrance), postGestureFrames: post(healthy) }).reached,
      true,
    );
    assert.equal(
      interactionReached({ entrance: judgeEntrance(stuck.entrance), postGestureFrames: post(stuck) }).reached,
      false,
    );
    assert.equal(interactionReached({ entrance: judgeEntrance(NO_DOOR), postGestureFrames: 12 }).reached, true);
    assert.equal(interactionReached({ entrance: judgeEntrance(NO_DOOR), postGestureFrames: 0 }).reached, false);
    const loader = interactionReached({
      entrance: { confirmed: false, doorObserved: false, why: "no door" },
      postGestureFrames: 71,
      stillLoading: { phrase: "Raising the houses… 11/12", progress: true },
    });
    assert.equal(loader.reached, false);
    assert.match(loader.why, /still read "Raising the houses… 11\/12" at the end/);
  });

  it("demoteForNoInteraction only ever turns a fail into unknown", () => {
    const notReached = { reached: false, why: "a loader" };
    assert.equal(demoteForNoInteraction("fail", notReached).result, "unknown");
    assert.match(
      demoteForNoInteraction("fail", notReached).why ?? "",
      /must not be reported as a project that does not RESPOND/,
    );
    assert.equal(demoteForNoInteraction("pass", notReached).why, null);
    assert.equal(demoteForNoInteraction("fail", { reached: true, why: "entered" }).result, "fail");
  });

  it("pageRan answers 'did not run' for an empty observation, and both measured shapes ran", () => {
    assert.deepEqual(pageRan({ rafFrames: 0, requests: 0, lastRafPageMs: null }), {
      ran: false,
      why: "the page scheduled no animation frame",
    });
    assert.match(
      String(pageRan({ rafFrames: 10, requests: 1, lastRafPageMs: 5000 }).why),
      /only 1 network request\(s\)/,
    );
    assert.match(
      String(pageRan({ rafFrames: 10, requests: 2, lastRafPageMs: 20000, windowMs: 60000 }).why),
      /last animation frame was at 20000ms of page time, so the 60s window was not observed in full/,
    );
    for (const o of [healthy, stuck]) {
      const ran = pageRan({
        rafFrames: o.raf.distinctFrames,
        requests: o.network.requests,
        lastRafPageMs: o.raf.lastT,
        windowMs: 60000,
      });
      assert.deepEqual(ran, { ran: true, why: null });
    }
    assert.equal(healthy.network.requests, RAN_REQUEST_FLOOR);
  });

  it("exposure frames: the stuck run has no eligible frame; the healthy run's chosen eight are the newest", () => {
    const stuckSel = selectExposureFrames(stuck.frames, stuck.firstNonDegenerateMs);
    assert.equal(stuckSel.eligible.length, 0);
    assert.match(String(stuckSel.why), new RegExp(`only 0 page frame\\(s\\) .* under the ${MIN_EXPOSURE_FRAMES}`));
    const sel = selectExposureFrames(healthy.frames, healthy.firstNonDegenerateMs);
    assert.equal(sel.candidates.length, 46);
    assert.equal(sel.chosen.length, EXPOSURE_SAMPLE);
    assert.deepEqual(
      sel.chosen.map((f) => f.file),
      healthy.exposureChosen,
    );
    assert.equal(sel.why, null);
  });

  it("look and element frames never enter the exposure sample; no witnessed draw means nothing is eligible", () => {
    const frames = [
      { atMs: 30_000, phase: "directions" as const, source: "page" as const },
      { atMs: 40_000, phase: "ack" as const, source: "page" as const },
      { atMs: 50_000, phase: "input-burst" as const, source: "page" as const },
      ...Array.from({ length: 16 }, (_, i) => ({
        atMs: 60_000 + i * 1000,
        phase: "look" as const,
        source: "page" as const,
      })),
      { atMs: 80_000, phase: "soak" as const, source: "element" as const },
      { atMs: 90_000, phase: "soak" as const, source: "page" as const },
    ];
    const sel = selectExposureFrames(frames, 10_000);
    assert.equal(sel.excludedLook, 16);
    assert.equal(sel.excludedElement, 1);
    assert.deepEqual(
      sel.candidates.map((f) => f.phase),
      ["directions", "ack", "input-burst", "soak"],
    );
    assert.equal(selectExposureFrames(frames, null).eligible.length, 0);
    assert.ok(POST_GESTURE_PHASES.has("look"), "look frames are still post-gesture for the judge");
  });

  it("a verb's pixel response counts only when it beat the matched control window", () => {
    assert.equal(verbPixelExceededControl({ pixelDelta: 0.05, pixelControlMax: 0.02, pixelControlSamples: 12 }), true);
    assert.equal(verbPixelExceededControl({ pixelDelta: 0.05, pixelControlMax: 0.09, pixelControlSamples: 12 }), false);
    assert.equal(verbPixelExceededControl({ pixelDelta: 0.05, pixelControlMax: 0.05, pixelControlSamples: 12 }), false);
    assert.equal(verbPixelExceededControl({ pixelDelta: null }), null);
    assert.equal(verbPixelExceededControl({ pixelDelta: 0.05 }), null);
    assert.equal(verbPixelExceededControl({ pixelDelta: 0.05, pixelControlMax: null, pixelControlSamples: 0 }), null);
  });

  it("a screen names its keys; an in-project interact hint names none", () => {
    assert.deepEqual(namedKeysIn("Esc resumes too"), ["Escape"]);
    assert.deepEqual(namedKeysIn("Press Enter or Space to begin"), ["Enter", "Space"]);
    assert.deepEqual(namedKeysIn("Press E to interact"), []);
    assert.deepEqual(namedKeysIn("Press F to start"), ["KeyF"]);
    assert.deepEqual(namedKeysIn("Enter the village"), ["Enter"]);
  });
});

describe("enterableVerdict", () => {
  const base = {
    confirmed: false,
    by: "none" as const,
    doorObserved: true,
    startControl: { found: "Start", clicked: true, gone: false },
    pressAnyKey: null,
    pointerLock: { requested: false, engaged: false },
    fullscreen: { requested: false, granted: false },
  };

  it("every move a player has, and the screen is still there: the project cannot be entered, a FAIL", () => {
    const v = enterableVerdict({
      ...base,
      startControl: { found: "Esc resumes too", clicked: true, gone: false },
      pressAnyKey: { affordance: "Esc resumes too", keysSent: ["Escape"], keysRefused: [], gone: false },
    });
    assert.equal(v.result, "fail");
    assert.match(v.why, /pressed Escape as the screen "Esc resumes too" asked/);
  });

  it("pass on a confirmed entrance or no door; unknown when the probe could not make a player's move", () => {
    assert.equal(enterableVerdict({ ...base, confirmed: true, by: "pointer-lock" }).result, "pass");
    assert.equal(enterableVerdict({ ...base, doorObserved: false }).result, "pass");
    assert.equal(enterableVerdict({ ...base, fullscreen: { requested: true, granted: false } }).result, "unknown");
    assert.equal(enterableVerdict({ ...base, pointerLock: { requested: true, engaged: false } }).result, "unknown");
    assert.equal(
      enterableVerdict({ ...base, startControl: { found: "Start", clicked: false, gone: null } }).result,
      "unknown",
    );
    const refused = { affordance: "Press Enter", keysSent: [], keysRefused: ["Enter"], gone: null };
    assert.equal(enterableVerdict({ ...base, pressAnyKey: refused }).result, "unknown");
    assert.equal(enterableVerdict(base).result, "fail");
  });

  it("a visible start control under an invisible cover FAILS and names the cover, even behind a lock door", () => {
    const occluded = { text: "Walk in", by: "div.menu-note (effective opacity 0.00)" };
    const startControl = { found: null, clicked: false, gone: null, occluded };
    const v = enterableVerdict({ ...base, startControl });
    assert.equal(v.result, "fail");
    assert.match(v.why, /"Walk in" is covered by an invisible element/);
    assert.equal(
      enterableVerdict({ ...base, startControl, pointerLock: { requested: true, engaged: null } }).result,
      "fail",
    );
  });
});

describe("directionPairVerdict", () => {
  it("49 vs 2 is not a verdict; the same disagreement between two strong readings is", () => {
    const v = directionPairVerdict({ a: 49, b: 2, want: "opposite" });
    assert.equal(v.verdict, "unknown");
    assert.match(v.why, /the weaker reading is only 2 column\(s\)/);
    assert.equal(directionPairVerdict({ a: 49, b: MIN_FAIL_MOTION_COLUMNS, want: "opposite" }).verdict, "fail");
    assert.equal(directionPairVerdict({ a: 49, b: MIN_FAIL_MOTION_COLUMNS - 1, want: "opposite" }).verdict, "unknown");
  });

  it("the bar is raised for fail only; unreadable and below-floor readings are unknown", () => {
    for (const [a, b] of [
      [-3, 2],
      [-4, 3],
      [-7, 16],
    ] as const) {
      assert.equal(directionPairVerdict({ a, b, want: "opposite" }).verdict, "pass");
    }
    assert.equal(directionPairVerdict({ a: null, b: 20, want: "opposite" }).why, "frames too dissimilar to correlate");
    assert.equal(directionPairVerdict({ a: 20, b: 0, want: "same" }).why, "movement below the noise floor");
    assert.equal(directionPairVerdict({ a: -2, b: 49, want: "same" }).verdict, "unknown");
  });
});

describe("console-line classifiers", () => {
  const REMOVED_API = "THREE.WebGLShadowMap: PCFSoftShadowMap has been removed. Using PCFShadowMap instead.";
  const REJECTED_DRAW =
    "[.WebGL-0x13400569000] GL_INVALID_OPERATION: glDrawElements: Mismatch between texture format and sampler type (signed/unsigned/float/shadow).";

  it("loader failures are library-anchored: three.js and DOM wording, not a project's own prose", () => {
    const lines = [
      "[world] a building failed TypeError: Failed to execute 'drawImage' on 'CanvasRenderingContext2D': The provided value is not of type '(...)'.",
      "THREE.GLTFLoader: Couldn't load texture blob:https://project.example.test/3c1da18a",
      "THREE.KTX2Loader: Unable to load transcoder",
    ];
    for (const line of lines) assert.equal(isLoaderFailureLine(line), true, line);
    assert.equal(loaderFailureCount(lines.map((text) => ({ text }))), 3);
    for (const benign of [
      "THREE.WebGLShadowMap: PCFSoftShadowMap has been deprecated. Using PCFShadowMap instead.",
      "[Violation] 'requestAnimationFrame' handler took 127ms",
      "[world] could not load the barn",
    ]) {
      assert.equal(isLoaderFailureLine(benign), false, benign);
    }
    assert.equal(loaderFailureCount([{ text: undefined }, { text: 42 }, {}]), 0);
  });

  it("renderer defects collapse the flood to distinct causes, merge contexts, and ignore noise", () => {
    const d = rendererDefects([{ text: REMOVED_API }, ...Array.from({ length: 200 }, () => ({ text: REJECTED_DRAW }))]);
    assert.equal(d.count, 201);
    assert.deepEqual(d.distinct, [REMOVED_API, REJECTED_DRAW.replace("[.WebGL-0x13400569000] ", "")]);
    const other = REJECTED_DRAW.replace("0x13400569000", "0x90c00169000");
    assert.equal(rendererDefects([{ text: REJECTED_DRAW }, { text: other }]).distinct.length, 1);
    for (const benign of [
      "THREE.KTX2Loader: Multiple active KTX2 loaders may cause performance issues.",
      "THREE.WebGLRenderer: EXT_clip_control not supported, falling back to the standard depth buffer.",
    ]) {
      assert.equal(isRendererDefectLine(benign), false, benign);
    }
    assert.equal(isLoaderFailureLine(REJECTED_DRAW), false, "neither detector claims the other");
    assert.deepEqual(rendererDefects([]), { count: 0, distinct: [] });
  });
});

describe("gates", () => {
  const row = (id: ProbeRow, layer: Check["layer"], result: Check["result"], over: Partial<Check> = {}): Check => ({
    id,
    layer,
    result,
    title: id,
    source: "machine",
    value: null,
    detail: "",
    ...over,
  });
  const l1 = (survives: Check["result"], gates: boolean): Check[] => [
    row(ProbeRow.L1BuildsAndBoots, "L1", "pass"),
    row(ProbeRow.L1NoErrors60s, "L1", "pass"),
    row(ProbeRow.L1Survives5min, "L1", survives, { gates }),
    row(ProbeRow.L1AssetsArrived, "L1", "pass"),
    row(ProbeRow.L1StayedOnProject, "L1", "pass"),
  ];
  const l2 = (input: Check["result"], ackGates: boolean): Check[] => [
    row(ProbeRow.L2Enterable, "L2", "pass"),
    row(ProbeRow.L2InputChangesState, "L2", input),
    row(ProbeRow.L2ActionAcknowledged200ms, "L2", "unknown", { gates: ackGates }),
    row(ProbeRow.L3SpatiallyLegible, "L2", "unknown", { source: "judge" }),
  ];

  it("a project that booted, entered and moved reads PASS when the unmeasurable rows do not gate", () => {
    const g = gateFor([...l1("unknown", false), ...l2("pass", false)]);
    assert.deepEqual([g.l1, g.l2], ["pass", "pass"]);
    assert.equal(isScored(g), true);
  });

  it("a real defect still fails, and a row unknown for a non-substrate reason still holds the gate", () => {
    const failed = gateFor([...l1("unknown", false), ...l2("fail", false)]);
    assert.equal(failed.l2, "fail");
    assert.equal(isScored(failed), false);
    assert.equal(gateFor(l1("fail", true)).l1, "fail");
    assert.equal(gateFor(l1("unknown", true)).l1, "unknown");
    assert.equal(
      gateFor([row(ProbeRow.L1BuildsAndBoots, "L1", "unknown")]).l1,
      "unknown",
      "absent gates means it gates",
    );
  });

  it("nothing observed is unknown, and judge rows never reach the machine gate", () => {
    assert.equal(worstResult([]), "unknown");
    assert.equal(gateFor([]).l2, "unknown");
    assert.deepEqual(gatingRows(l2("pass", false), "L2"), ["pass", "pass"]);
    assert.equal(isScored({ l1: "unknown", l2: "unknown" }), true, "only a fail un-scores a run");
  });
});
