/**
 * The eval CLI's registry (scripts/eval.ts) and its shared parts (scripts/evals/cli/): argument
 * parsing, per-command help, the `--live` gate (refused without `--live`, refused in CI, stripped
 * before the handler, a dry-run switch for `campaign run`) and exit codes, then one end-to-end pass
 * through `main` on fakes: `campaign plan` → `campaign run` (dry, then live) → `grade --quick` →
 * `report`, with fake lanes, a fake server, prober and grader model, and the real ledger. No
 * provider, browser or network is touched.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { COMMANDS, findCommand, main } from "../../scripts/eval.ts";
import { campaignPlanCommand, campaignRunCommand } from "../../scripts/evals/campaign/commands.ts";
import { parseCliArgs } from "../../scripts/evals/cli/args.ts";
import type { CliContext } from "../../scripts/evals/cli/context.ts";
import { CliExit, type CliRun } from "../../scripts/evals/cli/exit.ts";
import { MESSAGE } from "../../scripts/evals/cli/help.ts";
import { LIVE_FLAG, LiveNeed, LiveRefusal, liveGate, runsInCi } from "../../scripts/evals/cli/live.ts";
import { reportCommand } from "../../scripts/evals/cli/report.ts";
import type { GraderComplete } from "../../scripts/evals/grade/checklist/complete.ts";
import { gradeCommand } from "../../scripts/evals/grade/commands.ts";
import type { FrameRef, RunQuickProbe, ServeSnapshot } from "../../scripts/evals/grade/types.ts";
import { currentRows, readPairwiseRows, readRunRows } from "../../scripts/evals/ledger/read.ts";
import {
  CheckResult,
  EntranceVia,
  EvalCommand,
  ProbePhase,
  ProbeRow,
  RendererMode,
  RowKind,
  ServedVia,
} from "../../scripts/evals/vocabulary.ts";
import { ZERO_TOKEN_USAGE } from "../../src/shared/eval-lane.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { BASE, CASES, campaignWorld, NOW, REGISTRY } from "../fixtures/evals/campaign/world.ts";
import { harness } from "../fixtures/evals/grading/campaign.ts";

/** A line printer that keeps what it printed. */
function printer() {
  const lines: string[] = [];
  return { lines, out: (line: string) => void lines.push(line), text: () => lines.join("\n") };
}

/** Handlers that record their arguments instead of running anything. */
function recorders() {
  const calls: Array<{ command: EvalCommand; args: readonly string[] }> = [];
  const handlers = Object.fromEntries(
    Object.values(EvalCommand).map((command): [EvalCommand, CliRun] => [
      command,
      async (args) => {
        calls.push({ command, args });
        return 0;
      },
    ]),
  ) as Record<EvalCommand, CliRun>;
  return { calls, handlers };
}

const words = (command: EvalCommand) => command.split(" ");

describe("argument parsing", () => {
  it("splits positionals, switches and values, and refuses anything it does not know", () => {
    const spec = { switches: ["--quick"], values: ["--seed"] };
    assert.deepEqual(parseCliArgs(["c1", "--quick", "--seed", "s"], spec), {
      positional: ["c1"],
      switches: new Set(["--quick"]),
      values: new Map([["--seed", "s"]]),
    });
    const refused: string[][] = [["--nope"], ["--seed"], ["--seed", "--quick"], ["c1", "--quick=1"], ["--live"]];
    for (const args of refused) assert.equal(parseCliArgs(args, spec), null, args.join(" "));
  });

  it("resolves the longest command and leaves the rest of the line", () => {
    assert.equal(findCommand(["baseline", "promote", "--campaign", "x"])?.spec.command, EvalCommand.BaselinePromote);
    assert.deepEqual(findCommand(["ledger", "export", "--release", "abc1234"])?.rest, ["--release", "abc1234"]);
    assert.equal(findCommand(["baseline"]), undefined);
    assert.equal(findCommand(["ledger"]), undefined);
  });
});

