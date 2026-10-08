/** What the Builds tab reads off an asset job: its first picture, its kind in words, and whether it is still being made. */
import { type AssetKind, assetFormat, assetKind } from "../../../shared/project-assets.ts";
import type { AssetInfo } from "../../run-graph.ts";
import { AssetCardState, BLENDER_SOURCE } from "../../run-graph-assets.ts";

/** The largest side, in pixels, of a job's thumbnail still. */
export const ASSET_THUMB_PX = 128;

const KIND_WORD: Partial<Record<AssetKind, string>> = {
  model: "3D model",
  audio: "Sound",
  image: "Image",
  video: "Video",
};

/** A job's kind as a word, from its first file, or null when it names no kind the panel knows. */
export const kindWord = (job: AssetInfo): string | null =>
  job.files[0] ? (KIND_WORD[assetKind(job.files[0])] ?? null) : null;

/** The first picture a job delivered that the contained reader can show as a thumbnail. */
export const firstImage = (job: AssetInfo): string | null =>
  job.files.find((file) => assetFormat(file)?.raster) ?? null;

/** Whether a job is still on its way: asked for, or being generated. */
export const isMaking = (job: AssetInfo): boolean =>
  job.state === AssetCardState.Requested || job.state === AssetCardState.Generating;

/** A modeller's render still of an asset, when it has one, keyed by when it was made. */
export const blenderRender = (job: AssetInfo): { run: string; version: string } | null =>
  job.source === BLENDER_SOURCE && job.render ? { run: job.render, version: job.at } : null;

/** A triangle count in words, grouped for reading. */
export const trianglesWords = (triangles: number): string => `${triangles.toLocaleString("en-US")} triangles`;
