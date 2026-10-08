/**
 * Reading a file the chat named, for the viewer beside it (see shared/project-file.ts). Only two
 * places answer: the project folder, and a commit of the project's own history (the build a run made).
 * A name that leaves the project — `..`, another folder, `.git` — is refused, not searched for.
 */
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileKind, imageType, type ProjectFile } from "../shared/project-file.ts";
import { containedReal } from "../substrate/paths.ts";

const execFileAsync = promisify(execFile);

/** Enough for any document an agent writes; the rest is cut with a note. */
export const TEXT_LIMIT = 400_000;
const IMAGE_LIMIT = 16 * 1024 * 1024;
/** How much of a file's start is looked at to tell text from binary. */
const BINARY_SNIFF_BYTES = 8192;
/** A control character, which no file name the chat means holds. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
const CONTROL_CHAR = /[\x00-\x1f]/;

/** The chat's words for a file → its path inside the project folder, or null when it is outside. */
export function projectRelativePath(raw: string, projectDir: string): string | null {
  let value = String(raw ?? "").trim();
  if (/^file:/i.test(value)) {
    try {
      value = decodeURIComponent(new URL(value).pathname);
    } catch {
      return null;
    }
  }
  value = value.replace(/:\d+(?::\d+)?$/, "").replace(/\\/g, "/");
  if (isUnnameable(value)) return null;
  if (path.isAbsolute(value)) {
    const relative = path.relative(projectDir, value);
    if (isOutside(relative)) return null;
    value = relative.split(path.sep).join("/");
  }
  value = path.posix.normalize(value).replace(/^(\.\/)+/, "");
  if (namesNothingInside(value)) return null;
  if (value.split("/").some((part) => part === ".git")) return null;
  return value;
}

/** A name no project file answers to: empty, under the home folder (`~`), or holding a control character. */
function isUnnameable(value: string): boolean {
  return !value || value.startsWith("~") || CONTROL_CHAR.test(value);
}

/** A `path.relative` answer that is not below the folder it was measured from. */
function isOutside(relative: string): boolean {
  return !relative || relative.startsWith("..") || path.isAbsolute(relative);
}

/** A normalized relative path that names the folder itself or climbs out of it. */
function namesNothingInside(value: string): boolean {
  return !value || value === "." || value === ".." || value.startsWith("../") || value.startsWith("/");
}

function fromBytes(relative: string, where: ProjectFile["where"], bytes: Buffer): ProjectFile {
  const name = relative.split("/").pop() ?? relative;
  const kind = fileKind(relative);
  const type = imageType(relative);
  if (kind === "image" && type)
    return { path: relative, name, where, kind, src: `data:${type};base64,${bytes.toString("base64")}` };
  // A NUL in the first few kilobytes is a binary file; the viewer says so instead of printing it.
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { path: relative, name, where, kind: "other" };
  const text = bytes.toString("utf8");
  return {
    path: relative,
    name,
    where,
    kind,
    text: text.slice(0, TEXT_LIMIT),
    ...(text.length > TEXT_LIMIT ? { truncated: true } : {}),
  };
}

/** The file in the project folder, or null when there is none. Links may not lead out of it. */
export async function readFolderFile(projectDir: string, relative: string): Promise<ProjectFile | null> {
  const target = await folderFilePath(projectDir, relative);
  if (!target) return null;
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) return null;
  if (info.size > IMAGE_LIMIT)
    return { path: relative, name: path.basename(relative), where: "project", kind: "other" };
  return fromBytes(relative, "project", await readFile(target));
}

/** The absolute path of a file that exists in the project folder — for Show in Finder. */
export async function folderFilePath(projectDir: string, relative: string): Promise<string | null> {
  return containedReal(projectDir, relative).catch(() => null);
}

/** The file as a commit of the project's history has it, or null when the commit has none. */
export async function readCommitFile(
  projectDir: string,
  commit: string,
  relative: string,
): Promise<ProjectFile | null> {
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) return null;
  const git = (args: string[], encoding: "utf8" | "buffer") =>
    execFileAsync("git", ["-C", projectDir, ...args], {
      encoding,
      maxBuffer: IMAGE_LIMIT + 1024,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    });
  const spec = `${commit}:${relative}`;
  try {
    const type = String((await git(["cat-file", "-t", spec], "utf8")).stdout).trim();
    if (type !== "blob") return null;
    const size = Number(String((await git(["cat-file", "-s", spec], "utf8")).stdout).trim());
    if (!(size <= IMAGE_LIMIT)) return { path: relative, name: path.basename(relative), where: "build", kind: "other" };
    const { stdout } = await git(["cat-file", "blob", spec], "buffer");
    return fromBytes(relative, "build", Buffer.from(stdout));
  } catch {
    return null;
  }
}
