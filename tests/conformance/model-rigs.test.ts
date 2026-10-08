/**
 * Animation files belong to the model they move: an animation-only GLB (a rig and its clips, nothing
 * to draw) is folded into the drawn model whose bones it drives, read from the files' headers.
 */
import assert from "node:assert/strict";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { foldMotions, glbJsonLength, gltfRig, isMotionOnly, motionOwner } from "../../src/shared/model-rig.ts";
import { clipTitles } from "../../src/renderer/asset-names.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { glb, motionGlb } from "../helpers/glb.ts";
import { tmpDir } from "../helpers/tmp.ts";

const BONES = ["Hips", "Spine", "Head"];
/** A skinned knight: one mesh and the rig's bones. */
const knightDoc = {
  asset: { version: "2.0" },
  nodes: [{ name: "Knight", mesh: 0, skin: 0 }, ...BONES.map((name) => ({ name }))],
  meshes: [{ primitives: [] }],
  skins: [{ joints: [1, 2, 3] }],
};
const clipDoc = (name: string, bone = "Hips") => ({
  asset: { version: "2.0" },
  nodes: BONES.map((n) => ({ name: n })),
  animations: [{ name, channels: [{ sampler: 0, target: { node: BONES.indexOf(bone), path: "rotation" } }] }],
});

describe("a model file's rig", () => {
  it("counts what it draws, names its clips, and lists a drawn model's nodes", () => {
    assert.deepEqual(gltfRig("assets/knight.glb", knightDoc), {
      file: "assets/knight.glb",
      meshes: 1,
      clips: [],
      bones: ["Knight", ...BONES],
    });
  });

  it("lists only the bones an animation-only file's clips move", () => {
    assert.deepEqual(gltfRig("assets/walk.glb", clipDoc("Walk", "Spine")), {
      file: "assets/walk.glb",
      meshes: 0,
      clips: ["Walk"],
      bones: ["Spine"],
    });
  });

  it("reads a malformed document as nothing to draw and nothing to play", () => {
    for (const doc of [null, 42, "text", { nodes: "x", animations: {} }, { nodes: [null, { mesh: "0" }] }])
      assert.deepEqual(gltfRig("a.glb", doc), { file: "a.glb", meshes: 0, clips: [], bones: [] });
  });

  it("is animation only with clips and no mesh, never for a drawn model or an empty file", () => {
    assert.equal(isMotionOnly(gltfRig("w.glb", clipDoc("Walk"))), true);
    assert.equal(isMotionOnly(gltfRig("k.glb", knightDoc)), false);
    assert.equal(isMotionOnly(gltfRig("e.glb", { asset: { version: "2.0" } })), false);
    assert.equal(
      isMotionOnly(gltfRig("both.glb", { ...knightDoc, animations: clipDoc("Idle").animations })),
      false,
      "a drawn model with its own clips is a model",
    );
  });
});

describe("an animation file's model", () => {
  const knight = gltfRig("assets/genex/k1/knight.glb", knightDoc);
  const walk = gltfRig("assets/genex/k1/knight-walk.glb", clipDoc("Walk"));

  it("is the drawn model whose bones include every bone the clip moves", () => {
    assert.equal(motionOwner(walk, [knight]), knight.file);
    const crate = gltfRig("assets/crate.glb", { nodes: [{ name: "Crate", mesh: 0 }], meshes: [{}] });
    assert.equal(motionOwner(walk, [crate]), null, "a model without those bones");
  });

  it("is never another animation file, and an animation file with no bones has none", () => {
    assert.equal(motionOwner(walk, [gltfRig("assets/run.glb", clipDoc("Run"))]), null);
    const loose = { file: "assets/x.glb", meshes: 0, clips: ["X"], bones: [] };
    assert.equal(motionOwner(loose, [knight]), null);
    assert.equal(motionOwner(knight, [knight]), null, "a drawn model is no animation file");
  });

  it("prefers the model in the clip's own folder, then the first one given", () => {
    const older = gltfRig("assets/genex/k0/knight.glb", knightDoc);
    const newer = gltfRig("assets/genex/k2/knight.glb", knightDoc);
    assert.equal(motionOwner(walk, [newer, older, knight]), knight.file);
    const elsewhere = gltfRig("assets/genex/a9/knight-run.glb", clipDoc("Run"));
    assert.equal(motionOwner(elsewhere, [newer, older]), newer.file);
  });

  it("folds each animation file into its model and keeps the ones with no model apart", () => {
    const idle = gltfRig("assets/genex/k1/knight-idle.glb", clipDoc("Idle"));
    const tail = gltfRig("assets/genex/z/tail-wag.glb", { ...clipDoc("Wag"), nodes: [{ name: "Tail" }] });
    const folded = foldMotions([knight, idle, walk, tail]);
    assert.deepEqual([...folded.clipsOf], [[knight.file, [idle.file, walk.file]]]);
    assert.deepEqual(folded.loose, [tail.file]);
    assert.deepEqual([...folded.motions].sort(), [idle.file, tail.file, walk.file].sort());
  });
});

