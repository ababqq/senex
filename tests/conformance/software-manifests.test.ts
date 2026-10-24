/**
 * A folder is somebody's software when its package.json says so, or when it holds the one file a
 * language's own tooling starts from (go.mod, Gemfile, Cargo.toml, manage.py, hugo.toml…). Software
 * with no web page of its own is opened, not given a starter project: the starter's 15 files would
 * sit beside files it knows nothing about, and its briefing ("this project starts empty") would
 * be false there. Before, only a package.json counted, so a Go, Rails, Django or Hugo folder was
 * written into the moment it was opened without a sheet (the chat pointing at a path).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { openOptions } from "../../src/shared/shape-words.ts";
import { folderDeclaresSoftware } from "../../src/substrate/project-shape.ts";
import { ProjectWorkspaces } from "../../src/substrate/project-workspace.ts";
import { tmpDir } from "../helpers/tmp.ts";

const repo = path.resolve(import.meta.dirname, "../..");
const POSIX = process.platform !== "win32";
const STARTER_PAGES = ["index.html", "src/main.js", "CLAUDE.md", "NOTES.md", "docs/CONTRACT.md"];

/** What a language's tooling starts from, by ecosystem: each is a folder of software on its own. */
const MANIFESTS: Array<[string, string]> = [
  ["Go", "go.mod"],
  ["Rust", "Cargo.toml"],
  ["Ruby", "Gemfile"],
  ["Python", "pyproject.toml"],
  ["Python pip", "requirements.txt"],
  ["Python setup", "setup.py"],
  ["Django", "manage.py"],
  ["PHP", "composer.json"],
  ["Java Maven", "pom.xml"],
  ["Gradle", "build.gradle"],
  ["Gradle Kotlin", "build.gradle.kts"],
  ["Elixir", "mix.exs"],
  ["Swift", "Package.swift"],
  ["Dart", "pubspec.yaml"],
  ["Deno", "deno.json"],
  ["Hugo", "hugo.toml"],
  ["Jekyll", "_config.yml"],
  ["MkDocs", "mkdocs.yml"],
];

/** Folders opened every way in below. */
const ADOPTED: ReadonlyArray<readonly [string, string]> = [
  ["Go", "go.mod"],
  ["Django", "manage.py"],
  ["Hugo", "hugo.toml"],
  ["Rails", "Gemfile"],
];

/** The one row a sheet shows for a folder with no project in it. */
function onlyRow(inspection: Parameters<typeof openOptions>[0]) {
  const [row] = openOptions(inspection);
  assert.ok(row, "the sheet has a row to open the folder by");
  return row;
}

async function workspaces() {
  const base = await tmpDir("studio-manifests-");
  const projects = new ProjectWorkspaces({
    root: path.join(base, "library"),
    templateDir: path.join(repo, "src", "project-template"),
    vendorDir: path.join(base, "vendor"),
    indexFile: path.join(base, "projects.json"),
    userData: path.join(base, "userData"),
    homeDir: base,
  });
  return { projects, base };
}

/** A folder holding exactly these files. */
async function folder(base: string, name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(base, name);
  await mkdir(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text);
  }
  return dir;
}

const exists = (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false,
  );

