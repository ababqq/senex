/**
 * Attach, don't install (M4.2a): the page the studio composes, and the renderer hook that reads a
 * project's scene, camera and renderer off the frames it actually draws.
 *
 * Everything here is the pure half — the rewrite as strings, the world choice as numbers, the
 * prototype-chain trap over fake classes, the bounded walk over a synthetic graph. The four real
 * pages (an inline page, an import-map page with a composer, a menu → level machine and a bundled
 * page with the two lines) are M4.11's fixtures and are proved there.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import {
  CHARSET_BUDGET,
  HOOK_TAG,
  SHIM_TAG,
  isThreeUrl,
  rewriteProjectHtml,
  shouldRewrite,
  threeHookModule,
  threeHookUrl,
  threeUrlKey,
} from "../../src/main/page-serve.ts";
import {
  OBJECT_CAP,
  chooseWorld,
  countDrawables,
  current,
  endFrame,
  hook,
  hookState,
  inspect,
  reset,
  scenes,
  scoreObservation,
  wrapRenderer,
} from "../../src/page/hook.ts";

const DOC = "project://sweep/index.html";
/** A page with the import map a three.js project writes for itself; the DOM template has none to rewrite. */
const TEMPLATE = `<!doctype html>
<meta charset="utf-8" />
<script type="importmap">
  {
    "imports": {
      "three/webgpu": "/vendor/three.webgpu.js",
      "three/tsl": "/vendor/three.tsl.js",
      "three": "/vendor/three.module.js",
      "three/addons/": "/vendor/three/examples/jsm/",
      "three/": "/vendor/three/"
    }
  }
</script>
<script type="module" src="/src/main.js"></script>`;
const FIXTURES = path.resolve("tests/fixtures/pages");
const page = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