describe("help", () => {
  it("prints each command's usage, summary and exit codes without running it", async () => {
    const { calls, handlers } = recorders();
    for (const spec of COMMANDS) {
      const { out, text } = printer();
      assert.equal(await main([...words(spec.command), "--help"], out, { handlers }), 0);
      assert.match(text(), new RegExp(`^Usage: npm run eval -- ${escapeRegExp(MESSAGE[spec.command].usage)}`));
      assert.match(text(), /exit 0/);
    }
    assert.deepEqual(calls, []);
    const overview = printer();
    assert.equal(await main([], overview.out), 0);
    for (const command of Object.values(EvalCommand)) assert.match(overview.text(), new RegExp(`^  ${command} `, "m"));
  });

  it("points no reader at a numbered section of a document the repository does not hold", async () => {
    const pages: string[] = [];
    for (const spec of COMMANDS) {
      const { out, text } = printer();
      await main([...words(spec.command), "--help"], out);
      pages.push(text());
    }
    const overview = printer();
    await main(["--help"], overview.out);
    pages.push(overview.text());
    for (const page of pages) assert.doesNotMatch(page, /§\s*\d/, page.split("\n")[0]);
  });

  it("answers an unknown command with exit 64 and the overview", async () => {
    const { out, text } = printer();
    assert.equal(await main(["explode", "--live"], out), CliExit.Usage);
    assert.match(text(), /^unknown-command: explode --live/);
  });
});

/** Escape a usage line for a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("the --live gate", () => {
  it("knows CI by its variables", () => {
    for (const env of [{ CI: "true" }, { CI: "1" }, { GITHUB_ACTIONS: "true" }, { CI: "TRUE" }])
      assert.equal(runsInCi(env), true, JSON.stringify(env));
    for (const env of [{}, { CI: "" }, { CI: "false" }, { CI: "0" }]) assert.equal(runsInCi(env), false);
  });

  it("gates a line by its need", () => {
    const local = {};
    const ci = { CI: "true" };
    assert.deepEqual(liveGate(LiveNeed.None, ["a", LIVE_FLAG], ci), { refusal: null, args: ["a", LIVE_FLAG] });
    assert.deepEqual(liveGate(LiveNeed.Required, ["a"], local), { refusal: LiveRefusal.Required, args: null });
    assert.deepEqual(liveGate(LiveNeed.Required, ["a", LIVE_FLAG], local), { refusal: null, args: ["a"] });
    assert.deepEqual(liveGate(LiveNeed.Required, ["a", LIVE_FLAG], ci), { refusal: LiveRefusal.InCi, args: null });
    assert.deepEqual(liveGate(LiveNeed.Switch, ["a"], ci), { refusal: null, args: ["a"] });
    assert.deepEqual(liveGate(LiveNeed.Switch, ["a", LIVE_FLAG], local), { refusal: null, args: ["a", LIVE_FLAG] });
    assert.deepEqual(liveGate(LiveNeed.Switch, ["a", LIVE_FLAG], ci), { refusal: LiveRefusal.InCi, args: null });
  });

  const LIVE_COMMANDS = [
    EvalCommand.Grade,
    EvalCommand.Regrade,
    EvalCommand.Calibrate,
    EvalCommand.LedgerPublish,
    EvalCommand.LedgerShare,
    EvalCommand.LedgerUnshare,
  ];

  it("refuses every quota-spending or data-sending command without --live, and in CI, running nothing", async () => {
    for (const command of LIVE_COMMANDS) {
      const { calls, handlers } = recorders();
      const without = printer();
      assert.equal(await main([...words(command), "x"], without.out, { handlers, env: {} }), CliExit.Usage);
      assert.equal(without.text(), `${LiveRefusal.Required}: ${command} needs ${LIVE_FLAG}`);
      const inCi = printer();
      const ci = { CI: "true" };
      assert.equal(await main([...words(command), "x", LIVE_FLAG], inCi.out, { handlers, env: ci }), CliExit.Refused);
      assert.equal(inCi.text(), `${LiveRefusal.InCi}: ${command}`);
      assert.deepEqual(calls, [], command);
      assert.equal(await main([...words(command), LIVE_FLAG, "x"], printer().out, { handlers, env: {} }), 0);
      assert.deepEqual(calls, [{ command, args: ["x"] }], "--live is removed before the handler");
    }
  });

  it("passes campaign run's own --live through, and gates diagnostics only when it re-grades", async () => {
    const { calls, handlers } = recorders();
    const run = words(EvalCommand.CampaignRun);
    await main([...run, "c"], printer().out, { handlers, env: { CI: "true" } });
    await main([...run, "c", LIVE_FLAG], printer().out, { handlers, env: {} });
    assert.equal(await main([...run, "c", LIVE_FLAG], printer().out, { handlers, env: { CI: "1" } }), CliExit.Refused);
    const diagnostics = words(EvalCommand.Diagnostics);
    await main([...diagnostics, "c"], printer().out, { handlers, env: {} });
    assert.equal(
      await main([...diagnostics, "c", "--repeatability"], printer().out, { handlers, env: {} }),
      CliExit.Usage,
    );
    await main([...diagnostics, "c", "--repeatability", LIVE_FLAG], printer().out, { handlers, env: {} });
    assert.deepEqual(calls, [
      { command: EvalCommand.CampaignRun, args: ["c"] },
      { command: EvalCommand.CampaignRun, args: ["c", LIVE_FLAG] },
      { command: EvalCommand.Diagnostics, args: ["c"] },
      { command: EvalCommand.Diagnostics, args: ["c", "--repeatability"] },
    ]);
  });

  it("runs local commands in CI and hands them their whole line", async () => {
    const { calls, handlers } = recorders();
    const local = COMMANDS.filter(
      (spec) => spec.live([]) === LiveNeed.None && spec.command !== EvalCommand.Diagnostics,
    );
    for (const spec of local)
      await main([...words(spec.command), "a"], printer().out, { handlers, env: { CI: "true" } });
    assert.deepEqual(
      calls.map((call) => call.command),
      local.map((spec) => spec.command),
    );
  });
});

// ── end to end on fakes ─────────────────────────────────────────────────────────────────

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "eval-cli-e2e-")));
after(() => {
  unlock(ROOT);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** Give back write access to the read-only stop-time clones, so the folder can be removed. */
