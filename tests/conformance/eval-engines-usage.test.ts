/**
 * What the two subscription engines measure about a session, for the evals (plan M4.1, M4.2, M4.7):
 * every model a Claude session called, its thinking tokens and API timing; a Codex turn's
 * reasoning and cache tokens, every compaction and how full its window is; and the context
 * mirror keeping where a reading came from. The CLIs are injected (`queryFn`, `execFn`) and every
 * stream here is synthetic, shaped like the ones Claude Code 2.1 and Codex 0.15x write.
 */
import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import { delegationMirror } from "../../src/main/core/delegation-events.ts";
import type { StudioCore } from "../../src/main/studio-core.ts";
import { SessionActivityRole } from "../../src/shared/chat-activity.ts";
import { ContextSource, measuredContext } from "../../src/shared/context.ts";
import { CustomEvent, customPayload } from "../../src/shared/custom-events.ts";
import type { EventData } from "../../src/shared/event-log.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { ClaudeCodeEngine } from "../../src/substrate/engines/claude-code.ts";
import { CodexEngine, translateEvent, type CodexExec } from "../../src/substrate/engines/codex.ts";
import { DelegateEventType, type DelegateEvent } from "../../src/substrate/engines/types.ts";
import { fixtureCodingCli } from "../helpers/external-cli.ts";
import { tmpDir } from "../helpers/tmp.ts";

// An engine resolves its login homes the moment it is built: these get tmp homes of their own.
delete process.env.CLAUDE_CONFIG_DIR;

const MAIN_MODEL = "claude-fixture-main";
const AUX_MODEL = "claude-fixture-aux";

/** A Claude Code engine with a login of its own, whose SDK `query()` returns `stream`. */
async function claudeEngine(stream: object): Promise<ClaudeCodeEngine> {
  const root = await tmpDir("eval-engines-claude-");
  const home = path.join(root, "claude-home");
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, ".credentials.json"), "{}");
  return new ClaudeCodeEngine({
    resolveCli: fixtureCodingCli,
    engineHome: home,
    systemHome: path.join(root, "no-system-login"),
    judgeCwd: path.join(root, "judge"),
    queryFn: (() => stream) as never,
  });
}

/** A query object that yields `messages` and answers the telemetry controls it is given. */
function claudeStream(messages: unknown[], controls: Record<string, () => Promise<unknown>> = {}): object {
  return {
    ...controls,
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message;
    },
  };
}

const claudeInit = { type: "system", subtype: "init", model: MAIN_MODEL, session_id: "ses_eval", tools: [] };

/** A result as Claude Code writes it: per-turn main-loop `usage`, running-total `modelUsage`. */
function claudeResult(fields: Record<string, unknown>): Record<string, unknown> {
  return { type: "result", subtype: "success", is_error: false, result: "Built.", num_turns: 1, ...fields };
}

