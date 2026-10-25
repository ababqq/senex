/**
 * Preview input, applied: how one {@link PreviewInputAction} becomes Chromium input events plus
 * the page-side copies (`__studio.injectInput` and synthetic DOM events), so a paused `step()`
 * playthrough still sees WASD. `substrate/preview-input.ts` owns the mapping and the caps; this
 * module owns the order of events a player's hands would produce. {@link ProjectPreview} supplies
 * the target: its view's `sendInputEvent`, its page dispatch, its clock and its pointer.
 */
import {
  clampHoldMs,
  clampLook,
  clampRepeat,
  MAX_HOLD_KEY_MS,
  type ModifierName,
  modifierOf,
  mouseButton,
  type NormalizedKey,
  normalizeKeys,
  type PreviewInputAction,
  parseCombo,
  pointInView,
  studioAliases,
  typedChar,
  typedText,
} from "../substrate/preview-input.ts";
import { setTimeout as delay } from "node:timers/promises";

/** How long a tap or a chord stays down when no simulated frame is stepped between. */
const KEY_STROKE_MS = 16;
/** The gap between two strokes of a repeated chord. */
const REPEAT_GAP_MS = 24;
/** The gap between keydown and keyup of one typed character. */
const TYPED_CHAR_MS = 8;
/** Intermediate moves of a drag: a slider or an orbit control needs the glide, not the jump. */
const DRAG_STEPS = 6;
/** The pause between two moves of a drag: about one frame. */
const DRAG_STEP_MS = 16;
/** Most clicks one click action makes (3 = triple click). */
const MAX_CLICKS = 3;
/** A wheel delta in pixels; a computer-use scroll of 50 notches is 6000 px, a real gesture. */
const MAX_SCROLL_PX = 6_000;
/** What the page receives for one beat of input: the studio's own injection and DOM copies. */
export interface PageDispatch {
  studio?: { down?: string[]; up?: string[]; look?: { dx: number; dy: number } };
  dom?: Array<Record<string, unknown>>;
  /** Native delivery is proven for this page: the page drops the copies it already heard. */
  native?: boolean;
}

/** A Chromium input event the driver sends through the view. */
export type NativeInputEvent = Electron.MouseInputEvent | Electron.MouseWheelInputEvent | Electron.KeyboardInputEvent;

interface Point {
  x: number;
  y: number;
}

/** The preview the driver acts on. `send` never throws: a view that will not take it drops it. */
export interface InputTarget {
  width: number;
  height: number;
  send(event: NativeInputEvent): void;
  dispatch(payload: PageDispatch): Promise<void>;
  /** Advance the page's own loop by hand — the frozen-clock stand-in for a real sleep. */
  stepClock(ms: number): Promise<void>;
  pointer(): Point;
  movePointer(point: Point): void;
  /**
   * The modifiers held now. They outlive one action, as they do on a keyboard: `down shift` then `tap a`
   * types a capital, and every native event and page copy in between says shift is down.
   */
  held: Set<ModifierName>;
}

type ActionOf<T extends PreviewInputAction["type"]> = Extract<PreviewInputAction, { type: T }>;
type InputHandlers = {
  [T in PreviewInputAction["type"]]: (target: InputTarget, action: ActionOf<T>) => Promise<void>;
};

const INPUT_HANDLERS: InputHandlers = {
  wait: (_target, action) => sleep(clampHoldMs(action.ms)),
  look: applyLook,
  move: applyMove,
  click: applyClick,
  drag: applyDrag,
  mousedown: (target, action) => applyButton(target, action.button, "down"),
  mouseup: (target, action) => applyButton(target, action.button, "up"),
  type: applyType,
  press: applyPress,
  scroll: applyScroll,
  down: (target, action) => keysDown(target, normalizeKeys(action.keys)),
  up: (target, action) => keysUp(target, normalizeKeys(action.keys)),
  tap: applyTap,
  hold: applyHold,
};

