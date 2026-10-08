/**
 * The pairwise judge (§8.5) through its interface, with a fake `GraderComplete`: the rubric guard,
 * reply parsing (an unparseable facet is invalid, never a tie), both orders per family in a seeded
 * order, a win only when both orders agree, skipped pairs that make no call, and the ledger rows.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { EvalCase } from "../../scripts/evals/case-types.ts";
import type { GraderComplete, GraderPrompt } from "../../scripts/evals/grade/checklist/complete.ts";
import { defaultGraderPins, GraderPinError } from "../../scripts/evals/grade/checklist/family.ts";
import {
  createJudgePairwise,
  createPairwiseRows,
  familyOutcomes,
  orderSequence,
  pairOutcome,
  PairwiseRubricError,
  parsePairPicks,
  readPairwiseRubric,
  RubricViolation,
  rubricViolations,
} from "../../scripts/evals/grade/pairwise.ts";
import type { EvidenceRefs, FrameRef, GraderPin, PairwiseRequest } from "../../scripts/evals/grade/types.ts";
import { PAIRWISE_ROW_SCHEMA } from "../../scripts/evals/ledger/types.ts";
import {
  Axis,
  CaseExposure,
  CaseMode,
  CaseVisibility,
  GraderFamily,
  PairFacet,
  PairOrder,
  PairOutcome,
  NoBuild,
  PairPick,
  ProbePhase,
} from "../../scripts/evals/vocabulary.ts";
import { ZERO_TOKEN_USAGE } from "../../src/shared/eval-lane.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ORIGIN = "http://127.0.0.1:42000";

const evalCase: EvalCase = {
  id: "synthetic-pair",
  number: 91,
  label: "synthetic pair",
  brief: "A synthetic brief for a pair of projects.",
  mode: CaseMode.Build,
  exposure: CaseExposure.None,
  exposureReason: null,
  visibility: CaseVisibility.Public,
  acceptance: [],
  followUps: [],
  deadlineMin: 30,
  version: "0123456789ab",
  checklistVersion: "ba9876543210",
  startFrom: null,
};

/** A side's evidence: `count` frames whose bytes carry the side's name. */
async function sideEvidence(root: string, side: string, count: number): Promise<EvidenceRefs> {
  const frames: FrameRef[] = [];
  for (let index = 0; index < count; index += 1) {
    const file = `${side}-${index}.png`;
    await writeFile(path.join(root, file), Buffer.concat([PNG_MAGIC, Buffer.from(side)]));
    frames.push({ path: file, atMs: 1_000 + index, phase: ProbePhase.InputBurst, origin: ORIGIN, width: 8, height: 8 });
  }
  await writeFile(path.join(root, `${side}-console.txt`), `${side} console`);
  return {
    projectOrigin: ORIGIN,
    frames,
    consoleSummaryPath: `${side}-console.txt`,
    networkSummaryPath: `${side}-console.txt`,
    videoPath: null,
    summaryBytes: 4096,
  };
}

/** Which side the first frame shown on the left belongs to. */
function leftSide(prompt: GraderPrompt): string {
  const first = prompt.images[0];
  return first ? Buffer.from(first.data, "base64").subarray(PNG_MAGIC.length).toString() : "";
}

const allFacets = (pick: string) =>
  Object.values(PairFacet)
    .map((facet) => `${facet.toUpperCase()}: ${pick}`)
    .join("\n");

async function setup(firstFrames = 4, secondFrames = 4) {
  const root = await tmpDir("eval-graders-pairwise-");
  const rubric = await readPairwiseRubric();
  const graders = defaultGraderPins(rubric.sha);
  const request: PairwiseRequest = {
    evalCase,
    first: {
      runId: "20261001T000000-lane-a-synthetic-pair-r1",
      laneId: "lane-a",
      evidence: await sideEvidence(root, "first", firstFrames),
      noBuild: null,
    },
    second: {
      runId: "20261001T000000-lane-b-synthetic-pair-r1",
      laneId: "lane-b",
      evidence: await sideEvidence(root, "second", secondFrames),
      noBuild: null,
    },
    graders,
    blindSeed: "synthetic-seed",
    pairwiseRubricSha: rubric.sha,
  };
  return { root, rubric, graders, request };
}

