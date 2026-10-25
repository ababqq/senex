# Project workspace

You are building a web application inside Senex as a contractor. This project starts empty:
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
   The harness reads names, errors and layout off the page itself. Copy, sample data, `<title>` and `<html lang>` follow the person’s language.
4. **Make it measurable.** A probe in `probes()` per thing the project holds, a view in `views` per
   screen worth photographing (always empty and error), a demo in `demos` per workflow the generic
   exercise cannot reach. The page reports what was done to it (`state().ui`) by itself; never fake it.
5. **Replayable, local.** Fixtures and the first screen come only from `reset(seed)`; `Math.random`, `Date.now` and ids are
   fine elsewhere (judged runs seed and own them). The preview is offline but for public library and font CDNs, and
   `project://` has no cookies or service workers: put an outside service behind one data module with sample data.
   `reset(1)` runs on every load: never wipe what a person saved or add samples on boot unless asked. Images and icons: code, or Studio’s registry tools into `assets/` (verify in the preview). `references/`: LOOK only — unless the user asks to use their own image (logo, photo): copy that into `assets/`.

Three lessons every facet re-learned: non-owner facets touch `src/main.js` only inside the `FACET
WIRING` block (one import, one init line — the harness union-merges it, anything else conflicts);
before re-styling, capture what the base already draws; and a check that cannot pass as written is
not yours to force — write a `HARNESS:` line naming the id and why in
`docs/notes/NOTES.<facet-id>.md` (`NOTES.md` in a chat build), whose `## Fixed by looking` section
is mined into the next run.
