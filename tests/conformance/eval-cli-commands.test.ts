/**
 * The CLI-owned eval commands (scripts/evals/cli/) over temp evals homes and temp repository roots,
 * with rows written through the real ledger writer: `report` (scorecard, explorer, trend, and the
 * Diagnostics gate), `compare`, `check` (same-campaign base, committed baseline, withheld verdict),
 * `baseline promote` (refusals, the repeatability precondition, and a promoted file that Biome
 * accepts), `ledger export`, `validate-ledger`, `cases` and `gc` (dry run, removal, and everything
 * it must keep). Nothing touches a provider, a browser or the network.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  appendFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { casesCommand } from "../../scripts/evals/cli/cases.ts";
import { checkCommand } from "../../scripts/evals/cli/check.ts";
import { compareCommand } from "../../scripts/evals/cli/compare.ts";
import { biomeFormatter, REPO_ROOT } from "../../scripts/evals/cli/context.ts";
import { CliExit } from "../../scripts/evals/cli/exit.ts";
import { gcCommand } from "../../scripts/evals/cli/gc.ts";
import { ledgerExportCommand, validateLedgerCommand } from "../../scripts/evals/cli/ledger.ts";
import { baselinePromoteCommand } from "../../scripts/evals/cli/promote.ts";
import { REPORTS_DIR, reportCommand } from "../../scripts/evals/cli/report.ts";
import { BASELINES_DIR } from "../../scripts/evals/grade/regrade.ts";
import type { RowLane, RunRow } from "../../scripts/evals/ledger/types.ts";
import { withGradeId } from "../../scripts/evals/ledger/write.ts";
import { parseBaseline } from "../../scripts/evals/report/baseline.ts";
import { comparabilityKey, PinField, showPinFact } from "../../scripts/evals/report/comparability.ts";
import { ENDPOINTS_SHA, MetricId } from "../../scripts/evals/report/endpoints.ts";
import { CaseVisibility, CHECK_EXIT_CODE, CheckState } from "../../scripts/evals/vocabulary.ts";
import {
  BASE_SHA,
  CAND_SHA,
  type CliWorld,
  canaryRow,
  cliWorld,
  gradedRow,
  recordGreen,
  seedRows,
  writePlan,
  writeRepeatability,
} from "../fixtures/evals/cli/ledger.ts";
import { CAMPAIGN, CASE_ID, gradingCase, LANES, runIdOf } from "../fixtures/evals/grading/campaign.ts";
import { closeBeforeCleanup } from "../helpers/tmp.ts";

const run = promisify(execFile);
/** A holdout case's id, which must never reach the repository. */
const HOLDOUT_ID = "holdout-1";
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );
type Handler = (args: readonly string[], out: (line: string) => void, given: CliWorld["ctx"]) => Promise<number>;

/** Run a handler against a world; answers its exit code and what it printed. */
async function call(handler: Handler, args: readonly string[], world: CliWorld) {
  world.lines.length = 0;
  const code = await handler(args, world.out, world.ctx);
  return { code, text: world.lines.join("\n") };
}

/** Four lanes of one case, three full grades each, all booting. */
function healthyCampaign() {
  return [LANES.a, LANES.b, LANES.c, LANES.d].flatMap((lane) =>
    [1, 2, 3].map((rep) => gradedRow({ lane, rep, boots: true })),
  );
}

/** Lane A's base app booting six times (reps 1–6), then the candidate's attempts (reps 7…). */
function versionCampaign(candidateBoots: readonly boolean[], noisyBase = false) {
  const base = [1, 2, 3, 4, 5, 6].map((rep) =>
    gradedRow({ lane: LANES.a, rep, boots: true, appSha: BASE_SHA, apiError: noisyBase && rep === 1 }),
  );
  const cand = candidateBoots.map((boots, index) =>
    gradedRow({ lane: LANES.a, rep: 7 + index, boots, appSha: CAND_SHA }),
  );
  return [...base, ...cand];
}

