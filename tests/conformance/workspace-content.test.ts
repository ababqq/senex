import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { workspaceContentStamp, workspaceContentStamps } from "../../src/substrate/workspace-content.ts";

test("chat content stamps detect source, untracked asset and deletion changes without counting tool bridge writes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "content-stamp-"));
  try {
    await promisify(execFile)("git", ["init", dir]);
    await writeFile(path.join(dir, "index.html"), "one");
    const first = await workspaceContentStamp(dir);
    assert.ok(first);
    assert.equal(await workspaceContentStamp(dir), first);
    await mkdir(path.join(dir, ".studio"));
    await writeFile(path.join(dir, ".studio/tool.json"), "bookkeeping");
    assert.equal(await workspaceContentStamp(dir), first);
    await writeFile(path.join(dir, "index.html"), "two");
    const second = await workspaceContentStamp(dir);
    assert.notEqual(second, first);
    await writeFile(path.join(dir, "asset.glb"), "asset");
    const asset = await workspaceContentStamp(dir);
    assert.notEqual(asset, second);
    await rm(path.join(dir, "asset.glb"));
    assert.equal(await workspaceContentStamp(dir), second);
    await writeFile(path.join(dir, ".gitignore"), "generated/\n");
    await mkdir(path.join(dir, "generated"));
    await writeFile(path.join(dir, "generated/mesh.glb"), "ignored but served");
    const ignored = await workspaceContentStamp(dir);
    assert.ok(ignored);
    await writeFile(path.join(dir, "generated/mesh.glb"), "changed");
    assert.notEqual(await workspaceContentStamp(dir), ignored, "Git-ignored runtime assets still count");
    await symlink("/etc/hosts", path.join(dir, "external"));
    assert.equal(await workspaceContentStamp(dir), null, "external content remains unknown");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a docs-only change leaves the source stamp alone, never the full one", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "content-stamp-docs-"));
  try {
    await promisify(execFile)("git", ["init", dir]);
    await writeFile(path.join(dir, "index.html"), "project");
    const before = await workspaceContentStamps(dir);
    assert.ok(before.all && before.source);
    // A research-and-plan turn: a plan under docs/ and notes in Markdown, nothing the preview shows.
    await mkdir(path.join(dir, "docs"));
    await writeFile(path.join(dir, "docs/fight-plan.md"), "# Plan");
    await writeFile(path.join(dir, "RESEARCH.md"), "# Research");
    const planned = await workspaceContentStamps(dir);
    assert.notEqual(planned.all, before.all, "the chat still learns the folder changed");
    assert.equal(planned.source, before.source, "a plan is nothing the preview can show");
    await writeFile(path.join(dir, "index.html"), "project, changed");
    assert.notEqual((await workspaceContentStamps(dir)).source, before.source, "project sources still count");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("one walk answers both stamps, and the full one is the single stamp", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "content-stamp-split-"));
  try {
    await promisify(execFile)("git", ["init", dir]);
    await writeFile(path.join(dir, "index.html"), "project");
    await mkdir(path.join(dir, "docs"));
    await writeFile(path.join(dir, "docs/fight-plan.md"), "# Plan");
    const stamps = await workspaceContentStamps(dir);
    assert.equal(stamps.all, await workspaceContentStamp(dir));
    assert.ok(stamps.source && stamps.source !== stamps.all);
    // A folder of documents only has no project source to stamp: unknown, so the preview check runs.
    await rm(path.join(dir, "index.html"));
    assert.equal((await workspaceContentStamps(dir)).source, null);
    await symlink("/etc/hosts", path.join(dir, "external"));
    assert.deepEqual(await workspaceContentStamps(dir), { all: null, source: null }, "unknown stays unknown");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
