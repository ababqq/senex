/**
 * Evidence — how the harness looks at a build.
 *
 * One pass (`gatherEvidence`): load the build, wait for it to say it is up, replay the requested
 * state, prove the studio owns the clock, drive the project's own controls, photograph every camera
 * and the player's eyes, run its demos, and read the state, the console and the GPU. Every mode
 * uses it — the classic gauntlet, the pipeline's base and facets, a spike, the director's judge,
 * health and close passes.
 *
 * Around the pass: the one classifier of why a pass came back unjudgeable (the camera, the clock,
 * or the build), the patience that follows from it (`withObservationPatience`, `patientEvidence`),
 * and the preview windows a look is taken through (`acquireWindow`, `withLease`).
 *
 * This moved here out of gauntlet.ts and director.ts; gauntlet.ts still exports every name it
 * exported, so a harness file the in-app agent edited before the move keeps its imports.
 */
import { applyPlayScript } from "./play-script.ts";
import { playScriptFor, wantsEyeCameras } from "./kinds.ts";
import { LOAD_RACE_RETRY_MS, OBSERVATION_RETRY_MS, RACE_RETRY_MS, WINDOW_RETRIES_MS } from "./config.ts";
import { HostMethod } from "./host-methods.ts";
import { PageMethod } from "./page-contract.ts";
import { clip } from "./text.ts";
import { SECOND_MS, sleep } from "./time.ts";
import { isRecord } from "./json.ts";
import { DEFAULT_CAMERA } from "./cameras.ts";
import type { AnyRecord, HarnessCtx, Run } from "../types/harness.d.ts";
import type { CheckEvidence } from "./checks.ts";

/** One photographed frame: the camera, where the file is, its pixels and the surface it came off. */
export interface Shot {
  camera: string;
  path?: string | null;
  bytes?: number;
  base64?: string;
  stats?: AnyRecord | null;
  surface?: string;
  registered?: boolean;
  [field: string]: unknown;
}

/**
 * What an evidence pass gathered: whether the build is judgeable (`ok`), what makes it not
 * (`problems`), what a judge and the next builder should know anyway (`warnings`), and every
 * reading — frames, state, demos, console, readiness, the clock proof.
 */
export interface Evidence extends CheckEvidence {
  ok: boolean;
  problems: string[];
  warnings: string[];
  shots: Shot[];
  consoleErrors: string[];
  readyAfterMs?: number | null;
  attempts?: number;
  // biome-ignore lint/suspicious/noExplicitAny: every other reading of the pass, read by name where it is used.
  [field: string]: any;
}

/** What one evidence pass is asked to look at, and how. */
export interface GatherOptions {
  run: Run;
  iterationId?: string | number;
  seed?: number;
  handle?: string | null;
  root?: string | null;
  labelPrefix?: string | null;
  cameras?: string[] | null;
  entry?: string;
  eyes?: boolean;
  motion?: number;
  audio?: boolean;
  maxDemos?: number;
  requiredDemos?: string[];
  userView?: boolean;
  scaffold?: boolean;
  setup?: AnyRecord | null;
  inheritedConsole?: string[];
}

/** The pass's own state, phase to phase: its arguments, then what each phase found. */
interface Look extends GatherOptions {
  ctx: HarnessCtx;
  // Set by gatherEvidence's own defaults.
  eyes: boolean;
  motion: number;
  audio: boolean;
  maxDemos: number;
  requiredDemos: string[];
  userView: boolean;
  scaffold: boolean;
  inheritedConsole: string[];
  // biome-ignore lint/suspicious/noExplicitAny: each phase adds the readings the phases after it read.
  [field: string]: any;
}

/** A phase ends the pass by answering its result, or hands on by answering nothing. */
type LookEnd = { value: Evidence } | undefined | void;

/** How the studio's proof of its own clock came out. */
export interface StepProof {
  ok: boolean;
  code: string;
  reason: string;
  frames: number;
  drawCalls: number;
  ms: number;
  canvas: boolean;
  simulatedMs: number | null;
  idle: number;
  askedFrames: number;
  idleLoop: boolean;
  note: string;
}

/** Above this fraction of differing pixels, the user's page and the canvas are two pictures. */
const USER_VIEW_MISMATCH = 0.02;
/** Below this lit fraction on every camera, a build renders effectively black. */
const BLACK_LIT_FRACTION = 0.005;
/** A page that takes longer than this to say it is ready is warned about: every pass pays that boot. */
const SLOW_BOOT_MS = 5 * SECOND_MS;
/** How long a setup waits for the project to settle after its actions: 400 ms unless it says, never over ten seconds. */
const SETUP_SETTLE_MS = 400;
const SETUP_SETTLE_MAX_MS = 10 * SECOND_MS;
/** The most keys a setup's gesture presses, and the most input actions it replays. */
const MAX_GESTURE_KEYS = 4;
const MAX_SETUP_ACTIONS = 24;
/** The clock proof steps twice, this long each. */
const PROOF_STEPS = 2;
const PROOF_STEP_MS = 320;
/** The drive: this many steps of this long (about thirty simulated seconds), motion frames spread over them. */
const DRIVE_STEPS = 29;
const DRIVE_STEP_MS = 960;
const LAST_DRIVE_STEP = DRIVE_STEPS - 1;
/** A pass without a spec photographs at most this many cameras. */
const MAX_CAMERAS = 6;
/** The harness's own viewpoints, asked of a project that declares fewer than two. */
const FLOOR_CAMERAS = [DEFAULT_CAMERA, "close", "wide"];
/** The player's-eye cameras a pass photographs when the project has them. */
const EYE_CAMERAS = ["eye:spawn", "eye:here", "eye:down"];
/** How many of the page's UI entries a warning names. */
const MAX_UI_ENTRIES = 6;
/** What the answer keeps of the console and the GPU: the last few errors for a prompt, and the baseline. */
const PROMPT_CONSOLE_ERRORS = 5;
/** How many inherited console errors a pass's warning quotes, and how much of each. */
const INHERITED_ERRORS_QUOTED = 2;
const INHERITED_ERROR_CHARS = 160;
const MAX_CONSOLE_BASELINE = 200;
const MAX_GPU_ERRORS = 16;

/** The sentence this pass pushes when the page carries no contract at all. Exported because the
 * race classifier is built from it: a sentence two files re-type is a sentence that drifts. */
export const MISSING_CONTRACT = "window.__studio is missing — the build cannot be judged";

/** The sentence a pass with no frame owes its reader; also an observation problem. */
const NO_FRAME = /^no camera produced a frame/;

/**
 * Every way a look can come back unjudgeable without the build being at fault, in one table —
 * each sentence once, with what it can mean. There used to be two lists: the classic pass's
 * observation problems and the director's load race, each a copy of the other's first four lines.
 *
 *  - `observation`: a blind camera — a capture that raced the compositor, failed outright, or
 *    found no display surface. Duplicate-frame problems are deliberately NOT here: captures are
 *    page-rendered fresh per call, so identical frames across cameras indict the build's camera
 *    wiring — treating them as an outage once held a finished panelka build "unjudged" until
 *    teardown deleted it.
 *  - `race`: the page was photographed before it finished coming up. Only the missing contract
 *    qualifies, exactly as worded, and only while readiness itself went unmeasured (see
 *    `classifyEvidenceFailure`). "evidence pass failed" is deliberately absent: it is the
 *    catch-all for a dead preview, and it must cost its iteration rather than be retried three
 *    times against the same corpse.
 *  - `load`: what the director's patient pass looks again for — a load that raced the window (no
 *    __studio yet, a capture before the first frame) is not a broken build. Eight health passes in
 *    one night failed this way while the judge, forty seconds later, found every one of those
 *    builds fine. A pass that took no frame at all has never been one of these.
 */
/** What one problem can mean (`EVIDENCE_FAILURES`). */
const ProblemMeaning = {
  Observation: "observation",
  Race: "race",
  Load: "load",
} as const;
type ProblemMeaning = (typeof ProblemMeaning)[keyof typeof ProblemMeaning];

/** Why a look is not judgeable (`classifyEvidenceFailure`): nothing, the camera, the clock, or the build. */
export const EvidenceFailure = {
  None: "none",
  Observation: "observation",
  Race: "race",
  Build: "build",
} as const;
export type EvidenceFailure = (typeof EvidenceFailure)[keyof typeof EvidenceFailure];