describe("the page the studio composes", () => {
  it("points three and three/webgpu at the studio's wrapper and leaves every other key alone", () => {
    const { html, reach, hooked } = rewriteProjectHtml(TEMPLATE, { documentUrl: DOC });
    assert.equal(reach, "import-map");
    assert.deepEqual(Object.keys(hooked).sort(), ["three", "three/webgpu"]);
    assert.equal(hooked.three, threeHookUrl("project://sweep/vendor/three.module.js", "three"));
    assert.equal(hooked["three/webgpu"], threeHookUrl("project://sweep/vendor/three.webgpu.js", "three/webgpu"));
    // The keys that still resolve to the project's own copies are byte-identical.
    for (const line of [
      '"three/tsl": "/vendor/three.tsl.js"',
      '"three/addons/": "/vendor/three/examples/jsm/"',
      '"three/": "/vendor/three/"',
    ]) {
      assert.ok(html.includes(line), `${line} was rewritten`);
    }
    assert.ok(!html.includes('"three": "/vendor/three.module.js"'), "the three key was not pointed at the wrapper");
  });

  it("keeps the hook after the whole map and before every module script", () => {
    const { html } = rewriteProjectHtml(TEMPLATE, { documentUrl: DOC });
    const map = html.indexOf('<script type="importmap"');
    const mapEnd = html.indexOf("</script>", map);
    const hookAt = html.indexOf(HOOK_TAG);
    const projectModule = html.indexOf('<script type="module"', hookAt + HOOK_TAG.length);
    assert.ok(map >= 0 && hookAt > mapEnd, `hook at ${hookAt}, map ends at ${mapEnd}`);
    assert.ok(projectModule > hookAt, "a module the project wrote must not load before the hook");
    assert.equal(html.indexOf('<script type="module"'), hookAt, "the hook is the first module on the page");
    assert.ok(html.indexOf(SHIM_TAG) < map, "the shim is a classic script and runs first");
  });

  it("is idempotent — the studio's own page comes back unchanged", () => {
    const once = rewriteProjectHtml(TEMPLATE, { documentUrl: DOC });
    const twice = rewriteProjectHtml(once.html, { documentUrl: DOC });
    assert.equal(twice.injected, false);
    assert.equal(twice.html, once.html);
    assert.equal(twice.reach, "none");
  });

  it("inserts the studio's five-key map into a page that has none, charset intact", () => {
    const { html, reach, hooked } = rewriteProjectHtml(page("vite-dist.html"), {
      documentUrl: "project://corridor/index.html",
    });
    assert.equal(reach, "inserted-map");
    assert.deepEqual(Object.keys(hooked).sort(), ["three", "three/webgpu"]);
    const map = JSON.parse(/<script type="importmap" data-studio-map>([\s\S]*?)<\/script>/.exec(html)![1]!);
    assert.deepEqual(Object.keys(map.imports).sort(), [
      "three",
      "three/",
      "three/addons/",
      "three/tsl",
      "three/webgpu",
    ]);
    assert.equal(map.imports["three/addons/"], "/vendor/three/examples/jsm/");
    assert.ok(html.toLowerCase().indexOf("<meta charset") < CHARSET_BUDGET);
    assert.ok(html.indexOf(HOOK_TAG) > html.indexOf("data-studio-map"), "the hook still follows the map");
    // …and nothing is inserted when the caller says not to.
    assert.equal(rewriteProjectHtml(page("vite-dist.html"), { documentUrl: DOC, insertMap: false }).reach, "none");
  });

  it("rewrites a three URL inside an inline module, and never an external file", () => {
    const source = page("inline-url.html");
    const { html, reach, hooked } = rewriteProjectHtml(source, { documentUrl: "project://onefile/index.html" });
    // The URL the page actually imports is the reach; the map inserted beside it answers only
    // for the keys nothing on the page has claimed.
    assert.equal(reach, "inline-url");
    assert.equal(hooked.three, threeHookUrl("https://cdn.example.com/three@0.180.0/build/three.module.js", "three"));
    assert.ok(html.includes(`from "${hooked.three}"`), "the three import was not rewritten");
    // The addon beside it resolves to the project's own copy and is left exactly as written.
    assert.ok(html.includes('from "https://cdn.example.com/three@0.180.0/examples/jsm/controls/OrbitControls.js"'));
    // A string that merely names the file is not an import and keeps its own text.
    assert.ok(html.includes('const label = "three.module.js";'));
    // An external module file is never rewritten: served bytes would differ from the bytes on
    // disk, and a URL import cannot be redirected by a map anyway.
    assert.equal(shouldRewrite("text/javascript", "src/main.js", false, "script", 400), false);
    assert.equal(shouldRewrite(null, "src/main.ts", false, "script", 400), false);
  });

  it("never touches a scope that names three", () => {
    const scoped = [
      "<!doctype html>",
      '<script type="importmap">',
      '{ "imports": { "three": "/vendor/three.module.js" }, "scopes": { "/legacy/": { "three": "/legacy/three.js" } } }',
      "</script>",
      '<script type="module" src="/src/main.js"></script>',
    ].join("\n");
    const { html, hooked } = rewriteProjectHtml(scoped, { documentUrl: DOC });
    assert.ok(html.includes('"scopes": { "/legacy/": { "three": "/legacy/three.js" } }'), "a scope was rewritten");
    assert.deepEqual(Object.keys(hooked), ["three"]);
  });

  it("knows which URLs are three and which are its neighbours", () => {
    assert.equal(threeUrlKey("/vendor/three.module.js"), "three");
    assert.equal(threeUrlKey("./three.min.js"), "three");
    assert.equal(threeUrlKey("https://cdn.example.com/three@0.180.0/build/three.module.js"), "three");
    assert.equal(threeUrlKey("/vendor/three.webgpu.js"), "three/webgpu");
    assert.equal(threeUrlKey("/vendor/three.tsl.js"), null);
    assert.equal(threeUrlKey("/vendor/three/examples/jsm/controls/OrbitControls.js"), null);
    assert.equal(threeUrlKey("three"), null, "a bare specifier is the import map's business");
    assert.equal(isThreeUrl("/vendor/three.module.js"), true);
  });

  it("generates a wrapper that re-exports the real module, and refuses anything but a URL", () => {
    const body = threeHookModule("project://sweep/vendor/three.module.js", "three")!;
    assert.match(body, /^import \* as __t from "project:\/\/sweep\/vendor\/three\.module\.js";$/m);
    assert.match(body, /^export \* from "project:\/\/sweep\/vendor\/three\.module\.js";$/m);
    assert.match(body, /^import \{ hook \} from "\/vendor\/studio\/hook\.js";$/m);
    assert.match(body, /^hook\(__t, "three", "project:\/\/sweep\/vendor\/three\.module\.js"\);$/m);
    assert.equal(threeHookModule("/vendor/three.module.js", "three"), null, "a relative real is a 400");
    assert.equal(threeHookModule("", "three"), null);
    assert.equal(threeHookModule("javascript:alert(1)", "three"), null);
  });
});

