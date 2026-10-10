# Genex eval cases — the pinned briefs

**This file is the suite.** Everything else about the eval system is machinery; these texts are what
actually gets measured. `scripts/evals/cases.ts` parses it; nothing else holds a copy of a brief.

## Whose list this is

**The brief list belongs to the owner.** It is not edited, reworded, extended or "improved" by an
agent without being asked. Proposals arrive as draft cases, clearly marked, and stay drafts until
the owner pins them.

*(This rule exists because it was broken in the suite this one is ported from: the list churned
across five revisions — cases invented, cases silently dropped, the casual case exploded into five
arcade briefs and then deleted. That is the opposite of what a pinned suite is for.)*

## The one hard rule

**A brief is never reworded once pinned, and neither is its acceptance checklist.** A run from
October is comparable to one from August only because both are byte-identical. If either must
change it becomes a *new* case with a new id, and the old one retires — never edited in place.

Each case is versioned by the sha256 of its own block (heading to the next heading, trailing blank
lines and `---` rules excluded), and its checklist by the sha256 of the acceptance block and the
control line. Adding, moving or retiring another case never changes a case's version.

## The grammar

- `## C<n> · \`id\` — label` opens a case; the block runs to the next `#` or `##` heading. `✅ PINNED`
  and an `*(…)*` note are stripped from the label.
- `**Mode:**` (optional): `build` (default), `edit-existing`, `follow-up` or `long-horizon`.
- `**Exposure:**` (required): `none`, or `dev-tuned (<reason>)` when the product was iterated on this
  case. A product-axis headline needs at least one `Exposure: none` case.
- `**Visibility:**` (optional): public here; every case in `$GENEX_EVALS_HOME/cases-private.md` is a
  holdout.
- `**Deadline:**` (optional): `<minutes> min`; 90 by default.
- The brief is the **first** blockquote.
- `**Acceptance:**` is followed by a fenced block of `[ ] text <- "brief phrase"` lines (`←` also
  reads). `KEY:` marks the spatial or judgement item named first in reports; `full assets only:`
  items are skipped when the run had no paid assets. A wrapped item continues on an indented line.
- `**Control:**` is the absurd control item every checklist carries: a grade that passes it is void.
- `**Follow-ups:**` (follow-up cases): a numbered list, one later user turn per item.
- `**Start from:**` (edit cases): one committed folder under `tests/fixtures/evals/projects/`.

## Assets

Every case runs in one of two asset settings, and the setting is part of the run record because
results across settings are not comparable:

- **primitives** (default) — generation returns valid placeholders. Isolates spatial reasoning,
  layout and systems. Cheap enough to run often. Eval profiles have no Genex login, so this is what
  every lane gets today.
- **full assets** (occasional) — the real pipeline. The only setting where the exposure, audio and
  paid-asset-delivery checks mean anything.

---

# The cases

## C1 · `medieval-village` — content volume ✅ PINNED

**Assets:** `assets: none` by default · `all` at the release gate
**Exposure:** dev-tuned (the harness seed was iterated on village runs: facet/policy.ts, replan.ts and recipes/liveness.filled-ground.json)

> I want a medieval village I can walk around. A few houses, a blacksmith, a well in the middle —
> and people living there who walk about, each with something of their own to say when I talk to
> them. Let time pass so I can see it go from day to night.

**Acceptance:**

```
[ ] more than one house, and they are distinguishable        <- "a few houses"
[ ] a blacksmith that reads as a blacksmith                  <- "a blacksmith"
[ ] a well, and it is central rather than dropped anywhere   <- "in the middle"
[ ] villagers move on their own                              <- "walk about"
[ ] you can talk to one                                      <- "when I talk to them"
[ ] different villagers say different things                 <- "each with something of their own"
[ ] time passes and day becomes night                        <- "let time pass ... day to night"
[ ] KEY: the village reads as a place, not scattered objects <- "a village I can walk around"
[ ] full assets only: the night scene is legible, not black
```

