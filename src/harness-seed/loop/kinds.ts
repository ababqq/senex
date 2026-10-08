/**
 * What kind of project this is — the one table nobody re-decides.
 *
 * Until this file the harness knew one project: the template's first-person walker. Every board
 * carried its screen rules, every input check read `player.x`/`player.z`/`player.yaw`, every
 * judge was told a place is what it is looking at, and a project the user brought — a chess board,
 * a builder, a side-scroller — failed checks about a player it does not have and collected
 * `[dead-input]` reports for controls it was never asked to answer.
 *
 * So a project says what it is. A kind carries five things and nothing else:
 *
 *  - `traits`: what the harness may assume (a HUD drawn into the canvas, mouse look, keys that
 *    move a player). EVERY trait is off until something declares it: a plan that says nothing
 *    gets a board with no screen rule, no look check and no movement check;
 *  - `look` / `move`: the state paths the two input checks read, so a top-down project is measured
 *    on the axes it actually moves on;
 *  - `eyes`: whether an eye camera (the player's own view) is worth photographing;
 *  - `critic`: `place` for a world a player walks through, `screen` for a project that is a screen
 *    to read (a board, a side-on level);
 *  - `script`: the controls the harness drives before every judgement, so two builds are
 *    compared on the same inputs and the judge is told which ones.
 *
 * A ninth kind is a change to this table and nothing else.
 */
import { HostMethod } from "./host-methods.ts";
import { CLIP_QUOTE, clip } from "./text.ts";
import { CONTROL_EXERCISE, type PlayAction } from "./play-script.ts";
import { SECOND_MS } from "./time.ts";
import { isPlainRecord } from "./json.ts";
import { MAX_ACTION_MS, MAX_PLAY_SCRIPT } from "./config.ts";
import type { AnyRecord, HarnessCtx } from "../types/harness.d.ts";
import type { ProjectImageRead } from "../types/host-api.d.ts";

/** The play-script cap lives with the loop's other shared numbers (config.ts); exported here too, for the files that import it from here. */
export { MAX_PLAY_SCRIPT } from "./config.ts";

/** What a declared hold or wait lasts when it says nothing (the longest is `MAX_ACTION_MS`). */
const HOLD_DEFAULT_MS = 400;
const WAIT_DEFAULT_MS = 100;
/** The longest camera name a script may switch to. */
const CAMERA_NAME_CHARS = 60;
/** The most keys one tap or hold may press together. */
const MAX_ACTION_KEYS = 8;
/** How much of who declared the project (`declaredBy`) studio.json keeps. */
const DECLARED_BY_CHARS = 80;

/** A kind of project: the phrase a judge is given, and what the harness does for it. */
export interface AppKind {
  says: string;
  traits: { hud: boolean; mouseLook: boolean; keyboardMove: boolean };
  look: string[];
  move: string[];
  eyes: boolean;
  critic: string;
  script: PlayAction[];
}

/**
 * The traits a project may declare, each of which puts the harness's own check for it on the board.
 * studio.json and plans keep them by these names: never rename a value.
 */
export const AppTrait = {
  Hud: "hud",
  MouseLook: "mouseLook",
  KeyboardMove: "keyboardMove",
} as const;
export type AppTrait = (typeof AppTrait)[keyof typeof AppTrait];

/** What the harness may assume about a project, every trait decided. */
export interface AppTraits {
  kind: string | null;
  hud: boolean;
  mouseLook: boolean;
  keyboardMove: boolean;
  playScript: PlayAction[] | null;
}

/** One of the two input checks: the state paths it reads, its expression and its note. */
export interface InputProbe {
  paths: string[];
  expr: string;
  note: string;
}

/** The controls a keyboard-moved project is driven with when it declares no script of its own. */
const KEYS_EXERCISE: PlayAction[] = [
  { type: "hold", keys: ["w", "ArrowUp"], ms: 1200 },
  { type: "hold", keys: ["a", "ArrowLeft"], ms: 800 },
  { type: "tap", keys: ["space"] },
];

