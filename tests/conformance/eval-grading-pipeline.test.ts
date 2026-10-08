/**
 * The grading pipeline end to end over a fake four-lane campaign (§8): collected rows in a temp
 * ledger, snapshot folders with their index, a fake server, a fake quick probe and a fake grader
 * model. Each graded run gets a new `gradeSeq` row (first boot and first playable from the scan,
 * the final probe, both families' checklist, the grading pins); the campaign's four pairs are judged
 * in both orders by both families. Grading refuses without a covering calibration and stops at the
 * quota guard, writing nothing it should not. A regrade is a new grade of the same observation.
 */
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { BudgetStop } from "../../scripts/evals/budget.ts";
import { CHECKLIST_PROMPT_SHA } from "../../scripts/evals/grade/checklist/prompt.ts";
import {
  calibrationRefusal,
  createCalibrationProber,
  GradeRefusal,
  GradeSkip,
  gradeCampaign,
  gradeDirOf,
  planPairs,
  readGradeRecord,
  readLatestCalibration,
  recordCalibration,
} from "../../scripts/evals/grade/pipeline.ts";
import { baselineRunIds, RegradeRefusal, regradeBaseline, regradeRun } from "../../scripts/evals/grade/regrade.ts";
import type { CalibrationResult } from "../../scripts/evals/grade/types.ts";
import { currentRows, readPairwiseRows, readRunRows } from "../../scripts/evals/ledger/read.ts";
import { unavailable } from "../../scripts/evals/ledger/types.ts";
import { withGradeId } from "../../scripts/evals/ledger/write.ts";
import { promotable } from "../../scripts/evals/prober/full-probe.ts";
import { PROBER_VERSION } from "../../scripts/evals/prober/types.ts";
import { ENDPOINTS_SHA } from "../../scripts/evals/report/endpoints.ts";
import {
  Axis,
  CalibrationFixture,
  CheckResult,
  HarnessFailure,
  ItemVerdict,
  LaneMode,
  NoBuild,
  NoteCode,
  PairOrder,
  PairPick,
  RendererMode,
  ServedVia,
  UnavailableReason,
} from "../../scripts/evals/vocabulary.ts";
import { GENEX_PLUGIN_ID } from "../../src/shared/genex.ts";
import { tmpDir } from "../helpers/tmp.ts";
import {
  CAMPAIGN,
  collectedRow,
  defaultRows,
  FAKE_SOAK_MS,
  GRADERS,
  GREEN,
  gradingCase,
  harness,
  LANES,
  ledgerSize,
  PLAYABLE_AT_ONCE,
  runIdOf,
  type SnapshotSpec,
  seedCampaign,
  writeAppBuild,
  writeSnapshots,
} from "../fixtures/evals/grading/campaign.ts";

