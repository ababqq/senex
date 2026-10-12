/**
 * The words the close puts to its own judge (integrate.ts `judgeTheLanding`). A build with no
 * picture of a "before" — a new project, or one whose start nobody could photograph — cannot be
 * compared with anything, so its judge is asked a yes or no about the build's goal.
 */
import { clipMarked } from "../text.ts";

/** How much of the run's goal the close's question quotes. */
const GOAL_CHARS = 400;

/**
 * The yes-or-no question the vision judge answers about the build, on its first camera. The goal is
 * quoted whole and under no author's name: it is the chat's launch paragraph or, once a build is
 * reopened, the asks since, and it can carry details the user never wrote.
 */
export function finalJudgeQuestion(goal: unknown): string {
  return `This build's goal: "${clipMarked(goal, GOAL_CHARS)}". Does this build visibly show that, working — rather than an empty page, a placeholder or a different project? If one picture cannot show it, say so with a low confidence.`;
}
