/**
 * The two small vocabularies every side reads the same way: a plugin's id (src/shared/plugin-id.ts)
 * and a retained Genex original's reference (src/shared/genex-ref.ts). Both arrive from plugins
 * and harness records, so each is tested against hostile values.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { genexOutputFile, genexRef, isGenexRef, parseGenexRef } from "../../src/shared/genex-ref.ts";
import { isPluginId, PLUGIN_ID } from "../../src/shared/plugin-id.ts";

describe("a plugin id", () => {
  it("is lowercase, starts with a letter, and is at most 48 characters", () => {
    for (const id of ["genex", "blender-tools", "a", `a${"b".repeat(47)}`]) assert.equal(isPluginId(id), true, id);
    for (const id of [
      "",
      "Genex",
      "1genex",
      "-genex",
      "genex_tools",
      "genex/../x",
      "gen ex",
      `a${"b".repeat(48)}`,
      "genex\n",
      "constructor!",
    ])
      assert.equal(isPluginId(id), false, JSON.stringify(id));
    for (const value of [null, undefined, 7, {}, ["genex"]]) assert.equal(isPluginId(value), false);
    assert.equal(PLUGIN_ID.flags, "", "no flag loosens it (no i, no m)");
  });
});

describe("a Genex reference", () => {
  it("formats and splits `@genex/<job>/<file>`", () => {
    const ref = genexRef("job-1", "boat.glb");
    assert.equal(ref, "@genex/job-1/boat.glb");
    assert.equal(isGenexRef(ref), true);
    assert.deepEqual(parseGenexRef(ref), { jobId: "job-1", path: ["boat.glb"] });
    assert.deepEqual(genexOutputFile(ref), { jobId: "job-1", file: "boat.glb" });
    assert.deepEqual(parseGenexRef("@genex/job-1/textures/wood.png"), {
      jobId: "job-1",
      path: ["textures", "wood.png"],
    });
  });

  it("is never a project path, and a direct output file is never nested, hidden or empty", () => {
    for (const value of ["assets/boat.glb", "genex/job/boat.glb", "/@genex/job/a", "", null, 3])
      assert.equal(isGenexRef(value), false, String(value));
    assert.equal(parseGenexRef("@genex/"), null, "no job");
    assert.equal(parseGenexRef("@genex//boat.glb"), null, "an empty job");
    for (const ref of ["@genex/job", "@genex/job/", "@genex/job/.env", "@genex/job/a/b.png", "@genex/job/../x"])
      assert.equal(genexOutputFile(ref), null, ref);
  });
});
