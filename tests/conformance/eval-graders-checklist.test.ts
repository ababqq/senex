/**
 * The checklist grader (§8.4) through its interface, with a fake `GraderComplete`: no provider is
 * ever reached. It pins the vote (odd calls per family, majority, fewer than two decided votes is
 * inconclusive), the conjunction across families, the scores, the control item, the skipped runs,
 * the Rule 18 frame filter, and a hostile-path table in which nothing outside the evidence root is
 * read or sent. The engine binding is checked against a real `CodexEngine` with a scripted CLI.
 */
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { AcceptanceItem, EvalCase } from "../../scripts/evals/case-types.ts";
import {
  type CompletingEngine,
  engineGraderComplete,
  type GraderComplete,
  GraderEngineMissing,
  type GraderPrompt,
  tokenUsageFromEngine,
} from "../../scripts/evals/grade/checklist/complete.ts";
import {
  createGraderEngines,
  GraderSetupError,
  GraderSetupProblem,
} from "../../scripts/evals/grade/checklist/engines.ts";
import { MIN_EVIDENCE_FRAMES, pickFrames, witnessedFrames } from "../../scripts/evals/grade/checklist/evidence.ts";
import {
  defaultGraderPins,
  GraderPinError,
  GraderPinProblem,
  validateGraderPins,
} from "../../scripts/evals/grade/checklist/family.ts";
import { createGradeChecklist } from "../../scripts/evals/grade/checklist/grade.ts";
import {
  CHECKLIST_PROMPT_SHA,
  parseChecklistVote,
  renderChecklistPrompt,
} from "../../scripts/evals/grade/checklist/prompt.ts";
import {
  aggregateChecklistScores,
  scoredItemCount,
  toRowChecklist,
} from "../../scripts/evals/grade/checklist/score.ts";
import { assertVoteCount, combineVerdicts, familyVerdict } from "../../scripts/evals/grade/checklist/vote.ts";
import type { ChecklistGradeRequest, EvidenceRefs, FrameRef, GraderPin } from "../../scripts/evals/grade/types.ts";
import {
  CaseExposure,
  CaseMode,
  CaseVisibility,
  ChecklistVote,
  GraderFamily,
  GraderVoid,
  ItemVerdict,
  NoBuild,
  ProbePhase,
} from "../../scripts/evals/vocabulary.ts";
import { ZERO_TOKEN_USAGE } from "../../src/shared/eval-lane.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PROJECT_ORIGIN = "http://127.0.0.1:41000";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SECRET = "SYNTHETIC-SECRET-7f3a";

/** A tiny "PNG": the magic bytes, then the frame's name so a test can tell which frame was sent. */
function pngBytes(name: string): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.from(`frame:${name}`)]);
}

function item(index: number, text: string, extra: Partial<AcceptanceItem> = {}): AcceptanceItem {
  return {
    id: `synthetic-golf-${index}`,
    text,
    tracesTo: null,
    key: false,
    assetsOnly: false,
    control: false,
    ...extra,
  };
}

function syntheticCase(acceptance: AcceptanceItem[]): EvalCase {
  return {
    id: "synthetic-golf",
    number: 90,
    label: "synthetic putting green",
    brief: "A synthetic brief: one putting green with a ball and a cup.",
    mode: CaseMode.Build,
    exposure: CaseExposure.None,
    exposureReason: null,
    visibility: CaseVisibility.Public,
    acceptance,
    followUps: [],
    deadlineMin: 30,
    version: "0123456789ab",
    checklistVersion: "ba9876543210",
    startFrom: null,
  };
}

interface EvidenceFixture {
  root: string;
  refs: EvidenceRefs;
}

