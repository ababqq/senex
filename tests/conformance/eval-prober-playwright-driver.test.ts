/**
 * The Playwright driver's adapter (`playwright-driver.ts`), hermetically: a real mouse and a
 * touchscreen tap reach the page and answer whether they settled (a rejected call answers false,
 * never throws), and the phone pass opens its own 390x844 @3x touch context while the desktop page
 * keeps the probe viewport. The fakes stand in for Playwright's `Browser` and `Page`; the real
 * Chromium path is `eval-full-prober-browser.test.ts` (opt-in).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Browser, BrowserContextOptions, Page } from "@playwright/test";
import { PHONE_VIEWPORT } from "../../scripts/evals/prober/phases/mobile.ts";
import {
  BLOCKED_BY_POLICY,
  PROBE_NETWORK_POLICY,
  probeRequestAllowed,
} from "../../scripts/evals/prober/network-policy.ts";
import { PHONE_CONTEXT, PROBE_VIEWPORT, probeBrowserOf } from "../../scripts/evals/prober/playwright-driver.ts";
import { PROBER_VERSION } from "../../scripts/evals/prober/types.ts";
import { PROBER_VERSION_PATTERN } from "../../scripts/evals/ledger/schema.ts";

/** A request as the route handler sees it. */
interface FakeRequest {
  url: () => string;
  method: () => string;
  resourceType: () => string;
  failure: () => { errorText: string } | null;
  response: () => Promise<null>;
}

type RouteHandler = (route: {
  request: () => FakeRequest;
  continue: () => Promise<void>;
  abort: (code?: string) => Promise<void>;
}) => unknown;
type WebSocketHandler = (ws: {
  url: () => string;
  close: (options?: { code?: number; reason?: string }) => Promise<void>;
}) => unknown;

interface FakeWorld {
  calls: string[];
  contexts: BrowserContextOptions[];
  failTouch: boolean;
  routes: RouteHandler[];
  sockets: WebSocketHandler[];
  /** The page's event listeners, so a test can fire `requestfailed`. */
  listeners: Map<string, (value: unknown) => void>;
}

/** A Playwright page stand-in: records every input, answers the navigation with a 200. */
function fakePage(world: FakeWorld): Page {
  const record = (call: string) => async () => {
    world.calls.push(call);
  };
  const page = {
    addInitScript: async () => {},
    on: (event: string, listener: (value: unknown) => void) => {
      world.listeners.set(event, listener);
      return page;
    },
    goto: async () => {
      world.calls.push("goto");
      return { status: () => 200 };
    },
    url: () => "http://127.0.0.1:1/",
    viewportSize: () => null,
    mainFrame: () => null,
    mouse: {
      move: async (x: number, y: number, options?: { steps?: number }) => {
        world.calls.push(`move ${x},${y} steps=${options?.steps}`);
      },
      down: record("down"),
      up: record("up"),
      click: record("click"),
    },
    touchscreen: {
      tap: async (x: number, y: number) => {
        if (world.failTouch) throw new Error("touch is not enabled");
        world.calls.push(`tap ${x},${y}`);
      },
    },
  };
  // A partial stand-in for Playwright's page: only the members the adapter calls exist.
  return page as unknown as Page;
}

function fakeBrowser(world: FakeWorld): Browser {
  const browser = {
    newContext: async (options: BrowserContextOptions) => {
      world.contexts.push(options);
      return {
        newPage: async () => fakePage(world),
        route: async (_pattern: string, handler: RouteHandler) => {
          world.calls.push("route");
          world.routes.push(handler);
        },
        routeWebSocket: async (_pattern: unknown, handler: WebSocketHandler) => {
          world.calls.push("routeWebSocket");
          world.sockets.push(handler);
        },
      };
    },
    close: async () => {},
  };
  // A partial stand-in for Playwright's browser: only the members the driver calls exist.
  return browser as unknown as Browser;
}

const world = (): FakeWorld => ({
  calls: [],
  contexts: [],
  failTouch: false,
  routes: [],
  sockets: [],
  listeners: new Map(),
});

/** Inputs only: what the pointer tests compare, without the context's setup calls. */
const inputs = (w: FakeWorld) => w.calls.filter((call) => !["route", "routeWebSocket", "goto"].includes(call));

const SERVE = "http://127.0.0.1:4173";

function fakeRequest(url: string, method: string): FakeRequest {
  return {
    url: () => url,
    method: () => method,
    resourceType: () => "fetch",
    failure: () => ({ errorText: "net::ERR_BLOCKED_BY_CLIENT" }),
    response: async () => null,
  };
}

/** Send one request through the context's route; answers whether it went out. */
async function routed(w: FakeWorld, request: FakeRequest): Promise<boolean> {
  const [handler] = w.routes;
  assert.ok(handler, "a context route is installed");
  let decision: boolean | null = null;
  await handler({
    request: () => request,
    continue: async () => {
      decision = true;
    },
    abort: async () => {
      decision = false;
    },
  });
  assert.notEqual(decision, null, "the route always decides");
  return decision === true;
}

/** Hostile and allowed requests from a project served at `SERVE`. */
const NETWORK_TABLE: Array<{ url: string; method: string; allowed: boolean }> = [
  { url: `${SERVE}/main.js`, method: "GET", allowed: true },
  { url: `${SERVE}/`, method: "GET", allowed: true },
  { url: "https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js", method: "GET", allowed: true },
  { url: "data:image/png;base64,AAAA", method: "GET", allowed: true },
  { url: "blob:http://127.0.0.1:4173/7a1d", method: "GET", allowed: true },
  { url: "https://evil.example/collect", method: "GET", allowed: false },
  { url: "https://cdn.jsdelivr.net/collect", method: "POST", allowed: false },
  { url: "http://127.0.0.1:11434/api/tags", method: "GET", allowed: false },
  { url: "http://localhost:4173/main.js", method: "GET", allowed: false },
  { url: "ws://127.0.0.1:4173/", method: "GET", allowed: false },
  { url: "file:///etc/passwd", method: "GET", allowed: false },
  { url: "https://cdn.jsdelivr.net:8443/x.js", method: "GET", allowed: false },
  { url: "http://cdn.jsdelivr.net/x.js", method: "GET", allowed: false },
  { url: "http://user@127.0.0.1:4173/main.js", method: "GET", allowed: false },
  { url: "not a url", method: "GET", allowed: false },
];

