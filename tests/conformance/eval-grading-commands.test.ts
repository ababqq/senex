/**
 * The grading commands (`grade`, `regrade`, `calibrate`, `diagnostics`) with an injected context:
 * usage errors exit 64, a refused or red outcome exits non-zero, and `calibrate` runs the committed
 * calibration fixtures (and the project template) through the fake server and probe and the real
 * checklist grader on a fake model, recording the result that gates grading.
 */
import assert from "node:assert/strict";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { readCases } from "../../scripts/evals/cases.ts";
import { CliExit } from "../../scripts/evals/cli/exit.ts";
import {
  CALIBRATION_CASE_ID,
  calibrateCommand,
  diagnosticsCommand,
  GradingExit,
  type GradingCommandContext,
  gradeCommand,
  regradeCommand,
  repeatabilityFile,
} from "../../scripts/evals/grade/commands.ts";
import type { GraderComplete } from "../../scripts/evals/grade/checklist/complete.ts";
import { DiagnosticId, DiagnosticStatus } from "../../scripts/evals/grade/diagnostics.ts";
import {
  calibrationRefusal,
  GradeRefusal,
  type GradingDeps,
  readLatestCalibration,
} from "../../scripts/evals/grade/pipeline.ts";
import type {
  FrameRef,
  QuickProbeResult,
  RunFullProbe,
  RunQuickProbe,
  ServeSnapshot,
} from "../../scripts/evals/grade/types.ts";
import { EvalHomesRefusal } from "../../scripts/evals/lanes/homes.ts";
import { currentRows, readRunRows } from "../../scripts/evals/ledger/read.ts";
import { JudgeEvidenceClause } from "../../scripts/evals/prober/verdicts.ts";
import {
  CalibrationFixture,
  CheckResult,
  NoBuild,
  EntranceVia,
  ProbePhase,
  RendererMode,
  ServedVia,
} from "../../scripts/evals/vocabulary.ts";
import { ZERO_TOKEN_USAGE } from "../../src/shared/eval-lane.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { CAMPAIGN, PROJECT_ORIGIN, harness, LANES, runIdOf, seedCampaign } from "../fixtures/evals/grading/campaign.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A command's printed lines and exit code. */
async function run(
  command: (args: readonly string[], out: (line: string) => void, given?: GradingCommandContext) => Promise<number>,
  args: string[],
  context?: GradingCommandContext,
): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const code = await command(args, (line) => lines.push(line), context);
  return { code, text: lines.join("\n") };
}

async function gradedContext(patch: Partial<GradingDeps> = {}) {
  const h = await harness(patch);
  await seedCampaign(h);
  return { h, context: { deps: h.deps, root: REPO } satisfies GradingCommandContext };
}

