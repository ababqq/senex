/**
 * The grading pipeline (§8, "after all builds, under the probe lock"). Per run of a campaign:
 *
 * 1. the boot/playable scan over the run's snapshots (`boot-scan.ts`, short error windows);
 * 2. the final probe of the stop-time snapshot (the full prober; the quick probe on `--quick`),
 *    whose witnessed frames land in the grade's evidence folder (Rule 22: a typed no-build is never
 *    served or probed);
 * 3. the checklist, both families and the control item (`checklist/`);
 * 4. a new `gradeSeq` row: the collected row copied (a regrade is not an observation, Rule 10) with
 *    first boot/playable, the probe, the checklist and the grading pins filled, written through the
 *    ledger writer with its `gradeId`.
 *
 * Then, campaign-level, the pairwise judge over each case × rep's pairs (A,B), (D,C), (A,D), (B,C)
 * (and the auto lanes against their raw sibling), both orders, both families, seeded placement,
 * into the local ledger only. Nothing runs without a green calibration covering the current prober
 * and grader pins (§8.8); the quota guard runs before every batch. Every outside effect (server,
 * probe, grader model, lock, quota, clock) is injected, so a whole campaign grades hermetically.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SECOND_MS } from "../../../src/shared/duration.ts";
import { EngineId } from "../../../src/shared/providers.ts";
import type { BudgetStop } from "../budget.ts";
import {
  type CalibrationProber,
  calibrationCovers,
  type GradingVersions,
  selectCalibration,
} from "../calibrate/run.ts";
import type { EvalCase } from "../case-types.ts";
import { caseById } from "../cases.ts";
import { canonicalJson, hashDir, sha256Text, shortDigest } from "../ledger/hash.ts";
import type { EvalsPaths } from "../ledger/paths.ts";
import { currentRows, readPairwiseRows, readRunRows } from "../ledger/read.ts";
import {
  type GradingPins,
  isMeasured,
  type PairwiseRow,
  type RowLane,
  type RowTime,
  type RunRow,
  unavailable,
} from "../ledger/types.ts";
import { rowProbeOf } from "../prober/full-probe.ts";
import { appendLedgerRow, withGradeId } from "../ledger/write.ts";
import { ENDPOINTS_SHA } from "../report/endpoints.ts";
import type { Homes } from "../../transcript-census.ts";
import {
  Axis,
  CheckResult,
  Coverage,
  EvalAgent,
  LaneMode,
  NoBuild,
  NoteCode,
  RendererMode,
  RowKind,
  ServedVia,
  ShimMode,
  SnapshotKind,
  UnavailableReason,
} from "../vocabulary.ts";
import { readSnapshotIndex, scanSnapshots, snapshotFacts } from "../watch/snapshots.ts";
import { type BootScanOutcome, createBootScan, SCAN_BUDGET_MS, SCAN_MAX_PROBES } from "./boot-scan.ts";
import type { GraderComplete } from "./checklist/complete.ts";
import { vendorReady } from "./serve.ts";
import { createGradeChecklist } from "./checklist/grade.ts";
import { toRowChecklist } from "./checklist/score.ts";
import { createJudgePairwise, createPairwiseRows, type PairwiseRubric } from "./pairwise.ts";
import { QUICK_FIRST_DRAW_TIMEOUT_MS, QUICK_NO_ERRORS_MS, SCAN_FIRST_DRAW_TIMEOUT_MS } from "./quick-probe.ts";
import type {
  CalibrationResult,
  ChecklistResult,
  EvidenceRefs,
  FullProbeOptions,
  GraderPin,
  PairSide,
  PairwiseRequest,
  ProbeResult,
  RunFullProbe,
  QuickProbeOptions,
  RunQuickProbe,
  ServeHandle,
  ServeOptions,
  ServeSnapshot,
} from "./types.ts";

/** The folder inside a run's work root the snapshot watcher writes (`work/<runId>/snapshots`). */
export const SNAPSHOTS_DIR = "snapshots";
/**
 * The grade's own record inside its evidence folder: the scan, the probe and every item's votes.
 * The one file every later reader (regrade, pairwise, diagnostics, the human review) takes a
 * grade's checklist and frames from; see `gradeRecordPathIn`.
 */
export const GRADE_RECORD_FILE = "grade.json";
/** The grade record's schema id (a local artifact, never a ledger row). */
export const GRADE_RECORD_SCHEMA = "genex-evals/grade-record/1";
/** Where the scan probes and the final probe write inside a grade's evidence folder. */
export const SCAN_EVIDENCE_DIR = "scan";
export const FINAL_EVIDENCE_DIR = "final";
/** The error window of a scan probe: short, since only boot and playability are asked of it. */
export const SCAN_NO_ERRORS_MS = 5 * SECOND_MS;
/** Votes per family per item (§8.4). */
export const DEFAULT_VOTES_PER_FAMILY = 3;
/** Where calibration results are kept under the evals home, one JSON line per `calibrate`. */
export const CALIBRATION_DIR = "calibration";
export const CALIBRATION_FILE = "results.jsonl";
/** Hex characters of a pair's placement seed. */
const BLIND_SEED_CHARS = 16;

