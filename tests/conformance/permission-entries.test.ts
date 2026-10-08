/**
 * A `tool_permission` request rides the log twice — asked, then settled — and both land on one
 * chat entry keyed by its request id. The pending row stays in the chat's state projection (so the
 * card stays reachable when its history page is unloaded) and in Needs you until it settles.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toEntries } from "../../src/renderer/chat-entries.ts";
import { chatContext } from "../../src/shared/chat-history.ts";
import { applyEvents, EMPTY_NOTICES, waitingNotices } from "../../src/renderer/notifications.ts";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";

const event = (id: number, data: EventData): EventEnvelope => ({
  id: String(id).padStart(6, "0"),
  thread_id: "t1",
  turn_id: "turn",
  session_id: null,
  created_at: new Date(id).toISOString(),
  data,
});
const permission = (id: number, payload: Record<string, unknown>) =>
  event(id, { type: "custom", event_type: "tool_permission", payload });
const asked = (id: number, requestId: string) =>
  permission(id, {
    requestId,
    project: "project",
    threadId: "t1",
    tool: "Bash",
    title: "Claude wants to run npm install",
    subject: "npm install",
    input: { command: "npm install" },
    always: [{ kind: "rule", rule: "Bash(npm install:*)", scope: "game" }],
    state: "pending",
  });
const settled = (id: number, requestId: string, fields: Record<string, unknown>) =>
  permission(id, { requestId, project: "project", threadId: "t1", tool: "Bash", input: {}, ...fields });

describe("tool_permission entries", () => {
  it("is one pending card until its settled row arrives, then that card's outcome", () => {
    const pending = toEntries([asked(1, "r1")]);
    assert.equal(pending.length, 1);
    const card = pending[0]!;
    assert.ok(card.kind === "action" && card.action === "permission");
    assert.equal(card.pending, true);
    assert.equal(card.text, "Claude wants to run npm install");
    assert.equal(card.permission?.subject, "npm install");
    assert.equal(card.outcome, undefined);

    const done = toEntries([asked(1, "r1"), settled(2, "r1", { state: "allowed", by: "user", granted: "always" })]);
    assert.equal(done.length, 1, "the settled row lands on the same card");
    const outcome = done[0]!;
    assert.ok(outcome.kind === "action" && outcome.action === "permission");
    assert.equal(outcome.pending, false);
    assert.equal(outcome.outcome, "Always allowed");
    // What was asked stays on the card; the settled row adds how it ended.
    assert.equal(outcome.permission?.title, "Claude wants to run npm install");
    assert.equal(outcome.permission?.granted, "always");
  });

  it("keeps the question it first showed: a later row with its id changes only how it ended", () => {
    const forged = permission(2, {
      requestId: "r1",
      project: "project",
      threadId: "t1",
      tool: "Bash",
      title: "Claude wants to run ls",
      subject: "ls",
      input: { command: "ls" },
      state: "pending",
    });
    const [card] = toEntries([asked(1, "r1"), forged]);
    assert.ok(card?.kind === "action" && card.action === "permission");
    assert.equal(card.permission?.subject, "npm install");
    assert.equal(card.permission?.title, "Claude wants to run npm install");
  });

  it("keeps separate requests apart and says when the work withdrew one", () => {
    const entries = toEntries([asked(1, "r1"), asked(2, "r2"), settled(3, "r1", { state: "denied", by: "stop" })]);
    const cards = entries.filter((entry) => entry.kind === "action" && entry.action === "permission");
    assert.equal(cards.length, 2);
    assert.deepEqual(
      cards.map((card) => card.kind === "action" && [card.permission?.requestId, card.pending, card.outcome]),
      [
        ["r1", false, "Withdrawn when the work stopped"],
        ["r2", true, undefined],
      ],
    );
  });

  it("stays in the state projection only while it waits", () => {
    const waiting = chatContext([], [asked(1, "r1"), asked(2, "r2")]);
    assert.equal(waiting.filter((e) => e.data.type === "custom" && e.data.event_type === "tool_permission").length, 2);
    const after = chatContext(waiting, [settled(3, "r1", { state: "allowed", by: "user", granted: "once" })]);
    assert.deepEqual(
      after.map((e) => e.data.type === "custom" && (e.data.payload as { requestId?: string }).requestId),
      ["r2"],
    );
  });

  it("waits in Needs you with the card's question until it settles", () => {
    const raised = applyEvents(EMPTY_NOTICES, [asked(1, "r1")]);
    const waiting = waitingNotices(raised.state.items);
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0]?.kind, "permission");
    assert.equal(waiting[0]?.text, "Claude wants to run npm install");
    const answered = applyEvents(raised.state, [settled(2, "r1", { state: "denied", by: "user" })]);
    assert.equal(waitingNotices(answered.state.items).length, 0);
  });
});
