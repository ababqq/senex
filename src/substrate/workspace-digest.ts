/**
 * The workspace digest evals judge `template-untouched` by (evals plan Rule 22): one sha256 over a
 * project folder's paths and contents, without `node_modules`, `.git` and what the studio writes into
 * a project besides its template. The app's eval lane takes it of the seeded project the moment the chat
 * is bound to it (`EvalLaneReport.templateDigest`), and the eval scripts take it of the stop-time
 * snapshot; both call this module, so the two can only agree. Links are hashed by their target and
 * never followed.
 */
import { createHash, type Hash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";

/** Never cloned and never digested, at any depth. */
export const WORKSPACE_EXCLUDED: ReadonlySet<string> = new Set(["node_modules", ".git"]);
/**
 * What the studio writes into a project besides the template, left out of the workspace digest so
 * an untouched template still matches its seeded digest: its metadata file, its ignore rules, its
 * own folders, and Finder's litter.
 */
export const STUDIO_METADATA: readonly string[] = [
  "studio.json",
  ".gitignore",
  ".studio",
  ".studio-shadow",
  ".claude",
  ".DS_Store",
];

/** Visit every file and link under `dir` in sorted order, skipping the excluded names at any depth. */
export async function walkTree(
  dir: string,
  exclude: ReadonlySet<string>,
  visit: (rel: string, abs: string) => Promise<void>,
  rel = "",
): Promise<void> {
  const entries = await readdir(path.join(dir, rel), { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : Number(a.name > b.name)));
  for (const entry of entries) {
    if (exclude.has(entry.name)) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walkTree(dir, exclude, visit, child);
    else await visit(child, path.join(dir, child));
  }
}

/**
 * Add one tree entry to a digest: a link by its target, a regular file by its content's sha256.
 * Returns the file's bytes (null for a link or anything else), so a caller can total them.
 */
export async function digestTreeEntry(hash: Hash, rel: string, abs: string): Promise<Buffer | null> {
  const info = await lstat(abs);
  if (info.isSymbolicLink()) {
    hash.update(`L\0${rel}\0${await readlink(abs)}\0`);
    return null;
  }
  if (!info.isFile()) return null;
  const bytes = await readFile(abs);
  hash.update(`F\0${rel}\0${createHash("sha256").update(bytes).digest("hex")}\0`);
  return bytes;
}

/** The names the workspace digest leaves out. */
const DIGEST_EXCLUDED: ReadonlySet<string> = new Set([...WORKSPACE_EXCLUDED, ...STUDIO_METADATA]);

/**
 * The digest `template-untouched` compares: the tree without node_modules, .git and the studio's
 * own metadata. Taken of the seeded workspace before the agent starts, and of the stop-time
 * snapshot after.
 */
export async function workspaceDigest(dir: string): Promise<string> {
  const hash = createHash("sha256");
  await walkTree(dir, DIGEST_EXCLUDED, async (rel, abs) => {
    await digestTreeEntry(hash, rel, abs);
  });
  return hash.digest("hex");
}
