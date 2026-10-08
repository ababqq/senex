/**
 * Collect one finished run (§4 flow): read what the lane left (the receive-stamped stream, the eval
 * homes' transcripts, the Genex event log and lane report, the stop-time snapshot's facts) into the
 * contract's `RunObservation` and compute the §7 metric blocks from it. Nothing here decides
 * policy: the scheduler turns the result into a ledger row.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import type { EvalLaneReport } from "../../../src/shared/eval-lane.ts";
import { layoutFor } from "../../../src/main/core/layout.ts";
import { validateProjectDir } from "../../../src/substrate/project-validation.ts";
import { EngineId } from "../../../src/shared/providers.ts";
import { MINUTE_MS } from "../../../src/shared/duration.ts";
import { readClaudeStream } from "../collect/claude-stream.ts";
import { readCodexStream } from "../collect/codex-stream.ts";
import { type InAppSignals, readGenexEvents } from "../collect/genex-events.ts";
import { CollectError } from "../collect/honesty.ts";
import type { RunObservation, SnapshotFacts } from "../collect/observation.ts";
import { buildRunObservation, type StreamReading, type TimelineReading } from "../collect/observe.ts";
import { readTranscripts, type TranscriptReading } from "../collect/transcripts.ts";
import { readLaneReport } from "../lanes/genex-app.ts";
import type { LaneRegistryRow, LaneRunResult } from "../lanes/types.ts";
import { hashDir } from "../ledger/hash.ts";
import type { RowCalls } from "../ledger/types.ts";
import {
  callMetrics,
  contextMetrics,
  costMetrics,
  effortServed,
  observedHarnessFailure,
  type RunMetrics,
  servedModels,
  timeMetrics,
  tokenMetrics,
} from "../metrics.ts";
import type { PriceTable } from "../prices.ts";
import { CheckResult, Coverage, EvalAgent, LaneModeServed } from "../vocabulary.ts";

/** Slack around the run's window when attributing transcripts to it (sessions start a little early or late). */
const TRANSCRIPT_WINDOW_SLACK_MS = MINUTE_MS;

/** What collecting one run needs. */
export interface CollectInput {
  lane: LaneRegistryRow;
  result: LaneRunResult;
  snapshot: SnapshotFacts | null;
  prices: PriceTable;
}

/** One run collected: its observation, its metrics, and what the Genex lane report and event log said. */
export interface CollectedRun {
  observation: RunObservation;
  metrics: RunMetrics;
  report: EvalLaneReport | null;
  inApp: InAppSignals | null;
  /** The counted transcripts' digest (`TranscriptReading.sha256`); null when none was counted. */
  transcriptSha256: string | null;
}

async function readStream(
  lane: LaneRegistryRow,
  file: string | null,
  promptAtMs: number,
): Promise<StreamReading | null> {
  if (!file) return null;
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return null;
  return lane.engine === EngineId.Codex ? readCodexStream(text, promptAtMs) : readClaudeStream(text, promptAtMs);
}

/**
 * The run's own folders (its work root and the lane root its agent ran in), lexically and on their
 * real paths, so a transcript's recorded cwd matches either.
 */
async function runRoots(roots: readonly string[]): Promise<string[]> {
  const real = await Promise.all(roots.map((root) => realpath(root).catch(() => root)));
  return [...new Set([...roots, ...real])];
}

async function readRunTranscripts(
  lane: LaneRegistryRow,
  result: LaneRunResult,
  span: { promptAtMs: number; endAtMs: number },
  leadSessionId: string | null,
): Promise<TranscriptReading> {
  const home =
    lane.engine === EngineId.Codex ? result.artifacts.transcriptHomes.codex : result.artifacts.transcriptHomes.claude;
  return readTranscripts({
    engine: lane.engine,
    home,
    roots: await runRoots([result.artifacts.workRoot, result.artifacts.laneRoot]),
    window: { startMs: span.promptAtMs - TRANSCRIPT_WINDOW_SLACK_MS, endMs: span.endAtMs + TRANSCRIPT_WINDOW_SLACK_MS },
    promptAtMs: span.promptAtMs,
    leadSessionId,
    // Studio scratch sessions sit in folders every run shares: only a Genex lane runs them, and
    // only inside its own span, never the slack a neighbouring run's tail could fall into.
    ...(lane.agent === EvalAgent.GenexApp ? { scratch: { startMs: span.promptAtMs, endMs: span.endAtMs } } : {}),
  });
}