describe("grading a campaign end to end", () => {
  it("writes a new gradeSeq row per run with scan timing, the final probe, both families and the grading pins", async () => {
    const h = await harness();
    await seedCampaign(h);
    const report = await gradeCampaign(CAMPAIGN, h.deps);

    assert.equal(report.refused, null);
    assert.equal(report.stop, null);
    assert.equal(report.graded.length, 4);
    assert.equal(h.counts.locks, 1, "the whole campaign is graded under one probe lock");
    const all = await readRunRows(h.deps.paths);
    assert.equal(all.length, 8, "collected rows stay; each run gains one grade");
    const current = currentRows(all);
    for (const row of current) {
      assert.equal(row.gradeSeq, 2);
      assert.equal(row.gradeId, withGradeId(row).gradeId);
      assert.equal(row.pins.grading.endpointsSha, ENDPOINTS_SHA);
      assert.equal(row.pins.grading.proberVersion, PROBER_VERSION);
      assert.equal(row.pins.grading.graderPromptSha, CHECKLIST_PROMPT_SHA);
      assert.deepEqual(
        row.pins.grading.graderModels,
        GRADERS.map((pin) => pin.model),
      );
      assert.equal(row.pins.grading.pairwiseRubricSha, h.deps.rubric.sha);
      assert.equal(row.probe?.quick, true);
      assert.equal(row.checklist?.scoreAllRuns, 1, "three real items pass; the control never counts");
      assert.equal(row.checklist?.graderVoid, null);
      assert.deepEqual(Object.keys(row.checklist?.byFamily ?? {}).sort(), ["claude", "gpt"]);
      assert.ok(row.notes.includes(NoteCode.QuickGrade));
      assert.match(row.digests.evidenceSha256 ?? "", /^[0-9a-f]{64}$/);
      assert.equal(row.time.wallMs, 600_000, "the observation is copied, never re-measured");
    }
    const a = current.find((row) => row.lane.id === LANES.a.id);
    assert.equal(a?.time.firstBootMs, 60_000);
    assert.equal(a?.time.firstPlayableMs, 90_000);
    assert.equal(a?.time.firstPlayableResolutionMs, 30_000);

    const record = await readGradeRecord(h.deps.paths, runIdOf(LANES.a), 2);
    assert.equal(record?.checklist.items.length, gradingCase.acceptance.length);
    const control = record?.checklist.items.find((entry) => entry.item.control);
    assert.equal(control?.combined, ItemVerdict.Fail);
    const finalProbes = h.log.probed.filter(({ options }) => options.evidenceDir.endsWith(`${path.sep}final`));
    assert.equal(finalProbes.length, 4, "each run's stop-time snapshot gets one final probe");
    assert.ok(finalProbes.every(({ url }) => url.includes(encodeURIComponent(`${path.sep}final`))));
  });

  it("judges each case × rep's four pairs in both orders by both families, into the local ledger", async () => {
    const h = await harness();
    await seedCampaign(h);
    const report = await gradeCampaign(CAMPAIGN, h.deps);
    const pairwise = await readPairwiseRows(h.deps.paths);

    assert.equal(report.pairwiseRows, 16);
    assert.equal(pairwise.length, 16);
    const pairs = new Set(pairwise.map((row) => `${row.axis}:${row.lanes.first}>${row.lanes.second}`));
    assert.deepEqual(
      [...pairs].sort(),
      [
        `${Axis.ModelStack}:${LANES.a.id}>${LANES.d.id}`,
        `${Axis.ModelStack}:${LANES.b.id}>${LANES.c.id}`,
        `${Axis.ProductDefault}:${LANES.a.id}>${LANES.b.id}`,
        `${Axis.ProductDefault}:${LANES.d.id}>${LANES.c.id}`,
      ].sort(),
    );
    for (const row of pairwise) {
      assert.equal(row.pairwiseRubricSha, h.deps.rubric.sha);
      assert.equal(row.judgeSkipped, false);
      assert.match(row.blindSeed, /^[0-9a-z]{1,32}$/);
    }
    assert.equal(h.log.pairwiseCalls, 16);
  });

  it("grading again adds nothing: graded runs and judged pairs are skipped", async () => {
    const h = await harness();
    await seedCampaign(h);
    await gradeCampaign(CAMPAIGN, h.deps);
    const before = await ledgerSize(h);
    const probes = h.log.probed.length;
    const again = await gradeCampaign(CAMPAIGN, h.deps);

    assert.equal(again.graded.length, 0);
    assert.deepEqual(
      again.skipped.map((entry) => entry.reason),
      [GradeSkip.AlreadyGraded, GradeSkip.AlreadyGraded, GradeSkip.AlreadyGraded, GradeSkip.AlreadyGraded],
    );
    assert.equal(again.pairwiseRows, 0);
    assert.equal(await ledgerSize(h), before);
    assert.equal(h.log.probed.length, probes);
  });
});