// ── which render call was the world ──────────────────────────────────────────

/** A described observation, with the fields the score reads and sensible defaults. */
function obs(over: Record<string, unknown> = {}) {
  return {
    depth: 0,
    method: "render",
    quadRoot: false,
    cameraKind: "perspective",
    unitFrustum: false,
    drawables: 12,
    toTarget: false,
    targetSize: null,
    viewport: { width: 1280, height: 720 },
    ...over,
  };
}

describe("which render call was the world", () => {
  const quadPass = obs({
    cameraKind: "orthographic",
    unitFrustum: true,
    drawables: 1,
    toTarget: true,
    targetSize: { width: 1280, height: 720 },
  });

  it("prefers a RenderPass into a target over the composer's full-screen quads", () => {
    const renderPass = obs({ drawables: 40, toTarget: true, targetSize: { width: 1280, height: 720 } });
    assert.equal(chooseWorld([quadPass, renderPass, quadPass, quadPass]), 1);
    assert.equal(scoreObservation(quadPass), -1);
  });

  it("scores a bare QuadMesh root, a cube face and a nested render at -1", () => {
    assert.equal(scoreObservation(obs({ quadRoot: true })), -1);
    assert.equal(scoreObservation(obs({ cameraKind: "cube" })), -1);
    assert.equal(scoreObservation(obs({ depth: 1 })), -1);
    assert.equal(scoreObservation(obs({ drawables: 0 })), -1);
    assert.equal(chooseWorld([obs({ cameraKind: "cube", drawables: 90 }), obs({ drawables: 6 })]), 1);
  });

  it("prefers the large perspective world to a small orthographic minimap", () => {
    const minimap = obs({
      cameraKind: "orthographic",
      drawables: 12,
      toTarget: true,
      targetSize: { width: 256, height: 256 },
    });
    const world = obs({ drawables: 12 });
    assert.ok(scoreObservation(world) > scoreObservation(minimap));
    assert.equal(chooseWorld([world, minimap]), 0);
  });

  it("chooses nothing out of an empty frame", () => {
    assert.equal(chooseWorld([]), -1);
    assert.equal(chooseWorld([quadPass]), -1);
  });
});

// ── the hook over fake three-shaped classes ──────────────────────────────────

interface FakeObject3D {
  isMesh?: boolean;
  isScene?: boolean;
  children: FakeObject3D[];
  userData?: Record<string, unknown>;
}

const scene = (drawables: number, extra: Record<string, unknown> = {}): FakeObject3D => ({
  isScene: true,
  children: Array.from({ length: drawables }, () => ({ isMesh: true, children: [], userData: {} })),
  ...extra,
});
const perspective = { isPerspectiveCamera: true, type: "PerspectiveCamera" };
const canvas = { width: 1280, height: 720 };

