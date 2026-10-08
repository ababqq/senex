/**
 * Review stills stay inside the run folder, and Play is a worktree — never a live-tree rollback.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { startRig, type Rig } from "../helpers/studio-rig.ts";

const rigs: Rig[] = [];
after(async () => {
  await Promise.all(rigs.map((rig) => rig.stop().catch(() => {})));
});

describe("morning review: stills and play", () => {
  it("reads a still only from the run folder, and plays a snapshot without touching the live tree", async () => {
    const rig = await startRig();
    rigs.push(rig);

    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.alloc(32, 7)]);
    const saved = await rig.core.saveRunArtifact("run-1", "iter_001/screenshots/default.jpg", jpeg);
    const still = await rig.core.readRunStill(saved);
    assert.equal(still?.mimeType, "image/jpeg");
    assert.ok(still?.data);

    const outside = path.join(rig.userData, "escape.jpg");
    await writeFile(outside, jpeg);
    assert.equal(await rig.core.readRunStill(outside), null, "a path outside runs/ must not be readable");
    assert.equal(
      await rig.core.readRunStill(path.join(rig.core.layout.runs, "..", "escape.jpg")),
      null,
      "a .. escape must not be readable",
    );
    // Writing is held to the same folder: the harness names both parts over RPC.
    const write = rig.core.api()["run.artifact"]!;
    await assert.rejects(
      write({ runId: "run-1", name: "../../../written.txt", base64: "eA==" } as never),
      /inside its run folder/,
    );
    await assert.rejects(
      write({ runId: "../..", name: "written.txt", base64: "eA==" } as never),
      /inside its run folder/,
    );
    await assert.rejects(readFile(path.join(rig.core.layout.runs, "..", "..", "written.txt")));

    const project = await rig.core.projects.scaffold("pong");
    await writeFile(path.join(project.dir, "index.html"), "<h1>v1</h1>\n");
    const v1 = await rig.core.snapshot("game", "v1", "pong");
    await writeFile(path.join(project.dir, "index.html"), "<h1>v2 live</h1>\n");

    const played = await rig.core.playProjectSnapshot(v1.snapshot_id, "pong");
    assert.equal(await readFile(path.join(project.dir, "index.html"), "utf8"), "<h1>v2 live</h1>\n");
    assert.equal(await readFile(path.join(played.dir, "index.html"), "utf8"), "<h1>v1</h1>\n");
    assert.equal(rig.preview.loads.at(-1), "pong");
    assert.equal(rig.preview.loadRoot, played.dir);

    await rig.core.api()["preview.load"]({ project: "pong" } as never);
    assert.equal(rig.preview.loadRoot, null, "loading the live project must drop the review worktree");
  });
});
