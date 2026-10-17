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

test("a project that is only opened, not built in, gets the same repair, whatever the file's line endings", async () => {
  const lite = await coreLite();
  const rules = [".studio/", "node_modules", ".git.studio-backup", "*.sqlite", "output/", ".env", ".playwright-cli/"];
  const rows: Array<[string, string, string]> = [
    ["every studio rule", `export/\n.DS_Store\n${rules.join("\n")}\n`, `.DS_Store\n${rules.join("\n")}\n`],
    ["Windows line endings", "export/\r\n.DS_Store\r\nbuild/\r\n", ".DS_Store\r\nbuild/\r\n"],
    ["no final newline", "export/\n.DS_Store", ".DS_Store"],
    ["a user's own export/ after other rules", "dist/\nexport/\n.DS_Store\n", "dist/\nexport/\n.DS_Store\n"],
    ["an export/ not followed by the header's second line", "export/\n*.log\n", "export/\n*.log\n"],
  ];
  for (const [index, [what, before, after]] of rows.entries()) {
    const project = await lite.core.projects.scaffold(`opened-${index}`, { title: `Opened ${index}` });
    const gitignore = path.join(project.dir, ".gitignore");
    await writeFile(gitignore, before);
    await lite.core.projects.touch(project.name);
    assert.equal(await readFile(gitignore, "utf8"), after, what);
  }
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
