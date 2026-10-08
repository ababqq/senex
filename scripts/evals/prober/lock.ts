/**
 * ONE PROBE AT A TIME, PER MACHINE (Rule 11). Probes render through Chromium, and concurrent probes
 * contend for the CPU and GPU: the demo measured a software-rendered median of 30 fps fall to 10 with
 * four probes in parallel, with nothing about the projects changed. So parallelism is not a tuning knob.
 *
 * The lock is a file at an explicit path under `$GENEX_EVALS_HOME/locks/`, created exclusively and
 * holding the owner's pid. The holder touches it every `PROBE_LOCK_HEARTBEAT_MS` while it holds it,
 * so a grade that probes for hours keeps it fresh. It is broken when its holder is gone (a `kill -9`
 * skips the `finally` that removes it) or when its heartbeat stopped for `PROBE_LOCK_STALE_MS` (a
 * recycled pid, a wedged probe). Breaking is atomic: the lock is renamed aside, checked again, and
 * put back when it turned out to be another waiter's fresh one, so two waiters never delete each
 * other's new lock. It is re-entrant inside one process, so a boot scan that holds it can call the
 * boot probe, which takes it too. Hostile locations (a relative or missing home, a symlinked lock, a
 * locks folder that leads out of the home) are refused with no side effect. Time, sleeps, timers and
 * liveness are injectable.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MINUTE_MS, SECOND_MS } from "../../../src/shared/duration.ts";
import { configuredEvalsHome, EVALS_HOME_ENV } from "../home.ts";

/** The lock's folder inside the evals home, and its file name. */
export const PROBE_LOCK_DIR = "locks";
export const PROBE_LOCK_FILE = "probe.lock";
/** A lock untouched this long is broken even when its pid still answers (a recycled pid, a wedged probe). */
export const PROBE_LOCK_STALE_MS = 30 * MINUTE_MS;
/** How often the holder touches its lock; far inside the staleness window. */
export const PROBE_LOCK_HEARTBEAT_MS = MINUTE_MS;
/** Random bytes in the name a lock is renamed to while it is being broken. */
const BREAK_NAME_BYTES = 6;
/** How often a waiting probe looks again. */
export const PROBE_LOCK_POLL_MS = 3 * SECOND_MS;
/** How long a probe waits for the lock by default before giving up. */
export const PROBE_LOCK_WAIT_MS = 60 * MINUTE_MS;

/** Why the lock refused. */
export const ProbeLockErrorCode = {
  EvalsHomeMissing: "evals-home-missing",
  EvalsHomeNotAbsolute: "evals-home-not-absolute",
  EscapesEvalsHome: "lock-escapes-evals-home",
  NotRegularFile: "lock-not-a-regular-file",
  Timeout: "lock-timeout",
} as const;
export type ProbeLockErrorCode = (typeof ProbeLockErrorCode)[keyof typeof ProbeLockErrorCode];

/** A refusal from the probe lock, with its typed code. */
export class ProbeLockError extends Error {
  readonly code: ProbeLockErrorCode;
  constructor(code: ProbeLockErrorCode, message: string) {
    super(message);
    this.name = "ProbeLockError";
    this.code = code;
  }
}

/** What the lock reads from the outside world; every field has a real default. */
export interface ProbeLockDeps {
  pid?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Whether a process still runs; `EPERM` means it runs as someone else. */
  isAlive?: (pid: number) => boolean;
  /** How long to wait for a live holder before a typed timeout. */
  waitMs?: number;
  /** Run `tick` every `ms` until the returned stop is called (the heartbeat's timer). */
  every?: (ms: number, tick: () => void) => () => void;
}

type ResolvedDeps = Required<ProbeLockDeps>;

/**
 * The locks held by the current async call chain, for re-entrancy: a probe nested inside the work of
 * a lock holder runs at once, while an unrelated concurrent probe in the same process still waits.
 */
const held = new AsyncLocalStorage<ReadonlySet<string>>();

/** Whether a process still runs; signal 0 tests for existence without touching it. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The probe lock's path for this environment. A machine-wide lock needs the home named explicitly
 * (the campaign sets it, or passes its own lock path), so an unset home is refused rather than
 * defaulted; a relative one is refused too. Both are typed errors.
 */
export function probeLockPath(env: Record<string, string | undefined> = process.env): string {
  let home: string | null;
  try {
    home = configuredEvalsHome(env);
  } catch {
    throw new ProbeLockError(ProbeLockErrorCode.EvalsHomeNotAbsolute, `${EVALS_HOME_ENV} must be an absolute path`);
  }
  if (!home) throw new ProbeLockError(ProbeLockErrorCode.EvalsHomeMissing, `${EVALS_HOME_ENV} is not set`);
  return path.join(home, PROBE_LOCK_DIR, PROBE_LOCK_FILE);
}

/** A real repeating timer that never keeps the process alive by itself. */
function systemEvery(ms: number, tick: () => void): () => void {
  const timer = setInterval(tick, ms);
  timer.unref();
  return () => clearInterval(timer);
}

