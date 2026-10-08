import assert from "node:assert/strict";
import { it } from "node:test";
import { runInNewContext } from "node:vm";
import { installProfileObserver } from "../../src/preview-profiler/observer.ts";
import {
  chooseCapture,
  probePageUi,
  resolveSurface,
  PAGE_UI_PRIMARY_COVERAGE,
  type PageUi,
} from "../../src/substrate/page-ui.ts";
import type { PixelStats } from "../../src/substrate/pixel-stats.ts";
import { PreviewProfiler } from "../../src/substrate/preview-profiler.ts";
function fixture(common: boolean | "fallback" = false, bundle = false, extras: Record<string, unknown> = {}) {
  let time = 0,
    next = 0;
  const callbacks = new Map<number, (n: number) => void>();
  const scene = {
    children: [{ isMesh: true, isInstancedMesh: true, count: 8, material: {}, children: [], isBundleGroup: bundle }],
  };
  const canvas = {
    width: 960,
    height: 600,
    clientWidth: 960,
    clientHeight: 600,
    addEventListener() {},
    removeEventListener() {},
  };
  const info = {
    render: { calls: 0, drawCalls: 0, triangles: 0 },
    autoReset: true,
    reset() {
      this.render.calls = 0;
      this.render.drawCalls = 0;
      this.render.triangles = 0;
    },
  };
  const renderer = {
    isWebGLRenderer: !common,
    ...(common
      ? {
          hasInitialized: () => true,
          backend: common === "fallback" ? { isWebGLBackend: true } : { isWebGPUBackend: true },
        }
      : {}),
    domElement: canvas,
    info,
    render(s: unknown) {
      if (info.autoReset) info.reset();
      info.render.calls += common ? 1 : s === scene ? 8 : 1;
      info.render.drawCalls += s === scene ? 8 : 1;
      info.render.triangles += s === scene ? 96 : 2;
      return "original-return";
    },
  };
  const original = renderer.render;
  const camera = { type: "PerspectiveCamera", fov: 60, near: 0.1, far: 100 };
  const context = {
    performance: { now: () => time },
    document: { visibilityState: "visible" },
    requestAnimationFrame: (f: (n: number) => void) => {
      callbacks.set(++next, f);
      return next;
    },
    cancelAnimationFrame: (id: number) => callbacks.delete(id),
    __studio: {
      inspect: () => ({ scene, renderer, camera }),
      seed() {},
      start() {},
      pause() {},
      step() {},
      state() {
        return { fps: 123 };
      },
    },
    ...extras,
  };
  const result = runInNewContext(
    `(${installProfileObserver.toString()})({key:"observer",warmupMs:0,sampleMs:1000})`,
    context,
  );
  const read = () => (context as typeof context & { observer: { read: () => any } }).observer.read();
  const frame = (draw = true) => {
    time += 16;
    if (draw) {
      assert.equal(renderer.render(scene), "original-return");
      renderer.render({});
    }
    const jobs = [...callbacks.values()];
    callbacks.clear();
    jobs.forEach((f) => f(time));
  };
  return { frame, read, renderer, original, info, canvas, result, context, scene, camera };
}
it("observes actual world frames, preserves return/reset behavior, excludes the later HUD render", () => {
  for (const common of [false, true, "fallback"] as const) {
    const f = fixture(common);
    for (let i = 0; i < 65; i++) f.frame();
    const r = f.read();
    assert.equal(r.state, "finished");
    assert.equal(r.sample.metrics.drawCalls.value, 8);
    assert.equal(r.sample.metrics.triangles.value, 96);
    assert.equal(r.sample.metrics.fps.value, 62.5);
    assert.equal(r.sample.backend, common && common !== "fallback" ? "webgpu" : "webgl");
    assert.equal(f.renderer.render, f.original);
    assert.equal(f.info.autoReset, true);
    assert.equal(f.context.__studio.state().fps, 123);
  }
});
it("observer-only RAFs are not FPS, bundles are not free rendering, resize invalidates", () => {
  const paused = fixture();
  for (let i = 0; i < 65; i++) paused.frame(false);
  assert.equal(paused.read().sample.metrics.fps.value, null);
  const bundle = fixture(true, true);
  for (let i = 0; i < 65; i++) bundle.frame();
  assert.equal(bundle.read().sample.metrics.drawCalls.value, null);
  assert.match(bundle.read().sample.metrics.drawCalls.reason, /bundle/);
  const resized = fixture();
  resized.canvas.width = 480;
  assert.equal(resized.read().state, "unavailable");
  assert.equal(resized.renderer.render, resized.original);
});
it("cumulative info without autoReset uses deltas rather than lifetime counters", () => {
  const f = fixture(true);
  f.info.autoReset = false;
  for (let i = 0; i < 65; i++) f.frame();
  assert.equal(f.read().sample.metrics.drawCalls.value, 8);
});
it("host session invalidation never accepts page-supplied version/provenance", async () => {
  const p = new PreviewProfiler(
    async (expression) =>
      expression.includes("import(")
        ? "185"
        : expression.includes("installProfileObserver")
          ? { backend: "webgl" }
          : null,
    async () => "0.185.1",
  );
  const begin = (await p.profile({
    action: "begin",
    runId: "r",
    stageId: "optimization",
    scenarioId: "default",
    handle: "h",
    expectedRevision: { snapshotId: null, commit: "b", tree: "b" },
    warmupMs: 0,
    sampleMs: 1000,
  })) as { sessionId: string };
  assert.ok(begin.sessionId);
  await p.invalidate("screenshot during sample");
  assert.deepEqual(await p.profile({ action: "read", sessionId: begin.sessionId }), {
    state: "unavailable",
    sample: null,
    reason: "screenshot during sample",
  });
  await p.profile({ action: "end", sessionId: begin.sessionId });
  await p.profile({ action: "end", sessionId: begin.sessionId });
});

