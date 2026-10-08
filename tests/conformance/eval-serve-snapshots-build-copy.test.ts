/**
 * Building a snapshot copy for grading (`scripts/evals/grade/build-copy.ts`, §8.2–8.3): the
 * read-only snapshot is cloned into a writable copy; a project with no build (or with its `dist/`
 * already there) is served as-is; one with a build script and no output is installed with
 * `npm ci --ignore-scripts` (registry-only network) and built with the network off; a failed
 * rebuild is typed, never "did not boot"; an unchanged manifest reuses a built neighbour's
 * node_modules. The sandbox runner is a fake that records every request.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  BuildCopyError,
  BuildCopyErrorCode,
  InstallVia,
  buildSandboxOptions,
  createCopyBuilder,
  manifestDigest,
} from "../../scripts/evals/grade/build-copy.ts";
import { NoBuild, ServedVia } from "../../scripts/evals/vocabulary.ts";
import { REGISTRY_DOMAIN } from "../../src/main/project-build.ts";
import type { RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import { closeBeforeCleanup, tmpDir } from "../helpers/tmp.ts";

/** How the fake sandbox answers each command. */
interface Script {
  installCode?: number;
  buildCode?: number;
  /** Whether a successful build writes `dist/index.html`. */
  buildWrites?: boolean;
  /** Where a successful build writes its page, relative to the copy (default `dist`). */
  outDir?: string;
  /** What the built page says. */
  page?: string;
}

/** A fake sandbox runner: records requests and plays the part of npm inside `cwd`. */
function fakeRunner(script: Script = {}) {
  const requests: RunRequest[] = [];
  const run = async (request: RunRequest): Promise<RunResult> => {
    requests.push(request);
    const isBuild = request.command === "npm run build";
    const code = isBuild ? (script.buildCode ?? 0) : (script.installCode ?? 0);
    if (code === 0 && !isBuild) {
      await mkdir(path.join(request.cwd, "node_modules", "dep"), { recursive: true });
      await writeFile(path.join(request.cwd, "node_modules", "dep", "marker.txt"), "installed");
    }
    if (code === 0 && isBuild && (script.buildWrites ?? true)) {
      const out = path.resolve(request.cwd, script.outDir ?? "dist");
      await mkdir(out, { recursive: true });
      await writeFile(path.join(out, "index.html"), script.page ?? "built");
    }
    return {
      code,
      signal: null,
      stdout: "",
      stderr: "",
      durationMs: 1,
      timedOut: false,
      truncated: false,
      sandboxed: true,
      command: request.command,
      cwd: request.cwd,
    };
  };
  return { run, requests };
}

const BUILT_PACKAGE = JSON.stringify({
  name: "g",
  scripts: { build: "vite build" },
  devDependencies: { vite: "7.0.0" },
});

/** A snapshot folder with the given files, made read-only like the final clone. */
async function snapshot(base: string, name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(base, name);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
  await chmodTree(dir, 0o444, 0o555);
  // Writable again before the temp folders go, or their removal fails on a read-only folder.
  closeBeforeCleanup(() => chmodTree(dir, 0o644, 0o755));
  return dir;
}

async function chmodTree(dir: string, fileMode: number, dirMode: number): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) await chmodTree(child, fileMode, dirMode);
    else await chmod(child, fileMode);
  }
  await chmod(dir, dirMode);
}

async function exists(file: string): Promise<boolean> {
  return (await stat(file).catch(() => null)) !== null;
}

