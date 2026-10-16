import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { integrationIntent, integrationPlayAsk } from "../../src/harness-seed/loop/autopilot.ts";
import { KIND_NAMES, drawsScene, measuresRenderer } from "../../src/harness-seed/loop/kinds.ts";

describe("which projects the final optimization stage can measure", () => {
  it("measures a renderer only for a graphics project; a run that declared no kind is software", () => {
    assert.equal(measuresRenderer({ kind: "graphics" }), true);
    for (const app of [null, undefined, {}, { kind: "no-such-kind" }])
      assert.equal(measuresRenderer(app), false, `${JSON.stringify(app)} is not a declaration of a scene`);
  });

  it("has nothing to measure for every page-shaped kind, because it compares draw calls and triangles", () => {
    const pages = KIND_NAMES.filter((name) => name !== "graphics");
    assert.ok(pages.length >= 7, `the software kinds are listed: ${pages.join(", ")}`);
    for (const kind of pages) {
      assert.equal(measuresRenderer({ kind }), false, `${kind} draws no scene`);
      assert.equal(drawsScene({ kind }), false);
    }
  });
});

describe("what the integration playtester is asked to do", () => {
  const GAME_WORDS = /\b(world|falling through|core verb)\b/i;

  it("asks a page-shaped project for its main flow, with nothing of a walked world in it", () => {
    for (const kind of KIND_NAMES.filter((name) => name !== "graphics")) {
      const ask = integrationPlayAsk({ kind });
      assert.doesNotMatch(ask, GAME_WORDS, `${kind}: ${ask}`);
      assert.match(ask, /main flow/);
    }
  });

  it("keeps the walked-world question for a graphics project only", () => {
    assert.match(integrationPlayAsk({ kind: "graphics" }), /move through the world/);
  });

  it("asks a run that declared no kind for the main flow, as every other default does", () => {
    for (const app of [null, undefined, {}, { kind: "no-such-kind" }]) {
      const ask = integrationPlayAsk(app);
      assert.doesNotMatch(ask, GAME_WORDS, `${JSON.stringify(app)}: ${ask}`);
      assert.match(ask, /main flow/);
    }
  });
});

describe("what the integration facet is told to reconcile", () => {
  it("names a page's seams for every software kind and for a run that declared none, never a scene's", () => {
    for (const app of [...KIND_NAMES.filter((name) => name !== "graphics").map((kind) => ({ kind })), null, {}]) {
      const intent = integrationIntent(app, "keep the header");
      assert.doesNotMatch(intent, /\b(lighting|spawn)\b/i, `${JSON.stringify(app)}: ${intent}`);
      assert.match(intent, /\b(navigation|screens?)\b/i);
      assert.match(intent, /every facet's identity features present together/);
      assert.match(intent, /keep the header$/);
    }
  });

  it("keeps the scene's seams for a graphics project", () => {
    assert.match(integrationIntent({ kind: "graphics" }), /palette, scale, lighting, spawn/);
  });
});
