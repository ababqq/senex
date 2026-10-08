/**
 * The prober's pure pixel analysis (`frames.ts`, `png.ts`) on synthetic buffers, with no browser: if
 * a claim the prober makes about a frame cannot be reproduced from a hand-built buffer, it does not
 * belong in `frames.ts`. Ported from genex-demo's `prober/test/frames.test.ts` and the absolute half
 * of `scale.test.ts` (expansion has a sign; a pan is not mistaken for it).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bestShift,
  columnProfile,
  degeneracyReport,
  downsampleFrame,
  estimateMotion,
  estimateScale,
  exposureReport,
  frameDiff,
  linearSlope,
  MIN_SCALE_DELTA,
  MIN_SCALE_SCORE,
  percentile,
  type RawFrame,
  rowProfile,
  srgbLuma,
  tileWeight,
} from "../../scripts/evals/prober/frames.ts";
import { decodePng, encodePng } from "../../scripts/evals/prober/png.ts";
import zlib from "node:zlib";

function blank(width: number, height: number): RawFrame {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

function fill(frame: RawFrame, fn: (x: number, y: number) => [number, number, number]): RawFrame {
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * frame.width + x) * 4;
      frame.data[i] = r;
      frame.data[i + 1] = g;
      frame.data[i + 2] = b;
      frame.data[i + 3] = 255;
    }
  }
  return frame;
}

const flat = (w: number, h: number, v: number) => fill(blank(w, h), () => [v, v, v]);

/** Deterministic pseudo-texture, so "a real-looking frame" is reproducible. */
function noisy(w: number, h: number, seed = 1, base = 120, amp = 100): RawFrame {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
  return fill(blank(w, h), () => {
    const v = Math.max(0, Math.min(255, Math.round(base + (rnd() - 0.5) * amp * 2)));
    return [v, v, v];
  });
}

/**
 * A non-periodic horizontal texture built from a seeded random walk, wrapped so a
 * translation is exact. This is what a shift test should use: real frames are not
 * periodic, and a periodic fixture makes the correlator look broken when it is not.
 */
function landscape(w: number, h: number, seed: number, offset: number): RawFrame {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
  const walk = new Array<number>(w);
  let v = 128;
  for (let x = 0; x < w; x++) {
    v = Math.max(20, Math.min(235, v + (rnd() - 0.5) * 24));
    walk[x] = v;
  }
  return fill(blank(w, h), (x, y) => {
    const src = (((x - offset) % w) + w) % w;
    const value = Math.round(walk[src] * (0.75 + 0.5 * (y / h)));
    const c = Math.max(0, Math.min(255, value));
    return [c, c, c];
  });
}

/** Vertical bars, so a horizontal shift is unambiguous. */
function bars(w: number, h: number, offset: number, period = 16): RawFrame {
  return fill(blank(w, h), (x) => {
    const v = (((x - offset) % period) + period) % period < period / 2 ? 220 : 30;
    return [v, v, v];
  });
}

test("srgbLuma matches Rec.709 on the primaries", () => {
  assert.equal(srgbLuma(0, 0, 0), 0);
  assert.ok(Math.abs(srgbLuma(255, 255, 255) - 1) < 1e-12);
  assert.ok(Math.abs(srgbLuma(255, 0, 0) - 0.2126) < 1e-9);
  assert.ok(Math.abs(srgbLuma(0, 255, 0) - 0.7152) < 1e-9);
  assert.ok(Math.abs(srgbLuma(0, 0, 255) - 0.0722) < 1e-9);
});

test("a flat frame is degenerate; a textured frame is not", () => {
  const flatReport = degeneracyReport(flat(64, 36, 128));
  assert.equal(flatReport.degenerate, true);
  assert.equal(flatReport.distinctColors, 1);
  assert.equal(flatReport.dominantColorFraction, 1);
  assert.ok(flatReport.reasons.length >= 2, "a flat frame trips more than one reason");

  const real = degeneracyReport(noisy(64, 36));
  assert.equal(real.degenerate, false);
  assert.ok(real.distinctColors > 10);
  assert.ok(real.lumStdDev > 0.01);
});

test("a near-flat gradient is still degenerate (this is the case a colour count alone misses)", () => {
  const gradient = fill(blank(64, 36), (_x, y) => {
    const v = 100 + Math.floor(y / 24); // spans 2 values over the whole frame
    return [v, v, v];
  });
  const report = degeneracyReport(gradient);
  assert.equal(report.degenerate, true);
  assert.ok(report.reasons.some((r) => r.includes("flat")) || report.reasons.some((r) => r.includes("distinct")));
});

