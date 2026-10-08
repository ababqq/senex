/**
 * Edit-time ownership as the engine is handed it: field by field, so a project the user brought
 * never silently keeps the template's locks or its wiring rule.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeOwnership } from "../../src/main/core/delegation.ts";
import type { DelegateOwnership } from "../../src/shared/engine-requests.ts";

describe("delegated ownership", () => {
  it("keeps template and neverLock, and every field the studio recognises", () => {
    assert.deepEqual(
      normalizeOwnership({
        facetId: "hud",
        owns: ["src/hud.js", 7 as unknown as string],
        ownsMain: true,
        main: "src/main.js",
        studio: "src/studio.js",
        template: false,
        neverLock: ["src/assets.js"],
      }),
      {
        facetId: "hud",
        owns: ["src/hud.js", "7"],
        ownsMain: true,
        main: "src/main.js",
        studio: "src/studio.js",
        template: false,
        neverLock: ["src/assets.js"],
      },
    );
  });

  it("drops what it does not recognise and defaults the rest", () => {
    const raw = {
      facetId: "terrain",
      owns: "src/terrain.js",
      ownsMain: "yes",
      main: 3,
      template: "no",
      neverLock: [],
      extra: "dropped",
    } as unknown as DelegateOwnership;
    assert.deepEqual(normalizeOwnership(raw), { facetId: "terrain", owns: [], ownsMain: false });
  });

  it("is absent without a facet", () => {
    assert.equal(normalizeOwnership(undefined), undefined);
    assert.equal(normalizeOwnership({ owns: [] } as unknown as DelegateOwnership), undefined);
  });
});
