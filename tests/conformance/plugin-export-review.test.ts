import assert from "node:assert/strict";
import { test } from "node:test";
import { customEvents, startRig, waitForLog } from "../helpers/studio-rig.ts";
import { writeFile } from "node:fs/promises";
import path from "node:path";

test("publication staging requires a review of the exact exported file list before returning to a plugin", async () => {
  const rig = await startRig();
  let pending: Promise<unknown> | undefined;
  try {
    const project = "export-review";
    const entry = await rig.core.projects.scaffold(project);
    await writeFile(path.join(entry.dir, "index.html"), "<!DOCTYPE html><title>Fixture</title><h1>Playable</h1>");
    await writeFile(path.join(entry.dir, "studio.json"), JSON.stringify({ exportFiles: ["index.html", ".env.local"] }));
    const threadId = await rig.core.createProjectThread(project);
    await writeFile(path.join(entry.dir, ".env.local"), "FIXTURE_SECRET=private");
    const stage = rig.core.pluginServices.exportStage;
    assert.ok(stage);
    pending = stage({ project, directory: entry.dir, threadId }, path.join(rig.userData, "export-review"), "genex");
    const rejected = assert.rejects(pending, /declined/);
    void rejected.catch(() => {});
    const events = await waitForLog(rig.core, (rows) => customEvents(rows, "plugin_consent").length > 0, 5000);
    const consent = customEvents(events, "plugin_consent").at(-1);
    assert.ok(consent);
    assert.match(String(consent.prompt), /review.*upload/i);
    const review = consent.exportReview as { included: string[]; excluded: string[] };
    assert.ok(review.included.includes("index.html"));
    assert.ok(review.excluded.includes(".env.local"));
    rig.core.resolveConsent(String(consent.consentId), false);
    await rejected;
  } finally {
    await rig.stop();
    await pending?.catch(() => {});
  }
});