test("a dark frame reports a low mean but keeps its tonal range separate", () => {
  const dark = noisy(64, 36, 7, 10, 8);
  const report = exposureReport(dark);
  assert.ok(report.mean < 0.08, `mean was ${report.mean}`);
  assert.ok(report.tonalRange > 0, "a dark frame still has a tonal range");
  assert.ok(report.contrast > 0);
  // The linear mean is far below the sRGB mean in shadow: both are reported for a reason.
  assert.ok(report.meanLinear < report.mean);
});

test("a high-contrast frame separates contrast from mean", () => {
  const checker = fill(blank(64, 36), (x, y) => {
    const v = (x + y) % 2 === 0 ? 255 : 0;
    return [v, v, v];
  });
  const report = exposureReport(checker);
  assert.ok(Math.abs(report.mean - 0.5) < 0.02, `mean was ${report.mean}`);
  assert.ok(report.contrast > 0.45, `contrast was ${report.contrast}`);
  assert.ok(report.tonalRange > 0.9);
  assert.ok(report.michelson > 0.9);
  assert.ok(report.clippedBlackFraction > 0.4 && report.clippedWhiteFraction > 0.4);
});

test("a whole-frame mean hides a sky-and-floor split; the tiles do not", () => {
  // Top half bright, bottom half dark: the exact defect a single number cannot show.
  const skyFloor = fill(blank(64, 36), (_x, y) => (y < 18 ? [230, 230, 230] : [12, 12, 12]));
  const report = exposureReport(skyFloor);
  assert.ok(Math.abs(report.mean - 0.47) < 0.06, `mean was ${report.mean}`);
  assert.ok(report.tileSpread > 0.8, `tileSpread was ${report.tileSpread}`);
  assert.equal(report.tiles.length, 16);
  const topRow = report.tiles.filter((t) => t.iy === 0);
  const bottomRow = report.tiles.filter((t) => t.iy === 3);
  assert.ok(topRow.every((t) => t.mean > 0.85));
  assert.ok(bottomRow.every((t) => t.mean < 0.1));
});

test("centre weighting favours the middle tiles", () => {
  const centre = tileWeight(1, 1, 4, 4);
  const corner = tileWeight(0, 0, 4, 4);
  assert.ok(centre > corner * 3, `${centre} vs ${corner}`);

  // A frame that is bright only in the centre reads brighter centre-weighted than flat-averaged.
  const centreBright = fill(blank(64, 36), (x, y) =>
    x >= 16 && x < 48 && y >= 9 && y < 27 ? [220, 220, 220] : [20, 20, 20],
  );
  const report = exposureReport(centreBright);
  assert.ok(report.centreWeightedMean > report.mean, `${report.centreWeightedMean} vs ${report.mean}`);
});

test("a frame that differs in exactly one tile is caught by the tiles and nearly invisible in the mean", () => {
  const base = flat(64, 36, 100);
  const patched: RawFrame = { width: 64, height: 36, data: Uint8Array.from(base.data) };
  // Repaint one 4x4 tile (columns 48..63, rows 27..35) to white.
  for (let y = 27; y < 36; y++) {
    for (let x = 48; x < 64; x++) {
      const i = (y * 64 + x) * 4;
      patched.data[i] = 255;
      patched.data[i + 1] = 255;
      patched.data[i + 2] = 255;
    }
  }
  const a = exposureReport(base);
  const b = exposureReport(patched);
  assert.ok(Math.abs(b.mean - a.mean) < 0.05, "the whole-frame mean barely moves");

  const corner = (r: typeof a) => r.tiles.find((t) => t.ix === 3 && t.iy === 3)?.mean ?? Number.NaN;
  assert.ok(Math.abs(corner(b) - corner(a)) > 0.5, "the tile that changed moves a lot");

  const changedTiles = a.tiles.filter((t, i) => Math.abs(t.mean - b.tiles[i].mean) > 0.1);
  assert.equal(changedTiles.length, 1, "exactly one of the sixteen tiles changed");

  const diff = frameDiff(base, patched);
  assert.ok(diff.changedFraction > 0.05 && diff.changedFraction < 0.1, `changedFraction ${diff.changedFraction}`);
});

test("frameDiff is zero for identical frames and grows with the change", () => {
  const a = noisy(64, 36, 3);
  assert.deepEqual(frameDiff(a, a).meanAbs, 0);
  assert.equal(frameDiff(a, a).changedFraction, 0);

  const b = noisy(64, 36, 4);
  const big = frameDiff(a, b);
  assert.ok(big.meanAbs > 0.05, `meanAbs ${big.meanAbs}`);
  assert.ok(big.changedFraction > 0.5);

  assert.throws(() => frameDiff(a, flat(32, 18, 0)), /size mismatch/);
});

