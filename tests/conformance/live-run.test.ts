/**
 * The strip's Play/Stop is one button: Stop while the project runs, Play once it is stopped, and a
 * spinner in its place while either is under way. Full screen is offered only while the project
 * itself is on the stage.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fullScreenOffered, LiveRun, liveRun } from "../../src/renderer/panels/stage/live-run.ts";

test("the button follows the project: running, stopping, stopped, starting", () => {
  assert.equal(liveRun({ stopped: false, stopping: false, starting: false }), LiveRun.Running);
  assert.equal(liveRun({ stopped: false, stopping: true, starting: false }), LiveRun.Stopping);
  assert.equal(liveRun({ stopped: true, stopping: false, starting: false }), LiveRun.Stopped);
  assert.equal(liveRun({ stopped: false, stopping: false, starting: true }), LiveRun.Starting);
});

test("a press under way wins over what the last probe said", () => {
  assert.equal(liveRun({ stopped: false, stopping: true, starting: true }), LiveRun.Stopping);
  assert.equal(liveRun({ stopped: true, stopping: false, starting: true }), LiveRun.Starting);
});

test("full screen is offered only while the running project is on the stage", () => {
  const shown = { run: LiveRun.Running, live: true, loading: false, empty: false };
  assert.equal(fullScreenOffered(shown), true);
  assert.equal(fullScreenOffered({ ...shown, run: LiveRun.Stopped }), false);
  assert.equal(fullScreenOffered({ ...shown, run: LiveRun.Starting }), false);
  assert.equal(fullScreenOffered({ ...shown, live: false }), false);
  assert.equal(fullScreenOffered({ ...shown, loading: true }), false);
  assert.equal(fullScreenOffered({ ...shown, empty: true }), false);
});
