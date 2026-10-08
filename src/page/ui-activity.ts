/**
 * What a person's hands did to the page, and what a screen reader would find on it.
 *
 * The harness drives a software project the way a user does — a click, a Tab, some typing, a
 * scroll — and then asks whether any of it reached anything. A project the user brought has no
 * contract to answer that, and the template's contract should not have to: this module counts
 * the events at the document, in the capture phase, before the project's own handlers can stop
 * them, and reads the structure the way an assistive technology would. The result rides on
 * every `__studio.state()` as `ui`, so a check is a plain expression over two snapshots
 * (`delta('ui.edits') > 0`) and a project that never heard of the studio is still measurable.
 *
 * Everything is read from an injected `scope` (the page's window), defensively, and nothing
 * here throws into the project: a page that refuses a listener simply reports a smaller count.
 */

import type { Foreign } from "./foreign.ts";

/** The report's version — read before anything trusts these numbers. */
export const UI_ACTIVITY_VERSION = 1;

/** The most unnamed controls the report describes by markup (the count keeps going). */
const UNNAMED_SAMPLE = 5;
/** How much of a control's own markup a description quotes. */
const DESCRIBE_CHARS = 60;
/** How long after an input a change to the page still counts as the page answering it. */
const REACTION_WINDOW_MS = 600;
/** How much of an error message the report keeps. */
const ERROR_CHARS = 200;

/** What a person can operate: native controls, and the roles that make other elements one. */
const CONTROL_SELECTOR = [
  "a[href]",
  "button",
  'input:not([type="hidden"])',
  "select",
  "textarea",
  "summary",
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="textbox"]',
  '[role="combobox"]',
].join(",");
/** An element that takes no part in the page for a person, however it is marked up. */
const INERT_SELECTOR = '[hidden],[aria-hidden="true"],[inert]';
/** Input types whose accessible name is their own value. */
const VALUE_NAMED_TYPES = new Set(["button", "submit", "reset"]);

/** What the page's people did, and what a screen reader finds wrong with it. */
export interface UiReport {
  version: number;
  /** Pointer activations. */
  clicks: number;
  /** Keys pressed. */
  keys: number;
  /** `input` events: a field took what a person typed or chose. */
  edits: number;
  /** Times keyboard focus moved to a different element. */
  focusMoves: number;
  /** Times the address (path, query or fragment) changed. */
  navigations: number;
  /** Times the page changed within a moment of an input — the page answering a person. */
  reactions: number;
  /** Uncaught errors, unhandled rejections, `console.error` calls and failed resource loads. */
  errors: number;
  lastError: string | null;
  /** Where the page is now: path, query and fragment. */
  view: string;
  /** Visible controls a screen reader cannot name. */
  unnamedControls: number;
  /** Markup of the first few of them. */
  unnamedSample: string[];
  /** How far the page runs past the window's width, in CSS pixels. */
  overflowX: number;
}

/** The counters a report is made of. */
type Counters = Pick<
  UiReport,
  "clicks" | "keys" | "edits" | "focusMoves" | "navigations" | "reactions" | "errors" | "lastError"
>;

