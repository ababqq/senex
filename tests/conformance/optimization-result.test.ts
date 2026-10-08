/**
 * `normalizeOptimization`: the renderer's guard over a stage result the harness wrote. It refuses
 * a record it cannot read, and bounds what it keeps of one it can.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeOptimization, type OptimizationResultV1 } from "../../src/shared/optimization.ts";

const metric = { value: 12, unit: "ms", reason: null, provenance: "app observer" };

function sample(metrics = 1) {
  return {
    schemaVersion: 1,
    backend: "webgl",
    renderer: "three",
    version: "r170",
    scope: "world",
    configuration: {},
    inventory: {},
    metrics: Object.fromEntries(Array.from({ length: metrics }, (_, i) => [`m${i}`, metric])),
    intervals: { count: 30, elapsedMs: 500, minMs: 16, maxMs: 17 },
  };
}

function scenario(id: string, samples = 1) {
  return {
    id,
    workload: {},
    before: Array.from({ length: samples }, () => sample()),
    after: [sample()],
    comparison: { comparable: true, improved: true, reason: "faster", gains: ["frame time"] },
  };
}

function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: "run_a",
    project: "project",
    stageId: "optimization",
    attempt: 1,
    phase: "done",
    outcome: "improved",
    reasonCode: null,
    reason: null,
    summary: "Fewer draw calls.",
    baseline: null,
    candidate: null,
    retainedRevision: null,
    candidateAdopted: true,
    scenarios: [scenario("a")],
    preservation: { status: "preserved", reasons: [], evidenceRefs: [] },
    changedFiles: ["src/main.js"],
    reportPath: null,
    startedAt: null,
    finishedAt: null,
    sequence: 0,
    ...overrides,
  };
}

const read = (overrides: Record<string, unknown> = {}): OptimizationResultV1 | null =>
  normalizeOptimization(result(overrides));

describe("normalizeOptimization", () => {
  it("reads a well-formed result, with or without an outcome", () => {
    assert.equal(read()?.outcome, "improved");
    for (const outcome of ["no_improvement", "skipped", "failed", "interrupted", null])
      assert.equal(read({ outcome })?.outcome, outcome);
  });

  const refused: Array<[string, Record<string, unknown>]> = [
    ["a future schema", { schemaVersion: 2 }],
    ["another stage", { stageId: "verify" }],
    ["no run id", { runId: 7 }],
    ["no project", { project: undefined }],
    ["a fractional sequence", { sequence: 1.5 }],
    ["a negative sequence", { sequence: -1 }],
    ["no summary", { summary: null }],
    ["no phase", { phase: 3 }],
    ["an unknown outcome", { outcome: "exploded" }],
    ["a missing outcome", { outcome: undefined }],
  ];
  for (const [name, overrides] of refused)
    it(`refuses ${name}`, () => {
      assert.equal(read(overrides), null);
    });

  it("refuses what is not a record at all", () => {
    for (const value of [null, undefined, "result", 3]) assert.equal(normalizeOptimization(value), null);
  });

  it("keeps a bounded share of a large result", () => {
    const big = read({
      summary: "x".repeat(5000),
      changedFiles: [...Array.from({ length: 150 }, (_, i) => `f${i}.js`), 42],
      scenarios: [scenario("a", 20), scenario("b"), scenario("c")],
    });
    assert.ok(big);
    assert.equal(big.summary.length, 1200);
    assert.equal(big.changedFiles.length, 100);
    assert.deepEqual(
      big.scenarios.map((s) => s.id),
      ["a", "b"],
    );
    assert.equal(big.scenarios[0]?.before.length, 8);
    const many = read({ scenarios: [{ ...scenario("a"), before: [sample(30)] }] });
    assert.equal(Object.keys(many?.scenarios[0]?.before[0]?.metrics ?? {}).length, 12);
  });

  it("never reads a malformed number as a gain", () => {
    const bad = { value: -3, unit: 7, reason: 1, provenance: null };
    const kept = read({ scenarios: [{ ...scenario("a"), before: [{ ...sample(), metrics: { m: bad } }] }] });
    assert.deepEqual(kept?.scenarios[0]?.before[0]?.metrics.m, { value: null, unit: "", reason: null, provenance: "" });
  });

  it("fills a missing preservation and comparison as not run and not measured", () => {
    const bare = read({
      preservation: null,
      candidateAdopted: "yes",
      scenarios: [{ id: "a", before: [], after: [] }],
    });
    assert.deepEqual(bare?.preservation, { status: "not_run", reasons: [], evidenceRefs: [] });
    assert.equal(bare?.candidateAdopted, false);
    assert.deepEqual(bare?.scenarios[0]?.comparison, {
      comparable: false,
      improved: false,
      reason: "Not measured",
      gains: [],
    });
  });
});