it("a project that stops rendering midway cannot publish its earlier burst as current FPS", () => {
  const f = fixture();
  for (let i = 0; i < 35; i++) f.frame();
  for (let i = 0; i < 30; i++) f.frame(false);
  assert.equal(f.read().sample.metrics.fps.value, null);
  assert.match(f.read().sample.metrics.fps.reason, /sample window/);
});

// ── M4.9a: pipelines the observer used to refuse ────────────────────────────

it("a HUD render at depth 0 is still excluded once the hook names the world scenes", () => {
  const f = fixture();
  // The hook chooses ONE world per frame (a HUD scene and a composer quad never win), so a
  // second render of something else in the same frame is still not part of the sample.
  (f.context as Record<string, unknown>).__studioHook = { scenes: () => [f.scene] };
  for (let i = 0; i < 65; i++) f.frame();
  const r = f.read();
  assert.equal(r.state, "finished");
  assert.equal(r.sample.metrics.drawCalls.value, 8);
  assert.equal(r.sample.metrics.triangles.value, 96);
  assert.equal(r.sample.configuration.sceneSwitches, 0);
  assert.equal(r.sample.configuration.fov, 60);
});

it("a scene the hook calls a world is measured, and the switch makes the sample incomparable", () => {
  const f = fixture();
  const second = { children: [] };
  const camera = { type: "PerspectiveCamera", fov: 35, near: 0.5, far: 200 };
  (f.context as Record<string, unknown>).__studioHook = { scenes: () => [second, f.scene] };
  for (let i = 0; i < 20; i++) f.frame();
  for (let i = 0; i < 45; i++) {
    (f as unknown as { renderer: { render: (s: unknown, c: unknown) => unknown } }).renderer.render(second, camera);
    f.frame();
  }
  const r = f.read();
  // A switch used to be "inspected renderer/scene/camera replaced" — the whole sample lost.
  assert.equal(r.state, "finished");
  assert.ok(r.sample.configuration.sceneSwitches >= 1);
  // The lens reported is the one the last world frame used, never the arm-time one it left.
  assert.equal(r.sample.configuration.fov, 35);
});

it("a bundle's real workload comes from the draw counters as a warm-window delta", () => {
  let drawn = 0;
  const f = fixture(true, true, {
    __studioDraw: { snapshot: () => ({ drawCalls: 1_000_000 + drawn * 8, triangles: 12_000_000 + drawn * 96 }) },
  });
  for (let i = 0; i < 65; i++) {
    drawn++;
    f.frame();
  }
  const r = f.read();
  assert.equal(r.state, "finished");
  // Lifetime totals over sample frames would report ~16000 calls a frame; the delta reports 8.
  assert.ok(Math.abs(r.sample.metrics.drawCalls.value - 8) < 0.3, String(r.sample.metrics.drawCalls.value));
  assert.ok(Math.abs(r.sample.metrics.triangles.value - 96) < 3, String(r.sample.metrics.triangles.value));
  assert.equal(r.sample.metrics.drawCalls.reason, null);
  assert.match(r.sample.metrics.drawCalls.provenance, /draw counters/);
  // The scope string is invariant: a candidate that introduces a bundle stays comparable.
  assert.match(r.sample.scope, /^world-render-call/);
});

