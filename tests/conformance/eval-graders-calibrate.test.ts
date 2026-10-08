/**
 * Calibration (§8.8) through its runner, with a fake prober and the real checklist grader on a fake
 * `GraderComplete`: the committed fixtures and the project template are copied into a work folder,
 * null fixtures must score 0 on L2 and the checklist, `template-untouched` must be typed `noBuild`,
 * the known-good mini-golf must pass, and a grader that says yes to anything turns calibration red.
 * Nothing is written into the committed fixtures.
 */
import assert from "node:assert/strict";
import { access, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { AcceptanceItem, EvalCase } from "../../scripts/evals/case-types.ts";
import { readCases } from "../../scripts/evals/cases.ts";
import { CALIBRATION_EXPECTATIONS, KNOWN_GOOD_MIN_CHECKLIST } from "../../scripts/evals/calibrate/expectations.ts";
import { scoredItemCount } from "../../scripts/evals/grade/checklist/score.ts";
import {
  CALIBRATION_FIXTURES_DIR,
  PROJECT_TEMPLATE_DIR,
  materializeFixture,
} from "../../scripts/evals/calibrate/fixtures.ts";
import {
  type CalibrationProbe,
  type CalibrationProber,
  calibrationCovers,
  createRunCalibration,
} from "../../scripts/evals/calibrate/run.ts";
import type { GraderComplete } from "../../scripts/evals/grade/checklist/complete.ts";
import { defaultGraderPins } from "../../scripts/evals/grade/checklist/family.ts";
import { createGradeChecklist } from "../../scripts/evals/grade/checklist/grade.ts";
import { CHECKLIST_PROMPT_SHA } from "../../scripts/evals/grade/checklist/prompt.ts";
import type { EvidenceRefs, FrameRef } from "../../scripts/evals/grade/types.ts";
import {
  CalibrationFixture,
  CaseExposure,
  CaseMode,
  CaseVisibility,
  CheckResult,
  NoBuild,
  ProbePhase,
} from "../../scripts/evals/vocabulary.ts";
import { ZERO_TOKEN_USAGE } from "../../src/shared/eval-lane.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES = path.join(REPO, CALIBRATION_FIXTURES_DIR);
const TEMPLATE = path.join(REPO, PROJECT_TEMPLATE_DIR);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PROBER_VERSION = "synthetic-prober/1";
const MARKER = "probed-here.txt";

function item(index: number, text: string, control = false): AcceptanceItem {
  return { id: `synthetic-golf-${index}`, text, tracesTo: null, key: false, assetsOnly: false, control };
}

/** A mini-golf-shaped synthetic case: eight items and the absurd control. */
const golfCase: EvalCase = {
  id: "synthetic-golf",
  number: 92,
  label: "synthetic mini golf",
  brief: "A synthetic brief: one hole of mini golf.",
  mode: CaseMode.Build,
  exposure: CaseExposure.None,
  exposureReason: null,
  visibility: CaseVisibility.Public,
  acceptance: [
    ...["aim", "power", "rolls", "bounces", "sinks", "strokes", "again", "layout"].map((text, index) =>
      item(index + 1, `golf item: ${text}`),
    ),
    item(9, "a dragon announces the score", true),
  ],
  followUps: [],
  deadlineMin: 30,
  version: "0123456789ab",
  checklistVersion: "ba9876543210",
  startFrom: null,
};

/** What a fake prober sees for each fixture, as a real one should. */
const SEEN: Record<CalibrationFixture, Omit<CalibrationProbe, "evidence"> & { content: string | null }> = {
  [CalibrationFixture.EmptyCanvas]: { l2: CheckResult.Fail, noBuild: null, content: "flat" },
  [CalibrationFixture.PlaceholderOnly]: { l2: CheckResult.Fail, noBuild: null, content: "placeholder" },
  [CalibrationFixture.BrokenBuild]: { l2: CheckResult.Unknown, noBuild: NoBuild.BuildFailed, content: null },
  [CalibrationFixture.TemplateUntouched]: {
    l2: CheckResult.Unknown,
    noBuild: NoBuild.TemplateUntouched,
    content: null,
  },
  [CalibrationFixture.KnownGoodMiniGolf]: { l2: CheckResult.Pass, noBuild: null, content: "golf" },
};

/** A fake prober: checks the work copy exists, marks it, and writes frames carrying the fixture's content. */
function fakeProber(evidenceRoot: string, seen = SEEN): { prober: CalibrationProber; dirs: string[] } {
  const dirs: string[] = [];
  const prober: CalibrationProber = async (fixture, dir) => {
    await access(path.join(dir, "index.html"));
    await writeFile(path.join(dir, MARKER), "written into the work copy only");
    dirs.push(dir);
    const { content, ...probe } = seen[fixture];
    if (content === null) return { ...probe, evidence: null };
    const frames: FrameRef[] = [];
    for (let index = 0; index < 4; index += 1) {
      const file = `${fixture}-${index}.png`;
      await writeFile(path.join(evidenceRoot, file), Buffer.concat([PNG_MAGIC, Buffer.from(content)]));
      frames.push({
        path: file,
        atMs: 1_000 * index,
        phase: ProbePhase.InputBurst,
        origin: "http://127.0.0.1:43000",
        width: 8,
        height: 8,
      });
    }
    const evidence: EvidenceRefs = {
      projectOrigin: "http://127.0.0.1:43000",
      frames,
      consoleSummaryPath: "",
      networkSummaryPath: "",
      videoPath: null,
      summaryBytes: 4096,
    };
    return { ...probe, evidence };
  };
  return { prober, dirs };
}

/** A grader that looks at the frames: golf frames satisfy golf items, and nothing satisfies the control. */
const lookingGrader: GraderComplete = async (pin, prompt) => {
  const golf = prompt.images.every((image) => Buffer.from(image.data, "base64").includes("golf"));
  const yes = golf && !prompt.text.includes("dragon");
  return {
    text: yes ? "VERDICT: YES\nWHY: seen" : "VERDICT: NO\nWHY: not seen",
    model: pin.model,
    usage: ZERO_TOKEN_USAGE,
  };
};

/** A grader that says yes to anything. */
const credulousGrader: GraderComplete = async (pin) => ({
  text: "VERDICT: YES\nWHY: sure",
  model: pin.model,
  usage: ZERO_TOKEN_USAGE,
});

async function calibrate(complete: GraderComplete, seen = SEEN) {
  const evidenceRoot = await tmpDir("eval-graders-calibration-evidence-");
  const workDir = await tmpDir("eval-graders-calibration-work-");
  const { prober, dirs } = fakeProber(evidenceRoot, seen);
  const run = createRunCalibration({
    prober,
    gradeChecklist: createGradeChecklist({ complete, evidenceRoot }),
    evalCase: golfCase,
    proberVersion: PROBER_VERSION,
    quick: false,
    votesPerFamily: 3,
    templateDir: TEMPLATE,
    workDir,
    now: () => new Date("2026-10-01T12:00:00Z"),
  });
  const result = await run(FIXTURES, defaultGraderPins(CHECKLIST_PROMPT_SHA));
  return { result, dirs, workDir };
}

describe("calibration", () => {
  it("sets the known-good bar on the committed mini-golf case: 6 of its 8 scored items, one control", () => {
    const golf = readCases(REPO).find((evalCase) => evalCase.id === "mini-golf");
    assert.ok(golf);
    assert.equal(golf.acceptance.filter((item) => item.control).length, 1);
    const scored = scoredItemCount(golf.acceptance, false);
    assert.equal(scored, 8);
    assert.equal(Math.round(KNOWN_GOOD_MIN_CHECKLIST * scored), 6);
  });

  it("is green when the prober and the grader tell the fixtures apart", async () => {
    const { result, dirs, workDir } = await calibrate(lookingGrader);
    assert.deepEqual(
      result.checks.map((check) => [check.fixture, check.ok]),
      Object.values(CalibrationFixture).map((fixture) => [fixture, true]),
    );
    assert.equal(result.ok, true);
    assert.equal(result.proberVersion, PROBER_VERSION);
    assert.equal(result.graderPromptSha, CHECKLIST_PROMPT_SHA);
    assert.equal(result.recordedAt, "2026-10-01T12:00:00.000Z");
    const golf = result.checks.find((check) => check.fixture === CalibrationFixture.KnownGoodMiniGolf);
    assert.equal(golf?.actual.checklist, 1);
    const template = result.checks.find((check) => check.fixture === CalibrationFixture.TemplateUntouched);
    assert.equal(template?.actual.noBuild, NoBuild.TemplateUntouched);
    assert.equal(template?.actual.checklist, null);
    assert.ok(
      dirs.every((dir) => path.dirname(dir) === workDir),
      "every fixture was probed in a work copy",
    );
    for (const fixture of await readdir(FIXTURES)) {
      await assert.rejects(access(path.join(FIXTURES, fixture, MARKER)), "the committed fixture was not written");
    }
  });

  it("turns red when the grader says yes to anything", async () => {
    const { result } = await calibrate(credulousGrader);
    assert.equal(result.ok, false);
    const bad = result.checks.filter((check) => !check.ok).map((check) => check.fixture);
    assert.ok(bad.includes(CalibrationFixture.EmptyCanvas));
    assert.ok(bad.includes(CalibrationFixture.PlaceholderOnly));
    assert.ok(bad.includes(CalibrationFixture.KnownGoodMiniGolf), "a void grade is never green");
  });

  it("turns red when the prober passes L2 on a null fixture or misses a no-build", async () => {
    const seen = {
      ...SEEN,
      [CalibrationFixture.EmptyCanvas]: { ...SEEN[CalibrationFixture.EmptyCanvas], l2: CheckResult.Pass },
      [CalibrationFixture.TemplateUntouched]: { l2: CheckResult.Fail, noBuild: null, content: "flat" },
    };
    const { result } = await calibrate(lookingGrader, seen);
    assert.deepEqual(
      result.checks.filter((check) => !check.ok).map((check) => check.fixture),
      [CalibrationFixture.EmptyCanvas, CalibrationFixture.TemplateUntouched],
    );
  });

  it("covers grading only for the exact versions it was run with", async () => {
    const { result } = await calibrate(lookingGrader);
    const versions = {
      proberVersion: PROBER_VERSION,
      graderPromptSha: CHECKLIST_PROMPT_SHA,
      graderModels: [...result.graderModels].reverse(),
      quick: false,
    };
    assert.equal(result.quick, false, "the calibration records the probe kind it ran");
    assert.equal(calibrationCovers(result, versions), true);
    assert.equal(calibrationCovers(result, { ...versions, quick: true }), true, "a full calibration covers --quick");
    assert.equal(
      calibrationCovers({ ...result, quick: true }, versions),
      false,
      "a quick one never covers a full grade",
    );
    assert.equal(calibrationCovers({ ...result, quick: true }, { ...versions, quick: true }), true);
    assert.equal(calibrationCovers(result, { ...versions, proberVersion: "synthetic-prober/2" }), false);
    assert.equal(calibrationCovers(result, { ...versions, graderPromptSha: "0".repeat(64) }), false);
    assert.equal(calibrationCovers(result, { ...versions, graderModels: ["claude-sonnet-5-5"] }), false);
    assert.equal(calibrationCovers({ ...result, ok: false }, versions), false);
  });

  it("expects every null fixture to score nothing", () => {
    for (const fixture of Object.values(CalibrationFixture)) {
      if (fixture === CalibrationFixture.KnownGoodMiniGolf) continue;
      assert.equal(CALIBRATION_EXPECTATIONS[fixture].checklistMax, 0, fixture);
      assert.equal(CALIBRATION_EXPECTATIONS[fixture].l2, CheckResult.Fail, fixture);
    }
  });

  it("refuses to copy a fixture over an existing work copy", async () => {
    const workDir = await tmpDir("eval-graders-calibration-twice-");
    const sources = { fixturesDir: FIXTURES, templateDir: TEMPLATE, workDir };
    await materializeFixture(CalibrationFixture.EmptyCanvas, sources);
    await assert.rejects(materializeFixture(CalibrationFixture.EmptyCanvas, sources));
  });
});