describe("full grades (M3)", () => {
  it("probes each stop-time snapshot with the full prober: the soak is pinned and the grade is promotable", async () => {
    const h = await harness({ quick: false });
    await seedCampaign(h);
    const report = await gradeCampaign(CAMPAIGN, h.deps);

    assert.equal(report.graded.length, 4);
    assert.equal(h.log.fullProbed.length, 4, "one full probe per run's final snapshot");
    assert.ok(h.log.fullProbed.every(({ options }) => options.evidenceDir.endsWith(`${path.sep}final`)));
    assert.ok(
      h.log.probed.every(({ options }) => !options.evidenceDir.endsWith(`${path.sep}final`)),
      "scans stay quick",
    );
    for (const row of currentRows(await readRunRows(h.deps.paths))) {
      assert.equal(row.probe?.quick, false);
      assert.equal(row.probe?.soakMs, FAKE_SOAK_MS);
      assert.equal(row.pins.grading.soakMs, FAKE_SOAK_MS);
      assert.ok(!row.notes.includes(NoteCode.QuickGrade));
      assert.equal(row.checklist?.scoreAllRuns, 1);
    }
    const record = await readGradeRecord(h.deps.paths, runIdOf(LANES.a), 2);
    assert.ok(record?.probe);
    assert.equal(promotable(record.probe), true);
  });

  it("a quick grade pins no soak and says so; it is never promotable", async () => {
    const h = await harness();
    await seedCampaign(h);
    await gradeCampaign(CAMPAIGN, h.deps);
    for (const row of currentRows(await readRunRows(h.deps.paths))) {
      assert.equal(row.probe?.quick, true);
      assert.deepEqual(row.probe?.soakMs, unavailable(UnavailableReason.ProbeSkipped));
      assert.deepEqual(row.pins.grading.soakMs, unavailable(UnavailableReason.ProbeSkipped));
      assert.ok(row.notes.includes(NoteCode.QuickGrade));
    }
    const record = await readGradeRecord(h.deps.paths, runIdOf(LANES.a), 2);
    assert.ok(record?.probe);
    assert.equal(promotable(record.probe), false);
  });

  it("a full grade replaces a quick one (dropping its note); a quick request leaves a full grade alone", async () => {
    const h = await harness();
    await seedCampaign(h);
    await gradeCampaign(CAMPAIGN, h.deps);
    const full = await gradeCampaign(CAMPAIGN, { ...h.deps, quick: false });
    assert.equal(full.graded.length, 4);
    for (const row of currentRows(await readRunRows(h.deps.paths))) {
      assert.equal(row.gradeSeq, 3);
      assert.equal(row.probe?.quick, false);
      assert.ok(!row.notes.includes(NoteCode.QuickGrade));
    }
    const quickAgain = await gradeCampaign(CAMPAIGN, h.deps);
    assert.equal(quickAgain.graded.length, 0);
    assert.deepEqual(new Set(quickAgain.skipped.map((entry) => entry.reason)), new Set([GradeSkip.AlreadyGraded]));
  });

  it("a full regrade of a quick grade probes again instead of reusing the quick probe", async () => {
    const h = await harness();
    await seedCampaign(h);
    await gradeCampaign(CAMPAIGN, h.deps);
    const outcome = await regradeRun(runIdOf(LANES.a), { ...h.deps, quick: false });
    assert.equal(outcome.reprobed, true);
    assert.equal(h.log.fullProbed.length, 1);
    const [row] = currentRows(await readRunRows(h.deps.paths)).filter((r) => r.runId === runIdOf(LANES.a));
    assert.equal(row?.probe?.quick, false);
  });
});