**Control:** a submarine periscope shows the ocean floor from inside the well

The panelka shape: many lanes at once, a long horizon, and the day/night cycle where the exposure
defect lives. The KEY line is the spatial-reasoning check — everything else can pass while the
buildings sit in a meaningless row.

## C2 · `shooter` — mechanics and feel ✅ PINNED

**Assets:** `assets: none` by default
**Exposure:** none

> A first-person shooter, something like Counter-Strike. The gun should have real recoil, and I want
> to clearly feel it when I land a hit and when I take one. Put enemies in there that can actually
> kill me.

**Acceptance:**

```
[ ] first-person view                                      <- "first-person"
[ ] shooting produces a visible response on the weapon     <- "real recoil"
[ ] landing a hit is acknowledged                          <- "feel it when I land a hit"
[ ] taking damage is acknowledged                          <- "and when I take one"
[ ] enemies exist and engage                               <- "put enemies in there"
[ ] you can die, and the project says so                      <- "that can actually kill me"
[ ] aim direction matches where the crosshair points
```

**Control:** every enemy is a knitted sweater that recites poetry before it fires

Combat feel is the axis machines grade worst and a human grades best — **this is the case that loads
the human's five minutes.** The last item is machine-checkable and is in every case for a reason:
inverted aim has shipped before.

## C3 · `mini-golf` — the short happy path ✅ PINNED

**Assets:** `assets: none` — and unusually, that is not a compromise
**Exposure:** none

> One hole of mini golf. I line up the shot with the mouse and hit the ball — it should roll and
> bounce off the walls properly. Count my strokes and tell me when I sink it.

**Acceptance:**

```
[ ] you can aim, and the aim is visible before you commit   <- "line up the shot"
[ ] shot power is controllable, not fixed                   <- "hit the ball"
[ ] the ball rolls under physics rather than teleporting    <- "it should roll"
[ ] it bounces off walls plausibly                          <- "bounce off the walls properly"
[ ] sinking it is detected and ends the hole                <- "tell me when I sink it"
[ ] strokes are counted and shown                           <- "count my strokes"
[ ] you can play the hole again
[ ] KEY: the hole is reachable but not trivial — the layout is a judgement
```

**Control:** the ball is a live goldfish that swims back out of the hole

**The project exists completely in primitives** — a green, a slope, two walls, a hole, a ball. The
default-mode run is not a degraded version of the real thing; it *is* the real thing, which makes
this the cleanest measurement in the suite.

**Spatial reasoning is the interaction**, not decoration around it: slope, distance, rebound, and where
to put an obstacle so the hole is reachable but not free. Weakly canonical — unlike snake, pong or
tetris there is no single dominant implementation to recall. Short by construction: one hole, not a
course.

## C5 · `vague-brief` — scope negotiation ✅ PINNED

**Run shape:** questions only — **this case does not build a project.** It runs until the agent asks
its questions, or until it starts building without asking, and then stops. Minutes and cents.
**Exposure:** none

> make me a project about space

Deliberately under-specified, and realistically so: this is the shape of a real first message.
Every major fork is open — single or multiplayer, combat or exploration, first-person or top-down,
what winning even means. Five words are too short to shingle, so the isolation check exempts this
brief by length; its checklist carries no brief phrase to leak.

**Acceptance:** what is measured — its own set; the floor does not apply.

```
[ ] KEY: did it ask at all, before committing to a direction
[ ] KEY: how early — in turns and minutes. A question asked after the project
        is built is worthless, and this is the number that catches it
[ ] how many (over-asking is its own failure)
[ ] KEY: are the questions GOOD — judge call: "would answering this change
        what gets built?" Single-or-multiplayer resolves a fork.
        Button colour does not, and asking it spends the user's attention
        on nothing
[ ] did it assume something major without asking
[ ] if it assumed, did it say so
```

