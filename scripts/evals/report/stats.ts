/**
 * The report's statistics (§10.2): pure, deterministic and dependency-free. Proportions get Wilson
 * intervals and the exact zero-failure bound; times get Kaplan–Meier curves with censoring; cells
 * get descriptive rank tests; rates pool by Mantel–Haenszel across cases; primaries get Holm;
 * intervals from resampling use a seeded generator and refuse below `BOOTSTRAP_MIN_N`. Every
 * probability is a fraction in [0, 1]; the renderers turn fractions into percentages.
 */

/** The two-sided 95% normal quantile. */
export const Z95 = 1.959963984540054;
/** The one-sided 80% normal quantile: the power term of the minimum detectable difference. */
const Z_POWER_80 = 0.8416212335729143;
/** A bootstrap interval is only printed at or above this many values (§10.2). */
export const BOOTSTRAP_MIN_N = 8;
/** Resamples per bootstrap interval unless the caller asks for another count. */
export const BOOTSTRAP_RESAMPLES = 2000;
/** The exact Mann–Whitney distribution is enumerated up to this many cells (m × n). */
const EXACT_MANN_WHITNEY_MAX_CELLS = 400;
/** Bradley–Terry MM iterations before giving up on convergence. */
const BRADLEY_TERRY_MAX_ITERATIONS = 10_000;
/** Bradley–Terry convergence: the largest change in any log-strength. */
const BRADLEY_TERRY_TOLERANCE = 1e-10;
/** Continued-fraction iterations for the incomplete beta function. */
const BETA_CF_MAX_ITERATIONS = 300;
const BETA_CF_EPSILON = 3e-16;
const FLOAT_FLOOR = 1e-300;

/** A closed interval as fractions or values, low end first. */
export interface Interval {
  lo: number;
  hi: number;
}

function assertPositiveInteger(n: number, what: string): void {
  if (!Number.isInteger(n) || n <= 0) throw new TypeError(`${what}: n must be a positive integer, got ${n}`);
}

/** The Wilson score interval for `passes` of `n`, as fractions. */
export function wilson(passes: number, n: number, z = Z95): Interval {
  assertPositiveInteger(n, "wilson");
  if (!Number.isInteger(passes) || passes < 0 || passes > n) {
    throw new TypeError(`wilson: passes must be 0..${n}, got ${passes}`);
  }
  const p = passes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lo: Math.max(0, centre - margin), hi: Math.min(1, centre + margin) };
}

/** The exact one-sided 95% upper bound on a failure rate after `n` clean runs: `1 − 0.05^(1/n)`. */
export function ruleOfThreeUpper(n: number): number {
  assertPositiveInteger(n, "ruleOfThreeUpper");
  return 1 - 0.05 ** (1 / n);
}

/** The type-7 (linear) quantile of the values; null for no values. */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const position = (sorted.length - 1) * q;
  const below = Math.floor(position);
  const above = Math.ceil(position);
  return sorted[below] + (sorted[above] - sorted[below]) * (position - below);
}

/** The median; null for no values (never zero). */
export function median(values: readonly number[]): number | null {
  return quantile(values, 0.5);
}

/** The arithmetic mean; null for no values. */
export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** The sample standard deviation (n − 1); null below two values. */
export function sampleSd(values: readonly number[]): number | null {
  const centre = mean(values);
  if (centre === null || values.length < 2) return null;
  const squares = values.reduce((sum, value) => sum + (value - centre) ** 2, 0);
  return Math.sqrt(squares / (values.length - 1));
}

/** One time-to-event observation: `event` false means censored at `time` (a rail cut the run). */
export interface KmObservation {
  time: number;
  event: boolean;
}

/** One distinct time on a Kaplan–Meier curve. */
export interface KmStep {
  time: number;
  atRisk: number;
  events: number;
  censored: number;
  /** S(t) just after this time. */
  survival: number;
}

