/**
 * Host git: the one place a git command on a project folder is built. A folder is somebody else's
 * data, and its `.git/config` and `.gitattributes` can name programs (filters, merge and diff
 * drivers, a signature checker, an editor, a transport). Every command here runs with
 *
 * - an environment stripped of ambient `GIT_*` routing, with no transport allowed and no editor;
 * - fixed-name settings that name a program pinned off (`PINNED_CONFIG`);
 * - every command-valued key the folder's own config sets (a driver name is the folder's choice)
 *   overridden to nothing, found by listing the config — and a folder whose config uses a name
 *   `-c` cannot carry, or whose `core.worktree` leaves the folder, refused with a typed error;
 * - diff-family commands told to use no external diff or text conversion, and `git add` told to
 *   leave environment files out.
 *
 * The guarantee is for the subcommands the host actually runs. A repository nested inside the
 * folder keeps its own `.git/config`, which this does not scan.
 */
import { type ChildProcess, type ChildProcessByStdio, execFile, spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { SECOND_MS } from "../shared/duration.ts";
import { isInside } from "./paths.ts";
import { startWithRecovery } from "./process-start.ts";

const exec = promisify(execFile);
/** The listing of a folder's whole config; past it the folder is not scanned (and not used). A config with ten thousand branches is 1.5 MB. */
const CONFIG_MAX_BYTES = 64 * 1024 ** 2;
/** How long reading the config, or asking where the work tree is, may take. */
const SCAN_TIMEOUT_MS = 20 * SECOND_MS;
/** The most output a host command may print when its caller names no limit. */
const DEFAULT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const WORK_TREE_MAX_BUFFER_BYTES = 64 * 1024;
/** How much of a `.git` file is read: a pointer is one short line. */
const GIT_FILE_MAX_CHARS = 4096;

/** The keys that make git run a program chosen by a name the folder invents: filter, diff and merge drivers. */
const DRIVER_KEY =
  /^(?:filter\..*\.(?:clean|smudge|process|required)|diff\..*\.(?:textconv|command)|merge\..*\.driver)$/is;
const MERGE_DRIVER_KEY = /^merge\..*\.driver$/is;
/** The commands a merge driver may be, and still be left as the folder set it: they start nothing. */
const INERT_MERGE_COMMANDS: ReadonlySet<string> = new Set(["true", "false"]);
const PRIVATE_ENV_PATHS = [":(glob,exclude)**/.env", ":(glob,exclude)**/.env.*"];
const DIFF_FAMILY = new Set(["diff", "diff-tree", "diff-index", "show", "log"]);
/** Options git takes before its subcommand that read the next argument as their value. */
const GLOBAL_OPTIONS_WITH_VALUE = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix"]);
const REPLACEMENT_CHARACTER = "�";

/**
 * A commit's auto-maintenance runs inside the call, never in a detached process: one kept writing
 * into the harness `.git` after `StudioCore.stop()` resolved, and removing the folder failed with
 * ENOTEMPTY. (`gc.autoDetach` is the same switch for a Git older than 2.47.)
 */
const ATTACHED_MAINTENANCE = { "maintenance.autoDetach": "false", "gc.autoDetach": "false" } as const;

/** Fixed-name settings that name a program, pinned off or to a no-op: `-c` beats every config file. */
const PINNED_CONFIG = {
  "core.fsmonitor": "",
  "core.hooksPath": "/dev/null",
  "core.pager": "cat",
  "commit.gpgsign": "false",
  "tag.gpgsign": "false",
  "core.alternateRefsCommand": "",
  "gpg.program": "",
  "gpg.openpgp.program": "",
  "gpg.x509.program": "",
  "gpg.ssh.program": "",
  // A helper or an askpass program runs when git needs a credential, whatever transport is allowed.
  "credential.helper": "",
  "core.askPass": "",
  ...ATTACHED_MAINTENANCE,
} as const;

/** Highest-precedence settings shared by host Git callers and sandboxed Git tools. */
export const HOST_GIT_CONFIG = Object.entries(PINNED_CONFIG).flatMap(([key, value]) => ["-c", `${key}=${value}`]);

/** Why host git declined to run in a folder. */
export const HostGitRefusal = {
  /** The folder's config names a program with a name `-c` cannot carry (an `=`, a newline, bytes that are not UTF-8). */
  UnsafeConfigKey: "unsafe-config-key",
  /** The folder's `core.worktree` sends git's work tree somewhere else. */
  ForeignWorkTree: "foreign-work-tree",
  /** The folder's `.git` file names the git directory of another work tree, so its commits would land there. */
  ForeignGitDir: "foreign-git-dir",
} as const;
export type HostGitRefusal = (typeof HostGitRefusal)[keyof typeof HostGitRefusal];

const MESSAGE = {
  UnsafeConfigKey: (key: string) =>
    `This folder's git settings name a program in a way Senex cannot switch off (${JSON.stringify(key).slice(0, 80)}). Remove or rename that entry in .git/config, then try again.`,
  ForeignWorkTree: (top: string) =>
    `This folder's .git/config sets core.worktree to a place other than this folder (${top}). Remove that setting from .git/config, then try again.`,
  ForeignGitDir: (target: string) =>
    `This folder's .git file points at the git directory of another folder (${target}), so Senex's saves would be written there. Remove or replace the .git file, then try again.`,
} as const;

/** A host git command was declined, with a typed `code`, so that nothing runs in or around the folder. */
export class HostGitRefusedError extends Error {
  readonly code: HostGitRefusal;
  constructor(code: HostGitRefusal, message: string) {
    super(message);
    this.name = "HostGitRefusedError";
    this.code = code;
  }
}

/**
 * For `.catch(...)` on a host git call whose failure is an answer ("no such commit", "not a
 * repository"): the failure becomes `fallback`, but a refusal to run in the folder is still thrown,
 * so it is not read as that answer.
 */
export function unlessRefused<T>(fallback: T): (error: unknown) => T {
  return (error) => {
    if (error instanceof HostGitRefusedError) throw error;
    return fallback;
  };
}

/** Index of the subcommand: the first argument after git's own leading options (`-c k=v`, `-C dir`, `--no-pager`). */
function subcommandIndex(args: readonly string[]): number {
  let index = 0;
  while (index < args.length) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("-")) return index;
    index += GLOBAL_OPTIONS_WITH_VALUE.has(arg) ? 2 : 1;
  }
  return -1;
}

