/**
 * The snapshot watcher (`scripts/evals/watch/snapshots.ts`, §8.3, Rule 22, M1.4): it clones a
 * project folder only when it changed, never node_modules or .git, never through a symlink; it takes
 * a read-only final clone at stop; it writes one index line per clone; and the stop-time
 * snapshot types "no build" (`template-untouched`, `no-entry`, `no-dist`, `build-failed`).
 * The clock and the timer are fakes; folders are temp folders.
 */
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  SNAPSHOT_INDEX_FILE,
  SNAPSHOT_INTERVAL_MS,
  createSnapshotWatcher,
  noBuildAtStop,
  readSnapshotIndex,
  scanSnapshots,
  snapshotFacts,
  workspaceDigest,
} from "../../scripts/evals/watch/snapshots.ts";
import { NoBuild, ServedVia, SnapshotKind } from "../../scripts/evals/vocabulary.ts";
import { closeBeforeCleanup, tmpDir } from "../helpers/tmp.ts";

const START_MS = 1_800_000_000_000;

/** A fake clock the test moves by hand. */
function clock() {
  let at = START_MS;
  return { now: () => at, advance: (ms: number) => (at += ms) };
}

/** Write files under a folder. */
async function files(dir: string, entries: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(entries)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
}

/** Writable again before the temp folders are removed. */
async function unlock(dir: string): Promise<void> {
  const info = await lstat(dir).catch(() => null);
  if (!info || info.isSymbolicLink()) return;
  await chmod(dir, info.isDirectory() ? 0o755 : 0o644);
  if (!info.isDirectory()) return;
  for (const name of await readdir(dir)) await unlock(path.join(dir, name));
}

async function setup(prefix: string) {
  const base = await tmpDir(prefix);
  const project = path.join(base, "project");
  const snapshots = path.join(base, "snapshots");
  await files(project, { "index.html": "<title>t</title>", "src/main.js.txt": "one\ntwo\n" });
  closeBeforeCleanup(() => unlock(snapshots));
  return { base, project, snapshots };
}

