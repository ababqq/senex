import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { PreviewService } from "../../src/main/core/previews.ts";
import type { LiveOffer } from "../../src/main/core/live-gate.ts";
import { idleWork, unservedPreviews, type CoreInternals } from "../../src/main/core/internals.ts";
import type { StudioCore } from "../../src/main/studio-core.ts";
import type { PreviewPort } from "../../src/substrate/preview-port.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A preview service over one project folder, with Live's loads and offers recorded instead of made. */
async function checkpointFixture(options: { headless?: boolean } = {}) {
  const root = await tmpDir("checkpoint-");
  const worktree = path.join(root, "worktree");
  await mkdir(worktree);
  const visible: boolean[] = [];
  const observed: boolean[] = [];
  const preview = {
    setVisible: (value: boolean) => visible.push(value),
    setObserved: (value: boolean) => observed.push(value),
  } as unknown as PreviewPort;
  const createHeadlessPreview = options.headless ? async () => preview : undefined;
  const core = {
    options: { preview, previewPoolMax: 0, ...(createHeadlessPreview ? { createHeadlessPreview } : {}) },
    projects: { dirFor: () => root },
  } as unknown as StudioCore;
  const state = { ...idleWork(), ...unservedPreviews() } as CoreInternals;
  const service = new PreviewService(core, state);
  const loads: unknown[] = [];
  const offers: LiveOffer[] = [];
  service.loadPreview = async (load) => {
    loads.push(load);
    return "project://p";
  };
  service.offerLive = async (offer) => {
    offers.push(offer);
  };
  const serve = (served: string | null) =>
    state.servedRoots.set("live", { project: "p", root: served, entry: undefined, loaded: null });
  return { root, worktree, visible, observed, state, service, loads, offers, serve };
}

test("a checkpoint never loads Live: it offers the build folder Live serves when it is in it, else the project folder", async () => {
  const { root, worktree, service, loads, offers, serve } = await checkpointFixture();
  serve(null);
  await service.checkpointPreview("p", root, "the cube turned orange");
  await service.checkpointPreview("p", worktree, null);
  serve(worktree);
  await service.checkpointPreview("p", worktree, null);
  await service.checkpointPreview("p", root, null);
  await service.checkpointPreview("other", worktree, null);
  assert.deepEqual(offers, [
    { project: "p", root: null, note: "the cube turned orange" },
    { project: "p", root: null, note: null },
    { project: "p", root: worktree, note: null },
    { project: "p", root: null, note: null },
    { project: "other", root: null, note: null },
  ]);
  assert.equal(loads.length, 0);
});

test("a hidden stage rests Live unless something looks through it", async () => {
  const { visible, observed, state, service } = await checkpointFixture();
  await service.setStageVisible(false);
  assert.equal(visible.at(-1), false);
  // With no hidden windows, a session and a run's harness look through Live itself.
  const session = service.sessionPortFor({ label: "look" });
  await session.get();
  assert.deepEqual([visible.at(-1), observed.at(-1)], [true, true]);
  await session.release();
  assert.deepEqual([visible.at(-1), observed.at(-1)], [false, false]);
  state.activeRunIds.add("run-1");
  service.refreshVisibility();
  assert.deepEqual([visible.at(-1), observed.at(-1)], [true, true]);
  await service.setStageVisible(true);
  assert.equal(visible.at(-1), true);
});

test("where the harness has the stand-in, a run leaves a hidden Live at rest", async () => {
  const { visible, observed, state, service } = await checkpointFixture({ headless: true });
  state.activeRunIds.add("run-1");
  await service.setStageVisible(false);
  assert.deepEqual([visible.at(-1), observed.at(-1)], [false, false]);
});
