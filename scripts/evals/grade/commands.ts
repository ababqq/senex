/**
 * The grading commands of `npm run eval` (§12): `grade <campaign> [--quick]`, `regrade <runId> |
 * --baseline [--reprobe]`, `calibrate` and `diagnostics <campaign> [--repeatability] [--seed s]`.
 * Each has the CLI's `CommandHandler` shape (`(args) => exit code`) plus an optional printer and an
 * injected context, so tests drive them with fakes; without one, `systemGradingContext` binds the
 * real server (ProcessSandbox builds), the quick and full probers, the app's engines in the eval
 * homes, the machine-wide probe lock and the quota guard. Ids that name a path are checked against their
 * patterns before anything is read or written.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CodingProvider } from "../../../src/shared/coding-cli.ts";
import { EngineId } from "../../../src/shared/providers.ts";
import { budgetCaps, engineQuotaReader, guardQuota, startBudget } from "../budget.ts";
import { CALIBRATION_FIXTURES_DIR, PROJECT_TEMPLATE_DIR } from "../calibrate/fixtures.ts";
import { createRunCalibration } from "../calibrate/run.ts";
import { caseById, readCases, readHoldoutCases } from "../cases.ts";
import { CliExit } from "../cli/exit.ts";
import { EVALS_HOME_ENV, resolveEvalsHome } from "../home.ts";
import { applyEvalHomesEnv, EvalHomesError, evalHomesRefusalLines, evalsLayout } from "../lanes/homes.ts";
import { laneById, readLaneRegistry } from "../lanes/registry.ts";
import { type EvalsPaths, evalsPaths } from "../ledger/paths.ts";
import { currentRows, readRunRows } from "../ledger/read.ts";
import { CAMPAIGN_ID_PATTERN, RUN_ID_PATTERN } from "../ledger/types.ts";
import { probeLockPath, withProbeLock } from "../prober/lock.ts";
import { runFullProbe } from "../prober/full-probe.ts";
import { PROBER_VERSION } from "../prober/types.ts";
import { RendererMode } from "../vocabulary.ts";
import { workspaceDigest } from "../watch/snapshots.ts";
import { engineGraderComplete } from "./checklist/complete.ts";
import { createGraderEngines } from "./checklist/engines.ts";
import { defaultGraderPins } from "./checklist/family.ts";
import { createGradeChecklist } from "./checklist/grade.ts";
import { CHECKLIST_PROMPT_SHA } from "./checklist/prompt.ts";
import {
  checklistItemRegrader,
  type ItemRecord,
  itemRecordsOf,
  type RepeatabilityObservation,
  renderDiagnostics,
  runDiagnostics,
  runRepeatabilitySample,
  sampleForRepeatability,
} from "./diagnostics.ts";
import { readPairwiseRubric } from "./pairwise.ts";
import {
  type CampaignGrade,
  calibrationRefusal,
  GradeRefusal,
  createCalibrationProber,
  DEFAULT_VOTES_PER_FAMILY,
  type GradingDeps,
  gradeCampaign,
  readGradeRecord,
  readLatestCalibration,
  recordCalibration,
  vendorRefusal,
} from "./pipeline.ts";
import { runQuickProbe } from "./quick-probe.ts";
import { type RegradeOutcome, regradeBaseline, regradeRun } from "./regrade.ts";
import { sandboxedServe, vendorReady } from "./serve.ts";
import { APP_VENDOR_DIR } from "../campaign/canary.ts";
import { APP_SHA_PATTERN } from "../lanes/genex-app.ts";

/** The exit codes the grading commands answer with. */
export const GradingExit = {
  Ok: CliExit.Ok,
  /** Refused (an unknown or changed run), stopped by the quota guard, a red calibration or a red diagnostic. */
  Refused: CliExit.Refused,
  /** Not ready: no covering calibration yet (run `calibrate`), or a campaign with no runs. */
  NotReady: CliExit.NotReady,
  Usage: CliExit.Usage,
} as const;
export type GradingExit = (typeof GradingExit)[keyof typeof GradingExit];

