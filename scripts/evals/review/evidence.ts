/**
 * What the review page may show from a run's evidence folder, and the one boundary every file
 * crosses. A file is read or served only when its real path — every link followed — lies under
 * `$GENEX_EVALS_HOME/evidence/<runId>/` on the evidence root's own real path: a path the prober's
 * scorecard names outside it, a climb, a link that leads out (or into another run's folder), a
 * control character or a missing file is refused before a byte is read. Bytes go out only when
 * they sniff as a PNG, JPEG or WebP frame, or a WebM trace video, within the evidence store's caps.
 */
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { isBelow } from "../../../src/substrate/paths.ts";
import { containedEvidenceFile, imageMimeType, pickFrames, witnessedFrames } from "../grade/checklist/evidence.ts";
import { GRADE_RECORD_SCHEMA, gradeRecordPathIn } from "../grade/pipeline.ts";
import type { EvidenceRefs, FrameRef } from "../grade/types.ts";
import type { FamilyVerdicts, RunRow } from "../ledger/types.ts";
import { RUN_ID_PATTERN } from "../ledger/types.ts";
import { EVIDENCE_MAX_FRAME_BYTES, EVIDENCE_MAX_VIDEO_BYTES } from "../remote/contract.ts";
import { GraderFamily, ItemVerdict, ProbePhase } from "../vocabulary.ts";

/** The run a review side or checklist is read for: its current grade names the grade record. */
export type GradedRun = Pick<RunRow, "runId" | "gradeSeq">;
/** The largest grade record the review reads. */
export const MAX_EVIDENCE_JSON_BYTES = 8 * 1024 * 1024;
/** The WebM (EBML) signature a trace video must start with. */
const WEBM_SIGNATURE = [0x1a, 0x45, 0xdf, 0xa3];
/** How many leading bytes identify a frame or a video. */
const SNIFF_BYTES = 12;
const WEBM_MIME = "video/webm";

/** What a piece of media is: a witnessed frame or the trace video. */
export const MediaKind = {
  Frame: "frame",
  Video: "video",
} as const;
export type MediaKind = (typeof MediaKind)[keyof typeof MediaKind];

/** One file the page may show, still to be checked again when it is served. */
export interface ReviewMedia {
  kind: MediaKind;
  runId: string;
  /** The path as the evidence named it (absolute, or relative to the run's folder). */
  file: string;
  width: number | null;
  height: number | null;
}

/** One run's side of a review: the frames a grader would see, and the trace video when one was kept. */
export interface ReviewSide {
  runId: string;
  frames: ReviewMedia[];
  video: ReviewMedia | null;
}

/** One checklist item as the graders judged it. */
export interface ChecklistItemView {
  id: string;
  text: string;
  key: boolean;
  control: boolean;
  verdicts: FamilyVerdicts;
  combined: ItemVerdict;
}

/** Bytes that may go out, with their content type. */
export interface ServableMedia {
  bytes: Buffer;
  contentType: string;
}

const MAX_BYTES: Readonly<Record<MediaKind, number>> = {
  [MediaKind.Frame]: EVIDENCE_MAX_FRAME_BYTES,
  [MediaKind.Video]: EVIDENCE_MAX_VIDEO_BYTES,
};

const PHASES: ReadonlySet<unknown> = new Set(Object.values(ProbePhase));
const FAMILIES: ReadonlySet<unknown> = new Set(Object.values(GraderFamily));
const VERDICTS: ReadonlySet<unknown> = new Set(Object.values(ItemVerdict));
const isPhase = (value: unknown): value is ProbePhase => PHASES.has(value);
const isFamily = (value: unknown): value is GraderFamily => FAMILIES.has(value);
/** Whether a value is an `ItemVerdict` code. */
export const isItemVerdict = (value: unknown): value is ItemVerdict => VERDICTS.has(value);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const finiteOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * The real path of `file` when it lies under `<evidenceRoot>/<runId>/` on the root's real path, or
 * null. A relative `file` is taken from the run's folder; the run id must be well-formed.
 */
export async function containedRunFile(evidenceRoot: string, runId: string, file: string): Promise<string | null> {
  if (!RUN_ID_PATTERN.test(runId) || typeof file !== "string" || !file) return null;
  const runDir = path.join(evidenceRoot, runId);
  const absolute = path.isAbsolute(file) ? file : path.join(runDir, file);
  const real = await containedEvidenceFile(evidenceRoot, absolute);
  if (real === null) return null;
  const realRoot = await realpath(evidenceRoot).catch(() => null);
  if (realRoot === null) return null;
  return isBelow(path.join(realRoot, runId), real) ? real : null;
}