describe("the renderer hook", () => {
  beforeEach(() => reset());

  it("wraps the base class's render for the WebGPU shape and still calls it", () => {
    const drew: unknown[] = [];
    class Renderer {
      render(target: unknown, camera: unknown) {
        drew.push([target, camera]);
        return "drawn";
      }
    }
    class WebGPURenderer extends Renderer {}
    hook({ WebGPURenderer }, "three/webgpu", "project://x/vendor/three.webgpu.js");

    // The wrapper is the subclass's own property; the shared base is left as it was.
    assert.ok(
      Object.getOwnPropertyDescriptor(WebGPURenderer.prototype, "render"),
      "the exported class carries the wrapper",
    );
    assert.equal((Renderer.prototype.render as { __studioHooked?: boolean }).__studioHooked, undefined);

    const renderer = new WebGPURenderer() as WebGPURenderer & { domElement: unknown };
    renderer.domElement = canvas;
    const world = scene(9);
    assert.equal(renderer.render(world, perspective), "drawn", "the project's own render must still run");
    endFrame();
    assert.equal(current()?.scene, world);
    assert.equal(current()?.renderer, renderer);
    assert.equal(hookState().renders, 1);
    assert.deepEqual(hookState().three[0]?.wrapped, ["WebGPURenderer"]);
  });

  it("traps the constructor's assignment for the WebGL r185 shape", () => {
    const drew: unknown[] = [];
    class WebGLRenderer {
      declare render: (scene: unknown, camera: unknown) => void;
      declare domElement: unknown;
      constructor() {
        this.domElement = canvas;
        this.render = (world: unknown) => void drew.push(world);
      }
    }
    hook({ WebGLRenderer }, "three", "project://x/vendor/three.module.js");
    const descriptor = Object.getOwnPropertyDescriptor(WebGLRenderer.prototype, "render");
    assert.equal(typeof descriptor?.get, "function", "the trap is an accessor on the prototype");

    const renderer = new WebGLRenderer();
    const world = scene(4);
    renderer.render(world, perspective);
    assert.deepEqual(drew, [world], "the constructor's own function still runs");
    endFrame();
    assert.equal(current()?.scene, world);
  });

  it("counts a re-entrant renderAsync once, and wraps a class only once", () => {
    class Renderer {
      declare domElement: unknown;
      renderAsync(world: unknown, camera: unknown) {
        return Promise.resolve(this.render(world, camera));
      }
      render(_world: unknown, _camera: unknown) {
        return true;
      }
    }
    const namespace = { WebGPURenderer: Renderer };
    hook(namespace, "three/webgpu", "project://x/vendor/three.webgpu.js");
    hook(namespace, "three/webgpu", "project://x/vendor/three.webgpu.js");
    const renderer = new Renderer();
    renderer.domElement = canvas;
    const world = scene(7);
    void renderer.renderAsync(world, perspective);
    endFrame();
    assert.equal(hookState().renders, 1, "renderAsync re-enters render; that is one frame's world");
    assert.equal(current()?.scene, world);
  });

  it("takes the two-line install from a project whose three is its own", () => {
    const renderer = {
      domElement: canvas,
      render(_world: unknown, _camera: unknown) {},
      setRenderTarget(_target: unknown) {},
    };
    assert.equal(wrapRenderer(renderer), true);
    assert.equal(wrapRenderer(renderer), true, "wrapping twice is not wrapping twice");
    const world = scene(11);
    renderer.render(world, perspective);
    renderer.render(world, perspective);
    endFrame();
    assert.equal(hookState().renders, 1);
    assert.equal(current()?.scene, world);
    assert.equal(hookState().attached, true, "the hook reports what it saw, not what it was told");
  });

  it("flips the world when a menu becomes a level, and keeps the HUD out of scenes()", () => {
    const renderer = { domElement: canvas, render(_w: unknown, _c: unknown) {} };
    wrapRenderer(renderer);
    const menu = scene(3);
    const level = scene(30);
    const hud: FakeObject3D = { isScene: true, children: [{ isMesh: true, children: [] }] };
    const hudCamera = { isOrthographicCamera: true, left: -1, right: 1, top: 1, bottom: -1 };

    renderer.render(menu, perspective);
    renderer.render(hud, hudCamera);
    endFrame();
    assert.equal(current()?.scene, menu);

    renderer.render(level, perspective);
    renderer.render(hud, hudCamera);
    endFrame();
    assert.equal(current()?.scene, level, "the level took the frame from the menu");
    assert.deepEqual(scenes(), [level, menu], "both worlds, most recent first, and no HUD");
  });

  it("answers `available: false` with a reason instead of throwing", () => {
    const empty = inspect() as { available: boolean; reason: string; meshes: () => unknown };
    assert.equal(empty.available, false);
    assert.match(String(empty.reason), /no scene has been rendered yet/);
    assert.throws(() => empty.meshes(), /the project's scene graph is not available/);

    const renderer = { domElement: canvas, render(_w: unknown, _c: unknown) {} };
    wrapRenderer(renderer);
    const world = scene(2);
    world.children[0]!.userData = { tag: "roof" };
    renderer.render(world, perspective);
    endFrame();
    const live = inspect();
    assert.equal(live.available, true);
    assert.equal((live as { count: (tag?: string) => number }).count("roof"), 1);
    assert.deepEqual((live as { tags: () => string[] }).tags(), ["roof"]);
  });
});

describe("counting the graph", () => {
  beforeEach(() => reset());

  /** A root of `n` descendants that counts every read of `children`. */
  function bigGraph(n: number) {
    let reads = 0;
    const node = (children: unknown[]) => {
      const self = { isMesh: true };
      Object.defineProperty(self, "children", {
        get() {
          reads++;
          return children;
        },
      });
      return self;
    };
    const leaves = Array.from({ length: n }, () => node([]));
    const root = node(leaves);
    Object.defineProperty(root, "isScene", { value: true });
    return { root, reads: () => reads };
  }

  it("walks a huge graph once and stops at the cap", () => {
    const { root, reads } = bigGraph(10_000);
    const first = countDrawables(root, 0);
    assert.equal(first.objects, OBJECT_CAP);
    assert.equal(first.capped, true);
    const after = reads();
    const again = countDrawables(root, 100);
    assert.deepEqual(again, first);
    assert.equal(reads(), after + 1, "a second call inside the interval reads children once, to compare");
  });

  it("walks again when the interval has passed", () => {
    const { root, reads } = bigGraph(4);
    countDrawables(root, 0);
    const after = reads();
    countDrawables(root, 5_000);
    assert.ok(reads() > after + 1, "an old count is not trusted for ever");
  });

  it("measures a tag's world bounds through each object's matrix, spelled both ways", () => {
    const box = { min: { x: -1, y: 0, z: -2 }, max: { x: 1, y: 3, z: 2 } };
    const lazy: { boundingBox: unknown; computeBoundingBox(): void } = {
      boundingBox: null,
      computeBoundingBox() {
        this.boundingBox = box;
      },
    };
    const translated = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1];
    const moved = { userData: { tag: "tree" }, geometry: lazy, matrixWorld: { elements: translated }, children: [] };
    const plain = { userData: { tag: "tree" }, geometry: { boundingBox: box }, children: [] };
    const bare = { userData: { tag: "rock" }, children: [] };
    const I = inspect({ scene: { children: [moved, plain, bare] } });
    const trees = I.bbox("tree");
    assert.deepEqual({ ...trees.min }, { x: -1, y: 0, z: -2 });
    assert.deepEqual({ ...trees.max }, { x: 11, y: 3, z: 2 });
    assert.deepEqual([trees.size.x, trees.size[1], trees.size.z, trees.size.length], [12, 3, 4, 3]);
    assert.equal(I.bbox("rock"), null, "an object with no geometry has no bounds");
    assert.equal(I.bbox("cloud"), null);
    assert.deepEqual({ ...I.bboxOf(plain).size }, { x: 2, y: 3, z: 4 });
  });
});