describe("report", () => {
  it("prints the Diagnostics block and the Markdown scorecard", async () => {
    const world = await cliWorld();
    await seedRows(world, healthyCampaign());
    const result = await call(reportCommand, [CAMPAIGN], world);
    assert.equal(result.code, CliExit.Ok, result.text);
    assert.match(result.text, /^Diagnostics$/m);
    assert.match(result.text, new RegExp(`# Scorecard · ${CAMPAIGN}`));
    assert.match(result.text, /Direction needs ≥5 distinct cases; this campaign has 1\./);
  });

  it("writes the explorer under the evals home with --html and trends with --trend", async () => {
    const world = await cliWorld();
    await seedRows(world, versionCampaign([true, true, true]));
    const html = await call(reportCommand, [CAMPAIGN, "--html"], world);
    assert.equal(html.code, CliExit.Ok);
    const file = path.join(world.paths.home, REPORTS_DIR, `${CAMPAIGN}.html`);
    assert.match(html.text, new RegExp(`wrote ${file}`));
    assert.match(await readFile(file, "utf8"), /^<!doctype html>/);
    const trend = await call(reportCommand, [CAMPAIGN, "--trend", "--metric", MetricId.BootRate], world);
    assert.equal(trend.code, CliExit.Ok, trend.text);
    assert.match(trend.text, /rate\.boot · genex-claude · grading-case/);
    assert.match(trend.text, /bbbbbbbb: median 100%/);
  });

  it("exits 1 while a diagnostic is red, 2 with no rows, and 64 on bad usage", async () => {
    const world = await cliWorld();
    assert.equal((await call(reportCommand, [CAMPAIGN], world)).code, CliExit.NotReady);
    await seedRows(world, versionCampaign([true], true));
    const red = await call(reportCommand, [CAMPAIGN], world);
    assert.equal(red.code, CliExit.Refused);
    assert.match(red.text, /Promotion blocked by: plumbing/);
    for (const args of [[], [CAMPAIGN, "--md", "--html"], [CAMPAIGN, "--metric", MetricId.BootRate], ["../x"]])
      assert.equal((await call(reportCommand, args, world)).code, CliExit.Usage, args.join(" "));
    assert.equal((await call(reportCommand, [CAMPAIGN, "--trend", "--metric", "nope"], world)).code, CliExit.Usage);
  });
});

describe("compare", () => {
  const arm = (lane: string) => `${CAMPAIGN}:${lane}`;

  it("compares two arms on an axis, refusing an aggregate below five cases", async () => {
    const world = await cliWorld();
    await seedRows(world, healthyCampaign());
    const args = ["--axis", "model-stack", "--a", arm(LANES.a.id), "--b", arm(LANES.d.id)];
    const result = await call(compareCommand, args, world);
    assert.equal(result.code, CliExit.Ok, result.text);
    assert.match(result.text, /^labels: grader-family-confounded$/m);
    assert.match(result.text, /^Primary checklist\.scoreAllRuns$/m);
    assert.match(result.text, /rate\.playableWithin30Min: n=1 is below the N=5 floor/);
    assert.match(result.text, /^ {2}cases \(A → B\): \d+\/\d+ → \d+\/\d+$/m, "a rate keeps its per-case pass counts");
    assert.match(result.text, /pairwise\.overallWinRate is a campaign-level metric/);
  });

  it("refuses arms that differ outside the axis, and is not ready for an empty arm", async () => {
    const world = await cliWorld();
    await seedRows(world, healthyCampaign());
    const refused = await call(
      compareCommand,
      ["--axis", "version", "--a", arm("raw-claude"), "--b", arm("raw-codex")],
      world,
    );
    assert.equal(refused.code, CliExit.Refused);
    assert.match(refused.text, /^refused incomparable: refusing to compare/m);
    const empty = await call(
      compareCommand,
      ["--axis", "version", "--a", arm("raw-claude"), "--b", arm("nobody")],
      world,
    );
    assert.equal(empty.code, CliExit.NotReady);
    assert.match(empty.text, /not-ready empty-arm B/);
    for (const args of [
      ["--axis", "sideways", "--a", arm("x"), "--b", arm("y")],
      ["--axis", "version", "--a", "../x:y", "--b", arm("y")],
    ])
      assert.equal((await call(compareCommand, args, world)).code, CliExit.Usage);
  });
});

