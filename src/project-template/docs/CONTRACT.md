# The studio contract — reference tables

`CLAUDE.md` carries the rules; this file carries the tables they point at.

## Projects with their own build

A folder the user brings may run differently — Vite, TypeScript, a bundler — and the studio does
not rewrite it. `studio.json` records that folder's shape, detected on first open and editable:

| Field | Meaning | Template value |
| --- | --- | --- |
| `main` | The project's real entry module — the main owner edits it, other facets wire into it | `src/main.js` |
| `build` | Shell command the studio runs (in the folder, or the facet's copy) before every preview | none |
| `entry` | The page the studio serves; with a build, inside its output. May carry a query the page reads | `index.html` |
| `bootMs` | How long the studio waits for the page to report itself ready before it looks anyway — 1000..60000, default 15000. Raise it for a project with a long data load or a top-level `await`. The studio reads this field and never writes it | none (15000) |
| `project` | This project's kind and traits, declared once a run by the plan — a nested block, not the top-level `kind`, which is the project's SHAPE | none |

Every rule below then reads with `main` in place of `src/main.js`: the contract is installed from
the real entry, facets wire into its FACET WIRING block, and the project's own UI and input stay as
they are. A build that fails is a blank screen for every critic — run it before you finish.

## `window.__studio`

`src/studio.js` installs it; a build that breaks it cannot be judged and is discarded.

The studio ATTACHES as well as installs. It serves the page itself, so its own code is on the
page before any project code runs: it owns `performance.now`, `Date.now` and `requestAnimationFrame`,
it seeds `Math.random`, and it watches what is done to the page. A project that calls none of this
is still stepped, seeded, photographed and observed (`state().ui`). Two consequences for any
project:

- **The studio may pause your own loop and step it.** Keep state in variables the loop updates
  from its delta, never in the wall clock: with the clock frozen, `Date.now()` does not move
  between frames because the studio is what moves it.
- **Assigning `window.__studio` yourself keeps every method you defined** — the studio's object is
  a facade that fills in only what you did not supply, and never writes to yours.

The two lines a project installs: `import { installStudio } from "./studio.js"` and
`installStudio({ probes, views, demos, reset })`. Everything on this page is optional beyond that —
`update` and `render` (a fixed-step simulation, a canvas), `scene`/`renderer`/`camera` (a 3D or canvas
world) — and a project that supplies none of them still answers `cameras()` with `["default"]` and
`capture()` from the page.

| Call | Meaning |
| --- | --- |
| `__studio.seed(n)` | Reseed and reset deterministically — **and pause**, so the judge can step from a known state. Same seed ⇒ same run. Calls your `reset(seed)`. |
| `__studio.start()` / `pause()` | The project runs from the moment it loads — never wait for `start()`. `pause()` freezes it for deterministic judging; `start()` resumes live use. |
| `__studio.step(dtMs)` | Advance by hand, independent of wall clock — used for scripted runs. |
| `__studio.state()` | JSON snapshot: runtime timing, the page's own activity (`ui`, below) and the numbers and short strings your `probes()` return. Nothing is required for a feature the project does not have. |
| `__studio.debugCamera(name)` | Show a named screen (`views`) and let the page settle, so screenshots are comparable. Async. `default` is the page as it loads; declare it too if your views move away from it. (The name is the wire name: the contract kept it when it grew past 3D.) |
| `__studio.cameras()` | The views you declared, or `["default"]`. |
| `__studio.demos()` / `demo(name)` | Scripted workflows (`demos`): each runs deterministically to its end state, which the critic photographs. Async; may return JSON the checks read. |
| `__studio.capture()` | Return the screen as a data URL — the critic's screenshot path. Never remove this method. |
| `__studio.inspect()` | Read-only helpers the `scene` checks run against: `dom` (below), `state`, and for a 3D or canvas world `scene`, `objects(tag)`, `meshes(tag)`, `materials(tag)`, `lights()`, `renderTargets()`, `count(tag)`, `bbox(tag)`, `bboxOf(obj)`, `untagged()`, `audio()`. A page with no 3D world answers with `scene: null`; its scene helpers throw the reason. |
| `state().camera` | The view the last `debugCamera()` showed — how a capture proves which screen it photographed. |
| `__studio.audio()` | RMS + spectral centroid from the `AnalyserNode` you pass as `config.audio`. |

### `probes()` — what the project holds

Return numbers, booleans and short strings, one per thing a person could check: `items`,
`selectedId`, `route`, `form.valid`, `cart.total`. Nested objects are read with dotted paths
(`form.valid`). Report only what exists: a counter for a feature the project does not have is a
lie a check will believe. Keep them cheap and side-effect free; `state()` calls them often.

### `views` and `demos`

`views` is `{ name: () => void | Promise }`: each shows one screen — a route, a tab, a dialog, the
empty state, the error state — and returns when the page has applied it. `demos` is
`{ name: async () => result }`: each performs one workflow with the app's own functions (or its own
events), deterministically, and returns JSON-able data its check reads (`{ items: 1, errorShown: true }`).
Both run with time frozen, so an animation or timer a view depends on must be driven by
`requestAnimationFrame` or `Date.now`, which the studio moves, and not by something it cannot see.