describe("grade and regrade", () => {
  const usage: Array<[string, string[]]> = [
    ["no campaign", []],
    ["an unknown flag", [CAMPAIGN, "--fast"]],
    ["two campaigns", [CAMPAIGN, CAMPAIGN]],
  ];
  for (const [name, args] of usage) {
    it(`grade exits 64 on ${name}, grading nothing`, async () => {
      const { h, context } = await gradedContext();
      const result = await run(gradeCommand, args, context);
      assert.equal(result.code, GradingExit.Usage);
      assert.equal(h.counts.locks, 0);
    });
  }

  it("grade grades the campaign and prints each run and the pairwise rows", async () => {
    const { h, context } = await gradedContext();
    const result = await run(gradeCommand, [CAMPAIGN, "--quick"], context);
    assert.equal(result.code, GradingExit.Ok);
    assert.match(result.text, new RegExp(`graded ${runIdOf(LANES.a)}`));
    assert.match(result.text, /pairwise 16/);
    assert.equal(
      currentRows(await readRunRows(h.deps.paths)).every((row) => row.gradeSeq === 2),
      true,
    );
  });

  it("grade runs the full prober on each final snapshot unless --quick asks for the quick probe", async () => {
    const full = await gradedContext();
    assert.equal((await run(gradeCommand, [CAMPAIGN], full.context)).code, GradingExit.Ok);
    assert.equal(full.h.log.fullProbed.length, 4);
    assert.ok(currentRows(await readRunRows(full.h.deps.paths)).every((row) => row.probe?.quick === false));
    const quick = await gradedContext();
    assert.equal((await run(gradeCommand, [CAMPAIGN, "--quick"], quick.context)).code, GradingExit.Ok);
    assert.equal(quick.h.log.fullProbed.length, 0);
    assert.ok(currentRows(await readRunRows(quick.h.deps.paths)).every((row) => row.probe?.quick === true));
  });

  it("refuses with a usage line, not a stack trace, when a CLI home variable names another home", async () => {
    const home = await tmpDir("eval-grading-other-home-");
    const env = { GENEX_EVALS_HOME: home, CODEX_HOME: path.join(home, "elsewhere") };
    for (const command of [gradeCommand, regradeCommand, calibrateCommand, diagnosticsCommand]) {
      const lines: string[] = [];
      const args = command === regradeCommand ? [runIdOf(LANES.a)] : [CAMPAIGN];
      const code = await command(command === calibrateCommand ? [] : args, (line) => lines.push(line), undefined, env);
      assert.equal(code, GradingExit.Usage);
      assert.deepEqual(lines[0], `refused ${EvalHomesRefusal.OtherHome} CODEX_HOME`);
      assert.match(lines[1] ?? "", /^usage: unset CODEX_HOME/);
    }
  });

  it("grade is not ready (exit 2) and prints the refusal without a covering calibration", async () => {
    const { context } = await gradedContext({ latestCalibration: async () => null });
    const result = await run(gradeCommand, [CAMPAIGN], context);
    assert.equal(result.code, GradingExit.NotReady);
    assert.equal(result.code, CliExit.NotReady);
    assert.match(result.text, /refused calibration-missing/);
    const regrade = await run(regradeCommand, [runIdOf(LANES.a)], context);
    assert.equal(regrade.code, GradingExit.NotReady);
    const sample = await run(diagnosticsCommand, [CAMPAIGN, "--repeatability"], context);
    assert.equal(sample.code, GradingExit.NotReady);
  });

  it("regrade adds a grade to one run, and --baseline to every baseline run", async () => {
    const { h, context } = await gradedContext();
    await run(gradeCommand, [CAMPAIGN], context);
    const one = await run(regradeCommand, [runIdOf(LANES.b)], context);
    assert.equal(one.code, GradingExit.Ok);
    assert.match(one.text, new RegExp(`regraded ${runIdOf(LANES.b)} 3`));
    const none = await run(regradeCommand, ["--baseline"], { ...context, root: await tmpDir("eval-grading-nobase-") });
    assert.equal(none.code, GradingExit.Ok);
    assert.equal(
      currentRows(await readRunRows(h.deps.paths)).find((row) => row.runId === runIdOf(LANES.b))?.gradeSeq,
      3,
    );
    assert.equal((await run(regradeCommand, [], context)).code, GradingExit.Usage);
    const unknown = await run(regradeCommand, ["20261001T120000-raw-claude-grading-case-r7"], context);
    assert.equal(unknown.code, GradingExit.Refused);
  });
});

describe("ids that name folders", () => {
  const hostile = [
    "../../etc",
    "/abs/path",
    "20261001T120000-ok/../../x",
    "20261001T120000-UPPER",
    "20261001T120000-a\u0000b",
    "..",
    "",
  ];
  for (const id of hostile) {
    it(`refuses ${JSON.stringify(id)} as a campaign or run id before touching the evals home`, async () => {
      const { h, context } = await gradedContext();
      const before = await readdir(h.deps.paths.home);
      assert.equal((await run(gradeCommand, [id], context)).code, GradingExit.Usage);
      assert.equal((await run(diagnosticsCommand, [id, "--repeatability"], context)).code, GradingExit.Usage);
      assert.equal((await run(regradeCommand, [id], context)).code, GradingExit.Usage);
      assert.deepEqual(await readdir(h.deps.paths.home), before);
      assert.equal(h.counts.locks, 0);
      assert.equal(h.log.graderCalls, 0);
    });
  }
});

