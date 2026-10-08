/** The build turn — interrupted by a steer or wound down by the clock, retried after a provider outage — and a turn that was stopped on purpose. */
import { roleEffort, RoleKey } from "../../model-roles.ts";
import { buildTurn } from "../../build-turn.ts";
import { isResumeFailure } from "../../chat-session.ts";
import { EngineFailure, isTransientProviderError, outageDelays, StopReason } from "../../outage.ts";
import { isCommit } from "../../shell.ts";
import { resetClean } from "../../git.ts";
import { RunEvent } from "../../run-events.ts";
import { MINUTE_MS, SECOND_MS } from "../../time.ts";
import { CLIP_DETAIL, CLIP_REASON } from "../../text.ts";
import type { AnyRecord } from "../../../types/harness.d.ts";
import { STUDIO_CONTRACT, type FacetLoop, type FacetRound } from "../state.ts";
import { RoundFlow, stoppedByUser } from "../flow.ts";
import { steerPrompt, WIND_DOWN_ASK } from "../prompt.ts";
import { OutagePhase, roundFields } from "../record.ts";
import { facetPromptFor } from "./brief.ts";

/**
 * How a delegated build turn failed, beside the engine's own failure kinds: the clock cut it
 * (its edits are still judged as a partial), or the engine gave up on it.
 */
export const BuildFailure = {
  Deadline: "deadline",
  DelegateFailed: "delegate_failed",
} as const;
export type BuildFailure = (typeof BuildFailure)[keyof typeof BuildFailure];

/** A wind-down is asked for only when the verdict's own time and this much more are still left. */
const WIND_DOWN_SLACK_MS = MINUTE_MS;

/** The build turn — interrupted by a steer or wound down by the clock, retried after a provider outage — and a turn that was stopped on purpose. */
export async function buildChallenger(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { ctx, deadline, delegated, extraReadRoots, facet, run, spikeRoots, stoppedHere } = loop;
  // ── build ──
  round.buildFailed = null;
  round.buildEngineError = null;
  round.shotDirs = [...new Set(round.acceptedShots.map((p: string) => p.slice(0, p.lastIndexOf("/"))))];
  round.extraReads = [...new Set([...extraReadRoots, ...round.shotDirs, ...spikeRoots])];
  /** The build turn's own fields, whichever kind of engine takes it. */
  round.turnOf = (text: string) => turnFields(loop, text);
  round.delegate = (
    text: string,
    resume: string | null | undefined,
    timeoutMs: number,
    images: AnyRecord[] | null = null,
  ) => delegateTurn(loop, round, { text, resume, timeoutMs, images });
  round.buildStartedAt = Date.now();
  round.buildEndedAt = null;
  try {
    if (delegated) await delegatedBuild(loop, round);
    else
      await buildTurn(ctx, {
        ...round.turnOf(round.prompt),
        delegated: false,
        metadata: { runId: run.runId, facetId: facet.id, iteration: round.iteration, phase: "build" },
        deadlineMs: deadline,
      });
  } catch (err: any) {
    round.buildFailed = err?.message ?? String(err);
    round.buildEngineError = typeof err?.kind === "string" && err.kind !== EngineFailure.Aborted ? err : null;
  }
  round.buildEndedAt = Date.now();
  if (ctx.cancelled) return stoppedByUser(loop);
  const retried = await waitOutProviderOutage(loop, round);
  if (retried) return retried;
  if (!round.buildFailed) loop.outageRetries = 0;

  // ── stopped on purpose is not a lost round ──
  // "stopped" is the engine's word for "somebody aborted this worktree", and the only
  // somebody who can is the run — the director pulling a worker off, or the user through it.
  // The turn ended mid-edit, so there is nothing here to judge: an evidence pass would
  // photograph a half-written project, the verdict would read "broken", the circuit breaker
  // would take a strike for it, and the rollback would erase work nobody asked to lose. One
  // night lost four first-round iterations exactly that way and told the owner they had
  // stopped them. Instead: commit what is on disk, keep it on the round's `…-stopped` ref, leave
  // the worktree standing, record the round as `stopped`, and end the facet.
  if (round.buildEngineError?.stopReason === StopReason.Stopped) {
    await stoppedHere(round.iteration, true);
    return RoundFlow.Stop;
  }
}

/** The build turn's own fields, whichever kind of engine takes it. */
function turnFields(loop: FacetLoop, text: string): AnyRecord {
  const { engineId, facetThreadId, run } = loop;
  const effort = roleEffort(run, RoleKey.Builder);
  return {
    engine: engineId,
    prompt: text,
    project: run.project,
    threadId: facetThreadId,
    runId: run.runId,
    model: run.model,
    ...(effort ? { effort } : {}),
  };
}

