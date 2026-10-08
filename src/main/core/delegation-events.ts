import { chatDeltas } from "./chat-deltas.ts";
/**
 * A delegated session's events, mirrored into the log of the thread that asked for the build —
 * so a delegated build is as inspectable as a local one, and each project's chat holds its own
 * builds — and streamed to the chat while the conversation's own session replies.
 */
import { ChatActivityPhase, SessionActivityRole } from "../../shared/chat-activity.ts";
import { CustomEvent, DELEGATED_PREFIX, customEventData } from "../../shared/custom-events.ts";
import { EventKind, type EventData } from "../../shared/event-log.ts";
import { ContextSource, DEFAULT_MODEL_ID } from "../../shared/context.ts";
import { isDelegated } from "../../shared/model-roles.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import type { DelegateRequest } from "../../substrate/engines/types.ts";
import type { StudioCore } from "../studio-core.ts";

/** What a delegated engine reports (`claude-code.ts`, `codex.ts`). Mirrored into logs: never rename a value. */
const DelegatedEvent = {
  TextDelta: "text_delta",
  ContextUsage: "context_usage",
  Context: "context",
  Activity: "activity",
  Assistant: "assistant",
  Checkpoint: "checkpoint",
} as const;

/** The stream a planner's reply goes to when the engine names none. */
const REPLY_STREAM = "reply";

type EngineEvent = Parameters<NonNullable<DelegateRequest["onEvent"]>>[0];

/** Who the mirrored records belong to: the session's role, run and facet (`delegationActivityScope`). */
export interface ActivityScope {
  delegationId: string;
  role: SessionActivityRole;
  runId?: string;
  facetId?: string;
}

/**
 * A custom record of a delegated session, with its payload as written: the session's scope (a
 * `reviewer` role, a `null` session id) rides along beyond what the payload's readers type.
 */
export function scopedRecord(name: CustomEvent, payload: Record<string, unknown>): EventData {
  return { type: EventKind.Custom, event_type: name, payload };
}

export interface DelegationMirrorOptions {
  core: StudioCore;
  /** The thread the records land in: the caller's, or the studio's main thread. */
  threadId: string;
  /** The thread the caller named, as the context meter is told it. */
  requestThreadId: string | undefined;
  project: string;
  cwd?: string;
  engineId: string;
  requestedModel: string | undefined;
  activityScope: ActivityScope;
}

export interface DelegationMirror {
  onEvent: NonNullable<DelegateRequest["onEvent"]>;
  /** The chat stream the session's reply is going to, once it has begun. */
  streamId(): string | null;
  /** Deliver queued token text before the stream commits or ends. */
  flush(): void;
  /** The event the reply streams after: the thread's head when the session started. */
  afterEventId: string | null;
}

/** The mirror for one delegated session. */
export function delegationMirror(options: DelegationMirrorOptions): DelegationMirror {
  const { core, threadId, engineId, activityScope } = options;
  const append = (data: Parameters<StudioCore["append"]>[0][number]) => core.append([data], threadId);
  let streamId: string | null = null;
  let replying = false;
  const deltas = chatDeltas((payload) => core.emit(UiEvent.ChatDelta, payload));

  const mirror: DelegationMirror = {
    afterEventId: null,
    streamId: () => streamId,
    flush: deltas.flush,
    onEvent: (event) => {
      if (event.type === DelegatedEvent.TextDelta) return textDelta(event);
      if (event.type === DelegatedEvent.ContextUsage) return contextUsage(event);
      if (event.type === DelegatedEvent.Activity) replying = false;
      if (event.type === DelegatedEvent.Activity || event.type === DelegatedEvent.Context) activity(event);
      record(event);
      if (event.type === DelegatedEvent.Checkpoint) checkpoint(event);
    },
  };

  /** The contractor says "this is worth seeing" — Live's Reload lights up with its note (`index.ts`). */
  function checkpoint(event: EngineEvent): void {
    core.emit(UiEvent.DelegationCheckpoint, {
      project: options.project,
      cwd: options.cwd ?? core.projects.dirFor(options.project),
      note: (event.payload as { note?: string } | undefined)?.note ?? "",
    });
  }

  /** A piece of the conversation's own reply, streamed to the chat; a builder's text is not. */
  function textDelta(event: EngineEvent): void {
    if (activityScope.role !== SessionActivityRole.Planner) return;
    const chunk = event.payload as { streamId?: string; delta?: string; replace?: boolean };
    streamId = `${activityScope.delegationId}:${chunk.streamId ?? REPLY_STREAM}`;
    if (chunk.delta && !replying) {
      replying = true;
      void append(
        customEventData(CustomEvent.SessionActivity, {
          engine: engineId,
          phase: ChatActivityPhase.Responding,
          ...activityScope,
        }),
      );
    }
    deltas.push({ ...chunk, streamId, threadId, afterEventId: mirror.afterEventId });
  }

  /**
   * The pick a context reading was taken for (`measuresPick`): the model asked for, else, on an
   * engine with a default row, that default, since its CLI reports the model it ran
   * (`claude-opus-5-5[1m]`), which the chat's default pick would never match. A local session has
   * no default row: its readings name no pick and belong to the model they measured.
   */
  function readingPick(): string | null {
    if (options.requestedModel) return options.requestedModel;
    return isDelegated(engineId) ? DEFAULT_MODEL_ID : null;
  }

  /** A context meter's reading, recorded with the source it names; one that names none is an estimate. */
  function contextUsage(event: EngineEvent): void {
    const context = event.payload as {
      promptTokens: number;
      contextWindow: number;
      percent: number;
      model: string;
      source?: ContextSource;
    };
    void append(
      scopedRecord(CustomEvent.ContextUsage, {
        ...context,
        source: context.source ?? ContextSource.Estimated,
        engine: engineId,
        requestedModel: readingPick(),
        ...activityScope,
      }),
    ).then(() => core.emit(UiEvent.ContextUsage, { threadId: options.requestThreadId }));
  }

  /** An activity or context report, recorded as the session's activity or context usage. */
  function activity(event: EngineEvent): void {
    const isActivity = event.type === DelegatedEvent.Activity;
    void append(
      scopedRecord(isActivity ? CustomEvent.SessionActivity : CustomEvent.ContextUsage, {
        ...(event.payload as Record<string, unknown>),
        engine: engineId,
        requestedModel: isActivity ? (options.requestedModel ?? null) : readingPick(),
        ...activityScope,
      }),
    );
  }

  /** Every event, as the engine reported it, under `delegated.<engine>`. */
  function record(event: EngineEvent): void {
    const committedStream = event.type === DelegatedEvent.Assistant ? streamId : null;
    if (committedStream) deltas.flush();
    void append({
      type: EventKind.Custom,
      event_type: `${DELEGATED_PREFIX}${engineId}`,
      payload: {
        kind: event.type,
        data: event.payload,
        engine: engineId,
        requestedModel: options.requestedModel ?? null,
        ...activityScope,
      },
    })
      .then((eventId) => {
        if (committedStream) core.emit(UiEvent.ChatStreamCommitted, { threadId, streamId: committedStream, eventId });
        core.emit(UiEvent.DelegatedEvent, { engine: engineId, ...event });
      })
      .catch((error) => core.options.onLog?.(`Could not record delegated activity: ${String(error)}`, "stderr"));
  }

  return mirror;
}