/** A Kaplan–Meier curve with its censored count beside it (never a median over survivors alone). */
export interface KmCurve {
  n: number;
  events: number;
  censored: number;
  steps: KmStep[];
  /** The first time S(t) ≤ 0.5; null when survival never gets there. */
  median: number | null;
}

/** The Kaplan–Meier estimate; at a shared time, events are taken before censorings. */
export function kaplanMeier(observations: readonly KmObservation[]): KmCurve {
  const times = [...new Set(observations.map((o) => o.time))].sort((x, y) => x - y);
  let atRisk = observations.length;
  let survival = 1;
  const steps: KmStep[] = [];
  for (const time of times) {
    const here = observations.filter((o) => o.time === time);
    const events = here.filter((o) => o.event).length;
    survival *= events > 0 ? 1 - events / atRisk : 1;
    steps.push({ time, atRisk, events, censored: here.length - events, survival });
    atRisk -= here.length;
  }
  const events = observations.filter((o) => o.event).length;
  const medianStep = steps.find((step) => step.events > 0 && step.survival <= 0.5);
  return {
    n: observations.length,
    events,
    censored: observations.length - events,
    steps,
    median: medianStep?.time ?? null,
  };
}

/** S(t): the share still without the event at time `t`. */
export function survivalAt(curve: KmCurve, time: number): number {
  let survival = 1;
  for (const step of curve.steps) {
    if (step.time > time) break;
    survival = step.survival;
  }
  return survival;
}

/** The "within T" rate: the estimated share that reached the event by `t` (1 − S(t)). */
export function withinRate(curve: KmCurve, time: number): number {
  return 1 - survivalAt(curve, time);
}

/** Mid-ranks of the values (1-based), ties sharing the average rank. */
export function midRanks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((x, y) => x.value - y.value);
  const ranks = new Array<number>(values.length);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && order[end + 1].value === order[start].value) end += 1;
    const rank = (start + end) / 2 + 1;
    for (let k = start; k <= end; k += 1) ranks[order[k].index] = rank;
    start = end + 1;
  }
  return ranks;
}

function tieGroups(values: readonly number[]): number[] {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.values()];
}

/** A descriptive Mann–Whitney result: U for each sample and a two-sided p. */
export interface MannWhitney {
  uA: number;
  uB: number;
  p: number;
  /** True when p comes from the exact distribution (no ties, small samples). */
  exact: boolean;
}

/** The number of arrangements giving each U for samples of size m and n. */
function mannWhitneyCounts(m: number, n: number): number[] {
  // table[i][j] is the U-count distribution for sizes (i, j).
  const table: number[][][] = [];
  for (let i = 0; i <= m; i += 1) {
    table.push([]);
    for (let j = 0; j <= n; j += 1) {
      if (i === 0 || j === 0) {
        table[i].push([1]);
        continue;
      }
      const counts = new Array<number>(i * j + 1).fill(0);
      table[i - 1][j].forEach((count, u) => {
        counts[u + j] += count;
      });
      table[i][j - 1].forEach((count, u) => {
        counts[u] += count;
      });
      table[i].push(counts);
    }
  }
  return table[m][n];
}

function exactMannWhitneyP(uA: number, m: number, n: number): number {
  const counts = mannWhitneyCounts(m, n);
  const total = counts.reduce((sum, count) => sum + count, 0);
  const lower = counts.slice(0, Math.floor(uA) + 1).reduce((sum, count) => sum + count, 0) / total;
  const upper = counts.slice(Math.ceil(uA)).reduce((sum, count) => sum + count, 0) / total;
  return Math.min(1, 2 * Math.min(lower, upper));
}

