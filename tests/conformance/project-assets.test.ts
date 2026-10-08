import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, stat, symlink, writeFile, utimes } from "node:fs/promises";
import path from "node:path";
import { tmpDir } from "../helpers/tmp.ts";
import {
  joinProjectAssets,
  readContainedImage,
  readGenexJobs,
  walkProjectAssets,
} from "../../src/main/project-assets.ts";
import { assetKind, isAudioFile } from "../../src/shared/project-assets.ts";
import { isImageFile } from "../../src/substrate/project-workspace.ts";
import type { EventEnvelope } from "../../src/substrate/types.ts";

const JOB_A = "11111111-1111-1111-1111-111111111111";
const JOB_B = "22222222-2222-2222-2222-222222222222";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** A project with one file of every shape the walk has an opinion about. */
async function project(): Promise<string> {
  const root = path.join(await tmpDir("studio-assets-"), "project");
  for (const dir of ["assets/genex/" + JOB_A, "assets/foo/" + JOB_B, "assets/src", "public/assets", "outside"]) {
    await mkdir(path.join(root, ...dir.split("/")), { recursive: true });
  }
  await writeFile(path.join(root, "assets/genex", JOB_A, "a.png"), PNG);
  await writeFile(path.join(root, "assets/foo", JOB_B, "b.png"), PNG);
  await writeFile(path.join(root, "assets/barn.glb"), "glb");
  await writeFile(path.join(root, "assets/hand.mp3"), "mp3");
  await writeFile(path.join(root, "assets/src/tree.py"), "import bpy");
  await writeFile(path.join(root, "assets/README.md"), "# notes");
  await writeFile(path.join(root, "assets/.hidden"), "x");
  await writeFile(path.join(root, "public/assets/x.png"), PNG);
  await writeFile(path.join(root, "outside/secret.png"), PNG);
  await symlink(path.join(root, "outside"), path.join(root, "assets/escape"));
  // Fixed file times so the ordering assertions test the join's precedence, not the clock.
  const when = new Date("2020-01-01T00:00:00.000Z");
  for (const file of [
    "assets/genex/" + JOB_A + "/a.png",
    "assets/foo/" + JOB_B + "/b.png",
    "assets/barn.glb",
    "assets/hand.mp3",
    "public/assets/x.png",
  ]) {
    await utimes(path.join(root, ...file.split("/")), when, when);
  }
  return root;
}

const custom = (event_type: string, payload: unknown): EventEnvelope => ({
  id: `e-${event_type}-${Math.random()}`,
  thread_id: "t1",
  session_id: null,
  turn_id: null,
  created_at: "2026-09-18T10:00:00.000Z",
  data: { type: "custom", event_type, payload },
});

it("the walk lists the project's own assets and refuses to follow anything that leaves it", async () => {
  const root = await project();
  const walk = await walkProjectAssets(root);
  assert.deepEqual(
    walk.entries.map((e) => e.file),
    [
      "assets/barn.glb",
      `assets/foo/${JOB_B}/b.png`,
      `assets/genex/${JOB_A}/a.png`,
      "assets/hand.mp3",
      "public/assets/x.png",
    ],
  );
  assert.deepEqual(walk.skipped, [{ file: "assets/escape", why: "symlink" }]);
  assert.equal(walk.truncated, false);
  assert.equal(
    walk.entries.every((e) => e.bytes > 0 && e.mtime === "2020-01-01T00:00:00.000Z"),
    true,
  );
  // The link is reported and the walk carries on: one hostile link must not hide the folder.
  assert.ok(walk.entries.some((e) => e.file === "assets/hand.mp3"));
  const capped = await walkProjectAssets(root, { maxEntries: 2 });
  assert.equal(capped.truncated, true);
  assert.ok(capped.entries.length <= 2);
  // Depth bounds how far the walk nests: the asset folders themselves are depth 1.
  const shallow = await walkProjectAssets(root, { maxDepth: 1 });
  assert.equal(shallow.truncated, true);
  assert.deepEqual(
    shallow.entries.map((e) => e.file),
    ["assets/barn.glb", "assets/hand.mp3", "public/assets/x.png"],
  );
  assert.deepEqual(await walkProjectAssets(path.join(root, "nowhere")), { entries: [], truncated: false, skipped: [] });
});