/** An evidence folder: one boot frame, `count` witnessed frames, one frame off the project's origin. */
async function evidenceFixture(count = 10): Promise<EvidenceFixture> {
  const root = await tmpDir("eval-graders-evidence-");
  const frames: FrameRef[] = [];
  const add = async (name: string, atMs: number, phase: FrameRef["phase"], origin = PROJECT_ORIGIN) => {
    await writeFile(path.join(root, `${name}.png`), pngBytes(name));
    frames.push({ path: path.join(root, `${name}.png`), atMs, phase, origin, width: 8, height: 8 });
  };
  await add("boot", 100, ProbePhase.Boot);
  for (let index = 0; index < count; index += 1) await add(`play-${index}`, 1_000 + index * 500, ProbePhase.InputBurst);
  await add("elsewhere", 2_200, ProbePhase.InputBurst, "http://127.0.0.1:41999");
  await writeFile(path.join(root, "console.txt"), "synthetic console line");
  await writeFile(path.join(root, "network.txt"), "GET /index.html 200");
  return {
    root,
    refs: {
      projectOrigin: PROJECT_ORIGIN,
      frames,
      consoleSummaryPath: "console.txt",
      networkSummaryPath: "network.txt",
      videoPath: null,
      summaryBytes: 4096,
    },
  };
}

interface Recorded {
  pin: GraderPin;
  prompt: GraderPrompt;
}

/** A fake grader: answers by the item and the family, and records every call. */
function fakeComplete(answer: (pin: GraderPin, prompt: string) => string): {
  complete: GraderComplete;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const complete: GraderComplete = async (pin, prompt) => {
    calls.push({ pin, prompt });
    return {
      text: answer(pin, prompt.text),
      model: pin.model,
      usage: { ...ZERO_TOKEN_USAGE, uncachedInput: 10, output: 2 },
    };
  };
  return { complete, calls };
}

const YES = "VERDICT: YES\nWHY: synthetic";
const NO = "VERDICT: NO\nWHY: synthetic";

function request(
  evalCase: EvalCase,
  evidence: EvidenceRefs,
  extra: Partial<ChecklistGradeRequest> = {},
): ChecklistGradeRequest {
  return {
    evalCase,
    evidence,
    graders: defaultGraderPins(CHECKLIST_PROMPT_SHA),
    votesPerFamily: 3,
    fullAssets: false,
    noBuild: null,
    runEngine: null,
    ...extra,
  };
}

/** The frame names a call carried. */
function sentFrames(call: Recorded): string[] {
  return call.prompt.images.map((image) => Buffer.from(image.data, "base64").subarray(PNG_MAGIC.length).toString());
}

describe("checklist vote parsing", () => {
  const table: Array<[string, string, ChecklistVote]> = [
    ["a plain yes", YES, ChecklistVote.Yes],
    ["a plain no", "verdict: no\nwhy: nothing moved", ChecklistVote.No],
    ["markdown bold", "**VERDICT:** YES\nWHY: it rolls", ChecklistVote.Yes],
    ["the template echoed back", "VERDICT: YES or NO\nWHY: one sentence", ChecklistVote.Invalid],
    ["both answers", "VERDICT: YES\nVERDICT: NO", ChecklistVote.Invalid],
    ["no verdict line", "The ball rolls, so yes.", ChecklistVote.Invalid],
    ["empty", "", ChecklistVote.Invalid],
  ];
  for (const [name, reply, vote] of table) it(`reads ${name}`, () => assert.equal(parseChecklistVote(reply), vote));
});

describe("checklist prompt", () => {
  it("fills placeholders once, so evidence that spells one is not substituted again", () => {
    const text = renderChecklistPrompt({
      brief: "synthetic brief",
      item: item(1, "the cup is visible", { tracesTo: "a cup" }),
      consoleSummary: "log says {{brief}}",
      networkSummary: "",
      frameCount: 3,
    });
    assert.ok(text.includes("synthetic brief"));
    assert.ok(text.includes("the cup is visible"));
    assert.ok(text.includes("log says {{brief}}"));
    assert.ok(!text.includes("{{item}}"));
    assert.match(CHECKLIST_PROMPT_SHA, /^[0-9a-f]{64}$/);
  });
});

