/**
 * A snapshot made servable (§8.2 Serving, §8.3 per-snapshot serve). The snapshot is read-only
 * evidence, so it is never built where it stands: it is cloned (APFS `clonefile` through
 * `COPYFILE_FICLONE`) into a writable copy, and only the copy is built — the pattern of the
 * app's shadow build in `src/main/project-build.ts`.
 *
 * - No build script: the copy is served as written (`as-is`), or typed `no-entry` without a page.
 * - A build script and its output already there: served from the output (`as-is`).
 * - A build script and no output: installed and built inside `ProcessSandbox`, then served
 *   (`rebuilt`). The install is `npm ci --ignore-scripts` (`npm install --ignore-scripts` with no
 *   lockfile) with the network opened to the npm registry only; the build runs with the network
 *   off. Both write only their own copy and the per-run npm cache: the sandbox grants the cache,
 *   and each step adds its own copy, never the folder of copies. A failure is `rebuild-failed` —
 *   unknown, never "did not boot" — with `build-failed`, or `no-dist` when the build wrote no page.
 * - An output folder that resolves outside the copy (`outDir: '../dist'`, an absolute folder, a
 *   `dist` symlinked elsewhere) is never built into or served: the copy is `rebuild-failed` with
 *   `no-dist`, so one run can never be graded on what another run's build left beside it.
 *
 * A built neighbour's `node_modules` is cloned instead of installing again while the
 * `package.json` + lockfile digest is unchanged, so a Vite project is not measured later than it
 * was playable just because every snapshot paid for its own install.
 */
