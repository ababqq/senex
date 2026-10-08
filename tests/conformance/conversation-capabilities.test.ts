import { test } from "node:test";
import assert from "node:assert/strict";
import { startRig, customEvents } from "../helpers/studio-rig.ts";
import { coordinatorTools } from "../../src/harness-seed/loop/run-inbox.ts";
import type { DelegateRequest, CompleteRequest } from "../../src/substrate/engines/types.ts";

test("existing chat coordinators see current builder capabilities without receiving their execution tools", async () => {
  const rig = await startRig({ replies: [] });
  try {
    const project = "capability-chat";
    await rig.core.projects.scaffold(project);
    const threadId = await rig.core.createProjectThread(project);
    const api = rig.core.api() as unknown as Record<string, (p: any) => Promise<any>>;
    for (const engine of ["codex", "claude-code", "bonsai"]) {
      let seen: DelegateRequest | undefined;
      rig.core.engines.register({
        id: engine,
        label: engine,
        kind: "delegated",
        models: async () => [],
        status: async () => ({ code: "ready" }),
        delegate: async (request: DelegateRequest) => {
          seen = request;
          return { ok: true, engine, summary: "fixture", turns: 1, usage: {} };
        },
      } as never);
      const call = () =>
        api["engine.delegate"]!({
          engine,
          threadId,
          project,
          prompt: "Do you see Genex tools? Just answer.",
          coordinator: { runId: "fixture" },
          readOnly: true,
        });
      await rig.core.plugins.setEnabled("genex", true);
      await call();
      assert.match(seen!.prompt, /genex__asset/);
      assert.match(seen!.prompt, /capabilities of this project's builders/);
      assert.match(seen!.prompt, /cannot call them in this conversation/);
      assert.match(seen!.prompt, /"account":"locked"/);
      assert.ok(!seen!.liveTools?.some((t) => t.name.startsWith("genex__")));
      await assert.rejects(
        Promise.resolve().then(() => seen!.onLiveTool!("genex__asset", { operation: "model" })),
        /unknown coordinator tool/,
      );
      await rig.core.plugins.setEnabled("genex", false);
      await call();
      assert.doesNotMatch(seen!.prompt, /genex__asset/);
    }
    await rig.core.plugins.setEnabled("genex", true);
    const services = rig.core.pluginServices;
    const original = services.call.bind(services);
    services.call = ((id: string, method: string, args: unknown, binding: unknown) =>
      method === "credentials.read"
        ? Promise.resolve("fixture-secret-do-not-disclose")
        : original(id, method, args as never, binding as never)) as typeof services.call;
    await rig.core.plugins.action("genex", "unlock", {});
    let completion: CompleteRequest | undefined;
    rig.core.engines.register({
      id: "local-fixture",
      kind: "direct",
      models: async () => [],
      status: async () => ({ code: "ready" }),
      complete: async (request: CompleteRequest) => {
        completion = request;
        return { message: { role: "assistant", content: "fixture" }, usage: {}, stopReason: "stop" };
      },
    } as never);
    // The local coordinator obtains the same facts through the harness capability API.
    const facts = await api["capabilities.describe"]!({ threadId, project });
    await api["engine.complete"]!({
      engine: "local-fixture",
      threadId,
      messages: [{ role: "user", content: `Do you see Genex?\n${facts}` }],
      tools: coordinatorTools,
    });
    assert.match(completion!.messages.map((message) => message.content).join("\n"), /genex__asset/);
    assert.match(
      completion!.messages.map((message) => message.content).join("\n"),
      /capabilities of this project's builders/,
    );
    assert.match(completion!.messages.map((message) => message.content).join("\n"), /"account":"unlocked"/);
    assert.doesNotMatch(
      completion!.messages.map((message) => message.content).join("\n"),
      /fixture-secret-do-not-disclose/,
    );
    assert.deepEqual(completion!.tools, coordinatorTools);
    await api["engine.complete"]!({
      engine: "local-fixture",
      threadId,
      messages: [{ role: "user", content: "Judge this image" }],
      tools: [],
      stream: false,
    });
    assert.doesNotMatch(completion!.systemPrompt ?? "", /genex__asset/, "judges do not receive builder guidance");
    const events = await rig.core.store.listEvents(threadId);
    assert.ok(customEvents(events, "conversation_capabilities_applied").length >= 7);
    assert.equal(
      customEvents(events, "tool_registry_applied").length,
      0,
      "description never claims execution tools were applied",
    );
  } finally {
    await rig.stop();
  }
});
