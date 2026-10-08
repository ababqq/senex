/**
 * The first-boot / first-playable scan (`scripts/evals/grade/boot-scan.ts`, §8.3): coarse to fine
 * over a run's snapshots, re-verifying the answer and its predecessor, with a 20 s first-draw
 * timeout, at most 12 probes and a 10 min budget. The server and the probe are fakes that answer
 * per snapshot from a table, so each test states which snapshots boot and which are playable.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SCAN_BUDGET_MS,
  SCAN_FIRST_DRAW_TIMEOUT_MS,
  SCAN_MAX_PROBES,
  createBootScan,
} from "../../scripts/evals/grade/boot-scan.ts";
import type {
  BootScanOptions,
  QuickProbeOptions,
  QuickProbeResult,
  ServeHandle,
  ServeOptions,
} from "../../scripts/evals/grade/types.ts";
import {
  CheckResult,
  Coverage,
  EntranceVia,
  ProbeRow,
  RendererMode,
  ServedVia,
  ShimMode,
} from "../../scripts/evals/vocabulary.ts";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";

/** What one snapshot does when probed; a list plays one answer per probe, the last one repeating. */
interface SnapshotPlay {
  booted: boolean | boolean[];
  playable?: boolean | boolean[];
  servedVia?: ServedVia;
  serveThrows?: boolean;
}

function answerAt(value: boolean | boolean[] | undefined, attempt: number): boolean {
  if (value === undefined) return false;
  if (!Array.isArray(value)) return value;
  return value[Math.min(attempt, value.length - 1)] ?? false;
}

function checkOf(value: boolean): CheckResult {
  return value ? CheckResult.Pass : CheckResult.Fail;
}

function quickResult(booted: boolean, playable: boolean, servedVia: ServedVia): QuickProbeResult {
  return {
    rows: { [ProbeRow.L1BuildsAndBoots]: checkOf(booted), [ProbeRow.L2Enterable]: checkOf(playable) },
    l1Gate: checkOf(booted),
    l2Gate: checkOf(playable),
    scored: booted && playable,
    entrance: playable ? EntranceVia.StartControl : EntranceVia.None,
    firstRenderMs: booted ? 500 : null,
    fpsMedian: null,
    consoleErrors: 0,
    rendererMode: RendererMode.Software,
    servedVia,
    evidence: {
      projectOrigin: "",
      frames: [],
      consoleSummaryPath: "",
      networkSummaryPath: "",
      videoPath: null,
      summaryBytes: 0,
    },
    proberVersion: "fake",
    noErrorsMs: 0,
    quick: true,
  };
}

/** A fake server and probe over a table of snapshots, recording every call. */
function fakes(
  plays: SnapshotPlay[],
  clock?: { now: () => number; perProbeMs: number; advance: (ms: number) => void },
) {
  const attempts = new Map<string, number>();
  const calls = { serves: 0, closes: 0, probes: [] as Array<{ root: string; options: QuickProbeOptions }> };
  const playOf = (root: string) => plays[Number(root.replace("snap-", ""))] ?? { booted: false };
  const serve = async (options: ServeOptions): Promise<ServeHandle> => {
    calls.serves += 1;
    const play = playOf(options.root);
    if (play.serveThrows) throw new Error("copy failed");
    return {
      url: `http://127.0.0.1:1/${options.root}`,
      origin: "http://127.0.0.1:1",
      root: options.root,
      servedVia: play.servedVia ?? ServedVia.AsIs,
      noBuild: null,
      close: async () => {
        calls.closes += 1;
      },
    };
  };
  const probe = async (url: string, options: QuickProbeOptions): Promise<QuickProbeResult> => {
    const root = new URL(url).pathname.slice(1);
    calls.probes.push({ root, options });
    clock?.advance(clock.perProbeMs);
    const attempt = attempts.get(root) ?? 0;
    attempts.set(root, attempt + 1);
    const play = playOf(root);
    const booted = answerAt(play.booted, attempt);
    return quickResult(booted, booted && answerAt(play.playable, attempt), play.servedVia ?? ServedVia.AsIs);
  };
  return { serve, probe, calls };
}

