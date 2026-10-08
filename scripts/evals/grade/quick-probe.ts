/**
 * The M2 quick probe (§8.2): a short Chromium visit to a served snapshot that answers the eight quick
 * rows. Boot (the first non-degenerate canvas within the first-draw timeout), a no-input idle
 * baseline, the entrance judged by witnesses only (start control gone, press-any-key line gone,
 * pointer lock held, camera moved), input bursts measured against the post-entrance baseline, then
 * the rows, the gates and the evidence a grader may see. Frames are written only after the first
 * render. Every probe holds the machine-wide lock (Rule 11). Quick grades can never be promoted or
 * used by `check`: the result says `quick: true`.
 *
 * `probeBoot` is the boot phase alone, with a short timeout, for the first-boot scan.
 */
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SECOND_MS } from "../../../src/shared/duration.ts";
import { diagnosticUrl } from "../prober/boot-observation.ts";
import {
  fpsMedian,
  glRendererOf,
  type InstrumentSnapshot,
  type LaunchBrowser,
  lastCameraSample,
  type PageEvents,
  type ProbeBrowser,
  rafOf,
  readProbeSnapshotInPage,
} from "../prober/driver.ts";
import { createFrameLog } from "../prober/frame-log.ts";
import { probeInitSource } from "../prober/instrument.ts";
import { type ProbeLockDeps, probeLockPath, withProbeLock } from "../prober/lock.ts";
import { buildBaseline, BaselineName, type PageBaseline, quietWindow } from "../prober/phases/baseline.ts";
import { type BootObservation, bootPhase, bootVerdict, uncaughtBeforeFirstDraw } from "../prober/phases/boot.ts";
import { captureFrame, type PhaseContext } from "../prober/phases/context.ts";
import { cameraMovement, type EntranceObservation, entrancePhase } from "../prober/phases/entrance.ts";
import { type BurstObservation, inputPhase } from "../prober/phases/input.ts";
import { launchPlaywright } from "../prober/playwright-driver.ts";
import { evidenceFrames, type QuickObservation, quickRows } from "../prober/quick-rows.ts";
import { classifyRenderer, launchWithFallback } from "../prober/renderer.ts";
import { PROBER_VERSION } from "../prober/types.ts";
import { AFTER_GESTURE_LABEL, gateFor, isScored } from "../prober/verdicts.ts";
import { EntranceVia, ProbePhase, type RendererMode, ServedVia } from "../vocabulary.ts";
import type {
  BootProbeOptions,
  BootProbeResult,
  ProbeBoot,
  QuickProbeOptions,
  QuickProbeResult,
  RunQuickProbe,
} from "./types.ts";

/** The quick probe's error window: a short variant of the full prober's 60 s. */
export const QUICK_NO_ERRORS_MS = 20 * SECOND_MS;
/** The first-draw wait for a final probe, and for a snapshot in the boot scan (§8.3). */
export const QUICK_FIRST_DRAW_TIMEOUT_MS = 120 * SECOND_MS;
export const SCAN_FIRST_DRAW_TIMEOUT_MS = 20 * SECOND_MS;
/** The no-input window before the entrance, and the one after it on interaction. */
export const IDLE_BASELINE_MS = 3 * SECOND_MS;
export const POST_ENTRANCE_BASELINE_MS = 4 * SECOND_MS;
/**
 * How long the probe waits past `noErrorsMs` of run time: the page's own clock starts when navigation
 * starts, a little after the run clock, and the error window is judged in page time.
 */
export const PAGE_CLOCK_SLACK_MS = 2 * SECOND_MS;
/** The cap on each console and network summary a grader may read. */
export const SUMMARY_BYTES = 4 * 1024;
/** Where the probe writes its full scorecard and summaries inside the evidence folder. */
export const SCORECARD_FILE = "quick-probe.json";
export const CONSOLE_SUMMARY_FILE = "console-summary.json";
export const NETWORK_SUMMARY_FILE = "network-summary.json";

/** What the probe reads from outside; each has a real default. */
export interface QuickProbeDeps {
  launch?: LaunchBrowser;
  sleep?: (ms: number) => Promise<void>;
  /** The machine-wide lock's path; defaults to the one under `$GENEX_EVALS_HOME`. */
  lockPath?: string;
  lock?: ProbeLockDeps;
}

/** One probe's open page and what it has read so far: the state both probes' phases share. */
export interface ProbeRun {
  ctx: PhaseContext;
  launched: RendererMode;
  snapshots: InstrumentSnapshot[];
}

/** The page a probe opened under the lock: its browser, the renderer it launched, and the phases' context. */
export interface OpenedProbe {
  browser: ProbeBrowser;
  launched: RendererMode;
  ctx: PhaseContext;
}

/**
 * Open the page under the machine-wide lock with the renderer fallback, run `work`, always close the
 * browser. The quick probe, the boot probe and the full prober all open their page here.
 */
