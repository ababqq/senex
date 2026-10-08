/**
 * What a glTF model file holds, read from its header, so an animation file is shown with the model
 * it moves. Genex delivers a character's extra actions as animation-only GLBs: the rig and its
 * clips, with nothing to draw. Such a file is folded into the drawn model whose bones it drives.
 */

/** A GLB's first bytes: magic, version, length, then the JSON chunk's length and type. */
const GLB_HEADER_BYTES = 20;
const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const GLB_CHUNK_JSON = 0x4e4f534a;
/** The most bone names a rig keeps, and the longest name. */
const MAX_BONES = 1024;
const MAX_NAME_CHARS = 128;

/** A model file's rig, as the app reads it from the file's header. */
export interface ModelRig {
  /** The file, relative to the project folder. */
  file: string;
  /** How many of its nodes draw a mesh: none in an animation-only file. */
  meshes: number;
  /** Its animation clips' names, in the file's order. */
  clips: string[];
  /** A drawn model's named nodes; an animation-only file's, the nodes its clips move. */
  bones: string[];
}

/** The length of a GLB 2's JSON chunk, from the file's first 20 bytes; null when it is no GLB 2. */
export function glbJsonLength(header: Uint8Array): number | null {
  if (header.length < GLB_HEADER_BYTES) return null;
  const view = new DataView(header.buffer, header.byteOffset, GLB_HEADER_BYTES);
  const glb2 = view.getUint32(0, true) === GLB_MAGIC && view.getUint32(4, true) === GLB_VERSION;
  if (!glb2 || view.getUint32(16, true) !== GLB_CHUNK_JSON) return null;
  return view.getUint32(12, true);
}

/** The items of `value` when it is a list, else none. */
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
/** A record's field, when the value is a record. */
const fieldOf = (value: unknown, key: string): unknown =>
  value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;

/** A node's name, kept short; none for a nameless node. */
function nameOf(node: unknown): string | null {
  const name = fieldOf(node, "name");
  return typeof name === "string" && name ? name.slice(0, MAX_NAME_CHARS) : null;
}

/** Names once each, in order, up to the cap. */
function distinct(names: Array<string | null>): string[] {
  return [...new Set(names.filter((name): name is string => name !== null))].slice(0, MAX_BONES);
}

/** The nodes an animation's channels move. */
function movedNodes(animations: unknown[], nodes: unknown[]): string[] {
  const targets = animations.flatMap((animation) =>
    listOf(fieldOf(animation, "channels")).map((channel) => fieldOf(fieldOf(channel, "target"), "node")),
  );
  return distinct(targets.map((index) => (Number.isInteger(index) ? nameOf(nodes[index as number]) : null)));
}

/** A glTF document's rig: what it draws, its clips, and its bones. A malformed one holds nothing. */
export function gltfRig(file: string, doc: unknown): ModelRig {
  const nodes = listOf(fieldOf(doc, "nodes"));
  const animations = listOf(fieldOf(doc, "animations"));
  const meshes = nodes.filter((node) => Number.isInteger(fieldOf(node, "mesh"))).length;
  const clips = animations.map((animation) => nameOf(animation) ?? "");
  const bones = meshes > 0 ? distinct(nodes.map(nameOf)) : movedNodes(animations, nodes);
  return { file, meshes, clips, bones };
}

/** An animation-only file: clips to play and nothing to draw. */
export function isMotionOnly(rig: Pick<ModelRig, "meshes" | "clips">): boolean {
  return rig.meshes === 0 && rig.clips.length > 0;
}

/** The folder a file sits in. */
const folderOf = (file: string): string => file.slice(0, file.lastIndexOf("/") + 1);

/**
 * The drawn model an animation file moves: one with every bone its clips drive, the one in its own
 * folder first, else the first such model given (callers give the newest first). Null when none fits.
 */
export function motionOwner(clip: ModelRig, models: readonly ModelRig[]): string | null {
  if (!isMotionOnly(clip) || clip.bones.length === 0) return null;
  const fits = models.filter((model) => model.meshes > 0 && clip.bones.every((bone) => model.bones.includes(bone)));
  const folder = folderOf(clip.file);
  return (fits.find((model) => folderOf(model.file) === folder) ?? fits[0])?.file ?? null;
}

/** Animation files folded into their models: each model's clips, and the clips no model moves. */
export interface FoldedMotions {
  /** Each model's animation files, in the order given. */
  clipsOf: Map<string, string[]>;
  /** Animation files with no model among those given. */
  loose: string[];
  /** Every animation-only file given. */
  motions: Set<string>;
}

/** Fold every animation file in `rigs` into the model it moves, looking among `models` (default: `rigs`). */
export function foldMotions(rigs: readonly ModelRig[], models: readonly ModelRig[] = rigs): FoldedMotions {
  const folded: FoldedMotions = { clipsOf: new Map(), loose: [], motions: new Set() };
  for (const rig of rigs) {
    if (!isMotionOnly(rig)) continue;
    folded.motions.add(rig.file);
    const owner = motionOwner(rig, models);
    if (owner) folded.clipsOf.set(owner, [...(folded.clipsOf.get(owner) ?? []), rig.file]);
    else folded.loose.push(rig.file);
  }
  return folded;
}