describe("snapshot copy builder", () => {
  it("serves a no-build project as-is from the copy, without running anything", async () => {
    const base = await tmpDir("eval-copy-");
    const snap = await snapshot(base, "snap", { "index.html": "<title>t</title>", "src/main.txt": "m" });
    const fake = fakeRunner();
    const builder = createCopyBuilder({ run: fake.run });
    const copyDir = path.join(base, "copies", "a");
    const result = await builder.prepare({ snapshotDir: snap, copyDir, npmCacheDir: path.join(base, "cache") });
    assert.equal(result.servedVia, ServedVia.AsIs);
    assert.equal(result.servedDir, copyDir);
    assert.equal(result.noBuild, null);
    assert.equal(fake.requests.length, 0);
    assert.equal(await readFile(path.join(copyDir, "index.html"), "utf8"), "<title>t</title>");
  });

  it("types a folder with no page and no build as no-entry", async () => {
    const base = await tmpDir("eval-copy-noentry-");
    const snap = await snapshot(base, "snap", { "notes.md": "n" });
    const builder = createCopyBuilder({ run: fakeRunner().run });
    const result = await builder.prepare({ snapshotDir: snap, copyDir: path.join(base, "c"), npmCacheDir: base });
    assert.equal(result.noBuild, NoBuild.NoEntry);
    assert.equal(result.servedDir, null);
  });

  it("serves a built project's existing dist as-is", async () => {
    const base = await tmpDir("eval-copy-dist-");
    const snap = await snapshot(base, "snap", {
      "package.json": BUILT_PACKAGE,
      "index.html": "src page",
      "dist/index.html": "built page",
    });
    const fake = fakeRunner();
    const copyDir = path.join(base, "c");
    const result = await createCopyBuilder({ run: fake.run }).prepare({
      snapshotDir: snap,
      copyDir,
      npmCacheDir: base,
    });
    assert.equal(result.servedVia, ServedVia.AsIs);
    assert.equal(result.servedDir, path.join(copyDir, "dist"));
    assert.equal(fake.requests.length, 0);
  });

  it("rebuilds inside the sandbox: registry-only install, then an offline build, writing only the copy and cache", async () => {
    const base = await tmpDir("eval-copy-rebuild-");
    const snap = await snapshot(base, "snap", {
      "package.json": BUILT_PACKAGE,
      "package-lock.json": "{}",
      "index.html": "src page",
    });
    const fake = fakeRunner();
    const copyDir = path.join(base, "c");
    const cache = path.join(base, "npm-cache");
    const result = await createCopyBuilder({ run: fake.run }).prepare({
      snapshotDir: snap,
      copyDir,
      npmCacheDir: cache,
    });
    assert.equal(result.servedVia, ServedVia.Rebuilt);
    assert.equal(result.servedDir, path.join(copyDir, "dist"));
    assert.equal(result.installed, InstallVia.Registry);
    assert.deepEqual(
      fake.requests.map((r) => r.command),
      ["npm ci --ignore-scripts", "npm run build"],
    );
    const [install, build] = fake.requests;
    assert.deepEqual(install?.policy?.allowedDomains, [REGISTRY_DOMAIN]);
    assert.deepEqual(build?.policy?.allowedDomains, []);
    for (const request of fake.requests) {
      assert.equal(request.cwd, copyDir);
      assert.equal(request.env?.npm_config_cache, cache);
      assert.deepEqual(request.policy?.allowWrite, [copyDir, cache]);
    }
    assert.equal(await exists(path.join(snap, "dist")), false, "the snapshot itself is never built");
  });

  it("installs with npm install --ignore-scripts when there is no lockfile", async () => {
    const base = await tmpDir("eval-copy-nolock-");
    const snap = await snapshot(base, "snap", { "package.json": BUILT_PACKAGE, "index.html": "p" });
    const fake = fakeRunner();
    await createCopyBuilder({ run: fake.run }).prepare({
      snapshotDir: snap,
      copyDir: path.join(base, "c"),
      npmCacheDir: base,
    });
    assert.equal(fake.requests[0]?.command, "npm install --ignore-scripts");
  });

  const failures: Array<{ name: string; script: Script; noBuild: NoBuild; commands: number }> = [
    { name: "a failed install", script: { installCode: 1 }, noBuild: NoBuild.BuildFailed, commands: 1 },
    { name: "a failed build", script: { buildCode: 2 }, noBuild: NoBuild.BuildFailed, commands: 2 },
    { name: "a build that wrote no page", script: { buildWrites: false }, noBuild: NoBuild.NoDist, commands: 2 },
  ];
  for (const row of failures) {
    it(`types ${row.name} as rebuild-failed`, async () => {
      const base = await tmpDir("eval-copy-fail-");
      const snap = await snapshot(base, "snap", { "package.json": BUILT_PACKAGE, "index.html": "p" });
      const fake = fakeRunner(row.script);
      const result = await createCopyBuilder({ run: fake.run }).prepare({
        snapshotDir: snap,
        copyDir: path.join(base, "c"),
        npmCacheDir: base,
      });
      assert.equal(result.servedVia, ServedVia.RebuildFailed);
      assert.equal(result.noBuild, row.noBuild);
      assert.equal(result.servedDir, null);
      assert.equal(fake.requests.length, row.commands);
    });
  }

  it("reuses a built neighbour's node_modules while package.json and the lockfile are unchanged", async () => {
    const base = await tmpDir("eval-copy-neighbour-");
    const files = { "package.json": BUILT_PACKAGE, "package-lock.json": '{"v":1}', "index.html": "p" };
    const first = await snapshot(base, "s1", files);
    const second = await snapshot(base, "s2", { ...files, "src/more.txt": "changed source" });
    const third = await snapshot(base, "s3", { ...files, "package-lock.json": '{"v":2}' });
    const fake = fakeRunner();
    const builder = createCopyBuilder({ run: fake.run });
    await builder.prepare({ snapshotDir: first, copyDir: path.join(base, "c1"), npmCacheDir: base });
    const reused = await builder.prepare({ snapshotDir: second, copyDir: path.join(base, "c2"), npmCacheDir: base });
    assert.equal(reused.installed, InstallVia.Neighbour);
    assert.equal(await readFile(path.join(base, "c2", "node_modules", "dep", "marker.txt"), "utf8"), "installed");
    const installs = () => fake.requests.filter((r) => r.command !== "npm run build").length;
    assert.equal(installs(), 1);
    const fresh = await builder.prepare({ snapshotDir: third, copyDir: path.join(base, "c3"), npmCacheDir: base });
    assert.equal(fresh.installed, InstallVia.Registry);
    assert.equal(installs(), 2);
  });

  it("makes the copy writable and leaves node_modules and .git of the snapshot behind", async () => {
    const base = await tmpDir("eval-copy-ro-");
    const snap = await snapshot(base, "snap", {
      "index.html": "p",
      "node_modules/x/index.txt": "x",
      ".git/HEAD": "ref",
    });
    const copyDir = path.join(base, "c");
    await createCopyBuilder({ run: fakeRunner().run }).prepare({ snapshotDir: snap, copyDir, npmCacheDir: base });
    await writeFile(path.join(copyDir, "index.html"), "writable");
    assert.equal(await exists(path.join(copyDir, "node_modules")), false);
    assert.equal(await exists(path.join(copyDir, ".git")), false);
  });

  it("reuses its own copy when the same snapshot is probed again", async () => {
    const base = await tmpDir("eval-copy-again-");
    const snap = await snapshot(base, "snap", { "package.json": BUILT_PACKAGE, "index.html": "p" });
    const fake = fakeRunner();
    const builder = createCopyBuilder({ run: fake.run });
    const request = { snapshotDir: snap, copyDir: path.join(base, "c"), npmCacheDir: base };
    const first = await builder.prepare(request);
    const again = await builder.prepare(request);
    assert.deepEqual(again, first);
    assert.equal(fake.requests.length, 2, "one install and one build, not two of each");
  });

  it("replaces a stale copy from an earlier probe", async () => {
    const base = await tmpDir("eval-copy-stale-");
    const snap = await snapshot(base, "snap", { "index.html": "p" });
    const copyDir = path.join(base, "c");
    await mkdir(copyDir, { recursive: true });
    await writeFile(path.join(copyDir, "leftover.txt"), "old");
    await createCopyBuilder({ run: fakeRunner().run }).prepare({ snapshotDir: snap, copyDir, npmCacheDir: base });
    assert.equal(await exists(path.join(copyDir, "leftover.txt")), false);
  });

  const overlaps: Array<{ name: string; copy: (snap: string) => string }> = [
    { name: "the snapshot itself", copy: (snap) => snap },
    { name: "a folder inside the snapshot", copy: (snap) => path.join(snap, "copy") },
    { name: "a parent of the snapshot", copy: (snap) => path.dirname(snap) },
  ];
  for (const row of overlaps) {
    it(`refuses a copy folder that is ${row.name}, touching nothing`, async () => {
      const base = await tmpDir("eval-copy-overlap-");
      const snap = await snapshot(base, "snap", { "index.html": "p" });
      const fake = fakeRunner();
      await assert.rejects(
        createCopyBuilder({ run: fake.run }).prepare({ snapshotDir: snap, copyDir: row.copy(snap), npmCacheDir: base }),
        (error: unknown) => error instanceof BuildCopyError && error.code === BuildCopyErrorCode.CopyOverlapsSnapshot,
      );
      assert.deepEqual(await readdir(snap), ["index.html"]);
      assert.equal(await readFile(path.join(snap, "index.html"), "utf8"), "p");
      assert.equal(fake.requests.length, 0);
    });
  }

  it("opens a Genex project with its local-test query", async () => {
    const base = await tmpDir("eval-copy-genex-");
    const pkg = JSON.stringify({ name: "g", dependencies: { "@genex-ai/embed-sdk": "1.0.0" } });
    const snap = await snapshot(base, "snap", { "package.json": pkg, "index.html": '<script src="/m.js"></script>' });
    const result = await createCopyBuilder({ run: fakeRunner().run }).prepare({
      snapshotDir: snap,
      copyDir: path.join(base, "c"),
      npmCacheDir: base,
    });
    assert.equal(result.entryQuery, "genex_local_test=1");
  });
});

