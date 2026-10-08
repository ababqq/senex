/**
 * Pure pixel analysis. No browser, no I/O, no state: raw RGBA buffers in, numbers out, so every
 * claim the prober makes about a frame is unit-testable with a synthetic buffer.
 *
 * The rule that shaped this file: exposure is NEVER one number. A whole-frame mean is dominated by
 * sky and floor, which is exactly the defect that shipped. So every exposure figure comes out three
 * ways (mean, tonal range, contrast), tiled 4x4, with the per-tile values carried through.
 */
import type { RawFrame } from "./png.ts";

export type { RawFrame };

/** Luma below this is clipped black, 0..1. */
const CLIP_BLACK = 0.02;
/** Luma above this is clipped white, 0..1. */
const CLIP_WHITE = 0.98;
/** Exposure histogram bins over luma 0..1. */
const HISTOGRAM_BINS = 16;
/** The exposure tile grid, per side. */
const DEFAULT_TILES = 4;
/** At most this many quantised colours and a frame is flat. */
const DEGENERATE_MAX_COLORS = 4;
/** One colour covering more than this share of the frame makes it degenerate. */
const DEGENERATE_DOMINANT_FRACTION = 0.995;
/** Luma standard deviation under this, with a range under the next, is a flat gradient. */
const DEGENERATE_LUMA_STDDEV = 0.005;
const DEGENERATE_LUMA_RANGE = 0.05;
/** A channel moving by more than this (0..255) marks a pixel changed in `frameDiff`. */
const DEFAULT_DIFF_THRESHOLD = 8;
/** The correlation grid `estimateMotion` and `estimateScale` downsample to. */
const MOTION_GRID_WIDTH = 160;
const MOTION_GRID_HEIGHT = 90;
/** A correlation needs at least this many overlapping samples. */
const MIN_CORRELATION_SAMPLES = 8;
/** The candidate scales `estimateScale` tries, and its step. */
const SCALE_MIN = 0.88;
const SCALE_MAX = 1.1201;
const SCALE_STEP = 0.005;
/** Ground-flow bands, as fractions of the frame, and their downsample grid. */
const GROUND_TOP = 0.45;
const GROUND_BOTTOM = 0.97;
const GROUND_GRID_WIDTH = 120;
const GROUND_GRID_HEIGHT = 80;
const GROUND_MAX_SHIFT = 26;
const EPSILON = 1e-12;

/** Exposure over one tile of the grid. */
export interface TileStat {
  ix: number;
  iy: number;
  /** Centre weight applied to this tile in the centre-weighted aggregates. */
  weight: number;
  mean: number;
  min: number;
  max: number;
  p01: number;
  p99: number;
  stdDev: number;
  tonalRange: number;
}

/** A frame's exposure, three ways, whole-frame and centre-weighted. */
export interface ExposureReport {
  width: number;
  height: number;
  /** Unweighted whole-frame mean luma in sRGB space, 0..1. */
  mean: number;
  /** Whole-frame mean after sRGB -> linear. Dark scenes differ a lot between the two. */
  meanLinear: number;
  /** Centre-weighted mean over the tiles. */
  centreWeightedMean: number;
  /** p99 - p01 of luma over the whole frame. */
  tonalRange: number;
  centreWeightedTonalRange: number;
  /** RMS contrast: standard deviation of luma, 0..1. */
  contrast: number;
  centreWeightedContrast: number;
  /** (p99 - p01) / (p99 + p01). Scale-free, so it survives an overall exposure shift. */
  michelson: number;
  clippedBlackFraction: number;
  clippedWhiteFraction: number;
  /** max(tile.mean) - min(tile.mean). High means the frame mean is an average of unlike things. */
  tileSpread: number;
  tiles: TileStat[];
  histogram: number[];
}

/** Whether a frame is a rendered scene or one flat colour, and why. */
export interface DegeneracyReport {
  degenerate: boolean;
  reasons: string[];
  distinctColors: number;
  dominantColorFraction: number;
  lumStdDev: number;
  lumRange: number;
  meanAlpha: number;
}