it("a symlinked asset root is reported and never walked, so a link cannot lend another folder to this project", async () => {
  const root = await project();
  // `public/assets` is replaced by a link to a folder outside the project; `assets/` stays real.
  await rm(path.join(root, "public/assets"), { recursive: true, force: true });
  await symlink(path.join(root, "outside"), path.join(root, "public/assets"));
  const walk = await walkProjectAssets(root);
  assert.deepEqual(walk.skipped, [
    { file: "assets/escape", why: "symlink" },
    { file: "public/assets", why: "symlink" },
  ]);
  assert.equal(
    walk.entries.some((e) => e.file.startsWith("public/assets/")),
    false,
    "nothing behind the link is listed, not even its names",
  );
  assert.deepEqual(
    walk.entries.map((e) => e.file),
    ["assets/barn.glb", `assets/foo/${JOB_B}/b.png`, `assets/genex/${JOB_A}/a.png`, "assets/hand.mp3"],
    "and the project's own folder is still read in full",
  );
  assert.equal(walk.truncated, false);
});

it("the join names where each file came from, in the order the ledger and the records allow", async () => {
  const root = await project();
  const walk = await walkProjectAssets(root);
  const ledger = [
    custom("asset_delivered", {
      project: "farm",
      source: "genex",
      pluginId: "genex",
      jobId: JOB_A,
      files: [{ file: `assets/genex/${JOB_A}/a.png`, bytes: PNG.length, kind: "image" }],
      at: "2026-09-18T12:00:00.000Z",
      runId: "run-1",
      facetId: "world",
      iteration: 2,
    }),
    custom("blender_asset", {
      project: "farm",
      name: "barn",
      file: "assets/barn.glb",
      ok: true,
      render: "/runs/run-1/barn-1.png",
      renderFront: "/runs/run-1/barn-1-front.png",
      runId: "run-1",
      facetId: "world",
      iteration: 1,
      at: "2026-09-18T11:00:00.000Z",
    }),
    // Another project's delivery, sitting in the same Studio thread: it must not touch this project.
    custom("asset_delivered", {
      project: "other",
      source: "genex",
      jobId: JOB_B,
      files: [{ file: "assets/hand.mp3", bytes: 3, kind: "audio" }],
      at: "2026-09-18T23:00:00.000Z",
    }),
    // A record for a file nobody can find: the walk is the truth about existence.
    custom("asset_delivered", {
      project: "farm",
      source: "genex",
      jobId: JOB_A,
      files: [{ file: "assets/genex/gone.png", bytes: 1, kind: "image" }],
      at: "2026-09-18T13:00:00.000Z",
    }),
  ];
  const jobs = [
    {
      id: JOB_A,
      files: [`assets/genex/${JOB_A}/a.png`],
      operation: "image",
      status: "downloaded",
      prompt: "a barn at dusk",
      createdAt: "2026-09-18T09:00:00.000Z",
      use: { stage: "integrated" as const },
    },
  ];
  const joined = joinProjectAssets({
    project: "farm",
    entries: walk.entries,
    ledger,
    jobs,
    truncated: walk.truncated,
    skipped: walk.skipped,
  });
  const by = (file: string) => joined.assets.find((a) => a.file === file)!;
  assert.equal(joined.assets.length, 5);
  assert.equal(
    joined.assets.some((a) => a.file === "assets/genex/gone.png"),
    false,
  );

  const a = by(`assets/genex/${JOB_A}/a.png`);
  assert.equal(a.source, "genex");
  assert.equal(a.jobId, JOB_A);
  assert.equal(a.kind, "image");
  assert.equal(a.operation, "image");
  assert.equal(a.pluginStatus, "downloaded");
  assert.equal(a.prompt, "a barn at dusk");
  assert.deepEqual(a.use, { stage: "integrated" });
  assert.equal(a.runId, "run-1");
  assert.equal(a.facetId, "world");
  assert.equal(a.iteration, 2);

  const barn = by("assets/barn.glb");
  assert.equal(barn.source, "blender");
  assert.equal(barn.kind, "model");
  assert.equal(barn.jobId, "barn");
  assert.equal(barn.render, "/runs/run-1/barn-1.png");
  assert.equal(barn.renderFront, "/runs/run-1/barn-1-front.png");

  // The other project's event claimed this file; it stays an imported drop-in.
  assert.equal(by("assets/hand.mp3").source, "imported");
  assert.equal(by("assets/hand.mp3").kind, "audio");
  assert.equal(by("public/assets/x.png").source, "imported");
  // Nothing in the ledger, nothing in the records: the shape a delivery leaves behind is inference.
  assert.equal(by(`assets/foo/${JOB_B}/b.png`).source, "foo");
  assert.equal(by(`assets/foo/${JOB_B}/b.png`).jobId, JOB_B);
  assert.equal(by(`assets/foo/${JOB_B}/b.png`).pluginStatus, undefined);

  // Newest first by when it was delivered, falling back to the file's own time, then by path.
  assert.deepEqual(
    joined.assets.map((x) => x.file),
    [
      `assets/genex/${JOB_A}/a.png`,
      "assets/barn.glb",
      `assets/foo/${JOB_B}/b.png`,
      "assets/hand.mp3",
      "public/assets/x.png",
    ],
  );
  assert.equal(joined.project, "farm");
  assert.deepEqual(joined.skipped, [{ file: "assets/escape", why: "symlink" }]);
});

