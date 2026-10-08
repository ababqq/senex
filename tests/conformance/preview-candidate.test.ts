import { test } from "node:test";
import assert from "node:assert/strict";
import { startRig, makeFakePreview } from "../helpers/studio-rig.ts";
import { gitFile } from "../helpers/git.ts";

test("a full preview pool refuses candidate preparation without navigating Live", async () => {
  const rig = await startRig(
    { replies: [] },
    { previewPoolMax: 0, createHeadlessPreview: async () => makeFakePreview() },
  );
  try {
    const project = await rig.core.projects.scaffold("preview-full", { title: "Preview full" });
    // The person's own load: a harness `preview.load` reaches its stand-in, not Live.
    await rig.core.loadPreview({ project: project.name });
    const head = (await gitFile(["rev-parse", "HEAD"], { cwd: project.dir })).stdout.trim();
    const loads = rig.preview.loads.length,
      root = rig.preview.loadRoot;
    await assert.rejects(rig.core.showBuild(project.name, head), /pool exhausted/);
    assert.equal(rig.preview.loads.length, loads);
    assert.equal(rig.preview.loadRoot, root);
  } finally {
    await rig.stop();
  }
});

test("a candidate that fails to load preserves the current project without reloading it", async () => {
  const candidate = makeFakePreview();
  candidate.load = async () => {
    throw new Error("candidate runtime failed");
  };
  const rig = await startRig({ replies: [] }, { previewPoolMax: 1, createHeadlessPreview: async () => candidate });
  try {
    const project = await rig.core.projects.scaffold("preview-failed", { title: "Preview failed" });
    // The person's own load: a harness `preview.load` reaches its stand-in, not Live.
    await rig.core.loadPreview({ project: project.name });
    const head = (await gitFile(["rev-parse", "HEAD"], { cwd: project.dir })).stdout.trim(),
      loads = rig.preview.loads.length;
    await assert.rejects(rig.core.showBuild(project.name, head), /candidate runtime failed/);
    assert.equal(rig.preview.loads.length, loads);
  } finally {
    await rig.stop();
  }
});
