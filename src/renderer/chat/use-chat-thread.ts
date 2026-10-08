import { useMemo } from "react";
import { rewindsOf, withoutRewound } from "../../shared/chat-rewind.ts";
import { ThreadKind } from "../../shared/event-log.ts";
import { messageQueueState, type QueuedMessage, QueueState, type QueueView } from "../../shared/message-queue.ts";
import { RunState, runExecution } from "../../shared/run-state.ts";
import { displayChatTitle } from "../chat-labels.ts";
import { isWorkingStatus, threadMeta } from "../state/threads.ts";
import type { ChatPanelProps } from "./chat-panel-props.ts";
import { leadTakesChat } from "./live-chat.ts";
import { usePendingSends } from "./use-pending-sends.ts";
import { useThreadTranscript } from "./use-thread-transcript.ts";

/** A rewound chat reads without the rows it withdrew: the log keeps them, the chat does not. */
function useRewoundView({ activeThread, events: rawEvents, stateEvents: rawStateEvents }: ChatPanelProps) {
  const threadId = activeThread?.id;
  const metadata = activeThread?.metadata;
  const rewinds = useMemo(
    () =>
      rewindsOf(
        rawStateEvents.filter((event) => event.thread_id === threadId),
        metadata,
      ),
    [rawStateEvents, threadId, metadata],
  );
  const events = useMemo(() => withoutRewound(rawEvents, rewinds), [rawEvents, rewinds]);
  const stateEvents = useMemo(() => withoutRewound(rawStateEvents, rewinds), [rawStateEvents, rewinds]);
  return { events, stateEvents };
}

/** Being answered, or being handed to the turn that answers: the chat's work. */
const ANSWERING: ReadonlySet<QueueState> = new Set<QueueState>([QueueState.Processing, QueueState.Steering]);

/**
 * Saved and about to be answered is the chat's work as well: no gap between Sending and the
 * reply, and Stop reaches it. (During a build, waiting input stays below the build instead.)
 */
function isAnswering(queue: QueueView, activeRunId: string | null): boolean {
  if (activeRunId) return false;
  const aboutToBeAnswered = (m: QueuedMessage): boolean => m.state === QueueState.Queued && !queue.paused;
  return [...queue.messages.values()].some((m) => ANSWERING.has(m.state) || aboutToBeAnswered(m));
}

/**
 * What the open chat is: its thread record and kind, its slice of the log, its run, the messages
 * on their way and its transcript split the way the panel draws it.
 */
export function useChatThread(props: ChatPanelProps) {
  const { activeThread, projects, firstAsk, status } = props;
  const { events, stateEvents } = useRewoundView(props);
  const meta = threadMeta(activeThread);
  const isStudioThread = meta.kind !== ThreadKind.Project;
  const isDraft = meta.kind === ThreadKind.Project && !meta.project;
  const folder = projects.find((project) => project.name === meta.project) ?? null;
  const chatTitle =
    folder?.title ??
    displayChatTitle({
      title: activeThread?.title,
      projectTitle: folder?.title ?? meta.project,
      firstAsk,
      unbound: isDraft,
    });
  // One thread at a time: this chat shows exactly the active thread's slice of the log.
  const threadEvents = useMemo(
    () => (activeThread ? stateEvents.filter((event) => event.thread_id === activeThread.id) : []),
    [stateEvents, activeThread?.id],
  );
  const run = useMemo(() => (isStudioThread ? null : runExecution(threadEvents)), [threadEvents, isStudioThread]);
  const activeRunId = run?.state === RunState.Running ? run.runId : null;
  const leadListens = useMemo(() => leadTakesChat(threadEvents, activeRunId), [threadEvents, activeRunId]);
  const queue = useMemo(() => messageQueueState(threadEvents), [threadEvents]);
  const sends = usePendingSends({ threadId: activeThread?.id, threadEvents, queue });
  const transcript = useThreadTranscript({
    events,
    stateEvents,
    threadEvents,
    queue,
    holdsInPlace: sends.holdsInPlace,
    activeRunId,
    studio: isStudioThread,
  });
  return {
    threadId: activeThread?.id,
    events,
    stateEvents,
    /** The log as it came, rewound rows included: a send's row can only come after its newest. */
    rawStateEvents: props.stateEvents,
    queue,
    sends,
    answering: isAnswering(queue, activeRunId),
    meta,
    project: meta.project ?? null,
    isStudioThread,
    isDraft,
    folder,
    chatTitle,
    threadEvents,
    run,
    activeRunId,
    /** The running build's lead takes the chat's messages now (live chat). */
    leadListens,
    pausedRunId: run?.state === RunState.Paused ? run.runId : null,
    working: isWorkingStatus(status) || run?.state === RunState.Running,
    transcript,
  };
}

/** The open chat as the panel's hooks and parts read it. */
export type ChatThread = ReturnType<typeof useChatThread>;
