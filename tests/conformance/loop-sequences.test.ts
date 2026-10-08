/**
 * The substrate calls a harness loop makes, in order, recorded through a fake `ctx`: which
 * snapshot, restore and worktree calls a spike makes when its build fails, crashes or is stopped.
 * Characterization for the loop refactors; a change that means to alter a sequence names it.
 *
 * Covered here: `runSpike`'s reject, crash, stop and refusal paths in live and worktree mode,
 * and what a live-mode rollback does when the attempt cannot be kept or the restore is refused.
 * Not yet: a passing spike (it needs a full evidence pass) and the autopilot, gauntlet and
 * facet-loop sequences, which still rely on the rig suites (L3).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runSpike } from "../../src/harness-seed/loop/spike.ts";
import { spikeRef } from "../../src/harness-seed/loop/repo.ts";
import { ctxRecorder, type CtxHandler } from "../helpers/ctx-recorder.ts";
import { runDelegatedTurn } from "../../src/harness-seed/loop/delegated-turn.ts";
import { handleRunStart } from "../../src/harness-seed/loop/run-dispatch.ts";

const run = { runId: "run_a", project: "pong", engine: "claude-code" };
const check = { id: "jump-arc", kind: "vision", camera: "default" };
const spec = { id: "feel", title: "Project feel", intent: "The jump reads as weighty.", checks: [check] };
const SNAPSHOTS = (method: string) => method.startsWith("snapshot.");

function spikeCtx(delegate: CtxHandler) {
  return ctxRecorder({
    handlers: {
      "engine.describe": () => [{ id: "claude-code", kind: "delegated" }],
      "engine.delegate": delegate,
      "events.append": () => true,
      "run.exec": () => ({ code: 0, stdout: "", stderr: "" }),
    },
  });
}
const spike = (recorder: ReturnType<typeof spikeCtx>, extra: Record<string, unknown> = {}) =>
  runSpike(recorder.ctx, {
    run,
    spec,
    check,
    iteration: 3,
    facetThreadId: "facet-thread",
    deadline: Date.now() + 60 * 60_000,
    ...extra,
  } as never);
const phases = (recorder: ReturnType<typeof spikeCtx>) =>
  recorder.paramsOf("events.append").map((p) => (p.batch as Array<{ payload: { phase: string } }>)[0]!.payload.phase);

describe("a spike on the live folder", () => {
  // Flipped (GDS-2): the restore used to follow the build straight away, erasing whatever the
  // folder gained during the spike window. The attempt is now snapshotted first.
  it("snapshots before it builds, snapshots the attempt, then restores the first snapshot when the build fails", async () => {
    const recorder = spikeCtx(() => ({ ok: false, errorText: "the page never loaded", summary: "" }));
    const outcome = await spike(recorder);
    assert.deepEqual(recorder.sequence(), [
      "engine.describe",
      "snapshot.create",
      "events.append",
      "engine.delegate",
      "snapshot.create",
      "snapshot.restore",
      "events.append",
    ]);
    assert.deepEqual(recorder.paramsOf("snapshot.create"), [
      { scope: "game", reason: "run run_a spike jump-arc: before", project: "pong", healthy: false },
      { scope: "game", reason: "run run_a spike jump-arc: attempt", project: "pong", healthy: false },
    ]);
    assert.deepEqual(recorder.paramsOf("snapshot.restore"), [
      { snapshotId: "snap-1", project: "pong", scope: "game", reason: "run run_a spike jump-arc: did not pass" },
    ]);
    assert.deepEqual(phases(recorder), ["opened", "closed"]);
    const closed = (recorder.paramsOf("events.append")[1]!.batch as Array<{ payload: Record<string, unknown> }>)[0]!
      .payload;
    assert.equal(closed.attemptSnapshot, "snap-2", "the closing event names where the attempt was kept");
    assert.equal(closed.rolledBack, true);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, "the page never loaded");
    assert.equal(outcome.branch, null);
    assert.deepEqual(
      recorder.notifications.map((n) => n.type),
      ["autopilot.spike"],
    );
  });

  // Flipped (GDS-2), as above.
  it("snapshots the attempt and restores the same way when the engine crashes mid-build", async () => {
    const recorder = spikeCtx(() => {
      throw new Error("engine crashed");
    });
    const outcome = await spike(recorder);
    assert.deepEqual(recorder.sequence(SNAPSHOTS), ["snapshot.create", "snapshot.create", "snapshot.restore"]);
    assert.equal(outcome.reason, "engine crashed");
    assert.deepEqual(phases(recorder), ["opened", "closed"]);
  });

  it("leaves the folder as it is when the attempt cannot be saved, and says so", async () => {
    const recorder = spikeCtx(() => ({ ok: false, errorText: "the page never loaded", summary: "" }));
    let creates = 0;
    recorder.handle("snapshot.create", (p) => {
      if (++creates === 2) throw new Error("index.lock: the user's git client holds the index");
      return {
        snapshot_id: "snap-before",
        scope: "game",
        git: {},
        created_at: new Date(0).toISOString(),
        reason: String(p.reason),
        healthy: false,
      };
    });
    await spike(recorder);
    assert.deepEqual(
      recorder.sequence(SNAPSHOTS),
      ["snapshot.create", "snapshot.create"],
      "no restore without the attempt kept",
    );
    const closed = (recorder.paramsOf("events.append")[1]!.batch as Array<{ payload: Record<string, unknown> }>)[0]!
      .payload;
    assert.equal(closed.attemptSnapshot, null);
    assert.equal(closed.rolledBack, false);
  });

  it("reports a restore the studio refused instead of hiding it", async () => {
    const recorder = spikeCtx(() => ({ ok: false, errorText: "the page never loaded", summary: "" }));
    recorder.handle("snapshot.restore", () => {
      throw Object.assign(new Error("the folder is on refs/heads/feature"), { code: "branch-changed" });
    });
    await spike(recorder);
    assert.deepEqual(recorder.sequence(SNAPSHOTS), ["snapshot.create", "snapshot.create", "snapshot.restore"]);
    const closed = (recorder.paramsOf("events.append")[1]!.batch as Array<{ payload: Record<string, unknown> }>)[0]!
      .payload;
    assert.equal(closed.rolledBack, false);
    assert.equal(closed.attemptSnapshot, "snap-2");
  });

  it("returns at once when the user stops it: no restore and no closing event (today's behaviour)", async () => {
    const recorder = spikeCtx((_params, r) => {
      r.cancel();
      throw Object.assign(new Error("aborted"), { kind: "aborted" });
    });
    const outcome = await spike(recorder);
    assert.deepEqual(recorder.sequence(), ["engine.describe", "snapshot.create", "events.append", "engine.delegate"]);
    assert.equal(outcome.reason, "stopped by the user");
    assert.deepEqual(phases(recorder), ["opened"]);
    assert.deepEqual(recorder.notifications, []);
  });
});

describe("a spike in its own worktree", () => {
  it("builds at the incumbent commit, keeps a failed attempt on a ref, and never snapshots or restores the live folder", async () => {
    const recorder = spikeCtx(() => ({ ok: false, stopReason: "budget", summary: "" }));
    const outcome = await spike(recorder, { worktree: true, incumbentCommit: "abc123" });
    assert.deepEqual(recorder.sequence(), [
      "engine.describe",
      "snapshot.worktree",
      "events.append",
      "engine.delegate",
      "run.exec",
      "run.exec",
      "run.exec",
      "events.append",
    ]);
    assert.deepEqual(recorder.paramsOf("snapshot.worktree"), [
      { project: "pong", commit: "abc123", name: "spike-feel-jump-arc", runId: "run_a" },
    ]);
    const worktree = "/fake/workspaces/harness/scratch/autopilot/run_a/spike-feel-jump-arc";
    const [delegated] = recorder.paramsOf("engine.delegate");
    assert.equal(delegated!.cwd, worktree, "the builder works in the worktree, not the live folder");
    const commands = recorder.paramsOf("run.exec").map((p) => p.command as string);
    assert.equal(commands[0], "git add -A");
    // Flipped (HQ-1): the message was double-quoted, where a backtick in the reason still ran.
    assert.match(commands[1]!, /commit -q --allow-empty -m 'spike feel\/jump-arc: did not pass — budget'$/);
    assert.equal(commands[2], `git update-ref ${spikeRef("run_a", "feel", "jump-arc")} HEAD`);
    for (const p of recorder.paramsOf("run.exec")) assert.equal(p.cwd, worktree);
    assert.equal(outcome.worktree, worktree);
    assert.equal(outcome.branch, spikeRef("run_a", "feel", "jump-arc"));
    assert.equal(outcome.ok, false);
  });

  it("opens nothing for a project whose output folder it cannot name", async () => {
    const recorder = spikeCtx(() => assert.fail("no build for a refused spike"));
    const outcome = await spike(recorder, {
      worktree: true,
      incumbentCommit: "abc123",
      ownShape: true,
      shape: { build: "npm run build" },
    });
    assert.deepEqual(recorder.sequence(), ["engine.describe"]);
    assert.match(outcome.reason, /^no spike: this project builds into an output folder/);
  });
});

describe("a chat turn and Stop", () => {
  /** A delegated chat turn in project `g`, answered by a builder that reports it did the work. */
  function chatTurn() {
    return ctxRecorder({
      unknown: { value: null },
      handlers: {
        "events.messages": () => [{ role: "user", content: "make the sky pink" }],
        "project.list": () => [{ name: "g", title: "G" }],
        "engine.describe": () => [],
        "engine.delegate": () => ({ ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "s", summary: "done" }),
      },
    });
  }
  const options = {
    threadId: "thread-1",
    turnId: "turn-1",
    text: "make the sky pink",
    engine: "codex",
    engineLabel: "Codex",
    project: "g",
  };

  it("a Stop while the turn prepares hands nothing to the builder, and the turn ends stopped", async () => {
    const recorder = chatTurn();
    // Stamping the folder is the last step before the builder starts: nothing is running to abort yet.
    recorder.cancelAfter("project.contentStamp");
    const outcome = await runDelegatedTurn(recorder.ctx as never, options);
    assert.deepEqual(recorder.sequence("engine.delegate"), [], "no builder starts after the Stop");
    assert.equal(outcome.stopped, "aborted");
    assert.deepEqual(recorder.sequence("preview."), [], "no health pass after a Stop");
  });

  it("without a Stop the same turn hands the ask to the builder", async () => {
    const recorder = chatTurn();
    await runDelegatedTurn(recorder.ctx as never, options);
    assert.deepEqual(recorder.sequence("engine.delegate"), ["engine.delegate"]);
  });
});