**Control:** it asked for the user's shoe size before anything else

The ledger's `outcome.questionsAsked` counts questions — it cannot tell a good one from a bad one.
That gap is the whole reason this case exists.

## C8 · `canary` — drift detector ✅ PINNED

**Exposure:** none

> A ball rolls down a slope, I steer it with the arrows, and mustn't fall off the edge.

The simplest thing that is still a project, run every campaign. **Its result must never change** —
providers drift silently under a fixed prompt, and this is how we notice. A campaign whose canary
fails is void rather than interpreted. **No checklist, and so no control:** its verdict is
machine-only (boot, first draw, input response).

**What a canary is for** — from the bird in the coal mine. Providers silently swap the model behind
a fixed name; a router sends you to a different endpoint. When that happens every case degrades at
once and it looks exactly like a regression *we* caused. The canary is how you tell the two apart.

It runs **first and last** in every campaign, and **one failure is not enough to stop on** — retry
once; two consecutive failures is the signal. On a stop, read the served main-loop model back from
the transcript before walking away.

*Chess was considered and rejected: a memorised task survives model degradation, so the canary would
stay green while everything else went red — a false all-clear, the worst failure a drift detector
can have.*

## C9 · `edit-existing` — adding to a project that already works *(draft: owner pins before first baseline)*

**Mode:** `edit-existing`
**Exposure:** none
**Start from:** `tests/fixtures/evals/projects/edit-existing`

> Add a double jump to this project, and put a few floating platforms up high with extra gems on them.

**Acceptance:**

```
[ ] a second jump works in mid-air, once per jump           <- "a double jump"
[ ] there are platforms above the ground                    <- "a few floating platforms up high"
[ ] the high platforms can be reached with the double jump
[ ] the platforms hold gems, and collecting them counts     <- "extra gems on them"
[ ] KEY: everything that worked before the edit still works
[ ] the agent did not rewrite things it was not asked about
```

**Control:** the project now opens with a fully voiced opera about tax law

Every lane starts from the same committed folder, a small hand-made project: move, jump once, collect
the gems, restart. The regression item is the one failure that cannot happen on a fresh build, and
the last item bounds blast radius — one mechanic was requested; a rewritten renderer is a failure
even if the double jump works.

## C10 · `follow-up` — the second turn *(draft: owner pins before first baseline)*

**Mode:** `follow-up`
**Exposure:** none

> A small top-down project where I steer a little boat around a lake and collect floating buoys before
> a timer runs out.

**Follow-ups:**

1. Now add a storm halfway through the timer: rain, a darker sky and waves that push the boat
   around.

**Acceptance:**

```
[ ] a top-down view of a lake                               <- "top-down"
[ ] the boat can be steered                                 <- "steer a little boat around a lake"
[ ] buoys can be collected                                  <- "collect floating buoys"
[ ] a timer runs out and the project says so                   <- "before a timer runs out"
[ ] a storm arrives partway through the round               <- "a storm halfway through the timer"
[ ] the storm is visible: rain and a darker sky             <- "rain, a darker sky"
[ ] KEY: the storm changes how the boat handles             <- "waves that push the boat around"
[ ] everything from the first turn still works after the follow-up
```

**Control:** the boat sprouts wings and the lake turns into a volcano

Genex gets the follow-up as the next message in the same chat; raw lanes resume their session. The
checklist is graded once, on the final state, so it covers both turns.

## C11 · `long-horizon` — a long Loop *(draft: owner pins before first baseline)*

**Mode:** `long-horizon`
**Exposure:** none
**Deadline:** 180 min

> A survival project on a small island. I gather wood and stone, craft tools from them, and build a
> shelter before the first night. Creatures come out in the dark, and I have to survive them.

**Acceptance:**

