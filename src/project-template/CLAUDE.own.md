# This project's workspace

You are building inside Senex as a contractor, in a project **the studio did not
write**. Its entry is `__ENTRY_MAIN__`, __BUILD_LINE__, and the studio serves `__SERVED_ENTRY__`.
Its structure, its libraries, its screens and its controls are decisions somebody made — they are
the project, not defects to correct. Change what the brief asks for and leave the rest standing.

1. **In a build, read `.studio/BRIEF.md` first when it exists.** This iteration's contract: the checks the
   harness verifies, the scoreboard, the attempts that lost, the distance to the reference stills,
   the recipes that apply. Work identity checks first.
2. **Keep the studio able to see this project.** It ATTACHES rather than installs: it serves the
   page, owns the clock, seeds `Math.random` in judged runs and watches the page for what was done to
   it (clicks, typing, navigation, errors) — so it may pause the page and step it. If this project runs a loop (a
   canvas, an animation, a simulation), keep that loop's state in what it updates from its own delta, not in
   extra timers; a page with no loop needs nothing here. Where `__ENTRY_MAIN__` calls
   `installStudio({ probes, views, demos })` — the lines that tell the studio what the project
   holds and which screens to photograph, imported from `src/studio.js`, typed in `src/studio.d.ts`
   so the same import compiles under `tsc --strict` — leave them in and keep the probes honest. An
   unjudgeable build is a loss.
3. **Keep this project's screens and its controls.** Its UI is its own — its framework, its
   components, its styling. Do not re-route its input and do not rebuild its screens to suit the
   studio. The harness drives the project with real clicks and keystrokes, so keep it usable from
   the keyboard and the mouse, give every control a name, and show errors on the page.
4. **Make what you add measurable.** A probe in `probes()` per thing you build, a view that shows
   its screen (and its empty and error states), a demo in `demos` when the generic exercise cannot
   reach the workflow. Leave the project's existing code unmeasured when no check needs it.
5. **Deterministic runs, and this project's own assets.** The studio seeds `Math.random` and owns the
   clock, so the project's existing randomness and timers stay as they are; new random ids or choices
   use `Math.random` or a counter (not `crypto.randomUUID`, which the studio does not seed), and a
   project with a loop or a `reset(seed)` draws from that. Two builds that cannot be run on one seed
   cannot be compared. Whatever this project already loads at run time keeps loading: the template's
   "nothing is downloaded" rule is about the studio's offline scaffold, not about your project. New
   images or icons come from the studio's own tools; `references/` is for you to LOOK at, unless the
   user asks to use their own image (logo, photo): that file is theirs, so copy it into `assets/`.
__BUILD_RULE__
What your server writes while it runs (a database, uploads, a log) goes into `.gitignore` as soon as the
path exists: every snapshot saves whatever git does not ignore, and a checkpoint should hold the project,
not its data.

Two lessons every contractor re-learned: before re-styling, capture the project and look at what it
already draws; and a check that cannot pass as written is not yours to force — write a `HARNESS:`
line naming the check id and why in your notes (`docs/notes/NOTES.<facet-id>.md` in a facet run,
`NOTES.md` in a chat build), whose `## Fixed by looking` section is mined into the next run. Helper
scripts of your own go under `.studio/`, never into the project.
