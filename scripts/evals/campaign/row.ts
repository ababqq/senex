/**
 * The collected `RunRow` (§9.1): every pin (run, grading, recorded), the outcome with `noBuild` from
 * the stop-time snapshot, and the §7 blocks, written before any grade. It is the run's first
 * `gradeSeq` (the schema starts at 1); probe and checklist stay null until `grade` adds a later one,
 * except a canary's, which carries its boot-only verdict. Every string is made to fit the closed
 * schema here (a window id becomes a slug, a model id a model id) instead of being refused later.
 */
import os from "node:os";
import type { TokenUsage } from "../../../src/shared/eval-lane.ts";
import type { EvalLaneReport } from "../../../src/shared/eval-lane.ts";
import type { EvalCase } from "../case-types.ts";
import type { InAppSignals } from "../collect/genex-events.ts";
import type { RunObservation, SnapshotFacts } from "../collect/observation.ts";
import { sumUsage, totalTokens } from "../collect/usage.ts";
import { textDigest } from "../lanes/common.ts";
import type { AppBuild, LaneRegistryRow, LaneRunResult } from "../lanes/types.ts";
import {
  INSTANT_PATTERN,
  MODEL_ID_PATTERN,
  NOT_APPLICABLE,
  OS_PATTERN,
  type Pinned,
  type QuotaDelta,
  RUN_ROW_SCHEMA,
  type RowInApp,
  type RowProbe,
  type RunRow,
  type ServedModel,
  unavailable,
  VERSION_PATTERN,
} from "../ledger/types.ts";
import { withGradeId } from "../ledger/write.ts";
import type { RunMetrics } from "../metrics.ts";
import { PROBER_VERSION } from "../prober/types.ts";
import { ENDPOINTS_SHA } from "../report/endpoints.ts";
import {
  type AccountExclusive,
  type CampaignVoidReason,
  type Concurrency,
  ContainmentPin,
  Effort,
  EvalAgent,
  HardwareClass,
  type HarnessFailure,
  LaneModeServed,
  NoBuild,
  NoteCode,
  ObservationEventKind,
  RendererMode,
  type RowKind,
  ServedModelRole,
  ShimMode,
  UnavailableReason,
  type CheckResult,
} from "../vocabulary.ts";

/** The gradeSeq a collected row carries: the first one the schema allows; grades follow it. */
export const COLLECTED_GRADE_SEQ = 1;
/** The longest slug a quota window id may be. */
const WINDOW_ID_MAX = 40;

/** Facts about this machine and checkout, recorded on every row and never compared. */
export interface MachineFacts {
  evalSha: string;
  os: string;
  hardwareClass: HardwareClass;
}

/** How the run was scheduled (Rule 21), recorded on its row. */
export interface ScheduleFacts {
  campaignId: string;
  kind: RowKind;
  interleaveSeed: string;
  concurrency: Concurrency;
  coRunLane: string | null;
  accountExclusive: AccountExclusive;
  /** This rep replaces a harness-failure row (§10.5). */
  replacement: boolean;
  /** This invocation resumed the campaign. */
  resumed: boolean;
}

/** Everything a collected row is assembled from. */
export interface RowInput {
  schedule: ScheduleFacts;
  machine: MachineFacts;
  lane: LaneRegistryRow;
  evalCase: EvalCase;
  /** The shared suffix and, for raw lanes, the deliverable text the lane was given. */
  instructions: { suffix: string; deliverable: string | null };
  result: LaneRunResult;
  report: EvalLaneReport | null;
  observation: RunObservation;
  metrics: RunMetrics;
  inApp: InAppSignals | null;
  snapshot: SnapshotFacts | null;
  appBuild: AppBuild | null;
  /** A canary's boot-only probe block and the renderer it ran on; null for a build. */
  canaryProbe: { probe: RowProbe; rendererMode: RendererMode } | null;
  streamSha256: string | null;
  /** The counted transcripts' digest; null when none was counted. */
  transcriptSha256: string | null;
  /** The run's evidence folder's `hashDir` (a canary's boot frames); null when none was kept. */
  evidenceSha256: string | null;
  /** What `validateProjectDir` says of the stop-time snapshot; unknown without one. */
  validate: CheckResult;
  supersededBy: string | null;
  campaignVoid: CampaignVoidReason | null;
  recordedAt: string;
}

