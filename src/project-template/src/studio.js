/**
 * The studio contract — attachable to any page, optional to install.
 *
 * Projects are built so the critic can *judge* them: deterministic runs, exposed state, named
 * views and fixed-timestep stepping. The harness verifies a project's contract with `probe`
 * checks over `state()` (`state.items.length > 0`), with `play` scripts that click, type and
 * press keys the way a person does, and with `demo` checks that drive a flow the generic
 * script cannot reach. What only the project knows is declared here: what its state means
 * (`probes`), which screens the critic should photograph (`views`), which flows to run (`demos`).
 *
 * NOTHING HERE IS REQUIRED. The studio serves the page itself and attaches to whatever it renders,
 * so a project that calls none of this is still stepped, seeded, photographed and watched: the
 * page reports what people did to it (`state().ui`: clicks, typing, navigations, errors, unnamed
 * controls, overflow) by itself. A project with its own loop needs two lines —
 * `installStudio({ probes })` — and everything else is optional: pass `update` and the studio
 * drives a fixed-step loop for you; leave it out and the studio paces the loop the project
 * already has.
 *
 * There is no import of a rendering library here, on purpose: the contract must be importable by a project with
 * no import map and no rendering library at all. A project that does draw a 3D or canvas world
 * hands its renderer, scene and camera over (or lets the studio's hook read them off the frames)
 * and gets `inspect()` scene checks; a DOM project never needs any of it.
 *
 * The project runs from the moment `installStudio` returns — nobody in the pipeline calls
 * `start()`, so a build that waits for it ships a frozen screen. `pause()` is how a judge
 * freezes the simulation to `step()` it deterministically; `seed()` pauses for the same reason.
 *
 * Keep this file intact. Extend it (new probes, new views) rather than removing anything —
 * every method here is something the harness calls.
 */

/** Deterministic RNG (mulberry32). Same seed ⇒ same run ⇒ comparable screenshots. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mouse buttons arrive in `ctx.keys` under these names — the same set a harness click produces. */
const MOUSE_KEYS = ["Mouse1", "Mouse3", "Mouse2"];
/** The longest a view or a demo may take to settle before the harness photographs it. */
const SETTLE_TURNS = 3;
/** The most elements one `dom.list()` names. */
const DOM_LIST_LIMIT = 40;
/** How much of an element's text an entry in a list carries. */
const DOM_TEXT_CHARS = 60;