function unlock(dir: string): void {
  fs.chmodSync(dir, 0o755);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
    if (entry.isDirectory()) unlock(path.join(dir, entry.name));
}

const PROJECT_ORIGIN = "http://127.0.0.1:43112";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const CONTROL = "sonnet";

/** A server that serves nothing: its url names the snapshot it was asked for. */
const fakeServe: ServeSnapshot = async (options) => ({
  url: `${PROJECT_ORIGIN}/?root=${encodeURIComponent(options.root)}`,
  origin: PROJECT_ORIGIN,
  root: options.root,
  servedVia: ServedVia.AsIs,
  noBuild: null,
  close: async () => {},
});

/** A quick probe that boots whatever snapshot has a canvas and keeps three witnessed frames. */
const fakeQuickProbe: RunQuickProbe = async (url, options) => {
  const root = decodeURIComponent(new URL(url).searchParams.get("root") ?? "");
  const boots = (await readFile(path.join(root, "index.html"), "utf8").catch(() => "")).includes("<canvas");
  const verdict = boots ? CheckResult.Pass : CheckResult.Fail;
  await mkdir(options.evidenceDir, { recursive: true });
  const frames: FrameRef[] = [];
  for (let index = 0; boots && index < 3; index += 1) {
    const file = path.join(options.evidenceDir, `frame-${index}.png`);
    await writeFile(file, PNG);
    frames.push({
      path: file,
      atMs: 2_000 + index,
      phase: ProbePhase.InputBurst,
      origin: PROJECT_ORIGIN,
      width: 8,
      height: 8,
    });
  }
  for (const name of ["console-summary.json", "network-summary.json"])
    await writeFile(path.join(options.evidenceDir, name), "[]");
  return {
    rows: { [ProbeRow.L1BuildsAndBoots]: verdict },
    l1Gate: verdict,
    l2Gate: verdict,
    scored: boots,
    entrance: boots ? EntranceVia.StartControl : EntranceVia.None,
    firstRenderMs: boots ? 500 : null,
    fpsMedian: boots ? 60 : null,
    consoleErrors: 0,
    rendererMode: RendererMode.Gpu,
    servedVia: ServedVia.AsIs,
    evidence: {
      projectOrigin: PROJECT_ORIGIN,
      frames,
      consoleSummaryPath: path.join(options.evidenceDir, "console-summary.json"),
      networkSummaryPath: path.join(options.evidenceDir, "network-summary.json"),
      videoPath: null,
      summaryBytes: 4,
    },
    proberVersion: "genex-prober/6+desktop.1",
    noErrorsMs: options.noErrorsMs,
    quick: true,
  };
};