/** The machine's own facts for the rows: the eval checkout's SHA, the OS and the hardware class. */
export function machineFacts(evalSha: string, platform: NodeJS.Platform = process.platform, arch = process.arch) {
  const hardware: Record<string, HardwareClass> = {
    "darwin-arm64": HardwareClass.AppleSilicon,
    "darwin-x64": HardwareClass.IntelMac,
    "linux-x64": HardwareClass.LinuxX64,
    "win32-x64": HardwareClass.WindowsX64,
  };
  const osName = `${platform}-${os.release()}`;
  return {
    evalSha,
    os: OS_PATTERN.test(osName) ? osName : `${platform}-unknown`,
    hardwareClass: hardware[`${platform}-${arch}`] ?? HardwareClass.Unknown,
  } satisfies MachineFacts;
}

/** A model id the schema accepts: the id itself, or with a context tag (`[1m]`) dropped; null otherwise. */
export function schemaModelId(id: string | null): string | null {
  if (id === null) return null;
  const bare = id.replace(/\[[^\]]*\]$/, "").toLowerCase();
  return MODEL_ID_PATTERN.test(bare) ? bare : null;
}

/** A quota window id as a slug (`five_hour` → `five-hour`, `model:opus` → `model-opus`). */
export function windowSlug(id: string): string {
  const slug = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, WINDOW_ID_MAX);
  return slug || "window";
}

const instantOrNull = (value: string | null): string | null => {
  if (value === null) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  const iso = new Date(at).toISOString();
  return INSTANT_PATTERN.test(iso) ? iso : null;
};

const percentOrNull = (value: number | null): number | null =>
  value !== null && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;

function schemaQuota(quota: readonly QuotaDelta[]): QuotaDelta[] {
  return quota.map((delta) => ({
    windowId: windowSlug(delta.windowId),
    before: percentOrNull(delta.before),
    after: percentOrNull(delta.after),
    resetsAtBefore: instantOrNull(delta.resetsAtBefore),
    resetsAtAfter: instantOrNull(delta.resetsAtAfter),
    resetInside: delta.resetInside,
  }));
}

/** Per-model usage keyed by schema model ids; an id the schema refuses is summed under nothing and dropped. */
function schemaByModel(byModel: Record<string, TokenUsage>): Record<string, TokenUsage> {
  const out: Record<string, TokenUsage> = {};
  for (const [id, usage] of Object.entries(byModel)) {
    const key = schemaModelId(id);
    if (key) out[key] = out[key] ? sumUsage([out[key], usage]) : usage;
  }
  return out;
}

function schemaServed(served: readonly ServedModel[]): ServedModel[] {
  return served.flatMap((model) => {
    const id = schemaModelId(model.id);
    return id ? [{ ...model, id }] : [];
  });
}

const EFFORTS: ReadonlySet<string> = new Set(Object.values(Effort));

function schemaEffort(value: Pinned<string>): Pinned<string> {
  if (typeof value !== "string") return value;
  return EFFORTS.has(value) ? value : unavailable(UnavailableReason.CliUnreported);
}

function cliVersionPin(version: string | null): Pinned<string> {
  if (version === null) return unavailable(UnavailableReason.NotRecorded);
  return VERSION_PATTERN.test(version) ? version : unavailable(UnavailableReason.ParseFailure);
}

/** The run's pins: what must match for two rows to compare (Genex-only ones are n/a on raw lanes). */
function runPins(input: RowInput): RunRow["pins"]["run"] {
  const { lane, appBuild, report, instructions } = input;
  const genex = lane.agent === EvalAgent.GenexApp;
  const seed = report?.harnessDigest.shipped ?? null;
  return {
    appSha: genex && appBuild ? appBuild.sha : NOT_APPLICABLE,
    buildId: genex && appBuild ? appBuild.sha : NOT_APPLICABLE,
    harnessSeedDigest: genex ? (seed ?? unavailable(UnavailableReason.NotRecorded)) : NOT_APPLICABLE,
    cliVersion: cliVersionPin(input.result.cliVersion),
    laneWrapperDigest: lane.flagsDigest,
    containmentDigest: containmentDigest(lane),
    instructionSha: textDigest(instructions.suffix, instructions.deliverable ?? ""),
  };
}

