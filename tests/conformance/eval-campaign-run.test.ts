/**
 * `campaign run` (§4, §8.1, §10.5, §10.6, Rules 20, 21, 24), end to end and hermetic: fake lanes
 * replay the fixture streams (raw) or seed and edit a project with a lane report (Genex), a fake
 * server and boot probe judge the canaries, and every row goes through the real ledger writer and
 * its guard. Covered: phase order, one live run per provider with the two providers side by side
 * (or serial), the canary gate (retry, abort, void), harness-failure replacements, a CLI change,
 * budget and quota stops, resume, the dry run, refusals, `noBuild` from the stop-time snapshot and
 * the Genex template digest, the workspace boundary, and the two command handlers.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { APP_VENDOR_DIR, type CanaryInput } from "../../scripts/evals/campaign/canary.ts";
import {
  CAMPAIGN_EXIT,
  campaignPlanCommand,
  campaignRunCommand,
  EXIT_CAMPAIGN_USAGE,
  type PlanCommandDeps,
} from "../../scripts/evals/campaign/commands.ts";
import { type PlanInput, planCampaign, plannedRuns, writeCampaignPlan } from "../../scripts/evals/campaign/plan.ts";
import {
  AbandonedRunLiveError,
  CampaignOutcome,
  type CampaignRunDeps,
  type CampaignRunOptions,
  CampaignRunRefusal,
  CampaignStop,
  runCampaign,
} from "../../scripts/evals/campaign/run.ts";
import { type CampaignPlan, CanaryBracket } from "../../scripts/evals/campaign/types.ts";
import { parseCases } from "../../scripts/evals/cases.ts";
import { LANE_PID_FILE, lanePidText, WorkspaceRefusedError } from "../../scripts/evals/lanes/common.ts";
import { EvalHomesRefusal, evalsLayout, runWorkRoot } from "../../scripts/evals/lanes/homes.ts";
import { evalsPaths } from "../../scripts/evals/ledger/paths.ts";
import { NOT_APPLICABLE } from "../../scripts/evals/ledger/types.ts";
import { hashDir } from "../../scripts/evals/ledger/hash.ts";
import { PROBER_VERSION } from "../../scripts/evals/prober/types.ts";
import {
  AccountExclusive,
  CampaignVoidReason,
  CaseVisibility,
  CheckResult,
  Concurrency,
  HarnessFailure,
  LaneModeServed,
  LaunchPath,
  NoBuild,
  NoteCode,
  RowKind,
} from "../../scripts/evals/vocabulary.ts";
import {
  BASE,
  CASES,
  CLI_VERSION,
  campaignWorld,
  type LaneScript,
  NOW,
  REGISTRY,
} from "../fixtures/evals/campaign/world.ts";
import { validateProjectDir } from "../../src/substrate/project-validation.ts";
import { EngineId } from "../../src/shared/providers.ts";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/evals");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eval-campaign-run-")));
/** Give back write permission on the read-only final clones, so the temporary folder can be removed. */
function writable(dir: string): void {
  fs.chmodSync(dir, 0o755);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
    if (entry.isDirectory()) writable(path.join(dir, entry.name));
}
after(() => {
  writable(ROOT);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** A campaign world under this file's temporary root. */
const world = (script: LaneScript = {}, probe: (input: CanaryInput) => CheckResult = () => CheckResult.Pass) =>
  campaignWorld(ROOT, script, probe);

function plan(overrides: Partial<PlanInput> = {}): CampaignPlan {
  return planCampaign({
    cases: CASES,
    registry: REGISTRY,
    caseIds: ["tiny-roll"],
    laneSelectors: ["raw-claude", "raw-codex", "genex-claude"],
    reps: 1,
    apps: [BASE],
    deadlineMin: null,
    seed: "s1",
    label: "smoke",
    nowMs: NOW,
    ...overrides,
  });
}

const LIVE: CampaignRunOptions = {
  live: true,
  caps: { hours: 8, maxRuns: null, maxQuotaPercent: 70 },
  accountExclusive: false,
  serial: false,
};

const isOpening = (p: CampaignPlan, runId: string) =>
  plannedRuns(p).some((run) => run.runId === runId && run.bracket !== null && run.bracket !== CanaryBracket.Closing);
const isClosing = (p: CampaignPlan, runId: string) =>
  plannedRuns(p).some((run) => run.runId === runId && run.bracket === CanaryBracket.Closing);

describe("a hermetic campaign", () => {
  it("runs openings, then builds, then closings; one run per provider, the two providers side by side", async () => {
    const w = world();
    const p = plan();
    const report = await runCampaign(p, LIVE, w.deps);
    assert.equal(report.outcome, CampaignOutcome.Completed);
    assert.deepEqual(report.pending, []);
    const kinds = w.calls.map((runId) => {
      if (isOpening(p, runId)) return "open";
      return isClosing(p, runId) ? "close" : "build";
    });
    assert.deepEqual(
      kinds,
      [...kinds].sort((a, b) => ["open", "build", "close"].indexOf(a) - ["open", "build", "close"].indexOf(b)),
    );
    assert.equal(w.stats.maxPerEngine, 1);
    assert.equal(w.stats.maxOverall, 2);
    assert.deepEqual(w.stats.builtApps, [BASE]);
    const rows = await w.rows(p.campaignId);
    assert.equal(rows.length, 9);
    assert.ok(rows.every((row) => row.gradeSeq === 1 && row.checklist === null && row.campaignVoid === null));
    assert.ok(rows.some((row) => row.pins.recorded.coRunLane !== null && row.notes.includes(NoteCode.CoRun)));
    assert.ok(rows.every((row) => row.pins.recorded.concurrency === Concurrency.OnePerProvider));
    assert.ok(rows.every((row) => row.pins.recorded.interleaveSeed === p.seed));
    assert.ok(rows.every((row) => row.pins.recorded.accountExclusive === AccountExclusive.Unattested));
  });

  it("writes build rows ungraded and canary rows with their boot-only verdict", async () => {
    const w = world();
    const p = plan();
    await runCampaign(p, LIVE, w.deps);
    const rows = await w.rows(p.campaignId);
    const canaries = rows.filter((row) => row.kind === RowKind.Canary);
    assert.equal(canaries.length, 6);
    for (const row of canaries) {
      assert.equal(row.probe?.l1Gate, CheckResult.Pass);
      assert.equal(row.probe?.quick, true);
      assert.equal(row.pins.grading.proberVersion, PROBER_VERSION);
    }
    const raw = rows.find((row) => row.kind === RowKind.Build && row.lane.id === "raw-claude");
    assert.ok(raw);
    assert.equal(raw.probe, null);
    assert.deepEqual(raw.pins.run.appSha, NOT_APPLICABLE);
    assert.equal(raw.pins.run.cliVersion, CLI_VERSION[EngineId.ClaudeCode]);
    assert.equal(raw.model.main, "claude-opus-5-5");
    assert.equal(raw.outcome.noBuild, null);
    assert.equal(raw.output.hasEntry, true);
    assert.ok(raw.notes.includes(NoteCode.RawDeliverableText));
    assert.equal(raw.lane.modeServed, LaneModeServed.RawCli);
    assert.match(raw.digests.streamSha256 ?? "", /^[0-9a-f]{64}$/);
    const genex = rows.find((row) => row.kind === RowKind.Build && row.lane.id === "genex-claude");
    assert.ok(genex);
    assert.equal(genex.pins.run.appSha, BASE);
    assert.equal(genex.pins.run.harnessSeedDigest, "c".repeat(64));
    assert.equal(genex.inApp?.launch, LaunchPath.None);
    assert.equal(genex.lane.modeServed, LaneModeServed.AutopilotUntilSatisfied);
    assert.equal(genex.outcome.noBuild, null);
    // A Genex canary is served with its own app build's vendored files; a raw one with the default.
    const appVendor = path.join(w.layout.builds, BASE, APP_VENDOR_DIR);
    assert.equal(w.stats.vendors.filter((dir) => dir === appVendor).length, 2);
    assert.equal(w.stats.vendors.filter((dir) => dir === path.join(w.base, "vendor")).length, 4);
  });

  it("types no-build from the stop-time snapshot: a Genex template left as seeded, a raw folder with no page", async () => {
    const w = world({
      untouched: (request) => request.evalCase.id === "tiny-roll",
      noPage: (request) => request.evalCase.id === "tiny-roll",
    });
    const p = plan();
    await runCampaign(p, LIVE, w.deps);
    const builds = (await w.rows(p.campaignId)).filter((row) => row.kind === RowKind.Build);
    const byLane = new Map(builds.map((row) => [row.lane.id, row.outcome.noBuild]));
    assert.equal(byLane.get("genex-claude"), NoBuild.TemplateUntouched);
    assert.equal(byLane.get("raw-claude"), NoBuild.NoEntry);
    assert.equal(byLane.get("raw-codex"), NoBuild.NoEntry);
  });

  it("runs every stream one after another under --serial, with no co-runs", async () => {
    const w = world();
    const p = plan();
    const report = await runCampaign(p, { ...LIVE, serial: true }, w.deps);
    assert.equal(report.outcome, CampaignOutcome.Completed);
    assert.equal(w.stats.maxOverall, 1);
    const rows = await w.rows(p.campaignId);
    assert.ok(rows.every((row) => row.pins.recorded.concurrency === Concurrency.Serial));
    assert.ok(rows.every((row) => row.pins.recorded.coRunLane === null));
  });
});

describe("the canary gate (Rule 20)", () => {
  it("retries a failed opening canary once and goes on when the retry passes", async () => {
    const p = plan({ laneSelectors: ["raw-claude"], apps: [] });
    const [first] = p.streams[0]?.opening ?? [];
    assert.ok(first);
    const w = world({}, (input) => (input.runId === first.runId ? CheckResult.Fail : CheckResult.Pass));
    const report = await runCampaign(p, LIVE, w.deps);
    assert.equal(report.outcome, CampaignOutcome.Completed);
    const rows = await w.rows(p.campaignId);
    assert.equal(rows.find((row) => row.runId === first.runId)?.probe?.l1Gate, CheckResult.Fail);
    assert.equal(rows.filter((row) => row.kind === RowKind.Build).length, 1);
  });

  it("aborts before any case when an opening canary fails twice, and voids what was written", async () => {
    const w = world({}, () => CheckResult.Fail);
    const p = plan();
    const report = await runCampaign(p, LIVE, w.deps);
    assert.equal(report.outcome, CampaignOutcome.Aborted);
    assert.equal(report.voidReason, CampaignVoidReason.OpeningCanary);
    assert.ok(w.calls.every((runId) => isOpening(p, runId)));
    const rows = await w.rows(p.campaignId);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => row.campaignVoid === CampaignVoidReason.OpeningCanary));
    assert.ok(rows.every((row) => row.notes.includes(NoteCode.CampaignVoid)));
  });

  it("voids the campaign when a closing canary fails", async () => {
    const p = plan({ laneSelectors: ["raw-claude"], apps: [] });
    const closing = p.streams[0]?.closing[0];
    assert.ok(closing);
    const w = world({}, (input) => (input.runId === closing.runId ? CheckResult.Fail : CheckResult.Pass));
    const report = await runCampaign(p, LIVE, w.deps);
    assert.equal(report.outcome, CampaignOutcome.Void);
    assert.equal(report.voidReason, CampaignVoidReason.ClosingCanary);
    const rows = await w.rows(p.campaignId);
    assert.ok(rows.every((row) => row.campaignVoid === CampaignVoidReason.ClosingCanary));
    const resumed = await runCampaign(p, LIVE, w.deps);
    assert.equal(resumed.refusal, CampaignRunRefusal.AlreadyVoid);
  });

  it("fails a canary with a harness failure without probing it", async () => {
    const p = plan({ laneSelectors: ["raw-codex"], apps: [] });
    const w = world({ failure: (request) => (request.evalCase.id === "canary" ? HarnessFailure.EmptyStream : null) });
    const report = await runCampaign(p, LIVE, w.deps);
    assert.equal(report.outcome, CampaignOutcome.Aborted);
    assert.deepEqual(w.stats.served, []);
  });
});

