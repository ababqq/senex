import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readdir, realpath, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  claudeGlobalSkills,
  codexBuilderUse,
  normalizeCodexSkills,
  projectSkills,
} from "../../src/main/provider-skills.ts";
import { registerSkillsIpc } from "../../src/main/ipc/skills.ts";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { assertOwnedProject } from "../../src/main/project-policy.ts";
import { ProjectWorkspaces } from "../../src/substrate/project-workspace.ts";
import { LoginSource } from "../../src/shared/engine-descriptor.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { ProviderBuilderUse, type ProjectSkillInventory } from "../../src/shared/provider-skills.ts";
test("native Codex discovery preserves disabled global skills and excludes project scope", () => {
  const skill = {
    name: "global",
    path: "/home/test/.agents/skills/global/SKILL.md",
    scope: "user",
    enabled: false,
    description: "Example",
  };
  const rows = normalizeCodexSkills({
    data: [
      {
        skills: [
          skill,
          { ...skill },
          { ...skill, name: "project", path: "/project/.agents/skills/project/SKILL.md", scope: "repo" },
          { name: "invalid" },
        ],
      },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.enabled, false);
  assert.equal(rows[0]?.scope, "user");
  assert.deepEqual(normalizeCodexSkills({}), []);
});
test("Claude inventories personal, shared symlinks, commands, managed and installed plugin skills without loading settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "provider-skills-"));
  const home = path.join(root, ".claude"),
    managed = path.join(root, "managed");
  const skill = async (dir: string, name: string) => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Use ${name}\n---\nInstructions`);
  };
  try {
    await skill(path.join(home, "skills/personal"), "Personal");
    await mkdir(path.join(home, "skills/personal/references/a/b/c/d/e/f/g"), { recursive: true });
    await writeFile(
      path.join(home, "skills/personal/SKILL.md"),
      "---\nname: Personal\ndescription: >-\n  A multiline\n  description.\n---\nInstructions",
    );
    await skill(path.join(root, ".agents/skills/shared"), "Shared");
    await symlink(path.join(root, ".agents/skills/shared"), path.join(home, "skills/shared"));
    await skill(path.join(root, "private"), "Secret");
    await symlink(path.join(root, "private"), path.join(home, "skills/escape"));
    await mkdir(path.join(home, "commands"), { recursive: true });
    await writeFile(path.join(home, "commands/legacy.md"), "Legacy instructions");
    const live = path.join(home, "plugins/cache/example/2");
    await skill(path.join(live, "skills/example"), "Current plugin");
    await skill(path.join(home, "plugins/cache/example/1/skills/example"), "Obsolete plugin");
    await writeFile(
      path.join(home, "plugins/installed_plugins.json"),
      JSON.stringify({ plugins: { example: [{ scope: "user", installPath: live }] } }),
    );
    await writeFile(path.join(home, "settings.json"), "unreadable settings must never execute hooks");
    await skill(path.join(managed, "managed"), "Managed");
    const result = await claudeGlobalSkills(home, root, managed);
    assert.deepEqual(
      result.skills.map((s) => s.name),
      ["Current plugin", "legacy", "Managed", "Personal", "Shared"],
    );
    assert.equal(result.warnings.length, 0);
    assert.equal(result.skills.find((s) => s.name === "Personal")?.description, "A multiline description.");
    assert.match(result.note, /not enabled/);
    assert.ok(result.skills.every((s) => s.enabled === undefined));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("missing Claude folders are empty; corrupt plugin metadata remains a visible warning", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "provider-skills-empty-"));
  try {
    assert.equal((await claudeGlobalSkills(root, root, path.join(root, "managed"))).skills.length, 0);
    await mkdir(path.join(root, "plugins"));
    await writeFile(path.join(root, "plugins/installed_plugins.json"), "{broken");
    const result = await claudeGlobalSkills(root, root, path.join(root, "managed"));
    assert.equal(result.warnings.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const KIB = 1024;
const skillFile = (name: string) => `---\nname: ${name}\ndescription: Use ${name}\n---\nInstructions`;

/** Every entry under `dir`, links not followed, with what a write would change. */
async function tree(dir: string): Promise<string[]> {
  const rows: string[] = [];
  const walk = async (at: string): Promise<void> => {
    const info = await lstat(at);
    rows.push(`${path.relative(dir, at)} ${info.mode} ${info.size} ${info.mtimeMs}`);
    if (!info.isDirectory()) return;
    for (const entry of (await readdir(at)).sort()) await walk(path.join(at, entry));
  };
  await walk(dir);
  return rows;
}

/** A projects root with one project, `demo`, and a folder outside it; the body gets all three. */
async function withProject<T>(body: (projects: string, project: string, outside: string) => Promise<T>): Promise<T> {
  // Real paths: the development containment check refuses a projects root reached through a link (/var).
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "project-skills-")));
  const projects = path.join(root, "projects"),
    project = path.join(projects, "demo"),
    outside = path.join(root, "outside");
  try {
    await mkdir(path.join(outside, "stolen"), { recursive: true });
    await writeFile(path.join(outside, "stolen", "SKILL.md"), skillFile("Stolen"));
    await writeFile(path.join(outside, "stolen.md"), "Stolen command");
    await mkdir(path.join(project, ".claude/skills/level-design"), { recursive: true });
    await writeFile(path.join(project, ".claude/skills/level-design/SKILL.md"), skillFile("Level design"));
    await mkdir(path.join(project, ".claude/commands"), { recursive: true });
    await writeFile(path.join(project, ".claude/commands/playtest.md"), "---\ndescription: Play it\n---\nPlay.");
    await mkdir(path.join(project, ".agents/skills/shaders"), { recursive: true });
    await writeFile(path.join(project, ".agents/skills/shaders/SKILL.md"), skillFile("Shaders"));
    return await body(projects, project, outside);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a project's project skills and commands are listed with the builders that load them", async () => {
  await withProject(async (_projects, project) => {
    const before = await tree(project);
    const { skills, warnings } = await projectSkills(project);
    assert.deepEqual(skills, [
      {
        name: "Level design",
        description: "Use Level design",
        path: ".claude/skills/level-design/SKILL.md",
        kind: "skill",
        engines: [EngineId.ClaudeCode],
      },
      {
        name: "playtest",
        description: "Play it",
        path: ".claude/commands/playtest.md",
        kind: "command",
        engines: [EngineId.ClaudeCode],
      },
      {
        name: "Shaders",
        description: "Use Shaders",
        path: ".agents/skills/shaders/SKILL.md",
        kind: "skill",
        engines: [EngineId.Codex],
      },
    ]);
    assert.deepEqual(warnings, []);
    assert.deepEqual(await tree(project), before);
  });
});

test("one skill folder both builders read is listed once, for both", async () => {
  await withProject(async (_projects, project) => {
    await rm(path.join(project, ".agents/skills"), { recursive: true });
    await symlink(path.join(project, ".claude/skills"), path.join(project, ".agents/skills"));
    const { skills } = await projectSkills(project);
    const shared = skills.filter((s) => s.name === "Level design");
    assert.equal(shared.length, 1);
    assert.deepEqual(shared[0]?.engines, [EngineId.ClaudeCode, EngineId.Codex]);
  });
});

/** Hostile project folders: each lists nothing from outside the project and leaves the folder as it was. */
const HOSTILE_PROJECTS: Array<{
  name: string;
  arrange(project: string, outside: string): Promise<void>;
  warns?: boolean;
}> = [
  {
    name: "a skill folder linked outside the project",
    arrange: (project, outside) => symlink(path.join(outside, "stolen"), path.join(project, ".claude/skills/stolen")),
  },
  {
    name: "a SKILL.md linked outside the project",
    arrange: async (project, outside) => {
      await mkdir(path.join(project, ".claude/skills/stolen"));
      await symlink(path.join(outside, "stolen", "SKILL.md"), path.join(project, ".claude/skills/stolen/SKILL.md"));
    },
  },
  {
    name: "a command linked outside the project",
    arrange: (project, outside) =>
      symlink(path.join(outside, "stolen.md"), path.join(project, ".claude/commands/stolen.md")),
  },
  {
    name: "a whole skills root linked outside the project",
    arrange: async (project, outside) => {
      await rm(path.join(project, ".agents/skills"), { recursive: true });
      await symlink(outside, path.join(project, ".agents/skills"));
    },
  },
  {
    name: "the .claude folder linked outside the project",
    arrange: async (project, outside) => {
      await rm(path.join(project, ".claude"), { recursive: true });
      await mkdir(path.join(outside, "skills", "stolen"), { recursive: true });
      await writeFile(path.join(outside, "skills", "stolen", "SKILL.md"), skillFile("Stolen"));
      await symlink(outside, path.join(project, ".claude"));
    },
  },
  {
    name: "a 300 KiB SKILL.md",
    arrange: async (project) => {
      await mkdir(path.join(project, ".claude/skills/huge"));
      await writeFile(
        path.join(project, ".claude/skills/huge/SKILL.md"),
        `${skillFile("Stolen")}\n${"x".repeat(300 * KIB)}`,
      );
    },
    warns: true,
  },
];

for (const row of HOSTILE_PROJECTS)
  test(`project skills: ${row.name} is not listed, and the project is left as it was`, async () => {
    await withProject(async (_projects, project, outside) => {
      await row.arrange(project, outside);
      const before = await tree(project);
      const outsideBefore = await tree(outside);
      const { skills, warnings } = await projectSkills(project);
      assert.ok(!skills.some((s) => s.name === "Stolen"), JSON.stringify(skills));
      assert.ok(skills.every((s) => !s.path.startsWith("..") && !path.isAbsolute(s.path)));
      assert.equal(warnings.length > 0, row.warns === true, JSON.stringify(warnings));
      assert.deepEqual(await tree(project), before);
      assert.deepEqual(await tree(outside), outsideBefore);
    });
  });

test("whether Codex's global skills reach builders follows the login they use", () => {
  assert.equal(codexBuilderUse(LoginSource.System), ProviderBuilderUse.BorrowedLogin);
  assert.equal(codexBuilderUse(LoginSource.Env), ProviderBuilderUse.BorrowedLogin);
  assert.equal(codexBuilderUse(LoginSource.Isolated), ProviderBuilderUse.StudioProfile);
  assert.equal(codexBuilderUse(LoginSource.None), ProviderBuilderUse.NoLogin);
});

test("Claude's global skills say they never reach builders", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "provider-skills-builders-"));
  try {
    const result = await claudeGlobalSkills(root, root, path.join(root, "managed"));
    assert.equal(result.builders, ProviderBuilderUse.NotLoaded);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

type Listener = (event: IpcSender, payload: unknown) => Promise<IpcResult>;

/** The skills registrar over a real projects root, the development containment check and a recorded skillText. */
function skillsIpc(projects: string) {
  const listeners = new Map<string, Listener>();
  const handle = createIpcHandle(
    { handle: (channel, listener) => void listeners.set(channel, listener) },
    { fixture: true, isStudioUi: () => true },
  );
  const reads: unknown[][] = [];
  const workspace = new ProjectWorkspaces({
    root: projects,
    templateDir: projects,
    vendorDir: projects,
    indexFile: path.join(projects, "index.json"),
    userData: projects,
  });
  registerSkillsIpc(handle, {
    core: {
      layout: { harnessWs: projects } as never,
      projects: workspace,
      assertProjectAllowed: (dir: string) => assertOwnedProject(projects, dir),
      plugins: {
        skillText: async (...args: unknown[]) => {
          reads.push(args);
          return "text";
        },
      } as never,
    },
    subscription: () => null,
    home: () => projects,
  });
  const invoke = (channel: string, payload?: unknown) => {
    const listener = listeners.get(channel);
    assert.ok(listener, `${channel} is not registered`);
    return listener({ sender: "studio", senderFrame: "main-frame" }, payload);
  };
  return { invoke, reads };
}

test("studio:skills.project lists the named project's skills", async () => {
  await withProject(async (projects) => {
    const result = await skillsIpc(projects).invoke("studio:skills.project", { project: "demo" });
    assert.equal(result.ok, true);
    const inventory = (result as { value: ProjectSkillInventory }).value;
    assert.equal(inventory.project, "demo");
    assert.deepEqual(
      inventory.skills.map((s) => s.name),
      ["Level design", "playtest", "Shaders"],
    );
  });
});

/**
 * Payloads the channel refuses. The name checks hold in every profile; the linked folder is refused
 * only by the development containment root (`executionPolicy.allowedProjectRoot`, set for dev
 * profiles alone), which `skillsIpc` wires in: a normal profile treats a linked project folder as the
 * user's own project. The rows prove the refusal and that nothing is written, not that nothing is read.
 */
const HOSTILE_PROJECT_PAYLOADS: Array<{ name: string; payload: unknown }> = [
  { name: "no payload", payload: undefined },
  { name: "no project", payload: {} },
  { name: "a number", payload: { project: 7 } },
  { name: "a traversal", payload: { project: "../outside" } },
  { name: "an absolute path", payload: { project: "/etc" } },
  {
    name: "a project folder linked outside the projects root, in a development profile",
    payload: { project: "alias" },
  },
];

for (const row of HOSTILE_PROJECT_PAYLOADS)
  test(`studio:skills.project refuses ${row.name} and writes nothing`, async () => {
    await withProject(async (projects, _project, outside) => {
      await mkdir(path.join(outside, ".claude/skills"), { recursive: true });
      await symlink(path.join(outside, "stolen"), path.join(outside, ".claude/skills/stolen"));
      await symlink(outside, path.join(projects, "alias"));
      const before = await tree(path.dirname(projects));
      const result = await skillsIpc(projects).invoke("studio:skills.project", row.payload);
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.deepEqual(await tree(path.dirname(projects)), before);
    });
  });

test("studio:plugins.skill reads a plugin skill's text, and refuses a malformed request before any read", async () => {
  await withProject(async (projects) => {
    const ipc = skillsIpc(projects);
    const ok = await ipc.invoke("studio:plugins.skill", { id: "genex", name: "multiplayer", file: "refs/rooms.md" });
    assert.deepEqual(ok, { ok: true, value: "text" });
    assert.deepEqual(await ipc.invoke("studio:plugins.skill", { id: "genex", name: "publishing" }), {
      ok: true,
      value: "text",
    });
    for (const payload of [
      undefined,
      {},
      { id: 1, name: "a" },
      { id: "genex", name: {} },
      { id: "genex", name: "a", file: 3 },
    ]) {
      const result = await ipc.invoke("studio:plugins.skill", payload);
      assert.equal(result.ok, false, JSON.stringify(payload));
    }
    assert.deepEqual(ipc.reads, [
      ["genex", "multiplayer", "refs/rooms.md"],
      ["genex", "publishing", undefined],
    ]);
  });
});