describe("claude code session measurement", () => {
  it("reads every model the session called, its thinking tokens and API timing, beside the main loop's tokens", async () => {
    const engine = await claudeEngine(
      claudeStream([
        claudeInit,
        claudeResult({
          duration_ms: 9000,
          duration_api_ms: 7000,
          ttft_ms: 1200,
          total_cost_usd: 1.5,
          usage: {
            input_tokens: 40,
            output_tokens: 900,
            cache_read_input_tokens: 5000,
            cache_creation_input_tokens: 700,
            output_tokens_details: { thinking_tokens: 300 },
          },
          modelUsage: {
            [MAIN_MODEL]: {
              inputTokens: 60,
              outputTokens: 1100,
              thinkingTokens: 350,
              cacheReadInputTokens: 6000,
              cacheCreationInputTokens: 800,
              webSearchRequests: 0,
              costUSD: 1.4,
              contextWindow: 1_000_000,
              maxOutputTokens: 64000,
            },
            [AUX_MODEL]: {
              inputTokens: 500,
              outputTokens: 10,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              webSearchRequests: 0,
              costUSD: 0.1,
              contextWindow: 200_000,
              maxOutputTokens: 32000,
            },
          },
        }),
      ]),
    );
    const result = await engine.delegate({ cwd: await tmpDir("eval-engines-run-"), prompt: "Build" });

    assert.deepEqual(
      [
        result.usage.input_tokens,
        result.usage.output_tokens,
        result.usage.cache_read_tokens,
        result.usage.cache_write_tokens,
      ],
      [40, 900, 5000, 700],
      "the top-level tokens stay the main loop's",
    );
    assert.equal(result.usage.reasoning_tokens, 300, "the main loop's thinking, already inside its output");
    assert.deepEqual(result.usage.by_model, {
      [MAIN_MODEL]: {
        input_tokens: 60,
        output_tokens: 1100,
        cache_read_tokens: 6000,
        cache_write_tokens: 800,
        reasoning_tokens: 350,
        cost_usd: 1.4,
        context_window: 1_000_000,
      },
      [AUX_MODEL]: {
        input_tokens: 500,
        output_tokens: 10,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd: 0.1,
        context_window: 200_000,
      },
    });
    assert.equal(result.usage.duration_api_ms, 7000);
    assert.equal(result.usage.ttft_ms, 1200);
    assert.equal(result.usage.cost_usd, 1.5);
  });

  it("takes running totals from the latest result, the first reply's latency from the first, and adds per-turn tokens", async () => {
    const model = (outputTokens: number) => ({
      [MAIN_MODEL]: { inputTokens: 1, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });
    const engine = await claudeEngine(
      claudeStream([
        claudeInit,
        claudeResult({
          duration_api_ms: 1000,
          ttft_ms: 400,
          usage: { input_tokens: 1, output_tokens: 10, output_tokens_details: { thinking_tokens: 4 } },
          modelUsage: model(10),
        }),
        claudeResult({
          duration_api_ms: 2500,
          ttft_ms: 900,
          usage: { input_tokens: 2, output_tokens: 30, output_tokens_details: { thinking_tokens: 6 } },
          modelUsage: model(40),
        }),
      ]),
    );
    const result = await engine.delegate({ cwd: await tmpDir("eval-engines-run-"), prompt: "Build" });

    assert.equal(result.usage.output_tokens, 40, "per-turn main-loop output adds up");
    assert.equal(result.usage.reasoning_tokens, 10, "per-turn main-loop thinking adds up");
    assert.equal(result.usage.by_model?.[MAIN_MODEL]?.output_tokens, 40, "modelUsage is a running total, not summed");
    assert.equal(result.usage.duration_api_ms, 2500);
    assert.equal(result.usage.ttft_ms, 400);
  });

  it("leaves a figure the CLI did not report absent, never zero", async () => {
    const engine = await claudeEngine(
      claudeStream([claudeInit, claudeResult({ usage: { input_tokens: 3, output_tokens: 5 }, modelUsage: {} })]),
    );
    const result = await engine.delegate({ cwd: await tmpDir("eval-engines-run-"), prompt: "Build" });

    for (const field of ["reasoning_tokens", "by_model", "duration_api_ms", "ttft_ms", "compactions"] as const)
      assert.equal(field in result.usage, false, field);
  });

  it("drops a model row whose counts are not counts", async () => {
    const engine = await claudeEngine(
      claudeStream([
        claudeInit,
        claudeResult({
          usage: {},
          modelUsage: {
            [MAIN_MODEL]: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 },
            broken: { inputTokens: "many", outputTokens: -1 },
            nothing: null,
          },
        }),
      ]),
    );
    const result = await engine.delegate({ cwd: await tmpDir("eval-engines-run-"), prompt: "Build" });

    assert.deepEqual(Object.keys(result.usage.by_model ?? {}), [MAIN_MODEL]);
  });

  it("counts each compaction, and says its context meter is the provider's own", async () => {
    const engine = await claudeEngine(
      claudeStream(
        [
          claudeInit,
          { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 9000 } },
          { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 9500 } },
          claudeResult({ usage: {} }),
        ],
        { getContextUsage: async () => ({ totalTokens: 24000, maxTokens: 200000, percentage: 12, model: MAIN_MODEL }) },
      ),
    );
    const events: DelegateEvent[] = [];
    const result = await engine.delegate({
      cwd: await tmpDir("eval-engines-run-"),
      prompt: "Build",
      onEvent: (event) => events.push(event),
    });
    // The reading is not awaited by the run: let its already-answered control settle.
    await setImmediate();

    assert.equal(result.usage.compactions, 2);
    const readings = events.filter((event) => event.type === DelegateEventType.ContextUsage);
    assert.ok(readings.length > 0, "the session's context was read");
    for (const reading of readings) assert.equal(reading.payload.source, ContextSource.Provider);
  });

  /** An assistant reply as Claude Code streams it, with the request's own token counts. */
  const reply = (usage: Record<string, number>, parent: string | null = null) => ({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { content: [{ type: "text", text: "Working." }], usage: { output_tokens: 40, ...usage } },
  });

  it("hands back the main loop's last request size, every input kind counted, never a subagent's", async () => {
    const engine = await claudeEngine(
      claudeStream([
        claudeInit,
        reply({ input_tokens: 5, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 1_000 }),
        reply({ input_tokens: 10, cache_read_input_tokens: 500_000, cache_creation_input_tokens: 90_000 }),
        reply({ input_tokens: 999_999 }, "tu_subagent"),
        claudeResult({ usage: {} }),
      ]),
    );
    const result = await engine.delegate({ cwd: await tmpDir("eval-engines-run-"), prompt: "Build" });
    assert.equal(result.contextTokens, 590_010);
  });

  it("hands back no request size once the session compacted after its last reply", async () => {
    const engine = await claudeEngine(
      claudeStream([
        claudeInit,
        reply({ input_tokens: 10, cache_read_input_tokens: 700_000 }),
        { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 700_010 } },
        claudeResult({ usage: {} }),
      ]),
    );
    const result = await engine.delegate({ cwd: await tmpDir("eval-engines-run-"), prompt: "Build" });
    assert.equal("contextTokens" in result, false);
  });
});