/**
 * @param {{
 *   fixedStepMs?: number,
 *   update?: (dtSeconds: number, ctx: {rng: () => number, frame: number, keys: Set<string>, look: {x: number, y: number}, wheel: {x: number, y: number}, pointer: {x: number, y: number, locked: boolean}}) => void,
 *   render?: () => void,
 *   probes?: () => Record<string, unknown>,
 *   views?: Record<string, () => unknown>,
 *   cameras?: Record<string, () => unknown>,
 *   demos?: Record<string, () => unknown>,
 *   reset?: (seed: number) => void,
 *   canvas?: HTMLCanvasElement,
 *   scene?: unknown,
 *   renderer?: unknown,
 *   camera?: unknown,
 *   player?: () => ({x: number, y: number, z?: number, yaw?: number, pitch?: number}),
 *   audio?: () => (AnalyserNode | null),
 *   input?: { pointerLock?: boolean },
 * }} config
 */
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: the contract is one closure. Every verb reads and writes the same loop state (seed, frame, keys, look, the current view), and a project may call any of them at any time; splitting it would change how every shipped project's contract is built. The helpers that need none of that state live below it.
export function installStudio(config) {
  const fixedStepMs = config.fixedStepMs ?? 1000 / 60;
  /** The named screens: `views` is the spelling, `cameras` the one older projects still use. */
  const views = { ...(config.cameras ?? {}), ...(config.views ?? {}) };
  let seed = 1;
  let rng = makeRng(seed);
  let running = true;
  let frame = 0;
  let simulatedMs = 0;
  let accumulator = 0;
  let lastFrameTime = 0;
  let rafHandle = 0;
  const fpsSamples = [];
  const heldKeys = new Set();
  const look = { x: 0, y: 0 };
  const wheel = { x: 0, y: 0 };
  const pointer = { x: 0.5, y: 0.5 };
  /** Render targets the renderer has been pointed at, recorded without the builder's help. */
  const renderTargets = new Set();

  // ── what the studio can see, read at the moment it is used ──
  // A project that draws a 3D world may pass its scene, camera and renderer in; one that passes
  // only a renderer (or nothing at all) is watched by the studio's hook, which reads them off the
  // frames the page actually draws. A DOM project has neither, and every answer below says so.
  const hookNow = () => (typeof globalThis.__studioHook === "object" ? globalThis.__studioHook : null);
  const clockNow = () => (typeof globalThis.__studioClock === "object" ? globalThis.__studioClock : null);
  const worldNow = () => {
    try {
      return hookNow()?.current?.() ?? null;
    } catch {
      return null;
    }
  };
  const sceneNow = () => config.scene ?? worldNow()?.scene ?? null;
  const cameraNow = () => config.camera ?? worldNow()?.camera ?? null;
  const rendererNow = () => config.renderer ?? worldNow()?.renderer ?? null;
  /** The canvas the project draws on, or null for a page that is all DOM. */
  const canvasNow = () => config.canvas ?? rendererNow()?.domElement ?? null;

  if (config.renderer && typeof config.renderer.setRenderTarget === "function" && !config.renderer.__studioWrapped) {
    const original = config.renderer.setRenderTarget.bind(config.renderer);
    config.renderer.setRenderTarget = function (target, ...rest) {
      if (target) renderTargets.add(target);
      return original(target, ...rest);
    };
    config.renderer.__studioWrapped = true;
  }

  // A project whose rendering library is inside its own bundle never passes through the studio's
  // wrapper module, so the renderer is handed to the hook by name instead.
  try {
    if (config.renderer) hookNow()?.wrapRenderer?.(config.renderer);
  } catch {
    /* a hook that refuses a renderer still leaves the project running */
  }

  function rememberKey(code, key, down) {
    const aliases = [code, key];
    if (typeof key === "string" && key.length === 1) {
      aliases.push(key.toLowerCase(), key.toUpperCase());
    }
    for (const alias of aliases) {
      if (!alias) continue;
      if (down) heldKeys.add(alias);
      else heldKeys.delete(alias);
    }
  }

  window.addEventListener("keydown", (event) => rememberKey(event.code, event.key, true));
  window.addEventListener("keyup", (event) => rememberKey(event.code, event.key, false));
  window.addEventListener("blur", () => heldKeys.clear());

  // ── the one input path ──
  // The studio owns live input for a project that passes `update`: mouse movement into the same
  // `look` accumulator the harness's injectInput feeds, mouse buttons as keys, the wheel as
  // `ctx.wheel`. A project reads ctx and nothing else — so the human path and the harness path
  // are the same path, and a check that proves one proves the other. Pointer lock is opt-in
  // (`input: { pointerLock: true }`): a page of forms and lists must keep its cursor.
  const pointerLockWanted = config.input?.pointerLock === true;
  /**
   * Beats of mouse input the harness has already handed us through `injectInput`.
   *
   * One look reaches a page by up to three roads: this contract's `injectInput`, a synthetic
   * move the studio dispatches so a project with its own listener still turns, and — in a window
   * that hears native input — the browser's own trusted move. All three feed ONE accumulator
   * here. The count is set when the studio injects and spent by the moves of that same beat.
   */
  let injectedLook = 0;
  let injectedWheel = 0;
  const locked = () => {
    const canvas = canvasNow();
    return Boolean(canvas) && document.pointerLockElement === canvas;
  };
  window.addEventListener("mousedown", (event) => {
    const canvas = canvasNow();
    if (pointerLockWanted && canvas && event.target === canvas && !locked()) {
      try {
        const request = canvas.requestPointerLock?.();
        if (request && typeof request.catch === "function") request.catch(() => {});
      } catch {
        /* pointer lock is a convenience; keys and buttons work without it */
      }
    }
    const name = MOUSE_KEYS[event.button] ?? `Mouse${event.button + 1}`;
    rememberKey(name, name, true);
  });
  window.addEventListener("mouseup", (event) => {
    const name = MOUSE_KEYS[event.button] ?? `Mouse${event.button + 1}`;
    rememberKey(name, name, false);
  });
  window.addEventListener("mousemove", (event) => {
    const canvas = canvasNow();
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        pointer.x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
        pointer.y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
      }
    }
    if (!locked()) return;
    // The studio already handed this beat's look to injectInput; this is the same movement
    // arriving by another road, not a second look.
    if (injectedLook > 0) {
      injectedLook -= 1;
      return;
    }
    look.x += event.movementX || 0;
    look.y += event.movementY || 0;
  });
  // Only a locked canvas swallows the wheel; a page that scrolls keeps scrolling (and a passive listener).
  window.addEventListener(
    "wheel",
    (event) => {
      if (locked()) event.preventDefault();
      if (injectedWheel > 0) {
        injectedWheel -= 1;
        return;
      }
      wheel.x += event.deltaX || 0;
      wheel.y += event.deltaY || 0;
    },
    { passive: !pointerLockWanted },
  );
  document.addEventListener("pointerlockchange", () => {
    if (!locked()) for (const name of MOUSE_KEYS) heldKeys.delete(name);
  });

  function consumeLook() {
    const out = { x: look.x, y: look.y };
    look.x = 0;
    look.y = 0;
    return out;
  }
  function consumeWheel() {
    const out = { x: wheel.x, y: wheel.y };
    wheel.x = 0;
    wheel.y = 0;
    return out;
  }

  /** Frames per second for a project whose loop is its own: counted off the studio's clock. */
  let fpsMark = null;
  function clockFps(stats) {
    const at = Date.now();
    if (!fpsMark) {
      fpsMark = { frames: stats.frames, at };
      return 0;
    }
    const elapsed = at - fpsMark.at;
    if (elapsed < 500) return fpsMark.value ?? 0;
    const value = Math.round(((stats.frames - fpsMark.frames) * 1000) / elapsed);
    fpsMark = { frames: stats.frames, at, value };
    return value;
  }

  /** The named screen the last debugCamera() showed; reported by state() so a capture can prove which one it photographed. */
  let currentView = "default";

  /** A project that draws its own frames (or none) has no render function to call: that is fine. */
  function renderAll() {
    if (typeof config.render !== "function") return false;
    config.render();
    return true;
  }

  /**
   * Draw the view the harness just asked for, awaiting an asynchronous renderer. A project that
   * passed `render` draws through it, so a composer's last pass is what lands on the canvas. A
   * project that draws its own frames has no render to call, and the frame the page would draw
   * next belongs to the PROJECT's camera — so the world the hook is watching is rendered once,
   * from the camera the view just placed. That last path skips a composer the project may have,
   * which is the price of photographing a view the project itself never draws.
   *
   * Returns false when there was nothing to draw with, true (or a promise of true) otherwise.
   */
  function renderPlaced() {
    if (typeof config.render === "function") return config.render() ?? true;
    const renderer = rendererNow();
    const scene = sceneNow();
    const camera = cameraNow();
    if (!renderer || typeof renderer.render !== "function" || !scene || !camera) return false;
    try {
      return renderer.render(scene, camera) ?? true;
    } catch {
      return false;
    }
  }

  /**
   * Draw the current view and read the canvas in the same JS turn (a WebGL drawing buffer
   * survives exactly that long), and record what was photographed where the studio reads it.
   */
  async function photographPlaced() {
    const before = drawCallsSoFar();
    const drawn = renderPlaced();
    if (drawn && typeof drawn.then === "function") await drawn;
    else if (drawn === false) return null;
    const canvas = canvasNow();
    const url = canvas ? canvas.toDataURL("image/png") : null;
    const after = drawCallsSoFar();
    // Provenance and the page's own background, both from the studio's own capture. This picture
    // never went through it: a record left over from before the page had drawn anything
    // described a capture that never happened, and a raw canvas read keeps the alpha a
    // transparent frame was drawn with, which encodes as black.
    return throughCaptureShim(url, photographRecord(url, before, after));
  }

  /** Let the page apply what a view or a demo just did: microtasks only, because timers freeze with the clock. */
  async function settle() {
    for (let turn = 0; turn < SETTLE_TURNS; turn++) await Promise.resolve();
    if (canvasNow()) await Promise.resolve(renderPlaced());
  }

  function stepOnce() {
    if (typeof config.update !== "function") return;
    config.update(fixedStepMs / 1000, {
      rng,
      frame,
      keys: heldKeys,
      look: consumeLook(),
      wheel: consumeWheel(),
      pointer: { x: pointer.x, y: pointer.y, locked: locked() },
    });
    frame++;
    simulatedMs += fixedStepMs;
  }

  function loop(now) {
    rafHandle = requestAnimationFrame(loop);
    if (!running) return;
    const delta = lastFrameTime ? now - lastFrameTime : fixedStepMs;
    lastFrameTime = now;
    if (delta > 0) fpsSamples.push(1000 / delta);
    if (fpsSamples.length > 120) fpsSamples.shift();
    // Clamp so a stall (or a debugger pause) cannot spiral into a thousand catch-up steps.
    accumulator += Math.min(delta, 250);
    while (accumulator >= fixedStepMs) {
      stepOnce();
      accumulator -= fixedStepMs;
    }
    renderAll();
  }

  /** Where the player is now (see `playerPosition`); null when `player()` has no answer or throws. */
  function playerNow() {
    try {
      return playerPosition(config.player?.());
    } catch {
      return null;
    }
  }

  /**
   * What `inspect()` answers with: the 3D scene helpers when the page draws a world the studio can
   * see (the hook holds the one implementation, so an attached project and an installed one are
   * inspected by the same code), and always `dom`, the page's own elements. A page that draws no
   * world is still inspectable — `available: true`, `scene: null`, and its scene helpers throw the
   * reason when called. A page that does draw one but has not yet rendered a frame says
   * `available: false`, so a scene check waits instead of failing.
   */
  function inspect() {
    const scene = sceneNow();
    const source = {
      scene,
      roots: [scene].filter(Boolean),
      renderer: rendererNow(),
      camera: cameraNow(),
      state: api.state(),
      player: playerNow(),
      audio: () => api.audio(),
      renderTargets: () => [...renderTargets],
    };
    const hook = hookNow();
    const world = hook && typeof hook.inspect === "function" ? hook.inspect(source) : null;
    if (world?.available) return { ...world, dom: domHelpers() };
    const drawsWorld = Boolean(config.renderer || config.scene || config.camera || config.canvas);
    return { ...domInspect(source), available: !drawsWorld, dom: domHelpers() };
  }

  const api = {
    version: 2,

    /** Reseed, fully reset — and pause. Judging is stepped, never wall-clocked. */
    seed(value) {
      // Seeding is the judge's deterministic entry point; a wall-clock RAF firing between
      // step() calls would make identical seeds diverge. start() resumes live play.
      running = false;
      seed = Number(value) >>> 0;
      rng = makeRng(seed);
      frame = 0;
      simulatedMs = 0;
      accumulator = 0;
      fpsSamples.length = 0;
      heldKeys.clear();
      look.x = 0;
      look.y = 0;
      wheel.x = 0;
      wheel.y = 0;
      config.reset?.(seed);
      renderAll();
      return seed;
    },

    /** Resume live play after seed() or pause(). The project is already running on load. */
    start() {
      running = true;
      lastFrameTime = 0;
      if (!rafHandle) rafHandle = requestAnimationFrame(loop);
      return true;
    },

    /** Freeze the simulation — how a judge holds the project still between step() calls. */
    pause() {
      running = false;
      return true;
    },

    /**
     * Advance the simulation by hand — the judge's scripted run. Independent of wall clock, so a
     * headless comparison run is reproducible.
     */
    step(dtMs = fixedStepMs) {
      const steps = Math.max(1, Math.round(dtMs / fixedStepMs));
      for (let i = 0; i < steps; i++) stepOnce();
      renderAll();
      return { frame, simulatedMs };
    },

    /**
     * JSON-safe snapshot: whatever the project's probes report (items, selection, form values,
     * route…). A project with no `update` has no loop of the studio's to count, so the frame, the
     * simulated time and the rate come from the studio's own clock, which is pacing the project's
     * own loop. The page adds `ui` — what people did to it — on top, by itself.
     */
    state() {
      const clock = typeof config.update === "function" ? null : (clockNow()?.stats?.() ?? null);
      const fps = clock ? clockFps(clock) : averageFps(fpsSamples);
      return {
        version: 2,
        seed,
        frame: clock ? clock.frames : frame,
        simulatedMs: clock ? Math.round(clock.now) : simulatedMs,
        running: clock ? !clock.frozen : running,
        fps,
        held: [...heldKeys],
        pointerLock: locked(),
        camera: currentView,
        error: window.__studio_error ?? null,
        player: playerNow(),
        ...(config.probes ? config.probes() : {}),
      };
    },

    /**
     * Named screens, so judging compares like with like: a route, a tab, a dialog, an empty state, a
     * filled state. Show one, let the page settle, and the harness photographs it. `default` is
     * the screen the project shows on load — the answer for a project that registered no view,
     * which is photographed as it stands rather than voided. (The wire name is `debugCamera`:
     * the contract kept it when it grew past 3D.)
     */
    async debugCamera(name) {
      const show = views[name];
      if (!show) {
        if (name === "default") {
          currentView = "default";
          await settle();
          return { ok: true, camera: "default" };
        }
        return { ok: false, available: api.cameras() };
      }
      await show();
      currentView = name;
      await settle();
      return { ok: true, camera: name };
    },

    /** The names a project registered — or `default`, the screen it shows as it stands. */
    cameras() {
      const declared = Object.keys(views);
      return declared.length ? declared : ["default"];
    },

    /** The studio's own eye cameras are a 3D idea; a page declares its screens as views. */
    eyes() {
      return [];
    },

    /**
     * Photograph the project from inside the page. A canvas project re-renders and reads its
     * canvas in the same JS turn (a WebGL buffer survives exactly that long); a DOM page has no
     * canvas to read, so the studio's own capture (the compositor's picture of the page) answers.
     */
    async capture() {
      // A canvas project that draws through `render`, or that a view has pointed somewhere else,
      // is photographed here: the page-side capture drives one more of the PROJECT's own frames
      // before it reads, and a project that sets its camera inside its loop puts its own view
      // straight back over the one the harness placed.
      if (canvasNow() && (typeof config.render === "function" || currentView !== "default")) {
        const placed = await photographPlaced();
        if (placed) return placed;
      }
      const shot = globalThis.__studioCapture?.capture?.() ?? hookNow()?.capture?.() ?? null;
      return shot && typeof shot.then === "function" ? await shot : shot;
    },

    /**
     * Scripted demonstrations of behaviour the generic run cannot reach (create an item, edit it,
     * delete it and undo; fill the form wrongly and fix it; sign in; drag a card across the
     * board). A demo must be deterministic, leave the project paused on its end state, and return
     * a JSON-able result. The critic runs every demo and photographs its end screen — this is how
     * a workflow becomes visible to the judge.
     */
    demos() {
      return Object.keys(config.demos ?? {});
    },

    async demo(name) {
      const demo = config.demos?.[name];
      if (!demo) return { ok: false, available: Object.keys(config.demos ?? {}) };
      running = false;
      const result = await demo();
      renderAll();
      await settle();
      return { ok: true, demo: name, result: result === undefined ? null : result };
    },

    /**
     * The critic's hands when Chromium events are not enough (paused `step()` runs).
     * `down`/`up` are key names (`KeyW`, `Enter`, `a`); `look` is a mouse delta in pixels.
     */
    injectInput(input) {
      for (const key of input?.down ?? []) rememberKey(key, key, true);
      for (const key of input?.up ?? []) rememberKey(key, key, false);
      if (input?.look) {
        look.x += Number(input.look.dx) || 0;
        look.y += Number(input.look.dy) || 0;
        // The same movement is about to arrive as a synthetic move, and in an attended window
        // as a trusted one too. Two beats, reset on every injection so a stale count can never
        // swallow more than the moves of the beat after it.
        injectedLook = 2;
      }
      if (input?.wheel) {
        wheel.x += Number(input.wheel.dx) || 0;
        wheel.y += Number(input.wheel.dy) || 0;
        injectedWheel = 2;
      }
      return { keys: [...heldKeys], look: { x: look.x, y: look.y }, wheel: { x: wheel.x, y: wheel.y } };
    },

    /** Read-only helpers for the harness's `scene` checks: the page's elements, and a 3D world when it has one. */
    inspect,

    /** A summary a check can read without the graph: counts by tag for a 3D world, element counts for a page. */
    sceneSummary() {
      const I = inspect();
      const page = I.dom.summary();
      if (!I.scene) return { available: false, reason: I.reason, ...page };
      const byTag = {};
      for (const tag of I.tags()) byTag[tag] = I.count(tag);
      return {
        available: true,
        ...page,
        meshes: I.meshes().length,
        untagged: I.untagged(),
        byTag,
        lights: I.lights().map((l) => l.type),
        renderTargets: I.renderTargets().map((rt) => ({ width: rt.width, height: rt.height })),
      };
    },

    /**
     * Audio probe: RMS level and spectral centroid of whatever `config.audio()` analyses.
     * Enough for "the alert tone exists" or "playback is silent when muted" as a check.
     */
    audio() {
      let analyser = null;
      try {
        analyser = config.audio?.() ?? null;
      } catch {
        analyser = null;
      }
      if (!analyser || typeof analyser.getFloatTimeDomainData !== "function")
        return { available: false, rms: 0, centroid: 0 };
      const time = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(time);
      let sum = 0;
      for (let i = 0; i < time.length; i++) sum += time[i] * time[i];
      const rms = Math.sqrt(sum / Math.max(1, time.length));
      const freq = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(freq);
      let weighted = 0;
      let total = 0;
      const nyquist = (analyser.context?.sampleRate ?? 44100) / 2;
      for (let i = 0; i < freq.length; i++) {
        weighted += (i / freq.length) * nyquist * freq[i];
        total += freq[i];
      }
      return { available: true, rms: Number(rms.toFixed(4)), centroid: total > 0 ? Math.round(weighted / total) : 0 };
    },
  };

  // The clock verbs belong to whoever owns the loop. A project that passed `update` is stepped by
  // this file; a project that did not is stepped by the studio's own shim, which paces the loop the
  // project already has — and defining them here as well would advance every step() twice.
  if (typeof config.update !== "function") {
    delete api.step;
    delete api.pause;
    delete api.start;
    if (typeof config.reset !== "function") delete api.seed;
  }

  window.__studio = api;
  config.reset?.(seed);
  renderAll();
  if (typeof config.update === "function") rafHandle = requestAnimationFrame(loop);
  return api;
}

