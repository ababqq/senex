/**
 * Genex's Publish on the stage strip has two looks: the accent while the project has something to
 * publish, the quiet fill otherwise. Its status says which, and never writes a badge.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { publishButtonStatus } from "../../src/plugins/genex/backend.ts";
import {
  GenexHostedStatus,
  GenexPublishJobState,
  GenexPublishKind,
  GenexPublishPhase,
  type GenexPublishJob,
  type GenexPublishState,
} from "../../src/shared/genex.ts";

const state = (over: Partial<GenexPublishState> = {}): GenexPublishState => ({
  version: 1,
  project: "pong",
  connected: true,
  ...over,
});
const job = (jobState: GenexPublishJob["state"]): GenexPublishJob => ({
  id: "job",
  kind: GenexPublishKind.Gallery,
  state: jobState,
  phase: GenexPublishPhase.Uploading,
  startedAt: "2026-10-03T10:00:00Z",
});

test("a project that is not listed yet calls for Publish", () => {
  assert.equal(publishButtonStatus(state()).attention, true);
  assert.equal(publishButtonStatus(state({ slug: "pong", status: GenexHostedStatus.Draft })).attention, true);
});

test("a failed publish still calls for Publish", () => {
  assert.equal(publishButtonStatus(state({ job: job(GenexPublishJobState.Failed) })).attention, true);
});

test("a listed project, or one uploading, leaves Publish quiet", () => {
  assert.equal(publishButtonStatus(state({ slug: "pong", status: GenexHostedStatus.Published })).attention, false);
  assert.equal(publishButtonStatus(state({ job: job(GenexPublishJobState.Running) })).attention, false);
  assert.equal(publishButtonStatus(state({ job: job(GenexPublishJobState.Unresolved) })).attention, false);
});

test("Publish never carries a badge, only its tooltip", () => {
  const all = [
    state(),
    state({ slug: "pong", status: GenexHostedStatus.Draft }),
    state({ slug: "pong", status: GenexHostedStatus.Published }),
    state({ job: job(GenexPublishJobState.Running) }),
    state({ job: job(GenexPublishJobState.Failed) }),
  ];
  for (const each of all) {
    const status = publishButtonStatus(each);
    assert.equal(status.badge, undefined);
    assert.equal(status.tone, undefined);
    assert.equal(typeof status.title, "string");
  }
});
