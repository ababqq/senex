/**
 * The snapshot watcher (§8.3, Rule 22, M1.4): what the project folder looked like while the run
 * went on, and exactly what it held when the run stopped.
 *
 * Every 30 s the watcher stats the project folder (never `node_modules` or `.git`, at any depth)
 * and, when anything changed, clones it (`fs.cp` with `COPYFILE_FICLONE`, an APFS `clonefile`,
 * so a clone costs no space) into `<snapshotDir>/<seq>-<atMs>/`. A clone whose content digest
 * equals the previous one (a file touched, not changed) is dropped. At stop it takes a final
 * clone whatever changed and makes it read-only: that clone, never the live folder later, is
 * what "no build" is typed from and what the final probe grades. Each clone appends one line to
 * `index.jsonl` with its offset from the prompt, wall time and digest. Symlinks are copied as
 * links, so a clone never holds a file from outside the project.
 *
 * The clock, the timer and the clone are injectable.
 */
import { constants } from "node:fs";
import { appendFile, chmod, cp, lstat, mkdir, readdir, readFile, readlink, rm } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { SECOND_MS } from "../../../src/shared/duration.ts";
import { pathExists } from "../../../src/substrate/fsx.ts";
import { readPackageManifest } from "../../../src/substrate/project-shape.ts";
import {
  digestTreeEntry,
  WORKSPACE_EXCLUDED as EXCLUDED,
  walkTree,
  workspaceDigest,
} from "../../../src/substrate/workspace-digest.ts";
import type { SnapshotFacts } from "../collect/observation.ts";
import type { PreparedCopy } from "../grade/build-copy.ts";
import { readServeShape } from "../grade/build-copy.ts";
import { NoBuild, ServedVia, SnapshotKind } from "../vocabulary.ts";

/** How often the watcher looks for a change. */
export const SNAPSHOT_INTERVAL_MS = 30 * SECOND_MS;
/** The index file inside the snapshot folder, one JSON line per clone. */
export const SNAPSHOT_INDEX_FILE = "index.jsonl";
/** The final clone's folder name inside the snapshot folder. */
export const FINAL_SNAPSHOT_NAME = "final";
// The workspace digest and its walker are the app's too (the eval lane digests the seeded project).
export { STUDIO_METADATA, workspaceDigest } from "../../../src/substrate/workspace-digest.ts";
/** Source files whose lines count as `loc`. */
const LOC_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".html",
  ".css",
  ".glsl",
  ".wgsl",
  ".vue",
  ".svelte",
]);
/** Digits in a clone's sequence number, so folder names sort in time order. */
const SEQ_DIGITS = 4;
/** Read-only modes for the final clone. */
const READ_ONLY_FILE = 0o444;
const READ_ONLY_DIR = 0o555;
/** The page a served folder opens. */
const INDEX_FILE = "index.html";

/** One clone, as the index records it. */
export interface SnapshotIndexEntry {
  seq: number;
  kind: SnapshotKind;
  /** The clone's folder name inside the snapshot folder. */
  name: string;
  /** Milliseconds from the prompt. */
  atMs: number;
  recordedAt: string;
  /** sha256 over the clone's paths and contents. */
  sha256: string;
  files: number;
  bytes: number;
}

/** Clone a folder tree; the default is `fs.cp` with `COPYFILE_FICLONE`, excluding node_modules and .git. */
export type CloneTree = (from: string, to: string) => Promise<void>;
/** Call `tick` every `ms`; returns the cancel. The default is an unref'd `setInterval`. */
export type Every = (tick: () => void, ms: number) => () => void;

/** What a watcher needs. */
export interface SnapshotWatcherOptions {
  projectRoot: string;
  snapshotDir: string;
  /** When the prompt was sent, on the `now` clock. */
  startedAtMs: number;
  /** Epoch milliseconds. */
  now: () => number;
  intervalMs?: number;
  clone?: CloneTree;
  every?: Every;
}

/** A running watcher over one project folder. */
export interface SnapshotWatcher {
  /** Start ticking on the timer. */
  start(): void;
  /** Look once: the new clone's entry, or null when nothing changed (or after stop). */
  tick(): Promise<SnapshotIndexEntry | null>;
  /** Stop ticking and take the read-only final clone. */
  stop(): Promise<SnapshotIndexEntry>;
  /** Every clone so far, in order. */
  entries(): SnapshotIndexEntry[];
}

/** Digest totals over one tree. */
interface TreeTotals {
  sha256: string;
  files: number;
  bytes: number;
  loc: number;
}