describe("check", () => {
  it("answers the gate's exit codes against the same campaign's base app", async () => {
    const cases: Array<[readonly boolean[], CheckState]> = [
      [[false, false, false], CheckState.Regression],
      [[false, false], CheckState.Probable],
      [[false, true], CheckState.Flaky],
      [[true], CheckState.Clear],
    ];
    for (const [attempts, state] of cases) {
      const world = await cliWorld();
      await writePlan(world, { base: BASE_SHA, cand: CAND_SHA });
      await seedRows(world, versionCampaign(attempts));
      const result = await call(checkCommand, [CAMPAIGN], world);
      assert.equal(result.code, CHECK_EXIT_CODE[state], `${attempts.join(",")}: ${result.text}`);
      assert.match(result.text, new RegExp(`${CASE_ID} × ${LANES.a.id}: ${state}`));
      assert.match(result.text, /^Diagnostics$/m);
    }
  });

  it("withholds a clear verdict while a diagnostic is red; a failing verdict keeps its code", async () => {
    const world = await cliWorld();
    await writePlan(world, { base: BASE_SHA, cand: CAND_SHA });
    await seedRows(world, versionCampaign([true], true));
    const clear = await call(checkCommand, [CAMPAIGN], world);
    assert.equal(clear.code, CliExit.Refused);
    assert.match(clear.text, /verdict withheld: diagnostics red \(plumbing\)/);
    const failing = await cliWorld();
    await writePlan(failing, { base: BASE_SHA, cand: CAND_SHA });
    await seedRows(failing, versionCampaign([false, false, false], true));
    assert.equal((await call(checkCommand, [CAMPAIGN], failing)).code, CHECK_EXIT_CODE[CheckState.Regression]);
  });

  it("prints the Diagnostics block before the cell verdicts, and the withheld line last", async () => {
    const world = await cliWorld();
    await writePlan(world, { base: BASE_SHA, cand: CAND_SHA });
    await seedRows(world, versionCampaign([true], true));
    const lines = (await call(checkCommand, [CAMPAIGN], world)).text.split("\n");
    const at = (pattern: RegExp) => lines.findIndex((line) => pattern.test(line));
    const diagnostics = at(/^Diagnostics$/);
    const cell = at(new RegExp(`^${CASE_ID} × ${LANES.a.id}: `));
    const verdict = at(/^verdict: /);
    assert.ok(diagnostics >= 0 && cell >= 0 && verdict >= 0, lines.join("\n"));
    assert.ok(diagnostics < cell && cell < verdict, lines.join("\n"));
    assert.match(lines.at(-1) ?? "", /^verdict withheld: diagnostics red/);
  });

  /** A committed six-run, all-booting baseline for lane A, pinned like the candidate's rows unless overridden. */
  function committedBaseline(
    overrides: { caseVersion?: string; endpointsSha?: string; pins?: Record<string, string> } = {},
  ) {
    const key = comparabilityKey(gradedRow({ lane: LANES.a, rep: 7, boots: false }));
    const pins = Object.fromEntries(Object.values(PinField).map((field) => [field, showPinFact(key[field])]));
    return {
      schema: "genex-evals/baseline/1",
      caseId: CASE_ID,
      caseVersion: overrides.caseVersion ?? gradingCase.version,
      exposure: "none",
      campaignId: CAMPAIGN,
      promotedAt: "2026-09-30T00:00:00Z",
      epoch: "0123456789ab",
      endpointsSha: overrides.endpointsSha ?? ENDPOINTS_SHA,
      lanes: [
        {
          laneId: LANES.a.id,
          runIds: [1, 2, 3, 4, 5, 6].map((rep) => runIdOf(LANES.a, rep)),
          endedHow: Array(6).fill("agent-finished"),
          pins: { ...pins, ...overrides.pins },
          metrics: { [MetricId.BootRate]: [1, 1, 1, 1, 1, 1] },
        },
      ],
    };
  }

  it("refuses a committed baseline measured under other pins, naming the field, and never arms its cell", async () => {
    const stale: Array<[Parameters<typeof committedBaseline>[0], RegExp]> = [
      [{ caseVersion: "fedcba987654" }, /refused baseline .* × .*: case\.version fedcba987654 vs /],
      [{ endpointsSha: "0123456789ab" }, /refused baseline .* × .*: grading\.endpointsSha 0123456789ab vs /],
      [{ pins: { [PinField.CliVersion]: "0.0.1" } }, /refused baseline .* × .*: run\.cliVersion 0\.0\.1 vs /],
      [
        { pins: { [PinField.ProberVersion]: "prober-0" } },
        /refused baseline .* × .*: grading\.proberVersion prober-0 vs /,
      ],
    ];
    for (const [overrides, refusal] of stale) {
      const world = await cliWorld();
      await writePlan(world, null);
      await mkdir(path.join(world.root, BASELINES_DIR), { recursive: true });
      await writeFile(
        path.join(world.root, BASELINES_DIR, `${CASE_ID}.json`),
        JSON.stringify(committedBaseline(overrides)),
      );
      await seedRows(
        world,
        [false, false, false].map((boots, i) => gradedRow({ lane: LANES.a, rep: 7 + i, boots })),
      );
      const result = await call(checkCommand, [CAMPAIGN, "--baseline"], world);
      assert.equal(result.code, CliExit.Refused, result.text);
      assert.match(result.text, refusal);
      assert.match(result.text, /gate not armed/);
    }
  });

  it("falls back to the committed baseline, and refuses with no candidate runs", async () => {
    const world = await cliWorld();
    await writePlan(world, null);
    const baseline = committedBaseline();
    await mkdir(path.join(world.root, BASELINES_DIR), { recursive: true });
    await writeFile(path.join(world.root, BASELINES_DIR, `${CASE_ID}.json`), JSON.stringify(baseline));
    assert.equal((await call(checkCommand, [CAMPAIGN], world)).code, CliExit.Refused);
    await seedRows(
      world,
      [false, false, false].map((boots, i) => gradedRow({ lane: LANES.a, rep: 7 + i, boots })),
    );
    const result = await call(checkCommand, [CAMPAIGN, "--baseline"], world);
    assert.equal(result.code, CHECK_EXIT_CODE[CheckState.Regression], result.text);
    assert.match(result.text, /baseline 6\/6 booted/);
    await writeFile(path.join(world.root, BASELINES_DIR, `${CASE_ID}.json`), "{");
    const broken = await call(checkCommand, [CAMPAIGN, "--baseline"], world);
    assert.equal(broken.code, CliExit.Refused);
    assert.match(broken.text, /^refused baseline json$/m);
    assert.equal((await call(checkCommand, [], world)).code, CliExit.Usage);
  });
});

