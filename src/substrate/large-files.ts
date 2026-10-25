/**
 * Big new files stay out of the studio's commits. A video or a data dump dropped into a project
 * folder would otherwise be swept in by the next `git add -A`, and a repository cannot take it
 * back out again. Before the studio stages a project folder, each untracked file over
 * {@link LARGE_FILE_MAX_BYTES} is added to the repository's own `info/exclude` (never its
 * `.gitignore`, which the person may share) under a comment of the studio's, and the caller is told
 * which files it was, so the chat can say so.
 *
 * The file stays where it is and a restore leaves it alone. The person saves it anyway with
 * `git add -f`: tracked files are never touched, since only a file git has never seen is left out.
 * A line stays only while it names an untracked file that is still over the limit; the next pass
 * takes out the ones that do not, so a small file later made at the same path is saved again.
 *
 * The person's own lines in that file are only ever appended to or copied, and the studio's own are
 * told apart from them by their comment, one above each. A name that cannot be written safely (a
 * line break, a backslash, a repository whose exclude file is shared or a link) is left out of the
 * commit by a pathspec instead (`keep`), never by a line that could hide other files.
 */
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { openNoFollow, replaceFile } from "./fsx.ts";
import { type HostGitContext, hostGit, hostGitContext, unlessRefused } from "./git-policy.ts";
import { assertRelativePath, containedReal } from "./paths.ts";

const MEBIBYTE = 1024 * 1024;
/** A new file larger than this (strictly) stays out of saves and chat checkpoints. */
export const LARGE_FILE_MAX_BYTES = 50 * MEBIBYTE;

/** The comment above each line the studio adds to `info/exclude`; {@link leftOutPaths} reads the line below it. */
export const LEFT_OUT_MARKER = `# Senex: over ${LARGE_FILE_MAX_BYTES / MEBIBYTE} MB, kept out of saves. To save it anyway: git add -f <its path>`;
/** Files whose stat runs at once. */
const STAT_BATCH = 64;
/** Where the studio's exclude lines are kept, relative to the git directory. */
const EXCLUDE_FILE = "info/exclude";
/** The permission bits of a file's mode. */
const PERMISSION_BITS = 0o777;
const MESSAGE = { ChangedMeanwhile: "the exclude file changed while it was being rewritten" } as const;
/** The suffix of the file an exclude rewrite is made in before it replaces the original. */
const REWRITE_SUFFIX = ".senex-rewrite";
/** The exit status of `check-ignore` when none of the paths is ignored. */
const NONE_IGNORED_EXIT = 1;
/** git output a pass may buffer: a listing of every file of a big folder. */
const UNLIMITED_BYTES = Number.POSITIVE_INFINITY;

/** One file left out of saves, and whether its line is in the exclude file (else a pathspec keeps it out). */
export interface LeftOutFile {
  path: string;
  bytes: number;
  listed: boolean;
}

/** Called with the files a save left out for the first time. */
export type LeftOutReport = (files: LeftOutFile[]) => void | Promise<void>;

/** What a pass found: `reported` is new to the person, `keep` is every path the next `add` must skip. */
export interface LeftOutResult {
  reported: LeftOutFile[];
  keep: string[];
}

/** A file over the limit, as found. */
interface LargeFile {
  path: string;
  bytes: number;
}

/** A line of the studio's in the exclude file: the path it names, and the index of its comment above it. */
interface Entry {
  path: string;
  at: number;
}

/** A pass that found nothing. */
const NOTHING: LeftOutResult = { reported: [], keep: [] };
/** Names a pathspec has kept out of a commit and a notice has already said so, per folder. */
const announcedKept = new Map<string, Set<string>>();
/** Passes over one folder, one at a time: two saves at once write one line, not two. */
const passes = new Map<string, Promise<unknown>>();

/**
 * The exclude file is handled as bytes written one to a character ("binary" text), so the person's
 * lines come back out exactly as they went in, whatever encoding their editor saved them in.
 * Names the studio writes and reads cross over here.
 */
const binary = (text: string): string => Buffer.from(text, "utf8").toString("latin1");
const unbinary = (text: string): string => Buffer.from(text, "latin1").toString("utf8");

