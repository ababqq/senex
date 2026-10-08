/**
 * Whether a `webglcontextlost` event was actually a failure.
 *
 * Pages routinely create a throwaway WebGL context to probe capabilities (three.js and friends do)
 * and discard it, which fires `webglcontextlost` while the real renderer keeps drawing. Counting
 * that event as an error failed nearly half of a measured corpus whose projects rendered perfectly.
 *
 * So a loss counts only when the project did not carry on. Either of two observations excuses one:
 * a `webglcontextrestored` follows it, or the page's own rAF loop kept producing frames well after
 * it. Context identity is deliberately NOT inferred: the events carry no handle back to their canvas.
 */

/** How long the render loop must outlive a loss before the loss is excused. */
export const CONTEXT_LOSS_SURVIVAL_MS = 2_000;

/** The WebGL context events the instrument records. */
export const ContextEventKind = {
  Lost: "webglcontextlost",
  Restored: "webglcontextrestored",
  CreationError: "webglcontextcreationerror",
} as const;
export type ContextEventKind = (typeof ContextEventKind)[keyof typeof ContextEventKind];

/** One context event, page-clock `t`. */
export interface ContextEvent {
  readonly t: number;
  readonly kind: string;
}

/** A loss the project survived, and why it was excused. */
export interface SurvivedLoss {
  readonly atMs: number;
  readonly why: string;
}

/** The losses split into fatal and survived. */
export interface ContextLossVerdict {
  /** Losses the project did not survive. These are the only ones worth failing on. */
  readonly fatal: readonly ContextEvent[];
  /** Losses the project rendered straight through, with why each was excused. */
  readonly survived: readonly SurvivedLoss[];
}

/** Split the recorded context losses into the ones the project survived and the fatal rest. */
export function classifyContextLosses(
  events: readonly ContextEvent[],
  rafLastT: number | null,
  survivalMs: number = CONTEXT_LOSS_SURVIVAL_MS,
): ContextLossVerdict {
  const restored = events.filter((e) => e.kind === ContextEventKind.Restored);
  const fatal: ContextEvent[] = [];
  const survived: SurvivedLoss[] = [];
  for (const loss of events.filter((e) => e.kind === ContextEventKind.Lost)) {
    const excuse = excuseFor(loss, restored, rafLastT, survivalMs);
    if (excuse) survived.push({ atMs: loss.t, why: excuse });
    else fatal.push(loss);
  }
  return { fatal, survived };
}

function excuseFor(
  loss: ContextEvent,
  restored: readonly ContextEvent[],
  rafLastT: number | null,
  survivalMs: number,
): string | null {
  const restore = restored.find((r) => r.t > loss.t);
  if (restore) return `restored at ${Math.round(restore.t)}ms — the project recovered the context`;
  if (rafLastT === null || rafLastT < loss.t + survivalMs) return null;
  const after = Math.round(rafLastT - loss.t);
  return `the rAF loop kept producing frames until ${Math.round(rafLastT)}ms, ${after}ms after this event — the context that died was not the one rendering`;
}
