/**
 * The pure verdict helpers the prober applies to what it observed, kept out of the browser driver so
 * each can be replayed against a fixture with no browser. Ported from genex-demo's
 * `prober/verdicts.ts`; hosted-only rules (the embed SDK's markers and identity bounce, the demo
 * template's optional capability probes) are dropped, and `stayedOnProject` allows no bounce at all.
 *
 * Every export exists because a run was MIS-SCORED by a confident, plausible, wrong reading:
 * - `CHROME_DENY_SOURCE` and the click guard: a random soak click landed on "Sign in" and the
 *   document left the project.
 * - `pickEvidenceSnapshot`: a foreign page's animated background out-scored the project's own state.
 * - `classifyFailure`: benign failures (favicons, beacons, a `.ktx2` probe whose fallback loaded)
 *   failed `l1.assets_arrived`.
 * - `shouldDemoteForCamera`: "no camera seen" on a context the hook could not read is blindness.
 * - `demoteForPointerLock` / `lookInputVerdict` / `demoteForFullscreen` / `demoteForNoInteraction`: a
 *   project the probe could not ENTER must not be reported as a project that does not RESPOND.
 * - `judgeEvidence`: a judge handed frames of a loading card scored the project 0/9.
 * - `pageRan`, `selectExposureFrames`, `interactionReached`: rows that answered confidently on an
 *   empty observation.
 * - `judgeEntrance`: which door the probe walked through, from signals that can witness it, and
 *   NEVER from a pixel change (a Space that makes the player jump changes pixels too).
 */
import { CheckResult, EntranceVia, ProbePhase } from "../vocabulary.ts";
import { SECOND_MS } from "../../../src/shared/duration.ts";
import { type Check, CheckLayer, CheckSource, type Demotion, ShotKind } from "./types.ts";

/* ------------------------------------------------------------ chrome deny */

/**
 * Text a click must NEVER land on: sign-in, account and settings chrome, and close buttons. Kept as
 * a SOURCE string because it crosses into `page.evaluate`, which serialises the function and cannot
 * see module scope; the flag is re-applied in the page.
 */
export const CHROME_DENY =
  /(sign\s*in|sign\s*up|log\s*in|login|register|account|settings|options|credits|privacy|terms|cookie|dismiss|close|^×$|^✕$|^x$)/i;
/** `CHROME_DENY` as source text, for the page-side finders. */
export const CHROME_DENY_SOURCE = CHROME_DENY.source;

/* ---------------------------------------------------------- evidence pick */

/** A page-state snapshot as the instrument returns it: untyped page data. */
export type ProbeSnapshot = Record<string, unknown>;

/**
 * How much of a PROJECT a snapshot saw. Audio contexts outrank canvases outrank mirror colours outrank
 * rAF frames. Origin is deliberately NOT in here: it is a filter applied first, never a weight a loud
 * enough foreign page could outscore.
 */
export function evidenceScore(snap: ProbeSnapshot): number {
  const audio = snap.audio as { contexts?: unknown[] } | undefined;
  const canvases = snap.liveCanvases as unknown[] | undefined;
  const raf = snap.raf as { distinctFrames?: number } | undefined;
  const frames = snap.frames as { mirrorBestColors?: number } | undefined;
  return (
    (audio?.contexts?.length ?? 0) * 1000 +
    (canvases?.length ?? 0) * 100 +
    (frames?.mirrorBestColors ?? 0) +
    (raf?.distinctFrames ?? 0) / 1000
  );
}

/** The origin of a URL, or null when it cannot be read. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The origin a snapshot was taken on, from the `href` the instrument records. */
export function snapshotOrigin(snap: ProbeSnapshot): string | null {
  return typeof snap.href === "string" ? originOf(snap.href) : null;
}

/** The snapshot picked as the project's page state, and what was excluded. */
export interface EvidencePick {
  readonly snapshot: ProbeSnapshot | null;
  /** Caveats for the scorecard's notes. Empty when every snapshot was on the project's origin. */
  readonly notes: readonly string[];
  readonly sameOrigin: number;
  readonly foreign: number;
}

interface TaggedSnapshot {
  snap: ProbeSnapshot;
  i: number;
  origin: string | null;
}

const bestSnapshot = (list: TaggedSnapshot[]) =>
  list.reduce((a, b) => (evidenceScore(b.snap) > evidenceScore(a.snap) ? b : a));

function describeSnapshot(t: TaggedSnapshot): string {
  const atMs = t.snap.takenAtMs;
  const when = typeof atMs === "number" && Number.isFinite(atMs) ? `${Math.round(atMs)}ms` : `snapshot ${t.i + 1}`;
  return `${t.origin} at ${when}`;
}

/**
 * Pick the snapshot that saw the PROJECT: same-origin snapshots only, best evidence score among them. A
 * snapshot whose origin cannot be read stays eligible (it cannot be proven foreign). When every
 * snapshot is foreign the pick falls back to the best of them and SAYS SO.
 */
export function pickEvidenceSnapshot(snapshots: ReadonlyArray<ProbeSnapshot>, projectOrigin: string): EvidencePick {
  if (snapshots.length === 0) return { snapshot: null, notes: [], sameOrigin: 0, foreign: 0 };
  const tagged = snapshots.map((snap, i) => ({ snap, i, origin: snapshotOrigin(snap) }));
  // With no project origin to compare against nothing can be called foreign.
  const foreign = projectOrigin ? tagged.filter((t) => t.origin !== null && t.origin !== projectOrigin) : [];
  const eligible = tagged.filter((t) => !foreign.includes(t));
  if (foreign.length === 0) {
    return { snapshot: bestSnapshot(eligible).snap, notes: [], sameOrigin: eligible.length, foreign: 0 };
  }
  const listed = foreign.map(describeSnapshot).join(", ");
  if (eligible.length > 0) {
    return {
      snapshot: bestSnapshot(eligible).snap,
      notes: [
        `${foreign.length} of ${snapshots.length} page-state snapshot(s) were taken on a foreign origin (${listed}) — the document had left the project's origin ${projectOrigin} when they were read, so they were excluded from the page-state readout.`,
      ],
      sameOrigin: eligible.length,
      foreign: foreign.length,
    };
  }
  const origins = [...new Set(foreign.map((t) => t.origin))].join(", ");
  return {
    snapshot: bestSnapshot(foreign).snap,
    notes: [
      `every snapshot was taken on a foreign origin (${origins}) — the run left the project. Page-side state is read from the best of them (${listed}) and describes THAT page, not the project; treat every page-state check on this scorecard as contaminated.`,
    ],
    sameOrigin: 0,
    foreign: foreign.length,
  };
}

/* ------------------------------------------------------ failure blame */

/** Whose problem a failed request is. */
export const FailureBlameKind = {
  Asset: "asset",
  Benign: "benign",
} as const;
export type FailureBlameKind = (typeof FailureBlameKind)[keyof typeof FailureBlameKind];

/** URLs whose failure says nothing about the project's assets. */
export const BENIGN_URL = [/\/favicon\.ico$/i, /apple-touch-icon/i, /\/robots\.txt$/i, /\.map$/i, /\/sw\.js$/i];
/** Third-party telemetry, not project content: these abort or rate-limit routinely. */
export const TELEMETRY_URL = [
  /\/cdn-cgi\/rum/i,
  /\/monitoring(\?|$)/i,
  /ingest\.[a-z0-9.-]*sentry\.io/i,
  /posthog/i,
  /google-analytics|googletagmanager/i,
];
/** An asset-shaped URL: blamed on the project wherever it was served from. */
export const ASSET_EXT =
  /\.(glb|gltf|bin|ktx2|basis|png|jpe?g|webp|avif|hdr|exr|vrm|fbx|obj|mp3|ogg|wav|m4a|webm|json|js|css|woff2?|ttf|svg)(\?|$)/i;

/** Whose problem a failed request is, and why. */
export interface FailureBlame {
  blame: FailureBlameKind;
  why: string;
}

/**
 * A `.ktx2` capability probe: loaders request the `.ktx2` sibling first and fall back to the
 * universal file when it is missing. Benign ONLY when the fallback actually loaded.
 */
export const KTX2_SIBLING = /\.ktx2(?:\?.*)?$/i;
/** The reason a `.ktx2` failure with a loaded fallback is benign. */
export const KTX2_FALLBACK_WHY = "a .ktx2 capability probe; the universal fallback then loaded";

/** The URLs whose success excuses a failed `.ktx2` request. */
export function ktx2FallbackUrls(url: string): string[] {
  if (!KTX2_SIBLING.test(url)) return [];
  const stripped = url.replace(KTX2_SIBLING, "");
  const base = stripped.replace(/@\d+$/, "");
  return base === stripped ? [stripped] : [stripped, base];
}

const benign = (why: string): FailureBlame => ({ blame: FailureBlameKind.Benign, why });
const asset = (why: string): FailureBlame => ({ blame: FailureBlameKind.Asset, why });

/**
 * A failed request is the PROJECT's problem when it is same-origin with the project, or asset-shaped
 * wherever it came from. Everything else is recorded and ignored.
 */
export function classifyFailure(url: string, pageOrigin: string, succeeded?: ReadonlySet<string>): FailureBlame {
  if (BENIGN_URL.some((re) => re.test(url))) return benign("favicon/robots/sourcemap");
  if (TELEMETRY_URL.some((re) => re.test(url))) return benign("third-party telemetry beacon");
  if (succeeded && ktx2FallbackUrls(url).some((u) => succeeded.has(u))) return benign(KTX2_FALLBACK_WHY);
  const origin = originOf(url);
  if (origin === null) return benign("unparseable url");
  if (origin === pageOrigin) return asset("same origin as the project");
  if (ASSET_EXT.test(url)) return asset("asset-shaped url on another origin");
  return benign("third-party non-asset request");
}

