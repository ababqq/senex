/**
 * Briefs more than one mode builds from: the base builder's (the classic pipeline's shared base,
 * and the starting point a director's night from scratch builds first) and the one sentence that
 * makes somebody's own project judgeable (the base builder's own-shape bullet, and the director's
 * `installContract`). They lived in autopilot.ts, so the director imported the whole classic
 * pipeline to reach them; autopilot.ts still exports both, for harness files that import them
 * from there.
 */
import { roleEngine, RoleKey, toolCall } from "./model-roles.ts";
import type { AnyRecord, Run } from "../types/harness.d.ts";

/**
 * The one job that makes somebody's own project judgeable: its entry loads the studio contract, so
 * every window, judge and check can see the project at all. The base builder's own-shape bullet is
 * this sentence, and so is the step a director's night runs first when the project arrived without
 * it (director.ts `contractBrief`) — one wording, because the two are the same task.
 */
export function contractWiringAsk(shape: { main?: string } | null | undefined): string {
  const entryMain = shape?.main ?? "src/main.js";
  return `Add the two lines to ${entryMain} (or a module it imports): \`import { installStudio } from "./studio.js"\` — the contract module the studio keeps in src/, with its types in src/studio.d.ts beside it — and \`installStudio({ probes })\` with a probes() that reports what this project holds (items, selection, route). Two lines is the whole ask: the studio's own code is already on the page and watches what is done to it (clicks, typing, navigation, errors); what the project holds is the one thing it cannot guess. A project that draws a canvas or 3D world also passes its renderer and camera.`;
}

/**
 * The base builder's brief. The classic pipeline knows its facets by name here; a director's
 * night does not — it plans as it goes — so a plan with no facets asks for the same starting
 * point in the same words, minus the roll call (director, 2026-09-08).
 */
/** What the base builder is told about the plan: its facets and the shared base they fork from. */
export interface BasePlan {
  base?: { files?: Array<{ path: string; purpose?: string }>; notes?: string } | null;
  facets?: Array<{ id: string; title?: string; owns?: string[]; identity?: string[]; cameras?: string[] }>;
  integrationNotes?: string;
}

/** What the base builder is told about the project's shape: its entry, its page and its build. */
type BriefShape = { main?: string; entry?: string; build?: string | null } | null;
/** The run as the base brief reads it. */
type BriefRun = Pick<Run, "goal" | "reference" | "engine" | "builderEngine"> & { runId?: string };
/** The base plan's facets. */
type BriefFacets = NonNullable<BasePlan["facets"]>;

export function baseBrief({
  run,
  plan,
  projectLabel,
  shape = null,
  ownShape = false,
  setup = null,
}: {
  run: BriefRun;
  plan: BasePlan;
  projectLabel: string;
  shape?: BriefShape;
  ownShape?: boolean;
  setup?: AnyRecord | null;
}): string {
  const facets = plan.facets ?? [];
  if (!ownShape && facets.length === 0) return startingSceneBrief(run, projectLabel, setup);
  return [
    ...baseHeader(run, plan, projectLabel),
    ``,
    `ALWAYS, whatever the notes say:`,
    ...(ownShape ? ownShapeRules(shape) : templateRules(facets)),
    `- probes() reports what the facets will need (counts per list, the selection, the route).`,
    cameraRule(facets),
    ownShape
      ? `- The project already exists and works. Add only the contract wiring and the shared structure the facets need; do not remove, restyle or "clean up" what is there.`
      : `- The new project is empty. Add only shared structure required by this specific project. Do not add demo content, placeholder copy, sample users or a fake dashboard. An empty page and empty regions are valid at this stage; the shell, inspection and view switching must still work. Each facet creates its own visible content from the brief.`,
    `- The project must still load and window.__studio must work. Do not build facet content — scaffolding only. Do not commit; the studio commits.`,
    ``,
    `YOU HAVE HANDS AND EYES: ${toolCall(roleEngine(run, RoleKey.Builder), "computer")} runs this folder's build live in its own window (its own description lists every action), and ${toolCall(roleEngine(run, RoleKey.Builder), "capture")} takes every registered camera at once. Look before you finish: a base nobody can see is a base nobody can build on.`,
    ...(setup ? [requestedStateLine(setup)] : []),
  ]
    .filter((line) => line !== undefined && line !== null)
    .join("\n");
}

