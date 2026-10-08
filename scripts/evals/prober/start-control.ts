/**
 * FIND THE PROJECT'S OWN START CONTROL, and never page chrome, and never something buried under an
 * overlay. Plus the other page-side payloads the probe serialises: what is under a click
 * (`chromeAtInPage`), where keyboard focus sits (`describeFocusInPage`), dropping focus
 * (`blurActiveInPage`), a "press any key" title line (`findPressAnyKeyInPage`) and the look phase's
 * synthetic mouse deltas (`dispatchLookDeltasInPage`).
 *
 * Every function here is PAGE-SIDE source: `page.evaluate` serialises it with
 * `Function.prototype.toString`, so it names only page globals and its one argument; a module-scope
 * helper or constant would be a ReferenceError in the page. That is also what makes each replayable
 * against a fake DOM in `node:vm` with no browser.
 *
 * WHY THE FINDER SCORES INSTEAD OF MATCHING: projects name their start button after their fiction
 * ("DEPLOY", "Walk in"), so an anchored vocabulary misses them. Two halves carry the weight: the deny
 * list (`CHROME_DENY_SOURCE`, passed in because module scope is not visible) and a GEOMETRIC
 * predicate: a candidate must be the topmost hit at its own centre (itself or a descendant), so a
 * HUD legend under a full-screen overlay cannot outscore the overlay's own call to action. The walk
 * descends open shadow roots, and the hit test descends through shadow hosts.
 */

/** Where a synthetic look move was dispatched. */
export type LookTarget = "lock" | "canvas" | "none";

/** The finder's cover report: a visible control an invisible element covers. */
export interface OccludedControl {
  text: string;
  by: string;
}

