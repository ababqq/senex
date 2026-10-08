import path from "node:path";
import { readdir, realpath, stat } from "node:fs/promises";
import type { BuildPreviewFrame, BuildPreviewRequest } from "../shared/build-preview.ts";
import { isBelow } from "./paths.ts";

/** The largest capture file the preview hands on; anything bigger is not one of ours. */
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
/** A run or facet id as the preview accepts it: one plain path segment. */
const PLAIN_SEGMENT = /^[a-z0-9_-]+$/i;
/** A builder capture's file name: `c<sequence>_<camera>.jpg`. */
const CAPTURE_FILE = /^c(\d+)_(.+)\.jpg$/;
/** The camera a capture is taken with when the project names none; it wins a tie. */
const DEFAULT_CAMERA = "default";
/** Iteration folders are numbered to this many digits: `iter_007`. */
const ITERATION_DIGITS = 3;

interface Capture {
  name: string;
  sequence: number;
  camera: string;
}

/** Read only saved builder captures. Never launch a renderer or touch a live worktree. */
export async function latestBuildPreview(
  runsRoot: string,
  request: BuildPreviewRequest,
): Promise<BuildPreviewFrame | null> {
  if (!isPlainRequest(request)) return null;
  try {
    const root = await realpath(runsRoot);
    const dir = await realpath(iterationDir(root, request));
    if (!isBelow(root, dir)) return null;
    for (const file of newestFirst(await readdir(dir))) {
      const target = await realpath(path.join(dir, file.name));
      if (!isBelow(root, target)) continue;
      const info = await stat(target);
      const usable = info.isFile() && info.size > 0 && info.size <= MAX_CAPTURE_BYTES;
      if (!usable) continue;
      return { path: target, capturedAt: info.mtime.toISOString(), camera: file.camera };
    }
  } catch {
    /* no capture yet */
  }
  return null;
}

/** A request whose ids are plain segments and whose iteration is a whole, non-negative number. */
function isPlainRequest(request: BuildPreviewRequest): boolean {
  if (!request) return false;
  const plainIds = PLAIN_SEGMENT.test(request.runId) && PLAIN_SEGMENT.test(request.facetId);
  return plainIds && Number.isSafeInteger(request.iteration) && request.iteration >= 0;
}

/** Where a builder's own captures for one iteration are saved. */
function iterationDir(root: string, request: BuildPreviewRequest): string {
  const iteration = `iter_${String(request.iteration).padStart(ITERATION_DIGITS, "0")}`;
  return path.join(root, request.runId, `facet_${request.facetId}`, "self", iteration);
}

/** The capture files among `names`, newest first; the default camera, then the name, break a tie. */
function newestFirst(names: string[]): Capture[] {
  return names
    .flatMap((name) => {
      const [, sequence, camera] = CAPTURE_FILE.exec(name) ?? [];
      return sequence && camera ? [{ name, sequence: Number(sequence), camera }] : [];
    })
    .sort(
      (a, b) =>
        b.sequence - a.sequence ||
        Number(b.camera === DEFAULT_CAMERA) - Number(a.camera === DEFAULT_CAMERA) ||
        a.name.localeCompare(b.name),
    );
}
