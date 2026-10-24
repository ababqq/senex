/**
 * Navigations the studio starts in a preview window (load, reload): a page's own guard against
 * being left must not hold them, and one that never settles must not hold their caller. Free of
 * Electron, so both are tested with a held clock and a fake window.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { MINUTE_MS, SECOND_MS } from "../shared/duration.ts";

/**
 * How long a load or reload the studio asked for may take to settle before it is given up on. A
 * backstop, not a verdict on a slow page: the unload guard no longer holds a navigation, so only a
 * load that cannot end (a request that never does) is still waiting at this point.
 */
export const NAVIGATION_SETTLE_MS = 2 * MINUTE_MS;

/** Why a navigation was given up on. */
export const NavigationFailure = { TimedOut: "timed-out" } as const;
export type NavigationFailure = (typeof NavigationFailure)[keyof typeof NavigationFailure];

/** A navigation the studio asked for that did not settle: carries a typed code, and words for a console. */
export class PreviewNavigationError extends Error {
  readonly code: NavigationFailure;
  constructor(code: NavigationFailure, message: string) {
    super(message);
    this.name = "PreviewNavigationError";
    this.code = code;
  }
}

const MESSAGE = {
  timedOut: (ms: number) =>
    `the page did not finish loading within ${Math.round(ms / SECOND_MS)} seconds, so the studio gave up waiting (a page that holds on to being left, or a request that never ends)`,
} as const;

/** The wait a navigation is given: `ms`, ended early when the signal aborts (it rejects then). */
type Wait = (ms: number, signal: AbortSignal) => Promise<unknown>;
const realWait: Wait = (ms, signal) => sleep(ms, undefined, { signal });

/** What the window tells the guard: a page's `beforeunload` handler is trying to cancel the unload. */
export interface UnloadGuardHooks {
  willPreventUnload(listener: (event: { preventDefault(): void }) => void): void;
}

/**
 * Overrule a page's guard against being left while the studio is the one navigating: a reload the
 * person pressed, a rebuilt page loaded, a stopped project resumed. Outside those, the page's own
 * leaving (a link it follows itself) stays its business.
 */
export function bypassUnloadGuard(hooks: UnloadGuardHooks, navigating: () => boolean): void {
  hooks.willPreventUnload((event) => {
    if (navigating()) event.preventDefault();
  });
}

/**
 * The navigation's own answer, or a `PreviewNavigationError` once `ms` have passed. A caller that
 * must not leave the navigation running passes `onTimeout` (stop the window). The clock is
 * stopped as soon as the navigation settles, either way.
 */
export async function settleWithin<T>(
  navigation: Promise<T>,
  ms: number,
  wait: Wait = realWait,
  onTimeout: () => void = () => {},
): Promise<T> {
  const stop = new AbortController();
  const elapsed = wait(ms, stop.signal).then(() => {
    onTimeout();
    throw new PreviewNavigationError(NavigationFailure.TimedOut, MESSAGE.timedOut(ms));
  });
  // The clock is stopped when the navigation settles first: its rejection is then nobody's to hear.
  elapsed.catch(() => {});
  navigation.catch(() => {});
  try {
    return await Promise.race([navigation, elapsed]);
  } finally {
    stop.abort();
  }
}

/** The part of a window a reload needs. */
export interface ReloadTarget {
  once(event: "did-finish-load" | "did-fail-load", listener: () => void): unknown;
  off(event: "did-finish-load" | "did-fail-load", listener: () => void): unknown;
  reloadIgnoringCache(): void;
  stop(): void;
}

/**
 * Reload the window, bypassing the cache, and wait until it has loaded or failed to (the failure
 * is the console's to report) — at most `ms`; after that the navigation is stopped and the wait
 * rejects. Listens before it reloads, so an answer that comes at once is heard.
 */
export async function reloadWithin(wc: ReloadTarget, ms = NAVIGATION_SETTLE_MS, wait: Wait = realWait): Promise<void> {
  let done: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    done = resolve;
    wc.once("did-finish-load", done);
    wc.once("did-fail-load", done);
  });
  try {
    wc.reloadIgnoringCache();
    await settleWithin(settled, ms, wait, () => wc.stop());
  } finally {
    wc.off("did-finish-load", done);
    wc.off("did-fail-load", done);
  }
}
