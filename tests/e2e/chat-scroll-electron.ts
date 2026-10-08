/**
 * Flings the long chat (`tests/fixtures/chat-scroll.tsx`) with real scroll input and records what
 * was painted: every compositor frame (screencast) checked for a blank block, every main-thread
 * frame for viewport the transcript left uncovered, the main thread's cost, then a CPU profile
 * and a Chromium trace of one fling. Disposable profile; no engine, account or network.
 */
import { app, BrowserWindow, contentTracing, nativeImage, type WebContents, WebContentsView } from "electron";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { blankRunPx, bundleModules, type Band, type CpuProfile, summarizeProfile } from "./chat-scroll-frames.ts";

const PAGE = process.env.STUDIO_CHAT_SCROLL_PAGE ?? "";
const BUNDLE = process.env.STUDIO_CHAT_SCROLL_BUNDLE ?? "";
const EVIDENCE = process.env.STUDIO_CHAT_SCROLL_EVIDENCE ?? "";
/** The heavy stand-in project (`tests/fixtures/gpu-load.html`) and its draw calls per frame. */
const PROJECT = process.env.STUDIO_CHAT_SCROLL_PROJECT ?? "";
/**
 * The stand-in project's load: its draw calls a frame keep the GPU process busy (the stadium project kept
 * its main thread 85% busy) and its fill pass keeps the GPU itself saturated, as a heavy scene does.
 */
const PROJECT_LOAD = process.env.STUDIO_CHAT_SCROLL_PROJECT_LOAD ?? "draws=20000&fill=800";
/** The chat column (the page keeps to it) and, beside it, Live's slot, as in a laptop-sized Genex window (CSS px). */
const CHAT = { width: 640, height: 980 };
const LIVE = { x: CHAT.width, y: 0, width: 900, height: CHAT.height };
const WINDOW = { width: CHAT.width + LIVE.width, height: CHAT.height };
/** Time for the project to warm up before the chat is flung beside it. */
const PROJECT_WARMUP_MS = 1500;
/** Fling speeds, px/s: a brisk scroll and a hard trackpad flick. */
const SPEEDS = [3000, 6000, 10_000] as const;
/** The fast flings the gate counts beside a project, px/s. */
const FAST_SPEEDS: readonly number[] = [6000, 10_000];
/**
 * Beside the GPU-heavy stand-in project, at most this many frames of the fast flings may show a blank
 * block. Three runs each on an M2 Max: rows mounted just in time showed 36–48, rows mounted
 * screens ahead 3–12 (none at 6,000 px/s). Without a project no frame may.
 */
const BLANK_FRAMES_BESIDE_PROJECT = 20;
/** How far one long fling travels, px: about a dozen screens. */
const FLING_PX = 12_000;
/** One leg of the back-and-forth scroll, px, and how many times it turns. */
const SHUTTLE_PX = 2_400;
const SHUTTLE_TURNS = 4;
/** An empty stretch this tall (CSS px) is a blank block: no gap in a chat's own layout comes close. */
const BLANK_BLOCK_PX = 160;
/** Time for the last frames to land after the input ends. */
const TAIL_MS = 400;
/** One image pixel per CSS pixel is plenty to find an empty stretch, and keeps each frame small. */
const SCREENCAST = {
  format: "jpeg",
  quality: 60,
  everyNthFrame: 1,
  maxWidth: WINDOW.width,
  maxHeight: WINDOW.height,
} as const;
const TRACE_CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "blink.user_timing",
  "v8.execute",
  "cc",
  "viz",
  "latencyInfo",
];

interface PageFrame {
  at: number;
  scrollTop: number;
  uncovered: number;
  mounted: number;
}
interface Shot {
  timestamp: number;
  data: string;
  deviceWidth: number;
}
interface SceneResult {
  name: string;
  speed: number;
  /** The GPU process's CPU while the scene ran (%), and the project's frames per second beside it. */
  gpuPercent: number;
  projectFps: number | null;
  frames: number;
  painted: number;
  blankFrames: number;
  maxBlankPx: number;
  uncoveredFrames: number;
  maxUncoveredPx: number;
  longTasks: number;
  longTaskMs: number;
  maxFrameGapMs: number;
  mountedMax: number;
  /** How far the scroll position moved in all, and how many times it turned back (each fling turns once). */
  travelPx: number;
  reversals: number;
  maxStepPx: number;
  cost: Record<string, number>;
}