describe("failure accounting (§10.5) and CLI pins (Rule 24)", () => {
  it("replaces a harness-failure build by a new rep, at most twice per cell, each failure naming its replacement", async () => {
    const p = plan({ laneSelectors: ["raw-claude", "raw-codex"], apps: [], reps: 2 });
    const failing = world({
      failure: (request) =>
        request.lane.id === "raw-codex" && request.evalCase.id === "tiny-roll" && request.rep <= 3
          ? HarnessFailure.EmptyStream
          : null,
    });
    const done = await runCampaign(p, LIVE, failing.deps);
    assert.equal(done.outcome, CampaignOutcome.Completed);
    const cell = (await failing.rows(p.campaignId))
      .filter((row) => row.lane.id === "raw-codex" && row.kind === RowKind.Build)
      .sort((a, b) => a.runId.localeCompare(b.runId));
    assert.deepEqual(
      cell.map((row) => [row.runId.slice(-2), row.supersededBy?.slice(-2) ?? null, row.outcome.harnessFailure]),
      [
        ["r1", "r3", HarnessFailure.EmptyStream],
        ["r2", "r4", HarnessFailure.EmptyStream],
        ["r3", null, HarnessFailure.EmptyStream],
        ["r4", null, null],
      ],
    );
    assert.ok(
      cell.filter((row) => Number(row.runId.slice(-1)) > 2).every((row) => row.notes.includes(NoteCode.ReplacementRep)),
    );
  });

  const providerFailures = [
    HarnessFailure.AuthExpired,
    HarnessFailure.QuotaExhausted,
    HarnessFailure.RateLimited,
    HarnessFailure.CliMissing,
  ];
  for (const code of providerFailures) {
    it(`stops cleanly on ${code}, spending no replacement, and finishes the campaign on resume`, async () => {
      const p = plan({ laneSelectors: ["raw-claude"], apps: [], reps: 2 });
      let down = true;
      const w = world({ failure: (_request, index) => (down && index >= 2 ? code : null) });
      const first = await runCampaign(p, LIVE, w.deps);
      assert.equal(first.outcome, CampaignOutcome.Stopped);
      assert.equal(first.stop, CampaignStop.ProviderUnavailable);
      assert.equal(first.voidReason, null);
      assert.equal(w.calls.length, 2, "nothing starts after the provider went down");
      const stopped = w.calls[1] ?? "";
      const written = await w.rows(p.campaignId);
      assert.ok(written.every((row) => row.campaignVoid === null));
      assert.equal(
        written.some((row) => row.runId === stopped),
        false,
        "the failed run writes no row and stays pending",
      );
      assert.ok(first.pending.includes(stopped));
      down = false;
      const second = await runCampaign(p, LIVE, w.deps);
      assert.equal(second.outcome, CampaignOutcome.Completed);
      assert.ok(second.ran.includes(stopped));
      const rows = await w.rows(p.campaignId);
      assert.ok(rows.every((row) => row.campaignVoid === null && row.supersededBy === null));
      assert.ok(rows.every((row) => row.outcome.harnessFailure === null));
      assert.equal(rows.filter((row) => row.kind === RowKind.Build).length, 2, "no replacement rep was queued");
    });
  }

  it("stops instead of voiding when the closing canary is the first run the provider fails", async () => {
    const p = plan({ laneSelectors: ["raw-claude"], apps: [] });
    let down = true;
    const w = world({
      failure: (request) => (down && isClosing(p, request.runId) ? HarnessFailure.AuthExpired : null),
    });
    const first = await runCampaign(p, LIVE, w.deps);
    assert.equal(first.outcome, CampaignOutcome.Stopped);
    assert.equal(first.voidReason, null);
    assert.ok((await w.rows(p.campaignId)).every((row) => row.campaignVoid === null));
    down = false;
    const second = await runCampaign(p, LIVE, w.deps);
    assert.equal(second.outcome, CampaignOutcome.Completed);
    assert.ok((await w.rows(p.campaignId)).every((row) => row.campaignVoid === null));
  });

  it("voids the campaign when a CLI's version changes between runs", async () => {
    const p = plan({ laneSelectors: ["raw-claude"], apps: [], reps: 2 });
    const w = world({ cliVersion: (_request, index) => (index >= 3 ? "2.1.285" : CLI_VERSION[EngineId.ClaudeCode]) });
    const report = await runCampaign(p, LIVE, w.deps);
    assert.equal(report.outcome, CampaignOutcome.Void);
    assert.equal(report.voidReason, CampaignVoidReason.CliChanged);
    assert.equal(w.calls.length, 3);
    const rows = await w.rows(p.campaignId);
    assert.ok(rows.every((row) => row.campaignVoid === CampaignVoidReason.CliChanged));
  });
});

