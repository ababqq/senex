/**
 * Plugin consent ledger — every way a question can be settled, and that each one settles it once.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PluginConsent } from "../../src/main/plugin-consent.ts";

const ask = (
  consent: PluginConsent,
  consentId: string,
  extra: { project?: string; threadId?: string; signal?: AbortSignal } = {},
) =>
  consent.request({
    consentId,
    pluginId: "genex",
    tool: "genex__publish",
    project: extra.project ?? "project",
    ...(extra.threadId ? { threadId: extra.threadId } : {}),
    ...(extra.signal ? { signal: extra.signal } : {}),
  });

test("the user's answer settles the question, either way", async () => {
  const consent = new PluginConsent({ timeoutMs: 10_000, now: () => 1_000 });
  const approved = ask(consent, "c1", { threadId: "t1" });
  const declined = ask(consent, "c2", { threadId: "t1" });
  assert.deepEqual(
    consent.pending().map((p) => [p.consentId, p.expiresAt]),
    [
      ["c1", 11_000],
      ["c2", 11_000],
    ],
  );
  assert.equal(consent.resolve("c1", true), true);
  assert.equal(consent.resolve("c2", false), true);
  assert.deepEqual(await approved, { approved: true, by: "user" });
  assert.deepEqual(await declined, { approved: false, by: "user" });
  assert.deepEqual(consent.pending(), []);
});

test("nobody answering declines on the user's behalf", async () => {
  const consent = new PluginConsent({ timeoutMs: 20 });
  assert.deepEqual(await ask(consent, "c1"), { approved: false, by: "timeout" });
  assert.equal(consent.resolve("c1", true), false, "a click after the timeout changes nothing");
});

test("a turn's end and a project's Stop withdraw only the questions in their scope", async () => {
  const consent = new PluginConsent({ timeoutMs: 10_000 });
  const inTurn = ask(consent, "c1", { project: "project", threadId: "t1" });
  const otherTurn = ask(consent, "c2", { project: "project", threadId: "t2" });
  const otherProject = ask(consent, "c3", { project: "other", threadId: "t3" });
  const unbound = ask(consent, "c4", { project: "project" });
  assert.equal(consent.cancel({ threadId: "t1" }, "turn"), 1);
  assert.deepEqual(await inTurn, { approved: false, by: "turn" });
  assert.deepEqual(
    consent.pending().map((p) => p.consentId),
    ["c2", "c3", "c4"],
  );
  assert.equal(consent.cancel({ project: "project" }, "stop"), 2);
  assert.deepEqual(await otherTurn, { approved: false, by: "stop" });
  assert.deepEqual(await unbound, { approved: false, by: "stop" });
  assert.deepEqual(
    consent.pending().map((p) => p.consentId),
    ["c3"],
  );
  assert.equal(consent.cancel({}, "stop"), 1, "an empty scope is the shutdown path: everything goes");
  assert.deepEqual(await otherProject, { approved: false, by: "stop" });
  assert.equal(consent.cancel({}, "stop"), 0);
});

test("an unknown or already settled id resolves to false; a repeat answer is idempotent", async () => {
  const consent = new PluginConsent({ timeoutMs: 10_000 });
  assert.equal(consent.resolve("nope", true), false);
  const answer = ask(consent, "c1");
  assert.equal(consent.resolve("c1", false), true);
  assert.equal(consent.resolve("c1", true), false);
  assert.deepEqual(await answer, { approved: false, by: "user" });
  await assert.rejects(Promise.all([ask(consent, "dup"), ask(consent, "dup")]), /already pending/);
});

test("the turn's abort signal withdraws its question as a stop", async () => {
  const consent = new PluginConsent({ timeoutMs: 10_000 });
  const controller = new AbortController();
  const answer = ask(consent, "c1", { signal: controller.signal });
  controller.abort();
  assert.deepEqual(await answer, { approved: false, by: "stop" });
  assert.equal(consent.resolve("c1", true), false);
  const already = new AbortController();
  already.abort();
  assert.deepEqual(await ask(consent, "c2", { signal: already.signal }), { approved: false, by: "stop" });
  assert.deepEqual(consent.pending(), []);
});
