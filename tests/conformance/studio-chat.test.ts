import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn } from "../../src/harness-seed/loop/turn-loop.ts";
import type { CompleteRequest } from "../../src/substrate/engines/types.ts";
import type { EventEnvelope, Message } from "../../src/substrate/types.ts";

function rig(kind = "delegated", answer = "Hello! What would you like to know about Studio?") {
  const events: EventEnvelope[] = [];
  const requests: CompleteRequest[] = [];
  const methods: string[] = [];
  const add = (message: Message) =>
    events.push({
      id: String(events.length),
      thread_id: "studio",
      turn_id: "turn",
      session_id: null,
      created_at: new Date().toISOString(),
      data: { type: "messages", messages: [message] },
    });
  const ctx = {
    cancelled: false,
    notify: () => {},
    setStatus: () => {},
    call: async (method: string, p?: any): Promise<any> => {
      methods.push(method);
      if (method === "engine.describe")
        return [
          {
            id: "chosen",
            kind,
            supportsSessions: kind === "delegated",
            models: [{ id: "one", contextWindow: 32768 }],
            defaultModel: "one",
          },
        ];
      if (method === "events.list") return events;
      if (method === "studio.context")
        return { recentActivity: [{ title: "Updated camera instructions", status: "Applied" }] };
      if (method === "engine.complete") {
        requests.push(p);
        return { message: { role: "assistant", content: answer }, usage: { input_tokens: 42 } };
      }
      if (method === "turn.append") {
        for (const item of p.batch) if (item.type === "messages") item.messages.forEach(add);
        return;
      }
      throw new Error(`Unexpected authority: ${method}`);
    },
  };
  return { ctx, events, requests, methods, add };
}

for (const kind of ["delegated", "direct"])
  test(`${kind} Studio chat calls the chosen model with conversation and recorded activity, never build tools`, async () => {
    const r = rig(kind);
    r.add({ role: "user", content: "hi" });
    const options = { engine: "chosen", model: "one", studioThread: true, threadId: "studio", turnId: "turn" };
    await runTurn(r.ctx as never, options);
    r.add({ role: "user", content: "How does it learn?" });
    await runTurn(r.ctx as never, {
      ...options,
      stills: [{ mimeType: "image/png", data: "pixels", label: "Screenshot" }],
    });
    assert.equal(r.requests.length, 2);
    assert.equal(r.requests[0]!.model, "one");
    assert.match(r.requests[1]!.systemPrompt!, /Updated camera instructions/);
    assert.ok(r.requests[1]!.messages.some((message) => message.content.includes("Hello!")));
    assert.deepEqual(r.requests[1]!.messages.at(-1)!.images, [
      { mimeType: "image/png", data: "pixels", label: "Screenshot" },
    ]);
    assert.equal(r.requests[1]!.tools, undefined);
    assert.ok(!r.methods.includes("engine.delegate") && !r.methods.includes("project.scaffold"));
  });

test("an empty Studio response is an actionable error and cannot appear as a successful assistant message", async () => {
  const r = rig("delegated", "");
  r.add({ role: "user", content: "hi" });
  await assert.rejects(
    runTurn(r.ctx as never, { engine: "chosen", studioThread: true, threadId: "studio", turnId: "turn" }),
    /empty reply/,
  );
  assert.equal(r.events.length, 1);
});

test("Stop prevents a Studio completion from starting", async () => {
  const r = rig();
  r.ctx.cancelled = true;
  const result = await runTurn(r.ctx as never, {
    engine: "chosen",
    studioThread: true,
    threadId: "studio",
    turnId: "turn",
  });
  assert.equal(result.stopped, "cancelled");
  assert.equal(r.requests.length, 0);
});
