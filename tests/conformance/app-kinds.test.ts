import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