describe("grading a campaign: what is left alone", () => {
  it("never serves or probes a typed no-build; its checklist is judge-skipped and it forfeits its pairs", async () => {
    const h = await harness();
    const rows = defaultRows();
    rows[3] = collectedRow({ lane: LANES.d, noBuild: NoBuild.TemplateUntouched });
    await seedCampaign(h, rows);
    await gradeCampaign(CAMPAIGN, h.deps);

    assert.ok(h.log.served.every((root) => !root.includes(runIdOf(LANES.d))));
    const d = currentRows(await readRunRows(h.deps.paths)).find((row) => row.lane.id === LANES.d.id);
    assert.equal(d?.gradeSeq, 2);
    assert.equal(d?.probe, null);
    assert.equal(d?.checklist?.judgeSkipped, true);
    assert.equal(d?.checklist?.scoreAllRuns, 0);
    assert.equal(d?.time.firstBootMs, null);
    const withD = (await readPairwiseRows(h.deps.paths)).filter(
      (row) => row.lanes.first === LANES.d.id || row.lanes.second === LANES.d.id,
    );
    assert.equal(withD.length, 8);
    // Flipped (grade-probe-review-5): a pair with one typed no-build is a forfeit the no-build loses,
    // decided with no call, instead of a skip that counted as invalid for both lanes.
    assert.ok(withD.every((row) => row.forfeit === true && !row.judgeSkipped));
    for (const row of withD) {
      const dOnLeft = (row.lanes.first === LANES.d.id) === (row.order === PairOrder.FirstLeft);
      assert.equal(row.picks.overall, dOnLeft ? PairPick.Right : PairPick.Left);
    }
    assert.equal(h.log.pairwiseCalls, 8, "only the two pairs without the no-build were judged");
  });

  it("rebuilds a no-dist stop-time snapshot: a page means a real grade, a failed rebuild types itself exactly", async () => {
    const table: Array<[string, Partial<SnapshotSpec>, NoBuild | null]> = [
      ["the rebuild made a page", { rebuilt: true }, null],
      ["the build failed", { rebuildFailed: true, rebuildNoBuild: NoBuild.BuildFailed }, NoBuild.BuildFailed],
      ["the build wrote no page", { rebuildFailed: true, rebuildNoBuild: NoBuild.NoDist }, NoBuild.NoDist],
    ];
    for (const [name, rebuild, expected] of table) {
      const h = await harness();
      const rows = defaultRows();
      rows[3] = collectedRow({ lane: LANES.d, noBuild: NoBuild.NoDist });
      await seedCampaign(h, rows);
      await writeSnapshots(
        h.deps.paths,
        runIdOf(LANES.d),
        PLAYABLE_AT_ONCE.map((snap) => ({ ...snap, ...rebuild })),
      );
      await gradeCampaign(CAMPAIGN, h.deps);
      const d = currentRows(await readRunRows(h.deps.paths)).find((row) => row.lane.id === LANES.d.id);
      assert.equal(d?.gradeSeq, 2, name);
      assert.equal(d?.outcome.noBuild, expected, name);
      assert.equal(d?.probe === null, expected !== null, name);
      assert.equal(d?.checklist?.judgeSkipped, expected !== null, name);
    }
  });

  it("leaves harness failures, superseded reps and other campaigns' runs alone", async () => {
    const h = await harness();
    const failed = collectedRow({
      lane: LANES.b,
      rep: 2,
      patch: {
        outcome: { ...collectedRow({ lane: LANES.b }).outcome, harnessFailure: HarnessFailure.EmptyStream },
        supersededBy: runIdOf(LANES.b, 3),
      },
    });
    const elsewhere = collectedRow({ lane: LANES.c, rep: 5, patch: { campaignId: "20261001T120000-other" } });
    await seedCampaign(h, [...defaultRows(), failed, elsewhere]);
    const report = await gradeCampaign(CAMPAIGN, h.deps);

    assert.deepEqual(report.skipped, [{ runId: failed.runId, reason: GradeSkip.HarnessFailure }]);
    const current = currentRows(await readRunRows(h.deps.paths));
    assert.equal(current.find((row) => row.runId === failed.runId)?.gradeSeq, 1);
    assert.equal(current.find((row) => row.runId === elsewhere.runId)?.gradeSeq, 1);
  });

  it("stops cleanly at the quota guard before the next batch", async () => {
    let calls = 0;
    const h = await harness({
      quotaGate: async () => {
        calls += 1;
        return calls >= 2 ? BudgetStop.Quota : null;
      },
    });
    await seedCampaign(h);
    const report = await gradeCampaign(CAMPAIGN, h.deps);

    assert.equal(report.stop, BudgetStop.Quota);
    assert.equal(report.graded.length, 1);
    assert.equal(report.pairwiseRows, 0);
    assert.equal((await readPairwiseRows(h.deps.paths)).length, 0);
  });
});

