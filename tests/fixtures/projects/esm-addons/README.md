# Orbit Yard

Orbit Yard is an ES-module project in the shape most no-build Three.js projects take: the five
import-map keys, `src/main.js` pulling `OrbitControls`, `EffectComposer`, `RenderPass` and
`UnrealBloomPass` out of `three/addons`, and `src/world.js` handing back a scene and a camera
from a module closure with nothing on `window`. Every frame goes through `composer.render()` and
never through `renderer.render()`, so the picture a player sees is the bloom, not the scene
before it. It ships a plain `studio.json` with a title and a `project` block and no
`contractVersion` — the third place a night can learn what kind of project this is.

There is no player and there are no keys. Drag to orbit the yard, wheel to zoom.

## What it proves

- `three/addons` resolves from the copies vendored with the studio, with no install and no
  bundler: four addon modules, each importing `three` and its own siblings by bare specifier.
- The renderer hook finds a renderer whose frames go through an `EffectComposer` — the world
  render is a pass into a render target, and the last pass is a full-screen quad.
- The end-of-frame capture reads the composer's output. A capture that re-rendered the scene
  from `(scene, camera)` would return a picture the player never saw.
- A scene held in a module closure is inspectable: nothing here is reachable from `window`.
- `studio.json`'s nested `project` block is the third declaration source, after the plan and the
  scout — and the top-level `kind` (the project shape) is not it.
- A kind with no input probes invites no `[dead-input]` report: `graphics` asks for no look
  check and no movement check, so an unmoving player is not a defect here.

## Shape

`three-modules`, own, entry `index.html`, main `src/main.js`, no build, no package manager. Its
`studio.json` carries no `contractVersion` and no shape fields, so `readProjectShape` falls
through to detection. `kind: "graphics"`.
