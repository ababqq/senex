/**
 * The report's statistics hold to hand-computed vectors: Wilson intervals, the exact zero-failure
 * bound, Kaplan–Meier with censoring, Mann–Whitney (exact and tie-corrected), Brunner–Munzel,
 * Mantel–Haenszel with its Robins–Breslow–Greenland interval, Holm, the seeded bootstrap (which
 * refuses below n=8), Bradley–Terry by MM, and the paired log ratio of geometric means. Pure and
 * hermetic: no file, clock or network.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BOOTSTRAP_MIN_N,
  bootstrapCi,
  bradleyTerry,
  brunnerMunzel,
  holm,
  kaplanMeier,
  mannWhitney,
  mantelHaenszel,
  median,
  minimumDetectableDifference,
  normalCdf,
  pairedLogRatio,
  quantile,
  ruleOfThreeUpper,
  seededRandom,
  studentTCdf,
  survivalAt,
  tCritical95,
  wilson,
  withinRate,
} from "../../scripts/evals/report/stats.ts";

const close = (actual: number | null | undefined, expected: number, tolerance = 1e-4) => {
  assert.ok(typeof actual === "number", `expected a number, got ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
};

describe("proportions", () => {
  it("gives the Wilson 95% interval of hand-computed vectors", () => {
    const eightOfTen = wilson(8, 10);
    close(eightOfTen.lo, 0.490158);
    close(eightOfTen.hi, 0.943314);
    close(wilson(3, 3).lo, 0.438507);
    close(wilson(6, 6).lo, 0.609637);
    close(wilson(5, 6).lo, 0.436495);
    assert.equal(wilson(0, 4).lo, 0);
    assert.equal(wilson(4, 4).hi, 1);
  });

  it("refuses an impossible proportion", () => {
    assert.throws(() => wilson(9, 8), /passes must be 0\.\.8/);
    assert.throws(() => wilson(0, 0), /positive integer/);
    assert.throws(() => wilson(1.5, 4), /passes must be 0\.\.4/);
  });

  it("uses the exact zero-failure bound, 1 − 0.05^(1/n)", () => {
    close(ruleOfThreeUpper(8), 0.312344);
    close(ruleOfThreeUpper(1), 0.95);
    assert.throws(() => ruleOfThreeUpper(0), /positive integer/);
  });
});

describe("order statistics", () => {
  it("takes medians and type-7 quantiles, and says null for nothing", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([]), null);
    assert.equal(quantile([1, 2, 3, 4], 0.25), 1.75);
    assert.equal(quantile([1, 2, 3, 4], 0.75), 3.25);
  });
});

describe("Kaplan–Meier", () => {
  const observations = [
    { time: 5, event: true },
    { time: 8, event: false },
    { time: 12, event: true },
    { time: 12, event: true },
    { time: 20, event: false },
  ];

  it("steps down at each event, counts censoring, and finds the median", () => {
    const curve = kaplanMeier(observations);
    assert.equal(curve.n, 5);
    assert.equal(curve.events, 3);
    assert.equal(curve.censored, 2);
    assert.deepEqual(
      curve.steps.map((step) => [step.time, step.atRisk, step.events, step.censored]),
      [
        [5, 5, 1, 0],
        [8, 4, 0, 1],
        [12, 3, 2, 0],
        [20, 1, 0, 1],
      ],
    );
    close(curve.steps[0].survival, 0.8);
    close(curve.steps[2].survival, 0.8 / 3);
    assert.equal(curve.median, 12);
  });

  it("answers 'within T' rates from the curve, never from survivors alone", () => {
    const curve = kaplanMeier(observations);
    assert.equal(survivalAt(curve, 4), 1);
    close(withinRate(curve, 10), 0.2);
    close(withinRate(curve, 12), 1 - 0.8 / 3);
  });

  it("has no median when survival never reaches one half", () => {
    const curve = kaplanMeier([
      { time: 5, event: true },
      { time: 6, event: false },
      { time: 7, event: false },
    ]);
    assert.equal(curve.median, null);
  });

  it("takes the first time survival reaches exactly one half", () => {
    const curve = kaplanMeier([
      { time: 1, event: true },
      { time: 2, event: true },
      { time: 3, event: false },
      { time: 4, event: false },
    ]);
    assert.equal(curve.median, 2);
  });

  it("is empty, not zero, with no observations", () => {
    const curve = kaplanMeier([]);
    assert.equal(curve.n, 0);
    assert.equal(curve.median, null);
    assert.deepEqual(curve.steps, []);
  });
});

describe("rank tests", () => {
  it("computes Mann–Whitney U with an exact p-value when there are no ties", () => {
    const separated = mannWhitney([1, 2, 3], [4, 5, 6]);
    assert.equal(separated?.uA, 0);
    assert.equal(separated?.uB, 9);
    assert.equal(separated?.exact, true);
    close(separated?.p, 0.1);
    const interleaved = mannWhitney([1, 3, 5], [2, 4, 6]);
    assert.equal(interleaved?.uA, 3);
    close(interleaved?.p, 0.7);
  });

  it("falls back to the tie-corrected normal approximation with ties", () => {
    const tied = mannWhitney([1, 2, 2], [2, 3, 4]);
    assert.equal(tied?.uA, 1);
    assert.equal(tied?.exact, false);
    close(tied?.p, 0.16415, 1e-3);
    assert.equal(mannWhitney([], [1]), null);
  });

  it("matches the published Brunner–Munzel example", () => {
    const result = brunnerMunzel([1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 2, 4, 1, 1], [3, 3, 4, 3, 1, 2, 3, 1, 1, 5, 4]);
    close(result?.statistic, 3.1374674823029505, 1e-6);
    close(result?.p, 0.0057862086661515377, 1e-5);
    assert.equal(brunnerMunzel([1], [2, 3]), null);
    assert.equal(brunnerMunzel([1, 1], [1, 1]), null);
  });

  it("has the normal and t distributions it rests on", () => {
    close(normalCdf(0), 0.5, 1e-7);
    close(normalCdf(1.959963984540054), 0.975, 1e-6);
    close(studentTCdf(2.365, 7), 0.975, 1e-3);
    close(studentTCdf(0, 3), 0.5, 1e-9);
    assert.equal(tCritical95(1), 12.706);
    assert.equal(tCritical95(7), 2.365);
    assert.equal(tCritical95(45), 2.021);
    assert.equal(tCritical95(500), 1.96);
  });
});

describe("pooled rates", () => {
  it("pools a Mantel–Haenszel odds ratio stratified by case with the RGB interval", () => {
    const pooled = mantelHaenszel([
      { a: 3, b: 1, c: 1, d: 3 },
      { a: 2, b: 2, c: 1, d: 3 },
    ]);
    close(pooled.oddsRatio, 5);
    close(pooled.ci?.lo, 0.579514, 1e-3);
    close(pooled.ci?.hi, 43.138, 1e-2);
    assert.equal(pooled.strata, 2);
  });

  it("has no odds ratio when no stratum is discordant the other way", () => {
    const oneSided = mantelHaenszel([{ a: 3, b: 0, c: 0, d: 3 }]);
    assert.equal(oneSided.oddsRatio, null);
    assert.equal(oneSided.ci, null);
    assert.equal(mantelHaenszel([]).oddsRatio, null);
  });

  it("adjusts p-values by Holm's step-down, monotone and capped at 1", () => {
    const adjusted = holm([0.01, 0.04, 0.03, 0.005]);
    for (const [index, expected] of [0.03, 0.06, 0.06, 0.02].entries()) close(adjusted[index], expected, 1e-12);
    assert.deepEqual(holm([0.5, 0.9]), [1, 1]);
    assert.deepEqual(holm([]), []);
  });
});

describe("resampling", () => {
  it("draws the same sequence from the same seed and another from another", () => {
    const first = seededRandom("seed-a");
    const again = seededRandom("seed-a");
    const other = seededRandom("seed-b");
    const a = [first(), first(), first()];
    assert.deepEqual([again(), again(), again()], a);
    assert.notDeepEqual([other(), other(), other()], a);
    for (const value of a) assert.ok(value >= 0 && value < 1);
  });

  it("refuses a bootstrap below n=8 and is deterministic above it", () => {
    const seven = [1, 2, 3, 4, 5, 6, 7];
    assert.equal(BOOTSTRAP_MIN_N, 8);
    assert.equal(
      bootstrapCi(seven, (values) => median(values) ?? 0, { seed: "s" }),
      null,
    );
    const eight = [1, 2, 3, 4, 5, 6, 7, 8];
    const once = bootstrapCi(eight, (values) => median(values) ?? 0, { seed: "s", resamples: 500 });
    const twice = bootstrapCi(eight, (values) => median(values) ?? 0, { seed: "s", resamples: 500 });
    assert.deepEqual(once, twice);
    assert.ok(once && once.lo <= 4.5 && once.hi >= 4.5);
    assert.deepEqual(
      bootstrapCi([5, 5, 5, 5, 5, 5, 5, 5], (values) => median(values) ?? 0, { seed: "s" }),
      { lo: 5, hi: 5 },
    );
  });
});

describe("Bradley–Terry", () => {
  it("fits the win ratio of two items and normalises to geometric mean one", () => {
    const fit = bradleyTerry(
      ["a", "b"],
      [
        { a: "a", b: "b", scoreA: 1 },
        { a: "a", b: "b", scoreA: 1 },
        { a: "b", b: "a", scoreA: 0 },
        { a: "a", b: "b", scoreA: 0 },
      ],
    );
    close(fit.strengths.a, Math.sqrt(3), 1e-6);
    close(fit.strengths.b, 1 / Math.sqrt(3), 1e-6);
    assert.equal(fit.converged, true);
    assert.deepEqual(fit.degenerate, []);
  });

  it("gives equal strengths to balanced items and names degenerate ones", () => {
    const balanced = bradleyTerry(
      ["a", "b", "c"],
      [
        { a: "a", b: "b", scoreA: 1 },
        { a: "b", b: "a", scoreA: 1 },
        { a: "b", b: "c", scoreA: 0.5 },
        { a: "c", b: "a", scoreA: 0.5 },
      ],
    );
    for (const item of ["a", "b", "c"]) close(balanced.strengths[item], 1, 1e-6);
    const swept = bradleyTerry(["a", "b"], [{ a: "a", b: "b", scoreA: 1 }]);
    assert.deepEqual(swept.degenerate, ["a", "b"]);
  });

  it("adds bootstrap intervals only with at least eight projects, deterministically", () => {
    const projects = Array.from({ length: 8 }, (_, index) => ({ a: "a", b: "b", scoreA: index < 6 ? 1 : 0 }));
    const fit = bradleyTerry(["a", "b"], projects, { seed: "bt", resamples: 200 });
    const again = bradleyTerry(["a", "b"], projects, { seed: "bt", resamples: 200 });
    assert.deepEqual(fit.intervals, again.intervals);
    assert.ok(fit.intervals?.a && fit.intervals.a.lo <= fit.strengths.a && fit.intervals.a.hi >= fit.strengths.a);
    assert.equal(bradleyTerry(["a", "b"], projects.slice(0, 7), { seed: "bt" }).intervals, null);
  });
});

describe("log scale", () => {
  it("reports a paired ratio of geometric means with its t interval", () => {
    const a = [100, 100, 100, 100, 100, 100, 100, 100];
    const b = [200, 200, 200, 200, 100, 100, 100, 100];
    const ratio = pairedLogRatio(a, b);
    close(ratio?.ratio, Math.SQRT2, 1e-6);
    close(ratio?.ci.lo, 1.037461, 1e-4);
    close(ratio?.ci.hi, 1.927809, 1e-4);
  });

  it("refuses a non-positive value instead of taking its log", () => {
    assert.equal(pairedLogRatio([1, 0], [1, 2]), null);
    assert.equal(pairedLogRatio([1], [2]), null);
  });

  it("prints the minimum detectable difference from a within-cell SD", () => {
    close(minimumDetectableDifference(1, 8), (1.959963984540054 + 0.8416212335729143) / Math.sqrt(8), 1e-9);
    assert.equal(minimumDetectableDifference(1, 0), null);
  });
});
