/**
 * The M2 quick probe end to end against a FAKE page on a virtual clock: boot, idle baseline,
 * entrance by witness, input bursts against the post-entrance baseline, the eight rows, the gates,
 * the evidence frames (only after first render, only on interaction) and the machine-wide lock. No
 * browser starts; `eval-prober-browser.test.ts` runs the same probe in Chromium when opted in.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { probeBoot, runQuickProbe } from "../../scripts/evals/grade/quick-probe.ts";
import {
  CanvasState,
  type CanvasCapture,
  type Capture,
  type PageEvents,
  type ProbeBrowser,
  type ProbePage,
  readProbeSeriesInPage,
  readProbeSnapshotInPage,
} from "../../scripts/evals/prober/driver.ts";
import { probeInitSource } from "../../scripts/evals/prober/instrument.ts";
import { probeLockPath } from "../../scripts/evals/prober/lock.ts";
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
  ProbePhase,
  ProbeRow,
  QUICK_PROBE_ROWS,
  RendererMode,
  ServedVia,
} from "../../scripts/evals/vocabulary.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PROJECT = "http://127.0.0.1:4173";
const URL_ = `${PROJECT}/index.html`;
const SAMPLE_EVERY_MS = 100;

/** A 64x36 frame: flat grey, or a textured mid-tone scene. */
function frame(kind: "flat" | "scene"): RawFrame {
  const width = 64;
  const height = 36;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const v = kind === "flat" ? 40 : 60 + ((x * 7 + y * 13) % 11) * 12;
      data.set([v, (v + 30) % 256, (v * 2) % 256, 255], o);
    }
  }
  return { width, height, data };
}
const png = (kind: "flat" | "scene"): Capture => ({ png: encodePng(frame(kind)), source: "page" });

interface Scenario {
  /** Run ms at which the canvas first draws something non-flat; `null` never. */
  drawsAtMs: number | null;
  startControl: string | null;
  /** Whether input produces a visible response in the page-side series. */
  responds: boolean;
  /** A foreign URL the page navigates to at this run ms. */
  leavesAtMs?: number;
  glRenderer?: string;
  uncaughtAtMs?: number;
  /** The page clock starts this much after the run clock (navigation begins after the page opens). */
  pageClockLagMs?: number;
  /** After the start control is clicked, the camera flies on its own (an intro), with no input. */
  cameraFliesAfterEntrance?: boolean;
}