/* ------------------------------------------------------ camera demotion */

/** What `shouldDemoteForCamera` reads. */
export interface CameraDemotionState {
  /** WebGL contexts the page created. */
  readonly webglContexts: number;
  /** The instrument's `camera` record, or absent on a snapshot that has none. */
  readonly camera: { readonly seen?: boolean; readonly hooks?: number; readonly viewLocs?: number } | null | undefined;
}

/**
 * Should a passing boot be demoted to "no 3D scene was ever drawn"? Only when the hook was in a
 * position to see one: a WebGL context existed, the instrument hooked a context's `uniformMatrix4fv`,
 * a program declared `viewMatrix`, and still no view matrix was uploaded. With `hooks` or `viewLocs`
 * at zero, "no camera seen" is the hook's blindness, not the project's silence.
 */
export function shouldDemoteForCamera(state: CameraDemotionState): boolean {
  const hooks = state.camera?.hooks ?? 0;
  const viewLocs = state.camera?.viewLocs ?? 0;
  const hookCouldSee = hooks > 0 && viewLocs > 0;
  return state.webglContexts > 0 && hookCouldSee && !state.camera?.seen;
}

/* -------------------------------------------------- pointer-lock demotion */

/** The instrument's running heading record since the synthetic lock engaged. */
export interface LookRecord {
  readonly windowMs: number;
  readonly samples: number;
  readonly headings: number;
  readonly firstT: number | null;
  readonly lastT: number | null;
  readonly sweepDeg: number;
  readonly mouseSweepDeg: number;
  readonly mouseSteps: number;
  readonly mouseStepsUnattributable: number;
  readonly lastMoveT?: number | null;
}

/** The instrument's `pointerLock` record, or absent on an older bundle. */
export type PointerLockState =
  | {
      readonly requested?: number;
      readonly grantedNatively?: boolean;
      readonly shimmed?: boolean;
      /** PAGE-clock ms at which the synthetic lock engaged; the camera samples share that clock. */
      readonly engagedAtMs?: number | null;
      /** Move events the shim's listeners saw while locked. */
      readonly movesWhileLocked?: number;
      /** Every post-lock camera sample, accumulated as it was flushed and never discarded. */
      readonly look?: LookRecord | null;
    }
  | null
  | undefined;

/**
 * Did the probe get stuck OUTSIDE a click-to-lock door? True only when the project ASKED for pointer lock
 * and neither the browser nor the shim gave it one. An absent record reads as "not blocked": absence
 * of the measurement is not evidence that it failed.
 */
export function pointerLockBlocked(state: PointerLockState): boolean {
  const requested = state?.requested ?? 0;
  return requested > 0 && !state?.grantedNatively && !state?.shimmed;
}

/** Why a fail behind an unopened pointer-lock door is unknown. */
export const POINTER_LOCK_BLOCKED_WHY =
  "The project asked for pointer lock and never got one — not from the browser, and not from the probe's fallback shim — so every input after that door landed on a menu the probe could not leave. A project we could not ENTER must not be reported as a project that does not RESPOND.";

/** A demotion that moved nothing. */
const unchanged = (result: CheckResult): Demotion => ({ result, why: null });

/**
 * Demote a check that only failed because the probe never got into the project. A `fail` becomes
 * `unknown`; nothing else moves. It never rescues a fail into a pass.
 */
export function demoteForPointerLock(result: CheckResult, state: PointerLockState): Demotion {
  if (result !== CheckResult.Fail || !pointerLockBlocked(state)) return unchanged(result);
  return { result: CheckResult.Unknown, why: POINTER_LOCK_BLOCKED_WHY };
}

/* ------------------------------------------------- delivered look input */

/**
 * A camera sample as the instrument records it: PAGE-clock `t`, a position and the forward axis.
 * The heading is the forward axis projected onto the ground plane; `fy` is where it is aimed up or
 * down (pitch).
 */
export interface CameraYawSample {
  readonly t?: number;
  readonly fx?: number;
  readonly fy?: number;
  readonly fz?: number;
}

/**
 * How far the heading must have swept INSIDE the mouse windows, after the synthetic lock engaged,
 * before the probe's mouse deltas count as DELIVERED. A heading read off a frozen camera moves by
 * float noise only; a mouse-look project turns by tens of degrees on the probe's drag.
 */
export const MIN_LOOK_YAW_DEG = 5;

/** Did the look input reach the project behind a shimmed lock? */
export interface LookInputVerdict {
  /** Only a SHIMMED entry is measured: the project asked, the browser refused, the shim let the probe in. */
  readonly applicable: boolean;
  /** `true` swept past the floor; `false` measured and under it; `null` nothing observed. */
  readonly delivered: boolean | null;
  readonly samplesAfterLock: number;
  readonly headingsAfterLock: number;
  /** The unwrapped heading range over EVERY post-lock sample (keyboard turns and pans included). */
  readonly yawSweepDeg: number | null;
  /** The same range over only the steps inside `windowMs` of a locked move event: the delivery signal. */
  readonly mouseYawSweepDeg: number | null;
  readonly window: { readonly firstT: number | null; readonly lastT: number | null; readonly windowMs: number | null };
  /** The demotion reason, naming the door. `null` when nothing demotes. */
  readonly why: string | null;
}

const LOOK_NOT_APPLICABLE: LookInputVerdict = {
  applicable: false,
  delivered: null,
  samplesAfterLock: 0,
  headingsAfterLock: 0,
  yawSweepDeg: null,
  mouseYawSweepDeg: null,
  window: { firstT: null, lastT: null, windowMs: null },
  why: null,
};

const UNKNOWN_BEHIND_DOOR =
  "A fail measured behind a door we cannot show we walked through is not a fail; this row is unknown.";

function lookDoor(state: NonNullable<PointerLockState>, requested: number): string {
  const engaged =
    typeof state.engagedAtMs === "number" && Number.isFinite(state.engagedAtMs) ? state.engagedAtMs : null;
  const at = engaged === null ? "" : ` at ${Math.round(engaged)}ms of page time`;
  return `The project asked for pointer lock ${requested} time(s), the browser refused, and the probe entered through its synthetic lock${at}`;
}

function lookUndelivered(door: string, look: LookRecord, span: string): string {
  const unattributable =
    look.mouseStepsUnattributable > 0
      ? ` ${look.mouseStepsUnattributable} step(s) followed a move but spanned more than the window and were not attributed — a sampler slower than ${look.windowMs}ms cannot say what inside a step was the mouse.`
      : "";
  return `${door} — and across the ${look.headings} readable heading(s) in the ${look.samples} camera sample(s) flushed after it${span} the heading swept ${look.sweepDeg.toFixed(1)}° in total but only ${look.mouseSweepDeg.toFixed(1)}° inside the ${look.windowMs}ms windows following the mouse deltas delivered while locked (${look.mouseSteps} attributed step(s)), under the ${MIN_LOOK_YAW_DEG}° that would show those deltas reached the project's look.${unattributable} The synthetic lock opened the door; nothing shows the mouse walked through it. This row is unknown.`;
}

/**
 * DID THE LOOK INPUT REACH THE PROJECT? Keyed on what was DELIVERED, never on what the shim did. The
 * heading also moves on A/D turns, a follow camera and the project's own pans, so `delivered` reads the
 * mouse-attributed sweep; the total sweep is context. Absence demotes too.
 */
export function lookInputVerdict(state: PointerLockState): LookInputVerdict {
  const requested = state?.requested ?? 0;
  if (!state || requested <= 0 || state.shimmed !== true) return LOOK_NOT_APPLICABLE;
  const door = lookDoor(state, requested);
  const look = state.look ?? null;
  if (!look) {
    return {
      ...LOOK_NOT_APPLICABLE,
      applicable: true,
      why: `${door} — but this instrument kept no post-lock heading record, so whether the mouse deltas the probe sent ever reached the project's look is UNOBSERVED. ${UNKNOWN_BEHIND_DOOR}`,
    };
  }
  const span =
    look.firstT !== null && look.lastT !== null
      ? ` (page-ms ${Math.round(look.firstT)}–${Math.round(look.lastT)})`
      : "";
  const base = {
    applicable: true as const,
    samplesAfterLock: look.samples,
    headingsAfterLock: look.headings,
    window: { firstT: look.firstT, lastT: look.lastT, windowMs: look.windowMs },
  };
  if (look.headings < 2) {
    return {
      ...base,
      delivered: null,
      yawSweepDeg: null,
      mouseYawSweepDeg: null,
      why: `${door} — but of the ${look.samples} camera sample(s) flushed after the lock engaged${span} only ${look.headings} carried a readable ground heading, and a sweep needs two, so whether the mouse deltas the probe sent ever reached the project's look is UNOBSERVED. ${UNKNOWN_BEHIND_DOOR}`,
    };
  }
  const sweeps = { yawSweepDeg: look.sweepDeg, mouseYawSweepDeg: look.mouseSweepDeg };
  if (look.mouseSweepDeg >= MIN_LOOK_YAW_DEG) return { ...base, ...sweeps, delivered: true, why: null };
  return { ...base, ...sweeps, delivered: false, why: lookUndelivered(door, look, span) };
}

/**
 * Demote a check that failed behind a shimmed lock whose look input was never seen to land. The same
 * one-directional rule as `demoteForPointerLock`.
 */
