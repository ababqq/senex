/**
 * Preview HID — keys, clicks, look — as a plain data plan.
 *
 * Electron's `sendInputEvent` lives in {@link ProjectPreview}; this file is the mapping and the
 * caps, so tests can exercise "W means KeyW" without a window.
 */
import type { PreviewInputAction } from "../shared/preview-contract.ts";

export interface NormalizedKey {
  /** Electron `sendInputEvent` keyCode (`W`, `Space`, `Up`). */
  keyCode: string;
  /** `KeyboardEvent.code` (`KeyW`, `Space`, `ArrowUp`). */
  code: string;
  /** `KeyboardEvent.key` (`w`, ` `, `ArrowUp`). */
  key: string;
  /**
   * What a keypress of this key types, when that is not `key`: a typed capital stays a capital (`A`) while
   * `key` stays the key's own (`a`), so a game's `event.key === "a"` still matches. Only the `char` event
   * reads it; see {@link keyChar}.
   */
  char?: string;
  which: number;
  printable: boolean;
}

export type { PreviewInputAction };

/** The modifier keys, spelled as Electron names them on an input event (`modifiers: ["control"]`). */
export const ModifierName = { Shift: "shift", Control: "control", Alt: "alt", Meta: "meta" } as const;
export type ModifierName = (typeof ModifierName)[keyof typeof ModifierName];

/** The modifier each modifier key's `code` is; a key not here is not a modifier. */
const MODIFIER_OF_CODE: Record<string, ModifierName> = {
  ShiftLeft: ModifierName.Shift,
  ControlLeft: ModifierName.Control,
  AltLeft: ModifierName.Alt,
  MetaLeft: ModifierName.Meta,
};

export const MAX_INPUT_ACTIONS = 24;
export const MAX_HOLD_MS = 8_000;
/** A held key in a computer-use session (hold_key) may last this long — a long grind, not a stuck key. */
export const MAX_HOLD_KEY_MS = 300_000;
export const MAX_KEYS = 8;
export const MAX_LOOK = 2_000;
export const MAX_TYPE_CHARS = 2_000;
export const MAX_PRESS_REPEAT = 100;
/** How long a hold lasts when the caller gives no usable duration. */
const DEFAULT_HOLD_MS = 120;

