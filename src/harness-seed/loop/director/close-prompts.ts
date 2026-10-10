/**
 * The words the close puts to its own judge (integrate.ts `judgeTheLanding`). A build with no
 * picture of a "before" — a new project, or one whose start nobody could photograph — cannot be
 * compared with anything, so its judge is asked a yes or no about the user's own goal.
 */
import { clipMarked } from "../text.ts";

/** How much of the run's goal the close's question quotes. */
const GOAL_CHARS = 400;

/** The yes-or-no question the vision judge answers about the build, on its first camera. */
export function finalJudgeQuestion(goal: unknown): string {
  return `The user asked for: "${clipMarked(goal, GOAL_CHARS)}". Does this build visibly show that, working — rather than an empty page, a placeholder or a different project? If one picture cannot show it, say so with a low confidence.`;
}
