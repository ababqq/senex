/**
 * What a contractor hears back from a plugin tool (PLG-3).
 *
 * The SDK types `tool()` as `Promise<unknown>` and the guide's skeleton returns nothing, so a
 * plugin may answer `undefined`, `null`, a string or an array. The tool has already done its work
 * (and the ledger says ok) by the time the engine is answered: the answer must never turn into a
 * failure, and a plain string must reach the model as the string it is.
 */
import { it } from "node:test";
import assert from "node:assert/strict";
import { coreLite } from "../helpers/core-lite.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";

const TOOL = {
  name: "fixture__deliver",
  description: "Deliver something",
  parameters: { type: "object", properties: {} },
};

it("a plugin tool's non-object answer reaches the engine intact, and nothing reads as a failure", async () => {
  const lite = await coreLite();
  const { core } = lite;
  const project = "live-results";
  await core.projects.scaffold(project);

  let answer: unknown;
  // The registry is the plugin boundary; the host's wrapper is what is under test.
  core.plugins.snapshot = (() => ({
    tools: [TOOL],
    guidance: "",
    applied: { plugins: ["fixture"], skills: [] },
  })) as never;
  core.plugins.tool = (async () => answer) as never;

  const heard: Array<{ returned: unknown; error: string | null }> = [];
  core.engines.register({
    id: "claude-code",
    label: "fixture",
    kind: "delegated",
    supportsSessions: true,
    status: async () => ({ code: "ready", detail: "fixture" }),
    models: async () => [],
    delegate: async (request: DelegateRequest) => {
      assert.ok(
        request.liveTools?.some((tool) => tool.name === TOOL.name),
        "the plugin tool is offered",
      );
      try {
        heard.push({ returned: await request.onLiveTool!(TOOL.name, {}), error: null });
      } catch (err) {
        heard.push({ returned: undefined, error: (err as Error).message });
      }
      return { ok: true, engine: "claude-code", summary: "fixture", turns: 1, usage: {} };
    },
  } as never);
  const api = core.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;

  const cases: Array<{ label: string; value: unknown; expected: unknown }> = [
    { label: "undefined", value: undefined, expected: "null" },
    { label: "null", value: null, expected: "null" },
    { label: "string", value: "Done", expected: "Done" },
    { label: "array", value: ["a", "b"], expected: JSON.stringify(["a", "b"]) },
    { label: "number", value: 3, expected: "3" },
    { label: "object", value: { ok: true, file: "x.glb" }, expected: JSON.stringify({ ok: true, file: "x.glb" }) },
  ];
  for (const { label, value, expected } of cases) {
    answer = value;
    heard.length = 0;
    await api["engine.delegate"]!({ engine: "claude-code", project, prompt: `call it (${label})` });
    assert.equal(heard.length, 1, label);
    assert.equal(heard[0]!.error, null, `${label}: a tool that answered must not read as a failure`);
    assert.equal(heard[0]!.returned, expected, label);
  }

  // Images still split off an object answer as before.
  answer = { note: "see", images: [{ mimeType: "image/png", data: "AA==" }] };
  heard.length = 0;
  await api["engine.delegate"]!({ engine: "claude-code", project, prompt: "call it (images)" });
  assert.deepEqual(heard[0]!.returned, {
    text: JSON.stringify({ note: "see" }),
    images: [{ mimeType: "image/png", data: "AA==" }],
  });
});
