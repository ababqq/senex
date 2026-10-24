/**
 * The dev status record's view of the harness workspace: how far it has drifted from the shipped
 * seed, and its git state. The in-app agent edits that folder, so its git is read through the
 * host policy, and a read that cannot be answered says so (null) instead of reporting a clean tree.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, stat, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { harnessIdentity } from "../../src/main/dev/harness-identity.ts";
import { fixtureGit } from "../helpers/snapshot-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";

const POSIX = process.platform !== "win32";
const PROMPT = "prompts/identity.md";

/** A build folder whose shipped seed holds one prompt. */
async function shippedBuild(): Promise<string> {
  const buildRoot = await tmpDir("harness-identity-build-");
  await mkdir(path.join(buildRoot, "resources/harness-seed/prompts"), { recursive: true });
  await writeFile(path.join(buildRoot, "resources/harness-seed", PROMPT), "you are the harness\n");
  return buildRoot;
}

/** A harness workspace under git, holding the shipped prompt as committed. */
async function workspace(): Promise<string> {
  const dir = path.join(await tmpDir("harness-identity-ws-"), "ws");
  await mkdir(path.join(dir, "prompts"), { recursive: true });
  await fixtureGit(dir, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(dir, PROMPT), "you are the harness\n");
  await fixtureGit(dir, ["add", "-A"]);
  await fixtureGit(dir, ["commit", "-q", "-m", "seed"]);
  return dir;
}

describe("the harness identity the dev status reports", () => {
  it("names the commit and whether the workspace has changes, and which files drifted from the seed", async () => {
    const buildRoot = await shippedBuild();
    const dir = await workspace();
    const head = await fixtureGit(dir, ["rev-parse", "HEAD"]);
    const clean = await harnessIdentity(dir, buildRoot);
    assert.equal(clean.sha, head);
    assert.equal(clean.dirty, false);
    assert.deepEqual(clean.divergentPaths, []);
    assert.equal(clean.runtimeDigest, clean.shippedDigest);

    await writeFile(path.join(dir, PROMPT), "you are a different harness\n");
    const edited = await harnessIdentity(dir, buildRoot);
    assert.equal(edited.dirty, true);
    assert.deepEqual(edited.divergentPaths, [PROMPT]);
    assert.notEqual(edited.runtimeDigest, edited.shippedDigest);
  });

  it("says it cannot tell, rather than that the workspace is clean, when git has no answer", async () => {
    const buildRoot = await shippedBuild();
    const plain = await tmpDir("harness-identity-plain-");
    await mkdir(path.join(plain, "prompts"), { recursive: true });
    await writeFile(path.join(plain, PROMPT), "you are the harness\n");
    const identity = await harnessIdentity(plain, buildRoot);
    assert.equal(identity.sha, null);
    assert.equal(identity.dirty, null);
  });

  it("does not report another repository's state for a workspace whose .git leads out of it", async () => {
    const buildRoot = await shippedBuild();
    const other = await workspace();
    await writeFile(path.join(other, "stray.txt"), "dirty\n");
    const dir = await tmpDir("harness-identity-link-");
    await mkdir(path.join(dir, "prompts"), { recursive: true });
    await writeFile(path.join(dir, PROMPT), "you are the harness\n");
    await writeFile(path.join(dir, ".git"), `gitdir: ${path.join(other, ".git")}\n`);
    const identity = await harnessIdentity(dir, buildRoot);
    assert.equal(identity.sha, null);
    assert.equal(identity.dirty, null);
  });

  it("keeps a program the workspace's own git config names from running", {
    skip: !POSIX && "shell scripts",
  }, async () => {
    const buildRoot = await shippedBuild();
    const dir = await workspace();
    const outside = await tmpDir("harness-identity-outside-");
    const marker = path.join(outside, "RAN");
    const hook = path.join(outside, "monitor.sh");
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    await chmod(hook, 0o755);
    await appendFile(path.join(dir, ".git", "config"), `[core]\n\tfsmonitor = ${hook}\n`);
    await writeFile(path.join(dir, "stray.txt"), "dirty\n");
    const identity = await harnessIdentity(dir, buildRoot);
    assert.equal(identity.dirty, true);
    await assert.rejects(stat(marker), "the monitor named in the workspace's config never ran");
  });
});