/** Read a contained regular file without following a final link, refusing anything over `maxBytes`. */
async function readContained(real: string, maxBytes: number): Promise<Buffer | null> {
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (handle === null) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return null;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** The content type of media bytes, or null when they are not what their kind allows. */
export function mediaContentType(kind: MediaKind, bytes: Uint8Array): string | null {
  const head = bytes.subarray(0, SNIFF_BYTES);
  if (kind === MediaKind.Frame) return imageMimeType(head);
  return WEBM_SIGNATURE.every((byte, index) => head[index] === byte) ? WEBM_MIME : null;
}

/** The bytes of one piece of media, re-checked at serve time; null for anything refused. */
export async function readServableMedia(evidenceRoot: string, media: ReviewMedia): Promise<ServableMedia | null> {
  const real = await containedRunFile(evidenceRoot, media.runId, media.file);
  if (real === null) return null;
  const bytes = await readContained(real, MAX_BYTES[media.kind]);
  if (bytes === null) return null;
  const contentType = mediaContentType(media.kind, bytes);
  return contentType === null ? null : { bytes, contentType };
}

/** A JSON file inside the run's folder, or null when it is refused, missing, too large or not JSON. */
async function readRunJson(evidenceRoot: string, runId: string, file: string): Promise<unknown> {
  const real = await containedRunFile(evidenceRoot, runId, file);
  if (real === null) return null;
  const bytes = await readContained(real, MAX_EVIDENCE_JSON_BYTES);
  if (bytes === null) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
}

function parseFrame(value: unknown): FrameRef | null {
  if (!isRecord(value)) return null;
  const { path: file, atMs, phase, origin, width, height } = value;
  const typed = typeof file === "string" && typeof origin === "string" && isPhase(phase);
  if (!typed || typeof atMs !== "number" || !Number.isFinite(atMs)) return null;
  return {
    path: file,
    atMs,
    phase,
    origin,
    width: finiteOrNull(width) ?? 0,
    height: finiteOrNull(height) ?? 0,
  };
}

/** The evidence references a scorecard carries, with every malformed frame dropped; null when there are none. */
export function parseEvidenceRefs(value: unknown): EvidenceRefs | null {
  if (!isRecord(value) || typeof value.projectOrigin !== "string" || !Array.isArray(value.frames)) return null;
  const frames = value.frames.map(parseFrame).filter((frame): frame is FrameRef => frame !== null);
  return {
    projectOrigin: value.projectOrigin,
    frames,
    consoleSummaryPath: typeof value.consoleSummaryPath === "string" ? value.consoleSummaryPath : "",
    networkSummaryPath: typeof value.networkSummaryPath === "string" ? value.networkSummaryPath : "",
    videoPath: typeof value.videoPath === "string" ? value.videoPath : null,
    summaryBytes: finiteOrNull(value.summaryBytes) ?? 0,
  };
}

/**
 * The run's current grade record (`evidence/<runId>/grade-<gradeSeq>/grade.json`, the grade
 * command's own file), or null when it is refused, missing, or another run's or grade's.
 */
async function readGradeRecordJson(evidenceRoot: string, run: GradedRun): Promise<Record<string, unknown> | null> {
  const record = await readRunJson(evidenceRoot, run.runId, gradeRecordPathIn(run.gradeSeq));
  if (!isRecord(record) || record.schema !== GRADE_RECORD_SCHEMA) return null;
  return record.runId === run.runId && record.gradeSeq === run.gradeSeq ? record : null;
}

/** The frames and video of one run the page may show: the grader's own sample, contained files only. */
export async function reviewSide(evidenceRoot: string, run: GradedRun): Promise<ReviewSide> {
  const runId = run.runId;
  const probe = (await readGradeRecordJson(evidenceRoot, run))?.probe;
  const refs = isRecord(probe) ? parseEvidenceRefs(probe.evidence) : null;
  if (refs === null) return { runId, frames: [], video: null };
  const frames: ReviewMedia[] = [];
  for (const frame of pickFrames(witnessedFrames(refs.frames, refs.projectOrigin))) {
    if ((await containedRunFile(evidenceRoot, runId, frame.path)) === null) continue;
    frames.push({ kind: MediaKind.Frame, runId, file: frame.path, width: frame.width, height: frame.height });
  }
  const videoPath = refs.videoPath;
  const videoContained = videoPath !== null && (await containedRunFile(evidenceRoot, runId, videoPath)) !== null;
  const video =
    videoContained && videoPath !== null
      ? { kind: MediaKind.Video, runId, file: videoPath, width: null, height: null }
      : null;
  return { runId, frames, video };
}

function parseVerdicts(value: unknown): FamilyVerdicts | null {
  if (!isRecord(value)) return null;
  const verdicts: FamilyVerdicts = {};
  for (const [family, verdict] of Object.entries(value)) {
    if (!isFamily(family) || !isItemVerdict(verdict)) return null;
    verdicts[family] = verdict;
  }
  return Object.keys(verdicts).length ? verdicts : null;
}

function parseChecklistItem(value: unknown): ChecklistItemView | null {
  if (!isRecord(value) || !isRecord(value.item)) return null;
  const { id, text, key, control } = value.item;
  const verdicts = parseVerdicts(value.verdicts);
  const combined = value.combined;
  const typed = typeof id === "string" && typeof text === "string" && isItemVerdict(combined);
  if (!typed || verdicts === null) return null;
  return { id, text, key: key === true, control: control === true, verdicts, combined };
}

/** The checklist items of one run's current grade that at least one family judged; empty when none was kept. */
export async function checklistItems(evidenceRoot: string, run: GradedRun): Promise<ChecklistItemView[]> {
  const record = await readGradeRecordJson(evidenceRoot, run);
  const result = record?.checklist;
  if (!isRecord(result) || !Array.isArray(result.items)) return [];
  return result.items.map(parseChecklistItem).filter((item): item is ChecklistItemView => item !== null);
}
