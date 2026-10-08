/** The facet loop's pure decisions: when a round starts, who asked it to stop, what a round keeps, where the move comes from. */
import { harnessFlags } from "../replan.ts";
import { ChangeScale, Side } from "../judge.ts";
import { CheckKind, CheckOrigin, CheckWeight } from "../spec.ts";
import { MINUTE_MS } from "../time.ts";
import { VerdictSource } from "../verdict.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import { FACET_POLICY, MAX_STUCK_ANSWERS } from "./policy.ts";
import { CLIP_QUOTE } from "../text.ts";
import type { FacetPolicy } from "./policy.ts";

/**
 * Where a round's move comes from (`chooseMove`'s `source`, and `facet_move.source` for the
 * ones that name a move): the director's ladder, a move still pending, the taste judge's big move
 * for the facet (`reviewer`), the liveness critic's gap, or the planner. `none` is a climbed
 * director's ladder nobody has proposed a next step for. Never rename a value.
 */
export const MoveSource = {
  Milestone: "milestone",
  Pending: "pending",
  Reviewer: "reviewer",
  Critic: "critic",
  Planner: "planner",
  None: "none",
} as const;
export type MoveSource = (typeof MoveSource)[keyof typeof MoveSource];

/** The sources whose moves are re-asked while they have attempts left: the harness's own, not the director's. */
const NAMED_MOVE_SOURCES: readonly unknown[] = [MoveSource.Planner, MoveSource.Reviewer, MoveSource.Critic];

/** Why a judge-grown check retires (`facet_check_retired.why`): solved, or not a question a picture answers. */
export const RetireReason = {
  Passed: "passed",
  Unanswerable: "unanswerable",
} as const;
export type RetireReason = (typeof RetireReason)[keyof typeof RetireReason];

/** Camera names that are the harness's own eyes, or a demo's composed frame: never one of the spec's cameras. */
const BORROWED_CAMERA = /^(?:eye|demo):/;

/** The ladder's owner when the director wrote it (`spec.moveOwner`). */
const DIRECTOR_LADDER = "director";

/** How many whole minutes a span reads as in the owner's sentence: at least one. */
const wholeMinutes = (ms: number): number => Math.max(1, Math.round(ms / MINUTE_MS));

/**
 * A round is started only when what is left covers a whole one of this worker's own rounds,
 * with this much headroom. The clock used to be the only gate — "is there any time left?" —
 * and one night's five round-two workers all began a round they could not finish: the build
 * turn was cut mid-edit, the half-written project was judged as a partial, three of them lost,
 * and the morning counted those rounds as undone.
 */
export const ITERATION_HEADROOM = 1.25;

/** How much the last round weighs against the ones before it in a worker's own average. */
const ITERATION_EMA_ALPHA = 0.5;
/** How much of one lesson line from the builder's notes is kept. */
const LESSON_CHARS = 240;

/** Small counts read as words, so a sentence about them reads like a sentence. */
const COUNT_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

const countWord = (n: number): string => COUNT_WORDS[n] ?? String(n);

/** A camera a new check names that the facet should list: named, not listed yet, and not borrowed. */
export function isNewOwnCamera(cameras: readonly string[], camera: unknown): camera is string {
  return Boolean(camera) && !cameras.includes(camera as string) && !BORROWED_CAMERA.test(String(camera));
}

/** "two unjudgeable builds", "one unjudgeable build" — the streak sentence, whatever the limit is. */
export const brokenStreakWords = (limit: number): string =>
  `${countWord(limit)} unjudgeable build${limit === 1 ? "" : "s"}`;

/**
 * A model review finding worded like this once read as a check being gamed. The loop now reads
 * the reviewer's own `gaming` flag (phases/review.ts); this stays for a kept copy that imports it.
 */
export const GAMING_FINDING =
  /\bgam(e|ed|es|ing)\b|fak(e|ed|es)|hard-?cod|forc(e|ed|es|ing)\s+(the\s+)?(probe|check|value|result|flag)|\bl(ie|ies|ying)\b|bypass|short-?circuit|always (true|1|pass)/i;

