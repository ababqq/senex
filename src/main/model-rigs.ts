/** A model file's rig read from its header alone: a GLB's JSON chunk, or a small glTF's text. */
import path from "node:path";
import { constants } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { openNoFollow } from "../substrate/fsx.ts";
import { assertRelativePath } from "../substrate/paths.ts";
import { assetExtension } from "../shared/asset-preview.ts";
import { glbJsonLength, gltfRig, type ModelRig } from "../shared/model-rig.ts";

/** A GLB's header: magic, version, length, and the JSON chunk's length and type. */
const GLB_HEADER_BYTES = 20;
/** The largest JSON a rig is read from: a header that claims more is not read. */
const MAX_RIG_JSON_BYTES = 8 * 1024 * 1024;

/** Read `length` bytes at `offset`, or null when the file holds fewer. */
async function readAt(
  handle: Awaited<ReturnType<typeof openNoFollow>>,
  offset: number,
  length: number,
): Promise<Buffer | null> {
  const bytes = Buffer.alloc(length);
  const { bytesRead } = await handle.read(bytes, 0, length, offset);
  return bytesRead === length ? bytes : null;
}

/** The glTF document a model file holds, read no further than its JSON; null for anything else. */
async function readGltfJson(target: string, ext: string): Promise<unknown> {
  const handle = await openNoFollow(target, constants.O_RDONLY);
  try {
    const { size } = await handle.stat();
    if (ext === "gltf") {
      const text = size <= MAX_RIG_JSON_BYTES ? await readAt(handle, 0, size) : null;
      return text && JSON.parse(text.toString("utf8"));
    }
    const header = await readAt(handle, 0, GLB_HEADER_BYTES);
    const length = header && glbJsonLength(header);
    if (!length || length > MAX_RIG_JSON_BYTES || GLB_HEADER_BYTES + length > size) return null;
    const json = await readAt(handle, GLB_HEADER_BYTES, length);
    return json && JSON.parse(json.toString("utf8").replace(/[\0\s]+$/, ""));
  } finally {
    await handle.close();
  }
}

/**
 * The rig of one GLB or glTF in the project folder at `root` (already a real path): null for another
 * format, a path that leaves the folder, a link, anything but a regular file, or a malformed header.
 */
export async function readModelRig(root: string, file: unknown): Promise<ModelRig | null> {
  if (typeof file !== "string") return null;
  const ext = assetExtension(file);
  if (ext !== "glb" && ext !== "gltf") return null;
  try {
    assertRelativePath(file);
    const target = path.join(root, ...file.split("/"));
    if ((await realpath(target)) !== target || !(await lstat(target)).isFile()) return null;
    const doc = await readGltfJson(target, ext);
    return doc ? gltfRig(file, doc) : null;
  } catch {
    return null;
  }
}