test("a tiny ambient wobble reads far below a real change — the idle-drift baseline works", () => {
  const idleA = noisy(64, 36, 11, 120, 60);
  const idleB: RawFrame = { width: 64, height: 36, data: Uint8Array.from(idleA.data) };
  for (let i = 0; i < idleB.data.length; i += 4) idleB.data[i + 1] = Math.min(255, idleB.data[i + 1] + 2);
  const ambient = frameDiff(idleA, idleB).meanAbs;

  const moved = bars(64, 36, 9);
  const rest = bars(64, 36, 0);
  const response = frameDiff(rest, moved).meanAbs;
  assert.ok(response > ambient * 20, `ambient ${ambient} vs response ${response}`);
});

test("bestShift recovers a known 1-D translation with the right sign", () => {
  const a = columnProfile(bars(128, 32, 0));
  const right = columnProfile(bars(128, 32, 7));
  const left = columnProfile(bars(128, 32, -7));
  // Bars are periodic with period 16, so the search window is kept inside one period.
  assert.equal(bestShift(a, right, 7).shift, 7);
  assert.equal(bestShift(a, left, 7).shift, -7);
  assert.equal(bestShift(a, a, 7).shift, 0);
  assert.ok(bestShift(a, a, 7).score > 0.99);
});

test("estimateMotion gives opposite signs for opposite movement (the only claim the prober makes)", () => {
  // A non-periodic texture, because a periodic one aliases: a repeating pattern
  // correlates equally well at every multiple of its period, and no correlator can
  // tell those apart. Real scenes are not periodic; this fixture must not be either.
  const rest = landscape(320, 180, 5, 0);
  const movedRight = landscape(320, 180, 5, 32);
  const movedLeft = landscape(320, 180, 5, -32);
  const right = estimateMotion(rest, movedRight);
  const left = estimateMotion(rest, movedLeft);
  assert.ok(right.dx > 0, `dx ${right.dx}`);
  assert.ok(left.dx < 0, `dx ${left.dx}`);
  assert.equal(right.dx, 16, "a 32px shift at 320 wide is 16 columns on the 160-wide grid");
  assert.equal(left.dx, -16);
  assert.ok(right.dxScore > 0.8 && left.dxScore > 0.8);
});

test("a periodic texture aliases, and the prober is honest that it cannot resolve one", () => {
  // Kept as a test rather than a footnote: bars with period 40 shifted by 20 are
  // indistinguishable from a shift of -20, so the magnitude is not trustworthy there.
  const rest = bars(320, 180, 0, 40);
  const moved = bars(320, 180, 20, 40);
  const motion = estimateMotion(rest, moved);
  assert.ok(motion.dxScore > 0.9, "it correlates perfectly...");
  assert.ok(Math.abs(motion.dx) % 10 === 0, "...at an aliased multiple of the half-period");
});

test("estimateMotion reports a low correlation when the frames share no structure", () => {
  const a = noisy(320, 180, 21);
  const b = noisy(320, 180, 22);
  const motion = estimateMotion(a, b);
  assert.ok(motion.dxScore < 0.4, `dxScore ${motion.dxScore}`);
});

test("rowProfile detects vertical movement the same way", () => {
  const stripes = (offset: number) =>
    fill(blank(64, 128), (_x, y) => {
      const v = (((y - offset) % 32) + 32) % 32 < 16 ? 220 : 30;
      return [v, v, v];
    });
  assert.equal(bestShift(rowProfile(stripes(0)), rowProfile(stripes(9)), 15).shift, 9);
});

test("downsampleFrame preserves mean brightness", () => {
  const src = noisy(320, 180, 5, 140, 90);
  const small = downsampleFrame(src, 64, 36);
  assert.equal(small.width, 64);
  assert.equal(small.height, 36);
  assert.ok(Math.abs(exposureReport(small).mean - exposureReport(src).mean) < 0.02);
});

test("percentile and linearSlope behave", () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(percentile([], 0.5), 0);
  assert.ok(Math.abs(linearSlope([0, 1, 2, 3], [10, 20, 30, 40]) - 10) < 1e-9);
  assert.equal(linearSlope([1], [1]), 0);
});

test("the PNG round-trip the prober depends on is lossless", () => {
  const src = noisy(37, 23, 99, 130, 110);
  const decoded = decodePng(encodePng(src));
  assert.equal(decoded.width, 37);
  assert.equal(decoded.height, 23);
  assert.deepEqual(Array.from(decoded.data), Array.from(src.data));
});

