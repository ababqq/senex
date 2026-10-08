import { readFile, mkdtemp, mkdir, writeFile, rm, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { buildRunGraph } from "../../src/renderer/run-graph.ts";
import { CustomEvent, DELEGATED_PREFIX } from "../../src/shared/custom-events.ts";
import { EventKind } from "../../src/shared/event-log.ts";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { RunSummaryCache } from "../../src/main/run-summary-cache.ts";
import { summarizeRun } from "../../src/shared/run-summary.ts";
import type { EventEnvelope } from "../../src/substrate/types.ts";

test("summary folds once per history/evidence version and refreshes independent evidence", async () => {
  let folds = 0;
  let version = "one";
  const cache = new RunSummaryCache({
    fold: (...args) => {
      folds++;
      return summarizeRun(...args);
    },
    version: async () => version,
    supplement: async () => {},
  });
  const events: EventEnvelope[] = [];
  const first = await cache.read(events, "project", "run", "/runs");
  assert.equal(await cache.read(events, "project", "run", "/runs"), first);
  assert.equal(folds, 1);
  version = "two";
  const changed = await cache.read(events, "project", "run", "/runs");
  assert.notEqual(changed.revision, first.revision);
  assert.equal(folds, 2);
  await cache.read([...events], "project", "run", "/runs");
  assert.equal(folds, 3);
});

test("concurrent identical summary requests share one fold and supplement", async () => {
  let folds = 0;
  let supplements = 0;
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cache = new RunSummaryCache({
    fold: (...args) => {
      folds++;
      return summarizeRun(...args);
    },
    version: async () => "one",
    supplement: async () => {
      supplements++;
      await held;
    },
  });
  const events: EventEnvelope[] = [];
  const reads = Array.from({ length: 20 }, () => cache.read(events, "project", "run", "/runs"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  release?.();
  const results = await Promise.all(reads);
  assert.equal(folds, 1);
  assert.equal(supplements, 1);
  assert.ok(results.every((result) => result === results[0]));
});

test("a separate evidence root never reuses another root's summary", async () => {
  const cache = new RunSummaryCache({ version: async () => "", supplement: async () => {} });
  const events: EventEnvelope[] = [];
  const first = await cache.read(events, "project", "run", "/one");
  const second = await cache.read(events, "project", "run", "/two");
  assert.notEqual(first, second);
  assert.equal(second.runDirectory, path.join("/two", "run"));
});

test("graph transport drops trace payloads without changing graph ordering or timestamps", async () => {
  const recorded: EventEnvelope[] = JSON.parse(
    await readFile(new URL("../fixtures/village-outcome.json", import.meta.url), "utf8"),
  );
  const events = recorded.flatMap((event, index) => [
    event,
    {
      ...event,
      id: `noise-${index}`,
      created_at: "2099-01-01T00:00:00Z",
      data: {
        type: EventKind.Custom,
        event_type:
          [CustomEvent.SessionActivity, CustomEvent.ContextUsage, `${DELEGATED_PREFIX}test`][index % 3] ??
          CustomEvent.SessionActivity,
        payload: { project: "fixture-village", runId: "run_village", text: "x".repeat(1000) },
      },
    } satisfies EventEnvelope,
  ]);
  const cache = new RunSummaryCache({ version: async () => "", supplement: async () => {} });
  const result = await cache.read(events, "fixture-village", "run_village", "/runs");
  assert.ok((result.graphEvents?.length ?? Infinity) <= recorded.length);
  assert.deepEqual(buildRunGraph(result.graphEvents ?? []), buildRunGraph(events));
});

test("unchanged events refresh when an outside-director capture is created, changed or removed", async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "summary-evidence-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = path.join(root, "run");
  const start = path.join(run, "iter_000", "screenshots", "default.jpg");
  await mkdir(path.join(run, "director", "start"), { recursive: true });
  await mkdir(path.dirname(start), { recursive: true });
  await writeFile(
    path.join(run, "director", "start", "verdict.json"),
    JSON.stringify({ commit: "base", shots: [{ path: start }] }),
  );
  const cache = new RunSummaryCache();
  const events: EventEnvelope[] = [];
  const absent = await cache.read(events, "project", "run", root);
  assert.equal(absent.captures?.base, undefined);
  await writeFile(start, "first image");
  const created = await cache.read(events, "project", "run", root);
  assert.equal(created.captures?.base, start);
  assert.notEqual(created.revision, absent.revision);
  assert.equal(await cache.read(events, "project", "run", root), created);
  await writeFile(start, "a different image");
  const changed = await cache.read(events, "project", "run", root);
  assert.notEqual(changed.revision, created.revision);
  await rm(start);
  assert.equal((await cache.read(events, "project", "run", root)).captures?.base, undefined);
});

test("evidence scans do not traverse escaping directory links or cycle through internal links", async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "summary-boundary-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runs = path.join(root, "runs");
  const run = path.join(runs, "run");
  const outside = path.join(root, "runs-other");
  await mkdir(run, { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.json"), "private");
  await symlink(outside, path.join(run, "escape"), "junction");
  await symlink(run, path.join(run, "cycle"), "junction");
  const original = fs.readdir;
  const reads: string[] = [];
  fs.readdir = ((...args: Parameters<typeof fs.readdir>) => {
    reads.push(String(args[0]));
    return Reflect.apply(original, fs, args);
  }) as typeof fs.readdir;
  syncBuiltinESMExports();
  t.after(() => {
    fs.readdir = original;
    syncBuiltinESMExports();
  });
  const cache = new RunSummaryCache();
  const events: EventEnvelope[] = [];
  const first = await cache.read(events, "project", "run", runs);
  await writeFile(path.join(outside, "secret.json"), "changed private");
  assert.equal(await cache.read(events, "project", "run", runs), first);
  assert.ok(
    reads.every((file) => file === run),
    JSON.stringify(reads),
  );
  assert.equal(await readFile(path.join(outside, "secret.json"), "utf8"), "changed private");
});

test("a rejected supplement can retry and does not poison the pending cache", async () => {
  let attempts = 0;
  const cache = new RunSummaryCache({
    version: async () => "one",
    supplement: async () => {
      if (++attempts === 1) throw new Error("temporary read failure");
    },
  });
  const events: EventEnvelope[] = [];
  await assert.rejects(cache.read(events, "project", "run", "/runs"), /temporary/);
  await cache.read(events, "project", "run", "/runs");
  assert.equal(attempts, 2);
});

test("summary cache bounds retained runs and keeps recently read entries", async () => {
  const cache = new RunSummaryCache({ version: async () => "one", supplement: async () => {} });
  const events: EventEnvelope[] = [];
  const first = await cache.read(events, "project", "run0", "/runs");
  const second = await cache.read(events, "project", "run1", "/runs");
  for (let i = 2; i < 32; i++) await cache.read(events, "project", `run${i}`, "/runs");
  assert.equal(await cache.read(events, "project", "run0", "/runs"), first);
  await cache.read(events, "project", "run32", "/runs");
  assert.equal(await cache.read(events, "project", "run0", "/runs"), first);
  assert.notEqual(await cache.read(events, "project", "run1", "/runs"), second);
});