/** A fake page on a virtual clock that the probe's own sleeps advance. */
function fakePage(s: Scenario) {
  let now = 0;
  let clicked = false;
  let respondUntil = -1;
  let url = URL_;
  const samples: Array<{ t: number; m: number; d: number }> = [];
  const events: PageEvents = {
    console: [],
    pageErrors: s.uncaughtAtMs === undefined ? [] : [{ atMs: s.uncaughtAtMs, message: "boom" }],
    network: [
      { url: URL_, method: "GET", status: 200, resourceType: "document", failure: null, startedAtMs: 0 },
      { url: `${PROJECT}/main.js`, method: "GET", status: 200, resourceType: "script", failure: null, startedAtMs: 5 },
    ],
    navigations: [{ atMs: 0, url: URL_ }],
    documentStatus: 200,
  };
  const advance = (ms: number) => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + SAMPLE_EVERY_MS);
      if (s.drawsAtMs !== null && now >= s.drawsAtMs)
        samples.push({ t: now, m: 0.4, d: now <= respondUntil ? 0.05 : 0.001 });
      if (s.leavesAtMs !== undefined && now >= s.leavesAtMs && url === URL_) {
        url = "https://elsewhere.example.test/login";
        events.navigations.push({ atMs: now, url });
      }
    }
  };
  const drawn = () => s.drawsAtMs !== null && now >= s.drawsAtMs;
  const snapshot = () => ({
    href: url,
    raf: {
      calls: 100,
      distinctFrames: drawn() ? 100 : 0,
      firstT: drawn() ? s.drawsAtMs : null,
      lastT: now - (s.pageClockLagMs ?? 0),
      intervals: [16, 17, 16],
    },
    errors: [],
    rejections: [],
    contextLost: [],
    canvases: [{ id: 1, kind: "webgl2", t: 10, attrs: null, width: 1280, height: 720 }],
    gl: {
      renderer: s.glRenderer ?? "ANGLE (Apple, ANGLE Metal Renderer: Apple M3)",
      vendor: "Apple",
      forcedPreserveDrawingBuffer: true,
    },
    camera: {
      seen: true,
      hooks: 1,
      viewLocs: 1,
      samples: [{ t: now, x: 0, y: 1, z: s.cameraFliesAfterEntrance && clicked ? now / 100 : 0, fx: 0, fy: 0, fz: 1 }],
    },
    pointerLock: { requested: 0, grantedNatively: false, shimmed: false, locked: false },
    fullscreen: { requested: 0, granted: false },
  });
  const answers = new Map<unknown, (arg: unknown) => unknown>([
    [readProbeSnapshotInPage, () => snapshot()],
    [
      readProbeSeriesInPage,
      (from) => ({
        installedAt: 0,
        href: url,
        frames: samples.slice(from as number),
        rms: [],
        nextFrame: samples.length,
        nextRms: 0,
      }),
    ],
    [findStartControlInPage, () => (clicked ? null : s.startControl)],
    [readOccludedStartControlInPage, () => null],
    [findPressAnyKeyInPage, () => null],
    [chromeAtInPage, () => ({ interactive: false, name: "" })],
    [
      describeFocusInPage,
      () => ({ tag: "BODY", type: null, role: null, href: false, contentEditable: false, name: "" }),
    ],
    [blurActiveInPage, () => false],
    [dispatchLookDeltasInPage, () => ({ target: "canvas", dispatched: 2 })],
  ]);
  const page: ProbePage = {
    elapsedMs: () => now,
    url: () => url,
    viewport: () => ({ width: 1280, height: 720 }),
    async evaluate(fn, arg) {
      const answer = answers.get(fn);
      if (!answer) throw new Error(`the fake page has no answer for ${fn.name}`);
      return answer(arg) as never;
    },
    async captureCanvas(): Promise<CanvasCapture> {
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
    async press(_key, holdMs) {
      if (s.responds) respondUntil = now + holdMs + 500;
      advance(holdMs);
      return true;
    },
    events: () => events,
  };
  const opened: string[] = [];
  const browser: ProbeBrowser = {
    async open(target, initScript) {
      opened.push(target);
      assert.equal(initScript, probeInitSource(), "the instrument is injected before the page runs");
      return page;
    },
    async close() {},
  };
  return { browser, sleep: async (ms: number) => advance(ms), opened };
}

async function setup() {
  const home = fs.realpathSync(await tmpDir("eval-prober-quick-"));
  const evidenceDir = path.join(home, "evidence", "run-1", "probe");
  return { home, evidenceDir, lockPath: probeLockPath({ GENEX_EVALS_HOME: home }) };
}

const options = (evidenceDir: string) => ({
  firstDrawTimeoutMs: 10_000,
  rendererMode: RendererMode.Gpu,
  noErrorsMs: 20_000,
  evidenceDir,
});

