/**
 * The door — where a launch lands (M1.7).
 *
 * The opening rule exists because a first launch used to land in the Studio thread — the one
 * chat that cannot build — so the first sentence a new user typed was answered with "this chat
 * never builds; press the folder+".
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  chatPlaceholder,
  COMPOSER_LINE_CHARS,
  composerPlaceholder,
  HOME_PLACEHOLDER,
  LEAD_PLACEHOLDER,
  PLAN_PLACEHOLDER,
  QUEUE_PLACEHOLDER,
} from "../../src/renderer/composer-placeholder.ts";
import { leadTakesChat } from "../../src/renderer/chat/live-chat.ts";
import { endClock } from "../../src/harness-seed/loop/wall-clock.ts";
import { createStudio } from "../../src/renderer/state/studio.ts";
import { Room, roomOf } from "../../src/renderer/state/threads.ts";
import type { Bootstrap, ConversationRecord } from "../../src/shared/studio-api.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const read = (file: string): string => readFileSync(path.join(root, file), "utf8");
const rendererFiles = (): string[] =>
  readdirSync(path.join(root, "src/renderer"), { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => path.join(root, "src/renderer", file));

/** The slice of a thread record a launch reads. */
interface OpeningThread {
  id: string;
  updated_at: string;
  metadata?: { kind?: string; project?: string | null; archived?: boolean } | null;
}

const studio: OpeningThread = { id: "studio", updated_at: "2026-09-01T10:00:00Z", metadata: { kind: "studio" } };
const project = (id: string, updated: string, project: string | null, archived = false): OpeningThread => ({
  id,
  updated_at: updated,
  metadata: { kind: "game", project, archived },
});

describe("the door: what the app opens on launch", () => {
  const record = (thread: OpeningThread): ConversationRecord => ({
    id: thread.id,
    agent_id: "a",
    created_at: thread.updated_at,
    updated_at: thread.updated_at,
    latest_event_id: null,
    metadata: thread.metadata ?? {},
  });
  const launch = async (threads: OpeningThread[], projects: string[], remembered: Record<string, string> = {}) => {
    const boot: Bootstrap = {
      threadId: "studio",
      layout: {},
      projectsRootLabel: "~/AI Projects",
      harness: { state: "ready", version: null, capabilities: [] },
      threads: threads.map(record),
      events: [],
      eventsCursor: null,
      engines: [],
      activeDelegations: {},
      projects: projects.map((name) => ({
        name,
        dir: `/g/${name}`,
        title: name,
        createdAt: "",
        pathLabel: name,
        library: true,
        built: false,
        shape: {
          entry: "index.html",
          main: "src/main.js",
          build: null,
          install: null,
          own: false,
          kind: "studio-template",
          serve: ".",
        },
      })),
    };
    const fake = fakeStudioApi({ bootstrap: async () => boot });
    const data = new Map(Object.entries(remembered));
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    };
    const timers = { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0 };
    const app = createStudio(fake.api, { storage, timers });
    app.start();
    await new Promise((resolve) => setImmediate(resolve));
    return { app, fake };
  };
  /** Home: no chat open, no project on the stage, nothing loaded, made or asked for. */
  const assertHome = ({ app, fake }: Awaited<ReturnType<typeof launch>>) => {
    assert.equal(app.threads.getState().activeThreadId, null, "no chat is selected");
    assert.equal(roomOf(app.threads.getState()), Room.Home);
    assert.equal(app.threads.getState().stageProject, null, "no project is on the stage");
    assert.deepEqual(fake.callsOf("loadPreview"), [], "no project is loaded behind home");
    for (const method of ["createProject", "nameProject", "newProjectThread", "threadForProject"] as const)
      assert.deepEqual(fake.callsOf(method), [], `${method}: nothing is made until the first message`);
  };

  it("opens home even when there are projects, and the last chat is remembered", async () => {
    // Intentionally flipped (2026-10-01): a launch used to reopen the remembered chat with its project
    // on the stage. Home is where every launch starts; the remembered chat is one click or ⌘1 away.
    const launched = await launch(
      [studio, project("old", "2026-09-01T10:00:00Z", "pond-life"), project("fresh", "2026-09-04T10:00:00Z", "rift")],
      ["pond-life", "rift"],
      { "studio.activeThread": "old", "studio.reviewProject": "rift", "studio.lastProjectThread": "old" },
    );
    assertHome(launched);
    assert.equal(
      launched.app.threads.getState().lastProjectThreadId,
      "old",
      "⌘1 still returns to the last project chat",
    );
  });

  it("an empty library opens home too: no Create project, nothing minted", async () => {
    // Intentionally flipped (2026-10-01): an empty library used to open Create project over Studio.
    assertHome(await launch([studio], []));
  });

  it("a remembered chat whose project was removed opens home like any other launch", async () => {
    assertHome(
      await launch([studio, project("gone", "2026-09-04T10:00:00Z", "deleted-project")], [], {
        "studio.activeThread": "gone",
      }),
    );
  });
});

