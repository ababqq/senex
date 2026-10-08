/**
 * The harness's `snapshot.restore` on a project (GDS-3 follow-through). The engine commits a rescue
 * snapshot of the folder before it resets it; the core must log that rescue like any other
 * snapshot, so the index, Rewind and a "recover my files" view can find it, and name it on the
 * `workspace_restored` event. A refusal reaches the harness with its typed code.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { SnapshotScope } from "../../src/shared/event-log.ts";
import { coreLite, type CoreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

const git = promisify(execFile);
type Api = Record<string, (input: unknown) => Promise<unknown>>;
interface Snap {
  snapshot_id: string;
}

let lite: CoreLite;
let api: Api;
let dir: string;

before(async () => {
  lite = await coreLite({ projectsRoot: await realpath(await tmpDir("studio-projects-")) });
  api = lite.api() as unknown as Api;
  await lite.core.projects.scaffold("pong");
  dir = lite.core.projects.dirFor("pong");
});

async function eventsOfType(type: string): Promise<Array<Record<string, unknown>>> {
  const events = await lite.core.listAllEvents();
  return events.map((e) => e.data as unknown as Record<string, unknown>).filter((d) => d.type === type);
}

describe("snapshot.restore on a project", () => {
  it("logs the pre-restore rescue snapshot and names it on workspace_restored", async () => {
    const before = (await api["snapshot.create"]!({ scope: "game", project: "pong", reason: "before" })) as Snap;
    await writeFile(path.join(dir, "notes.txt"), "the user's unsaved thought\n");

    await api["snapshot.restore"]!({ snapshotId: before.snapshot_id, project: "pong", reason: "failed build" });

    const restored = (await eventsOfType("workspace_restored")).at(-1)!;
    assert.equal(restored.snapshot_id, before.snapshot_id);
    const rescueId = restored.rescue_snapshot_id;
    assert.equal(typeof rescueId, "string", "workspace_restored names the rescue snapshot");
    const created = (await eventsOfType("snapshot_created")).find((d) => d.snapshot_id === rescueId);
    assert.ok(created, "the rescue snapshot is logged as snapshot_created");
    assert.equal(created.scope, SnapshotScope.Project);
    const record = lite.core.snapshotIndex.get(String(rescueId));
    assert.ok(record?.git.game, "the index knows the rescue commit");
    const { stdout } = await git("git", ["-C", dir, "show", `${record.git.game}:notes.txt`]);
    assert.equal(stdout, "the user's unsaved thought\n", "the rescue holds the file the restore removed");
  });

  it("reports a refusal with its typed code and leaves the folder alone", async () => {
    const snap = (await api["snapshot.create"]!({ scope: "game", project: "pong", reason: "on main" })) as Snap;
    await git("git", ["-C", dir, "checkout", "-q", "-b", "elsewhere"]);
    await writeFile(path.join(dir, "draft.txt"), "keep me\n");
    await assert.rejects(api["snapshot.restore"]!({ snapshotId: snap.snapshot_id, project: "pong" }), {
      name: "SnapshotRefusedError",
      code: "branch-changed",
    });
    assert.equal(await readFile(path.join(dir, "draft.txt"), "utf8"), "keep me\n");
  });
});
