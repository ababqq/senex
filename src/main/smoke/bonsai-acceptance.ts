/** Explicit isolated local-model acceptance; never called by ordinary startup. */
import path from "node:path";
import { app } from "electron";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { BonsaiEngine } from "../../substrate/engines/bonsai.ts";
import { BonsaiRuntime } from "../../substrate/bonsai/runtime.ts";
import { BONSAI_RUNTIME, BONSAI_REVISION } from "../../substrate/bonsai/manifest.ts";
import type { StudioCore } from "../studio-core.ts";
import type { ProjectPreview } from "../preview.ts";
import type { DelegateResult } from "../../substrate/engines/types.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { EngineId } from "../../shared/providers.ts";
import { HostMethod } from "../../shared/harness-api.ts";
import { waitFor } from "./wait.ts";
import {
  BONSAI_ACCEPTANCE_GOAL,
  BONSAI_ACCEPTANCE_REQUIREMENTS,
  BONSAI_RECOVERY_PROMPT,
  BONSAI_VISION_PROMPT,
} from "./bonsai-acceptance-prompts.ts";
import { ReasoningEffort } from "../../shared/model-preferences.ts";

/** Why the Bonsai acceptance cannot run. */
const MESSAGE = {
  needsPreview: "the Bonsai acceptance needs a headless preview",
  noDelegate: "the host has no engine.delegate",
} as const;

/** The view the generated project is played and captured in. */
const VIEW = { x: 0, y: 0, width: 960, height: 640 };
/** The local builder gets this long and this many turns. */
const BUILD_TIMEOUT_MS = 16 * MINUTE_MS;
const BUILD_MAX_TURNS = 40;
/** How long the generated project has to boot, and how long a killed runtime has to go. */
const BOOT_TIMEOUT_MS = 15 * SECOND_MS;
const EXIT_TIMEOUT_MS = 5 * SECOND_MS;
/** A frame at least this lit shows content. */
const MIN_LIT_FRACTION = 0.02;

type BaseBrief = (input: {
  run: { engine: string; goal: string };
  plan: { facets: unknown[] };
  projectLabel: string;
}) => string;

/** One acceptance: the engine under test, where its evidence goes, and the checks it records. */
interface Acceptance {
  core: StudioCore;
  engine: BonsaiEngine;
  preview: ProjectPreview;
  model: string;
  out: string;
  report: Record<string, unknown>;
  check(name: string, ok: boolean, detail?: unknown): void;
}

export async function runBonsaiAcceptance(
  core: StudioCore,
  _preview: ProjectPreview,
  root: string,
  model: string,
): Promise<number> {
  const baseBrief = await loadBaseBrief(core);
  const createPreview = core.options.createHeadlessPreview;
  if (!createPreview) throw new Error(MESSAGE.needsPreview);
  const preview = (await createPreview()) as ProjectPreview;
  const out = path.join(root, model.endsWith("ptq1_0") ? "live-ptq" : "live-pq");
  await mkdir(out, { recursive: true });
  const engine = new BonsaiEngine({
    root: path.join(core.layout.engineHomes, EngineId.Bonsai),
    scratchRoot: path.join(core.layout.scratch, EngineId.Bonsai),
    runtime: new BonsaiRuntime(path.join(root, "runtime")),
    protectedPaths: [core.layout.engineHomes, core.layout.secrets, path.join(root, "runtime")],
  });
  core.engines.register(engine);
  const checks: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
  const acceptance: Acceptance = {
    core,
    engine,
    preview,
    model,
    out,
    report: await startReport(core, model, checks),
    check: (name, ok, detail) => {
      checks.push({ name, ok, detail });
      console.log(`Bonsai live ${ok ? "PASS" : "FAIL"}: ${name}`);
    },
  };
  try {
    const project = await buildTheProject(acceptance, baseBrief);
    await playTheProject(acceptance, project);
    await crashAndRecover(acceptance);
  } catch (err) {
    acceptance.check("acceptance completed without error", false, (err as Error).stack);
  } finally {
    await engine.dispose();
    await preview.dispose?.();
    await writeFile(path.join(out, "report.json"), JSON.stringify(acceptance.report, null, 2));
  }
  return checks.some((c) => !c.ok) ? 1 : 0;
}

/**
 * The brief comes from the harness this build ships (as the run smoke loads its evidence
 * helpers), never bundled into main: the seed is the in-app agent's editable code.
 */
async function loadBaseBrief(core: StudioCore): Promise<BaseBrief> {
  const autopilot = path.join(core.options.paths.resources, "harness-seed/loop/autopilot.ts");
  const { baseBrief } = (await import(pathToFileURL(autopilot).href)) as { baseBrief: BaseBrief };
  return baseBrief;
}