describe("the vendor folder a project is served with", () => {
  const BASE_SHA = "b".repeat(40);
  const CAND_SHA = "c".repeat(40);

  /** Record every serve's root and vendor folder on top of the harness's fake server. */
  function recordVendors(h: Awaited<ReturnType<typeof harness>>): Array<[string, string]> {
    const seen: Array<[string, string]> = [];
    const inner = h.deps.serve;
    h.deps.serve = async (options) => {
      seen.push([options.root, options.vendorDir]);
      return inner(options);
    };
    return seen;
  }

  it("serves a Genex run's /vendor from its own app build, and a raw run's from the default", async () => {
    const h = await harness();
    const rows = defaultRows();
    rows[0].pins.run.appSha = BASE_SHA;
    rows[3].pins.run.appSha = CAND_SHA;
    const base = await writeAppBuild(h, BASE_SHA);
    const cand = await writeAppBuild(h, CAND_SHA);
    await seedCampaign(h, rows);
    const seen = recordVendors(h);
    const report = await gradeCampaign(CAMPAIGN, h.deps);
    assert.equal(report.graded.length, 4);
    const want: Record<string, string> = {
      [runIdOf(LANES.a)]: base,
      [runIdOf(LANES.b)]: h.deps.vendorDir,
      [runIdOf(LANES.c)]: h.deps.vendorDir,
      [runIdOf(LANES.d)]: cand,
    };
    for (const [runId, vendor] of Object.entries(want)) {
      const served = seen.filter(([root]) => root.includes(runId));
      assert.ok(served.length > 1, `${runId} was scanned and probed`);
      assert.ok(
        served.every(([, dir]) => dir === vendor),
        `${runId} served with ${vendor}`,
      );
    }
  });

  it("skips a Genex run whose app build is missing instead of serving it the checkout's vendor", async () => {
    const h = await harness();
    const rows = defaultRows();
    rows[0].pins.run.appSha = BASE_SHA;
    await seedCampaign(h, rows);
    const seen = recordVendors(h);
    const report = await gradeCampaign(CAMPAIGN, h.deps);
    assert.deepEqual(report.skipped, [{ runId: runIdOf(LANES.a), reason: GradeSkip.AppBuildMissing }]);
    assert.ok(seen.every(([root]) => !root.includes(runIdOf(LANES.a))));
  });

  it("refuses to grade when the default vendor folder has no three.js, before any lock or serve", async () => {
    const h = await harness({ vendorDir: path.join(await tmpDir("eval-grading-no-vendor-"), "vendor") });
    await seedCampaign(h);
    const before = await ledgerSize(h);
    const report = await gradeCampaign(CAMPAIGN, h.deps);
    assert.equal(report.refused, GradeRefusal.VendorMissing);
    assert.equal(h.counts.locks, 0);
    assert.deepEqual(h.log.served, []);
    assert.equal(await ledgerSize(h), before);
    const regrade = await regradeRun(runIdOf(LANES.b), h.deps);
    assert.equal(regrade.refused, GradeRefusal.VendorMissing);
  });
});

describe("the calibration gate", () => {
  const cases: Array<[string, CalibrationResult | null, GradeRefusal]> = [
    ["no calibration at all", null, GradeRefusal.CalibrationMissing],
    ["a red calibration", { ...GREEN, ok: false }, GradeRefusal.CalibrationNotCovering],
    ["another prober version", { ...GREEN, proberVersion: "genex-prober/5" }, GradeRefusal.CalibrationNotCovering],
    ["other grader models", { ...GREEN, graderModels: ["claude-sonnet-5-5"] }, GradeRefusal.CalibrationNotCovering],
    ["another prompt template", { ...GREEN, graderPromptSha: "f".repeat(64) }, GradeRefusal.CalibrationNotCovering],
  ];
  for (const [name, calibration, refusal] of cases) {
    it(`refuses to grade with ${name}, before any lock, serve, probe or write`, async () => {
      const h = await harness({ latestCalibration: async () => calibration });
      await seedCampaign(h);
      const before = await ledgerSize(h);
      const report = await gradeCampaign(CAMPAIGN, h.deps);

      assert.equal(report.refused, refusal);
      assert.equal(report.graded.length, 0);
      assert.equal(h.counts.locks, 0);
      assert.deepEqual(h.log.served, []);
      assert.equal(h.log.graderCalls, 0);
      assert.equal(await ledgerSize(h), before);
    });
  }

  it("refuses a full grade on a calibration that only ran the quick probe", async () => {
    const h = await harness({ quick: false, latestCalibration: async () => ({ ...GREEN, quick: true }) });
    await seedCampaign(h);
    const report = await gradeCampaign(CAMPAIGN, h.deps);
    assert.equal(report.refused, GradeRefusal.CalibrationNotCovering);
    assert.deepEqual(h.log.served, []);
  });

  describe("the newest record under the same pins whose probe kind covers the grade decides", () => {
    const FULL = { ...GREEN, quick: false };
    const QUICK = { ...GREEN, quick: true };
    const OTHER_PROBER = { ...GREEN, proberVersion: "genex-prober/5" };
    /** Recorded lines in order, then the refusal a full grade and a quick grade get. */
    const rows: Array<[string, CalibrationResult[], GradeRefusal | null, GradeRefusal | null]> = [
      ["a green quick run after a green full one", [FULL, QUICK], null, null],
      [
        "a red quick run after a green full one",
        [FULL, { ...QUICK, ok: false }],
        null,
        GradeRefusal.CalibrationNotCovering,
      ],
      [
        "a red full run after a green full one",
        [FULL, { ...FULL, ok: false }],
        GradeRefusal.CalibrationNotCovering,
        GradeRefusal.CalibrationNotCovering,
      ],
      ["only a quick run on record", [QUICK], GradeRefusal.CalibrationNotCovering, null],
      ["a newer red run under other pins", [FULL, { ...OTHER_PROBER, ok: false }], null, null],
    ];
    for (const [name, lines, full, quick] of rows) {
      it(`${name}: full ${full ?? "grades"}, quick ${quick ?? "grades"}`, async () => {
        const h = await harness({
          latestCalibration: async (versions) => readLatestCalibration(h.deps.paths, versions),
        });
        for (const [n, line] of lines.entries())
          await recordCalibration(h.deps.paths, { ...line, recordedAt: `2026-10-01T12:0${n}:00.000Z` });
        assert.equal(await calibrationRefusal({ ...h.deps, quick: false }), full);
        assert.equal(await calibrationRefusal({ ...h.deps, quick: true }), quick);
      });
    }

    it("grades a full campaign on a green full calibration a later quick one followed", async () => {
      const h = await harness({
        quick: false,
        latestCalibration: async (versions) => readLatestCalibration(h.deps.paths, versions),
      });
      await recordCalibration(h.deps.paths, FULL);
      await recordCalibration(h.deps.paths, { ...QUICK, recordedAt: "2026-10-01T13:00:00.000Z" });
      await seedCampaign(h);
      assert.equal((await gradeCampaign(CAMPAIGN, h.deps)).refused, null);
    });
  });

  it("reads a calibration recorded before it named its probe kind as a quick one", async () => {
    const h = await harness();
    const { quick: _quick, ...legacy } = GREEN;
    await recordCalibration(h.deps.paths, legacy as CalibrationResult);
    assert.equal((await readLatestCalibration(h.deps.paths))?.quick, true);
  });

  it("refuses a regrade the same way", async () => {
    const h = await harness({ latestCalibration: async () => null });
    await seedCampaign(h);
    const outcome = await regradeRun(runIdOf(LANES.a), h.deps);
    assert.equal(outcome.refused, GradeRefusal.CalibrationMissing);
    assert.equal(outcome.gradeSeq, null);
  });
});