/** A Codex session id: the only shape the session-file reader accepts. */
const CODEX_SESSION = "01a0ca94-caa4-7302-8ceb-3758173d6dcf";

/** A signed-in Codex engine whose `codex exec` is `execFn`, and the home its session files live in. */
async function codexEngine(execFn: CodexExec): Promise<{ engine: CodexEngine; root: string; home: string }> {
  const root = await tmpDir("eval-engines-codex-");
  const home = path.join(root, "codex-home");
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, "auth.json"), "{}");
  const engine = new CodexEngine({
    resolveCli: fixtureCodingCli,
    engineHome: home,
    systemHome: path.join(root, "no-system-login"),
    executable: "/fake/codex",
    authStatusFn: async () => ({ loggedIn: true, method: "chatgpt", detail: "Logged in using ChatGPT" }),
    execFn,
  });
  return { engine, root, home };
}

/** The session file Codex keeps for `CODEX_SESSION`, filed under today's date. */
function sessionFile(home: string): string {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", path.sep);
  return path.join(home, "sessions", day, `rollout-fixture-${CODEX_SESSION}.jsonl`);
}

const jsonl = (rows: unknown[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join("");

describe("codex session measurement", () => {
  it("keeps a turn's reasoning inside its output, and reads its cache reads and writes", () => {
    const translated = translateEvent({
      type: "turn.completed",
      usage: {
        input_tokens: 1200,
        cached_input_tokens: 400,
        cache_write_input_tokens: 30,
        output_tokens: 800,
        reasoning_output_tokens: 50,
      },
    });
    assert.deepEqual(translated?.usage, {
      input_tokens: 1200,
      output_tokens: 800,
      reasoning_tokens: 50,
      cache_read_tokens: 400,
      cache_write_tokens: 30,
    });
  });

  it("leaves reasoning and cache writes absent when the CLI does not report them", () => {
    const translated = translateEvent({
      type: "turn.completed",
      usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 4 },
    });
    assert.deepEqual(translated?.usage, { input_tokens: 10, output_tokens: 4, cache_read_tokens: 0 });
  });

  it("counts every compaction since the build began, even two between polls, and reports how full the window is", async () => {
    let home = "";
    const {
      engine,
      root,
      home: engineHome,
    } = await codexEngine(() => ({
      async *[Symbol.asyncIterator]() {
        const file = sessionFile(home);
        await mkdir(path.dirname(file), { recursive: true });
        const now = new Date().toISOString();
        const earlier = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        await writeFile(
          file,
          jsonl([
            { type: "session_meta", payload: { id: CODEX_SESSION, cli_version: "0.150.0" } },
            { type: "turn_context", payload: { model: "fixture-codex-model" } },
            { type: "compacted", timestamp: earlier, payload: { message: "an older session's checkpoint" } },
          ]),
        );
        yield { type: "thread.started", thread_id: CODEX_SESSION };
        await appendFile(
          file,
          jsonl([
            { type: "compacted", timestamp: now, payload: { message: "checkpoint one" } },
            { type: "compacted", timestamp: now, payload: { message: "checkpoint two" } },
            {
              type: "event_msg",
              timestamp: now,
              payload: {
                type: "token_count",
                info: { last_token_usage: { input_tokens: 64_600 }, model_context_window: 258_400 },
              },
            },
          ]),
        );
        yield { type: "item.completed", item: { id: "m", type: "agent_message", text: "Built." } };
        yield {
          type: "turn.completed",
          usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 4, reasoning_output_tokens: 1 },
        };
      },
    }));
    home = engineHome;
    const events: DelegateEvent[] = [];
    const result = await engine.delegate({ cwd: root, prompt: "Build", onEvent: (event) => events.push(event) });

    const contexts = events.filter((event) => event.type === DelegateEventType.Context).map((event) => event.payload);
    assert.equal(contexts.filter((context) => context.compacted).length, 2, "each new boundary is announced once");
    assert.equal(result.usage.compactions, 2, "the older session's checkpoint is not this build's");
    const reading = contexts.find((context) => typeof context.promptTokens === "number");
    assert.equal(reading?.contextWindow, 258_400);
    assert.equal(reading?.percent, 25);
    assert.equal(reading?.source, ContextSource.ProviderSession);
    assert.equal(result.contextTokens, 64_600, "the last request's own prompt size comes back with the result");
  });

  it("reports no compactions for a build whose session never compacted", async () => {
    const { engine, root } = await codexEngine(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "thread.started", thread_id: CODEX_SESSION };
        yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
      },
    }));
    const result = await engine.delegate({ cwd: root, prompt: "Build" });
    assert.equal("compactions" in result.usage, false);
    assert.equal("contextTokens" in result, false, "a session that reported no request size hands none back");
  });
});

