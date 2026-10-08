/**
 * A synthetic four-lane campaign for the grading tests: collected `gradeSeq` 1 rows (A–D lanes of
 * one case), snapshot folders with their index, and fakes for the server, the quick probe and the
 * grader model. Every value is invented; nothing touches a browser, a provider or the network.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { EndedHow, ZERO_TOKEN_USAGE } from "../../../../src/shared/eval-lane.ts";
import { EngineId } from "../../../../src/shared/providers.ts";
import type { AcceptanceItem, EvalCase } from "../../../../scripts/evals/case-types.ts";
import type { GraderComplete } from "../../../../scripts/evals/grade/checklist/complete.ts";
import { defaultGraderPins } from "../../../../scripts/evals/grade/checklist/family.ts";
import { CHECKLIST_PROMPT_SHA } from "../../../../scripts/evals/grade/checklist/prompt.ts";
import { readPairwiseRubric } from "../../../../scripts/evals/grade/pairwise.ts";
import { VENDOR_ENTRY } from "../../../../scripts/evals/grade/serve.ts";
import type { GradingDeps } from "../../../../scripts/evals/grade/pipeline.ts";
import type {
  CalibrationResult,
  FrameRef,
  FullProbeOptions,
  QuickProbeOptions,
  QuickProbeResult,
  RunFullProbe,
  RunQuickProbe,
  ServeOptions,
  ServeSnapshot,
} from "../../../../scripts/evals/grade/types.ts";
import { type EvalsPaths, evalsPaths } from "../../../../scripts/evals/ledger/paths.ts";
import { NOT_APPLICABLE, RUN_ROW_SCHEMA, type RowLane, type RunRow } from "../../../../scripts/evals/ledger/types.ts";
import { appendLedgerRow, withGradeId } from "../../../../scripts/evals/ledger/write.ts";
import { PROBER_VERSION } from "../../../../scripts/evals/prober/types.ts";
import { JudgeEvidenceClause } from "../../../../scripts/evals/prober/verdicts.ts";
import { defaultHomes } from "../../../../scripts/transcript-census.ts";
import { tmpDir } from "../../../helpers/tmp.ts";
import {
  AccountExclusive,
  BrowserPin,
  CaseExposure,
  CaseMode,
  CaseVisibility,
  CheckResult,
  Concurrency,
  ContainmentPin,
  Coverage,
  EntranceVia,
  EvalAgent,
  HardwareClass,
  LaneMode,
  NetworkPin,
  NoBuild,
  ProbePhase,
  ProbeRow,
  RendererMode,
  RowKind,
  ServedVia,
  ShimMode,
  SnapshotKind,
} from "../../../../scripts/evals/vocabulary.ts";

/** The campaign every synthetic row belongs to. */
export const CAMPAIGN = "20261001T120000-grading-fixture";
/** The one case the campaign ran. */
export const CASE_ID = "grading-case";
/** The absurd control item's text; the fake grader never says yes to it. */
export const CONTROL_TEXT = "a dragon reads the score aloud";
/** The origin the fake server serves on. */
export const PROJECT_ORIGIN = "http://127.0.0.1:43111";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function item(index: number, text: string, control = false): AcceptanceItem {
  return { id: `${CASE_ID}-0${index}`, text, tracesTo: null, key: false, assetsOnly: false, control };
}

/** The synthetic case: three items and the control. */
export const gradingCase: EvalCase = {
  id: CASE_ID,
  number: 91,
  label: "grading fixture",
  brief: "A synthetic brief: a square that moves with the arrow keys.",
  mode: CaseMode.Build,
  exposure: CaseExposure.None,
  exposureReason: null,
  visibility: CaseVisibility.Public,
  acceptance: [
    item(1, "a square is drawn"),
    item(2, "the square moves with the arrows"),
    item(3, "the square stays on screen"),
    item(4, CONTROL_TEXT, true),
  ],
  followUps: [],
  deadlineMin: 30,
  version: "0a0a0a0a0a0a",
  checklistVersion: "0b0b0b0b0b0b",
  startFrom: null,
};

