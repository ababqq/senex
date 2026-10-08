/**
 * Chat = one folder + one contractor session. These helpers are the load-bearing shape:
 * a follow-up never guesses a sibling project, and "keep going" without a session still
 * carries the original ask instead of briefing a blank new job.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildContractorBrief,
  isContinueAsk,
  lastContractorSession,
  originalAsk,
  resolveChatProject,
} from "../../src/harness-seed/loop/chat-session.ts";
import { runDelegatedTurn } from "../../src/harness-seed/loop/delegated-turn.ts";
import { launchRules } from "../../src/harness-seed/loop/launch-prompts.ts";
import { fencedCommand } from "../../src/shared/terminal.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

type ChatMessage = { role: string; content: string };

describe("chat session helpers", () => {
  it("recognises keep-going phrasing, including a stretched keep", () => {
    assert.equal(isContinueAsk("keeep going plz"), true);
    assert.equal(isContinueAsk("Keep going from where we left off."), true);
    assert.equal(isContinueAsk("continue"), true);
    assert.equal(isContinueAsk("resume the build"), true);
    assert.equal(isContinueAsk("I want a rainy night city"), false);
  });

  it("never guesses a project from preview or newest-project", () => {
    const projects = [
      { name: "older", dir: "/projects/older" },
      { name: "newer", dir: "/projects/newer" },
    ];
    assert.equal(resolveChatProject({}, projects), null);
    assert.equal(resolveChatProject({ project: "missing" }, projects), null);
    assert.equal(resolveChatProject({ newProject: true, project: "older" }, projects), null);
    assert.equal(resolveChatProject({ project: "older" }, projects), "older");
  });

  it("skips keep-going lines when finding the original ask", () => {
    assert.equal(
      originalAsk([
        { role: "user", content: "Keep going" },
        { role: "user", content: "Build a megastructure of rusted walkways" },
        { role: "user", content: "Keep going from where we left off." },
      ] as ChatMessage[]),
      "Build a megastructure of rusted walkways",
    );
  });

  it("a keep-going brief without resume includes the original ask", () => {
    const brief = buildContractorBrief({
      ask: "Keep going",
      messages: [
        { role: "user", content: "Make Blame! — a vertical megastructure" },
        { role: "assistant", content: "Handing this to the contractor." },
        { role: "user", content: "Keep going" },
      ] as ChatMessage[],
      folderLabel: "AI Projects/blame",
    });
    assert.match(brief, /Make Blame!/);
    assert.match(brief, /Latest instruction:\nKeep going/);
    assert.match(brief, /this workspace \(folder `AI Projects\/blame`\)/);
    assert.doesNotMatch(brief, /You are resuming your own session/);
  });

  it("a resume brief is a short pickup, not a re-brief of the original job", () => {
    const brief = buildContractorBrief({
      ask: "Keep going",
      messages: [{ role: "user", content: "Make Blame!" }] as ChatMessage[],
      resume: true,
      folderLabel: "AI Projects/blame",
    });
    assert.match(brief, /resuming your own session/i);
    assert.doesNotMatch(brief, /Original request/);
  });

  it("reads the last contractor session from the log, newest last", () => {
    const found = lastContractorSession(
      [
        {
          data: {
            type: "custom",
            event_type: "delegation_incomplete",
            payload: { sessionId: "ses_old", engine: "vendor", project: "older" },
          },
        },
        {
          data: {
            type: "custom",
            event_type: "contractor_session",
            payload: { sessionId: "ses_ok", engine: "vendor", project: "older" },
          },
        },
      ],
      "vendor",
    );
    assert.deepEqual(found, { sessionId: "ses_ok", engine: "vendor", project: "older" });
  });

  it("tells a chat build to hand a blocked step to the user in a block the chat can run", () => {
    const brief = buildContractorBrief({ ask: "Add engine sounds" });
    const fence = /one command on a single line in a ```(\w+) block/.exec(brief)?.[1];
    assert.ok(fence, "the brief names the fence a command for the user goes in");
    assert.equal(fencedCommand("brew install ffmpeg", fence), "brew install ffmpeg");
  });

  it("talks like a person first: small talk gets a short reply, no tools and nothing about the studio", () => {
    for (const brief of [
      buildContractorBrief({ ask: "Hello", fresh: true }),
      buildContractorBrief({ ask: "hi", ownShape: true, shape: { main: "src/project.ts" } }),
    ]) {
      const talk = brief.search(/greeting/i);
      assert.ok(talk >= 0, "the brief says how to answer a greeting");
      assert.ok(talk < brief.search(/CLAUDE\.md/), "before any rule about building");
    }
    const loop = launchRules("claude-code", { toolName: "start_unattended_run" }).join("\n");
    assert.ok(
      loop.search(/greeting/i) >= 0 && loop.search(/greeting/i) < loop.search(/ask_user/),
      "a Loop chat replies before it asks",
    );
  });

  it("briefs a brand-new project's first message as a blank page, and a built one's as code to continue", () => {
    const fresh = buildContractorBrief({ ask: "Hello", fresh: true, folderLabel: "AI Projects/untitled-project" });
    assert.doesNotMatch(fresh, /existing code/);
    assert.match(fresh, /nothing has been built/i);
    assert.match(buildContractorBrief({ ask: "Hello", folderLabel: "AI Projects/arena" }), /existing code/);
  });
});

describe("a chat's first message in a project", () => {
  /** The brief a project's first message is delegated with, its folder at `commits` commits and `changes` uncommitted. */
  async function briefFor({
    commits,
    changes = "",
    prior = [] as ChatMessage[],
  }: {
    commits: string;
    changes?: string;
    prior?: ChatMessage[];
  }) {
    const prompts: string[] = [];
    const recorder = ctxRecorder({
      threadId: "t1",
      unknown: { value: null },
      handlers: {
        "events.messages": () => [...prior, { role: "user", content: "Hello" }],
        "events.list": () => [],
        "project.list": () => [{ name: "untitled-project", title: "Untitled project", dir: "/g/untitled-project" }],
        "project.contentStamp": () => ({ all: "same", source: "same" }),
        "run.exec": (params) => {
          const command = String(params.command);
          if (command.includes("rev-list")) return { code: 0, stdout: `${commits}\n`, stderr: "" };
          if (command.includes("status")) return { code: 0, stdout: changes, stderr: "" };
          return { code: 1, stdout: "", stderr: "unexpected" };
        },
        "engine.delegate": (params) => {
          prompts.push(String(params.prompt));
          return { ok: true, engine: "claude-code", turns: 1, usage: {}, sessionId: "s1", summary: "Hi!" };
        },
      },
    });
    await runDelegatedTurn(recorder.ctx as never, {
      threadId: "t1",
      turnId: "turn-1",
      text: "Hello",
      engine: "claude-code",
      engineLabel: "Claude Code",
      project: "untitled-project",
    });
    return prompts[0] ?? "";
  }

  it("is a blank page when nothing has been made in the project since the studio made it", async () => {
    assert.match(await briefFor({ commits: "1" }), /nothing has been built/i);
  });

  it("continues from the code once anything has been made, or the chat is already talking", async () => {
    assert.match(await briefFor({ commits: "3" }), /existing code/);
    assert.match(await briefFor({ commits: "1", changes: " M src/main.js\n" }), /existing code/);
    assert.doesNotMatch(
      await briefFor({ commits: "1", prior: [{ role: "user", content: "Make a fishing project" }] }),
      /nothing has been built/i,
    );
  });
});
