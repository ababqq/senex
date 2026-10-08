/**
 * THE CAPTURE BREAKER: a screenshot path that keeps failing must stop costing the probe its wall
 * clock. On a slow page every screenshot once died on its 15 s timeout, a retry paid a second 15 s,
 * and the grader abandoned the probe with no evidence written.
 *
 * A circuit breaker per capture KIND plus one time budget over all kinds, and every skip is counted:
 *   - `CAPTURE_FAILURE_STREAK` consecutive failures of one kind SUSPEND it. While suspended it is
 *     tried once per `CAPTURE_RETRY_EVERY_MS` (a short "probe" attempt); a success re-arms it fully.
 *   - `CAPTURE_TIME_BUDGET_MS` bounds the wall clock spent INSIDE failed shots over the whole probe.
 *     Past it every kind is on the probe cadence, whatever its own streak.
 * Pure and clock-injected so the measured shape replays as a test.
 */
import { MINUTE_MS, SECOND_MS } from "../../../src/shared/duration.ts";
import { ShotKind } from "./types.ts";

/** Consecutive failures of one kind that suspend it. */
export const CAPTURE_FAILURE_STREAK = 3;
/** How often a suspended kind is probed: recovery is rare and not urgent. */
export const CAPTURE_RETRY_EVERY_MS = 2 * MINUTE_MS;
/** The short ceiling a probe attempt runs under. */
export const CAPTURE_PROBE_TIMEOUT_MS = 5 * SECOND_MS;
/** Wall clock the probe may spend inside failed shots before every kind is gated. */
export const CAPTURE_TIME_BUDGET_MS = 4 * MINUTE_MS;

const KINDS: readonly ShotKind[] = Object.values(ShotKind);

type PerKind<T> = Record<ShotKind, T>;

const perKind = <T>(value: T): PerKind<T> => ({
  [ShotKind.Page]: value,
  [ShotKind.Element]: value,
  [ShotKind.Canvas]: value,
});

/** The breaker's mutable state. */
export interface CaptureBreakerState {
  streak: PerKind<number>;
  suspendedAtMs: PerKind<number | null>;
  lastProbeAtMs: PerKind<number | null>;
  skipped: PerKind<number>;
  probes: PerKind<number>;
  /** Wall clock spent inside shots that FAILED, over the whole probe. */
  failedTimeMs: number;
  budgetExhaustedAtMs: number | null;
}

/** A fresh breaker. */
export function createCaptureBreaker(): CaptureBreakerState {
  return {
    streak: perKind(0),
    suspendedAtMs: perKind<number | null>(null),
    lastProbeAtMs: perKind<number | null>(null),
    skipped: perKind(0),
    probes: perKind(0),
    failedTimeMs: 0,
    budgetExhaustedAtMs: null,
  };
}

/** Whether a shot may go out now, and under which ceiling. */
export interface AttemptDecision {
  readonly attempt: boolean;
  /** True when the attempt is the periodic probe of a suspended kind. */
  readonly probing: boolean;
  /** The ceiling this attempt runs under: short for a probe, `null` for a normal shot (the caller's own). */
  readonly timeoutMs: number | null;
  readonly why: string | null;
}

function skipReason(kind: ShotKind, exhausted: boolean): string {
  const cadence = `probed once per ${CAPTURE_RETRY_EVERY_MS / SECOND_MS}s under ${CAPTURE_PROBE_TIMEOUT_MS / SECOND_MS}s`;
  if (exhausted) {
    return `capture time budget (${CAPTURE_TIME_BUDGET_MS / SECOND_MS}s inside failed shots) is spent; ${kind} shots are ${cadence}`;
  }
  return `${kind} screenshots suspended after ${CAPTURE_FAILURE_STREAK} failures in a row; ${cadence}`;
}

/** May a shot of this kind go out now? A skip is counted on the state; the caller logs it. */
export function shouldAttempt(s: CaptureBreakerState, kind: ShotKind, nowMs: number): AttemptDecision {
  const suspended = s.suspendedAtMs[kind] !== null;
  const exhausted = s.budgetExhaustedAtMs !== null;
  if (!suspended && !exhausted) return { attempt: true, probing: false, timeoutMs: null, why: null };
  const last = s.lastProbeAtMs[kind];
  const due = last === null || nowMs - last >= CAPTURE_RETRY_EVERY_MS;
  if (!due) {
    s.skipped[kind]++;
    return { attempt: false, probing: false, timeoutMs: null, why: skipReason(kind, exhausted) };
  }
  s.lastProbeAtMs[kind] = nowMs;
  s.probes[kind]++;
  return { attempt: true, probing: true, timeoutMs: CAPTURE_PROBE_TIMEOUT_MS, why: null };
}

