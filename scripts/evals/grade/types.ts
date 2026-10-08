/**
 * The grading contracts (§8): evidence references, the boot and quick-probe results, checklist and
 * pairwise verdicts, calibration, and the static server handle. The function signatures the
 * prober (`probe*`), the server (`serve`), the graders and the calibration runner implement are
 * exported as type aliases so their owners and the campaign integrator agree before any of them
 * exists. Types only.
 */
import type { TokenUsage } from "../../../src/shared/eval-lane.ts";
import type { EngineId } from "../../../src/shared/providers.ts";
import type { AcceptanceItem, EvalCase } from "../case-types.ts";
import type { FamilyVerdicts, PairwiseRow } from "../ledger/types.ts";
import type { DarkPhaseReview } from "../prober/dark-phase.ts";
import type { Check } from "../prober/types.ts";
import type { JudgeEvidenceVerdict } from "../prober/verdicts.ts";
import type {
  CalibrationFixture,
  CheckResult,
  ChecklistVote,
  EntranceVia,
  GraderFamily,
  GraderVoid,
  ItemVerdict,
  NoBuild,
  PairFacet,
  PairOrder,
  PairPick,
  ProbePhase,
  ProbeRow,
  RendererMode,
  ServedVia,
  ShimMode,
} from "../vocabulary.ts";

/** A frame the prober witnessed: after the entrance and first render, on the project's origin (Rule 18). */
export interface FrameRef {
  path: string;
  /** Milliseconds after the page was opened. */
  atMs: number;
  phase: ProbePhase;
  /** The origin the frame was taken on; a frame off the project's origin is never evidence. */
  origin: string;
  width: number;
  height: number;
}

/** Everything a grader may see: witnessed frames and bounded console and network summaries. */
export interface EvidenceRefs {
  /** The origin the project was served on; a frame on any other origin is never evidence. */
  projectOrigin: string;
  frames: FrameRef[];
  consoleSummaryPath: string;
  networkSummaryPath: string;
  videoPath: string | null;
  /** The size cap the summaries were cut to (4 kB each). */
  summaryBytes: number;
}

/** How a snapshot is served: over which folder, with which shim mode, and where the app's vendor files are. */
export interface ServeOptions {
  root: string;
  vendorDir: string;
  shimMode: ShimMode;
  /** The npm cache the sandboxed install may write to. */
  npmCacheDir: string;
}

/** A running static server over one snapshot copy. */
export interface ServeHandle {
  url: string;
  origin: string;
  root: string;
  servedVia: ServedVia;
  /**
   * How the copy's own build typed a snapshot it could not serve a page from (`build-failed`, or
   * `no-dist` when the build ran and wrote no page); null whenever there is a page.
   */
  noBuild: NoBuild | null;
  close(): Promise<void>;
}

/** What the boot probe may spend. */
export interface BootProbeOptions {
  /** The wait for the first non-degenerate draw (20 s in a scan, 120 s for the final probe). */
  firstDrawTimeoutMs: number;
  rendererMode: RendererMode;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Where the boot frame is written; without it the result carries no frames. */
  evidenceDir?: string;
  /** How the server served the snapshot; the prober only reports it (default `as-is`). */
  servedVia?: ServedVia;
}

/** Did it boot: a non-degenerate canvas with no uncaught error before the first draw. */
export interface BootProbeResult {
  booted: CheckResult;
  firstRenderMs: number | null;
  uncaughtBeforeFirstDraw: boolean;
  degenerateCanvas: boolean;
  rendererMode: RendererMode;
  servedVia: ServedVia;
  consoleErrors: number;
  frames: FrameRef[];
}

/** What the quick probe may spend and how it enters the project. */
export interface QuickProbeOptions extends BootProbeOptions {
  /** How long the project must run without an uncaught error (`l1.no_errors_60s`). */
  noErrorsMs: number;
  /** Where frames and summaries are written. */
  evidenceDir: string;
}

