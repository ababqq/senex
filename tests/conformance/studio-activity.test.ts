import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventEnvelope } from "../../src/substrate/types.ts";
import { ActivityIndex, feedsActivity, studioActivity } from "../../src/shared/studio-activity.ts";
import { toEntries } from "../../src/renderer/chat-entries.ts";
import { changeRecords } from "../../src/main/self-changes.ts";

const event = (n: number, data: EventEnvelope["data"]): EventEnvelope => ({
  id: String(n).padStart(5, "0"),
  thread_id: "studio",
  session_id: null,
  turn_id: null,
  created_at: new Date(1700000000000 + n * 1000).toISOString(),
  data,
});
const custom = (n: number, event_type: string, payload: Record<string, unknown>) =>
  event(n, { type: "custom", event_type, payload });

test("all runs survive a long notification tail, retain their briefs and remain independently expandable", () => {
  const brief = "Mushroom trees and a volcanic landscape. ".repeat(100);
  const log = [
    custom(1, "run_started", { runId: "a", project: "alpha", goal: brief }),
    custom(2, "run_finished", { runId: "a", project: "alpha", landed: false, stoppedBecause: "deadline" }),
    ...Array.from({ length: 650 }, (_, i) => custom(i + 3, "noise", {})),
    custom(655, "run_started", { runId: "b", project: "beta", goal: "A river village" }),
    custom(656, "run_finished", { runId: "b", project: "beta", landed: false }),
  ];
  const result = studioActivity(log);
  assert.deepEqual(
    result.map((item) => item.project),
    ["beta", "alpha"],
  );
  assert.equal(result[1]!.title, brief, "keep the full prompt in disclosed details");
  assert.deepEqual(
    result[1]!.runOutcome,
    { state: "finished", delivered: "none", verification: "incomplete" },
    "the run carries its outcome as fields, not a sentence",
  );
  assert.equal(result[1]!.status, undefined);
  assert.equal(result[1]!.attention, true);
  assert.equal(studioActivity(log.slice(-600)).length, 1, "a tail alone cannot represent this feed");
});

test("a later restore marks instruction changes undone without treating normal lost rounds as recovery", () => {
  const log = [
    event(1, { type: "snapshot_created", scope: "harness", snapshot_id: "pre", git: { harness: "a" } }),
    event(2, { type: "snapshot_created", scope: "harness", snapshot_id: "post", git: { harness: "b" } }),
    custom(3, "skillopt_accepted", {
      skill: "camera",
      snapshot_id: "pre",
      post_snapshot_id: "post",
      rationale: "Choose useful viewpoints",
    }),
    event(4, { type: "workspace_restored", scope: "game", snapshot_id: "round", reason: "challenger did not win" }),
    custom(5, "skillopt_pass", { tasks: 3, accepted: 1, staged: 1 }),
    event(6, {
      type: "workspace_restored",
      scope: "harness",
      snapshot_id: "pre",
      reason: "Harness stopped responding",
    }),
  ];
  const items = studioActivity(log);
  assert.equal(items.filter((item) => item.kind === "recovery").length, 1);
  assert.equal(items.find((item) => item.kind === "improvement")?.undone, true);
  assert.match(items.find((item) => item.kind === "learning")!.status!, /awaiting review/);
});

test("project chats say plainly what Harness learned; restarts become Work rows and errors stay visible", () => {
  const result = toEntries([
    custom(1, "skillopt_accepted", { skill: "facet-decomposition", rationale: "Keep ownership explicit" }),
    custom(2, "skillopt_pass", { tasks: 8, staged: 1 }),
    event(3, {
      type: "messages",
      messages: [{ role: "system", content: "You were restarted (watchdog_restore). Check your log." }],
    }),
    event(4, { type: "error", message: "Harness stopped responding" }),
    event(5, {
      type: "workspace_restored",
      scope: "harness",
      snapshot_id: "before",
      reason: "Recovered from the missed heartbeat",
    }),
    custom(6, "skillopt_pass", { tasks: 8, staged: 0, accepted: 0, rejected: 3 }),
    custom(7, "skillopt_accepted", { skill: "director", title: "Check the player’s view before finishing a scene" }),
  ]);
  assert.deepEqual(
    result.map((item) => item.kind),
    ["learning", "learning", "notice", "system", "notice", "learning"],
  );
  assert.equal(result[0]!.kind === "learning" && result[0].text, "Harness updated how it plans a build.");
  assert.deepEqual(result[1]!.kind === "learning" && [result[1].text, result[1].link], [
    "Harness learned 1 thing from this build.",
    "Review in Harness",
  ]);
  assert.equal(result[2]!.kind === "notice" && result[2].row.state, "stopped");
  assert.equal(
    result[5]!.kind === "learning" && result[5].text,
    "Harness learned to check the player’s view before finishing a scene.",
  );
  assert.ok(
    !result.some((item) => "text" in item && /facet-decomposition|past tasks reviewed|rejected/.test(item.text)),
    "no instruction-file names or review counts",
  );
});