/** The four primary lanes, A–D, as rows carry them. */
export const LANES: Readonly<Record<"a" | "b" | "c" | "d", RowLane>> = {
  a: {
    id: "genex-claude",
    agent: EvalAgent.GenexApp,
    engine: EngineId.ClaudeCode,
    mode: LaneMode.ProductDefault,
    modeServed: null,
    harnessPin: "1a1a1a1a1a1a",
    network: NetworkPin.ContractorOff,
    browser: BrowserPin.Studio,
    containment: ContainmentPin.App,
  },
  b: {
    id: "raw-claude",
    agent: EvalAgent.ClaudeCli,
    engine: EngineId.ClaudeCode,
    mode: LaneMode.RawCli,
    modeServed: null,
    harnessPin: "2b2b2b2b2b2b",
    network: NetworkPin.AutoClassifier,
    browser: BrowserPin.LookAtPage,
    containment: ContainmentPin.MainAgent,
  },
  c: {
    id: "raw-codex",
    agent: EvalAgent.CodexCli,
    engine: EngineId.Codex,
    mode: LaneMode.RawCli,
    modeServed: null,
    harnessPin: "3c3c3c3c3c3c",
    network: NetworkPin.On,
    browser: BrowserPin.LookAtPage,
    containment: ContainmentPin.MainAgent,
  },
  d: {
    id: "genex-codex",
    agent: EvalAgent.GenexApp,
    engine: EngineId.Codex,
    mode: LaneMode.ProductDefault,
    modeServed: null,
    harnessPin: "4d4d4d4d4d4d",
    network: NetworkPin.ContractorOff,
    browser: BrowserPin.Studio,
    containment: ContainmentPin.App,
  },
};

/** The run id of one lane's rep. */
export const runIdOf = (lane: RowLane, rep = 1, caseId = CASE_ID): string =>
  `20261001T120000-${lane.id}-${caseId}-r${rep}`;

/** What a synthetic collected row varies by. */
export interface CollectedRowSpec {
  lane: RowLane;
  rep?: number;
  noBuild?: NoBuild | null;
  patch?: Partial<RunRow>;
}

/** The collected (`gradeSeq` 1) row of one run: no probe, no checklist, grading pins not yet set. */
export function collectedRow(spec: CollectedRowSpec): RunRow {
  const row: RunRow = {
    schema: RUN_ROW_SCHEMA,
    runId: runIdOf(spec.lane, spec.rep ?? 1),
    campaignId: CAMPAIGN,
    recordedAt: "2026-10-01T13:00:00Z",
    gradeSeq: 1,
    gradeId: "000000000000",
    kind: RowKind.Build,
    campaignVoid: null,
    supersededBy: null,
    case: {
      id: CASE_ID,
      version: gradingCase.version,
      checklistVersion: gradingCase.checklistVersion,
      exposure: CaseExposure.None,
      visibility: CaseVisibility.Public,
    },
    lane: spec.lane,
    model: { requested: "fixture", main: "fixture", served: [], effort: "high", effortServed: "high" },
    pins: {
      run: {
        appSha: NOT_APPLICABLE,
        buildId: NOT_APPLICABLE,
        harnessSeedDigest: NOT_APPLICABLE,
        cliVersion: "1.0.0",
        laneWrapperDigest: "5e5e5e5e5e5e",
        containmentDigest: "6f6f6f6f6f6f",
        instructionSha: "7a7a7a7a7a7a",
      },
      grading: {
        proberVersion: NOT_APPLICABLE,
        soakMs: NOT_APPLICABLE,
        graderPromptSha: NOT_APPLICABLE,
        graderModels: [],
        pairwiseRubricSha: NOT_APPLICABLE,
        shimMode: ShimMode.None,
        rendererMode: NOT_APPLICABLE,
        endpointsSha: "8b8b8b8b8b8b",
      },
      recorded: {
        evalSha: "9c9c9c9c9c9c9c9c",
        appDirty: false,
        os: "darwin-25.6.0",
        hardwareClass: HardwareClass.AppleSilicon,
        concurrency: Concurrency.OnePerProvider,
        coRunLane: null,
        interleaveSeed: "7",
        accountExclusive: AccountExclusive.Unattested,
      },
    },
    outcome: {
      endedHow: EndedHow.AgentFinished,
      harnessFailure: null,
      noBuild: spec.noBuild ?? null,
      questionsAsked: 0,
      answersGiven: 0,
      traceComplete: { parseFailures: 0, truncatedTail: false },
      providerNoise: { apiErrors: 0, retries: 0, apiErrorStatus: null },
    },
    time: {
      wallMs: 600_000,
      toDoneMs: 600_000,
      firstBootMs: null,
      firstPlayableMs: null,
      firstPlayableResolutionMs: null,
      firstPreviewMs: null,
      delegationP50Ms: null,
      builds: [],
      coverage: Coverage.Full,
    },
    tokens: { ...ZERO_TOKEN_USAGE, byRole: {}, byModel: {}, coverage: Coverage.Full },
    context: { leadPeakPct: null, leadPeakTokens: null, workersPeakPct: null, compactions: null, coverage: Coverage.Full },
    calls: {
      modelCalls: 1,
      tools: { total: 0, byCategory: {} },
      blindEditStreak: null,
      subagents: null,
      verifiedBeforeDone: null,
      coverage: Coverage.Full,
    },
    cost: { apiEquivalentUsd: 0, priceTable: "2026-09-25", cliReportedUsd: null, billed: null, quota: [] },
    output: { files: 2, bytes: 20, loc: 2, hasEntry: true, buildScript: false, validate: CheckResult.Unknown },
    probe: null,
    checklist: null,
    inApp: null,
    digests: { streamSha256: null, transcriptSha256: null, snapshotSha256: null, evidenceSha256: null },
    notes: [],
    ...spec.patch,
  };
  return withGradeId(row);
}

