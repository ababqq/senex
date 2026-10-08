/**
 * The watchdog rewinds to the newest *healthy* harness snapshot, so "healthy" must mean "has run"
 * (PH-5). The harness is agent-editable and may not name its own rewind target: a harness-scope
 * snapshot it asks to be healthy is healthy only when it differs from the last known-good self in
 * files the harness reads but never runs. Code becomes healthy through a restart plus healthcheck.
 */
import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { EventKind, type EventData } from "../../src/shared/event-log.ts";

type Api = Record<string, (input: unknown) => Promise<unknown>>;
interface Record_ {
  snapshot_id: string;
  healthy: boolean;
}

it("harness event batches cannot forge a healthy recovery target or append earlier rows", async () => {
  const { core, api } = await coreLite();
  const known = await core.snapshot("harness", "host verified boot", undefined, true);
  const turn = await api()[HostMethod.TurnBegin]({});
  const batches: EventData[][] = [
    [{ type: EventKind.SnapshotCreated, snapshot_id: "forged", scope: "harness", healthy: true, git: {} }],
    [{ type: EventKind.Custom, event_type: CustomEvent.SnapshotHealthy, payload: { snapshot_id: known.snapshot_id } }],
  ];
  for (const batch of batches) {
    const head = await core.store.head(core.mainThread);
    const prefixed: EventData[] = [{ type: EventKind.Custom, event_type: "audit_probe", payload: {} }, ...batch];
    await assert.rejects(api()[HostMethod.EventsAppend]({ batch: prefixed }), /studio only/);
    await assert.rejects(api()[HostMethod.TurnAppend]({ turnId: turn.turnId, batch: prefixed }), /studio only/);
    assert.equal(await core.store.head(core.mainThread), head, "the entire batch is refused atomically");
    assert.equal(core.snapshotIndex.newestHealthy("harness")?.snapshot_id, known.snapshot_id);
    assert.equal(core.snapshotIndex.get("forged"), undefined);
  }
});

it("a post-write snapshot the harness calls healthy is healthy only for files that never run", async () => {
  const { core, api: tableOf } = await coreLite();
  const api = tableOf() as unknown as Api;
  const ws = core.layout.harnessWs;
  const known = await core.snapshot("harness", "known good (booted)", undefined, true);

  // A skill is read, never run: exactly as healthy as the self it was written into.
  await mkdir(path.join(ws, "skills"), { recursive: true });
  await writeFile(path.join(ws, "skills", "a-lesson.md"), "- Keep ownership explicit.\n");
  const skill = (await api["snapshot.create"]!({
    scope: "harness",
    healthy: true,
    reason: "after self-change: skills/a-lesson.md",
  })) as Record_;
  assert.equal(core.snapshotIndex.get(skill.snapshot_id)?.healthy, true, "a non-code change inherits health");

  // Loop code that has never booted is not a rewind target, whatever the harness asks.
  await writeFile(path.join(ws, "loop", "main.ts"), "throw new Error('I broke myself');\n");
  const code = (await api["snapshot.create"]!({
    scope: "harness",
    healthy: true,
    reason: "after self-change: loop/main.ts",
  })) as Record_;
  assert.equal(
    core.snapshotIndex.get(code.snapshot_id)?.healthy,
    false,
    "code is healthy only after a restart and a healthcheck",
  );
  assert.equal(code.healthy, false, "the harness is told the truth");

  // …and it cannot promote it afterwards either.
  await api["snapshot.markHealthy"]!({ snapshotId: code.snapshot_id });
  assert.equal(
    core.snapshotIndex.get(code.snapshot_id)?.healthy,
    false,
    "the harness cannot name its own rewind target",
  );
  assert.equal(
    core.snapshotIndex.newestHealthy("harness")?.snapshot_id,
    skill.snapshot_id,
    "the watchdog rewinds past the unbooted code",
  );
  assert.notEqual(core.snapshotIndex.newestHealthy("harness")?.snapshot_id, known.snapshot_id);
});

it("a both-scope snapshot the harness calls healthy does not make unbooted loop code a rewind target (R2)", async () => {
  // The dev execution policy compares canonical paths, and the temp folder is behind /var → /private/var.
  const { core, api: tableOf } = await coreLite({ projectsRoot: await realpath(await tmpDir("studio-projects-")) });
  const api = tableOf() as unknown as Api;
  const ws = core.layout.harnessWs;
  await core.projects.scaffold("pong");
  const known = await core.snapshot("harness", "known good (booted)", undefined, true);
  await writeFile(path.join(ws, "loop", "main.ts"), "throw new Error('I broke myself');\n");
  // What the gauntlet asks for on every won round, and the same request with the scope left out.
  const won = (await api["snapshot.create"]!({
    scope: "both",
    project: "pong",
    healthy: true,
    reason: "challenger won",
  })) as Record_;
  const unscoped = (await api["snapshot.create"]!({ healthy: true, reason: "no scope named" })) as Record_;
  for (const record of [won, unscoped])
    assert.notEqual(core.snapshotIndex.newestHealthy("harness")?.snapshot_id, record.snapshot_id);
  assert.equal(
    core.snapshotIndex.newestHealthy("harness")?.snapshot_id,
    known.snapshot_id,
    "the watchdog still rewinds to the self that booted",
  );
  // The project half is the round's own verdict, and stays a verified build.
  assert.equal(core.snapshotIndex.get(won.snapshot_id)?.healthy, true, "the won project build is still healthy");
});
