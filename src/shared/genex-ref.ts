/**
 * A retained Genex original, named without a path the renderer could misuse:
 * `@genex/<jobId>/<file>`. The host issues these (`ProjectAsset.assetRef`) and resolves them inside
 * the job's own output folder; everything else only formats, recognises and splits them here.
 */

export const GENEX_REF_PREFIX = "@genex/";

/** A Genex reference, not a project-relative path. */
export function isGenexRef(value: unknown): value is `@genex/${string}` {
  return typeof value === "string" && value.startsWith(GENEX_REF_PREFIX);
}

/** The reference for one file of a job's output. */
export function genexRef(jobId: string, file: string): string {
  return `${GENEX_REF_PREFIX}${jobId}/${file}`;
}

/** The job and the path inside its output, or null for anything that is not a reference with a job. */
export function parseGenexRef(ref: unknown): { jobId: string; path: string[] } | null {
  if (!isGenexRef(ref)) return null;
  const [jobId = "", ...path] = ref.slice(GENEX_REF_PREFIX.length).split("/");
  return jobId ? { jobId, path } : null;
}

/**
 * A reference to one file directly in its job's output — no nesting and no hidden name — or null.
 * The host still resolves the job and the file by realpath inside the output folder.
 */
export function genexOutputFile(ref: unknown): { jobId: string; file: string } | null {
  const parsed = parseGenexRef(ref);
  if (!parsed || parsed.path.length !== 1) return null;
  const [file = ""] = parsed.path;
  return file && !file.startsWith(".") ? { jobId: parsed.jobId, file } : null;
}
