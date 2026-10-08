/**
 * Home starts a project from its first message: the project is named by the model picked for it, made
 * where the user chose, opened, and only then does its own chat send the message. Nothing is made
 * before the message, and a refusal leaves the user at home with their words.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  initialLaunch,
  LaunchPhase,
  launchFailed,
  launchFinished,
  launchHanded,
  launchInSidebar,
  launchMade,
  launchNamed,
  launchOpened,
  launchStarted,
  returnTaken,
} from "../../src/renderer/state/launch.ts";
import { createStudio } from "../../src/renderer/state/studio.ts";
import { Room, roomOf } from "../../src/renderer/state/threads.ts";
import type { KeyValueStorage } from "../../src/renderer/storage.ts";
import type { Bootstrap, ConversationRecord, Project } from "../../src/shared/studio-api.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const REQUEST = "A cozy fishing project on a tiny island.";

function memoryStorage(seed: Record<string, string> = {}): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const project = (name: string, title: string): Project =>
  ({ name, title, dir: `/g/${name}`, pathLabel: `~/AI Projects/${name}`, createdAt: "" }) as Project;
const chat = (id: string, project: string): ConversationRecord => ({
  id,
  agent_id: "a",
  created_at: "",
  updated_at: "",
  latest_event_id: null,
  metadata: { kind: "game", project },
});

describe("the launch's own steps", () => {
  const started = launchStarted(initialLaunch(), { id: "l1", text: REQUEST, extras: undefined, at: 5 });

  it("goes naming → opening → opened → handed, each step only for its own launch", () => {
    assert.equal(started.launch?.phase, LaunchPhase.Naming);
    const named = launchNamed(started, "l1", "Tiny Island Fishing");
    assert.equal(named.launch?.phase, LaunchPhase.Opening);
    assert.equal(named.launch?.title, "Tiny Island Fishing");
    assert.equal(launchNamed(started, "other", "Wrong"), started, "a stale launch's step changes nothing");
    const opened = launchOpened(named, "l1", { project: "tiny-island-fishing", threadId: "t1" });
    assert.deepEqual(
      { phase: opened.launch?.phase, project: opened.launch?.project, threadId: opened.launch?.threadId },
      { phase: LaunchPhase.Opened, project: "tiny-island-fishing", threadId: "t1" },
    );
    assert.deepEqual(opened.planning, { project: "tiny-island-fishing", at: 5 }, "the stage plans from the send");
    const handed = launchHanded(opened, "l1");
    assert.equal(handed.launch?.phase, LaunchPhase.Handed);
    assert.equal(launchHanded(handed, "l1"), handed, "a message is handed over once");
    assert.equal(launchFinished(handed, "l1").launch, null);
    assert.deepEqual(launchFinished(handed, "l1").planning, opened.planning, "and keeps doing so after");
    assert.equal(launchFinished(handed, "other"), handed);
  });

  it("the sidebar holds one row for it: a placeholder until its project is listed, then the project's own", () => {
    const named = launchNamed(started, "l1", "Tiny Island Fishing");
    const nothing = () => false;
    assert.deepEqual(launchInSidebar(null, nothing), { placeholder: false, title: null, project: null });
    assert.deepEqual(launchInSidebar(named.launch, nothing), {
      placeholder: true,
      title: "Tiny Island Fishing",
      project: null,
    });
    const made = launchMade(named, "l1", "tiny-island-fishing");
    assert.equal(made.launch?.phase, LaunchPhase.Opening, "made, its chat still opening");
    assert.equal(launchMade(named, "other", "x"), named, "a stale launch's step changes nothing");
    assert.equal(launchInSidebar(made.launch, nothing).placeholder, true, "never no row at all");
    assert.deepEqual(
      launchInSidebar(made.launch, (name) => name === "tiny-island-fishing"),
      { placeholder: false, title: "Tiny Island Fishing", project: "tiny-island-fishing" },
    );
  });

  it("a failed launch gives the words back to home once", () => {
    const failed = launchFailed(started, "l1");
    assert.equal(failed.launch, null);
    assert.equal(failed.returned?.text, REQUEST);
    assert.equal(returnTaken(failed).returned, null);
  });
});

describe("launching a project from home", () => {
  function launched(overrides: Parameters<typeof fakeStudioApi>[0] = {}, storage = memoryStorage()) {
    const boot = {
      threadId: "studio",
      layout: {},
      projectsRootLabel: "~/AI Projects",
      harness: { state: "ready", version: null, capabilities: [] },
      threads: [],
      events: [],
      eventsCursor: null,
      engines: [],
      activeDelegations: {},
      projects: [],
    } as unknown as Bootstrap;
    const made: Project[] = [];
    const fake = fakeStudioApi({
      bootstrap: async () => boot,
      projects: async () => made,
      nameProject: async () => ({ title: "Tiny Island Fishing" }),
      createProject: async (title) => {
        made.push(project("tiny-island-fishing", title));
        return made[0] as Project;
      },
      threadForProject: async (project) => chat("t-fish", project),
      ...overrides,
    });
    const timers = { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0 };
    const app = createStudio(fake.api, { storage, timers });
    app.start();
    return { app, fake, storage };
  }

  it("names the project with the picked model, makes it in the projects folder, and opens its chat", async () => {
    const { app, fake, storage } = launched();
    await tick();
    assert.equal(roomOf(app.threads.getState()), Room.Home);
    await app.launchProject({ text: REQUEST, modelKey: "claude-code::opus", effort: "high" });
    assert.deepEqual(fake.callsOf("nameProject"), [[{ prompt: REQUEST, engine: "claude-code", model: "opus" }]]);
    assert.deepEqual(fake.callsOf("createProject"), [["Tiny Island Fishing"]]);
    assert.equal(app.threads.getState().activeThreadId, "t-fish");
    assert.equal(roomOf(app.threads.getState()), Room.Build);
    assert.deepEqual(fake.callsOf("loadPreview"), [["tiny-island-fishing"]], "the new project loads once");
    assert.deepEqual(
      app.library.getState().projects.map((g) => g.name),
      ["tiny-island-fishing"],
    );
    const { launch } = app.launch.getState();
    assert.deepEqual(
      { phase: launch?.phase, threadId: launch?.threadId, text: launch?.text },
      { phase: LaunchPhase.Opened, threadId: "t-fish", text: REQUEST },
      "the chat sends the message itself, once it is open",
    );
    assert.deepEqual(fake.callsOf("send"), [], "nothing is sent before the chat is open");
    assert.equal(storage.data.get("studio.model.t-fish"), "claude-code::opus", "the chat keeps home's model");
    assert.equal(storage.data.get("studio.threadEffort.t-fish"), "high", "and its effort");
  });

  it("the made project takes its placeholder's place at once, while its chat is still opening", async () => {
    let openChat: (record: ConversationRecord) => void = () => {};
    const { app } = launched({
      threadForProject: () =>
        new Promise((resolve) => {
          openChat = resolve;
        }),
    });
    await tick();
    const going = app.launchProject({ text: REQUEST, modelKey: null, effort: null });
    await tick();
    const listed = (name: string) => app.library.getState().projects.some((g) => g.name === name);
    assert.ok(listed("tiny-island-fishing"), "the library lists the new project");
    assert.deepEqual(
      launchInSidebar(app.launch.getState().launch, listed),
      { placeholder: false, title: "Tiny Island Fishing", project: "tiny-island-fishing" },
      "one row, the project's own, never the project and its placeholder",
    );
    openChat(chat("t-fish", "tiny-island-fishing"));
    await going;
    assert.equal(app.launch.getState().launch?.phase, LaunchPhase.Opened);
  });

  it("makes the project in the folder chosen at home", async () => {
    const { app, fake } = launched();
    await tick();
    await app.launchProject({ text: REQUEST, modelKey: null, effort: null, parent: "/Users/me/Projects" });
    assert.deepEqual(fake.callsOf("nameProject"), [[{ prompt: REQUEST }]]);
    assert.deepEqual(fake.callsOf("createProject"), [["Tiny Island Fishing", { parent: "/Users/me/Projects" }]]);
  });

  it("still makes the project, as Untitled project, when naming itself fails", async () => {
    const { app, fake } = launched({
      nameProject: async () => {
        throw new Error("main went away");
      },
    });
    await tick();
    await app.launchProject({ text: REQUEST, modelKey: null, effort: null });
    assert.deepEqual(fake.callsOf("createProject"), [["Untitled project", { provisional: true }]]);
  });

  it("a first message that names no project (a greeting) makes it Untitled, its name waiting for an idea", async () => {
    const { app, fake } = launched({ nameProject: async () => ({ title: "Untitled project", provisional: true }) });
    await tick();
    await app.launchProject({ text: "Hello", modelKey: null, effort: null });
    assert.deepEqual(fake.callsOf("createProject"), [["Untitled project", { provisional: true }]]);
  });

  it("a refused project leaves home as it was, says why, and gives the words back", async () => {
    const { app, fake } = launched({
      createProject: async () => {
        throw new Error("Choose a folder outside your projects.");
      },
    });
    await tick();
    await app.launchProject({ text: REQUEST, modelKey: null, effort: null, parent: "/inside/a/project" });
    assert.equal(app.threads.getState().activeThreadId, null);
    assert.equal(roomOf(app.threads.getState()), Room.Home);
    assert.equal(app.launch.getState().launch, null);
    assert.equal(app.launch.getState().returned?.text, REQUEST);
    assert.equal(app.toasts.getState().items[0]?.tone, "err");
    assert.deepEqual(fake.callsOf("send"), []);
  });

  it("one launch at a time: a second send while the first is out does nothing", async () => {
    const { app, fake } = launched();
    await tick();
    const first = app.launchProject({ text: REQUEST, modelKey: null, effort: null });
    await app.launchProject({ text: "Another project", modelKey: null, effort: null });
    await first;
    assert.equal(fake.callsOf("createProject").length, 1);
  });
});