/** The digest of a lane's containment, network and browser pins. */
export function containmentDigest(lane: LaneRegistryRow): string {
  return textDigest(lane.containment, lane.network, lane.browser);
}

/** The lane's harness pin: its flags, its instructions and its containment (Rule 6). */
function harnessPin(input: RowInput): string {
  const pins = runPins(input);
  return textDigest(input.lane.flagsDigest, pins.instructionSha, pins.containmentDigest);
}

/** Grading pins before any grade: nothing graded yet, except a canary's boot probe. */
function gradingPins(input: RowInput): RunRow["pins"]["grading"] {
  const notYet = unavailable(UnavailableReason.NotRecorded);
  const canary = input.canaryProbe;
  return {
    proberVersion: canary ? PROBER_VERSION : notYet,
    soakMs: unavailable(UnavailableReason.ProbeSkipped),
    graderPromptSha: notYet,
    graderModels: [],
    pairwiseRubricSha: notYet,
    shimMode: ShimMode.None,
    rendererMode: canary ? canary.rendererMode : notYet,
    endpointsSha: ENDPOINTS_SHA,
  };
}

/** The in-app signals of a Genex run (§8.7), from its lane report and event log. */
function inAppBlock(input: RowInput): RowInApp | null {
  const { report, inApp } = input;
  if (!report) return null;
  const judges = input.observation.timeline.filter(
    (event) => event.kind === ObservationEventKind.ModelCall && event.session.role === ServedModelRole.Judge,
  );
  const judgeUsage = sumUsage(
    judges.flatMap((event) => (event.kind === ObservationEventKind.ModelCall ? [event.usage] : [])),
  );
  return {
    mode: report.modeServed,
    launch: report.launch,
    budgets: {
      completionPolicy: report.budgets.completionPolicy,
      wallClockMs: report.budgets.wallClockMs ?? null,
      untilSatisfied: report.budgets.untilSatisfied ?? null,
    },
    permissionMode: report.permissionModeServed,
    victory: inApp?.victory ?? null,
    executionStatus: inApp?.executionStatus ?? null,
    stopCode: inApp?.stopCode ?? null,
    livenessMax: inApp?.livenessMax ?? null,
    scoreboard: inApp?.scoreboard ?? null,
    judgeCalls: judges.length ? judges.length : null,
    judgeTokens: totalTokens(judgeUsage) > 0 ? judgeUsage : null,
    // The shipped seed's digest covers the in-app judges' rubrics; a rubric change moves it.
    inAppRubricDigest: report.harnessDigest.shipped,
  };
}

function notesOf(input: RowInput, effort: Pinned<string>): NoteCode[] {
  const { lane, schedule } = input;
  const notes: NoteCode[] = [];
  const add = (condition: boolean, note: NoteCode) => {
    if (condition) notes.push(note);
  };
  add(schedule.coRunLane !== null, NoteCode.CoRun);
  add(schedule.resumed, NoteCode.Resumed);
  add(schedule.replacement, NoteCode.ReplacementRep);
  add(input.instructions.deliverable !== null, NoteCode.RawDeliverableText);
  add(lane.containment === ContainmentPin.Contractor, NoteCode.ContainmentContractor);
  add(typeof effort !== "string", NoteCode.EffortUnreported);
  add(input.canaryProbe?.rendererMode === RendererMode.Software, NoteCode.SoftwareRenderer);
  add(input.result.answersGiven > 0, NoteCode.AnsweredQuestion);
  add(input.campaignVoid !== null, NoteCode.CampaignVoid);
  return notes;
}

/** The stop-time snapshot's no-build, or `no-entry` when the run never made a project folder (Rule 22). */
function noBuildOf(snapshot: SnapshotFacts | null): NoBuild | null {
  return snapshot ? snapshot.noBuild : NoBuild.NoEntry;
}

/** The first harness failure: the lane's own guards, then the observation's (token and served-model checks). */
export function harnessFailureOf(result: LaneRunResult, metrics: RunMetrics): HarnessFailure | null {
  return result.harnessFailure ?? metrics.harnessFailure;
}