export async function withProbePage<T>(
  url: string,
  options: BootProbeOptions,
  deps: QuickProbeDeps,
  work: (opened: OpenedProbe) => Promise<T>,
): Promise<T> {
  const lockPath = deps.lockPath ?? probeLockPath();
  const launch = deps.launch ?? ((mode: RendererMode) => launchPlaywright(mode, options.now));
  return withProbeLock(
    lockPath,
    async () => {
      const { browser, launched } = await launchWithFallback(launch, options.rendererMode);
      try {
        const page = await browser.open(url, probeInitSource());
        const frames = createFrameLog(options.evidenceDir ?? null);
        const ctx = {
          page,
          sleep: deps.sleep ?? ((ms: number) => delay(ms)),
          frames,
          projectOrigin: new URL(url).origin,
        };
        return await work({ browser, launched, ctx });
      } finally {
        await browser.close();
      }
    },
    // The lock's staleness is wall-clock age against the file's mtime; the probe's `now` is a run
    // clock and never reaches it.
    deps.lock,
  );
}

/** `withProbePage` for the quick and boot probes: a fresh run over the opened page. */
function withQuickRun<T>(
  url: string,
  options: BootProbeOptions,
  deps: QuickProbeDeps,
  work: (run: ProbeRun) => Promise<T>,
): Promise<T> {
  return withProbePage(url, options, deps, ({ ctx, launched }) => work({ ctx, launched, snapshots: [] }));
}

/** Read the instrument's snapshot and keep it on the run; null when the page did not answer. */
export async function takeSnapshot(run: ProbeRun): Promise<InstrumentSnapshot | null> {
  const snap = await run.ctx.page.evaluate(readProbeSnapshotInPage, undefined);
  if (snap) run.snapshots.push(snap);
  return snap;
}

/** The mode the page's WebGL renderer string reveals, else the one launched. */
export function detectedMode(run: ProbeRun): RendererMode {
  const last = run.snapshots.length ? run.snapshots[run.snapshots.length - 1] : null;
  return classifyRenderer(glRendererOf(last)) ?? run.launched;
}

/** The boot probe (`ProbeBoot`): the boot phase alone, under the lock. */
export async function probeBoot(
  url: string,
  options: BootProbeOptions,
  deps: QuickProbeDeps = {},
): Promise<BootProbeResult> {
  return withQuickRun(url, options, deps, async (run) => {
    const boot = await bootPhase(run.ctx, options.firstDrawTimeoutMs);
    await takeSnapshot(run);
    const events = run.ctx.page.events();
    return {
      booted: bootVerdict(boot, events, options.firstDrawTimeoutMs).result,
      firstRenderMs: boot.firstRenderMs,
      uncaughtBeforeFirstDraw: uncaughtBeforeFirstDraw(boot, events),
      degenerateCanvas: boot.firstRenderMs === null && boot.images > 0,
      rendererMode: detectedMode(run),
      servedVia: options.servedVia ?? ServedVia.AsIs,
      consoleErrors: consoleErrors(events),
      frames: options.evidenceDir ? run.ctx.frames.frames.map((f) => f.ref) : [],
    };
  });
}

/** Contract binding for the scan (`grade/types.ts`). */
export const bootProbe: ProbeBoot = (url, options) => probeBoot(url, options);

/** Console errors plus uncaught page errors. */
export function consoleErrors(events: PageEvents): number {
  return events.console.filter((c) => c.type === "error").length + events.pageErrors.length;
}

/** What the play phases observed once the canvas drew, and where the page's frame series was read up to. */
export interface PlayObservation {
  entrance: EntranceObservation;
  idleMoved: boolean | null;
  stillMoved: boolean | null;
  preBaseline: PageBaseline;
  postBaseline: PageBaseline | null;
  bursts: BurstObservation[];
  cursor: { next: number };
}

/** A no-input baseline on interaction, taken once the entrance is confirmed. */
export async function postEntranceBaseline(ctx: PhaseContext, cursor: { next: number }): Promise<PageBaseline> {
  return buildBaseline(BaselineName.PostEntrance, await quietWindow(ctx, cursor, POST_ENTRANCE_BASELINE_MS));
}

/** Idle baseline, entrance, post-entrance baseline, input bursts. */
export async function playPhases(run: ProbeRun): Promise<PlayObservation> {
  const { ctx } = run;
  const cursor = { next: 0 };
  const idleStart = lastCameraSample(await takeSnapshot(run));
  const preBaseline = buildBaseline(BaselineName.PreGesture, await quietWindow(ctx, cursor, IDLE_BASELINE_MS));
  const idleMoved = cameraMovement(idleStart, lastCameraSample(await takeSnapshot(run))).moved;
  const entrance = await entrancePhase(ctx, idleMoved);
  if (entrance.snapshot) run.snapshots.push(entrance.snapshot);
  await captureFrame(ctx, ProbePhase.Entrance, AFTER_GESTURE_LABEL);
  // The post-entrance window is on interaction: the camera moving there with no input (an intro flyover)
  // means camera motion during the bursts witnesses nothing.
  const stillStart = lastCameraSample(await takeSnapshot(run));
  const postBaseline = entrance.verdict.confirmed ? await postEntranceBaseline(ctx, cursor) : null;
  const stillMoved = postBaseline
    ? cameraMovement(stillStart, lastCameraSample(await takeSnapshot(run))).moved
    : idleMoved;
  const bursts = await inputPhase(ctx, cursor);
  return { entrance, idleMoved, stillMoved, preBaseline, postBaseline, bursts, cursor };
}