/** The M2 quick probe's rows and the evidence it witnessed (§8.2). */
export interface QuickProbeResult {
  rows: Partial<Record<ProbeRow, CheckResult>>;
  l1Gate: CheckResult;
  l2Gate: CheckResult;
  /** `l1 != fail && l2 != fail`. */
  scored: boolean;
  entrance: EntranceVia;
  firstRenderMs: number | null;
  fpsMedian: number | null;
  consoleErrors: number;
  rendererMode: RendererMode;
  servedVia: ServedVia;
  evidence: EvidenceRefs;
  proberVersion: string;
  /** The window `l1.no_errors_60s` actually covered: a scan probe runs a short one. */
  noErrorsMs: number;
  quick: true;
}

/** What the full prober (§8.2, `prober/full-probe.ts`) may spend and how it plays. */
export interface FullProbeOptions extends BootProbeOptions {
  /** Where frames, summaries, the timeline and the scorecard are written. */
  evidenceDir: string;
  /** The soak to run: `SPEC_SOAK_MS` unless a caller chooses a shorter local loop deliberately. The pin. */
  soakMs?: number;
  /** The seeded autoplay stream's seed. */
  seed?: number;
  fpsFloor?: number;
  ackWindowMs?: number;
  /** The whole probe's budget; defaults to `probeBudgetMs(soakMs)`. */
  budgetMs?: number;
  /** Run the phone pass (default true). */
  mobile?: boolean;
  /** The operator's review of the darkest playable phase, for `l3.dark_phase`. */
  darkPhaseReview?: DarkPhaseReview;
}

/** The full prober's rows, gates, evidence and the soak it ran (§8.2). */
export interface FullProbeResult extends Omit<QuickProbeResult, "quick"> {
  quick: false;
  l3Gate: CheckResult;
  checks: Check[];
  /** The configured soak: the `soakMs` pin two grades must share to compare. */
  soakMs: number;
  /** The soak that actually ran; `null` when the canvas never drew and no soak ran. */
  soakRanMs: number | null;
  seed: number;
  /** Whether the witnessed frames are worth a judge's time. */
  judgeEvidence: JudgeEvidenceVerdict;
  scorecardPath: string;
}

/** Either probe's result: what the grading pipeline holds. */
export type ProbeResult = QuickProbeResult | FullProbeResult;

/** The first-boot / first-playable scan over a run's snapshots (§8.3). */
export interface BootScanOptions {
  /** Snapshot folders in time order, each with its offset from the prompt. */
  snapshots: Array<{ dir: string; atMs: number }>;
  maxProbes: number;
  budgetMs: number;
  serve: ServeOptions;
  probe: QuickProbeOptions;
  now?: () => number;
}

/** How the scan searched and what it found. */
export interface BootScanResult {
  firstBootMs: number | null;
  firstPlayableMs: number | null;
  /** The snapshot interval the answer resolved to. */
  resolutionMs: number | null;
  search: { method: "coarse-to-fine"; probes: number; capped: boolean };
  /** Per snapshot probed: how it was served and whether it booted. */
  probed: Array<{ atMs: number; servedVia: ServedVia; booted: CheckResult; playable: CheckResult }>;
}

/** One grader call: which family and model, and the pinned prompt template. */
export interface GraderPin {
  family: GraderFamily;
  engine: EngineId;
  model: string;
  effort: string;
  /** sha256 of the prompt template, never of the evidence. */
  promptSha: string;
}

/** One family's votes on one item. */
export interface FamilyVotes {
  family: GraderFamily;
  model: string;
  votes: ChecklistVote[];
  decided: number;
  verdict: ItemVerdict;
  sameFamily: boolean;
  usage: TokenUsage;
}

/** One acceptance item's verdict across families (§8.4). */
export interface ChecklistItemVerdict {
  item: AcceptanceItem;
  byFamily: FamilyVotes[];
  verdicts: FamilyVerdicts;
  combined: ItemVerdict;
}

/** A run's checklist grade. */
export interface ChecklistResult {
  items: ChecklistItemVerdict[];
  scoreAllRuns: number;
  scoreGraded: number | null;
  inconclusiveRate: number;
  judgeSkipped: boolean;
  graderVoid: GraderVoid | null;
  graders: GraderPin[];
  usage: TokenUsage;
}

