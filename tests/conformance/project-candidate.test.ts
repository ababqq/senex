import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectCandidates } from "../../src/substrate/project-candidate.ts";
import { SnapshotEngine, git } from "../../src/substrate/snapshots.ts";
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "optimization-")),
    live = path.join(root, "live");
  await mkdir(live);
  await writeFile(path.join(live, "index.html"), "baseline");
  const snapshots = new SnapshotEngine([{ name: "project", dir: live }]);
  await snapshots.init();
  const snapshot = await snapshots.snapshot({
    scope: "game",
    projectWorkspace: "project",
    reason: "baseline",
    healthy: true,
  });
  const registry = new ProjectCandidates(snapshots, path.join(root, "scratch"));
  const c = await registry.open("project", "run_test", snapshot.snapshot_id, snapshot.git.game!);
  return { root, live, snapshots, snapshot, registry, c };
}
async function validation(
  f: Awaited<ReturnType<typeof fixture>>,
  frozen: Awaited<ReturnType<ProjectCandidates["freeze"]>>,
) {
  const file = path.join(f.root, "validation.json");
  await writeFile(
    file,
    JSON.stringify({
      runId: "run_test",
      candidate: frozen.revision,
      preservation: { status: "preserved" },
      scenarios: [{ comparison: { comparable: true, improved: true } }],
    }),
  );
  return file;
}
it("candidate routing confines writes and excludes traversal, metadata and symlinks", async () => {
  const f = await fixture();
  for (const bad of ["../live/index.html", ".git/config", "/tmp/escape", "src/../../escape"])
    await assert.rejects(f.registry.file(f.c.candidateId, "project", bad, true));
  await symlink(f.live, path.join(f.c.root, "escape"));
  await assert.rejects(f.registry.file(f.c.candidateId, "project", "escape/index.html", true), /symlink/);
  await assert.rejects(f.registry.file(f.c.candidateId, "other", "index.html", true), /another project/);
  assert.equal(await readFile(path.join(f.live, "index.html"), "utf8"), "baseline");
  await f.registry.close(f.c.candidateId);
});
it("freeze includes new source, discards ephemeral brief, and blocks late direct writes", async () => {
  const f = await fixture();
  await writeFile(await f.registry.file(f.c.candidateId, "project", "new.js", true), "export const n=1");
  await mkdir(path.join(f.c.root, ".studio"));
  await writeFile(path.join(f.c.root, ".studio/BRIEF.md"), "coordinator prompt");
  const frozen = await f.registry.freeze(f.c.candidateId);
  assert.deepEqual(frozen.changedFiles, ["new.js"]);
  assert.match(frozen.diff, /export const n=1/);
  await assert.rejects(f.registry.file(f.c.candidateId, "project", "index.html", true), /frozen/);
  assert.equal(await readFile(path.join(f.live, "index.html"), "utf8"), "baseline");
  await f.registry.close(f.c.candidateId);
  assert.equal(
    (await git(f.live, ["rev-parse", `refs/optimization/${f.c.candidateId}`])).trim(),
    frozen.revision!.commit,
  );
});
it("empty freeze commits retain the content tree; live edits and late candidate edits refuse promotion", async () => {
  const f = await fixture();
  const frozen = await f.registry.freeze(f.c.candidateId);
  assert.notEqual(frozen.revision!.commit, f.c.baseline.commit);
  assert.equal(frozen.revision!.tree, f.c.baseline.tree);
  await writeFile(path.join(f.live, "untracked.js"), "user work");
  assert.equal(
    (await f.registry.promote(f.c.candidateId, f.c.baseline, frozen.revision!, await validation(f, frozen))).outcome,
    "baseline_changed",
  );
  assert.equal(await readFile(path.join(f.live, "untracked.js"), "utf8"), "user work");
  await writeFile(path.join(f.c.root, "index.html"), "late edit");
  await assert.rejects(f.registry.freeze(f.c.candidateId), /changed after freeze/);
  await f.registry.close(f.c.candidateId);
});
it("guarded promotion and restarted registry identify the retained validated tree without reset", async () => {
  const f = await fixture();
  await writeFile(path.join(f.c.root, "index.html"), "candidate");
  const frozen = await f.registry.freeze(f.c.candidateId),
    file = await validation(f, frozen);
  const restarted = new ProjectCandidates(f.snapshots, path.join(f.root, "scratch"));
  const promoted = await restarted.promote(f.c.candidateId, f.c.baseline, frozen.revision!, file);
  assert.equal(promoted.outcome, "promoted");
  assert.equal(await readFile(path.join(f.live, "index.html"), "utf8"), "candidate");
  assert.equal((await restarted.reconcile("project", f.c.baseline, frozen.revision!)).retained, "candidate");
  await writeFile(path.join(f.live, "index.html"), "new human edit");
  assert.equal((await restarted.reconcile("project", f.c.baseline, frozen.revision!)).retained, "changed");
  await restarted.close(f.c.candidateId);
  await restarted.close(f.c.candidateId);
});
it("promotion never brings a candidate's change to the project's .claude folder", async () => {
  // Claude Code loads the project's project settings and hooks into the person's own session there.
  const f = await fixture();
  await mkdir(path.join(f.c.root, ".Claude"), { recursive: true });
  await writeFile(path.join(f.c.root, ".Claude", "settings.json"), '{"hooks":{}}');
  await writeFile(path.join(f.c.root, "index.html"), "candidate");
  const frozen = await f.registry.freeze(f.c.candidateId);
  const promoted = await f.registry.promote(
    f.c.candidateId,
    f.c.baseline,
    frozen.revision!,
    await validation(f, frozen),
  );
  assert.equal(promoted.outcome, "failed");
  assert.match(String(promoted.reason), /\.claude folder \(\.Claude\/settings\.json\)/);
  assert.equal(await readFile(path.join(f.live, "index.html"), "utf8"), "baseline");
  await assert.rejects(readFile(path.join(f.live, ".Claude", "settings.json")), /ENOENT/);
  await f.registry.close(f.c.candidateId);
});
