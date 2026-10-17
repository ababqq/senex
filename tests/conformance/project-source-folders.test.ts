/**
 * A project's source folders are the project's to name. A "CSV export" feature keeps its code in
 * `src/export/`; neither Git nor the harness's file tree may treat that folder as someone's old
 * output (exports went to the studio's own folder long ago), or the module is silently left out of
 * a worker's commit and out of the build that lands.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { coreLite } from "../helpers/core-lite.ts";

const exec = promisify(execFile);

test("a project's src/export folder is tracked by Git and listed by the harness's file tree", async () => {
  const lite = await coreLite();
  const project = await lite.core.projects.scaffold("csv-tool", { title: "CSV tool" });
  await mkdir(path.join(project.dir, "src", "export"), { recursive: true });
  await writeFile(
    path.join(project.dir, "src", "export", "csv.js"),
    "export const toCsv = (rows) => rows.join('\\n');\n",
  );

  const ignored = await exec("git", ["check-ignore", "-q", "src/export/csv.js"], { cwd: project.dir }).then(
    () => 0,
    (error: { code?: number }) => error.code ?? -1,
  );
  assert.equal(ignored, 1, "Git does not ignore a source folder called export (check-ignore exits 1)");
  const staged = await exec("git", ["add", "-A", "--dry-run"], { cwd: project.dir });
  assert.match(staged.stdout, /src\/export\/csv\.js/, "and adding the project's files takes it");

  const tree = await lite.api()["project.tree"]({ project: project.name });
  assert.ok(tree.includes("src/export/csv.js"), tree.join(", "));
});

test("a project the studio started with its old .gitignore loses the export/ line when it is opened again, and only that line", async () => {
  const lite = await coreLite();
  const project = await lite.core.projects.scaffold("old-tool", { title: "Old tool" });
  const gitignore = path.join(project.dir, ".gitignore");
  // What the studio wrote before exports left the project folder, plus a rule of the user's own.
  await writeFile(gitignore, "export/\n.DS_Store\n.studio/\nnode_modules\n.git.studio-backup\n*.sqlite\n");
  assert.ok(
    (await lite.core.projects.plannedWrites(project.dir)).includes(".gitignore"),
    "the sheet promises the change",
  );

  await lite.core.projects.adopt(project.dir);
  const text = await readFile(gitignore, "utf8");
  assert.doesNotMatch(text, /^export\/$/m);
  for (const kept of [".DS_Store", ".studio/", "node_modules", ".git.studio-backup", "*.sqlite"]) {
    assert.match(text, new RegExp(`^${kept.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"), kept);
  }
  await mkdir(path.join(project.dir, "src", "export"), { recursive: true });
  await writeFile(path.join(project.dir, "src", "export", "pdf.js"), "export const toPdf = () => 1;\n");
  const ignored = await exec("git", ["check-ignore", "-q", "src/export/pdf.js"], { cwd: project.dir }).then(
    () => 0,
    (error: { code?: number }) => error.code ?? -1,
  );
  assert.equal(ignored, 1, "git check-ignore exits 1 for a path nothing ignores");
  assert.equal(
    (await lite.core.projects.plannedWrites(project.dir)).includes(".gitignore"),
    false,
    "and nothing is left to write",
  );
});

/** What a repository's porcelain status says, one line per change. */
async function dirt(dir: string): Promise<string> {
  return (await exec("git", ["status", "--porcelain"], { cwd: dir })).stdout;
}