describe("budget, quota and resume", () => {
  it("stops cleanly at the run cap and resumes without rerunning a finished run", async () => {
    const p = plan({ laneSelectors: ["raw-claude"], apps: [], reps: 2 });
    const w = world();
    const first = await runCampaign(p, { ...LIVE, caps: { ...LIVE.caps, maxRuns: 2 } }, w.deps);
    assert.equal(first.outcome, CampaignOutcome.Stopped);
    assert.equal(first.ran.length, 2);
    const second = await runCampaign(p, LIVE, w.deps);
    assert.equal(second.outcome, CampaignOutcome.Completed);
    assert.equal(new Set(w.calls).size, w.calls.length);
    const rows = await w.rows(p.campaignId);
    assert.equal(rows.length, 4);
    assert.ok(
      rows.filter((row) => second.ran.includes(row.runId)).every((row) => row.notes.includes(NoteCode.Resumed)),
    );
  });

  it("sets aside the work folder of a run that never wrote its row, and reruns it", async () => {
    const p = plan({ laneSelectors: ["raw-claude"], apps: [] });
    const w = world();
    const [first] = p.streams[0]?.opening ?? [];
    assert.ok(first);
    const stale = runWorkRoot(w.layout, first.runId);
    await mkdir(path.join(stale, "project"), { recursive: true });
    await writeFile(path.join(stale, "project", "half.js"), "partial");
    const report = await runCampaign(p, LIVE, w.deps);
    assert.equal(report.outcome, CampaignOutcome.Completed);
    const aside = fs.readdirSync(w.layout.work).filter((name) => name.startsWith(`${first.runId}.abandoned-`));
    assert.equal(aside.length, 1);
    assert.equal(fs.readFileSync(path.join(w.layout.work, aside[0] ?? "", "project", "half.js"), "utf8"), "partial");
  });

  it("refuses to rerun a run whose interrupted lane is still running, launching nothing and moving nothing", async () => {
    const p = plan({ laneSelectors: ["raw-claude"], apps: [] });
    const w = world();
    const [first] = p.streams[0]?.opening ?? [];
    assert.ok(first);
    const stale = runWorkRoot(w.layout, first.runId);
    await mkdir(stale, { recursive: true });
    await writeFile(path.join(stale, LANE_PID_FILE), lanePidText(31337, NOW));
    const asked: number[] = [];
    const groupAlive = (pid: number) => {
      asked.push(pid);
      return true;
    };
    await assert.rejects(runCampaign(p, LIVE, { ...w.deps, groupAlive }), AbandonedRunLiveError);
    assert.deepEqual(asked, [31337]);
    assert.deepEqual(w.calls, []);
    assert.ok(fs.existsSync(path.join(stale, LANE_PID_FILE)), "the live run's folder stays where it is");
    const report = await runCampaign(p, LIVE, { ...w.deps, groupAlive: () => false });
    assert.equal(report.outcome, CampaignOutcome.Completed, "a dead group's folder is set aside as before");
  });

  it("stops before any run when a quota window is over the ceiling with no reset inside the budget", async () => {
    const p = plan({ laneSelectors: ["raw-claude"], apps: [] });
    const w = world();
    const deps: CampaignRunDeps = {
      ...w.deps,
      readQuota: async () => ({
        measuredAt: new Date(NOW).toISOString(),
        windows: [{ id: "five_hour", label: "5h", percent: 90 }],
      }),
    };
    const report = await runCampaign(p, LIVE, deps);
    assert.equal(report.outcome, CampaignOutcome.Stopped);
    assert.deepEqual(w.calls, []);
  });

  it("never reads quota before a fixture lane's run, and reads it before a live lane's", async () => {
    const over = { measuredAt: new Date(NOW).toISOString(), windows: [{ id: "five_hour", label: "5h", percent: 90 }] };
    for (const fixture of [true, false]) {
      const lanes = REGISTRY.lanes.map((lane) => (lane.id === "raw-claude" ? { ...lane, fixture } : lane));
      const registry = { ...REGISTRY, lanes };
      const p = plan({ registry, laneSelectors: ["raw-claude"], apps: [] });
      const w = world();
      const asked: string[] = [];
      const readQuota: CampaignRunDeps["readQuota"] = async (engine) => {
        asked.push(engine);
        return over;
      };
      const report = await runCampaign(p, LIVE, { ...w.deps, registry, readQuota });
      if (fixture) {
        assert.deepEqual(asked, [], "a fixture campaign starts no provider CLI");
        assert.equal(report.outcome, CampaignOutcome.Completed);
      } else {
        assert.ok(asked.length > 0);
        assert.equal(report.outcome, CampaignOutcome.Stopped);
      }
    }
  });

  it("lists every run and touches nothing on a dry run", async () => {
    const p = plan();
    const w = world();
    const report = await runCampaign(p, { ...LIVE, live: false }, w.deps);
    assert.equal(report.outcome, CampaignOutcome.DryRun);
    assert.deepEqual(w.calls, []);
    assert.equal(report.pending.length, 3 + 3 + 3);
    assert.equal(fs.existsSync(w.home), false);
  });
});

