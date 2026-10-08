/**
 * The scripts the preview runs inside a project's page: probes that report what the page can do
 * and saw (trusted input, the attach report, WebGL errors) and the page-side capture. Each is an
 * expression string for `webContents.executeJavaScript`.
 */

/** Installed once per page: remembers whether any trusted (native) input ever arrived. */
export const TRUSTED_PROBE = `(() => {
  if (window.__studioTrustedProbe) return true;
  window.__studioTrustedProbe = true;
  const mark = (event) => {
    if (!event.isTrusted) return;
    window.__studioTrustedInput = true;
    (window.__studioTrustedTypes = window.__studioTrustedTypes || {})[event.type] = true;
  };
  for (const type of ["keydown", "keyup", "mousedown", "mouseup", "mousemove", "wheel"]) window.addEventListener(type, mark, true);
  return true;
})()`;

/**
 * Is the project attached, and to what? Read off the hook, which knows what it wrapped and what it
 * has seen rendered — never off the project's own claim about itself. `contract` is `installed` when
 * a project assigned `window.__studio` (the facade keeps the object as `__project`), `attached` when
 * the studio recognised a world in the frames the page drew, and `none` when neither is true.
 */
export const ATTACH_PROBE = `(() => {
  const hook = window.__studioHook || null;
  const facade = window.__studio || null;
  const project = facade && facade.__project ? facade.__project : null;
  const call = (fn) => { try { const v = fn(); return v === undefined ? null : v; } catch { return null; } };
  const world = hook && typeof hook.current === "function" ? call(() => hook.current()) : null;
  const s = hook && typeof hook.state === "function" ? call(() => hook.state()) : null;
  const name = (v) => { try { return v && v.constructor && v.constructor.name ? v.constructor.name : (v ? typeof v : null); } catch { return null; } };
  return {
    contract: project ? "installed" : world ? "attached" : "none",
    shim: Boolean(window.__studioClock),
    hook: Boolean(hook),
    renderer: name(world && world.renderer),
    scene: name(world && world.scene),
    camera: name(world && world.camera),
    cameraKind: s ? s.cameraKind : null,
    cameras: call(() => facade.cameras()) || [],
    eyes: call(() => facade.eyes()) || [],
    player: Boolean(call(() => facade.player())),
    renders: s ? s.renders : 0,
    frames: s ? s.frames : 0,
    scenes: s ? s.scenes : 0,
    three: s ? s.three.map((n) => n.key + (n.revision ? " r" + n.revision : "")) : [],
    namespaces: s ? s.three : [],
    reason: s ? s.reason : "the studio hook is not on this page",
  };
})()`;

/**
 * What the page-side capture reported about the frame it took, or declined to take (M4.9a).
 * Every field is optional: the page answers what it knows, and an older page answers nothing.
 */
export interface PageCaptureInfo {
  source?: string;
  reason?: string | null;
  picked?: unknown;
  canvases?: unknown[];
  background?: string | null;
  composited?: boolean;
  drawCalls?: number | null;
  ladder?: string[];
  backend?: string | null;
  kind?: string | null;
  /** How many pictures the shim's own capture has recorded — how a stale record is spotted. */
  count?: number;
  /** Who took this picture: `shim` read the canvas itself, `project` answered with its own. */
  provenance?: "shim" | "project";
  /** The record describes some earlier picture: the project answered without going through the shim. */
  stale?: boolean;
}

/** The page-side capture never runs longer than this before the compositor takes the frame. */
export const PAGE_CAPTURE_TIMEOUT_MS = 1500;

/**
 * Ask the page for the end of its own frame. `capture()` may be async (a WebGPU project awaits
 * its render), so this awaits it; `captureInfo()` is plain data and comes back beside it, which
 * is how a shot's provenance reaches the stats a check reads.
 */