/** The chat's own session as the real mirror records it. */
function mirrored(engine: EngineId) {
  const events: Array<{ data: EventData }> = [];
  const core = {
    append: async (batch: EventData[]) => {
      events.push(...batch.map((data) => ({ data })));
      return "event";
    },
    emit: () => {},
    options: {},
  };
  const mirror = delegationMirror({
    core: core as unknown as StudioCore,
    threadId: "chat",
    requestThreadId: "chat",
    project: "project",
    engineId: engine,
    requestedModel: undefined,
    activityScope: { delegationId: "lead", role: SessionActivityRole.Planner },
  });
  return { events, onEvent: mirror.onEvent };
}

describe("the delegation mirror's context readings", () => {
  it("keeps the source a reading names, and calls one that names none an estimate", () => {
    const session = mirrored(EngineId.ClaudeCode);
    const reading = { promptTokens: 50_000, contextWindow: 1_000_000, percent: 5, model: MAIN_MODEL, sessionId: "s1" };
    session.onEvent({ type: DelegateEventType.ContextUsage, payload: { ...reading, source: ContextSource.Provider } });
    session.onEvent({ type: DelegateEventType.ContextUsage, payload: reading });

    const sources = session.events.map((event) => customPayload(event.data, CustomEvent.ContextUsage)?.source);
    assert.deepEqual(sources, [ContextSource.Provider, ContextSource.Estimated]);
  });

  it("shows the provider's own reading as measured, not as an estimate", () => {
    const session = mirrored(EngineId.ClaudeCode);
    session.onEvent({
      type: DelegateEventType.ContextUsage,
      payload: { promptTokens: 1, contextWindow: 10, percent: 10, source: ContextSource.Provider, sessionId: "s1" },
    });
    assert.equal(measuredContext(session.events, EngineId.ClaudeCode, "default")?.source, ContextSource.Provider);
  });
});