export function demoteForLookInput(result: CheckResult, verdict: LookInputVerdict): Demotion {
  const undelivered = verdict.applicable && verdict.delivered !== true && verdict.why !== null;
  if (result !== CheckResult.Fail || !undelivered) return unchanged(result);
  return { result: CheckResult.Unknown, why: verdict.why };
}

/* ------------------------------------------------- console-line classifiers */

/**
 * Console lines that mean AN ASSET ARRIVED AND THE PROJECT COULD NOT USE IT. Library-anchored, never project
 * prose: three.js's loader wording and the DOM's `drawImage` refusal mean the same thing in every
 * project. A project that logs nothing reports zero, so this can only fail on POSITIVE evidence.
 */
const LOADER_FAILURE_PATTERNS: ReadonlyArray<RegExp> = [
  /THREE\.\w+:\s*(Couldn't|Could not|Unable to)\s+load/i,
  /Failed to execute 'drawImage' on 'CanvasRenderingContext2D'/i,
];

/** Whether one console line reports an asset the project could not use. */
export function isLoaderFailureLine(text: string): boolean {
  return LOADER_FAILURE_PATTERNS.some((re) => re.test(text));
}

/** How many console lines report an asset the project could not use. */
export function loaderFailureCount(entries: ReadonlyArray<{ readonly text?: unknown }>): number {
  return entries.filter((e) => typeof e.text === "string" && isLoaderFailureLine(e.text)).length;
}

/**
 * Console lines that mean THE RENDERER REFUSED TO DRAW, or the project called an API three.js removed:
 * the bug class `no_errors_60s` cannot see, because both arrive at `warn` level. Library/driver
 * anchored: three's "has been removed/deprecated" wording and ANGLE's `GL_INVALID_OPERATION: glDraw*`.
 */
const RENDERER_DEFECT_PATTERNS: ReadonlyArray<RegExp> = [
  /THREE\.\w+:\s*.*\bhas been (removed|deprecated)\b/i,
  /GL_INVALID_OPERATION:\s*glDraw\w*:/i,
];

/** Whether one console line reports a rejected draw call or a removed three.js API. */
export function isRendererDefectLine(text: string): boolean {
  return RENDERER_DEFECT_PATTERNS.some((re) => re.test(text));
}

/** Renderer defect lines, counted and collapsed to their distinct messages. */
export interface RendererDefects {
  /** Every matching line, including the driver's per-draw-call repeats. */
  readonly count: number;
  /** One entry per distinct message, first occurrence first. */
  readonly distinct: ReadonlyArray<string>;
}

/** How many console lines report a rejected draw call or a removed three.js API. */
export function rendererDefects(entries: ReadonlyArray<{ readonly text?: unknown }>): RendererDefects {
  let count = 0;
  const distinct: string[] = [];
  for (const e of entries) {
    if (typeof e.text !== "string" || !isRendererDefectLine(e.text)) continue;
    count++;
    // ANGLE prefixes each line with the context handle; strip it so two contexts' floods read as one.
    const key = e.text.replace(/^\[\.WebGL-0x[0-9a-f]+\]\s*/i, "");
    if (!distinct.includes(key)) distinct.push(key);
  }
  return { count, distinct };
}

/* ------------------------------------------------------------ camera geometry */

const HEADING_EPSILON = 1e-6;
const RADIANS_TO_DEGREES = 180 / Math.PI;
const finiteOr = (v: number | undefined, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/**
 * The camera's ground heading in degrees, from its forward axis: the ONE definition the look
 * verdict and the entrance judgement read. `null` for a camera looking straight up or down.
 */
export function cameraHeadingDeg(sample: CameraYawSample): number | null {
  const fx = finiteOr(sample.fx, Number.NaN);
  const fz = finiteOr(sample.fz, Number.NaN);
  if (Number.isNaN(fx) || Number.isNaN(fz)) return null;
  if (Math.abs(fx) < HEADING_EPSILON && Math.abs(fz) < HEADING_EPSILON) return null;
  return Math.atan2(fx, fz) * RADIANS_TO_DEGREES;
}

/**
 * The camera's PITCH in degrees from the horizon: 0 is level, negative is aimed DOWN at the ground.
 * A drag that is never undone can leave a camera aimed at the dirt, and the frames then show the
 * dirt; `cameraHeadingDeg` cannot see that, so this reads `fy`.
 */
export function cameraPitchDeg(sample: CameraYawSample): number | null {
  const fy = finiteOr(sample.fy, Number.NaN);
  if (Number.isNaN(fy)) return null;
  const len = Math.hypot(finiteOr(sample.fx, 0), fy, finiteOr(sample.fz, 0));
  if (!Number.isFinite(len) || len < HEADING_EPSILON) return null;
  // Clamped: a forward axis a hair over unit length must not produce NaN.
  return Math.asin(Math.max(-1, Math.min(1, fy / len))) * RADIANS_TO_DEGREES;
}

/** Pitch past which the camera is aimed so far off the horizon that its frames are not what a player sees. */
export const PITCH_RUINED_DEG = 40;

/**
 * Where a restore drag must END, given the press point and the pitch. Moving the mouse DOWN pitches
 * the camera DOWN, so a camera that is too LOW is raised by dragging UP, to a SMALLER y.
 */
export function restoreDragTargetY(cy: number, dragPx: number, pitchDeg: number): number {
  const magnitude = Math.abs(dragPx);
  return pitchDeg < 0 ? cy - magnitude : cy + magnitude;
}

/**
 * Whether a gesture left the camera aimed somewhere a player would not leave it. An unreadable pitch
 * is never a ruin, and a project that STARTED steep (top-down, isometric) was not ruined by the gesture.
 */
export function pitchRuined(
  before: CameraYawSample | null | undefined,
  after: CameraYawSample | null | undefined,
  limitDeg: number = PITCH_RUINED_DEG,
): boolean {
  const a = after ? cameraPitchDeg(after) : null;
  if (a === null || Math.abs(a) <= limitDeg) return false;
  const b = before ? cameraPitchDeg(before) : null;
  return b === null || Math.abs(b) <= limitDeg;
}

/** Pitch past which a frame is ground or sky edge to edge: steeper than `PITCH_RUINED_DEG` on purpose. */
export const PITCH_UNJUDGEABLE_DEG = 60;
/** How much of the window must be aimed away before the frames stop being evidence. */
export const UNJUDGEABLE_PITCH_SHARE = 0.5;
/** Below this many readable samples a share is not a measurement. */
export const MIN_CAMERA_SANITY_SAMPLES = 8;

/** How seriously to take where the camera pointed. */
export const CameraSeverity = {
  Ok: "ok",
  Note: "note",
  Withhold: "withhold",
} as const;
export type CameraSeverity = (typeof CameraSeverity)[keyof typeof CameraSeverity];

/** Where the camera pointed while the frames were taken. */
export interface CameraSanity {
  /** `withhold`: the frames are ground or sky; `note`: worth a reader's attention; `ok`: nothing to say. */
  readonly severity: CameraSeverity;
  /** The sentence the ledger prints verbatim. `null` when `ok`. */
  readonly why: string | null;
  readonly samples: number;
  readonly readable: number;
  readonly beyondLimit: number;
  readonly medianPitchDeg: number | null;
  /** Whether the forward axis never changed across the whole window. */
  readonly orientationFrozen: boolean;
}

const NO_CAMERA_SANITY: CameraSanity = {
  severity: CameraSeverity.Ok,
  why: null,
  samples: 0,
  readable: 0,
  beyondLimit: 0,
  medianPitchDeg: null,
  orientationFrozen: false,
};

type Axis3 = readonly [number, number, number];
const isAxis = (a: readonly (number | undefined)[]): a is Axis3 =>
  a.every((c) => typeof c === "number" && Number.isFinite(c));

/** Whether every readable forward axis in the window is the same one. */
function forwardAxisFrozen(samples: ReadonlyArray<CameraYawSample>): boolean {
  const axes = samples.map((s) => [s.fx, s.fy, s.fz] as const).filter(isAxis);
  if (axes.length < MIN_CAMERA_SANITY_SAMPLES) return false;
  const [fx, fy, fz] = axes[0];
  return axes.every((a) => a[0] === fx && a[1] === fy && a[2] === fz);
}

/**
 * WAS THE CAMERA POINTING SOMEWHERE A VERDICT CAN BE DRAWN FROM? Two clauses and only one withholds:
 * more than half the readable window past `PITCH_UNJUDGEABLE_DEG` withholds; a frozen orientation is
 * only a note, because an isometric or side-on follow camera looks exactly the same.
 */
export function cameraSanity(
  samples: ReadonlyArray<CameraYawSample> | null | undefined,
  opts?: { readonly limitDeg?: number; readonly share?: number },
): CameraSanity {
  if (!samples || samples.length === 0) return NO_CAMERA_SANITY;
  const limitDeg = opts?.limitDeg ?? PITCH_UNJUDGEABLE_DEG;
  const share = opts?.share ?? UNJUDGEABLE_PITCH_SHARE;
  const pitches = samples.map(cameraPitchDeg).filter((p): p is number => p !== null);
  const readable = pitches.length;
  const beyondLimit = pitches.filter((p) => Math.abs(p) > limitDeg).length;
  const sorted = [...pitches].sort((a, b) => a - b);
  const medianPitchDeg = readable === 0 ? null : sorted[Math.floor(readable / 2)];
  const orientationFrozen = forwardAxisFrozen(samples);
  const base = { samples: samples.length, readable, beyondLimit, medianPitchDeg, orientationFrozen };
  if (readable >= MIN_CAMERA_SANITY_SAMPLES && beyondLimit > readable * share) {
    const frozen = orientationFrozen ? ", and its forward axis never changed across the whole window" : "";
    return {
      ...base,
      severity: CameraSeverity.Withhold,
      why: `the camera was aimed more than ${limitDeg}° off the horizon for ${beyondLimit} of ${readable} readable camera sample(s) (median pitch ${(medianPitchDeg ?? 0).toFixed(2)}°)${frozen} — the viewport was ground or sky for most of the period these frames come from`,
    };
  }
  if (!orientationFrozen) return { ...base, severity: CameraSeverity.Ok, why: null };
  const pitch = medianPitchDeg === null ? "" : ` (pitch ${medianPitchDeg.toFixed(2)}°)`;
  return {
    ...base,
    severity: CameraSeverity.Note,
    why: `the camera's forward axis was identical across all ${samples.length} retained sample(s)${pitch} — nothing the probe did turned the view. That is also what an isometric or side-on follow camera looks like, so it is recorded rather than acted on: orientation alone cannot tell a frozen look control from a fixed one.`,
  };
}

/* ------------------------------------------------- the direction pair rule */

/**
 * A SIGN DISAGREEMENT IS A VERDICT ONLY WHEN BOTH READINGS ARE STRONG: three times the 2-column
 * admission floor, on a 160-wide correlation grid. The bar is raised for `fail` and not for `pass`
 * because a false fail publishes "this project's controls are broken" about a working project.
 */
export const MIN_FAIL_MOTION_COLUMNS = 6;

/** Whether a direction pair should move opposite ways or the same way. */
export const PairWant = {
  Opposite: "opposite",
  Same: "same",
} as const;
export type PairWant = (typeof PairWant)[keyof typeof PairWant];

/** Two keys' column shifts; `null` unreadable, `0` below the noise floor. */
export interface DirectionPair {
  readonly a: number | null;
  readonly b: number | null;
  readonly want: PairWant;
}

/** A direction pair's verdict. */
export interface DirectionPairVerdict {
  readonly verdict: CheckResult;
  readonly why: string;
}

/** Whether two shifts agree in direction. */
export function directionPairVerdict(
  pair: DirectionPair,
  minFailColumns: number = MIN_FAIL_MOTION_COLUMNS,
): DirectionPairVerdict {
  const { a, b, want } = pair;
  if (a === null || b === null) return { verdict: CheckResult.Unknown, why: "frames too dissimilar to correlate" };
  if (a === 0 || b === 0) return { verdict: CheckResult.Unknown, why: "movement below the noise floor" };
  const opposite = Math.sign(a) !== Math.sign(b);
  const ok = want === PairWant.Opposite ? opposite : !opposite;
  if (ok) return { verdict: CheckResult.Pass, why: `${a} vs ${b}` };
  const weakest = Math.min(Math.abs(a), Math.abs(b));
  if (weakest >= minFailColumns) return { verdict: CheckResult.Fail, why: `${a} vs ${b}` };
  return {
    verdict: CheckResult.Unknown,
    why: `${a} vs ${b} — they point the wrong way relative to each other, but the weaker reading is only ${weakest} column(s), under the ${minFailColumns} a sign must clear before it convicts a project. Not established.`,
  };
}

/** The signed short-way-round difference between two headings, in degrees. */
export function headingStepDeg(fromDeg: number, toDeg: number): number {
  let step = toDeg - fromDeg;
  while (step > 180) step -= 360;
  while (step < -180) step += 360;
  return step;
}

/**
 * The total angle the heading swept across the samples, UNWRAPPED: each step taken the short way
 * round and accumulated, so a full turn counts as 360°. The instrument accumulates the same quantity
 * incrementally (`pointerLock.look.sweepDeg`); the tests hold the two to each other.
 */
export function yawSweepDeg(samples: ReadonlyArray<CameraYawSample>): number | null {
  return headingSweepDeg(samples.map(cameraHeadingDeg));
}

/** The same unwrapped range over headings already in degrees (`null` entries are skipped). */
export function headingSweepDeg(readings: ReadonlyArray<number | null>): number | null {
  const headings = readings.filter((h): h is number => h !== null);
  if (headings.length < 2) return null;
  let acc = 0;
  let min = 0;
  let max = 0;
  for (let i = 1; i < headings.length; i++) {
    acc += headingStepDeg(headings[i - 1], headings[i]);
    min = Math.min(min, acc);
    max = Math.max(max, acc);
  }
  return max - min;
}

/* ---------------------------------------------------------- judge evidence */

/** Which clause found the evidence sufficient. */
export const JudgeEvidenceClause = {
  Clock: "clock",
  Phase: "phase",
} as const;
export type JudgeEvidenceClause = (typeof JudgeEvidenceClause)[keyof typeof JudgeEvidenceClause];

/** A frame as `judgeEvidence` reads it. */
export interface EvidenceFrameLike {
  readonly atMs: number;
  readonly phase?: ProbePhase;
  readonly source?: ShotKind;
}

/** What `judgeEvidence` reads. Frame stamps are RUN time; `firstRafPageMs` is PAGE time. */
export interface JudgeEvidenceInput {
  readonly frames: ReadonlyArray<EvidenceFrameLike>;
  /** The page's first animation frame, PAGE-clock ms. */
  readonly firstRafPageMs: number | null;
  /** The first non-degenerate capture, RUN-clock ms. */
  readonly firstRenderRunMs: number | null;
  /** RUN ms minus PAGE ms for the document the rAF came from, or `null` when unmeasured. */
  readonly pageToRunOffsetMs: number | null;
  /** When present and not reached, the judge is withheld whatever the frame counts say. */
  readonly interactionReached?: { readonly reached: boolean; readonly why: string } | null;
  /** Only `withhold` refuses; a `note` gates nothing. */
  readonly cameraSanity?: { readonly severity: CameraSeverity; readonly why: string | null } | null;
  /** The page-side mirror's first non-degenerate read, PAGE-clock ms. Reason text only. */
  readonly mirrorFirstDrawPageMs?: number | null;
  /** The first camera sample, PAGE-clock ms. Reason text only. */
  readonly firstCameraSamplePageMs?: number | null;
}

/** Whether the frames are worth judging. */
export interface JudgeEvidenceVerdict {
  readonly sufficient: boolean;
  /** Why not, in a sentence the ledger prints verbatim. `null` when sufficient. */
  readonly reason: string | null;
  readonly by: JudgeEvidenceClause | null;
}

/**
 * How many frames must overlap the drawing period: one frame cannot show motion and two show a
 * single transition that a loading spinner also produces.
 */
export const MIN_JUDGE_FRAMES = 3;

/**
 * The phases after the entrance gesture: a frame here was taken after the probe had done everything
 * it does to enter the project. The quick probe's input bursts count; its entrance frames do not.
 */
export const POST_GESTURE_PHASES: ReadonlySet<ProbePhase> = new Set([
  ProbePhase.Directions,
  ProbePhase.Ack,
  ProbePhase.Interact,
  ProbePhase.Look,
  ProbePhase.Soak,
  ProbePhase.InputBurst,
]);

const insufficient = (reason: string): JudgeEvidenceVerdict => ({ sufficient: false, reason, by: null });

/** Clause 0: the frames exist, show the project, and were not all taken before anything drew. */
function evidencePreconditions(input: JudgeEvidenceInput, pageFrames: EvidenceFrameLike[], elementNote: string) {
  if (pageFrames.length < MIN_JUDGE_FRAMES) {
    return insufficient(
      `only ${pageFrames.length} page frame(s) were captured${elementNote}, below the ${MIN_JUDGE_FRAMES} a judge needs to see anything change — the trace ended before it became evidence.`,
    );
  }
  if (input.interactionReached?.reached === false) {
    return insufficient(
      `interaction was never reached — ${input.interactionReached.why}. Every one of the ${pageFrames.length} page frame(s) is of the screen the probe was stuck on, and a verdict from them would describe that screen rather than the project.`,
    );
  }
  if (input.cameraSanity?.severity === CameraSeverity.Withhold) {
    return insufficient(
      `the camera was not pointing at the project — ${input.cameraSanity.why}. All ${pageFrames.length} page frame(s) come from that window, so a verdict from them would describe what the camera was aimed at rather than the build.`,
    );
  }
  const last = Math.max(...pageFrames.map((f) => f.atMs));
  if (input.firstRenderRunMs !== null && last < input.firstRenderRunMs) {
    return insufficient(
      `frame capture ended at ${Math.round(last)}ms and the first non-degenerate render was at ${Math.round(input.firstRenderRunMs)}ms — every frame predates the moment anything was drawn.`,
    );
  }
  return null;
}

/** The refusal when neither clause cleared the floor, naming both counts. */
function evidenceRefusal(
  input: JudgeEvidenceInput,
  counts: { afterRaf: number; interaction: number; total: number },
  elementNote: string,
): string {
  const offset = input.pageToRunOffsetMs;
  const firstRaf = Math.round(input.firstRafPageMs ?? 0);
  const clockSentence =
    offset === null
      ? `${counts.afterRaf} of ${counts.total} page frame(s) postdate the page's first animation frame at ${firstRaf}ms of page time compared UNCORRECTED — the page→run clock offset was not measured for this document, so that count is an over-estimate and cannot pass the gate on its own`
      : `${counts.afterRaf} of ${counts.total} page frame(s) were taken after the page's first animation frame (${firstRaf}ms of page time, ${Math.round((input.firstRafPageMs ?? 0) + offset)}ms of run time with the measured ${offset >= 0 ? "+" : ""}${Math.round(offset)}ms page→run offset)`;
  const witnessed = input.firstRenderRunMs;
  const phaseSentence =
    witnessed === null
      ? "no capture ever witnessed a non-degenerate draw, so the phase clause has no first draw to count from"
      : `${counts.interaction} page frame(s) were taken in a post-gesture phase after the first witnessed draw at ${Math.round(witnessed)}ms of run time`;
  const asides: string[] = [];
  if (typeof input.mirrorFirstDrawPageMs === "number") {
    asides.push(
      `the page-side mirror first read a non-degenerate frame at ${Math.round(input.mirrorFirstDrawPageMs)}ms of page time`,
    );
  }
  if (typeof input.firstCameraSamplePageMs === "number") {
    asides.push(`the first camera sample landed at ${Math.round(input.firstCameraSamplePageMs)}ms of page time`);
  }
  const aside = asides.length ? ` For the reader: ${asides.join("; ")} — neither figure gates.` : "";
  return `${clockSentence}, and ${phaseSentence}${elementNote} — both below the ${MIN_JUDGE_FRAMES}-frame floor, so the trace is of a page that had not started drawing, and a verdict from it would describe the loading screen rather than the project.${aside}`;
}

/**
 * WAS THE PROJECT EVER PHOTOGRAPHED IN MOTION? One question only: do the captured frames OVERLAP the
 * period in which the page was drawing? Never a quality signal. Two independent routes to
 * "sufficient", each an observation: the CLOCK clause (≥3 page frames after the first rAF, compared
 * in one clock; it can pass only with a MEASURED offset) and the PHASE clause (≥3 page frames after
 * the first witnessed draw in a post-gesture phase). Element-source frames count for neither: they
 * omit the DOM HUD.
 */
export function judgeEvidence(input: JudgeEvidenceInput): JudgeEvidenceVerdict {
  const frames = input.frames ?? [];
  const pageFrames = frames.filter((f) => f.source !== ShotKind.Element);
  const elementFrames = frames.length - pageFrames.length;
  const elementNote =
    elementFrames > 0 ? ` (${elementFrames} canvas-element frame(s) are excluded: they omit the DOM HUD)` : "";
  const refused = evidencePreconditions(input, pageFrames, elementNote);
  if (refused) return refused;
  const offset = input.pageToRunOffsetMs;
  const firstRafRunMs = input.firstRafPageMs === null ? null : input.firstRafPageMs + (offset ?? 0);
  const afterRaf = firstRafRunMs === null ? 0 : pageFrames.filter((f) => f.atMs > firstRafRunMs).length;
  if (offset !== null && afterRaf >= MIN_JUDGE_FRAMES) {
    return { sufficient: true, reason: null, by: JudgeEvidenceClause.Clock };
  }
  const witnessed = input.firstRenderRunMs;
  const postGesture = (f: EvidenceFrameLike) =>
    witnessed !== null && f.atMs > witnessed && f.phase !== undefined && POST_GESTURE_PHASES.has(f.phase);
  const interaction = pageFrames.filter(postGesture).length;
  if (interaction >= MIN_JUDGE_FRAMES) return { sufficient: true, reason: null, by: JudgeEvidenceClause.Phase };
  if (input.firstRafPageMs === null) {
    return insufficient(
      `the page never scheduled an animation frame, so there was no drawing period for the frames to overlap, and ${interaction} page frame(s) were taken in a post-gesture phase after a witnessed draw, below the ${MIN_JUDGE_FRAMES}-frame floor. Whether that is a broken project or a static one is the machine floor's question, not the judge's.`,
    );
  }
  return insufficient(evidenceRefusal(input, { afterRaf, interaction, total: pageFrames.length }, elementNote));
}

/* ---------------------------------------------------------- click guard text */

/**
 * The name the text half of the click guard reads (see `chromeAtInPage`): the nearest interactive
 * ancestor's accessible name, or the hit element's OWN short text when there is none.
 */
export interface ClickTarget {
  readonly interactive: boolean;
  readonly name: string;
}

/** A label longer than this is a container's text, not a control's. */
export const CHROME_NAME_MAX = 44;

/**
 * THE TEXT RULE OF THE CLICK GUARD, on the nearest interactive ancestor's accessible name and NEVER
 * on a container's text: an inline row reads "Start Options" as one line, and Start must not be
 * refused for the label of the button beside it.
 */
export function chromeNameRefusal(target: ClickTarget | null, deny: RegExp = CHROME_DENY): string | null {
  if (!target) return null;
  const name = target.name.trim();
  const controlSized = name.length > 0 && name.length <= CHROME_NAME_MAX && !name.includes("\n");
  if (!controlSized || !deny.test(name)) return null;
  return target.interactive
    ? `on a control named "${name}", which matches the chrome deny list`
    : `on "${name}", which matches the chrome deny list`;
}

/* ----------------------------------------------------------- key focus guard */

/** Where keyboard focus sits, as `describeFocusInPage` reports it. `tag` is upper-case. */
export interface FocusDescription {
  readonly tag: string;
  readonly type?: string | null;
  readonly role?: string | null;
  readonly href?: boolean;
  readonly contentEditable?: boolean;
  /** The element's accessible name, for the reason string. May be empty. */
  readonly name?: string;
}

const FORM_CONTROL_TAGS = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "OPTION"]);
const ACTIVATABLE_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "tab",
  "checkbox",
  "radio",
  "switch",
  "option",
  "combobox",
  "textbox",
  "searchbox",
]);