/** A grader model: yes to every real item, no to the control, the left side in every pairwise facet. */
const fakeComplete: GraderComplete = async (pin, prompt) => {
  const pairwise = prompt.text.includes("LEFT FRAMES ATTACHED");
  const text = pairwise
    ? ["OVERALL: LEFT", "WORKS: LEFT", "VISUALS: LEFT", "FEEL: LEFT", "PLAY: LEFT"].join("\n")
    : `VERDICT: ${prompt.text.includes(CONTROL) ? "NO" : "YES"}\nWHY: seen`;
  return { text, model: pin.model, usage: ZERO_TOKEN_USAGE };
};

describe("end to end on fakes", () => {
  it("plans, dry-runs, runs, grades and reports a campaign through main", async () => {
    const world = campaignWorld(ROOT);
    const grading = await harness({
      paths: world.paths,
      cases: CASES,
      serve: fakeServe,
      quickProbe: fakeQuickProbe,
      complete: fakeComplete,
    });
    const context: CliContext = {
      paths: world.paths,
      root: await tmpDir("eval-cli-e2e-root-"),
      lanes: await tmpDir("eval-cli-e2e-lanes-"),
      cases: () => CASES,
      registry: () => REGISTRY,
      now: () => new Date(NOW),
      formatJson: async () => {},
    };
    const handlers: Partial<Record<EvalCommand, CliRun>> = {
      [EvalCommand.CampaignPlan]: (args, out) =>
        campaignPlanCommand(args, out, {
          paths: world.paths,
          cases: () => CASES,
          registry: () => REGISTRY,
          resolveSha: async () => BASE,
          now: () => NOW,
          randomSeed: () => "s1",
        }),
      [EvalCommand.CampaignRun]: (args, out) => campaignRunCommand(args, out, world.deps),
      [EvalCommand.Grade]: (args, out) => gradeCommand(args, out, { deps: grading.deps, root: context.root }),
      [EvalCommand.Report]: (args, out) => reportCommand(args, out, context),
    };
    const env = {};
    const cli = async (...args: string[]) => {
      const { out, text } = printer();
      const code = await main(args, out, { handlers, env });
      return { code, text: text() };
    };

    const planned = await cli(
      "campaign",
      "plan",
      "--cases",
      "tiny-roll",
      "--lanes",
      "raw-claude,raw-codex",
      "--reps",
      "1",
    );
    assert.equal(planned.code, 0, planned.text);
    const campaignId = /^campaign (\S+) \(seed s1\)$/m.exec(planned.text)?.[1] ?? "";
    assert.match(campaignId, /^\d{8}T\d{6}-campaign$/);

    const dry = await cli("campaign", "run", campaignId);
    assert.equal(dry.code, 0, dry.text);
    assert.deepEqual(await readRunRows(world.paths), [], "a dry run writes nothing");

    const ran = await cli("campaign", "run", campaignId, "--live");
    assert.equal(ran.code, 0, ran.text);
    const collected = currentRows(await readRunRows(world.paths));
    assert.equal(collected.filter((row) => row.kind === RowKind.Build).length, 2);

    assert.equal((await cli("grade", campaignId, "--quick")).code, CliExit.Usage, "grading needs --live");
    const graded = await cli("grade", campaignId, "--quick", "--live");
    assert.equal(graded.code, 0, graded.text);
    assert.match(graded.text, /^graded .*-raw-claude-tiny-roll-r1$/m);
    const builds = currentRows(await readRunRows(world.paths)).filter((row) => row.kind === RowKind.Build);
    assert.ok(builds.every((row) => row.gradeSeq === 2 && row.checklist?.scoreAllRuns === 1 && row.probe?.quick));
    assert.equal((await readPairwiseRows(world.paths)).length > 0, true);

    const report = await cli("report", campaignId);
    assert.equal(report.code, 0, report.text);
    assert.match(report.text, /^Diagnostics$/m);
    assert.match(report.text, new RegExp(`^# Scorecard · ${campaignId}$`, "m"));
    assert.match(report.text, /raw-claude/);
    assert.match(report.text, /raw-codex/);
  });
});