it("a renderer that is still initialising is asked again rather than given up on", async () => {
  let attempts = 0;
  const begin = {
    action: "begin",
    runId: "r",
    stageId: "optimization",
    scenarioId: "default",
    handle: "h",
    expectedRevision: { snapshotId: null, commit: "b", tree: "b" },
    warmupMs: 0,
    sampleMs: 1000,
  } as const;
  const profiler = (answer: (n: number) => unknown) =>
    new PreviewProfiler(
      async (expression) => {
        if (expression.includes("import(")) return "185";
        if (expression.includes("installProfileObserver")) return answer(++attempts);
        return null;
      },
      async () => "0.185.1",
    );

  const patient = profiler((n) =>
    n < 3 ? { error: "renderer is not initialized", retryable: true } : { backend: "webgpu" },
  );
  const started = (await patient.profile(begin)) as { sessionId: string | null };
  assert.ok(started.sessionId);
  assert.equal(attempts, 3);
  await patient.profile({ action: "end", sessionId: started.sessionId! });

  attempts = 0;
  const stubborn = profiler(() => ({ error: "renderer is not initialized", retryable: true }));
  const gaveUp = (await stubborn.profile(begin)) as { sessionId: string | null; reason: string };
  assert.equal(gaveUp.sessionId, null);
  assert.equal(gaveUp.reason, "renderer is not initialized");
  assert.equal(attempts, 9);
});

it("a bundled project with no bare specifier is identified by the canvas stamp, and only its own revision", async () => {
  const stamped = (engine: string | null) =>
    new PreviewProfiler(
      async (expression) => {
        if (expression.includes("installProfileObserver")) return { backend: "webgl" };
        if (!expression.includes("import(")) return null;
        // The page really evaluates the identity probe: there is no module loader in here, so the
        // dynamic import rejects exactly as it does for a project whose three is inside its bundle.
        return await runInNewContext(expression, {
          __studio: {
            inspect: () => ({
              renderer: {
                isWebGLRenderer: true,
                domElement: { getAttribute: (name: string) => (name === "data-engine" ? engine : null) },
              },
            }),
          },
        });
      },
      async () => "0.185.1",
    );
  const begin = {
    action: "begin",
    runId: "r",
    stageId: "optimization",
    scenarioId: "default",
    handle: "h",
    expectedRevision: { snapshotId: null, commit: "b", tree: "b" },
    warmupMs: 0,
    sampleMs: 1000,
  } as const;

  const matching = (await stamped("three.js r185").profile(begin)) as { sessionId: string | null };
  assert.ok(matching.sessionId);
  const other = (await stamped("three.js r184").profile(begin)) as { sessionId: string | null; reason: string };
  assert.deepEqual(
    { sessionId: other.sessionId, reason: other.reason },
    { sessionId: null, reason: "renderer version/module identity unavailable" },
  );
  const none = (await stamped(null).profile(begin)) as { sessionId: string | null };
  assert.equal(none.sessionId, null);
});

// ── M4.5a: which surface a capture photographs ──────────────────────────────

/**
 * The surface ladder, without a window. `chooseCapture` is the whole of `#capture`'s decision:
 * `canvas` and `page` go straight through, and `auto` asks the page what it looks like — but
 * every rung falls toward a picture, because a capture that works today must not begin to fail
 * because a probe rejected or a compositor was asleep.
 */
function litStats(litFraction: number): PixelStats {
  return { width: 8, height: 8, sampled: 64, meanLuma: litFraction * 255, litFraction };
}

const uiOver = (coverage: number, canvases = 1): PageUi => ({
  entries: coverage > 0 ? ["div.menu"] : [],
  coverage,
  canvas: canvases > 0 ? { count: canvases, x: 0, y: 0, width: 800, height: 600 } : null,
  viewport: { width: 800, height: 600 },
  uiPrimary: coverage >= PAGE_UI_PRIMARY_COVERAGE,
});