/** Assemble a collected run's row, with its `gradeId`. */
export function assembleRunRow(input: RowInput): RunRow {
  const { lane, evalCase, observation, metrics, result, snapshot, schedule } = input;
  const effort = schemaEffort(metrics.effortServed);
  const provenance = observation.provenance;
  const row: RunRow = {
    schema: RUN_ROW_SCHEMA,
    runId: result.runId,
    campaignId: schedule.campaignId,
    recordedAt: input.recordedAt,
    gradeSeq: COLLECTED_GRADE_SEQ,
    gradeId: "",
    kind: schedule.kind,
    campaignVoid: input.campaignVoid,
    supersededBy: input.supersededBy,
    case: {
      id: evalCase.id,
      version: evalCase.version,
      checklistVersion: evalCase.checklistVersion,
      exposure: evalCase.exposure,
      visibility: evalCase.visibility,
    },
    lane: {
      id: lane.id,
      agent: lane.agent,
      engine: lane.engine,
      mode: lane.mode,
      modeServed: observation.modeServed ?? (lane.agent === EvalAgent.GenexApp ? null : LaneModeServed.RawCli),
      harnessPin: harnessPin(input),
      network: lane.network,
      browser: lane.browser,
      containment: lane.containment,
    },
    model: {
      requested: lane.model,
      main: schemaModelId(provenance.servedMain),
      served: schemaServed(metrics.served),
      effort: lane.effort,
      effortServed: effort,
    },
    pins: {
      run: runPins(input),
      grading: gradingPins(input),
      recorded: {
        evalSha: input.machine.evalSha,
        appDirty: input.appBuild?.dirty ?? false,
        os: input.machine.os,
        hardwareClass: input.machine.hardwareClass,
        concurrency: schedule.concurrency,
        coRunLane: schedule.coRunLane,
        interleaveSeed: schedule.interleaveSeed,
        accountExclusive: schedule.accountExclusive,
      },
    },
    outcome: {
      endedHow: result.endedHow,
      harnessFailure: harnessFailureOf(result, metrics),
      noBuild: noBuildOf(snapshot),
      questionsAsked: result.questionsAsked,
      answersGiven: result.answersGiven,
      traceComplete: provenance.traceComplete,
      providerNoise: provenance.providerNoise,
    },
    time: metrics.time,
    tokens: { ...metrics.tokens, byModel: schemaByModel(metrics.tokens.byModel) },
    context: metrics.context,
    calls: metrics.calls,
    cost: { ...metrics.cost, quota: schemaQuota(metrics.cost.quota) },
    output: {
      files: snapshot?.files ?? 0,
      bytes: snapshot?.bytes ?? 0,
      loc: snapshot?.loc ?? 0,
      hasEntry: snapshot?.hasEntry ?? false,
      buildScript: snapshot?.buildScript ?? false,
      validate: input.validate,
    },
    probe: input.canaryProbe?.probe ?? null,
    checklist: null,
    inApp: lane.agent === EvalAgent.GenexApp ? inAppBlock(input) : null,
    digests: {
      streamSha256: input.streamSha256,
      transcriptSha256: input.transcriptSha256,
      snapshotSha256: snapshot?.sha256 ?? null,
      evidenceSha256: input.evidenceSha256,
    },
    notes: notesOf(input, effort),
  };
  return withGradeId(row);
}

/** A row not yet written, carrying a campaign's void reason (and its note) from the start. */
export function withCampaignVoid(row: RunRow, reason: CampaignVoidReason): RunRow {
  const notes = row.notes.includes(NoteCode.CampaignVoid) ? row.notes : [...row.notes, NoteCode.CampaignVoid];
  return withGradeId({ ...row, campaignVoid: reason, notes });
}

/** The same run, voided (§8.1, Rule 24): a later `gradeSeq` carrying the reason, so `currentRows()` sees it. */
export function voidedRow(row: RunRow, reason: CampaignVoidReason, recordedAt: string): RunRow {
  return withCampaignVoid({ ...row, gradeSeq: row.gradeSeq + 1, recordedAt }, reason);
}

/** Whether a lane gets the deliverable text (raw lanes, the stated asymmetry). */
export function isRawLane(lane: LaneRegistryRow): boolean {
  return lane.agent !== EvalAgent.GenexApp;
}