async function startReport(core: StudioCore, model: string, checks: unknown[]): Promise<Record<string, unknown>> {
  return {
    build: {
      version: app.getVersion(),
      electron: process.versions.electron,
      packaged: app.isPackaged,
      executable: process.execPath,
      mainSha256: createHash("sha256")
        .update(await readFile(fileURLToPath(import.meta.url)))
        .digest("hex"),
    },
    model,
    runtime: BONSAI_RUNTIME,
    revision: BONSAI_REVISION,
    profile: core.layout.engineHomes,
    checks,
  };
}

/** The local builder writes the project through the same host call a run's builder uses. */
async function buildTheProject(acceptance: Acceptance, baseBrief: BaseBrief) {
  const { core, preview, model, check, report } = acceptance;
  const project = await core.projects.scaffold("bonsai-live-project", { title: "Bonsai local acceptance" });
  const threadId = await core.threadForProject(project.name);
  preview.setBounds(VIEW);
  preview.setVisible(true);
  const api = core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
  const delegate = api[HostMethod.EngineDelegate];
  if (!delegate) throw new Error(MESSAGE.noDelegate);
  const brief = baseBrief({
    run: { engine: EngineId.Bonsai, goal: BONSAI_ACCEPTANCE_GOAL },
    plan: { facets: [] },
    projectLabel: project.name,
  });
  const result = (await delegate({
    engine: EngineId.Bonsai,
    model,
    project: project.name,
    threadId,
    timeoutMs: BUILD_TIMEOUT_MS,
    maxTurns: BUILD_MAX_TURNS,
    selfCapture: { project: project.name, root: project.dir },
    prompt: brief + BONSAI_ACCEPTANCE_REQUIREMENTS,
  })) as DelegateResult;
  report.result = result;
  check("local builder completed", result.ok, result.summary);
  return project;
}

/** Boot the project, press Space, and have the model look at the frame. */
async function playTheProject(acceptance: Acceptance, project: { name: string; dir: string }): Promise<void> {
  const { engine, preview, model, check, report } = acceptance;
  preview.setBounds(VIEW);
  await preview.load(project.name, "index.html", project.dir);
  const ready = await waitFor(() => preview.evaluate("Boolean(window.bonsaiAcceptance)").catch(() => false), {
    timeoutMs: BOOT_TIMEOUT_MS,
    intervalMs: 200,
  });
  check("generated project booted", ready);
  const before = await preview.evaluate("window.bonsaiAcceptance?.score");
  await preview.input([
    { type: "press", combo: "Space" },
    { type: "wait", ms: 200 },
  ]);
  const after = await preview.evaluate("window.bonsaiAcceptance?.score");
  const scored = typeof before === "number" && typeof after === "number" && after > before;
  check("real keyboard input changes project score", scored, { before, after });
  const shot = await preview.screenshotWithStats(85, { surface: "page" });
  await writeFile(path.join(acceptance.out, "project.jpg"), shot.jpeg);
  check("project renders visible content", shot.stats.litFraction > MIN_LIT_FRACTION, shot.stats);
  const vision = await engine.complete({
    model,
    effort: ReasoningEffort.Low,
    maxTokens: 1000,
    messages: [
      {
        role: "user",
        content: BONSAI_VISION_PROMPT,
        images: [{ mimeType: "image/jpeg", data: shot.jpeg.toString("base64") }],
      },
    ],
  });
  report.vision = vision;
  const described = /cube/i.test(vision.message.content) && /space/i.test(vision.message.content);
  check("vision identifies cube and keyboard instruction", described, vision.message.content);
  report.project = project.dir;
}

/** Kill only the native child created by this isolated acceptance engine, then ask again. */
async function crashAndRecover(acceptance: Acceptance): Promise<void> {
  const { engine, model, check } = acceptance;
  const pid = engine.runtime.processId;
  if (!pid) {
    check("native runtime has an owned process", false);
    return;
  }
  process.kill(pid, "SIGKILL");
  await waitFor(() => !isAlive(pid), { timeoutMs: EXIT_TIMEOUT_MS, intervalMs: 50 });
  const recovered = await engine.complete({
    model,
    effort: ReasoningEffort.Low,
    maxTokens: 100,
    messages: [{ role: "user", content: BONSAI_RECOVERY_PROMPT }],
  });
  const restarted = /recovered/i.test(recovered.message.content) && engine.runtime.processId !== pid;
  check("native runtime restarts after a crash", restarted, recovered.message.content);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