describe("the vote", () => {
  const table: Array<[ChecklistVote[], ItemVerdict, number]> = [
    [[ChecklistVote.Yes, ChecklistVote.Yes, ChecklistVote.No], ItemVerdict.Pass, 3],
    [[ChecklistVote.No, ChecklistVote.No, ChecklistVote.Yes], ItemVerdict.Fail, 3],
    [[ChecklistVote.Yes, ChecklistVote.Invalid, ChecklistVote.Invalid], ItemVerdict.Inconclusive, 1],
    [[ChecklistVote.Yes, ChecklistVote.No, ChecklistVote.Invalid], ItemVerdict.Inconclusive, 2],
    [[ChecklistVote.Yes, ChecklistVote.Yes, ChecklistVote.Invalid], ItemVerdict.Pass, 2],
  ];
  for (const [votes, verdict, decided] of table) {
    it(`${votes.join(",")} → ${verdict}`, () => assert.deepEqual(familyVerdict(votes), { decided, verdict }));
  }

  it("combines families by conjunction and never sums them", () => {
    assert.equal(combineVerdicts([ItemVerdict.Pass, ItemVerdict.Pass]), ItemVerdict.Pass);
    assert.equal(combineVerdicts([ItemVerdict.Fail, ItemVerdict.Fail]), ItemVerdict.Fail);
    assert.equal(combineVerdicts([ItemVerdict.Pass, ItemVerdict.Fail]), ItemVerdict.Inconclusive);
    assert.equal(combineVerdicts([ItemVerdict.Pass, ItemVerdict.Inconclusive]), ItemVerdict.Inconclusive);
    assert.equal(combineVerdicts([]), ItemVerdict.Inconclusive);
  });

  it("refuses an even or too small vote count", () => {
    for (const bad of [0, 1, 2, 4, 3.5]) assert.throws(() => assertVoteCount(bad), RangeError);
    assert.doesNotThrow(() => assertVoteCount(3));
    assert.doesNotThrow(() => assertVoteCount(5));
  });
});

describe("grader pins", () => {
  const pins = defaultGraderPins(CHECKLIST_PROMPT_SHA);
  const [claude, gpt] = pins;
  assert.ok(claude && gpt);
  const table: Array<[string, GraderPin[], GraderPinProblem]> = [
    ["no graders", [], GraderPinProblem.NoGraders],
    ["one family twice", [claude, { ...claude, model: "claude-haiku-4-5" }], GraderPinProblem.FamilyTwice],
    [
      "an engine under another family",
      [{ ...gpt, engine: EngineId.ClaudeCode }],
      GraderPinProblem.EngineFamilyMismatch,
    ],
    ["another template", [{ ...claude, promptSha: "0".repeat(64) }], GraderPinProblem.PromptShaMismatch],
  ];
  for (const [name, bad, problem] of table) {
    it(`refuses ${name}`, () => {
      assert.throws(
        () => validateGraderPins(bad, CHECKLIST_PROMPT_SHA),
        (err: unknown) => err instanceof GraderPinError && err.problem === problem,
      );
    });
  }

  it("defaults to one Claude and one GPT grader at low effort", () => {
    assert.deepEqual(
      pins.map((pin) => [pin.family, pin.engine, pin.model, pin.effort]),
      [
        [GraderFamily.Claude, EngineId.ClaudeCode, "claude-sonnet-5-5", "low"],
        [GraderFamily.Gpt, EngineId.Codex, "gpt-6.1-sol", "low"],
      ],
    );
  });
});

describe("witnessed frames (Rule 18)", () => {
  it("keeps frames after the entrance on the project's origin, and samples evenly", async () => {
    const { refs } = await evidenceFixture(20);
    const kept = witnessedFrames(refs.frames, refs.projectOrigin);
    assert.equal(kept.length, 20);
    assert.ok(kept.every((frame) => frame.phase !== ProbePhase.Boot && frame.origin === PROJECT_ORIGIN));
    const picked = pickFrames(kept);
    assert.equal(picked.length, 8);
    assert.equal(picked[0], kept[0]);
    assert.equal(picked.at(-1), kept.at(-1));
  });
});

const ACCEPTANCE = [
  item(1, "you can aim"),
  item(2, "power is controllable"),
  item(3, "strokes are shown"),
  item(4, "full assets only: textured grass", { assetsOnly: true }),
  item(5, "a dragon sings the score", { control: true }),
];