describe("which folders are somebody's software", () => {
  for (const [ecosystem, manifest] of MANIFESTS) {
    it(`takes a folder with a ${manifest} (${ecosystem}) for software`, async () => {
      const { base } = await workspaces();
      const dir = await folder(base, "app", { [manifest]: "x\n" });
      assert.equal(await folderDeclaresSoftware(dir), true);
    });
  }

  it("still asks a package.json to declare packages or a script someone wrote", async () => {
    const { base } = await workspaces();
    const declared = await folder(base, "declared", {
      "package.json": JSON.stringify({ dependencies: { next: "15.0.0" } }),
    });
    const bare = await folder(base, "bare", { "package.json": JSON.stringify({ name: "bare" }) });
    assert.equal(await folderDeclaresSoftware(declared), true);
    assert.equal(await folderDeclaresSoftware(bare), false);
  });

  it("does not take a stray source file, notes or an empty folder for software", async () => {
    const { base } = await workspaces();
    const strays: Array<[string, Record<string, string>]> = [
      ["script", { "script.py": "print('hi')\n" }],
      ["go-source", { "main.go": "package main\n" }],
      ["ruby-source", { "app.rb": "puts 1\n" }],
      ["lock-only", { "Cargo.lock": "# lock\n", "yarn.lock": "# lock\n" }],
      ["notes", { "README.md": "# notes\n" }],
      ["near-miss", { "go.mod.bak": "module x\n", "Gemfile.txt": "x\n", "my-pom.xml": "x\n" }],
      ["empty", {}],
    ];
    for (const [name, files] of strays) {
      const dir = await folder(base, name, files);
      assert.equal(await folderDeclaresSoftware(dir), false, name);
    }
  });

  it("reads only a regular file named for a manifest: not a folder, a link or a pipe", async () => {
    const { base } = await workspaces();
    const asFolder = await folder(base, "dir-named-go-mod", {});
    await mkdir(path.join(asFolder, "go.mod"));
    assert.equal(await folderDeclaresSoftware(asFolder), false, "a folder named go.mod");

    const elsewhere = await folder(base, "elsewhere", { Gemfile: "source 'https://rubygems.org'\n" });
    const linked = await folder(base, "link-named-gemfile", {});
    await symlink(path.join(elsewhere, "Gemfile"), path.join(linked, "Gemfile")).catch(() => undefined);
    assert.equal(await folderDeclaresSoftware(linked), false, "a link named Gemfile is not followed");

    if (POSIX) {
      const piped = await folder(base, "pipe-named-cargo", {});
      await promisify(execFile)("mkfifo", [path.join(piped, "Cargo.toml")]);
      assert.equal(await folderDeclaresSoftware(piped), false, "a pipe named Cargo.toml is never opened");
    }
    assert.equal(await folderDeclaresSoftware(path.join(base, "missing")), false, "a folder that is not there");
  });
});

describe("a folder of software with no page is opened as it is, every way in", () => {
  for (const [ecosystem, manifest] of ADOPTED) {
    it(`writes no starter page into a ${ecosystem} folder: the sheet, the chat's bare adopt, the library`, async () => {
      const { projects, base } = await workspaces();
      const dir = await folder(base, "site", { [manifest]: "x\n", "content/post.md": "# hello\n" });
      const before = (await readdir(dir, { recursive: true })).sort();

      const inspection = await projects.inspect(dir);
      assert.equal(inspection.packageWithoutPage, true);
      const row = onlyRow(inspection);
      assert.match(row.headline, /software with no web page/);
      assert.deepEqual(row.choice, { template: false });
      assert.deepEqual((await readdir(dir, { recursive: true })).sort(), before, "looking writes nothing");

      // The chat adopts a folder it was pointed at with no options and no sheet.
      const planned = await projects.plannedWrites(dir);
      for (const file of STARTER_PAGES) assert.ok(!planned.includes(file), `${file} is not planned`);
      await projects.adopt(dir);
      for (const file of STARTER_PAGES) assert.equal(await exists(path.join(dir, file)), false, `${file} was written`);
      assert.equal(await exists(path.join(dir, manifest)), true);

      // A library folder of the same kind is described, never scaffolded over.
      const home = path.join(base, "library", "site2");
      await folder(path.join(base, "library"), "site2", { [manifest]: "x\n" });
      await projects.scaffold("site2");
      assert.equal(await exists(path.join(home, "index.html")), false, "scaffold left the folder alone");
    });
  }

  it("gives the starter when the caller asks for it, and leaves a folder with a page of its own to its page", async () => {
    const { projects, base } = await workspaces();
    const wants = await folder(base, "wants-a-starter", { "go.mod": "module x\n" });
    assert.ok((await projects.plannedWrites(wants, { template: true })).includes("index.html"));

    const withPage = await folder(base, "go-with-a-page", { "go.mod": "module x\n", "index.html": "<p>hi</p>" });
    const inspection = await projects.inspect(withPage);
    assert.equal(inspection.packageWithoutPage, false, "a project with its own page is never described this way");
    assert.ok(inspection.candidates.length > 0);
  });

  it("keeps an empty folder, and a folder of notes, what they were: they get the starter", async () => {
    const { projects, base } = await workspaces();
    const empty = await folder(base, "nothing", {});
    const notes = await folder(base, "notes", { "README.md": "# notes\n", "script.py": "print(1)\n" });
    for (const dir of [empty, notes]) {
      const inspection = await projects.inspect(dir);
      assert.equal(inspection.packageWithoutPage, false);
      assert.equal(onlyRow(inspection).headline, "an empty folder");
    }
  });
});