/** The draw calls the page has made so far, as the studio's hook counts them; null without one. */
const drawCallsSoFar = () => globalThis.__studioDraw?.totals?.()?.drawCalls ?? null;

/** How a picture the project's own capture took came about: why there is none, and what it cost to draw. */
function photographRecord(url, before, after) {
  return {
    reason: url ? null : "the project's own capture produced no image",
    drawCalls: before !== null && after !== null ? after - before : null,
    ladder: ["render"],
  };
}

/**
 * Hand a picture to the studio's capture shim, which paints the page's own background under it;
 * an older shim can only take note of it. Without a shim, or when it paints nothing, the picture
 * is returned as it was taken.
 */
async function throughCaptureShim(url, record) {
  const shim = globalThis.__studioCapture;
  if (shim && typeof shim.paint === "function") {
    const painted = await Promise.resolve(shim.paint(url, record)).catch(() => null);
    return painted || url;
  }
  try {
    shim?.note?.({ ...record, composited: false });
  } catch {
    /* an older shim has no note to take */
  }
  return url;
}

/** The average of the frame rates the loop sampled; 0 before it sampled any. */
function averageFps(samples) {
  if (!samples.length) return 0;
  return Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
}

/**
 * Where the player is. `x` plus at least one of `y`/`z` is a position: a side-scroller locates
 * its player in x/y and a top-down project in x/z. The missing axis is reported as 0, never
 * absent, so a check reads a number either way. A page with no player reports null.
 */
