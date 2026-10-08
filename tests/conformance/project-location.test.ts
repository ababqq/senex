/**
 * Create project in a folder the user chose: the chosen folder is only *where*, and the project gets a
 * new folder of its own inside it, named as the user named the project. The chosen folder's own
 * contents are never opened, adopted or written (the Open Project sheet used to take over here and
 * offer to open whatever was already in it).
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { ProjectWorkspaces } from "../../src/substrate/project-workspace.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

const repo = path.resolve(import.meta.dirname, "../..");
const posixOnly = process.platform === "win32" ? "symlinks need privileges on Windows" : false;

async function workspaces() {
  const base = await tmpDir("studio-project-location-");
  const options = {
    root: path.join(base, "library"),
    templateDir: path.join(repo, "src", "project-template"),
    vendorDir: path.join(base, "vendor"),
    indexFile: path.join(base, "projects.json"),
    userData: path.join(base, "userData"),
    homeDir: base,
  };
  await mkdir(options.userData, { recursive: true });
  const places = path.join(base, "places");
  await mkdir(places, { recursive: true });
  return { projects: new ProjectWorkspaces(options), base, places, options };
}

/** What a refused location must leave exactly as it was. */
async function sideEffects(projects: ProjectWorkspaces, options: { root: string; indexFile: string }, watched: string) {
  // Listing first: a listing makes the projects folder and its index, which is not the location's doing.
  const listed = (await projects.list()).map((project) => `${project.name}=${project.dir}`);
  return {
    listed,
    watched: await readdir(watched).catch(() => null),
    root: await readdir(options.root).catch(() => null),
    index: await readFile(options.indexFile, "utf8").catch(() => null),
  };
}