/** The scroll position's path over the page frames: total travel, turns back and the largest one-frame step. */
function travel(frames: PageFrame[]): { travelPx: number; reversals: number; maxStepPx: number } {
  const steps = frames.slice(1).map((frame, i) => frame.scrollTop - (frames[i]?.scrollTop ?? frame.scrollTop));
  let reversals = 0;
  let heading = 0;
  for (const step of steps) {
    if (!step) continue;
    if (heading && Math.sign(step) !== heading) reversals++;
    heading = Math.sign(step);
  }
  return {
    travelPx: steps.reduce((sum, step) => sum + Math.abs(step), 0),
    reversals,
    maxStepPx: Math.max(0, ...steps.map(Math.abs)),
  };
}

const failures: { name: string; detail: unknown }[] = [];
const errors: string[] = [];
const fail = (name: string, detail: unknown) => failures.push({ name, detail });

app.setPath("userData", mkdtempSync(path.join(os.tmpdir(), "genex-chat-scroll-")));

async function page<T>(wc: WebContents, call: string): Promise<T> {
  return (await wc.executeJavaScript(call)) as T;
}

/** Main-thread time spent between two readings of Chromium's counters, in ms. */
async function counters(wc: WebContents): Promise<Record<string, number>> {
  const { metrics } = (await wc.debugger.sendCommand("Performance.getMetrics")) as {
    metrics: { name: string; value: number }[];
  };
  return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
}
function spent(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const ms = ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"].map((key) => [
    key,
    Math.round(((after[key] ?? 0) - (before[key] ?? 0)) * 1000),
  ]);
  const counts = ["LayoutCount", "RecalcStyleCount"].map((key) => [key, (after[key] ?? 0) - (before[key] ?? 0)]);
  return Object.fromEntries([...ms, ...counts]);
}

/** Real scroll input over the conversation: positive `dy` scrolls toward the top. */
async function fling(wc: WebContents, at: { x: number; y: number }, dy: number, speed: number): Promise<void> {
  await wc.debugger.sendCommand("Input.synthesizeScrollGesture", {
    x: at.x,
    y: at.y,
    yDistance: dy,
    speed,
    gestureSourceType: "mouse",
    preventFling: true,
  });
}

/** Record the painted frames and the page's own frames while `act` runs. */
/** The GPU process's CPU since the last reading, in % of one core (Electron spreads it over every core). */
function gpuPercent(): number {
  const gpu = app.getAppMetrics().find((metric) => metric.type === "GPU");
  return Math.round((gpu?.cpu.percentCPUUsage ?? 0) * os.cpus().length);
}

/** The stand-in project's frame count, or null when no project runs beside the chat. */
async function projectFrames(project: WebContents | null): Promise<number | null> {
  return project ? ((await project.executeJavaScript("window.gpuLoad.frames")) as number) : null;
}

