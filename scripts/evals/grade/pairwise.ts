/**
 * The pairwise judge (§8.5): an eval-owned rubric (`pairwise-prompt.md`, pinned as
 * `pairwiseRubricSha`) with no Genex contract, no incumbent and no placeholders; every pair is
 * judged in both orders by every family, the family's first order drawn from the recorded seed. A
 * pair is a win only when both orders agree; disagreement is `position-inconsistent` and an
 * unparseable reply is `invalid`, never a tie. A pair where exactly one side shipped a typed no-build
 * and the other has enough evidence is a forfeit: the side that built wins every facet, with no
 * call, and its rows say so. Any other pair short of evidence is skipped (`invalid`). Rows go to the
 * local ledger only.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { MessageImage } from "../../../src/shared/event-log.ts";
import { ZERO_TOKEN_USAGE } from "../../../src/shared/eval-lane.ts";
import type { EngineId } from "../../../src/shared/providers.ts";
import { PAIRWISE_ROW_SCHEMA, type PairwiseRow } from "../ledger/types.ts";
import { type Axis, type GraderFamily, PairFacet, PairOrder, PairOutcome, PairPick } from "../vocabulary.ts";
import type { GraderComplete, GraderPrompt } from "./checklist/complete.ts";
import { evidenceSufficient, type GraderEvidence, loadGraderEvidence } from "./checklist/evidence.ts";
import { GraderPinError, GraderPinProblem, isSameFamily, validateGraderPins } from "./checklist/family.ts";
import type { GraderPin, JudgePairwise, PairwiseRequest, PairwiseRows, PairwiseVerdict } from "./types.ts";

/** Which side of a pair. */
type Side = "first" | "second";

/** Where the rubric lives, beside this module. */
export const PAIRWISE_RUBRIC_FILE = new URL("./pairwise-prompt.md", import.meta.url);

/** The headings the evidence sections carry after the rubric; part of the pinned sha. */
const PROMPT_HEADING = {
  Request: "WHAT THE PERSON ASKED FOR:",
  Frames: "FRAMES ATTACHED:",
  Console: "BROWSER CONSOLE (may be empty):",
  Network: "FILES THE PAGE LOADED:",
  Side: { left: "LEFT", right: "RIGHT" },
} as const;

/** What the rubric must never contain. */
export const RubricViolation = {
  /** The Genex runtime contract (`window.__studio`): a raw-lane project can never satisfy it. */
  StudioContract: "studio-contract",
  /** Language that favours one side for being the existing one. */
  Incumbent: "incumbent",
  /** A template placeholder: the rubric is fixed text, the evidence follows it. */
  Placeholder: "placeholder",
} as const;
export type RubricViolation = (typeof RubricViolation)[keyof typeof RubricViolation];

