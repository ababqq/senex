/** The round's gate and opening, continuous integration, and the re-baseline it may call for. */
import { gatherEvidence } from "../../evidence.ts";
import { isMeasured, runDeterministicChecks, toScoreboard } from "../../checks.ts";
import { demosNamedByChecks } from "../../spec.ts";
import { unionMergeMain } from "../../merge.ts";
import { isCommit } from "../../shell.ts";
import { GIT, isAncestor, mergeNoFf, shortSha } from "../../git.ts";
import { GIT_TIMEOUT_MS } from "../../config.ts";
import { StopCode, stopWith } from "../../outcomes.ts";
import { RunEvent } from "../../run-events.ts";
import { HostMethod } from "../../host-methods.ts";
import { CLIP_REASON } from "../../text.ts";
import type { Scoreboard } from "../../checks.ts";
import type { FacetLoop, FacetRound } from "../state.ts";
import { RoundFlow } from "../flow.ts";
import { stopSignal, tooLateToStart } from "../rules.ts";
import { MOTION_FRAMES } from "../policy.ts";
import { roundFields } from "../record.ts";

/** The round's gate — a stop, the clock, a round that would not fit, fair share — and its opening: the status, the event, the user's steering. */
export async function openRound(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { appendRun, ctx, deadline, facet, finishRequested, result, roundEstimate, run, steering } = loop;
  if (ctx.cancelled) {
    stopWith(result, StopCode.UserStop, "stopped by the user");
    return RoundFlow.Stop;
  }
  round.finishing = stopSignal(await finishRequested(loop.iterationsThisRound));
  if (round.finishing) {
    stopWith(result, StopCode.FinishRequested, round.finishing.reason);
    return RoundFlow.Stop;
  }
  if (Date.now() > deadline) {
    stopWith(result, StopCode.Budget, "facet budget exhausted");
    return RoundFlow.Stop;
  }
  // Enough time for a whole round, not merely to begin one. A round this worker cannot finish
  // is worth less than the accepted build it already has: the turn is cut mid-edit, the judge
  // sees half a project, and the round is lost. Stopping here keeps what it made and says so.
  round.tooLate = tooLateToStart({ leftMs: deadline - Date.now(), ...roundEstimate() });
  if (round.tooLate) {
    stopWith(result, StopCode.TooLate, round.tooLate);
    return RoundFlow.Stop;
  }
  // Fair share (WP6): a facet at its round cap steps aside while others are still waiting
  // for a slot; it returns with everything it needs to continue where it stopped.
  if (yieldsNow(loop)) {
    result.yielded = true;
    stopWith(
      result,
      StopCode.Yielded,
      `yielded after ${loop.iterationsThisRound} iterations this round (other facets waiting)`,
    );
    return RoundFlow.Stop;
  }
  loop.iterationsThisRound += 1;
  result.iterations = round.iteration;
  round.iterationId = String(round.iteration).padStart(3, "0");
  ctx.setStatus(`run ${run.runId} · ${facet.title} — iteration ${round.iteration}`);
  await appendRun(RunEvent.FacetBuildStarted, {
    runId: run.runId,
    facetId: facet.id,
    facetTitle: facet.title,
    iteration: round.iteration,
    deadlineMs: deadline,
  });
  round.userSteering = (await steering()).filter(Boolean);
}

/** Fair share (WP6): has this facet played its round cap while other facets wait for a slot? */
function yieldsNow({ softCap, shouldYield, iterationsThisRound }: FacetLoop): boolean {
  if (!softCap || iterationsThisRound < softCap) return false;
  return typeof shouldYield === "function" && shouldYield();
}

/** Continuous integration: take the other facets' accepted work at the round's boundary (a union merge on the wiring block, else a note for the builder). */
export async function takeIntegration(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { ctx, gitOptions, gitWhere, integration, worktree } = loop;
  loop.integrationNote = null;
  round.notedHead = null;
  round.rebaseline = false;
  if (!worktree || !integration?.head) return;
  const head = await integration.head().catch(() => null);
  const isNews = isCommit(head) && head !== loop.mergedIntegration && head !== loop.incumbentCommit;
  if (!isNews) return;
  if (await isAncestor(ctx, gitWhere, head, gitOptions)) {
    loop.mergedIntegration = head;
    return;
  }
  await mergeIntegration(loop, round, head, worktree);
}

/**
 * Merge the integration head into the worktree. A conflict on the wiring block alone is resolved
 * by union merge (WP1c); anything else is aborted and handed to the builder as before.
 */