/** The refusals that mean a missing precondition (a calibration, the campaign's runs), not a failure. */
const NOT_READY_REFUSALS: ReadonlySet<string> = new Set(Object.values(GradeRefusal));

/** Whether a refusal is a missing precondition rather than a failure. */
function notReady(refusal: string | null): boolean {
  return NOT_READY_REFUSALS.has(refusal ?? "");
}

/** The case every calibration fixture is graded against (§8.8). */
export const CALIBRATION_CASE_ID = "mini-golf";
/** Where diagnostics keep a campaign's re-graded repeatability sample under the evals home. */
export const DIAGNOSTICS_DIR = "diagnostics";
export const REPEATABILITY_FILE = "repeatability.json";

/** What the operator is told when the vendored three.js is missing. */
const VENDOR_MISSING_HINT =
  "grading serves /vendor from dist/resources/vendor, which has no three.js: run npm run build first";

/** The repository root this module ships in (cases, calibration fixtures, template, baselines). */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** What a grading command runs against: the grading deps and the repository root. */
export interface GradingCommandContext {
  deps: GradingDeps;
  root: string;
}

/** A command's printer. */
type Out = (line: string) => void;

/** One command line, split. */
interface ParsedArgs {
  positional: string[];
  flags: Set<string>;
  values: Map<string, string>;
}

/** Split `args` into positionals, known flags and known `--name value` pairs; null on anything else. */
function parseArgs(args: readonly string[], spec: { flags?: string[]; values?: string[] }): ParsedArgs | null {
  const parsed: ParsedArgs = { positional: [], flags: new Set(), values: new Map() };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("--")) parsed.positional.push(arg);
    else if (spec.flags?.includes(arg)) parsed.flags.add(arg);
    else if (spec.values?.includes(arg) && args[i + 1] !== undefined) {
      parsed.values.set(arg, args[i + 1] ?? "");
      i += 1;
    } else return null;
  }
  return parsed;
}

/** The one campaign id a command names, checked against its pattern (it names folders). */
function campaignArg(parsed: ParsedArgs | null): string | null {
  if (parsed?.positional.length !== 1) return null;
  const [campaignId] = parsed.positional;
  return campaignId !== undefined && CAMPAIGN_ID_PATTERN.test(campaignId) ? campaignId : null;
}

/** The engines the quota guard can read. */
const QUOTA_ENGINES: ReadonlySet<EngineId> = new Set([EngineId.ClaudeCode, EngineId.Codex]);

function isQuotaEngine(engine: EngineId): engine is CodingProvider {
  return QUOTA_ENGINES.has(engine);
}

/**
 * The real grading context: the evals home's paths, the app's engines in the eval homes, the
 * sandboxed copy builder and server, the quick and full probers and the lock at
 * `$GENEX_EVALS_HOME/locks`, and the quota guard over every grader's provider. Grades are full unless
 * a command asks for quick ones. Loaded lazily; tests inject their own.
 */