describe("snapshot watcher", () => {
  it("clones on change only, excluding node_modules and .git, and indexes each clone", async () => {
    const { project, snapshots } = await setup("eval-snap-change-");
    await files(project, { "node_modules/x/a.txt": "dep", ".git/HEAD": "ref", "src/node_modules/y.txt": "nested" });
    const time = clock();
    const watcher = createSnapshotWatcher({
      projectRoot: project,
      snapshotDir: snapshots,
      startedAtMs: START_MS,
      now: time.now,
    });
    time.advance(SNAPSHOT_INTERVAL_MS);
    const first = await watcher.tick();
    assert.ok(first);
    assert.equal(first.kind, SnapshotKind.Periodic);
    assert.equal(first.atMs, SNAPSHOT_INTERVAL_MS);
    const firstDir = path.join(snapshots, first.name);
    assert.deepEqual((await readdir(firstDir)).sort(), ["index.html", "src"]);
    assert.deepEqual(await readdir(path.join(firstDir, "src")), ["main.js.txt"]);

    time.advance(SNAPSHOT_INTERVAL_MS);
    assert.equal(await watcher.tick(), null, "an unchanged folder is not cloned again");

    await writeFile(path.join(project, "index.html"), "<title>changed</title>");
    time.advance(SNAPSHOT_INTERVAL_MS);
    const second = await watcher.tick();
    assert.ok(second);
    assert.notEqual(second.sha256, first.sha256);
    assert.equal(second.seq, first.seq + 1);

    const index = await readSnapshotIndex(snapshots);
    assert.deepEqual(
      index.map((entry) => entry.name),
      [first.name, second.name],
    );
    assert.equal(index[0]?.recordedAt, new Date(START_MS + SNAPSHOT_INTERVAL_MS).toISOString());
  });

  it("drops a clone whose contents did not change (a touched file)", async () => {
    const { project, snapshots } = await setup("eval-snap-touch-");
    const time = clock();
    const watcher = createSnapshotWatcher({
      projectRoot: project,
      snapshotDir: snapshots,
      startedAtMs: START_MS,
      now: time.now,
    });
    await watcher.tick();
    const later = new Date(Date.now() + 60_000);
    await utimes(path.join(project, "index.html"), later, later);
    assert.equal(await watcher.tick(), null);
    const clones = (await readdir(snapshots)).filter((name) => name !== SNAPSHOT_INDEX_FILE);
    assert.equal(clones.length, 1);
  });

  it("copies a symlink as a link, never the outside file it points at", async () => {
    const { base, project, snapshots } = await setup("eval-snap-link-");
    await files(base, { "outside/secret.txt": "outside-sentinel" });
    await symlink(path.join(base, "outside"), path.join(project, "escape"));
    const watcher = createSnapshotWatcher({
      projectRoot: project,
      snapshotDir: snapshots,
      startedAtMs: START_MS,
      now: clock().now,
    });
    const entry = await watcher.tick();
    assert.ok(entry);
    const link = await lstat(path.join(snapshots, entry.name, "escape"));
    assert.ok(link.isSymbolicLink());
  });

  it("retries after a clone that failed, leaving no partial folder", async () => {
    const { project, snapshots } = await setup("eval-snap-fail-");
    let calls = 0;
    const watcher = createSnapshotWatcher({
      projectRoot: project,
      snapshotDir: snapshots,
      startedAtMs: START_MS,
      now: clock().now,
      clone: async (from, to) => {
        calls += 1;
        await mkdir(to, { recursive: true });
        if (calls === 1) throw new Error("vanished mid-copy");
        await files(to, { "index.html": await readFile(path.join(from, "index.html"), "utf8") });
      },
    });
    assert.equal(await watcher.tick(), null);
    assert.deepEqual(
      (await readdir(snapshots)).filter((name) => name !== SNAPSHOT_INDEX_FILE),
      [],
    );
    assert.ok(await watcher.tick());
  });

  it("ticks on the injected timer every 30 s and stops with a read-only final clone", async () => {
    const { project, snapshots } = await setup("eval-snap-final-");
    const time = clock();
    const timers: Array<{ ms: number; cancelled: boolean; fire: () => void }> = [];
    const watcher = createSnapshotWatcher({
      projectRoot: project,
      snapshotDir: snapshots,
      startedAtMs: START_MS,
      now: time.now,
      every: (fire, ms) => {
        const timer = { ms, cancelled: false, fire };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    });
    watcher.start();
    assert.equal(timers[0]?.ms, SNAPSHOT_INTERVAL_MS);
    time.advance(SNAPSHOT_INTERVAL_MS);
    timers[0]?.fire();
    time.advance(5_000);
    const final = await watcher.stop();
    assert.equal(timers[0]?.cancelled, true);
    assert.equal(final.kind, SnapshotKind.Final);
    assert.equal(final.atMs, SNAPSHOT_INTERVAL_MS + 5_000);
    const finalDir = path.join(snapshots, final.name);
    await assert.rejects(writeFile(path.join(finalDir, "index.html"), "tampered"), { code: "EACCES" });
    await assert.rejects(writeFile(path.join(finalDir, "new.txt"), "x"), { code: "EACCES" });
    const index = await readSnapshotIndex(snapshots);
    assert.deepEqual(
      index.map((entry) => entry.kind),
      [SnapshotKind.Periodic, SnapshotKind.Final],
    );
    assert.equal(await watcher.tick(), null, "nothing is cloned after stop");
    const scan = scanSnapshots(snapshots, index);
    assert.deepEqual(
      scan.map((row) => row.dir),
      [finalDir],
      "an unchanged last periodic clone is the final clone",
    );
  });
});

describe("stop-time no-build reasons", () => {
  it("ignores studio metadata, .git and node_modules in the workspace digest", async () => {
    const base = await tmpDir("eval-snap-digest-");
    await files(base, { "index.html": "p", "src/a.txt": "a" });
    const seeded = await workspaceDigest(base);
    await files(base, {
      "studio.json": '{"name":"x"}',
      ".gitignore": "dist\n",
      ".git/HEAD": "ref",
      "node_modules/d/x.txt": "x",
      ".studio/state.json": "{}",
    });
    assert.equal(await workspaceDigest(base), seeded);
    await files(base, { "src/a.txt": "edited" });
    assert.notEqual(await workspaceDigest(base), seeded);
  });

  it("reads the stop-time facts of a snapshot", async () => {
    const base = await tmpDir("eval-snap-facts-");
    await files(base, { "index.html": "a\nb\n", "src/main.js": "x\ny\nz\n", "assets/t.png": "png" });
    const facts = await snapshotFacts(base, { templateDigest: null });
    assert.equal(facts.files, 3);
    assert.equal(facts.hasEntry, true);
    assert.equal(facts.buildScript, false);
    assert.equal(facts.loc, 5);
    assert.equal(facts.noBuild, null);
    assert.match(facts.sha256, /^[0-9a-f]{64}$/);
  });

  it("types an untouched template from its seeded digest", async () => {
    const base = await tmpDir("eval-snap-template-");
    await files(base, { "index.html": "template", "src/main.js": "seed" });
    const templateDigest = await workspaceDigest(base);
    await files(base, { "studio.json": "{}" });
    assert.equal((await snapshotFacts(base, { templateDigest })).noBuild, NoBuild.TemplateUntouched);
    await files(base, { "src/main.js": "the agent's project" });
    assert.equal((await snapshotFacts(base, { templateDigest })).noBuild, null);
  });

  const table: Array<{
    name: string;
    stop: { templateUntouched: boolean; hasEntry: boolean; buildScript: boolean; hasOutput: boolean };
    build: { servedVia: ServedVia; noBuild: NoBuild | null } | null;
    expected: NoBuild | null;
  }> = [
    {
      name: "untouched template wins over everything",
      stop: { templateUntouched: true, hasEntry: true, buildScript: false, hasOutput: false },
      build: null,
      expected: NoBuild.TemplateUntouched,
    },
    {
      name: "no page and no build",
      stop: { templateUntouched: false, hasEntry: false, buildScript: false, hasOutput: false },
      build: null,
      expected: NoBuild.NoEntry,
    },
    {
      name: "a page with no build",
      stop: { templateUntouched: false, hasEntry: true, buildScript: false, hasOutput: false },
      build: null,
      expected: null,
    },
    {
      name: "a build with its output",
      stop: { templateUntouched: false, hasEntry: true, buildScript: true, hasOutput: true },
      build: null,
      expected: null,
    },
    {
      name: "a build without output, not rebuilt",
      stop: { templateUntouched: false, hasEntry: true, buildScript: true, hasOutput: false },
      build: null,
      expected: NoBuild.NoDist,
    },
    {
      name: "a build without output that rebuilt",
      stop: { templateUntouched: false, hasEntry: true, buildScript: true, hasOutput: false },
      build: { servedVia: ServedVia.Rebuilt, noBuild: null },
      expected: null,
    },
    {
      name: "a build without output whose rebuild failed",
      stop: { templateUntouched: false, hasEntry: true, buildScript: true, hasOutput: false },
      build: { servedVia: ServedVia.RebuildFailed, noBuild: NoBuild.BuildFailed },
      expected: NoBuild.BuildFailed,
    },
    {
      name: "a build that rebuilt without writing a page",
      stop: { templateUntouched: false, hasEntry: true, buildScript: true, hasOutput: false },
      build: { servedVia: ServedVia.RebuildFailed, noBuild: NoBuild.NoDist },
      expected: NoBuild.NoDist,
    },
  ];
  for (const row of table) {
    it(`types ${row.name}`, () => {
      assert.equal(noBuildAtStop(row.stop, row.build), row.expected);
    });
  }
});
