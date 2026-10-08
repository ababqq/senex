/**
 * The two guard payloads, `chromeAtInPage` (what is under a click) and `describeFocusInPage` (where
 * keyboard focus sits), plus `blurActiveInPage`, replayed against a FAKE DOM tree in a bare
 * `node:vm` context: page-side source may name only globals, and running its `toString()` is what
 * proves that. The measured shape: an inline row `<div>[Start] [Options]</div>` reads as one line,
 * and a guard that matched container text refused Start for the label beside it. Ported from
 * genex-demo's `prober/guards.test.ts`, without the hosted embed SDK's markers.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { blurActiveInPage, chromeAtInPage, describeFocusInPage } from "../../scripts/evals/prober/start-control.ts";
import { chromeNameRefusal, keyFocusRefusal } from "../../scripts/evals/prober/verdicts.ts";

function inPage<T>(fn: (...args: never[]) => T, document: unknown, arg?: unknown): T {
  const ctx = vm.createContext({ document, __arg: arg });
  return vm.runInContext(`(${fn.toString()})(__arg)`, ctx) as T;
}

type Node = {
  readonly id: string;
  readonly tag: string;
  readonly attrs: Record<string, string>;
  readonly text: string;
  readonly children: Node[];
  parent: Node | null;
  /** Only the leaf's own text is `innerText`; a container's is its subtree's, space-joined. */
  readonly innerText: string;
  readonly textContent: string;
  readonly isContentEditable: boolean;
  readonly tagName: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  closest(selector: string): Node | null;
  matches(selector: string): boolean;
  blur(): void;
  readonly value?: string;
  readonly placeholder?: string;
};

type Spec = {
  readonly id: string;
  readonly tag: string;
  readonly attrs?: Record<string, string>;
  readonly text?: string;
  readonly children?: readonly Spec[];
  readonly editable?: boolean;
};