/**
 * WHY A KEY MUST NOT BE SENT with focus where it is, or `null` when it may. Enter on a focused button
 * IS a click, and Space on the project's own start button restarts it mid-measurement. A link, a form
 * control, an activatable ARIA role, an editable region or an `<iframe>` other than the evidence frame
 * refuses; the canvas, the body and a plain focused container do not. The caller blurs once and asks
 * again; a refusal after that is counted and the key is not sent.
 */
export function keyFocusRefusal(focus: FocusDescription | null): string | null {
  if (!focus) return null;
  const who = focus.name ? ` "${focus.name.slice(0, CHROME_NAME_MAX)}"` : "";
  const tag = focus.tag.toUpperCase();
  const lower = tag.toLowerCase();
  if (tag === "A" && focus.href) return `focus is on a link${who} — Enter would follow it`;
  if (tag === "IFRAME") {
    return `focus is on an <iframe>${who} that is not the frame the reads target — a key would land in a document nothing here measures`;
  }
  if (FORM_CONTROL_TAGS.has(tag)) {
    const type = focus.type ? ` type=${focus.type}` : "";
    return `focus is on a form control <${lower}${type}>${who} — a key would activate or type into it`;
  }
  if (focus.contentEditable) return `focus is in an editable region <${lower}>${who} — a key would type into it`;
  const role = (focus.role ?? "").toLowerCase();
  if (ACTIVATABLE_ROLES.has(role)) return `focus is on role="${role}"${who} — a key would activate it`;
  return null;
}

