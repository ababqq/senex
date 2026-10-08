import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { StudioCore } from "../../src/main/studio-core.ts";
import { makeResources } from "../helpers/resources.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { assertOwnedProject } from "../../src/main/project-policy.ts";
import { fixtureEngines } from "../../src/main/dev/fixtures.ts";
import { OllamaEngine } from "../../src/substrate/engines/ollama.ts";
import { CodexEngine } from "../../src/substrate/engines/codex.ts";
import { ClaudeCodeEngine } from "../../src/substrate/engines/claude-code.ts";
test("pre-init injection avoids every real engine status/models/auth probe and keeps sandbox enabled", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-policy-"));
  for (const proto of [OllamaEngine.prototype, CodexEngine.prototype, ClaudeCodeEngine.prototype])
    for (const key of ["status", "models", "probeAuth"])
      if (typeof (proto as any)[key] === "function")
        t.mock.method(proto as any, key, () => {
          throw new Error(`real ${key} must not run`);
        });
  const core = new StudioCore({
    paths: { userData: root, resources: await makeResources() },
    engines: fixtureEngines(),
    improvementIdle: { idleMs: 0, minGapMs: 0 },
    executionPolicy: { runBackgroundImprovement: false },
  });
  await core.init();
  // The harness stops before its folder goes: Windows refuses to remove a running process's
  // working folder (EBUSY), and keeps it busy for a moment after the exit, hence the retries.
  t.after(async () => {
    await core.stop();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await core.start();
  assert.equal(core.host.state, "ready");
  assert.equal((await core.engines.describe()).length, 3);
  assert.equal(core.sandbox.enabled, true);
  await core.updateSettings({ architect: true });
  let calls = 0;
  for (const engine of [core.engines.get("ollama"), core.engines.get("codex"), core.engines.get("claude-code")])
    if (engine.complete)
      t.mock.method(engine as Required<typeof engine>, "complete", async () => {
        calls++;
        throw new Error("fixture background must stay parked");
      });
  await core.runIdleCheckNow();
  assert.equal(calls, 0);
});
test("owned project policy rejects external adoption and symlink escapes before writes", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dev-project-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projects = path.join(root, "projects"),
    inside = path.join(projects, "inside"),
    outside = path.join(root, "external");
  await fs.mkdir(inside, { recursive: true });
  await fs.mkdir(outside);
  await assertOwnedProject(projects, inside);
  await assert.rejects(assertOwnedProject(projects, outside), /outside/);
  await fs.symlink(outside, path.join(projects, "alias"));
  await assert.rejects(assertOwnedProject(projects, path.join(projects, "alias")), /outside|alias/);
  const core = new StudioCore({
    paths: { userData: path.join(root, "core"), resources: await makeResources() },
    projectsRoot: projects,
    engines: [],
    executionPolicy: { allowedProjectRoot: projects },
  });
  await assert.rejects(core.adoptProject(outside), /outside/);
  assert.deepEqual(await fs.readdir(outside), []);
});

/** Run `body` with the system temp folder pointed at `dir`; os.tmpdir() reads these at each call. */
async function withTempFolder<T>(dir: string, body: () => Promise<T>): Promise<T> {
  const names = ["TMPDIR", "TMP", "TEMP"];
  const saved = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) process.env[name] = dir;
  try {
    return await body();
  } finally {
    for (const [name, value] of saved)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
}