/** Mann–Whitney U, two-sided; exact without ties on small samples, else normal with tie and continuity corrections. */
export function mannWhitney(a: readonly number[], b: readonly number[]): MannWhitney | null {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return null;
  const all = [...a, ...b];
  const ranks = midRanks(all);
  const rankSumA = ranks.slice(0, m).reduce((sum, rank) => sum + rank, 0);
  const uA = rankSumA - (m * (m + 1)) / 2;
  const uB = m * n - uA;
  const ties = tieGroups(all);
  const hasTies = ties.some((count) => count > 1);
  if (!hasTies && m * n <= EXACT_MANN_WHITNEY_MAX_CELLS) {
    return { uA, uB, p: exactMannWhitneyP(uA, m, n), exact: true };
  }
  const total = m + n;
  const tieTerm = ties.reduce((sum, t) => sum + (t ** 3 - t), 0) / (total * (total - 1));
  const variance = ((m * n) / 12) * (total + 1 - tieTerm);
  if (variance <= 0) return { uA, uB, p: 1, exact: false };
  const z = Math.max(0, Math.abs(uA - (m * n) / 2) - 0.5) / Math.sqrt(variance);
  return { uA, uB, p: Math.min(1, 2 * (1 - normalCdf(z))), exact: false };
}

/** The complementary error function (Numerical Recipes' Chebyshev fit; fractional error below 1.2e-7). */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const poly =
    -1.26551223 +
    t *
      (1.00002368 +
        t *
          (0.37409196 +
            t *
              (0.09678418 +
                t *
                  (-0.18628806 +
                    t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))));
  const value = t * Math.exp(-z * z + poly);
  return x >= 0 ? value : 2 - value;
}

/** The standard normal CDF. */
export function normalCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2);
}

/** ln Γ(x) by Lanczos (g = 7, n = 9). */
function logGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const shifted = x - 1;
  let sum = c[0];
  for (let i = 1; i < c.length; i += 1) sum += c[i] / (shifted + i);
  const t = shifted + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** The continued fraction of the incomplete beta function (Numerical Recipes `betacf`). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const floor = (value: number) => (Math.abs(value) < FLOAT_FLOOR ? FLOAT_FLOOR : value);
  let c = 1;
  let d = 1 / floor(1 - ((a + b) * x) / (a + 1));
  let h = d;
  for (let m = 1; m <= BETA_CF_MAX_ITERATIONS; m += 1) {
    const even = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 / floor(1 + even * d);
    c = floor(1 + even / c);
    h *= d * c;
    const odd = (-(a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 / floor(1 + odd * d);
    c = floor(1 + odd / c);
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < BETA_CF_EPSILON) break;
  }
  return h;
}