describe("creating a project in a chosen folder", () => {
  it("makes a new folder named after the project inside the chosen one, and lists it", async () => {
    const { projects, places, options } = await workspaces();
    const parent = path.join(places, "Projects");
    await mkdir(path.join(parent, "some-old-project"), { recursive: true });
    await writeFile(path.join(parent, "some-old-project", "index.html"), "<title>theirs</title>");
    await writeFile(path.join(parent, "notes.txt"), "mine");

    const project = await projects.create("Space Pong", { parent });

    assert.equal(project.dir, path.join(await realpath(parent), "Space Pong"));
    assert.equal(project.title, "Space Pong");
    assert.equal(project.library, false);
    assert.match(await readFile(path.join(project.dir, "index.html"), "utf8"), /Space Pong/);
    assert.equal(JSON.parse(await readFile(path.join(project.dir, "studio.json"), "utf8")).title, "Space Pong");
    assert.deepEqual((await readdir(parent)).sort(), ["Space Pong", "notes.txt", "some-old-project"]);
    assert.equal(await readFile(path.join(parent, "some-old-project", "index.html"), "utf8"), "<title>theirs</title>");
    assert.equal(await readFile(path.join(parent, "notes.txt"), "utf8"), "mine");
    assert.deepEqual(await readdir(options.root), [], "nothing is made in the projects folder");

    const reopened = new ProjectWorkspaces(options);
    const listed = (await reopened.list()).find((row) => row.name === project.name);
    assert.equal(listed?.dir, project.dir, "the project is still listed after a restart");
    assert.equal(reopened.dirFor(project.name), project.dir);
    assert.equal(reopened.root, options.root, "a project's location never moves the projects folder");
  });

  it("keeps the words the user typed, and never overwrites a folder that is already there", async () => {
    const { projects, places } = await workspaces();
    const parent = path.join(places, "Игры");
    await mkdir(path.join(parent, "Лунный лес"), { recursive: true });
    await writeFile(path.join(parent, "Лунный лес", "keep.txt"), "keep");
    await writeFile(path.join(parent, "Лунный лес 2"), "a file, not a folder");

    const project = await projects.create("Лунный лес", { parent });

    assert.equal(path.basename(project.dir), "Лунный лес 3");
    assert.equal(await readFile(path.join(parent, "Лунный лес", "keep.txt"), "utf8"), "keep");
    assert.deepEqual(await readdir(path.join(parent, "Лунный лес")), ["keep.txt"]);
    assert.equal(await readFile(path.join(parent, "Лунный лес 2"), "utf8"), "a file, not a folder");
    assert.equal(project.title, "Лунный лес");
  });

  it("never lets a title reach outside the chosen folder, hide itself or name a device", async () => {
    const { projects, places } = await workspaces();
    const parent = path.join(places, "titles");
    await mkdir(parent);
    const real = await realpath(parent);
    const titles = [
      "../escape",
      "a/b\\c",
      "..",
      ".hidden",
      "CON",
      "CON.txt",
      "nul.tar.gz",
      "LPT1.md",
      "COM¹",
      "con .txt",
    ];
    for (const title of [...titles, "  spaced out.  ", 'Q: "why?" <a|b>*', "Pong [WIP]"]) {
      const project = await projects.create(title, { parent });
      const name = path.basename(project.dir);
      assert.equal(path.dirname(project.dir), real, title);
      assert.ok(!name.startsWith("."), `${title}: not hidden`);
      // Windows reads a device name in the part before the first dot, whatever follows it.
      const stem = (name.split(".")[0] ?? "").trimEnd();
      assert.doesNotMatch(stem, /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i, `${title}: not a device name`);
      // Glob characters too: the sandbox reads a path holding one as a pattern.
      assert.doesNotMatch(name, /[\\/:*?"<>|[\]]|[. ]$/, `${title}: a name any file system and sandbox keep`);
    }
    assert.deepEqual(await readdir(places), ["titles"]);
  });

  it("the projects folder itself is the ordinary library, not a location", async () => {
    const { projects, options } = await workspaces();
    await mkdir(options.root, { recursive: true });
    const project = await projects.create("Pong", { parent: options.root });
    assert.equal(project.library, true);
    assert.equal(project.dir, path.join(options.root, "pong"));
    assert.equal(await projects.location(options.root), await realpath(options.root));
  });

  it("a name the library already uses gets its own, and both projects keep their folders", async () => {
    const { projects, places, options } = await workspaces();
    const inLibrary = await projects.create("Pong");
    const elsewhere = await projects.create("Pong", { parent: places });
    assert.notEqual(elsewhere.name, inLibrary.name);
    assert.equal(elsewhere.dir, path.join(await realpath(places), "Pong"));
    const later = await projects.create("Pong");
    const reopened = new ProjectWorkspaces(options);
    const dirs = Object.fromEntries((await reopened.list()).map((project) => [project.name, project.dir]));
    assert.equal(dirs[inLibrary.name], inLibrary.dir);
    assert.equal(dirs[elsewhere.name], elsewhere.dir);
    assert.equal(dirs[later.name], later.dir);
    assert.equal(new Set([inLibrary.name, elsewhere.name, later.name]).size, 3);
  });

  it("a long name used twice gets a second one, not a hang", async () => {
    const { projects, places } = await workspaces();
    const title = "The Legend of the Very Long Named Project of Doom and Destiny Part II";
    const first = await projects.create(title, { parent: places });
    const second = await projects.create(title, { parent: places });
    const inRoot = await projects.create(title);
    assert.equal(new Set([first.name, second.name, inRoot.name]).size, 3);
  });

  it("making the chosen folder the projects folder later keeps every project's name and folder", async () => {
    const { projects, places, options } = await workspaces();
    const inLibrary = await projects.create("pong");
    const placed = await projects.create("pong", { parent: places });
    assert.equal(path.basename(placed.dir), "pong", "a one-word title is also a library-style folder name");
    // As Settings → Projects hands it over: the folder's real path.
    const root = await realpath(places);
    await projects.changeRoot(root);
    const reopened = new ProjectWorkspaces({ ...options, root });
    await reopened.list();
    for (const workspaces of [projects, reopened]) {
      assert.equal(workspaces.dirFor(inLibrary.name), inLibrary.dir, "the first project keeps its name");
      assert.equal(workspaces.dirFor(placed.name), placed.dir, "the placed project keeps its name");
    }
  });

  it("two projects with one name at once get two folders", async () => {
    const { projects, places } = await workspaces();
    const [a, b] = await Promise.all([
      projects.create("Twin", { parent: places }),
      projects.create("Twin", { parent: places }),
    ]);
    assert.notEqual(a.name, b.name);
    assert.deepEqual([path.basename(a.dir), path.basename(b.dir)].sort(), ["Twin", "Twin 2"]);
    assert.deepEqual((await projects.list()).map((project) => project.name).sort(), [a.name, b.name].sort());
  });

  it("a link to an ordinary folder creates the project in the folder it points at", { skip: posixOnly }, async () => {
    const { projects, base, places } = await workspaces();
    await mkdir(path.join(places, "real"));
    await symlink(path.join(places, "real"), path.join(base, "shortcut"));
    const project = await projects.create("Linked", { parent: path.join(base, "shortcut") });
    assert.equal(project.dir, path.join(await realpath(path.join(places, "real")), "Linked"));
  });
});

describe("a location that is refused changes nothing", () => {
  it("a link swapped in after the location was checked is caught before anything is written", {
    skip: posixOnly,
  }, async () => {
    const env = await workspaces();
    const parent = path.join(env.places, "Projects");
    const outside = path.join(env.base, "outside");
    await mkdir(parent);
    await mkdir(outside);
    const before = await sideEffects(env.projects, env.options, outside);
    const swap = async () => {
      await rename(parent, `${parent}-moved`);
      await symlink(outside, parent);
    };
    await assert.rejects(env.projects.create("Escape", { parent, allowed: swap }));
    assert.deepEqual(await sideEffects(env.projects, env.options, outside), before, "nothing outside, no alias");
  });

  /** Each row builds a hostile location and names the folder whose contents must not change. */
  const rows: Array<{
    name: string;
    skip?: string | false;
    setup(env: Awaited<ReturnType<typeof workspaces>>): Promise<{ parent: string; watched: string }>;
  }> = [
    {
      name: "a project in the library",
      async setup({ projects }) {
        const project = await projects.create("Pong");
        return { parent: project.dir, watched: project.dir };
      },
    },
    {
      name: "a folder inside a project",
      async setup({ projects }) {
        const project = await projects.create("Pong");
        return { parent: path.join(project.dir, "src"), watched: path.join(project.dir, "src") };
      },
    },
    {
      name: "a project opened from elsewhere",
      async setup({ projects, places }) {
        await mkdir(path.join(places, "mine"));
        const project = await projects.adopt(path.join(places, "mine"));
        return { parent: project.dir, watched: project.dir };
      },
    },
    {
      name: "a project removed from the sidebar",
      async setup({ projects }) {
        const project = await projects.create("Old");
        await projects.forget(project.name);
        return { parent: project.dir, watched: project.dir };
      },
    },
    {
      name: "a project created in a chosen folder",
      async setup({ projects, places }) {
        const project = await projects.create("Placed", { parent: places });
        return { parent: project.dir, watched: project.dir };
      },
    },
    {
      name: "the app's own data",
      async setup({ options }) {
        return { parent: options.userData, watched: options.userData };
      },
    },
    {
      name: "a folder inside the app's own data",
      async setup({ options }) {
        await mkdir(path.join(options.userData, "secrets"));
        return { parent: path.join(options.userData, "secrets"), watched: path.join(options.userData, "secrets") };
      },
    },
    {
      name: "a Claude Code settings folder",
      async setup({ places }) {
        await mkdir(path.join(places, ".claude", "skills"), { recursive: true });
        return { parent: path.join(places, ".claude", "skills"), watched: path.join(places, ".claude", "skills") };
      },
    },
    {
      name: "a link to a project",
      skip: posixOnly,
      async setup({ projects, base }) {
        const project = await projects.create("Pong");
        await symlink(project.dir, path.join(base, "to-pong"));
        return { parent: path.join(base, "to-pong"), watched: project.dir };
      },
    },
    {
      name: "a folder that does not exist",
      async setup({ places }) {
        return { parent: path.join(places, "missing", "deeper"), watched: places };
      },
    },
    {
      name: "a file",
      async setup({ places }) {
        await writeFile(path.join(places, "file.txt"), "text");
        return { parent: path.join(places, "file.txt"), watched: places };
      },
    },
    {
      name: "a relative path",
      async setup({ places }) {
        return { parent: path.relative(process.cwd(), places), watched: places };
      },
    },
    {
      name: "an empty path",
      async setup({ places }) {
        return { parent: "", watched: places };
      },
    },
    {
      name: "the whole disk",
      async setup({ base, places }) {
        return { parent: path.parse(base).root, watched: places };
      },
    },
  ];

  for (const row of rows) {
    it(row.name, { skip: row.skip ?? false }, async () => {
      const env = await workspaces();
      const { parent, watched } = await row.setup(env);
      const before = await sideEffects(env.projects, env.options, watched);
      await assert.rejects(env.projects.location(parent), `${row.name}: the picker refuses it`);
      await assert.rejects(env.projects.create("Intruder", { parent }), `${row.name}: creating there is refused`);
      assert.deepEqual(await sideEffects(env.projects, env.options, watched), before, `${row.name}: nothing changed`);
    });
  }
});

/** A core whose projects folder is spelled by its real path, as a launch's own projects folder is. */
async function studio() {
  return coreLite({ projectsRoot: await realpath(await tmpDir("studio-project-location-projects-")) });
}

describe("the studio checks a chosen folder before the library writes anything", () => {
  it("a development profile keeps new projects inside its own projects folder", { skip: posixOnly }, async () => {
    const { core, projectsRoot } = await studio();
    const outside = await tmpDir("studio-project-location-outside-");
    await symlink(outside, path.join(projectsRoot, "shortcut"));
    for (const parent of [outside, path.join(projectsRoot, "shortcut")]) {
      await assert.rejects(core.projectLocation(parent), /outside the owned|alias/, parent);
      await assert.rejects(core.createProject("Escape", { parent }), /outside the owned|alias/, parent);
    }
    assert.deepEqual(await readdir(outside), [], "nothing was written outside the profile");
    assert.deepEqual(await readdir(projectsRoot), ["shortcut"]);
  });

  it("refuses the Genex login folder, also through a link, before anything is written", {
    skip: posixOnly,
  }, async (t) => {
    const home = await realpath(await tmpDir("studio-project-location-home-"));
    const previous = process.env.HOME;
    process.env.HOME = home;
    t.after(() => {
      process.env.HOME = previous;
    });
    // A launch without the development policy, as the normal profile runs.
    const { core } = await coreLite({ executionPolicy: { runBackgroundImprovement: false } });
    await mkdir(path.join(home, "dotfiles", "genex", "inner"), { recursive: true });
    await symlink(path.join(home, "dotfiles", "genex"), path.join(home, ".genex"));
    for (const parent of [path.join(home, ".genex"), path.join(home, "dotfiles", "genex", "inner")]) {
      await assert.rejects(core.projectLocation(parent), /can't create projects there/, parent);
      await assert.rejects(core.createProject("Leak", { parent }), /can't create projects there/, parent);
    }
    assert.deepEqual(await readdir(path.join(home, "dotfiles", "genex")), ["inner"]);
    assert.deepEqual(await readdir(path.join(home, "dotfiles", "genex", "inner")), []);
  });

  it("offers the projects folder and a plain folder inside it, labelled as the picker shows them", async () => {
    const { core, projectsRoot } = await studio();
    await mkdir(path.join(projectsRoot, "My Stuff"));
    const library = await core.projectLocation(projectsRoot);
    assert.equal(library.dir, await realpath(projectsRoot));
    const project = await core.createProject("Home", { parent: projectsRoot });
    assert.equal(project.library, true);

    const stuff = await core.projectLocation(path.join(projectsRoot, "My Stuff"));
    assert.equal(stuff.dir, await realpath(path.join(projectsRoot, "My Stuff")));
    assert.ok(stuff.pathLabel.endsWith(`${path.sep}My Stuff`), stuff.pathLabel);
    const placed = await core.createProject("Placed", { parent: stuff.dir });
    assert.equal(placed.dir, path.join(stuff.dir, "Placed"));
    assert.ok((await core.projects.list()).some((listed) => listed.dir === placed.dir));
  });
});
