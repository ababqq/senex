/**
 * The words the classic pipeline (autopilot.ts) hands a model beyond the shared base brief
 * (prompts-build.ts): the integrator's brief when facet merges conflict.
 */
import type { AnyRecord, Run } from "../types/harness.d.ts";

/** A facet merge that conflicted: the facet, and the commit that would not merge. */
export interface MergeConflict {
  facet: AnyRecord;
  commit: string;
}

/** The integrator's brief: bring every conflicted facet's accepted work into the merged build, and commit it. */
export function integratorBrief({
  run,
  plan,
  conflicts,
  worktreeOf,
}: {
  run: Pick<Run, "runId" | "project">;
  plan: { integrationNotes?: string };
  conflicts: readonly MergeConflict[];
  worktreeOf: (facetId: string) => string | undefined;
}): string {
  return [
    `You are the integrator for Autopilot run ${run.runId} on the project "${run.project}".`,
    `Several facet builds could not be merged automatically. Each facet's accepted work is in a git worktree:`,
    ...conflicts.map(
      (c) =>
        `- facet "${c.facet.title}" (${c.facet.id}): worktree ${worktreeOf(c.facet.id) ?? "?"}, commit ${c.commit}`,
    ),
    plan.integrationNotes ? `INTEGRATION NOTES from the plan: ${plan.integrationNotes}` : "",
    `Bring each facet's work into this folder (merge, or copy the relevant files and reconcile by hand).`,
    `Nothing a facet registered may go missing: every demo (config.demos), named camera and tagged group the`,
    `conflicted facets expose in their worktrees must still be present in the merged build —`,
    `a merge that "resolves" a conflict by dropping a facet's module has destroyed that facet's work.`,
    `When you are done: the project must load, window.__studio must still work, and you MUST commit`,
    `the reconciled result (\`git add -A\`, then \`git commit\`) — uncommitted integration work does not`,
    `survive a rollback and would be silently destroyed.`,
  ]
    .filter(Boolean)
    .join("\n");
}