describe("baseline promote", () => {
  /** A promotable campaign: canaries, three full booting grades per lane, a green calibration. */
  async function promotable(world: CliWorld, extra: Parameters<typeof gradedRow>[0][] = []) {
    const canaries = [canaryRow(LANES.b, 1, true), canaryRow(LANES.b, 3, true)];
    const builds = [LANES.b, LANES.c].flatMap((lane) => [1, 2, 3].map((rep) => gradedRow({ lane, rep, boots: true })));
    await seedRows(world, [...canaries, ...builds, ...extra.map(gradedRow)]);
    await recordGreen(world);
  }

  it("writes one formatted baseline per case that Biome accepts", async () => {
    const world = await cliWorld({ formatJson: biomeFormatter(REPO_ROOT) });
    await promotable(world);
    await writeRepeatability(world, 5);
    const result = await call(baselinePromoteCommand, ["--campaign", CAMPAIGN], world);
    assert.equal(result.code, CliExit.Ok, result.text);
    const file = path.join(world.root, BASELINES_DIR, `${CASE_ID}.json`);
    assert.match(result.text, new RegExp(`wrote ${file}`));
    const baseline = parseBaseline(await readFile(file, "utf8"));
    assert.deepEqual(
      baseline.lanes.map((lane) => [lane.laneId, lane.metrics[MetricId.BootRate]]),
      [
        [LANES.b.id, [1, 1, 1]],
        [LANES.c.id, [1, 1, 1]],
      ],
    );
    const biome = path.join(REPO_ROOT, "node_modules", ".bin", "biome");
    await run(biome, ["check", file], { cwd: REPO_ROOT });
    assert.equal((await readdir(path.dirname(file))).length, 1, "no temp file is left beside it");
  });

  it("never writes a holdout case's baseline into the repository", async () => {
    const holdoutRow = (lane: RowLane, rep: number): RunRow => {
      const graded = gradedRow({ lane, rep, boots: true });
      return withGradeId({
        ...graded,
        runId: runIdOf(lane, rep, HOLDOUT_ID),
        case: { ...graded.case, id: HOLDOUT_ID, visibility: CaseVisibility.Holdout },
      });
    };
    const world = await cliWorld();
    await promotable(world);
    await seedRows(
      world,
      [LANES.b, LANES.c].flatMap((lane) => [1, 2, 3].map((rep) => holdoutRow(lane, rep))),
    );
    await writeRepeatability(world, 5);
    const result = await call(baselinePromoteCommand, ["--campaign", CAMPAIGN], world);
    assert.equal(result.code, CliExit.Ok, result.text);
    assert.deepEqual(await readdir(path.join(world.root, BASELINES_DIR)), [`${CASE_ID}.json`]);
    const written = await readFile(path.join(world.root, BASELINES_DIR, `${CASE_ID}.json`), "utf8");
    assert.equal(written.includes(HOLDOUT_ID), false);
    assert.match(result.text, /^withheld-holdouts 1$/m);

    const onlyHoldouts = await cliWorld();
    const canaries = [canaryRow(LANES.b, 1, true), canaryRow(LANES.b, 3, true)];
    await seedRows(onlyHoldouts, [...canaries, ...[1, 2, 3].map((rep) => holdoutRow(LANES.b, rep))]);
    await recordGreen(onlyHoldouts);
    await writeRepeatability(onlyHoldouts, 5);
    const refused = await call(baselinePromoteCommand, ["--campaign", CAMPAIGN], onlyHoldouts);
    assert.equal(refused.code, CliExit.Refused, refused.text);
    assert.match(refused.text, /refused no-public-cases/);
    assert.equal(await exists(path.join(onlyHoldouts.root, BASELINES_DIR)), false, "nothing is written");
  });

  it("is not ready without a re-graded repeatability sample, and writes nothing", async () => {
    const world = await cliWorld();
    await promotable(world);
    const result = await call(baselinePromoteCommand, ["--campaign", CAMPAIGN], world);
    assert.equal(result.code, CliExit.NotReady);
    assert.match(result.text, /not-ready grader-repeatability/);
    assert.equal(await exists(path.join(world.root, BASELINES_DIR)), false);
  });

  it("refuses on a red diagnostic, quick grades, missing canaries or a missing calibration", async () => {
    const red = await cliWorld();
    await promotable(red);
    await writeRepeatability(red, 5, 2);
    const blocked = await call(baselinePromoteCommand, ["--campaign", CAMPAIGN], red);
    assert.equal(blocked.code, CliExit.Refused);
    assert.match(blocked.text, /refused diagnostics-red grader-repeatability/);

    const bare = await cliWorld();
    await seedRows(
      bare,
      [1, 2, 3].map((rep) => gradedRow({ lane: LANES.b, rep, boots: true, quick: true })),
    );
    await writeRepeatability(bare, 5);
    const refused = await call(baselinePromoteCommand, ["--campaign", CAMPAIGN], bare);
    assert.equal(refused.code, CliExit.Refused);
    for (const code of ["opening-canary", "closing-canary", "calibration-red", "quick-grade"])
      assert.match(refused.text, new RegExp(`refused ${code}`));
    assert.equal(await exists(path.join(bare.root, BASELINES_DIR)), false);
  });

  it("is not ready with no rows and refuses bad usage", async () => {
    const world = await cliWorld();
    assert.equal((await call(baselinePromoteCommand, ["--campaign", CAMPAIGN], world)).code, CliExit.NotReady);
    for (const args of [[], [CAMPAIGN], ["--campaign", "../../etc"]])
      assert.equal((await call(baselinePromoteCommand, args, world)).code, CliExit.Usage);
  });
});

