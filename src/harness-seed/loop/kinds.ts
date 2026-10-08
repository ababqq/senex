/**
 * What kind of software this is — the one table nobody re-decides.
 *
 * A harness that knows one kind of project judges every other kind by its rules: a form
 * collects reports about controls it was never meant to answer, a dashboard fails checks about a
 * camera, a utility is told to look for a world. So a project says what it is. A kind carries
 * these things and nothing else:
 *
 *  - `traits`: what the harness may assume (DOM UI it can inspect, views to move between, fields
 *    to type into; for a canvas, a mouse-looked camera and keys that move a player). EVERY trait
 *    is off until something declares it: a plan that says nothing gets a board with no screen
 *    rule, no navigation check and no typing check;
 *  - `navigate` / `edit` / `look` / `move`: the state paths the input checks read, so a content
 *    site is measured on its address, a form on its fields and a walkable scene on its player;
 *  - `eyes`: whether an eye camera (a player's own view) is worth photographing — only a
 *    project with a first-person world has one;
 *  - `critic`: `place` for a world a person moves through, `screen` for software that is a
 *    screen to read and operate;
 *  - `script`: the controls the harness drives before every judgement, so two builds are
 *    compared on the same inputs and the judge is told which ones.
 *
 * A ninth kind is a change to this table and nothing else.
 */
import { HostMethod } from "./host-methods.ts";
import { CLIP_QUOTE, clip } from "./text.ts";
import { CONTROL_EXERCISE, WALK_EXERCISE, type PlayAction } from "./play-script.ts";
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
/** The most text one typing action may enter, and the longest key chord one press may name. */
const MAX_TYPED_CHARS = 200;
const MAX_COMBO_CHARS = 40;
/** The most times one press may repeat. */
const MAX_PRESS_REPEAT = 20;
/** How much of who declared the project (`declaredBy`) studio.json keeps. */
const DECLARED_BY_CHARS = 80;

/** A kind of project: the phrase a judge is given, and what the harness does for it. */
export interface AppKind {
  says: string;
  traits: { ui: boolean; navigation: boolean; typing: boolean; mouseLook: boolean; keyboardMove: boolean };
  navigate: string[];
  edit: string[];
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
  Ui: "ui",
  Navigation: "navigation",
  Typing: "typing",
  MouseLook: "mouseLook",
  KeyboardMove: "keyboardMove",
} as const;
export type AppTrait = (typeof AppTrait)[keyof typeof AppTrait];

/** What the harness may assume about a project, every trait decided. */
export interface AppTraits {
  kind: string | null;
  ui: boolean;
  navigation: boolean;
  typing: boolean;
  mouseLook: boolean;
  keyboardMove: boolean;
  playScript: PlayAction[] | null;
}

/** One of the four input checks: the state paths it reads, its expression and its note. */
export interface InputProbe {
  paths: string[];
  expr: string;
  note: string;
}

/** What the studio's page layer counts on every page (`src/page/ui-activity.ts`): the evidence the inputs landed. */
const NAVIGATION_PATHS = ["ui.navigations", "ui.reactions"];
const EDIT_PATHS = ["ui.edits"];
/** What a scene's `player()` reports, for a canvas project a person walks and looks around in. */
const LOOK_PATHS = ["player.yaw"];
const MOVE_PATHS = ["player.x", "player.z"];

/** Click a spot, type into whatever took focus, move on with Tab, submit with Return. */
const FORM_EXERCISE: PlayAction[] = [
  { type: "click", x: 0.5, y: 0.35 },
  { type: "type", text: "Ada Lovelace" },
  { type: "press", combo: "Tab" },
  { type: "type", text: "ada@example.com" },
  { type: "press", combo: "Tab" },
  { type: "press", combo: "Return" },
  { type: "wait", ms: 300 },
];

/** Add an item, add another, then touch the first one. */
const LIST_EXERCISE: PlayAction[] = [
  { type: "click", x: 0.5, y: 0.2 },
  { type: "type", text: "Buy milk" },
  { type: "press", combo: "Return" },
  { type: "wait", ms: 200 },
  { type: "type", text: "Call Ada" },
  { type: "press", combo: "Return" },
  { type: "wait", ms: 200 },
  { type: "click", x: 0.4, y: 0.35 },
  { type: "wait", ms: 200 },
];