describe("the calibration prober", () => {
  it("types a copy whose rebuild failed by what the rebuild said: build-failed or no-dist", async () => {
    for (const noBuild of [NoBuild.BuildFailed, NoBuild.NoDist]) {
      const dir = await tmpDir("eval-grading-calibration-fixture-");
      await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }));
      const prober = createCalibrationProber({
        serve: async (options) => ({
          url: "http://127.0.0.1:1/",
          origin: "http://127.0.0.1:1",
          root: options.root,
          servedVia: ServedVia.RebuildFailed,
          noBuild,
          close: async () => {},
        }),
        quickProbe: async () => assert.fail("a failed rebuild is never probed"),
        fullProbe: async () => assert.fail("a failed rebuild is never probed"),
        quick: false,
        rendererMode: RendererMode.Gpu,
        templateDigest: "0".repeat(64),
        evidenceDir: path.join(dir, "evidence"),
        vendorDir: path.join(dir, "vendor"),
        npmCacheDir: path.join(dir, "npm-cache"),
      });
      const verdict = await prober(CalibrationFixture.BrokenBuild, dir);
      assert.equal(verdict.noBuild, noBuild);
      assert.equal(verdict.l2, CheckResult.Unknown);
    }
  });
});

describe("the calibration prober's probe kind", () => {
  for (const quick of [false, true]) {
    it(`runs the ${quick ? "quick probe" : "full prober"} when grades will`, async () => {
      const dir = await tmpDir("eval-grading-calibration-kind-");
      await writeFile(path.join(dir, "index.html"), "<canvas></canvas>");
      const h = await harness();
      const ran: string[] = [];
      const prober = createCalibrationProber({
        serve: async (options) => ({
          url: "http://127.0.0.1:1/",
          origin: "http://127.0.0.1:1",
          root: options.root,
          servedVia: ServedVia.AsIs,
          noBuild: null,
          close: async () => {},
        }),
        quickProbe: async (url, options) => {
          ran.push("quick");
          return h.deps.quickProbe(url, options);
        },
        fullProbe: async (url, options) => {
          ran.push("full");
          return h.deps.fullProbe(url, options);
        },
        quick,
        rendererMode: RendererMode.Gpu,
        templateDigest: "0".repeat(64),
        evidenceDir: path.join(dir, "evidence"),
        vendorDir: path.join(dir, "vendor"),
        npmCacheDir: path.join(dir, "npm-cache"),
      });
      await prober(CalibrationFixture.EmptyCanvas, dir).catch(() => null);
      assert.deepEqual(ran, [quick ? "quick" : "full"]);
    });
  }
});

