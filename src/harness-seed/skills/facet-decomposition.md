---
name: Facet decomposition
description: Turn an Autopilot ask into typed facet specs with verifiable checks, sized to the engine.
trainable: true
---

<!-- SLOW_UPDATE -->
Output JSON only, no prose around it:
{"genres":["forms"],"app":{"kind":"<one of the kinds this ask names, or null>","playScript":null},"facets":[{"id":"kebab-slug","title":"…","intent":"…prose brief…","owns":["src/<slug>.js"],"identity":["ranked identity feature","…"],"cameras":["default","camSettings"],"checks":[{"id":"kebab","kind":"scene|pixel|probe|demo|vision|play","weight":"identity|normal","hard":false,"…":"…"}],"craft":["forms.validation-messages"],"milestones":[{"id":"kebab","what":"one structural step — what the project IS after it","check":{"kind":"scene","js":"count('row') >= 6"}}],"budgetShare":0.25}],"mainOwner":"kebab-slug","base":{"notes":"…","files":[{"path":"src/tokens.js","purpose":"…"}]},"integrationNotes":"…","assumptions":["…"]}

Rules that never change:
- budgetShare values sum to 1.
- `mainOwner` names exactly ONE facet id — the only facet allowed to edit the project's entry
  (`src/main.js`; a project with its own shape names its own, e.g. `src/main.ts`) and
  `src/studio.js`. Every other facet ships its work as its own module and one import line.
- Every facet has an `intent` (the prose brief) AND `checks`: the contract the harness verifies
  every iteration. A facet with no checks is judged by taste alone and plateaus — give every
  facet 4–10 checks, the majority mechanical (scene/pixel/probe/demo), vision only where
  nothing mechanical fits, at most one `play` check.
{{check-grammar}}
- Craft is not law. How a thing should LOOK and behave — a clear visual hierarchy, a calm error
  message, an empty state that says what to do, a form that keeps what was typed — lives in
  `library/recipes` as craft recipes, not on every board. They are
  retrieved for the builder automatically the moment a check fails or a judge names the matching
  defect, so a plan does not have to ask for them. `craft` is the exception: name up to 3 recipe
  ids there (from the craft menu below) when this facet EXISTS to get one of them right, and the
  harness puts that recipe's check on its board at normal weight. Naming none is a valid plan.
- Completeness is a ladder, not a pack. What makes software feel finished — the whole flow
  reachable, every state handled, feedback on every action, somewhere obvious to go next — is
  climbed through `milestones`, not bought by adding four checks. The loop's critic scores the
  principles every iteration (a screen: readable, state, affordance, feedback, depth, composition,
  palette, finish; a 3D scene: extent, scales, purpose, life, next-step, wear, light, material) and
  turns the worst grow gap into the next move by itself. Write the ladder so the grow principles
  are climbed in order.
- Assets: when the ask says BLENDER is available, any facet that owns 3D models (a product viewer,
  a scene, a configurator) names the assets to model in its intent and takes shape checks a modelled
  object can pass (`objects('chair').some(o => o.userData?.asset)` is the cheapest); facets owning
  different objects model in parallel. Interfaces, icons and illustrations are built in code or
  generated, not modelled.
- `weight:"identity"` marks the checks the facet exists for (2–4 of them). `hard:true` marks a
  check known to need a technique spike (a virtualised table of ten thousand rows, drag-and-drop
  reordering, a canvas chart that redraws on resize).
- `milestones` is the facet's ladder: 3–5 ORDERED structural steps, each one iteration's work,
  each changing what the project IS (its extent, a system, a workflow, where the user goes next,
  what the screen tells them) — never how it looks. Once the identity checks hold, the loop
  hands the builder the next unclimbed milestone as THE MOVE of the iteration, and a build that
  only polishes what already exists loses. The ladder must reach the whole intent: "a list that
  renders rows" → "add, edit and delete, kept across a reload" → "search, filters and sorting
  that survive navigation" → "empty, loading and error states, keyboard shortcuts and undo".
  Give each milestone a mechanical `check` where one exists (`count('row') >= 6`,
  `has('filters.active')`); leave `check` null when only a judge can see it.
- Every check names a camera (a named view the build registers) or a tag; the default camera is
  the page as it opens. A view the check needs but the build does not register is declared on the
  facet's `cameras`, and the builder is told to register it.