import { constants } from "node:fs";
import { chmod, cp, lstat, readdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { REGISTRY_DOMAIN } from "../../../src/main/project-build.ts";
import { MINUTE_MS } from "../../../src/shared/duration.ts";
import { pathExists } from "../../../src/substrate/fsx.ts";
import { declaresDependencies, detectProjectShape, readPackageManifest } from "../../../src/substrate/project-shape.ts";
import type { RunRequest, RunResult, SandboxOptions } from "../../../src/substrate/spawn.ts";
import { NoBuild, ServedVia } from "../vocabulary.ts";

/** How long the sandboxed install may run. */
const INSTALL_TIMEOUT_MS = 10 * MINUTE_MS;
/** How long the sandboxed build may run. */
const BUILD_TIMEOUT_MS = 5 * MINUTE_MS;
/** Where a build writes its page when the shape names no other folder. */
const DEFAULT_OUTPUT_DIR = "dist";
/** The page every served folder opens. */
const INDEX_FILE = "index.html";
/** Never part of a copy: a snapshot excludes them, and a copy installs its own. */
const NEVER_COPIED = new Set(["node_modules", ".git"]);
/** The lockfiles `npm ci` installs from. */
const NPM_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json"] as const;
/** Every lockfile whose change means a neighbour's node_modules no longer fits. */
const MANIFEST_FILES = [
  "package.json",
  ...NPM_LOCKFILES,
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;
/** The permission bits a copied file or folder gains so the build can write it. */
const OWNER_WRITE = 0o200;
/** Folders need search permission too. */
const OWNER_RWX = 0o700;

/** The commands a copy is built with; npm only (§8.2). */
const Command = {
  Ci: "npm ci --ignore-scripts",
  Install: "npm install --ignore-scripts",
  Build: "npm run build",
} as const;

/** How a rebuilt copy got its `node_modules`. */
export const InstallVia = {
  /** Nothing to install: the package declares no dependencies, or nothing was rebuilt. */
  None: "none",
  /** Cloned from a built neighbour with the same manifest digest. */
  Neighbour: "neighbour",
  /** Installed from the npm registry inside the sandbox. */
  Registry: "registry",
} as const;
export type InstallVia = (typeof InstallVia)[keyof typeof InstallVia];

/** Why a copy was refused before anything was written. */
export const BuildCopyErrorCode = {
  /** The copy folder is the snapshot, inside it, or around it: building there would write the evidence. */
  CopyOverlapsSnapshot: "copy-overlaps-snapshot",
} as const;
export type BuildCopyErrorCode = (typeof BuildCopyErrorCode)[keyof typeof BuildCopyErrorCode];

/** A typed refusal to prepare a copy. */
export class BuildCopyError extends Error {
  readonly code: BuildCopyErrorCode;

  constructor(code: BuildCopyErrorCode) {
    super(code);
    this.name = "BuildCopyError";
    this.code = code;
  }
}

/** One copy to prepare: which snapshot, where its copy lives, and the npm cache it may write. */
export interface CopyRequest {
  snapshotDir: string;
  copyDir: string;
  npmCacheDir: string;
}

/** What serving needs from a prepared copy. */
export interface PreparedCopy {
  /** The folder holding the page to serve; null when there is none. */
  servedDir: string | null;
  servedVia: ServedVia;
  /** The query the entry opens with, without `?` (`genex_local_test=1` for a Genex project). */
  entryQuery: string;
  /** Why there is no build to grade, from this copy of the stop-time snapshot. */
  noBuild: NoBuild | null;
}

/** One sandboxed step and how it ended. */
export interface BuildStepResult {
  command: string;
  code: number | null;
  timedOut: boolean;
  durationMs: number;
}

/** A prepared copy with how it was built. */
export interface BuildCopyResult extends PreparedCopy {
  copyDir: string;
  /** sha256 of package.json and the lockfiles; null without a package.json. */
  manifestDigest: string | null;
  installed: InstallVia;
  steps: BuildStepResult[];
}

/** Runs one command inside `ProcessSandbox` (`sandbox.run`); a fake in tests. */
export type SandboxRun = (request: RunRequest) => Promise<RunResult>;

/** Prepares copies for one run, remembering built neighbours by manifest digest. */
export interface CopyBuilder {
  prepare(request: CopyRequest): Promise<BuildCopyResult>;
}

/** Whether `inner` is `outer` or lies under it. */
function within(outer: string, inner: string): boolean {
  const rel = path.relative(path.resolve(outer), path.resolve(inner));
  return rel === "" || !(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

/** The copy may neither be the snapshot, nor sit inside it, nor contain it. */
function assertApart(snapshotDir: string, copyDir: string): void {
  const overlaps = within(snapshotDir, copyDir) || within(copyDir, snapshotDir);
  if (overlaps) throw new BuildCopyError(BuildCopyErrorCode.CopyOverlapsSnapshot);
}

/** sha256 over package.json and whichever lockfiles exist; null without a package.json. */
export async function manifestDigest(dir: string): Promise<string | null> {
  if (!(await pathExists(path.join(dir, "package.json")))) return null;
  const hash = createHash("sha256");
  for (const name of MANIFEST_FILES) {
    const bytes = await readFile(path.join(dir, name)).catch(() => null);
    hash.update(`${name}\0${bytes === null ? "-" : bytes.length}\0`);
    if (bytes !== null) hash.update(bytes);
  }
  return hash.digest("hex");
}

/**
 * The sandbox a copy is built in: it may write the npm cache and nothing else, and it opens no
 * network by itself. Each step adds its own copy to write (`step`'s `allowWrite`) and, for an
 * install, the registry; a per-step grant only ever adds, so the base never names the folder of
 * copies, or one copy's build could write every sibling.
 */
export function buildSandboxOptions(p: { npmCacheDir: string; scratchDir: string }): SandboxOptions {
  return { writableRoots: [p.npmCacheDir], scratchDir: p.scratchDir, secretPaths: [] };
}

/** Give the owner write permission on every file and folder of the copy (the snapshot is read-only). */
async function makeWritable(dir: string): Promise<void> {
  const info = await lstat(dir);
  await chmod(dir, info.mode | OWNER_RWX);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) await makeWritable(child);
    else if (entry.isFile()) await chmod(child, (await lstat(child)).mode | OWNER_WRITE);
  }
}

/** Clone the snapshot into a fresh copy, without node_modules or .git, and make it writable. */
async function cloneSnapshot(snapshotDir: string, copyDir: string): Promise<void> {
  await rm(copyDir, { recursive: true, force: true });
  await cp(snapshotDir, copyDir, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
    verbatimSymlinks: true,
    filter: (source) => !NEVER_COPIED.has(path.basename(source)),
  });
  await makeWritable(copyDir);
}

/** The environment every sandboxed npm step gets: the per-run cache, and no chatter. */
function npmEnv(npmCacheDir: string): Record<string, string> {
  return {
    npm_config_cache: npmCacheDir,
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
}

/** Run one sandboxed step and keep its record. */
async function step(
  run: SandboxRun,
  request: CopyRequest,
  command: string,
  p: { allowedDomains: string[]; timeoutMs: number },
): Promise<BuildStepResult> {
  const result = await run({
    command,
    cwd: request.copyDir,
    env: npmEnv(request.npmCacheDir),
    timeoutMs: p.timeoutMs,
    label: `eval-copy:${command}`,
    policy: { allowedDomains: p.allowedDomains, allowWrite: [request.copyDir, request.npmCacheDir] },
  });
  return { command, code: result.code, timedOut: result.timedOut, durationMs: result.durationMs };
}

/** The entry's query from a detected shape's entry (`dist/index.html?genex_local_test=1`). */
function entryQueryOf(entry: string | undefined): string {
  const at = entry?.indexOf("?") ?? -1;
  return entry && at >= 0 ? entry.slice(at + 1) : "";
}

/** How a folder is served before anything is built: build script, output folder, entry query, dependencies. */
export interface ServeShape {
  buildScript: boolean;
  outputDir: string;
  /** Whether the output folder, as named, lies inside the copy (a symlink is checked on disk later). */
  contained: boolean;
  entryQuery: string;
  dependencies: boolean;
}

/** Read a folder's serve shape: the build's output folder (the shape's, else `dist`), or the folder itself. */
export async function readServeShape(copyDir: string): Promise<ServeShape> {
  const pkg = await readPackageManifest(copyDir);
  const buildScript = typeof pkg?.scripts?.build === "string" && pkg.scripts.build.trim().length > 0;
  const shape = await detectProjectShape(copyDir);
  const serve = buildScript ? (shape?.serve ?? DEFAULT_OUTPUT_DIR) : ".";
  // Resolved as the bundler does: an absolute `outDir` is taken as it stands.
  const outputDir = path.resolve(copyDir, serve);
  return {
    buildScript,
    outputDir,
    contained: within(copyDir, outputDir),
    entryQuery: entryQueryOf(shape?.entry),
    dependencies: declaresDependencies(pkg),
  };
}

/** Whether a folder holds a page to open. */
function hasPage(dir: string): Promise<boolean> {
  return pathExists(path.join(dir, INDEX_FILE));
}

/** Whether `dir`, every symlink followed, still lies inside the copy; a missing folder is not outside. */
async function staysInCopy(copyDir: string, dir: string): Promise<boolean> {
  const real = await realpath(dir).catch(() => null);
  if (real === null) return true;
  return within(await realpath(copyDir), real);
}

/** Whether a shape's output folder is the copy's own, by name and on disk. */
async function ownOutput(copyDir: string, shape: ServeShape): Promise<boolean> {
  return shape.contained && (await staysInCopy(copyDir, shape.outputDir));
}

/** A copy whose output folder lies outside it: nothing is built there and nothing is served. */
function outsideCopy(request: CopyRequest, shape: ServeShape, digest: string | null): BuildCopyResult {
  return {
    copyDir: request.copyDir,
    servedDir: null,
    servedVia: ServedVia.RebuildFailed,
    entryQuery: shape.entryQuery,
    noBuild: NoBuild.NoDist,
    manifestDigest: digest,
    installed: InstallVia.None,
    steps: [],
  };
}

/** Build copies of one run's snapshots inside the sandbox `run` stands for. */
export function createCopyBuilder(options: { run: SandboxRun }): CopyBuilder {
  /** A built copy's node_modules by manifest digest. */
  const neighbours = new Map<string, string>();
  /** Copies already prepared, by copy folder: a snapshot never changes, so a re-probe reuses its copy. */
  const prepared = new Map<string, { snapshotDir: string; result: BuildCopyResult }>();

  /** node_modules for a rebuild: a neighbour's clone, a registry install, or none needed. */
  async function install(
    request: CopyRequest,
    digest: string | null,
    steps: BuildStepResult[],
  ): Promise<InstallVia | null> {
    const neighbour = digest === null ? undefined : neighbours.get(digest);
    if (neighbour !== undefined && (await pathExists(neighbour))) {
      const target = path.join(request.copyDir, "node_modules");
      await cp(neighbour, target, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true });
      return InstallVia.Neighbour;
    }
    const locked = await Promise.all(NPM_LOCKFILES.map((name) => pathExists(path.join(request.copyDir, name))));
    const command = locked.some(Boolean) ? Command.Ci : Command.Install;
    const result = await step(options.run, request, command, {
      allowedDomains: [REGISTRY_DOMAIN],
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    steps.push(result);
    return result.code === 0 ? InstallVia.Registry : null;
  }

  /** Install (when the package has dependencies) and build the copy, then find its page. */
  async function rebuild(request: CopyRequest, shape: ServeShape, digest: string | null): Promise<BuildCopyResult> {
    const steps: BuildStepResult[] = [];
    const failed = (noBuild: NoBuild, installed: InstallVia): BuildCopyResult => ({
      copyDir: request.copyDir,
      servedDir: null,
      servedVia: ServedVia.RebuildFailed,
      entryQuery: shape.entryQuery,
      noBuild,
      manifestDigest: digest,
      installed,
      steps,
    });
    const installed = shape.dependencies ? await install(request, digest, steps) : InstallVia.None;
    if (installed === null) return failed(NoBuild.BuildFailed, InstallVia.Registry);
    const build = await step(options.run, request, Command.Build, { allowedDomains: [], timeoutMs: BUILD_TIMEOUT_MS });
    steps.push(build);
    if (build.code !== 0) return failed(NoBuild.BuildFailed, installed);
    // The build may have made its output a link out of the copy: that page is not this copy's.
    const own = await ownOutput(request.copyDir, shape);
    if (!own || !(await hasPage(shape.outputDir))) return failed(NoBuild.NoDist, installed);
    const modules = path.join(request.copyDir, "node_modules");
    if (digest !== null && installed !== InstallVia.None) neighbours.set(digest, modules);
    return {
      copyDir: request.copyDir,
      servedDir: shape.outputDir,
      servedVia: ServedVia.Rebuilt,
      entryQuery: shape.entryQuery,
      noBuild: null,
      manifestDigest: digest,
      installed,
      steps,
    };
  }

  return {
    async prepare(request: CopyRequest): Promise<BuildCopyResult> {
      assertApart(request.snapshotDir, request.copyDir);
      const earlier = prepared.get(path.resolve(request.copyDir));
      const reusable =
        earlier?.snapshotDir === path.resolve(request.snapshotDir) && (await pathExists(request.copyDir));
      if (earlier && reusable) return earlier.result;
      const result = await prepareFresh(request);
      prepared.set(path.resolve(request.copyDir), { snapshotDir: path.resolve(request.snapshotDir), result });
      return result;
    },
  };

  /** Clone the snapshot and make its copy servable. */
  async function prepareFresh(request: CopyRequest): Promise<BuildCopyResult> {
    await cloneSnapshot(request.snapshotDir, request.copyDir);
    const shape = await readServeShape(request.copyDir);
    const digest = await manifestDigest(request.copyDir);
    if (!(await ownOutput(request.copyDir, shape))) return outsideCopy(request, shape, digest);
    const needsBuild = shape.buildScript && !(await hasPage(shape.outputDir));
    if (needsBuild) return await rebuild(request, shape, digest);
    const page = await hasPage(shape.outputDir);
    return {
      copyDir: request.copyDir,
      servedDir: page ? shape.outputDir : null,
      servedVia: ServedVia.AsIs,
      entryQuery: shape.entryQuery,
      noBuild: page ? null : NoBuild.NoEntry,
      manifestDigest: digest,
      installed: InstallVia.None,
      steps: [],
    };
  }
}
