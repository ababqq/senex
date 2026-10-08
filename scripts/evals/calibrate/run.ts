/**
 * The calibration run (§8.8): every fixture goes through the prober and the checklist grader, and
 * each result is checked against its expectation. Grading refuses to run without a green calibration
 * for the current prober version, prompt template and grader models, run with the probe kind the
 * grade uses: a full-prober calibration covers full and quick grades, a quick one only quick grades
 * (`calibrationCovers`). The
 * prober and the grader are injected, so this runner is hermetic under test; the campaign binds the
 * real ones and records the result.
 */
import type { EvalCase } from "../case-types.ts";
import type {
  CalibrationCheck,
  CalibrationResult,
  EvidenceRefs,
  GradeChecklist,
  GraderPin,
  RunCalibration,
} from "../grade/types.ts";
import type { CalibrationFixture, CheckResult, NoBuild } from "../vocabulary.ts";
import { checkFixture } from "./expectations.ts";
import { CALIBRATION_ORDER, type FixtureSources, materializeFixture } from "./fixtures.ts";

/** What probing one fixture found: the L2 gate, the typed no-build, and the witnessed evidence. */
export interface CalibrationProbe {
  l2: CheckResult;
  noBuild: NoBuild | null;
  /** Null when nothing was probed (a typed no-build). */
  evidence: EvidenceRefs | null;
}

/** Probe one fixture's work folder (serve, then the quick probe or the full prober) and report what it saw. */
export type CalibrationProber = (fixture: CalibrationFixture, dir: string) => Promise<CalibrationProbe>;

/** What the calibration runner is built from. */
export interface CalibrationDeps {
  prober: CalibrationProber;
  gradeChecklist: GradeChecklist;
  /** The case every fixture is graded against: the mini-golf case. */
  evalCase: EvalCase;
  proberVersion: string;
  /** Whether the prober is the quick probe; recorded so a quick calibration never covers a full grade. */
  quick: boolean;
  votesPerFamily: number;
  /** Where the template comes from and where fixtures are copied; `fixturesDir` is the run's argument. */
  templateDir: string;
  workDir: string;
  now?: () => Date;
}

/** Evidence with nothing in it, for a fixture that was never probed. */
const NO_EVIDENCE: EvidenceRefs = {
  projectOrigin: "",
  frames: [],
  consoleSummaryPath: "",
  networkSummaryPath: "",
  videoPath: null,
  summaryBytes: 0,
};

/** Probe and grade one fixture, then check it. */
async function calibrateFixture(
  deps: CalibrationDeps,
  graders: GraderPin[],
  fixture: CalibrationFixture,
  sources: FixtureSources,
): Promise<CalibrationCheck> {
  const dir = await materializeFixture(fixture, sources);
  const probe = await deps.prober(fixture, dir);
  const grade = await deps.gradeChecklist({
    evalCase: deps.evalCase,
    evidence: probe.evidence ?? NO_EVIDENCE,
    graders,
    votesPerFamily: deps.votesPerFamily,
    fullAssets: false,
    noBuild: probe.noBuild,
    // A hand-made fixture: no engine built it, so no grader family is the run's own.
    runEngine: null,
  });
  const checklist = grade.judgeSkipped ? null : grade.scoreAllRuns;
  return checkFixture(fixture, { l2: probe.l2, checklist, noBuild: probe.noBuild }, grade.graderVoid !== null);
}

/** Build the `RunCalibration` the `calibrate` command calls. */
export function createRunCalibration(deps: CalibrationDeps): RunCalibration {
  return async (fixturesDir, graders) => {
    const sources: FixtureSources = { fixturesDir, templateDir: deps.templateDir, workDir: deps.workDir };
    const checks: CalibrationCheck[] = [];
    for (const fixture of CALIBRATION_ORDER) checks.push(await calibrateFixture(deps, graders, fixture, sources));
    const promptShas = [...new Set(graders.map((pin) => pin.promptSha))];
    return {
      proberVersion: deps.proberVersion,
      graderPromptSha: promptShas.join(","),
      graderModels: graders.map((pin) => pin.model),
      checks,
      ok: checks.every((check) => check.ok),
      recordedAt: (deps.now ?? (() => new Date()))().toISOString(),
      quick: deps.quick,
    };
  };
}

/** The versions a grade would run under. */
export interface GradingVersions {
  proberVersion: string;
  graderPromptSha: string;
  graderModels: readonly string[];
  /** Whether the grade's final probe is the quick probe. */
  quick: boolean;
}

/** Whether a calibration ran the probe a grade uses: the full prober covers both kinds, the quick probe only itself. */
function probeKindCovers(result: CalibrationResult, versions: GradingVersions): boolean {
  return !result.quick || versions.quick;
}

/** Whether a calibration ran under exactly these prober, prompt and grader-model pins. */
function samePins(result: CalibrationResult, versions: GradingVersions): boolean {
  const models = [...result.graderModels].sort().join(",");
  const wanted = [...versions.graderModels].sort().join(",");
  return (
    result.proberVersion === versions.proberVersion &&
    result.graderPromptSha === versions.graderPromptSha &&
    models === wanted
  );
}

/** Whether a calibration is green for exactly these versions and this probe kind; grading refuses otherwise. */
export function calibrationCovers(result: CalibrationResult, versions: GradingVersions): boolean {
  return result.ok && samePins(result, versions) && probeKindCovers(result, versions);
}

/**
 * The calibration that decides a grade under these versions, from the recorded lines in order:
 * the newest one under the same pins whose probe kind covers it, so a later quick run never
 * revokes a full one while a newer red run of a covering kind still does. With none, the newest
 * line of any kind, which then does not cover; null when nothing is recorded.
 */
export function selectCalibration(
  lines: readonly CalibrationResult[],
  versions: GradingVersions,
): CalibrationResult | null {
  const deciding = lines.findLast((line) => samePins(line, versions) && probeKindCovers(line, versions));
  return deciding ?? lines.at(-1) ?? null;
}
