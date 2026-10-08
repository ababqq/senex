/**
 * What a finished build reopened says to its lead (director/reopen.ts): the heading of its first
 * digest, the paragraph that digest ends on, the words its brief's resume note opens with, and how
 * the workers of the finished build are spoken of. Plain facts in, text out.
 */
import { shortSha } from "../git.ts";
import type { PriorEra } from "./journal-prompts.ts";

/** A clock time as the digest says it. */
const utc = (ms: number): string => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

/** The heading of a reopened build's first digest, in place of "RESUMED AT". */
export function reopenedHeading({ now, minutesLeft }: { now: number; minutesLeft: number }): string {
  return `THE BUILD GOES ON AT ${utc(now)} — it had finished, and the user asks for more (their words are below). The same run reopens with ${minutesLeft} more working minutes before its wrap-up: a fresh budget, not what the finished run had left. Its plan, its log and what its workers committed are kept; none of them is running.`;
}

/**
 * The paragraph a reopened build's first digest ends on, while it has working time. A build that goes
 * on until its outcomes are verified (`goal`) has none until its lead plans for the ask.
 */
export function reopenClosing(goal = false): string {
  const plan = goal
    ? "Call plan first for what the user asks: its parts' done scenarios become the outcomes this build must verify before it finishes — the finished build's are not its outcomes any more."
    : "The plan the build finished on stands until you call plan again — call it when the ask is new work.";
  return `Do what the user asks now. ${plan} Start the workers it needs (from=<commit> builds on a finished worker's work), integrate, show, and finish when it is done; then end your turn: the studio wakes you when something happens.`;
}

/**
 * The words a reopened build's resume note opens with (director.ts `resumeWords`): where it goes on
 * from — the project folder as it is now when the finished build is in it, else the finished build.
 */
export function reopenNote({ inFolder, forkCommit }: { inFolder: boolean; forkCommit: string | null }): string {
  const from = inFolder
    ? `the project folder as it is now (${shortSha(forkCommit ?? "")}): the finished build is in it, with whatever changed since`
    : `the finished build (${shortSha(forkCommit ?? "")}), which is not in the project folder — finish land=yes lands it with what you add`;
  return `This build had finished; the user asked for more, so the same run goes on with a fresh working budget from ${from}.`;
}

/** How the workers of the finished build are spoken of (journal-prompts.ts speaks of a pause by default). */
export const REOPEN_ERA = {
  running: "stopped when the build finished",
  state: "in the finished build",
  from: "from the finished build",
} as const satisfies PriorEra;