it("Genex job records are read without being written, and an approval never leaves the folder", async () => {
  const homes = await tmpDir("studio-homes-");
  const jobs = path.join(homes, "genex", "projects", "farm", "jobs");
  const good = path.join(jobs, JOB_A);
  await mkdir(good, { recursive: true });
  await writeFile(
    path.join(good, "job.json"),
    JSON.stringify({
      id: JOB_A,
      project: "farm",
      operation: "image",
      status: "downloaded",
      files: [`assets/genex/${JOB_A}/a.png`],
      createdAt: "2026-09-18T09:00:00.000Z",
      approval: { images: ["AAAA"] },
    }),
  );
  await writeFile(path.join(good, "request.json"), JSON.stringify({ prompt: "p".repeat(900) }));
  // A record naming another project, a folder that is not a job id, and a link out of the folder.
  const wrong = path.join(jobs, JOB_B);
  await mkdir(wrong, { recursive: true });
  await writeFile(path.join(wrong, "job.json"), JSON.stringify({ id: JOB_B, project: "other", files: [] }));
  await mkdir(path.join(jobs, "not-a-uuid"), { recursive: true });
  await writeFile(
    path.join(jobs, "not-a-uuid", "job.json"),
    JSON.stringify({ id: "not-a-uuid", project: "farm", files: [] }),
  );
  const linked = path.join(jobs, "33333333-3333-3333-3333-333333333333");
  await mkdir(linked, { recursive: true });
  await symlink(
    path.join(homes, "genex", "projects", "farm", "jobs", JOB_A, "job.json"),
    path.join(linked, "job.json"),
  );

  const before = await readdir(jobs);
  const beforeMtime = (await stat(path.join(good, "job.json"))).mtimeMs;
  const records = await readGenexJobs(homes, "farm");
  assert.deepEqual(
    records.map((r) => r.id),
    [JOB_A],
  );
  assert.equal(records[0]!.operation, "image");
  assert.equal(records[0]!.prompt!.length, 500);
  assert.equal("approval" in records[0]!, false);
  assert.equal(JSON.stringify(records).includes("AAAA"), false);
  assert.deepEqual(await readdir(jobs), before);
  assert.equal((await stat(path.join(good, "job.json"))).mtimeMs, beforeMtime);
  assert.deepEqual(await readGenexJobs(homes, "../escape"), []);
  assert.deepEqual(await readGenexJobs(homes, "never-a-project"), []);
});

