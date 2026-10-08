/** The helpers the Claude Code and Codex engines share (src/substrate/engines/common.ts). */
import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  abortControllerFor,
  clip,
  COMPLETE_TIMEOUT_MS,
  hasCredentials,
  interruption,
  partialDelegateResult,
} from "../../src/substrate/engines/common.ts";
import { tmpDir } from "../helpers/tmp.ts";

it("clips long trace text and says how much was cut", () => {
  assert.equal(clip("short", 10), "short");
  assert.equal(clip("0123456789", 10), "0123456789");
  assert.equal(clip("0123456789abc", 10), "0123456789… [3 more chars]");
});

it("gives a deadline a controller that follows the caller's signal", () => {
  assert.equal(abortControllerFor().signal.aborted, false, "no signal still yields a controller");
  const caller = new AbortController();
  const follower = abortControllerFor(caller.signal);
  assert.equal(follower.signal.aborted, false);
  caller.abort();
  assert.equal(follower.signal.aborted, true);
  assert.equal(
    abortControllerFor(AbortSignal.abort()).signal.aborted,
    true,
    "an already-aborted signal aborts at once",
  );
  const own = new AbortController();
  const independent = abortControllerFor(own.signal);
  independent.abort();
  assert.equal(own.signal.aborted, false, "the deadline aborting never aborts the caller");
});

it("keeps one completion ceiling for both engines", () => {
  assert.equal(COMPLETE_TIMEOUT_MS, 15 * 60_000);
});

it("tells a user's stop from a spent time budget", () => {
  assert.deepEqual(interruption(true), { stopReason: "stopped", errorText: "stopped by you" });
  assert.deepEqual(interruption(false), { stopReason: "deadline", errorText: "time budget exhausted" });
  assert.deepEqual(interruption(undefined), interruption(false), "no signal means the deadline stopped it");
});

it("reports a build cut short as an outcome that keeps what it did", () => {
  const usage = { engine: "codex", input_tokens: 10 };
  const calls = [{ name: "start_autopilot", args: { goal: "x" } }];
  const result = partialDelegateResult(
    "codex",
    { stopReason: "deadline", errorText: "time budget exhausted" },
    {
      summary: "half a project",
      usage,
      turns: 4,
      startedAt: Date.now() - 1_000,
      sessionId: "s-1",
      model: "gpt-x",
      requestedModel: undefined,
      cliVersion: "1.2.3",
      cliPath: "/usr/local/bin/codex",
      studioToolCalls: calls,
    },
  );
  const { durationMs, ...rest } = result;
  assert.ok(typeof durationMs === "number" && durationMs >= 1_000);
  assert.deepEqual(rest, {
    ok: false,
    summary: "half a project",
    usage,
    turns: 4,
    engine: "codex",
    stopReason: "deadline",
    errorText: "time budget exhausted",
    billing: "subscription",
    sessionId: "s-1",
    model: "gpt-x",
    cliPath: "/usr/local/bin/codex",
    cliVersion: "1.2.3",
    studioToolCalls: calls,
  });
  const bare = partialDelegateResult(
    "claude-code",
    { stopReason: "stopped", errorText: "stopped by you" },
    { summary: "", usage, turns: 0, startedAt: Date.now(), studioToolCalls: [] },
  );
  assert.equal("studioToolCalls" in bare, false, "no recorded calls, no empty list");
  assert.equal("sessionId" in bare, false);
});

it("detects a sign-in by the credential file or anything beside it, never by reading it", async () => {
  const empty = await tmpDir("studio-engine-home-");
  assert.equal(await hasCredentials(empty, ".credentials.json"), false);
  assert.equal(await hasCredentials(path.join(empty, "missing"), ".credentials.json"), false);
  const withFile = await tmpDir("studio-engine-home-");
  await writeFile(path.join(withFile, ".credentials.json"), "not read");
  assert.equal(await hasCredentials(withFile, ".credentials.json"), true);
  const withJson = await tmpDir("studio-engine-home-");
  await writeFile(path.join(withJson, "settings.json"), "{}");
  assert.equal(await hasCredentials(withJson, "auth.json"), true);
  const withDir = await tmpDir("studio-engine-home-");
  await mkdir(path.join(withDir, "projects"));
  assert.equal(await hasCredentials(withDir, "auth.json"), true);
});

it("ownership recovery state alone never selects an empty coding-provider login", async () => {
  const home = await tmpDir("studio-engine-runtime-");
  await mkdir(path.join(home, "ownership-locks"));
  assert.equal(await hasCredentials(home, "auth.json"), false);
  await writeFile(path.join(home, "auth.json"), "not opened");
  assert.equal(await hasCredentials(home, "auth.json"), true);
});
