import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { extractCandidatePaths, isTooBroad, resolveNamedPaths } from "../../src/substrate/user-paths.ts";
import { tmpDir } from "../helpers/tmp.ts";

describe("named paths in chat", () => {
  it("extracts the absolute folder Simeon typed, quoted or bare", () => {
    const home = "/Users/alex";
    const named = "/Users/alex/coding/blame-megastructure-project/ref";
    assert.deepEqual(extractCandidatePaths(`I put reference in ${named} folder.`, home, "darwin"), [named]);
    assert.deepEqual(extractCandidatePaths(`'${named}' refs in this folder inside our root lol`, home, "darwin"), [
      named,
    ]);
    assert.deepEqual(extractCandidatePaths(`stills are in ~/coding/rift/ref`, home, "darwin"), [
      `${home}/coding/rift/ref`,
    ]);
  });

  it("on Windows extracts drive, UNC and ~ folders, with either slash", () => {
    const home = "C:\\Users\\Simeon";
    const named = "C:\\Users\\Simeon\\coding\\blame\\ref";
    assert.deepEqual(extractCandidatePaths(`I put reference in ${named} folder.`, home, "win32"), [named]);
    assert.deepEqual(extractCandidatePaths(`"D:\\Projects\\My Project\\ref" has the stills`, home, "win32"), [
      "D:\\Projects\\My Project\\ref",
    ]);
    assert.deepEqual(extractCandidatePaths("see c:/Users/Simeon/coding/rift/ref.", home, "win32"), [
      "c:\\Users\\Simeon\\coding\\rift\\ref",
    ]);
    assert.deepEqual(extractCandidatePaths("on the share \\\\nas\\art\\ref", home, "win32"), ["\\\\nas\\art\\ref"]);
    assert.deepEqual(extractCandidatePaths("stills are in ~\\coding\\rift\\ref", home, "win32"), [
      "C:\\Users\\Simeon\\coding\\rift\\ref",
    ]);
    assert.deepEqual(extractCandidatePaths("a ratio 3:4 and a path-less C: drive", home, "win32"), []);
  });

  it("will not treat ~/coding as a project", () => {
    const home = "/Users/alex";
    assert.equal(isTooBroad(home, home), true);
    assert.equal(isTooBroad(`${home}/coding`, home), true);
    assert.equal(isTooBroad(`${home}/coding/blame-megastructure-project`, home), false);
  });

  it("a stills folder names its parent as the workspace to open", async () => {
    const root = await tmpDir("named-paths-");
    const project = path.join(root, "blame-megastructure-project");
    const ref = path.join(project, "ref");
    await mkdir(ref, { recursive: true });
    await writeFile(path.join(ref, "main.png"), Buffer.from("png"));
    const named = await resolveNamedPaths(`refs in ${ref}`, { home: os.homedir() });
    assert.equal(named.workspace, await realpath(project));
    assert.ok(named.stillRoots.some((dir) => dir.endsWith(`${path.sep}ref`)));
    assert.ok(named.stillFiles.some((file) => file.endsWith(`${path.sep}main.png`)));
  });
});