/** `tag`, `tag[attr]`, `[attr]`, `[attr="v"]`, `tag[attr="v"]`, comma lists — what the two payloads use. */
function matchesSimple(node: Node, selector: string): boolean {
  return selector.split(",").some((part) => {
    const s = part.trim();
    const m = /^([a-z]*)((?:\[[^\]]+\])*)$/i.exec(s);
    if (!m) return false;
    const tag = m[1];
    if (tag && node.tag.toLowerCase() !== tag.toLowerCase()) return false;
    const attrs = [...(m[2] ?? "").matchAll(/\[([a-z-]+)(?:="([^"]*)")?\]/gi)];
    return attrs.every(([, name, value]) => {
      if (!(name in node.attrs)) return false;
      return value === undefined || node.attrs[name] === value;
    });
  });
}

function build(spec: Spec, parent: Node | null, all: Node[]): Node {
  const node: Node = {
    id: spec.id,
    tag: spec.tag,
    attrs: { ...(spec.attrs ?? {}) },
    text: spec.text ?? "",
    children: [],
    parent,
    get innerText() {
      const own = [this.text, ...this.children.map((c) => c.innerText)].filter(Boolean);
      return own.join(" ");
    },
    get textContent() {
      return this.innerText;
    },
    isContentEditable: spec.editable === true,
    tagName: spec.tag.toUpperCase(),
    getAttribute: (name) => (name in node.attrs ? node.attrs[name] : null),
    hasAttribute: (name) => name in node.attrs,
    matches: (selector) => matchesSimple(node, selector),
    closest: (selector) => {
      let el: Node | null = node;
      while (el) {
        if (el.matches(selector)) return el;
        el = el.parent;
      }
      return null;
    },
    blur: () => {
      if (activeElement === node) activeElement = body;
    },
  };
  all.push(node);
  for (const c of spec.children ?? []) node.children.push(build(c, node, all));
  return node;
}

let body: Node;
let activeElement: Node;

function mount(
  specs: readonly Spec[],
  hitId: string | null,
  focusId?: string,
): { document: { readonly activeElement: Node }; byId: (id: string) => Node } {
  const all: Node[] = [];
  body = build({ id: "body", tag: "body", children: specs }, null, all);
  const byId = (id: string): Node => {
    const n = all.find((e) => e.id === id);
    if (!n) throw new Error(`no fixture element ${id}`);
    return n;
  };
  activeElement = focusId ? byId(focusId) : body;
  const document = {
    get body() {
      return body;
    },
    get activeElement() {
      return activeElement;
    },
    elementFromPoint: () => (hitId ? byId(hitId) : null),
    getElementById: (id: string) => all.find((e) => e.id === id) ?? null,
  };
  return { byId, document };
}

/** The measured row: an inline button row whose text reads as one line. */
const ROW: Spec = {
  id: "row",
  tag: "div",
  children: [
    { id: "start", tag: "button", children: [{ id: "start-label", tag: "span", text: "Start" }] },
    { id: "options", tag: "button", children: [{ id: "options-label", tag: "span", text: "Options" }] },
  ],
};

function clickReason(specs: readonly Spec[], hitId: string): string | null {
  const dom = mount(specs, hitId);
  const found = inPage(chromeAtInPage, dom.document, { x: 0, y: 0 });
  if (found === null) return null;
  if (typeof found === "string") return found;
  return chromeNameRefusal(found);
}

test('THE MEASURED CASE: "Start Options" — a click on Start\'s label goes through, a click on Options is refused', () => {
  const dom = mount([ROW], "start-label");
  assert.equal(
    dom.byId("row").innerText,
    "Start Options",
    "the premise: the row reads as one short line the old walk matched",
  );
  assert.equal(clickReason([ROW], "start-label"), null, "Start is not refused for the button beside it");
  assert.match(clickReason([ROW], "options-label") ?? "", /control named "Options"/);
  assert.match(clickReason([ROW], "options") ?? "", /control named "Options"/, "the button itself, not only its label");
});

test("the target is the NEAREST interactive ancestor's accessible name — aria-label outranks text, a label is found through a plain span", () => {
  const labelled: Spec = {
    id: "wrap",
    tag: "div",
    text: "Settings",
    children: [
      {
        id: "go",
        tag: "div",
        attrs: { role: "button", "aria-label": "Play now" },
        children: [{ id: "icon", tag: "span", text: "▶" }],
      },
    ],
  };
  assert.equal(
    clickReason([labelled], "icon"),
    null,
    '"Play now" is the name; the wrapper\'s "Settings" is never consulted',
  );
  const named: Spec = {
    id: "x",
    tag: "button",
    attrs: { "aria-label": "Close" },
    children: [{ id: "glyph", tag: "span", text: "" }],
  };
  assert.match(clickReason([named], "glyph") ?? "", /"Close"/);
});

test("a link refuses before any name is read", () => {
  const link: Spec = {
    id: "a",
    tag: "a",
    attrs: { href: "https://more-projects.example.test/" },
    children: [{ id: "lt", tag: "span", text: "Play more" }],
  };
  assert.match(clickReason([link], "lt") ?? "", /inside a link to https:\/\/more-projects\.example\.test\//);
});

test("with no interactive ancestor the hit element's OWN text is read, never a container's", () => {
  // A non-semantic clickable div labelled Sign in is still refused…
  const divBar: Spec = { id: "bar", tag: "div", text: "Sign in" };
  assert.match(clickReason([divBar], "bar") ?? "", /"Sign in"/);
  // …while the canvas inside a HUD whose container text mentions Settings is not.
  const hud: Spec = { id: "hud", tag: "div", text: "Settings", children: [{ id: "canvas", tag: "canvas" }] };
  assert.equal(clickReason([hud], "canvas"), null);
  assert.equal(inPage(chromeAtInPage, mount([], null).document, { x: 0, y: 0 }), null, "nothing under the point");
});

test('THE HAZARD: a focused "Sign in" button refuses Enter; blurring it clears the refusal', () => {
  const bar: Spec = { id: "bar", tag: "div", children: [{ id: "signin", tag: "button", text: "Sign in" }] };
  const dom = mount([bar, { id: "canvas", tag: "canvas", attrs: { tabindex: "0" } }], null, "signin");
  const before = inPage(describeFocusInPage, dom.document);
  assert.equal(before.tag, "BUTTON");
  assert.equal(before.name, "Sign in");
  assert.match(keyFocusRefusal(before) ?? "", /form control <button> "Sign in"/);
  assert.equal(inPage(blurActiveInPage, dom.document), true, "the one retry: blur");
  const after = inPage(describeFocusInPage, dom.document);
  assert.equal(after.tag, "BODY");
  assert.equal(keyFocusRefusal(after), null, "body focus lets the key through");
  assert.equal(inPage(blurActiveInPage, dom.document), false, "nothing to blur on the body");
});

test("a focused canvas or plain div passes the key guard; a focused project start button and an input do not", () => {
  const specs: readonly Spec[] = [
    { id: "canvas", tag: "canvas", attrs: { tabindex: "0" } },
    { id: "wrap", tag: "div", attrs: { tabindex: "-1" } },
    { id: "play", tag: "button", text: "PLAY" },
    { id: "name", tag: "input", attrs: { type: "text" } },
    { id: "note", tag: "div", editable: true },
  ];
  const focusOn = (id: string): string | null =>
    keyFocusRefusal(inPage(describeFocusInPage, mount(specs, null, id).document));
  assert.equal(focusOn("canvas"), null);
  assert.equal(focusOn("wrap"), null);
  assert.match(focusOn("play") ?? "", /form control <button> "PLAY"/);
  assert.match(focusOn("name") ?? "", /<input type=text>/);
  assert.match(focusOn("note") ?? "", /editable/);
});

test("a focused <iframe> refuses the key: it is a frame nothing here reads (the routed frame is descended into on the Node side)", () => {
  // A wrapper page: the project in a same-origin iframe, an ad in another. Keys
  // go to the TOP document's focused element, so the guard reads the top
  // document first; an <iframe> it did not descend into is refused.
  const specs: readonly Spec[] = [
    { id: "project", tag: "iframe", attrs: { title: "project" } },
    { id: "ad", tag: "iframe", attrs: { title: "sponsor" } },
  ];
  const focus = inPage(describeFocusInPage, mount(specs, null, "ad").document);
  assert.equal(focus.tag, "IFRAME");
  assert.equal(focus.name, "sponsor");
  assert.match(keyFocusRefusal(focus) ?? "", /<iframe> "sponsor" that is not the frame the reads target/);
});

test("blurring a focused element INSIDE a shadow root reports success at that depth, though document.activeElement stays the host", () => {
  const dom = mount(
    [
      { id: "host", tag: "div" },
      { id: "canvas", tag: "canvas" },
    ],
    null,
    "host",
  );
  const host = dom.byId("host");
  // The open shadow root's own button holds focus; from outside, the document
  // reports the host and keeps reporting it after the inner blur.
  const inner = {
    tagName: "BUTTON",
    blur() {
      shadow.activeElement = null;
    },
  };
  const shadow: { activeElement: unknown } = { activeElement: inner };
  Object.assign(host, { shadowRoot: shadow });
  assert.equal(inPage(blurActiveInPage, dom.document), true, "focus moved off the inner button");
  assert.equal(shadow.activeElement, null);
  assert.equal(dom.document.activeElement, host, "the premise: the host is still the document-level activeElement");
});
