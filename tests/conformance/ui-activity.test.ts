/**
 * ui-activity.ts — what a person's hands did to the page, and what a screen reader finds on it.
 * The page is a stub window: listeners are recorded and fired by hand, elements are plain objects.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accessibleName, installUiActivity, isEditable, unnamedControls } from "../../src/page/ui-activity.ts";

type Handler = (event: Record<string, unknown>) => void;

interface StubElement {
  tagName: string;
  attrs?: Record<string, string>;
  textContent?: string;
  value?: string;
  labels?: Array<{ textContent: string }>;
  hidden?: boolean;
  rects?: number;
  inert?: boolean;
  isContentEditable?: boolean;
}

/** An element with just the surface the module reads. */
function element(spec: StubElement) {
  return {
    tagName: spec.tagName,
    textContent: spec.textContent ?? "",
    value: spec.value,
    labels: spec.labels ?? [],
    hidden: spec.hidden ?? false,
    isContentEditable: spec.isContentEditable ?? false,
    getAttribute: (name: string) => spec.attrs?.[name] ?? null,
    querySelector: () => null,
    closest: () => (spec.inert ? {} : null),
    getClientRects: () => ({ length: spec.rects ?? 1 }),
  };
}

/** A page: a document and window that record their listeners, a clock the test moves, a history. */
function stubPage(options: { controls?: StubElement[]; scrollWidth?: number; clientWidth?: number } = {}) {
  const docHandlers = new Map<string, Handler[]>();
  const winHandlers = new Map<string, Handler[]>();
  const add = (into: Map<string, Handler[]>) => (type: string, handler: Handler) => {
    into.set(type, [...(into.get(type) ?? []), handler]);
  };
  const clock = { now: 0 };
  const consoleErrors: unknown[][] = [];
  const mutations: Array<() => void> = [];
  const location = { pathname: "/", search: "", hash: "" };
  const history = {
    pushState(_state: unknown, _title: string, url: string) {
      location.pathname = url;
    },
    replaceState(_state: unknown, _title: string, url: string) {
      location.pathname = url;
    },
  };
  const scope = {
    document: {
      addEventListener: add(docHandlers),
      querySelectorAll: () => (options.controls ?? []).map(element),
      getElementById: (id: string) => (id === "heading" ? { textContent: "Billing" } : null),
      documentElement: { scrollWidth: options.scrollWidth ?? 800, clientWidth: options.clientWidth ?? 800 },
    },
    addEventListener: add(winHandlers),
    location,
    history,
    performance: { now: () => clock.now },
    console: { error: (...args: unknown[]) => consoleErrors.push(args) },
    MutationObserver: class {
      constructor(callback: () => void) {
        mutations.push(callback);
      }
      observe() {}
    },
  };
  const fire = (from: Map<string, Handler[]>, type: string, event: Record<string, unknown> = {}) => {
    for (const handler of from.get(type) ?? []) handler(event);
  };
  return {
    scope,
    clock,
    consoleErrors,
    document: (type: string, event?: Record<string, unknown>) => fire(docHandlers, type, event),
    window: (type: string, event?: Record<string, unknown>) => fire(winHandlers, type, event),
    mutate: () => {
      for (const callback of mutations) callback();
    },
  };
}