/**
 * Mark and return the best start control's text (`[data-genex-probe-start]`), or `null`. A visible
 * control under an INVISIBLE cover is recorded instead (`[data-genex-probe-occluded]`), never clicked.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: page-side source serialized with toString(), so it stays one self-contained function
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: page-side source serialized with toString(), so it stays one self-contained function
export function findStartControlInPage(denySource: string): string | null {
  const DENY = new RegExp(denySource, "i");
  const PLAY =
    /(play|start|begin|enter|continue|deploy|launch|resume|new project|go\b|jump in|drop in|walk in|step in|step inside|come in|wander in|spawn|ready|fight|race|drive|run\b)/i;
  const MARK = "data-genex-probe-start";
  const MARK_OCCLUDED = "data-genex-probe-occluded";
  const MAX_LABEL = 44;
  const MIN_WIDTH = 24;
  const MIN_HEIGHT = 12;
  const INVISIBLE = 0.1;
  const MAX_DEPTH = 8;
  const MAX_ANCESTORS = 48;
  type Root = { querySelectorAll: (s: string) => ArrayLike<Element> };
  type WithShadow = Element & { shadowRoot?: ShadowRoot | null };
  // Every open shadow root too: a query on the document alone never sees inside a component.
  const collect = (root: Root, selector: string, out: Element[]): void => {
    const found = root.querySelectorAll(selector);
    for (let i = 0; i < found.length; i++) out.push(found[i]);
    const hosts = root.querySelectorAll("*");
    for (let i = 0; i < hosts.length; i++) {
      const sr = (hosts[i] as WithShadow).shadowRoot;
      if (sr) collect(sr, selector, out);
    }
  };
  // `document.elementFromPoint` retargets a hit inside a shadow tree to its host.
  const deepElementFromPoint = (x: number, y: number): Element | null => {
    let hit: Element | null = document.elementFromPoint(x, y);
    for (let depth = 0; hit && depth < MAX_DEPTH; depth++) {
      const sr = (hit as WithShadow).shadowRoot;
      if (!sr || typeof sr.elementFromPoint !== "function") break;
      const inner = sr.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  };
  // EFFECTIVE opacity: the element's own times every ancestor's. A card at opacity 0 whose children
  // read opacity 1 is still invisible, and still takes the clicks meant for what is beneath it.
  const effOpacity = (start: Element | null): number => {
    let o = 1;
    let n: Element | null = start;
    for (let i = 0; n && i < MAX_ANCESTORS; i++) {
      const v = Number(getComputedStyle(n).opacity);
      if (!Number.isNaN(v)) o *= v;
      if (o < INVISIBLE) return o;
      n = n.parentElement;
    }
    return o;
  };
  // A short CSS-ish name for the element that took the hit, so the verdict can name the cover.
  const describe = (el: Element): string => {
    const raw = (el as HTMLElement).className;
    const cls = typeof raw === "string" ? raw.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
    const id = el.id ? `#${el.id}` : "";
    const classes = cls.length ? `.${cls.join(".")}` : "";
    const hidden = el.getAttribute("hidden") !== null ? "[hidden]" : "";
    return `${el.tagName.toLowerCase()}${id}${classes}${hidden} (effective opacity ${effOpacity(el).toFixed(2)})`;
  };
  // ONE MARKED ELEMENT AT A TIME: a strict-mode click on a selector matching two elements throws.
  for (const attr of [MARK, MARK_OCCLUDED]) {
    const marked: Element[] = [];
    collect(document, `[${attr}]`, marked);
    for (const el of marked) el.removeAttribute(attr);
  }
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;
  let best: { el: HTMLElement; score: number; text: string } | null = null;
  let occluded: { el: HTMLElement; score: number; text: string; by: string } | null = null;
  const all: Element[] = [];
  collect(document, 'button, [role="button"], a, .start, #start, div, span', all);
  for (const el of all as HTMLElement[]) {
    const text = (el.innerText || el.textContent || "").trim();
    if (!text || text.length > MAX_LABEL || text.includes("\n") || DENY.test(text) || !PLAY.test(text)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < MIN_WIDTH || rect.height < MIN_HEIGHT) continue;
    // Off-screen or invisible controls are not what a player would press.
    if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || effOpacity(el) < INVISIBLE) continue;
    const px = (rect.left + rect.right) / 2;
    const py = (rect.top + rect.bottom) / 2;
    if (px < 0 || py < 0 || px > vw || py > vh) continue;
    let score = 0;
    if (el.tagName === "BUTTON" || el.getAttribute("role") === "button") score += 4;
    if (cs.cursor === "pointer") score += 3;
    // Centre-weighted: a start control sits in the middle of a menu, while chrome hugs an edge.
    score += 2 * (1 - Math.min(1, Math.abs(px / vw - 0.5) * 2));
    score += 1 * (1 - Math.min(1, Math.abs(py / vh - 0.5) * 2));
    // Prefer the shortest matching label: "DEPLOY" over a paragraph that happens to say "play".
    score += Math.max(0, 2 - text.length / 20);
    const hit = deepElementFromPoint(px, py);
    if (!hit || !(hit === el || el.contains(hit))) {
      // A VISIBLE control under an INVISIBLE cover is a defect a player meets too: recorded, never
      // clicked. A visible cover is the ordinary "painted over" case and stays a plain skip.
      const invisibleCover = hit !== null && effOpacity(hit) < INVISIBLE;
      if (invisibleCover && (!occluded || score > occluded.score)) occluded = { el, score, text, by: describe(hit) };
      continue;
    }
    if (!best || score > best.score) best = { el, score, text };
  }
  if (best) {
    best.el.setAttribute(MARK, "");
    return best.text;
  }
  if (occluded) occluded.el.setAttribute(MARK_OCCLUDED, JSON.stringify({ text: occluded.text, by: occluded.by }));
  return null;
}

/** Read back the cover report `findStartControlInPage` left on an occluded control, as JSON text. */
export function readOccludedStartControlInPage(): string | null {
  const ATTR = "data-genex-probe-occluded";
  type Root = { querySelectorAll: (s: string) => ArrayLike<Element> };
  const collect = (root: Root, out: Element[]): void => {
    const found = root.querySelectorAll(`[${ATTR}]`);
    for (let i = 0; i < found.length; i++) out.push(found[i]);
    const hosts = root.querySelectorAll("*");
    for (let i = 0; i < hosts.length; i++) {
      const sr = (hosts[i] as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (sr) collect(sr, out);
    }
  };
  const found: Element[] = [];
  collect(document, found);
  return found.length ? found[0].getAttribute(ATTR) : null;
}

/**
 * WHAT IS UNDER A CLICK: the page-side half of the click guard. A refusal string for a link, or a
 * `ClickTarget` for the text rule (`chromeNameRefusal`): the accessible name of the NEAREST
 * interactive ancestor of the hit, never a container's concatenated text. `null` when nothing is under
 * the point. `ox`/`oy` translate viewport coordinates into a routed frame's own.
 */
export function chromeAtInPage(arg: {
  x: number;
  y: number;
  ox?: number;
  oy?: number;
}): string | { interactive: boolean; name: string } | null {
  const INTERACTIVE =
    'button, a, input, select, textarea, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"]';
  const MAX_NAME = 200;
  const MAX_DEPTH = 8;
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: page-side source serialized with toString(), so it stays one self-contained function
  const nameOf = (el: Element): string => {
    const attr = (n: string): string => (el.getAttribute(n) || "").trim();
    const label = attr("aria-label");
    if (label) return label;
    const by = attr("aria-labelledby");
    const parts: string[] = [];
    for (const id of by ? by.split(/\s+/) : []) {
      const ref = document.getElementById(id);
      if (ref) parts.push(((ref as HTMLElement).innerText || ref.textContent || "").trim());
    }
    const joined = parts.filter(Boolean).join(" ").trim();
    if (joined) return joined;
    if (el.tagName === "INPUT") {
      const input = el as HTMLInputElement;
      const own = (input.value || input.placeholder || attr("title")).trim();
      if (own) return own;
    }
    return attr("title") || ((el as HTMLElement).innerText || el.textContent || "").trim();
  };
  const x = arg.x - (arg.ox || 0);
  const y = arg.y - (arg.oy || 0);
  let hit: Element | null = document.elementFromPoint(x, y);
  for (let depth = 0; hit && depth < MAX_DEPTH; depth++) {
    const sr = (hit as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (!sr || typeof sr.elementFromPoint !== "function") break;
    const inner = sr.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  if (!hit) return null;
  const link = hit.closest("a[href]");
  if (link) return `inside a link to ${(link.getAttribute("href") || "").slice(0, 80)}`;
  const control = hit.closest(INTERACTIVE);
  if (control) return { interactive: true, name: nameOf(control).slice(0, MAX_NAME) };
  return { interactive: false, name: nameOf(hit).slice(0, MAX_NAME) };
}

/**
 * WHERE KEYBOARD FOCUS SITS: the page-side half of the key guard. Descends through shadow hosts, whose
 * `activeElement` is the host from outside.
 */
export function describeFocusInPage(): {
  tag: string;
  type: string | null;
  role: string | null;
  href: boolean;
  contentEditable: boolean;
  name: string;
} {
  const MAX_DEPTH = 8;
  const MAX_NAME = 80;
  const nameOf = (el: Element): string => {
    const attr = (n: string): string => (el.getAttribute(n) || "").trim();
    const label = attr("aria-label");
    if (label) return label;
    if (el.tagName === "INPUT") {
      const input = el as HTMLInputElement;
      const own = (input.value || input.placeholder || attr("title")).trim();
      if (own) return own;
    }
    return attr("title") || ((el as HTMLElement).innerText || el.textContent || "").trim();
  };
  let el: Element | null = document.activeElement;
  for (let depth = 0; el && depth < MAX_DEPTH; depth++) {
    const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (!sr?.activeElement || sr.activeElement === el) break;
    el = sr.activeElement;
  }
  const focused = el || document.body;
  if (!focused) return { tag: "NONE", type: null, role: null, href: false, contentEditable: false, name: "" };
  return {
    tag: String(focused.tagName || "").toUpperCase(),
    type: focused.getAttribute("type"),
    role: focused.getAttribute("role"),
    href: focused.tagName === "A" && focused.hasAttribute("href"),
    contentEditable: (focused as HTMLElement).isContentEditable === true,
    name: nameOf(focused).slice(0, MAX_NAME),
  };
}

/**
 * Drop focus so a refused key can be retried once. Success is read at the depth the element was
 * found: inside a shadow root `document.activeElement` stays the HOST after a blur.
 */
export function blurActiveInPage(): boolean {
  const MAX_DEPTH = 8;
  const deepest = (): Element | null => {
    let el: Element | null = document.activeElement;
    for (let depth = 0; el && depth < MAX_DEPTH; depth++) {
      const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (!sr?.activeElement || sr.activeElement === el) break;
      el = sr.activeElement;
    }
    return el;
  };
  const el = deepest();
  if (!el || el === document.body) return false;
  const html = el as HTMLElement;
  if (typeof html.blur !== "function") return false;
  html.blur();
  return deepest() !== el;
}

/**
 * A "PRESS ANY KEY" TITLE LINE: consulted only when no start control was found. The affordance's own
 * shape (press / hit / tap, an optional "any", then the thing to press, or "[SPACE] to start"), and
 * deliberately NOT "Press E to interact", a HUD legend on a project already running. The same visibility
 * and topmost-at-centre rules as the finder apply. Marks nothing and clicks nothing.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: page-side source serialized with toString(), so it stays one self-contained function
export function findPressAnyKeyInPage(): string | null {
  const AFFORDANCE =
    /\b(press|hit|tap)\s+(any\s+)?(key|space|enter|start|button|a\s+key)\b|\[\s*(space|enter|any\s*key)\s*\]\s*(to\s+)?(start|play|begin|continue|enter)|\b(space|enter)\s+to\s+(start|play|begin|continue|enter)\b/i;
  const MAX_LINE = 80;
  const MIN_WIDTH = 24;
  const MIN_HEIGHT = 8;
  const INVISIBLE = 0.1;
  const MAX_DEPTH = 8;
  const MAX_ANCESTORS = 48;
  type Root = { querySelectorAll: (s: string) => ArrayLike<Element> };
  type WithShadow = Element & { shadowRoot?: ShadowRoot | null };
  const collect = (root: Root, selector: string, out: Element[]): void => {
    const found = root.querySelectorAll(selector);
    for (let i = 0; i < found.length; i++) out.push(found[i]);
    const hosts = root.querySelectorAll("*");
    for (let i = 0; i < hosts.length; i++) {
      const sr = (hosts[i] as WithShadow).shadowRoot;
      if (sr) collect(sr, selector, out);
    }
  };
  const deepElementFromPoint = (x: number, y: number): Element | null => {
    let hit: Element | null = document.elementFromPoint(x, y);
    for (let depth = 0; hit && depth < MAX_DEPTH; depth++) {
      const sr = (hit as WithShadow).shadowRoot;
      if (!sr || typeof sr.elementFromPoint !== "function") break;
      const inner = sr.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  };
  // Effective (inherited) opacity: a line inside an invisible card is not an affordance.
  const effOpacity = (start: Element): number => {
    let eff = 1;
    let n: Element | null = start;
    for (let i = 0; n && i < MAX_ANCESTORS && eff >= INVISIBLE; i++) {
      const v = Number(getComputedStyle(n).opacity);
      if (!Number.isNaN(v)) eff *= v;
      n = n.parentElement;
    }
    return eff;
  };
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;
  const all: Element[] = [];
  collect(document, "div, span, p, h1, h2, h3, h4, button, a, label, small, em, strong", all);
  let best: string | null = null;
  for (const el of all as HTMLElement[]) {
    const text = (el.innerText || el.textContent || "").trim();
    if (!text || text.length > MAX_LINE || text.includes("\n") || !AFFORDANCE.test(text)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < MIN_WIDTH || rect.height < MIN_HEIGHT) continue;
    if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || effOpacity(el) < INVISIBLE) continue;
    const px = (rect.left + rect.right) / 2;
    const py = (rect.top + rect.bottom) / 2;
    if (px < 0 || py < 0 || px > vw || py > vh) continue;
    const hit = deepElementFromPoint(px, py);
    if (!hit || !(hit === el || el.contains(hit))) continue;
    // The shortest matching line is the affordance itself, not a paragraph that contains it.
    if (best === null || text.length < best.length) best = text;
  }
  return best;
}

/**
 * THE LOOK PHASE'S SYNTHETIC MOUSE DELTAS: one `pointermove` and one `mousemove` per call, each with
 * an explicit `movementX`/`movementY`, on the pointer-lock element or else the largest canvas. A
 * LOCKED project reads `movementX` with no button held; a project with NO lock reads look input from a
 * DRAG, so without a lock the events go out as a real gesture: a press at the target's centre on
 * `start`, moves whose coordinates advance by the caller's offset with `buttons: 1`, a release on
 * `end`. The events are untrusted; the caller reads the camera to see whether they landed.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: page-side source serialized with toString(), so it stays one self-contained function
export function dispatchLookDeltasInPage(arg: {
  dx: number;
  dy: number;
  /** Pixels from the target's centre this move lands at. Drag shape only. */
  offsetX?: number;
  offsetY?: number;
  /** `start` presses before the move, `end` releases after it. Drag shape only. */
  phase?: "start" | "move" | "end";
}): { target: LookTarget; dispatched: number } {
  let target: Element | null = null;
  let kind: LookTarget = "none";
  try {
    target = document.pointerLockElement;
  } catch {
    target = null;
  }
  if (target) kind = "lock";
  else {
    let bestArea = 0;
    const canvases = document.querySelectorAll("canvas");
    for (let i = 0; i < canvases.length; i++) {
      const c = canvases[i] as HTMLCanvasElement;
      const rect = c.getBoundingClientRect();
      const area = Math.max(rect.width * rect.height, (c.width || 0) * (c.height || 0));
      if (area > bestArea) {
        bestArea = area;
        target = c;
      }
    }
    if (target) kind = "canvas";
  }
  if (!target) return { target: "none", dispatched: 0 };
  const rect = target.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const drag = kind !== "lock";
  const atX = drag ? cx + (arg.offsetX || 0) : cx;
  const atY = drag ? cy + (arg.offsetY || 0) : cy;
  const el = target;
  let dispatched = 0;
  const at = (x: number, y: number, dx: number, dy: number, buttons: number) => ({
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    movementX: dx,
    movementY: dy,
    button: 0,
    buttons,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  });
  // Both event families, so a handler on either one sees the gesture.
  const send = (pointerType: string, mouseType: string, init: Record<string, unknown>) => {
    try {
      if (typeof PointerEvent === "function") {
        el.dispatchEvent(new PointerEvent(pointerType, init as PointerEventInit));
        dispatched++;
      }
    } catch {
      // A page without PointerEvent still gets the mouse event.
    }
    try {
      el.dispatchEvent(new MouseEvent(mouseType, init as MouseEventInit));
      dispatched++;
    } catch {
      // Nothing more to try.
    }
  };
  // The press lands at the CENTRE, before the first move, so a handler that records its origin on
  // pointerdown does not lose the first frame of the drag.
  if (drag && arg.phase === "start") send("pointerdown", "mousedown", at(cx, cy, 0, 0, 1));
  send("pointermove", "mousemove", at(atX, atY, arg.dx, arg.dy, drag ? 1 : 0));
  if (drag && arg.phase === "end") send("pointerup", "mouseup", at(atX, atY, 0, 0, 0));
  return { target: kind, dispatched };
}