/** One delegated turn in the builder's session (or a fresh one), never past the facet's clock. */
async function delegateTurn(
  loop: FacetLoop,
  round: FacetRound,
  {
    text,
    resume,
    timeoutMs,
    images,
  }: { text: string; resume: string | null | undefined; timeoutMs: number; images: AnyRecord[] | null },
) {
  const { ctx, deadline, worktree } = loop;
  return buildTurn(ctx, {
    ...round.turnOf(text),
    delegated: true,
    cwd: worktree,
    resume,
    timeoutMs: Math.min(timeoutMs ?? Infinity, deadline - Date.now()),
    delegation: {
      ...(round.extraReads.length ? { extraReads: round.extraReads } : {}),
      // The modeller (AG-930): a Blender grant for this worktree when the run has Blender.
      ...(worktree ? { selfCapture: selfCapture(loop, round, worktree), ownership: ownership(loop) } : {}),
      ...(images?.length ? { images } : {}),
    },
  });
}

/** What the builder's own capture tool photographs: this worktree, in the facet's setup. */
function selfCapture({ facet, facetSetup, handle, run }: FacetLoop, round: FacetRound, worktree: string): AnyRecord {
  return {
    project: run.project,
    root: worktree,
    runId: run.runId,
    facetId: facet.id,
    iteration: round.iteration,
    ...(handle ? { handle } : {}),
    ...(facetSetup ? { setup: facetSetup } : {}),
    label: facet.title ?? facet.id,
  };
}

/**
 * The seam, as the hook and the locks read it (M4.6). `template: false` says this is the user's
 * own project: no wiring block to pass through, and the build output the shape names stays
 * writable so the project's own build still runs.
 */
function ownership({ facet, ownShape, ownsMain, shape, spec }: FacetLoop): AnyRecord {
  return {
    facetId: facet.id,
    owns: spec.owns ?? [],
    ownsMain,
    ...(ownShape ? { template: false } : {}),
    ...(ownShape && shape?.serve && shape.serve !== "." ? { neverLock: [shape.serve] } : {}),
    ...(ownShape && shape?.main ? { main: shape.main, studio: STUDIO_CONTRACT } : {}),
  };
}

/**
 * The build turn, and the two things that may interrupt it. A steer that cannot wait ends the
 * turn on purpose and the same session picks it up where it left off; the clock is met by asking
 * the builder to finish tidily rather than cutting it mid-edit. Everything the builder had read
 * is still in that session, so neither costs the round.
 */
async function delegatedBuild(loop: FacetLoop, round: FacetRound): Promise<void> {
  const { ctx, deadline, result, windDownMs } = loop;
  let delegation: AnyRecord;
  let turnPrompt = round.prompt;
  let turnImages = round.promptImages;
  // The turn gets what is left minus what this worker's own rounds have needed after it.
  let turnBudget = deadline - Date.now() - (loop.emaAfterMs ?? 0) - windDownMs;
  let woundDown = false;
  for (;;) {
    delegation = await delegateResuming(loop, round, { turnPrompt, turnBudget, turnImages });
    if (delegation.sessionId) {
      loop.sessionId = delegation.sessionId;
      result.sessionId = loop.sessionId;
    }
    if (delegation.ok || !loop.sessionId || ctx.cancelled) break;
    const arrived = await steerThatArrived(loop, round, delegation);
    if (arrived) {
      turnPrompt = steerPrompt(arrived);
      turnImages = null;
      turnBudget = deadline - Date.now() - (loop.emaAfterMs ?? 0) - windDownMs;
      continue;
    }
    // The clock, met with a tidy ending instead of a cut. One wind-down per round: if the
    // builder cannot stop within it, what is on disk is judged as a partial, as before.
    if (!woundDown && mayWindDown(loop, delegation)) {
      woundDown = true;
      await loop.appendRun(RunEvent.FacetWindDown, {
        ...roundFields(loop, round.iteration),
        minutesLeft: Math.round((deadline - Date.now()) / MINUTE_MS),
      });
      turnPrompt = WIND_DOWN_ASK;
      turnImages = null;
      turnBudget = windDownMs;
      continue;
    }
    break;
  }
  if (!delegation.ok) noteFailedDelegation(loop, round, delegation);
}