describe("diagnostics", () => {
  it("prints the Diagnostics block of a graded campaign, re-grading a sample only when asked", async () => {
    const { h, context } = await gradedContext();
    await run(gradeCommand, [CAMPAIGN], context);
    const plain = await run(diagnosticsCommand, [CAMPAIGN], context);
    assert.equal(plain.code, GradingExit.Ok);
    assert.match(plain.text, /^Diagnostics/);
    assert.match(plain.text, new RegExp(`${DiagnosticId.GraderRepeatability}: ${DiagnosticStatus.NotRun}`));

    const calls = h.log.graderCalls;
    const sampled = await run(diagnosticsCommand, [CAMPAIGN, "--repeatability", "--seed", "abc"], context);
    assert.equal(sampled.code, GradingExit.Ok);
    assert.ok(h.log.graderCalls > calls, "the sample is graded again");
    await access(repeatabilityFile(h.deps.paths, CAMPAIGN));
    const reread = await run(diagnosticsCommand, [CAMPAIGN], context);
    assert.match(reread.text, new RegExp(`${DiagnosticId.GraderRepeatability}: ${DiagnosticStatus.Ok}`));
  });

  it("exits non-zero when a diagnostic is red", async () => {
    let call = 0;
    const flipping: GraderComplete = async (pin) => {
      call += 1;
      return { text: call % 2 ? "VERDICT: YES" : "VERDICT: NO", model: pin.model, usage: ZERO_TOKEN_USAGE };
    };
    const { context } = await gradedContext();
    await run(gradeCommand, [CAMPAIGN], context);
    const flipped = { ...context, deps: { ...context.deps, complete: flipping } };
    const result = await run(diagnosticsCommand, [CAMPAIGN, "--repeatability"], flipped);
    assert.equal(result.code, GradingExit.Refused);
    assert.match(result.text, /Promotion blocked by: grader-repeatability/);
  });

  it("exits 64 without a campaign", async () => {
    const { context } = await gradedContext();
    assert.equal((await run(diagnosticsCommand, [], context)).code, GradingExit.Usage);
  });
});

/** Serve a calibration fixture's copy: the broken build fails to rebuild, everything else is served as is. */
function calibrationServe(): ServeSnapshot {
  return async (options) => ({
    url: `${PROJECT_ORIGIN}/?fixture=${encodeURIComponent(path.basename(options.root))}`,
    origin: PROJECT_ORIGIN,
    root: options.root,
    servedVia:
      path.basename(options.root) === CalibrationFixture.BrokenBuild ? ServedVia.RebuildFailed : ServedVia.AsIs,
    noBuild: path.basename(options.root) === CalibrationFixture.BrokenBuild ? NoBuild.BuildFailed : null,
    close: async () => {},
  });
}

/** Probe a calibration fixture: only the known-good project is enterable; frames carry what it drew. */
function calibrationProbe(): RunQuickProbe {
  return async (url, options) => {
    const fixture = new URL(url).searchParams.get("fixture");
    const good = fixture === CalibrationFixture.KnownGoodMiniGolf;
    await mkdir(options.evidenceDir, { recursive: true });
    const frames: FrameRef[] = [];
    for (let index = 0; index < 3; index += 1) {
      const file = path.join(options.evidenceDir, `frame-${index}.png`);
      await writeFile(file, Buffer.concat([PNG_MAGIC, Buffer.from(good ? "golf" : "flat")]));
      frames.push({
        path: file,
        atMs: 2_000 + index,
        phase: ProbePhase.InputBurst,
        origin: PROJECT_ORIGIN,
        width: 8,
        height: 8,
      });
    }
    const l2 = good ? CheckResult.Pass : CheckResult.Fail;
    const result: QuickProbeResult = {
      rows: {},
      l1Gate: CheckResult.Pass,
      l2Gate: l2,
      scored: good,
      entrance: good ? EntranceVia.StartControl : EntranceVia.None,
      firstRenderMs: 500,
      fpsMedian: 60,
      consoleErrors: 0,
      rendererMode: RendererMode.Gpu,
      servedVia: ServedVia.AsIs,
      evidence: {
        projectOrigin: PROJECT_ORIGIN,
        frames,
        consoleSummaryPath: "",
        networkSummaryPath: "",
        videoPath: null,
        summaryBytes: 4096,
      },
      proberVersion: "genex-prober/6+desktop.1",
      noErrorsMs: options.noErrorsMs,
      quick: true,
    };
    return result;
  };
}

/** The full prober over the calibration fixtures: the same verdicts and frames, as a full result. */
function calibrationFullProbe(ran: string[]): RunFullProbe {
  const quick = calibrationProbe();
  return async (url, options) => {
    ran.push("full");
    const seen = await quick(url, { ...options, noErrorsMs: 0 });
    return {
      ...seen,
      quick: false,
      l3Gate: CheckResult.Unknown,
      checks: [],
      soakMs: 0,
      soakRanMs: 0,
      seed: 1,
      judgeEvidence: { sufficient: true, reason: null, by: JudgeEvidenceClause.Phase },
      scorecardPath: path.join(options.evidenceDir, "full-probe.json"),
    };
  };
}