export async function systemGradingContext(env: NodeJS.ProcessEnv = process.env): Promise<GradingCommandContext> {
  const home = resolveEvalsHome({ env });
  const paths = evalsPaths(home);
  const layout = evalsLayout(home);
  applyEvalHomesEnv(layout.homes, env);
  const judgeCwd = path.join(home, "judge-cwd");
  await mkdir(judgeCwd, { recursive: true });
  const engines = await createGraderEngines({ homes: layout.homes, judgeCwd, env });
  const graders = defaultGraderPins(CHECKLIST_PROMPT_SHA);
  const lockPath = probeLockPath({ [EVALS_HOME_ENV]: home });
  const budget = startBudget(budgetCaps(), Date.now());
  const read = engineQuotaReader(layout, env);
  const lanes = readLaneRegistry(REPO_ROOT);
  const deps: GradingDeps = {
    paths,
    cases: [...readCases(REPO_ROOT), ...readHoldoutCases(home)],
    graders,
    votesPerFamily: DEFAULT_VOTES_PER_FAMILY,
    proberVersion: PROBER_VERSION,
    rendererMode: RendererMode.Gpu,
    vendorDir: path.join(REPO_ROOT, APP_VENDOR_DIR),
    appVendorDir: (appSha) => appBuildVendorDir(layout.builds, appSha),
    npmCacheDir: paths.npmCache,
    serve: sandboxedServe(paths, async (options) =>
      (await import("../../../src/substrate/spawn.ts")).ProcessSandbox.create(options),
    ),
    quick: false,
    quickProbe: (url, options) => runQuickProbe(url, options, { lockPath }),
    fullProbe: (url, options) => runFullProbe(url, options, { lockPath }),
    complete: engineGraderComplete(engines),
    rubric: await readPairwiseRubric(),
    withLock: (fn) => withProbeLock(lockPath, fn),
    quotaGate: async () => {
      for (const engine of new Set(graders.map((pin) => pin.engine))) {
        if (!isQuotaEngine(engine)) continue;
        const outcome = await guardQuota({ engine, budget, read });
        if (!outcome.proceed) return outcome.stop;
      }
      return null;
    },
    latestCalibration: (versions) => readLatestCalibration(paths, versions),
    now: () => new Date(),
    disabledPluginsOf: (laneId) => laneById(lanes, laneId)?.disabledPlugins ?? [],
  };
  return { deps, root: REPO_ROOT };
}

/**
 * A Genex run's app build's vendor folder (`<builds>/<sha>/dist/resources/vendor`, as the canary
 * serves it), or null when the SHA is not a full commit or that build has no three.js.
 */
async function appBuildVendorDir(buildsDir: string, appSha: string): Promise<string | null> {
  if (!APP_SHA_PATTERN.test(appSha)) return null;
  const dir = path.join(buildsDir, appSha, APP_VENDOR_DIR);
  return (await vendorReady(dir)) ? dir : null;
}

/**
 * The given context, else the system one; null, with the refusal and a usage line printed, when a
 * CLI home variable names another home (`EvalHomesError`), so the operator sees what to unset.
 */
async function contextFor(
  given: GradingCommandContext | undefined,
  out: Out,
  env: NodeJS.ProcessEnv,
): Promise<GradingCommandContext | null> {
  if (given) return given;
  try {
    return await systemGradingContext(env);
  } catch (error) {
    if (!(error instanceof EvalHomesError)) throw error;
    for (const line of evalHomesRefusalLines(error)) out(line);
    return null;
  }
}

/** Print what grading a campaign did. */
function printGrade(report: CampaignGrade, out: Out): void {
  if (report.refused !== null) out(`refused ${report.refused}`);
  if (report.refused === GradeRefusal.VendorMissing) out(VENDOR_MISSING_HINT);
  for (const runId of report.graded) out(`graded ${runId}`);
  for (const { runId, reason } of report.skipped) out(`skipped ${runId} ${reason}`);
  out(`pairwise ${report.pairwiseRows}`);
  if (report.stop !== null) out(`stopped ${report.stop}`);
}

/**
 * `grade <campaign> [--quick]` (§8): every run's scan, final probe and checklist, then the pairs.
 * The final probe is the full prober (M3); `--quick` runs the quick probe instead, and such a grade
 * can never be promoted.
 */
export async function gradeCommand(
  args: readonly string[],
  out: Out = console.log,
  given?: GradingCommandContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const parsed = parseArgs(args, { flags: ["--quick"] });
  const campaignId = campaignArg(parsed);
  if (campaignId === null) {
    out("usage: grade <campaign> [--quick]");
    return GradingExit.Usage;
  }
  const context = await contextFor(given, out, env);
  if (context === null) return GradingExit.Usage;
  const report = await gradeCampaign(campaignId, { ...context.deps, quick: parsed?.flags.has("--quick") === true });
  printGrade(report, out);
  if (notReady(report.refused)) return GradingExit.NotReady;
  return report.stop !== null ? GradingExit.Refused : GradingExit.Ok;
}

