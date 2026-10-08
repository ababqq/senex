/**
 * The M3 full prober end to end against a FAKE page on a virtual clock (the probe's own sleeps and
 * key holds advance it): boot, the quick probe's entrance and bursts, directions, ack, interact,
 * look, the 300 s seeded soak, the phone pass, every `ProbeRow`, the gates, the evidence and the
 * machine-wide lock. Also the quick-versus-full typing the grading pipeline relies on: a quick grade
 * is never promotable and its soak pin is unavailable. No browser starts; the Chromium run is
 * `eval-full-prober-browser.test.ts`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { QuickProbeResult } from "../../scripts/evals/grade/types.ts";
import {
  CanvasState,
  type Capture,
  type PageEvents,
  type ProbeBrowser,
  readProbeSeriesInPage,
  readProbeSnapshotInPage,
} from "../../scripts/evals/prober/driver.ts";
import {
  FULL_SCORECARD_FILE,
  type FullProbeResult,
  isFullProbe,
  promotable,
  rowProbeOf,
  runFullProbe,
  TIMELINE_FILE,
} from "../../scripts/evals/prober/full-probe.ts";
import { probeInitSource } from "../../scripts/evals/prober/instrument.ts";
import { probeLockPath } from "../../scripts/evals/prober/lock.ts";
import type { FullProbePage, ProbeMouse } from "../../scripts/evals/prober/phases/full-context.ts";
import type { PhonePage } from "../../scripts/evals/prober/phases/mobile.ts";
import { markInPage, readCameraInPage, readSeriesInPage } from "../../scripts/evals/prober/phases/series.ts";
import { SPEC_SOAK_MS } from "../../scripts/evals/prober/phases/soak.ts";
import { encodePng, type RawFrame } from "../../scripts/evals/prober/png.ts";
import {
  blurActiveInPage,
  chromeAtInPage,
  describeFocusInPage,
  dispatchLookDeltasInPage,
  findPressAnyKeyInPage,
  findStartControlInPage,
  readOccludedStartControlInPage,
} from "../../scripts/evals/prober/start-control.ts";
import { PROBER_VERSION } from "../../scripts/evals/prober/types.ts";
import {
  CheckResult,
  EntranceVia,
  ProbeRow,
  RendererMode,
  ServedVia,
  UnavailableReason,
} from "../../scripts/evals/vocabulary.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PROJECT = "http://127.0.0.1:4173";
const URL_ = `${PROJECT}/index.html`;
const SAMPLE_EVERY_MS = 100;
const RAD = Math.PI / 180;
const GPU = "ANGLE (Apple, ANGLE Metal Renderer: Apple M3)";
const SOFTWARE = "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)";

function frame(kind: "flat" | "scene"): RawFrame {
  const width = 64;
  const height = 36;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = kind === "flat" ? 40 : 60 + ((x * 7 + y * 13) % 11) * 12;
      data.set([v, (v + 30) % 256, (v * 2) % 256, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}
const png = (kind: "flat" | "scene"): Capture => ({ png: encodePng(frame(kind)), source: "page" });

interface Scenario {
  drawsAtMs: number | null;
  glRenderer?: string;
  /** The page has a real mouse. */
  mouse?: boolean;
  /** W walks backward and S forward. */
  inverted?: boolean;
}