const RACING_EXERCISE: PlayAction[] = [
  { type: "hold", keys: ["w", "ArrowUp"], ms: 1600 },
  { type: "hold", keys: ["a", "ArrowLeft"], ms: 600 },
  { type: "hold", keys: ["w", "ArrowUp"], ms: 800 },
];

// The look action is not decoration: flight names a look axis, so a plan that declares
// `mouseLook: true` on a flight project must have something for the check to measure.
const FLIGHT_EXERCISE: PlayAction[] = [
  { type: "hold", keys: ["w", "ArrowUp"], ms: 1200 },
  { type: "look", dx: 40, dy: -12 },
  { type: "hold", keys: ["a", "ArrowLeft"], ms: 600 },
];

const SIDE_EXERCISE: PlayAction[] = [
  { type: "hold", keys: ["d", "ArrowRight"], ms: 1200 },
  { type: "tap", keys: ["space"] },
  { type: "hold", keys: ["a", "ArrowLeft"], ms: 600 },
];

const BOARD_EXERCISE: PlayAction[] = [
  { type: "click", x: 0.5, y: 0.5 },
  { type: "wait", ms: 300 },
  { type: "drag", fromX: 0.4, fromY: 0.6, x: 0.6, y: 0.4 },
  { type: "wait", ms: 300 },
];

const CAMERA_EXERCISE: PlayAction[] = [
  { type: "drag", fromX: 0.35, fromY: 0.5, x: 0.65, y: 0.5 },
  { type: "scroll", dx: 0, dy: -240 },
  { type: "wait", ms: 300 },
  { type: "drag", fromX: 0.5, fromY: 0.4, x: 0.5, y: 0.6 },
];

/** The eight kinds. `says` is the phrase every judge is given; the rest is what the harness does. */
export const APP_KINDS: Record<string, AppKind> = {
  "first-person": {
    says: "a first-person project — the camera is the player's own eyes",
    traits: { hud: true, mouseLook: true, keyboardMove: true },
    look: ["player.yaw"],
    move: ["player.x", "player.z"],
    eyes: true,
    critic: "place",
    script: CONTROL_EXERCISE,
  },
  "third-person": {
    says: "a third-person project — a camera behind a character the player steers",
    traits: { hud: true, mouseLook: true, keyboardMove: true },
    look: ["player.yaw"],
    move: ["player.x", "player.z"],
    eyes: true,
    critic: "place",
    script: CONTROL_EXERCISE,
  },
  "top-down": {
    says: "a top-down project — the camera looks down on a world the player moves through",
    // A top-down project is 3D-isometric on x/z as often as it is 2D on x/y; one expression
    // covers both, so nobody has to guess which one this project chose.
    traits: { hud: true, mouseLook: false, keyboardMove: true },
    look: [],
    move: ["player.x", "player.y", "player.z"],
    eyes: false,
    critic: "place",
    script: KEYS_EXERCISE,
  },
  "side-2d": {
    says: "a side-on project — one plane, seen from the side",
    traits: { hud: false, mouseLook: false, keyboardMove: true },
    look: [],
    move: ["player.x", "player.y"],
    eyes: false,
    critic: "screen",
    script: SIDE_EXERCISE,
  },
  racing: {
    says: "a racing project — a vehicle the player drives along a course",
    traits: { hud: true, mouseLook: false, keyboardMove: true },
    look: [],
    move: ["player.x", "player.z", "player.y"],
    eyes: false,
    critic: "place",
    script: RACING_EXERCISE,
  },
  flight: {
    says: "a flight project — a craft the player pitches and turns through open space",
    traits: { hud: true, mouseLook: false, keyboardMove: true },
    look: ["player.pitch", "player.yaw"],
    move: ["player.x", "player.y", "player.z"],
    eyes: false,
    critic: "place",
    script: FLIGHT_EXERCISE,
  },
  "static-board": {
    says: "a board project on one screen — pieces on a board, not a world a player walks through",
    // No HUD rule: a board project's interface is the most likely of all to be real DOM or React,
    // and the template's canvas-only screen rule would fail it for existing.
    traits: { hud: false, mouseLook: false, keyboardMove: false },
    look: [],
    move: [],
    eyes: false,
    critic: "screen",
    script: BOARD_EXERCISE,
  },
  "free-camera": {
    says: "a free-camera project — the player orbits and builds rather than walks",
    traits: { hud: false, mouseLook: false, keyboardMove: false },
    look: [],
    move: [],
    eyes: false,
    critic: "place",
    script: CAMERA_EXERCISE,
  },
};

