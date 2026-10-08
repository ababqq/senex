/**
 * Event-log benchmark: builds a synthetic store the size of a long-lived install and times the
 * reads the app does at launch, on every renderer poll and when the harness boots.
 *
 *   node scripts/bench/event-log.ts [--events 60000] [--threads 200] [--runs 3] [--keep]
 *
 * The store is written straight to disk in Exo's layout (one pretty JSON file per event, sizes
 * like real ones: user and assistant text, tool calls, run and queue records, snapshots), into a
 * temporary folder that is removed afterwards unless `--keep` is given. Every measurement opens a
 * fresh `EventStore`, standing in for a new process with a warm OS file cache. Nothing here is a
 * test: it prints milliseconds, and the numbers belong in the PR that changes them.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { RecoveryService } from "../../src/main/core/recovery.ts";
import { InboxProjection, inboxOf } from "../../src/main/core/inbox.ts";
import type { CoreInternals, StudioCore } from "../../src/main/studio-core.ts";
import { EventStore } from "../../src/substrate/event-store.ts";
import { createUuidv7Generator, uuid7Timestamp } from "../../src/substrate/ids.ts";
import type { EventData } from "../../src/substrate/types.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { EventKind, ThreadKind } from "../../src/shared/event-log.ts";

const { values } = parseArgs({
  options: {
    events: { type: "string", default: "60000" },
    threads: { type: "string", default: "200" },
    runs: { type: "string", default: "3" },
    keep: { type: "boolean", default: false },
  },
});
const TOTAL = Number(values.events);
const THREADS = Number(values.threads);
const RUNS = Number(values.runs);
/** The Studio conversation receives every event appended without a thread: a third of the log. */
const STUDIO_SHARE = 1 / 3;

const words = "the player jumps over a moving platform while the camera follows smoothly and the score updates".split(
  " ",
);
const prose = (n: number, seed: number) =>
  Array.from({ length: n }, (_, i) => words[(seed + i * 7) % words.length]).join(" ");

/** One turn's worth of events, cycling through the kinds a real conversation carries. */
function* conversation(count: number, studio: boolean): Generator<{ data: EventData; turn: string | null }> {
  let n = 0;
  let turn = 0;
  let run = 0;
  let queued = 0;
  while (n < count) {
    const turnId = `turn_${turn++}`;
    const messageId = `msg_${queued++}`;
    const batch: Array<{ data: EventData; turn: string | null }> = [
      { turn: null, data: { type: EventKind.Messages, messages: [{ role: "user", content: prose(40, n) }] } },
      {
        turn: null,
        data: {
          type: EventKind.Custom,
          event_type: CustomEvent.CoordinatorMessageQueued,
          payload: { messageId, action: { type: "user_message", text: prose(40, n) } },
        },
      },
      {
        turn: null,
        data: { type: EventKind.Custom, event_type: CustomEvent.CoordinatorMessageProcessing, payload: { messageId } },
      },
      { turn: turnId, data: { type: EventKind.TurnStarted } },
      {
        turn: turnId,
        data: {
          type: EventKind.ToolRequested,
          tool_call_id: `call_${n}`,
          request: { name: "read_file", arguments: { path: "src/project.js" } },
        },
      },
      {
        turn: turnId,
        data: { type: EventKind.ToolResult, tool_call_id: `call_${n}`, result: { ok: true, content: prose(120, n) } },
      },
      {
        turn: turnId,
        data: { type: EventKind.Messages, messages: [{ role: "assistant", content: prose(80, n + 3) }] },
      },
      { turn: turnId, data: { type: EventKind.TurnEnded, status: "ok" } },
      {
        turn: null,
        data: { type: EventKind.Custom, event_type: CustomEvent.CoordinatorMessageHandled, payload: { messageId } },
      },
    ];
    if (turn % 5 === 0) {
      const runId = `run_${run++}`;
      batch.push(
        {
          turn: null,
          data: {
            type: EventKind.Custom,
            event_type: CustomEvent.RunStarted,
            payload: { runId, project: "project", goal: prose(12, n), mode: "director" },
          },
        },
        {
          turn: null,
          data: {
            type: EventKind.Custom,
            event_type: CustomEvent.RunFinished,
            payload: { runId, project: "project", victory: true },
          },
        },
      );
    }
    if (studio && turn % 7 === 0) {
      batch.push({
        turn: null,
        data: {
          type: EventKind.SnapshotCreated,
          snapshot_id: `snap_${turn}`,
          scope: "harness",
          git: { harness: "a".repeat(40) },
          healthy: true,
          reason: "turn",
        },
      });
    }
    for (const event of batch) {
      if (n++ >= count) return;
      yield event;
    }
  }
}

