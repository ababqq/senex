/** Model headers the app has read (`projectModelRigs`), kept by project and file so a remounted card knows at once. */
import { useState } from "react";
import { assetExtension } from "../shared/asset-preview.ts";
import type { ProjectAsset } from "../shared/project-assets.ts";
import { foldMotions, motionOwner, type FoldedMotions, type ModelRig } from "../shared/model-rig.ts";
import { useAsyncEffect } from "./use-async-effect.ts";

/** Each file's rig, or null when the file has none the app can read. */
const rigs = new Map<string, ModelRig | null>();
/** How many files `rigs` remembers before it forgets the oldest. */
const RIG_CAP = 2000;
const rigKey = (project: string, file: string) => `${project}\n${file}`;

/** A file whose header names its meshes, clips and bones: a GLB or a glTF. */
export function hasRig(file: string): boolean {
  const ext = assetExtension(file);
  return ext === "glb" || ext === "gltf";
}

/** Remember what was read for each asked file, forgetting the oldest past the cap. */
function remember(project: string, asked: readonly string[], found: readonly ModelRig[]): void {
  const byFile = new Map(found.map((rig) => [rig.file, rig]));
  for (const file of asked) rigs.set(rigKey(project, file), byFile.get(file) ?? null);
  while (rigs.size > RIG_CAP) {
    const oldest = rigs.keys().next().value;
    if (oldest !== undefined) rigs.delete(oldest);
  }
}

/** The rigs of `files` already read, or null while any is still unread. */
function knownRigs(project: string, files: readonly string[]): ModelRig[] | null {
  if (!files.every((file) => rigs.has(rigKey(project, file)))) return null;
  return files.map((file) => rigs.get(rigKey(project, file))).filter((rig): rig is ModelRig => Boolean(rig));
}

/** The rigs of `files`, read once each; a file the app cannot read has none. */
export async function loadRigs(project: string, files: readonly string[]): Promise<ModelRig[]> {
  const unread = files.filter((file) => hasRig(file) && !rigs.has(rigKey(project, file)));
  if (unread.length) {
    const found = await window.studio.projectModelRigs({ project, files: unread }).catch(() => []);
    remember(project, unread, found);
  }
  return knownRigs(project, files.filter(hasRig)) ?? [];
}

/** The rigs of these files in the project folder, or null until they are known. */
export function useModelRigs(project: string, files: readonly string[]): ModelRig[] | null {
  const models = files.filter(hasRig);
  const key = models.join("\n");
  const [state, setState] = useState<{ key: string; rigs: ModelRig[] } | null>(() => {
    const known = knownRigs(project, models);
    return known ? { key, rigs: known } : null;
  });
  useAsyncEffect(
    (alive) => {
      const asked = key ? key.split("\n") : [];
      const known = knownRigs(project, asked);
      if (known) {
        setState({ key, rigs: known });
        return;
      }
      void loadRigs(project, asked).then((found) => {
        if (alive()) setState({ key, rigs: found });
      });
      return undefined;
    },
    [project, key],
  );
  return state?.key === key ? state.rigs : null;
}

/** The project's newest drawn model that an animation file moves, from everything the project holds; null when none. */
export async function ownerInProject(project: string, clip: ModelRig): Promise<ProjectAsset | null> {
  const listed = await window.studio.projectAssets(project).catch(() => null);
  const models = (listed?.assets ?? [])
    .filter((asset) => hasRig(asset.file))
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
  const rigs = await loadRigs(
    project,
    models.map((asset) => asset.file),
  );
  const owner = motionOwner(clip, rigs);
  return models.find((asset) => asset.file === owner) ?? null;
}

/** Fold the animation files among `assets` into their models, by the rigs read for them. */
export function foldAssets(assets: readonly ProjectAsset[], known: readonly ModelRig[]): FoldedMotions {
  const files = new Set(assets.map((asset) => asset.file));
  return foldMotions(known.filter((rig) => files.has(rig.file)));
}