describe("runQuickProbe", () => {
  it("scores a project that boots, opens by its start control and answers input", async () => {
    const { evidenceDir, lockPath } = await setup();
    const fake = fakePage({ drawsAtMs: 2_000, startControl: "PLAY", responds: true });
    const result = await runQuickProbe(URL_, options(evidenceDir), {
      launch: async () => fake.browser,
      sleep: fake.sleep,
      lockPath,
    });
    assert.deepEqual(Object.keys(result.rows).sort(), [...QUICK_PROBE_ROWS].sort());
    for (const id of QUICK_PROBE_ROWS) assert.equal(result.rows[id], CheckResult.Pass, id);
    assert.equal(result.l1Gate, CheckResult.Pass);
    assert.equal(result.l2Gate, CheckResult.Pass);
    assert.equal(result.scored, true);
    assert.equal(result.entrance, EntranceVia.StartControl);
    assert.equal(result.firstRenderMs, 2_000);
    assert.equal(result.rendererMode, RendererMode.Gpu);
    assert.equal(result.servedVia, ServedVia.AsIs);
    assert.equal(result.proberVersion, PROBER_VERSION);
    assert.equal(result.quick, true);
    assert.equal(result.evidence.frames.length, 8, "one after-gesture frame and one per burst");
    for (const f of result.evidence.frames) {
      assert.ok(f.atMs > 2_000, "never before the first render");
      assert.equal(f.origin, PROJECT);
      assert.notEqual(f.phase, ProbePhase.Boot);
      assert.ok(fs.existsSync(f.path));
    }
    assert.ok(fs.statSync(result.evidence.consoleSummaryPath).size <= result.evidence.summaryBytes);
    assert.ok(fs.statSync(result.evidence.networkSummaryPath).size <= result.evidence.summaryBytes);
    assert.equal(fs.existsSync(lockPath), false, "the lock is released");
  });

  it("writes no frame and fails the floor when the canvas never draws", async () => {
    const { evidenceDir, lockPath } = await setup();
    const fake = fakePage({ drawsAtMs: null, startControl: "PLAY", responds: true });
    const result = await runQuickProbe(URL_, options(evidenceDir), {
      launch: async () => fake.browser,
      sleep: fake.sleep,
      lockPath,
    });
    assert.equal(result.rows[ProbeRow.L1BuildsAndBoots], CheckResult.Fail);
    assert.equal(result.l1Gate, CheckResult.Fail);
    assert.equal(result.scored, false);
    assert.equal(result.firstRenderMs, null);
    assert.equal(result.rows[ProbeRow.L2Enterable], CheckResult.Unknown);
    assert.equal(result.rows[ProbeRow.L2InputChangesState], CheckResult.Unknown);
    assert.deepEqual(result.evidence.frames, []);
    assert.deepEqual(
      fs.readdirSync(evidenceDir).filter((f) => f.endsWith(".png")),
      [],
      "a loading card is never written as evidence",
    );
  });

  it("fails input_changes_state when nothing answers the input, against the post-entrance baseline", async () => {
    const { evidenceDir, lockPath } = await setup();
    const fake = fakePage({ drawsAtMs: 1_000, startControl: "PLAY", responds: false });
    const result = await runQuickProbe(URL_, options(evidenceDir), {
      launch: async () => fake.browser,
      sleep: fake.sleep,
      lockPath,
    });
    assert.equal(result.rows[ProbeRow.L2InputChangesState], CheckResult.Fail);
    assert.equal(result.l2Gate, CheckResult.Fail);
    assert.equal(result.scored, false);
  });

  it("a camera that flies on its own after the entrance is no witness that input changed anything", async () => {
    const { evidenceDir, lockPath } = await setup();
    const fake = fakePage({ drawsAtMs: 1_000, startControl: "PLAY", responds: false, cameraFliesAfterEntrance: true });
    const result = await runQuickProbe(URL_, options(evidenceDir), {
      launch: async () => fake.browser,
      sleep: fake.sleep,
      lockPath,
    });
    assert.equal(result.rows[ProbeRow.L2InputChangesState], CheckResult.Fail);
  });

  it("the page clock starting after the run clock does not leave the error window unobserved", async () => {
    const { evidenceDir, lockPath } = await setup();
    const fake = fakePage({ drawsAtMs: 1_000, startControl: null, responds: true, pageClockLagMs: 400 });
    const result = await runQuickProbe(URL_, options(evidenceDir), {
      launch: async () => fake.browser,
      sleep: fake.sleep,
      lockPath,
    });
    assert.equal(result.rows[ProbeRow.L1NoErrors60s], CheckResult.Pass);
  });

  it("the lock judges staleness on the wall clock, never on the probe's injected run clock", async () => {
    const { evidenceDir, lockPath } = await setup();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "777");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(lockPath, twoHoursAgo, twoHoursAgo);
    const fake = fakePage({ drawsAtMs: 1_000, startControl: null, responds: true });
    const result = await runQuickProbe(
      URL_,
      { ...options(evidenceDir), now: () => 0 },
      {
        launch: async () => fake.browser,
        sleep: fake.sleep,
        lockPath,
        lock: { isAlive: () => true, waitMs: 0, sleep: async () => {} },
      },
    );
    assert.equal(result.quick, true, "a two-hour-old lock is broken even though the run clock reads 0");
  });

  it("an uncaught error before the first draw fails the boot", async () => {
    const { evidenceDir, lockPath } = await setup();
    const fake = fakePage({ drawsAtMs: 2_000, startControl: null, responds: true, uncaughtAtMs: 500 });
    const result = await runQuickProbe(URL_, options(evidenceDir), {
      launch: async () => fake.browser,
      sleep: fake.sleep,
      lockPath,
    });
    assert.equal(result.rows[ProbeRow.L1BuildsAndBoots], CheckResult.Fail);
  });

  it("fails stayed_on_project when the document leaves the origin, with no bounce allowed", async () => {
    const { evidenceDir, lockPath } = await setup();
    const fake = fakePage({ drawsAtMs: 1_000, startControl: null, responds: true, leavesAtMs: 12_000 });
    const result = await runQuickProbe(URL_, options(evidenceDir), {
      launch: async () => fake.browser,
      sleep: fake.sleep,
      lockPath,
    });
    assert.equal(result.rows[ProbeRow.L1StayedOnProject], CheckResult.Fail);
    assert.ok(
      result.evidence.frames.every((f) => f.origin === PROJECT),
      "frames off the project's origin are never evidence",
    );
  });

  it("reads the renderer back: SwiftShader behind a GPU launch reports software", async () => {
    const { evidenceDir, lockPath } = await setup();
    const fake = fakePage({ drawsAtMs: 1_000, startControl: null, responds: true, glRenderer: "Google SwiftShader" });
    const result = await runQuickProbe(URL_, options(evidenceDir), {
      launch: async () => fake.browser,
      sleep: fake.sleep,
      lockPath,
    });
    assert.equal(result.rendererMode, RendererMode.Software);
  });

  it("falls back to a software launch when the GPU launch fails", async () => {
    const { evidenceDir, lockPath } = await setup();
    const fake = fakePage({ drawsAtMs: 1_000, startControl: null, responds: true, glRenderer: "Google SwiftShader" });
    const tried: RendererMode[] = [];
    const result = await runQuickProbe(URL_, options(evidenceDir), {
      launch: async (mode) => {
        tried.push(mode);
        if (mode === RendererMode.Gpu) throw new Error("no GPU");
        return fake.browser;
      },
      sleep: fake.sleep,
      lockPath,
    });
    assert.deepEqual(tried, [RendererMode.Gpu, RendererMode.Software]);
    assert.equal(result.rendererMode, RendererMode.Software);
  });
});