/**
 * THE FIX's recipe, pinned into the brief's "Recipes that apply" — where THE FIX's own line
 * says it is. Retrieval sorts by score and keeps three, and an exact check-id match outscores
 * a match on the gap's prose by a wide margin: two failing craft checks were enough to drop
 * the fix's own recipe while the sentence naming it stayed, sending the builder to look for
 * something the brief did not carry. The budget does not grow — the lowest-scoring of the rest
 * gives up its place — and a fix whose recipe retrieval already found is left where it is.
 *
 */
export function pinFixRecipe<
  H extends { recipe: { id: string }; score?: number; checkIds?: string[]; primaryCheckId?: string | null },
>(
  retrieved: readonly H[] | null | undefined,
  fix: { recipe?: H["recipe"] | null; checkId?: string | null } | null | undefined,
  defectCheckId: string | null = null,
): H[] {
  const list = [...(retrieved ?? [])];
  const recipe = fix?.recipe ?? null;
  if (!recipe || list.some((entry) => entry.recipe?.id === recipe.id)) return list;
  const budget = Math.max(list.length, 1);
  const fixCheckId = fix?.checkId ?? null;
  const checkIds = [fixCheckId, defectCheckId].filter((id): id is string => Boolean(id));
  list.unshift({
    recipe,
    score: Infinity,
    checkIds: checkIds.length ? checkIds : ["the fix"],
    primaryCheckId: fixCheckId,
  } as H);
  list.length = budget;
  return list;
}

/**
 * Is the work done? The contract is the identity checks the facet was started on — a
 * director's `done` list, the planner's identity features, the harness's own — and nothing
 * else. Checks the judge grows during the night are on the board and steer the next
 * iteration, but a facet that met its contract is finished even while the judge is still
 * naming polish; the alternative (every check, judge-grown included) is a worker that can
 * never stop, which is exactly what a night of 4-of-7 boards looked like.
 *
 * Returns the sentence for `stoppedBecause`, or null while there is still work to do.
 */
export function facetIsDone({
  won,
  broken = false,
  verdict = null,
  summary = null,
  legacy = false,
}: {
  won: unknown;
  broken?: boolean;
  verdict?: { satisfied?: boolean } | null;
  summary?: { identityAllPass?: boolean } | null;
  legacy?: boolean;
}): string | null {
  const satisfiedWin = won && !broken && verdict?.satisfied;
  if (!satisfiedWin) return null;
  if (!legacy && summary?.identityAllPass !== true) return null;
  return legacy ? "facet critic satisfied" : "the work it was given is done";
}

/** One exponential step of a worker's own average, seeded by the first measurement it gets. */
export function smooth(average: number | null, sample: number): number | null {
  if (!Number.isFinite(sample) || sample < 0) return average;
  return average === null
    ? Math.round(sample)
    : Math.round(average * (1 - ITERATION_EMA_ALPHA) + sample * ITERATION_EMA_ALPHA);
}

/**
 * Is there time for another whole round? `buildMs`/`afterMs` are what this worker's own rounds
 * have taken (the build turn, then evidence and the judge); `runMs` is the run's median, used
 * only until the worker has finished one of its own. With nothing measured at all the answer is
 * always yes — a worker is never refused its first round on a guess.
 *
 * Returns the sentence for `stoppedBecause`, in the words the owner reads, or null.
 *
 */
export function tooLateToStart({
  leftMs,
  buildMs = null,
  afterMs = null,
  runMs = null,
}: {
  leftMs: number;
  buildMs?: number | null;
  afterMs?: number | null;
  runMs?: number | null;
}): string | null {
  const estimate = roundCostEstimate(buildMs, afterMs, runMs);
  if (estimate === null || leftMs >= estimate * ITERATION_HEADROOM) return null;
  return `stopped early to finish cleanly: a round here takes about ${wholeMinutes(estimate)} min and ${wholeMinutes(Math.max(0, leftMs))} min are left`;
}

