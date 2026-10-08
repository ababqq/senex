/**
 * No-input baselines from the instrument's page-side frame series (a 64x36 mirror diffed per sample).
 * Two baselines, and each check names the one it used: the pre-gesture idle (on a project with a title
 * screen that is the MENU's drift) and the post-entrance window, taken on interaction once the entrance
 * is confirmed, which is where every gated input measurement happens.
 */
import type { ProbeSample } from "../instrument.ts";
import { mean, percentile } from "../frames.ts";
import { readProbeSeriesInPage } from "../driver.ts";
import type { PhaseContext } from "./context.ts";

/** A response is a change when it exceeds this multiple of the baseline's p95. */
export const CHANGE_OVER_IDLE = 3;
/** Absolute floor, so a perfectly static project does not get a zero threshold. */
export const MIN_CHANGE_DIFF = 0.004;
/** The fewest sampler readings a baseline may set a threshold from. */
export const MIN_BASELINE_SAMPLES = 5;

/** Which no-input window a threshold came from. */
export const BaselineName = {
  PreGesture: "pre-gesture",
  PostEntrance: "post-entrance",
} as const;
export type BaselineName = (typeof BaselineName)[keyof typeof BaselineName];

/** One no-input baseline and the change threshold derived from it. */
export interface PageBaseline {
  name: BaselineName;
  samples: number;
  pageMeanDiff: number;
  pageP95Diff: number;
  pageMaxDiff: number;
  /** `max(p95 × CHANGE_OVER_IDLE, MIN_CHANGE_DIFF)`: what an input response must clear. */
  changeThreshold: number;
  /** Enough samples to stand on; a thin baseline is recorded, never applied. */
  usable: boolean;
}

/** A baseline from the diffs read in a no-input window. */
export function buildBaseline(name: BaselineName, diffs: readonly number[]): PageBaseline {
  const p95 = percentile(diffs, 0.95);
  return {
    name,
    samples: diffs.length,
    pageMeanDiff: mean(diffs),
    pageP95Diff: p95,
    pageMaxDiff: diffs.length ? Math.max(...diffs) : 0,
    changeThreshold: Math.max(p95 * CHANGE_OVER_IDLE, MIN_CHANGE_DIFF),
    usable: diffs.length >= MIN_BASELINE_SAMPLES,
  };
}

/** The post-entrance baseline when it is usable, else the pre-gesture one. */
export function appliedBaseline(pre: PageBaseline, post: PageBaseline | null): PageBaseline {
  return post?.usable ? post : pre;
}

/** Where the next series read starts. */
export interface SeriesCursor {
  next: number;
}

/** Read the samples the instrument took since the cursor, advancing it. */
export async function pullSeries(ctx: PhaseContext, cursor: SeriesCursor): Promise<ProbeSample[]> {
  const series = await ctx.page.evaluate(readProbeSeriesInPage, cursor.next);
  if (!series) return [];
  cursor.next = series.nextFrame;
  return series.frames;
}

/** Sleep for `ms` with no input and return the diffs sampled in that window. */
export async function quietWindow(ctx: PhaseContext, cursor: SeriesCursor, ms: number): Promise<number[]> {
  await pullSeries(ctx, cursor);
  await ctx.sleep(ms);
  return (await pullSeries(ctx, cursor)).map((s) => s.d);
}