/** Move between the views a dashboard offers, change a filter, read down the page. */
const DASHBOARD_EXERCISE: PlayAction[] = [
  { type: "click", x: 0.12, y: 0.3 },
  { type: "wait", ms: 300 },
  { type: "click", x: 0.5, y: 0.25 },
  { type: "press", combo: "Tab", repeat: 2 },
  { type: "scroll", dx: 0, dy: 400 },
  { type: "wait", ms: 200 },
];

/** Read down a page, follow the first link the keyboard reaches, come back up. */
const SITE_EXERCISE: PlayAction[] = [
  { type: "scroll", dx: 0, dy: 600 },
  { type: "wait", ms: 200 },
  { type: "press", combo: "Tab", repeat: 2 },
  { type: "press", combo: "Return" },
  { type: "wait", ms: 300 },
  { type: "scroll", dx: 0, dy: -600 },
];

/** Make a mark on the canvas or document, type into it, take it back. */
const EDITOR_EXERCISE: PlayAction[] = [
  { type: "click", x: 0.5, y: 0.5 },
  { type: "type", text: "Hello" },
  { type: "drag", fromX: 0.3, fromY: 0.4, x: 0.6, y: 0.6 },
  { type: "wait", ms: 200 },
  { type: "press", combo: "ctrl+z" },
];

/** Hover a mark, zoom, pan. */
const EXPLORE_EXERCISE: PlayAction[] = [
  { type: "move", x: 0.5, y: 0.5 },
  { type: "wait", ms: 200 },
  { type: "move", x: 0.6, y: 0.55 },
  { type: "scroll", dx: 0, dy: -240 },
  { type: "drag", fromX: 0.4, fromY: 0.5, x: 0.6, y: 0.5 },
];

/** Give a tool its inputs and ask for the result. */
const UTILITY_EXERCISE: PlayAction[] = [
  { type: "click", x: 0.5, y: 0.4 },
  { type: "type", text: "42" },
  { type: "press", combo: "Tab" },
  { type: "type", text: "7" },
  { type: "press", combo: "Return" },
  { type: "wait", ms: 300 },
];

/** The eight kinds. `says` is the phrase every judge is given; the rest is what the harness does. */
export const APP_KINDS: Record<string, AppKind> = {
  dashboard: {
    says: "a dashboard — tables, charts and filters over data, with views to move between",
    traits: { ui: true, navigation: true, typing: false, mouseLook: false, keyboardMove: false },
    navigate: NAVIGATION_PATHS,
    edit: EDIT_PATHS,
    look: [],
    move: [],
    eyes: false,
    critic: "screen",
    script: DASHBOARD_EXERCISE,
  },
  "form-flow": {
    says: "a form flow — fields, validation and a submit, possibly over several steps",
    traits: { ui: true, navigation: false, typing: true, mouseLook: false, keyboardMove: false },
    navigate: NAVIGATION_PATHS,
    edit: EDIT_PATHS,
    look: [],
    move: [],
    eyes: false,
    critic: "screen",
    script: FORM_EXERCISE,
  },
  "list-manager": {
    says: "a list manager — items the user adds, edits, completes and removes",
    traits: { ui: true, navigation: false, typing: true, mouseLook: false, keyboardMove: false },
    navigate: NAVIGATION_PATHS,
    edit: EDIT_PATHS,
    look: [],
    move: [],
    eyes: false,
    critic: "screen",
    script: LIST_EXERCISE,
  },
  "content-site": {
    says: "a content site — pages to read and links between them",
    traits: { ui: true, navigation: true, typing: false, mouseLook: false, keyboardMove: false },
    navigate: NAVIGATION_PATHS,
    edit: EDIT_PATHS,
    look: [],
    move: [],
    eyes: false,
    critic: "screen",
    script: SITE_EXERCISE,
  },
  editor: {
    says: "an editor or builder — a document or canvas the user changes with pointer and keyboard",
    traits: { ui: true, navigation: false, typing: true, mouseLook: false, keyboardMove: false },
    navigate: NAVIGATION_PATHS,
    edit: EDIT_PATHS,
    look: [],
    move: [],
    eyes: false,
    critic: "screen",
    script: EDITOR_EXERCISE,
  },
  "data-viz": {
    says: "an interactive visualisation — a chart, map or diagram the user explores",
    traits: { ui: true, navigation: false, typing: false, mouseLook: false, keyboardMove: false },
    navigate: NAVIGATION_PATHS,
    edit: EDIT_PATHS,
    look: [],
    move: [],
    eyes: false,
    critic: "screen",
    script: EXPLORE_EXERCISE,
  },
  utility: {
    says: "a small utility — inputs in, a result out",
    traits: { ui: true, navigation: false, typing: true, mouseLook: false, keyboardMove: false },
    navigate: NAVIGATION_PATHS,
    edit: EDIT_PATHS,
    look: [],
    move: [],
    eyes: false,
    critic: "screen",
    script: UTILITY_EXERCISE,
  },
  graphics: {
    says: "an interactive graphics project — a canvas the user steers with keyboard and pointer, a game or a 3D scene",
    // No screen rule and no DOM input check: a canvas has no DOM to name and no field to type into.
    // A walkable scene opts in to the look and move checks by declaring `mouseLook` / `keyboardMove`.
    traits: { ui: false, navigation: false, typing: false, mouseLook: false, keyboardMove: false },
    navigate: [],
    edit: [],
    look: LOOK_PATHS,
    move: MOVE_PATHS,
    eyes: false,
    critic: "place",
    script: WALK_EXERCISE,
  },
};