async function buildStore(root: string): Promise<{ threads: string[] }> {
  const ids = createUuidv7Generator();
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const conversations = path.join(root, "agents", "studio", "conversations");
  const studioEvents = Math.round(TOTAL * STUDIO_SHARE);
  const perProject = Math.floor((TOTAL - studioEvents) / (THREADS - 1));
  const threads: string[] = [];
  for (let t = 0; t < THREADS; t++) {
    const threadId = ids((clock += 1000));
    threads.push(threadId);
    const events = path.join(conversations, threadId, "events");
    await mkdir(events, { recursive: true });
    const count = t === 0 ? studioEvents : perProject;
    const writes: Promise<void>[] = [];
    let head: string | null = null;
    const created = {
      data: { type: EventKind.ThreadCreated, title: t === 0 ? "Studio" : `Project ${t}` } as EventData,
      turn: null,
    };
    for (const { data, turn } of [created, ...conversation(count - 1, t === 0)]) {
      const id: string = ids((clock += 250));
      head = id;
      const envelope = {
        id,
        thread_id: threadId,
        session_id: "ses_bench",
        turn_id: turn,
        created_at: uuid7Timestamp(id),
        data,
      };
      writes.push(writeFile(path.join(events, `${id}.json`), JSON.stringify(envelope, null, 2)));
      if (writes.length >= 256) await Promise.all(writes.splice(0));
    }
    await Promise.all(writes);
    const metadata = t === 0 ? { kind: ThreadKind.Studio } : { kind: ThreadKind.Project, project: `project-${t}` };
    const now = new Date(clock).toISOString();
    await writeFile(
      path.join(conversations, threadId, "record.json"),
      JSON.stringify(
        {
          id: threadId,
          agent_id: "studio",
          created_at: now,
          updated_at: now,
          latest_event_id: head,
          title: t === 0 ? "Studio" : `Project ${t}`,
          metadata,
        },
        null,
        2,
      ),
    );
  }
  await writeFile(
    path.join(root, "agents", "studio", "record.json"),
    JSON.stringify({
      id: "studio",
      created_at: new Date(clock).toISOString(),
      updated_at: new Date(clock).toISOString(),
      metadata: {},
    }),
  );
  return { threads };
}

/** Median wall time of `RUNS` runs, each on a fresh store (a new process, warm OS cache). */
async function time(
  label: string,
  root: string,
  work: (store: EventStore) => Promise<unknown>,
  setup?: () => Promise<unknown>,
): Promise<void> {
  const samples: number[] = [];
  let note = "";
  for (let i = 0; i < RUNS; i++) {
    await setup?.();
    const store = await EventStore.open(root);
    const started = performance.now();
    const result = await work(store);
    samples.push(performance.now() - started);
    if (typeof result === "string") note = result;
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)]!;
  console.log(`${label.padEnd(58)} ${median.toFixed(0).padStart(7)} ms${note ? `  (${note})` : ""}`);
}

const root = await mkdtemp(path.join(tmpdir(), "studio-bench-events-"));
try {
  const built = performance.now();
  const { threads } = await buildStore(root);
  console.log(
    `synthetic store: ${TOTAL} events in ${THREADS} threads at ${root} (${((performance.now() - built) / 1000).toFixed(1)} s to write)`,
  );
  const studioThread = threads[0]!;
  const recovery = (store: EventStore) =>
    new RecoveryService(
      { store, mainThread: studioThread } as unknown as StudioCore,
      { indexEvent: () => {} } as unknown as CoreInternals,
    );

  // The first launch after an upgrade has no repair checkpoints yet; every later one has.
  const forgetCheckpoints = () =>
    Promise.all(
      threads.flatMap((id) =>
        ["repair-state.json", "snapshot-records.json"].map((name) =>
          rm(path.join(root, "agents", "studio", "conversations", id, name), { force: true }),
        ),
      ),
    );
  const launch = async (store: EventStore) => {
    const service = recovery(store);
    await service.rebuildSnapshotIndex();
    await service.closeInterruptedWork();
  };
  await time(
    "first launch: rebuildSnapshotIndex (init)",
    root,
    (store) => recovery(store).rebuildSnapshotIndex(),
    forgetCheckpoints,
  );
  await time(
    "first launch: closeInterruptedWork (start)",
    root,
    (store) => recovery(store).closeInterruptedWork(),
    forgetCheckpoints,
  );
  await time("first launch: both, one process", root, launch, forgetCheckpoints);
  await time("later launch: rebuildSnapshotIndex (init)", root, (store) => recovery(store).rebuildSnapshotIndex());
  await time("later launch: closeInterruptedWork (start)", root, (store) => recovery(store).closeInterruptedWork());
  await time("later launch: both, one process", root, launch);
  await time(
    "bootstrap: listAllSince(undefined, 600)",
    root,
    async (store) => `${(await store.listAllSince(undefined, 600)).events.length} events`,
  );
  await time("poll: listAllSince(cursor), nothing new, first call", root, async (store) => {
    const { cursor } = await store.listAllSince(undefined, 1);
    const started = performance.now();
    await store.listAllSince(cursor ?? undefined);
    return `${(performance.now() - started).toFixed(1)} ms after the head read`;
  });
  await time("poll: listAllSince(cursor) x10, nothing new", root, async (store) => {
    let { cursor } = await store.listAllSince(undefined, 1);
    const started = performance.now();
    for (let i = 0; i < 10; i++) cursor = (await store.listAllSince(cursor ?? undefined)).cursor;
    return `${((performance.now() - started) / 10).toFixed(1)} ms per poll once warm`;
  });
  await time("open a long chat: listEvents of the largest thread", root, async (store) => {
    const events = await store.listEvents(studioThread);
    return `${events.length} events`;
  });
  await time("harness boot restore: events.list of every thread", root, async (store) => {
    let bytes = 0;
    for (const thread of await store.listThreads()) bytes += JSON.stringify(await store.listEvents(thread.id)).length;
    return `${(bytes / 1e6).toFixed(1)} MB over stdio`;
  });
  await time("harness boot restore: events.inbox, nothing seeded", root, async (store) => {
    const pending = await new InboxProjection().pending(store);
    return `${(JSON.stringify(pending).length / 1e3).toFixed(1)} kB over stdio`;
  });
  await time("harness boot restore: events.inbox after the boot repair", root, async (store) => {
    await recovery(store).closeInterruptedWork();
    const started = performance.now();
    await inboxOf(store).pending(store);
    return `${(performance.now() - started).toFixed(1)} ms of it after the repair`;
  });
} finally {
  if (values.keep) console.log(`kept ${root}`);
  else await rm(root, { recursive: true, force: true });
}