const NAMED: Record<string, Omit<NormalizedKey, "printable"> & { printable?: boolean }> = {
  space: { keyCode: "Space", code: "Space", key: " ", which: 32, printable: true },
  // Enter carries a char: Chromium clicks a focused button, submits a form and breaks a line on the
  // keypress it makes from one, never on the bare keyDown.
  enter: { keyCode: "Enter", code: "Enter", key: "Enter", which: 13, printable: true },
  return: { keyCode: "Enter", code: "Enter", key: "Enter", which: 13, printable: true },
  escape: { keyCode: "Escape", code: "Escape", key: "Escape", which: 27 },
  esc: { keyCode: "Escape", code: "Escape", key: "Escape", which: 27 },
  tab: { keyCode: "Tab", code: "Tab", key: "Tab", which: 9 },
  backspace: { keyCode: "Backspace", code: "Backspace", key: "Backspace", which: 8 },
  delete: { keyCode: "Delete", code: "Delete", key: "Delete", which: 46 },
  shift: { keyCode: "Shift", code: "ShiftLeft", key: "Shift", which: 16 },
  control: { keyCode: "Control", code: "ControlLeft", key: "Control", which: 17 },
  ctrl: { keyCode: "Control", code: "ControlLeft", key: "Control", which: 17 },
  alt: { keyCode: "Alt", code: "AltLeft", key: "Alt", which: 18 },
  option: { keyCode: "Alt", code: "AltLeft", key: "Alt", which: 18 },
  meta: { keyCode: "Meta", code: "MetaLeft", key: "Meta", which: 91 },
  command: { keyCode: "Meta", code: "MetaLeft", key: "Meta", which: 91 },
  cmd: { keyCode: "Meta", code: "MetaLeft", key: "Meta", which: 91 },
  // The code names a computer-use click or hold_key hands back (`computerToInput`).
  shiftleft: { keyCode: "Shift", code: "ShiftLeft", key: "Shift", which: 16 },
  controlleft: { keyCode: "Control", code: "ControlLeft", key: "Control", which: 17 },
  altleft: { keyCode: "Alt", code: "AltLeft", key: "Alt", which: 18 },
  metaleft: { keyCode: "Meta", code: "MetaLeft", key: "Meta", which: 91 },
  up: { keyCode: "Up", code: "ArrowUp", key: "ArrowUp", which: 38 },
  arrowup: { keyCode: "Up", code: "ArrowUp", key: "ArrowUp", which: 38 },
  down: { keyCode: "Down", code: "ArrowDown", key: "ArrowDown", which: 40 },
  arrowdown: { keyCode: "Down", code: "ArrowDown", key: "ArrowDown", which: 40 },
  left: { keyCode: "Left", code: "ArrowLeft", key: "ArrowLeft", which: 37 },
  arrowleft: { keyCode: "Left", code: "ArrowLeft", key: "ArrowLeft", which: 37 },
  right: { keyCode: "Right", code: "ArrowRight", key: "ArrowRight", which: 39 },
  arrowright: { keyCode: "Right", code: "ArrowRight", key: "ArrowRight", which: 39 },
  pageup: { keyCode: "PageUp", code: "PageUp", key: "PageUp", which: 33 },
  page_up: { keyCode: "PageUp", code: "PageUp", key: "PageUp", which: 33 },
  pagedown: { keyCode: "PageDown", code: "PageDown", key: "PageDown", which: 34 },
  page_down: { keyCode: "PageDown", code: "PageDown", key: "PageDown", which: 34 },
  home: { keyCode: "Home", code: "Home", key: "Home", which: 36 },
  end: { keyCode: "End", code: "End", key: "End", which: 35 },
  insert: { keyCode: "Insert", code: "Insert", key: "Insert", which: 45 },
  super: { keyCode: "Meta", code: "MetaLeft", key: "Meta", which: 91 },
  win: { keyCode: "Meta", code: "MetaLeft", key: "Meta", which: 91 },
  minus: { keyCode: "-", code: "Minus", key: "-", which: 189, printable: true },
  plus: { keyCode: "+", code: "Equal", key: "+", which: 187, printable: true },
  equal: { keyCode: "=", code: "Equal", key: "=", which: 187, printable: true },
  comma: { keyCode: ",", code: "Comma", key: ",", which: 188, printable: true },
  period: { keyCode: ".", code: "Period", key: ".", which: 190, printable: true },
  slash: { keyCode: "/", code: "Slash", key: "/", which: 191, printable: true },
};

/** A character's code point is half of a surrogate pair: UTF-16 text that is not a character. */
function isSurrogateHalf(codePoint: number): boolean {
  return codePoint >= 0xd800 && codePoint <= 0xdfff;
}

/**
 * The key of one character that has no key of its own name: it types itself. Any plane (an emoji is one
 * character of two UTF-16 units), and any Unicode space but the space bar (trimmed away otherwise, it would
 * type nothing). Half of a surrogate pair is not a character, and Chromium types it as U+FFFD.
 */
function literalKey(character: string): NormalizedKey | null {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined || isSurrogateHalf(codePoint)) return null;
  return { keyCode: character, code: character, key: character, which: codePoint, printable: true };
}

/** A code name (`KeyW`, `Digit3`, `ArrowUp`, as hold_key hands them back) names the key, not a capital: `KeyW` types `w`. */
function withoutCodePrefix(text: string): string {
  if (/^key[a-z]$/i.test(text)) return text.slice(3).toLowerCase();
  if (/^digit[0-9]$/i.test(text)) return text.slice(5);
  if (/^arrow/i.test(text)) return text.slice(5);
  if (/^kp_/i.test(text)) return text.slice(3);
  return text;
}