function recording(answer: (pin: GraderPin, prompt: GraderPrompt) => string) {
  const calls: Array<{ pin: GraderPin; prompt: GraderPrompt }> = [];
  const complete: GraderComplete = async (pin, prompt) => {
    calls.push({ pin, prompt });
    return { text: answer(pin, prompt), model: pin.model, usage: { ...ZERO_TOKEN_USAGE, output: 5 } };
  };
  return { complete, calls };
}

describe("the pairwise rubric", () => {
  it("loads clean and pins a sha", async () => {
    const rubric = await readPairwiseRubric();
    assert.deepEqual(rubricViolations(rubric.text), []);
    assert.match(rubric.sha, /^[0-9a-f]{64}$/);
  });

  const table: Array<[string, RubricViolation[]]> = [
    ["the side that sets window.__studio wins", [RubricViolation.StudioContract]],
    ["the incumbent keeps ties", [RubricViolation.Incumbent]],
    ["ask about {{brief}}", [RubricViolation.Placeholder]],
    ["the request is <BRIEF>", [RubricViolation.Placeholder]],
    ["pick the side that plays better", []],
  ];
  for (const [text, violations] of table) {
    it(`flags "${text}"`, () => assert.deepEqual(rubricViolations(text), violations));
  }

  it("refuses a rubric file with a violation", async () => {
    const dir = await tmpDir("eval-graders-rubric-");
    const file = path.join(dir, "rubric.md");
    await writeFile(file, "Prefer the incumbent. Request: {{brief}}");
    await assert.rejects(readPairwiseRubric(file), PairwiseRubricError);
  });
});

describe("pairwise replies and outcomes", () => {
  it("parses whole facet lines and types anything else as invalid", () => {
    assert.deepEqual(parsePairPicks(allFacets("LEFT")), {
      picks: {
        [PairFacet.Overall]: PairPick.Left,
        [PairFacet.Works]: PairPick.Left,
        [PairFacet.Visuals]: PairPick.Left,
        [PairFacet.Feel]: PairPick.Left,
        [PairFacet.Play]: PairPick.Left,
      },
      valid: true,
    });
    const partial = parsePairPicks("OVERALL: TIE\nWORKS: RIGHT\nVISUALS: LEFT or RIGHT\nFEEL: LEFT\nFEEL: RIGHT");
    assert.equal(partial.valid, false);
    assert.equal(partial.picks[PairFacet.Overall], PairPick.Tie);
    assert.equal(partial.picks[PairFacet.Works], PairPick.Right);
    assert.equal(partial.picks[PairFacet.Visuals], PairPick.Invalid);
    assert.equal(partial.picks[PairFacet.Feel], PairPick.Invalid);
    assert.equal(partial.picks[PairFacet.Play], PairPick.Invalid);
  });

  const table: Array<[PairPick, PairPick, PairOutcome]> = [
    [PairPick.Left, PairPick.Right, PairOutcome.First],
    [PairPick.Right, PairPick.Left, PairOutcome.Second],
    [PairPick.Left, PairPick.Left, PairOutcome.PositionInconsistent],
    [PairPick.Tie, PairPick.Tie, PairOutcome.Tie],
    [PairPick.Tie, PairPick.Right, PairOutcome.PositionInconsistent],
    [PairPick.Invalid, PairPick.Right, PairOutcome.Invalid],
  ];
  for (const [firstLeft, firstRight, outcome] of table) {
    it(`first-left ${firstLeft}, first-right ${firstRight} → ${outcome}`, () =>
      assert.equal(pairOutcome(firstLeft, firstRight), outcome));
  }

  it("draws each family's first order from the seed, deterministically", () => {
    const orders = (seed: string) => orderSequence(seed, GraderFamily.Claude);
    assert.deepEqual(orders("seed-1"), orders("seed-1"));
    const firsts = new Set(Array.from({ length: 16 }, (_, index) => orders(`seed-${index}`)[0]));
    assert.deepEqual(firsts, new Set([PairOrder.FirstLeft, PairOrder.FirstRight]));
    for (let index = 0; index < 16; index += 1)
      assert.deepEqual(new Set(orders(`seed-${index}`)), new Set(Object.values(PairOrder)));
  });
});

