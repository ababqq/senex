import { shareSnapshot } from "../../src/renderer/state/snapshot-equality.ts";
import assert from "node:assert/strict";
import { it } from "node:test";
import { largeBuildGraph } from "../helpers/large-build-graph.ts";
import { GraphNodeKind, buildRunGraph } from "../../src/renderer/run-graph.ts";
import { partRows, layoutSteps } from "../../src/renderer/run-steps.ts";
import { sameGateButton, sameStepNode, type StepNodeProps } from "../../src/renderer/panels/run-graph/step-props.ts";

it("a thousand rebuilt step snapshots avoid all unchanged node renders", () => {
  const fixture = largeBuildGraph();
  const graph = buildRunGraph(fixture.events);
  assert.ok(graph);
  const rows = partRows(graph);
  const layout = layoutSteps(rows);
  const onSelect = () => {};
  const props: StepNodeProps[] = rows
    .flatMap((row) => row.steps)
    .map((step) => ({
      project: "fixture-project",
      runId: graph.runId,
      active: graph.active,
      step,
      rect: layout.rects[step.id],
      ghost: layout.ghosts.has(step.id),
      selected: false,
      onSelect,
    }));
  assert.equal(props.length, 1_000);
  assert.equal(
    props.filter(
      (old) => !sameStepNode(old, { ...old, step: structuredClone(old.step), rect: structuredClone(old.rect) }),
    ).length,
    0,
  );
  const first = props[0];
  assert.ok(first);
  for (const changed of [
    { ...first, selected: true },
    { ...first, active: !first.active },
    { ...first, runId: "another-run" },
    { ...first, project: "another-project" },
    { ...first, ghost: !first.ghost },
    { ...first, onSelect: () => {} },
    { ...first, step: { ...first.step, name: "changed" } },
    { ...first, rect: first.rect ? { ...first.rect, x: first.rect.x + 1 } : { x: 0, y: 0, w: 1, h: 1 } },
  ])
    assert.equal(sameStepNode(first, changed), false);
});

it("a thousand cloned gates retain their buttons without losing new notes or actions", () => {
  const graph = buildRunGraph(largeBuildGraph().events);
  assert.ok(graph);
  const gates = layoutSteps(partRows(graph)).gates;
  assert.ok(gates.length >= 1_000);
  const onOpen = () => {};
  const onTip = () => {};
  for (const gate of gates) {
    const before = { gate, notesId: null, onOpen, onTip };
    assert.equal(sameGateButton(before, { ...before, gate: structuredClone(gate) }), true);
    assert.equal(sameGateButton(before, { ...before, notesId: "new-note" }), false);
    assert.equal(sameGateButton(before, { ...before, onOpen: () => {} }), false);
    assert.equal(sameGateButton(before, { ...before, gate: { ...gate, x: gate.x + 1 } }), false);
  }
});

it("appending a round retains every unchanged graph and layout branch", () => {
  const graph = buildRunGraph(largeBuildGraph().events);
  assert.ok(graph);
  const next = structuredClone(graph);
  const last = next.nodes.find((node) => node.kind === GraphNodeKind.Iteration);
  assert.ok(last);
  next.nodes.push({ ...last, id: "appended" });
  const shared = shareSnapshot(graph, next);
  assert.notEqual(shared, graph);
  assert.deepEqual(shared, next);
  assert.equal(shared.facets, graph.facets);
  assert.equal(shared.nodes.filter((node, index) => node === graph.nodes[index]).length, graph.nodes.length);
  const layout = layoutSteps(partRows(graph));
  const moved = structuredClone(layout);
  const rect = Object.values(moved.rects)[0];
  assert.ok(rect);
  rect.x++;
  const sharedLayout = shareSnapshot(layout, moved);
  assert.notEqual(sharedLayout.rects, layout.rects);
  assert.equal(sharedLayout.edges, layout.edges);
});

it("snapshot sharing preserves deletions, undefined keys and opaque collections", () => {
  assert.deepEqual(shareSnapshot({ a: 1, b: 2 }, { a: 1 }), { a: 1 });
  const empty = {};
  assert.notEqual(shareSnapshot(empty, { missing: undefined }), empty);
  const set = new Set([2]);
  assert.equal(shareSnapshot(new Set([1]), set), set);
  const map = new Map([["a", 2]]);
  assert.equal(shareSnapshot(new Map([["a", 1]]), map), map);
  assert.equal(shareSnapshot([1, 2], [1]).length, 1);
});

it("snapshot array sharing preserves holes and signed zero", () => {
  const sparse = Array<undefined>(1);
  const removed = shareSnapshot([undefined], sparse);
  assert.equal(Object.hasOwn(removed, 0), false);
  const inserted = shareSnapshot(sparse, [undefined]);
  assert.equal(Object.hasOwn(inserted, 0), true);
  assert.equal(Object.is(shareSnapshot([0], [-0])[0], -0), true);
  const unchanged = [NaN];
  assert.equal(shareSnapshot(unchanged, [NaN]), unchanged);
});