```
[ ] wood and stone can be gathered                          <- "I gather wood and stone"
[ ] tools can be crafted from what was gathered             <- "craft tools from them"
[ ] a shelter can be built                                  <- "build a shelter"
[ ] night falls, and it changes what is safe                <- "before the first night"
[ ] creatures appear in the dark and threaten you           <- "Creatures come out in the dark"
[ ] you can die, and the project says so                       <- "I have to survive them"
[ ] the island reads as an island                           <- "a small island"
[ ] KEY: the systems connect — gathering feeds crafting feeds building feeds surviving
```

**Control:** the creatures are polite accountants who file the player's taxes

A three-hour deadline, so the case measures what a long Loop adds over a short build: whether the
systems keep connecting, and whether later work breaks earlier work.

## C12 · `sales-dashboard` — a screen to read at a glance *(draft: owner pins before first baseline)*

**Exposure:** none

> I run a small online shop and I want one screen that shows how this week went: revenue and number
> of orders at the top, a chart of sales day by day, and a table of my best-selling products. Let me
> flip between this week and last month. Sample data is fine, but make it believable.

**Acceptance:**

```
[ ] revenue and the number of orders are at the top, readable without scrolling   <- "revenue and number of orders at the top"
[ ] a chart shows sales for each day of the period                                <- "a chart of sales day by day"
[ ] a table lists products, the best seller first                                 <- "my best-selling products"
[ ] the period can be switched, and the numbers on screen change with it          <- "flip between this week and last month"
[ ] the figures agree: the totals match what the chart and the table show         <- "make it believable"
[ ] KEY: the screen reads at a glance — the headline numbers dominate and the rest is quiet
```

**Control:** the revenue total is announced aloud by a choir of sea lions

The dashboard shape: a screen that is read far more than it is operated, so hierarchy and
consistency carry the case. The KEY line is the layout judgement — every number can be present while
the page is a wall of equal-weight boxes.

## C13 · `class-signup` — the failure path is the product *(draft: owner pins before first baseline)*

**Exposure:** none

> A sign-up form for a community pottery class. I need the person's name, their email, which session
> they want (Tuesday evening or Saturday morning) and whether they have used a wheel before. If they
> get something wrong, tell them what to fix. When it goes through, show a confirmation of what they
> signed up for.

**Acceptance:**

```
[ ] the form asks for name, email, session and wheel experience                   <- "the person's name, their email"
[ ] the session choice offers Tuesday evening and Saturday morning                <- "Tuesday evening or Saturday morning"
[ ] a malformed email is refused with a message that says what is wrong           <- "tell them what to fix"
[ ] a required field left empty is refused, with the message beside that field
[ ] a valid submission shows a confirmation                                       <- "show a confirmation"
[ ] the confirmation repeats the person's name and the session they chose         <- "what they signed up for"
[ ] KEY: after a refusal, what the person already typed is still in the form
```

**Control:** the confirmation is delivered as a handwritten letter by post

The form-flow shape: the happy path is a handful of fields and every real defect lives in what
happens when a field is wrong. The KEY line is the one a form quietly fails — a refusal that wipes
the form teaches nobody anything.

## C14 · `habit-tracker` — a list that changes under your hands *(draft: owner pins before first baseline)*

**Exposure:** none

> A little habit tracker. I add habits like "stretch" or "read", tick each one off for today, and see
> how many days in a row I have kept it going. I should be able to delete a habit I don't want any
> more.

**Acceptance:**

```
[ ] a habit can be added by typing its name                                       <- "I add habits"
[ ] a habit can be ticked off for today                                           <- "tick each one off for today"
[ ] each habit shows a streak, and ticking it raises the count                    <- "how many days in a row"
[ ] a habit can be deleted                                                        <- "delete a habit"
[ ] with no habits the screen says what to do instead of showing nothing
[ ] KEY: the list stays coherent as it changes — ticked habits are distinguishable and nothing duplicates or vanishes
```

**Control:** ticking a habit also waters a real houseplant

