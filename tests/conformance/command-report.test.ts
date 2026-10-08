/**
 * The result of a command the user ran from a reply goes to the agent as a message the chat wrote
 * itself: the send carries its origin to the harness, the queue keeps it, and the transcript never
 * draws it as the user's bubble.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isChatReport, MessageOrigin } from "../../src/shared/protocol.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { EventKind, type EventEnvelope } from "../../src/shared/event-log.ts";
import { messageQueueState } from "../../src/shared/message-queue.ts";
import { chatReportEntryIds } from "../../src/renderer/chat/transcript.ts";
import { chatLoopExtras, loopCommissions, rememberChatLoop } from "../../src/renderer/loop-setting.ts";
// `useReport` calls no React hook: it builds the chat's sender for a command's result.
import { useReport as reporter } from "../../src/renderer/chat/use-submit.ts";
import { coreLite } from "../helpers/core-lite.ts";

const envelope = (id: string, data: EventEnvelope["data"]): EventEnvelope => ({
  id,
  thread_id: "t",
  session_id: null,
  turn_id: null,
  created_at: "2026-09-27T09:00:00.000Z",
  data,
});
const queued = (eventId: string, messageId: string, action: Record<string, unknown>) => [
  envelope(eventId, { type: EventKind.Messages, messages: [{ role: "user", content: String(action.text) }] }),
  envelope(`${eventId}-q`, {
    type: EventKind.Custom,
    event_type: CustomEvent.CoordinatorMessageQueued,
    payload: { messageId, action },
  }),
];

test("a command's result is sent to the harness with its origin", async (t) => {
  const { core } = await coreLite();
  const thread = await core.createProjectThread();
  const dispatched: Record<string, unknown>[] = [];
  t.mock.method(core.host, "dispatch", async (action: Record<string, unknown>) => {
    dispatched.push(action);
  });
  await core.sendUserMessage("I ran this in the terminal", { thread, origin: MessageOrigin.CommandResult });
  await core.sendUserMessage("Make it rain", { thread });
  assert.equal(dispatched[0]?.origin, MessageOrigin.CommandResult);
  assert.equal("origin" in (dispatched[1] ?? {}), false, "the user's own words carry no origin");
});

test("the transcript leaves out the messages the chat wrote itself, and only those", () => {
  const events = [
    ...queued("e1", "m1", { text: "Convert the recordings" }),
    ...queued("e2", "m2", { text: "I ran this in the terminal", origin: MessageOrigin.CommandResult }),
    ...queued("e3", "m3", { text: "A stranger origin", origin: "something-else" }),
  ];
  const { messages } = messageQueueState(events);
  assert.deepEqual([...chatReportEntryIds(messages.values())], ["e2-0:user"]);
  assert.equal(isChatReport(undefined), false);
  assert.equal(isChatReport({ origin: MessageOrigin.CommandResult }), true);
});

test("a command's result carries the chat's Loop only before the chat's first build", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
  const threadId = "derby-chat";
  rememberChatLoop(storage, threadId, { on: true, hours: 2 });
  const fresh = chatLoopExtras({ storage, threadId, build: null, coordinating: false, projectMode: true });
  assert.deepEqual(fresh, { autopilot: { hours: 2, frames: [] } });
  const building = chatLoopExtras({ storage, threadId, build: null, coordinating: true, projectMode: true });
  assert.deepEqual(building, {}, "a running build takes no new commission");
  const halfHour = { on: true, hours: 0.5 };
  const finished = chatLoopExtras({
    storage,
    threadId,
    build: { state: "finished", loop: halfHour },
    coordinating: false,
    projectMode: true,
  });
  // Flipped (was: the chat's own Loop again): a result is not the person asking for more, so it never reopens the build.
  assert.deepEqual(finished, {}, "a finished build: a command's result carries no Loop");
  assert.equal(loopCommissions({ state: "finished" }), true, "a message the person types still does");
  const paused = chatLoopExtras({
    storage,
    threadId,
    build: { state: "paused", loop: halfHour },
    coordinating: false,
    projectMode: true,
  });
  assert.deepEqual(paused, {}, "a paused build takes no new commission");
  rememberChatLoop(storage, threadId, { on: false, hours: 2 });
  assert.deepEqual(chatLoopExtras({ storage, threadId, build: null, coordinating: false, projectMode: true }), {});
  assert.deepEqual(chatLoopExtras({ storage, threadId, build: null, coordinating: false, projectMode: false }), {});
});

test("a command's result is sent with its origin, and with the chat's Loop only before the chat's first build", async (t) => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  t.after(() => void delete (globalThis as { localStorage?: unknown }).localStorage);
  const threadId = "derby-chat";
  rememberChatLoop(storage, threadId, { on: true, hours: 2 });
  const model = {
    selected: "claude-code::opus",
    choices: [{ key: "claude-code::opus", engine: "claude-code", model: "opus", label: "Opus", disabled: false }],
    roleOthers: [],
    studio: false,
    selectedEngine: { id: "claude-code" },
    plannerEffort: "low",
    roles: null,
    preferences: {},
  };
  const words = "I ran this in the terminal:\nnpm test\n\nIt failed (exit code 1). It printed nothing.";
  /** What the chat sends for a command's result while its build is in `state` (null: none yet). */
  const sendFor = async (state: string | null): Promise<Record<string, unknown>> => {
    const sent: Array<Record<string, unknown>> = [];
    const run = state ? { runId: "run-1", state } : null;
    const build = run ? { state, loop: { on: true, hours: 0.5 } } : null;
    const props = { onSend: async (_text: string, options: Record<string, unknown>) => void sent.push(options) };
    await reporter(
      props as never,
      { threadId, run, isStudioThread: false } as never,
      { model, build } as never,
    )(words, MessageOrigin.CommandResult);
    assert.equal(sent.length, 1);
    return sent[0] ?? {};
  };
  const fresh = await sendFor(null);
  assert.deepEqual(fresh.autopilot, { hours: 2 }, "before the first build: the chat's Loop goes on with it");
  assert.equal(fresh.origin, MessageOrigin.CommandResult);
  for (const state of ["running", "paused", "finished"]) {
    const sent = await sendFor(state);
    assert.equal("autopilot" in sent, false, `${state}: no commission`);
    assert.equal(sent.origin, MessageOrigin.CommandResult);
    assert.equal(sent.engine, "claude-code");
  }
});
