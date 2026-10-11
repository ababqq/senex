import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { integrationPlayAsk } from "../../src/harness-seed/loop/autopilot.ts";
import { KIND_NAMES, drawsScene, measuresRenderer } from "../../src/harness-seed/loop/kinds.ts";

describe("which projects the final optimization stage can measure", () => {
  it("measures a renderer for a graphics project and for a run that declared no kind", () => {
    assert.equal(measuresRenderer({ kind: "graphics" }), true);
    assert.equal(measuresRenderer(null), true, "no declaration keeps the stage, as before the retarget");
    assert.equal(measuresRenderer(undefined), true);
    assert.equal(measuresRenderer({}), true);
    assert.equal(measuresRenderer({ kind: "no-such-kind" }), true, "an unknown kind is not a declaration");
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

  it("keeps the walked-world question for a graphics project and for a run that declared no kind", () => {
    for (const app of [{ kind: "graphics" }, null, undefined, {}])
      assert.match(integrationPlayAsk(app), /move through the world/, JSON.stringify(app));
  });
});