/** A project on a virtual clock: W walks forward, S back, pointer deltas turn the camera, input shows. */
function fakeProject(s: Scenario) {
  let now = 0;
  let clicked = false;
  let respondUntil = -1;
  let heading = 0;
  let z = 0;
  const samples: Array<{ t: number; m: number; d: number }> = [];
  const rms: Array<{ t: number; c: number; rms: number; peak: number }> = [];
  const pressed: string[] = [];
  const events: PageEvents = {
    console: [],
    pageErrors: [],
    network: [
      { url: URL_, method: "GET", status: 200, resourceType: "document", failure: null, startedAtMs: 0 },
      { url: `${PROJECT}/main.js`, method: "GET", status: 200, resourceType: "script", failure: null, startedAtMs: 5 },
      { url: `${PROJECT}/theme.ogg`, method: "GET", status: 200, resourceType: "media", failure: null, startedAtMs: 9 },
    ],
    navigations: [{ atMs: 0, url: URL_ }],
    documentStatus: 200,
  };
  const drawn = () => s.drawsAtMs !== null && now >= s.drawsAtMs;
  const advance = (ms: number) => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + SAMPLE_EVERY_MS);
      if (!drawn()) continue;
      samples.push({ t: now, m: 0.4, d: now <= respondUntil ? 0.05 : 0.001 });
      rms.push({ t: now, c: 1, rms: 0.01, peak: 0.02 });
    }
  };
  const camera = () => ({ t: now, x: 0, y: 1, z, fx: Math.sin(heading * RAD), fy: 0, fz: Math.cos(heading * RAD) });
  const snapshot = () => ({
    href: URL_,
    raf: {
      calls: 100,
      distinctFrames: drawn() ? 100 : 0,
      firstT: drawn() ? s.drawsAtMs : null,
      lastT: now,
      intervals: [16, 17, 16],
    },
    errors: [],
    rejections: [],
    contextLost: [],
    canvases: [{ id: 1, kind: "webgl2", t: 10, attrs: null, width: 1280, height: 720 }],
    gl: { renderer: s.glRenderer ?? GPU, vendor: "x", forcedPreserveDrawingBuffer: true },
    camera: { seen: true, hooks: 1, viewLocs: 1, samples: [camera()] },
    pointerLock: { requested: 0, grantedNatively: false, shimmed: false, locked: false },
    fullscreen: { requested: 0, granted: false },
    heap: {
      available: true,
      samples: Array.from({ length: Math.floor(now / 1000) }, (_, i) => ({
        t: i * 1000,
        used: 10e6 + (i % 3) * 1000,
        total: 20e6,
      })),
      note: "",
    },
    audio: {
      contexts: [{ id: 1, t: 0, sampleRate: 48000, states: [], finalState: "running", analyserAttached: true }],
      edges: [],
      edgesTotal: 2,
      edgesRecordingCapped: false,
      edgesToDestination: 1,
      distinctSources: 1,
      peakRms: 0.01,
      rmsSamples: rms.length,
      elements: [],
    },
  });
  const answers = new Map<unknown, (arg: never) => unknown>([
    [readProbeSnapshotInPage, () => snapshot()],
    [
      readProbeSeriesInPage,
      (from: number) => ({
        installedAt: 0,
        href: URL_,
        frames: samples.slice(from),
        rms: [],
        nextFrame: samples.length,
        nextRms: 0,
      }),
    ],
    [
      readSeriesInPage,
      (arg: { fromFrame: number; fromRms: number }) => ({
        installedAt: 0,
        href: URL_,
        frames: samples.slice(arg.fromFrame),
        rms: rms.slice(arg.fromRms),
        nextFrame: samples.length,
        nextRms: rms.length,
      }),
    ],
    [markInPage, () => now],
    [readCameraInPage, () => camera()],
    [findStartControlInPage, () => (clicked ? null : "PLAY")],
    [readOccludedStartControlInPage, () => null],
    [findPressAnyKeyInPage, () => null],
    [chromeAtInPage, () => ({ interactive: false, name: "" })],
    [
      describeFocusInPage,
      () => ({ tag: "BODY", type: null, role: null, href: false, contentEditable: false, name: "" }),
    ],
    [blurActiveInPage, () => false],
    [
      dispatchLookDeltasInPage,
      (arg: { dx: number }) => {
        heading += arg.dx * 0.13;
        respondUntil = now + 300;
        return { target: "canvas", dispatched: 2 };
      },
    ],
  ]);
  const mouse: ProbeMouse = { move: async () => true, down: async () => true, up: async () => true };
  const page: FullProbePage = {
    elapsedMs: () => now,
    url: () => URL_,
    viewport: () => ({ width: 1280, height: 720 }),
    async evaluate(fn, arg) {
      const answer = answers.get(fn);
      if (!answer) throw new Error(`the fake page has no answer for ${fn.name}`);
      return answer(arg as never) as never;
    },
    async captureCanvas() {
      return { state: CanvasState.Image, capture: png(drawn() ? "scene" : "flat") };
    },
    async screenshot() {
      return png(drawn() ? "scene" : "flat");
    },
    async click() {
      clicked = true;
      return true;
    },
    async clickAt() {
      return true;
    },
    async press(key, holdMs) {
      pressed.push(key);
      respondUntil = now + holdMs + 500;
      const forward = s.inverted ? -1 : 1;
      if (key === "KeyW") z += (forward * holdMs) / 100;
      if (key === "KeyS") z -= (forward * holdMs) / 100;
      advance(holdMs);
      return true;
    },
    events: () => events,
    ...(s.mouse ? { mouse } : {}),
  };
  const phone: PhonePage = {
    ...page,
    captureCanvas: async () => ({ state: CanvasState.Image, capture: png("scene") }),
    tap: async () => true,
  };
  const browser: ProbeBrowser & { openPhone: (url: string, init: string) => Promise<PhonePage> } = {
    async open(target, initScript) {
      assert.equal(target, URL_);
      assert.equal(initScript, probeInitSource(), "the instrument is injected before the page runs");
      return page;
    },
    async openPhone() {
      return phone;
    },
    async close() {},
  };
  return { browser, sleep: async (ms: number) => advance(ms), pressed };
}