test("a core-lite in a temp folder reached through a link owns its projects by their real path", async () => {
  // macOS spells os.tmpdir() as /var/folders/…, a link to /private/var/folders/…. The containment
  // check refuses a projects root reached through a link, so the fixture must hand the core a real one.
  const root = await fs.realpath(await tmpDir("dev-linked-tmp-"));
  const real = path.join(root, "real");
  const linked = path.join(root, "linked");
  await fs.mkdir(real);
  await fs.symlink(real, linked, "junction");
  const linkedProjects = path.join(linked, "projects");
  await fs.mkdir(path.join(linkedProjects, "project"), { recursive: true });
  await assert.rejects(assertOwnedProject(linkedProjects, path.join(linkedProjects, "project")), /outside/);

  const resources = await makeResources();
  const lite = await withTempFolder(linked, () => coreLite({ resources }));
  try {
    await lite.core.projects.scaffold("linked");
    const binding = await lite.core.pluginBinding("linked");
    assert.equal(binding?.directory, path.join(lite.projectsRoot, "linked"));
    assert.equal(lite.projectsRoot, await fs.realpath(lite.projectsRoot));
  } finally {
    await lite.close();
  }
});
test("indexed external project is rejected before sandbox/snapshot write registration", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dev-index-")));
  // The refused init can leave the harness workspace's git still writing objects for a moment;
  // retry like tests/helpers/tmp.ts does rather than fail the run with ENOTEMPTY.
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const userData = path.join(root, "core"),
    projects = path.join(root, "projects"),
    external = path.join(root, "outside");
  await fs.mkdir(userData);
  await fs.mkdir(projects);
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, "index.html"), "external project");
  await fs.writeFile(
    path.join(userData, "projects.json"),
    JSON.stringify({ version: 1, aliases: { outside: external }, recents: [] }),
  );
  const core = new StudioCore({
    paths: { userData, resources: await makeResources() },
    projectsRoot: projects,
    engines: [],
    executionPolicy: { allowedProjectRoot: projects },
  });
  await assert.rejects(core.init(), /outside the owned/);
  assert.equal(core.sandbox, undefined);
  assert.equal(await fs.readFile(path.join(external, "index.html"), "utf8"), "external project");
});
test("fixture native guard covers all account, external, picker, export and download routes", async () => {
  const { assertNativeActionAllowed, FIXTURE_BLOCKED_CHANNELS } = await import("../../src/main/dev/native-policy.ts");
  for (const channel of FIXTURE_BLOCKED_CHANNELS) {
    assert.throws(() => assertNativeActionAllowed(true, channel), /unsupported-in-fixture/);
    assert.doesNotThrow(() => assertNativeActionAllowed(false, channel));
  }
  assert.doesNotThrow(() => assertNativeActionAllowed(true, "studio:bootstrap"));
  // The list is the only gate (every handler is wrapped), so the channels that reach outside the
  // profile are named here too: a download is a download in a fixture profile as well.
  for (const channel of [
    "studio:packages.install",
    "studio:project.pick",
    "studio:projects-root.choose",
    "studio:open-url",
    "studio:export",
    // Installing a plugin from a pinned commit downloads code and shows a trust dialog; updating does both again.
    "studio:plugins.install-github",
    // Looking a pasted link up reaches GitHub.
    "studio:plugins.lookup-github",
    "studio:plugins.github-versions",
    "studio:plugins.update",
    // Trusting a connector starts a program on this Mac with the environment variables it names;
    // the dialog that approves it is native, so a fixture profile never reaches it.
    "studio:mcp.trust",
  ])
    assert.ok(FIXTURE_BLOCKED_CHANNELS.has(channel), channel);
  // Reading the index and watching a local folder open no dialog and, offline, no socket either.
  for (const channel of [
    "studio:plugins.index",
    "studio:plugins.watch",
    // Listing, editing and removing connectors stay open: they write a file inside the profile and
    // open no dialog. Only the trust step is native.
    "studio:mcp.list",
    "studio:mcp.save",
    "studio:mcp.remove",
    "studio:mcp.test",
    "studio:mcp.tools",
  ])
    assert.ok(!FIXTURE_BLOCKED_CHANNELS.has(channel), channel);
  // …and adoption is not one of them: it opens no network and writes only inside the profile's
  // own projects root, which is the one way a dev profile can hold a project that is not the fixture.
  assert.doesNotThrow(() => assertNativeActionAllowed(true, "studio:project.adopt"));
});