/** The names, in the order a planner should read them. */
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
  const base = kind
    ? APP_KINDS[kind]!.traits
    : { ui: false, navigation: false, typing: false, mouseLook: false, keyboardMove: false };
  const flag = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);
  return {
    kind,
    ui: flag(raw?.ui, base.ui),
    navigation: flag(raw?.navigation ?? raw?.nav, base.navigation),
    typing: flag(raw?.typing, base.typing),
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
  type: (raw) => {
    const typed = typeof raw.text === "string" ? raw.text.slice(0, MAX_TYPED_CHARS) : "";
    return typed ? { type: "type", text: typed } : null;
  },
  press: (raw) => {
    const combo = typeof raw.combo === "string" ? raw.combo.trim().slice(0, MAX_COMBO_CHARS) : "";
    if (!combo) return null;
    const repeat = Math.round(clamp(raw.repeat ?? 1, 1, MAX_PRESS_REPEAT));
    return { type: "press", combo, ...(repeat > 1 ? { repeat } : {}) };
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

/** How each action type reads in a sentence. */
const ACTION_CLAUSES: Record<string, (action: PlayAction) => string> = {
  hold: (a) => `hold ${keyList(a.keys)} for ${seconds(a.ms ?? 400)}`,
  tap: (a) => `tap ${keyList(a.keys)}`,
  look: (a) => `look ${lookWords(a.dx, a.dy)}`,
  click: (a) => `click ${at(a.x, a.y)}`,
  drag: (a) => `drag from ${at(a.fromX, a.fromY)} to ${at(a.x, a.y)}`,
  move: (a) => `move the pointer to ${at(a.x, a.y)}`,
  scroll: (a) => `scroll ${number(a.dx, 0)}, ${number(a.dy, 0)}`,
  wait: (a) => `wait ${seconds(a.ms ?? 100)}`,
  camera: (a) => `switch to the ${a.name} view`,
  type: (a) => `type "${clip(String(a.text ?? ""), CLIP_QUOTE)}"`,
  press: (a) => `press ${a.combo}${(a.repeat ?? 1) > 1 ? ` ${a.repeat} times` : ""}`,
};

function clauseFor(action: PlayAction | null | undefined): string {
  if (!action || !Object.hasOwn(ACTION_CLAUSES, action.type)) return "";
  return ACTION_CLAUSES[action.type]?.(action) ?? "";
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
  const paths = [...kind.navigate, ...kind.edit];
  // `kind && navigate.length === 0 && edit.length === 0` — the shape of this test is the whole
  // point: a project with no input the studio can measure must be told about, not given an empty list.
  if (paths.length === 0) {
    return `PROJECT: ${kind.says}.${drives} This project has no input the studio can measure, so the artefact class [dead-input] does not apply — do not report it.`;
  }
  return `PROJECT: ${kind.says}.${drives} The input evidence is ${paths.join(", ")} in __studio.state() — report [dead-input] only if those are unchanged.`;
}

/** Whether the project draws a scene a person moves through (a canvas, a 3D world) rather than a page of DOM. */
export function drawsScene(app: AnyRecord | null | undefined): boolean {
  return normalizeAppTraits(app).kind === "graphics";
}

/** `place` for a world a person moves through, `screen` for software that is a screen to read and operate. */
export function criticFor(app: AnyRecord | null | undefined): string {
  const kind = normalizeAppTraits(app).kind;
  return APP_KINDS[kind as string]?.critic ?? "screen";
}

/**
 * The axes an undeclared project is still measured on, and what a declared kind with no axis of
 * its own falls back to. Written `abs(delta(path)) > 0` for the reason given below
 * `navigationProbe`: a page that reports nothing must not pass an identity check.
 */
const TEMPLATE_PROBES: { navigate: InputProbe; edit: InputProbe; look: InputProbe; move: InputProbe } = {
  navigate: {
    paths: NAVIGATION_PATHS,
    expr: "abs(delta('ui.navigations')) > 0 || abs(delta('ui.reactions')) > 0",
    note: "harness-owned: after the scripted clicks the address or the page changed — the pointer reaches something that responds",
  },
  edit: {
    paths: EDIT_PATHS,
    expr: "abs(delta('ui.edits')) > 0",
    note: "harness-owned: after the scripted typing a field took input — the keyboard reaches the form",
  },
  look: {
    paths: LOOK_PATHS,
    expr: "abs(delta('player.yaw')) > 0.01",
    note: "harness-owned: after the scripted look (56 px right) player().yaw changed — the mouse path from ctx.look to the camera works",
  },
  move: {
    paths: MOVE_PATHS,
    expr: "abs(delta('player.x')) > 0 || abs(delta('player.z')) > 0",
    note: "harness-owned: after the scripted W/A hold player().x or .z changed — the key path from ctx.keys to the controller works",
  },
};

/**
 * The four input checks' expressions, on the axes this kind actually answers on.
 *
 * A declared trait whose kind names no axis falls back to the page-level axes rather than
 * dropping the check: "declare typing: true" is the documented remedy for a project whose
 * kind does not imply it, and a remedy that silently does nothing is worse than no remedy.
 */
export function inputProbesFor(app: AnyRecord | null | undefined): {
  navigate: InputProbe;
  edit: InputProbe;
  look: InputProbe;
  move: InputProbe;
} {
  const kind = normalizeAppTraits(app).kind;
  const entry = kind ? APP_KINDS[kind] : null;
  return {
    navigate: entry?.navigate.length
      ? counterProbe(entry.navigate, "clicks", "the pointer reaches something that responds")
      : TEMPLATE_PROBES.navigate,
    edit: entry?.edit.length
      ? counterProbe(entry.edit, "typing", "the keyboard reaches a field")
      : TEMPLATE_PROBES.edit,
    look: entry?.look.length ? lookProbe(entry.look) : TEMPLATE_PROBES.look,
    move: entry?.move.length ? moveProbe(entry.move) : TEMPLATE_PROBES.move,
  };
}

// `abs(delta(path)) > 0` and not `delta(path) != 0`: an axis the project does not report reads
// undefined, and `undefined != 0` is true — the check would pass on a page that reports nothing.
function counterProbe(paths: string[], scripted: string, meaning: string): InputProbe {
  return {
    paths,
    expr: paths.map((path) => `abs(delta('${path}')) > 0`).join(" || "),
    note: `harness-owned: after the scripted ${scripted} ${paths.join(" or ")} changed — ${meaning}`,
  };
}

function lookProbe(paths: string[]): InputProbe {
  return {
    paths,
    expr: paths.map((path) => `abs(delta('${path}')) > 0.01`).join(" || "),
    note: `harness-owned: after the scripted look ${paths.join(" or ")} changed — the mouse path reaches the camera`,
  };
}

function moveProbe(paths: string[]): InputProbe {
  return counterProbe(paths, "keys", "the key path reaches the player");
}

/** Whether an eye camera — a first-person view — is worth photographing for this kind. */
export function wantsEyeCameras(app: AnyRecord | null | undefined): boolean {
  const kind = normalizeAppTraits(app).kind;
  // Software has no eyes to look through, declared or not.
  return APP_KINDS[kind as string]?.eyes ?? false;
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
    ui: traits.ui,
    navigation: traits.navigation,
    typing: traits.typing,
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