describe("a GLB's header", () => {
  it("gives the length of its JSON chunk, and nothing for anything else", () => {
    const file = glb(knightDoc);
    assert.equal(glbJsonLength(file.subarray(0, 20)), file.readUInt32LE(12));
    assert.equal(glbJsonLength(file.subarray(0, 19)), null, "too short");
    const notGltf = Buffer.from(file);
    notGltf.writeUInt32LE(0x12345678, 0);
    assert.equal(glbJsonLength(notGltf), null, "not glTF");
    const version1 = Buffer.from(file);
    version1.writeUInt32LE(1, 4);
    assert.equal(glbJsonLength(version1), null, "glTF 1");
    const binFirst = Buffer.from(file);
    binFirst.writeUInt32LE(0x004e4942, 16);
    assert.equal(glbJsonLength(binFirst), null, "first chunk not JSON");
  });
});

describe("clip names", () => {
  it("drop the words every clip shares, so the chips read Idle, Walk, Run", () => {
    const job = "assets/genex/0d99db96-677f-436b-abcf-5da04d1e06cf";
    assert.deepEqual(
      clipTitles([`${job}/knight-idle-cmucttyj.glb`, `${job}/Knight_Walk.glb`, `${job}/knight-run.glb`]),
      ["Idle", "Walk", "Run"],
    );
  });

  it("keep a lone clip's whole name, and never drop a clip's last word", () => {
    assert.deepEqual(clipTitles(["assets/knight-walk.glb"]), ["Knight walk"]);
    assert.deepEqual(clipTitles(["assets/walk.glb", "assets/walk-fast.glb"]), ["Walk", "Walk fast"]);
  });
});

describe("the project folder's model headers", () => {
  it("are read for the asked models, and nothing else is opened or written", async () => {
    const { core, projectsRoot } = await coreLite({ projectsRoot: await realpath(await tmpDir("model-rigs-")) });
    const project = await core.projects.scaffold("keep", { title: "Keep" });
    const folder = path.join(project.dir, "assets", "genex", "k1");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "knight.glb"), glb(knightDoc));
    await writeFile(path.join(folder, "knight-walk.glb"), motionGlb("Walk", BONES));
    await writeFile(path.join(folder, "knight.gltf"), JSON.stringify(knightDoc));
    await writeFile(path.join(folder, "not-a-model.glb"), "plain text");
    const huge = glb(knightDoc);
    huge.writeUInt32LE(64 * 1024 * 1024, 12);
    await writeFile(path.join(folder, "huge-header.glb"), huge);
    await writeFile(path.join(folder, "cover.png"), "png");
    await writeFile(path.join(projectsRoot, "outside.glb"), glb(knightDoc));
    await symlink(path.join(projectsRoot, "outside.glb"), path.join(folder, "linked.glb"));

    const rigs = await core.projectModelRigs({
      project: "keep",
      files: [
        "assets/genex/k1/knight.glb",
        "assets/genex/k1/knight-walk.glb",
        "assets/genex/k1/knight.gltf",
        "assets/genex/k1/not-a-model.glb",
        "assets/genex/k1/huge-header.glb",
        "assets/genex/k1/cover.png",
        "assets/genex/k1/linked.glb",
        "assets/genex/k1/missing.glb",
        "../outside.glb",
        "/etc/hosts.glb",
        "assets/../../outside.glb",
        42 as unknown as string,
      ],
    });
    assert.deepEqual(rigs, [
      { file: "assets/genex/k1/knight.glb", meshes: 1, clips: [], bones: ["Knight", ...BONES] },
      { file: "assets/genex/k1/knight-walk.glb", meshes: 0, clips: ["Walk"], bones: ["Hips"] },
      { file: "assets/genex/k1/knight.gltf", meshes: 1, clips: [], bones: ["Knight", ...BONES] },
    ]);
    for (const bad of [null, { project: "keep" }, { project: 7, files: [] }, { project: "keep", files: "a.glb" }])
      await assert.rejects(core.projectModelRigs(bad as never), /Project and files are required/);
    await assert.rejects(core.projectModelRigs({ project: "../keep", files: [] }));
  });
});