/** A name the studio can put on a line of its own: plain, relative, with no way out of the folder. */
function plainRelative(rel: string): boolean {
  try {
    assertRelativePath(rel);
    return true;
  } catch {
    return false;
  }
}

/** The exclude line for `rel`, anchored to the folder's root; git's own pattern characters are escaped. */
function excludeLine(rel: string): string {
  return `/${rel.replace(/[\\*?[\]]/g, "\\$&").replace(/ $/, "\\ ")}`;
}

/** The path a line from {@link excludeLine} names. */
function pathOfLine(line: string): string {
  return line.slice(1).replace(/\\(.)/g, "$1");
}

/** The studio's lines in an exclude file's binary text: each one directly below its comment, nothing else. */
function entriesOf(text: string): Entry[] {
  const lines = text.split(/\r?\n/);
  const entries: Entry[] = [];
  for (let at = 0; at + 1 < lines.length; at += 1) {
    const named = lines[at + 1] ?? "";
    if (lines[at] === LEFT_OUT_MARKER && named.startsWith("/")) entries.push({ path: unbinary(pathOfLine(named)), at });
  }
  return entries;
}

/** Untracked, unignored names under `dir`. A failed listing fails the pass: a save must not guess that no file is big. */
async function untrackedNames(dir: string, context: HostGitContext): Promise<string[]> {
  const { stdout } = await hostGit(dir, ["ls-files", "--others", "--exclude-standard", "-z"], {
    context,
    maxBuffer: UNLIMITED_BYTES,
  });
  return stdout.split("\0").filter(Boolean);
}

/** The untracked regular files over the limit. A symlink is its link's length, and a nested repository is `name/`. */
async function largeUntracked(dir: string, context: HostGitContext): Promise<LargeFile[]> {
  const names = (await untrackedNames(dir, context)).filter((name) => !name.endsWith("/"));
  const large: LargeFile[] = [];
  for (let at = 0; at < names.length; at += STAT_BATCH) {
    const batch = names.slice(at, at + STAT_BATCH);
    const stats = await Promise.all(batch.map((name) => lstat(path.join(dir, ...name.split("/"))).catch(() => null)));
    batch.forEach((name, index) => {
      const stat = stats[index];
      if (stat?.isFile() && stat.size > LARGE_FILE_MAX_BYTES) large.push({ path: name, bytes: stat.size });
    });
  }
  return large;
}

/** Both paths name one folder, links followed. */
async function sameFolder(left: string, right: string): Promise<boolean> {
  const [first, second] = await Promise.all([realpath(left).catch(() => left), realpath(right).catch(() => right)]);
  return first === second;
}

/**
 * Where this repository keeps its `info/exclude`, or null where a line there would reach further
 * than this folder: a linked worktree shares it with the main checkout and its other worktrees,
 * which would lose any file that happens to have the same path.
 */
async function excludePath(dir: string, context: HostGitContext): Promise<string | null> {
  const printed = await hostGit(
    dir,
    // Absolute only for the two folders: git also resolves links when it prints a path absolute, which would hide a linked exclude file.
    ["rev-parse", "--git-path", EXCLUDE_FILE, "--path-format=absolute", "--git-dir", "--git-common-dir"],
    { context },
  ).then(({ stdout }) => stdout.split("\n"), unlessRefused([] as string[]));
  const [exclude, gitDir, commonDir] = printed;
  if (!gitDir || !commonDir || !exclude) return null;
  return (await sameFolder(gitDir, commonDir)) ? path.resolve(dir, exclude) : null;
}

/** The exclude file's binary text ("" when there is none), or null where it is not a plain file in a plain folder, or unreadable. */
async function readableExclude(file: string): Promise<string | null> {
  const infoStat = await lstat(path.dirname(file)).catch(() => null);
  if (infoStat !== null && !infoStat.isDirectory()) return null;
  const stat = await lstat(file).catch(() => null);
  if (stat === null) return "";
  if (!stat.isFile()) return null;
  // An unreadable file is not an empty one: its last line would be run into the comment.
  return await readFile(file, "latin1").catch(() => null);
}