/** One snapshot of a run: whether its project boots and is playable when probed. */
export interface SnapshotSpec {
  atMs: number;
  boots: boolean;
  playable: boolean;
  final?: boolean;
  /** The copy had to be rebuilt (a build script, no output at stop). */
  rebuilt?: boolean;
  rebuildFailed?: boolean;
  /** How a failed rebuild typed itself (`build-failed` unless it built without a page). */
  rebuildNoBuild?: NoBuild;
}

/** How the fake server says a snapshot's copy was served. */
function servedViaOf(state: SnapshotSpec): ServedVia {
  if (state.rebuildFailed) return ServedVia.RebuildFailed;
  return state.rebuilt ? ServedVia.Rebuilt : ServedVia.AsIs;
}

/** The state file a synthetic snapshot carries; the fake server and probe read it. */
const STATE_FILE = "state.json";

/** Write a run's snapshots and their index under `work/<runId>/snapshots`, as the watcher leaves them. */
export async function writeSnapshots(paths: EvalsPaths, runId: string, snapshots: readonly SnapshotSpec[]) {
  const dir = path.join(paths.work, runId, "snapshots");
  await mkdir(dir, { recursive: true });
  const lines: string[] = [];
  for (const [seq, snap] of snapshots.entries()) {
    const kind = snap.final ? SnapshotKind.Final : SnapshotKind.Periodic;
    const name = snap.final ? "final" : `${String(seq).padStart(4, "0")}-${snap.atMs}`;
    await mkdir(path.join(dir, name), { recursive: true });
    await writeFile(path.join(dir, name, STATE_FILE), JSON.stringify(snap));
    await writeFile(path.join(dir, name, "index.html"), "<canvas></canvas>");
    const sha256 = String(seq + 1).padStart(64, "0");
    lines.push(
      JSON.stringify({ seq, kind, name, atMs: snap.atMs, recordedAt: "2026-10-01T13:00:00Z", sha256, files: 2, bytes: 20 }),
    );
  }
  await writeFile(path.join(dir, "index.jsonl"), `${lines.join("\n")}\n`);
  return dir;
}

/** Calls the fakes saw, for asserting what was probed. */
export interface FakeLog {
  served: string[];
  probed: Array<{ url: string; options: QuickProbeOptions }>;
  fullProbed: Array<{ url: string; options: FullProbeOptions }>;
  graderCalls: number;
  pairwiseCalls: number;
}

/** A fresh call log. */
export const fakeLog = (): FakeLog => ({ served: [], probed: [], fullProbed: [], graderCalls: 0, pairwiseCalls: 0 });

/** The soak the fake full prober reports (the spec's five minutes). */
export const FAKE_SOAK_MS = 300_000;

/** A fake server: it serves nothing, answering a url that names the snapshot it was asked for. */
export function fakeServe(log: FakeLog): ServeSnapshot {
  return async (options: ServeOptions) => {
    log.served.push(options.root);
    const state = JSON.parse(await readFile(path.join(options.root, STATE_FILE), "utf8")) as SnapshotSpec;
    return {
      url: `${PROJECT_ORIGIN}/?snapshot=${encodeURIComponent(options.root)}`,
      origin: PROJECT_ORIGIN,
      root: options.root,
      servedVia: servedViaOf(state),
      noBuild: state.rebuildFailed ? (state.rebuildNoBuild ?? NoBuild.BuildFailed) : null,
      close: async () => {},
    };
  };
}