/**
 * An `add` that leaves environment files out. The excludes go right after `--`, before the paths:
 * git 2.43 stages nothing for an explicit untracked file when an exclude follows it.
 */
function addArgs(rest: readonly string[]): string[] {
  // Checkpoints already filter their stdin path list. Git forbids mixing that list with argv paths.
  if (rest.some((arg) => arg.startsWith("--pathspec-from-file="))) return [...rest];
  const { optionsEnd, pathsStart } = pathsBoundary(rest);
  return [...rest.slice(0, optionsEnd), "--", ...PRIVATE_ENV_PATHS, ...rest.slice(pathsStart)];
}

/** Where an `add`'s options end and its paths begin, with or without a `--` between them. */
function pathsBoundary(rest: readonly string[]): { optionsEnd: number; pathsStart: number } {
  const separator = rest.indexOf("--");
  if (separator >= 0) return { optionsEnd: separator, pathsStart: separator + 1 };
  const firstPath = rest.findIndex((arg) => !arg.startsWith("-"));
  const start = firstPath >= 0 ? firstPath : rest.length;
  return { optionsEnd: start, pathsStart: start };
}

/** Git diff-family commands never invoke an external diff or text-conversion driver; `add` leaves `.env` files out. */
export function hostGitArgs(args: readonly string[]): string[] {
  const at = subcommandIndex(args);
  const command = args[at];
  if (command === undefined) return [...args];
  const globals = args.slice(0, at);
  const rest = args.slice(at + 1);
  if (command === "add") return [...globals, command, ...addArgs(rest)];
  if (DIFF_FAMILY.has(command)) return [...globals, command, "--no-ext-diff", "--no-textconv", ...rest];
  return [...args];
}

/** Remove ambient Git routing and executable configuration; callers supply only owned overrides. */
export function hostGitEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    // No transport can start ssh, `ext::`, a proxy or a credential helper, and a promisor remote's
    // lazy fetch cannot run an `ext::` program. (GIT_NO_LAZY_FETCH is the same for git 2.44 and later.)
    GIT_ALLOW_PROTOCOL: "none",
    GIT_NO_LAZY_FETCH: "1",
    // A commit with no message would open `core.editor`; this one accepts the empty text and git declines.
    GIT_EDITOR: ":",
    ...overrides,
  };
}

/**
 * One override per command-valued key in a NUL-separated key listing, so the folder's drivers do
 * nothing (a `required` filter is made optional instead, or its absence would fail the command).
 * Throws on a key `-c` cannot carry: git splits `-c` at the first `=`, and a name with bytes that
 * are not UTF-8 reaches us as U+FFFD, so no argument can name it. A key in `trusted` is left alone.
 */
