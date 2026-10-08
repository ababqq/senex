/**
 * Turn the prober's evidence references into what a grader may see (Rule 18): frames witnessed after
 * the entrance, on the project's own origin, evenly subsampled to eight, plus the console and network
 * summaries cut to 4 kB each. Every file is read through its real path inside the evidence root, and
 * only PNG, JPEG or WebP bytes are ever handed to a provider: a path that escapes the root, a link
 * that leads out of it, or a file that is not an image is dropped before anything is read.
 */
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { MessageImage } from "../../../../src/shared/event-log.ts";
import { containedReal } from "../../../../src/substrate/paths.ts";
import { ProbePhase } from "../../vocabulary.ts";
import type { EvidenceRefs, FrameRef } from "../types.ts";
import { CHECKLIST_PROMPT_FILLER } from "./checklist-prompts.ts";

/** The most frames one call carries (§8.4). */
export const MAX_GRADER_FRAMES = 8;
/** Fewer witnessed frames than this is insufficient evidence: the run is `judgeSkipped`. */
export const MIN_EVIDENCE_FRAMES = 2;
/** Each console or network summary is cut to this many bytes. */
export const SUMMARY_CAP_BYTES = 4 * 1024;
/** A frame larger than this is not read (the evidence store's own per-frame cap). */
export const MAX_FRAME_BYTES = 5 * 1024 * 1024;

/** Frames taken before the entrance show a title or loading screen, never the project (Rule 18). */
const PRE_ENTRANCE_PHASES: ReadonlySet<ProbePhase> = new Set([ProbePhase.Boot, ProbePhase.IdleBaseline]);
/** How many leading bytes identify an image. */
const SNIFF_BYTES = 12;

/** What a grader call may carry: witnessed frames as bytes, and bounded summaries. */
export interface GraderEvidence {
  frames: MessageImage[];
  consoleSummary: string;
  networkSummary: string;
  /** Frames dropped because their path, link target or bytes were refused. */
  refusedFrames: number;
}

/**
 * The frames a grader may see, in time order: taken after the entrance, and on the origin the project
 * was served on (`EvidenceRefs.projectOrigin`, what the prober opened), never another.
 */
export function witnessedFrames(frames: readonly FrameRef[], projectOrigin: string): FrameRef[] {
  const inOrder = [...frames].sort((a, b) => a.atMs - b.atMs);
  return inOrder.filter((frame) => frame.origin === projectOrigin && !PRE_ENTRANCE_PHASES.has(frame.phase));
}

/** Up to `max` items, evenly spaced over the whole list so the sample covers the whole session. */
export function pickFrames<T>(frames: readonly T[], max = MAX_GRADER_FRAMES): T[] {
  if (frames.length <= max) return [...frames];
  if (max <= 1) return frames.slice(0, Math.max(0, max));
  const step = (frames.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, index) => frames[Math.round(index * step)]).filter(
    (frame): frame is T => frame !== undefined,
  );
}

/** The image type of some leading bytes, or null when they are not a PNG, JPEG or WebP. */
export function imageMimeType(head: Uint8Array): string | null {
  const ascii = (from: number, to: number): string => String.fromCharCode(...head.subarray(from, to));
  if (head[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

/** The real path of an evidence file inside the root, or null when it is outside, missing or a link out. */
export async function containedEvidenceFile(root: string, file: string): Promise<string | null> {
  const relative = path.isAbsolute(file) ? path.relative(root, file) : file;
  try {
    return await containedReal(root, relative.split(path.sep).join("/"));
  } catch {
    return null;
  }
}

/** One frame's bytes as a message image, or null when it is refused. */
async function readFrame(root: string, frame: FrameRef, label: string): Promise<MessageImage | null> {
  const real = await containedEvidenceFile(root, frame.path);
  if (!real) return null;
  const info = await stat(real);
  if (!info.isFile() || info.size > MAX_FRAME_BYTES) return null;
  const head = await readHead(real);
  const mimeType = imageMimeType(head);
  if (!mimeType) return null;
  const bytes = await readFile(real);
  return { mimeType, data: bytes.toString("base64"), label };
}

/** The first bytes of a file, for sniffing its type before the whole file is read. */
async function readHead(file: string): Promise<Uint8Array> {
  const handle = await open(file, "r");
  try {
    const head = new Uint8Array(SNIFF_BYTES);
    const { bytesRead } = await handle.read(head, 0, SNIFF_BYTES, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** A summary's text cut to the cap, or the "not recorded" filler when it cannot be read. */
async function readSummary(root: string, file: string): Promise<string> {
  const real = await containedEvidenceFile(root, file);
  if (!real) return CHECKLIST_PROMPT_FILLER.Unreadable;
  const info = await stat(real);
  if (!info.isFile()) return CHECKLIST_PROMPT_FILLER.Unreadable;
  const handle = await open(real, "r");
  try {
    const buffer = Buffer.alloc(Math.min(info.size, SUMMARY_CAP_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Load the witnessed evidence a grader may see; refused frames are counted, never sent. */
export async function loadGraderEvidence(
  refs: EvidenceRefs,
  evidenceRoot: string,
  labelPrefix = "frame",
): Promise<GraderEvidence> {
  const chosen = pickFrames(witnessedFrames(refs.frames, refs.projectOrigin));
  const frames: MessageImage[] = [];
  let refusedFrames = 0;
  for (const [index, frame] of chosen.entries()) {
    const image = await readFrame(evidenceRoot, frame, `${labelPrefix} ${index + 1}/${chosen.length}`);
    if (image) frames.push(image);
    else refusedFrames += 1;
  }
  return {
    frames,
    consoleSummary: await readSummary(evidenceRoot, refs.consoleSummaryPath),
    networkSummary: await readSummary(evidenceRoot, refs.networkSummaryPath),
    refusedFrames,
  };
}

/** Whether the evidence is enough to grade on; below it the run is `judgeSkipped`, never graded blind. */
export function evidenceSufficient(evidence: GraderEvidence): boolean {
  return evidence.frames.length >= MIN_EVIDENCE_FRAMES;
}