/** Record how a shot went. `spentMs` is the wall clock the shot took. */
export function recordShot(s: CaptureBreakerState, kind: ShotKind, ok: boolean, nowMs: number, spentMs: number): void {
  if (ok) {
    s.streak[kind] = 0;
    s.suspendedAtMs[kind] = null;
    s.lastProbeAtMs[kind] = null;
    // A success re-arms the budget gate too, but the spent time stays counted: the next failure
    // re-exhausts it at once, which is the honest reading of a page that answers one shot in four.
    s.budgetExhaustedAtMs = null;
    return;
  }
  s.streak[kind]++;
  s.failedTimeMs += Math.max(0, spentMs);
  // A suspension starts the probe clock: the first probe goes out a full interval after the failure
  // that tripped the breaker, not at once, which would be a fourth timeout for free.
  if (s.streak[kind] >= CAPTURE_FAILURE_STREAK && s.suspendedAtMs[kind] === null) {
    s.suspendedAtMs[kind] = nowMs;
    s.lastProbeAtMs[kind] = nowMs;
  }
  if (s.failedTimeMs >= CAPTURE_TIME_BUDGET_MS && s.budgetExhaustedAtMs === null) {
    s.budgetExhaustedAtMs = nowMs;
    // Every kind moves to the probe cadence from this moment.
    for (const k of KINDS) s.lastProbeAtMs[k] = nowMs;
  }
}

/** The breaker's own account, for the scorecard. */
export interface CaptureBreakerSummary {
  readonly pageSuspendedAtMs: number | null;
  readonly elementSuspendedAtMs: number | null;
  readonly canvasSuspendedAtMs: number | null;
  readonly budgetExhaustedAtMs: number | null;
  readonly failedTimeMs: number;
  readonly skipped: Readonly<PerKind<number>>;
  readonly probes: Readonly<PerKind<number>>;
}

/** Summarise the breaker's state. */
export function captureBreakerSummary(s: CaptureBreakerState): CaptureBreakerSummary {
  return {
    pageSuspendedAtMs: s.suspendedAtMs.page,
    elementSuspendedAtMs: s.suspendedAtMs.element,
    canvasSuspendedAtMs: s.suspendedAtMs.canvas,
    budgetExhaustedAtMs: s.budgetExhaustedAtMs,
    failedTimeMs: s.failedTimeMs,
    skipped: { ...s.skipped },
    probes: { ...s.probes },
  };
}

const total = (counts: PerKind<number>) => KINDS.reduce((sum, k) => sum + counts[k], 0);

/** Whether the breaker ever did anything worth a sentence. */
function breakerActed(s: CaptureBreakerState): boolean {
  const suspended = KINDS.some((k) => s.suspendedAtMs[k] !== null);
  return total(s.skipped) > 0 || s.budgetExhaustedAtMs !== null || suspended;
}

const SUSPENDED_LABEL: PerKind<string> = {
  [ShotKind.Page]: "page screenshots",
  [ShotKind.Element]: "canvas-element screenshots",
  [ShotKind.Canvas]: "canvas readbacks",
};

/** One sentence for the scorecard note; null when nothing was ever skipped. */
export function captureBreakerSentence(s: CaptureBreakerState): string | null {
  if (!breakerActed(s)) return null;
  const parts: string[] = [];
  for (const k of KINDS) {
    const at = s.suspendedAtMs[k];
    if (at === null) continue;
    const streak = k === ShotKind.Page ? ` after ${CAPTURE_FAILURE_STREAK} failures in a row` : "";
    parts.push(`${SUSPENDED_LABEL[k]} were suspended at ${Math.round(at)}ms${streak}`);
  }
  if (s.budgetExhaustedAtMs !== null) {
    parts.push(
      `the ${CAPTURE_TIME_BUDGET_MS / SECOND_MS}s budget for time inside failed shots ran out at ${Math.round(s.budgetExhaustedAtMs)}ms`,
    );
  }
  parts.push(
    `${total(s.skipped)} capture(s) were skipped (${s.skipped.page} page, ${s.skipped.element} element, ${s.skipped.canvas} canvas) and ${total(s.probes)} short probe attempt(s) (one per kind per ${CAPTURE_RETRY_EVERY_MS / SECOND_MS}s, ${CAPTURE_PROBE_TIMEOUT_MS / SECOND_MS}s each) went out — the probe kept its wall clock instead of paying two timeouts per frame. Fewer frames is the honest cost; a run graded on them reads as evidence-insufficient rather than as a project that did not respond`,
  );
  return `${parts.join("; ")}.`;
}