/** Why grading refused to start. */
export const GradeRefusal = {
  /** No calibration was ever recorded. */
  CalibrationMissing: "calibration-missing",
  /** The latest calibration is red, or was run for another prober, prompt or grader models. */
  CalibrationNotCovering: "calibration-not-covering",
  /** The campaign has no runs in the ledger. */
  NoRuns: "no-runs",
  /** The default vendor folder has no three.js: `npm run build` has not filled `dist/resources/vendor`. */
  VendorMissing: "vendor-missing",
} as const;
export type GradeRefusal = (typeof GradeRefusal)[keyof typeof GradeRefusal];

/** Why one run of a campaign was not graded. */
export const GradeSkip = {
  /** Its current grade already carries these grading pins. */
  AlreadyGraded: "already-graded",
  /** A canary or calibration row: canaries get their machine verdict in the campaign run. */
  NotABuild: "not-a-build",
  /** A harness failure is excluded from n and replaced (§10.5); it is never graded. */
  HarnessFailure: "harness-failure",
  /** The case is not in the case files. */
  CaseUnknown: "case-unknown",
  /** The case's frozen version moved since the run: its checklist is not the one the run was given. */
  CaseChanged: "case-changed",
  /** A Genex run whose app build (and so its `/vendor`) is not in the builds folder. */
  AppBuildMissing: "app-build-missing",
} as const;
export type GradeSkip = (typeof GradeSkip)[keyof typeof GradeSkip];

/** Everything grading reads from outside; the command binds the real ones, tests bind fakes. */
export interface GradingDeps {
  paths: EvalsPaths;
  /** Whose homes the ledger must stay out of (default: this user's). */
  homes?: Homes;
  cases: readonly EvalCase[];
  graders: GraderPin[];
  votesPerFamily: number;
  /** The prober version this grade runs under (`PROBER_VERSION`). */
  proberVersion: string;
  rendererMode: RendererMode;
  /**
   * The vendor folder served at `/vendor/**` for a run without an app build of its own (a raw lane,
   * a calibration fixture): the grading checkout's `dist/resources/vendor`.
   */
  vendorDir: string;
  /** A Genex run's own app build's vendor folder, by app SHA; null when that build is missing. */
  appVendorDir: (appSha: string) => Promise<string | null>;
  /** The npm cache a sandboxed rebuild may write. */
  npmCacheDir: string;
  serve: ServeSnapshot;
  /**
   * Whether the stop-time snapshot gets the quick probe (`grade --quick`) instead of the full prober
   * (M3). A quick grade carries `quick-grade`, pins no soak and can never be promoted; the first-boot
   * scan is quick either way.
   */
  quick: boolean;
  quickProbe: RunQuickProbe;
  fullProbe: RunFullProbe;
  complete: GraderComplete;
  rubric: PairwiseRubric;
  /** Hold the machine-wide probe lock for the whole call (Rule 11). */
  withLock: <T>(fn: () => Promise<T>) => Promise<T>;
  /** The quota guard before a batch: null to proceed, or why to stop. */
  quotaGate: () => Promise<BudgetStop | null>;
  /** The calibration that decides a grade under these versions (`selectCalibration`); null when none is recorded. */
  latestCalibration: (versions: GradingVersions) => Promise<CalibrationResult | null>;
  now: () => Date;
  /** A millisecond clock for the scan budget; defaults to `Date.now`. */
  clock?: () => number;
  /** Whether `full assets only:` items apply; paid generation is off (Rule 9), so false by default. */
  fullAssets?: boolean;
  /** The plugins a lane turns off, by lane id (the registry's `disabledPlugins`); none by default. */
  disabledPluginsOf?: (laneId: string) => readonly string[];
}

/** What one grade observed and decided, kept beside its evidence for regrades, pairwise and diagnostics. */
export interface GradeRecord {
  schema: typeof GRADE_RECORD_SCHEMA;
  runId: string;
  gradeSeq: number;
  recordedAt: string;
  proberVersion: string;
  scan: BootScanOutcome | null;
  probe: ProbeResult | null;
  checklist: ChecklistResult;
}

/** What grading a campaign did. */
export interface CampaignGrade {
  refused: GradeRefusal | null;
  graded: string[];
  skipped: Array<{ runId: string; reason: GradeSkip }>;
  /** Why the quota guard stopped grading, or null. */
  stop: BudgetStop | null;
  pairwiseRows: number;
}

/** Evidence with nothing in it: a run that was never probed. */
export const NO_EVIDENCE: EvidenceRefs = {
  projectOrigin: "",
  frames: [],
  consoleSummaryPath: "",
  networkSummaryPath: "",
  videoPath: null,
  summaryBytes: 0,
};

/** A grade's folder name inside its run's evidence folder. */
const gradeDirName = (gradeSeq: number) => `grade-${gradeSeq}`;

/** A grade's evidence folder: `evidence/<runId>/grade-<gradeSeq>`. */
export function gradeDirOf(paths: EvalsPaths, runId: string, gradeSeq: number): string {
  return path.join(paths.evidence, runId, gradeDirName(gradeSeq));
}

/** A grade's record, relative to its run's evidence folder: `grade-<gradeSeq>/grade.json`. */
export function gradeRecordPathIn(gradeSeq: number): string {
  return path.join(gradeDirName(gradeSeq), GRADE_RECORD_FILE);
}

