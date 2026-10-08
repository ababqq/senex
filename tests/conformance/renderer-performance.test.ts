import ceilings from "../fixtures/renderer-performance-ceilings.json" with { type: "json" };
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeChatEvents } from "../../src/shared/chat-history.ts";
import { EventKind, type EventEnvelope } from "../../src/shared/event-log.ts";
import { assetsFailed, assetsLoaded, projectsLoaded, initialLibrary } from "../../src/renderer/state/library.ts";
import { harnessDown, initialThreads, statusReported, threadsLoaded } from "../../src/renderer/state/threads.ts";
import { eventsArrived, initialEventLog, threadBackfilled } from "../../src/renderer/state/event-log.ts";
import { appendFeed } from "../../src/renderer/event-feed.ts";

const event = (id: string): EventEnvelope => ({
  id,
  thread_id: "lead",
  session_id: null,
  turn_id: null,
  created_at: "2026-09-28T00:00:00Z",
  data: { type: EventKind.Custom, event_type: "test", payload: {} },
});

describe("renderer performance behavior", () => {
  it("unchanged store refreshes preserve identity and still clear asset errors", () => {
    const inventory = { project: "project", assets: [], skipped: [], truncated: false };
    const library = assetsLoaded(initialLibrary(), "project", inventory);
    assert.equal(assetsLoaded(library, "project", structuredClone(inventory)), library);
    assert.equal(projectsLoaded(library, []), library);
    const failed = assetsFailed(library, "project", "read failed");
    assert.equal(assetsLoaded(failed, "project", inventory).assets.project?.error, null);
    const threads = statusReported(initialThreads(), {});
    assert.equal(threadsLoaded(threads, []), threads);
    assert.equal(statusReported(threads, {}), threads);
    assert.equal(harnessDown(threads), threads);
  });
  it("event order is independent of a Danish collator", () => {
    const ids = ["0199aaaa-0000", "0199ab00-0000", "0199a900-0000"];
    const original = String.prototype.localeCompare;
    const collator = new Intl.Collator("da");
    try {
      String.prototype.localeCompare = function (other: string) {
        return collator.compare(String(this), other);
      };
      assert.deepEqual(
        mergeChatEvents(ids.map(event)).map((item) => item.id),
        [...ids].sort(),
      );
    } finally {
      String.prototype.localeCompare = original;
    }
  });
  it("duplicate and out-of-order batches stay ordered without duplicate events", () => {
    const current = [event("01"), event("03")];
    assert.deepEqual(
      appendFeed(current, [event("02"), event("02")]).map((item) => item.id),
      ["01", "02", "03"],
    );
    const state = threadBackfilled(initialEventLog(), "lead", current);
    const next = eventsArrived(state, { events: [event("04"), event("04")], cursor: "04" });
    assert.deepEqual(
      next.byThread.lead?.map((item) => item.id),
      ["01", "03", "04"],
    );
  });
  it("a sorted append never inspects ids in retained thread history", () => {
    let reads = 0;
    const history = Array.from({ length: 20_000 }, (_, index) => event(String(index).padStart(8, "0")));
    const state = threadBackfilled(initialEventLog(), "lead", history);
    for (const item of state.byThread.lead ?? []) {
      const id = item.id;
      Object.defineProperty(item, "id", {
        get: () => {
          reads++;
          return id;
        },
      });
    }
    eventsArrived(state, { events: [event("00020000")], cursor: "00020000" });
    assert.ok(reads <= ceilings.retainedHistoryIdReadsPerAppend, `retained history id reads: ${reads}`);
  });
});

it("backfill viewers release complete logs and stale reads cannot repin after StrictMode cleanup", async () => {
  const { createEventLogStore } = await import("../../src/renderer/state/event-log.ts");
  const reads: Array<(events: EventEnvelope[]) => void> = [];
  const store = createEventLogStore({
    events: async () => ({ events: [], cursor: null }),
    threadEvents: () => new Promise((resolve) => reads.push(resolve)),
  });
  const first = store.watchThread("lead");
  first();
  const second = store.watchThread("lead");
  reads[0]?.([event("old")]);
  await Promise.resolve();
  assert.equal(store.getState().byThread.lead?.length ?? 0, 0);
  reads[1]?.(Array.from({ length: 5_000 }, (_, index) => event(String(index).padStart(8, "0"))));
  await Promise.resolve();
  assert.equal(store.getState().byThread.lead?.length, 5_000);
  second();
  assert.equal(store.getState().backfill.lead, undefined);
  assert.equal(store.getState().byThread.lead?.length, 4_000);
});

it("a thousand-step graph folds once when workers add no missing lifecycle", async () => {
  const { largeBuildGraph } = await import("../helpers/large-build-graph.ts");
  const { projectBuildGraph } = await import("../../src/renderer/build-progress.ts");
  const { buildRunGraph } = await import("../../src/renderer/run-graph.ts");
  const fixture = largeBuildGraph();
  let folds = 0;
  const fold: typeof buildRunGraph = (events) => {
    folds++;
    return buildRunGraph(events);
  };
  const graph = projectBuildGraph(fixture.events, "lead", fixture.threads, null, null, { fold });
  assert.equal(graph?.facets.length, 5);
  assert.equal(graph?.nodes.filter((node) => node.kind === "iteration").length, 1_000);
  assert.equal(folds, ceilings.foldsWithCompleteLifecycle);
  folds = 0;
  projectBuildGraph(fixture.events, "lead", fixture.threads, null, null, { fold, includeWorkers: false });
  assert.equal(folds, ceilings.foldsWithHiddenWorkers);
});

it("coordinator status is transient and never triggers event polling", async () => {
  const { uiEventReads } = await import("../../src/renderer/state/ui-event-routes.ts");
  const { UiEvent } = await import("../../src/shared/ui-events.ts");
  assert.equal(uiEventReads({ type: UiEvent.CoordinatorStatus, payload: {} }).events, false);
});