describe("ledger export and validate-ledger", () => {
  it("exports a release's public rows into the repository and refuses an empty release", async () => {
    const world = await cliWorld();
    await seedRows(world, versionCampaign([true]));
    const result = await call(ledgerExportCommand, ["--release", CAND_SHA], world);
    assert.equal(result.code, CliExit.Ok, result.text);
    const file = path.join(world.root, "evals", "ledger", `export-${CAND_SHA}.jsonl`);
    assert.match(result.text, /rows=7 holdouts-skipped=0/);
    assert.equal((await readFile(file, "utf8")).trim().split("\n").length, 7);
    assert.equal((await call(ledgerExportCommand, ["--release", "f".repeat(40)], world)).code, CliExit.NotReady);
    assert.equal(await exists(path.join(world.root, "evals", "ledger", `export-${"f".repeat(40)}.jsonl`)), false);
    for (const args of [[], ["--release", "../x"], ["--release"]])
      assert.equal((await call(ledgerExportCommand, args, world)).code, CliExit.Usage);
  });

  it("resolves a short release sha to the one full sha it names, and refuses an ambiguous one", async () => {
    const exportOf = (world: CliWorld, sha: string) => path.join(world.root, "evals", "ledger", `export-${sha}.jsonl`);
    const world = await cliWorld();
    await seedRows(world, versionCampaign([true]));
    const short = await call(ledgerExportCommand, ["--release", CAND_SHA.slice(0, 12)], world);
    assert.equal(short.code, CliExit.Ok, short.text);
    assert.equal(await exists(exportOf(world, CAND_SHA)), true, "the file is named by the full sha");
    assert.equal(await exists(exportOf(world, CAND_SHA.slice(0, 12))), false);

    const twin = `${CAND_SHA.slice(0, 7)}${"e".repeat(33)}`;
    const ambiguous = await cliWorld();
    await seedRows(ambiguous, [
      ...versionCampaign([true]),
      gradedRow({ lane: LANES.b, rep: 1, boots: true, appSha: twin }),
    ]);
    const refused = await call(ledgerExportCommand, ["--release", CAND_SHA.slice(0, 7)], ambiguous);
    assert.equal(refused.code, CliExit.Usage, refused.text);
    assert.match(refused.text, /^refused ambiguous-release /);
    assert.equal(await exists(path.join(ambiguous.root, "evals", "ledger")), false, "nothing is written");
  });

  it("counts a valid ledger and names the first bad line", async () => {
    const world = await cliWorld();
    await seedRows(world, healthyCampaign());
    const valid = await call(validateLedgerCommand, [], world);
    assert.equal(valid.code, CliExit.Ok);
    assert.equal(valid.text, "runs 12 current 12 pairwise 0 human 0");
    await appendFile(world.paths.ledgerFiles.runs, "{not json}\n");
    const invalid = await call(validateLedgerCommand, [], world);
    assert.equal(invalid.code, CliExit.Refused);
    assert.match(invalid.text, /^invalid .*runs\.jsonl:13: not a JSON row$/);
    assert.equal((await call(validateLedgerCommand, ["extra"], world)).code, CliExit.Usage);
  });
});

