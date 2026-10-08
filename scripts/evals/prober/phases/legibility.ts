/**
 * The two L3 legibility rows beside the quick probe's `l3.visually_legible`:
 *
 * - `l3.dark_phase` (village day→night): an OPERATOR REVIEW names the darkest playable phase and the
 *   frames that show it and says whether interaction stayed readable; the prober measures those frames
 *   with the same tiled, centre-weighted exposure report and `darkPhaseAcceptance` judges both
 *   together. No review, or a named frame the probe never wrote, is `unknown`.
 * - `l3.spatially_legible`: judge-owned. The machine declares it and always leaves it `unknown`.
 */
import { ProbeRow } from "../../vocabulary.ts";
import { type DarkPhaseReview, darkPhaseAcceptance } from "../dark-phase.ts";
import type { LoggedFrame } from "../frame-log.ts";
import { downsampleFrame, exposureReport } from "../frames.ts";
import type { Check, ExposureSample } from "../types.ts";
import { selectExposureFrames } from "../verdicts.ts";
import { judgeRow, machineRow } from "./row.ts";

/** The exposure analysis grid for dark-phase frames. */
export const EXPOSURE_WIDTH = 640;
export const EXPOSURE_HEIGHT = 360;

/** The exposure sample of one logged frame. */
function sampleOf(frame: LoggedFrame): ExposureSample {
  return {
    file: frame.record.file,
    phase: frame.record.phase,
    report: exposureReport(downsampleFrame(frame.raw, EXPOSURE_WIDTH, EXPOSURE_HEIGHT)),
  };
}

/**
 * `l3.dark_phase`. The reviewed files must be eligible interaction frames (post-gesture, page-source,
 * after the first render; `selectExposureFrames`): a loading card is never the dark phase.
 */
export function darkPhaseRow(
  frames: readonly LoggedFrame[],
  firstRenderMs: number | null,
  review?: DarkPhaseReview,
): Check {
  const candidates = frames.map((f) => ({ ...f.record, logged: f }));
  const eligible = selectExposureFrames(candidates, firstRenderMs).eligible;
  const named = new Set(review?.files ?? []);
  const samples = eligible.filter((f) => named.has(f.file)).map((f) => sampleOf(f.logged));
  const verdict = darkPhaseAcceptance(samples, review);
  return machineRow(ProbeRow.L3DarkPhase, verdict.result, verdict.detail, verdict.value);
}

/** `l3.spatially_legible`: the judge's, always `unknown` from the machine. */
export function spatiallyLegibleRow(): Check {
  return judgeRow(
    ProbeRow.L3SpatiallyLegible,
    "Judge-owned. The frames this probe witnessed are the evidence the judge reads; the machine renders no verdict here.",
  );
}