/** Scan options over `n` snapshots taken every 30 s from 30 s on. */
function scanOptions(n: number, overrides: Partial<BootScanOptions> = {}): BootScanOptions {
  return {
    snapshots: Array.from({ length: n }, (_, i) => ({ dir: `snap-${i}`, atMs: (i + 1) * 30 * SECOND_MS })),
    maxProbes: SCAN_MAX_PROBES,
    budgetMs: SCAN_BUDGET_MS,
    serve: { root: "", vendorDir: "/vendor", shimMode: ShimMode.None, npmCacheDir: "/cache" },
    probe: {
      firstDrawTimeoutMs: 120 * SECOND_MS,
      rendererMode: RendererMode.Software,
      noErrorsMs: 5 * SECOND_MS,
      evidenceDir: "/evidence",
    },
    now: () => 0,
    ...overrides,
  };
}

/** Snapshots booting from `boot` on and playable from `playable` on. */
function monotonic(n: number, boot: number, playable: number): SnapshotPlay[] {
  return Array.from({ length: n }, (_, i) => ({ booted: i >= boot, playable: i >= playable }));
}

const atMs = (i: number) => (i + 1) * 30 * SECOND_MS;

describe("first-boot / first-playable scan", () => {
  it("finds first boot and first playable coarse to fine within the probe cap", async () => {
    const fake = fakes(monotonic(20, 9, 13));
    const result = await createBootScan({ serve: fake.serve, probe: fake.probe })(scanOptions(20));
    assert.equal(result.firstBootMs, atMs(9));
    assert.equal(result.firstPlayableMs, atMs(13));
    assert.equal(result.resolutionMs, atMs(13) - atMs(12));
    assert.equal(result.firstBootResolutionMs, atMs(9) - atMs(8));
    assert.equal(result.search.method, "coarse-to-fine");
    assert.ok(result.search.probes <= SCAN_MAX_PROBES);
    assert.equal(result.search.probes, fake.calls.probes.length);
    assert.equal(result.search.capped, false);
    assert.equal(result.coverage, Coverage.Full);
    assert.equal(fake.calls.closes, fake.calls.serves, "every served snapshot is closed");
  });

  it("probes with the 20 s scan timeout, not the final probe's", async () => {
    const fake = fakes(monotonic(4, 0, 0));
    await createBootScan({ serve: fake.serve, probe: fake.probe })(scanOptions(4));
    assert.ok(fake.calls.probes.length > 0);
    for (const call of fake.calls.probes) assert.equal(call.options.firstDrawTimeoutMs, SCAN_FIRST_DRAW_TIMEOUT_MS);
  });

  it("walks back when the predecessor also boots on re-verification", async () => {
    const plays = monotonic(12, 6, 99);
    // Snapshot 5 failed its first probe and boots on the second: playability is not monotonic.
    plays[5] = { booted: [false, true] };
    plays[4] = { booted: false };
    const fake = fakes(plays);
    const result = await createBootScan({ serve: fake.serve, probe: fake.probe })(scanOptions(12));
    assert.equal(result.firstBootMs, atMs(5));
    assert.equal(result.firstPlayableMs, null);
  });

  it("leaves an answer that does not re-verify unanswered", async () => {
    const plays = monotonic(8, 3, 99);
    plays[3] = { booted: [true, false] };
    plays[4] = { booted: [true, false] };
    plays[5] = { booted: [true, false] };
    plays[6] = { booted: [true, false] };
    plays[7] = { booted: [true, false] };
    const fake = fakes(plays);
    const result = await createBootScan({ serve: fake.serve, probe: fake.probe })(scanOptions(8));
    assert.equal(result.firstBootMs, null);
  });

  it("treats a rebuild that failed as unknown: never probed, and it widens the resolution", async () => {
    const plays = monotonic(12, 5, 99);
    plays[4] = { booted: false, servedVia: ServedVia.RebuildFailed };
    const fake = fakes(plays);
    const result = await createBootScan({ serve: fake.serve, probe: fake.probe })(scanOptions(12));
    assert.equal(result.firstBootMs, atMs(5));
    assert.ok(!fake.calls.probes.some((call) => call.root === "snap-4"), "a failed rebuild is never probed");
    const failed = result.probed.find((row) => row.servedVia === ServedVia.RebuildFailed);
    assert.equal(failed?.booted, CheckResult.Unknown);
    assert.equal(result.firstBootResolutionMs, atMs(5) - atMs(3));
  });

  it("treats a copy that could not be served as unknown", async () => {
    const plays = monotonic(8, 2, 99);
    plays[1] = { booted: false, serveThrows: true };
    const fake = fakes(plays);
    const result = await createBootScan({ serve: fake.serve, probe: fake.probe })(scanOptions(8));
    assert.equal(result.firstBootMs, atMs(2));
    assert.equal(result.firstBootResolutionMs, atMs(2));
  });

  it("answers null for a run that never booted", async () => {
    const fake = fakes(monotonic(10, 99, 99));
    const result = await createBootScan({ serve: fake.serve, probe: fake.probe })(scanOptions(10));
    assert.equal(result.firstBootMs, null);
    assert.equal(result.firstPlayableMs, null);
    assert.equal(result.search.capped, false);
    assert.equal(result.coverage, Coverage.Full);
  });

  it("stops at the budget with no answer and scan-budget coverage", async () => {
    let now = 0;
    const clock = { now: () => now, perProbeMs: 4 * MINUTE_MS, advance: (ms: number) => (now += ms) };
    const fake = fakes(monotonic(20, 9, 13), clock);
    const result = await createBootScan({ serve: fake.serve, probe: fake.probe })(scanOptions(20, { now: clock.now }));
    assert.equal(result.firstBootMs, null);
    assert.equal(result.firstPlayableMs, null);
    assert.equal(result.coverage, Coverage.ScanBudget);
    assert.equal(result.search.capped, true);
    assert.ok(fake.calls.probes.length <= Math.ceil(SCAN_BUDGET_MS / clock.perProbeMs));
  });

  it("never exceeds the probe cap, however many snapshots there are", async () => {
    const fake = fakes(monotonic(180, 97, 151));
    const result = await createBootScan({ serve: fake.serve, probe: fake.probe })(scanOptions(180));
    assert.ok(fake.calls.probes.length <= SCAN_MAX_PROBES);
    assert.equal(result.search.probes, fake.calls.probes.length);
    // The playable search ran out of probes before any of its coarse points passed: unmeasured.
    assert.equal(result.firstPlayableMs, null);
    assert.equal(result.coverage, Coverage.ScanBudget);
  });

  it("a cap that cuts the coarse pass before a pass is unmeasured, not never", async () => {
    const fake = fakes(monotonic(120, 3, 100));
    const result = await createBootScan({ serve: fake.serve, probe: fake.probe })(scanOptions(120));
    assert.equal(result.search.capped, true);
    assert.equal(result.firstPlayableMs, null);
    assert.equal(result.resolutionMs, null);
    assert.notEqual(result.coverage, Coverage.Full, "a null first-playable here means unknown, not never playable");
    assert.equal(result.coverage, Coverage.ScanBudget);
    // First boot was found and re-verified before the cap, so it stands.
    assert.equal(result.firstBootMs, atMs(3));
  });

  it("reports the best bracket, capped, when the cap cuts the search short", async () => {
    const fake = fakes(monotonic(20, 9, 13));
    const result = await createBootScan({ serve: fake.serve, probe: fake.probe })(scanOptions(20, { maxProbes: 3 }));
    assert.equal(fake.calls.probes.length, 3);
    assert.equal(result.search.capped, true);
    // Two coarse points (snapshots 9 and 19) fit a cap of 3, then one bisection step: 9 by 6.
    assert.equal(result.firstBootMs, atMs(9));
    assert.equal(result.firstBootResolutionMs, atMs(9) - atMs(6));
  });

  it("does nothing without snapshots", async () => {
    const fake = fakes([]);
    const result = await createBootScan({ serve: fake.serve, probe: fake.probe })(scanOptions(0));
    assert.equal(fake.calls.serves, 0);
    assert.equal(result.coverage, Coverage.Unmeasured);
    assert.equal(result.firstBootMs, null);
  });
});