async function mergeIntegration(loop: FacetLoop, round: FacetRound, head: string, worktree: string): Promise<void> {
  const { appendRun, ctx, facet, git, gitOptions, gitWhere, ownShape, shape } = loop;
  const merge = await mergeNoFf(ctx, gitWhere, head, {
    message: `facet ${facet.id}: take integration ${shortSha(head)}`,
    noEdit: true,
    fastForward: true,
    label: gitOptions.label,
    timeoutMs: gitOptions.timeoutMs,
    failure: gitOptions.failure,
    rpcErrors: "fail",
    cleanupLabel: gitOptions.label,
    resolve: () =>
      unionMergeMain(
        (command) =>
          ctx.call(HostMethod.RunExec, {
            command,
            cwd: worktree,
            timeoutMs: GIT_TIMEOUT_MS.quick,
            label: `facet:${facet.id}:union-merge`,
          }),
        {
          message: `facet ${facet.id}: take integration ${shortSha(head)} (union on FACET WIRING)`,
          wiring: !ownShape,
          ...(ownShape && shape?.main ? { main: shape.main } : {}),
        },
      ),
  });
  const merged = { ...roundFields(loop, round.iteration), head };
  if (!merge.ok) {
    round.notedHead = head;
    loop.integrationNote = `Other facets' accepted work is on commit ${head}. Your worktree could not merge it automatically (${merge.resolved?.reason}). FIRST run \`git merge ${head}\`, resolve the conflicts keeping both sides' work (yours and theirs), and commit the merge — then continue with your own checks.`;
    await appendRun(RunEvent.IntegrationMerge, {
      ...merged,
      conflict: true,
      error: String(merge.error).slice(0, CLIP_REASON),
    });
    return;
  }
  loop.incumbentCommit = await git(GIT.head);
  loop.mergedIntegration = head;
  const union = merge.union ? { union: true, duplicates: merge.resolved.duplicates ?? 0 } : {};
  await appendRun(RunEvent.IntegrationMerge, { ...merged, conflict: false, ...union });
  round.rebaseline = true;
}

/** Re-baseline: the incumbent just changed under this facet, so its evidence and board are looked at again once. */
export async function rebaselineIncumbent(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { legacy, previewLock, worktree } = loop;
  // ── re-baseline (director, 2026-09-07): the incumbent just changed under this facet ──
  // Other facets' work is in the worktree now; the accepted evidence and board predate it.
  // Judged against stale evidence, a regression they caused would be this facet's loss and
  // a fix they landed would be this facet's flip. Look at the merged incumbent once.
  const needsLook = round.rebaseline && !legacy && loop.incumbentEvidence;
  if (!needsLook || !worktree) return;
  const release = await previewLock();
  try {
    await lookAtMergedIncumbent(loop, round, worktree);
  } catch {
    /* a failed re-look keeps the old baseline; the next verdict is at worst the old unfairness */
  } finally {
    release();
  }
}

/** One evidence pass over the merged incumbent, and its measured checks laid over the board. */
async function lookAtMergedIncumbent(loop: FacetLoop, round: FacetRound, worktree: string): Promise<void> {
  const { appendRun, ctx, facet, facetSetup, handle, references, run, seed, spec } = loop;
  const merged = await gatherEvidence(ctx, {
    run,
    iterationId: `${round.iterationId}m`,
    seed,
    ...(handle ? { handle } : {}),
    root: worktree,
    labelPrefix: `facet_${facet.id}/iter_${round.iterationId}/merged-incumbent`,
    cameras: spec.cameras,
    eyes: true,
    motion: MOTION_FRAMES,
    audio: true,
    requiredDemos: demosNamedByChecks(spec.checks),
    setup: facetSetup,
  });
  if (!merged.ok) return;
  loop.incumbentEvidence = merged;
  const { results } = await runDeterministicChecks(ctx, { spec, evidence: merged, diffs: {}, handle, references });
  const rescored = Object.values(toScoreboard(results)).filter((entry) => isMeasured(entry));
  const changed = rescored
    .filter((entry) => isMeasured(loop.board[entry.id]) && loop.board[entry.id].pass !== entry.pass)
    .map((entry) => entry.id);
  const measured: Scoreboard = Object.fromEntries(rescored.map((entry) => [entry.id, entry]));
  loop.board = { ...loop.board, ...measured };
  await appendRun(RunEvent.FacetRebaselined, {
    ...roundFields(loop, round.iteration),
    head: loop.mergedIntegration,
    changed,
  });
}