/** A director's night from scratch: one visible, working first version, and no roll call. */
function startingSceneBrief(run: BriefRun, projectLabel: string, setup: AnyRecord | null): string {
  return [
    `You are building the first working version of "${projectLabel}". Goal: ${run.goal}`,
    run.reference?.name ? `Direction: ${run.reference.name}.` : "",
    `Complete one visible, working first version now: the goal's main screen with real controls that do something, realistic fixture data, and the states a person meets first. Preserve the user's intended product; later workers can enrich detail. Do not spend this stage designing a large framework.`,
    `Read src/main.js first, then edit it. Read docs/CONTRACT.md only for a specific unanswered API question. src/studio.js is existing host instrumentation: use its public API; do not study or rewrite its implementation. index.html mounts <main id="app"> and links src/styles.css, which holds the shared tokens (colour, spacing, type scale).`,
    `Integration guide: keep import { installStudio } from "./studio.js" and the FACET WIRING markers. Render into #app with real elements — buttons, links, labels, headings, landmarks — keep the data in one store module, and derive the screen from it with one render function. Define views.default() so the page can be brought back to the screen it boots into; it is called by reset.`,
    `Keep installStudio({reset(seed){/* known state for this seed */}, probes(){return {phase:"app", items:store.items().length, route:location.hash}}, views:{default(){...}, empty(){...}}, demos:{}}). The studio paces the page: no separate animation loop unless the product animates. Keep the FACET WIRING markers for later edits.`,
    `Input/UI: ordinary DOM events on real elements. The page reports clicks, typing, navigation and errors by itself in state().ui, so nothing needs faking; give every control a name, handle the empty state, and show a failure on the page. A project that animates or draws a canvas passes update(dtSeconds, ctx) and reads ctx.keys, ctx.look and ctx.wheel.`,
    `Do not invent helpers or controls you have not implemented. Make the requested screen real with HTML and CSS first; use the studio's asset tools only when the goal needs an image or icon you cannot draw in code.`,
    `After writing, use computer to reload and use the actual page: click through it, type into its fields, fix console errors and layout breaks, then finish with what you observed. The host commits and validates your changes. No git commit is needed.`,
    setup ? `Requested inspection state: ${JSON.stringify(setup)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Who the base builder is, the goal and direction, the facets that fork from it, and the plan's notes. */
function baseHeader(run: BriefRun, plan: BasePlan, projectLabel: string): string[] {
  const facets = plan.facets ?? [];
  const files = plan.base?.files ?? [];
  const who = run.runId ? `run ${run.runId}` : "this run";
  const many = facets.length > 0;
  const count = many ? `${facets.length} facets are` : "Builders are";
  const fork = many ? "be built in parallel, each in" : "work on this project, each with";
  const seams = many ? "facets" : "them";
  const notes = run.reference?.notes ? ` — ${run.reference.notes}` : "";
  return [
    `You are the BASE BUILDER for ${who} on the project "${projectLabel}". ${count} about to ${fork} its own copy of this folder. Before they fork, create the shared base they all build on — so the seams between ${seams} are code, not prose.`,
    ``,
    `PROJECT GOAL: ${run.goal}`,
    run.reference?.name ? `REFERENCE / DIRECTION: ${run.reference.name}${notes}` : "",
    ``,
    many ? `FACETS THAT WILL FORK FROM YOUR WORK:` : "",
    ...facets.map(
      (f) =>
        `- ${f.id}: ${f.title} — owns ${f.owns?.length ? f.owns.join(", ") : `src/${f.id}.js`}; identity: ${f.identity?.join(", ") || "n/a"}`,
    ),
    ``,
    plan.integrationNotes ? `INTEGRATION NOTES (the shared contract): ${plan.integrationNotes}` : "",
    plan.base?.notes ? `BASE NOTES: ${plan.base.notes}` : "",
    files.length ? `FILES TO CREATE:\n${files.map((f) => `- ${f.path} — ${f.purpose}`).join("\n")}` : "",
  ];
}

/** The rules for a project that came with its own shape: keep it, wire the contract in, run its build. */
function ownShapeRules(shape: BriefShape): string[] {
  const entryMain = shape?.main ?? "src/main.js";
  const builtWith = shape?.build ? `, its page is built with \`${shape.build}\`` : "";
  return [
    `- THIS PROJECT HAS ITS OWN SHAPE — it is not the studio's template. Its entry is ${entryMain}${builtWith} and the studio serves ${shape?.entry ?? "index.html"}. Keep that: no second entry, do not replace index.html, do not rewrite the project in plain JS, keep its UI and input handling.`,
    `- ${contractWiringAsk(shape)} Register the views the facets name through config.views, in the same call.`,
    // Said as a prohibition, because the template's answer to "where do parallel builders
    // meet" is a marker block and a group per facet, and imposing either on a project that
    // already has its own structure is how a night rewrites somebody's architecture.
    `- Do NOT impose the studio template's structure on this project: no marker block in the entry for builders to add import lines to, no empty per-builder container added to the page, no shared module invented to hold them. Builders here are given a seam in the code this project already has — a file, a folder or a glob — and they wire their work in the way this project already wires things.`,
    ...(shape?.build
      ? [
          `- Run \`${shape.build}\` yourself before you finish and fix every error it reports — the studio runs the same build before every preview, and a build that fails is a blank screen for every critic.`,
        ]
      : []),
  ];
}

/** The rules for the studio's template: the wiring block, a region per facet, and shared tokens. */
function templateRules(facets: BriefFacets): string[] {
  return [
    facets.length
      ? `- src/main.js keeps the FACET WIRING block and builds the shell in #app (header, nav, main, footer), with one empty region per facet (a <section data-facet="<facet id>"> with its heading) exported from src/shell.js so each facet fills its own region.`
      : `- src/main.js keeps the FACET WIRING block (one import + one init line per builder — the studio union-merges that block, so it is where parallel work meets) and builds the shell in #app (header, nav, main, footer), exporting from src/shell.js one empty region per part the goal names (<section data-facet="<part>"> with its heading).`,
    `- src/styles.css holds the tokens every facet must share: the colours, the spacing and type scales, the radius and the focus ring. Facets use the tokens and add their own rules in their own files, never raw numbers for what a token covers.`,
  ];
}

/** Which views the base registers: the facets' own, or a default plus one per screen. */
function cameraRule(facets: BriefFacets): string {
  if (facets.length)
    return `- Register distinct, working views (config.views — the harness calls them cameras) for the screens the facets name: ${[...new Set(facets.flatMap((f) => f.cameras ?? []))].join(", ")}.`;
  return `- Register distinct, working views through config.views: "default" showing the project as a person first meets it, an "empty" and one per screen the goal names. Every judge and every check looks through them.`;
}

/** How the setup script names the state it replays: its note, its demo, or its input actions. */
function setupLabel(setup: AnyRecord): string {
  return setup.note ?? replayedSteps(setup);
}

/** A setup script without a note: the demo it runs, or how many input actions it replays. */
function replayedSteps(setup: AnyRecord): string {
  if (setup.demo) return `demo "${setup.demo}"`;
  return `${(setup.actions ?? []).length} input action(s)`;
}

/** The state the run is about, which the base's views must be registered against. */
function requestedStateLine(setup: AnyRecord): string {
  const equals = setup.verify && "equals" in setup.verify ? ` == ${JSON.stringify(setup.verify.equals)}` : "";
  const verified = setup.verify ? `, verified by ${setup.verify.path}${equals}` : "";
  return `THE REQUESTED STATE: this run is about a state the project does not boot into — the studio replays a setup script after every load (${setupLabel(setup)})${verified}. Register the facets' views against THAT state (the account, the data set, the screen the goal names), and keep the way a person reaches it working — do not change what the project boots into.`;
}
