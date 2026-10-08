import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeResources, startRig, type Rig } from "../helpers/studio-rig.ts";
import { StudioCore } from "../../src/main/studio-core.ts";
import { nameFromIdea } from "../../src/main/core/project-naming.ts";
import type { ProjectName, ProjectNameRequest } from "../../src/shared/project-folder.ts";
import { ProjectWorkspaces } from "../../src/substrate/project-workspace.ts";
import { coverFromBrief, validateProjectCover } from "../../src/shared/project-library.ts";
import { projectCoverSvg } from "../../src/shared/project-cover.ts";
import { librarySearch } from "../../src/renderer/project-search.ts";
let rig: Rig;
before(async () => {
  rig = await startRig({ replies: [] });
});
after(async () => {
  await rig?.stop();
});
describe("project-first library", () => {
  it("reserves duplicate names without overwriting folders and creates exactly one conversation", async () => {
    const first = await rig.core.createProject("Snow Temple");
    await writeFile(path.join(first.dir, "keep.txt"), "owner content");
    const next = await rig.core.createProject("Snow Temple");
    assert.notEqual(next.name, first.name);
    assert.equal(await readFile(path.join(first.dir, "keep.txt"), "utf8"), "owner content");
    const ids = await Promise.all(Array.from({ length: 5 }, () => rig.core.threadForProject(first.name)));
    assert.equal(new Set(ids).size, 1);
    assert.equal(await rig.core.createProjectThread(first.name), ids[0]);
    assert.equal(
      (await rig.core.store.listThreads()).filter((t) => (t.metadata as { project?: string })?.project === first.name)
        .length,
      1,
    );
  });
  it("rename/pin/cover survive restart; removal keeps library files and re-adding restores history", async () => {
    const project = await rig.core.createProject("Neon Harbor");
    const thread = await rig.core.threadForProject(project.name);
    await rig.core.append([{ type: "messages", messages: [{ role: "user", content: "Preserve my history" }] }], thread);
    const cover = coverFromBrief("Neon Harbor");
    await rig.core.updateProject(project.name, { title: "Harbor at dusk", pinned: true, cover });
    const before = await readFile(path.join(project.dir, "studio.json"), "utf8");
    await rig.core.removeProject(project.name);
    assert.ok(!(await rig.core.projects.list()).some((g) => g.name === project.name));
    assert.equal(await readFile(path.join(project.dir, "studio.json"), "utf8"), before);
    const restarted = new ProjectWorkspaces(rig.core.projects);
    const [library, presentation] = await Promise.all([restarted.list(), restarted.presentation(project.name)]);
    assert.ok(!library.some((g) => g.name === project.name));
    assert.equal(presentation.primaryThreadId, thread);
    assert.deepEqual(presentation.cover, cover);
    const restored = await rig.core.adoptProject(project.dir);
    assert.equal(restored.name, project.name);
    assert.equal(restored.title, "Harbor at dusk");
    assert.equal(restored.pinned, true);
    assert.deepEqual(restored.cover, cover);
    assert.equal((await rig.core.projects.presentation(project.name)).primaryThreadId, thread);
    assert.ok((await rig.core.store.listEvents(thread)).some((e) => e.data.type === "messages"));
  });
  it("a project made Untitled by a greeting takes its first idea's name in place, never over the person's own", async () => {
    const replies: Record<string, ProjectName> = {
      "Hi there": { title: "Untitled project", provisional: true },
      "A cozy island fishing project": { title: "Island Angler" },
    };
    const asked: string[] = [];
    const changed: string[] = [];
    const namer = {
      projects: rig.core.projects,
      name: async (request: ProjectNameRequest) => {
        asked.push(request.prompt);
        return replies[request.prompt] ?? { title: "Wrong", provisional: true };
      },
      changed: (project: string) => void changed.push(project),
    };
    const project = await rig.core.createProject("Untitled project", { provisional: true });
    assert.equal(project.provisional, true);
    assert.equal(await nameFromIdea(namer, project.name, { prompt: "Hi there" }), false, "small talk keeps waiting");
    assert.equal(await nameFromIdea(namer, project.name, { prompt: "A cozy island fishing project" }), true);
    const named = (await rig.core.projects.list()).find((g) => g.name === project.name);
    assert.deepEqual(
      { title: named?.title, provisional: named?.provisional, dir: named?.dir },
      { title: "Island Angler", provisional: undefined, dir: project.dir },
      "renamed in place: the folder stays",
    );
    assert.deepEqual(changed, [project.name]);
    assert.equal(await nameFromIdea(namer, project.name, { prompt: "Add a lantern" }), false, "named once");

    const own = await rig.core.createProject("Untitled project", { provisional: true });
    await rig.core.updateProject(own.name, { title: "My Island" });
    asked.length = 0;
    assert.equal(await nameFromIdea(namer, own.name, { prompt: "A cozy island fishing project" }), false);
    assert.deepEqual(asked, [], "a name the person gave is theirs");
    assert.equal((await rig.core.projects.list()).find((g) => g.name === own.name)?.title, "My Island");
  });
  it("chooses a canonical legacy conversation without deleting the others", async () => {
    const project = await rig.core.createProject("Archive planet");
    const primary = await rig.core.threadForProject(project.name);
    const old = await rig.core.store.createThread({
      title: "Earlier idea",
      metadata: { kind: "game", project: project.name },
    });
    assert.equal(await rig.core.threadForProject(project.name), primary);
    assert.equal((await rig.core.store.getRecord(old)).title, "Earlier idea");
  });
  it("keeps the look a project was born with and never replaces a custom image", async () => {
    const project = await rig.core.createProject("First brief");
    const cover = (await rig.core.projects.presentation(project.name)).cover;
    assert.equal(cover?.kind, "recipe");
    assert.deepEqual(project.cover, cover);
    await rig.core.projects.ensureCover(project.name);
    assert.deepEqual((await rig.core.projects.presentation(project.name)).cover, cover);
    const uploaded = { kind: "image" as const, dataUrl: "data:image/png;base64,aGVsbG8=" };
    await rig.core.projects.update(project.name, { cover: uploaded });
    await rig.core.projects.ensureCover(project.name);
    assert.deepEqual((await rig.core.projects.presentation(project.name)).cover, uploaded);
    assert.throws(() =>
      validateProjectCover({ kind: "image", dataUrl: 'data:image/svg+xml,<svg onload="alert(1)"/>' }),
    );
  });
  it("creates new projects in a chosen folder while existing projects keep their folders, names and chats", async () => {
    const original = rig.core.projects.root;
    const old = await rig.core.createProject("Old shelf");
    const thread = await rig.core.threadForProject(old.name);
    const chosen = path.join(path.dirname(rig.userData), "chosen projects");
    await mkdir(chosen);
    await rig.core.setProjectsRoot(chosen);
    assert.equal(rig.core.layout.projectsRoot, chosen);
    assert.deepEqual(JSON.parse(await readFile(path.join(rig.userData, "games-root.json"), "utf8")), { dir: chosen });
    const fresh = await rig.core.createProject("New shelf");
    assert.equal(path.dirname(fresh.dir), chosen);
    const listed = await new ProjectWorkspaces(rig.core.projects).list();
    assert.equal(listed.find((project) => project.name === old.name)?.dir, old.dir);
    assert.ok(listed.some((project) => project.name === fresh.name));
    assert.equal(await rig.core.threadForProject(old.name), thread);
    // Every folder in the root is listed as a project, so a folder holding anything else is refused.
    const busy = path.join(path.dirname(rig.userData), "busy");
    await mkdir(path.join(busy, "photos"), { recursive: true });
    await assert.rejects(rig.core.setProjectsRoot(busy), /empty folder/);
    await assert.rejects(rig.core.setProjectsRoot(path.join(fresh.dir, "levels")), /outside your projects/);
    assert.equal(rig.core.projects.root, chosen);
    // Going back is allowed: the old folder holds only this library's projects.
    await rig.core.setProjectsRoot(original);
    const back = await rig.core.projects.list();
    assert.equal(back.find((project) => project.name === old.name)?.dir, old.dir);
    assert.equal(back.find((project) => project.name === fresh.name)?.dir, fresh.dir);
  });
  it("a restart keeps creating projects in the chosen folder", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "projects-root-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const userData = path.join(root, "userData");
    const chosen = path.join(root, "chosen");
    await mkdir(userData);
    await mkdir(chosen);
    await writeFile(path.join(userData, "games-root.json"), JSON.stringify({ dir: chosen }));
    const core = new StudioCore({
      paths: { userData, resources: await makeResources() },
      projectsRoot: path.join(root, "default"),
      engines: [],
    });
    await core.init();
    t.after(() => core.stop());
    assert.equal(core.layout.projectsRoot, chosen);
    assert.equal(path.dirname((await core.createProject("Returns here")).dir), chosen);
  });
  it("search ranks titles and prefixes, handles Cyrillic and prototype-like words, and omits removed projects", async () => {
    const a = await rig.core.createProject("Moon racer"),
      b = await rig.core.createProject("Racer constructor"),
      c = await rig.core.createProject("Лунный лес");
    const corpus = librarySearch([a, b, c], [], {});
    assert.equal(corpus.search("moon rac")[0]?.project?.name, a.name);
    assert.equal(corpus.search("constructor")[0]?.project?.name, b.name);
    assert.equal(corpus.search("лун")[0]?.project?.name, c.name);
    assert.deepEqual(corpus.search("zzyyxxmissing"), []);
  });
  it("artwork is deterministic, bounded and never embeds the brief as executable SVG", () => {
    const cover = coverFromBrief("<script>alert(1)</script> ice");
    assert.equal(projectCoverSvg(cover), projectCoverSvg(cover));
    assert.ok(projectCoverSvg(cover).length < 20000);
    assert.doesNotMatch(projectCoverSvg(cover), /<script|onload|href=/);
    assert.notEqual(projectCoverSvg(), projectCoverSvg(cover));
  });
});
