/**
 * `l3.dark_phase`: explicit, reviewed evidence about the darkest playable phase (a village at
 * night), separate from the median exposure. The reviewer names the phase and the frames and says
 * whether interaction (not just the HUD) stayed readable. No review, or a missing frame, is `unknown`.
 */
import { CheckResult } from "../vocabulary.ts";
import type { ExposureSample } from "./types.ts";

/** The darkest verified phase must keep at least this centre-weighted sRGB luma. */
export const DARK_PHASE_MIN_LUMA = 0.08;
/** And no reviewed frame may exceed this (a bright frame is not the dark phase). */
export const DARK_PHASE_MAX_LUMA = 0.85;

/** What the reviewer recorded. */
export interface DarkPhaseReview {
  files: string[];
  phase: string;
  interactionReadable: boolean;
  note: string;
}

/** The row's verdict, its sentence and the measurement behind it. */
export interface DarkPhaseVerdict {
  result: CheckResult;
  detail: string;
  value: unknown;
}

const filled = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Whether a review names a phase, a note, at least one frame and a readability answer. */
function isCompleteReview(review: DarkPhaseReview | undefined): review is DarkPhaseReview {
  if (!review || !filled(review.phase) || !filled(review.note)) return false;
  const files = Array.isArray(review.files) && review.files.length > 0 && review.files.every(filled);
  return files && typeof review.interactionReadable === "boolean";
}

const measured = (s: ExposureSample) =>
  [s.report.centreWeightedMean, s.report.tonalRange, s.report.contrast].every(Number.isFinite);

/** Judge the reviewed dark phase against the frames the prober measured. */
export function darkPhaseAcceptance(samples: readonly ExposureSample[], review?: DarkPhaseReview): DarkPhaseVerdict {
  const unknown = (detail: string): DarkPhaseVerdict => ({
    result: CheckResult.Unknown,
    detail,
    value: { review: review ?? null },
  });
  if (!isCompleteReview(review)) {
    return unknown("The darkest playable phase has not been identified and visually reviewed.");
  }
  const frames = review.files.map((file) => samples.find((s) => s.file === file));
  if (frames.some((s) => !s)) return unknown("A reviewed dark-phase frame is missing or could not be measured.");
  const found = frames.filter((s): s is ExposureSample => s !== undefined);
  if (!found.every(measured)) return unknown("Dark-phase measurements are incomplete.");
  const darkest = Math.min(...found.map((s) => s.report.centreWeightedMean));
  const inBand = found.every(
    (s) => s.report.centreWeightedMean <= DARK_PHASE_MAX_LUMA && s.report.tonalRange > 0 && s.report.contrast > 0,
  );
  const pass = review.interactionReadable && darkest >= DARK_PHASE_MIN_LUMA && inBand;
  return {
    result: pass ? CheckResult.Pass : CheckResult.Fail,
    detail: `Darkest verified phase: ${review.phase}; minimum centre-weighted sRGB luma ${darkest.toFixed(5)} (required ≥ ${DARK_PHASE_MIN_LUMA}). Interaction review: ${review.note}`,
    value: { review, darkest, band: { min: DARK_PHASE_MIN_LUMA, max: DARK_PHASE_MAX_LUMA }, frames: found },
  };
}