export const PAGE_CAPTURE = `(async () => {
  var readInfo = function (holder) {
    try { return holder && typeof holder.captureInfo === "function" ? JSON.parse(JSON.stringify(holder.captureInfo())) : null; } catch (err) { return null; }
  };
  try {
    const s = window.__studio;
    if (!s || typeof s.capture !== "function") return null;
    /* Provenance, not the page's word for it. \`capture()\` and \`captureInfo()\` are both members
       the facade delegates to the project, so a build could answer with a pre-baked picture and the
       draw count to go with it, and the record would be indistinguishable from a frame the shim
       read off the canvas. The shim's own capture counts the pictures IT took: if that count did
       not move, this one came from the project and is labelled so. */
    const own = window.__studioCapture;
    const before = readInfo(own);
    const image = await s.capture();
    const after = readInfo(own);
    const info = after || readInfo(s);
    if (info) {
      const fresh = Boolean(after && before && after.count !== before.count);
      const supplied = !fresh || info.source === "project" || (Array.isArray(info.ladder) && info.ladder.indexOf("project") >= 0);
      info.provenance = supplied ? "project" : "shim";
      if (!fresh) info.stale = true;
    }
    return { image: typeof image === "string" ? image : null, info: info };
  } catch (err) {
    return null;
  }
})()`;

/**
 * Wrap WebGL getError + drain each frame. Chromium's GPU process logs
 * `GL_INVALID_OPERATION` where the page console cannot hear them — that is how a
 * real run shipped a broken sampler while every probe looked clean.
 */
export const GL_PROBE = `(() => {
  if (window.__studioGl) return true;
  const seen = [];
  const names = {
    1280: "INVALID_ENUM",
    1281: "INVALID_VALUE",
    1282: "INVALID_OPERATION",
    1285: "OUT_OF_MEMORY",
    1286: "INVALID_FRAMEBUFFER_OPERATION",
    37442: "CONTEXT_LOST_WEBGL",
  };
  const note = (code) => {
    const msg = "GL_" + (names[code] || String(code));
    if (!seen.includes(msg) && seen.length < 16) seen.push(msg);
  };
  const wrap = (proto) => {
    if (!proto || proto.__studioWrapped) return;
    proto.__studioWrapped = true;
    const orig = proto.getError;
    proto.getError = function () {
      const e = orig.call(this);
      if (e && e !== this.NO_ERROR) note(e);
      return e;
    };
  };
  if (window.WebGLRenderingContext) wrap(WebGLRenderingContext.prototype);
  if (window.WebGL2RenderingContext) wrap(WebGL2RenderingContext.prototype);
  // Every WebGL context the page creates from here on, by canvas. The drain reads only these:
  // asking a canvas for "webgl2" CREATES a WebGL context on a canvas that has none yet, and a
  // WebGPU renderer that initialises a moment later then finds getContext("webgpu") null —
  // every frame of a WebGPU project failed that way. Never probe a canvas blind.
  const contexts = new WeakMap();
  const tracked = new Set();
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = origGetContext.call(this, type, attrs);
    if (ctx && (type === "webgl" || type === "webgl2" || type === "experimental-webgl")) {
      if (!contexts.has(this)) {
        contexts.set(this, ctx);
        tracked.add(this);
        this.addEventListener("webglcontextlost", () => {
          if (!seen.includes("GL_CONTEXT_LOST") && seen.length < 16) seen.push("GL_CONTEXT_LOST");
        });
      }
    }
    return ctx;
  };
  const drain = () => {
    for (const canvas of tracked) {
      const gl = contexts.get(canvas);
      if (!gl || typeof gl.getError !== "function" || gl.isContextLost?.()) continue;
      let n = 0;
      let err;
      while ((err = gl.getError()) !== gl.NO_ERROR && n++ < 8) note(err);
    }
  };
  const GL_DRAIN_EVERY_FRAMES = 30;
  let frames = 0;
  const tick = () => {
    if (++frames % GL_DRAIN_EVERY_FRAMES === 0) drain();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__studioGl = { errors: () => { drain(); return seen.slice(); } };
  return true;
})()`;