async function setup() {
  const home = fs.realpathSync(await tmpDir("eval-full-prober-"));
  const evidenceDir = path.join(home, "evidence", "run-1", "probe");
  return { evidenceDir, lockPath: probeLockPath({ GENEX_EVALS_HOME: home }) };
}

/** A deliberately short soak's chosen budget (the default floor, `probeBudgetMs`, is also enough). */
const SHORT_SOAK_BUDGET_MS = 600_000;

async function probe(s: Scenario, extra: { soakMs?: number; rendererMode?: RendererMode } = {}) {
  const { evidenceDir, lockPath } = await setup();
  const project = fakeProject(s);
  const result = await runFullProbe(
    URL_,
    {
      firstDrawTimeoutMs: 10_000,
      rendererMode: extra.rendererMode ?? RendererMode.Gpu,
      evidenceDir,
      soakMs: extra.soakMs,
      budgetMs: extra.soakMs === undefined ? undefined : SHORT_SOAK_BUDGET_MS,
    },
    { launch: async () => project.browser, sleep: project.sleep, lockPath },
  );
  return { result, evidenceDir, lockPath, project };
}

const ALL_ROWS = Object.values(ProbeRow);

describe("runFullProbe", () => {
  it("answers every row for a project that boots, enters, walks the right way, survives the soak and draws on a phone", async () => {
    const { result, evidenceDir, lockPath } = await probe({ drawsAtMs: 2_000, mouse: true });
    assert.deepEqual(Object.keys(result.rows).sort(), [...ALL_ROWS].sort());
    assert.deepEqual(
      result.checks.map((c) => c.id),
      ALL_ROWS,
      "the scorecard lists rows in ProbeRow order",
    );
    const passes = [
      ProbeRow.L1BuildsAndBoots,
      ProbeRow.L1NoErrors60s,
      ProbeRow.L1StayedOnProject,
      ProbeRow.L1Survives5min,
      ProbeRow.L1FrameRateFloor,
      ProbeRow.L2Enterable,
      ProbeRow.L2InputChangesState,
      ProbeRow.L2ActionAcknowledged200ms,
      ProbeRow.L2NoSoftLock5min,
      ProbeRow.L2DirectionsMatchLabels,
      ProbeRow.L2InteractAcknowledged,
      ProbeRow.L3PhoneViewport,
      ProbeRow.L3AudioNetwork,
      ProbeRow.L3AudioContextState,
      ProbeRow.L3AudioOutputRms,
    ];
    for (const id of passes) assert.equal(result.rows[id], CheckResult.Pass, id);
    assert.equal(result.rows[ProbeRow.L3SpatiallyLegible], CheckResult.Unknown, "judge-owned");
    assert.equal(result.rows[ProbeRow.L3DarkPhase], CheckResult.Unknown, "no operator review was given");
    assert.equal(result.l1Gate, CheckResult.Pass);
    assert.equal(result.l2Gate, CheckResult.Pass);
    assert.equal(result.scored, true);
    assert.equal(result.quick, false);
    assert.equal(result.soakMs, SPEC_SOAK_MS, "the soak pin is the configured soak");
    assert.ok((result.soakRanMs ?? 0) >= SPEC_SOAK_MS);
    assert.equal(result.entrance, EntranceVia.StartControl);
    assert.equal(result.rendererMode, RendererMode.Gpu);
    assert.equal(result.servedVia, ServedVia.AsIs);
    assert.equal(result.proberVersion, PROBER_VERSION);
    assert.equal(result.noErrorsMs, 60_000);
    assert.equal(result.judgeEvidence.sufficient, true);
    for (const f of result.evidence.frames) {
      assert.ok(f.atMs > 2_000, "never before the first render");
      assert.equal(f.origin, PROJECT);
      assert.ok(fs.existsSync(f.path));
    }
    assert.ok(fs.existsSync(path.join(evidenceDir, FULL_SCORECARD_FILE)));
    assert.ok(fs.existsSync(path.join(evidenceDir, TIMELINE_FILE)));
    assert.equal(fs.existsSync(lockPath), false, "the lock is released");
  });

  it("with the canvas never drawing, every play row is unknown and no soak runs, but every row is still answered", async () => {
    const { result, evidenceDir } = await probe({ drawsAtMs: null });
    assert.deepEqual(Object.keys(result.rows).sort(), [...ALL_ROWS].sort());
    assert.equal(result.rows[ProbeRow.L1BuildsAndBoots], CheckResult.Fail);
    for (const id of [
      ProbeRow.L2DirectionsMatchLabels,
      ProbeRow.L2ActionAcknowledged200ms,
      ProbeRow.L1Survives5min,
      ProbeRow.L2NoSoftLock5min,
    ]) {
      assert.equal(result.rows[id], CheckResult.Unknown, id);
    }
    assert.equal(result.soakRanMs, null);
    assert.equal(result.scored, false);
    assert.deepEqual(result.evidence.frames, []);
    assert.deepEqual(
      fs.readdirSync(evidenceDir).filter((f) => f.endsWith(".png") && f !== "phone.png"),
      [],
      "a loading card is never written as evidence",
    );
  });

  it("AN INVERTED SCHEME fails the directions row from the engine camera, and the run is not scored", async () => {
    const { result } = await probe({ drawsAtMs: 1_000, inverted: true }, { soakMs: 30_000 });
    const row = result.checks.find((c) => c.id === ProbeRow.L2DirectionsMatchLabels);
    assert.equal(row?.result, CheckResult.Fail);
    assert.match(row?.detail ?? "", /INVERTED/);
    assert.equal(result.l2Gate, CheckResult.Fail);
    assert.equal(result.scored, false);
  });

  it("A SHORTER SOAK is recorded as the pin and leaves both five-minute rows unknown", async () => {
    const { result } = await probe({ drawsAtMs: 1_000 }, { soakMs: 60_000 });
    assert.equal(result.soakMs, 60_000);
    assert.equal(result.rows[ProbeRow.L1Survives5min], CheckResult.Unknown);
    assert.equal(result.rows[ProbeRow.L2NoSoftLock5min], CheckResult.Unknown);
  });

  it("A SHORT SOAK WITHOUT A CHOSEN BUDGET still runs in full: the budget floor holds it", async () => {
    const { evidenceDir, lockPath } = await setup();
    const project = fakeProject({ drawsAtMs: 1_000 });
    const result = await runFullProbe(
      URL_,
      { firstDrawTimeoutMs: 10_000, rendererMode: RendererMode.Gpu, evidenceDir, soakMs: 30_000 },
      { launch: async () => project.browser, sleep: project.sleep, lockPath },
    );
    assert.equal(result.soakMs, 30_000);
    assert.ok((result.soakRanMs ?? 0) >= 30_000, "the whole short soak ran");
  });

  it("ON A SOFTWARE RASTERISER the frame-rate and ack rows never gate, read from the page, not the flags", async () => {
    const { result } = await probe({ drawsAtMs: 1_000, glRenderer: SOFTWARE }, { soakMs: 30_000 });
    assert.equal(result.rendererMode, RendererMode.Software);
    const gates = (id: ProbeRow) => result.checks.find((c) => c.id === id)?.gates;
    assert.equal(gates(ProbeRow.L1FrameRateFloor), false);
    assert.equal(gates(ProbeRow.L2ActionAcknowledged200ms), false);
  });

  it("A PAGE WITH NO MOUSE still drags (synthetically) and the scorecard says what it could not send", async () => {
    const { result, project } = await probe({ drawsAtMs: 1_000 }, { soakMs: 30_000 });
    assert.equal(result.rows[ProbeRow.L2InputChangesState], CheckResult.Pass);
    assert.ok(project.pressed.length > 0);
    const scorecard = JSON.parse(fs.readFileSync(result.scorecardPath, "utf8")) as { notes: string[] };
    assert.ok(scorecard.notes.some((n) => /hover move\(s\) were skipped: the page has no mouse/.test(n)));
  });
});