/** The regularized incomplete beta function I_x(a, b). */
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a;
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Student's t CDF with `df` degrees of freedom (df may be fractional, as Welch-type tests need). */
export function studentTCdf(t: number, df: number): number {
  const tail = 0.5 * incompleteBeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

/** Two-sided 95% t critical values: exact for df 1..30, then the nearest lower tabulated df, then the normal limit past 120. */
export function tCritical95(df: number): number {
  const exact = [
    12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11,
    2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
  ];
  if (!Number.isInteger(df) || df < 1) throw new TypeError(`tCritical95: df must be an integer ≥ 1, got ${df}`);
  if (df <= 30) return exact[df - 1];
  if (df > 120) return 1.96;
  const table: readonly (readonly [number, number])[] = [
    [120, 1.98],
    [100, 1.984],
    [80, 1.99],
    [60, 2.0],
    [50, 2.009],
    [40, 2.021],
    [35, 2.03],
  ];
  return table.find(([threshold]) => df >= threshold)?.[1] ?? 2.042;
}

/** A Brunner–Munzel result: the statistic, its Welch-type df, a two-sided p and P(A < B) + ½P(A = B). */
export interface BrunnerMunzel {
  statistic: number;
  df: number;
  p: number;
  pHat: number;
}

function placementVariance(combinedRanks: readonly number[], withinRanks: readonly number[]): number {
  const n = withinRanks.length;
  const centre = (mean(combinedRanks) ?? 0) - (n + 1) / 2;
  const squares = combinedRanks.reduce((sum, rank, i) => sum + (rank - withinRanks[i] - centre) ** 2, 0);
  return squares / (n - 1);
}

/** The Brunner–Munzel test (descriptive); null below two values per side or with zero variance. */
export function brunnerMunzel(a: readonly number[], b: readonly number[]): BrunnerMunzel | null {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 < 2 || n2 < 2) return null;
  const ranks = midRanks([...a, ...b]);
  const ranksA = ranks.slice(0, n1);
  const ranksB = ranks.slice(n1);
  const varianceA = placementVariance(ranksA, midRanks(a));
  const varianceB = placementVariance(ranksB, midRanks(b));
  const pooled = n1 * varianceA + n2 * varianceB;
  if (pooled === 0) return null;
  const meanA = mean(ranksA) ?? 0;
  const meanB = mean(ranksB) ?? 0;
  const statistic = (n1 * n2 * (meanB - meanA)) / ((n1 + n2) * Math.sqrt(pooled));
  const df = pooled ** 2 / ((n1 * varianceA) ** 2 / (n1 - 1) + (n2 * varianceB) ** 2 / (n2 - 1));
  const cdf = studentTCdf(statistic, df);
  return { statistic, df, p: Math.min(1, 2 * Math.min(cdf, 1 - cdf)), pHat: (meanB - meanA) / (n1 + n2) + 0.5 };
}

/** One case's 2×2 table: `a`/`b` successes and failures in the first cell, `c`/`d` in the second. */
export interface Stratum {
  a: number;
  b: number;
  c: number;
  d: number;
}

/** A pooled odds ratio; null when the pool has no discordance the other way. */
export interface MantelHaenszel {
  oddsRatio: number | null;
  ci: Interval | null;
  strata: number;
}

/** The Mantel–Haenszel odds ratio stratified by case, with the Robins–Breslow–Greenland 95% interval. */
export function mantelHaenszel(strata: readonly Stratum[]): MantelHaenszel {
  let sumR = 0;
  let sumS = 0;
  let sumPR = 0;
  let sumMixed = 0;
  let sumQS = 0;
  const used = strata.filter((s) => s.a + s.b + s.c + s.d > 0);
  for (const { a, b, c, d } of used) {
    const n = a + b + c + d;
    const [p, q, r, s] = [(a + d) / n, (b + c) / n, (a * d) / n, (b * c) / n];
    sumR += r;
    sumS += s;
    sumPR += p * r;
    sumMixed += p * s + q * r;
    sumQS += q * s;
  }
  if (sumR === 0 || sumS === 0) return { oddsRatio: null, ci: null, strata: used.length };
  const oddsRatio = sumR / sumS;
  const variance = sumPR / (2 * sumR ** 2) + sumMixed / (2 * sumR * sumS) + sumQS / (2 * sumS ** 2);
  const half = Z95 * Math.sqrt(variance);
  const log = Math.log(oddsRatio);
  return { oddsRatio, ci: { lo: Math.exp(log - half), hi: Math.exp(log + half) }, strata: used.length };
}

/** Holm step-down adjusted p-values, in the input order, monotone and capped at 1. */
export function holm(pValues: readonly number[]): number[] {
  const m = pValues.length;
  const order = pValues.map((p, index) => ({ p, index })).sort((x, y) => x.p - y.p);
  const adjusted = new Array<number>(m);
  let running = 0;
  order.forEach(({ p, index }, rank) => {
    running = Math.max(running, Math.min(1, (m - rank) * p));
    adjusted[index] = running;
  });
  return adjusted;
}

