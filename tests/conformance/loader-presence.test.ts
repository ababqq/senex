/**
 * The stage's loader never flashes: a load that finishes within the first moments shows nothing,
 * one that shows the loader keeps it up long enough to be read, and it fades out before the project
 * is uncovered.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOADER_DELAY_MS,
  LOADER_FADE_MS,
  LOADER_MIN_MS,
  LoaderPhase,
  loaderNext,
} from "../../src/renderer/panels/stage/loader-presence.ts";

test("a load starts by waiting, and shows the loader only after the delay", () => {
  assert.deepEqual(loaderNext(LoaderPhase.Hidden, true, 0), { phase: LoaderPhase.Waiting, after: 0 });
  assert.deepEqual(loaderNext(LoaderPhase.Waiting, true, 0), { phase: LoaderPhase.Shown, after: LOADER_DELAY_MS });
});

test("a load that ends while waiting shows nothing", () => {
  assert.deepEqual(loaderNext(LoaderPhase.Waiting, false, 0), { phase: LoaderPhase.Hidden, after: 0 });
});

test("a shown loader stays its minimum, then fades out, then is gone", () => {
  assert.deepEqual(loaderNext(LoaderPhase.Shown, false, 100), {
    phase: LoaderPhase.Leaving,
    after: LOADER_MIN_MS - 100,
  });
  assert.deepEqual(loaderNext(LoaderPhase.Shown, false, LOADER_MIN_MS + 50), { phase: LoaderPhase.Leaving, after: 0 });
  assert.deepEqual(loaderNext(LoaderPhase.Leaving, false, 0), { phase: LoaderPhase.Hidden, after: LOADER_FADE_MS });
});

test("a new load while it fades out keeps it up, and nothing moves while a load is shown", () => {
  assert.deepEqual(loaderNext(LoaderPhase.Leaving, true, 0), { phase: LoaderPhase.Shown, after: 0 });
  assert.equal(loaderNext(LoaderPhase.Shown, true, 5000), null);
  assert.equal(loaderNext(LoaderPhase.Hidden, false, 0), null);
});
