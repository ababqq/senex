/**
 * THE PROBE BUDGET: a probe must always write its evidence inside the grader's deadline, whatever the
 * page does. A slow page (a main thread busy for seconds, screenshots timing out) once took a probe
 * past the grader's deadline twice and left NO evidence, less than a project that crashed in ten seconds.
 *
 * Three rules, pure and clock-injected so the shape replays as a test:
 *   1. The budget is four soaks minus a fixed readout margin, but never less than the soak itself
 *      plus what the phases around it need (the pre-soak allowance, the look and teardown
 *      reserves): four soaks minus the margin is nothing for a soak of 30 s, which used to leave a
 *      deliberately short soak at 0 s. The floor only matters for soaks under about three minutes;
 *      the spec's five-minute soak keeps 1 080 s.
 *   2. Optional work is skipped when the budget cannot hold it plus the soak plus the teardown
 *      reserve (the look phase first), and the soak is SHORTENED rather than run past the deadline.
 *   3. A page whose page-side calls (reads, screenshots, inputs) wait out their full timeout three
 *      times in a row is UNRESPONSIVE for the rest of the run: every later call gets a short ceiling.
 *      It does not un-trip on a later success.
 */
import { SECOND_MS } from "../../../src/shared/duration.ts";

/** Four-soak work budget, excluding the grader's additional delivery grace. */
export const PROBE_DEADLINE_FACTOR = 4;
/** What the probe keeps below the grader's deadline for the readout, the video and the evidence write. */
export const PROBE_BUDGET_MARGIN_MS = 120 * SECOND_MS;
/** What every phase leaves for the readout after the soak. */
export const TEARDOWN_RESERVE_MS = 90 * SECOND_MS;
/** What the look phase may cost on a slow page. */
export const LOOK_RESERVE_MS = 90 * SECOND_MS;
/** What the phases before the soak (boot, baselines, entrance, bursts, directions, ack, interact) may take, for the budget floor. */
export const PRE_SOAK_ALLOWANCE_MS = 180 * SECOND_MS;
/** The soak is not worth running under this; the survives check is unknown either way. */
export const MIN_SOAK_MS = 30 * SECOND_MS;
/** A page-side read's ceiling, and its ceiling once the page is unresponsive. */
export const EVAL_TIMEOUT_MS = 10 * SECOND_MS;
export const EVAL_TIMEOUT_FAST_MS = 2.5 * SECOND_MS;
/** An input's or screenshot's ceiling, and its ceiling once the page is unresponsive. */
export const ACT_TIMEOUT_MS = 15 * SECOND_MS;
export const ACT_TIMEOUT_FAST_MS = 4 * SECOND_MS;
/** Consecutive timed-out calls that mark the page unresponsive. */
export const UNRESPONSIVE_STREAK = 3;

const seconds = (ms: number) => Math.round(ms / SECOND_MS);

/** The whole probe's budget for a soak of `soakMs`: four soaks less the margin, floored so the soak and its phases fit (rule 1). */
export function probeBudgetMs(soakMs: number): number {
  const floor = soakMs + PRE_SOAK_ALLOWANCE_MS + LOOK_RESERVE_MS + TEARDOWN_RESERVE_MS;
  return Math.max(soakMs * PROBE_DEADLINE_FACTOR - PROBE_BUDGET_MARGIN_MS, floor);
}

/** How long the soak runs, and by how much the budget shortened it. */
export interface SoakPlan {
  readonly soakMs: number;
  /** How much the budget took off the configured soak; 0 when it fit. */
  readonly shortenedByMs: number;
  readonly why: string | null;
}

/** How long the soak may run given what is left, keeping the teardown reserve. */
export function planSoak(budgetLeftMs: number, soakMs: number): SoakPlan {
  const room = Math.max(0, budgetLeftMs - TEARDOWN_RESERVE_MS);
  if (room >= soakMs) return { soakMs, shortenedByMs: 0, why: null };
  const planned = Math.max(0, Math.min(soakMs, room));
  return {
    soakMs: planned,
    shortenedByMs: soakMs - planned,
    why: `the probe budget had ${seconds(budgetLeftMs)}s left with ${seconds(TEARDOWN_RESERVE_MS)}s reserved for the readout, so the ${seconds(soakMs)}s soak ran ${seconds(planned)}s`,
  };
}

