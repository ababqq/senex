import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  GenexOperation,
  GenexUseStage,
  GenexUseVerification,
  type GenexJob,
  type GenexRequest,
} from "../shared/genex.ts";
import type { AudioPlaybackEvidence } from "../shared/audio-observation.ts";
import { isAudioFile } from "../shared/project-assets.ts";
import { atomicWriteJson } from "./fsx.ts";
import { USE_GUIDANCE } from "./genex-outcomes-prompts.ts";

/** Quieter than this RMS level is silence, however the player reports itself. */
const AUDIBLE_RMS = 0.0001;
const MIN_NOTE_CHARS = 12;
const MAX_NOTE_CHARS = 2000;

const MESSAGE = {
  NotDelivered: "Retrieve and deliver this job before checking its use. Use the delivered Studio job id.",
  NoObserver: "Project observation is unavailable in this host",
  UnknownOperation: "Unknown asset observation operation",
  NeedsInspection:
    "A runtime-loaded visual asset and a fresh inspection are required. Audio playback is not established by a screenshot.",
  StaleInspection: "Verification must reference the current host inspection",
  NeedsNote: "Describe the visible use you observed in the attached frame",
} as const;

export interface GenexObservation {
  image: Buffer;
  loadedFiles: string[];
  consoleAvailable: boolean;
  audio?: AudioPlaybackEvidence[];
}
export type GenexObserver = (
  project: string,
  root: string,
  files: string[],
  signal: AbortSignal,
) => Promise<GenexObservation>;

interface UseInput {
  job: GenexJob;
  dir: string;
  root: string;
  request: GenexRequest;
  signal: AbortSignal;
  observe?: GenexObserver;
}

/** A player that is playing, audibly, and advancing. */
const isAudiblePlayback = (item: AudioPlaybackEvidence) =>
  item.state === "playing" && Number.isFinite(item.rms) && (item.rms ?? 0) > AUDIBLE_RMS && item.advancedSeconds > 0;

/** Every delivered file is audio, and each one was heard playing. */
function allAudioPlayed(job: GenexJob, audioFiles: string[], evidence: AudioPlaybackEvidence[] | undefined): boolean {
  if (audioFiles.length !== job.files.length) return false;
  return audioFiles.every((file) => evidence?.some((item) => item.file === file && isAudiblePlayback(item)));
}

/** What the agent is told after an inspection. */
function inspectionGuidance(audio: boolean, verification: string, loaded: boolean): string {
  if (audio)
    return verification === GenexUseVerification.RuntimeAudioPlayback
      ? USE_GUIDANCE.AudioVerified
      : USE_GUIDANCE.AudioUnverified;
  return loaded ? USE_GUIDANCE.VisualLoaded : USE_GUIDANCE.NothingLoaded;
}

/** Capture the running project, record which delivered files it loaded, and verify audio playback. */
async function inspectUse({ job, dir, root, signal, observe }: UseInput): Promise<unknown> {
  if (!observe) throw new Error(MESSAGE.NoObserver);
  signal.throwIfAborted();
  const observation = await observe(job.project, root, job.files, signal);
  signal.throwIfAborted();
  const id = randomUUID();
  await writeFile(path.join(dir, `inspection-${id}.jpg`), observation.image, { flag: "wx" });
  const audio = job.files.some(isAudioFile);
  const use: NonNullable<GenexJob["use"]> = {
    stage: observation.loadedFiles.length ? GenexUseStage.Integrated : GenexUseStage.Unconfirmed,
    inspectionId: id,
    observedAt: new Date().toISOString(),
    loadedFiles: observation.loadedFiles,
    consoleAvailable: observation.consoleAvailable,
    verification: audio ? GenexUseVerification.UnavailableAudio : GenexUseVerification.PendingVisual,
  };
  job.use = use;
  if (audio) {
    const audioFiles = job.files.filter(isAudioFile);
    use.audio = observation.audio?.filter((item) => audioFiles.includes(item.file));
    if (allAudioPlayed(job, audioFiles, use.audio)) {
      use.stage = GenexUseStage.Verified;
      use.verification = GenexUseVerification.RuntimeAudioPlayback;
    }
  }
  await atomicWriteJson(path.join(dir, "job.json"), job);
  return {
    ...job,
    images: [
      { mimeType: "image/jpeg", data: observation.image.toString("base64"), label: "Asset use in the running project" },
    ],
    guidance: inspectionGuidance(audio, use.verification, observation.loadedFiles.length > 0),
  };
}

/** Record the agent's own account of a visible use, against the current inspection only. */
async function verifyUse({ job, dir, request, signal }: UseInput): Promise<GenexJob> {
  const pendingVisual =
    job.use?.stage === GenexUseStage.Integrated && job.use.verification === GenexUseVerification.PendingVisual;
  if (!job.use || !pendingVisual) throw new Error(MESSAGE.NeedsInspection);
  if (request.options?.inspectionId !== job.use.inspectionId) throw new Error(MESSAGE.StaleInspection);
  const note = request.prompt;
  if (typeof note !== "string" || note.trim().length < MIN_NOTE_CHARS || note.length > MAX_NOTE_CHARS)
    throw new Error(MESSAGE.NeedsNote);
  signal.throwIfAborted();
  job.use = {
    ...job.use,
    stage: GenexUseStage.Verified,
    verification: GenexUseVerification.AgentVisualObservation,
    note: note.trim(),
  };
  await atomicWriteJson(path.join(dir, "job.json"), job);
  return job;
}

/** Evidence records are separate from Genex's charge ledger and identify their observer. */
export async function recordGenexUse(input: UseInput): Promise<unknown> {
  if (!input.job.files.length) throw new Error(MESSAGE.NotDelivered);
  if (input.request.operation === GenexOperation.InspectUse) return inspectUse(input);
  if (input.request.operation !== GenexOperation.VerifyUse) throw new Error(MESSAGE.UnknownOperation);
  return verifyUse(input);
}
