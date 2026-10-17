/**
 * What a project page's window does with a file the page starts downloading. Live is the person's
 * window: their own save dialog answers. A window an agent drives has nobody to click it, so a
 * "Download CSV" button would wait on a native dialog forever; it is cancelled instead and the
 * console says what happened, so a judge can tell a working Export button from a dead one.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { downloadDecision } from "../../src/main/project-view.ts";

describe("a download the project starts", () => {
  const file = { name: "report.csv", mimeType: "text/csv" };

  it("is left to the person's own dialog in Live", () => {
    assert.deepEqual(downloadDecision(false, file), { cancel: false, note: null });
  });

  it("is cancelled in a window an agent drives, and the console says which file and why", () => {
    const { cancel, note } = downloadDecision(true, file);
    assert.equal(cancel, true);
    assert.match(note ?? "", /report\.csv/);
    assert.match(note ?? "", /text\/csv/);
    assert.match(note ?? "", /not saved/);
  });

  it("names a file whatever it is called, and a file with no name or type", () => {
    for (const name of ["a b.csv", "../../etc/passwd", "𝒳.txt", ""]) {
      const { note } = downloadDecision(true, { name, mimeType: "" });
      assert.equal(typeof note, "string", name);
      assert.ok((note ?? "").length < 300, name);
    }
  });
});