/* ------------------------------------------------------------ stayed on project */

/** One main-frame navigation, run-clock ms. */
export interface NavigationRecord {
  readonly atMs: number;
  readonly url: string;
}

/** One stretch the document spent off the project's origin. */
export interface OffProjectExcursion {
  readonly fromMs: number;
  /** When a same-origin navigation ended it; the run's end when it never did. */
  readonly toMs: number;
  readonly durationMs: number;
  readonly returned: boolean;
  /** Every foreign URL visited inside it, in order. */
  readonly urls: readonly string[];
}

/** What `stayedOnProject` reads. */
export interface StayedOnProjectInput {
  readonly navigations: ReadonlyArray<NavigationRecord>;
  readonly projectOrigin: string;
  /** `pickEvidenceSnapshot(...).foreign`: snapshots read while off the origin. */
  readonly foreignSnapshots: number;
  readonly sameOriginSnapshots: number;
  /** Run ms when the probe ended; closes an excursion that never returned. */
  readonly endAtMs: number;
}

/** `l1.stayed_on_project`'s verdict and the excursions behind it. */
export interface StayedOnProjectVerdict {
  readonly result: CheckResult;
  readonly detail: string;
  readonly excursions: readonly OffProjectExcursion[];
  readonly foreignNavigations: number;
}

/**
 * How long the document may spend off the project's origin and still pass. Zero: a local snapshot served
 * from `127.0.0.1` has no identity bounce (the hosted embed SDK's round trip is not ported), so any
 * stretch off the origin is the run leaving the project.
 */
export const OFF_PROJECT_ALLOWANCE_MS = 0;

/** Walk the navigations in time order and collect the stretches spent off the origin. */
function collectExcursions(navs: NavigationRecord[], projectOrigin: string, endAtMs: number) {
  const excursions: OffProjectExcursion[] = [];
  let open: { fromMs: number; urls: string[] } | null = null;
  let foreignNavigations = 0;
  for (const nav of navs) {
    // An unreadable origin cannot be proven foreign or home: it neither opens nor closes a stretch.
    const origin = originOf(nav.url);
    if (origin === null) continue;
    if (origin !== projectOrigin) {
      foreignNavigations++;
      if (open) open.urls.push(nav.url);
      else open = { fromMs: nav.atMs, urls: [nav.url] };
      continue;
    }
    if (!open) continue;
    const durationMs = nav.atMs - open.fromMs;
    excursions.push({ fromMs: open.fromMs, toMs: nav.atMs, durationMs, returned: true, urls: open.urls });
    open = null;
  }
  if (open) {
    const toMs = Math.max(endAtMs, open.fromMs);
    excursions.push({ fromMs: open.fromMs, toMs, durationMs: toMs - open.fromMs, returned: false, urls: open.urls });
  }
  return { excursions, foreignNavigations };
}