/** Keep lines while they fit the byte cap. */
export function capped(lines: string[]): string {
  const kept: string[] = [];
  let bytes = 2;
  for (const line of lines) {
    bytes += Buffer.byteLength(line) + 2;
    if (bytes > SUMMARY_BYTES) break;
    kept.push(line);
  }
  return `[${kept.join(",\n")}]`;
}

/** Write the bounded console and network summaries a grader may read; URLs lose their queries. */
export function writeSummaries(dir: string, events: PageEvents): { console: string; network: string } {
  const consolePath = path.join(dir, CONSOLE_SUMMARY_FILE);
  const networkPath = path.join(dir, NETWORK_SUMMARY_FILE);
  const consoleLines = events.console
    .filter((c) => c.type === "error" || c.type === "warning")
    .map((c) => JSON.stringify({ atMs: Math.round(c.atMs), type: c.type, text: c.text.slice(0, 300) }));
  const errorLines = events.pageErrors.map((e) =>
    JSON.stringify({ atMs: Math.round(e.atMs), type: "pageerror", text: e.message.slice(0, 300) }),
  );
  const networkLines = events.network.map((n) =>
    JSON.stringify({ url: diagnosticUrl(n.url), status: n.status, failure: n.failure }),
  );
  fs.writeFileSync(consolePath, capped([...errorLines, ...consoleLines]));
  fs.writeFileSync(networkPath, capped(networkLines));
  return { console: consolePath, network: networkPath };
}

/** Run the quick probe over a served page (`RunQuickProbe`). */
export async function runQuickProbe(
  url: string,
  options: QuickProbeOptions,
  deps: QuickProbeDeps = {},
): Promise<QuickProbeResult> {
  return withQuickRun(url, options, deps, async (run) => {
    const { ctx } = run;
    const boot = await bootPhase(ctx, options.firstDrawTimeoutMs);
    const play = boot.firstRenderMs === null ? null : await playPhases(run);
    const waitLeft = options.noErrorsMs + PAGE_CLOCK_SLACK_MS - ctx.page.elapsedMs();
    if (waitLeft > 0) await ctx.sleep(waitLeft);
    await takeSnapshot(run);
    return quickResult(run, options, observation(run, options, boot, play));
  });
}

/** Contract binding for the campaign (`grade/types.ts`). */
export const quickProbe: RunQuickProbe = (url, options) => runQuickProbe(url, options);

function observation(
  run: ProbeRun,
  options: QuickProbeOptions,
  boot: BootObservation,
  play: PlayObservation | null,
): QuickObservation {
  const events = run.ctx.page.events();
  return {
    projectOrigin: run.ctx.projectOrigin,
    endAtMs: run.ctx.page.elapsedMs(),
    noErrorsMs: options.noErrorsMs,
    firstRenderMs: boot.firstRenderMs,
    boot: bootVerdict(boot, events, options.firstDrawTimeoutMs),
    events,
    snapshots: run.snapshots,
    entrance: play?.entrance ?? null,
    idleMoved: play?.idleMoved ?? null,
    stillMoved: play?.stillMoved ?? null,
    preBaseline: play?.preBaseline ?? null,
    postBaseline: play?.postBaseline ?? null,
    bursts: play?.bursts ?? [],
    frames: run.ctx.frames.frames,
  };
}

function quickResult(run: ProbeRun, options: QuickProbeOptions, o: QuickObservation): QuickProbeResult {
  const checks = quickRows(o);
  const gate = gateFor(checks);
  const summaries = writeSummaries(options.evidenceDir, o.events);
  const last = run.snapshots.length ? run.snapshots[run.snapshots.length - 1] : null;
  const result: QuickProbeResult = {
    rows: Object.fromEntries(checks.map((c) => [c.id, c.result])),
    l1Gate: gate.l1,
    l2Gate: gate.l2,
    scored: isScored(gate),
    entrance: o.entrance?.verdict.by ?? EntranceVia.None,
    firstRenderMs: o.firstRenderMs,
    fpsMedian: fpsMedian(rafOf(last)),
    consoleErrors: consoleErrors(o.events),
    rendererMode: detectedMode(run),
    servedVia: options.servedVia ?? ServedVia.AsIs,
    evidence: {
      projectOrigin: o.projectOrigin,
      frames: evidenceFrames(o).map((f) => f.ref),
      consoleSummaryPath: summaries.console,
      networkSummaryPath: summaries.network,
      videoPath: null,
      summaryBytes: SUMMARY_BYTES,
    },
    proberVersion: PROBER_VERSION,
    noErrorsMs: options.noErrorsMs,
    quick: true,
  };
  const scorecard = { ...result, checks, frames: o.frames.map((f) => f.record), l3Gate: gate.l3 };
  fs.writeFileSync(path.join(options.evidenceDir, SCORECARD_FILE), `${JSON.stringify(scorecard, null, 2)}\n`);
  return result;
}