function playerPosition(p) {
  if (!p || typeof p.x !== "number") return null;
  const y = typeof p.y === "number" ? p.y : null;
  const z = typeof p.z === "number" ? p.z : null;
  if (y === null && z === null) return null;
  return {
    x: p.x,
    y: y ?? 0,
    z: z ?? 0,
    yaw: typeof p.yaw === "number" ? p.yaw : 0,
    pitch: typeof p.pitch === "number" ? p.pitch : 0,
  };
}

const DOM_SKIPPED = new Set(["SCRIPT", "STYLE", "LINK", "META", "TEMPLATE", "TITLE", "HEAD", "HTML"]);

/** Is the element on screen: displayed, not transparent, with a box? */
function isShown(el) {
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && el.getClientRects().length > 0;
}

/** `tag#id.class.names`, the way the failing check names an element. */
function elementName(el) {
  const id = el.id ? `#${el.id}` : "";
  const classes =
    el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
  return `${el.tagName.toLowerCase()}${id}${classes}`;
}

/** The text a person reads in an element: what it shows, trimmed and collapsed. */
function shownText(el) {
  return (el.innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** One element as a list names it: its selector-ish name and its first words. */
function describeElement(el) {
  const text = shownText(el).slice(0, DOM_TEXT_CHARS);
  return text ? `${elementName(el)} "${text}"` : elementName(el);
}

/**
 * Read-only queries over the page's own elements, for checks that ask what a person would see:
 * `dom.count("li.task")`, `dom.text("h1")`, `dom.visible("#dialog")`, `dom.list("button")`.
 * Hidden elements do not count: a node that is on the tree but not on the screen is not UI.
 */
function domHelpers() {
  const all = (selector) => [...document.querySelectorAll(selector)].filter((el) => !DOM_SKIPPED.has(el.tagName));
  const shown = (selector) => all(selector).filter(isShown);
  return {
    count: (selector) => shown(selector).length,
    visible: (selector) => shown(selector).length > 0,
    text: (selector) => shown(selector).map(shownText),
    first: (selector) => {
      const el = shown(selector)[0];
      return el ? shownText(el) : "";
    },
    value: (selector) => {
      const el = document.querySelector(selector);
      return el && "value" in el ? el.value : null;
    },
    /** True when the page shows no text and no visual element: a scaffold nobody has built on. */
    empty: () =>
      !document.body ||
      (shownText(document.body) === "" &&
        shown("img, svg, canvas, video, picture, iframe, input, select, textarea, button").length === 0),
    list: (selector = "body *") => shown(selector).slice(0, DOM_LIST_LIMIT).map(describeElement),
    summary: () => ({
      title: document.title,
      headings: shown("h1, h2, h3").map(shownText).slice(0, 12),
      buttons: shown("button, [role=button], input[type=submit]").length,
      links: shown("a[href]").length,
      fields: shown("input, select, textarea").length,
      landmarks: shown("main, nav, header, footer, aside, [role=main], [role=navigation]").length,
    }),
  };
}

/** What `inspect()` builds on when there is no 3D world to read: scene helpers that throw the reason the world is missing. */
function domInspect(source) {
  const reason =
    "this page draws no 3D scene the studio can see — use `dom` for its elements, or pass scene/camera/renderer to installStudio for a 3D world";
  const fail = () => {
    throw new Error(`the project's scene graph is not available: ${reason}`);
  };
  return {
    reason,
    scene: null,
    renderer: source.renderer,
    camera: source.camera,
    state: source.state,
    player: source.player,
    objects: fail,
    meshes: fail,
    materials: fail,
    lights: fail,
    tags: fail,
    untagged: fail,
    count: fail,
    bbox: fail,
    bboxOf: fail,
    domUi: () => domHelpers().list("body *"),
    renderTargets: source.renderTargets,
    audio: source.audio,
  };
}