/** Lines in a text: newlines, plus a last line without one. */
function countLines(text: string): number {
  if (!text) return 0;
  const newlines = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

/** sha256, file count, bytes and lines of code over a tree (links hashed by target, never followed). */
async function treeTotals(dir: string, exclude: ReadonlySet<string>): Promise<TreeTotals> {
  const hash = createHash("sha256");
  const totals = { files: 0, bytes: 0, loc: 0 };
  await walkTree(dir, exclude, async (rel, abs) => {
    const bytes = await digestTreeEntry(hash, rel, abs);
    if (bytes === null) return;
    totals.files += 1;
    totals.bytes += bytes.length;
    if (LOC_EXTENSIONS.has(path.extname(rel).toLowerCase())) totals.loc += countLines(bytes.toString("utf8"));
  });
  return { sha256: hash.digest("hex"), ...totals };
}

/** A cheap change key: every path's size, mtime and link target. */
async function statKey(dir: string): Promise<string> {
  const hash = createHash("sha256");
  await walkTree(dir, EXCLUDED, async (rel, abs) => {
    const info = await lstat(abs).catch(() => null);
    if (!info) return;
    const target = info.isSymbolicLink() ? await readlink(abs).catch(() => "") : "";
    hash.update(`${rel}\0${info.size}\0${info.mtimeMs}\0${target}\n`);
  });
  return hash.digest("hex");
}

/** The default clone: APFS clonefile where it can, a copy elsewhere; links stay links. */
const cloneTree: CloneTree = (from, to) =>
  cp(from, to, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
    verbatimSymlinks: true,
    filter: (source) => !EXCLUDED.has(path.basename(source)),
  });

/** The default timer: an unref'd interval, so a forgotten watcher never holds the process open. */
const everyInterval: Every = (tick, ms) => {
  const timer = setInterval(tick, ms);
  timer.unref();
  return () => clearInterval(timer);
};

/** Make a finished clone read-only, leaves first (links are left alone). */
async function makeReadOnly(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) await makeReadOnly(child);
    else if (entry.isFile()) await chmod(child, READ_ONLY_FILE);
  }
  await chmod(dir, READ_ONLY_DIR);
}

/** Watch one project folder: change-driven clones every 30 s and a read-only final clone at stop. */
export function createSnapshotWatcher(options: SnapshotWatcherOptions): SnapshotWatcher {
  const clone = options.clone ?? cloneTree;
  const every = options.every ?? everyInterval;
  const indexPath = path.join(options.snapshotDir, SNAPSHOT_INDEX_FILE);
  const taken: SnapshotIndexEntry[] = [];
  let lastKey: string | null = null;
  let inFlight: Promise<SnapshotIndexEntry | null> | null = null;
  let cancel: (() => void) | null = null;
  let stopped = false;

  /**
   * Clone into `name`, digest the clone and index it. A periodic clone identical to the last one
   * is dropped (null); a clone that failed is removed and rethrown.
   */
  async function capture(name: string, kind: SnapshotKind, at: number): Promise<SnapshotIndexEntry | null> {
    const dir = path.join(options.snapshotDir, name);
    await mkdir(options.snapshotDir, { recursive: true });
    try {
      await clone(options.projectRoot, dir);
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    const totals = await treeTotals(dir, EXCLUDED);
    if (kind === SnapshotKind.Periodic && taken.at(-1)?.sha256 === totals.sha256) {
      await rm(dir, { recursive: true, force: true });
      return null;
    }
    const entry: SnapshotIndexEntry = {
      seq: taken.length,
      kind,
      name,
      atMs: at - options.startedAtMs,
      recordedAt: new Date(at).toISOString(),
      sha256: totals.sha256,
      files: totals.files,
      bytes: totals.bytes,
    };
    taken.push(entry);
    await appendFile(indexPath, `${JSON.stringify(entry)}\n`);
    return entry;
  }

  /** One look: clone when the stat key moved; a failed clone keeps the old key, so the next tick retries. */
  async function look(): Promise<SnapshotIndexEntry | null> {
    const at = options.now();
    const key = await statKey(options.projectRoot);
    if (key === lastKey) return null;
    const name = `${String(taken.length).padStart(SEQ_DIGITS, "0")}-${at - options.startedAtMs}`;
    const entry = await capture(name, SnapshotKind.Periodic, at).catch(() => undefined);
    if (entry === undefined) return null;
    lastKey = key;
    return entry;
  }

  function tick(): Promise<SnapshotIndexEntry | null> {
    if (stopped) return Promise.resolve(null);
    if (inFlight) return inFlight;
    inFlight = look().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    start() {
      if (cancel || stopped) return;
      cancel = every(() => {
        tick().catch(() => {});
      }, options.intervalMs ?? SNAPSHOT_INTERVAL_MS);
    },
    tick,
    async stop() {
      stopped = true;
      cancel?.();
      cancel = null;
      const at = options.now();
      await inFlight?.catch(() => null);
      const entry = await capture(FINAL_SNAPSHOT_NAME, SnapshotKind.Final, at);
      if (entry === null) throw new Error("a final clone is never dropped");
      await makeReadOnly(path.join(options.snapshotDir, FINAL_SNAPSHOT_NAME));
      return entry;
    },
    entries: () => [...taken],
  };
}

/** Whether a parsed index line has the shape the watcher writes. */
function isIndexEntry(value: unknown): value is SnapshotIndexEntry {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  const kinds: readonly unknown[] = Object.values(SnapshotKind);
  const named = typeof row.name === "string" && !row.name.includes("/") && !row.name.startsWith(".");
  return named && kinds.includes(row.kind) && typeof row.atMs === "number" && typeof row.sha256 === "string";
}

/** The index a watcher wrote, in order; lines that do not parse or are not entries are skipped. */
export async function readSnapshotIndex(snapshotDir: string): Promise<SnapshotIndexEntry[]> {
  const text = await readFile(path.join(snapshotDir, SNAPSHOT_INDEX_FILE), "utf8").catch(() => "");
  const entries: SnapshotIndexEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isIndexEntry(parsed)) entries.push(parsed);
    } catch {
      // A torn last line (a crash mid-append) is not a snapshot.
    }
  }
  return entries;
}

