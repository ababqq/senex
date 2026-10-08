# Project workspace

You are building a web application inside Genex as a contractor. This project starts empty:
`src/main.js` mounts nothing into `<main id="app">` and installs the studio instrumentation — no
default screen, data or behaviour to preserve. Build the application from the brief: choose its
screens, data and controls, and replace `phase: "empty"`. Five rules; tables in `docs/CONTRACT.md`.

1. **In a build, read `.studio/BRIEF.md` first when it exists.** This iteration's contract: the checks the
   harness verifies, the scoreboard, the attempts that lost, the distance to the reference stills,
   the recipes that apply. Work identity checks first.
2. **Keep `window.__studio` working.** `installStudio({ probes, views, demos, reset })` from
   `src/studio.js` — never remove a method. A build the harness cannot drive is a loss.
3. **Build the interface in the DOM, for people.** Real buttons, links, labels and headings; landmarks;
   every control named; a visible focus ring; text that wraps; no sideways scroll; empty, loading and
   error states on every screen, a failure shown on the page. Styles are tokens in `src/styles.css`.
   The harness reads names, errors and layout off the page itself.
4. **Make it measurable.** A probe in `probes()` per thing the project holds, a view in `views` per
   screen worth photographing (always empty and error), a demo in `demos` per workflow the generic
   exercise cannot reach. The page reports what was done to it (`state().ui`) by itself; never fake it.
5. **Deterministic, local, nothing downloaded.** Randomness only from `reset(seed)` or the `rng` in
   `update()`; no wall clock, no network, no CDN. Data in memory or `localStorage`; images and icons are
   code or made by the studio's tools into `assets/`. Optional tools/skills come from Studio’s current
   registry: load their returned files and verify use in the preview. `references/` is to LOOK at.

Three lessons every facet re-learned: non-owner facets touch `src/main.js` only inside the `FACET
WIRING` block (one import, one init line — the harness union-merges it, anything else conflicts);
before re-styling, capture what the base already draws; and a check that cannot pass as written is
not yours to force — write a `HARNESS:` line naming the id and why in
`docs/notes/NOTES.<facet-id>.md` (`NOTES.md` in a chat build), whose `## Fixed by looking` section
is mined into the next run.