describe("the door: the composer's own instruction", () => {
  const every = [QUEUE_PLACEHOLDER, LEAD_PLACEHOLDER, HOME_PLACEHOLDER, PLAN_PLACEHOLDER];
  for (const revisingPlan of [true, false])
    for (const studio of [true, false])
      for (const draft of [true, false]) every.push(chatPlaceholder({ revisingPlan, studio, draft }));

  it("fits the line it is drawn on", () => {
    // About 53 characters is what the composer shows on one line at the default chat width, and
    // an empty box measures none of it — this is the sentence a first launch is read from.
    for (const words of new Set(every))
      assert.ok(words.length <= COMPOSER_LINE_CHARS, `too long for one line: "${words}"`);
  });

  it("asks home what to make, and only an active build overrides the context", () => {
    // Intentionally flipped (2026-10-01): the words were "Describe a project…".
    assert.equal(HOME_PLACEHOLDER, "What do you want to make?");
    const firstLaunch = chatPlaceholder({ revisingPlan: false, studio: false, draft: true });
    assert.equal(firstLaunch, HOME_PLACEHOLDER);
    assert.equal(composerPlaceholder(false, firstLaunch), firstLaunch);
    assert.equal(composerPlaceholder(true, firstLaunch), QUEUE_PLACEHOLDER);
    // The most specific task wins: revising a plan outranks the Studio chat's own prompt. An
    // interview question is answered in its own card, so it does not take the composer's words.
    assert.equal(
      chatPlaceholder({ revisingPlan: true, studio: true, draft: false }),
      "Describe the changes to the plan…",
    );
  });
});

describe("the door: the composer while a build's lead takes the chat", () => {
  /** A build's start as its log records it: the night's lead takes the chat when it says so. */
  const start = (runId: string, payload: Record<string, unknown>, n: number) => ({
    id: `e${n}`,
    thread_id: "t",
    session_id: null,
    turn_id: null,
    created_at: "2026-09-26T08:44:56.000Z",
    data: { type: "custom" as const, event_type: "autopilot_started", payload: { runId, director: true, ...payload } },
  });

  it("says a message reaches the lead, not the end of the build, while such a build runs", () => {
    const contextual = "Ask for a change…";
    assert.equal(composerPlaceholder(true, contextual, true), LEAD_PLACEHOLDER);
    assert.equal(
      composerPlaceholder(true, contextual, false),
      QUEUE_PLACEHOLDER,
      "a build with no lead line keeps its queue",
    );
    assert.equal(composerPlaceholder(false, contextual, true), contextual, "no build, no lead to reach");
  });

  it("reads whether the lead takes the chat from the running build's latest start", () => {
    assert.equal(leadTakesChat([start("r1", { liveChat: true }, 1)], "r1"), true);
    assert.equal(leadTakesChat([start("r1", {}, 1)], "r1"), false, "the long turn opens no line");
    assert.equal(leadTakesChat([start("r1", { liveChat: true }, 1)], "r2"), false, "another build's lead");
    assert.equal(leadTakesChat([start("r1", { liveChat: true }, 1)], null), false, "nothing running");
    const resumedOld = [start("r1", { liveChat: true }, 1), start("r1", { resumed: true }, 2)];
    assert.equal(leadTakesChat(resumedOld, "r1"), false, "a resumed night says again for itself");
  });
});

describe("the chat's promise of when a build ends", () => {
  const at = (day: string, hhmm: string): number => new Date(`2026-09-${day}T${hhmm}:00`).getTime();
  // English whatever the machine's language: the sentence around the clock is English.
  const clock = (day: string, hhmm: string): string =>
    new Date(at(day, hhmm)).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const HOUR = 3_600_000;

  it("names today's end by its clock alone", () => {
    assert.equal(endClock(3 * HOUR, at("26", "09:10")), clock("26", "12:10"));
  });

  it("says tomorrow when the end is on the next day: a 24-hour build ends at the minute it began", () => {
    assert.equal(endClock(24 * HOUR, at("26", "13:44")), `${clock("27", "13:44")} tomorrow`);
    assert.equal(endClock(3 * HOUR, at("26", "23:40")), `${clock("27", "02:40")} tomorrow`);
  });
});

/**
 * Source-level gates that remain: each needs a rendered window (dev-control golden snapshots of
 * the app-basics fixture) or the build smoke's own text to be proven any other way.
 */
describe("the door: the surfaces that draw it", () => {
  it("nothing in the renderer mints a project chat", () => {
    // What the app opens is proven by launching the studio store above. `window.studio` reaches
    // every renderer file, so this rule is about the whole tree: creation
    // waits for an explicit name or folder.
    const minting = rendererFiles()
      .filter((file) => /\bnewProjectThread\(/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file));
    assert.deepEqual(minting, [], "creation waits for an explicit name or folder");
  });

  it("blank chats keep creation in navigation and writing in the composer", () => {
    const chat = read("src/renderer/panels/ChatPanel.tsx");
    assert.doesNotMatch(
      chat,
      /What would you like to build\?|Ideas to start with|Ask about Studio<|Start a project<|STARTERS/,
    );
    assert.match(chat, /<PromptBar/);
    assert.match(read("src/renderer/panels/Sidebar.tsx"), /New project/);
  });

  it("the composer groups build behavior in the Mode panel", () => {
    const bar = read("src/renderer/ui/PromptBar.tsx");
    assert.match(bar, /<ComposerModeMenu/);
    assert.doesNotMatch(bar, /aria-label="Hours"/);
  });

  it("the box is sized to its placeholder, so a longer one still cannot be clipped", () => {
    assert.match(read("src/renderer/ui/PromptBar.tsx"), /if \(draft\.length === 0 && input\.placeholder\)/);
  });
});