/** FNV-1a over the seed's UTF-16 code units: a 32-bit state for the generator. */
function seedState(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** A deterministic uniform generator in [0, 1) from a string seed (mulberry32). */
export function seededRandom(seed: string): () => number {
  let state = seedState(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How a seeded resampling runs. */
export interface ResampleOptions {
  seed: string;
  resamples?: number;
  /** Coverage, 0.95 unless given. */
  level?: number;
}

function resample<T>(values: readonly T[], random: () => number): T[] {
  return values.map(() => values[Math.floor(random() * values.length)]);
}

function percentileInterval(estimates: readonly number[], level: number): Interval {
  const tail = (1 - level) / 2;
  return { lo: quantile(estimates, tail) ?? Number.NaN, hi: quantile(estimates, 1 - tail) ?? Number.NaN };
}

/** A seeded percentile bootstrap interval of `statistic`; null below `BOOTSTRAP_MIN_N` values. */
export function bootstrapCi(
  values: readonly number[],
  statistic: (values: readonly number[]) => number,
  options: ResampleOptions,
): Interval | null {
  if (values.length < BOOTSTRAP_MIN_N) return null;
  const random = seededRandom(options.seed);
  const count = options.resamples ?? BOOTSTRAP_RESAMPLES;
  const estimates = Array.from({ length: count }, () => statistic(resample(values, random)));
  return percentileInterval(estimates, options.level ?? 0.95);
}

/** One Bradley–Terry project: `scoreA` is 1 when `a` won, 0 when `b` won, 0.5 for a tie. */
export interface BtProject {
  a: string;
  b: string;
  scoreA: number;
}

/** A Bradley–Terry fit: strengths normalised to geometric mean 1, so P(i beats j) = sᵢ / (sᵢ + sⱼ). */
export interface BradleyTerry {
  strengths: Record<string, number>;
  /** Percentile bootstrap intervals over resampled projects; null below `BOOTSTRAP_MIN_N` projects or without a seed. */
  intervals: Record<string, Interval> | null;
  converged: boolean;
  iterations: number;
  /** Items with no wins or no losses: their MLE is at the boundary and the strength is not identifiable. */
  degenerate: string[];
}

function winsAndMeetings(items: readonly string[], projects: readonly BtProject[]) {
  const wins = new Map(items.map((item) => [item, 0]));
  const losses = new Map(items.map((item) => [item, 0]));
  const meetings = new Map<string, number>();
  const key = (x: string, y: string) => `${x}\u0000${y}`;
  for (const project of projects) {
    wins.set(project.a, (wins.get(project.a) ?? 0) + project.scoreA);
    wins.set(project.b, (wins.get(project.b) ?? 0) + 1 - project.scoreA);
    losses.set(project.a, (losses.get(project.a) ?? 0) + 1 - project.scoreA);
    losses.set(project.b, (losses.get(project.b) ?? 0) + project.scoreA);
    meetings.set(key(project.a, project.b), (meetings.get(key(project.a, project.b)) ?? 0) + 1);
    meetings.set(key(project.b, project.a), (meetings.get(key(project.b, project.a)) ?? 0) + 1);
  }
  const met = (x: string, y: string) => meetings.get(key(x, y)) ?? 0;
  return { wins, losses, met };
}

function normaliseGeometric(strengths: Map<string, number>): Map<string, number> {
  const positive = [...strengths.values()].filter((value) => value > 0);
  const logMean = positive.reduce((sum, value) => sum + Math.log(value), 0) / Math.max(1, positive.length);
  const scale = Math.exp(logMean);
  return new Map([...strengths].map(([item, value]) => [item, value / scale]));
}

/** The MM iterations (Hunter 2004) of the Bradley–Terry maximum likelihood. */
function fitStrengths(items: readonly string[], projects: readonly BtProject[]) {
  const { wins, losses, met } = winsAndMeetings(items, projects);
  let strengths = new Map(items.map((item) => [item, 1]));
  for (let iteration = 1; iteration <= BRADLEY_TERRY_MAX_ITERATIONS; iteration += 1) {
    const next = new Map<string, number>();
    for (const item of items) {
      const own = strengths.get(item) ?? 1;
      const denominator = items
        .filter((other) => other !== item)
        .reduce((sum, other) => sum + met(item, other) / (own + (strengths.get(other) ?? 1)), 0);
      next.set(item, denominator > 0 ? (wins.get(item) ?? 0) / denominator : own);
    }
    const normalised = normaliseGeometric(next);
    const change = Math.max(...items.map((item) => logDistance(normalised.get(item), strengths.get(item))));
    strengths = normalised;
    if (change < BRADLEY_TERRY_TOLERANCE) return { strengths, converged: true, iterations: iteration, wins, losses };
  }
  return { strengths, converged: false, iterations: BRADLEY_TERRY_MAX_ITERATIONS, wins, losses };
}

function logDistance(x: number | undefined, y: number | undefined): number {
  if (!x || !y) return x === y ? 0 : Number.POSITIVE_INFINITY;
  return Math.abs(Math.log(x) - Math.log(y));
}

function bradleyTerryIntervals(
  items: readonly string[],
  projects: readonly BtProject[],
  options: ResampleOptions,
): Record<string, Interval> {
  const random = seededRandom(options.seed);
  const draws = new Map(items.map((item) => [item, [] as number[]]));
  for (let i = 0; i < (options.resamples ?? BOOTSTRAP_RESAMPLES); i += 1) {
    const fit = fitStrengths(items, resample(projects, random));
    for (const item of items) draws.get(item)?.push(fit.strengths.get(item) ?? 0);
  }
  const level = options.level ?? 0.95;
  return Object.fromEntries(items.map((item) => [item, percentileInterval(draws.get(item) ?? [], level)]));
}

/** A Bradley–Terry fit over pairwise projects, with seeded bootstrap intervals when `resampling` is given. */
export function bradleyTerry(
  items: readonly string[],
  projects: readonly BtProject[],
  resampling?: ResampleOptions,
): BradleyTerry {
  const fit = fitStrengths(items, projects);
  const degenerate = items.filter((item) => (fit.wins.get(item) ?? 0) === 0 || (fit.losses.get(item) ?? 0) === 0);
  const canResample = resampling !== undefined && projects.length >= BOOTSTRAP_MIN_N;
  return {
    strengths: Object.fromEntries(fit.strengths),
    intervals: canResample ? bradleyTerryIntervals(items, projects, resampling) : null,
    converged: fit.converged,
    iterations: fit.iterations,
    degenerate,
  };
}

/** A paired ratio of geometric means (B over A) with its 95% t interval. */
export interface LogRatio {
  ratio: number;
  ci: Interval;
  n: number;
  /** The SD of the log differences; 0 makes the interval degenerate, not precise. */
  sdLog: number;
}

/** The ratio of geometric means of paired positive values (b over a); null for a non-positive value or n < 2. */
export function pairedLogRatio(a: readonly number[], b: readonly number[]): LogRatio | null {
  const n = a.length;
  const positive = [...a, ...b].every((value) => Number.isFinite(value) && value > 0);
  if (n < 2 || b.length !== n || !positive) return null;
  const differences = a.map((value, i) => Math.log(b[i]) - Math.log(value));
  const centre = mean(differences) ?? 0;
  const sdLog = sampleSd(differences) ?? 0;
  const half = tCritical95(n - 1) * (sdLog / Math.sqrt(n));
  return { ratio: Math.exp(centre), ci: { lo: Math.exp(centre - half), hi: Math.exp(centre + half) }, n, sdLog };
}

/** The smallest mean difference a paired design of `n` detects at 5% two-sided with 80% power. */
export function minimumDetectableDifference(sd: number, n: number): number | null {
  if (!Number.isInteger(n) || n < 1 || !Number.isFinite(sd)) return null;
  return ((Z95 + Z_POWER_80) * sd) / Math.sqrt(n);
}