const listExcursions = (ex: readonly OffProjectExcursion[]) =>
  ex
    .map((e) => {
      const end = `${Math.round(e.toMs)}ms (${e.returned ? "returned" : "never returned"})`;
      return `${Math.round(e.fromMs)}→${end}: ${e.urls.map((u) => u.slice(0, 120)).join(" → ")}`;
    })
    .join("; ");

/** Why the run did not stay on the project; empty when it did. */
function offProjectReasons(input: StayedOnProjectInput, excursions: readonly OffProjectExcursion[]): string[] {
  const neverReturned = excursions.filter((e) => !e.returned);
  const tooLong = excursions.filter((e) => e.returned && e.durationMs >= OFF_PROJECT_ALLOWANCE_MS);
  const reasons: string[] = [];
  if (neverReturned.length) {
    reasons.push(`the document left ${input.projectOrigin} and never came back (${listExcursions(neverReturned)})`);
  }
  if (tooLong.length) {
    reasons.push(
      `${tooLong.length} excursion(s) left the origin and came back (${listExcursions(tooLong)}); no bounce is allowed`,
    );
  }
  if (input.foreignSnapshots > 0) {
    const total = input.foreignSnapshots + input.sameOriginSnapshots;
    reasons.push(`${input.foreignSnapshots} of ${total} page-state snapshot(s) were read off the origin`);
  }
  return reasons;
}

/**
 * DID THE RUN STAY ON THE PROJECT? An L1 row: a run that left the project measured something else. A
 * stretch off the origin fails when it never came back, when it outlasted `OFF_PROJECT_ALLOWANCE_MS`
 * (zero here), or when any page-state snapshot was read while off the origin. `unknown` only when
 * there is no origin or nothing to read.
 */
export function stayedOnProject(input: StayedOnProjectInput): StayedOnProjectVerdict {
  const unknown = (detail: string): StayedOnProjectVerdict => ({
    result: CheckResult.Unknown,
    detail,
    excursions: [],
    foreignNavigations: 0,
  });
  if (!input.projectOrigin)
    return unknown("The project URL has no readable origin, so no navigation can be called foreign.");
  const navs = [...input.navigations].sort((a, b) => a.atMs - b.atMs);
  if (navs.length === 0 && input.foreignSnapshots === 0) {
    return unknown("No main-frame navigation was observed, so where the document sat was never read.");
  }
  const { excursions, foreignNavigations } = collectExcursions(navs, input.projectOrigin, input.endAtMs);
  const reasons = offProjectReasons(input, excursions);
  if (reasons.length) {
    return {
      result: CheckResult.Fail,
      detail: `The run did not stay on the project: ${reasons.join("; ")}. Every check measured while off the origin describes that page, not the project.`,
      excursions,
      foreignNavigations,
    };
  }
  const snapshots =
    input.sameOriginSnapshots > 0
      ? `every one of the ${input.sameOriginSnapshots} page-state snapshot(s) was read on that origin`
      : "no page-state snapshot came back to check against it";
  return {
    result: CheckResult.Pass,
    detail: `${navs.length} main-frame navigation(s) were observed and the document stayed on ${input.projectOrigin}; ${snapshots}.`,
    excursions,
    foreignNavigations,
  };
}

/* ----------------------------------------------------------- evidence frame */

/** One frame of the page, as the prober enumerates them before routing reads. */
export interface FrameCandidate {
  readonly url: string;
  readonly isTop: boolean;
  /** Largest canvas area in that frame; 0 for none. */
  readonly canvasArea: number;
}

/** Which frame the page-side reads target, and why. */
export interface EvidenceFrameChoice {
  /** Index into the input list, or `null` when reads stay on the top frame with no routing. */
  readonly index: number | null;
  readonly url: string | null;
  /** `null` when the frame's origin could not be read (about:srcdoc, about:blank). */
  readonly sameOrigin: boolean | null;
  /** True only when reads were moved off the top frame. */
  readonly routed: boolean;
  readonly why: string;
}

/** The origin of a frame URL; `null` for an opaque (`"null"`) or unreadable one. */
function frameOrigin(url: string): string | null {
  const origin = originOf(url);
  return origin === "null" ? null : origin;
}

/**
 * WHICH FRAME THE PAGE-SIDE READS TARGET. Reads move to the frame holding the largest canvas ONLY
 * when the top frame has none, and only when that frame is on the project's own origin; otherwise a
 * boot could pass on an embedded ad's pixels. An unreadable origin stays eligible (`sameOrigin: null`).
 */
export function chooseEvidenceFrame(frames: ReadonlyArray<FrameCandidate>, projectOrigin: string): EvidenceFrameChoice {
  const topIndex = frames.findIndex((f) => f.isTop);
  const top = topIndex === -1 ? null : frames[topIndex];
  if (top && top.canvasArea > 0) {
    return { index: topIndex, url: top.url, sameOrigin: true, routed: false, why: "the top frame holds a canvas" };
  }
  const children = frames.map((f, i) => ({ f, i })).filter(({ f }) => !f.isTop && f.canvasArea > 0);
  if (!children.length) {
    const index = top ? topIndex : null;
    return { index, url: top?.url ?? null, sameOrigin: true, routed: false, why: "no frame holds a canvas" };
  }
  const largest = children.reduce((a, b) => (b.f.canvasArea > a.f.canvasArea ? b : a));
  const origin = frameOrigin(largest.f.url);
  const foreign = Boolean(projectOrigin) && origin !== null && origin !== projectOrigin;
  if (foreign) {
    return {
      index: null,
      url: largest.f.url,
      sameOrigin: false,
      routed: false,
      why: `the top frame has no canvas and the largest canvas is in a CROSS-ORIGIN frame (${origin}, project ${projectOrigin}); refused as evidence — reads stay on the top frame`,
    };
  }
  const kind = origin === null ? "origin-less" : "same-origin";
  return {
    index: largest.i,
    url: largest.f.url,
    sameOrigin: origin === null ? null : true,
    routed: true,
    why: `the top frame has no canvas; reads routed to the ${kind} frame holding the largest canvas`,
  };
}

/* ------------------------------------------------------ fullscreen demotion */

/**
 * The instrument's `fullscreen` record, or absent on an older bundle. INSTRUMENT ONLY: nothing shims
 * this door. `granted` is read from `document.fullscreenElement`, never from a promise resolving.
 */
export type FullscreenState =
  | {
      readonly requested?: number;
      readonly granted?: boolean;
      readonly firstRequestAtMs?: number | null;
      readonly userActivationAtRequest?: boolean | null;
      readonly lastRefusal?: string | null;
    }
  | null
  | undefined;

/** Did the probe get stuck outside a fullscreen door? Only when the project asked and never got it. */
export function fullscreenBlocked(state: FullscreenState): boolean {
  const requested = state?.requested ?? 0;
  return requested > 0 && state?.granted !== true;
}

function activationClause(activation: boolean | null | undefined): string {
  if (activation === false) {
    return " with NO user activation live at the first call — a request a real browser refuses for every player, so this is worth reading as a defect in the project as well as a door the probe could not open";
  }
  return activation === true ? " with user activation live at the first call" : "";
}

/**
 * Demote a check that failed behind a refused fullscreen request. There is NO shim, on purpose: a project
 * asking for fullscreen without a gesture is refused for every real player too. Call sites apply it
 * only while the entrance is unconfirmed: fullscreen is presentation, not input.
 */
export function demoteForFullscreen(result: CheckResult, state: FullscreenState): Demotion {
  if (result !== CheckResult.Fail || !fullscreenBlocked(state)) return unchanged(result);
  const refusal = state?.lastRefusal ? ` (${state.lastRefusal})` : "";
  return {
    result: CheckResult.Unknown,
    why: `The project asked for fullscreen ${state?.requested ?? 0} time(s)${activationClause(state?.userActivationAtRequest)} and never got it${refusal}; the probe has no fullscreen shim, so whether the project went on past that door is unobserved and every input after it may have landed on the screen it shows while waiting. A project we could not ENTER must not be reported as a project that does not RESPOND; this row is unknown.`,
  };
}

/* ------------------------------------------------------------ the entrance */

/** The start control the finder named and what became of it. */
export interface StartControlSignal {
  readonly found: string | null;
  readonly clicked: boolean;
  /** Whether it was gone afterwards; `null` when not re-checked. */
  readonly gone: boolean | null;
  /** A visible control the finder could not reach, covered by an element of effective opacity 0. */
  readonly occluded?: { readonly text: string; readonly by: string } | null;
}

/** The press-any-key affordance, the keys sent for it and whether it went away. */
export interface PressAnyKeySignal {
  readonly affordance: string | null;
  readonly keysSent: readonly string[];
  readonly gone: boolean | null;
}

/**
 * What the entrance can WITNESS. There is deliberately no pixel-change field: a Space that makes the
 * player jump changes pixels too, so a diff can never say a door opened.
 */
export interface EntranceSignals {
  readonly startControl: StartControlSignal;
  readonly pressAnyKey: PressAnyKeySignal | null;
  /** The camera moved across the gesture (and was not already moving on its own). `null` unreadable. */
  readonly cameraMoved: boolean | null;
  /** A pointer lock (native or the shim's) was held after the gesture. `null` when the page never answered. */
  readonly pointerLockEngaged: boolean | null;
  /** The project asked for pointer lock at all. */
  readonly pointerLockRequested: boolean;
}