describe("refusals and boundaries", () => {
  it("refuses a plan whose case or lane moved under it", async () => {
    const p = plan();
    const w = world();
    const moved = CASES.map((c) => (c.id === "tiny-roll" ? { ...c, version: "0".repeat(12) } : c));
    assert.equal((await runCampaign(p, LIVE, { ...w.deps, cases: moved })).refusal, CampaignRunRefusal.CaseMoved);
    const lanes = REGISTRY.lanes.map((lane) =>
      lane.id === "raw-codex" ? { ...lane, flagsDigest: "0".repeat(12) } : lane,
    );
    const registry = { ...REGISTRY, lanes };
    assert.equal((await runCampaign(p, LIVE, { ...w.deps, registry })).refusal, CampaignRunRefusal.LaneMoved);
    assert.deepEqual(w.calls, []);
  });

  it("stops the other provider's stream when one stream's lane runner throws, and rethrows", async () => {
    const p = plan({ laneSelectors: ["raw-claude", "raw-codex"], apps: [], reps: 3 });
    const w = world({ crash: (request) => request.lane.id === "raw-codex" && request.evalCase.id !== "canary" });
    await assert.rejects(runCampaign(p, LIVE, w.deps), /lane runner fault/);
    const started = w.calls.length;
    await delay(50);
    assert.equal(w.calls.length, started);
    assert.ok(w.calls.filter((runId) => runId.includes("-raw-claude-tiny-roll-")).length < 3);
  });

  it("refuses a work folder inside a Git repository before the lane starts, creating nothing", async () => {
    const w = world();
    const repo = path.join(w.base, "repo");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    const inside = evalsLayout(path.join(repo, "evals"));
    const p = plan({ laneSelectors: ["raw-claude"], apps: [] });
    await assert.rejects(runCampaign(p, LIVE, { ...w.deps, layout: inside }), WorkspaceRefusedError);
    assert.deepEqual(w.calls, []);
    assert.equal(fs.existsSync(inside.work), false);
  });

  it("runs each lane's agent outside the evals home, then keeps what it made in the run's work folder", async () => {
    const w = world();
    const p = plan();
    await runCampaign(p, LIVE, w.deps);
    const rows = await w.rows(p.campaignId);
    assert.equal(w.stats.laneRoots.size, rows.length);
    const home = fs.realpathSync(w.home);
    for (const [runId, laneRoot] of w.stats.laneRoots) {
      assert.equal(laneRoot.startsWith(home + path.sep), false, `${runId} ran inside the evals home`);
      assert.equal(fs.existsSync(laneRoot), false, `${runId}'s lane folder is gone once the run ends`);
    }
    const raw = rows.find((row) => row.kind === RowKind.Build && row.lane.id === "raw-claude");
    const genex = rows.find((row) => row.kind === RowKind.Build && row.lane.id === "genex-claude");
    assert.ok(raw && genex);
    assert.ok(fs.existsSync(path.join(runWorkRoot(w.layout, raw.runId), "project", "index.html")));
    assert.ok(fs.existsSync(path.join(runWorkRoot(w.layout, genex.runId), "projects", "project-1", "index.html")));
    assert.ok(fs.existsSync(path.join(runWorkRoot(w.layout, genex.runId), "lane-report.json")));
  });

  it("refuses a holdout campaign whose ledger sits inside a Git repository before anything runs", async () => {
    const w = world();
    const repo = path.join(w.base, "repo");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    const holdouts = parseCases(
      fs.readFileSync(path.join(FIXTURES, "campaign/cases.md"), "utf8"),
      CaseVisibility.Holdout,
    );
    const p = plan({ cases: holdouts, laneSelectors: ["raw-claude"], apps: [] });
    const paths = evalsPaths(path.join(repo, "evals"));
    const report = await runCampaign(p, LIVE, { ...w.deps, cases: holdouts, paths });
    assert.equal(report.refusal, CampaignRunRefusal.HoldoutInWorktree);
    assert.deepEqual(w.calls, []);
    assert.equal(fs.existsSync(paths.ledger), false);
  });
});