test("Activity describes runs and instruction changes in plain words", () => {
  const items = studioActivity([
    custom(1, "run_started", { runId: "a", project: "alpha", goal: "A river village" }),
    custom(2, "run_finished", {
      runId: "a",
      project: "alpha",
      landed: true,
      executionStatus: "completed",
      summary: "The river now catches the light.",
    }),
    custom(3, "run_started", { runId: "b", project: "beta", goal: "A bridge" }),
    custom(4, "skillopt_accepted", {
      skill: "facet-decomposition",
      approvedBy: "human",
      title: "Check the player’s view",
      summary: ["Looks through the player’s eyes."],
    }),
    custom(5, "skillopt_accepted", {
      skill: "facet-decomposition",
      approvedBy: "auto",
      rationale: "The trajectories repeat three failure shapes",
    }),
    custom(6, "seed_upgraded", { added: [], updated: ["loop/main.ts"], kept: [], retired: [] }),
  ]);
  const run = (id: string) => items.find((item) => item.runId === id)!;
  assert.deepEqual([run("a").outcome, run("a").report], ["delivered", "The river now catches the light."]);
  assert.equal(run("b").outcome, "running");
  const changes = items.filter((item) => item.kind === "improvement");
  assert.deepEqual(
    changes.map((item) => [item.title, item.approvedBy]),
    [
      ["Changed how Harness plans a build", "auto"],
      ["Check the player’s view", "human"],
    ],
  );
  assert.deepEqual(changes[1]!.summary, ["Looks through the player’s eyes."]);
  assert.equal(
    items.find((item) => item.title.startsWith("App update"))?.kind,
    "upkeep",
    "app updates are upkeep, not learning",
  );
});

test("the events Activity keeps between reads project exactly what the whole log does", () => {
  const log = [
    event(1, { type: "snapshot_created", scope: "harness", snapshot_id: "pre", git: { harness: "a" } }),
    custom(2, "run_started", { runId: "a", project: "alpha", goal: "A river village" }),
    custom(3, "delegated.claude-code", { kind: "assistant", data: { text: "thinking" } }),
    custom(4, "facet_iteration", { runId: "a", facetId: "river", iteration: 1, winner: "challenger" }),
    event(5, { type: "messages", messages: [{ role: "user", content: "hello" }] }),
    event(6, { type: "snapshot_created", scope: "harness", snapshot_id: "post", git: { harness: "b" } }),
    custom(7, "skillopt_accepted", {
      skill: "facet-decomposition",
      title: "Keep ownership explicit",
      snapshot_id: "pre",
      post_snapshot_id: "post",
    }),
    custom(8, "run_finished", { runId: "a", project: "alpha", landed: true, executionStatus: "completed" }),
    custom(9, "self_change_undone", { snapshot_id: "pre", file: "skills/facet-decomposition.md" }),
    event(10, {
      type: "workspace_restored",
      scope: "harness",
      snapshot_id: "pre",
      reason: "Harness stopped responding",
    }),
    custom(11, "seed_upgraded", { added: [], updated: ["loop/main.ts"], kept: [], retired: [] }),
  ];
  const kept = log.filter(feedsActivity);
  assert.ok(kept.length < log.length, "chatter and messages are not kept");
  assert.deepEqual(studioActivity(kept), studioActivity(log));
  const change = studioActivity(log).find((item) => item.kind === "improvement")!;
  assert.deepEqual([change.undone, change.status], [true, "Undone"], "undone by the user, not by the later restore");
});

test("the move to TypeScript says which edits were replaced, and a return from an older app says what it stranded", () => {
  const items = studioActivity([
    custom(1, "harness_layout_migrated", { ok: true, replaced: ["tools/index.mjs"] }),
    custom(2, "harness_downgraded", { migrated: true, stranded: ["loop/turn-loop.mjs"] }),
    custom(3, "harness_downgraded", {}),
  ]);
  const moved = items.find((item) => item.title === "App update moved Studio’s code to TypeScript");
  assert.ok(moved?.attention && /Replaced with the shipped version.*tools\/index\.mjs/.test(moved.detail));
  const returns = items.filter((item) => /older version of the app/.test(item.title));
  assert.equal(returns.length, 2);
  assert.ok(returns.some((item) => item.attention && /TypeScript again\. .*loop\/turn-loop\.mjs/.test(item.detail)));
  assert.ok(
    returns.some((item) => item.detail === "Studio keeps running its current files."),
    "a payload with nothing in it still reads",
  );
  assert.ok(feedsActivity(custom(4, "harness_downgraded", {})));
});

