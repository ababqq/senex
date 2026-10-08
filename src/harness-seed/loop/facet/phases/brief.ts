/** The brief (`.studio/BRIEF.md` in the worktree) and the prompt that points at it. */
import { renderLiveness } from "../../judge.ts";
import { checksFromDefects, recipesForChecks, renderBrief, writeWorktreeBrief } from "../../library.ts";
import type { AnyRecord } from "../../../types/harness.d.ts";
import type { FacetLoop, FacetRound } from "../state.ts";
import type { RoundFlow } from "../flow.ts";
import { pinFixRecipe } from "../rules.ts";
import { briefWithMovedSections, facetPrompt, promptImagesFor } from "../prompt.ts";

/** A template project's entry module, when the shape names none. */
const DEFAULT_ENTRY = "src/main.js";

/** The brief (`.studio/BRIEF.md` in the worktree) and the prompt that points at it. */
export async function writeBrief(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { baseShots, delegated, ownShape, ownsMain, run, shape, spec, workdir } = loop;
  // ── the brief: `.studio/BRIEF.md` in the worktree, plus the prompt that points at it ──
  pickRecipes(loop, round);
  round.briefText = renderBrief(briefInput(loop, round));
  // The four sections the prompt no longer renders for a delegated engine (M4.8b) live here.
  round.brief = briefWithMovedSections(round.briefText, {
    spec,
    ownsMain,
    ownShape,
    entryMain: shape?.main ?? DEFAULT_ENTRY,
    build: shape?.build ?? null,
  });
  round.briefFile = workdir ? await writeWorktreeBrief(workdir, round.brief).catch(() => null) : null;
  round.acceptedShots = (loop.incumbentEvidence?.shots ?? []).map((shot: AnyRecord) => shot.path).filter(Boolean);
  // Stills into the prompt (WP3d): every reference still plus the base build's frames on the
  // first iteration; later, one reference|build pair per camera — only when a style or
  // vision check is failing or the last build lost (context cost otherwise).
  round.promptImages = promptImagesFor({
    run,
    spec,
    iteration: round.iteration,
    board: loop.board,
    loseStreak: loop.loseStreak,
    baseShots,
    incumbentEvidence: loop.incumbentEvidence,
    pairs: loop.lastPairs,
  });
  round.prompt = facetPromptFor(loop, round, {
    resumed: Boolean(loop.sessionId),
    briefText: delegated ? null : round.brief,
    fix: loop.currentFix,
  });
}

/**
 * The recipes the brief injects: retrieved for the failing and unscored checks and, beside
 * retrieval by check id, from prose — the fix's own sentence pulls its recipe into "Recipes
 * that apply", which is where THE FIX's line says it is.
 */
function pickRecipes(loop: FacetLoop, round: FacetRound): void {
  const { run, spec } = loop;
  round.failingChecks = Object.values(loop.board)
    .filter((e) => e.pass === false)
    .map((e) => spec.checks.find((c) => c.id === e.id) ?? e);
  round.unscored = Object.keys(loop.board).length === 0 ? spec.checks : [];
  round.fixDefects = loop.currentFix ? checksFromDefects([loop.currentFix.what], { limit: 1 }) : [];
  round.injected = recipesForChecks(
    loop.recipes,
    [...round.failingChecks, ...round.unscored, ...round.fixDefects],
    undefined,
    { project: run.project },
  );
  round.injectedWithFix = pinFixRecipe(round.injected, loop.currentFix, round.fixDefects[0]?.id ?? null);
}

/** Everything `renderBrief` renders: the contract, the board, the last attempts, the recipes and this round's move and fix. */
function briefInput(loop: FacetLoop, round: FacetRound) {
  const { critic, app: app, lessons, ownShape, ownsMain, result, run, shape, spec } = loop;
  const last = result.attempts.at(-1);
  return {
    run,
    spec,
    iteration: round.iteration,
    screen: !ownShape,
    // Which world this worker is in (M4.6): the studio's template, or a project the user
    // brought. The brief's determinism, one-input-path and materials lines are the
    // template's rules and are not asked of somebody's own project.
    template: !ownShape,
    ownsMain,
    entryMain: shape?.main ?? DEFAULT_ENTRY,
    ownShape,
    build: shape?.build ?? null,
    critic,
    app: app,
    board: loop.board,
    comparison: last?.iteration === round.iteration - 1 ? { flips: last.flips, regressions: last.regressions } : null,
    attempts: result.attempts,
    recipes: round.injectedWithFix,
    spike: round.spikeText,
    steering: round.userSteering,
    integration: loop.integrationNote,
    resumed: Boolean(loop.sessionId),
    defects: loop.defectList,
    polish: loop.polishList,
    style: styleInput(loop),
    flags: loop.flags,
    lessons,
    // What earlier nights on this project cost. The director loads them once and hangs them on
    // the run so every worker's BRIEF.md carries the same five (loop/ledger.ts).
    projectLessons: run.projectLessons ?? [],
    move: loop.currentMove,
    fix: loop.currentFix,
    liveness: loop.lastLiveness ? renderLiveness(loop.lastLiveness) : null,
  };
}

/** The brief's "distance to the references": the accepted build's shots against the references, when there are both. */
function styleInput(loop: FacetLoop): AnyRecord | null {
  const { references } = loop;
  if (!references.length || !loop.incumbentEvidence) return null;
  return {
    shots: loop.incumbentEvidence.shots,
    references,
    previous: loop.lastStyle?.previous ?? [],
    pairs: loop.lastPairs.map((p) => ({ camera: p.camera, path: p.path })),
  };
}

/** The build prompt for this round, as `facetPrompt` renders it from the loop's state. */
export function facetPromptFor(
  loop: FacetLoop,
  round: FacetRound,
  { resumed, briefText = null, fix = null }: { resumed: boolean; briefText?: string | null; fix?: AnyRecord | null },
): string {
  const { app: app, gapHistory, legacy, ownShape, ownsMain, result, run, shape, spec, worktree } = loop;
  return facetPrompt({
    shape,
    ownShape,
    app: app,
    run,
    spec,
    iteration: round.iteration,
    resumed,
    briefFile: round.briefFile,
    briefText,
    board: loop.board,
    lastAttempt: result.attempts.at(-1) ?? null,
    lastFailure: loop.lastFailure,
    loseStreak: loop.loseStreak,
    gapHistory,
    defectList: loop.defectList,
    worktree,
    userSteering: round.userSteering,
    acceptedShots: round.acceptedShots,
    ownsMain,
    spike: round.spikeText,
    integrationNote: loop.integrationNote,
    legacy,
    imagesAttached: round.promptImages.length,
    move: loop.currentMove,
    fix,
  });
}