export function driverOverrides(listing: string, trusted: ReadonlySet<string> = new Set()): string[] {
  const overrides: string[] = [];
  for (const key of new Set(listing.split("\0").filter(Boolean))) {
    if (!DRIVER_KEY.test(key) || trusted.has(key)) continue;
    if (key.includes("=") || key.includes("\n") || key.includes(REPLACEMENT_CHARACTER))
      throw new HostGitRefusedError(HostGitRefusal.UnsafeConfigKey, MESSAGE.UnsafeConfigKey(key));
    overrides.push("-c", `${key}=${/\.required$/i.test(key) ? "false" : ""}`);
  }
  return overrides;
}

/** Every key the folder's config sets, including what its `include.path` files add, NUL-separated. */
async function configListing(dir: string, env: NodeJS.ProcessEnv): Promise<string> {
  const running = exec("git", [...HOST_GIT_CONFIG, "-C", dir, "config", "--list", "--null", "--name-only"], {
    env,
    maxBuffer: CONFIG_MAX_BYTES,
    timeout: SCAN_TIMEOUT_MS,
    windowsHide: true,
  });
  // An `include.path` of /dev/stdin waits for input that never comes, on the git that macOS ships.
  running.child.stdin?.end();
  return (await running).stdout;
}

/** Where git says the folder's work tree is, or null when it cannot say (not a repository, a bare one). */
async function workTreeOf(dir: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const running = exec("git", [...HOST_GIT_CONFIG, "-C", dir, "rev-parse", "--show-toplevel"], {
      env,
      maxBuffer: WORK_TREE_MAX_BUFFER_BYTES,
      timeout: SCAN_TIMEOUT_MS,
      windowsHide: true,
    });
    running.child.stdin?.end();
    return (await running).stdout.replace(/\r?\n$/, "") || null;
  } catch {
    return null;
  }
}

/** The same folder, by identity rather than spelling (links, case, normalization form). */
async function sameFolder(a: string, b: string): Promise<boolean> {
  try {
    const [first, second] = await Promise.all([stat(a, { bigint: true }), stat(b, { bigint: true })]);
    return first.ino !== 0n && first.ino === second.ino && first.dev === second.dev;
  } catch {
    return false;
  }
}

/** Whether `inner` is `outer` or lies under it, by real path. */
async function lies(inner: string, outer: string): Promise<boolean> {
  try {
    const [deep, shallow] = await Promise.all([realpath(inner), realpath(outer)]);
    return isInside(shallow, deep);
  } catch {
    return false;
  }
}

/**
 * A `core.worktree` can send `add -A` and `reset --hard` into files outside the folder. The work
 * tree git reports must be the folder: a linked worktree, `--separate-git-dir` and a `.git` file
 * all answer with the folder itself. A folder with no `.git` of its own inside a larger repository
 * reads that repository, so its work tree may also be a folder that contains this one.
 */
async function refuseForeignWorkTree(dir: string, env: NodeJS.ProcessEnv, keys: ReadonlySet<string>): Promise<void> {
  if (!keys.has("core.worktree")) return;
  const top = await workTreeOf(dir, env);
  if (top === null || (await sameFolder(top, dir))) return;
  const holdsGit = await stat(path.join(dir, ".git")).then(
    () => true,
    () => false,
  );
  if (!holdsGit && (await lies(dir, top))) return;
  throw new HostGitRefusedError(HostGitRefusal.ForeignWorkTree, MESSAGE.ForeignWorkTree(top));
}

/**
 * A `.git` file is a pointer, and one planted in a downloaded folder can point at the git directory
 * of the person's other project, where the studio's saves and restores would then land. A pointer
 * to a linked worktree's or a submodule's directory, or to a separate git directory, is the folder's
 * own; one that names the `.git` directory of another work tree is not.
 */
async function refuseForeignGitFile(dir: string): Promise<void> {
  let text: string;
  try {
    const file = path.join(dir, ".git");
    if (!(await stat(file)).isFile()) return;
    text = (await readFile(file, "utf8")).slice(0, GIT_FILE_MAX_CHARS);
  } catch {
    return;
  }
  const pointer = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(text)?.[1];
  if (pointer === undefined) return;
  const target = path.resolve(dir, pointer);
  if (path.basename(target) !== ".git") return;
  const parent = path.dirname(target);
  if (await sameFolder(parent, dir)) return;
  throw new HostGitRefusedError(HostGitRefusal.ForeignGitDir, MESSAGE.ForeignGitDir(target));
}

/** Auto-maintenance can run a program a folder's `gc.recentObjectsHook` names, and the key cannot be reset: it is turned off for such a folder. */
function maintenancePins(keys: ReadonlySet<string>): string[] {
  return keys.has("gc.recentobjectshook") ? ["-c", "gc.auto=0", "-c", "maintenance.auto=false"] : [];
}

