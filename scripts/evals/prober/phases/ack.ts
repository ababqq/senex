/**
 * `l2.action_acknowledged_200ms`: three verbs a player tries first (Space, a centre click, a
 * centre drag), each measured by `measureVerb`, and the fastest pixel or audio response judged
 * against the ~200 ms target.
 *
 * TWO REASONS THE ROW CANNOT GATE. The page-side sampler backs off when the mirror readback is
 * expensive, and a latency measured at one-second resolution cannot be compared with 200 ms: when
 * the sampler resolved more coarsely than half the target, "late" is indistinguishable from "sampled
 * late" and the row is `unknown` with `gates: false`. And on a software rasteriser (S5) the render
 * loop's cadence says nothing about the project, so the row never gates there either. No verb response
 * at all is `unknown`, never a fail: the primary verb is project-specific and this probe only guesses.
 */
import { CheckResult, ProbeRow, type RendererMode } from "../../vocabulary.ts";
import type { ProbeSample } from "../instrument.ts";
import { fpsRowsGate } from "../renderer.ts";
import type { Check } from "../types.ts";
import { machineRow } from "./row.ts";
import { samplerResolutionMs } from "./series.ts";
import {
  baselineClause,
  measureVerb,
  refusedClause,
  type VerbAcknowledgement,
  type VerbDeps,
  type VerbSend,
} from "./verbs.ts";

/** The acknowledgement target. */
export const SPEC_ACK_MS = 200;
/** Gaps longer than this are a paused document, not the sampler's resolution. */
export const RESOLUTION_MAX_GAP_MS = 5000;

/** The verbs the ack phase sends, in order. */
export const AckVerb = {
  Space: "Space",
  MouseLeft: "MouseLeft",
  MouseDrag: "MouseDrag",
} as const;
export type AckVerb = (typeof AckVerb)[keyof typeof AckVerb];

/** Measure each verb in order. */
export async function verbPhase(
  deps: VerbDeps,
  verbs: ReadonlyArray<{ verb: string; send: () => Promise<VerbSend> }>,
): Promise<VerbAcknowledgement[]> {
  const measured: VerbAcknowledgement[] = [];
  for (const { verb, send } of verbs) measured.push(await measureVerb(deps, verb, send));
  return measured;
}

/** A verb's fastest response, pixel or audio; `null` with neither. */
export function fastestResponse(v: VerbAcknowledgement): number | null {
  const latencies = [v.pixelLatencyMs, v.audioLatencyMs].filter((l): l is number => l !== null);
  return latencies.length ? Math.min(...latencies) : null;
}

/** What the ack row reads. */
export interface AckRowInput {
  verbs: readonly VerbAcknowledgement[];
  /** Every sample the run pulled: its median gap is the sampler's time resolution. */
  samples: readonly ProbeSample[];
  rendererMode: RendererMode;
  ackWindowMs: number;
}

/** `l2.action_acknowledged_200ms`. */
export function ackRow(input: AckRowInput): Check {
  const { verbs, ackWindowMs } = input;
  const resolutionMs = samplerResolutionMs(input.samples, RESOLUTION_MAX_GAP_MS);
  const best = verbs.map(fastestResponse).filter((l): l is number => l !== null);
  const rendererGates = fpsRowsGate(input.rendererMode);
  const value = { target: SPEC_ACK_MS, window: ackWindowMs, samplerResolutionMs: resolutionMs, verbs };
  const refused = refusedClause(verbs);
  const first = verbs[0];
  const against = first
    ? ` Pixel responses were read against ${baselineClause(first.baseline, first.changeThreshold)}.`
    : "";
  const sent = verbs.filter((v) => v.sent).map((v) => v.verb);
  if (!best.length) {
    const detail = sent.length
      ? `None of the verbs that went out (${sent.join(", ")}) produced a pixel or audio change above the threshold within ${ackWindowMs}ms.${refused} The primary verb is project-specific and this probe only tries these, so this is unknown rather than a failure.`
      : `No acknowledgement verb went out at all:${refused} Nothing here observed how the project responds.`;
    return machineRow(
      ProbeRow.L2ActionAcknowledged200ms,
      CheckResult.Unknown,
      `${detail}${against}`,
      value,
      rendererGates,
    );
  }
  const fastest = Math.min(...best);
  const resolution = resolutionMs === null ? "n/a" : `${resolutionMs.toFixed(0)}ms`;
  if (fastest <= SPEC_ACK_MS) {
    const detail = `Fastest acknowledgement ${fastest.toFixed(0)}ms, within the ~${SPEC_ACK_MS}ms target (sampler resolution ${resolution}).${refused}${against}`;
    return machineRow(ProbeRow.L2ActionAcknowledged200ms, CheckResult.Pass, detail, value, rendererGates);
  }
  if (resolutionMs !== null && resolutionMs > SPEC_ACK_MS / 2) {
    const detail = `Fastest acknowledgement ${fastest.toFixed(0)}ms, but the frame sampler only resolved ${resolution}, coarser than half the ${SPEC_ACK_MS}ms target, so "late" cannot be told from "sampled late". A slow render loop, not proof of a slow response.${against}`;
    return machineRow(ProbeRow.L2ActionAcknowledged200ms, CheckResult.Unknown, detail, value, false);
  }
  const detail = `Fastest acknowledgement ${fastest.toFixed(0)}ms, past the ~${SPEC_ACK_MS}ms target at a sampler resolution of ${resolution}.${refused}${against}`;
  return machineRow(ProbeRow.L2ActionAcknowledged200ms, CheckResult.Fail, detail, value, rendererGates);
}