// ── the contract, attached ───────────────────────────────────────────────────

describe("the two-line contract", () => {
  it("installs with a renderer and a player, and leaves the clock to the studio", async () => {
    reset();
    const listeners: string[] = [];
    const stub = {
      addEventListener: (type: string) => listeners.push(type),
      requestAnimationFrame: () => 1,
    };
    const doc = {
      addEventListener: () => {},
      querySelector: () => null,
      createElement: () => ({ getContext: () => null, style: {} }),
      body: null,
    };
    const globals = globalThis as unknown as Record<string, unknown>;
    const had = { window: globals.window, document: globals.document };
    globals.window = stub;
    globals.document = doc;
    try {
      const { installStudio } = await import("../../src/project-template/src/studio.js");
      const renderer = { domElement: { width: 800, height: 600 }, render() {}, setRenderTarget() {} };
      const api = installStudio({ renderer, player: () => ({ x: 3, z: -4 }) }) as unknown as Record<string, unknown>;

      // The clock verbs belong to the studio's shim: a project with no update() must not define
      // them, or every step() would advance the page twice.
      for (const verb of ["step", "pause", "start", "seed"]) assert.equal(api[verb], undefined, verb);
      assert.equal(typeof api.state, "function");
      assert.equal(typeof api.inspect, "function");

      // x plus one other axis is a position; the missing axis reads 0, never absent.
      const state = (api.state as () => Record<string, unknown>)();
      assert.deepEqual(state.player, { x: 3, y: 0, z: -4, yaw: 0, pitch: 0 });

      // The renderer reached the hook by name, and inspect() delegates to it.
      const inspected = (api.inspect as () => { available: boolean; reason?: string })();
      assert.equal(inspected.available, false);
      assert.match(String(inspected.reason), /no 3D scene the studio can see/);

      const world = scene(5);
      (renderer.render as (a: unknown, b: unknown) => void)(world, perspective);
      endFrame();
      assert.deepEqual(
        (api.cameras as () => string[])(),
        ["default"],
        "the view the project renders is a camera the studio can name",
      );
      assert.equal(
        ((await (api.debugCamera as (name: string) => Promise<{ ok: boolean }>)("default")) as { ok: boolean }).ok,
        true,
      );
      assert.equal((api.inspect as () => { scene: unknown })().scene, world);
    } finally {
      globals.window = had.window;
      globals.document = had.document;
    }
  });
});