/** What a round is expected to cost: this worker's own two halves, else the run's median, else unknown. */
function roundCostEstimate(buildMs: number | null, afterMs: number | null, runMs: number | null): number | null {
  if (buildMs !== null) return buildMs + (afterMs ?? 0);
  return Number(runMs) > 0 ? Number(runMs) : null;
}

/**
 * Who asked this facet to stop, and in the words that end up on the owner's screen.
 *
 * `finishRequested` answers with a plain `true` — the old contract, and still what the user's
 * own wrap-up signal means — or with `{ by, reason }`. The director answers with itself,
 * because a night that stopped five workers to fix one shader must not tell the owner they did
 * it. Returns null when nobody has asked.
 */
export function stopSignal(answer: unknown): { by: string; reason: string } | null {
  const asked = "finishing after the current attempt at the user’s request";
  if (!answer) return null;
  if (answer === true) return { by: "user", reason: asked };
  const { by: who, reason: why } = answer as { by?: string; reason?: unknown };
  const by = who === "director" ? "director" : "user";
  const reason = String(why ?? "").trim();
  return { by, reason: reason || (by === "director" ? "stopped by the director" : asked) };
}

/**
 * Which stop ends the round where it stands. The user's wrap-up signal means "after the current
 * attempt" and is answered at the top of the next round; only the director pulling a worker off
 * abandons the round it is in. `aborted` is the engine's own word — the turn was aborted, so
 * the round is over whoever asked, and the reason is theirs if they gave one.
 */
export function stopsThisRound(
  answer: unknown,
  { aborted = false }: { aborted?: boolean } = {},
): { by: string; reason: string } | null {
  const asked = stopSignal(answer);
  if (aborted) return asked ?? { by: "user", reason: "stopped before the round finished" };
  return asked?.by === "director" ? asked : null;
}

/** Bullets under `## Fixed by looking` (any heading containing those words) plus `HARNESS:` lines. */
export function lessonsFromNotes(notes: unknown): string[] {
  const text = String(notes ?? "");
  const out: string[] = [];
  const section = /^##+\s+.*fixed by looking.*$([\s\S]*?)(?=^##+\s|\s*$(?![\s\S]))/gim;
  let m;
  while ((m = section.exec(text))) {
    for (const line of m[1].split("\n")) {
      const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
      if (bullet) out.push(bullet[1].trim().slice(0, LESSON_CHARS));
    }
  }
  for (const flag of harnessFlags(text)) out.push(`HARNESS: ${flag.what}`);
  return [...new Set(out)];
}

/** The kinds of check that measure themselves — no judge is asked whether they moved. */
const SELF_MEASURING_KINDS: readonly string[] = [
  CheckKind.Scene,
  CheckKind.Pixel,
  CheckKind.Metric,
  CheckKind.Probe,
  CheckKind.Demo,
  CheckKind.Play,
];

/**
 * The flips that are evidence on their own (M3.2). A mechanical check measures itself, and a
 * vision check the planner or the harness wrote is part of the contract the build was accepted
 * against. A crop question the judge grew from its own defect list is neither: it was seeded
 * "fail" by the judge that wrote it, so its first "yes" is that judge agreeing with itself. One
 * night kept a round that way — a car that had got worse, kept because one grown question about
 * its trunk answered yes while the twin question about the same trunk still failed at 0.80.
 */
export function strongFlips(
  spec: { checks?: AnyRecord[] } | null | undefined,
  board: AnyRecord | null | undefined,
  flips: readonly string[] | null = [],
): string[] {
  const checks = new Map<string, AnyRecord>((spec?.checks ?? []).map((c) => [c.id, c]));
  return (flips ?? []).filter((id) => {
    const check = checks.get(id) ?? null;
    const entry = board?.[id] ?? null;
    // A flip on something neither the spec nor the board knows about is nobody's note: keep it.
    if (!check && !entry) return true;
    const kind = check?.kind ?? entry?.kind ?? null;
    if (SELF_MEASURING_KINDS.includes(kind)) return true;
    return kind === CheckKind.Vision && (check?.origin ?? entry?.origin ?? null) !== CheckOrigin.Judge;
  });
}