describe("calibrate", () => {
  const golf = readCases(REPO).find((evalCase) => evalCase.id === CALIBRATION_CASE_ID);
  const control = golf?.acceptance.find((item) => item.control)?.text ?? "";
  const looking: GraderComplete = async (pin, prompt) => {
    const sawGolf = prompt.images.every((image) => Buffer.from(image.data, "base64").includes("golf"));
    const yes = sawGolf && !prompt.text.includes(control);
    return { text: yes ? "VERDICT: YES" : "VERDICT: NO", model: pin.model, usage: ZERO_TOKEN_USAGE };
  };
  const credulous: GraderComplete = async (pin) => ({
    text: "VERDICT: YES",
    model: pin.model,
    usage: ZERO_TOKEN_USAGE,
  });

  async function calibrateWith(complete: GraderComplete, args: string[] = []) {
    const ran: string[] = [];
    const quick = calibrationProbe();
    const h = await harness({
      cases: golf ? [golf] : [],
      serve: calibrationServe(),
      quickProbe: async (url, options) => {
        ran.push("quick");
        return quick(url, options);
      },
      fullProbe: calibrationFullProbe(ran),
      complete,
      latestCalibration: async () => readLatestCalibration(h.deps.paths),
    });
    const result = await run(calibrateCommand, args, { deps: h.deps, root: REPO });
    return { h, result, ran };
  }

  it("records a green calibration that then covers grading, and exits 0", async () => {
    assert.ok(golf, "the mini-golf case exists");
    const { h, result, ran } = await calibrateWith(looking);
    assert.equal(result.code, GradingExit.Ok, result.text);
    assert.equal(h.counts.locks, 1, "calibration probes under the probe lock");
    assert.ok(ran.length > 0 && ran.every((kind) => kind === "full"), "the default calibrates the full prober");
    const latest = await readLatestCalibration(h.deps.paths);
    assert.equal(latest?.ok, true);
    assert.equal(latest?.quick, false);
    assert.equal(await calibrationRefusal({ ...h.deps, quick: false }), null, "it covers a full grade");
    assert.deepEqual(
      latest?.checks.map((check) => [check.fixture, check.ok]),
      Object.values(CalibrationFixture).map((fixture) => [fixture, true]),
    );
    assert.equal(
      latest?.checks.find((c) => c.fixture === CalibrationFixture.TemplateUntouched)?.actual.noBuild,
      "template-untouched",
    );
    assert.equal(
      latest?.checks.find((c) => c.fixture === CalibrationFixture.BrokenBuild)?.actual.noBuild,
      "build-failed",
    );
  });

  it("calibrates the quick probe on --quick, which covers only quick grades", async () => {
    const { h, result, ran } = await calibrateWith(looking, ["--quick"]);
    assert.equal(result.code, GradingExit.Ok, result.text);
    assert.ok(ran.length > 0 && ran.every((kind) => kind === "quick"));
    assert.equal((await readLatestCalibration(h.deps.paths))?.quick, true);
    assert.equal(await calibrationRefusal({ ...h.deps, quick: true }), null);
    assert.equal(await calibrationRefusal({ ...h.deps, quick: false }), GradeRefusal.CalibrationNotCovering);
  });

  it("refuses to calibrate without the vendored three.js, naming the build step", async () => {
    const h = await harness({
      cases: golf ? [golf] : [],
      vendorDir: path.join(await tmpDir("eval-calibrate-no-vendor-"), "vendor"),
    });
    const result = await run(calibrateCommand, [], { deps: h.deps, root: REPO });
    assert.equal(result.code, GradingExit.NotReady);
    assert.match(result.text, /refused vendor-missing/);
    assert.match(result.text, /npm run build/);
    assert.equal(await readLatestCalibration(h.deps.paths), null);
  });

  it("exits 64 on anything but --quick", async () => {
    const { result } = await calibrateWith(looking, ["--full"]);
    assert.equal(result.code, GradingExit.Usage);
    assert.match(result.text, /usage: calibrate \[--quick\]/);
  });

  it("records a red calibration and exits non-zero when the grader says yes to anything", async () => {
    const { h, result } = await calibrateWith(credulous);
    assert.equal(result.code, GradingExit.Refused);
    assert.match(result.text, /calibration red/);
    assert.equal((await readLatestCalibration(h.deps.paths))?.ok, false);
  });
});