/** Whether the probe got in, through which door, and whether any door was seen. */
export interface EntranceVerdict {
  readonly confirmed: boolean;
  readonly by: EntranceVia;
  /** A door was OBSERVED (start control, press-any-key line, pointer-lock request), opened or not. */
  readonly doorObserved: boolean;
  readonly why: string;
}

function doorObservedIn(s: EntranceSignals): boolean {
  const control = s.startControl.found !== null || (s.startControl.occluded ?? null) !== null;
  return control || (s.pressAnyKey?.affordance ?? null) !== null || s.pointerLockRequested;
}

/** The witness that confirmed the entrance, strongest first; `null` when none did. */
function entranceWitness(s: EntranceSignals): { by: EntranceVia; why: string } | null {
  if (s.pointerLockEngaged === true) {
    return {
      by: EntranceVia.PointerLock,
      why: "a pointer lock was held after the gesture — the project took the probe in",
    };
  }
  const control = s.startControl;
  if (control.found !== null && control.clicked && control.gone === true) {
    return {
      by: EntranceVia.StartControl,
      why: `the start control "${control.found}" was clicked and was no longer on screen afterwards`,
    };
  }
  const key = s.pressAnyKey;
  if (key && key.affordance !== null && key.keysSent.length > 0 && key.gone === true) {
    return {
      by: EntranceVia.PressAnyKey,
      why: `the press-any-key line "${key.affordance}" was no longer on screen after ${key.keysSent.join(" then ")} went out`,
    };
  }
  if (s.cameraMoved === true) {
    return { by: EntranceVia.CameraMoved, why: "a camera sample moved across the gesture — the scene is being driven" };
  }
  return null;
}

function startControlStory(control: StartControlSignal): string | null {
  if (control.found !== null) {
    if (!control.clicked) return `the start control "${control.found}" was found and not clicked`;
    const after = control.gone === false ? "was STILL on screen afterwards" : "was not re-checked";
    return `the start control "${control.found}" was clicked and ${after}`;
  }
  if (!control.occluded) return null;
  return `the start control "${control.occluded.text}" is covered by an invisible element (${control.occluded.by}) — a hit test at its centre never reaches it, so it was not clicked`;
}

function pressAnyKeyStory(key: PressAnyKeySignal | null): string | null {
  if (!key || key.affordance === null) return null;
  if (!key.keysSent.length) {
    return `the press-any-key line "${key.affordance}" was found and no key went out for it (the focus guard refused)`;
  }
  const after = key.gone === false ? "was still on screen" : "was not re-checked";
  return `the press-any-key line "${key.affordance}" ${after} after ${key.keysSent.join(" then ")}`;
}

function cameraStory(moved: boolean | null): string {
  if (moved === false) return "no camera sample moved across the gesture";
  return moved === null ? "no camera could be read" : "the camera was not consulted";
}

/**
 * DID THE PROBE GET IN? Judged only from signals that can witness an entrance, in order of the
 * witness's strength: a pointer lock held after the gesture, the clicked start control gone, the
 * press-any-key line gone, a camera that moved across the gesture. Never from a pixel diff.
 */
export function judgeEntrance(s: EntranceSignals): EntranceVerdict {
  const doorObserved = doorObservedIn(s);
  const witness = entranceWitness(s);
  if (witness) return { confirmed: true, by: witness.by, doorObserved, why: witness.why };
  const parts = [startControlStory(s.startControl), pressAnyKeyStory(s.pressAnyKey)].filter(
    (p): p is string => p !== null,
  );
  if (s.pointerLockRequested) parts.push("the project asked for pointer lock and none was held after the gesture");
  parts.push(cameraStory(s.cameraMoved));
  const door = doorObserved ? "a door was observed and never seen to open" : "no door was observed";
  return { confirmed: false, by: EntranceVia.None, doorObserved, why: `${door}: ${parts.join("; ")}` };
}

/** A loading phrase still on screen at the end of the run. */
export interface StillLoading {
  readonly phrase: string;
  readonly progress: boolean;
}

/** Whether interaction was reached, and why. */
export interface InteractionReached {
  readonly reached: boolean;
  readonly why: string;
}

/**
 * WAS INTERACTION EVER REACHED? A confirmed entrance is the strong answer. With NO door observed, page
 * frames after the gesture are frames of whatever the project is (a project with no title screen has no
 * entrance to confirm). A door observed and never opened, a loader still on screen at the end, or no
 * post-gesture frame at all is interaction never reached.
 */
export function interactionReached(input: {
  readonly entrance: Pick<EntranceVerdict, "confirmed" | "doorObserved" | "why">;
  /** Page-source frames captured in a post-gesture phase (`POST_GESTURE_PHASES`). */
  readonly postGestureFrames: number;
  readonly stillLoading?: StillLoading | null;
}): InteractionReached {
  if (input.entrance.confirmed) return { reached: true, why: `the entrance was confirmed (${input.entrance.why})` };
  if (input.postGestureFrames === 0) {
    return { reached: false, why: "no page frame was captured in any post-gesture phase" };
  }
  if (input.stillLoading) {
    return {
      reached: false,
      why: `the page still read "${input.stillLoading.phrase}" at the end of the run — a loading screen the probe never got past, so every frame is of the loader`,
    };
  }
  if (!input.entrance.doorObserved) {
    return {
      reached: true,
      why: `no door was observed and ${input.postGestureFrames} page frame(s) were captured after the gesture — a project with no entrance to confirm`,
    };
  }
  return { reached: false, why: input.entrance.why };
}

/**
 * Demote an input-side row that failed on a project the probe never got INTO. The same one-directional
 * rule as the pointer-lock demotion. A crash is never routed here.
 */
export function demoteForNoInteraction(result: CheckResult, interaction: InteractionReached): Demotion {
  if (result !== CheckResult.Fail || interaction.reached) return unchanged(result);
  return {
    result: CheckResult.Unknown,
    why: `Interaction was never reached (${interaction.why}), so this row measured the screen the probe was stuck on, not the project. A project we could not ENTER must not be reported as a project that does not RESPOND; this row is unknown.`,
  };
}

/* ------------------------------------------------------- page-ran precondition */

/** Fewer requests than this and the page did not load a project: the document plus one sub-resource. */
export const RAN_REQUEST_FLOOR = 2;

/** Whether the page ran, and why not. */
export interface PageRan {
  readonly ran: boolean;
  readonly why: string | null;
}

/**
 * DID THE PAGE RUN AT ALL? The precondition a "nothing went wrong" row needs before it may PASS: a
 * page that never scheduled an animation frame produces zero errors by doing nothing. It gates the
 * pass branch only. `windowMs`, when given, also requires the last animation frame to sit past it.
 */
export function pageRan(obs: {
  readonly rafFrames: number;
  readonly requests: number;
  readonly lastRafPageMs: number | null;
  readonly windowMs?: number;
}): PageRan {
  if (obs.rafFrames <= 0) return { ran: false, why: "the page scheduled no animation frame" };
  if (obs.requests < RAN_REQUEST_FLOOR) {
    return {
      ran: false,
      why: `only ${obs.requests} network request(s) were observed, under the ${RAN_REQUEST_FLOOR} (document plus one sub-resource) a page that loaded a project makes`,
    };
  }
  const window = obs.windowMs;
  if (window === undefined) return { ran: true, why: null };
  const last = obs.lastRafPageMs;
  if (last !== null && last >= window) return { ran: true, why: null };
  const at = last === null ? "no readable time" : `${Math.round(last)}ms`;
  return {
    ran: false,
    why: `the page's last animation frame was at ${at} of page time, so the ${Math.round(window / SECOND_MS)}s window was not observed in full`,
  };
}

/* --------------------------------------------------------- exposure frames */

/** The phases whose page frames may feed the exposure sample. `look` is deliberately absent. */
export const EXPOSURE_PHASES: ReadonlySet<ProbePhase> = new Set([
  ProbePhase.Directions,
  ProbePhase.Ack,
  ProbePhase.Interact,
  ProbePhase.Soak,
  ProbePhase.InputBurst,
]);
/** The label of the frame taken right after the entrance gesture, which also feeds exposure. */
export const AFTER_GESTURE_LABEL = "after-gesture";
/** The fewest eligible frames a median can be called a measurement over. */
export const MIN_EXPOSURE_FRAMES = 3;
/** How many of the newest eligible frames are analysed. */
export const EXPOSURE_SAMPLE = 8;

/** A frame as `selectExposureFrames` reads it. */
export interface ExposureFrameLike {
  readonly atMs: number;
  readonly phase: ProbePhase;
  readonly label?: string;
  readonly source?: ShotKind;
}

/** Which frames `l3.visually_legible` may read, and why not when it cannot. */
export interface ExposureSelection<F extends ExposureFrameLike> {
  /** Page-source frames in an exposure phase (or the after-gesture frame). */
  readonly candidates: readonly F[];
  /** Candidates taken after the first witnessed non-degenerate draw. */
  readonly eligible: readonly F[];
  /** The newest `EXPOSURE_SAMPLE` of the eligible: what is analysed. */
  readonly chosen: readonly F[];
  readonly excludedLook: number;
  readonly excludedElement: number;
  /** Why the sample cannot answer, or `null` when it can. */
  readonly why: string | null;
}

/**
 * WHICH FRAMES `visually_legible` MAY READ. Element-source frames are out (no DOM HUD), look-phase
 * frames are out (the best-lit heading the prober hunted for, not what a player sees), frames before
 * the first witnessed draw are out (a loading card is not interaction), and fewer than
 * `MIN_EXPOSURE_FRAMES` eligible frames is no sample.
 */
