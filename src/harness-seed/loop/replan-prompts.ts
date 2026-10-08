/** What the planner is told when a check cannot pass as written, and when a facet needs its next move. */
import { renderChecks, type Check, type FacetSpec, type Milestone } from "./spec.ts";
import { clip } from "./text.ts";
import type { Run } from "../types/harness.d.ts";

/** How much of a facet's intent a replan question quotes, and how much the next-move question does. */
const REPLAN_INTENT_CHARS = 600;
const MOVE_INTENT_CHARS = 900;
/** How much of the page's state (or its tag counts) a question quotes. */
const STATE_CHARS = 600;
/** How much of the builder's "known gaps" the next-move question carries. */
const KNOWN_GAPS_CHARS = 1200;
/** The ledger defects the next-move question names, and how much of each. */
const LEDGER_DEFECTS = 6;
const LEDGER_DEFECT_CHARS = 140;

/** A facet as the planner is asked about it. */
export type PlannedFacet = Pick<FacetSpec, "id" | "title" | "intent"> & {
  checks?: Check[];
  identity?: string[];
  milestones?: Milestone[];
};

/** The planner's brief for a check nobody can satisfy as written. */
export const REPLAN_SYSTEM = [
  "You are the planner of an Autopilot run. One check on a facet's contract cannot be satisfied as written — a spike, the builder, or four identical failures say so.",
  "Decide, in JSON only: repoint (same intent, a camera/crop/tag/helper that can actually see it), relax (same intent, a threshold the evidence supports), or drop (the check measures nothing the facet exists for).",
  "Identity checks may be repointed or relaxed, never dropped unless they are genuinely unmeasurable. Keep the id. Write the corrected check in the same JSON shape it has now.",
  'Reply with JSON only: {"action":"repoint"|"relax"|"drop","check":{…full check…},"why":"one sentence"}',
].join("\n");

/** The question about one check: the facet, the check, why it cannot pass, and what the build can see. */
export function replanUserPrompt({
  spec,
  check,
  reason,
  cameras,
  eyes,
  evidence,
}: {
  spec: PlannedFacet;
  check: Check;
  reason: string;
  cameras: string[];
  eyes: string[];
  evidence: { state?: unknown } | null;
}): string {
  return [
    `FACET: ${spec.title} (${spec.id}) — intent: ${clip(spec.intent, REPLAN_INTENT_CHARS)}`,
    `THE CHECK:`,
    renderChecks([check]),
    JSON.stringify(check),
    ``,
    `WHY IT CANNOT PASS AS WRITTEN: ${reason}`,
    cameras.length ? `CAMERAS THE BUILD REGISTERS: ${cameras.join(", ")}` : "",
    eyes.length
      ? `HARNESS EYE CAMERAS: ${eyes.join(", ")} (eye:spawn is pitched −25°, eye:here −10°, eye:down −60°, eye:back over the shoulder)`
      : "",
    evidence?.state ? `LAST STATE: ${JSON.stringify(evidence.state).slice(0, STATE_CHARS)}` : "",
    `OTHER CHECKS ON THE FACET (do not duplicate): ${(spec.checks ?? [])
      .filter((c) => c.id !== check.id)
      .map((c) => c.id)
      .join(", ")}`,
    ``,
    'Reply with JSON only: {"action":"repoint"|"relax"|"drop","check":{…},"why":"…"}',
  ]
    .filter(Boolean)
    .join("\n");
}

/** The planner's brief for the next structural move. */
export const NEXT_MOVE_SYSTEM = [
  "You are the planner of an Autopilot run. One facet's identity checks now pass, and its builder must not spend the next iteration tuning what already exists.",
  "Name the ONE structural move the next iteration must make: a change to what the project IS — its extent (three houses become the whole hamlet), a system that does not exist yet (doors that open, weather, a market), a mechanic, where the player goes next, what the screen tells them — sized so that one builder can land it in one iteration and a player would notice it at once.",
  "Never a material, lighting, shadow or parameter tweak, and never something the ledger already lists: the defect ledger covers polish. Do not repeat a move already delivered. Prefer the move that carries the facet's intent furthest toward the project goal.",
  "If the move can be measured, write a check in the same JSON shape the facet's checks use (scene/probe/demo/pixel) that passes once the move is in; else null.",
  'Reply with JSON only: {"what":"one or two sentences — the move","why":"one sentence","check":{…}|null}',
].join("\n");

/** The builder's own "known gaps" section of its notes, if it wrote one. */
function knownGapsOf(notes: string): string {
  return (
    /## (?:Known gaps|Left for a later iteration|Open \/ next|Open|Next)[^\n]*\n([\s\S]*?)(?=\n## |$)/i
      .exec(String(notes ?? ""))?.[1]
      ?.trim()
      .slice(0, KNOWN_GAPS_CHARS) ?? ""
  );
}

/** What the move is asked from: the goal, the facet, what it already did, and what is already covered. */
export function nextMoveUserPrompt({
  run,
  spec,
  defects,
  notes,
  moves,
  counts,
  cameras,
}: {
  run: Run;
  spec: PlannedFacet;
  defects: readonly unknown[];
  notes: string;
  moves: ReadonlyArray<{ what?: string; delivered?: boolean }>;
  counts: unknown;
  cameras: string[];
}): string {
  const knownGaps = knownGapsOf(notes);
  return [
    `PROJECT GOAL: ${run.goal}`,
    run.reference?.name ? `REFERENCE / DIRECTION: ${run.reference.name}` : "",
    `FACET: ${spec.title} (${spec.id}) — intent: ${clip(spec.intent, MOVE_INTENT_CHARS)}`,
    spec.identity?.length ? `IDENTITY FEATURES: ${spec.identity.join(" > ")}` : "",
    (spec.milestones ?? []).length
      ? `MILESTONES ALREADY CLIMBED: ${(spec.milestones ?? []).map((m) => m.what).join(" | ")}`
      : "",
    moves.length
      ? `MOVES SO FAR (do not repeat): ${moves.map((m) => `${m.what}${m.delivered ? " (delivered)" : " (not delivered)"}`).join(" | ")}`
      : "",
    counts ? `WHAT THE BUILD CONTAINS NOW (tag counts): ${JSON.stringify(counts).slice(0, STATE_CHARS)}` : "",
    defects.length
      ? `THE JUDGE'S LEDGER (polish — already covered, do not choose from it): ${defects
          .slice(0, LEDGER_DEFECTS)
          .map((d) => String(d).slice(0, LEDGER_DEFECT_CHARS))
          .join(" | ")}`
      : "",
    knownGaps ? `THE BUILDER'S OWN "KNOWN GAPS": ${knownGaps}` : "",
    cameras.length ? `CAMERAS: ${cameras.join(", ")}` : "",
    `CHECK IDS IN USE (do not reuse): ${(spec.checks ?? []).map((c) => c.id).join(", ")}`,
    "",
    'Reply with JSON only: {"what":"…","why":"…","check":{…}|null}',
  ]
    .filter(Boolean)
    .join("\n");
}
