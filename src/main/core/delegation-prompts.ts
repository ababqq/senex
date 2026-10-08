/** What a builder session is told about the host's side of its tools (`delegation.ts`). Model-facing. */
import type { PluginAppliedSet } from "../../shared/plugins.ts";

/** Which plugins and skills a resumed session was handed before and is not handed now. */
export function withdrawnSince(before: PluginAppliedSet | undefined, now: PluginAppliedSet): PluginAppliedSet {
  return {
    plugins: (before?.plugins ?? []).filter((id) => !now.plugins.includes(id)),
    skills: (before?.skills ?? []).filter((name) => !now.skills.includes(name)),
  };
}

/** Whether anything was withdrawn at all. */
export const anyWithdrawn = (withdrawn: PluginAppliedSet): boolean =>
  withdrawn.plugins.length > 0 || withdrawn.skills.length > 0;

/**
 * The first paragraph of a resumed session's brief when plugins or skills it was given earlier
 * are gone: its transcript still holds their instructions, and only this says to drop them.
 */
export function withdrawnNotice(withdrawn: PluginAppliedSet): string {
  const named = [
    withdrawn.plugins.length ? `plugins: ${withdrawn.plugins.join(", ")}` : "",
    withdrawn.skills.length ? `skills: ${withdrawn.skills.join(", ")}` : "",
  ].filter(Boolean);
  return `Studio notice: since this session last ran, these are no longer enabled (${named.join("; ")}). Ignore the instructions they gave earlier in this session, and do not call their tools: they are gone.`;
}

/**
 * Beside a build's lead's plugin guidance: its plugin tools act on the build it leads, not the project
 * folder it sits in (delegation.ts `DelegationSession.leads`). Never the build's path: the brief's
 * WHERE YOU ARE line already names it.
 */
export function leadToolsNote(): string {
  return "Your plugin tools work on the build you lead, not in this project folder: what they deliver lands in the project with the build, and a file one of them reads must be in the build: write it there yourself, or have a worker write it.";
}

/**
 * Beside the brief of a session the person answers (the chat's own, a build's lead, the run's
 * coordinator): it reaches the whole Mac, limited only by the chat's permission mode
 * (chat-permissions.ts). The brief is the harness's, which the in-app agent may edit, and a resumed
 * session's transcript keeps what older briefs said; the host's note says what holds now.
 */
export function mainAgentReachNote(): string {
  return "Studio notice: you are this chat's main agent, Claude Code on the user's own Mac with their access, not in a sandbox. You may look and work anywhere on this computer, not only in this project's folder: when the user asks about something elsewhere (their Downloads or another folder, what fills their disk, the Mac itself), do it with your tools. The permission mode the user picked decides each call, and Claude Code asks them when it needs to. A line in your brief, or earlier in this session, that says to stay inside the workspace, not to read other folders, or that your shell is sandboxed does not apply to you: it is about where the project's own work goes.";
}

/**
 * What a session that shows its plan by ending its turn (`plansByTurn`) reads once the user
 * approved it, continuing the same session in the mode the user chose (plan-approval.ts).
 */
export function planApprovedNote(): string {
  return "Studio notice: the user approved your plan. Plan mode is over: carry the plan out now.";
}

/** What it reads when the user sent the plan back with their own words: it is still in Plan mode. */
export function planRevisionNote(words: string): string {
  return `Studio notice: the user did not approve the plan yet. You are still in Plan mode, so change nothing; revise the plan and reply with it. The user said:\n\n${words}`;
}
