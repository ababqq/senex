# Ion Field

Ion Field is the WebGPU shape, and it is here because WebGPU is not an optional extra: it is
what a Three.js project written today may well be. It imports `three/webgpu`, constructs a
`WebGPURenderer`, and then does the thing that breaks every fixed guess about boot — a
**top-level** `await renderer.init()`, so the page has a canvas and no frame at all until the
adapter answers. Its loop is `renderer.setAnimationLoop` with `renderAsync` inside, not a
hand-rolled `requestAnimationFrame` chain, so the studio can only pace it by owning the clock
three itself schedules on.

Sweep the pale ring over the twenty-four ions with WASD or the arrow keys.

## What it proves

- A slow top-level-await boot is waited for rather than photographed black. The old fixed
  1500 ms guess was both too much for a page that is ready in 200 ms and not enough for this one.
- `renderer.setAnimationLoop` is paced because it rides the patched `requestAnimationFrame`:
  pausing the clock stops this project too, and `step(ms)` advances it by exactly one step.
- The WebGPU backend is recognised everywhere `isWebGLRenderer` used to be the gate — the
  renderer hook, the capture, the checks and the judges.
- Draw calls and GPU errors are reported for a WebGPU page: the counters read
  `GPURenderPassEncoder` and render bundles, not only `WebGLRenderingContext`.
- The capture reads a WebGPU canvas. A canvas whose context is `webgpu` returns nothing from the
  paths written for a `webgl` one.

## Shape

`three-modules`, own, entry `index.html`, main `src/main.js`, no build, no package manager, no
`studio.json`. `kind: "graphics"` with `keyboardMove`. Its ready budget is the longest of the five, because the
adapter request is the slow part and it is the whole point of the fixture.
