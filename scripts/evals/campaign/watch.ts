/**
 * The snapshot watcher around one run (Rule 22, M1.4). A raw lane's project folder is known before it
 * starts (`<workRoot>/project`), so it is watched from the start. A Genex lane's project folder is
 * made by the app when the chat seeds its template, so the campaign polls the projects folder until a
 * seeded project appears and watches it from then on. The template's digest, which `template-untouched`
 * is judged against at stop, is not taken here: the app's lane takes it the moment the chat is bound
 * to the project (`EvalLaneReport.templateDigest`), before any edit a poll could miss. When the run
 * stops the watcher always takes the read-only final clone, the only thing "no build" and the canary
 * are read from.
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { SECOND_MS } from "../../../src/shared/duration.ts";
import { type CloneTree, createSnapshotWatcher, type Every, type SnapshotWatcher } from "../watch/snapshots.ts";

/** How often a Genex run's projects folder is polled for its seeded project. */
export const SEED_POLL_MS = SECOND_MS;
/** The snapshot folder inside a run's work root; both lane runners name it so. */
export const SNAPSHOTS_DIR = "snapshots";
/** The page a seeded template always has. */
const SEEDED_PAGE = "index.html";

/** Where the project is: a folder known up front (raw lanes), or one to find under a projects folder (Genex). */
export type ProjectLocation = { projectRoot: string } | { projectsRoot: string };

/** What a run's watch needs. */
export interface ProjectWatchOptions {
  location: ProjectLocation;
  snapshotDir: string;
  /** When the prompt was sent, on the `now` clock. */
  startedAtMs: number;
  now: () => number;
  every?: Every;
  clone?: CloneTree;
  intervalMs?: number;
  seedPollMs?: number;
}

/** What the watch saw when the run stopped. */
export interface ProjectWatchResult {
  /** The read-only final clone, or null when the run never made a project folder. */
  finalDir: string | null;
}

/** A running watch; `stop` takes the final clone (of `projectDir` when nothing was found before). */
export interface ProjectWatch {
  stop(projectDir: string | null): Promise<ProjectWatchResult>;
}

const isDir = (dir: string): Promise<boolean> =>
  stat(dir).then(
    (info) => info.isDirectory(),
    () => false,
  );

/** The first project folder under `projectsRoot` whose template has been seeded (it holds `index.html`). */
export async function seededProjectDir(projectsRoot: string): Promise<string | null> {
  const entries = await readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (const name of names.sort()) {
    const page = await stat(path.join(projectsRoot, name, SEEDED_PAGE)).catch(() => null);
    if (page?.isFile()) return path.join(projectsRoot, name);
  }
  return null;
}

/** The default poll timer: an unref'd interval, so a forgotten poll never holds the process open. */
const everyInterval: Every = (tick, ms) => {
  const timer = setInterval(tick, ms);
  timer.unref();
  return () => clearInterval(timer);
};

/** Start watching one run's project. */
export function watchProject(options: ProjectWatchOptions): ProjectWatch {
  const every = options.every ?? everyInterval;
  let watcher: SnapshotWatcher | null = null;
  let finding: Promise<void> | null = null;
  let cancelPoll: (() => void) | null = null;

  const begin = (projectRoot: string): void => {
    watcher = createSnapshotWatcher({
      projectRoot,
      snapshotDir: options.snapshotDir,
      startedAtMs: options.startedAtMs,
      now: options.now,
      ...(options.every ? { every: options.every } : {}),
      ...(options.clone ? { clone: options.clone } : {}),
      ...(options.intervalMs ? { intervalMs: options.intervalMs } : {}),
    });
    watcher.start();
  };

  const look = async (projectsRoot: string): Promise<void> => {
    const dir = await seededProjectDir(projectsRoot);
    if (!dir || watcher) return;
    begin(dir);
    cancelPoll?.();
    cancelPoll = null;
  };

  if ("projectRoot" in options.location) begin(options.location.projectRoot);
  else {
    const { projectsRoot } = options.location;
    cancelPoll = every(() => {
      finding ??= look(projectsRoot)
        .catch(() => {})
        .finally(() => {
          finding = null;
        });
    }, options.seedPollMs ?? SEED_POLL_MS);
  }

  return {
    async stop(projectDir) {
      cancelPoll?.();
      await finding;
      if (!watcher && projectDir && (await isDir(projectDir))) begin(projectDir);
      const active: SnapshotWatcher | null = watcher;
      if (!active) return { finalDir: null };
      const root = "projectRoot" in options.location ? options.location.projectRoot : null;
      if (root && !(await isDir(root))) {
        // The lane never made its folder: stop the timer; the final clone has nothing to take.
        await active.stop().catch(() => null);
        return { finalDir: null };
      }
      const final = await active.stop();
      return { finalDir: path.join(options.snapshotDir, final.name) };
    },
  };
}
