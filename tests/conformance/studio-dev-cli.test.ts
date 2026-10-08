import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { parseStudioDevArgs, parseOperation } from "../../scripts/studio-dev/args.ts";
import { FIXTURE_NAMES } from "../../src/main/dev/fixtures.ts";
import { devBuildArgs, main } from "../../scripts/studio-dev.ts";

test("fixtures lists the one exported fixture list without a profile or app", async () => {
  assert.equal(FIXTURE_NAMES.length, 16);
  for (const added of ["first-launch", "notifications", "build-graph", "sandbox-setup", "update-ready"])
    assert.ok((FIXTURE_NAMES as readonly string[]).includes(added), added);
  assert.deepEqual(await main(["fixtures"]), { fixtures: [...FIXTURE_NAMES] });
  // An unknown fixture is refused before any profile is allocated or build started.
  await assert.rejects(
    main(["start", "--profile", "cli-test-never-created", "--fixture", "nope"]),
    /unknown named fixture; one of app-basics/,
  );
});

test("lifecycle commands keep their flags; missing profile and unknown commands fail before any work", () => {
  assert.deepEqual(parseStudioDevArgs(["start", "--profile", "p", "--fixture", "sidebar", "--reuse"]), {
    command: "start",
    profile: "p",
    reuse: true,
    providers: undefined,
    fixture: "sidebar",
  });
  assert.deepEqual(parseStudioDevArgs(["stop", "--profile", "p"]), { command: "stop", profile: "p", reuse: false });
  assert.throws(() => parseStudioDevArgs(["status"]), /Usage: studio:dev/);
  assert.throws(() => parseStudioDevArgs(["launch", "--profile", "p"]), /unknown command launch/);
  assert.throws(() => parseStudioDevArgs(["start", "--profile", "--fixture", "x"]), /--profile needs a value/);
});

test("ui takes a request file, stdin or inline --json, exactly one of them", () => {
  assert.equal(parseStudioDevArgs(["ui", "--profile", "p", "--request", "/tmp/r.json"]).requestFile, "/tmp/r.json");
  assert.equal(parseStudioDevArgs(["diagnostics", "--profile", "p", "--request", "-"]).requestFile, "-");
  const inline = parseStudioDevArgs([
    "ui",
    "--profile",
    "p",
    "--json",
    '{"method":"click","params":{"selector":"[aria-label=\\"Send\\"]"}}',
  ]);
  assert.deepEqual(inline.operation, { method: "click", params: { selector: '[aria-label="Send"]' } });
  assert.equal(inline.requestFile, undefined);
  assert.throws(() => parseStudioDevArgs(["ui", "--profile", "p"]), /--request FILE, --request - or --json/);
  assert.throws(
    () => parseStudioDevArgs(["ui", "--profile", "p", "--request", "a.json", "--json", "{}"]),
    /one of --request or --json/,
  );
  // Inline requests get the same closed schema as files: no eval, no privileged fields.
  assert.throws(() =>
    parseStudioDevArgs(["ui", "--profile", "p", "--json", '{"method":"evaluate","params":{"expression":"1"}}']),
  );
  assert.throws(() => parseStudioDevArgs(["ui", "--profile", "p", "--json", '{"method":"stop","params":{"pid":1}}']));
  assert.throws(() => parseOperation("{not json"), /request is not JSON/);
  assert.deepEqual(parseOperation('{"method":"project.state","params":{}}'), { method: "project.state", params: {} });
});

test("snapshot, logs and capture shortcuts build the protocol operations with its defaults", () => {
  assert.deepEqual(parseStudioDevArgs(["snapshot", "--profile", "p"]).operation, {
    method: "snapshot",
    params: { surface: "desktop", limit: 150 },
  });
  assert.deepEqual(
    parseStudioDevArgs(["snapshot", "--profile", "p", "--scope", "[data-stage-view]", "--limit", "20"]).operation,
    { method: "snapshot", params: { surface: "desktop", scope: "[data-stage-view]", limit: 20 } },
  );
  assert.deepEqual(parseStudioDevArgs(["logs", "--profile", "p"]).operation, {
    method: "logs",
    params: { surface: "desktop", cursor: 0, limit: 100 },
  });
  assert.deepEqual(parseStudioDevArgs(["logs", "--profile", "p", "--surface", "core", "--cursor", "7"]).operation, {
    method: "logs",
    params: { surface: "core", cursor: 7, limit: 100 },
  });
  assert.deepEqual(parseStudioDevArgs(["capture", "--profile", "p"], 42).operation, {
    method: "capture",
    params: { surface: "desktop", name: "capture-42" },
  });
  assert.throws(() => parseStudioDevArgs(["logs", "--profile", "p", "--limit", "9999"]));
  assert.throws(() => parseStudioDevArgs(["logs", "--profile", "p", "--surface", "keychain"]));
  assert.throws(() => parseStudioDevArgs(["capture", "--profile", "p", "--name", "../private"]));
});

test("the CLI prints the fixture list as JSON and reports errors as JSON with exit 1", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["scripts/studio-dev.ts", ...args], { encoding: "utf8" });
  const ok = run("fixtures");
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout).fixtures, [...FIXTURE_NAMES]);
  const bad = run("ui", "--profile", "p");
  assert.equal(bad.status, 1);
  assert.match(JSON.parse(bad.stderr).error, /--json is required/);
});

test("a fixture profile's build counts React commits for its checks; a live profile's does not", () => {
  assert.deepEqual(devBuildArgs("b-1", "fixture"), ["scripts/build.mjs", "--dev-build=b-1", "--commit-counts"]);
  assert.deepEqual(devBuildArgs("b-2", "live"), ["scripts/build.mjs", "--dev-build=b-2"]);
});