describe("quick or full is a type", () => {
  const quickResult = (): QuickProbeResult => ({
    rows: {},
    l1Gate: CheckResult.Pass,
    l2Gate: CheckResult.Pass,
    scored: true,
    entrance: EntranceVia.None,
    firstRenderMs: 1,
    fpsMedian: 60,
    consoleErrors: 0,
    rendererMode: RendererMode.Gpu,
    servedVia: ServedVia.AsIs,
    evidence: {
      projectOrigin: PROJECT,
      frames: [],
      consoleSummaryPath: "",
      networkSummaryPath: "",
      videoPath: null,
      summaryBytes: 0,
    },
    proberVersion: PROBER_VERSION,
    noErrorsMs: 20_000,
    quick: true,
  });

  it("a quick grade is never promotable and its soak pin is unavailable; a full one carries its soak", async () => {
    const quick = quickResult();
    assert.equal(isFullProbe(quick), false);
    assert.equal(promotable(quick), false);
    assert.deepEqual(rowProbeOf(quick).soakMs, { unavailable: true, reason: UnavailableReason.ProbeSkipped });
    assert.equal(rowProbeOf(quick).quick, true);
    const { result } = await probe({ drawsAtMs: 1_000 }, { soakMs: 30_000 });
    const full: FullProbeResult = result;
    assert.equal(promotable(full), true);
    assert.equal(rowProbeOf(full).soakMs, 30_000);
    assert.equal(rowProbeOf(full).quick, false);
  });
});