### `state().ui` — what the page reports about its own use

The studio counts these on every page, with or without the contract. The harness-owned checks read
them; a project that reports its own `ui` keeps its keys.

| Key | What it counts |
| --- | --- |
| `clicks`, `keys`, `edits`, `focusMoves` | Pointer clicks, key presses, changes to fields (text, select, checkbox) and focus moves |
| `navigations` | Changes of the address, hash or history entry |
| `reactions` | Interactions the page answered with a visible change within a moment |
| `errors`, `lastError` | Uncaught errors, unhandled rejections, `console.error` calls and failed resource loads |
| `view` | The location or route the page is showing |
| `unnamedControls`, `unnamedSample` | Displayed buttons, links and fields with no accessible name, and up to five of them |
| `overflowX` | How many pixels the document runs past the window's width (0 when it does not) |

### `dom` — what a person can see

Available on `inspect()` in every `scene` check. Only displayed elements count: a node that is on
the tree but not on the screen is not UI.

| Call | What it returns |
| --- | --- |
| `dom.count(selector)` / `dom.visible(selector)` | How many displayed elements match / whether at least one does |
| `dom.text(selector)` / `dom.first(selector)` | The text a person reads in each match / in the first one |
| `dom.value(selector)` | The current value of the first matching input, select or textarea |
| `dom.list(selector)` | Up to forty matches named as `tag#id.class "first words"` |
| `dom.summary()` | `{ title, headings, buttons, links, fields, landmarks }` |
| `dom.empty()` | True when the page shows no text and no visual element |

## Input — `ctx` inside `update()`

A project that passes `update` gets live input from `ctx`, the same one the critic drives; a project
of forms and lists usually has no `update` and reads its own events. Read from `ctx`, never from a
private accumulator, when you use it.

| Member | What it holds |
| --- | --- |
| `ctx.keys` | A Set of held keys (`KeyW` / `w`, `Space`, `Enter`, …), **including mouse buttons as `Mouse1` (left), `Mouse2` (right), `Mouse3` (middle)** |
| `ctx.look` | `{x, y}` mouse pixels since the last step — the pointer-locked mouse (opt-in: `input: { pointerLock: true }`), or the harness's injected look |
| `ctx.wheel` | `{x, y}` wheel delta since the last step |
| `ctx.pointer` | `{x, y, locked}` normalised cursor position over the canvas and whether the pointer is locked |

## Tags: how checks find a 3D or canvas world

A project that draws a 3D world tags what it adds: `mesh.userData.tag = "chart-axis"`, a group's tag
covering its children. Checks are written against tags, so an untagged object does not exist as far
as the contract is concerned. Pass `scene`, `renderer`, `camera` and `canvas` into `installStudio`,
and `player: () => ({x, y, z, yaw})` when the project has an avatar; a project that reaches none of
them is still observed through the DOM.

## Renderers

Both WebGL and WebGPU are supported, without a default; the offline import map carries
`three/webgpu` and `three/tsl` alongside `three` for a page that draws 3D. With the bundled Three
0.185.1, `await renderer.init()` must finish before a WebGPURenderer's synchronous render, capture or
step, and a WebGPU `render` may return a promise (`renderer.renderAsync`) that capture awaits. A
WebGPURenderer can fall back to WebGL; the profiler reports its initialized backend. With a post pass,
capture `renderer.info.render` **immediately after the world render** and report those numbers from
`probes()` — three resets the counters at the start of every `render()` call.

## Optimization-stage observation

The studio installs a temporary, app-owned observer through `inspect()`. A project that draws a canvas
or 3D world returns the actual `renderer`, primary world `scene` and `camera`; every project retains
`seed`, `pause`, `step`, `start`, state, views, demos, capture and input behavior. This requires no
new project state fields, live profiler UI or FPS overlay. World-call counters include
renderer-internal passes and are not total GPU time or memory; unknown counters are reported as
unavailable. The observer does not change `state().fps` or simulation time, and adds nothing to
exported source.

## Assets — `assets/`

`assets/<name>.<ext>` is committed with the project and `assets/src/` holds the sources that made it.
Files come from the studio's own tools when they are offered; reference them by a relative URL. Inspect
runtime costs: an image or model that makes the first screen wait is a defect.