/** The eight names, in the order a planner should read them. */
export const KIND_NAMES = Object.keys(APP_KINDS);

export function isAppKind(value: unknown): value is string {
  return typeof value === "string" && Object.hasOwn(APP_KINDS, value);
}

/**
 * What the harness may assume about a project. Absent fields default to OFF — a plan that
 * declares nothing gets a board with no screen rule and no input checks. A declared kind IS a
 * declaration and supplies that kind's traits; an explicit boolean beside it still wins.
 */
export function normalizeAppTraits(raw: AnyRecord | null | undefined): AppTraits {
  const kind = isAppKind(raw?.kind) ? String(raw!.kind) : null;
  const base = kind ? APP_KINDS[kind]!.traits : { hud: false, mouseLook: false, keyboardMove: false };
  const flag = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);
  return {
    kind,
    hud: flag(raw?.hud ?? raw?.ui, base.hud),
    mouseLook: flag(raw?.mouseLook ?? raw?.mouse, base.mouseLook),
    keyboardMove: flag(raw?.keyboardMove ?? raw?.keys, base.keyboardMove),
    playScript: normalizePlayScript(raw?.playScript ?? raw?.play),
  };
}

/** A pointer at a spot: a click (which may name its button) or a move (which needs both coordinates). */
function pointerAction(type: "click" | "move", raw: AnyRecord): PlayAction | null {
  const x = number(raw.x, null);
  const y = number(raw.y, null);
  const unplaced = x === null || y === null;
  if (type === "move" && unplaced) return null;
  return {
    type,
    ...(x === null ? {} : { x }),
    ...(y === null ? {} : { y }),
    ...(raw.px === true ? { px: true } : {}),
    ...(type === "click" && raw.button ? { button: String(raw.button) } : {}),
  };
}

/** A drag from one spot to another; every coordinate is needed. */
function dragAction(raw: AnyRecord): PlayAction | null {
  const fromX = number(raw.fromX, null);
  const fromY = number(raw.fromY, null);
  const x = number(raw.x ?? raw.toX, null);
  const y = number(raw.y ?? raw.toY, null);
  if (fromX === null || fromY === null) return null;
  if (x === null || y === null) return null;
  return {
    type: "drag",
    fromX,
    fromY,
    x,
    y,
    ...(raw.px === true ? { px: true } : {}),
    ...(raw.button ? { button: String(raw.button) } : {}),
  };
}

/** Each action a script may declare, as the harness will drive it — or null for one it cannot. */
const ACTIONS: Record<string, (raw: AnyRecord) => PlayAction | null> = {
  hold: (raw) => {
    const keys = asKeys(raw.keys ?? raw.key);
    return keys.length ? { type: "hold", keys, ms: clamp(raw.ms ?? HOLD_DEFAULT_MS, 0, MAX_ACTION_MS) } : null;
  },
  tap: (raw) => {
    const keys = asKeys(raw.keys ?? raw.key);
    return keys.length ? { type: "tap", keys } : null;
  },
  look: (raw) => ({ type: "look", dx: number(raw.dx, 0), dy: number(raw.dy, 0) }),
  click: (raw) => pointerAction("click", raw),
  drag: dragAction,
  move: (raw) => pointerAction("move", raw),
  scroll: (raw) => ({ type: "scroll", dx: number(raw.dx, 0), dy: number(raw.dy, 0) }),
  wait: (raw) => ({ type: "wait", ms: clamp(raw.ms ?? WAIT_DEFAULT_MS, 0, MAX_ACTION_MS) }),
  camera: (raw) => {
    const name = typeof raw.name === "string" ? raw.name.trim().slice(0, CAMERA_NAME_CHARS) : "";
    return name ? { type: "camera", name } : null;
  },
};

