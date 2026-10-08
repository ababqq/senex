# Project workspace

You are building a project inside Genex as a contractor. This project starts empty:
`src/main.js` boots a renderer and the studio instrumentation, nothing more — no default project,
player, ground, HUD or loop to preserve. Build the scene and mechanics from the brief, choose that
project's controls and viewpoints, replace `phase: "empty"`. Five rules; tables in `docs/CONTRACT.md`.

1. **In a build, read `.studio/BRIEF.md` first when it exists.** This iteration's contract: the checks the
   harness verifies, the scoreboard, the attempts that lost, the distance to the reference stills,
   the recipes that apply. Work identity checks first.
2. **Keep `window.__studio` working.** `installStudio({ scene, renderer, camera, player, … })`
   from `src/studio.js` — never remove a method. A build the harness cannot inspect is a loss.
3. **One screen, one input path.** UI through `__studio.hud` (in the canvas; no DOM, no second HUD;
   a player's name is a sprite on the player); input from `ctx.keys`/`ctx.look`/`ctx.wheel` in `update()`.
4. **Tag everything, make it measurable.** `obj.userData.tag = "<tag>"` on every object (a group
   tag covers its children), a probe in `probes()` per mechanic, a camera that shows it, a demo in
   `config.demos` when the generic walk cannot reach it. What cannot be measured does not exist.
5. **Deterministic, textured, modelled.** Randomness only from the `rng` in `update()` or a
   generator seeded in `reset(seed)`; time only from `dt`. `references/` is for you to LOOK at.
   Materials come from `src/materials.js` and foliage from `src/foliage.js`. Use procedural geometry,
   imports or enabled asset tools for silhouettes. Optional tools/skills come from Studio’s current
   registry: load their returned files and verify use in the preview. A flat colour with no map is
   a defect; a sphere canopy a `[blob]`; a box for a gun a `[primitive]`.

Three lessons every facet re-learned: non-owner facets touch `src/main.js` only inside the `FACET
WIRING` block (one import, one init line — the harness union-merges it, anything else conflicts);
before re-tuning lighting or fog, capture what the base already draws; and a check that cannot pass
as written is not yours to force — write a `HARNESS:` line naming the id and why in
`docs/notes/NOTES.<facet-id>.md` (`NOTES.md` in a chat build), whose `## Fixed by looking` section
is mined into the next run.
