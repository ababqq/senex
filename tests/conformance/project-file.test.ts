import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatFileLink, ChatFileLookup, ChatFileRef } from "../../src/shared/chat-files.ts";
import { projectRelativePath, readCommitFile, readFolderFile } from "../../src/main/project-file.ts";
import { markdownHtml } from "../../src/renderer/ui/markdown-html.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

const known = new Map<string, ChatFileLink | null>([
  ["docs/RESEARCH.md", { open: "beside", path: "docs/RESEARCH.md" }],
  ["docs/BRIEF.md", { open: "beside", path: "docs/BRIEF.md" }],
  ["Node.js", null],
]);
const lookup: ChatFileLookup = (name) => known.get(name);

test("file names in replies become file buttons once main knows them; code names and URLs stay text", () => {
  const names: ChatFileRef[] = [];
  const html = markdownHtml(
    "The documents are here: `docs/RESEARCH.md` and [the plan](docs/BRIEF.md). Uses `Node.js`, see [site](https://example.com).",
    { files: { lookup, names } },
  );
  assert.match(
    html,
    /<button type="button" class="prose-file" data-file-path="docs\/RESEARCH.md" data-file-open="beside" data-file-target="docs\/RESEARCH.md" title="Opens beside the chat">/,
  );
  assert.match(
    html,
    /data-file-path="docs\/BRIEF.md" data-file-open="beside"[^>]*title="Opens beside the chat\ndocs\/BRIEF.md"/,
  );
  assert.match(html, /<span>the plan<\/span>/);
  assert.match(html, /<code>Node.js<\/code>/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.deepEqual([...new Set(names.map((ref) => ref.name))].sort(), ["Node.js", "docs/BRIEF.md", "docs/RESEARCH.md"]);
  assert.doesNotMatch(markdownHtml("`docs/RESEARCH.md`"), /prose-file/, "without a chat nothing is a file");
});

test("a file button cannot carry markup or break out of its attribute", () => {
  const evil: ChatFileLookup = () => ({ open: "app", path: '~/a"onmouseover="alert(1).md' });
  const html = markdownHtml('[x](docs/a"onmouseover="alert(1).md) `docs/<b>.md`', {
    files: { lookup: evil, names: [] },
  });
  assert.match(html, /prose-file/);
  assert.doesNotMatch(html, /onmouseover="alert/);
  assert.doesNotMatch(html, /<b>/);
});

test("names outside the project are refused, never searched for", () => {
  const project = "/Users/me/AI Projects/boxer";
  assert.equal(projectRelativePath("docs/BRIEF.md", project), "docs/BRIEF.md");
  assert.equal(projectRelativePath("./docs/../docs/BRIEF.md:12", project), "docs/BRIEF.md");
  assert.equal(projectRelativePath(`${project}/src/main.js`, project), "src/main.js");
  assert.equal(projectRelativePath(`file://${encodeURI(project)}/NOTES.md`, project), "NOTES.md");
  for (const name of [
    "../other/secret.md",
    "/etc/passwd",
    "~/.ssh/id_rsa",
    ".git/config",
    "/Users/me/AI Projects/other/a.md",
    "",
  ])
    assert.equal(projectRelativePath(name, project), null, name);
});

test("the project folder and the build answer; links out of the folder do not", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "project-file-"));
  const project = path.join(root, "project");
  mkdirSync(path.join(project, "docs"), { recursive: true });
  writeFileSync(path.join(root, "secret.md"), "outside");
  writeFileSync(path.join(project, "docs", "BRIEF.md"), "# Plan");
  writeFileSync(path.join(project, "art.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  writeFileSync(path.join(project, "blob.bin"), Buffer.from([1, 0, 2, 3]));
  symlinkSync(path.join(root, "secret.md"), path.join(project, "escape.md"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", project, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    })
      .toString()
      .trim();
  git("init", "-q");
  writeFileSync(path.join(project, "docs", "RESEARCH.md"), "only in the build");
  git("add", "docs/RESEARCH.md");
  git("commit", "-qm", "build");
  const head = git("rev-parse", "HEAD");
  git("rm", "-q", "docs/RESEARCH.md");

  assert.deepEqual(await readFolderFile(project, "docs/BRIEF.md"), {
    path: "docs/BRIEF.md",
    name: "BRIEF.md",
    where: "project",
    kind: "markdown",
    text: "# Plan",
  });
  assert.equal((await readFolderFile(project, "art.png"))?.src?.startsWith("data:image/png;base64,"), true);
  assert.equal((await readFolderFile(project, "blob.bin"))?.kind, "other");
  assert.equal(await readFolderFile(project, "escape.md"), null, "a link out of the folder is not followed");
  assert.equal(await readFolderFile(project, "docs/RESEARCH.md"), null);
  assert.deepEqual(await readCommitFile(project, head, "docs/RESEARCH.md"), {
    path: "docs/RESEARCH.md",
    name: "RESEARCH.md",
    where: "build",
    kind: "markdown",
    text: "only in the build",
  });
  assert.equal(await readCommitFile(project, head, "docs"), null, "a folder is not a file");
  assert.equal(await readCommitFile(project, "HEAD~1; rm -rf /", "docs/BRIEF.md"), null);
});

test("a chat reads only its own project: no folder, a name that leaves it, or a link out of it is refused", async () => {
  const { core, projectsRoot } = await coreLite({
    projectsRoot: realpathSync.native(await tmpDir("project-file-reader-")),
  });
  const project = await core.projects.scaffold("reader", { title: "Reader" });
  const threadId = await core.threadForProject("reader");
  mkdirSync(path.join(project.dir, "docs"), { recursive: true });
  writeFileSync(path.join(project.dir, "docs", "BRIEF.md"), "# Plan");
  writeFileSync(path.join(projectsRoot, "outside.md"), "secret");
  symlinkSync(path.join(projectsRoot, "outside.md"), path.join(project.dir, "link.md"));

  assert.equal((await core.readProjectFile(threadId, "docs/BRIEF.md")).text, "# Plan");
  assert.equal(
    await core.revealProjectFile(threadId, "docs/BRIEF.md"),
    path.join(realpathSync.native(project.dir), "docs", "BRIEF.md"),
  );
  for (const name of ["../outside.md", "/etc/passwd", ".git/config", "~/.ssh/id_rsa"]) {
    await assert.rejects(core.readProjectFile(threadId, name), /outside this project/, name);
    await assert.rejects(core.revealProjectFile(threadId, name), /isn’t in the project folder/, name);
  }
  await assert.rejects(core.readProjectFile(threadId, "link.md"), /Couldn’t find link.md/);
  await assert.rejects(core.revealProjectFile(threadId, "link.md"), /isn’t in the project folder/);
  const unbound = await core.createProjectThread();
  await assert.rejects(core.readProjectFile(unbound, "docs/BRIEF.md"), /no project folder/);
});

test("message images come only from that message's saved attachments, and only images", async () => {
  const { core } = await coreLite();
  await core.projects.scaffold("pictures", { title: "Pictures" });
  const threadId = await core.threadForProject("pictures");
  const png = { mimeType: "image/png", data: "iVBORw0KGgo=" };
  await core.store.writeArtifact(threadId, "message_attachments_m1", {
    stills: [png, { mimeType: "text/html", data: "<script>" }, { mimeType: "image/png" }],
  });
  assert.deepEqual(await core.messageImages(threadId, "m1"), [png]);
  assert.deepEqual(await core.messageImages(threadId, "missing"), []);
  for (const id of ["../m1", "m1/..", "", "x".repeat(81)])
    assert.deepEqual(await core.messageImages(threadId, id), [], id);
});