/** The key of one character: a letter, a digit, or anything else that types itself. */
function characterKey(ch: string): NormalizedKey | null {
  if (/[a-zA-Z]/.test(ch)) {
    const up = ch.toUpperCase();
    return { keyCode: up, code: `Key${up}`, key: ch.toLowerCase(), char: ch, which: up.charCodeAt(0), printable: true };
  }
  if (/[0-9]/.test(ch)) {
    return { keyCode: ch, code: `Digit${ch}`, key: ch, which: ch.charCodeAt(0), printable: true };
  }
  return literalKey(ch);
}

export function normalizeKey(raw: unknown): NormalizedKey | null {
  if (raw == null) return null;
  // A typed space is the Space key; trimmed, it would be nothing and `type` would drop it.
  if (raw === " ") return { ...NAMED.space!, printable: true };
  const characters = Array.from(String(raw));
  // A lone Unicode space (no-break, ideographic, em) is the character it is, not blank to be trimmed.
  if (characters.length === 1 && /^\p{Zs}$/u.test(characters[0] ?? "")) return literalKey(characters[0] ?? "");
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const text = withoutCodePrefix(trimmed);
  const named = NAMED[text.toLowerCase()];
  if (named) return { ...named, printable: named.printable === true };
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(text)) {
    const n = Number(text.slice(1));
    return { keyCode: `F${n}`, code: `F${n}`, key: `F${n}`, which: 111 + n, printable: false };
  }
  // One character, however many UTF-16 units it takes (an emoji takes two).
  if (Array.from(text).length === 1) return characterKey(text);
  return { keyCode: text, code: text, key: text, which: 0, printable: false };
}

/** The character a keypress of `key` types: its own `char`, else its `key`. */
export function keyChar(key: NormalizedKey): string {
  return key.char ?? key.key;
}

/** The modifier a key is, or null for a key that is not one. */
export function modifierOf(key: NormalizedKey): ModifierName | null {
  return MODIFIER_OF_CODE[key.code] ?? null;
}

/** The modifiers `keys` hold, once each, in the order they were listed. */
export function modifiersOf(keys: readonly NormalizedKey[]): ModifierName[] {
  const held: ModifierName[] = [];
  for (const key of keys) {
    const modifier = modifierOf(key);
    if (modifier && !held.includes(modifier)) held.push(modifier);
  }
  return held;
}

/** The keys shift leaves typing what they type: it breaks a line and spaces, as it does on a keyboard. */
const SHIFT_KEEPS_CODES = new Set(["Enter", "Space"]);

/**
 * The text striking `key` while `held` modifiers are down types, or null when it types none: a lone key types
 * its character, Shift turns a letter into its capital (and leaves Enter and Space as they are), and any other
 * held modifier (ctrl, alt, meta) makes a shortcut, which types nothing.
 */
export function typedChar(held: readonly ModifierName[], key: NormalizedKey | null): string | null {
  if (!key?.printable) return null;
  if (held.length === 0) return keyChar(key);
  if (held.some((modifier) => modifier !== ModifierName.Shift)) return null;
  if (/^[a-z]$/.test(key.key)) return key.key.toUpperCase();
  return SHIFT_KEEPS_CODES.has(key.code) ? keyChar(key) : null;
}

/** {@link typedChar} for the modifier keys of a chord. */
export function chordChar(modifiers: NormalizedKey[], key: NormalizedKey | null): string | null {
  return typedChar(modifiersOf(modifiers), key);
}

/** A single key, a list of keys, or nothing, as a list. */
function asList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  return raw != null ? [raw] : [];
}

export function normalizeKeys(raw: unknown): NormalizedKey[] {
  const list = asList(raw);
  const out: NormalizedKey[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const key = normalizeKey(item);
    if (!key || seen.has(key.code)) continue;
    seen.add(key.code);
    out.push(key);
    if (out.length >= MAX_KEYS) break;
  }
  return out;
}

export function clampHoldMs(ms: unknown): number {
  const n = Number(ms);
  if (!Number.isFinite(n)) return DEFAULT_HOLD_MS;
  return Math.min(MAX_HOLD_MS, Math.max(0, Math.round(n)));
}

export function clampLook(delta: unknown): number {
  const n = Number(delta);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-MAX_LOOK, Math.min(MAX_LOOK, n));
}

