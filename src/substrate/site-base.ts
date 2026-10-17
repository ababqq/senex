/**
 * The sub-path a built site expects to be hosted at. A bundler told `base: "/my-site/"` writes
 * `<script src="/my-site/assets/index.js">` into a page whose files sit at `assets/index.js`: on
 * the site's host that works, in a folder served from its own root it does not. The base is found
 * from the built page's own root-absolute URLs (never from the bundler's config, which is code),
 * and used only for a path that would otherwise be missing.
 */
import { stat } from "node:fs/promises";
import { containedReal } from "./paths.ts";

/** The studio's own route in a served page: a site is never hosted "under" it. */
const RESERVED_ROOTS: ReadonlySet<string> = new Set(["vendor"]);

/** A character no path segment of a served site holds: a backslash, or a control character. */
const UNSAFE_SEGMENT = /[\\\u0000-\u001f]/;

/** The segments of a root-absolute URL's path, or null when it is not a plain path of files to look for. */
function segmentsOf(reference: string): string[] | null {
  if (!reference.startsWith("/") || reference.startsWith("//")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(reference.split(/[?#]/)[0] ?? "");
  } catch {
    return null;
  }
  const segments = decoded.slice(1).split("/");
  const plain = segments.every((part) => part !== "" && part !== "." && part !== ".." && !UNSAFE_SEGMENT.test(part));
  return plain && segments.length >= 2 ? segments : null;
}

/** The shortest leading run of `segments` whose removal leaves a file, or null (also when the path is a file as written). */
async function prefixOf(segments: string[], isFile: (rel: string) => Promise<boolean>): Promise<string | null> {
  if (await isFile(segments.join("/"))) return null;
  for (let cut = 1; cut < segments.length; cut++) {
    if (await isFile(segments.slice(cut).join("/"))) return segments.slice(0, cut).join("/");
  }
  return null;
}

/**
 * The one prefix a page's root-absolute URLs agree on: each names a file only once that many
 * leading segments are taken off. Zero evidence, two different prefixes, and a prefix that is the
 * studio's own route all answer null, so a root build and a page with a broken link are untouched.
 * `isFile` answers for a root-relative path; it is asked only about plain paths that stay inside.
 */
export async function inferSiteBase(
  references: readonly string[],
  isFile: (rel: string) => Promise<boolean>,
): Promise<string | null> {
  const found = new Set<string>();
  for (const reference of references) {
    const segments = segmentsOf(reference);
    const prefix = segments ? await prefixOf(segments, isFile) : null;
    if (prefix !== null) found.add(prefix);
  }
  if (found.size !== 1) return null;
  const [base = ""] = found;
  return RESERVED_ROOTS.has(base.split("/")[0] ?? "") ? null : base;
}

/**
 * `relative` without the leading `base` segments, once: "" for the base itself, null when it is not
 * under the base (a name that merely begins like it is not) or there is no base.
 */
export function withoutSiteBase(relative: string, base: string | null): string | null {
  if (base === null) return null;
  if (relative === base) return "";
  return relative.startsWith(`${base}/`) ? relative.slice(base.length + 1).replace(/^\/+/, "") : null;
}

/** An `isFile` over a folder: true for a regular file inside it, links followed and contained. */
export function fileUnder(root: string): (rel: string) => Promise<boolean> {
  return async (rel) => {
    try {
      return (await stat(await containedReal(root, rel))).isFile();
    } catch {
      return false;
    }
  };
}