/** The Genex event log, when the eval profile wrote one. */
async function readEvents(
  result: LaneRunResult,
  promptAtMs: number,
): Promise<{ reading: TimelineReading; inApp: InAppSignals } | null> {
  if (!result.artifacts.eventLogDir) return null;
  const dir = layoutFor(result.artifacts.eventLogDir).exoharness;
  const present = await stat(dir).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!present) return null;
  const events = await readGenexEvents(dir, promptAtMs);
  return {
    reading: { events: events.events, trace: events.trace, modelUsage: events.modelUsage },
    inApp: events.inApp,
  };
}

/** `calls.*`, or an unmeasured block when the observation shows work but no model call (Rule 2, never zero). */
function safeCallMetrics(observation: RunObservation): RowCalls {
  try {
    return callMetrics(observation);
  } catch (error) {
    if (!(error instanceof CollectError)) throw error;
    return {
      modelCalls: null,
      tools: { total: null, byCategory: {} },
      blindEditStreak: null,
      subagents: null,
      verifiedBeforeDone: null,
      coverage: Coverage.Unmeasured,
    };
  }
}

/** Every metric block of one observation (`runMetrics`, with a vacuous call count kept unmeasured instead of thrown). */
export function collectMetrics(observation: RunObservation, prices: PriceTable): RunMetrics {
  return {
    time: timeMetrics(observation),
    tokens: tokenMetrics(observation),
    context: contextMetrics(observation),
    calls: safeCallMetrics(observation),
    cost: costMetrics(observation, prices),
    served: servedModels(observation),
    effortServed: effortServed(observation),
    harnessFailure: observedHarnessFailure(observation),
  };
}

/** Collect one finished run into its observation and metrics. */
export async function collectRun(input: CollectInput): Promise<CollectedRun> {
  const { lane, result } = input;
  const report = result.artifacts.reportPath ? await readLaneReport(result.artifacts.reportPath) : null;
  const promptAtMs = Date.parse(report?.startedAt ?? result.startedAt);
  const endAtMs = Date.parse(report?.endedAt ?? result.endedAt);
  const stream = await readStream(lane, result.artifacts.streamPath, promptAtMs);
  const transcripts = await readRunTranscripts(lane, result, { promptAtMs, endAtMs }, stream?.sessionId ?? null);
  const events = lane.agent === EvalAgent.GenexApp ? await readEvents(result, promptAtMs) : null;
  const modeServed = lane.agent === EvalAgent.GenexApp ? (report?.modeServed ?? null) : LaneModeServed.RawCli;
  const observation = buildRunObservation({
    runId: result.runId,
    laneId: lane.id,
    agent: lane.agent,
    engine: lane.engine,
    modelRequested: lane.model,
    modeServed,
    endedHow: result.endedHow,
    promptAtMs,
    endAtMs,
    stream,
    transcripts,
    eventLog: events?.reading ?? null,
    laneReport: report,
    snapshot: input.snapshot,
    quotaBefore: result.quotaBefore,
    quotaAfter: result.quotaAfter,
  });
  return {
    observation,
    metrics: collectMetrics(observation, input.prices),
    report,
    inApp: events?.inApp ?? null,
    transcriptSha256: transcripts.sha256,
  };
}

/** What `validateProjectDir` says of the stop-time snapshot (`output.validate`); unknown without one, or when it cannot be read. */
export async function snapshotValidation(finalDir: string | null): Promise<CheckResult> {
  if (finalDir === null) return CheckResult.Unknown;
  const found = await validateProjectDir(finalDir).catch(() => null);
  if (found === null) return CheckResult.Unknown;
  return found.ok ? CheckResult.Pass : CheckResult.Fail;
}

/** `hashDir` of a run's evidence folder (`digests.evidenceSha256`), or null when nothing was kept there. */
export async function keptEvidenceDigest(dir: string): Promise<string | null> {
  const present = await stat(dir).then(
    (info) => info.isDirectory(),
    () => false,
  );
  return present ? hashDir(dir) : null;
}