/**
 * Whether a round is kept. A strong flip is proof: the build does something measurable it did
 * not do before, and only a named regression (the taste veto) undoes it. Everything else — no
 * flip at all, or only the judge's own notes flipping — is decided by the blind side-by-side
 * pick, which is the one judgement that looked at both builds at once.
 */
export function acceptRound({
  spec,
  board,
  comparison,
  taste,
  moveMissing = false,
}: {
  spec: { checks?: AnyRecord[] } | null | undefined;
  board: AnyRecord | null | undefined;
  comparison?: { flips?: string[] } | null;
  taste?: { veto?: boolean; pick?: string | null } | null;
  moveMissing?: boolean;
}): { accepted: boolean; strong: string[]; source: string } {
  const strong = strongFlips(spec, board, comparison?.flips ?? []);
  const veto = taste?.veto === true;
  const accepted = strong.length > 0 ? !veto : taste?.pick === Side.Challenger && !moveMissing;
  return { accepted, strong, source: acceptanceSource({ veto, strong: strong.length > 0, moveMissing }) };
}

/** Which rule a kept-or-not round was decided by, in `acceptRound`'s order: a veto, a strong flip, a missing move, taste. */
function acceptanceSource({
  veto,
  strong,
  moveMissing,
}: {
  veto: boolean;
  strong: boolean;
  moveMissing: boolean;
}): VerdictSource {
  if (veto) return VerdictSource.TasteVeto;
  if (strong) return VerdictSource.Checks;
  if (moveMissing) return VerdictSource.NoMove;
  return VerdictSource.Taste;
}

/**
 * Whether this round may take a move at all. The harness's own moves — the planner's, the
 * critic's, a pending one — wait until the part is itself: an empty board (round one) or a
 * failing identity check means the worker still owes what it was started for.
 *
 * The director's ladder is exempt. Its rungs are the round's mandate from the first round on:
 * gated by identity they would have reached a builder only once every `done` check passed, which
 * is the moment the worker ends — so `worker_start move=` and `worker_steer move=` were accepted,
 * answered "its next round builds it", and handed to nobody (M3.3).
 *
 */
export function movesThisRound(
  spec: AnyRecord | null | undefined,
  board: Record<string, { weight?: string; pass?: boolean | null }> | null | undefined,
): boolean {
  if (spec?.moveOwner === DIRECTOR_LADDER) return true;
  const entries = Object.values(board ?? {});
  return entries.length > 0 && !entries.some((e) => e.weight === CheckWeight.Identity && e.pass === false);
}

/**
 * Where this iteration's move comes from, and whether missing it can undo the round (M3.3).
 * Pure: the caller seeds the move's check, counts the attempt, pushes a new move and asks the
 * planner. `source` is "milestone" | "pending" | "reviewer" | "critic" | "planner" | "none".
 *
 * The ladder wins over everything. When the director wrote it (`spec.moveOwner === "director"`)
 * the harness never invents a move of its own: a night once told five workers that puddles, a
 * wreck-cam and a tow truck were mandatory while the director's brief said mud, and the workers
 * lost the rounds they had spent on the brief. A rung the director steered in (`steered`) is
 * next, ahead of the rest of the ladder: the golden-goal night's lead steered past a rung its
 * worker was stuck on, was told "its next round builds it", and the steer waited behind the stuck
 * rung for good. A rung set aside after missing round after round (`setAside`) is passed over.
 *
 * Once the director's ladder is climbed, the next step is the director's call — but a worker that
 * waits for one spends its rounds on polish, which is what that night's workers did. The taste
 * judge names the one big move it sees for the facet every round (`lastBigMove`); the worker
 * builds that as guidance, never mandatory, until the director steers a rung of its own. With
 * nobody owning the ladder the reviewer's move, the critic's gap and the planner still name one —
 * it is worth having, it is what stops polish-only nights — but it is guidance until two accepted
 * builds in a row have polished instead of moving.
 */