/** Apply one input action to the preview, the way a player's hands would. */
export async function applyInputAction(target: InputTarget, action: PreviewInputAction): Promise<void> {
  const handler = INPUT_HANDLERS[action.type] as
    | ((target: InputTarget, action: PreviewInputAction) => Promise<void>)
    | undefined;
  if (!handler) return;
  await handler(target, action);
}

async function applyLook(target: InputTarget, action: ActionOf<"look">): Promise<void> {
  const dx = clampLook(action.dx);
  const dy = clampLook(action.dy);
  const pointer = target.pointer();
  const next = {
    x: Math.max(0, Math.min(target.width - 1, pointer.x + dx)),
    y: Math.max(0, Math.min(target.height - 1, pointer.y + dy)),
  };
  sendMouse(target, { type: "mouseMove", x: next.x, y: next.y, movementX: dx, movementY: dy });
  await target.dispatch({
    studio: { look: { dx, dy } },
    dom: [mouseCopy(target, { type: "mousemove", x: next.x, y: next.y, movementX: dx, movementY: dy })],
  });
  target.movePointer(next);
}

async function applyMove(target: InputTarget, action: ActionOf<"move">): Promise<void> {
  const point = pointInView(action.x, action.y, target.width, target.height, { exact: action.px === true });
  const pointer = target.pointer();
  const movementX = point.x - pointer.x;
  const movementY = point.y - pointer.y;
  sendMouse(target, { type: "mouseMove", x: point.x, y: point.y, movementX, movementY });
  await target.dispatch({
    studio: { look: { dx: movementX, dy: movementY } },
    dom: [mouseCopy(target, { type: "mousemove", x: point.x, y: point.y, movementX, movementY })],
  });
  target.movePointer(point);
}

async function applyClick(target: InputTarget, action: ActionOf<"click">): Promise<void> {
  const point = pointInView(action.x, action.y, target.width, target.height, { exact: action.px === true });
  const clicks = Math.max(1, Math.min(MAX_CLICKS, Math.round(Number(action.clicks) || 1)));
  const pressed = await pressModifiers(target, normalizeKeys(action.modifiers ?? []));
  sendMouse(target, { type: "mouseMove", x: point.x, y: point.y, movementX: 0, movementY: 0 });
  const click: ClickStroke = {
    point,
    button: mouseButton(action.button),
    stepMs: stepBetweenPressAndRelease(action),
    dom: [mouseCopy(target, { type: "mousemove", x: point.x, y: point.y, movementX: 0, movementY: 0 })],
  };
  for (let n = 1; n <= clicks; n++) await clickOnce(target, click, n);
  await target.dispatch({ studio: {}, dom: click.dom });
  await releaseModifiers(target, pressed);
  target.movePointer(point);
}

/** One click of a (multi-)click: its native press and release, and its DOM copies queued on `dom`. */
interface ClickStroke {
  point: Point;
  button: ReturnType<typeof mouseButton>;
  stepMs: number;
  dom: Array<Record<string, unknown>>;
}

async function clickOnce(target: InputTarget, click: ClickStroke, n: number): Promise<void> {
  const { point, button, dom } = click;
  const mouse = { x: point.x, y: point.y, button: button.name, clickCount: n };
  const page = { x: point.x, y: point.y, button: button.index, detail: n };
  sendMouse(target, { type: "mouseDown", ...mouse });
  dom.push(mouseCopy(target, { ...page, type: "mousedown", buttons: buttonsMask(button.index) }));
  if (click.stepMs) {
    // A frozen clock makes press and release the same instant, and a project that samples
    // input once a frame never sees the button down. Straddle a simulated frame instead.
    await target.dispatch({ studio: {}, dom: dom.splice(0, dom.length) });
    await target.stepClock(click.stepMs);
  }
  sendMouse(target, { type: "mouseUp", ...mouse });
  dom.push(
    mouseCopy(target, { ...page, type: "mouseup", buttons: 0 }),
    mouseCopy(target, { ...page, type: "click", buttons: 0 }),
  );
  if (n === 2) dom.push(mouseCopy(target, { ...page, type: "dblclick", buttons: 0 }));
}