test("Activity indexes noisy run events without retaining their payloads", () => {
  const log = [custom(1, "run_started", { runId: "run", project: "project", goal: "Build" })];
  const index = new ActivityIndex();
  assert.equal(index.append(log), true);
  for (let at = 2; at < 1002; at++) {
    const next = custom(at, "director_progress", {
      runId: "run",
      project: "project",
      head: `head-${at}`,
      noisy: "x".repeat(1000),
    });
    log.push(next);
    assert.equal(index.append([next]), true);
  }
  assert.deepEqual(index.items(), studioActivity(log));
  assert.equal(index.records().length, 1, "only the run start is retained for ownership checks");
  assert.equal(
    index.append([custom(1, "run_finished", { runId: "run", project: "project" })]),
    false,
    "older imports ask the caller to rebuild from durable history",
  );
});

test("the agent's own edits to its instructions, skills and tools are listed in Activity and can be undone (B7)", () => {
  const log = [
    event(1, { type: "snapshot_created", scope: "harness", snapshot_id: "p0", git: { harness: "a" } }),
    event(2, { type: "snapshot_created", scope: "harness", snapshot_id: "p1", git: { harness: "b" } }),
    custom(3, "self_edit", {
      file: "prompts/operating-rules.md",
      reason: "the README said to",
      snapshot_id: "p0",
      post_snapshot_id: "p1",
    }),
    custom(4, "skill_edited", { slug: "director", reason: "leads stall", snapshot_id: "p1", post_snapshot_id: "p2" }),
    custom(5, "tool_installed", { file: "tools/audio-tools.ts", reason: "sound", snapshot_id: "p2" }),
    custom(6, "self_edit", { file: "../outside.md", reason: "escape", snapshot_id: "p3" }),
    custom(7, "skill_edited", { slug: "../../x", reason: "escape", snapshot_id: "p4" }),
    event(8, { type: "workspace_restored", scope: "harness", snapshot_id: "p1", reason: "restore" }),
  ];
  assert.deepEqual(
    changeRecords(log).map((change) => [change.file, change.snapshotId, change.postSnapshotId]),
    [
      ["prompts/operating-rules.md", "p0", "p1"],
      ["skills/director.md", "p1", "p2"],
      ["tools/audio-tools.ts", "p2", undefined],
    ],
    "each self-change names the one file an undo may touch; a path out of the workspace is not a change",
  );
  const changes = studioActivity(log).filter((item) => item.kind === "improvement");
  assert.deepEqual(
    changes.map((item) => [item.title, item.detail, item.snapshotId, item.attention === true]),
    [
      ["Harness added a tool for itself: tools/audio-tools.ts", "sound", "p2", true],
      ["Harness rewrote how Harness leads a build", "leads stall", "p1", false],
      ["Harness edited its own file prompts/operating-rules.md", "the README said to", "p0", true],
    ],
    "a change undone since needs no attention",
  );
  const index = new ActivityIndex();
  assert.equal(index.append(log), true);
  assert.deepEqual(index.items(), studioActivity(log), "the incremental index keeps self-changes too");
});

test("an agent's own edit reads with the plain title and summary it wrote; an older record keeps its generated title", () => {
  const log = [
    custom(1, "skill_edited", {
      slug: "facet-decomposition",
      reason: "hud-score and referee both edited FACET WIRING",
      title: "Give the scoreboard one owner",
      summary: ["One part now owns the scoreboard."],
      snapshot_id: "p1",
    }),
    custom(2, "skill_edited", { slug: "director", reason: "leads stall", snapshot_id: "p2" }),
  ];
  assert.deepEqual(
    studioActivity(log)
      .filter((item) => item.kind === "improvement")
      .map((item) => [item.title, item.summary ?? null, item.detail]),
    [
      ["Harness rewrote how Harness leads a build", null, "leads stall"],
      [
        "Give the scoreboard one owner",
        ["One part now owns the scoreboard."],
        "hud-score and referee both edited FACET WIRING",
      ],
    ],
  );
});

test("Activity incremental rows preserve outcomes, milestones and restored improvement records", () => {
  const log = [
    custom(1, "run_started", { runId: "a", project: "alpha", goal: "first" }),
    custom(2, "facet_iteration", { runId: "a", facetId: "worker", iteration: 1, winner: "challenger" }),
    custom(3, "run_finished", {
      runId: "a",
      project: "alpha",
      landed: true,
      integrationHead: "new",
      baseCommit: "old",
    }),
    event(4, { type: "snapshot_created", scope: "harness", snapshot_id: "before", git: { harness: "a" } }),
    custom(5, "skillopt_accepted", { skill: "camera", snapshot_id: "before", rationale: "better" }),
    event(6, { type: "workspace_restored", scope: "harness", snapshot_id: "before", reason: "restore" }),
  ];
  const index = new ActivityIndex();
  for (let at = 0; at < log.length; at++) {
    assert.equal(index.append(log.slice(at, at + 1)), true);
    assert.deepEqual(index.items(), studioActivity(log.slice(0, at + 1)));
  }
});