/** The quick-probe result a snapshot's state gives. */
function resultFor(state: SnapshotSpec, options: QuickProbeOptions, frames: FrameRef[]): QuickProbeResult {
  const booted = state.boots ? CheckResult.Pass : CheckResult.Fail;
  const playable = state.playable ? CheckResult.Pass : CheckResult.Fail;
  return {
    rows: { [ProbeRow.L1BuildsAndBoots]: booted, [ProbeRow.L2Enterable]: playable },
    l1Gate: booted,
    l2Gate: state.boots ? playable : CheckResult.Fail,
    scored: state.boots && state.playable,
    entrance: state.playable ? EntranceVia.StartControl : EntranceVia.None,
    firstRenderMs: state.boots ? 800 : null,
    fpsMedian: state.boots ? 60 : null,
    consoleErrors: 0,
    rendererMode: RendererMode.Gpu,
    servedVia: options.servedVia ?? ServedVia.AsIs,
    evidence: {
      projectOrigin: PROJECT_ORIGIN,
      frames,
      consoleSummaryPath: path.join(options.evidenceDir, "console-summary.json"),
      networkSummaryPath: path.join(options.evidenceDir, "network-summary.json"),
      videoPath: null,
      summaryBytes: 4096,
    },
    proberVersion: "genex-prober/6+desktop.1",
    noErrorsMs: options.noErrorsMs,
    quick: true,
  };
}

/** A fake quick probe: reads the snapshot's state and writes witnessed PNG frames into the evidence folder. */
export function fakeQuickProbe(log: FakeLog): RunQuickProbe {
  return async (url, options) => {
    log.probed.push({ url, options });
    const root = decodeURIComponent(new URL(url).searchParams.get("snapshot") ?? "");
    const state = JSON.parse(await readFile(path.join(root, STATE_FILE), "utf8")) as SnapshotSpec;
    await mkdir(options.evidenceDir, { recursive: true });
    await writeFile(path.join(options.evidenceDir, "console-summary.json"), "[]");
    await writeFile(path.join(options.evidenceDir, "network-summary.json"), "[]");
    const frames: FrameRef[] = [];
    const frameCount = state.playable ? 3 : 0;
    for (let index = 0; index < frameCount; index += 1) {
      const file = path.join(options.evidenceDir, `frame-${index}.png`);
      await writeFile(file, Buffer.concat([PNG_MAGIC, Buffer.from(`square ${index}`)]));
      frames.push({ path: file, atMs: 1_000 * (index + 2), phase: ProbePhase.InputBurst, origin: PROJECT_ORIGIN, width: 8, height: 8 });
    }
    return resultFor(state, options, frames);
  };
}

/** A fake full prober: the quick fake's observation, reported as a full probe with its soak. */
export function fakeFullProbe(log: FakeLog): RunFullProbe {
  const quick = fakeQuickProbe(fakeLog());
  return async (url, options) => {
    log.fullProbed.push({ url, options });
    const seen = await quick(url, { ...options, noErrorsMs: 60_000 });
    return {
      ...seen,
      quick: false,
      l3Gate: CheckResult.Unknown,
      checks: [],
      soakMs: FAKE_SOAK_MS,
      soakRanMs: FAKE_SOAK_MS,
      seed: 1,
      judgeEvidence: { sufficient: true, reason: null, by: JudgeEvidenceClause.Phase },
      scorecardPath: path.join(options.evidenceDir, "full-probe.json"),
    };
  };
}

/** The picks a fake pairwise judge gives: the left side wins every facet. */
const LEFT_EVERYWHERE = ["OVERALL: LEFT", "WORKS: LEFT", "VISUALS: LEFT", "FEEL: LEFT", "PLAY: LEFT"].join("\n");

/** A fake grader model: yes to every real item, no to the control, and "left" in every pairwise facet. */
export function fakeComplete(log: FakeLog): GraderComplete {
  return async (pin, prompt) => {
    if (prompt.text.includes("LEFT FRAMES ATTACHED")) {
      log.pairwiseCalls += 1;
      return { text: LEFT_EVERYWHERE, model: pin.model, usage: ZERO_TOKEN_USAGE };
    }
    log.graderCalls += 1;
    const yes = !prompt.text.includes(CONTROL_TEXT);
    return { text: yes ? "VERDICT: YES\nWHY: seen" : "VERDICT: NO\nWHY: not seen", model: pin.model, usage: ZERO_TOKEN_USAGE };
  };
}

/** The default graders, pinned to the checklist template. */
export const GRADERS = defaultGraderPins(CHECKLIST_PROMPT_SHA);
/** The fixed clock every fake grade reads. */
export const NOW = new Date("2026-10-01T15:00:00Z");

/** A green calibration for exactly the pins the fake campaign grades with. */
export const GREEN: CalibrationResult = {
  proberVersion: PROBER_VERSION,
  graderPromptSha: CHECKLIST_PROMPT_SHA,
  graderModels: GRADERS.map((pin) => pin.model),
  checks: [],
  ok: true,
  recordedAt: "2026-10-01T12:00:00.000Z",
  quick: false,
};