test("decodePng refuses a buffer that is not a PNG rather than returning noise", () => {
  assert.throws(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])), /bad signature/);
});

/* ------------------------------------------------------------ expansion */

const W = 320;
const H = 180;

/** A textured scene, resampled about its centre by `scale`. */
function scene(scale: number): RawFrame {
  const data = new Uint8Array(W * H * 4);
  const cx = (W - 1) / 2;
  const cy = (H - 1) / 2;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const sx = cx + (x - cx) / scale;
      const sy = cy + (y - cy) / scale;
      const v = (Math.sin(sx / 7) * 0.5 + 0.5) * (Math.cos(sy / 11) * 0.5 + 0.5);
      const b = Math.round(v * 255);
      const i = (y * W + x) * 4;
      data[i] = b;
      data[i + 1] = b;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

function pannedRight(px: number): RawFrame {
  const f = scene(1);
  const d = new Uint8Array(f.data);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const sx = Math.min(W - 1, x + px);
      for (let k = 0; k < 4; k += 1) d[(y * W + x) * 4 + k] = f.data[(y * W + sx) * 4 + k];
    }
  }
  return { width: W, height: H, data: d };
}

const usable = (r: ReturnType<typeof estimateScale>) => r.agreed && r.score >= MIN_SCALE_SCORE;
const moved = (r: ReturnType<typeof estimateScale>) => Math.abs(r.scale - 1) >= MIN_SCALE_DELTA;

test("a scene that grows reads as expansion — the signal for moving forward", () => {
  const r = estimateScale(scene(1), scene(1.06));
  assert.ok(usable(r), "expansion must be usable");
  assert.ok(moved(r) && r.scale > 1, `expected expansion, got ${r.scale}`);
});

test("a scene that shrinks reads as contraction — the signal for moving back", () => {
  const r = estimateScale(scene(1), scene(0.94));
  assert.ok(usable(r), "contraction must be usable");
  assert.ok(moved(r) && r.scale < 1, `expected contraction, got ${r.scale}`);
});

test("AN INVERTED PROJECT IS DISTINGUISHABLE — the defect the pair tests could not see", () => {
  // Correct: W grows the world, S shrinks it.
  const wOk = estimateScale(scene(1), scene(1.06));
  const sOk = estimateScale(scene(1), scene(0.94));
  assert.ok(wOk.scale - 1 > 0 && sOk.scale - 1 < 0, "the correct wiring must read as forward");

  // Inverted: the SAME two observations with the keys swapped. Every pair test
  // still passes here — the shifts are still opposite — which is exactly how
  // this shipped.
  const wBad = sOk;
  const sBad = wOk;
  assert.ok(wBad.scale - 1 < 0 && sBad.scale - 1 > 0, "the inverted wiring must be detectable");
});

test("a pure pan is NOT mistaken for forward or backward motion", () => {
  const r = estimateScale(scene(1), pannedRight(6));
  assert.ok(!usable(r) || !moved(r), `a pan must not read as forward/back (scale ${r.scale}, score ${r.score})`);
});

test("a static scene reports no motion rather than a direction", () => {
  const r = estimateScale(scene(1), scene(1));
  assert.ok(!moved(r), `static must not move (scale ${r.scale})`);
});

test("decodePng reads a palette PNG and a grayscale PNG the way it reads RGBA", () => {
  const chunk = (type: string, body: Buffer) => {
    const out = Buffer.alloc(body.length + 12);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, "ascii");
    body.copy(out, 8);
    return out;
  };
  const png = (colorType: number, rows: number[][], extra: Buffer[] = []) => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(rows[0].length, 0);
    ihdr.writeUInt32BE(rows.length, 4);
    ihdr[8] = 8;
    ihdr[9] = colorType;
    const raw = Buffer.concat(rows.map((r) => Buffer.from([0, ...r])));
    const idat = chunk("IDAT", zlib.deflateSync(raw));
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return new Uint8Array(Buffer.concat([sig, chunk("IHDR", ihdr), ...extra, idat, chunk("IEND", Buffer.alloc(0))]));
  };
  const gray = decodePng(png(0, [[0, 128, 255]]));
  assert.deepEqual(Array.from(gray.data), [0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]);
  const plte = chunk("PLTE", Buffer.from([10, 20, 30, 200, 100, 50]));
  const palette = decodePng(png(3, [[1, 0]], [plte]));
  assert.deepEqual(Array.from(palette.data), [200, 100, 50, 255, 10, 20, 30, 255]);
});