/** Print one regrade's outcome. */
function printRegrade(outcome: RegradeOutcome, out: Out): void {
  if (outcome.refused !== null) out(`refused ${outcome.runId} ${outcome.refused}`);
  else if (outcome.stop !== null) out(`stopped ${outcome.runId} ${outcome.stop}`);
  else out(`regraded ${outcome.runId} ${outcome.gradeSeq} ${outcome.reprobed ? "reprobed" : "evidence-reused"}`);
}

/** `regrade <runId> | --baseline [--reprobe]`: a new grade of retained runs, never a new observation. */
export async function regradeCommand(
  args: readonly string[],
  out: Out = console.log,
  given?: GradingCommandContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const parsed = parseArgs(args, { flags: ["--baseline", "--reprobe"] });
  const baseline = parsed?.flags.has("--baseline") === true;
  const runId = parsed?.positional.length === 1 ? parsed.positional[0] : undefined;
  const oneRun = !baseline && runId !== undefined && RUN_ID_PATTERN.test(runId);
  const valid = parsed !== null && (oneRun || (baseline && parsed.positional.length === 0));
  if (!valid) {
    out("usage: regrade <runId> | --baseline [--reprobe]");
    return GradingExit.Usage;
  }
  const context = await contextFor(given, out, env);
  if (context === null) return GradingExit.Usage;
  const { deps, root } = context;
  const options = { reprobe: parsed.flags.has("--reprobe") };
  const outcomes =
    oneRun && runId ? [await regradeRun(runId, deps, options)] : await regradeBaseline(root, deps, options);
  for (const outcome of outcomes) printRegrade(outcome, out);
  const failed = outcomes.some((outcome) => outcome.refused !== null || outcome.stop !== null);
  if (outcomes.some((outcome) => notReady(outcome.refused))) return GradingExit.NotReady;
  return failed ? GradingExit.Refused : GradingExit.Ok;
}

/** A timestamp for folder names: `yyyymmddThhmmss`. */
function stampOf(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "");
}

/**
 * `calibrate [--quick]` (§8.8): the committed fixtures and the project template through the grading
 * server, the full prober (the quick probe on `--quick`) and the checklist grader, checked against
 * their expectations and recorded with the probe kind. A red calibration exits non-zero, and grading
 * refuses until a green one covers its pins: a full calibration covers every grade, a quick one only
 * `grade --quick`.
 */
export async function calibrateCommand(
  args: readonly string[],
  out: Out = console.log,
  given?: GradingCommandContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const parsed = parseArgs(args, { flags: ["--quick"] });
  if (parsed === null || parsed.positional.length > 0) {
    out("usage: calibrate [--quick]");
    return GradingExit.Usage;
  }
  const context = await contextFor(given, out, env);
  if (context === null) return GradingExit.Usage;
  const { root } = context;
  const deps = { ...context.deps, quick: parsed.flags.has("--quick") };
  const vendor = await vendorRefusal(deps);
  if (vendor !== null) {
    out(`refused ${vendor}`);
    out(VENDOR_MISSING_HINT);
    return GradingExit.NotReady;
  }
  const evalCase = caseById(deps.cases, CALIBRATION_CASE_ID);
  if (!evalCase) {
    out(`refused case-unknown ${CALIBRATION_CASE_ID}`);
    return GradingExit.Refused;
  }
  const stamp = stampOf(deps.now());
  const templateDir = path.join(root, PROJECT_TEMPLATE_DIR);
  const workDir = path.join(deps.paths.work, `calibration-${stamp}`);
  await mkdir(workDir, { recursive: true });
  const prober = createCalibrationProber({
    ...deps,
    templateDigest: await workspaceDigest(templateDir),
    evidenceDir: path.join(deps.paths.evidence, `calibration-${stamp}`),
  });
  const gradeChecklist = createGradeChecklist({ complete: deps.complete, evidenceRoot: deps.paths.evidence });
  const calibrate = createRunCalibration({
    prober,
    gradeChecklist,
    evalCase,
    proberVersion: deps.proberVersion,
    quick: deps.quick,
    votesPerFamily: deps.votesPerFamily,
    templateDir,
    workDir,
    now: deps.now,
  });
  const result = await deps.withLock(() => calibrate(path.join(root, CALIBRATION_FIXTURES_DIR), deps.graders));
  await recordCalibration(deps.paths, result);
  for (const check of result.checks) {
    const { l2, checklist, noBuild } = check.actual;
    out(
      `${check.fixture} ${check.ok ? "ok" : "failed"} l2=${l2} checklist=${checklist ?? "skipped"} noBuild=${noBuild ?? "none"}`,
    );
  }
  out(result.ok ? "calibration green" : "calibration red");
  return result.ok ? GradingExit.Ok : GradingExit.Refused;
}