/** One turn in the builder's session; a vanished session (compacted away, expired) costs a fresh start, not the iteration. */
async function delegateResuming(
  loop: FacetLoop,
  round: FacetRound,
  { turnPrompt, turnBudget, turnImages }: { turnPrompt: string; turnBudget: number; turnImages: AnyRecord[] | null },
): Promise<AnyRecord> {
  try {
    return await round.delegate(turnPrompt, loop.sessionId, turnBudget, turnImages);
  } catch (err: any) {
    if (!loop.sessionId || !isResumeFailure(err)) throw err;
    await loop.appendRun(RunEvent.FacetSessionReset, {
      ...roundFields(loop, round.iteration),
      reason: String(err?.message ?? err).slice(0, CLIP_DETAIL),
    });
    loop.sessionId = null;
    // A fresh session is given the whole prompt again (the move, never THE FIX: this prompt never carried it).
    const fresh = facetPromptFor(loop, round, { resumed: false });
    return round.delegate(fresh, null, turnBudget, round.promptImages);
  }
}

/**
 * Steering that could not wait: somebody interrupted this turn to hand the builder an
 * instruction. Nobody has asked it to stop, so this is not the end of the round — the steer goes
 * in front of everything and the same session carries on. Null when this was no steer.
 */
async function steerThatArrived(loop: FacetLoop, round: FacetRound, delegation: AnyRecord): Promise<unknown[] | null> {
  const { appendRun, ctx, finishRequested, steering } = loop;
  if (delegation.stopReason !== StopReason.Stopped) return null;
  if (await finishRequested(loop.iterationsThisRound).catch(() => false)) return null;
  const arrived = (await steering()).filter(Boolean);
  // The stop may have landed while that was in flight: a user's stop aborts the turn
  // the same way a steer does, and it must never be answered with another one.
  if (!arrived.length || ctx.cancelled) return null;
  round.userSteering.push(...arrived);
  await appendRun(RunEvent.FacetSteered, {
    ...roundFields(loop, round.iteration),
    texts: arrived.map((t: unknown) => String(t).slice(0, CLIP_REASON)),
    delivered: "mid-round",
  });
  return arrived;
}

/** The clock cut the turn, and there is still time for the builder to end it tidily before the verdict needs the rest. */
function mayWindDown(loop: FacetLoop, delegation: AnyRecord): boolean {
  if (delegation.stopReason !== StopReason.Deadline) return false;
  return loop.deadline - Date.now() > (loop.emaAfterMs ?? 0) + WIND_DOWN_SLACK_MS;
}

/**
 * A delegated turn that did not finish. The engine's own word for how the turn ended travels with
 * the failure: "stopped" means somebody aborted this worktree on purpose, and that is not a
 * broken build.
 */
function noteFailedDelegation(loop: FacetLoop, round: FacetRound, delegation: AnyRecord): void {
  round.buildFailed = delegation.errorText || delegation.stopReason || "delegated build did not finish";
  round.buildEngineError = {
    kind: delegation.stopReason === StopReason.Deadline ? BuildFailure.Deadline : BuildFailure.DelegateFailed,
    stopReason: delegation.stopReason ?? null,
  };
  const overflowed = /context/i.test(round.buildFailed) && /overflow|too long|exceed/i.test(round.buildFailed);
  if (overflowed) loop.sessionId = null;
}

/**
 * A provider hiccup (529 Overloaded, 500, a dropped socket) is weather: the half-written
 * attempt is rolled back, the loop waits, and the SAME iteration is tried again. It is never a
 * "broken build with the same cause" — that policy tripped four circuit breakers in one outage
 * on the village run. Null when the failure was no outage, or no wait is left.
 */
async function waitOutProviderOutage(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { appendRun, ctx, deadline, facet, gitOptions, gitWhere, run, sleepFor, worktree } = loop;
  if (!round.buildFailed || ctx.cancelled) return null;
  const kind = round.buildEngineError?.kind;
  if (!isTransientProviderError(kind ? { kind, message: round.buildFailed } : round.buildFailed)) return null;
  const wait = outageDelays(run)[loop.outageRetries];
  if (wait === undefined || Date.now() + wait >= deadline) return null;
  loop.outageRetries += 1;
  await appendRun(RunEvent.FacetProviderOutage, {
    ...roundFields(loop, round.iteration),
    phase: OutagePhase.Build,
    wait,
    attempt: loop.outageRetries,
    error: String(round.buildFailed).slice(0, CLIP_REASON),
  });
  ctx.setStatus(
    `run ${run.runId} · ${facet.title} — provider overloaded, retrying in ${Math.round(wait / SECOND_MS)}s`,
  );
  if (worktree)
    await resetClean(ctx, gitWhere, isCommit(loop.incumbentCommit) ? loop.incumbentCommit : null, {
      ...gitOptions,
      bestEffort: true,
    });
  await sleepFor(wait);
  if (ctx.cancelled) return stoppedByUser(loop);
  round.iteration -= 1;
  loop.iterationsThisRound -= 1;
  return RoundFlow.Next;
}
