/**
 * A page that guards against leaving (a `beforeunload` handler: "you have unsaved changes") used
 * to make the studio's own reload wait for ever, and its load fail with nothing on the console:
 * the Reload button spun, and a judge or builder that rebuilt and reloaded stopped there. The
 * studio asked for the navigation, so the guard is overruled while it does; a navigation that
 * still does not settle is given up on after a bound, loudly, instead of waiting.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
  bypassUnloadGuard,
  NAVIGATION_SETTLE_MS,
  NavigationFailure,
  PreviewNavigationError,
  reloadWithin,
  settleWithin,
} from "../../src/main/preview-navigation.ts";

/** A clock the test holds: a wait that ends when the test says so, or when it is told to stop waiting. */
function heldClock() {
  const waits: Array<{ ms: number; signal: AbortSignal; elapse: () => void }> = [];
  const wait = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      waits.push({ ms, signal, elapse: resolve });
      signal.addEventListener("abort", () => reject(new Error("wait stopped")), { once: true });
    });
  return { wait, waits };
}

const timedOut = (error: unknown) =>
  error instanceof PreviewNavigationError && error.code === NavigationFailure.TimedOut;

describe("a page's guard against being left", () => {
  it("is overruled while the studio is the one navigating, and only then", () => {
    let listener: ((event: { preventDefault(): void }) => void) | undefined;
    let navigating = false;
    bypassUnloadGuard({ willPreventUnload: (l) => (listener = l) }, () => navigating);
    assert.ok(listener, "the guard is listened for");
    const event = () => {
      const seen = { prevented: false };
      return { seen, preventDefault: () => (seen.prevented = true) };
    };
    const own = event();
    listener(own);
    assert.equal(own.seen.prevented, false, "the page's own leaving is its business");
    navigating = true;
    const studio = event();
    listener(studio);
    assert.equal(studio.seen.prevented, true, "a reload or load the studio asked for goes through");
  });
});

describe("waiting for a navigation to settle", () => {
  it("gives the navigation's own answer as soon as it has one, and stops the clock", async () => {
    const clock = heldClock();
    assert.equal(await settleWithin(Promise.resolve("loaded"), NAVIGATION_SETTLE_MS, clock.wait), "loaded");
    assert.equal(clock.waits[0]?.ms, NAVIGATION_SETTLE_MS);
    assert.equal(clock.waits[0]?.signal.aborted, true, "no timer is left running");
  });

  it("passes a navigation's own failure on as it was", async () => {
    const clock = heldClock();
    await assert.rejects(
      settleWithin(Promise.reject(new Error("ERR_FAILED")), 1000, clock.wait),
      (error: unknown) => error instanceof Error && error.message === "ERR_FAILED",
    );
    assert.equal(clock.waits[0]?.signal.aborted, true);
  });

  it("gives up on one that never settles, says so, and lets the caller cancel it", async () => {
    const clock = heldClock();
    let cancelled = 0;
    const waiting = settleWithin(new Promise<never>(() => {}), 1000, clock.wait, () => cancelled++);
    clock.waits[0]?.elapse();
    await assert.rejects(waiting, timedOut);
    assert.equal(cancelled, 1);
  });

  it("still reports the give-up when stopping the window is what makes the navigation fail", async () => {
    // Electron rejects the pending loadURL as soon as the window is stopped: that failure is the
    // give-up's own doing, not the page's, and the caller must hear the typed one.
    const clock = heldClock();
    let fail: (error: Error) => void = () => {};
    const navigation = new Promise<never>((_, reject) => {
      fail = reject;
    });
    const waiting = settleWithin(navigation, 1000, clock.wait, () => fail(new Error("ERR_FAILED (-2)")));
    clock.waits[0]?.elapse();
    await assert.rejects(waiting, timedOut);
  });

  it("does not cancel a navigation that settled", async () => {
    const clock = heldClock();
    let cancelled = 0;
    await settleWithin(Promise.resolve(), 1000, clock.wait, () => cancelled++);
    assert.equal(cancelled, 0);
  });

  it("names the wait in the error, in seconds", async () => {
    const clock = heldClock();
    const waiting = settleWithin(new Promise<never>(() => {}), 30_000, clock.wait);
    clock.waits[0]?.elapse();
    await assert.rejects(waiting, (error: unknown) => error instanceof Error && /30 seconds/.test(error.message));
  });
});

/** A web contents that reloads when told and answers with the events the test sends. */
function fakeContents(onReload: (wc: ReturnType<typeof fakeContents>) => void = () => {}) {
  const events = new EventEmitter();
  const wc = {
    reloads: 0,
    stops: 0,
    once: (event: "did-finish-load" | "did-fail-load", listener: () => void) => void events.once(event, listener),
    off: (event: "did-finish-load" | "did-fail-load", listener: () => void) => void events.off(event, listener),
    reloadIgnoringCache() {
      wc.reloads++;
      onReload(wc);
    },
    stop() {
      wc.stops++;
    },
    emit: (event: "did-finish-load" | "did-fail-load") => events.emit(event),
    listeners: () => events.listenerCount("did-finish-load") + events.listenerCount("did-fail-load"),
  };
  return wc;
}

describe("a reload the studio asked for", () => {
  it("is done when the page finishes loading, and leaves no listener behind", async () => {
    const clock = heldClock();
    const wc = fakeContents();
    const reloading = reloadWithin(wc, 1000, clock.wait);
    wc.emit("did-finish-load");
    await reloading;
    assert.equal(wc.reloads, 1);
    assert.equal(wc.listeners(), 0);
  });

  it("is done when the load fails too: the failure is the console's to report", async () => {
    const clock = heldClock();
    const wc = fakeContents();
    const reloading = reloadWithin(wc, 1000, clock.wait);
    wc.emit("did-fail-load");
    await reloading;
    assert.equal(wc.listeners(), 0);
  });

  it("listens before it reloads, so an answer that comes at once is not missed", async () => {
    const clock = heldClock();
    const wc = fakeContents((self) => self.emit("did-finish-load"));
    await reloadWithin(wc, 1000, clock.wait);
    assert.equal(wc.listeners(), 0);
  });

  it("gives up when the page answers neither way, stops the navigation and leaves no listener", async () => {
    const clock = heldClock();
    const wc = fakeContents();
    const reloading = reloadWithin(wc, 1000, clock.wait);
    clock.waits[0]?.elapse();
    await assert.rejects(reloading, timedOut);
    assert.equal(wc.stops, 1);
    assert.equal(wc.listeners(), 0);
  });
});