describe("pairing a campaign's runs", () => {
  const auto = (lane: typeof LANES.a) => ({ ...lane, id: `${lane.id}-auto`, mode: LaneMode.Auto });

  it("pairs (A,B), (D,C), (A,D), (B,C) per case × rep, and the auto lanes on the harness axis", () => {
    const rows = [1, 2].flatMap((rep) =>
      [LANES.a, LANES.b, LANES.c, LANES.d, auto(LANES.a), auto(LANES.d)].map((lane) => collectedRow({ lane, rep })),
    );
    const pairs = planPairs(rows);
    const shape = pairs.map((pair) => `${pair.rep}:${pair.axis}:${pair.first.lane.id}>${pair.second.lane.id}`);

    assert.equal(pairs.length, 12);
    assert.ok(shape.includes(`1:${Axis.ProductDefault}:${LANES.a.id}>${LANES.b.id}`));
    assert.ok(shape.includes(`2:${Axis.ProductDefault}:${LANES.d.id}>${LANES.c.id}`));
    assert.ok(shape.includes(`1:${Axis.ModelStack}:${LANES.a.id}>${LANES.d.id}`));
    assert.ok(shape.includes(`2:${Axis.ModelStack}:${LANES.b.id}>${LANES.c.id}`));
    assert.ok(shape.includes(`1:${Axis.ProductHarness}:${LANES.a.id}-auto>${LANES.b.id}`));
    assert.ok(shape.includes(`2:${Axis.ProductHarness}:${LANES.d.id}-auto>${LANES.c.id}`));
    assert.equal(new Set(pairs.map((pair) => pair.blindSeed)).size, 12, "every pair has its own seed");
  });

  it("pairs a plugin-off Genex lane with the raw lanes, and Genex lanes only with the same plugins off", () => {
    const off = (lane: typeof LANES.a) => ({ ...lane, id: `${lane.id}-plugin-off`, harnessPin: "0ff0ff0ff0ff" });
    const offIds = new Set([off(LANES.a).id, off(LANES.d).id]);
    const disabledPluginsOf = (laneId: string) => (offIds.has(laneId) ? [GENEX_PLUGIN_ID] : []);
    const rows = [LANES.a, LANES.b, LANES.c, LANES.d, off(LANES.a), off(LANES.d)].map((lane) => collectedRow({ lane }));

    const shape = planPairs(rows, disabledPluginsOf).map(
      (pair) => `${pair.axis}:${pair.first.lane.id}>${pair.second.lane.id}`,
    );

    assert.deepEqual(shape.sort(), [
      `${Axis.ModelStack}:${LANES.a.id}-plugin-off>${LANES.d.id}-plugin-off`,
      `${Axis.ModelStack}:${LANES.a.id}>${LANES.d.id}`,
      `${Axis.ModelStack}:${LANES.b.id}>${LANES.c.id}`,
      `${Axis.ProductDefault}:${LANES.a.id}-plugin-off>${LANES.b.id}`,
      `${Axis.ProductDefault}:${LANES.a.id}>${LANES.b.id}`,
      `${Axis.ProductDefault}:${LANES.d.id}-plugin-off>${LANES.c.id}`,
      `${Axis.ProductDefault}:${LANES.d.id}>${LANES.c.id}`,
    ]);
  });

  it("never pairs across reps, cases, harness failures or a lane with no partner", () => {
    const failedB = collectedRow({
      lane: LANES.b,
      patch: { outcome: { ...collectedRow({ lane: LANES.b }).outcome, harnessFailure: HarnessFailure.CliMissing } },
    });
    const pairs = planPairs([collectedRow({ lane: LANES.a }), failedB, collectedRow({ lane: LANES.c, rep: 2 })]);
    assert.deepEqual(pairs, []);
  });

  it("gives the same placement seed on every call", () => {
    const rows = defaultRows();
    assert.deepEqual(
      planPairs(rows).map((pair) => pair.blindSeed),
      planPairs(rows).map((pair) => pair.blindSeed),
    );
  });
});

