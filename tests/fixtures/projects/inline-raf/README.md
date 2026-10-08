# Sweep

Sweep is one `index.html` and nothing else: an import map, an inline module, a ground plane,
twelve pickups placed with `Math.random()`, its own `keydown`/`keyup` listeners and its own
`requestAnimationFrame` loop reading `performance.now()` by hand. It never mentions the studio,
registers no cameras and defines no `window.__studio`. This is the shape that proves the studio
can pace, seed, drive and photograph a page that was written as if the studio did not exist —
because a project like this one is what most Three.js pages on the internet actually are.

Drive the pale cube with WASD or the arrow keys and collect the twelve green shards.

## What it proves

- The shim owns `performance.now` and `requestAnimationFrame` for a page that never heard of the
  studio: pausing the clock stops this loop, and `step(ms)` advances it by exactly that much.
- `preview.input` reaches the page's own `keydown`/`keyup` listeners while the clock is frozen
  and stepped, so a play script moves the cube on a paced clock.
- The renderer hook discovers the renderer, scene and camera from the frames the page draws, so
  the build is judgeable with no edit at all.
- `seed(n)` makes `Math.random` reproducible for a project that calls it directly at module scope —
  the twelve pickups land in the same twelve places on every run.
- A project that registers no cameras is photographed on the one view it renders, and warned about,
  rather than voided for returning three identical frames from a dead `debugCamera`.

## Shape

`three-modules`, own, entry and main both `index.html` (the page's only script is inline, so the
page is its own entry), no build, no package manager, no `studio.json`. `kind: "top-down"`.