export function chooseMove({
  spec = null,
  moves = [],
  milestonesDone = [],
  setAside = [],
  polishStreak = 0,
  lastLiveness = null,
  lastBigMove = null,
  policy = FACET_POLICY,
}: {
  spec?: { milestones?: AnyRecord[]; moveOwner?: unknown } | null;
  moves?: AnyRecord[];
  milestonesDone?: Iterable<string>;
  setAside?: Iterable<string>;
  polishStreak?: number;
  lastLiveness?: { grow?: AnyRecord[] } | null;
  lastBigMove?: AnyRecord | null;
  policy?: FacetPolicy;
} = {}) {
  const next = nextRung(spec?.milestones ?? [], new Set([...milestonesDone, ...setAside]));
  if (next) return { source: MoveSource.Milestone, milestone: next, mandatory: true };
  // Past a director's ladder only the reviewer's move is the harness's to give, and as guidance.
  const directed = spec?.moveOwner === DIRECTOR_LADDER;
  const mandatory = !directed && polishStreak >= policy.polishStreakEscalate;
  const pending = [...moves].reverse().find((m) => isOpenMove(m, policy) && (!directed || isReviewers(m)));
  if (pending) return { source: MoveSource.Pending, pending, mandatory };
  const bigMove = freshBigMove(moves, lastBigMove);
  if (bigMove) return { source: MoveSource.Reviewer, bigMove, mandatory };
  if (directed) return { source: MoveSource.None, mandatory: false };
  const gap = (lastLiveness?.grow ?? []).find((g) => !moves.some((m) => m.what === g.fix));
  if (gap) return { source: MoveSource.Critic, gap, mandatory };
  return { source: MoveSource.Planner, mandatory };
}

/** The ladder's next rung: one the director steered in first, else the first not yet passed. */
function nextRung(ladder: readonly AnyRecord[], passed: ReadonlySet<string>): AnyRecord | null {
  const open = ladder.filter((m) => !passed.has(m.id));
  return open.find((m) => m.steered === true) ?? open[0] ?? null;
}

/** Was this move the reviewer's? */
const isReviewers = (move: AnyRecord): boolean => move.source === MoveSource.Reviewer;

/**
 * The reviewer's newest proposal, when nobody has worked on it yet. One still being worked on
 * comes back as a pending move while it has attempts left: a judge that rewords its proposal
 * every round would otherwise hand the worker a new direction every round.
 */
function freshBigMove(moves: readonly AnyRecord[], lastBigMove: AnyRecord | null): AnyRecord | null {
  if (!lastBigMove?.what) return null;
  return moves.some((m) => m.what === lastBigMove.what) ? null : lastBigMove;
}

/** A move the planner, the reviewer or the critic named that is not delivered yet and still has attempts left. */
function isOpenMove(move: AnyRecord, policy: FacetPolicy): boolean {
  const named = NAMED_MOVE_SOURCES.includes(move.source);
  return named && !move.delivered && (move.attempts ?? 1) < policy.moveAttempts;
}

/**
 * What became of the move: measured by its own check when it has one, else answered by the
 * taste judge (a judge that did not answer gives the benefit of the doubt). `costsRound` is the
 * demotion of M3.3 — only a move somebody asked for (`mandatory`) can undo a round the judge
 * preferred; every other miss is `note`, which rides into the round's record and the director's
 * digest so the night can steer instead of the worker losing the work.
 *
 * A move the judge saw already in the accepted build (`moveAlreadyPresent`) was delivered by an
 * earlier round: it is never missing, and its rung climbs whatever this round's fate. Asked
 * "visible here and absent from the other", the golden-goal night's judge answered no about a
 * restart loop both builds had, four rounds running, and each of those rounds was thrown away.
 */
