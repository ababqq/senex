/**
 * The words the lead's `playtest` puts to its tester when it names a required goal instead of asking
 * its own question (director/tools.ts `playtest`).
 */

/** The line a goal the lead flagged `multiplayer` adds: a second player needs a hosted route that may be missing. */
const MULTIPLAYER_LINE =
  " Report no or unmeasured when a dependency or hosted two-client route is unavailable. Screenshots and protocol tests alone cannot prove multiplayer.";
/** The line every other goal gets: a dependency the build needs may be missing, and that is a no, not a guess. */
const DEPENDENCY_LINE = " Report no or unmeasured when a dependency is unavailable.";

/**
 * The question a tester answers for a required goal: every scenario of its acceptance, through real use.
 * Only a goal the lead flagged `multiplayer` is told about the hosted two-client route; any other build
 * is not asked about a route it has no use for.
 */
export function goalPlaytestAsk(scenarios: string, multiplayer: boolean): string {
  const lead = `Verify every required scenario through actual interaction: ${scenarios}.`;
  return lead + (multiplayer ? MULTIPLAYER_LINE : DEPENDENCY_LINE);
}