/** What the checklist grader needs: the case, the evidence, the two families and the vote count. */
export interface ChecklistGradeRequest {
  evalCase: EvalCase;
  evidence: EvidenceRefs;
  graders: GraderPin[];
  votesPerFamily: number;
  /** The run had full assets, so `full assets only:` items are graded; false skips them (`assets: none`). */
  fullAssets: boolean;
  noBuild: NoBuild | null;
  /** The engine that built the run (null for none), so a grader of the same family is marked `sameFamily`. */
  runEngine: EngineId | null;
}

/** One pairwise judgement in one order (§8.5). */
export interface PairwiseVerdict {
  order: PairOrder;
  grader: GraderPin;
  picks: Record<PairFacet, PairPick>;
  /** Whether the reply parsed; an invalid reply is typed, never a tie. */
  valid: boolean;
  /** Made without a call because a side's evidence was insufficient (a failed call is `valid: false` only). */
  judgeSkipped: boolean;
  /** Made without a call because exactly one side shipped a typed no-build: the other side wins. */
  forfeit: boolean;
  usage: TokenUsage;
}

/** One side of a pair: its run, its lane, the evidence its grade witnessed and its typed no-build. */
export interface PairSide {
  runId: string;
  laneId: string;
  evidence: EvidenceRefs;
  noBuild: NoBuild | null;
}

/** What the pairwise judge needs. */
export interface PairwiseRequest {
  evalCase: EvalCase;
  first: PairSide;
  second: PairSide;
  graders: GraderPin[];
  blindSeed: string;
  pairwiseRubricSha: string;
}

/** One calibration fixture's expectation and outcome. */
export interface CalibrationCheck {
  fixture: CalibrationFixture;
  expected: { l2: CheckResult; checklistMax: number; noBuild: NoBuild | null };
  actual: { l2: CheckResult; checklist: number | null; noBuild: NoBuild | null };
  ok: boolean;
}

/** Calibration over every fixture for the current prober and grader versions (§8.8). */
export interface CalibrationResult {
  proberVersion: string;
  graderPromptSha: string;
  graderModels: string[];
  checks: CalibrationCheck[];
  ok: boolean;
  recordedAt: string;
  /** Whether the fixtures went through the quick probe (`calibrate --quick`) rather than the full prober. */
  quick: boolean;
}

/** Serve one snapshot copy (builds inside `ProcessSandbox`). Owner: `grade/serve.ts`. */
export type ServeSnapshot = (options: ServeOptions) => Promise<ServeHandle>;
/** Boot-probe a served page. Owner: `prober/`. */
export type ProbeBoot = (url: string, options: BootProbeOptions) => Promise<BootProbeResult>;
/** Run the quick probe over a served page. Owner: `grade/quick-probe.ts`. */
export type RunQuickProbe = (url: string, options: QuickProbeOptions) => Promise<QuickProbeResult>;
/** Run the full probe over a served page. Owner: `prober/full-probe.ts`. */
export type RunFullProbe = (url: string, options: FullProbeOptions) => Promise<FullProbeResult>;
/** Find first boot and first playable over a run's snapshots. Owner: `grade/boot-scan.ts`. */
export type ScanBoot = (options: BootScanOptions) => Promise<BootScanResult>;
/** Grade one run's checklist. Owner: `grade/checklist/`. */
export type GradeChecklist = (request: ChecklistGradeRequest) => Promise<ChecklistResult>;
/** Judge one pair in both orders per family. Owner: `grade/pairwise.ts`. */
export type JudgePairwise = (request: PairwiseRequest) => Promise<PairwiseVerdict[]>;
/** Turn pairwise verdicts into ledger rows. Owner: `grade/pairwise.ts`. */
export type PairwiseRows = (request: PairwiseRequest, verdicts: PairwiseVerdict[], campaignId: string) => PairwiseRow[];
/** Run calibration over the fixtures. Owner: `calibrate/`. */
export type RunCalibration = (fixturesDir: string, graders: GraderPin[]) => Promise<CalibrationResult>;
