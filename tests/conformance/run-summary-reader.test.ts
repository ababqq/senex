import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunSummaryReader } from "../../src/main/run-summary-reader.ts";
import { EventStore } from "../../src/substrate/event-store.ts";
test("summary reader caches full histories, reads appended tails, and includes earlier project chats", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "summary-reader-"));
  try {
    const store = await EventStore.open(root);
    const studio = await store.createThread({ title: "Studio" });
    const first = await store.createThread({
      title: "Earlier",
      metadata: { project: "project" },
    });
    const second = await store.createThread({
      title: "Later",
      metadata: { project: "project" },
    });
    const other = await store.createThread({
      title: "Other",
      metadata: { project: "another" },
    });
    await store.appendEvents(first, [{ type: "custom", event_type: "run_started", payload: { runId: "r" } }]);
    await store.appendEvents(other, [{ type: "custom", event_type: "foreign", payload: {} }]);
    let reads = 0;
    const list = store.listEvents.bind(store);
    store.listEvents = async (...args) => {
      reads++;
      return list(...args);
    };
    const reader = new RunSummaryReader(store);
    const before = await reader.forProject("project", studio);
    const count = reads;
    assert.ok(before.some((e) => e.thread_id === first));
    assert.ok(before.some((e) => e.thread_id === second));
    assert.ok(!before.some((e) => e.thread_id === other));
    assert.equal(
      await reader.forProject("project", studio),
      before,
      "unchanged heads reuse the merged project history",
    );
    assert.equal(reads, count);
    await store.appendEvents(first, [{ type: "custom", event_type: "run_finished", payload: { runId: "r" } }]);
    const [one, two] = await Promise.all([reader.forProject("project", studio), reader.forProject("project", studio)]);
    assert.equal(one.length, before.length + 1);
    assert.deepEqual(one, two);
    assert.equal(reads, count + 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("summary reader keeps only the most recently opened projects' histories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "summary-reader-"));
  try {
    const store = await EventStore.open(root);
    const studio = await store.createThread({ title: "Studio" });
    const first = await store.createThread({ title: "First", metadata: { project: "first" } });
    const second = await store.createThread({ title: "Second", metadata: { project: "second" } });
    const fullReads = new Map<string, number>();
    const list = store.listEvents.bind(store);
    store.listEvents = async (threadId, options) => {
      if (!options?.after) fullReads.set(threadId, (fullReads.get(threadId) ?? 0) + 1);
      return list(threadId, options);
    };
    const reader = new RunSummaryReader(store, { projects: 1 });
    await reader.forProject("first", studio);
    await reader.forProject("second", studio);
    await reader.forProject("second", studio);
    assert.equal(fullReads.get(second), 1, "the open project stays cached");
    assert.equal(fullReads.get(studio), 1, "the Studio conversation every project shares stays cached");
    await reader.forProject("first", studio);
    assert.equal(fullReads.get(first), 2, "a project pushed out by a newer one is read again");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
