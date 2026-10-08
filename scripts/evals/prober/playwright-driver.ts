/**
 * The one real `ProbeBrowser`: Playwright's Chromium, headless, 1280x720, launched with the flags for
 * the renderer mode (`renderer.ts`). Every page-side call is bounded, and a call that fails or times
 * out answers `null`/`false` instead of throwing, so a hung page costs the probe a ceiling, not the
 * run. Every context gets the probe's network policy (`network-policy.ts`) before its page navigates:
 * a request the product's preview would refuse is aborted and recorded as blocked, WebSockets are
 * closed and service workers are blocked (a route cannot see their traffic). Browsers are never
 * downloaded here: a missing Chromium is a launch error the caller reports.
 */
import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  chromium,
  type Page,
  type Request,
} from "@playwright/test";
import { setTimeout as delay } from "node:timers/promises";
import { RendererMode } from "../vocabulary.ts";
import { readCanvasPixels } from "./canvas-capture.ts";
import {
  type CanvasCapture,
  CanvasState,
  type Capture,
  type PageEvents,
  type PhonePage,
  type ProbeBrowser,
  type ProbeMouse,
} from "./driver.ts";
import { PHONE_VIEWPORT } from "./phases/mobile.ts";
import { ACT_TIMEOUT_MS, EVAL_TIMEOUT_MS } from "./probe-budget.ts";
import { BLOCKED_BY_POLICY, probeRequestAllowed, serveOriginOf } from "./network-policy.ts";
import { chromiumArgs } from "./renderer.ts";
import { ShotKind } from "./types.ts";

/** The probe's viewport: a common laptop project window. */
export const PROBE_VIEWPORT = { width: 1280, height: 720 } as const;
/** The desktop page's context. */
const DESKTOP_CONTEXT: BrowserContextOptions = {
  viewport: PROBE_VIEWPORT,
  deviceScaleFactor: 1,
  serviceWorkers: "block",
};
/** The phone pass's context: the phone the pass emulates, as a touch device. */
export const PHONE_CONTEXT = {
  viewport: { width: PHONE_VIEWPORT.width, height: PHONE_VIEWPORT.height },
  deviceScaleFactor: PHONE_VIEWPORT.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  serviceWorkers: "block",
} as const satisfies BrowserContextOptions;
/** How long the first navigation may take to reach DOMContentLoaded. */
export const NAVIGATION_TIMEOUT_MS = 60_000;
const DATA_URL_PREFIX = "data:image/png;base64,";

/** Race a page call against a ceiling; `null` when it failed or ran out. */
async function bounded<T>(work: Promise<T>, ms: number): Promise<T | null> {
  const deadline = new AbortController();
  try {
    return await Promise.race([work.catch(() => null), delay(ms, null, { signal: deadline.signal }).catch(() => null)]);
  } finally {
    deadline.abort();
  }
}

/** Requests and sockets the network policy refused, recorded as they fail. */
interface Blocked {
  requests: WeakSet<Request>;
}

/**
 * Hold a context to the probe's network policy for a page opened on `url`: requests the policy
 * refuses are aborted (and remembered, so their failure reads as blocked), WebSockets are closed.
 */
async function applyNetworkPolicy(
  context: BrowserContext,
  url: string,
  blocked: Blocked,
  events: () => PageEvents | null,
  elapsed: () => number,
): Promise<void> {
  const origin = serveOriginOf(url);
  await context.route("**/*", (route) => {
    const request = route.request();
    if (probeRequestAllowed(request.url(), request.method(), origin)) return route.continue();
    blocked.requests.add(request);
    return route.abort("blockedbyclient");
  });
  await context.routeWebSocket(
    () => true,
    (socket) => {
      events()?.network.push({
        url: socket.url(),
        method: "GET",
        status: null,
        resourceType: "websocket",
        failure: BLOCKED_BY_POLICY,
        startedAtMs: elapsed(),
      });
      return socket.close({ reason: BLOCKED_BY_POLICY });
    },
  );
}

/** Record console lines, uncaught errors, requests and main-frame navigations on a page. */
function recordEvents(page: Page, elapsed: () => number, blocked: Blocked): PageEvents {
  const events: PageEvents = { console: [], pageErrors: [], network: [], navigations: [], documentStatus: null };
  page.on("console", (m) => events.console.push({ atMs: elapsed(), type: m.type(), text: m.text() }));
  page.on("pageerror", (e) => events.pageErrors.push({ atMs: elapsed(), message: e.message }));
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) events.navigations.push({ atMs: elapsed(), url: f.url() });
  });
  page.on("requestfinished", async (req) => {
    const res = await req.response().catch(() => null);
    events.network.push({
      url: req.url(),
      method: req.method(),
      status: res?.status() ?? null,
      resourceType: req.resourceType(),
      failure: null,
      startedAtMs: elapsed(),
    });
  });
  page.on("requestfailed", (req) =>
    events.network.push({
      url: req.url(),
      method: req.method(),
      status: null,
      resourceType: req.resourceType(),
      failure: blocked.requests.has(req) ? BLOCKED_BY_POLICY : (req.failure()?.errorText ?? "failed"),
      startedAtMs: elapsed(),
    }),
  );
  return events;
}

function fromDataUrl(url: string): Uint8Array | null {
  return url.startsWith(DATA_URL_PREFIX)
    ? new Uint8Array(Buffer.from(url.slice(DATA_URL_PREFIX.length), "base64"))
    : null;
}

