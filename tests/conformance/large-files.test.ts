/**
 * New files too large to save stay out of the studio's commits (`substrate/large-files.ts`).
 *
 * Real git, sparse files (`truncate` allocates no disk) and the real snapshot engine: each case
 * reads what the snapshot's tree holds, what `info/exclude` holds byte for byte, and what is left
 * on disk. Cases marked "guard" describe behavior that holds without the change too; they pin what
 * the change must not disturb.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { folderPrint } from "../../src/main/core/live-gate.ts";
import { mirrorList, treeKey } from "../../src/main/project-build.ts";
import { ProjectCandidates } from "../../src/substrate/project-candidate.ts";
import { CustomEvent, customPayload } from "../../src/shared/custom-events.ts";
import { SnapshotScope } from "../../src/shared/event-log.ts";
import {
  LARGE_FILE_MAX_BYTES,
  LEFT_OUT_MARKER,
  type LeftOutFile,
  excludeLargeNewFiles,
  leftOutPaths,
  pathsInTheWay,
} from "../../src/substrate/large-files.ts";
import { HARNESS_WORKSPACE, SnapshotEngine, SnapshotRefusal, ensureRepo, git } from "../../src/substrate/snapshots.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { fixtureGit } from "../helpers/snapshot-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";

const OVER = LARGE_FILE_MAX_BYTES + 1;
const POSIX_ONLY = process.platform === "win32" && "these names and links cannot exist on this platform";

/** A file of `size` bytes that takes no disk. */
async function sparse(dir: string, rel: string, size = OVER): Promise<void> {
  const file = path.join(dir, ...rel.split("/"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "");
  await truncate(file, size);
}

/** A project folder under a snapshot engine, with what the engine told about files it left out. */
async function project(files: Record<string, string> = { "index.html": "page" }) {
  const dir = await tmpDir("studio-large-files-");
  for (const [rel, text] of Object.entries(files)) await writeFile(path.join(dir, rel), text);
  const told: LeftOutFile[][] = [];
  const engine = new SnapshotEngine([{ name: "project", dir }]);
  engine.onLeftOut = (_name, left) => {
    told.push(left);
  };
  await engine.init();
  const save = async (reason = "save") =>
    await engine.snapshot({ scope: SnapshotScope.Project, projectWorkspace: "project", reason });
  return { dir, engine, told, save };
}

/** The paths a commit's tree holds. */
async function tracked(dir: string, revision = "HEAD"): Promise<string[]> {
  return (await git(dir, ["ls-tree", "-r", "--name-only", "-z", revision])).split("\0").filter(Boolean);
}

/** `.git/info/exclude`, as bytes (empty when there is none). */
async function excludeBytes(dir: string): Promise<Buffer> {
  const where = (await git(dir, ["rev-parse", "--git-path", "info/exclude"])).trim();
  return await readFile(path.resolve(dir, where)).catch(() => Buffer.alloc(0));
}

/** The chat lines about left-out files that a core has written, in order. */
async function leftOutEvents(core: Awaited<ReturnType<typeof coreLite>>["core"]) {
  const told = [];
  for (const event of await core.listAllEvents()) {
    const payload = customPayload(event.data, CustomEvent.ProjectFilesLeftOut);
    if (payload) told.push({ threadId: event.thread_id, ...payload });
  }
  return told;
}

const sizeOf = async (dir: string, rel: string): Promise<number> => (await lstat(path.join(dir, rel))).size;

describe("a new file over the limit stays out of a save", () => {
  it("LF1. one byte over is left out and told once; exactly the limit is saved (the limit guard)", async () => {
    const p = await project();
    await sparse(p.dir, "big.mov");
    await sparse(p.dir, "edge.bin", LARGE_FILE_MAX_BYTES);
    await p.save();
    assert.deepEqual((await tracked(p.dir)).sort(), ["edge.bin", "index.html"]);
    assert.equal(await sizeOf(p.dir, "big.mov"), OVER, "the file is still in the folder, whole");
    const exclude = (await excludeBytes(p.dir)).toString("utf8");
    assert.equal(exclude.split("\n").filter((line) => line === "/big.mov").length, 1);
    assert.equal(exclude.match(/^# Senex:/gm)?.length, 1, "one block of the studio's own");
    assert.deepEqual(p.told, [[{ path: "big.mov", bytes: OVER, listed: true }]]);
    await p.save("again");
    assert.equal(p.told.length, 1, "a second save says nothing more");
    assert.equal((await excludeBytes(p.dir)).toString("utf8"), exclude, "and adds no line");
  });

  it("LF2. an adopted folder's first commit leaves it out and reports through ensureRepo", async () => {
    const dir = await tmpDir("studio-large-files-");
    await writeFile(path.join(dir, "index.html"), "page");
    await sparse(dir, "data/dump.bin");
    const told: LeftOutFile[][] = [];
    await ensureRepo(dir, (files) => {
      told.push(files);
    });
    assert.deepEqual(await tracked(dir), ["index.html"]);
    assert.deepEqual(told, [[{ path: "data/dump.bin", bytes: OVER, listed: true }]]);
    assert.equal(await sizeOf(dir, "data/dump.bin"), OVER);
  });

  it("LF3. the person's own exclude file is only appended to, byte for byte", async () => {
    const p = await project();
    const exclude = path.join(p.dir, ".git", "info", "exclude");
    const own = Buffer.from("# mine\r\n*.log\r\nscratch/");
    await mkdir(path.dirname(exclude), { recursive: true });
    await writeFile(exclude, own);
    await sparse(p.dir, "big.zip");
    await p.save();
    const after = await excludeBytes(p.dir);
    assert.ok(after.subarray(0, own.length).equals(own), "everything they wrote is still there, unchanged");
    assert.match(after.subarray(own.length).toString("utf8"), /^\n# Senex: [^\n]*\n\/big\.zip\n$/);
  });

  it("LF4. a tracked file that grows past the limit is saved as ever; nothing is written (guard)", async () => {
    const p = await project({ "index.html": "page", "grows.bin": "small" });
    await p.save("first");
    const before = await excludeBytes(p.dir);
    await sparse(p.dir, "grows.bin");
    await p.save("grown");
    assert.equal(await sizeOf(p.dir, "grows.bin"), OVER);
    assert.equal((await git(p.dir, ["status", "--porcelain", "--", "grows.bin"])).trim(), "");
    assert.ok((await excludeBytes(p.dir)).equals(before), "nothing was written");
    assert.deepEqual(p.told, []);
  });

  it("LF5. a symlink to a huge file is a link, not a big file (guard)", { skip: POSIX_ONLY }, async () => {
    const p = await project();
    const before = await excludeBytes(p.dir);
    const outside = await tmpDir("studio-large-files-out-");
    await sparse(outside, "huge.bin");
    await symlink(path.join(outside, "huge.bin"), path.join(p.dir, "huge-link"));
    await p.save();
    assert.ok((await tracked(p.dir)).includes("huge-link"));
    assert.ok((await excludeBytes(p.dir)).equals(before));
  });

  it("LF6. the harness's own workspace is not scanned (guard)", async () => {
    const dir = await tmpDir("studio-large-files-");
    await writeFile(path.join(dir, "main.ts"), "export {}");
    const engine = new SnapshotEngine([{ name: HARNESS_WORKSPACE, dir }]);
    engine.onLeftOut = () => assert.fail("the harness workspace is nobody's project folder");
    await engine.init();
    await sparse(dir, "model.bin");
    await engine.snapshot({ scope: SnapshotScope.Harness, reason: "save" });
    assert.ok((await tracked(dir)).includes("model.bin"));
  });

  it("LF7. 2,000 small files change nothing (guard)", async () => {
    const p = await project();
    const before = await excludeBytes(p.dir);
    for (let at = 0; at < 2000; at += 1) await writeFile(path.join(p.dir, `f${at}.txt`), String(at));
    await p.save();
    assert.equal((await tracked(p.dir)).length, 2001);
    assert.ok((await excludeBytes(p.dir)).equals(before));
  });
});

describe("what git must not be able to misread", () => {
  it("LF8. names with pattern characters get escaped lines of their own; siblings that only look alike are still saved", {
    skip: POSIX_ONLY,
  }, async () => {
    const p = await project();
    const big = ["#a.bin", "!b.bin", "star*.bin", "[c].bin", "tail.bin "];
    for (const name of big) await sparse(p.dir, name);
    const small = ["a.bin", "b.bin", "starX.bin", "c.bin", "tail.bin", "star.bin"];
    for (const name of small) await writeFile(path.join(p.dir, name), "small");
    await p.save();
    const saved = await tracked(p.dir);
    for (const name of big) assert.ok(!saved.includes(name), `${JSON.stringify(name)} is out`);
    for (const name of small) assert.ok(saved.includes(name), `${name} is saved`);
    // Out because of their own lines, not because a pathspec rescued them.
    const lines = (await excludeBytes(p.dir)).toString("utf8").split("\n");
    for (const line of ["/#a.bin", "/!b.bin", "/star\\*.bin", "/\\[c\\].bin", "/tail.bin\\ "]) {
      assert.ok(lines.includes(line), `${line} is written`);
    }
    assert.deepEqual(
      p.told.flat().map((file) => file.listed),
      big.map(() => true),
    );
  });

  it("LF8b. a name no line can hold (a backslash, a tab) is kept out by path and said once", {
    skip: POSIX_ONLY,
  }, async () => {
    const p = await project();
    const before = await excludeBytes(p.dir);
    const unsafe = ["back\\slash.bin", "tab\tname.bin"];
    for (const name of unsafe) await sparse(p.dir, name);
    await p.save();
    const saved = await tracked(p.dir);
    for (const name of unsafe) assert.ok(!saved.includes(name), `${JSON.stringify(name)} is out`);
    assert.ok((await excludeBytes(p.dir)).equals(before), "nothing was written for them");
    assert.deepEqual(
      p.told.flat().map((file) => file.listed),
      [false, false],
    );
  });

  it("LF9. a name with a line break never reaches the exclude file; a path keeps it out instead", {
    skip: POSIX_ONLY,
  }, async () => {
    const p = await project();
    await writeFile(path.join(p.dir, "name"), "an innocent file");
    await sparse(p.dir, "sub/nl\nname");
    const own = "*.log\n";
    const exclude = path.join(p.dir, ".git", "info", "exclude");
    await mkdir(path.dirname(exclude), { recursive: true });
    await writeFile(exclude, own);
    await p.save();
    const saved = await tracked(p.dir);
    assert.ok(!saved.includes("sub/nl\nname"));
    assert.ok(saved.includes("name"), "a file called `name` is not hidden by the second half of the other's name");
    assert.equal((await excludeBytes(p.dir)).toString("utf8"), own, "nothing was written for it");
    assert.deepEqual(p.told, [[{ path: "sub/nl\nname", bytes: OVER, listed: false }]]);
    await p.save("again");
    assert.equal(p.told.length, 1, "said once");
    assert.ok(!(await tracked(p.dir)).includes("sub/nl\nname"), "and kept out on every save");
  });

  it("LF10. a .gitignore that takes the file back in cannot put it into the save", async () => {
    const p = await project({ "index.html": "page", ".gitignore": "!*.bin\n" });
    await sparse(p.dir, "video.bin");
    await p.save();
    assert.ok(!(await tracked(p.dir)).includes("video.bin"));
    assert.deepEqual(p.told, [[{ path: "video.bin", bytes: OVER, listed: false }]]);
  });

  it("LF11. an exclude file that is a link out of the repository is not written through", {
    skip: POSIX_ONLY,
  }, async () => {
    const p = await project();
    const outside = await tmpDir("studio-large-files-out-");
    const target = path.join(outside, "their-exclude");
    await writeFile(target, "theirs\n");
    const exclude = path.join(p.dir, ".git", "info", "exclude");
    await rm(exclude, { force: true });
    await symlink(target, exclude);
    await sparse(p.dir, "big.bin");
    await p.save();
    assert.equal(await readFile(target, "utf8"), "theirs\n", "the link's target is unchanged");
    assert.ok(!(await tracked(p.dir)).includes("big.bin"));
    assert.deepEqual(p.told, [[{ path: "big.bin", bytes: OVER, listed: false }]]);
  });

  it("LF11b. a .git/info that is a link out of the repository is not written through", {
    skip: POSIX_ONLY,
  }, async () => {
    const p = await project();
    const outside = await tmpDir("studio-large-files-out-");
    await rm(path.join(p.dir, ".git", "info"), { recursive: true, force: true });
    await symlink(outside, path.join(p.dir, ".git", "info"));
    await sparse(p.dir, "big.bin");
    await p.save();
    assert.deepEqual(await readdir(outside), [], "nothing reached the link's target");
    assert.ok(!(await tracked(p.dir)).includes("big.bin"));
    assert.deepEqual(p.told, [[{ path: "big.bin", bytes: OVER, listed: false }]]);
  });

  it("LF12. a repository whose .git is a file writes the exclude beside its real git directory", async () => {
    const dir = await tmpDir("studio-large-files-");
    const gitDir = await tmpDir("studio-large-files-gitdir-");
    await fixtureGit(dir, ["init", "-q", "--separate-git-dir", path.join(gitDir, "repo")]);
    const p = new SnapshotEngine([{ name: "project", dir }]);
    await writeFile(path.join(dir, "index.html"), "page");
    await sparse(dir, "big.bin");
    await p.init();
    await p.snapshot({ scope: SnapshotScope.Project, projectWorkspace: "project", reason: "save" });
    assert.ok(!(await tracked(dir)).includes("big.bin"));
    assert.match(await readFile(path.join(gitDir, "repo", "info", "exclude"), "utf8"), /^\/big\.bin$/m);
  });

  it("LF13. a nested repository is never opened or excluded as a file (guard)", async () => {
    const p = await project();
    const before = await excludeBytes(p.dir);
    const inner = path.join(p.dir, "inner");
    await mkdir(inner);
    await fixtureGit(inner, ["init", "-q"]);
    await fixtureGit(inner, ["commit", "-q", "--allow-empty", "-m", "inner"]);
    await sparse(inner, "huge.bin");
    await p.save();
    assert.ok((await excludeBytes(p.dir)).equals(before));
    assert.deepEqual(p.told, []);
  });

  it("LF14. two passes at once write one block and report once", async () => {
    const p = await project();
    await sparse(p.dir, "big.bin");
    const [one, two] = await Promise.all([excludeLargeNewFiles(p.dir), excludeLargeNewFiles(p.dir)]);
    assert.equal(one.reported.length + two.reported.length, 1);
    assert.equal((await excludeBytes(p.dir)).toString("utf8").match(/^\/big\.bin$/gm)?.length, 1);
  });
  it("LF14b. a listing that fails fails the pass instead of passing an unchecked folder", async () => {
    const p = await project();
    await sparse(p.dir, "big.bin");
    await writeFile(path.join(p.dir, ".git", "index"), "not an index");
    await assert.rejects(excludeLargeNewFiles(p.dir));
  });

  it("LF14c. a linked worktree writes nothing to the exclude file it shares with the main checkout", async () => {
    const main = await project();
    const linked = path.join(await tmpDir("studio-large-files-wt-"), "linked");
    await git(main.dir, ["worktree", "add", "-q", "--detach", linked]);
    const before = await excludeBytes(main.dir);
    await writeFile(path.join(main.dir, "data.sql"), "tiny, and the main checkout's own");
    await sparse(linked, "data.sql");
    const engine = new SnapshotEngine([{ name: "linked", dir: linked }]);
    const told: LeftOutFile[][] = [];
    engine.onLeftOut = (_name, left) => {
      told.push(left);
    };
    await engine.snapshot({ scope: SnapshotScope.Project, projectWorkspace: "linked", reason: "save" });
    assert.ok(!(await tracked(linked)).includes("data.sql"), "kept out of the worktree's save");
    assert.ok((await excludeBytes(main.dir)).equals(before), "the shared exclude file is as it was");
    assert.equal((await git(main.dir, ["status", "--porcelain", "--", "data.sql"])).trim(), "?? data.sql");
    assert.deepEqual(told, [[{ path: "data.sql", bytes: OVER, listed: false }]]);
  });
});

describe("a line stops being true", () => {
  it("LS1. a file that shrank is saved again, and only the studio's line goes", async () => {
    const p = await project();
    const exclude = path.join(p.dir, ".git", "info", "exclude");
    const mine = "# mine\r\n*.log\r\n";
    await writeFile(exclude, mine);
    await sparse(p.dir, "big.bin");
    await p.save("left out");
    const theirs = "/after.txt\n";
    await writeFile(exclude, `${(await readFile(exclude, "utf8")).trimEnd()}\n${theirs}`);
    await truncate(path.join(p.dir, "big.bin"), 1024);
    await p.save("small now");
    assert.ok((await tracked(p.dir)).includes("big.bin"), "the small file at that path is saved");
    const after = await readFile(exclude, "utf8");
    assert.ok(!after.includes("big.bin"), "its line is gone");
    assert.ok(after.startsWith(mine) && after.endsWith(theirs), "the person's lines are as they were");
  });

  it("LS2. a folder made where a left-out file was is saved, not hidden by the old line", async () => {
    const p = await project();
    await sparse(p.dir, "data");
    await p.save("left out");
    await rm(path.join(p.dir, "data"));
    await mkdir(path.join(p.dir, "data"));
    await writeFile(path.join(p.dir, "data", "rows.csv"), "a,b");
    await p.save("a folder now");
    assert.ok((await tracked(p.dir)).includes("data/rows.csv"));
  });

  it("LS3. a file saved with git add -f is no longer left out, and a restore to it goes through", async () => {
    const p = await project();
    await sparse(p.dir, "big.bin");
    await p.save("left out");
    await fixtureGit(p.dir, ["add", "-f", "big.bin"]);
    const kept = await p.save("saved anyway");
    assert.ok((await tracked(p.dir)).includes("big.bin"));
    assert.deepEqual(await leftOutPaths(p.dir), []);
    await p.engine.restore(kept, { projectWorkspace: "project" });
    assert.equal(await sizeOf(p.dir, "big.bin"), OVER);
  });

  it("LS4. the person's own lines beside the studio's are not read as left-out files", async () => {
    const p = await project();
    await sparse(p.dir, "big.bin");
    await writeFile(path.join(p.dir, "mine.txt"), "mine");
    await p.save();
    const exclude = path.join(p.dir, ".git", "info", "exclude");
    await writeFile(exclude, `${await readFile(exclude, "utf8")}/mine.txt\n`);
    assert.deepEqual(await leftOutPaths(p.dir), ["big.bin"]);
  });

  it("LS5. lines that lead out of the folder name nothing, whatever the file says", { skip: POSIX_ONLY }, async () => {
    const outer = await tmpDir("studio-large-files-outer-");
    const elsewhere = await tmpDir("studio-large-files-elsewhere-");
    await writeFile(path.join(outer, "outside.txt"), "secret");
    await writeFile(path.join(elsewhere, "x"), "secret");
    const dir = path.join(outer, "proj");
    await mkdir(dir);
    await writeFile(path.join(dir, "index.html"), "page");
    await ensureRepo(dir, () => {});
    await symlink(elsewhere, path.join(dir, "link"));
    const exclude = path.join(dir, ".git", "info", "exclude");
    const lines = ["/../outside.txt", "/a/../../outside.txt", "/link/x", "//etc/passwd"];
    await writeFile(exclude, `${lines.map((line) => `${LEFT_OUT_MARKER}\n${line}\n`).join("")}/link\n`);
    assert.deepEqual(await leftOutPaths(dir), []);
    const listed = await mirrorList(dir, null);
    for (const outside of ["../outside.txt", "link/x"]) assert.ok(!listed.includes(outside), outside);
  });
});

describe("a restore and the readers of a folder's file list", () => {
  it("LF15. a restore keeps a left-out file where it is", async () => {
    const p = await project();
    const first = await p.save("first");
    await sparse(p.dir, "big.bin");
    await writeFile(path.join(p.dir, "later.txt"), "after");
    await p.save("second");
    await p.engine.restore(first, { projectWorkspace: "project" });
    assert.equal(await sizeOf(p.dir, "big.bin"), OVER);
    assert.deepEqual(await tracked(p.dir), ["index.html"]);
  });

  for (const saved of [true, false]) {
    it(`LF16. a restore that would overwrite a left-out file is refused, and nothing moves (${saved ? "a save between" : "the file is new"})`, async () => {
      const p = await project({ "index.html": "page", "data.bin": "small" });
      const old = await p.save("has data.bin");
      await git(p.dir, ["rm", "-q", "--cached", "data.bin"]);
      await writeFile(path.join(p.dir, "data.bin"), "");
      await truncate(path.join(p.dir, "data.bin"), OVER);
      if (saved) await p.save("data.bin is big and new again");
      const head = (await git(p.dir, ["rev-parse", "HEAD"])).trim();
      await assert.rejects(p.engine.restore(old, { projectWorkspace: "project" }), (error: unknown) => {
        assert.equal((error as { code?: string }).code, SnapshotRefusal.LargeFileInTheWay);
        return true;
      });
      assert.equal(await sizeOf(p.dir, "data.bin"), OVER);
      assert.equal((await git(p.dir, ["rev-parse", "HEAD"])).trim(), head);
    });
  }

  it("LF16b. a folder in the snapshot where a left-out file stands, or a file where its folder is, refuses the restore", async () => {
    const p = await project({ "index.html": "page" });
    await mkdir(path.join(p.dir, "data.bin"));
    await writeFile(path.join(p.dir, "data.bin", "inner.txt"), "inner");
    await writeFile(path.join(p.dir, "sub"), "a file");
    const old = await p.save("has data.bin/ and sub");
    await rm(path.join(p.dir, "data.bin"), { recursive: true });
    await rm(path.join(p.dir, "sub"));
    await sparse(p.dir, "data.bin");
    await sparse(p.dir, "sub/big.bin");
    await p.save("big files at those paths");
    await assert.rejects(p.engine.restore(old, { projectWorkspace: "project" }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, SnapshotRefusal.LargeFileInTheWay);
      assert.match(String((error as Error).message), /data\.bin.*sub\/big\.bin|sub\/big\.bin.*data\.bin/);
      return true;
    });
    assert.equal(await sizeOf(p.dir, "data.bin"), OVER);
    assert.equal(await sizeOf(p.dir, "sub/big.bin"), OVER);
  });

  it("LF16c. a file kept out by path alone would be deleted by a restore, so the restore is refused", {
    skip: POSIX_ONLY,
  }, async () => {
    const p = await project({ "index.html": "page", ".gitignore": "!*.bin\n" });
    const old = await p.save("before");
    await sparse(p.dir, "video.bin");
    await p.save("after");
    await assert.rejects(p.engine.restore(old, { projectWorkspace: "project" }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, SnapshotRefusal.LargeFileInTheWay);
      return true;
    });
    assert.equal(await sizeOf(p.dir, "video.bin"), OVER, "the file is still there");
  });

  it("LF16d. names compare as a case-insensitive folder reads them", () => {
    assert.deepEqual(pathsInTheWay(["Data.BIN", "docs/readme.md"], ["data.bin", "other.bin"]), ["data.bin"]);
    assert.deepEqual(pathsInTheWay(["data.bin/inner.txt"], ["DATA.bin"]), ["DATA.bin"]);
    assert.deepEqual(pathsInTheWay(["SUB"], ["sub/deep/big.bin"]), ["sub/deep/big.bin"]);
    assert.deepEqual(pathsInTheWay(["data.bin.old", "sub-other"], ["data.bin", "sub/big.bin"]), []);
  });

  it("LF17. leftOutPaths names the files the blocks name that are files on disk now", async () => {
    const p = await project();
    const star = process.platform === "win32" ? "a+b.bin" : "a*b.bin";
    for (const name of [star, "gone.bin", "swapped.bin"]) await sparse(p.dir, name);
    await p.save();
    await sparse(p.dir, "sub/c.bin");
    await p.save("again");
    assert.deepEqual((await leftOutPaths(p.dir)).sort(), [star, "gone.bin", "sub/c.bin", "swapped.bin"].sort());
    await rm(path.join(p.dir, "gone.bin"));
    await rm(path.join(p.dir, "swapped.bin"));
    await mkdir(path.join(p.dir, "swapped.bin"));
    assert.deepEqual((await leftOutPaths(p.dir)).sort(), [star, "sub/c.bin"].sort());
  });

  it("LF18. the build's file list still holds a left-out file", async () => {
    const p = await project();
    await sparse(p.dir, "media/intro.mp4");
    await p.save();
    assert.ok((await mirrorList(p.dir, null)).includes("media/intro.mp4"));
  });

  it("LF18b. replacing a left-out file moves the build's key and the folder's print", async () => {
    const p = await project();
    await sparse(p.dir, "media/intro.mp4");
    await p.save();
    const key = await treeKey(p.dir, null);
    const print = await folderPrint(p.dir);
    await truncate(path.join(p.dir, "media", "intro.mp4"), OVER + 4096);
    assert.notEqual(await treeKey(p.dir, null), key);
    assert.notEqual(await folderPrint(p.dir), print);
  });

  it("LF19. a candidate opens on a baseline whose folder holds a left-out file", async () => {
    const p = await project();
    await sparse(p.dir, "media/intro.mp4");
    const record = await p.save("baseline");
    const scratch = await tmpDir("studio-large-files-candidates-");
    const candidates = new ProjectCandidates(p.engine, scratch);
    const opened = await candidates.open("project", "run_large", record.snapshot_id, record.git.game ?? "");
    assert.ok(opened.candidateId);
    await candidates.close(opened.candidateId);
  });
});

describe("through the core", () => {
  it("LF20. adopting a folder with a big file leaves it out of the first commit and tells the project's chat", async () => {
    const { core, projectsRoot } = await coreLite();
    const dir = path.join(projectsRoot, "footage");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), "<!doctype html><title>x</title>");
    await sparse(dir, "raw/take1.mov");
    const adopted = await core.adoptProject(dir, { template: false });
    assert.ok(!(await tracked(dir)).includes("raw/take1.mov"));
    const told = await leftOutEvents(core);
    assert.equal(told.length, 1);
    assert.deepEqual(told[0]?.files, [{ path: "raw/take1.mov", bytes: OVER }]);
    assert.equal(told[0]?.more, 0);
    assert.equal(told[0]?.limitBytes, LARGE_FILE_MAX_BYTES);
    assert.equal(told[0]?.threadId, await core.threadForProject(adopted.name));
  });

  it("LF21. a later save says so too, and names at most five", async () => {
    const { core, projectsRoot } = await coreLite();
    const dir = path.join(projectsRoot, "reels");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), "<!doctype html><title>x</title>");
    const project = await core.adoptProject(dir, { template: false });
    for (let at = 0; at < 7; at += 1) await sparse(dir, `reel${at}.mov`);
    await core.snapshot(SnapshotScope.Project, "save", project.name);
    const told = await leftOutEvents(core);
    assert.equal(told.length, 1);
    assert.equal(told[0]?.files?.length, 5);
    assert.equal(told[0]?.more, 2);
  });
});