describe("probeBoot", () => {
  it("answers the boot question alone, under the lock, with frames only when asked for", async () => {
    const { evidenceDir, lockPath } = await setup();
    const fake = fakePage({ drawsAtMs: 3_000, startControl: "PLAY", responds: true });
    const result = await probeBoot(
      URL_,
      { firstDrawTimeoutMs: 20_000, rendererMode: RendererMode.Gpu, evidenceDir },
      { launch: async () => fake.browser, sleep: fake.sleep, lockPath },
    );
    assert.equal(result.booted, CheckResult.Pass);
    assert.equal(result.firstRenderMs, 3_000);
    assert.equal(result.uncaughtBeforeFirstDraw, false);
    assert.equal(result.degenerateCanvas, false);
    assert.equal(result.frames.length, 1);
    assert.equal(result.frames[0].phase, ProbePhase.Boot);
    assert.equal(fs.existsSync(lockPath), false);
  });

  it("a canvas that stays flat past a short scan timeout is a failed boot with a degenerate canvas", async () => {
    const { lockPath } = await setup();
    const fake = fakePage({ drawsAtMs: null, startControl: null, responds: true });
    const result = await probeBoot(
      URL_,
      { firstDrawTimeoutMs: 2_000, rendererMode: RendererMode.Software },
      { launch: async () => fake.browser, sleep: fake.sleep, lockPath },
    );
    assert.equal(result.booted, CheckResult.Fail);
    assert.equal(result.degenerateCanvas, true);
    assert.equal(result.firstRenderMs, null);
    assert.deepEqual(result.frames, []);
  });
});
