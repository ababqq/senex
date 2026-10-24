/**
 * A command may exit without reading the input the host wrote to it. That closes the pipe under the
 * write, and it is the command's business: the run still resolves with the command's own result
 * instead of raising an uncaught `write EPIPE` that takes the host down.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

/** Large enough that the child has exited before the kernel pipe can take all of it. */
const UNREAD_STDIN_BYTES = 8_000_000;
const RUNS = 5;
const SPAWN_TS = pathToFileURL(path.resolve("src/substrate/spawn.ts")).href;

/** Runs `RUNS` commands that exit without reading their stdin, in a process of their own so a crash is a status. */
const PROBE = `
  import { mkdtempSync, realpathSync } from "node:fs";
  import os from "node:os";
  import path from "node:path";
  import { setImmediate as nextTurn } from "node:timers/promises";
  import { ProcessSandbox } from ${JSON.stringify(SPAWN_TS)};
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "spawn-stdin-")));
  const sandbox = await ProcessSandbox.create({
    writableRoots: [root], scratchDir: path.join(root, "scratch"), secretPaths: [], enabled: false,
  });
  const codes = [];
  for (let run = 0; run < ${RUNS}; run++)
    codes.push((await sandbox.run({ command: "exit 3", cwd: root, stdin: "x".repeat(${UNREAD_STDIN_BYTES}) })).code);
  await nextTurn();
  console.log(JSON.stringify(codes));
`;

describe("a command that never reads its stdin", () => {
  it("ends its run with its own exit code, run after run, and raises nothing in the host", {
    skip: process.platform === "win32" && "Windows feeds a run's stdin from a file, not a pipe",
  }, () => {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", PROBE], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "[]"), Array(RUNS).fill(3));
  });
});