export function selectExposureFrames<F extends ExposureFrameLike>(
  frames: ReadonlyArray<F>,
  firstRenderRunMs: number | null,
): ExposureSelection<F> {
  const isPage = (f: F) => !f.source || f.source === ShotKind.Page;
  const excludedElement = frames.filter((f) => !isPage(f)).length;
  const pageFrames = frames.filter(isPage);
  const excludedLook = pageFrames.filter((f) => f.phase === ProbePhase.Look).length;
  const candidates = pageFrames.filter(
    (f) => f.phase !== ProbePhase.Look && (EXPOSURE_PHASES.has(f.phase) || f.label === AFTER_GESTURE_LABEL),
  );
  const eligible = firstRenderRunMs === null ? [] : candidates.filter((f) => f.atMs > firstRenderRunMs);
  const counts = { candidates: candidates.length, eligible: eligible.length, excludedLook, excludedElement };
  return {
    candidates,
    eligible,
    chosen: eligible.slice(-EXPOSURE_SAMPLE),
    excludedLook,
    excludedElement,
    why: exposureShortfall(counts, firstRenderRunMs),
  };
}

function exposureShortfall(
  counts: { candidates: number; eligible: number; excludedLook: number; excludedElement: number },
  firstRenderRunMs: number | null,
): string | null {
  if (firstRenderRunMs === null) {
    return `no capture ever witnessed a non-degenerate draw, so no frame can be called a interaction frame (${counts.candidates} post-gesture page frame(s) were captured)`;
  }
  if (counts.eligible >= MIN_EXPOSURE_FRAMES) return null;
  const look = counts.excludedLook ? ` (${counts.excludedLook} look-phase frame(s) are excluded by design)` : "";
  const element = counts.excludedElement
    ? ` (${counts.excludedElement} canvas-element frame(s) are excluded: they omit the DOM HUD)`
    : "";
  return `only ${counts.eligible} page frame(s) in a post-gesture phase were captured after the first witnessed draw at ${Math.round(firstRenderRunMs)}ms of run time, under the ${MIN_EXPOSURE_FRAMES} a median needs to be a measurement${look}${element}`;
}

/* ------------------------------------------------- verb pixel control window */

/**
 * DID THE VERB'S PIXEL RESPONSE EXCEED WHAT THE SCREEN WAS DOING ANYWAY? Ambient motion clears an idle
 * threshold with no verb at all, so a pixel acknowledgement counts only when the response beat the
 * matched pre-verb control window's maximum. `null` when either is missing.
 */
export function verbPixelExceededControl(row: {
  readonly pixelDelta: number | null;
  readonly pixelControlMax?: number | null;
  readonly pixelControlSamples?: number;
}): boolean | null {
  if (row.pixelDelta === null) return null;
  const controlMax = row.pixelControlMax;
  if (typeof controlMax !== "number" || (row.pixelControlSamples ?? 0) <= 0) return null;
  return row.pixelDelta > controlMax;
}

/* ------------------------------------------------------ a screen that names its key */

/** "press E" / "hit [q]", but not a HUD legend such as "press E to interact". */
const NAMED_LETTER_KEY =
  /\b(?:press|hit|tap|hold)\s+(?:the\s+)?(?:\[)?([a-z])(?:\])?\b(?!\s*(?:key|button)?\s*(?:to|for)\s+(?:interact|talk|use|open|pick|grab|attack|jump|sprint|run))/g;

/**
 * The keys an entrance screen NAMES ("Esc resumes too", "press E"). Only the keys the text names,
 * only at the entrance, only after a click failed to open the door; Escape is allowed HERE and
 * nowhere else, because here the project itself asked for it.
 */
export function namedKeysIn(text: string): string[] {
  const t = text.toLowerCase();
  const keys = new Set<string>();
  if (/\b(esc|escape)\b/.test(t)) keys.add("Escape");
  if (/\b(enter|return)\b/.test(t)) keys.add("Enter");
  if (/\b(space|spacebar)\b/.test(t)) keys.add("Space");
  if (/\btab\b/.test(t)) keys.add("Tab");
  for (const m of t.matchAll(NAMED_LETTER_KEY)) keys.add(`Key${m[1].toUpperCase()}`);
  return [...keys];
}

/* ------------------------------------------------------------ can it be entered */

/** What `enterableVerdict` reads. */
export interface EnterableInput {
  readonly confirmed: boolean;
  readonly by: EntranceVia;
  readonly doorObserved: boolean;
  readonly startControl: StartControlSignal;
  readonly pressAnyKey: (PressAnyKeySignal & { readonly keysRefused: readonly string[] }) | null;
  readonly pointerLock: { readonly requested: boolean; readonly engaged: boolean | null };
  readonly fullscreen: { readonly requested: boolean; readonly granted: boolean | null };
}

/** `l2.enterable`'s verdict. */
export interface EnterableVerdict {
  readonly result: CheckResult;
  readonly why: string;
}

/** A door the probe could not operate: the answer is unknown, not fail. */
function untriedDoor(e: EnterableInput): string | null {
  if (e.fullscreen.requested && e.fullscreen.granted !== true) {
    return "the door asked for fullscreen, which a headless browser cannot grant and the probe deliberately does not fake — whether a player can enter is unobserved";
  }
  if (e.pointerLock.requested && e.pointerLock.engaged !== true) {
    return "the door asked for pointer lock and none was held afterwards, neither granted nor shimmed — whether a player can enter is unobserved";
  }
  if (e.startControl.found !== null && !e.startControl.clicked) {
    return `the start control "${e.startControl.found}" was found but the click never went out, so the door was never tried`;
  }
  const key = e.pressAnyKey;
  if (key && key.keysSent.length === 0 && key.keysRefused.length > 0) {
    return `the screen "${key.affordance}" names keys the focus guard refused to send (${key.keysRefused.join(", ")}), so the door was never tried`;
  }
  return null;
}

function movesTried(e: EnterableInput): string {
  const tried: string[] = [];
  if (e.startControl.found !== null && e.startControl.clicked) {
    tried.push(`clicked the start control "${e.startControl.found}"`);
  }
  tried.push("clicked the viewport centre");
  const key = e.pressAnyKey;
  if (key?.keysSent.length)
    tried.push(`pressed ${key.keysSent.join(" then ")} as the screen "${key.affordance}" asked`);
  if (key?.keysRefused.length) tried.push(`(${key.keysRefused.join(", ")} were refused by the focus guard)`);
  return tried.join(", ");
}

/**
 * CAN THE PROJECT BE ENTERED AT ALL? An L2 machine row. `fail` only when the probe made EVERY move a
 * player has and the door stayed shut, or when the start control sits under an invisible cover no
 * click can pass. Anything the probe could not do is `unknown`. A confirmed entrance, or no door at
 * all, is `pass`.
 */
export function enterableVerdict(e: EnterableInput): EnterableVerdict {
  if (e.confirmed) return { result: CheckResult.Pass, why: `the probe got in (${e.by})` };
  if (!e.doorObserved) {
    return {
      result: CheckResult.Pass,
      why: "no door was observed — the project had no entrance to open, and every input landed on the project itself",
    };
  }
  const occluded = e.startControl.found === null ? e.startControl.occluded : null;
  if (occluded) {
    return {
      result: CheckResult.Fail,
      why: `The project cannot be entered: its start control "${occluded.text}" is covered by an invisible element (${occluded.by}) — a hit test at the control's centre never reaches it, so no click, the probe's or a player's, can land on it.`,
    };
  }
  const untried = untriedDoor(e);
  if (untried) return { result: CheckResult.Unknown, why: untried };
  return {
    result: CheckResult.Fail,
    why: `The project cannot be entered: the probe ${movesTried(e)}, looked again after the gesture, and the same screen was still there with no camera sample moving. That is every move a player has. A project nobody can get into is not scored on what lies behind its door.`,
  };
}

/* ------------------------------------------------------------------ gates */

/**
 * The rows that decide a layer's gate. A row gates only when it could be measured here
 * (`gates !== false`): a row that is `unknown` because of the substrate (frame rate on a software
 * rasteriser), or that can never fail by construction, must not make a gate that cannot read `pass`.
 * Above L1 only machine rows gate; judge-owned rows are excluded.
 */
export function gatingRows(checks: readonly Check[], layer: CheckLayer): CheckResult[] {
  return checks
    .filter((c) => c.layer === layer)
    .filter((c) => layer === CheckLayer.L1 || c.source === CheckSource.Machine)
    .filter((c) => c.gates !== false)
    .map((c) => c.result);
}

/** The worst of a set of results; an EMPTY set is `unknown`. */
export function worstResult(results: readonly CheckResult[]): CheckResult {
  if (results.includes(CheckResult.Fail)) return CheckResult.Fail;
  if (results.includes(CheckResult.Unknown) || results.length === 0) return CheckResult.Unknown;
  return CheckResult.Pass;
}

/** The L1, L2 and L3 gates from a scorecard's rows alone. */
export function gateFor(checks: readonly Check[]): { l1: CheckResult; l2: CheckResult; l3: CheckResult } {
  return {
    l1: worstResult(gatingRows(checks, CheckLayer.L1)),
    l2: worstResult(gatingRows(checks, CheckLayer.L2)),
    l3: worstResult(gatingRows(checks, CheckLayer.L3)),
  };
}

/** `scored = l1 != fail && l2 != fail` (§8.2). */
export function isScored(gate: { l1: CheckResult; l2: CheckResult }): boolean {
  return gate.l1 !== CheckResult.Fail && gate.l2 !== CheckResult.Fail;
}