/** What `validateProjectDir` says of a stop-time snapshot, as the row records it; unknown without one. */
async function validateOf(dir: string): Promise<CheckResult> {
  if (!fs.existsSync(dir)) return CheckResult.Unknown;
  return (await validateProjectDir(dir)).ok ? CheckResult.Pass : CheckResult.Fail;
}

describe("the collected row's output and digests", () => {
  it("validates the stop-time snapshot and hashes the evidence a canary kept; a build has none yet", async () => {
    const w = world();
    const p = plan();
    await runCampaign(p, LIVE, w.deps);
    const rows = await w.rows(p.campaignId);
    assert.ok(rows.some((row) => row.kind === RowKind.Canary));
    for (const row of rows) {
      const final = path.join(w.base, "evals", "work", row.runId, "snapshots", "final");
      assert.equal(row.output.validate, await validateOf(final), row.runId);
      const evidence = path.join(w.paths.evidence, row.runId);
      const kept = fs.existsSync(evidence) ? await hashDir(evidence) : null;
      assert.equal(row.digests.evidenceSha256, kept, row.runId);
      assert.equal(kept !== null, row.kind === RowKind.Canary, row.runId);
    }
  });
});

describe("the seeded template's digest", () => {
  it("judges template-untouched against the digest the app took at seeding, not a later poll", async () => {
    const w = world({ editsAtOnce: (request) => request.evalCase.id === "tiny-roll" });
    const p = plan();
    await runCampaign(p, LIVE, w.deps);
    const genex = (await w.rows(p.campaignId)).filter(
      (row) => row.kind === RowKind.Build && row.lane.id === "genex-claude",
    );
    assert.ok(genex.length > 0);
    assert.ok(
      genex.every((row) => row.outcome.noBuild === null),
      "an edited project is never template-untouched",
    );
  });
});