/** {@link readableExclude}, once the folder the file goes in exists. */
async function writableExclude(file: string): Promise<string | null> {
  const made = await mkdir(path.dirname(file), { recursive: true }).then(
    () => true,
    () => false,
  );
  return made ? await readableExclude(file) : null;
}

/** Append binary `text` to the file whole, never through a link planted at its name. */
async function appendUnlinked(file: string, text: string): Promise<boolean> {
  const handle = await openNoFollow(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o666).catch(
    () => null,
  );
  if (handle === null) return false;
  try {
    await handle.writeFile(Buffer.from(text, "latin1"));
    return true;
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** The paths git ignores, of those listed. Exit 1 says none are; any other failure is thrown, never read as "none". */
async function ignoredAmong(dir: string, context: HostGitContext, names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const input = `${names.join("\0")}\0`;
  const stdout = await hostGit(dir, ["check-ignore", "-z", "--stdin"], { context, input }).then(
    (result) => result.stdout,
    (error: unknown) => {
      if ((error as { code?: unknown }).code === NONE_IGNORED_EXIT) return "";
      throw error;
    },
  );
  return new Set(stdout.split("\0").filter(Boolean));
}

/** The lines to add: none already in the file, each with the comment above it, and the newline the file may lack. */
function appendix(existing: string, names: string[]): string {
  const present = new Set(existing.split(/\r?\n/));
  const lines = names.map((rel) => binary(excludeLine(rel))).filter((line) => !present.has(line));
  const lead = existing === "" || existing.endsWith("\n") || lines.length === 0 ? "" : "\n";
  return `${lead}${lines.map((line) => `${LEFT_OUT_MARKER}\n${line}\n`).join("")}`;
}

/** Write the lines for `names`; false when the exclude file cannot safely be appended to. */
async function writeLines(file: string, names: string[]): Promise<boolean> {
  const existing = await writableExclude(file);
  if (existing === null) return false;
  const text = appendix(existing, names);
  return text === "" || (await appendUnlinked(file, text));
}

/**
 * Replace the file with its own bytes less the studio's entries for `stale`, the person's lines
 * copied as they are. The copy is made beside it and put in place only if the file is still what
 * was read, so an edit made meanwhile is never lost: the stale lines then go on the next pass.
 */
async function rewriteWithout(file: string, stale: ReadonlySet<string>): Promise<void> {
  const before = await writableExclude(file);
  const stat = await lstat(file).catch(() => null);
  if (
    before === null ||
    stat === null ||
    !(await access(file, constants.W_OK).then(
      () => true,
      () => false,
    ))
  )
    return;
  const doomed = new Set<number>();
  for (const entry of entriesOf(before)) if (stale.has(entry.path)) doomed.add(entry.at).add(entry.at + 1);
  if (doomed.size === 0) return;
  const kept = before.split(/(?<=\n)/).filter((_, at) => !doomed.has(at));
  const rewrite = `${file}${REWRITE_SUFFIX}`;
  try {
    const handle = await open(rewrite, "wx", stat.mode & PERMISSION_BITS);
    try {
      await handle.writeFile(Buffer.from(kept.join(""), "latin1"));
      await handle.sync();
    } finally {
      await handle.close();
    }
    if ((await readFile(file, "latin1")) !== before) throw new Error(MESSAGE.ChangedMeanwhile);
    await replaceFile(rewrite, file);
  } catch {
    await rm(rewrite, { force: true }).catch(() => {});
  }
}

/** `rel` is a regular file over the limit inside `dir`, with no link on the way. */
async function isBigFile(dir: string, rel: string): Promise<boolean> {
  if (!plainRelative(rel)) return false;
  const stat = await containedReal(dir, rel)
    .then(() => lstat(path.join(dir, ...rel.split("/"))))
    .catch(() => null);
  return stat?.isFile() === true && stat.size > LARGE_FILE_MAX_BYTES;
}

/**
 * Take out the studio's lines that no longer name an untracked regular file over the limit: the
 * file was deleted, shrank, became a folder, or was saved with `git add -f`. A line left in would
 * hide whatever is made at that path next.
 */
async function retireStale(dir: string, context: HostGitContext, file: string): Promise<void> {
  const named = [...new Set(entriesOf((await writableExclude(file)) ?? "").map((entry) => entry.path))];
  if (named.length === 0) return;
  const big = await Promise.all(named.map((rel) => isBigFile(dir, rel)));
  // A tracked file is never reported as ignored, which is how one saved with `git add -f` shows here.
  const ignored = await ignoredAmong(
    dir,
    context,
    named.filter((_, at) => big[at]),
  );
  const stale = new Set(named.filter((rel) => !ignored.has(rel)));
  if (stale.size > 0) await rewriteWithout(file, stale);
}

/** What a pathspec keeps out is said once per folder and run; a written line is said when it is written. */
function resultOf(dir: string, large: LargeFile[], ignored: Set<string>): LeftOutResult {
  const said = announcedKept.get(dir) ?? new Set<string>();
  announcedKept.set(dir, said);
  const kept = large.filter((file) => !ignored.has(file.path));
  const unsaid = kept.filter((file) => !said.has(file.path));
  for (const file of unsaid) said.add(file.path);
  return {
    reported: [
      ...large.filter((file) => ignored.has(file.path)).map((file) => ({ ...file, listed: true })),
      ...unsaid.map((file) => ({ ...file, listed: false })),
    ],
    keep: kept.map((file) => file.path),
  };
}

/** One pass over a folder; see {@link excludeLargeNewFiles}. */
async function leaveOut(dir: string): Promise<LeftOutResult> {
  const context = await hostGitContext(dir);
  // Nothing but a refusal to run in the folder may fail a save from here: what cannot be written is kept out by pathspec.
  const file = await excludePath(dir, context).catch(unlessRefused(null));
  if (file) await retireStale(dir, context, file).catch(unlessRefused(undefined));
  const large = await largeUntracked(dir, context);
  if (large.length === 0) return NOTHING;
  const writable = large.filter((entry) => plainRelative(entry.path)).map((entry) => entry.path);
  const written = file ? await writeLines(file, writable).catch(unlessRefused(false)) : false;
  // What `add -A` will still stage is what the listing still shows: `check-ignore` can disagree where
  // the index holds a folder of the same name, and a path both ignored and kept out by pathspec fails the `add`.
  const staged = written ? new Set(await untrackedNames(dir, context)) : null;
  const ignored = new Set(staged ? writable.filter((rel) => !staged.has(rel)) : []);
  return resultOf(dir, large, ignored);
}

/**
 * Leave each untracked file over {@link LARGE_FILE_MAX_BYTES} out of the next save of `dir`: its
 * line goes into `info/exclude`, and `keep` names every file the caller's `add` must still skip
 * because no line could safely be written for it. One pass at a time per folder. A listing that
 * fails fails the pass, and only a host git refusal otherwise throws.
 */
export function excludeLargeNewFiles(dir: string): Promise<LeftOutResult> {
  const next = (passes.get(dir) ?? Promise.resolve()).catch(() => {}).then(() => leaveOut(dir));
  passes.set(dir, next);
  const done = () => {
    if (passes.get(dir) === next) passes.delete(dir);
  };
  next.then(done, done);
  return next;
}

/**
 * The files the studio's lines in `info/exclude` name that are regular files in `dir` now, with no
 * link on the way: the file's own text says nothing about where its names lead.
 */
export async function leftOutPaths(dir: string): Promise<string[]> {
  try {
    const text = await excludeText(dir);
    if (!text.includes(LEFT_OUT_MARKER)) return [];
    const named = [...new Set(entriesOf(text).map((entry) => entry.path))];
    const present = await Promise.all(
      named.map(async (rel) => {
        if (!plainRelative(rel)) return null;
        const stat = await containedReal(dir, rel)
          .then(() => lstat(path.join(dir, ...rel.split("/"))))
          .catch(() => null);
        return stat?.isFile() ? rel : null;
      }),
    );
    return present.filter((rel): rel is string => rel !== null);
  } catch {
    return [];
  }
}

/**
 * The text of this folder's exclude file, read without a git process where `.git` is a folder of
 * its own (the usual case; a linked worktree's is a file, and asks git where its lines may go).
 */
async function excludeText(dir: string): Promise<string> {
  const own = path.join(dir, ".git");
  if ((await lstat(own).catch(() => null))?.isDirectory()) {
    return (await readableExclude(path.join(own, EXCLUDE_FILE))) ?? "";
  }
  const file = await excludePath(dir, await hostGitContext(dir));
  return (file ? await readableExclude(file) : null) ?? "";
}

/**
 * Which of `leftOut` a commit with these file names would overwrite on a reset: a file at the same
 * path, one inside a folder at it, or one where a folder holding it is. Names compare without
 * regard to case, as a case-insensitive folder reads them.
 */
export function pathsInTheWay(treeNames: Iterable<string>, leftOut: readonly string[]): string[] {
  const byName = new Map(leftOut.map((rel) => [rel.toLowerCase(), rel]));
  const holdingFolder = new Map<string, string[]>();
  for (const rel of leftOut) {
    const parts = rel.toLowerCase().split("/");
    for (let end = 1; end < parts.length; end += 1) {
      const folder = parts.slice(0, end).join("/");
      holdingFolder.set(folder, [...(holdingFolder.get(folder) ?? []), rel]);
    }
  }
  const inTheWay = new Set<string>();
  for (const name of treeNames) {
    const parts = name.toLowerCase().split("/");
    // The tree has the path itself, or something under it.
    for (let end = 1; end <= parts.length; end += 1) {
      const same = byName.get(parts.slice(0, end).join("/"));
      if (same !== undefined) inTheWay.add(same);
    }
    // A file of the tree stands where a folder of the path is.
    for (const rel of holdingFolder.get(parts.join("/")) ?? []) inTheWay.add(rel);
  }
  return [...inTheWay];
}

/** Control and format characters (line breaks, bidi marks, zero-width joiners) that could reshape a line of text. */
const UNSEEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
/** The longest file name a message spells out; a longer one keeps its end, where the extension is. */
const SHOWN_NAME_CHARACTERS = 60;
/** File names a message names in full. */
const SHOWN_NAMES = 3;

/** Up to three file names for a message, nothing unseen in them and each clipped, and a count of the rest. */
export function namedFiles(files: readonly string[]): string {
  const shown = files.slice(0, SHOWN_NAMES).map((rel) => {
    const letters = [...rel.replace(UNSEEN_CHARACTERS, "�")];
    return letters.length > SHOWN_NAME_CHARACTERS
      ? `…${letters.slice(-(SHOWN_NAME_CHARACTERS - 1)).join("")}`
      : letters.join("");
  });
  const more = files.length - shown.length;
  return `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

/** The untracked regular files over the limit that no ignore rule hides yet: what a save would take in. Reads only. */
export async function untrackedLargeFiles(dir: string): Promise<string[]> {
  return (await largeUntracked(dir, await hostGitContext(dir))).map((file) => file.path);
}

/**
 * The pathspec that leaves those files out of a `git status` of the project folder: they are left
 * out of saves on purpose, so they are not edits somebody has to commit or discard. Empty when
 * there are none, so it can always be spread onto the arguments.
 */
export async function statusPathspec(dir: string): Promise<string[]> {
  const large = await untrackedLargeFiles(dir);
  return large.length > 0 ? ["--", ".", ...large.map((rel) => `:(exclude,literal)${rel}`)] : [];
}

/**
 * Which files left out of saves (listed in `info/exclude`, or not yet) the commit `commit` would
 * overwrite if it were merged or checked out into `dir`: a file at their path, one inside a folder
 * at it, or one where a folder holding them is. Git treats an ignored file as in the way of nothing,
 * so the merge would replace it with no copy anywhere. `commit` is a full hash.
 */
export async function filesInTheWay(dir: string, commit: string): Promise<string[]> {
  const leftOut = [...new Set([...(await leftOutPaths(dir)), ...(await untrackedLargeFiles(dir))])];
  if (leftOut.length === 0) return [];
  const listing = await hostGit(dir, ["ls-tree", "-r", "-z", "--name-only", commit], { maxBuffer: UNLIMITED_BYTES });
  return pathsInTheWay(listing.stdout.split("\0"), leftOut);
}
