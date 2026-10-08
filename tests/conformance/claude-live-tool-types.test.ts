/**
 * PLG-2: a plugin tool's declared parameter types survive the Claude live-tool mapping.
 *
 * Plugin tools reach Claude Code with only their flat `parameters` (no separate JSON Schema).
 * The mapping used to register every non-number parameter as a string, so a `boolean` or an API 3
 * `object` parameter could only be sent as text — which the plugin registry then refuses. The
 * registered schema is the model's real contract, so it is read back from the studio server and
 * the arguments it lets through are checked by the registry's own validator.
 */
import { fixtureCodingCli } from "../helpers/external-cli.ts";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { ClaudeCodeEngine } from "../../src/substrate/engines/claude-code.ts";
import { validateArguments } from "../../src/substrate/plugins/manifest.ts";
import type { PluginTool } from "../../src/shared/plugins.ts";
import { registeredSchema, scriptedClaude } from "../helpers/scripted-claude.ts";
import { tmpDir } from "../helpers/tmp.ts";

delete process.env.CLAUDE_CONFIG_DIR;

const TOOL: PluginTool = {
  name: "sfx__make",
  description: "Make a sound effect.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string" },
      loop: { type: "boolean", description: "Loop it." },
      volume: { type: "number" },
      options: { type: "object", description: "Synth options." },
      preset: { type: "object", acceptJsonString: true },
    },
    required: ["name", "loop"],
  },
} as PluginTool;

async function engineWithLogin(queryFn: never): Promise<ClaudeCodeEngine> {
  const root = await tmpDir("claude-live-types-");
  const home = path.join(root, "claude-home");
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, ".credentials.json"), "{}");
  return new ClaudeCodeEngine({
    resolveCli: fixtureCodingCli,
    engineHome: home,
    systemHome: path.join(root, "none"),
    queryFn,
  });
}

describe("PLG-2: plugin tool parameter types on Claude Code", () => {
  it("a boolean and an object parameter arrive typed, and the registry accepts what the model sent", async () => {
    const args = { name: "coin", loop: true, volume: 0.5, options: { wave: "square" }, preset: '{"bpm":120}' };
    const script = scriptedClaude([{ tool: TOOL.name, args }]);
    const engine = await engineWithLogin(script.queryFn);
    const seen: Array<Record<string, unknown>> = [];
    await engine.delegate({
      prompt: "build",
      cwd: "/tmp/project-workspace",
      liveTools: [TOOL],
      onLiveTool: async (_name, received) => {
        validateArguments(TOOL, received);
        seen.push(received);
        return "made";
      },
    });

    const schema = registeredSchema(script, TOOL.name);
    assert.ok(schema, "the studio server registered the plugin tool");
    assert.equal(schema!.safeParse(args).success, true, "a real boolean and a real object are what the model may send");
    assert.equal(
      schema!.safeParse({ ...args, preset: { bpm: 120 } }).success,
      true,
      "an acceptJsonString object takes an object too",
    );
    assert.equal(
      schema!.safeParse({ ...args, loop: "true" }).success,
      false,
      "a boolean sent as text is refused at the schema, not later by the registry",
    );
    assert.equal(
      schema!.safeParse({ ...args, options: '{"wave":"square"}' }).success,
      false,
      "a plain object parameter is not a string",
    );
    assert.equal(schema!.safeParse({ ...args, volume: "0.5" }).success, false);
    assert.equal(schema!.safeParse({ name: "coin" }).success, false, "required stays required");
    assert.deepEqual(seen, [args], "the call reached the plugin, and the registry's validator passed it");
    assert.equal(script.calls[0]?.text, "made");
  });
});