/** Pixel point. Values in 0…1 on both axes are treated as a fraction of the view. */
export function pointInView(
  x: unknown,
  y: unknown,
  width: number,
  height: number,
  options: { exact?: boolean } = {},
): { x: number; y: number } {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const centre = { x: Math.round(w / 2), y: Math.round(h / 2) };
  const unset = (value: unknown) => value == null || value === "";
  if (unset(x) || unset(y)) return centre;
  const px = Number(x);
  const py = Number(y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return centre;
  // A computer-use coordinate is always pixels: (1, 1) is the corner, not the far edge.
  const fraction = (value: number) => value >= 0 && value <= 1;
  if (!options.exact && fraction(px) && fraction(py)) {
    return { x: Math.round(px * w), y: Math.round(py * h) };
  }
  return {
    x: Math.max(0, Math.min(w - 1, Math.round(px))),
    y: Math.max(0, Math.min(h - 1, Math.round(py))),
  };
}

export function mouseButton(raw: unknown): { name: "left" | "middle" | "right"; index: number } {
  const value = String(raw ?? "left").toLowerCase();
  if (value === "right" || value === "2") return { name: "right", index: 2 };
  if (value === "middle" || value === "1") return { name: "middle", index: 1 };
  return { name: "left", index: 0 };
}

export function capActions(actions: unknown): PreviewInputAction[] {
  if (!Array.isArray(actions)) return [];
  return actions.filter(isAction).slice(0, MAX_INPUT_ACTIONS);
}

function isAction(value: unknown): value is PreviewInputAction {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === "tap" ||
    type === "down" ||
    type === "up" ||
    type === "hold" ||
    type === "click" ||
    type === "move" ||
    type === "drag" ||
    type === "mousedown" ||
    type === "mouseup" ||
    type === "look" ||
    type === "scroll" ||
    type === "type" ||
    type === "press" ||
    type === "wait"
  );
}

/**
 * "ctrl+shift+s" → the modifier keys held and the key struck. A bare "s" is a strike with no
 * modifiers; "+" alone is the plus key. Unknown modifier words are keys, not modifiers.
 */
export function parseCombo(raw: unknown): { modifiers: NormalizedKey[]; key: NormalizedKey | null } {
  const text = String(raw ?? "").trim();
  if (!text) return { modifiers: [], key: null };
  if (text === "+") return { modifiers: [], key: normalizeKey("+") };
  const parts = text
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const modifiers: NormalizedKey[] = [];
  let key: NormalizedKey | null = null;
  for (const part of parts) {
    const normalized = normalizeKey(part);
    if (!normalized) continue;
    if (MODIFIER_CODES.has(normalized.code) && parts.length > 1) modifiers.push(normalized);
    else key = normalized;
  }
  return { modifiers: modifiers.slice(0, 4), key };
}

const MODIFIER_CODES = new Set(Object.keys(MODIFIER_OF_CODE));

/** Modifier names on a click ("shift", "ctrl+alt") → the keys held for it. */
export function clickModifiers(raw: unknown): string[] {
  const { modifiers, key } = parseCombo(raw);
  const all = [...modifiers, ...(key && MODIFIER_CODES.has(key.code) ? [key] : [])];
  return all.map((k) => k.code);
}

/**
 * The first `max` characters of `text`. A character is a code point, so an emoji (two UTF-16 units) is never
 * cut in half; a character is at most two units, so twice `max` is all that is ever looked at.
 */
export function firstCharacters(text: string, max: number): string {
  return Array.from(text.slice(0, max * 2))
    .slice(0, max)
    .join("");
}

/** Text a keyboard can type: every character becomes one key stroke; capped at {@link MAX_TYPE_CHARS} characters. */
export function typedText(raw: unknown): string {
  return firstCharacters(String(raw ?? ""), MAX_TYPE_CHARS);
}

export function clampRepeat(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(MAX_PRESS_REPEAT, Math.round(n)));
}

export function studioAliases(keys: NormalizedKey[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    for (const alias of [key.code, key.key, key.keyCode]) {
      if (!alias || seen.has(alias)) continue;
      seen.add(alias);
      out.push(alias);
    }
  }
  return out;
}