describe("judging a pair", () => {
  it("judges both orders per family and wins only when the orders agree", async () => {
    const { rubric, root, request } = await setup();
    const honest = recording((_, prompt) => allFacets(leftSide(prompt) === "first" ? "LEFT" : "RIGHT"));
    const verdicts = await createJudgePairwise({ complete: honest.complete, evidenceRoot: root, rubric })(request);
    assert.equal(honest.calls.length, 4);
    assert.deepEqual(
      verdicts.map((verdict) => [verdict.grader.family, verdict.order]),
      request.graders.flatMap((pin) =>
        orderSequence(request.blindSeed, pin.family).map((order) => [pin.family, order]),
      ),
    );
    const outcomes = familyOutcomes(verdicts);
    assert.equal(outcomes[GraderFamily.Claude]?.[PairFacet.Overall], PairOutcome.First);
    assert.equal(outcomes[GraderFamily.Gpt]?.[PairFacet.Play], PairOutcome.First);
    for (const call of honest.calls) {
      assert.equal(call.prompt.images.length, 8);
      assert.ok(call.prompt.text.includes(evalCase.brief));
      assert.ok(!call.prompt.text.includes("__studio"));
    }

    const biased = recording(() => allFacets("LEFT"));
    const leaning = await createJudgePairwise({ complete: biased.complete, evidenceRoot: root, rubric })(request);
    assert.equal(familyOutcomes(leaning)[GraderFamily.Claude]?.[PairFacet.Overall], PairOutcome.PositionInconsistent);
  });

  it("types an unparseable or failed reply as invalid", async () => {
    const { rubric, root, request } = await setup();
    const garbled = await createJudgePairwise({
      complete: recording(() => "I prefer the first one.").complete,
      evidenceRoot: root,
      rubric,
    })(request);
    assert.ok(garbled.every((verdict) => !verdict.valid));
    const failing = await createJudgePairwise({
      complete: async () => {
        throw new Error("synthetic outage");
      },
      evidenceRoot: root,
      rubric,
    })(request);
    assert.ok(failing.every((verdict) => !verdict.valid && verdict.picks[PairFacet.Overall] === PairPick.Invalid));
    assert.equal(familyOutcomes(failing)[GraderFamily.Gpt]?.[PairFacet.Overall], PairOutcome.Invalid);
    const rows = createPairwiseRows({
      recordedAt: "2026-10-01T00:00:00Z",
      gradeSeq: 1,
      gradeId: "abcdefabcdef",
      rep: 1,
      axis: Axis.ProductDefault,
      engines: { first: EngineId.ClaudeCode, second: EngineId.ClaudeCode },
    })(request, failing, "20261001T000000-synthetic");
    assert.ok(
      rows.every((row) => !row.judgeSkipped),
      "a failed call is not a skip",
    );
  });

  it("skips a pair with too little evidence on either side, making no call", async () => {
    const { rubric, root, request } = await setup(4, 1);
    const fake = recording(() => allFacets("LEFT"));
    const verdicts = await createJudgePairwise({ complete: fake.complete, evidenceRoot: root, rubric })(request);
    assert.equal(fake.calls.length, 0);
    assert.equal(verdicts.length, 4);
    const rows = createPairwiseRows({
      recordedAt: "2026-10-01T00:00:00Z",
      gradeSeq: 1,
      gradeId: "abcdefabcdef",
      rep: 1,
      axis: Axis.ProductDefault,
      engines: { first: EngineId.ClaudeCode, second: EngineId.Codex },
    })(request, verdicts, "20261001T000000-synthetic");
    assert.ok(rows.every((row) => row.judgeSkipped));
  });

  const rowContext = {
    recordedAt: "2026-10-01T00:00:00Z",
    gradeSeq: 1,
    gradeId: "abcdefabcdef",
    rep: 1,
    axis: Axis.ProductDefault,
    engines: { first: EngineId.ClaudeCode, second: EngineId.Codex },
  };

  it("awards a forfeit, with no call, when exactly one side shipped a typed no-build", async () => {
    const { rubric, root, request } = await setup(0, 4);
    const fake = recording(() => allFacets("LEFT"));
    const forfeited = { ...request, first: { ...request.first, noBuild: NoBuild.TemplateUntouched } };
    const verdicts = await createJudgePairwise({ complete: fake.complete, evidenceRoot: root, rubric })(forfeited);
    assert.equal(fake.calls.length, 0);
    assert.equal(verdicts.length, 4);
    assert.ok(verdicts.every((verdict) => verdict.forfeit && verdict.valid && !verdict.judgeSkipped));
    for (const family of [GraderFamily.Claude, GraderFamily.Gpt]) {
      for (const facet of Object.values(PairFacet)) {
        assert.equal(familyOutcomes(verdicts)[family]?.[facet], PairOutcome.Second, `${family} ${facet}`);
      }
    }
    const rows = createPairwiseRows(rowContext)(forfeited, verdicts, "20261001T000000-synthetic");
    assert.ok(rows.every((row) => row.forfeit === true && !row.judgeSkipped));
  });

  it("keeps a pair skipped when the no-build's sibling has too little evidence too", async () => {
    const { rubric, root, request } = await setup(0, 1);
    const fake = recording(() => allFacets("LEFT"));
    const forfeited = { ...request, first: { ...request.first, noBuild: NoBuild.BuildFailed } };
    const verdicts = await createJudgePairwise({ complete: fake.complete, evidenceRoot: root, rubric })(forfeited);
    assert.equal(fake.calls.length, 0);
    assert.ok(verdicts.every((verdict) => verdict.judgeSkipped && !verdict.forfeit));
  });

  it("keeps a pair skipped when both sides shipped no build", async () => {
    const { rubric, root, request } = await setup(0, 0);
    const both = {
      ...request,
      first: { ...request.first, noBuild: NoBuild.NoEntry },
      second: { ...request.second, noBuild: NoBuild.TemplateUntouched },
    };
    const verdicts = await createJudgePairwise({
      complete: recording(() => allFacets("LEFT")).complete,
      evidenceRoot: root,
      rubric,
    })(both);
    assert.ok(verdicts.every((verdict) => verdict.judgeSkipped && !verdict.forfeit));
    const rows = createPairwiseRows(rowContext)(both, verdicts, "20261001T000000-synthetic");
    assert.ok(rows.every((row) => row.judgeSkipped && row.forfeit !== true));
  });

  it("skips when a side's frames escape the evidence root, reading none of them", async () => {
    const { rubric, root, request } = await setup();
    const escaping: EvidenceRefs = {
      ...request.second.evidence,
      frames: request.second.evidence.frames.map((frame) => ({ ...frame, path: `../${frame.path}` })),
    };
    const fake = recording(() => allFacets("LEFT"));
    await createJudgePairwise({ complete: fake.complete, evidenceRoot: root, rubric })({
      ...request,
      second: { ...request.second, evidence: escaping },
    });
    assert.equal(fake.calls.length, 0);
  });

  it("refuses a rubric sha the request did not pin, before any call", async () => {
    const { rubric, root, request } = await setup();
    const fake = recording(() => allFacets("LEFT"));
    const judge = createJudgePairwise({ complete: fake.complete, evidenceRoot: root, rubric });
    await assert.rejects(judge({ ...request, pairwiseRubricSha: "0".repeat(64) }), GraderPinError);
    await assert.rejects(judge({ ...request, graders: defaultGraderPins("0".repeat(64)) }), GraderPinError);
    assert.equal(fake.calls.length, 0);
  });
});