const PLAY_ACTIONS = new Set<string>(Object.keys(ACTIONS));

/**
 * A declared play script, as the harness will drive it. `step`, `pause`, `start` and
 * `screenshot` are dropped on purpose: the studio owns the clock and the evidence, and a plan
 * must not pause the project in the middle of the pass that judges it.
 */
export function normalizePlayScript(raw: unknown): PlayAction[] | null {
  let source = raw;
  if (typeof source === "string") {
    const text = source.trim();
    if (!text) return null;
    try {
      source = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (isPlainRecord(source)) source = [source];
  if (!Array.isArray(source)) return null;
  const actions: PlayAction[] = [];
  for (const item of source) {
    if (actions.length >= MAX_PLAY_SCRIPT) break;
    const action = normalizeAction(item);
    if (action) actions.push(action);
  }
  return actions.length ? actions : null;
}

function normalizeAction(raw: AnyRecord): PlayAction | null {
  const type = typeof raw?.type === "string" ? raw.type.trim() : "";
  if (!PLAY_ACTIONS.has(type)) return null;
  return ACTIONS[type](raw);
}

/**
 * The controls the harness drives before this project is judged. Null-safe on purpose: evidence
 * is gathered from many places that have no declared project at all — the build smoke, the
 * director's own first look, a spike, the classic loop — and every one of them must keep
 * working exactly as it does today.
 */
export function playScriptFor(app: { playScript?: unknown; kind?: string | null } | null | undefined): PlayAction[] {
  return normalizePlayScript(app?.playScript) ?? APP_KINDS[app?.kind as string]?.script ?? CONTROL_EXERCISE;
}

/** The play script in words, so a judge knows which controls were driven before it looked. */
export function describePlayScript(script: unknown): string {
  const actions = Array.isArray(script) ? script.slice(0, MAX_PLAY_SCRIPT) : [];
  const clauses = actions.map(clauseFor).filter(Boolean);
  return clauses.join(", ");
}

function clauseFor(action: PlayAction | null | undefined): string {
  const type = action?.type;
  // A type was read, so there is an action.
  if (type === "hold") return `hold ${keyList(action!.keys)} for ${seconds(action!.ms ?? 400)}`;
  if (type === "tap") return `tap ${keyList(action!.keys)}`;
  if (type === "look") return `look ${lookWords(action!.dx, action!.dy)}`;
  if (type === "click") return `click ${at(action!.x, action!.y)}`;
  if (type === "drag") return `drag from ${at(action!.fromX, action!.fromY)} to ${at(action!.x, action!.y)}`;
  if (type === "move") return `move the pointer to ${at(action!.x, action!.y)}`;
  if (type === "scroll") return `scroll ${number(action!.dx, 0)}, ${number(action!.dy, 0)}`;
  if (type === "wait") return `wait ${seconds(action!.ms ?? 100)}`;
  if (type === "camera") return `switch to the ${action!.name} camera`;
  return "";
}

/** A single-character key reads as the letter on the keyboard; a named key reads as it is given. */
function printKey(key: unknown): string {
  const text = String(key ?? "");
  return text.length === 1 ? text.toUpperCase() : text;
}

function keyList(keys: unknown): string {
  const list = Array.isArray(keys) ? keys.map(printKey).filter(Boolean) : [];
  return list.length ? list.join("/") : "nothing";
}

function lookWords(dx: unknown, dy: unknown): string {
  const x = number(dx, 0);
  const y = number(dy, 0);
  const parts: string[] = [];
  if (x) parts.push(`${Math.abs(x)} px ${x > 0 ? "right" : "left"}`);
  if (y) parts.push(`${Math.abs(y)} px ${y > 0 ? "down" : "up"}`);
  return parts.length ? parts.join(" and ") : "nowhere";
}

function at(x: unknown, y: unknown): string {
  if (x === undefined && y === undefined) return "the middle of the view";
  return `(${number(x, 0)}, ${number(y, 0)})`;
}

function seconds(ms: unknown): string {
  const n = clamp(ms, 0, MAX_ACTION_MS);
  return n >= SECOND_MS ? `${(n / SECOND_MS).toFixed(1)}s` : `${Math.round(n)} ms`;
}

/**
 * The one sentence every judge is given about the project in front of it: what kind it is, which
 * controls the harness drove before the shots were taken, and which state paths are the
 * evidence that those controls reached something.
 *
 * The retraction matters as much as the description. A board project and a builder have no player
 * the studio can measure, so an empty input-evidence list would invite exactly the
 * `[dead-input]` report this line exists to prevent: it says the class does not apply.
 */
export function appLine(app: AnyRecord | null | undefined): string {
  const traits = normalizeAppTraits(app);
  const kind = traits.kind ? APP_KINDS[traits.kind] : null;
  const script = playScriptFor(traits);
  const drove = describePlayScript(script);
  const drives = drove ? ` Before every judgement the harness drives the same controls: ${drove}.` : "";
  if (!kind) {
    if (!traits.playScript) return "";
    return `PROJECT: nothing declared what kind of project this is.${drives}`;
  }
  const paths = [...kind.look, ...kind.move];
  // `kind && look.length === 0 && move.length === 0` — the shape of this test is the whole
  // point: a project with no measurable player must be told about, not given an empty list.
  if (paths.length === 0) {
    return `PROJECT: ${kind.says}.${drives} This project has no player the studio can measure, so the artefact class [dead-input] does not apply — do not report it.`;
  }
  return `PROJECT: ${kind.says}.${drives} The input evidence is ${paths.join(", ")} in __studio.state() — report [dead-input] only if those are unchanged.`;
}

/** `place` for a world a player walks through, `screen` for a project that is a screen to read. */
export function criticFor(app: AnyRecord | null | undefined): string {
  const kind = normalizeAppTraits(app).kind;
  return APP_KINDS[kind as string]?.critic ?? "place";
}

/**
 * The template's own axes — what an undeclared project is still measured on, and what a declared
 * kind with no axis of its own falls back to. Written `abs(delta(path)) > 0` for the reason
 * given below lookProbe: a project that reports no player must not pass an identity check.
 */
const TEMPLATE_PROBES: { look: InputProbe; move: InputProbe } = {
  look: {
    paths: ["player.yaw"],
    expr: "abs(delta('player.yaw')) > 0.01",
    note: "harness-owned: after the scripted look (56 px right) player().yaw changed — the mouse path from ctx.look to the camera works",
  },
  move: {
    paths: ["player.x", "player.z"],
    expr: "abs(delta('player.x')) > 0 || abs(delta('player.z')) > 0",
    note: "harness-owned: after the scripted W/A hold player().x or .z changed — the key path from ctx.keys to the controller works",
  },
};

/**
 * The two input checks' expressions, on the axes this kind actually moves on.
 *
 * A declared trait whose kind names no axis falls back to the template's axes rather than
 * dropping the check: "declare mouseLook: true" is the documented remedy for a mouse-steered
 * racer, and a remedy that silently does nothing is worse than no remedy.
 */
export function inputProbesFor(app: AnyRecord | null | undefined): { look: InputProbe; move: InputProbe } {
  const kind = normalizeAppTraits(app).kind;
  const entry = kind ? APP_KINDS[kind] : null;
  return {
    look: entry?.look.length ? lookProbe(entry.look) : TEMPLATE_PROBES.look,
    move: entry?.move.length ? moveProbe(entry.move) : TEMPLATE_PROBES.move,
  };
}

// `abs(delta(path)) > 0` and not `delta(path) != 0`: an axis the project does not report reads
// undefined, and `undefined != 0` is true — the check would pass on a project with no player at all.
function lookProbe(paths: string[]): InputProbe {
  return {
    paths,
    expr: paths.map((path) => `abs(delta('${path}')) > 0.01`).join(" || "),
    note: `harness-owned: after the scripted look ${paths.join(" or ")} changed — the mouse path reaches the camera`,
  };
}

function moveProbe(paths: string[]): InputProbe {
  return {
    paths,
    expr: paths.map((path) => `abs(delta('${path}')) > 0`).join(" || "),
    note: `harness-owned: after the scripted keys ${paths.join(" or ")} changed — the key path reaches the player`,
  };
}

/** Whether an eye camera — the player's own view — is worth photographing for this kind. */
export function wantsEyeCameras(app: AnyRecord | null | undefined): boolean {
  const kind = normalizeAppTraits(app).kind;
  // An undeclared project keeps today's behaviour: the eyes are looked for, and a project that has
  // none simply reports none.
  return APP_KINDS[kind as string]?.eyes ?? true;
}

/**
 * The third declaration source: the `project` block inside the project's own studio.json. The
 * top-level `kind` there is the project SHAPE (three-modules, three-vite) and is never read
 * as a project kind.
 */
export async function readDeclaredApp(ctx: HarnessCtx, project: string): Promise<AppTraits | null> {
  const meta = await readStudioJson(ctx, project);
  const block = meta?.json?.app ?? meta?.json?.game;
  if (!block || typeof block !== "object") return null;
  const app = normalizeAppTraits(block);
  return app.kind || app.playScript ? app : null;
}

/**
 * Write the declared kind back into studio.json, once a night, read-modify-write. The file is
 * the user's; every key it already has survives, and a studio.json that cannot be read or
 * parsed is left exactly as it is rather than replaced by ours.
 */
export async function writeDeclaredApp(
  ctx: HarnessCtx,
  project: string,
  app: AnyRecord | null | undefined,
  { from = "the plan" }: { from?: string } = {},
): Promise<{ written: boolean; reason?: string; app?: AnyRecord }> {
  const traits = normalizeAppTraits(app);
  if (!traits.kind && !traits.playScript) return { written: false, reason: "nothing was declared" };
  const meta = await readStudioJson(ctx, project);
  if (!isPlainRecord(meta?.json)) {
    return { written: false, reason: "studio.json could not be read" };
  }
  const block = {
    ...(traits.kind ? { kind: traits.kind } : {}),
    hud: traits.hud,
    mouseLook: traits.mouseLook,
    keyboardMove: traits.keyboardMove,
    ...(traits.playScript ? { playScript: traits.playScript } : {}),
    declaredBy: String(from).slice(0, DECLARED_BY_CHARS),
  };
  const current = meta.json.app;
  if (current && JSON.stringify(current) === JSON.stringify(block)) return { written: false, reason: "unchanged" };
  const contents = `${JSON.stringify({ ...meta.json, app: block }, null, 2)}\n`;
  try {
    await ctx.call(HostMethod.ProjectWrite, { project, file: "studio.json", contents });
  } catch (err: any) {
    return {
      written: false,
      reason: `studio.json could not be written: ${clip(String(err?.message ?? err), CLIP_QUOTE)}`,
    };
  }
  return { written: true, app: block };
}

async function readStudioJson(ctx: HarnessCtx, project: string): Promise<{ json: any } | null> {
  let text: string | ProjectImageRead;
  try {
    text = await ctx.call(HostMethod.ProjectRead, { project, file: "studio.json" });
  } catch {
    return null;
  }
  const body = typeof text === "string" ? text : ((text as { text?: string } | null)?.text ?? "");
  try {
    return { json: JSON.parse(body) };
  } catch {
    return null;
  }
}

function asKeys(raw: unknown): string[] {
  if (Array.isArray(raw))
    return raw
      .map((key) => String(key))
      .filter(Boolean)
      .slice(0, MAX_ACTION_KEYS);
  if (raw == null || raw === "") return [];
  return [String(raw)];
}

function number<T>(value: unknown, fallback: T): number | T {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: unknown, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