test("a project that is only opened, not built in, gets the same repair, committed, whatever the file's line endings", async () => {
  const lite = await coreLite();
  const rules = [".studio/", "node_modules", ".git.studio-backup", "*.sqlite", "output/", ".env", ".playwright-cli/"];
  const rows: Array<[string, string, string]> = [
    ["every studio rule", `export/\n.DS_Store\n${rules.join("\n")}\n`, `.DS_Store\n${rules.join("\n")}\n`],
    ["Windows line endings", "export/\r\n.DS_Store\r\n.studio/\r\nbuild/\r\n", ".DS_Store\r\n.studio/\r\nbuild/\r\n"],
    ["no final newline", "export/\n.DS_Store\n.studio/", ".DS_Store\n.studio/"],
    [
      "a user's own export/ after other rules",
      "dist/\nexport/\n.DS_Store\n.studio/\n",
      "dist/\nexport/\n.DS_Store\n.studio/\n",
    ],
    ["an export/ not followed by the header's second line", "export/\n*.log\n.studio/\n", "export/\n*.log\n.studio/\n"],
    [
      "a header a person wrote for themselves: none of the studio's own rules follow it",
      "export/\n.DS_Store\n*.log\n",
      "export/\n.DS_Store\n*.log\n",
    ],
  ];
  for (const [index, [what, before, after]] of rows.entries()) {
    const project = await lite.core.projects.scaffold(`opened-${index}`, { title: `Opened ${index}` });
    const gitignore = path.join(project.dir, ".gitignore");
    // What the project looked like under the old studio: that file, committed.
    await writeFile(gitignore, before);
    await exec("git", ["add", ".gitignore"], { cwd: project.dir });
    await exec("git", ["commit", "-q", "-m", "an older studio's commit"], { cwd: project.dir });
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: project.dir })).stdout;
    await lite.core.projects.touch(project.name);
    assert.equal(await readFile(gitignore, "utf8"), after, what);
    assert.equal(await dirt(project.dir), "", `${what}: opening leaves the folder as clean as it found it`);
    const moved = (await exec("git", ["rev-parse", "HEAD"], { cwd: project.dir })).stdout !== head;
    assert.equal(moved, before !== after, `${what}: a repair is one commit, no repair is none`);
  }
});

test("opening a project never touches a .gitignore its owner is in the middle of editing, or what they staged", async () => {
  const lite = await coreLite();
  const project = await lite.core.projects.scaffold("busy-tool", { title: "Busy tool" });
  const gitignore = path.join(project.dir, ".gitignore");
  await writeFile(gitignore, "export/\n.DS_Store\n.studio/\n");
  await exec("git", ["add", ".gitignore"], { cwd: project.dir });
  await exec("git", ["commit", "-q", "-m", "an older studio's commit"], { cwd: project.dir });
  // Their own edit, not yet committed.
  const edited = "export/\n.DS_Store\n.studio/\n# my notes\n";
  await writeFile(gitignore, edited);
  await lite.core.projects.touch(project.name);
  assert.equal(await readFile(gitignore, "utf8"), edited, "an edit in progress is theirs");

  // And a file they staged for their own next commit stays staged when a repair is committed.
  const other = await lite.core.projects.scaffold("staging-tool", { title: "Staging tool" });
  await writeFile(path.join(other.dir, ".gitignore"), "export/\n.DS_Store\n.studio/\n");
  await exec("git", ["add", ".gitignore"], { cwd: other.dir });
  await exec("git", ["commit", "-q", "-m", "an older studio's commit"], { cwd: other.dir });
  await writeFile(path.join(other.dir, "notes.txt"), "mine\n");
  await exec("git", ["add", "notes.txt"], { cwd: other.dir });
  await lite.core.projects.touch(other.name);
  assert.equal(await dirt(other.dir), "A  notes.txt\n", "only their staged file is left, still staged");
  assert.equal(await readFile(path.join(other.dir, ".gitignore"), "utf8"), ".DS_Store\n.studio/\n");
});

test("a .gitignore the user wrote, export/ included, is theirs", async () => {
  const lite = await coreLite();
  const project = await lite.core.projects.scaffold("their-tool", { title: "Their tool" });
  const gitignore = path.join(project.dir, ".gitignore");
  const theirs =
    "dist/\nexport/\n.DS_Store\n.studio/\nnode_modules\n.git.studio-backup\noutput/\n.env\n.playwright-cli/\n";
  await writeFile(gitignore, theirs);
  await lite.core.projects.adopt(project.dir);
  assert.equal(await readFile(gitignore, "utf8"), theirs);
});