/** How far two same-sized frames differ. */
export interface FrameDiff {
  /** Mean absolute RGB difference, normalised 0..1. */
  meanAbs: number;
  /** Fraction of pixels whose max channel delta exceeds the threshold. */
  changedFraction: number;
  maxAbs: number;
  threshold: number;
}

/** The best integer offset between two 1-D profiles. */
export interface ShiftEstimate {
  /** Positive = frame B content sits further right / lower than frame A. */
  shift: number;
  /** Normalised cross-correlation at the winning offset, -1..1. */
  score: number;
  /** Correlation at zero offset, for comparison. */
  scoreAtZero: number;
}

/** The dominant on-screen translation between two frames. */
export interface MotionEstimate {
  dx: number;
  dy: number;
  dxScore: number;
  dyScore: number;
  dxScoreAtZero: number;
  dyScoreAtZero: number;
}

/** Rec.709 luma over sRGB-encoded bytes, 0..1. This is what a human reads as brightness. */
export function srgbLuma(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** sRGB-encoded 0..1 to linear light. */
export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** Throw unless two frames have the same size. */
export function assertSameSize(a: RawFrame, b: RawFrame): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`frames: size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
}

/** The mean RGBA of the source block [x0,x1) x [y0,y1), clipped to the frame. */
function blockMean(frame: RawFrame, x0: number, x1: number, y0: number, y1: number): number[] {
  const sum = [0, 0, 0, 0];
  let n = 0;
  for (let yy = y0; yy < Math.min(y1, frame.height); yy++) {
    for (let xx = x0; xx < Math.min(x1, frame.width); xx++) {
      const i = (yy * frame.width + xx) * 4;
      for (let c = 0; c < 4; c++) sum[c] += frame.data[i + c];
      n++;
    }
  }
  return sum.map((s) => (n ? Math.round(s / n) : 0));
}

/** Box-filter downsample. Makes diffs cheap and normalises frames to one comparison size. */
export function downsampleFrame(frame: RawFrame, width: number, height: number): RawFrame {
  const out = new Uint8Array(width * height * 4);
  const sx = frame.width / width;
  const sy = frame.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      out.set(blockMean(frame, x0, x1, y0, y1), (y * width + x) * 4);
    }
  }
  return { width, height, data: out };
}

/** Per-pixel luma, row-major. */
export function lumaArray(frame: RawFrame): Float64Array {
  const out = new Float64Array(frame.width * frame.height);
  for (let i = 0, p = 0; p < out.length; p++, i += 4) {
    out[p] = srgbLuma(frame.data[i], frame.data[i + 1], frame.data[i + 2]);
  }
  return out;
}

/** The value at fraction `p` of an already-sorted list; 0 for an empty one. */
export function percentileOfSorted(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}

function statsOf(values: number[]): {
  mean: number;
  min: number;
  max: number;
  p01: number;
  p99: number;
  stdDev: number;
} {
  if (values.length === 0) return { mean: 0, min: 0, max: 0, p01: 0, p99: 0, stdDev: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / values.length;
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    mean,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p01: percentileOfSorted(sorted, 0.01),
    p99: percentileOfSorted(sorted, 0.99),
    stdDev: Math.sqrt(variance),
  };
}

/**
 * Centre weight for a tile in a tilesX x tilesY grid: 1 / (1 + d^2), where d is the tile-centre
 * offset from the frame centre in tile units. On a 4x4 grid that is 0.67 for the four centre tiles
 * and 0.18 for the corners.
 */
export function tileWeight(ix: number, iy: number, tilesX: number, tilesY: number): number {
  const dx = ix + 0.5 - tilesX / 2;
  const dy = iy + 0.5 - tilesY / 2;
  return 1 / (1 + dx * dx + dy * dy);
}

function tileValues(frame: RawFrame, luma: Float64Array, ix: number, iy: number, tilesX: number, tilesY: number) {
  const y0 = Math.floor((iy * frame.height) / tilesY);
  const y1 = Math.floor(((iy + 1) * frame.height) / tilesY);
  const x0 = Math.floor((ix * frame.width) / tilesX);
  const x1 = Math.floor(((ix + 1) * frame.width) / tilesX);
  const values: number[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) values.push(luma[y * frame.width + x]);
  }
  return values;
}

/** Exposure statistics per tile of a tilesX x tilesY grid. */
export function tileExposure(frame: RawFrame, tilesX = DEFAULT_TILES, tilesY = DEFAULT_TILES): TileStat[] {
  const luma = lumaArray(frame);
  const tiles: TileStat[] = [];
  for (let iy = 0; iy < tilesY; iy++) {
    for (let ix = 0; ix < tilesX; ix++) {
      const s = statsOf(tileValues(frame, luma, ix, iy, tilesX, tilesY));
      tiles.push({ ix, iy, weight: tileWeight(ix, iy, tilesX, tilesY), ...s, tonalRange: s.p99 - s.p01 });
    }
  }
  return tiles;
}

/** Whole-frame luma sums: mean, linear mean, clipping and the histogram. */
function lumaSums(luma: Float64Array) {
  let sum = 0;
  let sumLinear = 0;
  let clippedBlack = 0;
  let clippedWhite = 0;
  const histogram = new Array<number>(HISTOGRAM_BINS).fill(0);
  for (const v of luma) {
    sum += v;
    sumLinear += srgbToLinear(v);
    if (v < CLIP_BLACK) clippedBlack++;
    if (v > CLIP_WHITE) clippedWhite++;
    histogram[Math.min(HISTOGRAM_BINS - 1, Math.floor(v * HISTOGRAM_BINS))]++;
  }
  return { sum, sumLinear, clippedBlack, clippedWhite, histogram };
}

/** The centre-weighted means of the tiles' mean, contrast and tonal range, and their spread. */
function weightedTiles(tiles: TileStat[]) {
  const wSum = tiles.reduce((a, t) => a + t.weight, 0);
  const weighted = (pick: (t: TileStat) => number) =>
    wSum ? tiles.reduce((a, t) => a + pick(t) * t.weight, 0) / wSum : 0;
  const means = tiles.map((t) => t.mean);
  return {
    mean: weighted((t) => t.mean),
    contrast: weighted((t) => t.stdDev),
    range: weighted((t) => t.tonalRange),
    spread: tiles.length ? Math.max(...means) - Math.min(...means) : 0,
  };
}

/** A frame's exposure: mean, tonal range and contrast, whole-frame and centre-weighted over tiles. */
export function exposureReport(frame: RawFrame, tilesX = DEFAULT_TILES, tilesY = DEFAULT_TILES): ExposureReport {
  const luma = lumaArray(frame);
  const n = luma.length;
  const sums = lumaSums(luma);
  const mean = n ? sums.sum / n : 0;
  const contrast = n ? Math.sqrt(luma.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / n) : 0;
  const sorted = Float64Array.from(luma).sort();
  const p01 = percentileOfSorted(sorted, 0.01);
  const p99 = percentileOfSorted(sorted, 0.99);
  const tiles = tileExposure(frame, tilesX, tilesY);
  const w = weightedTiles(tiles);
  const share = (count: number) => (n ? count / n : 0);
  return {
    width: frame.width,
    height: frame.height,
    mean,
    meanLinear: share(sums.sumLinear),
    centreWeightedMean: w.mean,
    tonalRange: p99 - p01,
    centreWeightedTonalRange: w.range,
    contrast,
    centreWeightedContrast: w.contrast,
    michelson: p99 + p01 > 1e-6 ? (p99 - p01) / (p99 + p01) : 0,
    clippedBlackFraction: share(sums.clippedBlack),
    clippedWhiteFraction: share(sums.clippedWhite),
    tileSpread: w.spread,
    tiles,
    histogram: sums.histogram.map(share),
  };
}

/** Quantised colour counts and luma per pixel, for `degeneracyReport`. */
function colourCensus(frame: RawFrame) {
  const counts = new Map<number, number>();
  const n = frame.width * frame.height;
  const lum = new Float64Array(n);
  let sumAlpha = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const r = frame.data[i];
    const g = frame.data[i + 1];
    const b = frame.data[i + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    lum[p] = srgbLuma(r, g, b);
    sumAlpha += frame.data[i + 3];
  }
  return { counts, lum, sumAlpha, n };
}

/** Min, max and standard deviation in one pass over a large series, without sorting it. */
function spreadOf(values: Float64Array): { min: number; max: number; stdDev: number } {
  if (values.length === 0) return { min: 0, max: 0, stdDev: 0 };
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    sum += v;
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  const m = sum / values.length;
  const variance = values.reduce((acc, v) => acc + (v - m) * (v - m), 0) / values.length;
  return { min, max, stdDev: Math.sqrt(variance) };
}

/**
 * "Non-degenerate pixels" made concrete: a frame that is one flat colour, or a near-flat gradient,
 * is not a rendered scene. Colours are quantised to 5 bits per channel so dithering and codec noise
 * do not read as detail.
 */
export function degeneracyReport(frame: RawFrame): DegeneracyReport {
  const { counts, lum, sumAlpha, n } = colourCensus(frame);
  const s = spreadOf(lum);
  const dominant = Math.max(0, ...counts.values());
  const dominantFraction = n ? dominant / n : 0;
  const lumRange = s.max - s.min;
  const reasons: string[] = [];
  if (counts.size <= DEGENERATE_MAX_COLORS) reasons.push(`only ${counts.size} distinct quantised colours`);
  if (dominantFraction > DEGENERATE_DOMINANT_FRACTION) {
    reasons.push(`one colour covers ${(dominantFraction * 100).toFixed(1)}% of the frame`);
  }
  if (s.stdDev < DEGENERATE_LUMA_STDDEV && lumRange < DEGENERATE_LUMA_RANGE) {
    reasons.push("luma is flat (stdDev < 0.005, range < 0.05)");
  }
  if (n === 0) reasons.push("empty frame");
  return {
    degenerate: reasons.length > 0,
    reasons,
    distinctColors: counts.size,
    dominantColorFraction: dominantFraction,
    lumStdDev: s.stdDev,
    lumRange,
    meanAlpha: n ? sumAlpha / n / 255 : 0,
  };
}

/** How far two same-sized frames differ, per pixel and on average. */
export function frameDiff(a: RawFrame, b: RawFrame, threshold = DEFAULT_DIFF_THRESHOLD): FrameDiff {
  assertSameSize(a, b);
  const n = a.width * a.height;
  let sum = 0;
  let changed = 0;
  let max = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const dr = Math.abs(a.data[i] - b.data[i]);
    const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
    const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
    sum += dr + dg + db;
    const m = Math.max(dr, dg, db);
    if (m > max) max = m;
    if (m > threshold) changed++;
  }
  return {
    meanAbs: n ? sum / (n * 3) / 255 : 0,
    changedFraction: n ? changed / n : 0,
    maxAbs: max / 255,
    threshold,
  };
}

/** Mean luma per column. */
export function columnProfile(frame: RawFrame): Float64Array {
  const out = new Float64Array(frame.width);
  for (let x = 0; x < frame.width; x++) {
    let s = 0;
    for (let y = 0; y < frame.height; y++) {
      const i = (y * frame.width + x) * 4;
      s += srgbLuma(frame.data[i], frame.data[i + 1], frame.data[i + 2]);
    }
    out[x] = s / frame.height;
  }
  return out;
}

/** Mean luma per row. */
export function rowProfile(frame: RawFrame): Float64Array {
  const out = new Float64Array(frame.height);
  for (let y = 0; y < frame.height; y++) {
    let s = 0;
    for (let x = 0; x < frame.width; x++) {
      const i = (y * frame.width + x) * 4;
      s += srgbLuma(frame.data[i], frame.data[i + 1], frame.data[i + 2]);
    }
    out[y] = s / frame.width;
  }
  return out;
}

/** Normalised cross-correlation of `a[i]` with `b[i + s]` over `[start, end)`. */
function correlationAt(a: ArrayLike<number>, b: ArrayLike<number>, s: number, start: number, end: number): number {
  const count = end - start;
  let sa = 0;
  let sb = 0;
  for (let i = start; i < end; i++) {
    sa += a[i];
    sb += b[i + s];
  }
  const ma = sa / count;
  const mb = sb / count;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = start; i < end; i++) {
    const va = a[i] - ma;
    const vb = b[i + s] - mb;
    num += va * vb;
    da += va * va;
    db += vb * vb;
  }
  const denom = Math.sqrt(da * db);
  return denom > EPSILON ? num / denom : 0;
}

/**
 * Normalised cross-correlation of two 1-D profiles over integer offsets. Positive shift = profile B
 * looks like profile A moved in the + direction.
 *
 * Camera conventions differ per project, so the prober never asserts an absolute sign; it asserts that
 * opposite keys produce opposite signs. This function's only obligation is sign and magnitude.
 */
export function bestShift(a: ArrayLike<number>, b: ArrayLike<number>, maxShift: number): ShiftEstimate {
  const n = Math.min(a.length, b.length);
  const limit = Math.min(maxShift, Math.max(0, n - MIN_CORRELATION_SAMPLES));
  let best = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  let scoreAtZero = 0;
  for (let s = -limit; s <= limit; s++) {
    const start = Math.max(0, -s);
    const end = Math.min(n, n - s);
    if (end - start < MIN_CORRELATION_SAMPLES) continue;
    const score = correlationAt(a, b, s, start, end);
    if (s === 0) scoreAtZero = score;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return { shift: best, score: Number.isFinite(bestScore) ? bestScore : 0, scoreAtZero };
}

/**
 * Estimate the dominant on-screen translation between two frames. Frames are downsampled first so
 * this stays cheap and so tiny shifts do not register as motion.
 */
export function estimateMotion(
  a: RawFrame,
  b: RawFrame,
  gridWidth = MOTION_GRID_WIDTH,
  gridHeight = MOTION_GRID_HEIGHT,
): MotionEstimate {
  const da = downsampleFrame(a, gridWidth, gridHeight);
  const db = downsampleFrame(b, gridWidth, gridHeight);
  const cx = bestShift(columnProfile(da), columnProfile(db), Math.floor(gridWidth / 3));
  const cy = bestShift(rowProfile(da), rowProfile(db), Math.floor(gridHeight / 3));
  return {
    dx: cx.shift,
    dy: cy.shift,
    dxScore: cx.score,
    dyScore: cy.score,
    dxScoreAtZero: cx.scoreAtZero,
    dyScoreAtZero: cy.scoreAtZero,
  };
}

/**
 * How much the scene EXPANDED or CONTRACTED between two frames.
 *
 * Translation alone cannot tell "moved forward" from "moved backward": both produce a symmetric
 * signal, so a check built on dx/dy passes an inverted axis. Forward motion in a forward-facing 3D
 * scene is RADIAL EXPANSION, an absolute signal with a sign. Both axes must agree; a top-down camera
 * produces no expansion at all, reported as a LOW SCORE and read as "cannot tell", never "backward".
 */
export interface ScaleEstimate {
  /** >1 expansion (moving in), <1 contraction (moving out), 1 neither. */
  readonly scale: number;
  /** Correlation of the best scale. Below `MIN_SCALE_SCORE` means unusable. */
  readonly score: number;
  /** Both axes agreed on the direction of the change. */
  readonly agreed: boolean;
}

/** Below this the frames do not share enough structure to call a scale. */
export const MIN_SCALE_SCORE = 0.55;
/** Smaller than this is inside the noise of a static scene. */
export const MIN_SCALE_DELTA = 0.012;

/** Resample a profile about its centre by `scale`, linearly interpolated. */
function rescaleProfile(src: ArrayLike<number>, scale: number): Float64Array {
  const n = src.length;
  const out = new Float64Array(n);
  const c = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    const x = Math.min(n - 1, Math.max(0, c + (i - c) / scale));
    const j = Math.min(n - 2, Math.floor(x));
    const f = x - j;
    out[i] = n < 2 ? src[0] : src[j] * (1 - f) + src[j + 1] * f;
  }
  return out;
}

/** Pearson correlation of two equal-length series. */
function correlate(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n < MIN_CORRELATION_SAMPLES) return 0;
  return correlationAt(a, b, 0, 0, n);
}

function bestScaleOn(a: ArrayLike<number>, b: ArrayLike<number>): { scale: number; score: number } {
  let bestScale = 1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let s = SCALE_MIN; s <= SCALE_MAX; s += SCALE_STEP) {
    const score = correlate(rescaleProfile(a, s), b);
    if (score > bestScore) {
      bestScore = score;
      bestScale = s;
    }
  }
  return { scale: bestScale, score: bestScore };
}

/** How much the scene expanded between two frames, agreed across both axes. */
export function estimateScale(
  a: RawFrame,
  b: RawFrame,
  gridWidth = MOTION_GRID_WIDTH,
  gridHeight = MOTION_GRID_HEIGHT,
): ScaleEstimate {
  const da = downsampleFrame(a, gridWidth, gridHeight);
  const db = downsampleFrame(b, gridWidth, gridHeight);
  const cx = bestScaleOn(columnProfile(da), columnProfile(db));
  const cy = bestScaleOn(rowProfile(da), rowProfile(db));
  // Both axes must move the same way: a pan stretches one and not the other, and calling that
  // "forward" is the false positive this guard exists for.
  const agreed = Math.sign(cx.scale - 1) === Math.sign(cy.scale - 1);
  return { scale: (cx.scale + cy.scale) / 2, score: Math.min(cx.score, cy.score), agreed };
}

/** A sub-rectangle of a frame, in fractions of width/height. */
export function cropFrame(frame: RawFrame, x0: number, y0: number, x1: number, y1: number): RawFrame {
  const px0 = Math.max(0, Math.round(x0 * frame.width));
  const py0 = Math.max(0, Math.round(y0 * frame.height));
  const px1 = Math.min(frame.width, Math.round(x1 * frame.width));
  const py1 = Math.min(frame.height, Math.round(y1 * frame.height));
  const w = Math.max(1, px1 - px0);
  const h = Math.max(1, py1 - py0);
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const src = ((py0 + y) * frame.width + px0) * 4;
    data.set(frame.data.subarray(src, src + w * 4), y * w * 4);
  }
  return { width: w, height: h, data };
}

/**
 * Which way the GROUND moved, measured on the side bands of the lower frame.
 *
 * Whole-frame expansion is too weak to rely on (a follow-camera barely changes scale), and the lower
 * centre is usually the avatar, welded to the viewport. The ground is at the SIDES: under forward
 * motion both bands flow the same way, while a turn drives them apart. The sign convention is pinned
 * by a fixture rather than reasoned about.
 */
export interface GroundFlow {
  readonly dy: number;
  readonly score: number;
  /** The two side bands agreed on direction. A turn makes them disagree. */
  readonly agreed: boolean;
}

function groundBand(frame: RawFrame, x0: number, x1: number): Float64Array {
  return rowProfile(
    downsampleFrame(cropFrame(frame, x0, GROUND_TOP, x1, GROUND_BOTTOM), GROUND_GRID_WIDTH, GROUND_GRID_HEIGHT),
  );
}

/** Which way the ground moved between two frames, agreed across both side bands. */
export function estimateGroundFlow(a: RawFrame, b: RawFrame): GroundFlow {
  const left = bestShift(groundBand(a, 0.02, 0.26), groundBand(b, 0.02, 0.26), GROUND_MAX_SHIFT);
  const right = bestShift(groundBand(a, 0.74, 0.98), groundBand(b, 0.74, 0.98), GROUND_MAX_SHIFT);
  const agreed = Math.sign(left.shift) === Math.sign(right.shift);
  return { dy: (left.shift + right.shift) / 2, score: Math.min(left.score, right.score), agreed };
}

/** The arithmetic mean; 0 for an empty list. */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** The value at fraction `p` of the list; 0 for an empty one. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  return percentileOfSorted(
    values.slice().sort((x, y) => x - y),
    p,
  );
}

/** Least-squares slope of y over x. Used for the heap-growth trend. */
export function linearSlope(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    num += dx * (ys[i] - my);
    den += dx * dx;
  }
  return den > EPSILON ? num / den : 0;
}