/** A run's snapshot folder: `work/<runId>/snapshots`. */
export function snapshotDirOf(paths: EvalsPaths, runId: string): string {
  return path.join(paths.work, runId, SNAPSHOTS_DIR);
}

/** The next `gradeSeq` of a run: one past every grade the ledger holds for it. */
export function nextGradeSeq(rows: readonly RunRow[], runId: string): number {
  return Math.max(0, ...rows.filter((row) => row.runId === runId).map((row) => row.gradeSeq)) + 1;
}

/** The prompt sha a set of graders is pinned to, spelled as calibration records it. */
function promptShaOf(graders: readonly GraderPin[]): string {
  return [...new Set(graders.map((pin) => pin.promptSha))].join(",");
}

/** Why the deciding calibration does not allow grading with these pins, or null when it does. */
export async function calibrationRefusal(deps: GradingDeps): Promise<GradeRefusal | null> {
  const versions: GradingVersions = {
    proberVersion: deps.proberVersion,
    graderPromptSha: promptShaOf(deps.graders),
    graderModels: deps.graders.map((pin) => pin.model),
    quick: deps.quick,
  };
  const calibration = await deps.latestCalibration(versions);
  if (calibration === null) return GradeRefusal.CalibrationMissing;
  return calibrationCovers(calibration, versions) ? null : GradeRefusal.CalibrationNotCovering;
}

/** The grading pins a grade under these deps carries; the renderer and the soak are what the probe read back. */
export function gradingPinsFor(deps: GradingDeps, probe: ProbeResult | null): GradingPins {
  return {
    proberVersion: deps.proberVersion,
    // The quick probe has no soak (§8.2); the full prober pins the one it was configured with.
    soakMs: probe ? rowProbeOf(probe).soakMs : unavailable(UnavailableReason.ProbeSkipped),
    graderPromptSha: promptShaOf(deps.graders),
    graderModels: deps.graders.map((pin) => pin.model),
    pairwiseRubricSha: deps.rubric.sha,
    shimMode: ShimMode.None,
    rendererMode: probe ? probe.rendererMode : unavailable(UnavailableReason.ProbeSkipped),
    endpointsSha: ENDPOINTS_SHA,
  };
}

/** Why the default vendor folder cannot serve a template project, or null when it can. */
export async function vendorRefusal(deps: Pick<GradingDeps, "vendorDir">): Promise<GradeRefusal | null> {
  return (await vendorReady(deps.vendorDir)) ? null : GradeRefusal.VendorMissing;
}

/**
 * The vendor folder a run's project is served with, as the canary serves it: a Genex run with an app
 * build gets that build's own (its three.js and studio hook), anything else the default. Null when
 * the Genex run's build is missing: it is never served the checkout's vendor in its place.
 */
export async function vendorDirFor(row: RunRow, deps: GradingDeps): Promise<string | null> {
  const appSha = row.pins.run.appSha;
  const ownBuild = row.lane.agent === EvalAgent.GenexApp && isMeasured(appSha);
  return ownBuild ? deps.appVendorDir(appSha) : deps.vendorDir;
}

/** Whether two grading pin sets were graded under the same versions (renderer and soak are read back, not chosen). */
function sameGradingVersions(a: GradingPins, b: GradingPins): boolean {
  const pick = (pins: GradingPins) => ({
    proberVersion: pins.proberVersion,
    graderPromptSha: pins.graderPromptSha,
    graderModels: [...pins.graderModels].sort(),
    pairwiseRubricSha: pins.pairwiseRubricSha,
    shimMode: pins.shimMode,
    endpointsSha: pins.endpointsSha,
  });
  return canonicalJson(pick(a)) === canonicalJson(pick(b));
}

/** The case a row was run on, at the same frozen version, or why it cannot be graded. */
export function caseForRow(row: RunRow, cases: readonly EvalCase[]): EvalCase | GradeSkip {
  const evalCase = caseById(cases, row.case.id);
  if (!evalCase) return GradeSkip.CaseUnknown;
  const same = evalCase.version === row.case.version && evalCase.checklistVersion === row.case.checklistVersion;
  return same ? evalCase : GradeSkip.CaseChanged;
}

/** Whether a row's probe answers this grading: anything answers a quick grade, a quick probe never answers a full one. */
function probeKindAnswers(row: RunRow, deps: GradingDeps): boolean {
  return deps.quick || row.probe?.quick !== true;
}

/** Why a campaign run is left ungraded, or null. */
function skipReason(row: RunRow, deps: GradingDeps): GradeSkip | null {
  if (row.kind !== RowKind.Build) return GradeSkip.NotABuild;
  if (row.outcome.harnessFailure !== null) return GradeSkip.HarnessFailure;
  const sameVersions = sameGradingVersions(row.pins.grading, gradingPinsFor(deps, null));
  const graded = row.checklist !== null && sameVersions && probeKindAnswers(row, deps);
  if (graded) return GradeSkip.AlreadyGraded;
  const evalCase = caseForRow(row, deps.cases);
  return typeof evalCase === "string" ? evalCase : null;
}

/** Where a served snapshot finds the app's vendor files and its npm cache. */
type ServeSetting = Pick<GradingDeps, "vendorDir" | "npmCacheDir">;