async function applyDrag(target: InputTarget, action: ActionOf<"drag">): Promise<void> {
  const exact = { exact: action.px === true };
  const from = pointInView(action.fromX, action.fromY, target.width, target.height, exact);
  const to = pointInView(action.x, action.y, target.width, target.height, exact);
  const button = mouseButton(action.button);
  const buttons = buttonsMask(button.index);
  const pointer = target.pointer();
  sendMouse(target, {
    type: "mouseMove",
    x: from.x,
    y: from.y,
    movementX: from.x - pointer.x,
    movementY: from.y - pointer.y,
  });
  sendMouse(target, { type: "mouseDown", x: from.x, y: from.y, button: button.name, clickCount: 1 });
  await target.dispatch({
    studio: {},
    dom: [
      mouseCopy(target, { type: "mousemove", x: from.x, y: from.y, movementX: 0, movementY: 0 }),
      mouseCopy(target, { type: "mousedown", x: from.x, y: from.y, button: button.index, buttons }),
    ],
  });
  await glide(target, from, to, button);
  sendMouse(target, { type: "mouseUp", x: to.x, y: to.y, button: button.name, clickCount: 1 });
  await target.dispatch({
    studio: {},
    dom: [mouseCopy(target, { type: "mouseup", x: to.x, y: to.y, button: button.index, buttons: 0 })],
  });
  target.movePointer(to);
}

/** The held-button moves of a drag, from `from` to `to` in {@link DRAG_STEPS} steps. */
async function glide(target: InputTarget, from: Point, to: Point, button: ReturnType<typeof mouseButton>) {
  const buttons = buttonsMask(button.index);
  const leftHeld = button.index === 0 ? { button: "left" as const } : {};
  let last = from;
  for (let i = 1; i <= DRAG_STEPS; i++) {
    const point = {
      x: Math.round(from.x + ((to.x - from.x) * i) / DRAG_STEPS),
      y: Math.round(from.y + ((to.y - from.y) * i) / DRAG_STEPS),
    };
    const movementX = point.x - last.x;
    const movementY = point.y - last.y;
    sendMouse(target, { type: "mouseMove", x: point.x, y: point.y, movementX, movementY, ...leftHeld });
    await target.dispatch({
      studio: { look: { dx: movementX, dy: movementY } },
      dom: [mouseCopy(target, { type: "mousemove", x: point.x, y: point.y, movementX, movementY, buttons })],
    });
    last = point;
    await sleep(DRAG_STEP_MS);
  }
}

/** A lone press or release of a mouse button at the pointer. */
async function applyButton(target: InputTarget, raw: unknown, edge: "down" | "up"): Promise<void> {
  const button = mouseButton(raw);
  const point = target.pointer();
  if (edge === "down") {
    sendMouse(target, { type: "mouseDown", x: point.x, y: point.y, button: button.name, clickCount: 1 });
    await target.dispatch({
      studio: {},
      dom: [
        mouseCopy(target, {
          type: "mousedown",
          x: point.x,
          y: point.y,
          button: button.index,
          buttons: buttonsMask(button.index),
        }),
      ],
    });
    return;
  }
  sendMouse(target, { type: "mouseUp", x: point.x, y: point.y, button: button.name, clickCount: 1 });
  await target.dispatch({
    studio: {},
    dom: [mouseCopy(target, { type: "mouseup", x: point.x, y: point.y, button: button.index, buttons: 0 })],
  });
}

/** Typed control characters and the key that types them. */
const TYPED_KEY: Record<string, string> = { "\n": "enter", "\t": "tab" };

async function applyType(target: InputTarget, action: ActionOf<"type">): Promise<void> {
  // Every character is one stroke: keydown, char, keyup — what a keyboard delivers, so a
  // project reading keydown and a text field reading input both hear it.
  for (const ch of typedText(action.text)) {
    const [key] = normalizeKeys([TYPED_KEY[ch] ?? ch]);
    if (!key) continue;
    const down = strikeDown(target, key);
    // The character as typed ("A", not the key's lowercase "a"); a control character is its key's own.
    if (key.printable) sendChar(target, ch in TYPED_KEY ? key.key : ch);
    await target.dispatch({ studio: { down: studioAliases([key]) }, dom: [down] });
    await sleep(TYPED_CHAR_MS);
    const up = strikeUp(target, key);
    await target.dispatch({ studio: { up: studioAliases([key]) }, dom: [up] });
  }
}