it("the contained reader refuses everything that is not an image inside the project's asset folders", async () => {
  const root = await project();
  const ok = await readContainedImage(root, `assets/genex/${JOB_A}/a.png`);
  assert.equal(ok?.mimeType, "image/png");
  assert.equal(Buffer.from(ok!.data, "base64").length, PNG.length);
  assert.equal(await readContainedImage(root, "../x.png"), null);
  assert.equal(await readContainedImage(root, "/etc/hosts.png"), null);
  assert.equal(await readContainedImage(root, "src/main.png"), null, "outside the asset prefixes");
  assert.equal(await readContainedImage(root, "assets/missing.png"), null);
  assert.equal(await readContainedImage(root, "assets/barn.glb"), null, "not an image extension");

  // A symlinked image inside the folder is refused rather than followed.
  await symlink(path.join(root, "outside/secret.png"), path.join(root, "assets/linked.png"));
  assert.equal(await readContainedImage(root, "assets/linked.png"), null);

  // The bytes name the type: a PNG called .jpg reads as a PNG, text called .png reads as nothing.
  await writeFile(path.join(root, "assets/mislabelled.jpg"), PNG);
  assert.equal((await readContainedImage(root, "assets/mislabelled.jpg"))?.mimeType, "image/png");
  await writeFile(path.join(root, "assets/pretend.png"), "not an image at all");
  assert.equal(await readContainedImage(root, "assets/pretend.png"), null);

  // The ceiling is bytes, not trust.
  assert.equal(await readContainedImage(root, `assets/genex/${JOB_A}/a.png`, { maxBytes: 4 }), null);

  // A resize is used when asked for, and a failing one falls back to the original bytes.
  const asked: number[] = [];
  const resized = await readContainedImage(root, `assets/genex/${JOB_A}/a.png`, {
    resize: async (data) => {
      asked.push(data.length);
      return Buffer.from("jpeg-bytes");
    },
  });
  assert.deepEqual(asked, [PNG.length]);
  assert.equal(resized?.mimeType, "image/jpeg");
  const fell = await readContainedImage(root, `assets/genex/${JOB_A}/a.png`, {
    resize: async () => {
      throw new Error("no preview");
    },
  });
  assert.equal(fell?.mimeType, "image/png");
  // An empty prefix list is how the inspection scope reads inside a job folder.
  assert.equal(
    (await readContainedImage(path.join(root, "outside"), "secret.png", { prefixes: [] }))?.mimeType,
    "image/png",
  );
});

it("assetKind classifies by extension and treats anything else as other", () => {
  assert.equal(assetKind("assets/a.png"), "image");
  assert.equal(assetKind("assets/BARN.GLB"), "model");
  assert.equal(assetKind("assets/hand.wav"), "audio");
  assert.equal(assetKind("assets/clip.mp4"), "video");
  assert.equal(assetKind("assets/src/tree.py"), "other");
  assert.equal(assetKind("assets/logo.svg"), "image");
  assert.equal(assetKind(""), "other");
});

it("the join falls back to the file's own time when nothing recorded a delivery", async () => {
  const root = await project();
  const older = path.join(root, "assets/hand.mp3");
  await utimes(older, new Date("2019-01-01T00:00:00.000Z"), new Date("2019-01-01T00:00:00.000Z"));
  const walk = await walkProjectAssets(root);
  const joined = joinProjectAssets({ project: "farm", entries: walk.entries, ledger: [], jobs: [] });
  assert.equal(joined.assets.at(-1)!.file, "assets/hand.mp3");
  assert.equal(
    joined.assets.every((a) => a.source === "imported" || a.source === "genex" || a.source === "foo"),
    true,
  );
  assert.equal(await readFile(older, "utf8"), "mp3");
});

it("main and the substrate read pictures and sounds from the one format table", () => {
  // The contained readers, the run stills and the user-paths listing take raster pictures only.
  for (const [file, image] of [
    ["a.png", true],
    ["dir/A.JPEG", true],
    ["b.webp", true],
    ["c.gif", true],
    ["d.svg", false],
    ["e.bmp", false],
    ["f.exr", false],
    [".png", false],
    ["png", false],
    ["dir.png/file", false],
  ] as const) {
    assert.equal(isImageFile(file), image, file);
  }
  // The audio a Genex use check observes: every audio row of the table, `.oga` and `.opus` included.
  for (const [file, audio] of [
    ["a.mp3", true],
    ["b.WAV", true],
    ["c.ogg", true],
    ["d.m4a", true],
    ["e.aac", true],
    ["f.flac", true],
    ["g.oga", true],
    ["h.opus", true],
    ["i.mp4", false],
    ["j.png", false],
    ["mp3", false],
  ] as const) {
    assert.equal(isAudioFile(file), audio, file);
  }
});