function resolveDeps(deps: ProbeLockDeps): ResolvedDeps {
  return {
    pid: deps.pid ?? process.pid,
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? ((ms) => delay(ms)),
    isAlive: deps.isAlive ?? processAlive,
    waitMs: deps.waitMs ?? PROBE_LOCK_WAIT_MS,
    every: deps.every ?? systemEvery,
  };
}

/**
 * Create the locks folder inside a home that must already exist, and prove by realpath that the folder
 * stays inside it: a `locks` symlink out of the home is refused before anything is written.
 */
function prepareLockDir(lockPath: string): void {
  const dir = path.dirname(lockPath);
  const home = path.dirname(dir);
  let realHome: string;
  try {
    realHome = fs.realpathSync(home);
  } catch {
    throw new ProbeLockError(ProbeLockErrorCode.EvalsHomeMissing, "the evals home does not exist");
  }
  const existing = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (existing && !existing.isDirectory()) {
    throw new ProbeLockError(
      ProbeLockErrorCode.EscapesEvalsHome,
      "the locks folder is not a folder inside the evals home",
    );
  }
  if (!existing) fs.mkdirSync(dir);
  const relative = path.relative(realHome, fs.realpathSync(dir));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ProbeLockError(ProbeLockErrorCode.EscapesEvalsHome, "the locks folder resolves outside the evals home");
  }
}

/** Try to create the lock exclusively; false when someone else holds it. */
function tryCreate(lockPath: string, pid: number): boolean {
  try {
    const fd = fs.openSync(lockPath, "wx");
    try {
      fs.writeSync(fd, String(pid));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** Whether the lock file at `file` may be broken: its holder is gone, or it is stale. Refuses a non-file. */
function holderGone(file: string, deps: ResolvedDeps): boolean {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isFile()) {
    throw new ProbeLockError(ProbeLockErrorCode.NotRegularFile, "the probe lock is not a regular file");
  }
  const holder = Number(fs.readFileSync(file, "utf8").trim());
  const readable = Number.isInteger(holder) && holder > 0;
  const stale = deps.now() - stat.mtimeMs > PROBE_LOCK_STALE_MS;
  return !readable || !deps.isAlive(holder) || stale;
}

/** Move `from` to `to`; false when `from` is already gone. */
function moved(from: string, to: string): boolean {
  try {
    fs.renameSync(from, to);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Break a lock seen as gone, atomically: rename it aside and judge the renamed file again. Another
 * waiter may have broken the old lock and created its own in between; that fresh lock is put back
 * (unless a third probe already took the path) instead of deleted.
 */
function breakLock(lockPath: string, deps: ResolvedDeps): void {
  const aside = `${lockPath}.broken-${deps.pid}-${randomBytes(BREAK_NAME_BYTES).toString("hex")}`;
  if (!moved(lockPath, aside)) return;
  try {
    if (holderGone(aside, deps)) return;
    fs.linkSync(aside, lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    fs.rmSync(aside, { force: true });
  }
}

async function acquire(lockPath: string, deps: ResolvedDeps): Promise<void> {
  prepareLockDir(lockPath);
  const deadline = deps.now() + deps.waitMs;
  for (;;) {
    if (tryCreate(lockPath, deps.pid)) return;
    if (holderGone(lockPath, deps)) {
      breakLock(lockPath, deps);
      continue;
    }
    if (deps.now() >= deadline) {
      throw new ProbeLockError(ProbeLockErrorCode.Timeout, "another probe held the lock for the whole wait");
    }
    await deps.sleep(PROBE_LOCK_POLL_MS);
  }
}

/** Whether the lock at `lockPath` is a regular file holding `pid`. */
function ownedBy(lockPath: string, pid: number): boolean {
  const stat = fs.lstatSync(lockPath, { throwIfNoEntry: false });
  return stat?.isFile() === true && fs.readFileSync(lockPath, "utf8").trim() === String(pid);
}

/** Touch our own lock so a waiter sees it fresh; a lock that is gone or not ours is left alone. */
function heartbeat(lockPath: string, deps: ResolvedDeps): void {
  try {
    if (!ownedBy(lockPath, deps.pid)) return;
    const seconds = deps.now() / SECOND_MS;
    fs.utimesSync(lockPath, seconds, seconds);
  } catch {
    // The lock vanished between the read and the touch; the release finds it gone too.
  }
}

/** Remove the lock only if it is still ours: a lock broken as stale may now belong to another probe. */
function release(lockPath: string, pid: number): void {
  if (ownedBy(lockPath, pid)) fs.rmSync(lockPath, { force: true });
}

/** Run `fn` while holding the machine-wide probe lock at `lockPath`. */
export async function withProbeLock<T>(lockPath: string, fn: () => Promise<T>, deps: ProbeLockDeps = {}): Promise<T> {
  const outer = held.getStore() ?? new Set<string>();
  if (outer.has(lockPath)) return fn();
  const resolved = resolveDeps(deps);
  await acquire(lockPath, resolved);
  const stopHeartbeat = resolved.every(PROBE_LOCK_HEARTBEAT_MS, () => heartbeat(lockPath, resolved));
  try {
    return await held.run(new Set([...outer, lockPath]), fn);
  } finally {
    stopHeartbeat();
    release(lockPath, resolved.pid);
  }
}
