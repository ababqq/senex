/**
 * A project's source folders are the project's to name. A "CSV export" feature keeps its code in
 * `src/export/`; neither Git nor the harness's file tree may treat that folder as someone's old
 * output (exports went to the studio's own folder long ago), or the module is silently left out of
 * a worker's commit and out of the build that lands.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
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
    () => true,
    () => false,
  );
  assert.equal(ignored, false, "Git does not ignore a source folder called export");
  const staged = await exec("git", ["add", "-A", "--dry-run"], { cwd: project.dir });
  assert.match(staged.stdout, /src\/export\/csv\.js/, "and adding the project's files takes it");

  const tree = await lite.api()["project.tree"]({ project: project.name });
  assert.ok(tree.includes("src/export/csv.js"), tree.join(", "));
});