async function applyPress(target: InputTarget, action: ActionOf<"press">): Promise<void> {
  const { modifiers, key } = parseCombo(action.combo);
  const chord: NormalizedKey[] = [...modifiers, ...(key ? [key] : [])];
  if (!chord.length) return;
  const times = clampRepeat(action.repeat ?? 1);
  for (let n = 0; n < times; n++) {
    const down = chord.map((struck) => strikeDown(target, struck));
    const typed = typedChar([...target.held], key);
    if (typed !== null) sendChar(target, typed);
    await target.dispatch({ studio: { down: studioAliases(chord) }, dom: down });
    await sleep(KEY_STROKE_MS);
    const up = [...chord].reverse().map((struck) => strikeUp(target, struck));
    await target.dispatch({ studio: { up: studioAliases(chord) }, dom: up });
    if (times > 1) await sleep(REPEAT_GAP_MS);
  }
}

async function applyScroll(target: InputTarget, action: ActionOf<"scroll">): Promise<void> {
  const dx = clampScroll(action.dx);
  const dy = clampScroll(action.dy);
  const at = scrollPoint(target, action);
  sendMouse(target, { type: "mouseWheel", x: at.x, y: at.y, deltaX: -dx, deltaY: -dy });
  await target.dispatch({
    studio: {},
    dom: [{ kind: "wheel", dx, dy, x: at.x, y: at.y, ...heldFlags(target.held) }],
  });
}

/** Where a wheel turns: at (x, y) in pixels when both are given, at the pointer otherwise. */
function scrollPoint(target: InputTarget, action: ActionOf<"scroll">): Point {
  if (action.x === undefined || action.y === undefined) return target.pointer();
  return pointInView(action.x, action.y, target.width, target.height, { exact: true });
}

async function applyTap(target: InputTarget, action: ActionOf<"tap">): Promise<void> {
  const keys = normalizeKeys(action.keys);
  if (keys.length === 0) return;
  const stepMs = stepBetweenPressAndRelease(action);
  await keysDown(target, keys);
  if (stepMs) await target.stepClock(stepMs);
  else await sleep(KEY_STROKE_MS);
  await keysUp(target, keys);
}

async function applyHold(target: InputTarget, action: ActionOf<"hold">): Promise<void> {
  const keys = normalizeKeys(action.keys);
  if (keys.length === 0) return;
  const ms = Math.min(MAX_HOLD_KEY_MS, Math.max(0, Math.round(Number(action.ms) || 0))) || clampHoldMs(action.ms);
  await keysDown(target, keys);
  if (ms > 0) await sleep(ms);
  await keysUp(target, keys);
}

/** Press `keys` (with the characters they type) natively and on the page. */
async function keysDown(target: InputTarget, keys: NormalizedKey[]): Promise<void> {
  if (keys.length === 0) return;
  const dom: Array<Record<string, unknown>> = [];
  for (const key of keys) {
    dom.push(strikeDown(target, key));
    const typed = typedChar([...target.held], key);
    if (typed !== null) sendChar(target, typed);
  }
  await target.dispatch({ studio: { down: studioAliases(keys) }, dom });
}

/** Release `keys`, last pressed first, natively and on the page. */
async function keysUp(target: InputTarget, keys: NormalizedKey[]): Promise<void> {
  if (keys.length === 0) return;
  const dom = [...keys].reverse().map((key) => strikeUp(target, key));
  await target.dispatch({ studio: { up: studioAliases(keys) }, dom });
}

/**
 * Hold a click's modifiers, natively and then on the page: the ones that were not already down, which are
 * returned so the click lets go of just those. A key listed that is not a modifier is pressed as it always was.
 */
async function pressModifiers(target: InputTarget, modifiers: NormalizedKey[]): Promise<NormalizedKey[]> {
  const fresh = modifiers.filter((key) => {
    const modifier = modifierOf(key);
    return modifier === null || !target.held.has(modifier);
  });
  if (fresh.length === 0) return fresh;
  const dom = fresh.map((key) => strikeDown(target, key));
  await target.dispatch({ studio: { down: studioAliases(fresh) }, dom });
  return fresh;
}