async function recorded(
  wc: WebContents,
  project: WebContents | null,
  name: string,
  speed: number,
  act: (box: { x: number; y: number }) => Promise<void>,
): Promise<SceneResult> {
  const box = await page<Band & { x: number; y: number }>(wc, "window.scrollerBox()");
  const shots: Shot[] = [];
  const onMessage = (_event: unknown, method: string, params: Record<string, unknown>) => {
    if (method !== "Page.screencastFrame") return;
    const metadata = params.metadata as { timestamp: number; deviceWidth: number };
    shots.push({ timestamp: metadata.timestamp, data: String(params.data), deviceWidth: metadata.deviceWidth });
    void wc.debugger.sendCommand("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
  };
  wc.debugger.on("message", onMessage);
  await wc.debugger.sendCommand("Page.startScreencast", SCREENCAST);
  await page(wc, "window.startSampling()");
  const before = await counters(wc);
  gpuPercent();
  const projectBefore = await projectFrames(project);
  const started = Date.now();
  await act(box);
  await sleep(TAIL_MS);
  const projectAfter = await projectFrames(project);
  const projectFps =
    projectBefore === null || projectAfter === null
      ? null
      : Math.round(((projectAfter - projectBefore) * 1000) / (Date.now() - started));
  const gpu = gpuPercent();
  const cost = spent(before, await counters(wc));
  const { frames, longTasks } = await page<{ frames: PageFrame[]; longTasks: number[] }>(wc, "window.stopSampling()");
  await wc.debugger.sendCommand("Page.stopScreencast");
  wc.debugger.removeListener("message", onMessage);
  const blanks = shots.map((shot) => {
    const image = nativeImage.createFromBuffer(Buffer.from(shot.data, "base64"));
    const { width, height } = image.getSize();
    return {
      shot,
      image,
      px: blankRunPx({ width, height, scale: width / shot.deviceWidth, pixels: image.toBitmap() }, box),
    };
  });
  const worst = blanks.reduce((a, b) => (b.px > a.px ? b : a), blanks[0] ?? { px: 0, image: null, shot: null });
  if (worst.image && worst.px >= BLANK_BLOCK_PX)
    writeFileSync(path.join(EVIDENCE, `${name.replaceAll(" ", "-")}-${speed}-worst.jpg`), worst.image.toJPEG(80));
  const gaps = frames.slice(1).map((frame, i) => frame.at - (frames[i]?.at ?? frame.at));
  const result: SceneResult = {
    name,
    speed,
    gpuPercent: gpu,
    projectFps,
    frames: frames.length,
    painted: shots.length,
    blankFrames: blanks.filter((blank) => blank.px >= BLANK_BLOCK_PX).length,
    maxBlankPx: worst.px,
    uncoveredFrames: frames.filter((frame) => frame.uncovered >= BLANK_BLOCK_PX).length,
    maxUncoveredPx: Math.max(0, ...frames.map((frame) => frame.uncovered)),
    longTasks: longTasks.length,
    longTaskMs: longTasks.reduce((sum, ms) => sum + ms, 0),
    maxFrameGapMs: Math.max(0, ...gaps),
    mountedMax: Math.max(0, ...frames.map((frame) => frame.mounted)),
    ...travel(frames),
    cost,
  };
  describe(result);
  writeFileSync(
    path.join(EVIDENCE, `${name.replaceAll(" ", "-")}-${speed}-frames.json`),
    JSON.stringify({ frames, painted: blanks.map((blank) => ({ at: blank.shot.timestamp, blankPx: blank.px })) }),
  );
  return result;
}

/** No blank block without a project; beside one, no more than `BLANK_FRAMES_BESIDE_PROJECT` over the fast flings. */
function gate(results: SceneResult[]): void {
  for (const result of results.filter((scene) => scene.projectFps === null)) {
    if (result.blankFrames) fail(`${result.name} @ ${result.speed}: a blank block was painted`, result.maxBlankPx);
    if (result.uncoveredFrames)
      fail(`${result.name} @ ${result.speed}: rows left the viewport uncovered`, result.maxUncoveredPx);
  }
  const fast = results.filter((scene) => scene.projectFps !== null && FAST_SPEEDS.includes(scene.speed));
  const blank = fast.reduce((sum, scene) => sum + scene.blankFrames + scene.uncoveredFrames, 0);
  if (blank > BLANK_FRAMES_BESIDE_PROJECT)
    fail("fast flings beside a project painted blank blocks", { frames: blank, allowed: BLANK_FRAMES_BESIDE_PROJECT });
}

/** One line per scene, printed as it finishes. */
function describe(result: SceneResult): void {
  console.log(
    `${result.name} @ ${result.speed}px/s: GPU process ${result.gpuPercent}%${result.projectFps === null ? "" : `, project ${result.projectFps} fps`}; ${result.painted} painted, ${result.blankFrames} with a blank block (max ${result.maxBlankPx}px); ` +
      `${result.frames} page frames, ${result.uncoveredFrames} uncovered (max ${result.maxUncoveredPx}px), ${result.mountedMax} rows mounted at most; ` +
      `scrolled ${result.travelPx}px, ${result.reversals} turns back, largest step ${result.maxStepPx}px; ` +
      `${result.longTasks} long tasks (${result.longTaskMs} ms), longest frame gap ${result.maxFrameGapMs} ms; ` +
      `main thread ${result.cost.TaskDuration} ms (script ${result.cost.ScriptDuration}, layout ${result.cost.LayoutDuration}, style ${result.cost.RecalcStyleDuration})`,
  );
}

/** The three ways the reader scrolls: up through history never seen, back down, and to and fro. */
async function scenes(wc: WebContents, project: WebContents | null, speed: number): Promise<SceneResult[]> {
  const beside = project ? " beside a project" : "";
  await page(wc, "window.openChat()");
  const up = await recorded(wc, project, `fresh fling up${beside}`, speed, (box) => fling(wc, box, FLING_PX, speed));
  await page(wc, "window.scrollToEdge('top')");
  const down = await recorded(wc, project, `fling down${beside}`, speed, (box) => fling(wc, box, -FLING_PX, speed));
  await page(wc, "window.openChat()");
  const shuttle = await recorded(wc, project, `back and forth${beside}`, speed, async (box) => {
    for (let turn = 0; turn < SHUTTLE_TURNS; turn++) {
      await fling(wc, box, SHUTTLE_PX, speed);
      await fling(wc, box, -SHUTTLE_PX, speed);
    }
  });
  await page(wc, "window.openChat()");
  await page(wc, "window.startWork()");
  const working = await recorded(wc, project, `while working${beside}`, speed, async (box) => {
    await fling(wc, box, FLING_PX / 2, speed);
    for (let turn = 0; turn < SHUTTLE_TURNS; turn++) {
      await fling(wc, box, -SHUTTLE_PX, speed);
      await fling(wc, box, SHUTTLE_PX, speed);
    }
  });
  await page(wc, "window.stopWork()");
  return [up, down, shuttle, working];
}

/** A CPU profile and a Chromium trace of the hard flick up through a freshly opened chat. */
async function profile(wc: WebContents): Promise<unknown> {
  await page(wc, "window.openChat()");
  const box = await page<{ x: number; y: number }>(wc, "window.scrollerBox()");
  await wc.debugger.sendCommand("Profiler.enable");
  await wc.debugger.sendCommand("Profiler.setSamplingInterval", { interval: 200 });
  await wc.debugger.sendCommand("Profiler.start");
  await fling(wc, box, FLING_PX, SPEEDS[1]);
  await sleep(TAIL_MS);
  const { profile: cpu } = (await wc.debugger.sendCommand("Profiler.stop")) as { profile: CpuProfile };
  writeFileSync(path.join(EVIDENCE, "fling.cpuprofile"), JSON.stringify(cpu));
  await page(wc, "window.openChat()");
  await contentTracing.startRecording({ included_categories: TRACE_CATEGORIES });
  await fling(wc, box, FLING_PX, SPEEDS[1]);
  await sleep(TAIL_MS);
  await contentTracing.stopRecording(path.join(EVIDENCE, "fling.trace.json"));
  const bundle = path.basename(BUNDLE);
  return summarizeProfile(cpu, bundleModules(readFileSync(BUNDLE, "utf8")), bundle);
}

/** The stand-in project in Live's slot beside the chat, warmed up. */
async function startProject(win: BrowserWindow): Promise<WebContents> {
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  win.contentView.addChildView(view);
  view.setBounds(LIVE);
  await view.webContents.loadURL(`file://${PROJECT}?${PROJECT_LOAD}`);
  await sleep(PROJECT_WARMUP_MS);
  return view.webContents;
}

async function main(): Promise<void> {
  await app.whenReady();
  // Shown, but parked off screen: a window that is never shown never draws a frame.
  const win = new BrowserWindow({
    ...WINDOW,
    show: false,
    focusable: false,
    skipTaskbar: true,
    x: -4000,
    y: 0,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  win.showInactive();
  const wc = win.webContents;
  wc.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  const report: Record<string, unknown> = {
    electron: process.versions.electron,
    window: WINDOW,
    chatColumn: CHAT,
    blankBlockPx: BLANK_BLOCK_PX,
    blankFramesBesideProject: BLANK_FRAMES_BESIDE_PROJECT,
    build: process.env.STUDIO_CHAT_SCROLL_BUILD,
  };
  try {
    await wc.loadFile(PAGE);
    await page(wc, "document.fonts.ready.then(() => true)");
    wc.debugger.attach("1.3");
    await wc.debugger.sendCommand("Performance.enable");
    report.chat = await page(wc, "window.openChat()");
    const results: SceneResult[] = [];
    // `STUDIO_CHAT_SCROLL_PASS=project` runs only the pass beside a project (a quicker look while iterating).
    if (process.env.STUDIO_CHAT_SCROLL_PASS !== "project")
      for (const speed of SPEEDS) results.push(...(await scenes(wc, null, speed)));
    const project = await startProject(win);
    for (const speed of SPEEDS) results.push(...(await scenes(wc, project, speed)));
    report.project = { load: PROJECT_LOAD };
    report.scenes = results;
    gate(results);
    report.profile = await profile(wc);
    writeFileSync(path.join(EVIDENCE, "chat.png"), (await wc.capturePage()).toPNG());
  } catch (error) {
    report.failure = error instanceof Error ? error.stack : String(error);
    console.error(error);
  }
  if (errors.length) fail("renderer errors", errors);
  report.failures = failures;
  writeFileSync(path.join(EVIDENCE, "report.json"), JSON.stringify(report, null, 2));
  for (const failure of failures) console.error(`FAIL ${failure.name} ${JSON.stringify(failure.detail).slice(0, 600)}`);
  app.exit(report.failure || failures.length ? 1 : 0);
}

void main();