describe("counting what a person does", () => {
  it("counts clicks, keys, typing into fields and focus moving between elements", () => {
    const page = stubPage();
    const activity = installUiActivity({ scope: page.scope });
    const field = element({ tagName: "INPUT" });
    const button = element({ tagName: "BUTTON" });
    page.document("click");
    page.document("keydown");
    page.document("keydown");
    page.document("input", { target: field });
    page.document("input", { target: element({ tagName: "DIV" }) });
    page.document("focusin", { target: field });
    page.document("focusin", { target: field });
    page.document("focusin", { target: button });
    const report = activity.report();
    assert.equal(report.clicks, 1);
    assert.equal(report.keys, 2);
    assert.equal(report.edits, 1, "an input event from something that is not a field is not an edit");
    assert.equal(report.focusMoves, 1, "the first focus is not a move, and the same element again is not one");
  });

  it("counts an address change once however it arrives", () => {
    const page = stubPage();
    const activity = installUiActivity({ scope: page.scope });
    page.scope.history.pushState({}, "", "/settings");
    assert.equal(activity.report().navigations, 1);
    page.scope.history.replaceState({}, "", "/settings");
    assert.equal(activity.report().navigations, 1, "the same address again is not a navigation");
    page.scope.location.hash = "#billing";
    page.window("hashchange");
    page.window("popstate");
    const report = activity.report();
    assert.equal(report.navigations, 2, "a hashchange and its popstate are one move");
    assert.equal(report.view, "/settings#billing");
  });

  it("counts what goes wrong and still lets console.error through", () => {
    const page = stubPage();
    const activity = installUiActivity({ scope: page.scope });
    page.scope.console.error("boom");
    page.window("error", { message: "Uncaught TypeError: x is not a function", target: page.scope });
    page.window("error", { target: { tagName: "IMG", src: "/missing.png" } });
    page.window("unhandledrejection", { reason: new Error("rejected") });
    const report = activity.report();
    assert.equal(report.errors, 4);
    assert.equal(report.lastError, "rejected");
    assert.deepEqual(page.consoleErrors, [["boom"]], "the page's own console.error still runs");
  });

  it("counts the page changing only within a moment of an input", () => {
    const page = stubPage();
    const activity = installUiActivity({ scope: page.scope });
    page.mutate();
    assert.equal(activity.report().reactions, 0, "a page that changes by itself is not answering anyone");
    page.clock.now = 1000;
    page.document("click");
    page.clock.now = 1200;
    page.mutate();
    page.clock.now = 5000;
    page.mutate();
    assert.equal(activity.report().reactions, 1);
  });

  it("is installed once per page", () => {
    const page = stubPage();
    const first = installUiActivity({ scope: page.scope });
    const second = installUiActivity({ scope: page.scope });
    page.document("click");
    assert.equal(second, first);
    assert.equal(first.report().clicks, 1);
  });

  it("survives a page that refuses everything", () => {
    const activity = installUiActivity({ scope: {} });
    assert.deepEqual(
      { ...activity.report(), unnamedSample: [] },
      {
        version: 1,
        clicks: 0,
        keys: 0,
        edits: 0,
        focusMoves: 0,
        navigations: 0,
        reactions: 0,
        errors: 0,
        lastError: null,
        view: "",
        unnamedControls: 0,
        unnamedSample: [],
        overflowX: 0,
      },
    );
  });
});

describe("reading the page the way a screen reader does", () => {
  const doc = { getElementById: (id: string) => (id === "heading" ? { textContent: "Billing" } : null) };

  it("names a control from its label, text, value, title or alternative text", () => {
    assert.equal(accessibleName(element({ tagName: "BUTTON", attrs: { "aria-label": "Close" } }), doc), "Close");
    assert.equal(accessibleName(element({ tagName: "BUTTON", textContent: " Save " }), doc), "Save");
    assert.equal(accessibleName(element({ tagName: "A", attrs: { "aria-labelledby": "heading" } }), doc), "Billing");
    assert.equal(accessibleName(element({ tagName: "INPUT", attrs: { type: "submit" }, value: "Send" }), doc), "Send");
    assert.equal(
      accessibleName(element({ tagName: "INPUT", labels: [{ textContent: "Email address" }] }), doc),
      "Email address",
    );
    assert.equal(accessibleName(element({ tagName: "BUTTON", attrs: { title: "Help" } }), doc), "Help");
    assert.equal(accessibleName(element({ tagName: "BUTTON" }), doc), "", "an icon button with nothing has no name");
  });

  it("lists the visible controls nobody can name, and skips hidden and inert ones", () => {
    const page = stubPage({
      controls: [
        { tagName: "BUTTON", textContent: "Save" },
        { tagName: "BUTTON", attrs: { class: "icon", id: "menu" } },
        { tagName: "INPUT", attrs: { type: "text" } },
        { tagName: "BUTTON", hidden: true },
        { tagName: "BUTTON", rects: 0 },
        { tagName: "BUTTON", inert: true },
      ],
    });
    const found = unnamedControls(page.scope.document);
    assert.equal(found.count, 2);
    assert.deepEqual(found.sample, ['<button id="menu" class="icon">', '<input type="text">']);
  });

  it("reports how far the page runs past the window", () => {
    const wide = installUiActivity({ scope: stubPage({ scrollWidth: 1210, clientWidth: 1000 }).scope });
    assert.equal(wide.report().overflowX, 210);
    const fits = installUiActivity({ scope: stubPage({ scrollWidth: 1000, clientWidth: 1000 }).scope });
    assert.equal(fits.report().overflowX, 0);
  });

  it("knows what a person types into", () => {
    assert.equal(isEditable(element({ tagName: "TEXTAREA" })), true);
    assert.equal(isEditable(element({ tagName: "SELECT" })), true);
    assert.equal(isEditable(element({ tagName: "DIV", isContentEditable: true })), true);
    assert.equal(isEditable(element({ tagName: "BUTTON" })), false);
    assert.equal(isEditable(null), false);
  });
});