/** Boot at 60 s, playable at 90 s, and the final snapshot playable. */
export const LATE_PLAYABLE: SnapshotSpec[] = [
  { atMs: 30_000, boots: false, playable: false },
  { atMs: 60_000, boots: true, playable: false },
  { atMs: 90_000, boots: true, playable: true },
  { atMs: 120_000, boots: true, playable: true, final: true },
];
/** Playable from the first snapshot. */
export const PLAYABLE_AT_ONCE: SnapshotSpec[] = [
  { atMs: 30_000, boots: true, playable: true },
  { atMs: 60_000, boots: true, playable: true, final: true },
];

/** A grading setup over a fresh evals home: the deps, the fakes' log and the lock and quota counts. */
export interface Harness {
  deps: GradingDeps;
  log: FakeLog;
  counts: { locks: number; gates: number };
  home: string;
}

/** Fresh grading deps over a temp evals home, every outside effect faked; `patch` overrides any. */
export async function harness(patch: Partial<GradingDeps> = {}): Promise<Harness> {
  const home = await tmpDir("eval-grading-home-");
  await writeVendor(path.join(home, "vendor"));
  const userHome = await tmpDir("eval-grading-user-");
  const log = fakeLog();
  const counts = { locks: 0, gates: 0 };
  const deps: GradingDeps = {
    paths: evalsPaths(home),
    homes: defaultHomes(userHome),
    cases: [gradingCase],
    graders: GRADERS,
    votesPerFamily: 3,
    proberVersion: PROBER_VERSION,
    rendererMode: RendererMode.Gpu,
    vendorDir: path.join(home, "vendor"),
    appVendorDir: async (appSha) => {
      const dir = path.join(home, "builds", appSha, "vendor");
      return (await stat(path.join(dir, VENDOR_ENTRY)).catch(() => null)) ? dir : null;
    },
    npmCacheDir: path.join(home, "npm-cache"),
    serve: fakeServe(log),
    quick: true,
    quickProbe: fakeQuickProbe(log),
    fullProbe: fakeFullProbe(log),
    complete: fakeComplete(log),
    rubric: await readPairwiseRubric(),
    withLock: async (fn) => {
      counts.locks += 1;
      return fn();
    },
    quotaGate: async () => {
      counts.gates += 1;
      return null;
    },
    latestCalibration: async () => GREEN,
    now: () => NOW,
    clock: () => 0,
    ...patch,
  };
  return { deps, log, counts, home };
}

/** Write a vendor folder with the entry grading checks for. */
export async function writeVendor(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, VENDOR_ENTRY), "export const REVISION = '185';\n");
}

/** An app build's vendor folder for `appSha` under the harness home, as `appVendorDir` finds it. */
export async function writeAppBuild(h: Harness, appSha: string): Promise<string> {
  const dir = path.join(h.home, "builds", appSha, "vendor");
  await writeVendor(dir);
  return dir;
}

/** The no-builds a stop-time snapshot types without any rebuild: such a run leaves nothing to serve. */
const TYPED_BEFORE_SERVE: ReadonlySet<NoBuild> = new Set([NoBuild.TemplateUntouched, NoBuild.NoEntry]);

/** Write the four lanes' collected rows and snapshots. */
export async function seedCampaign(h: Harness, rows: RunRow[] = defaultRows()): Promise<RunRow[]> {
  for (const row of rows) {
    await appendLedgerRow(row, { paths: h.deps.paths, homes: h.deps.homes });
    if (row.outcome.noBuild !== null && TYPED_BEFORE_SERVE.has(row.outcome.noBuild)) continue;
    const snapshots = row.lane.id === LANES.a.id ? LATE_PLAYABLE : PLAYABLE_AT_ONCE;
    await writeSnapshots(h.deps.paths, row.runId, snapshots);
  }
  return rows;
}

/** The four lanes' collected rows, rep 1. */
export function defaultRows(): RunRow[] {
  return [LANES.a, LANES.b, LANES.c, LANES.d].map((lane) => collectedRow({ lane }));
}

/** The bytes the run and pairwise ledgers hold, to prove a refusal wrote nothing. */
export async function ledgerSize(h: Harness): Promise<number> {
  const size = async (file: string) => (await stat(file).catch(() => null))?.size ?? 0;
  return (await size(h.deps.paths.ledgerFiles.runs)) + (await size(h.deps.paths.ledgerFiles.pairwise));
}