/** Where a campaign's re-graded repeatability sample is kept. */
export function repeatabilityFile(paths: EvalsPaths, campaignId: string): string {
  return path.join(paths.home, DIAGNOSTICS_DIR, campaignId, REPEATABILITY_FILE);
}

/** A campaign's current rows and the graded items their grade records hold. */
export async function campaignGrades(paths: EvalsPaths, campaignId: string) {
  const rows = currentRows(await readRunRows(paths)).filter((row) => row.campaignId === campaignId);
  const items: ItemRecord[] = [];
  for (const row of rows) {
    const record = await readGradeRecord(paths, row.runId, row.gradeSeq);
    if (record) items.push(...itemRecordsOf(row, record));
  }
  return { rows, items };
}

/** The kept repeatability sample of a campaign, or null when none was re-graded. */
export async function readRepeatability(
  paths: EvalsPaths,
  campaignId: string,
): Promise<RepeatabilityObservation[] | null> {
  try {
    const value: unknown = JSON.parse(await readFile(repeatabilityFile(paths, campaignId), "utf8"));
    return Array.isArray(value) ? (value as RepeatabilityObservation[]) : null;
  } catch {
    return null;
  }
}

/** Re-grade a seeded sample of the campaign's items with the current pins and keep the observations. */
async function sampleRepeatability(campaignId: string, items: readonly ItemRecord[], seed: string, deps: GradingDeps) {
  const regrade = checklistItemRegrader({
    gradeChecklist: createGradeChecklist({ complete: deps.complete, evidenceRoot: deps.paths.evidence }),
    graders: deps.graders,
    votesPerFamily: deps.votesPerFamily,
    cases: deps.cases,
  });
  const observations = await runRepeatabilitySample(sampleForRepeatability(items, seed), regrade);
  const file = repeatabilityFile(deps.paths, campaignId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(observations, null, 2)}\n`);
  return observations;
}

/**
 * `diagnostics <campaign> [--repeatability] [--seed s]` (§10.7): the Diagnostics block over the
 * campaign's current grades. `--repeatability` re-grades a seeded sample first (grader calls, after
 * the calibration gate and the quota guard); otherwise the kept sample is used. Red exits non-zero.
 */
export async function diagnosticsCommand(
  args: readonly string[],
  out: Out = console.log,
  given?: GradingCommandContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const parsed = parseArgs(args, { flags: ["--repeatability"], values: ["--seed"] });
  const campaignId = campaignArg(parsed);
  if (campaignId === null || parsed === null) {
    out("usage: diagnostics <campaign> [--repeatability] [--seed s]");
    return GradingExit.Usage;
  }
  const context = await contextFor(given, out, env);
  if (context === null) return GradingExit.Usage;
  const { deps } = context;
  const { rows, items } = await campaignGrades(deps.paths, campaignId);
  let repeatability = await readRepeatability(deps.paths, campaignId);
  if (parsed.flags.has("--repeatability")) {
    const refusal = (await calibrationRefusal(deps)) ?? (await deps.quotaGate());
    if (refusal !== null) {
      out(`refused ${refusal}`);
      return notReady(refusal) ? GradingExit.NotReady : GradingExit.Refused;
    }
    repeatability = await sampleRepeatability(campaignId, items, parsed.values.get("--seed") ?? campaignId, deps);
  }
  const block = runDiagnostics({ rows, items, repeatability });
  out(renderDiagnostics(block));
  return block.blocking.length > 0 ? GradingExit.Refused : GradingExit.Ok;
}
