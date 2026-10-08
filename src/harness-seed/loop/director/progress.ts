import { updateRef } from "../git.ts";
import { runRef } from "../repo.ts";
/** Local, recoverable progress; a checkpoint never implies landing or publication. */
import { GoalStatus } from "./goals.ts";
import { MINUTE_MS } from "../time.ts";
import type { GoalLedger } from "./goals.ts";
import type { Night } from "./night.ts";

const SOFT_REVIEW_MS = 30 * MINUTE_MS;

/** Independently verified requirements at one immutable integration revision. */
export interface PlayableCheckpoint {
  head: string;
  at: number;
  verifiedGoals: string[];
  requiredGoals: number;
}

/** Preserve the first verified milestone and the newest recoverable one without rewriting a project. */
export async function keepCheckpoint(night: Night, head: string): Promise<void> {
  const goals = night.state.goals;
  if (!goals) return;
  const verifiedGoals = goals.entries
    .filter((goal) => goal.head === head && goal.status === GoalStatus.Passed)
    .map((goal) => goal.id);
  if (!verifiedGoals.length) return;
  await updateRef(night.ctx, { project: night.run.project }, runRef(night.run.runId, "checkpoints", head), head);
  const checkpoint: PlayableCheckpoint = {
    head,
    at: Date.now(),
    verifiedGoals,
    requiredGoals: goals.entries.filter((goal) => goal.required).length,
  };
  const director = night.journal.director;
  const first = !director.firstVerifiedCheckpoint;
  director.firstVerifiedCheckpoint ??= checkpoint;
  director.latestVerifiedCheckpoint = checkpoint;
  night.report.firstVerifiedCheckpoint = director.firstVerifiedCheckpoint;
  night.report.latestVerifiedCheckpoint = checkpoint;
  if (first)
    await night.decision(
      `Verified checkpoint ${head}: ${verifiedGoals.join(", ")}. Remaining requirements are not yet verified.`,
      "A verified checkpoint is saved. You can ask to show this build now; Stop keeps it recoverable without overwriting your project.",
    );
  await night.saveJournal();
}

/** A soft review informs the user once; it never cancels healthy required work. */
export function progressReview(
  ledger: GoalLedger,
  head: string | null,
  elapsedMs: number,
  reviewed: boolean,
): string | null {
  if (reviewed || elapsedMs < SOFT_REVIEW_MS) return null;
  const verified = ledger.entries.filter((goal) => goal.status === GoalStatus.Passed && goal.head === head);
  const blocked = ledger.entries.filter((goal) => goal.status === GoalStatus.Blocked);
  const blockers = blocked.map((goal) => `${goal.id}: ${goal.blocker}`).join("; ");
  return `Build review: ${verified.length}/${ledger.entries.length} outcomes verified on the current revision.${blockers ? ` Blocked: ${blockers}.` : " Required work continues."} Saved checkpoints remain recoverable.`;
}

/** Durable review state survives Resume, so a paused run does not repeat its milestone. */
export async function reviewProgress(night: Night, now: number): Promise<void> {
  const ledger = night.state.goals;
  if (!ledger) return;
  const director = night.journal.director;
  const text = progressReview(
    ledger,
    night.state.integrationHead,
    now - night.started,
    director.softReviewAt !== undefined,
  );
  if (!text) return;
  director.softReviewAt = now;
  await night.decision(text, text);
  await night.saveJournal();
}