describe("pairwise rows", () => {
  it("writes one closed row per family and order, marking the family that built a side", async () => {
    const { rubric, root, request } = await setup();
    const fake = recording(() => allFacets("TIE"));
    const verdicts = await createJudgePairwise({ complete: fake.complete, evidenceRoot: root, rubric })(request);
    const rows = createPairwiseRows({
      recordedAt: "2026-10-01T00:00:00Z",
      gradeSeq: 2,
      gradeId: "abcdefabcdef",
      rep: 3,
      axis: Axis.ModelStack,
      engines: { first: EngineId.ClaudeCode, second: EngineId.ClaudeCode },
    })(request, verdicts, "20261001T000000-synthetic");
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.equal(row.schema, PAIRWISE_ROW_SCHEMA);
      assert.equal(row.caseId, evalCase.id);
      assert.equal(row.blindSeed, request.blindSeed);
      assert.equal(row.pairwiseRubricSha, rubric.sha);
      assert.equal(row.rep, 3);
      assert.equal(row.judgeSkipped, false);
      assert.equal(row.sameFamily, row.family === GraderFamily.Claude);
      assert.equal(row.picks[PairFacet.Overall], PairPick.Tie);
    }
    assert.deepEqual(new Set(rows.map((row) => row.order)), new Set(Object.values(PairOrder)));
  });
});