describe("grading a run", () => {
  const acceptance = ACCEPTANCE;

  it("votes three times per family per item and scores by conjunction", async () => {
    const { root, refs } = await evidenceFixture();
    const fake = fakeComplete((pin, prompt) => {
      if (prompt.includes("dragon")) return NO;
      if (prompt.includes("you can aim")) return YES;
      if (prompt.includes("power is controllable")) return pin.family === GraderFamily.Claude ? YES : NO;
      return NO;
    });
    const grade = createGradeChecklist({ complete: fake.complete, evidenceRoot: root });
    const result = await grade(request(syntheticCase(acceptance), refs));

    assert.equal(fake.calls.length, 4 * 2 * 3, "4 applicable items × 2 families × 3 votes");
    assert.deepEqual(
      result.items.map((entry) => entry.combined),
      [ItemVerdict.Pass, ItemVerdict.Inconclusive, ItemVerdict.Fail, ItemVerdict.Fail],
    );
    assert.equal(result.scoreAllRuns, 1 / 3);
    assert.equal(result.scoreGraded, 1 / 2);
    assert.equal(result.inconclusiveRate, 1 / 3);
    assert.equal(result.graderVoid, null);
    assert.equal(result.judgeSkipped, false);
    assert.deepEqual(result.usage, { ...ZERO_TOKEN_USAGE, uncachedInput: 240, output: 48 });
    assert.deepEqual(toRowChecklist(result).byFamily, {
      [GraderFamily.Claude]: { passed: 2, graded: 3, inconclusive: 0 },
      [GraderFamily.Gpt]: { passed: 1, graded: 3, inconclusive: 0 },
    });
    for (const call of fake.calls) {
      const names = sentFrames(call);
      assert.ok(names.length <= 8);
      assert.ok(!names.includes("boot") && !names.includes("elsewhere"), "only witnessed, on-origin frames");
    }
  });

  it("voids the grade when any family passes the control item", async () => {
    const { root, refs } = await evidenceFixture();
    const fake = fakeComplete((pin, prompt) =>
      prompt.includes("dragon") && pin.family === GraderFamily.Gpt ? YES : NO,
    );
    const result = await createGradeChecklist({ complete: fake.complete, evidenceRoot: root })(
      request(syntheticCase(acceptance), refs),
    );
    assert.equal(result.graderVoid, GraderVoid.ControlPassed);
  });

  it("grades full-assets-only items only when the run had assets", async () => {
    const { root, refs } = await evidenceFixture();
    const fake = fakeComplete(() => NO);
    const grade = createGradeChecklist({ complete: fake.complete, evidenceRoot: root });
    const without = await grade(request(syntheticCase(acceptance), refs));
    const withAssets = await grade(request(syntheticCase(acceptance), refs, { fullAssets: true }));
    assert.ok(!without.items.some((entry) => entry.item.assetsOnly));
    assert.ok(withAssets.items.some((entry) => entry.item.assetsOnly));
    assert.equal(scoredItemCount(acceptance, false), 3);
    assert.equal(scoredItemCount(acceptance, true), 4);
  });
});

