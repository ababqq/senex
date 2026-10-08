/**
 * The line below the transcript that says what is happening: the chat's own work (with the work
 * log folded in), else a running build's status, else Studio quietly learning, else nothing.
 */
import type { JSX, Key } from "react";
import type { AgentScreenFrame } from "../../shared/agent-screen.ts";
import { leadFrameOf } from "../state/agent-screens.ts";
import { useAgentScreens } from "../state/hooks.ts";
import { LoadingState } from "../ui/LoadingState.tsx";
import { Presence, type PresenceChild } from "../ui/Presence.tsx";
import { BuildStatus } from "./BuildStatus.tsx";
import type { ActivityItem } from "./conversation-entries.ts";
import { WorkLogContent } from "./WorkLog.tsx";

export interface ChatWorkProps {
  /** The chat's own work is under way. */
  chatWorking: boolean;
  learning: boolean;
  activeRunId: string | null;
  /** Remounts the busy line when the work it times changes (a plan, a run, the chat). */
  workKey: Key | null | undefined;
  /** What the busy line says (`busyLabel`). */
  label: string;
  /** The running build's one line (`buildCaption`): what is happening now, one thing at a time. */
  caption: string;
  /** The busy line waits on the user rather than working. */
  waiting: boolean;
  busySince: number | null;
  details: ActivityItem[] | null;
  /** The learning pass's own status line. */
  learningLine: string;
  runStarted: number | undefined;
  /** The time the running build was given, when it was given one. */
  budgetMs: number | null;
  /** The chat's project, whose running build's lead screen the build status shows. */
  project: string | null;
  onShowBuilds?: () => void;
  /** The chat is loading: the line it opens with is simply there. */
  still?: boolean;
}

/** What the line is: the chat's own work, a running build or Studio learning. A change of kind swaps it. */
const WorkKind = {
  Work: "work",
  Build: "build",
  Learning: "learning",
} as const;

/**
 * The line reads the lead's screen itself (a frame of the store's), so a new frame from any worker
 * re-renders at most this line, never the chat around it. A running build is one card with one
 * line: the parts' detail lives on Builds, not in a list under it. The line opens and closes in
 * place, and a work line becoming the build card (or back) closes one as the other opens.
 */
export function ChatWork(props: ChatWorkProps): JSX.Element {
  const { activeRunId, project } = props;
  const leadFrame = useAgentScreens((s) => (activeRunId ? leadFrameOf(s, project, activeRunId) : undefined));
  return <Presence still={props.still}>{workLine(props, leadFrame)}</Presence>;
}

/** The line on show, keyed by its kind, or nothing. */
function workLine(props: ChatWorkProps, leadFrame: AgentScreenFrame | undefined): PresenceChild[] {
  if (props.chatWorking)
    return [
      {
        key: WorkKind.Work,
        node: (
          <div className="flex min-w-0 flex-col gap-1">
            <LoadingState
              key={props.workKey}
              details={props.details ? <WorkLogContent items={props.details} /> : undefined}
              label={props.label}
              waiting={props.waiting}
              {...(props.busySince ? { since: props.busySince } : {})}
            />
          </div>
        ),
      },
    ];
  if (props.activeRunId)
    return [
      {
        key: WorkKind.Build,
        node: (
          <div className="flex min-w-0 flex-col gap-2">
            <BuildStatus
              {...(props.runStarted !== undefined ? { since: props.runStarted } : {})}
              budgetMs={props.budgetMs}
              {...(leadFrame ? { frame: leadFrame } : {})}
              {...(props.onShowBuilds ? { onOpenBuilds: props.onShowBuilds } : {})}
              caption={props.caption}
            />
          </div>
        ),
      },
    ];
  if (props.learning) return [{ key: WorkKind.Learning, node: <LoadingState label={props.learningLine} waiting /> }];
  return [];
}