/** Whether the look phase runs. */
export interface LookPlan {
  readonly run: boolean;
  readonly why: string | null;
}

/** Whether the look phase may run: it is the first thing dropped on a slow page. */
export function shouldRunLook(budgetLeftMs: number, soakMs: number, unresponsive: boolean): LookPlan {
  if (unresponsive) {
    return {
      run: false,
      why: "the page was unresponsive (three page-side reads in a row waited out their timeout), and the look phase is a camera read around every one of sixteen steps",
    };
  }
  const needed = LOOK_RESERVE_MS + soakMs + TEARDOWN_RESERVE_MS;
  if (budgetLeftMs >= needed) return { run: true, why: null };
  return {
    run: false,
    why: `the probe budget had ${seconds(budgetLeftMs)}s left and the look phase, the ${seconds(soakMs)}s soak and the ${seconds(TEARDOWN_RESERVE_MS)}s readout reserve need ${seconds(needed)}s`,
  };
}

/** The running record of page-side calls that waited out their timeout. */
export interface Responsiveness {
  /** Consecutive page-side calls (reads, screenshots, inputs) that waited out their timeout. */
  streak: number;
  timeouts: number;
  reads: number;
  unresponsiveAtMs: number | null;
}

/** A fresh responsiveness record. */
export function createResponsiveness(): Responsiveness {
  return { streak: 0, timeouts: 0, reads: 0, unresponsiveAtMs: null };
}

/** Record one page-side call; `ok` is false when it waited out its timeout. */
export function recordRead(r: Responsiveness, ok: boolean, nowMs: number): void {
  r.reads++;
  if (ok) {
    r.streak = 0;
    return;
  }
  r.timeouts++;
  r.streak++;
  if (r.streak >= UNRESPONSIVE_STREAK && r.unresponsiveAtMs === null) r.unresponsiveAtMs = nowMs;
}

/** Whether the page has been marked unresponsive. */
export function isUnresponsive(r: Responsiveness): boolean {
  return r.unresponsiveAtMs !== null;
}

/** The ceiling for the next page-side read. */
export function evalTimeoutFor(r: Responsiveness): number {
  return isUnresponsive(r) ? EVAL_TIMEOUT_FAST_MS : EVAL_TIMEOUT_MS;
}

/** The ceiling for the next input or screenshot. */
export function actTimeoutFor(r: Responsiveness): number {
  return isUnresponsive(r) ? ACT_TIMEOUT_FAST_MS : ACT_TIMEOUT_MS;
}

/** What the budget decided, for the scorecard. */
export interface BudgetSummary {
  readonly budgetMs: number;
  readonly usedMs: number;
  readonly soakPlannedMs: number;
  readonly soakShortenedByMs: number;
  readonly lookSkippedWhy: string | null;
  readonly responsiveness: {
    readonly reads: number;
    readonly timeouts: number;
    readonly unresponsiveAtMs: number | null;
  };
}

/** One sentence for the scorecard note; null when the budget changed nothing. */
export function budgetSentence(b: BudgetSummary): string | null {
  const parts: string[] = [];
  const { responsiveness: r } = b;
  if (r.unresponsiveAtMs !== null) {
    parts.push(
      `the page was marked unresponsive at ${Math.round(r.unresponsiveAtMs)}ms (${r.timeouts} of ${r.reads} page-side reads waited out their timeout), so every later read ran under a ${EVAL_TIMEOUT_FAST_MS / SECOND_MS}s ceiling and every input under ${ACT_TIMEOUT_FAST_MS / SECOND_MS}s`,
    );
  }
  if (b.lookSkippedWhy) parts.push(`the look phase was skipped: ${b.lookSkippedWhy}`);
  if (b.soakShortenedByMs > 0) {
    parts.push(
      `the soak was shortened by ${seconds(b.soakShortenedByMs)}s to stay inside the ${seconds(b.budgetMs)}s probe budget`,
    );
  }
  if (parts.length === 0) return null;
  return `Probe budget: ${parts.join("; ")}. A row that is unknown because of this says so in its own detail; none of it is a verdict on the project.`;
}
