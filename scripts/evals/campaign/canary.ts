/**
 * The canary verdict (§8.1, Rule 20): machine-only and cheap, taken right after each canary. Pass is
 * `l1.builds_and_boots` on the stop-time snapshot: served (a copy rebuilt inside the sandbox when it
 * needs a build) and boot-probed for a non-degenerate canvas with no uncaught error. A harness
 * failure, a typed no-build or a copy that could not be rebuilt is not a pass: the canary exists to
 * catch a provider that drifted, and a canary that says nothing has not shown that it did not.
 */
import path from "node:path";
import { MINUTE_MS } from "../../../src/shared/duration.ts";
import { repOf } from "../grade/pipeline.ts";
import type { BootProbeResult, ProbeBoot, ServeSnapshot } from "../grade/types.ts";
import { type RowProbe, type RunRow, unavailable } from "../ledger/types.ts";
import {
  CheckResult,
  RowKind,
  type HarnessFailure,
  type NoBuild,
  ProbeRow,
  RendererMode,
  ServedVia,
  ShimMode,
  UnavailableReason,
} from "../vocabulary.ts";
import { CANARY_REP, CanaryBracket } from "./types.ts";

/** The canary's first-draw wait: the final snapshot's, not a scan probe's (§8.2). */
export const CANARY_FIRST_DRAW_TIMEOUT_MS = 2 * MINUTE_MS;

/** Why a canary did not pass. */
export const CanaryFailure = {
  HarnessFailure: "harness-failure",
  NoBuild: "no-build",
  /** The copy could not be rebuilt, so nothing could be probed (unknown, never a pass). */
  NotServed: "not-served",
  DidNotBoot: "did-not-boot",
} as const;
export type CanaryFailure = (typeof CanaryFailure)[keyof typeof CanaryFailure];

/** A canary's verdict, with the boot probe it rests on when one ran. */
export interface CanaryVerdict {
  passed: boolean;
  failure: CanaryFailure | null;
  probe: BootProbeResult | null;
}

/** What the verdict is taken from: the run's own guard and its stop-time snapshot. */
export interface CanaryInput {
  runId: string;
  finalSnapshotDir: string | null;
  noBuild: NoBuild | null;
  harnessFailure: HarnessFailure | null;
  evidenceDir: string;
  /** The evaluated app build's vendored files (a Genex project's `/vendor/`); null serves the default ones. */
  vendorDir: string | null;
}

/** Judge one canary. */
export type CanaryJudge = (input: CanaryInput) => Promise<CanaryVerdict>;

/** An app build's vendored files (three.js and the studio hook), relative to its checkout. */
export const APP_VENDOR_DIR = path.join("dist", "resources", "vendor");

/** What judging needs: the snapshot server, the boot probe, and where serving may write. */
export interface CanaryJudgeDeps {
  serve: ServeSnapshot;
  probeBoot: ProbeBoot;
  /** The vendored files a run without an app build is served with. */
  vendorDir: string;
  npmCacheDir: string;
  rendererMode?: RendererMode;
  now?: () => number;
}

const failed = (failure: CanaryFailure, probe: BootProbeResult | null = null): CanaryVerdict => ({
  passed: false,
  failure,
  probe,
});

/** The canary judge over a real (or fake) server and boot probe; the server is always closed. */
export function createCanaryJudge(deps: CanaryJudgeDeps): CanaryJudge {
  return async (input) => {
    if (input.harnessFailure) return failed(CanaryFailure.HarnessFailure);
    if (input.noBuild || input.finalSnapshotDir === null) return failed(CanaryFailure.NoBuild);
    const handle = await deps.serve({
      root: input.finalSnapshotDir,
      vendorDir: input.vendorDir ?? deps.vendorDir,
      shimMode: ShimMode.None,
      npmCacheDir: deps.npmCacheDir,
    });
    try {
      if (handle.servedVia === ServedVia.RebuildFailed) return failed(CanaryFailure.NotServed);
      const probe = await deps.probeBoot(handle.url, {
        firstDrawTimeoutMs: CANARY_FIRST_DRAW_TIMEOUT_MS,
        rendererMode: deps.rendererMode ?? RendererMode.Gpu,
        evidenceDir: input.evidenceDir,
        servedVia: handle.servedVia,
        ...(deps.now ? { now: deps.now } : {}),
      });
      if (probe.booted !== CheckResult.Pass) return failed(CanaryFailure.DidNotBoot, probe);
      return { passed: true, failure: null, probe };
    } finally {
      await handle.close();
    }
  };
}

/** The boot-only probe block a canary row carries; null when nothing was probed. */
export function canaryProbeBlock(verdict: CanaryVerdict): RowProbe | null {
  const probe = verdict.probe;
  if (!probe) return null;
  return {
    l1Gate: probe.booted,
    l2Gate: CheckResult.Unknown,
    rows: { [ProbeRow.L1BuildsAndBoots]: probe.booted },
    firstRenderMs: probe.firstRenderMs,
    fpsMedian: null,
    consoleErrors: probe.consoleErrors,
    soakMs: unavailable(UnavailableReason.ProbeSkipped),
    quick: true,
  };
}

/** A campaign's canary brackets as `baseline promote` reads them from its rows (§8.1, §10.4). */
export interface CanaryResults {
  /** Pass when every (lane, app)'s opening passed on its first try or its retry; unknown with none. */
  opening: CheckResult;
  /** Pass when every closing canary passed; unknown with none. */
  closing: CheckResult;
}

const OPENING_REPS: ReadonlySet<number> = new Set([
  CANARY_REP[CanaryBracket.Opening],
  CANARY_REP[CanaryBracket.OpeningRetry],
]);

/** Whether a canary row booted (`l1.builds_and_boots` passed); a missing row has not. */
export const canaryPassed = (row: RunRow | undefined) => row?.probe?.l1Gate === CheckResult.Pass;

/** Pass when every group has a passing row, fail when one has none, unknown with no groups. */
function bracketResult(groups: ReadonlyMap<string, readonly RunRow[]>): CheckResult {
  if (groups.size === 0) return CheckResult.Unknown;
  return [...groups.values()].every((rows) => rows.some(canaryPassed)) ? CheckResult.Pass : CheckResult.Fail;
}

/** Group canary rows of the given reps by their run id without the rep: one group per (lane, app). */
function groupsOf(rows: readonly RunRow[], reps: ReadonlySet<number>): Map<string, RunRow[]> {
  const groups = new Map<string, RunRow[]>();
  for (const row of rows.filter((candidate) => candidate.kind === RowKind.Canary && reps.has(repOf(candidate.runId)))) {
    const key = row.runId.replace(/-r\d+$/, "");
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return groups;
}

/** The opening and closing canary results of a campaign's current rows. */
export function canaryResults(rows: readonly RunRow[]): CanaryResults {
  const closing = new Set([CANARY_REP[CanaryBracket.Closing]]);
  const closingGroups = new Map([...groupsOf(rows, closing).values()].flat().map((row) => [row.runId, [row]]));
  return { opening: bracketResult(groupsOf(rows, OPENING_REPS)), closing: bracketResult(closingGroups) };
}