The list-manager shape: create, mark and delete are three small features, and the defects live in the
seams — an empty list, the second item, the state a tick leaves behind. Persistence across a reload
is left out on purpose: no prober phase reloads the page, so no frame could show it.

## C15 · `hiking-club-site` — a small site that holds together *(draft: owner pins before first baseline)*

**Exposure:** none

> A small website for our hiking club. A home page that says who we are, a page with our three
> regular hikes and how long and how hard each one is, and a page about how to join. It should be
> easy to get between the pages and read well on a phone.

**Acceptance:**

```
[ ] the home page says who the club is                                            <- "says who we are"
[ ] a hikes page lists three hikes                                                <- "our three regular hikes"
[ ] each hike shows how long and how hard it is                                   <- "how long and how hard"
[ ] a page explains how to join                                                   <- "how to join"
[ ] every page links to the others, and following a link works                    <- "easy to get between the pages"
[ ] at phone width nothing scrolls sideways and the text stays readable           <- "read well on a phone"
[ ] KEY: it reads as one site — shared navigation and a consistent look on every page
```

**Control:** the hikes page can only be read during a solar eclipse

The content-site shape: little behaviour, so the case measures structure, copy and finish. The phone
line is the responsive check.

## C16 · `bill-splitter` — a small tool that must be right *(draft: owner pins before first baseline)*

**Exposure:** none

> A bill splitter for dinner with friends. I type in the total, pick a tip percentage and say how many
> of us there are, and it shows what each person pays. Round sensibly, and don't show nonsense if I
> leave a box empty.

**Acceptance:**

```
[ ] there are inputs for the total, the tip percentage and the number of people   <- "pick a tip percentage"
[ ] the amount each person pays is shown                                          <- "what each person pays"
[ ] the amount is rounded to cents                                                <- "Round sensibly"
[ ] an empty or zero input gives a neutral state, never NaN, a negative or an infinite amount   <- "leave a box empty"
[ ] KEY: the amount is right for the inputs on screen — (total plus tip) divided by the people
```

**Control:** splitting the bill also orders dessert for the table

The utility shape: one screen, one formula, no excuses. The KEY line is checkable from the frames
alone, because the inputs and the answer are on screen together.

---

# Rotation and holdouts

Retire a brief when every run passes it (saturated — it no longer discriminates) or none does
(floored — it measures only difficulty). Log each brief's pin date and the last decision it
contributed to.

**Holdouts** — at least one case never read while tuning anything, run only at a release gate and
reported separately. Without one this suite is fitted to itself within a month. Holdouts live in
`$GENEX_EVALS_HOME/cases-private.md` (the same grammar; every case there is `visibility: holdout`)
and never enter Git: the ledger writer refuses holdout rows for a ledger inside a Git worktree, and
export snapshots skip them. Reports show the **holdout gap**: public pass rate minus holdout pass
rate. `holdout-1` is due with the first live lanes, so the first product-axis observation has an
untuned case.

**New cases** arrive by pull request as a new id, marked draft. The owner pins a draft before its
first baseline; a case enters baselines only after one clean campaign. The numbers C4, C6 and C7 are
cases of the suite this one was ported from and are not ported; their numbers are not reused.

| id | status | pinned | last informed a decision |
|---|---|---|---|
| C1 medieval-village | **pinned** (dev-tuned) | 2026-08-28 | — |
| C2 shooter | **pinned** | 2026-08-28 | — |
| C3 mini-golf | **pinned** | 2026-08-28 | — |
| C5 vague-brief | **pinned** | 2026-08-28 | — |
| C8 canary | **pinned** | 2026-08-28 | — |
| C9 edit-existing | draft | — | — |
| C10 follow-up | draft | — | — |
| C11 long-horizon | draft | — | — |
| C12 sales-dashboard | draft | — | — |
| C13 class-signup | draft | — | — |
| C14 habit-tracker | draft | — | — |
| C15 hiking-club-site | draft | — | — |
| C16 bill-splitter | draft | — | — |