- Reuse ids and thresholds from the check catalogue below when they fit — never invent a second
  id for the same measurement. The catalogue is small on purpose: a few technical checks the
  harness keeps on every board, plus whatever the runs themselves learned, grouped under the
  kind of project that learned it. A group learned on another kind of project is a hypothesis here,
  not a group to take whole — take the entries that fit this ask and leave the rest.
- `genres` names the catalogue groups that apply (forms, dashboard, editor, content, graphics, …);
  what this run's judge learns is filed under them for the next project of that kind. `app`
  declares what the software IS — its `kind`, one of the names the ask lists. The kind already
  carries whether the project has DOM UI to inspect, views to move between and fields to type
  into; add the booleans `ui`, `navigation`, `typing` (and, for a 3D scene with a player,
  `mouseLook`, `keyboardMove`) beside it ONLY where this project differs from its kind, and
  remember that `false` is a declaration too — it takes that check off every board. The harness
  adds its own checks only for what is declared: `no-console-errors`, `controls-named` and
  `no-horizontal-overflow` for DOM UI, `nav-changes-view` when there are views to move between,
  `fields-take-input` when there are fields, `look-turns-camera` and `keys-move-player` for a
  scene with a player. Do not re-declare those ids. Build the interface in the DOM, with real
  buttons, links and labels: the harness reads names, errors and layout off the page itself, and
  input arrives as ordinary pointer and keyboard events.
- A demo (a registered user flow) may return data for its checks: name the fields in the check note
  (e.g. the `submit-empty` demo returns `{ errorsShown, focusedField }`).
- `base` lists the shared files every facet forks from (design tokens, shared constants, probe
  schema, empty tagged regions) — the base builder creates them before facets start.
- HOW MANY FACETS is a decision, not a default. When the ask carries a SCOUT REPORT, its
  BUILDERS count is the ceiling: produce that many facets or fewer, and with 1 produce exactly
  one facet for the whole ask. Without a scout, decide from the ask alone: a refinement of one
  existing screen, one flow, one look or one feature is ONE facet — parallel builders on one
  screen edit the same files and lose their work in the merge (an earlier run: six facets on
  one settings page, nothing merged). Split only along seams a user can name, each big
  enough to fill an hour on its own. The engine hint's maxParallel is a pool size, never a
  target.
- One facet is a valid answer for a small or tightly-coupled ask — do not split for the sake
  of splitting.
- When the scout report names a requested state (a view behind a menu, a role, a filter),
  every camera and check describes THAT state — the harness replays the scout's setup before
  each look, and adds the `requested-state` probe itself; do not re-declare it.
- `assumptions` lists the calls you made without data (a colour mood, a layout density);
  each becomes a decision card the user can overturn mid-run.
<!-- SLOW_UPDATE -->

## What makes a good split

Split along seams a user can name: data and storage, the main views, forms and validation, search
and filters, navigation, visual design and readability. Good facets touch mostly disjoint files;
the base commit and the integration notes carry whatever contract they must share (design
tokens, scale, where the user lands).

Weight budgetShare by how far each facet is from the reference, not by equal division — the
facet the mood board screams about deserves the largest share.

## What makes a good check

A check is a number or a boolean the harness can compute, phrased so that a failing check tells
the builder what to change. "Six or more rows" is a scene check over the tagged rows; "no more
than 2% of pixels above 0.9" is a pixel check on the view that shows the hero banner; "the item was
added" is a probe check on delta('items.count'). Write the number down once, in the check — never
only in the prose.

## File ownership

Facets that all edit `src/main.js` conflict at merge time by construction. Give every facet its
own module under `src/` (`list.js`, `filters.js`, `storage.js`) in `owns`; the `mainOwner`
facet is the only one that may restructure `src/main.js` and `src/studio.js`. Non-owner facets
touch main.js only to add their single import + init line inside the marked FACET WIRING block,
and write their notes to `NOTES.<facet-id>.md`, never the shared `NOTES.md`.

## Priority order inside a bundled facet

When spatial coupling forces one facet to hold more than 3 visual sub-systems, rank them in
`identity` and mark their checks `identity` — the loop works identity checks first and will not
polish a lower item while a higher one still fails.

(SkillOpt-editable guidance accretes below this line.)
