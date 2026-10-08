import { type PlanReview, PlanReviewState } from "../../shared/composer.ts";
import { type ChatActivity, ChatActivityPhase } from "../../shared/chat-activity.ts";
import type { RunSummary } from "../../shared/run-summary.ts";
import { type ActivityItem, ActivityItemKind } from "./conversation-entries.ts";
import { TaskState } from "./task-state.ts";
import { ToolState } from "../ui/tool-state.ts";
import { CHAT_WORDS, TOOL_ACTIVITY_WORDS, USING_A_TOOL } from "../words.ts";

/** Phases that say only that something is busy: the work itself can name them better. */
const GENERIC_PHASES: ReadonlySet<string> = new Set<ChatActivityPhase>([
  ChatActivityPhase.Thinking,
  ChatActivityPhase.Working,
  ChatActivityPhase.Idle,
  ChatActivityPhase.Tool,
]);
/** A tool phase's labels that name no tool. */
const GENERIC_TOOL_LABELS: ReadonlySet<string> = new Set([TOOL_ACTIVITY_WORDS.run, USING_A_TOOL]);
/** A running tool's own label, as the busy line says it. */
const TOOL_WORDS: ReadonlyMap<string, string> = new Map([
  [TOOL_ACTIVITY_WORDS.read, "Reading the code"],
  [TOOL_ACTIVITY_WORDS.write, "Editing the project"],
]);

/** What the plan under review is doing, when that is the chat's work. */
function planLabel(activity: ChatActivity, run: RunSummary | null, planState?: PlanReview["state"]): string | null {
  if (planState === PlanReviewState.Generating) return "Preparing your plan";
  const starting = planState === PlanReviewState.Starting && activity.phase === ChatActivityPhase.Idle && !run;
  return starting ? "Starting your build" : null;
}

/** The newest tool still running in the chat's own work, in words, or null. */
function runningToolLabel(items: ActivityItem[]): string | null {
  const current = items.findLast(
    (item) => item.kind === ActivityItemKind.Tool && item.tool.state === ToolState.Running,
  );
  if (current?.kind !== ActivityItemKind.Tool) return null;
  const label = current.tool.activeLabel ?? current.tool.label;
  return TOOL_WORDS.get(label) ?? label;
}

/** What a running build is doing: its one task, how many, or what comes next. */
function runLabel(run: RunSummary, activityLabel: string): string {
  const active = run.tasks.filter((task) => task.state === TaskState.Running);
  const [only] = active;
  if (active.length === 1 && only) return only.title;
  if (active.length > 1) return `Working on ${active.length} tasks`;
  if (run.tasks.some((task) => task.state === TaskState.Queued)) return "Preparing the next task";
  return activityLabel === "Idle" ? "Working" : activityLabel;
}

/** Explicit conversation activity wins. A run's generic busy state names the actual work. */
export function currentWorkLabel(
  activity: ChatActivity,
  run: RunSummary | null,
  finishing: boolean,
  items: ActivityItem[] = [],
  planState?: PlanReview["state"],
): string {
  const plan = planLabel(activity, run, planState);
  if (plan) return plan;
  if (finishing) return "Finishing up";
  if (!GENERIC_PHASES.has(activity.phase)) return activity.label;
  const toolPhase = activity.phase === ChatActivityPhase.Tool;
  if (toolPhase && !GENERIC_TOOL_LABELS.has(activity.label)) return activity.label;
  const tool = runningToolLabel(items);
  if (tool !== null) return tool;
  if (toolPhase || !run) return activity.label;
  return runLabel(run, activity.label);
}

/** Busy-line labels that only say the lead is between parts: the build card says it is planning. */
const PLANNING_LABELS: ReadonlySet<string> = new Set(["Thinking", "Working", "Idle"]);

/**
 * The one line in the chat's build card: what is happening right now, one thing at a time. A part
 * at work names itself; between parts the lead is planning, or doing what its tool says it is.
 */
export function buildCaption(
  activity: ChatActivity,
  run: RunSummary | null,
  finishing: boolean,
  items: ActivityItem[] = [],
  planState?: PlanReview["state"],
): string {
  if (finishing) return "Finishing up";
  const running = run?.tasks.filter((task) => task.state === TaskState.Running) ?? [];
  const [first] = running;
  if (first && running.length === 1) return `${first.title} · working`;
  if (first) return `${first.title} and ${running.length - 1} more · working`;
  const label = currentWorkLabel(activity, run, finishing, items, planState);
  if (PLANNING_LABELS.has(label)) return CHAT_WORDS.planningNextStep;
  // A label that names no tool: the lead is working on the build.
  if (GENERIC_TOOL_LABELS.has(label)) return "Working on the build";
  return label;
}