export function moveVerdict({
  move = null,
  board = {},
  taste = null,
  won = null,
}: {
  move?: AnyRecord | null;
  board?: AnyRecord | null;
  taste?: AnyRecord | null;
  won?: boolean | null;
} = {}): {
  measured: boolean;
  missing: boolean;
  costsRound: boolean;
  delivered: boolean | null;
  already: boolean;
  note: string | null;
} {
  const what = String(move?.what ?? "");
  if (!what || !move)
    return { measured: false, missing: false, costsRound: false, delivered: null, already: false, note: null };
  const measured = Boolean(move.check && board?.[move.check.id]?.pass === true);
  const already = !measured && taste?.moveAlreadyPresent === true;
  const missing = !measured && !already && taste?.moveDelivered === false;
  const costsRound = missing && move.mandatory === true;
  // Visible without being asked: a structural change the judge did not say was missing.
  const looksStructural = taste?.moveDelivered !== false && taste?.scale === ChangeScale.Structural;
  const landed = measured || taste?.moveDelivered === true || looksStructural;
  const delivered = won === null ? null : already || Boolean(won && landed);
  return { measured, missing, costsRound, delivered, already, note: moveNote(what, { missing, costsRound, already }) };
}

/** The round's note about its move: already built by an earlier round, or missed without costing the round. */
function moveNote(
  what: string,
  { missing, costsRound, already }: { missing: boolean; costsRound: boolean; already: boolean },
): string | null {
  if (already) return `the move was already in the accepted build — its rung is climbed: ${what.slice(0, CLIP_QUOTE)}`;
  if (missing && !costsRound)
    return `the move was not delivered, and it did not cost the round: ${what.slice(0, CLIP_QUOTE)}`;
  return null;
}

/**
 * The checks the judge grew, which the round's card must not count as the plan's (M3.2).
 * `spec.checks` is the authority, plus the ones retired this round: a question that goes pass →
 * fail → pass reaches its second pass on the round it also flips, and `judgeChecksToRetire` takes
 * it out of the spec before the scoreboard is built — so the spec alone would call the judge's
 * own question one of the plan's flips, and the card would read "+1 · kept" for it.
 *
 */
export function grownCheckIds(
  spec: { checks?: Array<{ id?: string; origin?: string } | null> } | null | undefined,
  retired: Iterable<string> = [],
): Set<string | undefined> {
  const grown = (spec?.checks ?? []).flatMap((c) => (c?.origin === CheckOrigin.Judge ? [c.id] : []));
  return new Set([...retired, ...grown]);
}

/**
 * Which judge-grown questions have finished their life. One that has passed often enough is
 * solved; one the judge has hedged on twice running is unanswerable by a picture — asking a
 * third time buys nothing and it is holding a slot a real question could use.
 */
export function judgeChecksToRetire(
  spec: { checks?: AnyRecord[] } | null | undefined,
  {
    passes = {},
    stucks = {},
    policy = FACET_POLICY,
  }: { passes?: Record<string, number>; stucks?: Record<string, number>; policy?: FacetPolicy } = {},
): Array<{ check: AnyRecord; why: string; count: number }> {
  const out: Array<{ check: AnyRecord; why: string; count: number }> = [];
  for (const check of (spec?.checks ?? []).filter((c) => c?.origin === CheckOrigin.Judge)) {
    if ((passes[check.id] ?? 0) >= policy.judgeCheckRetirePasses)
      out.push({ check, why: RetireReason.Passed, count: passes[check.id] });
    else if ((stucks[check.id] ?? 0) >= MAX_STUCK_ANSWERS)
      out.push({ check, why: RetireReason.Unanswerable, count: stucks[check.id] });
  }
  return out;
}