/** The largest canvas: an in-page readback, else a screenshot of the canvas element. */
async function captureCanvas(page: Page): Promise<CanvasCapture> {
  const read = await page.evaluate(readCanvasPixels).then(
    (pixels) => ({ ok: true as const, pixels }),
    () => ({ ok: false as const, pixels: null }),
  );
  const bytes = read.pixels ? fromDataUrl(read.pixels.png) : null;
  if (bytes) return { state: CanvasState.Image, capture: { png: bytes, source: ShotKind.Canvas } };
  if (read.ok && read.pixels === null) return { state: CanvasState.NoCanvas };
  // A tainted canvas refuses the readback; the element screenshot still sees it.
  const shot = await bounded(
    page.locator("canvas").first().screenshot({ type: "png", timeout: ACT_TIMEOUT_MS }),
    ACT_TIMEOUT_MS,
  );
  return shot
    ? { state: CanvasState.Image, capture: { png: new Uint8Array(shot), source: ShotKind.Element } }
    : { state: CanvasState.Failed };
}

async function screenshot(page: Page): Promise<Capture | null> {
  const shot = await bounded(page.screenshot({ type: "png", timeout: ACT_TIMEOUT_MS }), ACT_TIMEOUT_MS);
  return shot ? { png: new Uint8Array(shot), source: ShotKind.Page } : null;
}

async function press(page: Page, key: string, holdMs: number): Promise<boolean> {
  const down = await bounded(
    page.keyboard.down(key).then(() => true),
    ACT_TIMEOUT_MS,
  );
  await delay(holdMs);
  const up = await bounded(
    page.keyboard.up(key).then(() => true),
    ACT_TIMEOUT_MS,
  );
  return down === true && up === true;
}

/** A bounded page input: whether it settled in time. */
async function settled(work: Promise<void>): Promise<boolean> {
  return (
    (await bounded(
      work.then(() => true),
      ACT_TIMEOUT_MS,
    )) === true
  );
}

/** The page's real mouse (CDP input: trusted and viewport-bounded). */
function mouseOf(page: Page): ProbeMouse {
  return {
    move: (x, y, steps) => settled(page.mouse.move(x, y, { steps })),
    down: () => settled(page.mouse.down()),
    up: () => settled(page.mouse.up()),
  };
}

/**
 * Adapt a Playwright page to the probe's page. `tap` is always offered: on a context without touch
 * Playwright rejects it and the bounded call answers false.
 */
function adapt(page: Page, events: PageEvents, elapsed: () => number): PhonePage {
  return {
    elapsedMs: elapsed,
    url: () => page.url(),
    viewport: () => page.viewportSize() ?? PROBE_VIEWPORT,
    // Playwright types the argument through its own serialisation wrapper; the page functions here
    // take plain JSON arguments, so the call is widened to `unknown` at this one boundary.
    evaluate: (fn, arg) =>
      bounded(page.evaluate(fn as (a: unknown) => Awaited<ReturnType<typeof fn>>, arg as unknown), EVAL_TIMEOUT_MS),
    captureCanvas: () => captureCanvas(page),
    screenshot: () => screenshot(page),
    click: (selector) => settled(page.click(selector, { timeout: ACT_TIMEOUT_MS })),
    clickAt: (x, y) => settled(page.mouse.click(x, y)),
    press: (key, holdMs) => press(page, key, holdMs),
    events: () => events,
    mouse: mouseOf(page),
    tap: (x, y) => settled(page.touchscreen.tap(x, y)),
  };
}

async function openPage(
  browser: Browser,
  url: string,
  initScript: string,
  now: () => number,
  contextOptions: BrowserContextOptions = DESKTOP_CONTEXT,
): Promise<PhonePage> {
  const context = await browser.newContext(contextOptions);
  const blocked: Blocked = { requests: new WeakSet() };
  let recorded: PageEvents | null = null;
  let openedAt = now();
  const elapsed = () => now() - openedAt;
  await applyNetworkPolicy(context, url, blocked, () => recorded, elapsed);
  const page = await context.newPage();
  await page.addInitScript({ content: initScript });
  openedAt = now();
  const events = recordEvents(page, elapsed, blocked);
  recorded = events;
  const response = await page
    .goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS })
    .catch(() => null);
  events.documentStatus = response?.status() ?? null;
  return adapt(page, events, elapsed);
}

/** Launch Chromium for a renderer mode; the GPU path uses the full Chromium build's new headless mode. */
export async function launchPlaywright(
  mode: RendererMode,
  now: () => number = () => performance.now(),
): Promise<ProbeBrowser> {
  const channel = mode === RendererMode.Gpu ? { channel: "chromium" } : {};
  const browser = await chromium.launch({ headless: true, args: chromiumArgs(mode), ...channel });
  return probeBrowserOf(browser, now);
}

/** A launched Playwright browser as the probe's `ProbeBrowser`: desktop pages and the phone pass's touch context. */
export function probeBrowserOf(browser: Browser, now: () => number): ProbeBrowser {
  return {
    open: (url, initScript) => openPage(browser, url, initScript, now),
    openPhone: (url, initScript) => openPage(browser, url, initScript, now, PHONE_CONTEXT),
    close: () => browser.close(),
  };
}