/**
 * The merge drivers whose whole command is `true` or `false`: the keep-mine idiom (`merge.ours.driver
 * = true`). They run no program of the folder's choosing, so a landing that relies on one still works.
 */
async function trustedMergeDrivers(
  dir: string,
  env: NodeJS.ProcessEnv,
  keys: ReadonlySet<string>,
): Promise<Set<string>> {
  const trusted = new Set<string>();
  for (const key of keys) {
    if (!MERGE_DRIVER_KEY.test(key) || key.includes("=") || key.includes(REPLACEMENT_CHARACTER)) continue;
    try {
      const { stdout } = await exec("git", [...HOST_GIT_CONFIG, "-C", dir, "config", "--null", "--get-all", key], {
        env,
        maxBuffer: CONFIG_MAX_BYTES,
        timeout: SCAN_TIMEOUT_MS,
        windowsHide: true,
      });
      const values = stdout.split("\0").filter((value) => value !== "");
      if (values.length > 0 && values.every((value) => INERT_MERGE_COMMANDS.has(value))) trusted.add(key);
    } catch {
      /* unreadable: not trusted, so neutralized */
    }
  }
  return trusted;
}

/** The `-c` arguments that make git in `dir` run nothing the folder's config names, or a typed refusal. */
export async function hostGitConfig(dir: string, env: NodeJS.ProcessEnv = hostGitEnv()): Promise<string[]> {
  const listing = await configListing(dir, env);
  const keys = new Set(listing.split("\0").filter(Boolean));
  await refuseForeignWorkTree(dir, env, keys);
  await refuseForeignGitFile(dir);
  return [
    ...HOST_GIT_CONFIG,
    ...maintenancePins(keys),
    ...driverOverrides(listing, await trustedMergeDrivers(dir, env, keys)),
  ];
}

/** What one scan of a folder yields: run any number of commands from it without scanning again. */
export interface HostGitContext {
  readonly dir: string;
  readonly env: NodeJS.ProcessEnv;
  /** `-c` arguments, first on the command line. */
  readonly config: readonly string[];
}

/** Scan a folder once. `overrides` are the caller's own environment (a committer, a private index). */
export async function hostGitContext(dir: string, overrides: NodeJS.ProcessEnv = {}): Promise<HostGitContext> {
  const env = hostGitEnv(overrides);
  return { dir, env, config: await hostGitConfig(dir, env) };
}

/** The arguments and environment of a command in a scanned folder, for a caller that spawns it. */
export function hostGitCommand(
  context: HostGitContext,
  args: readonly string[],
): { args: string[]; env: NodeJS.ProcessEnv } {
  return { args: [...context.config, "-C", context.dir, ...hostGitArgs(args)], env: context.env };
}

/** A host command whose output is read as a stream, for output too large to hold. */
export function hostGitSpawn(
  context: HostGitContext,
  args: readonly string[],
): ChildProcessByStdio<null, Readable, Readable> {
  const command = hostGitCommand(context, args);
  return spawn("git", command.args, { env: command.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

export interface HostGitOptions {
  /** The caller's own environment on top of the pins (a committer, a private index, a PATH for filters). */
  env?: NodeJS.ProcessEnv;
  /** A scan already made of this folder; its environment is then used and `env` is not. */
  context?: HostGitContext;
  maxBuffer?: number;
  timeout?: number;
  /** Written to the command's standard input, which is closed after it. */
  input?: string;
}

/** Run a host git command in `dir`: text out, unless the caller asks for the bytes. */
export function hostGit(
  dir: string,
  args: readonly string[],
  options?: HostGitOptions & { encoding?: "utf8" },
): Promise<{ stdout: string; stderr: string }>;
export function hostGit(
  dir: string,
  args: readonly string[],
  options: HostGitOptions & { encoding: "buffer" },
): Promise<{ stdout: Buffer; stderr: Buffer }>;
export async function hostGit(
  dir: string,
  args: readonly string[],
  options: HostGitOptions & { encoding?: "utf8" | "buffer" } = {},
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  const context = options.context ?? (await hostGitContext(dir, options.env));
  const command = hostGitCommand(context, args);
  const limits = {
    env: command.env,
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER_BYTES,
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    windowsHide: true,
  };
  const fed = <T extends { child: ChildProcess }>(running: T): T => {
    // A command that exits without reading its input closes the pipe under the write; that is its
    // business, and the run still ends with its own result.
    running.child.stdin?.on("error", () => {});
    running.child.stdin?.end(options.input);
    return running;
  };
  if (options.encoding === "buffer")
    return startWithRecovery(() => fed(exec("git", command.args, { ...limits, encoding: "buffer" })));
  return startWithRecovery(() => fed(exec("git", command.args, { ...limits, encoding: "utf8" })));
}
