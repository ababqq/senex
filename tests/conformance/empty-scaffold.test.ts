import assert from "node:assert/strict";
import { test } from "node:test";
import { gatherEvidence } from "../../src/harness-seed/loop/gauntlet.ts";

function context({
  empty = true,
  broken = false,
  samePose = false,
}: {
  empty?: boolean;
  broken?: boolean;
  samePose?: boolean;
} = {}) {
  let camera = "default";
  // The page rides the studio's clock: every read of the step witness moves its own counters.
  // Without this the base pass would fail on `proveStep` before it ever looked at a pixel.
  let ticks = 0;
  return {
    call: async (method: string, p: Record<string, unknown> = {}) => {
      if (method === "preview.status") return { loadError: broken ? "failed to load" : null };
      if (method === "preview.state") return { phase: "empty", drawCalls: 0, version: 2, error: null };
      if (method === "preview.evaluate") {
        const expression = String(p.expression);
        if (expression.includes("studio step witness")) {
          ticks++;
          return {
            steppedFrames: ticks * 8,
            drawCalls: ticks * 40,
            now: ticks * 320,
            canvas: true,
            simulatedMs: ticks * 320,
          };
        }
        if (expression.includes("var s = window.__studio;")) return empty;
        return samePose ? "same-pose" : camera;
      }
      if (method === "preview.call") {
        if (p.method === "eyes") return [];
        if (p.method === "cameras") return ["default", "wide"];
        if (p.method === "debugCamera") {
          camera = String(p.arg);
          return { ok: true };
        }
        if (p.method === "demos") return {};
        return {};
      }
      // An empty scene draws nothing, so every camera frame really does carry drawCalls 0 —
      // the stat the census reads. A fixture that omitted it proved nothing about this path.
      if (method === "preview.screenshot")
        return {
          path: "/runs/base.jpg",
          base64: "same-black-frame",
          bytes: 500,
          stats: { canvas: true, litFraction: 0, drawCalls: 0 },
        };
      if (method === "preview.console" || method === "preview.gpuErrors") return [];
      return {};
    },
  };
}
const request = {
  run: { runId: "run_x", project: "empty" },
  iterationId: "base",
  handle: undefined,
  root: undefined,
  labelPrefix: undefined,
  entry: undefined,
  seed: 1,
  eyes: false,
  audio: false,
  scaffold: true,
};
test("an inspected empty shared base can pass infrastructure checks with blank frames", async () => {
  const result = await gatherEvidence(context() as never, request as never);
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.emptyScene, true);
  assert.match(result.warnings.join(" "), /no visual content or interaction has been validated/);
  // Zero draw calls on every camera is what an empty base IS: the same sentence, as a warning.
  assert.match(result.warnings.join(" | "), /the project drew nothing for any camera/);
  assert.ok(!result.problems.some((p: string) => /drew nothing/.test(p)), result.problems.join(" | "));
});
test("a generated blank build cannot opt out using its own empty phase or the scaffold flag", async () => {
  for (const options of [{ scaffold: false }, { iterationId: "001" }]) {
    const result = await gatherEvidence(context() as never, { ...request, ...options } as never);
    assert.equal(result.ok, false);
    assert.match(result.problems.join(" "), /black/);
    // Outside the base stage, drawing nothing is still the verdict and not a warning.
    assert.ok(result.problems.includes("the project drew nothing for any camera"), result.problems.join(" | "));
  }
});
test("existing geometry that renders black still fails in the base stage", async () => {
  const result = await gatherEvidence(context({ empty: false }) as never, request as never);
  assert.equal(result.ok, false);
  assert.equal(result.emptyScene, false);
});
test("an empty scene does not excuse load errors or dead camera placement", async () => {
  const broken = await gatherEvidence(context({ broken: true }) as never, request as never);
  assert.equal(broken.ok, false);
  const deadCamera = await gatherEvidence(context({ samePose: true }) as never, request as never);
  assert.equal(deadCamera.ok, false);
  assert.match(deadCamera.problems.join(" "), /same transform/);
});