describe("regrading", () => {
  it("re-grades from the retained evidence without probing again, as a new gradeSeq of the same observation", async () => {
    const h = await harness();
    await seedCampaign(h);
    await gradeCampaign(CAMPAIGN, h.deps);
    const probes = h.log.probed.length;
    const calls = h.log.graderCalls;
    const outcome = await regradeRun(runIdOf(LANES.a), h.deps);

    assert.equal(outcome.refused, null);
    assert.equal(outcome.gradeSeq, 3);
    assert.equal(outcome.reprobed, false);
    assert.equal(h.log.probed.length, probes, "no new observation");
    assert.ok(h.log.graderCalls > calls, "the checklist is graded again");
    const runRows = (await readRunRows(h.deps.paths)).filter((row) => row.runId === runIdOf(LANES.a));
    const [collected, first, second] = runRows;
    assert.deepEqual(second?.pins.run, collected?.pins.run);
    assert.deepEqual(second?.outcome, collected?.outcome);
    assert.equal(second?.time.firstPlayableMs, first?.time.firstPlayableMs);
    const record = await readGradeRecord(h.deps.paths, runIdOf(LANES.a), 3);
    assert.deepEqual(
      record?.probe?.evidence,
      (await readGradeRecord(h.deps.paths, runIdOf(LANES.a), 2))?.probe?.evidence,
    );
  });

  it("probes the retained snapshots again when asked, or when the prober version moved", async () => {
    const h = await harness();
    await seedCampaign(h);
    await gradeCampaign(CAMPAIGN, h.deps);
    const probes = h.log.probed.length;
    const outcome = await regradeRun(runIdOf(LANES.b), h.deps, { reprobe: true });

    assert.equal(outcome.reprobed, true);
    assert.equal(outcome.gradeSeq, 3);
    assert.ok(h.log.probed.length > probes);
    await access(path.join(gradeDirOf(h.deps.paths, runIdOf(LANES.b), 3), "final"));
  });

  it("refuses an unknown run and a run whose case changed since it ran", async () => {
    const h = await harness();
    await seedCampaign(h);
    const unknown = await regradeRun("20261001T120000-genex-claude-grading-case-r9", h.deps);
    assert.equal(unknown.refused, RegradeRefusal.RunUnknown);
    const changed = await regradeRun(runIdOf(LANES.a), {
      ...h.deps,
      cases: [{ ...gradingCase, version: "ffffffffffff" }],
    });
    assert.equal(changed.refused, RegradeRefusal.CaseChanged);
  });

  it("--baseline regrades the runs the committed baselines reference", async () => {
    const h = await harness();
    await seedCampaign(h);
    await gradeCampaign(CAMPAIGN, h.deps);
    const repo = await tmpDir("eval-grading-repo-");
    await mkdir(path.join(repo, "evals", "baselines"), { recursive: true });
    const baseline = {
      schema: "genex-evals/baseline/1",
      caseId: gradingCase.id,
      caseVersion: gradingCase.version,
      exposure: gradingCase.exposure,
      campaignId: CAMPAIGN,
      promotedAt: "2026-10-01T16:00:00Z",
      epoch: "abcabcabcabc",
      endpointsSha: ENDPOINTS_SHA,
      lanes: [{ laneId: LANES.a.id, runIds: [runIdOf(LANES.a)], endedHow: ["agent-finished"], pins: {}, metrics: {} }],
    };
    await writeFile(path.join(repo, "evals", "baselines", `${gradingCase.id}.json`), JSON.stringify(baseline));

    assert.deepEqual(await baselineRunIds(repo), [runIdOf(LANES.a)]);
    const outcomes = await regradeBaseline(repo, h.deps);
    assert.deepEqual(
      outcomes.map((outcome) => [outcome.runId, outcome.gradeSeq]),
      [[runIdOf(LANES.a), 3]],
    );
  });

  it("reads no baseline from a missing folder", async () => {
    const repo = await tmpDir("eval-grading-empty-repo-");
    assert.deepEqual(await baselineRunIds(repo), []);
  });
});