describe("runs graded partly or not at all", () => {
  const acceptance = ACCEPTANCE;

  it("counts a failed call as an invalid vote, never as a no", async () => {
    const { root, refs } = await evidenceFixture();
    const grade = createGradeChecklist({
      complete: async () => {
        throw new Error("synthetic outage");
      },
      evidenceRoot: root,
    });
    const result = await grade(request(syntheticCase([item(1, "you can aim")]), refs));
    const [only] = result.items;
    assert.ok(only);
    assert.equal(only.combined, ItemVerdict.Inconclusive);
    assert.deepEqual(only.byFamily[0]?.votes, [ChecklistVote.Invalid, ChecklistVote.Invalid, ChecklistVote.Invalid]);
    assert.equal(result.scoreAllRuns, 0);
    assert.equal(result.scoreGraded, null);
  });

  it("marks the grader of the run's own family as same-family", async () => {
    const { root, refs } = await evidenceFixture();
    const fake = fakeComplete(() => YES);
    const result = await createGradeChecklist({ complete: fake.complete, evidenceRoot: root })(
      request(syntheticCase([item(1, "you can aim")]), refs, { runEngine: EngineId.ClaudeCode }),
    );
    assert.deepEqual(
      result.items[0]?.byFamily.map((votes) => [votes.family, votes.sameFamily]),
      [
        [GraderFamily.Claude, true],
        [GraderFamily.Gpt, false],
      ],
    );
  });

  it("never grades a typed no-build or too little evidence, and makes no call", async () => {
    const { root, refs } = await evidenceFixture();
    const few = await evidenceFixture(MIN_EVIDENCE_FRAMES - 1);
    const fake = fakeComplete(() => YES);
    const grade = createGradeChecklist({ complete: fake.complete, evidenceRoot: root });
    const noBuild = await grade(request(syntheticCase(acceptance), refs, { noBuild: NoBuild.TemplateUntouched }));
    const thin = await createGradeChecklist({ complete: fake.complete, evidenceRoot: few.root })(
      request(syntheticCase(acceptance), few.refs),
    );
    for (const result of [noBuild, thin]) {
      assert.equal(result.judgeSkipped, true);
      assert.equal(result.scoreAllRuns, 0);
      assert.deepEqual(result.items, []);
    }
    assert.equal(fake.calls.length, 0);
  });

  it("refuses mismatched pins before any call", async () => {
    const { root, refs } = await evidenceFixture();
    const fake = fakeComplete(() => YES);
    const graders = defaultGraderPins("f".repeat(64));
    await assert.rejects(
      createGradeChecklist({ complete: fake.complete, evidenceRoot: root })(
        request(syntheticCase(acceptance), refs, { graders }),
      ),
      GraderPinError,
    );
    assert.equal(fake.calls.length, 0);
  });
});

describe("hostile evidence paths: nothing outside the evidence root is read or sent", () => {
  /** A root with a secret beside it, a sibling folder sharing its prefix, and a link out. */
  async function hostileLayout() {
    const parent = await tmpDir("eval-graders-hostile-");
    const root = path.join(parent, "evidence");
    const sibling = path.join(parent, "evidence-evil");
    await mkdir(root);
    await mkdir(sibling);
    const secretPng = Buffer.concat([PNG_MAGIC, Buffer.from(SECRET)]);
    await writeFile(path.join(parent, "outside.png"), secretPng);
    await writeFile(path.join(sibling, "frame.png"), secretPng);
    await writeFile(path.join(parent, "secret.txt"), SECRET);
    await symlink(path.join(parent, "outside.png"), path.join(root, "link.png"));
    await symlink(path.join(parent, "secret.txt"), path.join(root, "link.txt"));
    await writeFile(path.join(root, "not-an-image.png"), `text ${SECRET}`);
    for (let index = 0; index < 4; index += 1)
      await writeFile(path.join(root, `ok-${index}.png`), pngBytes(`ok-${index}`));
    return { parent, root, sibling };
  }

  const frame = (file: string, atMs: number): FrameRef => ({
    path: file,
    atMs,
    phase: ProbePhase.InputBurst,
    origin: PROJECT_ORIGIN,
    width: 8,
    height: 8,
  });

  it("drops every escaping frame and summary before reading it", async () => {
    const { parent, root, sibling } = await hostileLayout();
    const hostileFrames = [
      "../outside.png",
      path.join(parent, "outside.png"),
      path.join(sibling, "frame.png"),
      "link.png",
      "not-an-image.png",
      "missing.png",
      "ok-0.png\u0000",
      "",
    ];
    const hostileSummaries = ["../secret.txt", path.join(parent, "secret.txt"), "link.txt", "/etc/hosts"];
    for (const [index, hostile] of hostileFrames.entries()) {
      const summary = hostileSummaries[index % hostileSummaries.length] ?? "";
      const refs: EvidenceRefs = {
        projectOrigin: PROJECT_ORIGIN,
        frames: [frame("ok-0.png", 1_000), frame(hostile, 1_500), frame("ok-1.png", 2_000)],
        consoleSummaryPath: summary,
        networkSummaryPath: summary,
        videoPath: null,
        summaryBytes: 4096,
      };
      const fake = fakeComplete(() => YES);
      await createGradeChecklist({ complete: fake.complete, evidenceRoot: root })(
        request(syntheticCase([item(1, "you can aim")]), refs),
      );
      assert.equal(fake.calls.length, 6, `graded on the two safe frames (${hostile})`);
      for (const call of fake.calls) {
        assert.deepEqual(sentFrames(call), ["frame:ok-0", "frame:ok-1"]);
        assert.ok(!call.prompt.text.includes(SECRET), `no secret in the prompt (${summary})`);
      }
    }
  });

  it("skips a run whose only frames escape, with no call", async () => {
    const { parent, root } = await hostileLayout();
    const refs: EvidenceRefs = {
      projectOrigin: PROJECT_ORIGIN,
      frames: [
        frame("../outside.png", 1_000),
        frame(path.join(parent, "outside.png"), 2_000),
        frame("link.png", 3_000),
      ],
      consoleSummaryPath: "../secret.txt",
      networkSummaryPath: "../secret.txt",
      videoPath: null,
      summaryBytes: 4096,
    };
    const fake = fakeComplete(() => YES);
    const result = await createGradeChecklist({ complete: fake.complete, evidenceRoot: root })(
      request(syntheticCase([item(1, "you can aim")]), refs),
    );
    assert.equal(result.judgeSkipped, true);
    assert.equal(fake.calls.length, 0);
  });
});

