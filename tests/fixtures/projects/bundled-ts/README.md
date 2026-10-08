# Corridor

Corridor is the bundled shape: TypeScript sources, `three` as a bare specifier that ends up
inside the bundle, no import map on the page at all, and a build that writes `dist/index.html`.
It is the only fixture here that was edited for the studio, and the edit is exactly the two
lines the milestone promises — one `import { installStudio } from "./studio.js"` and one
`installStudio({ renderer, player })`. Its `three` is its own copy, so nothing anywhere may
recognise a renderer by comparing constructors, and its loop is a `THREE.Clock` loop, so the
studio can only pace it by owning the clock the page reads.

Click to look, WASD to walk down the corridor.

## What it proves

- The shape is detected as built: `dist/index.html` is served, not the raw `.ts` a browser
  refuses, and the shadow build runs before the first frame is asked for.
- The two-line `installStudio({ renderer, player })` suffices for a project whose `three` is a
  different copy from the studio's — a contract that only worked for the studio's own `three`
  would pass every other test in the repository and fail here.
- Nothing compares renderer constructors by identity.
- The shim paces a `THREE.Clock` loop: `getDelta()` returns the stepped `dt`, not a wall-clock
  one, so a paused project really is paused and a stepped project advances by exactly the step.
- Pointer-lock look works in a hidden window Chromium never grants a lock to: `look.locked`
  stays false and the synthetic look has to arrive as plain `mousemove` deltas.

## esbuild, not Vite — and no checked-in `dist/`

The build is `node tools/build.mjs`, one esbuild call, run through `npm run build`. esbuild
because this fixture must build with **no install and no network**: esbuild and three are already
this repository's own devDependencies, while Vite is not. What the studio sees is identical
either way — `kindOf` answers `three-vite` from three-in-dependencies plus a build script,
`outputDir` answers `dist`, `packageCommands` answers `npm run build`, and `ProjectBuilds`
shadow-builds and serves `dist/index.html`. Read "three-vite" as the studio's word for the
bundled shape, not as a claim that Vite is installed.

`dist/` is **not** checked in, for the opposite reason: a prebuilt output would let the build
path rot silently, which is the exact failure this milestone exists to catch. `src/main.ts` also
imports `./studio.js`, which the studio writes into the folder when it adopts it, so this folder
does not build until it has been adopted. The runner adopts a copy, links this repository's
`node_modules` into it (`manifest.needsNodeModules`), and only then builds.

## Shape

`three-vite`, own, entry `dist/index.html`, main `src/main.ts`, build `npm run build`, install
`npm install`, serve `dist`. `kind: "first-person"`.