describe("the command handlers", () => {
  function planDeps(home: string): PlanCommandDeps {
    return {
      paths: evalsPaths(home),
      cases: () => CASES,
      registry: () => REGISTRY,
      resolveSha: async (ref) => (ref === "HEAD" ? BASE : "b".repeat(40)),
      now: () => NOW,
      randomSeed: () => "r4nd0m",
    };
  }

  it("refuses a live run with a usage line, not a stack trace, when a CLI home variable names another home", async () => {
    const home = fs.mkdtempSync(path.join(ROOT, "other-home-"));
    const env = { GENEX_EVALS_HOME: home, CLAUDE_CONFIG_DIR: path.join(home, "elsewhere") };
    const lines: string[] = [];
    const code = await campaignRunCommand(
      ["20261001T120000-cli", "--live"],
      (line) => lines.push(line),
      undefined,
      env,
    );
    assert.equal(code, EXIT_CAMPAIGN_USAGE);
    assert.deepEqual(lines[0], `refused ${EvalHomesRefusal.OtherHome} CLAUDE_CONFIG_DIR`);
    assert.match(lines[1] ?? "", /^usage: unset CLAUDE_CONFIG_DIR/);
    assert.equal(env.CLAUDE_CONFIG_DIR, path.join(home, "elsewhere"));
  });

  it("plans from the command line, defaulting the app to HEAD for Genex lanes, and writes campaign.json", async () => {
    const home = path.join(ROOT, "cmd-plan");
    const lines: string[] = [];
    const code = await campaignPlanCommand(
      ["--cases", "tiny-roll,tiny-jump", "--lanes", "primary", "--reps", "2", "--label", "cli"],
      (line) => lines.push(line),
      planDeps(home),
    );
    assert.equal(code, 0);
    const file = path.join(home, "campaigns", "20261001T120000-cli", "campaign.json");
    const written = JSON.parse(await readFile(file, "utf8")) as CampaignPlan;
    assert.deepEqual(written.apps, [{ role: "base", sha: BASE }]);
    assert.equal(written.seed, "r4nd0m");
    assert.ok(lines.some((line) => line.startsWith("estimates:")));
  });

  const bad: Array<[string, string[]]> = [
    ["an unknown flag", ["--cases", "tiny-roll", "--nope"]],
    ["a flag without its value", ["--cases"]],
    ["reps that are not a number", ["--cases", "tiny-roll", "--reps", "many"]],
    ["an unknown case", ["--cases", "nope"]],
  ];
  for (const [name, args] of bad) {
    it(`refuses ${name} with the usage code and writes nothing`, async () => {
      const home = path.join(ROOT, `cmd-bad-${bad.findIndex(([n]) => n === name)}`);
      const code = await campaignPlanCommand(args, () => {}, planDeps(home));
      assert.equal(code, EXIT_CAMPAIGN_USAGE);
      assert.equal(fs.existsSync(home), false);
    });
  }

  it("runs a planned campaign dry by default and live with --live, exiting by outcome", async () => {
    const w = world();
    const p = plan({ laneSelectors: ["raw-claude"], apps: [] });
    await writeCampaignPlan(w.paths, p);
    const lines: string[] = [];
    assert.equal(await campaignRunCommand([p.campaignId], (line) => lines.push(line), w.deps), 0);
    assert.ok(lines.some((line) => line.startsWith("would run")));
    assert.deepEqual(w.calls, []);
    const live = await campaignRunCommand([p.campaignId, "--live", "--max-runs", "1"], () => {}, w.deps);
    assert.equal(live, CAMPAIGN_EXIT[CampaignOutcome.Stopped]);
    assert.equal(await campaignRunCommand([p.campaignId, "--live"], () => {}, w.deps), 0);
    assert.equal(await campaignRunCommand([], () => {}, w.deps), EXIT_CAMPAIGN_USAGE);
    assert.equal(await campaignRunCommand(["../x"], () => {}, w.deps), EXIT_CAMPAIGN_USAGE);
    assert.equal(await campaignRunCommand([p.campaignId, "--max-quota", "500"], () => {}, w.deps), EXIT_CAMPAIGN_USAGE);
  });
});