describe("Stop and the build a chat turn launched", () => {
  /** The loop's state as main.ts keeps it, with a host that records what the chat is told. */
  function studioWithStop() {
    const told: string[] = [];
    const recorded: string[] = [];
    type Appended = { event_type?: string; messages?: Array<{ content?: string }> };
    const host = {
      call: async (method: string, params: { batch?: Appended[] }) => {
        if (method === "project.list") return [{ name: "g", title: "G" }];
        if (method !== "events.append") return null;
        for (const item of params.batch ?? []) {
          if (item.event_type) recorded.push(item.event_type);
          for (const m of item.messages ?? []) told.push(String(m.content));
        }
        return null;
      },
      notify: () => {},
    };
    // The user pressed Stop after the turn that launched this build had ended, before it started.
    const studio = {
      host,
      cancels: new Set(["thread-1"]),
      moodBoards: new Map(),
      activeRuns: new Map(),
      startingRuns: new Map(),
      orphanRuns: new Map(),
      scoped: () => ({ cancelled: true }),
    };
    return { studio, told, recorded };
  }
  const start = { type: "run_start", threadId: "thread-1", run: { runId: "r1", project: "g", goal: "a dusk plaza" } };

  it("a Stop since the message that launched it keeps the build from starting, and the chat is told", async () => {
    const { studio, told, recorded } = studioWithStop();
    await handleRunStart(studio as never, start as never, { keepStop: true });
    assert.ok(studio.cancels.has("thread-1"), "the Stop is kept");
    assert.ok(!recorded.includes("run_registered"), "no run is registered");
    assert.equal(studio.startingRuns.size, 0);
    assert.ok(
      told.some((words) => /stopped before/i.test(words)),
      JSON.stringify(told),
    );
  });
});