describe("manifest digest and sandbox options", () => {
  it("changes with package.json or the lockfile and ignores everything else", async () => {
    const base = await tmpDir("eval-copy-digest-");
    await writeFile(path.join(base, "package.json"), "{}");
    const first = await manifestDigest(base);
    await writeFile(path.join(base, "index.html"), "x");
    assert.equal(await manifestDigest(base), first);
    await writeFile(path.join(base, "package-lock.json"), "{}");
    assert.notEqual(await manifestDigest(base), first);
    assert.equal(await manifestDigest(path.join(base, "missing")), null);
  });

  it("gives the build sandbox only the cache to write, and no network: each step adds its own copy", async () => {
    // Flipped (grade-probe-review-9): the base no longer grants the whole copies folder, which let
    // one copy's build write every sibling copy (the per-step grant only ever adds).
    const options = buildSandboxOptions({ npmCacheDir: "/w/cache", scratchDir: "/w/tmp" });
    assert.deepEqual(options.writableRoots, ["/w/cache"]);
    assert.equal(options.scratchDir, "/w/tmp");
    assert.deepEqual(options.secretPaths, []);
    const base = await tmpDir("eval-copy-sandbox-");
    const snap = await snapshot(base, "snap", { "package.json": BUILT_PACKAGE, "index.html": "p" });
    const copies = path.join(base, "copies");
    const fake = fakeRunner();
    await createCopyBuilder({ run: fake.run }).prepare({
      snapshotDir: snap,
      copyDir: path.join(copies, "a"),
      npmCacheDir: "/w/cache",
    });
    const sibling = path.join(copies, "b");
    for (const request of fake.requests) {
      const writable = [...options.writableRoots, ...(request.policy?.allowWrite ?? [])];
      const reaches = (target: string) =>
        writable.some((root) => {
          const rel = path.relative(root, target);
          return rel === "" || !(rel.startsWith("..") || path.isAbsolute(rel));
        });
      assert.equal(reaches(sibling), false, `${request.command} may not write a sibling copy`);
      assert.equal(reaches(path.join(copies, "dist")), false, `${request.command} may not write beside the copies`);
      assert.equal(reaches(path.join(copies, "a", "dist")), true);
    }
  });

  /** Stands for an absolute folder outside the copy, made under the test's own temp folder. */
  const ABSOLUTE_OUT_DIR = "<absolute>";
  const ESCAPING_OUT_DIRS: Array<{ name: string; outDir: string }> = [
    { name: "a parent folder", outDir: "../dist" },
    { name: "a folder further up", outDir: "../../x" },
    { name: "an absolute folder", outDir: ABSOLUTE_OUT_DIR },
  ];
  for (const row of ESCAPING_OUT_DIRS) {
    it(`refuses an output folder in ${row.name}: nothing is built or served outside the copy`, async () => {
      const base = await tmpDir("eval-copy-outdir-");
      const copies = path.join(base, "copies");
      const outDir = row.outDir === ABSOLUTE_OUT_DIR ? path.join(base, "elsewhere") : row.outDir;
      const results = [];
      const fake = fakeRunner({ outDir, page: "RUN-X" });
      const builder = createCopyBuilder({ run: fake.run });
      for (const name of ["x", "y"]) {
        const snap = await snapshot(base, `snap-${name}`, {
          "package.json": BUILT_PACKAGE,
          "vite.config.js": `export default { build: { outDir: '${outDir}' } };`,
          "index.html": "src page",
        });
        results.push(await builder.prepare({ snapshotDir: snap, copyDir: path.join(copies, name), npmCacheDir: base }));
      }
      for (const result of results) {
        assert.equal(result.servedDir, null);
        assert.equal(result.servedVia, ServedVia.RebuildFailed);
        assert.equal(result.noBuild, NoBuild.NoDist);
      }
      assert.equal(fake.requests.length, 0, "a build that can only write outside its copy is never run");
    });
  }

  it("refuses a dist that is a symlink out of the copy, serving none of it", async () => {
    const base = await tmpDir("eval-copy-symlinked-dist-");
    const outside = path.join(base, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "index.html"), "someone else's page");
    const snap = path.join(base, "snap");
    await mkdir(snap, { recursive: true });
    await writeFile(path.join(snap, "package.json"), BUILT_PACKAGE);
    await writeFile(path.join(snap, "index.html"), "src page");
    await symlink(await realpath(outside), path.join(snap, "dist"));
    const fake = fakeRunner();
    const result = await createCopyBuilder({ run: fake.run }).prepare({
      snapshotDir: snap,
      copyDir: path.join(base, "copies", "a"),
      npmCacheDir: base,
    });
    assert.equal(result.servedDir, null);
    assert.equal(result.servedVia, ServedVia.RebuildFailed);
    assert.equal(fake.requests.length, 0);
  });
});