/** The shape each violation is recognized by. */
const VIOLATION_PATTERN: Readonly<Record<RubricViolation, RegExp>> = {
  [RubricViolation.StudioContract]: /__studio/,
  [RubricViolation.Incumbent]: /\b(?:incumbent|champion|challenger|keeps? (?:the )?ties?)\b/i,
  [RubricViolation.Placeholder]: /\{\{|\}\}|\$\{|<[A-Z][A-Z_]*>/,
};

/** A rubric was refused, naming what it contained. */
export class PairwiseRubricError extends Error {
  readonly violations: RubricViolation[];
  constructor(violations: RubricViolation[]) {
    super(`pairwise rubric refused: ${violations.join(", ")}`);
    this.name = "PairwiseRubricError";
    this.violations = violations;
  }
}

/** A loaded rubric and its pin. */
export interface PairwiseRubric {
  text: string;
  sha: string;
}

/** What a rubric contains that it must not. */
export function rubricViolations(text: string): RubricViolation[] {
  return Object.values(RubricViolation).filter((violation) => VIOLATION_PATTERN[violation].test(text));
}

/** The `pairwiseRubricSha` of a rubric: its text and the evidence headings, never the evidence. */
export function pairwiseRubricSha(text: string): string {
  return createHash("sha256").update(text).update(JSON.stringify(PROMPT_HEADING)).digest("hex");
}

/** Read and check the rubric; a rubric with a violation is refused, never used. */
export async function readPairwiseRubric(file: URL | string = PAIRWISE_RUBRIC_FILE): Promise<PairwiseRubric> {
  const text = await readFile(file, "utf8");
  const violations = rubricViolations(text);
  if (violations.length > 0) throw new PairwiseRubricError(violations);
  return { text, sha: pairwiseRubricSha(text) };
}

/** One side's evidence section and its frames, relabelled for the side it is shown on. */
function sideSection(side: string, evidence: GraderEvidence): { text: string; images: MessageImage[] } {
  const images = evidence.frames.map((frame, index) => ({
    ...frame,
    label: `${side} ${index + 1}/${evidence.frames.length}`,
  }));
  const text = [
    `${side} ${PROMPT_HEADING.Frames} ${images.length}`,
    `${side} ${PROMPT_HEADING.Console}\n${evidence.consoleSummary}`,
    `${side} ${PROMPT_HEADING.Network}\n${evidence.networkSummary}`,
  ].join("\n\n");
  return { text, images };
}

/** The prompt for one order: rubric, request, then the left side's evidence and the right side's. */
export function renderPairwisePrompt(
  rubric: PairwiseRubric,
  brief: string,
  left: GraderEvidence,
  right: GraderEvidence,
): GraderPrompt {
  const leftSide = sideSection(PROMPT_HEADING.Side.left, left);
  const rightSide = sideSection(PROMPT_HEADING.Side.right, right);
  return {
    text: [rubric.text.trim(), `${PROMPT_HEADING.Request}\n${brief}`, leftSide.text, rightSide.text].join("\n\n"),
    images: [...leftSide.images, ...rightSide.images],
  };
}

/** A value for every facet. */
function perFacet<T>(value: (facet: PairFacet) => T): Record<PairFacet, T> {
  return {
    [PairFacet.Overall]: value(PairFacet.Overall),
    [PairFacet.Works]: value(PairFacet.Works),
    [PairFacet.Visuals]: value(PairFacet.Visuals),
    [PairFacet.Feel]: value(PairFacet.Feel),
    [PairFacet.Play]: value(PairFacet.Play),
  };
}

/** Every facet invalid: a skipped or unparseable judgement. */
function invalidPicks(): Record<PairFacet, PairPick> {
  return perFacet(() => PairPick.Invalid);
}

/** A verdict made without a call because a side's evidence was insufficient. */
function skippedVerdict(pin: GraderPin, order: PairOrder): PairwiseVerdict {
  return {
    order,
    grader: pin,
    picks: invalidPicks(),
    valid: false,
    judgeSkipped: true,
    forfeit: false,
    usage: ZERO_TOKEN_USAGE,
  };
}

/** A verdict made without a call because one side forfeited: `winner` takes every facet in this order. */
function forfeitVerdict(pin: GraderPin, order: PairOrder, winner: Side): PairwiseVerdict {
  const firstOnLeft = order === PairOrder.FirstLeft;
  const pick = (winner === "first") === firstOnLeft ? PairPick.Left : PairPick.Right;
  return {
    order,
    grader: pin,
    picks: perFacet(() => pick),
    valid: true,
    judgeSkipped: false,
    forfeit: true,
    usage: ZERO_TOKEN_USAGE,
  };
}

/**
 * The side that wins by forfeit: exactly one side shipped a typed no-build and the other side has
 * enough evidence to be judged; null otherwise (an eval-side shortfall is never a forfeit).
 */
function forfeitWinner(request: PairwiseRequest, sufficient: Record<Side, boolean>): Side | null {
  const firstMissing = request.first.noBuild !== null;
  const secondMissing = request.second.noBuild !== null;
  if (firstMissing === secondMissing) return null;
  const winner: Side = firstMissing ? "second" : "first";
  return sufficient[winner] ? winner : null;
}

/** Whether the judge skipped this pair for insufficient evidence (every verdict made without a call). */
export function pairJudgeSkipped(verdicts: readonly PairwiseVerdict[]): boolean {
  return verdicts.length > 0 && verdicts.every((verdict) => verdict.judgeSkipped);
}

/** A pick as the reply spells it. */
const REPLY_PICK: Readonly<Record<string, PairPick>> = {
  LEFT: PairPick.Left,
  RIGHT: PairPick.Right,
  TIE: PairPick.Tie,
};

/** One facet's pick: exactly one whole `FACET: LEFT|RIGHT|TIE` line, else invalid. */
function facetPick(reply: string, facet: PairFacet): PairPick {
  const line = new RegExp(String.raw`^\s*\**${facet}\**\s*:\**\s*\**(LEFT|RIGHT|TIE)\**[.!]?\s*$`, "gim");
  const answers = new Set([...reply.matchAll(line)].map((match) => (match[1] ?? "").toUpperCase()));
  const [only] = [...answers];
  if (answers.size !== 1 || only === undefined) return PairPick.Invalid;
  return REPLY_PICK[only] ?? PairPick.Invalid;
}

/** Read a reply's picks; the reply is valid only when every facet parsed. */
export function parsePairPicks(reply: string): { picks: Record<PairFacet, PairPick>; valid: boolean } {
  const picks = perFacet((facet) => facetPick(reply, facet));
  return { picks, valid: Object.values(picks).every((pick) => pick !== PairPick.Invalid) };
}

/** The two orders for one family, the first drawn from the recorded seed. */
export function orderSequence(blindSeed: string, family: GraderFamily): PairOrder[] {
  const byte = createHash("sha256").update(`${blindSeed}:${family}`).digest()[0] ?? 0;
  return byte % 2 === 0 ? [PairOrder.FirstLeft, PairOrder.FirstRight] : [PairOrder.FirstRight, PairOrder.FirstLeft];
}

/** What the pairwise judge is built from. */
export interface PairwiseJudgeDeps {
  complete: GraderComplete;
  evidenceRoot: string;
  rubric: PairwiseRubric;
}

/** One (family, order) judgement. */
async function judgeOrder(
  deps: PairwiseJudgeDeps,
  pin: GraderPin,
  order: PairOrder,
  prompts: Record<PairOrder, GraderPrompt>,
): Promise<PairwiseVerdict> {
  try {
    const reply = await deps.complete(pin, prompts[order]);
    const parsed = parsePairPicks(reply.text);
    return { order, grader: pin, ...parsed, judgeSkipped: false, forfeit: false, usage: reply.usage };
  } catch {
    const picks = invalidPicks();
    return { order, grader: pin, picks, valid: false, judgeSkipped: false, forfeit: false, usage: ZERO_TOKEN_USAGE };
  }
}

/** Refuse a request whose pins or rubric sha do not match the loaded rubric. */
function checkPairwisePins(request: PairwiseRequest, rubric: PairwiseRubric): void {
  if (request.pairwiseRubricSha !== rubric.sha) throw new GraderPinError(GraderPinProblem.PromptShaMismatch);
  validateGraderPins(request.graders, rubric.sha);
}

/** One (family, order) verdict: a forfeit or a skip without a call, else the judge's. */
function verdictFor(
  pin: GraderPin,
  order: PairOrder,
  decided: { winner: Side | null; skipped: boolean },
  judge: () => Promise<PairwiseVerdict>,
): Promise<PairwiseVerdict> {
  if (decided.winner !== null) return Promise.resolve(forfeitVerdict(pin, order, decided.winner));
  if (decided.skipped) return Promise.resolve(skippedVerdict(pin, order));
  return judge();
}

/** Build the `JudgePairwise` the campaign calls: both orders, every family, calls one at a time. */
export function createJudgePairwise(deps: PairwiseJudgeDeps): JudgePairwise {
  return async (request) => {
    checkPairwisePins(request, deps.rubric);
    const first = await loadGraderEvidence(request.first.evidence, deps.evidenceRoot);
    const second = await loadGraderEvidence(request.second.evidence, deps.evidenceRoot);
    const sufficient = { first: evidenceSufficient(first), second: evidenceSufficient(second) };
    const decided = { winner: forfeitWinner(request, sufficient), skipped: !(sufficient.first && sufficient.second) };
    const brief = request.evalCase.brief;
    const prompts: Record<PairOrder, GraderPrompt> = {
      [PairOrder.FirstLeft]: renderPairwisePrompt(deps.rubric, brief, first, second),
      [PairOrder.FirstRight]: renderPairwisePrompt(deps.rubric, brief, second, first),
    };
    const verdicts: PairwiseVerdict[] = [];
    for (const pin of request.graders) {
      for (const order of orderSequence(request.blindSeed, pin.family)) {
        verdicts.push(await verdictFor(pin, order, decided, () => judgeOrder(deps, pin, order, prompts)));
      }
    }
    return verdicts;
  };
}

/** One order's pick read against the pair: which of the pair's runs it chose. */
export function pickOutcome(order: PairOrder, pick: PairPick): PairOutcome {
  if (pick === PairPick.Invalid) return PairOutcome.Invalid;
  if (pick === PairPick.Tie) return PairOutcome.Tie;
  const firstSide = order === PairOrder.FirstLeft ? PairPick.Left : PairPick.Right;
  return pick === firstSide ? PairOutcome.First : PairOutcome.Second;
}

/** A pair's outcome over both orders: a result only when both agree. */
export function pairOutcome(firstLeft: PairPick, firstRight: PairPick): PairOutcome {
  const a = pickOutcome(PairOrder.FirstLeft, firstLeft);
  const b = pickOutcome(PairOrder.FirstRight, firstRight);
  if (a === PairOutcome.Invalid || b === PairOutcome.Invalid) return PairOutcome.Invalid;
  return a === b ? a : PairOutcome.PositionInconsistent;
}

/** Each family's outcome per facet, over its two orders (a family missing an order is invalid). */
export function familyOutcomes(
  verdicts: readonly PairwiseVerdict[],
): Partial<Record<GraderFamily, Record<PairFacet, PairOutcome>>> {
  const outcomes: Partial<Record<GraderFamily, Record<PairFacet, PairOutcome>>> = {};
  for (const family of new Set(verdicts.map((verdict) => verdict.grader.family))) {
    const ofFamily = verdicts.filter((verdict) => verdict.grader.family === family);
    const inOrder = (order: PairOrder) => ofFamily.find((verdict) => verdict.order === order)?.picks ?? invalidPicks();
    const left = inOrder(PairOrder.FirstLeft);
    const right = inOrder(PairOrder.FirstRight);
    outcomes[family] = perFacet((facet) => pairOutcome(left[facet], right[facet]));
  }
  return outcomes;
}

/** What a pairwise row needs beyond the request: when, which grade, which rep and axis, the pair's engines. */
export interface PairwiseRowContext {
  recordedAt: string;
  gradeSeq: number;
  gradeId: string;
  rep: number;
  axis: Axis;
  engines: { first: EngineId; second: EngineId };
}

/** Build the `PairwiseRows` the campaign calls: one row per (family, order), skipped and forfeited pairs marked. */
export function createPairwiseRows(context: PairwiseRowContext): PairwiseRows {
  return (request, verdicts, campaignId) => {
    const judgeSkipped = pairJudgeSkipped(verdicts);
    const forfeit = verdicts.length > 0 && verdicts.every((verdict) => verdict.forfeit);
    return verdicts.map(
      (verdict): PairwiseRow => ({
        schema: PAIRWISE_ROW_SCHEMA,
        campaignId,
        recordedAt: context.recordedAt,
        gradeSeq: context.gradeSeq,
        gradeId: context.gradeId,
        caseId: request.evalCase.id,
        caseVersion: request.evalCase.version,
        rep: context.rep,
        axis: context.axis,
        lanes: { first: request.first.laneId, second: request.second.laneId },
        runIds: { first: request.first.runId, second: request.second.runId },
        order: verdict.order,
        blindSeed: request.blindSeed,
        family: verdict.grader.family,
        graderModel: verdict.grader.model,
        sameFamily: isSameFamily(verdict.grader, [context.engines.first, context.engines.second]),
        pairwiseRubricSha: request.pairwiseRubricSha,
        picks: verdict.picks,
        judgeSkipped,
        ...(forfeit ? { forfeit: true } : {}),
      }),
    );
  };
}