/** The server options for one snapshot. */
function serveOptions(deps: ServeSetting, root: string): ServeOptions {
  return { root, vendorDir: deps.vendorDir, shimMode: ShimMode.None, npmCacheDir: deps.npmCacheDir };
}

/** First boot and first playable over the run's snapshots, with short scan probes. */
async function scanRun(row: RunRow, dir: string, deps: GradingDeps): Promise<BootScanOutcome> {
  const snapshotDir = snapshotDirOf(deps.paths, row.runId);
  const evidenceDir = path.join(dir, SCAN_EVIDENCE_DIR);
  await mkdir(evidenceDir, { recursive: true });
  const scan = createBootScan({ serve: deps.serve, probe: deps.quickProbe });
  return scan({
    snapshots: scanSnapshots(snapshotDir, await readSnapshotIndex(snapshotDir)),
    maxProbes: SCAN_MAX_PROBES,
    budgetMs: SCAN_BUDGET_MS,
    serve: serveOptions(deps, snapshotDir),
    probe: {
      firstDrawTimeoutMs: SCAN_FIRST_DRAW_TIMEOUT_MS,
      rendererMode: deps.rendererMode,
      noErrorsMs: SCAN_NO_ERRORS_MS,
      evidenceDir,
    },
    now: deps.clock,
  });
}

/** A final probe's options: the full first-draw wait and the quick error window (§8.2). */
function finalProbeOptions(rendererMode: RendererMode, evidenceDir: string, servedVia: ServedVia): QuickProbeOptions {
  return {
    firstDrawTimeoutMs: QUICK_FIRST_DRAW_TIMEOUT_MS,
    rendererMode,
    noErrorsMs: QUICK_NO_ERRORS_MS,
    evidenceDir,
    servedVia,
  };
}

/** A full probe's options: the full first-draw wait; the soak, error window and budget are the prober's own (§8.2). */
function fullProbeOptions(rendererMode: RendererMode, evidenceDir: string, servedVia: ServedVia): FullProbeOptions {
  return { firstDrawTimeoutMs: QUICK_FIRST_DRAW_TIMEOUT_MS, rendererMode, evidenceDir, servedVia };
}

/** What running a final probe reads: which probe, both probers and the renderer. */
type FinalProber = Pick<GradingDeps, "quick" | "quickProbe" | "fullProbe" | "rendererMode">;

/** The final probe this grading (or its calibration) runs: the quick probe on `--quick`, else the full prober. */
function runFinalProbe(
  deps: FinalProber,
  url: string,
  evidenceDir: string,
  servedVia: ServedVia,
): Promise<ProbeResult> {
  if (deps.quick) return deps.quickProbe(url, finalProbeOptions(deps.rendererMode, evidenceDir, servedVia));
  return deps.fullProbe(url, fullProbeOptions(deps.rendererMode, evidenceDir, servedVia));
}

/** The no-builds a stop-time snapshot types before any rebuild: nothing is served or probed (Rule 22). */
const TYPED_BEFORE_SERVE: ReadonlySet<NoBuild> = new Set([NoBuild.TemplateUntouched, NoBuild.NoEntry]);

/**
 * The stop-time no-build once this grade served the snapshot's copy (`noBuildAtStop`): a `no-dist`
 * snapshot is rebuilt, and a page clears it while a failed rebuild types itself (`build-failed`, or
 * `no-dist` when the build wrote no page). Every other no-build stands as collected.
 */
function noBuildAfterServe(stop: NoBuild | null, handle: ServeHandle): NoBuild | null {
  if (stop !== NoBuild.NoDist) return stop;
  if (handle.servedVia === ServedVia.Rebuilt) return null;
  if (handle.servedVia === ServedVia.RebuildFailed) return handle.noBuild ?? NoBuild.BuildFailed;
  return stop;
}

/** What the stop-time snapshot's serve and probe found: the probe (null when unknown) and the no-build. */
interface FinalObservation {
  probe: ProbeResult | null;
  noBuild: NoBuild | null;
}