describe("scores across runs", () => {
  it("counts a skipped run's items as 0 and leaves void grades out", async () => {
    const { root, refs } = await evidenceFixture();
    const acceptance = [item(1, "you can aim"), item(2, "strokes are shown"), item(3, "a dragon", { control: true })];
    const evalCase = syntheticCase(acceptance);
    const passing = await createGradeChecklist({
      complete: fakeComplete((_, p) => (p.includes("dragon") ? NO : YES)).complete,
      evidenceRoot: root,
    })(request(evalCase, refs));
    const voided = await createGradeChecklist({ complete: fakeComplete(() => YES).complete, evidenceRoot: root })(
      request(evalCase, refs),
    );
    const skipped = await createGradeChecklist({ complete: fakeComplete(() => YES).complete, evidenceRoot: root })(
      request(evalCase, refs, { noBuild: NoBuild.NoEntry }),
    );
    const scoredItems = scoredItemCount(acceptance, false);
    const aggregate = aggregateChecklistScores([
      { result: passing, scoredItems },
      { result: voided, scoredItems },
      { result: skipped, scoredItems },
    ]);
    assert.deepEqual(aggregate, {
      runs: 2,
      scoreAllRuns: 0.5,
      scoreGraded: 1,
      judgeSkippedRate: 0.5,
      inconclusiveRate: 0,
    });
  });
});

describe("binding graders to the app's engines", () => {
  it("sends one toolless user message with the frames, the pinned model and effort", async () => {
    const seen: unknown[] = [];
    const engine: CompletingEngine = {
      complete: async (req) => {
        seen.push(req);
        return {
          message: { role: "assistant", content: YES },
          usage: { input_tokens: 120, cache_read_tokens: 100, output_tokens: 7 },
          stopReason: "stop",
          model: "gpt-6.1-sol",
          engine: EngineId.Codex,
        };
      },
    };
    const [, gpt] = defaultGraderPins(CHECKLIST_PROMPT_SHA);
    assert.ok(gpt);
    const image = { mimeType: "image/png", data: pngBytes("x").toString("base64"), label: "frame 1/1" };
    const reply = await engineGraderComplete({ [EngineId.Codex]: engine })(gpt, { text: "question", images: [image] });
    assert.equal(reply.text, YES);
    assert.deepEqual(reply.usage, { uncachedInput: 20, cacheWrite: 0, cacheRead: 100, output: 7, reasoning: 0 });
    const [sent] = seen as Array<{ model: string; effort: string; tools?: unknown; messages: unknown[] }>;
    assert.equal(sent?.model, "gpt-6.1-sol");
    assert.equal(sent?.effort, "low");
    assert.equal(sent?.tools, undefined);
    assert.deepEqual(sent?.messages, [{ role: "user", content: "question", images: [image] }]);
  });

  it("keeps Anthropic's input as uncached and refuses an engine it was not given", async () => {
    assert.deepEqual(tokenUsageFromEngine(EngineId.ClaudeCode, { input_tokens: 30, cache_read_tokens: 500 }), {
      uncachedInput: 30,
      cacheWrite: 0,
      cacheRead: 500,
      output: 0,
      reasoning: 0,
    });
    const [claude] = defaultGraderPins(CHECKLIST_PROMPT_SHA);
    assert.ok(claude);
    await assert.rejects(engineGraderComplete({})(claude, { text: "q", images: [] }), GraderEngineMissing);
  });
});

