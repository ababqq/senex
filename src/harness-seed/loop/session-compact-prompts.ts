/** What a chat's session is told when it is compacted, and how its successor is briefed (session-compact.ts). */

/** The handover turn, sent to the session that remembers the chat; its reply is the summary. */
export const SESSION_HANDOVER_ASK = [
  `HANDOVER: this chat continues in a new session that remembers nothing of this one.`,
  `Write its handover as your reply: what the person asked for (their own words where short), every decision made and why, the current state of the project (files, features, known bugs), what was tried and failed, and anything promised but not done. At most about 40 lines.`,
  `Change nothing in this turn.`,
].join("\n");

/** The handover as a fresh session's brief carries it. */
export function handoverSection(summary: string): string {
  return `Where this chat stands — the handover the session before this one wrote when the chat was compacted:\n${summary}`;
}
