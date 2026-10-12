/**
 * The goal a build works and is judged to, as its lead, builders, judges and playtester read it.
 * A finished build reopened keeps what it was commissioned as (`run.goal`, which the Builds graph
 * shows as "The goal") and records each ask since on `run.asks`, the latest first (reopen-run.ts).
 */

/** How the asks a reopened build was given read ahead of its commission. */
const WORDS = {
  latest: "LATEST ASK — it wins wherever the rest says otherwise",
  earlier: "EARLIER ASK",
  build: "THE BUILD IT CONTINUES",
} as const;

/** The asks a run carries, latest first: none for a build never reopened. */
export function runAsks(run: { asks?: unknown }): string[] {
  if (!Array.isArray(run.asks)) return [];
  return run.asks.filter((ask): ask is string => typeof ask === "string" && ask.trim() !== "");
}

/**
 * The goal to build and judge: the commission, or — once reopened — the user's latest ask first,
 * winning where they conflict, then the earlier asks and the commission. A judge of a reopened
 * build once preferred two HUD plates the user had asked to remove, because only the commission
 * named them (golden-boot-glory).
 */
export function workingGoal(run: { goal?: unknown; asks?: unknown }): string {
  const goal = typeof run.goal === "string" ? run.goal : "";
  const [latest, ...earlier] = runAsks(run);
  if (!latest) return goal;
  return [
    `${WORDS.latest}: ${latest}`,
    ...earlier.map((ask) => `${WORDS.earlier}: ${ask}`),
    `${WORDS.build}: ${goal}`,
  ].join("\n\n");
}