/** Let go of the modifiers a click pressed, last held first. */
async function releaseModifiers(target: InputTarget, pressed: NormalizedKey[]): Promise<void> {
  if (pressed.length === 0) return;
  const dom = [...pressed].reverse().map((key) => strikeUp(target, key));
  await target.dispatch({ studio: { up: studioAliases(pressed) }, dom });
}

/**
 * One key going down: its native event, carrying the modifiers held as it goes (a modifier's own press
 * already reports itself held, as Chromium's does), and the page's copy of the same moment.
 */
function strikeDown(target: InputTarget, key: NormalizedKey): Record<string, unknown> {
  const modifier = modifierOf(key);
  if (modifier) target.held.add(modifier);
  target.send({ type: "keyDown", keyCode: key.keyCode, ...heldFlags(target.held) });
  return keyCopy(key, "keydown", target.held);
}

/** One key coming up: a modifier's release no longer reports itself held. */
function strikeUp(target: InputTarget, key: NormalizedKey): Record<string, unknown> {
  const modifier = modifierOf(key);
  if (modifier) target.held.delete(modifier);
  target.send({ type: "keyUp", keyCode: key.keyCode, ...heldFlags(target.held) });
  return keyCopy(key, "keyup", target.held);
}

/** How Chromium is told the characters that are not their own name. */
const CHAR_KEYCODE: Record<string, string> = { " ": "Space", Enter: "\r" };

/** Type one character: how Chromium is told it is in {@link CHAR_KEYCODE}. */
function sendChar(target: InputTarget, character: string): void {
  target.send({ type: "char", keyCode: CHAR_KEYCODE[character] ?? character, ...heldFlags(target.held) });
}

/** What the modifiers held say on an event, or nothing at all when none is held. */
function heldFlags(held: ReadonlySet<ModifierName>): { modifiers?: ModifierName[] } {
  return held.size > 0 ? { modifiers: [...held] } : {};
}

/** A mouse or wheel event sent through the view, with the modifiers held as it happens. */
function sendMouse(target: InputTarget, event: Electron.MouseInputEvent | Electron.MouseWheelInputEvent): void {
  target.send({ ...event, ...heldFlags(target.held) });
}

/** The page's copy of a mouse event, with the modifiers held. */
function mouseCopy(target: InputTarget, event: Record<string, unknown>): Record<string, unknown> {
  return { kind: "mouse", ...event, ...heldFlags(target.held) };
}

/** `MouseEvent.buttons` for a pressed button index: left 1, right 2, middle 4. */
function buttonsMask(index: number): number {
  if (index === 0) return 1;
  if (index === 2) return 2;
  return 4;
}

/** Wait `ms`; a negative wait is none. */
function sleep(ms: number): Promise<void> {
  return delay(Math.max(0, ms));
}

/**
 * `stepMs` on a tap or a click: how far to advance the page's own loop between the press and
 * the release. The play script sets it when the clock is frozen; a project that reads a key inside
 * its frame never sees a press and a release delivered in the same JS turn otherwise.
 */
function stepBetweenPressAndRelease(action: PreviewInputAction): number {
  const ms = Number((action as { stepMs?: number }).stepMs);
  return Number.isFinite(ms) && ms > 0 ? Math.min(MAX_HOLD_KEY_MS, ms) : 0;
}

/** A wheel delta in pixels, capped at {@link MAX_SCROLL_PX} either way. */
function clampScroll(delta: unknown): number {
  const n = Number(delta);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-MAX_SCROLL_PX, Math.min(MAX_SCROLL_PX, n));
}

/** The page's copy of one key event, with the modifiers held at that moment. */
function keyCopy(key: NormalizedKey, type: "keydown" | "keyup", held: ReadonlySet<ModifierName>) {
  return { kind: "key", type, key: key.key, code: key.code, keyCode: key.which, ...heldFlags(held) };
}