const EVIDENCE_FAILURES: ReadonlyArray<{ match: RegExp; means: readonly ProblemMeaning[] }> = [
  { match: /^screenshot\(.+\) failed/, means: [ProblemMeaning.Observation, ProblemMeaning.Load] },
  { match: /could not be attached/, means: [ProblemMeaning.Observation, ProblemMeaning.Load] },
  { match: /no compositor/i, means: [ProblemMeaning.Observation, ProblemMeaning.Load] },
  { match: /display surface/i, means: [ProblemMeaning.Observation, ProblemMeaning.Load] },
  { match: NO_FRAME, means: [ProblemMeaning.Observation] },
  { match: new RegExp(`^${MISSING_CONTRACT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), means: [ProblemMeaning.Race] },
  { match: /__studio is missing/, means: [ProblemMeaning.Load] },
  { match: /could not drive the project/, means: [ProblemMeaning.Load] },
];

/** Does every problem mean `kind`? An empty list means nothing. */
function allMean(problems: readonly unknown[] | null | undefined, kind: ProblemMeaning): boolean {
  const list = (problems ?? []).map((problem) => String(problem));
  return (
    list.length > 0 &&
    list.every((problem) =>
      EVIDENCE_FAILURES.some((failure) => failure.means.includes(kind) && failure.match.test(problem)),
    )
  );
}

/**
 * Why this evidence is not judgeable: nothing, the camera, the clock, or the build.
 *
 *  - `observation`: every problem is a blind camera. Retry, and never execute the challenger.
 *  - `race`: the page had not finished coming up when it was looked at, and nothing measured
 *    when it did. A short retry, because a slow boot is not a defect.
 *  - `build`: everything else, including a missing contract on a page whose boot WAS measured.
 *
 */
export function classifyEvidenceFailure(
  problems: readonly unknown[] | null | undefined,
  { readyAfterMs = null }: { readyAfterMs?: number | null } = {},
): EvidenceFailure {
  if (!(problems ?? []).length) return EvidenceFailure.None;
  if (allMean(problems, ProblemMeaning.Observation)) return EvidenceFailure.Observation;
  if (readyAfterMs === null && allMean(problems, ProblemMeaning.Race)) return EvidenceFailure.Race;
  return EvidenceFailure.Build;
}

/**
 * True when every evidence problem lives in the observation layer and none indict the build
 * itself (crash, load error, missing contract, console errors, all-black frames). Only then may
 * "not judgeable" mean "keep it": a blind camera must never execute a finished build.
 */
export function observationOnlyFailure(problems: readonly unknown[] | null | undefined): boolean {
  return classifyEvidenceFailure(problems) === EvidenceFailure.Observation;
}

/** Did the load race the window — every problem one a second look a few seconds later can settle? */
export function loadRaced(problems: readonly unknown[] | null | undefined): boolean {
  return allMean(problems, ProblemMeaning.Load);
}

/**
 * Evidence with patience for a blind camera. An occluded window (covered, on another Space,
 * display asleep) fails every capture for minutes and then recovers; a broken build does not.
 * Observation-only failures retry on a backoff instead of instantly indicting the challenger —
 * one such outage cost a run all three first-iteration builds, including a finished 77-mesh
 * building destroyed by the rollback that followed.
 *
 * A RACE has its own, much shorter backoff: a page that was still coming up needs seconds, not
 * a minute. `raceDelays: []` turns that off entirely, which is what the classic run passes.
 */
export async function withObservationPatience<
  E extends { ok?: boolean; problems: readonly unknown[]; readyAfterMs?: number | null },
>(
  ctx: { readonly cancelled: boolean; setStatus?: (status: string) => void },
  gatherOnce: () => Promise<E>,
  {
    deadline = Infinity,
    delays = OBSERVATION_RETRY_MS,
    raceDelays = RACE_RETRY_MS,
    onRetry = null,
  }: {
    deadline?: number;
    delays?: readonly number[] | null;
    raceDelays?: readonly number[] | null;
    onRetry?: ((kind: string, evidence: E, delay: number) => void) | null;
  } = {},
): Promise<E> {
  let evidence = await gatherOnce();
  const left: Record<string, number[]> = {
    [EvidenceFailure.Observation]: [...(delays ?? [])],
    [EvidenceFailure.Race]: [...(raceDelays ?? [])],
  };
  for (;;) {
    if (evidence.ok) return evidence;
    const kind = classifyEvidenceFailure(evidence.problems, { readyAfterMs: evidence.readyAfterMs ?? null });
    const delay = left[kind]?.shift();
    if (delay === undefined) return evidence;
    if (ctx.cancelled || Date.now() + delay > deadline) return evidence;
    ctx.setStatus?.(
      `${kind === EvidenceFailure.Race ? "the page was not up yet" : "observation outage"} — retrying evidence in ${Math.round(delay / SECOND_MS)}s (${evidence.problems[0]})`,
    );
    onRetry?.(kind, evidence, delay);
    await sleep(delay);
    evidence = await gatherOnce();
  }
}

/** What replaying a setup did: whether anything ran, whether the state was reached, and why not. */
interface SetupOutcome {
  applied: boolean;
  reached: boolean | null;
  reason: string;
  error: string | null;
}

/**
 * The knock first: a suspended AudioContext cannot resume, a pointer cannot lock and a title
 * screen waiting on a click cannot be walked past without a trusted gesture — and start() before
 * it would resume a project that is still on its first screen.
 */
async function knock(ctx: HarnessCtx, gesture: unknown, h: { handle?: string }): Promise<void> {
  const g: AnyRecord = gesture === true ? {} : (gesture as AnyRecord);
  await ctx
    .call(HostMethod.PreviewGesture, {
      ...(Number.isFinite(g?.x) ? { x: Number(g.x) } : {}),
      ...(Number.isFinite(g?.y) ? { y: Number(g.y) } : {}),
      ...(Array.isArray(g?.keys) && g.keys.length ? { keys: g.keys.map(String).slice(0, MAX_GESTURE_KEYS) } : {}),
      ...h,
    })
    .catch(() => null);
}

/** Run the setup's demo; the sentence to keep when it did not run, or null. */
async function runSetupDemo(ctx: HarnessCtx, demo: unknown, h: { handle?: string }): Promise<string | null> {
  const ran = (await ctx
    .call(HostMethod.PreviewCall, { method: PageMethod.Demo, arg: demo, ...h })
    .catch((err) => ({ ok: false, reason: String(err?.message ?? err) }))) as AnyRecord | null;
  if (isRecord(ran) && ran.ok === false) return `demo "${demo}" did not run: ${ran.reason ?? "unknown"}`;
  return null;
}

/** Whether the verify probe over `__studio.state()` says the requested state was reached, and why not. */
async function verifySetup(
  ctx: HarnessCtx,
  setup: AnyRecord,
  h: { handle?: string },
): Promise<{ reached: boolean | null; reason: string }> {
  const { verify } = setup;
  const state = (await ctx.call(HostMethod.PreviewState, { ...h }).catch(() => null)) as AnyRecord | null;
  const value = lookupState(state, verify.path);
  const usable = state && typeof state === "object" && !state.__missing;
  if (!usable) return { reached: null, reason: "the project's state is unreadable" };
  const note = setup.note ? ` (${setup.note})` : "";
  if ("equals" in verify) {
    const reached = value === verify.equals || String(value) === String(verify.equals);
    const expected = `${verify.path} is ${JSON.stringify(value)} — expected ${JSON.stringify(verify.equals)}${note}`;
    return { reached, reason: reached ? "" : expected };
  }
  const reached = verify.truthy ? Boolean(value) : value !== undefined;
  return { reached, reason: reached ? "" : `${verify.path} is ${JSON.stringify(value)}${note}` };
}

/**
 * Replay the run's setup on a loaded port: the demo or the input actions the scout wrote,
 * then the verify probe over `__studio.state()`. Never throws — a wrong state is a warning
 * the judge and the next builder read, not a voided challenger.
 */
export async function applySetup(
  ctx: HarnessCtx,
  setup: AnyRecord | null | undefined,
  h: { handle?: string } = {},
): Promise<SetupOutcome> {
  const out: SetupOutcome = { applied: false, reached: null, reason: "", error: null };
  if (!setup || typeof setup !== "object") return out;
  try {
    if (setup.gesture) {
      await knock(ctx, setup.gesture, h);
      out.applied = true;
    }
    await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Start, ...h }).catch(() => null);
    if (setup.demo) {
      const failed = await runSetupDemo(ctx, setup.demo, h);
      if (failed) out.error = failed;
      out.applied = true;
    }
    if (Array.isArray(setup.actions) && setup.actions.length) {
      await ctx.call(HostMethod.PreviewInput, { actions: setup.actions.slice(0, MAX_SETUP_ACTIONS), ...h });
      out.applied = true;
    }
    await sleep(Math.min(SETUP_SETTLE_MAX_MS, Number(setup.settleMs) || SETUP_SETTLE_MS));
    if (setup.verify?.path) Object.assign(out, await verifySetup(ctx, setup, h));
  } catch (err: any) {
    out.error = String(err?.message ?? err);
  }
  return out;
}

function lookupState(state: unknown, path: string): unknown {
  let current: any = state;
  for (const key of String(path).split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Console errors as evidence problems: only the errors this build introduced void it. An error
 * the incumbent (or the base) already logged rides along as a warning the builder still reads.
 */
export function consoleProblems(
  consoleErrors: ReadonlyArray<{ message?: unknown }> | null | undefined,
  inheritedConsole: readonly unknown[] | null = [],
): { problems: string[]; warnings: string[] } {
  const inherited = new Set((inheritedConsole ?? []).map((m) => String(m)));
  const fresh = (consoleErrors ?? []).filter((entry) => !inherited.has(String(entry.message)));
  const carried = (consoleErrors ?? []).length - fresh.length;
  return {
    problems: fresh.length ? [`${fresh.length} console error(s)`] : [],
    warnings: carried
      ? [
          `${carried} console error(s) inherited from the build this one started from — not this build's fault, but somebody's: ${(
            consoleErrors ?? []
          )
            .filter((entry) => inherited.has(String(entry.message)))
            .slice(0, INHERITED_ERRORS_QUOTED)
            .map((entry) => clip(String(entry.message), INHERITED_ERROR_CHARS))
            .join(" | ")}`,
        ]
      : [],
  };
}

/**
 * What a step must move, read page-side in one expression.
 *
 * `steppedFrames`, not `frames`: the wall-mode pump advances `frames` on a visible window
 * whether or not the page has a loop of its own, so comparing `frames` would prove nothing.
 */
export const STEP_WITNESS = `(() => {
  /* studio step witness */
  try {
    var clock = window.__studioClock;
    if (!clock || typeof clock.stats !== "function") return null;
    var stats = clock.stats() || {};
    var simulatedMs = null;
    try {
      var state = window.__studio && typeof window.__studio.state === "function" ? window.__studio.state() : null;
      if (state && typeof state.simulatedMs === "number") simulatedMs = state.simulatedMs;
    } catch (err) { simulatedMs = null; }
    return {
      steppedFrames: Number(stats.steppedFrames) || 0,
      drawCalls: Number(stats.drawCalls) || 0,
      now: Number(stats.now) || 0,
      canvas: !!(typeof document !== "undefined" && document.querySelector("canvas")),
      simulatedMs: simulatedMs
    };
  } catch (err) {
    return null;
  }
})()`;

/**
 * Prove the studio drives the project before anything it drives is believed.
 *
 * Two steps, not one: a single delta can be satisfied by a wall-clock frame that happened to
 * land between two reads. Both must move the page's own stepped-frame counter, its draw counter
 * and its clock — otherwise the pass that follows measures a page running itself, and every
 * "before/after" number in it is noise.
 */
export async function proveStep(ctx: HarnessCtx, h: { handle?: string } = {}, ms = 320): Promise<StepProof> {
  const samples = [await readWitness(ctx, h)];
  // The step answers, not only the witness: the shim counts the stepped frames that found no
  // animation callback at all (`idle`), and that is the difference between a project riding the
  // studio's clock and a project the studio merely stepped past.
  let idle = 0;
  let asked = 0;
  for (let i = 0; i < PROOF_STEPS; i++) {
    const answer = (await ctx.call(HostMethod.PreviewCall, {
      method: PageMethod.Step,
      arg: ms,
      ...h,
    })) as AnyRecord | null;
    if (answer && typeof answer === "object") {
      if (typeof answer.idle === "number") idle += answer.idle;
      if (typeof answer.frames === "number") asked += answer.frames;
    }
    samples.push(await readWitness(ctx, h));
  }
  const out: StepProof = {
    ok: false,
    code: "no-clock",
    reason: "",
    frames: 0,
    drawCalls: 0,
    ms: 0,
    canvas: samples.some((sample) => sample?.canvas === true),
    simulatedMs: null,
    idle,
    askedFrames: asked,
    idleLoop: false,
    note: "",
  };
  const read = samples.filter((sample): sample is AnyRecord => sample !== null);
  if (read.length !== samples.length) {
    out.reason = "the page has no studio clock (the shim did not load)";
    return out;
  }
  return weighSteps(out, read);
}

/** One read of the step witness: the page's own counters, or null when the shim is not there. */
async function readWitness(ctx: HarnessCtx, h: { handle?: string }): Promise<AnyRecord | null> {
  try {
    const answer = (await ctx.call(HostMethod.PreviewEvaluate, { expression: STEP_WITNESS, ...h })) as AnyRecord | null;
    if (!isRecord(answer) || typeof answer.steppedFrames !== "number") return null;
    return answer;
  } catch {
    return null;
  }
}

/** What the witness samples prove: frames of the page's own, something drawn, and a clock that moved. */
function weighSteps(out: StepProof, samples: AnyRecord[]): StepProof {
  const first = samples[0];
  const last = samples[samples.length - 1];
  out.frames = last.steppedFrames - first.steppedFrames;
  out.drawCalls = last.drawCalls - first.drawCalls;
  out.ms = last.now - first.now;
  out.simulatedMs = typeof last.simulatedMs === "number" ? last.simulatedMs : null;
  if (!samples.every((sample, index) => index === 0 || sample.steppedFrames > samples[index - 1].steppedFrames)) {
    out.code = "no-frame";
    out.reason =
      "the studio stepped the clock and the page ran no frame of its own — the project does not ride the studio's clock";
    return out;
  }
  if (!(out.drawCalls > 0)) {
    out.code = "no-draw";
    out.reason = "frames ran but nothing was drawn";
    return out;
  }
  if (!(out.ms > 0)) {
    out.code = "flat-clock";
    out.reason = "the studio clock did not advance across two steps — the page's time is not the studio's";
    return out;
  }
  out.ok = true;
  out.code = "ok";
  // Frames moved and something was drawn, but every stepped frame found no animation callback:
  // the project draws from somewhere else (a timer, an input handler, a render on demand). That is
  // a real project and not a failure, so it is a note — but the frame counts below are the studio's
  // and not the project's, and the honest answer says so instead of charging them to its loop.
  if (out.askedFrames > 0 && out.idle >= out.askedFrames) {
    out.idleLoop = true;
    out.note =
      "the studio stepped the clock and the project ran no animation frame of its own — it draws from somewhere else, so the frame counts are the studio's rather than the project's loop";
  }
  return out;
}

/**
 * The empty-scene exemption, as one expression a test can run under `node:vm`.
 *
 * A page of DOM is empty when `inspect().dom` says it shows no text and no visual element. A page
 * that draws a world censuses every scene the hook says was rendered (a menu → level machine
 * renders two, and the content may be in either), duck-types the scene and the camera rather than
 * trusting a three.js flag, and accepts a WebGPU backend everywhere `isWebGLRenderer` was once the
 * gate.
 */
export const EMPTY_SCENE_PROBE = `(() => {
  try {
    var s = window.__studio;
    var i = s && typeof s.inspect === "function" ? s.inspect() : null;
    if (!i || typeof i !== "object") return false;
    if (!i.scene && i.dom && typeof i.dom.empty === "function") return i.dom.empty() === true;
    var r = i.renderer;
    var backend = !!r && (r.isWebGLRenderer === true || (!!r.backend && (r.backend.isWebGPUBackend === true || r.backend.isWebGLBackend === true)));
    var c = i.camera;
    var camera = !!c && (c.isCamera === true || (!!c.projectionMatrix && !!c.matrixWorld));
    if (!backend || !camera) return false;
    var scenes = Array.isArray(i.scenes) && i.scenes.length ? i.scenes : (i.scene ? [i.scene] : []);
    if (!scenes.length) return false;
    var count = 0;
    for (var n = 0; n < scenes.length; n++) {
      var scene = scenes[n];
      if (!scene || (scene.isScene !== true && !Array.isArray(scene.children))) return false;
      var stack = (scene.children || []).slice();
      var guard = 0;
      while (stack.length && guard++ < 2048) {
        var o = stack.pop();
        if (!o) continue;
        if (o.isMesh || o.isLine || o.isPoints || o.isSprite) count++;
        if (Array.isArray(o.children)) for (var k = 0; k < o.children.length; k++) stack.push(o.children[k]);
      }
    }
    var state = s.state();
    var hud = state && state.hud;
    return count === 0 && !(hud && hud.items && hud.items.length) && !(hud && hud.crosshair) && !(hud && hud.flash);
  } catch (err) {
    return false;
  }
})()`;

/**
 * The camera pose, read only for the empty-scene stage where pixels cannot prove placement. A page
 * that draws no 3D world has no camera to place, and says so with an empty string.
 */
const CAMERA_POSE_PROBE = `(() => {
  const c = window.__studio.inspect().camera;
  if (!c) return "";
  c.updateMatrixWorld(true);
  const values = [...c.matrixWorld.elements, ...c.projectionMatrix.elements];
  return values.every(Number.isFinite) ? JSON.stringify(values) : null;
})()`;

/**
 * Whether a page that draws no 3D world shows nothing at all: no text and no visible element. A
 * build that ships that has no first screen, whatever its pixels say, so it is a problem anywhere
 * but on the shared base. A page with a scene, or one that predates `dom`, answers false.
 */
const BLANK_PAGE_PROBE = `(() => {
  try {
    var i = window.__studio.inspect();
    if (!i || i.scene || !i.dom || typeof i.dom.empty !== "function") return false;
    return i.dom.empty() === true;
  } catch (err) {
    return false;
  }
})()`;

/** The sentence a blank page earns. */
const BLANK_PAGE_PROBLEM = "the page shows nothing — no text and no visible element, so the build has no first screen";

/**
 * Which surface a frame was actually PHOTOGRAPHED on, as the port reports it — not the one the
 * capture asked for. A canvas read that declines (no canvas, nothing drew, a painted page
 * background) is answered by the compositor, and a page capture the compositor refuses is
 * answered off the canvas; a shot that says neither is read as the surface we asked for.
 */
function photographed(shot: { surface?: unknown } | null | undefined, asked = "canvas"): string {
  return shot?.surface === "page" || shot?.surface === "canvas" ? shot.surface : asked;
}

/**
 * Deterministic playthrough + screenshots at every named camera + structural probes.
 *
 * Exported for the Autopilot facet loop, which probes a worktree (`root`) through a pooled
 * observation port (`handle`) and files its shots under its own label (`labelPrefix`). With
 * none of those set, this is byte-for-byte the gauntlet's own evidence pass on the live view.
 */
export async function gatherEvidence(
  ctx: HarnessCtx,
  {
    run,
    iterationId,
    seed,
    handle,
    root,
    labelPrefix,
    cameras = null,
    entry,
    eyes = true,
    motion = 0,
    audio = true,
    maxDemos = 3,
    requiredDemos = [],
    userView = true,
    scaffold = false,
    setup = undefined,
    inheritedConsole = [],
  }: GatherOptions,
): Promise<Evidence> {
  // The pass's own state, phase to phase: its arguments, then what each phase found for the
  // phases after it.
  const look: Look = {
    ctx,
    run,
    iterationId,
    seed,
    handle,
    root,
    labelPrefix,
    cameras,
    entry,
    eyes,
    motion,
    audio,
    maxDemos,
    requiredDemos,
    userView,
    scaffold,
    setup,
    inheritedConsole,
  };
  for (const phase of LOOK_OPENING) {
    const done = await phase(look);
    if (done) return done.value;
  }
  // Everything from here to the last read touches the page. The finally hands the project back
  // running, so a crashed harness never leaves a dead page on the user's stage.
  try {
    for (const phase of LOOK_PHASES) {
      const done = await phase(look);
      if (done) return done.value;
    }
  } finally {
    // However this pass ends, the project is handed back running. A night that crashed here used
    // to leave the user's own stage frozen on a paused frame until they reloaded it.
    await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Start, ...look.h }).catch(() => {});
  }
  // Unreachable: the last phase (reportLook) always answers.
  return undefined as never;
}

/**
 * The evidence pass before it touches the page's clock: load, readiness, status, the requested
 * state and the eye cameras. A phase answers `{ value }` to end the pass with that result, or
 * nothing to hand on.
 */
const LOOK_OPENING: Array<(look: Look) => Promise<LookEnd>> = [loadPage, reachRequestedState];

/**
 * The evidence pass on the page itself, in order, inside the `finally` that hands the project back
 * running.
 */
const LOOK_PHASES: Array<(look: Look) => Promise<LookEnd>> = [
  proveAndDrive,
  inspectEmptyScene,
  readSurfaces,
  photographCameras,
  photographUserView,
  runDemos,
  weighFrames,
  readConsole,
  reportLook,
];

/** The sentence a page that measured itself not ready owes the judge, worded by case. */
function notReadyProblem(ready: AnyRecord): string {
  const reason = ready.reason ? `: ${ready.reason}` : "";
  if (ready.timedOut)
    return `the page never reported itself ready within ${((ready.budgetMs ?? 0) / SECOND_MS).toFixed(1)} s${reason}`;
  if (ready.phase === "failed") return `the page reported itself failed: ${ready.reason ?? "no reason given"}`;
  return `the page is not ready (${ready.phase ?? "unknown"})${reason}`;
}

/**
 * (2) ready: the page says when it is up, and the studio believes it rather than sleeping. A
 * not-ready-but-not-timed-out page used to skip the drive block (where the missing-contract
 * sentence lives), take one frame and come back ok: true. Every `ready === false` the page
 * actually measured is a problem, worded by case.
 */
async function readReadiness(look: Look): Promise<void> {
  const { ctx, h, problems, warnings } = look;
  look.ready = null;
  look.readyAfterMs = null;
  look.bootedFor = true;
  try {
    const answer = await ctx.call(HostMethod.PreviewReady, { ...h });
    if (isRecord(answer) && typeof answer.ready === "boolean") look.ready = answer;
  } catch {
    /* an older studio has no preview.ready; readiness is simply unmeasured */
  }
  const { ready } = look;
  if (!ready) return;
  if (ready.via === "shim" && Number.isFinite(ready.pageMs)) look.readyAfterMs = ready.pageMs;
  // `via: "none"` is a page the studio cannot reach at all — unmeasured, not failed.
  if (ready.ready === false && ready.via !== "none") {
    look.bootedFor = false;
    problems.push(notReadyProblem(ready));
  }
  if (look.readyAfterMs !== null && look.readyAfterMs > SLOW_BOOT_MS) {
    warnings.push(
      `the page took ${(look.readyAfterMs / SECOND_MS).toFixed(1)} s to report itself ready — every pass of the run pays that boot`,
    );
  }
}

/** (1) load, (2) ready and (3) status: read on a settled page, not on one still loading. */
async function loadPage(look: Look): Promise<LookEnd> {
  const { ctx, entry, handle, iterationId, labelPrefix, root, run, scaffold, setup } = look;
  // The state to look at: a worker's own (director, 2026-09-07 — one map per worker on a big project), else the run's.
  look.requestedSetup = setup === undefined ? run.setup : setup;
  const h = handle ? { handle } : {};
  look.h = h;
  look.prefix = labelPrefix ?? `iter_${iterationId}`;
  const problems: string[] = [];
  look.problems = problems;
  // Defects worth telling the judge and the next builder about, but not worth voiding an
  // otherwise judgeable challenger over.
  look.warnings = [];
  // The base pass of a shared scaffold is the one place a dead clock or a dead contract must
  // stop the night; a later iteration warns, so one regression never voids a whole run.
  look.baseStage = scaffold === true && iterationId === "base";

  // ── (1) load ──
  if (root || entry)
    await ctx.call(HostMethod.PreviewLoad, {
      project: run.project,
      ...(root ? { root } : {}),
      ...(entry ? { entry } : {}),
      ...h,
    });
  else await ctx.call(HostMethod.PreviewReload, { ...h });

  // ── (2) ready ──
  await readReadiness(look);

  // ── (3) status: read on a settled page, not on one still loading ──
  const status = await ctx.call(HostMethod.PreviewStatus, { ...h });
  look.status = status;
  if (status.loadError) problems.push(status.loadError);
  if (status.crashed) problems.push("the renderer crashed");
}

/** (4) setup, the player-eye cameras the project has, and the readings the page phases fill. */
async function reachRequestedState(look: Look): Promise<LookEnd> {
  const { ctx, eyes, h, prefix, requestedSetup, run, status, warnings } = look;
  // ── (4) setup: the requested state (computer use, 2026-09-07) — the scout's setup script,
  // replayed before anyone looks: the gesture, then start, then the map picker opened, the map
  // chosen, and a probe that says it landed. A build judged on the boot screen while the brief
  // was about another map cost a whole run. Replayed AFTER the readiness poll, because the scout
  // recorded it on a booted page: at 0 ms the same click lands on empty space.
  look.requestedState = null;
  const pageCameUp = look.bootedFor && !status.loadError && !status.crashed;
  if (requestedSetup && pageCameUp) {
    look.requestedState = await applySetup(ctx, requestedSetup, { ...h });
    if (look.requestedState.reached === false)
      warnings.push(`requested state not reached: ${look.requestedState.reason}`);
    if (look.requestedState.error) warnings.push(`setup script failed: ${look.requestedState.error}`);
  }

  // Harness-owned player-eye cameras (v2 contract): present when the project passed `camera` and
  // `player()` into installStudio. A board project has no eye worth photographing, so it is not
  // asked; a project that declares no kind is looked at exactly as before.
  look.eyeNames = [];
  const looksThroughEyes = eyes && look.bootedFor && wantsEyeCameras(run?.app);
  if (looksThroughEyes) {
    try {
      const declared = await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Eyes, ...h });
      if (Array.isArray(declared)) look.eyeNames = declared.map(String).filter((name) => name.startsWith("eye:"));
    } catch {
      look.eyeNames = [];
    }
  }
  const motionFrames: AnyRecord[] = [];
  look.motionFrames = motionFrames;
  const motionCamera = look.eyeNames.includes("eye:here") ? "eye:here" : null;
  look.motionCamera = motionCamera;
  const takeMotionFrame = async (index: number): Promise<void> => {
    if (motionCamera)
      await ctx.call(HostMethod.PreviewCall, { method: PageMethod.DebugCamera, arg: motionCamera, ...h });
    const shot = await ctx.call(HostMethod.PreviewScreenshot, {
      runId: run.runId,
      label: `${prefix}/motion/m${String(index).padStart(2, "0")}`,
      surface: "canvas",
      ...h,
    });
    motionFrames.push({
      index,
      camera: motionCamera ?? "current",
      path: shot.path,
      bytes: shot.bytes,
      base64: shot.base64,
      stats: shot.stats ?? null,
      surface: photographed(shot),
    });
  };
  look.takeMotionFrame = takeMotionFrame;

  look.state = null;
  look.stateEarly = null;
  look.audioProbe = null;
  look.clockProof = {
    ok: null,
    frames: 0,
    drawCalls: 0,
    ms: 0,
    reason: "readiness never got far enough to step the clock",
  };
  // The base stage's no-draw sentence, held until inspection says whether the scene is empty.
  look.noDrawPending = null;
}

/**
 * Where a failed clock proof goes. A page with no canvas at all is the DOM-first-screen shape the
 * readiness ladder exists for: frames without draws there is a warning, never a verdict. The shim
 * not loading is not a fact about the project: nothing measured below can be believed on any stage,
 * so it is a problem on a challenger exactly as on the base.
 *
 * An empty shared base draws nothing because there is nothing in it. That is the one stage where
 * blankness is allowed, and the exemption is settled by inspection a few steps below
 * (emptyScene) — so the no-draw verdict waits for it rather than failing the scaffold every night.
 */
function weighClockFailure(look: Look, proof: StepProof): void {
  const { baseStage, problems, warnings } = look;
  const soft = proof.code === "no-draw" && proof.canvas === false;
  const drawsLater = baseStage && proof.code === "no-draw" && !soft;
  if (proof.code === "no-clock") problems.push(proof.reason);
  else if (drawsLater) look.noDrawPending = proof.reason;
  else if (baseStage && !soft) problems.push(proof.reason);
  else warnings.push(proof.reason);
}

/** (5) prove: seed and pause first, then prove the studio owns the clock. */
async function proveClock(look: Look): Promise<void> {
  const { ctx, h, seed, warnings } = look;
  await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Seed, arg: seed, ...h });
  await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Pause, ...h });
  const proof = await proveStep(ctx, h, PROOF_STEP_MS);
  look.clockProof = {
    ok: proof.ok,
    frames: proof.frames,
    drawCalls: proof.drawCalls,
    ms: proof.ms,
    reason: proof.reason,
    idle: proof.idle,
    idleLoop: proof.idleLoop,
  };
  if (proof.ok && proof.idleLoop) warnings.push(proof.note);
  if (!proof.ok) weighClockFailure(look, proof);
}

/**
 * (6) drive. Two samples, ~30 simulated seconds apart: the first run judged on 5 uneventful
 * seconds, where every build's numbers look identical. The judge needs to see what MOVED. The
 * early sample is taken BEFORE the scripted controls, so `delta('player.yaw')` and
 * `delta('player.x')` measure what the controls did — the first v2 run took it after them and
 * every probe delta measured drift. The two proving steps sit before it, so the early sample is
 * the same distance into the simulation for every build.
 */
async function driveProject(look: Look): Promise<void> {
  const { ctx, h, motion, motionFrames, run, takeMotionFrame } = look;
  await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Step, arg: DRIVE_STEP_MS, ...h });
  look.stateEarly = await ctx.call(HostMethod.PreviewState, { ...h });
  // Drive the project's OWN controls every iteration so feel/play are judged on play, not idle
  // time — and so a board project is clicked rather than walked.
  await applyPlayScript(ctx, playScriptFor(run?.app), { clock: "step", runId: run.runId, ...h });
  // The motion strip: a few frames spread over the scripted walk, from the player's eye —
  // feel is judged from motion, not from two JSON snapshots.
  const motionAt = new Set<number>();
  if (motion > 0)
    for (let k = 0; k < motion; k++) motionAt.add(Math.round((k * LAST_DRIVE_STEP) / Math.max(1, motion - 1)));
  for (let i = 0; i < DRIVE_STEPS; i++) {
    if (motionAt.has(i)) {
      try {
        await takeMotionFrame(motionFrames.length + 1);
      } catch {
        /* a lost motion frame is a thinner strip, never a voided challenger */
      }
    }
    await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Step, arg: DRIVE_STEP_MS, ...h });
  }
}

/** The state the drive left, what it says is wrong with the page, and what the project sounds like. */
async function readDrivenState(look: Look): Promise<void> {
  const { audio, ctx, h, problems } = look;
  look.state = await ctx.call(HostMethod.PreviewState, { ...h });
  if (look.state?.__missing) problems.push(MISSING_CONTRACT);
  if (look.state?.error) problems.push(`runtime error: ${look.state.error.message}`);
  if (!audio || look.state?.__missing) return;
  try {
    const probe = (await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Audio, ...h })) as AnyRecord | null;
    if (isRecord(probe) && !probe.__missing) look.audioProbe = probe;
  } catch {
    look.audioProbe = null;
  }
}

/** (5) prove the studio owns the clock, then (6) drive the project's own controls. */
async function proveAndDrive(look: Look): Promise<LookEnd> {
  if (!look.bootedFor) return;
  try {
    await proveClock(look);
    await driveProject(look);
    await readDrivenState(look);
  } catch (err: any) {
    look.problems.push(`could not drive the project: ${err?.message ?? err}`);
  }
}

/** A generated build whose page shows nothing has no first screen: canvas draw counts cannot say so. */
async function flagBlankPage(look: Look): Promise<LookEnd> {
  const { ctx, h, problems } = look;
  try {
    if ((await ctx.call(HostMethod.PreviewEvaluate, { expression: BLANK_PAGE_PROBE, ...h })) === true)
      problems.push(BLANK_PAGE_PROBLEM);
  } catch {
    /* a page that cannot be read is judged by the checks that can read it */
  }
}

/** Whether an empty shared base is empty by inspection, and the base's held no-draw sentence. */
async function inspectEmptyScene(look: Look): Promise<LookEnd> {
  const { baseStage, ctx, h, problems, warnings } = look;
  // An empty shared base is infrastructure, not a finished project. Only this harness-owned
  // stage may accept empty pixels, and only when inspection proves no content exists.
  // A project's self-reported phase/drawCalls cannot turn off challenger health checks.
  look.emptyScene = false;
  if (baseStage) {
    try {
      look.emptyScene = (await ctx.call(HostMethod.PreviewEvaluate, { expression: EMPTY_SCENE_PROBE, ...h })) === true;
    } catch {
      /* missing inspection never exempts a broken build */
    }
  }
  if (!baseStage) await flagBlankPage(look);
  // A base that drew nothing: a scaffold with nothing in it is infrastructure and passes with a
  // warning; a base that has content and still drew nothing is broken and says so.
  if (look.noDrawPending) {
    if (look.emptyScene) warnings.push(look.noDrawPending);
    else problems.push(look.noDrawPending);
    look.noDrawPending = null;
  }
}

/** (7) surfaces: asked once, after the setup and before the cameras. */
async function readSurfaces(look: Look): Promise<LookEnd> {
  const { ctx, h } = look;
  // ── (7) surfaces: asked once, after the setup and before the cameras ──
  // The CAMERA frames stay canvas-sourced whatever this says: their stats feed the pixel
  // checks, the blank-build guard and style distance, and grading a DOM menu as if it were
  // the project defeats an identity-weight check class for exactly the projects this serves.
  look.pageUi = null;
  if (look.bootedFor) {
    try {
      const probe = (await ctx.call(HostMethod.PreviewPageUi, { ...h })) as AnyRecord | null;
      if (isRecord(probe) && Array.isArray(probe.entries)) look.pageUi = probe;
    } catch {
      /* an older studio cannot see outside the canvas; nothing downstream depends on it */
    }
  }
  const uiEntries = (look.pageUi?.entries ?? []).map(String);
  look.uiEntries = uiEntries;
  const uiCoverage = Number.isFinite(look.pageUi?.coverage) ? Number(look.pageUi.coverage) : null;
  look.uiCoverage = uiCoverage;
  const uiPrimary = look.pageUi ? look.pageUi.uiPrimary === true || (uiCoverage !== null && uiCoverage >= 0.25) : false;
  look.uiPrimary = uiPrimary;
}

/** A shot the camera could not give: it is not registered, and the sentence says what is. */
type MissingShot = Shot & { missing?: boolean; reason?: string };

/**
 * Only a viewpoint the PROJECT declares is censused for placement: the floor's own guesses
 * answering from one frozen pose is the harness asking twice, not a base that never placed its
 * cameras.
 */
async function recordCameraPose(look: Look, camera: string): Promise<void> {
  const { cameraPoses, ctx, h, problems } = look;
  try {
    const pose = await ctx.call(HostMethod.PreviewEvaluate, { expression: CAMERA_POSE_PROBE, ...h });
    if (pose === "") return;
    if (typeof pose === "string") cameraPoses.set(camera, pose);
    else problems.push(`camera(${camera}) has no valid transform`);
  } catch {
    problems.push(`camera(${camera}) cannot be inspected`);
  }
}

/** Point the page at `camera` and photograph it — or answer that it is not registered. */
async function takeShot(
  look: Look,
  camera: string,
  label: string,
  { anyway = false, floor = false }: { anyway?: boolean; floor?: boolean } = {},
): Promise<MissingShot> {
  const { askedFor, ctx, h, prefix, run } = look;
  const placed = (await ctx.call(HostMethod.PreviewCall, {
    method: PageMethod.DebugCamera,
    arg: camera,
    ...h,
  })) as AnyRecord | null;
  const unregistered = isRecord(placed) && placed.ok === false;
  if (unregistered && !anyway) {
    const available = (placed.available ?? []).join(", ") || "none";
    return {
      camera,
      missing: true,
      reason: placed.reason ?? `camera "${camera}" is not registered (available: ${available})`,
    };
  }
  askedFor.push(camera);
  if (look.emptyScene && !floor) await recordCameraPose(look, camera);
  const shot = await ctx.call(HostMethod.PreviewScreenshot, {
    runId: run.runId,
    label: `${prefix}/screenshots/${label}`,
    surface: "canvas",
    ...h,
  });
  // The surface the port says it PHOTOGRAPHED, not the one we asked for: a canvas read that
  // declined is answered by the compositor, and the dead-debugCamera guard below is written
  // to forgive exactly that. Hardcoding "canvas" here made that guard unreachable.
  return {
    camera,
    path: shot.path,
    bytes: shot.bytes,
    base64: shot.base64,
    stats: shot.stats ?? null,
    surface: photographed(shot),
    registered: !unregistered,
  };
}

/** Add `name` to the cameras to photograph, once. */
function addCamera(names: string[], name: string): void {
  if (!names.includes(name)) names.push(name);
}

/**
 * Without a spec: "default" plus whatever the project declares, capped so the judge is not flooded
 * — with a FLOOR, because the template registers ONE camera and the classic trio has always
 * been the harness's, not the project's: a project declaring fewer than two viewpoints is still asked
 * for close and wide, and an unregistered one of those is skipped silently.
 */
async function declaredCameraNames(look: Look, cameraNames: string[], floorCameras: Set<string>): Promise<void> {
  const { ctx, h } = look;
  cameraNames.push(DEFAULT_CAMERA);
  try {
    const answer = await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Cameras, ...h });
    if (Array.isArray(answer)) look.declaredCameras = answer.map(String);
  } catch {
    /* a project predating cameras() declares none */
  }
  const declared: string[] = look.declaredCameras ?? [];
  for (const name of declared)
    if (!cameraNames.includes(name) && cameraNames.length < MAX_CAMERAS) cameraNames.push(name);
  // "default" above is the HARNESS asking for the view the page renders. A project that names
  // its own cameras and none of them "default" declares one viewpoint fewer than the count
  // suggests, and its two identical frames are one view photographed twice — not a dead
  // debugCamera. Floor it, the way close and wide are floored.
  if (declared.length > 0 && !declared.includes(DEFAULT_CAMERA)) floorCameras.add(DEFAULT_CAMERA);
  if (declared.length >= 2) return;
  for (const name of FLOOR_CAMERAS) {
    if (!cameraNames.includes(name) && cameraNames.length < MAX_CAMERAS) {
      cameraNames.push(name);
      floorCameras.add(name);
    }
  }
}

/**
 * Which cameras to photograph. With a spec, exactly the cameras the facet names (default first)
 * plus the eye cameras; without one, the project's own with a floor (`declaredCameraNames`). A page
 * that never booted gets one frame: 30 step round trips against it is the endless hold, and a
 * human still sees whatever the page drew.
 */
async function chooseCameras(look: Look): Promise<void> {
  const { cameras } = look;
  const cameraNames: string[] = [];
  look.cameraNames = cameraNames;
  // ONE binding, populated on BOTH branches: the "registered: …" half of every sentence below
  // was a ReferenceError against a block-scoped shadow before this milestone.
  look.declaredCameras = null;
  const floorCameras = new Set<string>();
  look.floorCameras = floorCameras;
  const wantEyes = look.eyeNames.filter((name: string) => EYE_CAMERAS.includes(name));
  look.wantEyes = wantEyes;
  if (!look.bootedFor) cameraNames.push(DEFAULT_CAMERA);
  else if (Array.isArray(cameras) && cameras.length > 0) {
    for (const name of [DEFAULT_CAMERA, ...cameras.map(String)]) addCamera(cameraNames, name);
    for (const name of wantEyes) addCamera(cameraNames, name);
  } else {
    await declaredCameraNames(look, cameraNames, floorCameras);
    for (const name of wantEyes) addCamera(cameraNames, name);
  }
  // The viewpoints the PROJECT claims to have: the floor's guesses are not among them, so an
  // identical frame from a camera nobody declared is not evidence of dead wiring.
  look.declaredViewpoints = cameraNames.filter((name) => !name.startsWith("eye:") && !floorCameras.has(name));
}

/**
 * One camera's frame, kept on `shots`. A capture that raced the compositor returns the previous
 * camera's pixels: one retake settles the race; only a shot identical after the retake counts as
 * a dead debugCamera. A "default" the project never registered is noted on the look.
 */
async function shootCamera(look: Look, camera: string): Promise<void> {
  const { floorCameras, missingCameras, shots } = look;
  const label = camera.replace(/[^a-z0-9-_]+/gi, "-");
  // A project that registers no "default" is still photographed on the view it renders — the
  // whole point of this milestone — instead of three frames of one frozen viewpoint.
  const options = { anyway: camera === DEFAULT_CAMERA, floor: floorCameras.has(camera) };
  let shot = await takeShot(look, camera, label, options);
  if (shot.missing) {
    // A spec camera the build never registered is a defect for the builder, not a stale
    // duplicate for the judge: skip the frame and say so. A floor camera nobody asked for is
    // skipped silently, and eye cameras only exist on v2.
    if (!camera.startsWith("eye:") && !floorCameras.has(camera)) missingCameras.push(camera);
    return;
  }
  if (camera === DEFAULT_CAMERA && shot.registered === false) look.registeredDefault = false;
  if (shot.base64 && shots.some((other: Shot) => other.base64 === shot.base64)) {
    shot = await takeShot(look, camera, label, options);
    if (shot.missing) return;
  }
  shots.push(shot);
}

/** What the camera census owes the builder: a missing "default", and cameras named but never registered. */
function cameraWarnings(look: Look): void {
  const { cameras, missingCameras, problems, scaffold, warnings } = look;
  if (!look.registeredDefault) {
    warnings.push(
      `this project registers no "default" camera (registered: ${(look.declaredCameras ?? []).join(", ") || "none"}) — every frame is the view the project itself renders`,
    );
  }
  if (!missingCameras.length) return;
  const namesCameras = Array.isArray(cameras) && cameras.length > 0;
  if (scaffold && namesCameras) problems.push(`shared base is missing required cameras: ${missingCameras.join(", ")}`);
  warnings.push(
    `cameras named by the facet but not registered in config.cameras: ${missingCameras.join(", ")} — register them in main.js`,
  );
}

/** The cameras: the facet's own or the project's, with a floor, and what is missing. */
async function photographCameras(look: Look): Promise<LookEnd> {
  const { problems } = look;
  look.cameraPoses = new Map<string, string>();
  look.shots = [] as Shot[];
  look.askedFor = [] as string[];
  await chooseCameras(look);
  look.missingCameras = [] as string[];
  look.registeredDefault = true;
  for (const camera of look.cameraNames) {
    try {
      await shootCamera(look, camera);
    } catch (err: any) {
      problems.push(`screenshot(${camera}) failed: ${err?.message ?? err}`);
    }
  }
  cameraWarnings(look);
}

/** The fraction of pixels the page frame and the default camera's canvas frame differ by, or null when nobody could tell. */
async function userViewDiff(look: Look, shot: AnyRecord): Promise<number | null> {
  const { ctx, h, prefix, run, shots } = look;
  const canvasShot = shots.find((s: Shot) => s.camera === DEFAULT_CAMERA);
  if (!canvasShot?.path || !shot.path) return null;
  const diff = await ctx
    .call(HostMethod.PreviewDiff, {
      runId: run.runId,
      a: shot.path,
      b: canvasShot.path,
      label: `${prefix}/diff_user-view`,
      ...h,
    })
    .catch(() => null);
  const measured = isRecord(diff) && diff.compared > 0 && Number.isFinite(diff.diffFraction);
  return measured ? diff.diffFraction : null;
}

/** What the user's-eye frame tells the judge: UI outside the canvas, or a page that differs from it. */
function userViewWarning(uiEntries: string[], diffFraction: number | null): string | null {
  if (uiEntries.length > 0)
    return `this project paints UI outside the canvas (${uiEntries.slice(0, MAX_UI_ENTRIES).join(", ")}) — user:view shows it, the canvas frames do not`;
  if (diffFraction !== null && diffFraction > USER_VIEW_MISMATCH)
    return `the page the user sees differs from the canvas capture on the default camera (${(diffFraction * 100).toFixed(1)}% of pixels) — the page shows UI the canvas does not (DOM HUD, overlays); compare user:view with default`;
  return null;
}

/** The compositor's picture of the page on the default camera, kept when it shows something the canvas does not. */
async function photographPage(look: Look, pageLabel: string): Promise<void> {
  const { ctx, h, run, uiEntries, warnings } = look;
  await ctx.call(HostMethod.PreviewCall, { method: PageMethod.DebugCamera, arg: DEFAULT_CAMERA, ...h });
  const shot = await ctx.call(HostMethod.PreviewScreenshot, {
    runId: run.runId,
    label: pageLabel,
    page: true,
    surface: "page",
    ...h,
  });
  if (!shot?.base64) return;
  const candidate = {
    camera: "user:view",
    path: shot.path,
    bytes: shot.bytes,
    base64: shot.base64,
    stats: shot.stats ?? null,
    surface: photographed(shot, "page"),
  };
  const diffFraction = await userViewDiff(look, shot);
  // Kept when the probe found UI, when the pictures differ, or when nobody could tell;
  // dropped only when the probe found nothing AND a computed diff is under the threshold.
  const differs = diffFraction === null || diffFraction > USER_VIEW_MISMATCH;
  if (uiEntries.length > 0 || differs) look.userViewShot = candidate;
  const warning = userViewWarning(uiEntries, diffFraction);
  if (warning) warnings.push(warning);
}

/**
 * A compositor that cannot give the page frame still owes the judge a picture: retake it off the
 * canvas rather than leaving the label with no pixels behind it.
 */
async function photographPageOffCanvas(look: Look, pageLabel: string): Promise<void> {
  const { ctx, h, run } = look;
  try {
    const fallback = await ctx.call(HostMethod.PreviewScreenshot, {
      runId: run.runId,
      label: pageLabel,
      surface: "canvas",
      ...h,
    });
    if (fallback?.base64)
      look.userViewShot = {
        camera: "user:view",
        path: fallback.path,
        bytes: fallback.bytes,
        base64: fallback.base64,
        stats: fallback.stats ?? null,
        surface: photographed(fallback),
      };
  } catch {
    /* no frame at all: a warning already says why, and no problem is owed */
  }
}

/**
 * The user's-eye frame: the compositor's picture with every DOM element on it, on the default
 * camera. The canvas capture is the judge's picture for good reasons (it works occluded); this
 * one exists so a HUD painted into the DOM — invisible to every canvas shot — can be seen once,
 * and so a project whose UI IS the page is not judged blind.
 */
async function photographUserView(look: Look): Promise<LookEnd> {
  const { prefix, userView, warnings } = look;
  look.userViewShot = null;
  if (!userView || !look.bootedFor) return;
  const pageLabel = `${prefix}/screenshots/user-view`;
  try {
    await photographPage(look, pageLabel);
  } catch (err: any) {
    warnings.push(`user:view capture unavailable: ${err?.message ?? err}`);
    await photographPageOffCanvas(look, pageLabel);
  }
}

/**
 * Which demos run, in order, and which the cap leaves out. Every demo a check names runs, always;
 * the cap applies only to the unreferenced remainder. A cap that silently dropped check-named
 * demos made the harness report "ADS never engages" for a feature it never looked at.
 */
function demosToRun(
  registered: string[],
  requiredDemos: readonly unknown[] | null | undefined,
  maxDemos: number,
): { toRun: string[]; skipped: string[] } {
  const required = new Set((requiredDemos ?? []).map(String));
  const ordered: string[] = [
    ...registered.filter((n: string) => required.has(n)),
    ...registered.filter((n: string) => !required.has(n)),
  ];
  const budget = Number.isFinite(maxDemos) ? Math.max(1, maxDemos) : Infinity;
  const toRun: string[] = [];
  const skipped: string[] = [];
  let extra = 0;
  for (const name of ordered) {
    if (required.has(name)) toRun.push(name);
    else if (extra < budget) {
      toRun.push(name);
      extra++;
    } else skipped.push(name);
  }
  return { toRun, skipped };
}

/**
 * The state as a demo left it. The `state` sample above was taken before any demo ran, so a
 * number a demo drives (a crash test's kept speed) reads zero there; a probe scoped to this demo
 * is answered from this snapshot instead.
 */
async function demoEndState(look: Look, name: string): Promise<void> {
  const { ctx, demoStates, h } = look;
  try {
    const after = (await ctx.call(HostMethod.PreviewState, { ...h })) as AnyRecord | null;
    if (isRecord(after) && !after.__missing) demoStates[name] = after;
  } catch {
    /* a lost snapshot leaves the probe unmeasured, never failed */
  }
}

/** One demo: run it, and when it ran, keep the state it left and photograph its end frame as it stands. */
async function runDemo(look: Look, name: string): Promise<void> {
  const { ctx, demoShots, demos, h, prefix, run } = look;
  try {
    demos[name] = (await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Demo, arg: name, ...h })) as AnyRecord;
    if (demos[name]?.ok !== true) return;
    await demoEndState(look, name);
    const label = `demo_${name.replace(/[^a-z0-9-_]+/gi, "-")}`;
    const shot = await ctx.call(HostMethod.PreviewScreenshot, {
      runId: run.runId,
      label: `${prefix}/screenshots/${label}`,
      surface: "canvas",
      ...h,
    });
    demoShots.push({
      camera: `demo:${name}`,
      path: shot.path,
      bytes: shot.bytes,
      base64: shot.base64,
      stats: shot.stats ?? null,
      surface: photographed(shot),
    });
  } catch (err: any) {
    demos[name] = { ok: false, error: String(err?.message ?? err) };
  }
}

/**
 * The project's scripted demos, each photographed at its own end state. Behavioural facets are
 * invisible to the generic playthrough (a sit-on-a-bench beat that the scripted WASD walk never
 * reaches judged "pixel-identical" for six iterations), so any scripted demos the project declares
 * run now — after the main shots, because a demo moves the project to its own end state. Each
 * demo's result is data for the judge and its end frame is photographed as it stands (no camera
 * switch: the demo composes its own view).
 */
async function runDemos(look: Look): Promise<LookEnd> {
  const { ctx, h, maxDemos, requiredDemos } = look;
  look.demos = {} as Record<string, AnyRecord>;
  look.demoStates = {} as Record<string, AnyRecord>;
  look.demoShots = [] as Shot[];
  look.registeredDemos = null;
  const skippedDemos: string[] = [];
  look.skippedDemos = skippedDemos;
  if (!look.bootedFor) return;
  try {
    const names = await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Demos, ...h });
    if (!Array.isArray(names)) return;
    look.registeredDemos = names.map(String);
    const { toRun, skipped } = demosToRun(look.registeredDemos, requiredDemos, maxDemos);
    skippedDemos.push(...skipped);
    for (const name of toRun) await runDemo(look, name);
  } catch {
    /* a project predating the demo contract simply has none */
  }
}

/**
 * Whose count is this? The facade delegates `capture()` to the project, so a frame the page
 * labelled `project` — and the draw count beside it — is the build's claim about itself, not the
 * studio's read of the canvas. A verdict is only made on the studio's own reads.
 */
const claimedByProject = (shot: Shot): boolean => shot.stats?.provenance === "project";

/**
 * A frame that drew nothing is not evidence of blankness — it is evidence of no frame. It leaves
 * the blankness census and says so; but if EVERY frame drew nothing, dropping them all would
 * silently delete the verdict, so that is the verdict. Answers the frames the census counts.
 */
function weighDraws(look: Look): Shot[] {
  const { problems, shots, warnings } = look;
  const counted = shots.filter((shot: Shot) => shot.stats);
  look.counted = counted;
  const zeroDraw = counted.filter((shot: Shot) => shot.stats?.drawCalls === 0);
  look.zeroDraw = zeroDraw;
  look.claimed = claimedByProject;
  if (counted.length > 0 && zeroDraw.length === counted.length) {
    // An empty shared base draws nothing because there is nothing in it — the same exemption
    // the no-draw proof above waits for. Anywhere else it is the verdict.
    if (look.emptyScene) warnings.push("the project drew nothing for any camera");
    else if (zeroDraw.every(claimedByProject))
      warnings.push(
        "no camera frame reported a draw, and every frame is the project's own picture rather than the studio's read of the canvas — the count is the build's claim about itself, not a verdict",
      );
    else problems.push("the project drew nothing for any camera");
    return counted;
  }
  if (!zeroDraw.length) return counted;
  warnings.push(
    `${zeroDraw.length} camera frame(s) drew nothing (${zeroDraw.map((shot: Shot) => shot.camera).join(", ")}) — those frames are not evidence of blankness`,
  );
  return counted.filter((shot: Shot) => shot.stats?.drawCalls !== 0);
}

/**
 * The pictures themselves can lie to a vision judge (it politely describes a black JPEG), so the
 * pixel counts are the verdict on blankness — but only when every camera agrees: one dark angle
 * is composition, three is a build that renders nothing.
 */
function weighBlackness(look: Look, statBearing: Shot[]): void {
  const blackEverywhere =
    statBearing.length > 0 &&
    statBearing.every((shot: Shot) => shot.stats?.canvas && shot.stats.litFraction < BLACK_LIT_FRACTION);
  if (!look.emptyScene && blackEverywhere)
    look.problems.push("every camera renders effectively black (<0.5% pixels above luma 8)");
}

/** When every camera returned the same frame: an overlay, a dead camera contract, a stale picture, or one viewpoint. */
function sameFrameEverywhere(look: Look): void {
  const { canvasSourced, declaredViewpoints, problems, uiEntries, uiPrimary, warnings } = look;
  if (uiPrimary) {
    warnings.push(
      `a full-screen overlay covers the project (${uiEntries.slice(0, MAX_UI_ENTRIES).join(", ") || "the page"}) — every camera frame is the same picture behind it; judge user:view`,
    );
  } else if (declaredViewpoints.length > 1 && canvasSourced) {
    problems.push("every camera returned the same frame — debugCamera switches nothing, the cameras contract is dead");
  } else if (declaredViewpoints.length > 1) {
    warnings.push(
      "every camera returned the same frame, but the frames came off the compositor and not the canvas — the picture may be stale rather than the camera wiring dead",
    );
  } else {
    warnings.push("this build declares one viewpoint — identical frames are its design, not a dead debugCamera");
  }
}

/**
 * Different cameras returning byte-identical frames is one view wearing several labels — but
 * only when the project declares more than one viewpoint and the frames came off the canvas. A project
 * with one camera is photographed three times by the floor, and identical frames there are its
 * design; a full-screen overlay is a different sentence again.
 */
function weighDuplicates(look: Look): void {
  const { declaredViewpoints, shots, warnings } = look;
  const withPixels = shots.filter((shot: Shot) => shot.base64);
  look.withPixels = withPixels;
  look.canvasSourced = shots.every((shot: Shot) => shot.surface !== "page");
  const duplicate = shots.find((shot: Shot, index: number) =>
    shots.slice(0, index).some((other: Shot) => other.base64 && other.base64 === shot.base64),
  );
  look.duplicate = duplicate;
  if (look.emptyScene) return;
  const allSame = withPixels.length > 1 && withPixels.every((shot: Shot) => shot.base64 === withPixels[0].base64);
  if (allSame) sameFrameEverywhere(look);
  else if (duplicate && declaredViewpoints.length > 1)
    warnings.push(
      `the ${duplicate.camera} camera returned the same frame as another camera — each named camera must frame a distinct view; fix the camera wiring in main.js`,
    );
}

/** An empty shared base: its cameras must at least be placed apart, and nothing visual has been validated. */
function weighEmptyBase(look: Look): void {
  const { cameraPoses, problems, warnings } = look;
  if (!look.emptyScene) return;
  if (cameraPoses.size > 1 && new Set(cameraPoses.values()).size === 1)
    problems.push("every camera has the same transform — shared-base camera placement is not implemented");
  warnings.push(
    "Empty shared base: runtime and camera placement checked; no visual content or interaction has been validated.",
  );
}

/** Frames that drew nothing, blank pixels on every camera, and one view wearing several labels. */
async function weighFrames(look: Look): Promise<LookEnd> {
  weighBlackness(look, weighDraws(look));
  weighDuplicates(look);
  weighEmptyBase(look);
}

/** The console against what the page inherited, and the GPU's own errors. */
async function readConsole(look: Look): Promise<LookEnd> {
  const { ctx, h, inheritedConsole, problems, warnings } = look;
  const consoleEntries = await ctx.call(HostMethod.PreviewConsole, { sinceMs: 0, ...h });
  look.consoleEntries = consoleEntries;
  const consoleErrors = consoleEntries.filter((entry) => entry.level === "error");
  look.consoleErrors = consoleErrors;
  const consoleVerdict = consoleProblems(consoleErrors, inheritedConsole);
  look.consoleVerdict = consoleVerdict;
  problems.push(...consoleVerdict.problems);
  warnings.push(...consoleVerdict.warnings);

  look.gpuErrors = [];
  try {
    const answered = await ctx.call(HostMethod.PreviewGpuErrors, { ...h });
    look.gpuErrors = Array.isArray(answered) ? answered : [];
  } catch {
    look.gpuErrors = [];
  }
}

/**
 * What the page-side capture said about the judged frame. Who took it, and by which rungs: a
 * `project` provenance means the numbers are the build's own report and not the studio's read of
 * the canvas.
 */
function judgedCanvas(judged: Shot | null): AnyRecord | null {
  const stats = judged?.stats;
  if (!stats) return null;
  return {
    source: stats.source ?? null,
    composited: stats.composited ?? null,
    drawCalls: Number.isFinite(stats.drawCalls) ? stats.drawCalls : null,
    reason: stats.captureReason ?? null,
    kind: stats.kind ?? null,
    provenance: stats.provenance ?? null,
    ladder: Array.isArray(stats.ladder) ? stats.ladder : null,
  };
}

/**
 * "The build does not run: " must never end in a colon: a pass that took no frame owes the
 * reader the sentence saying so, with both halves of the camera story in it.
 */
function sayNoFrame(look: Look): void {
  const { askedFor, problems, shots } = look;
  if (shots.length > 0 || problems.some((problem: unknown) => NO_FRAME.test(String(problem)))) return;
  problems.push(
    `no camera produced a frame (asked for: ${askedFor.join(", ") || "none"}; registered: ${(look.declaredCameras ?? []).join(", ") || "none"})`,
  );
}

/** The pass's answer, never a bare colon. */
async function reportLook(look: Look): Promise<LookEnd> {
  const { consoleErrors, demoShots, demoStates, demos, missingCameras, motionFrames, problems, shots } = look;
  const { skippedDemos, uiCoverage, uiEntries, uiPrimary, warnings } = look;
  sayNoFrame(look);
  const judged = shots.find((shot: Shot) => shot.camera === DEFAULT_CAMERA) ?? shots[0] ?? null;
  look.judged = judged;
  return {
    value: {
      requestedState: look.requestedState,
      ok: problems.length === 0 && shots.length > 0,
      emptyScene: look.emptyScene,
      problems,
      warnings,
      // Demo end-frames join the evidence after the honesty guards — a demo that legitimately
      // ends on a frame matching a camera shot must not read as a dead debugCamera.
      shots: [...shots, ...demoShots, ...(look.userViewShot ? [look.userViewShot] : [])],
      demos: Object.keys(demos).length ? demos : null,
      // The state each demo left behind, for probes scoped to a demo.
      demoStates: Object.keys(demoStates).length ? demoStates : null,
      // What the project declares vs what the cap left out — so a check can tell "not registered"
      // (the builder's defect) from "not run" (nobody looked).
      registeredDemos: look.registeredDemos,
      skippedDemos,
      state: look.state,
      stateEarly: look.stateEarly,
      // The last five, for a judge and a builder to read in a prompt...
      consoleErrors: consoleErrors.slice(-PROMPT_CONSOLE_ERRORS).map((entry: AnyRecord) => entry.message),
      // ...and every distinct message, for the next build's baseline. An error inherited from the
      // build this one forked from must be recognisable when the next pass looks: a baseline of
      // five forgives the wrong ones, and one unforgiven shader line once voided four iterations,
      // every judge of a night and its landing.
      consoleBaseline: [...new Set(consoleErrors.map((entry: AnyRecord) => String(entry.message)))].slice(
        0,
        MAX_CONSOLE_BASELINE,
      ),
      gpuErrors: look.gpuErrors.slice(0, MAX_GPU_ERRORS),
      // v2 evidence: the motion strip (feel), the audio probe, which eye cameras exist, and
      // which spec cameras the build failed to register.
      motion: motionFrames,
      audio: look.audioProbe,
      eyes: look.eyeNames,
      missingCameras,
      // M4 evidence: when the page came up, what the readiness poll answered, what the two
      // proving steps moved, which surface the judged frames came off, what the page paints
      // outside its canvas, and what the page-side capture said about the frame it gave back.
      readyAfterMs: look.readyAfterMs,
      ready: look.ready,
      clock: look.clockProof,
      surface: judged?.surface ?? "canvas",
      pageUi: look.pageUi ? { entries: uiEntries, coverage: uiCoverage, primary: uiPrimary } : null,
      canvas: judgedCanvas(judged),
    },
  };
}

// ── windows: the preview a look is taken through ─────────────────────────────────────────────

/**
 * Ask for a window, then ask again: a worker holds one for a look, not for a round. The pool has
 * no queue — `preview.acquire` throws the instant every window is leased — so a few asks a few
 * seconds apart usually find one. Null when there is none, or when this studio has no pool at all
 * (`pooled: false`: its only window is the live one, and there is nothing to wait for).
 */
export async function acquireWindow(
  ctx: HarnessCtx,
  label: string,
  { pooled = true, retriesMs = WINDOW_RETRIES_MS }: { pooled?: boolean; retriesMs?: readonly number[] } = {},
): Promise<string | null> {
  if (!pooled) return null;
  for (let attempt = 0; ; attempt++) {
    const lease = await ctx.call(HostMethod.PreviewAcquire, { label }).catch(() => null);
    if (lease?.handle) return lease.handle;
    if (attempt >= retriesMs.length || ctx.cancelled) return null;
    await sleep(retriesMs[attempt]);
  }
}

/**
 * A window to look through — or, for a pass that can wait, none.
 *
 * A judge or a playtest is the director's own choice and can be made a minute later: when every
 * pooled window is leased it is told so (`{ noWindow }`), the same answer `worker_start` gives. A
 * pass that cannot be skipped — the health of a merge just made, the contract, the starting
 * point, the close — passes `borrow: true` and looks through the window a call that names none
 * reaches: the studio's own stand-in, never the user's Live, which only they change. In a studio
 * with no pool at all (`pooled: false`) that window is the live view, as it always was.
 */
export async function withLease<T>(
  ctx: HarnessCtx,
  label: string,
  fn: (handle: string | null) => Promise<T>,
  {
    borrow = false,
    pooled = true,
    retriesMs = WINDOW_RETRIES_MS,
  }: {
    borrow?: boolean;
    pooled?: boolean;
    retriesMs?: readonly number[];
  } = {},
): Promise<T | { noWindow: string }> {
  const handle = await acquireWindow(ctx, label, { pooled, retriesMs });
  const noneFree = !handle && pooled;
  if (noneFree && !borrow) return noWindowFree(ctx);
  try {
    return await fn(handle);
  } finally {
    if (handle) await ctx.call(HostMethod.PreviewRelease, { handle }).catch(() => {});
  }
}

/** What a pass that can wait is told when every window is leased. */
async function noWindowFree(ctx: HarnessCtx): Promise<{ noWindow: string }> {
  const cap = await ctx.call(HostMethod.PreviewCapacity, {}).catch(() => null);
  const inUse = cap?.max ? ` (${cap.inUse}/${cap.max} in use)` : "";
  return {
    noWindow: `no window free${inUse} — every window is a worker's right now; wait for one to finish or stop one, then ask again`,
  };
}

/**
 * A look that is allowed to look again when the load raced the window (`loadRaced`). `look` makes
 * one pass; a pass that throws is a failed pass, never a thrown night. `onRace` hears each race
 * before the next look. The answer carries how many looks it was allowed (`attempts`).
 */
export async function patientEvidence(
  ctx: { readonly cancelled?: boolean },
  look: () => Promise<Evidence>,
  {
    attempts = 3,
    delayMs = LOAD_RACE_RETRY_MS,
    onRace = null,
  }: { attempts?: number; delayMs?: number; onRace?: ((evidence: Evidence) => void) | null } = {},
): Promise<Evidence | null> {
  let evidence: Evidence | null = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(delayMs);
    evidence = await look().catch(
      (err): Evidence => ({
        ok: false,
        problems: [String(err?.message ?? err)],
        warnings: [],
        shots: [],
        consoleErrors: [],
      }),
    );
    if (evidence.ok || ctx.cancelled) break;
    if (!loadRaced(evidence.problems)) break;
    onRace?.(evidence);
  }
  if (evidence) evidence.attempts = attempts;
  return evidence;
}