/** The final probe of the stop-time snapshot; the probe is null when there is none or it could not be served (unknown). */
async function probeFinal(row: RunRow, dir: string, deps: GradingDeps): Promise<FinalObservation> {
  const unknown: FinalObservation = { probe: null, noBuild: row.outcome.noBuild };
  const snapshotDir = snapshotDirOf(deps.paths, row.runId);
  const final = (await readSnapshotIndex(snapshotDir)).find((entry) => entry.kind === SnapshotKind.Final);
  if (!final) return unknown;
  const evidenceDir = path.join(dir, FINAL_EVIDENCE_DIR);
  await mkdir(evidenceDir, { recursive: true });
  const handle = await deps.serve(serveOptions(deps, path.join(snapshotDir, final.name))).catch(() => null);
  if (handle === null) return unknown;
  const noBuild = noBuildAfterServe(row.outcome.noBuild, handle);
  try {
    // A copy whose rebuild failed is never "did not boot": it is not probed, and is unknown unless typed.
    if (handle.servedVia === ServedVia.RebuildFailed) return { probe: null, noBuild };
    return { probe: await runFinalProbe(deps, handle.url, evidenceDir, handle.servedVia), noBuild };
  } catch {
    return { probe: null, noBuild };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** What a grade saw of the run: the scan, the final probe and the stop-time no-build it settled. */
interface Observed extends FinalObservation {
  scan: BootScanOutcome | null;
}

/** Observe a run; a snapshot typed before any serve is never served or probed (Rule 22). */
async function observeRun(row: RunRow, dir: string, deps: GradingDeps): Promise<Observed> {
  const stop = row.outcome.noBuild;
  if (stop !== null && TYPED_BEFORE_SERVE.has(stop)) return { scan: null, probe: null, noBuild: stop };
  const scan = await scanRun(row, dir, deps);
  return { scan, ...(await probeFinal(row, dir, deps)) };
}

/** The row's timing with the scan's answers; a scan that did not finish narrows the coverage. */
function timeWithScan(time: RowTime, scan: BootScanOutcome | null): RowTime {
  const coverage = scan && time.coverage === Coverage.Full ? scan.coverage : time.coverage;
  return {
    ...time,
    firstBootMs: scan?.firstBootMs ?? null,
    firstPlayableMs: scan?.firstPlayableMs ?? null,
    firstPlayableResolutionMs: scan?.resolutionMs ?? null,
    coverage,
  };
}

/** The notes a grade owns: recomputed by every grade, never inherited from the one before. */
const GRADE_NOTES: ReadonlySet<NoteCode> = new Set([NoteCode.QuickGrade, NoteCode.SoftwareRenderer]);

/** The row's notes plus what this grade adds: a quick grade, and a software renderer when it ran on one. */
function notesWith(notes: readonly NoteCode[], probe: ProbeResult | null, quick: boolean): NoteCode[] {
  const added: NoteCode[] = [];
  if (quick) added.push(NoteCode.QuickGrade);
  if (probe?.rendererMode === RendererMode.Software) added.push(NoteCode.SoftwareRenderer);
  return [...new Set([...notes.filter((note) => !GRADE_NOTES.has(note)), ...added])];
}

/** Grade one run's checklist on what the final probe witnessed. */
function gradeChecklistOf(row: RunRow, evalCase: EvalCase, probe: ProbeResult | null, deps: GradingDeps) {
  const grade = createGradeChecklist({ complete: deps.complete, evidenceRoot: deps.paths.evidence });
  return grade({
    evalCase,
    evidence: probe?.evidence ?? NO_EVIDENCE,
    graders: deps.graders,
    votesPerFamily: deps.votesPerFamily,
    fullAssets: deps.fullAssets ?? false,
    noBuild: row.outcome.noBuild,
    runEngine: row.lane.engine,
  });
}

/** One run graded: the new row and the record beside its evidence. */
export interface GradedRun {
  row: RunRow;
  record: GradeRecord;
}

/**
 * Grade one run into `gradeSeq`: observe it (or reuse a retained record's scan and probe), grade
 * its checklist, keep the record, and append the new row. The collected observation is copied.
 */
export async function gradeRun(
  row: RunRow,
  evalCase: EvalCase,
  gradeSeq: number,
  deps: GradingDeps,
  reuse: GradeRecord | null = null,
): Promise<GradedRun> {
  const dir = gradeDirOf(deps.paths, row.runId, gradeSeq);
  await mkdir(dir, { recursive: true });
  // A reused record's grade already settled the no-build on the row it was taken from.
  const observed = reuse
    ? { scan: reuse.scan, probe: reuse.probe, noBuild: row.outcome.noBuild }
    : await observeRun(row, dir, deps);
  const graded: RunRow = { ...row, outcome: { ...row.outcome, noBuild: observed.noBuild } };
  const checklist = await gradeChecklistOf(graded, evalCase, observed.probe, deps);
  const recordedAt = deps.now().toISOString();
  const record: GradeRecord = {
    schema: GRADE_RECORD_SCHEMA,
    runId: row.runId,
    gradeSeq,
    recordedAt,
    proberVersion: deps.proberVersion,
    scan: observed.scan,
    probe: observed.probe,
    checklist,
  };
  await writeFile(path.join(dir, GRADE_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
  const next = withGradeId({
    ...graded,
    recordedAt,
    gradeSeq,
    pins: { ...row.pins, grading: gradingPinsFor(deps, observed.probe) },
    time: timeWithScan(row.time, observed.scan),
    probe: observed.probe ? rowProbeOf(observed.probe) : null,
    checklist: toRowChecklist(checklist),
    notes: notesWith(graded.notes, observed.probe, observed.probe ? observed.probe.quick : deps.quick),
    digests: { ...row.digests, evidenceSha256: await hashDir(dir) },
  });
  await appendLedgerRow(next, { paths: deps.paths, homes: deps.homes });
  return { row: next, record };
}

/** Whether a parsed JSON value is a grade record of this run and grade. */
function isGradeRecord(value: unknown, runId: string, gradeSeq: number): value is GradeRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<GradeRecord>;
  const checklist = record.checklist as Partial<ChecklistResult> | undefined;
  const shaped = record.schema === GRADE_RECORD_SCHEMA && Array.isArray(checklist?.items);
  return shaped && record.runId === runId && record.gradeSeq === gradeSeq;
}

/** A grade's retained record, or null when it is missing or not this grade's. */
export async function readGradeRecord(paths: EvalsPaths, runId: string, gradeSeq: number): Promise<GradeRecord | null> {
  const file = path.join(paths.evidence, runId, gradeRecordPathIn(gradeSeq));
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return isGradeRecord(value, runId, gradeSeq) ? value : null;
  } catch {
    return null;
  }
}

/** A campaign's current rows (the latest grade of each run). */
async function campaignRows(paths: EvalsPaths, campaignId: string): Promise<{ all: RunRow[]; current: RunRow[] }> {
  const all = await readRunRows(paths);
  return { all, current: currentRows(all).filter((row) => row.campaignId === campaignId) };
}

/** Grade every gradable run of the campaign, one quota-guarded batch per run. */
async function gradeRuns(campaignId: string, deps: GradingDeps, report: CampaignGrade): Promise<void> {
  const { all, current } = await campaignRows(deps.paths, campaignId);
  for (const row of current) {
    const skip = skipReason(row, deps);
    if (skip !== null) {
      report.skipped.push({ runId: row.runId, reason: skip });
      continue;
    }
    const vendorDir = await vendorDirFor(row, deps);
    if (vendorDir === null) {
      report.skipped.push({ runId: row.runId, reason: GradeSkip.AppBuildMissing });
      continue;
    }
    report.stop = await deps.quotaGate();
    if (report.stop !== null) return;
    const evalCase = caseForRow(row, deps.cases);
    if (typeof evalCase === "string") continue;
    await gradeRun(row, evalCase, nextGradeSeq(all, row.runId), { ...deps, vendorDir });
    report.graded.push(row.runId);
  }
}

/**
 * Grade a campaign (§8): refuse without a covering calibration, then, under the probe lock, grade
 * each run and judge the campaign's pairs. Resumable: a run already graded under these pins and a
 * pair already judged by these graders are skipped.
 */
export async function gradeCampaign(campaignId: string, deps: GradingDeps): Promise<CampaignGrade> {
  const report: CampaignGrade = { refused: null, graded: [], skipped: [], stop: null, pairwiseRows: 0 };
  report.refused = (await calibrationRefusal(deps)) ?? (await vendorRefusal(deps));
  if (report.refused !== null) return report;
  const { current } = await campaignRows(deps.paths, campaignId);
  if (current.length === 0) return { ...report, refused: GradeRefusal.NoRuns };
  return deps.withLock(async () => {
    await gradeRuns(campaignId, deps, report);
    if (report.stop !== null) return report;
    const pairs = await judgeCampaignPairs(campaignId, deps);
    return { ...report, pairwiseRows: pairs.rows, stop: pairs.stop };
  });
}

/** A lane's place in the 2×2 (§7.1): A Genex+Claude, B raw Claude, C raw Codex, D Genex+Codex, and the auto lanes. */
export const LaneSlot = {
  A: "a",
  B: "b",
  C: "c",
  D: "d",
  AAuto: "a-auto",
  DAuto: "d-auto",
} as const;
export type LaneSlot = (typeof LaneSlot)[keyof typeof LaneSlot];

/** The Genex lanes' slots, by engine and mode. */
const GENEX_SLOTS: Partial<Record<EngineId, Partial<Record<LaneMode, LaneSlot>>>> = {
  [EngineId.ClaudeCode]: { [LaneMode.ProductDefault]: LaneSlot.A, [LaneMode.Auto]: LaneSlot.AAuto },
  [EngineId.Codex]: { [LaneMode.ProductDefault]: LaneSlot.D, [LaneMode.Auto]: LaneSlot.DAuto },
};

/** A lane's slot, from its typed agent, engine and mode; null for a lane outside the 2x2. */
export function laneSlot(lane: RowLane): LaneSlot | null {
  if (lane.agent === EvalAgent.ClaudeCli) return LaneSlot.B;
  if (lane.agent === EvalAgent.CodexCli) return LaneSlot.C;
  return GENEX_SLOTS[lane.engine]?.[lane.mode] ?? null;
}

/** Which slots are paired, first against second, on which axis (§8.5). */
const PAIRINGS: ReadonlyArray<{ first: LaneSlot; second: LaneSlot; axis: Axis }> = [
  { first: LaneSlot.A, second: LaneSlot.B, axis: Axis.ProductDefault },
  { first: LaneSlot.D, second: LaneSlot.C, axis: Axis.ProductDefault },
  { first: LaneSlot.A, second: LaneSlot.D, axis: Axis.ModelStack },
  { first: LaneSlot.B, second: LaneSlot.C, axis: Axis.ModelStack },
  { first: LaneSlot.AAuto, second: LaneSlot.B, axis: Axis.ProductHarness },
  { first: LaneSlot.DAuto, second: LaneSlot.C, axis: Axis.ProductHarness },
];

/** One pair to judge. */
export interface PlannedPair {
  caseId: string;
  rep: number;
  axis: Axis;
  first: RunRow;
  second: RunRow;
  /** The recorded placement seed: which order each family sees first. */
  blindSeed: string;
}

/** A run's rep, from its id (`…-r<rep>`). */
export function repOf(runId: string): number {
  return Number(/-r(\d+)$/.exec(runId)?.[1] ?? 0);
}

/** Whether a row takes part in pairing: a build that counts (no harness failure, not replaced). */
function pairable(row: RunRow): boolean {
  return row.kind === RowKind.Build && row.outcome.harnessFailure === null && row.supersededBy === null;
}

/** A pair's placement seed, fixed by the campaign, the case, the rep and the two runs. */
function blindSeedOf(first: RunRow, second: RunRow): string {
  const text = [first.campaignId, first.case.id, repOf(first.runId), first.runId, second.runId].join(":");
  return createHash("sha256").update(text).digest("hex").slice(0, BLIND_SEED_CHARS);
}

/** The plugins a lane turns off, by lane id. */
export type DisabledPluginsOf = (laneId: string) => readonly string[];

const NO_PLUGINS_OFF: DisabledPluginsOf = () => [];

/**
 * Whether two runs may be judged against each other: two Genex lanes only with the same plugins
 * off (else the pair changes two variables), a raw lane, which has no plugins, with either.
 */
function samePlugins(a: RunRow, b: RunRow, disabledPluginsOf: DisabledPluginsOf): boolean {
  const bothGenex = a.lane.agent === EvalAgent.GenexApp && b.lane.agent === EvalAgent.GenexApp;
  if (!bothGenex) return true;
  const key = (row: RunRow) => [...disabledPluginsOf(row.lane.id)].sort().join(",");
  return key(a) === key(b);
}

/** The pairs of one case × rep group. */
function pairsOfGroup(rows: readonly RunRow[], disabledPluginsOf: DisabledPluginsOf): PlannedPair[] {
  const inSlot = (slot: LaneSlot) => rows.filter((row) => laneSlot(row.lane) === slot);
  const pairs: PlannedPair[] = [];
  for (const { first, second, axis } of PAIRINGS) {
    for (const a of inSlot(first)) {
      for (const b of inSlot(second)) {
        if (!samePlugins(a, b, disabledPluginsOf)) continue;
        const blindSeed = blindSeedOf(a, b);
        pairs.push({ caseId: a.case.id, rep: repOf(a.runId), axis, first: a, second: b, blindSeed });
      }
    }
  }
  return pairs;
}

/** Every pair a campaign's current rows give, per case × rep, in pairing order. */
export function planPairs(
  rows: readonly RunRow[],
  disabledPluginsOf: DisabledPluginsOf = NO_PLUGINS_OFF,
): PlannedPair[] {
  const groups = new Map<string, RunRow[]>();
  for (const row of rows.filter(pairable)) {
    const key = `${row.case.id}#${repOf(row.runId)}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].flatMap((group) => pairsOfGroup(group, disabledPluginsOf));
}

/** Whether every grader already judged this pair with this rubric. */
function alreadyJudged(existing: readonly PairwiseRow[], pair: PlannedPair, deps: GradingDeps): boolean {
  return deps.graders.every((pin) =>
    existing.some(
      (row) =>
        row.runIds.first === pair.first.runId &&
        row.runIds.second === pair.second.runId &&
        row.pairwiseRubricSha === deps.rubric.sha &&
        row.family === pin.family &&
        row.graderModel === pin.model,
    ),
  );
}

/** One side of a pair: its lane, the evidence its current grade witnessed and its typed no-build. */
async function pairSide(row: RunRow, deps: GradingDeps): Promise<PairSide> {
  const record = await readGradeRecord(deps.paths, row.runId, row.gradeSeq);
  const evidence = record?.probe?.evidence ?? NO_EVIDENCE;
  return { runId: row.runId, laneId: row.lane.id, evidence, noBuild: row.outcome.noBuild };
}

/** The pairwise grade's identity: the campaign, its sequence, the rubric, the graders and when. */
function pairwiseGrade(campaignId: string, existing: readonly PairwiseRow[], deps: GradingDeps) {
  const gradeSeq = Math.max(0, ...existing.map((row) => row.gradeSeq)) + 1;
  const recordedAt = deps.now().toISOString();
  const identity = { campaignId, gradeSeq, rubric: deps.rubric.sha, graders: deps.graders, recordedAt };
  return { gradeSeq, recordedAt, gradeId: shortDigest(sha256Text(canonicalJson(identity))) };
}

/** The checklist graders, pinned to the pairwise rubric instead of the checklist template. */
function pairwiseGraders(deps: GradingDeps): GraderPin[] {
  return deps.graders.map((pin) => ({ ...pin, promptSha: deps.rubric.sha }));
}

/** Judge one pair and append its rows; returns how many rows it wrote. */
async function judgePair(pair: PlannedPair, evalCase: EvalCase, grade: PairGrade, deps: GradingDeps): Promise<number> {
  const request: PairwiseRequest = {
    evalCase,
    first: await pairSide(pair.first, deps),
    second: await pairSide(pair.second, deps),
    graders: pairwiseGraders(deps),
    blindSeed: pair.blindSeed,
    pairwiseRubricSha: deps.rubric.sha,
  };
  const judge = createJudgePairwise({
    complete: deps.complete,
    evidenceRoot: deps.paths.evidence,
    rubric: deps.rubric,
  });
  const verdicts = await judge(request);
  const engines = { first: pair.first.lane.engine, second: pair.second.lane.engine };
  const toRows = createPairwiseRows({ ...grade, rep: pair.rep, axis: pair.axis, engines });
  const rows = toRows(request, verdicts, pair.first.campaignId);
  for (const row of rows) await appendLedgerRow(row, { paths: deps.paths, homes: deps.homes });
  return rows.length;
}

/** The identity every pairwise row of one grading pass shares. */
type PairGrade = ReturnType<typeof pairwiseGrade>;

/** Judge the campaign's unjudged pairs of graded runs, one quota-guarded batch per pair. */
export async function judgeCampaignPairs(
  campaignId: string,
  deps: GradingDeps,
): Promise<{ rows: number; stop: BudgetStop | null }> {
  const { current } = await campaignRows(deps.paths, campaignId);
  const existing = (await readPairwiseRows(deps.paths)).filter((row) => row.campaignId === campaignId);
  const grade = pairwiseGrade(campaignId, existing, deps);
  let rows = 0;
  const graded = current.filter((row) => row.checklist !== null);
  for (const pair of planPairs(graded, deps.disabledPluginsOf)) {
    const evalCase = caseById(deps.cases, pair.caseId);
    if (!evalCase || alreadyJudged(existing, pair, deps)) continue;
    const stop = await deps.quotaGate();
    if (stop !== null) return { rows, stop };
    rows += await judgePair(pair, evalCase, grade, deps);
  }
  return { rows, stop: null };
}

/** The calibration store's file under an evals home. */
export function calibrationFile(paths: EvalsPaths): string {
  return path.join(paths.home, CALIBRATION_DIR, CALIBRATION_FILE);
}

/** Append one calibration result to the store. */
export async function recordCalibration(paths: EvalsPaths, result: CalibrationResult): Promise<void> {
  const file = calibrationFile(paths);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(result)}\n`, { flag: "a" });
}

/** A calibration line as recorded: one written before the probe kind was recorded has no `quick`. */
type RecordedCalibration = Omit<CalibrationResult, "quick"> & { quick?: boolean };

/** Whether a parsed line is a calibration result. */
function isCalibrationResult(value: unknown): value is RecordedCalibration {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Partial<CalibrationResult>;
  const models = Array.isArray(result.graderModels) && result.graderModels.every((m) => typeof m === "string");
  const texts = typeof result.proberVersion === "string" && typeof result.graderPromptSha === "string";
  const kind = result.quick === undefined || typeof result.quick === "boolean";
  return models && texts && kind && typeof result.ok === "boolean" && Array.isArray(result.checks);
}

/** One recorded line as a calibration result; an unreadable line is none. */
function parseCalibration(line: string): CalibrationResult | null {
  try {
    const value: unknown = JSON.parse(line);
    return isCalibrationResult(value) ? { ...value, quick: value.quick ?? true } : null;
  } catch {
    return null;
  }
}

/**
 * Every recorded calibration in recording order; a missing store is none and an unreadable line
 * is skipped. A line without a probe kind predates it, when calibration only ran the quick probe.
 */
export async function readCalibrations(paths: EvalsPaths): Promise<CalibrationResult[]> {
  const text = await readFile(calibrationFile(paths), "utf8").catch(() => "");
  return text
    .split("\n")
    .map(parseCalibration)
    .filter((line): line is CalibrationResult => line !== null);
}

/**
 * The newest recorded calibration, or with `versions` the one that decides a grade under them
 * (`selectCalibration`); null when none is recorded (grading refuses).
 */
export async function readLatestCalibration(
  paths: EvalsPaths,
  versions?: GradingVersions,
): Promise<CalibrationResult | null> {
  const lines = await readCalibrations(paths);
  return versions ? selectCalibration(lines, versions) : (lines.at(-1) ?? null);
}

/** What the calibration prober is built from (§8.8): the grading server and probers, and the template's digest. */
export interface CalibrationProberDeps extends ServeSetting, FinalProber {
  serve: ServeSnapshot;
  /** `workspaceDigest` of the project template as calibration copies it, so its untouched copy is typed. */
  templateDigest: string;
  /** A fresh folder under the evidence root; each fixture's frames go to `<evidenceDir>/<fixture>`. */
  evidenceDir: string;
}

/**
 * The calibration prober (`CalibrationProber`): type the fixture's no-build from its stop facts, as a
 * run's stop-time snapshot is, then serve it (a failed rebuild types itself: `build-failed` or `no-dist`)
 * and probe it with the probe grades will use (`runFinalProbe`: the full prober, or the quick probe).
 */
export function createCalibrationProber(deps: CalibrationProberDeps): CalibrationProber {
  return async (fixture, dir) => {
    const facts = await snapshotFacts(dir, { templateDigest: deps.templateDigest });
    if (facts.noBuild !== null && TYPED_BEFORE_SERVE.has(facts.noBuild))
      return { l2: CheckResult.Unknown, noBuild: facts.noBuild, evidence: null };
    const handle = await deps.serve(serveOptions(deps, dir));
    try {
      if (handle.servedVia === ServedVia.RebuildFailed)
        return { l2: CheckResult.Unknown, noBuild: handle.noBuild ?? NoBuild.BuildFailed, evidence: null };
      const evidenceDir = path.join(deps.evidenceDir, fixture);
      await mkdir(evidenceDir, { recursive: true });
      const probe = await runFinalProbe(deps, handle.url, evidenceDir, handle.servedVia);
      return { l2: probe.l2Gate, noBuild: null, evidence: probe.evidence };
    } finally {
      await handle.close().catch(() => {});
    }
  };
}