describe("building the grading engines", () => {
  it("refuses a foreign CLI home before building anything", async () => {
    const homes = {
      claude: await tmpDir("eval-graders-claude-home-"),
      codex: await tmpDir("eval-graders-codex-home-"),
    };
    const table: Array<[string, Parameters<typeof createGraderEngines>[0], GraderSetupProblem]> = [
      [
        "a foreign CODEX_HOME",
        { homes, judgeCwd: homes.claude, env: { CODEX_HOME: "/tmp/somewhere-else" } },
        GraderSetupProblem.ForeignHome,
      ],
      [
        "a foreign CLAUDE_CONFIG_DIR",
        { homes, judgeCwd: homes.claude, env: { CLAUDE_CONFIG_DIR: "/tmp/somewhere-else" } },
        GraderSetupProblem.ForeignHome,
      ],
    ];
    for (const [name, options, problem] of table) {
      await assert.rejects(
        createGraderEngines(options),
        (err: unknown) => err instanceof GraderSetupError && err.problem === problem,
        name,
      );
    }
  });

  it("runs the Codex grader in the eval home, read-only and ephemeral, host skills off, frames as images", async (t) => {
    if (process.env.CODEX_HOME) {
      t.skip("CODEX_HOME is set in this environment; the engine would prefer it over the eval home");
      return;
    }
    const homes = {
      claude: await tmpDir("eval-graders-claude-home-"),
      codex: await tmpDir("eval-graders-codex-home-"),
    };
    const hostSkillsDir = await tmpDir("eval-graders-host-skills-");
    const hostSkill = path.join(hostSkillsDir, "operator-skill", "SKILL.md");
    await mkdir(path.dirname(hostSkill), { recursive: true });
    await writeFile(hostSkill, "synthetic host skill\n");
    const invocations: Array<{ argv: string[]; env: Record<string, string>; prompt: string }> = [];
    const engines = await createGraderEngines({
      homes,
      judgeCwd: homes.claude,
      hostSkillsDir,
      env: {},
      codex: {
        executable: "/synthetic/codex",
        execFn: async function* (invocation) {
          invocations.push(invocation);
          yield { type: "item.completed", item: { type: "agent_message", text: YES } };
          yield { type: "turn.completed", usage: { input_tokens: 50, cached_input_tokens: 40, output_tokens: 3 } };
        },
      },
    });
    const [, gpt] = defaultGraderPins(CHECKLIST_PROMPT_SHA);
    assert.ok(gpt);
    const image = { mimeType: "image/png", data: pngBytes("x").toString("base64"), label: "frame 1/1" };
    const reply = await engineGraderComplete(engines)(gpt, { text: "synthetic question", images: [image] });
    assert.equal(parseChecklistVote(reply.text), ChecklistVote.Yes);
    assert.deepEqual(reply.usage, { uncachedInput: 10, cacheWrite: 0, cacheRead: 40, output: 3, reasoning: 0 });
    const [call] = invocations;
    assert.ok(call);
    assert.equal(call.env.CODEX_HOME, homes.codex);
    for (const flag of ["--ephemeral", "read-only", "gpt-6.1-sol", "-i"]) assert.ok(call.argv.includes(flag), flag);
    assert.ok(call.argv.includes(`skills.config=[{path=${JSON.stringify(hostSkill)},enabled=false}]`));
    assert.equal(call.argv[call.argv.indexOf("--disable") + 1], "computer_use");
    assert.equal(call.argv.at(-1), "-");
    assert.ok(call.prompt.includes("synthetic question"));
  });
});