/**
 * The boot scan's input (`BootScanOptions.snapshots`): the periodic clones, then the final one.
 * A last periodic clone identical to the final clone is the same state and is left out.
 */
export function scanSnapshots(
  snapshotDir: string,
  entries: readonly SnapshotIndexEntry[],
): Array<{ dir: string; atMs: number }> {
  const final = entries.find((entry) => entry.kind === SnapshotKind.Final);
  const periodic = entries.filter((entry) => entry.kind === SnapshotKind.Periodic);
  if (final && periodic.at(-1)?.sha256 === final.sha256) periodic.pop();
  const ordered = final ? [...periodic, final] : periodic;
  return ordered.map((entry) => ({ dir: path.join(snapshotDir, entry.name), atMs: entry.atMs }));
}

/** What the stop-time snapshot says before anything is rebuilt. */
export interface StopFacts {
  templateUntouched: boolean;
  /** A page to open: `index.html` at the root or in the build's output folder. */
  hasEntry: boolean;
  buildScript: boolean;
  /** The build's output folder holds a page. */
  hasOutput: boolean;
}

/**
 * Why there is no build to grade (Rule 22), from the stop-time snapshot and, for a project with a
 * build script and no output, the rebuild of its copy. `no-dist` stands until a rebuild of that
 * very snapshot produces a page.
 */
export function noBuildAtStop(
  stop: StopFacts,
  build: Pick<PreparedCopy, "servedVia" | "noBuild"> | null,
): NoBuild | null {
  if (stop.templateUntouched) return NoBuild.TemplateUntouched;
  if (!stop.hasEntry && !stop.buildScript) return NoBuild.NoEntry;
  if (!stop.buildScript || stop.hasOutput) return null;
  if (build === null) return NoBuild.NoDist;
  if (build.servedVia === ServedVia.Rebuilt) return null;
  return build.noBuild ?? NoBuild.BuildFailed;
}

/** The stop-time facts of one snapshot folder (`RunObservation.snapshot`), before any rebuild. */
export async function snapshotFacts(dir: string, p: { templateDigest: string | null }): Promise<SnapshotFacts> {
  const totals = await treeTotals(dir, EXCLUDED);
  const pkg = await readPackageManifest(dir);
  const buildScript = typeof pkg?.scripts?.build === "string" && pkg.scripts.build.trim().length > 0;
  const shape = await readServeShape(dir);
  const hasOutput = await pathExists(path.join(shape.outputDir, INDEX_FILE));
  const hasEntry = hasOutput || (await pathExists(path.join(dir, INDEX_FILE)));
  const templateUntouched = p.templateDigest !== null && (await workspaceDigest(dir)) === p.templateDigest;
  return {
    dir,
    files: totals.files,
    bytes: totals.bytes,
    loc: totals.loc,
    hasEntry,
    buildScript,
    noBuild: noBuildAtStop({ templateUntouched, hasEntry, buildScript, hasOutput }, null),
    sha256: totals.sha256,
  };
}