describe("cases", () => {
  it("lists every case and checks each edit case's start folder", async () => {
    const world = await cliWorld();
    const listed = await call(casesCommand, [], world);
    assert.equal(listed.code, CliExit.Ok);
    assert.match(listed.text, /^C91 grading-case mode=build exposure=none visibility=public deadline=30min items=4/);
    const checked = await call(casesCommand, ["--check"], world);
    assert.match(checked.text, /cases ok: 1 public, 0 holdout$/);
    const broken = await cliWorld({
      cases: () => [{ ...gradingCase, startFrom: "tests/fixtures/evals/projects/nope" }],
    });
    const refused = await call(casesCommand, ["--check"], broken);
    assert.equal(refused.code, CliExit.Refused);
    assert.match(refused.text, /^invalid case file \(grading-case, start-from\)/);
    assert.equal((await call(casesCommand, ["--all"], world)).code, CliExit.Usage);
  });
});

describe("gc", () => {
  const OLD = "20260801T000000";
  const NEW = "20261001T000000";
  const runId = (stamp: string, lane: string) => `${stamp}-${lane}-grading-case-r1`;

  /** Give the read-only clone its write access back, so the temp home can be removed. */
  const writable = (world: CliWorld) =>
    chmod(path.join(world.paths.work, runId(OLD, "raw-claude"), "snapshots", "final"), 0o755);

  /** A home with old, new, baseline-kept, abandoned, calibration, foreign and symlinked folders. */
  async function littered() {
    const world = await cliWorld();
    const outside = path.join(world.userHome, "outside");
    await mkdir(outside, { recursive: true });
    const folders = [
      path.join(world.paths.work, runId(OLD, "raw-claude"), "snapshots", "final"),
      path.join(world.paths.evidence, runId(OLD, "raw-claude"), "grade-2"),
      path.join(world.paths.work, runId(NEW, "raw-claude")),
      path.join(world.paths.work, runId(OLD, "raw-codex")),
      path.join(world.paths.evidence, runId(OLD, "raw-codex")),
      path.join(world.paths.work, `${runId(OLD, "genex-claude")}.abandoned-1759000000000`),
      path.join(world.paths.evidence, `calibration-${OLD}`, "empty-canvas"),
      path.join(world.paths.work, "npm-cache"),
    ];
    for (const folder of folders) await mkdir(folder, { recursive: true });
    await writeFile(path.join(folders[0], "index.html"), "<canvas>");
    await chmod(folders[0], 0o555);
    await symlink(outside, path.join(world.paths.work, runId(OLD, "genex-codex")));
    const baseline = { lanes: [{ laneId: "raw-codex", runIds: [runId(OLD, "raw-codex")] }] };
    await mkdir(path.join(world.root, BASELINES_DIR), { recursive: true });
    await writeFile(
      path.join(world.root, BASELINES_DIR, "grading-case.json"),
      JSON.stringify({
        schema: "genex-evals/baseline/1",
        caseId: "grading-case",
        caseVersion: gradingCase.version,
        exposure: "none",
        campaignId: CAMPAIGN,
        promotedAt: "2026-09-01T00:00:00Z",
        epoch: "0123456789ab",
        endpointsSha: "0123456789ab",
        lanes: baseline.lanes.map((lane) => ({ ...lane, endedHow: ["agent-finished"], pins: {}, metrics: {} })),
      }),
    );
    return { world, outside };
  }

  it("lists what is older than the cutoff and removes nothing without --apply", async () => {
    const { world } = await littered();
    const result = await call(gcCommand, ["--older-than", "30d"], world);
    assert.equal(result.code, CliExit.Ok, result.text);
    assert.deepEqual(result.text.split("\n"), [
      `kept (symlink) work/${runId(OLD, "genex-codex")}`,
      `would remove work/${runId(OLD, "genex-claude")}.abandoned-1759000000000`,
      `would remove work/${runId(OLD, "raw-claude")}`,
      `kept (baseline) work/${runId(OLD, "raw-codex")}`,
      `would remove evidence/${runId(OLD, "raw-claude")}`,
      `kept (baseline) evidence/${runId(OLD, "raw-codex")}`,
      `would remove evidence/calibration-${OLD}`,
      "gc: 4 older than 30d; dry run, --apply removes",
    ]);
    assert.ok(await exists(path.join(world.paths.work, runId(OLD, "raw-claude"), "snapshots", "final", "index.html")));
    await writable(world);
  });

  it("removes old folders with --apply, read-only clones included, and keeps baselines, links and the rest", async () => {
    const { world, outside } = await littered();
    const result = await call(gcCommand, ["--older-than", "30d", "--apply"], world);
    assert.equal(result.code, CliExit.Ok, result.text);
    assert.deepEqual((await readdir(world.paths.work)).sort(), [
      runId(OLD, "genex-codex"),
      runId(OLD, "raw-codex"),
      runId(NEW, "raw-claude"),
      "npm-cache",
    ]);
    assert.deepEqual(await readdir(world.paths.evidence), [runId(OLD, "raw-codex")]);
    assert.ok(await exists(outside), "a symlink's target is never touched");
    assert.ok(await exists(world.paths.home));
  });

  const LONG_AGO = new Date("2026-08-01T00:00:00Z");
  const YESTERDAY = new Date("2026-10-01T00:00:00Z");

  /** Every folder under `dir` (never through a link) dated `at`, files keeping their own dates. */
  async function dateFolders(dir: string, at: Date): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true }))
      if (entry.isDirectory()) await dateFolders(path.join(dir, entry.name), at);
    await utimes(dir, at, at);
  }

  /** Owner access back on every folder under `dir`, so the temp folders can be removed. */
  async function openUp(dir: string): Promise<void> {
    await chmod(dir, 0o700);
    for (const entry of await readdir(dir, { withFileTypes: true }))
      if (entry.isDirectory()) await openUp(path.join(dir, entry.name));
  }

  /**
   * The snapshot server's folders and the lanes folder with old, recently touched, foreign and
   * linked entries: a cache folder is as old as the newest thing inside it.
   */
  async function cached() {
    const world = await cliWorld();
    const { lanes } = world.ctx;
    const outside = path.join(world.userHome, "outside");
    const files: Array<[string, Date]> = [
      [path.join(world.paths.serveCopies, "aaaa", "dist", "index.html"), LONG_AGO],
      [path.join(world.paths.serveCopies, "bbbb", "index.html"), YESTERDAY],
      [path.join(world.paths.npmCache, "_cacache", "index-v5", "entry"), LONG_AGO],
      [path.join(world.paths.npmCache, "_logs", "old.log"), LONG_AGO],
      [path.join(world.paths.npmCache, "_logs", "new.log"), YESTERDAY],
      [path.join(world.paths.sandboxScratch, ".curl-home", "curlrc"), LONG_AGO],
      [path.join(lanes, "run-a1b2c3", "project", "index.html"), LONG_AGO],
      [path.join(lanes, "run-d4e5f6", "project", "index.html"), YESTERDAY],
      [path.join(lanes, "not-a-lane", "notes.txt"), LONG_AGO],
      [path.join(outside, "run-old", "keep.txt"), LONG_AGO],
    ];
    for (const [file, at] of files) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "x");
      await utimes(file, at, at);
    }
    await symlink(path.join(outside, "run-old"), path.join(lanes, "run-linked"));
    for (const root of [world.paths.work, lanes, outside]) await dateFolders(root, LONG_AGO);
    // A finished lane's read-only clone, and the lanes folder its owner cannot list.
    await chmod(path.join(lanes, "run-a1b2c3", "project"), 0o555);
    await chmod(lanes, 0o300);
    closeBeforeCleanup(() => openUp(lanes));
    return { world, lanes, outside };
  }

  it("lists the snapshot server's and the lanes folder's entries untouched for the cutoff, without --apply", async () => {
    const { world, lanes } = await cached();
    const result = await call(gcCommand, ["--older-than", "30d"], world);
    assert.equal(result.code, CliExit.Ok, result.text);
    assert.deepEqual(result.text.split("\n"), [
      "would remove work/grade-copies/aaaa",
      "would remove work/npm-cache/_cacache",
      "would remove work/sandbox-scratch/.curl-home",
      `kept (symlink) ${path.join(lanes, "run-linked")}`,
      `would remove ${path.join(lanes, "run-a1b2c3")}`,
      "gc: 4 older than 30d; dry run, --apply removes",
    ]);
    assert.equal((await stat(lanes)).mode & 0o777, 0o300, "the lanes folder is unlistable again");
    assert.ok(await exists(path.join(world.paths.serveCopies, "aaaa", "dist", "index.html")));
  });

  it("removes them with --apply, read-only lane clones included, and keeps the rest", async () => {
    const { world, lanes, outside } = await cached();
    const result = await call(gcCommand, ["--older-than", "30d", "--apply"], world);
    assert.equal(result.code, CliExit.Ok, result.text);
    assert.deepEqual(await readdir(world.paths.serveCopies), ["bbbb"]);
    assert.deepEqual(await readdir(world.paths.npmCache), ["_logs"]);
    assert.deepEqual(await readdir(world.paths.sandboxScratch), []);
    assert.equal((await stat(lanes)).mode & 0o777, 0o300);
    await chmod(lanes, 0o700);
    assert.deepEqual((await readdir(lanes)).sort(), ["not-a-lane", "run-d4e5f6", "run-linked"]);
    assert.ok(await exists(path.join(outside, "run-old", "keep.txt")), "a link's target is never touched");
  });

  it("never follows a snapshot server folder or a lanes folder that is a link", async () => {
    const world = await cliWorld();
    const outside = path.join(world.userHome, "outside");
    await mkdir(path.join(outside, "run-x1y2z3"), { recursive: true });
    await dateFolders(outside, LONG_AGO);
    await mkdir(world.paths.work, { recursive: true });
    await symlink(outside, world.paths.serveCopies);
    const lanes = path.join(world.userHome, "lanes-link");
    await symlink(outside, lanes);
    const result = await call(gcCommand, ["--older-than", "30d", "--apply"], {
      ...world,
      ctx: { ...world.ctx, lanes },
    });
    assert.equal(result.code, CliExit.Ok, result.text);
    assert.deepEqual(result.text.split("\n"), [
      "kept (symlink) work/grade-copies",
      `kept (symlink) ${lanes}`,
      "gc: 0 older than 30d removed",
    ]);
    assert.deepEqual(await readdir(outside), ["run-x1y2z3"]);
    assert.ok((await lstat(lanes)).isSymbolicLink());
  });

  it("never follows a work or evidence folder that is a link, nor the snapshot server's folders inside it", async () => {
    const world = await cliWorld();
    const outside = path.join(world.userHome, "outside");
    const outsideEvidence = path.join(world.userHome, "outside-evidence");
    await mkdir(path.join(outside, runId(OLD, "raw-claude")), { recursive: true });
    await mkdir(path.join(outside, "grade-copies", "abc"), { recursive: true });
    await mkdir(path.join(outsideEvidence, runId(OLD, "raw-claude")), { recursive: true });
    await dateFolders(outside, LONG_AGO);
    await dateFolders(outsideEvidence, LONG_AGO);
    await mkdir(world.paths.home, { recursive: true });
    await symlink(outside, world.paths.work);
    await symlink(outsideEvidence, world.paths.evidence);
    const result = await call(gcCommand, ["--older-than", "30d", "--apply"], world);
    assert.equal(result.code, CliExit.Ok, result.text);
    assert.deepEqual(result.text.split("\n"), [
      "kept (symlink) work",
      "kept (symlink) evidence",
      "gc: 0 older than 30d removed",
    ]);
    assert.deepEqual((await readdir(outside)).sort(), [runId(OLD, "raw-claude"), "grade-copies"]);
    assert.deepEqual(await readdir(path.join(outside, "grade-copies")), ["abc"]);
    assert.deepEqual(await readdir(outsideEvidence), [runId(OLD, "raw-claude")]);
    assert.ok((await lstat(world.paths.work)).isSymbolicLink());
  });

  it("refuses a malformed baseline and bad usage without removing anything", async () => {
    const { world } = await littered();
    await writeFile(path.join(world.root, BASELINES_DIR, "broken.json"), "{");
    const result = await call(gcCommand, ["--older-than", "30d", "--apply"], world);
    assert.equal(result.code, CliExit.Refused);
    assert.ok(await exists(path.join(world.paths.work, runId(OLD, "raw-claude"))));
    for (const args of [[], ["--older-than", "30"], ["--older-than", "-1d"], ["--apply"]])
      assert.equal((await call(gcCommand, args, world)).code, CliExit.Usage, args.join(" "));
    await writable(world);
  });
});