/** A ladder whose four callbacks are declared per case and whose calls are recorded. */
function ladder(spec: {
  ui?: PageUi | null | (() => Promise<PageUi | null>);
  canvas?: string | Error;
  page?: string | Error;
  lit?: number;
}) {
  const calls: string[] = [];
  const give = (what: string | Error | undefined, name: string) => async () => {
    calls.push(name);
    if (what instanceof Error) throw what;
    return what ?? name;
  };
  return {
    calls,
    deps: {
      pageUi: async () => {
        calls.push("pageUi");
        return typeof spec.ui === "function" ? spec.ui() : (spec.ui ?? null);
      },
      canvas: give(spec.canvas, "canvas-frame"),
      page: give(spec.page, "page-frame"),
      measure: () => {
        calls.push("measure");
        return spec.lit === undefined ? null : litStats(spec.lit);
      },
    },
  };
}

it("an explicit surface is photographed without asking the page anything", async () => {
  const canvasOnly = ladder({ ui: uiOver(1) });
  assert.deepEqual(await chooseCapture("canvas", canvasOnly.deps), {
    shot: "canvas-frame",
    surface: "canvas",
    ui: null,
    stats: null,
  });
  assert.deepEqual(canvasOnly.calls, ["canvas-frame"]);
  const pageOnly = ladder({ ui: uiOver(0) });
  assert.deepEqual(await chooseCapture("page", pageOnly.deps), {
    shot: "page-frame",
    surface: "page",
    ui: null,
    stats: null,
  });
  assert.deepEqual(pageOnly.calls, ["page-frame"]);
  // The legacy flag is the permanent alias of the surface an older seed knew how to ask for.
  assert.equal(resolveSurface({ page: true }), "page");
  assert.equal(resolveSurface({ page: true, surface: "canvas" }), "canvas");
  assert.equal(resolveSurface({}), "canvas");
});

it("an auto capture whose page probe rejects still returns a canvas frame", async () => {
  const rig = ladder({
    ui: () => probePageUi(() => Promise.reject(new Error("frame is navigating"))),
    canvas: "canvas-frame",
    lit: 0.4,
  });
  const chosen = await chooseCapture("auto", rig.deps);
  assert.equal(chosen.shot, "canvas-frame");
  assert.equal(chosen.surface, "canvas");
  assert.equal(chosen.ui, null);
  // The frame it measured comes back with it: nobody counts those pixels twice.
  assert.equal(chosen.stats?.litFraction, 0.4);
  assert.deepEqual(rig.calls, ["pageUi", "canvas-frame", "measure"]);
});

it("a DOM primary page is photographed whole, and falls back to the canvas rather than failing", async () => {
  const dom = ladder({ ui: uiOver(0.6) });
  const chosen = await chooseCapture("auto", dom.deps);
  assert.equal(chosen.shot, "page-frame");
  assert.equal(chosen.surface, "page");
  assert.deepEqual(dom.calls, ["pageUi", "page-frame"]);

  const noCompositor = ladder({ ui: uiOver(0.6), page: new Error("display surface not available") });
  const fell = await chooseCapture("auto", noCompositor.deps);
  assert.equal(fell.shot, "canvas-frame");
  assert.equal(fell.surface, "canvas");
});

it("an auto capture whose canvas frame comes back blank on a page with a canvas flips to the page", async () => {
  const blind = ladder({ ui: uiOver(0), lit: 0 });
  const chosen = await chooseCapture("auto", blind.deps);
  assert.equal(chosen.shot, "page-frame");
  assert.equal(chosen.surface, "page");
  assert.deepEqual(blind.calls, ["pageUi", "canvas-frame", "measure", "page-frame"]);

  // Nothing to gain when the page has no canvas at all, or when the frame is lit.
  const noCanvas = ladder({ ui: uiOver(0, 0), lit: 0 });
  assert.equal((await chooseCapture("auto", noCanvas.deps)).surface, "canvas");
  const lit = ladder({ ui: uiOver(0), lit: 0.3 });
  assert.equal((await chooseCapture("auto", lit.deps)).surface, "canvas");
});

it("no frame at all asks the compositor, and a compositor that also fails returns the canvas frame it had", async () => {
  const both = ladder({
    ui: uiOver(0),
    canvas: new Error("the page never answered"),
    page: new Error("display surface not available"),
  });
  await assert.rejects(chooseCapture("auto", both.deps), /the page never answered/);

  const blankThenNothing = ladder({ ui: uiOver(0), lit: 0, page: new Error("display surface not available") });
  const chosen = await chooseCapture("auto", blankThenNothing.deps);
  assert.equal(chosen.shot, "canvas-frame");
  assert.equal(chosen.stats?.litFraction, 0);
});