describe("the Playwright driver's pointer", () => {
  it("gives the page a real mouse that moves in steps, presses and releases", async () => {
    const w = world();
    const page = await probeBrowserOf(fakeBrowser(w), () => 0).open("http://127.0.0.1:1/", "init");
    assert.ok(page.mouse);
    assert.equal(await page.mouse.move(10, 20, 5), true);
    assert.equal(await page.mouse.down(), true);
    assert.equal(await page.mouse.up(), true);
    assert.deepEqual(inputs(w), ["move 10,20 steps=5", "down", "up"]);
    assert.deepEqual(w.contexts, [{ viewport: PROBE_VIEWPORT, deviceScaleFactor: 1, serviceWorkers: "block" }]);
  });

  it("opens the phone pass in its own 390x844 @3x touch context and taps the touchscreen", async () => {
    const w = world();
    const browser = probeBrowserOf(fakeBrowser(w), () => 0);
    assert.ok(browser.openPhone);
    const phone = await browser.openPhone("http://127.0.0.1:1/", "init");
    assert.deepEqual(w.contexts, [PHONE_CONTEXT]);
    assert.deepEqual(PHONE_CONTEXT.viewport, { width: PHONE_VIEWPORT.width, height: PHONE_VIEWPORT.height });
    assert.equal(PHONE_CONTEXT.deviceScaleFactor, PHONE_VIEWPORT.deviceScaleFactor);
    assert.equal(PHONE_CONTEXT.hasTouch, true);
    assert.ok(phone.tap);
    assert.equal(await phone.tap(195, 422), true);
    assert.deepEqual(inputs(w), ["tap 195,422"]);
  });

  it("answers false, never throws, when a touch the context refuses is sent", async () => {
    const w = { ...world(), failTouch: true };
    const phone = await probeBrowserOf(fakeBrowser(w), () => 0).openPhone?.("http://127.0.0.1:1/", "init");
    assert.ok(phone?.tap);
    assert.equal(await phone.tap(1, 1), false);
  });
});

describe("the probe's network policy", () => {
  for (const row of NETWORK_TABLE) {
    it(`${row.allowed ? "lets" : "refuses"} ${row.method} ${row.url}`, () => {
      assert.equal(probeRequestAllowed(row.url, row.method, SERVE), row.allowed);
    });
  }

  it("installs the route on the context before the page navigates, on desktop and phone alike", async () => {
    for (const open of ["open", "openPhone"] as const) {
      const w = world();
      await probeBrowserOf(fakeBrowser(w), () => 0)[open]?.(`${SERVE}/?genex_local_test=1`, "init");
      assert.ok(w.calls.indexOf("route") >= 0 && w.calls.indexOf("route") < w.calls.indexOf("goto"));
      assert.ok(w.calls.indexOf("routeWebSocket") < w.calls.indexOf("goto"));
      assert.equal(w.contexts[0]?.serviceWorkers, "block");
    }
  });

  it("lets through exactly the allowed requests of the page's own origin and aborts the rest", async () => {
    const w = world();
    await probeBrowserOf(fakeBrowser(w), () => 0).open(`${SERVE}/?genex_local_test=1`, "init");
    for (const row of NETWORK_TABLE) {
      assert.equal(await routed(w, fakeRequest(row.url, row.method)), row.allowed, `${row.method} ${row.url}`);
    }
  });

  it("records a refused request as blocked by the policy, so the network summary blames it", async () => {
    const w = world();
    const page = await probeBrowserOf(fakeBrowser(w), () => 0).open(`${SERVE}/`, "init");
    const request = fakeRequest("https://evil.example/collect", "GET");
    assert.equal(await routed(w, request), false);
    w.listeners.get("requestfailed")?.(request);
    assert.deepEqual(
      page.events().network.map((entry) => [entry.url, entry.failure]),
      [["https://evil.example/collect", BLOCKED_BY_POLICY]],
    );
  });

  it("closes every WebSocket the page opens and records it as blocked", async () => {
    const w = world();
    const page = await probeBrowserOf(fakeBrowser(w), () => 0).open(`${SERVE}/`, "init");
    const [handler] = w.sockets;
    assert.ok(handler);
    let closed = false;
    await handler({
      url: () => "ws://127.0.0.1:4173/live",
      close: async () => {
        closed = true;
      },
    });
    assert.equal(closed, true);
    assert.deepEqual(
      page.events().network.map((entry) => [entry.url, entry.failure]),
      [["ws://127.0.0.1:4173/live", BLOCKED_BY_POLICY]],
    );
  });

  it("is pinned by name and by the CDN list it allows, inside the prober version a grade carries", () => {
    assert.match(PROBE_NETWORK_POLICY, /^preview-cdn-allowlist@[0-9a-f]{12}$/);
    const digest = PROBE_NETWORK_POLICY.split("@")[1] ?? "";
    // A change of policy or CDN list changes grading.proberVersion: a recalibration and a regrade.
    assert.ok(PROBER_VERSION.endsWith(`+cdn.${digest}`), PROBER_VERSION);
    assert.match(PROBER_VERSION, PROBER_VERSION_PATTERN);
  });
});