const zeroCounters = (): Counters => ({
  clicks: 0,
  keys: 0,
  edits: 0,
  focusMoves: 0,
  navigations: 0,
  reactions: 0,
  errors: 0,
  lastError: null,
});

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** Whether an element is a field a person types into or chooses from. */
export function isEditable(el: Foreign): boolean {
  if (!el) return false;
  const tag = String(el.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

/** The text of the elements an `aria-labelledby` list names. */
function labelledBy(el: Foreign, doc: Foreign): string {
  const ids = text(el.getAttribute?.("aria-labelledby")).split(/\s+/).filter(Boolean);
  return ids
    .map((id) => text(doc?.getElementById?.(id)?.textContent))
    .filter(Boolean)
    .join(" ");
}

/** The text of the `<label>`s tied to a field. */
function labelsOf(el: Foreign): string {
  const labels: Foreign[] = Array.from(el.labels ?? []);
  return labels
    .map((label) => text(label?.textContent))
    .filter(Boolean)
    .join(" ");
}

/** A name an image or icon inside the control gives it. */
function innerName(el: Foreign): string {
  const img = el.querySelector?.("img[alt]:not([alt=''])");
  if (img) return text(img.getAttribute("alt"));
  const titled = el.querySelector?.("svg title, [aria-label]");
  return text(titled?.textContent) || text(titled?.getAttribute?.("aria-label"));
}

/** Every source of an accessible name, strongest first; an empty string means a screen reader has none. */
export function accessibleName(el: Foreign, doc: Foreign): string {
  const type = text(el.getAttribute?.("type")).toLowerCase();
  const own = VALUE_NAMED_TYPES.has(type) ? text(el.getAttribute?.("value")) || text(el.value) : "";
  return (
    text(el.getAttribute?.("aria-label")) ||
    labelledBy(el, doc) ||
    own ||
    labelsOf(el) ||
    text(el.textContent) ||
    innerName(el) ||
    text(el.getAttribute?.("title")) ||
    text(el.getAttribute?.("placeholder"))
  );
}

/** Whether a person can see and reach the element at all. */
function takesPart(el: Foreign): boolean {
  if (el.hidden === true || el.closest?.(INERT_SELECTOR)) return false;
  const rects = el.getClientRects?.();
  return rects === undefined || rects.length > 0;
}

/** A short rendering of a control's own markup: `<button class="icon">`. */
function describe(el: Foreign): string {
  const tag = String(el.tagName ?? "?").toLowerCase();
  const attrs = ["id", "class", "type", "href"]
    .map((name) => [name, text(el.getAttribute?.(name))] as const)
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}="${value}"`);
  return `<${[tag, ...attrs].join(" ")}>`.slice(0, DESCRIBE_CHARS);
}

/** The visible controls a screen reader cannot name. */
export function unnamedControls(doc: Foreign): { count: number; sample: string[] } {
  const found: string[] = [];
  let count = 0;
  const controls: Foreign[] = Array.from(doc?.querySelectorAll?.(CONTROL_SELECTOR) ?? []);
  for (const el of controls) {
    if (!takesPart(el) || accessibleName(el, doc)) continue;
    count += 1;
    if (found.length < UNNAMED_SAMPLE) found.push(describe(el));
  }
  return { count, sample: found };
}

/** How far the page runs past the window's width. */
function overflowOf(doc: Foreign): number {
  const root = doc?.documentElement;
  if (!root) return 0;
  const past = Number(root.scrollWidth) - Number(root.clientWidth);
  return Number.isFinite(past) && past > 0 ? Math.round(past) : 0;
}

/** Where the page is, as a person would say it. */
function viewOf(scope: Foreign): string {
  const here = scope.location;
  return here ? `${here.pathname ?? ""}${here.search ?? ""}${here.hash ?? ""}` : "";
}

/** The message of whatever an error event or rejection carries. */
function messageOf(reason: unknown): string {
  const shaped = reason as { message?: unknown } | null;
  const raw = shaped && typeof shaped === "object" && "message" in shaped ? shaped.message : reason;
  return String(raw ?? "").slice(0, ERROR_CHARS);
}

/** The listeners that count a person's inputs. */
function countInputs(scope: Foreign, counters: Counters, onInput: () => void): void {
  const doc = scope.document;
  let focused: unknown = null;
  const on = (type: string, handler: (event: Foreign) => void) => {
    try {
      doc.addEventListener(type, handler, true);
    } catch {
      /* a page that refuses a listener reports a smaller count */
    }
  };
  on("click", () => {
    counters.clicks += 1;
    onInput();
  });
  on("keydown", () => {
    counters.keys += 1;
    onInput();
  });
  on("input", (event) => {
    if (isEditable(event?.target)) counters.edits += 1;
    onInput();
  });
  on("focusin", (event) => {
    if (focused !== null && event?.target !== focused) counters.focusMoves += 1;
    focused = event?.target ?? null;
  });
}

/** Count address changes however they happen: links, history calls, back and forward. */
function countNavigations(scope: Foreign, counters: Counters): () => void {
  let last = viewOf(scope);
  const check = () => {
    const now = viewOf(scope);
    if (now === last) return;
    last = now;
    counters.navigations += 1;
  };
  for (const type of ["popstate", "hashchange"]) scope.addEventListener?.(type, check);
  for (const verb of ["pushState", "replaceState"]) {
    const original = scope.history?.[verb];
    if (typeof original !== "function") continue;
    scope.history[verb] = function (this: unknown, ...args: unknown[]) {
      const result = original.apply(this, args);
      check();
      return result;
    };
  }
  return check;
}

/** Count what goes wrong: uncaught errors, rejections, `console.error`, a resource that failed to load. */
function countErrors(scope: Foreign, counters: Counters): void {
  const note = (message: unknown) => {
    counters.errors += 1;
    counters.lastError = messageOf(message);
  };
  scope.addEventListener?.(
    "error",
    (event: Foreign) => {
      // A failed <img>, <script> or <link> reports on the element, not on the window.
      const target = event?.target;
      note(target && target !== scope ? `failed to load ${target.src ?? target.href ?? target.tagName}` : event);
    },
    true,
  );
  scope.addEventListener?.("unhandledrejection", (event: Foreign) => note(event?.reason));
  const original = scope.console?.error;
  if (typeof original !== "function") return;
  scope.console.error = function (this: unknown, ...args: unknown[]) {
    note(args[0]);
    return original.apply(this, args);
  };
}

/** Count the page changing within a moment of an input: the page answering a person. */
function countReactions(scope: Foreign, counters: Counters): () => void {
  let inputAt = Number.NEGATIVE_INFINITY;
  const now = () => Number(scope.performance?.now?.() ?? 0);
  const Observer = scope.MutationObserver;
  if (typeof Observer === "function" && scope.document?.documentElement) {
    const watcher = new Observer(() => {
      if (now() - inputAt <= REACTION_WINDOW_MS) counters.reactions += 1;
    });
    watcher.observe(scope.document.documentElement, { childList: true, subtree: true, characterData: true });
  }
  return () => {
    inputAt = now();
  };
}

/** What `installUiActivity` hands back. */
export interface UiActivity {
  report(): UiReport;
}

/**
 * Start counting on a page. Idempotent per scope: a second install returns the first.
 * `scope` is the page's window; the report is read whenever `state()` is.
 */
export function installUiActivity({ scope }: { scope: Foreign }): UiActivity {
  const existing = scope.__studioUi;
  if (existing && existing.version === UI_ACTIVITY_VERSION) return existing;
  const counters = zeroCounters();
  try {
    const markInput = countReactions(scope, counters);
    const checkView = countNavigations(scope, counters);
    countInputs(scope, counters, () => {
      markInput();
      checkView();
    });
    countErrors(scope, counters);
  } catch {
    /* a page the studio cannot watch still answers state() */
  }
  const activity = {
    version: UI_ACTIVITY_VERSION,
    report(): UiReport {
      const unnamed = unnamedControls(scope.document);
      return {
        version: UI_ACTIVITY_VERSION,
        ...counters,
        view: viewOf(scope),
        unnamedControls: unnamed.count,
        unnamedSample: unnamed.sample,
        overflowX: overflowOf(scope.document),
      };
    },
  };
  try {
    Object.defineProperty(scope, "__studioUi", { value: activity, configurable: true });
  } catch {
    /* the report is still returned to the caller */
  }
  return activity;
}
