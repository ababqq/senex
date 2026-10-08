/**
 * The vote (§8.4): an odd number of calls per family, majority wins, and fewer than two decided
 * votes is `inconclusive`: "the judge could not tell" is a fact about the instrument, never a defect
 * in the project. Calls run one after another, because they are independent samples of one question and
 * concurrency buys only rate-limit errors. Families combine by conjunction and are never summed.
 */
import { ZERO_TOKEN_USAGE, type TokenUsage } from "../../../../src/shared/eval-lane.ts";
import type { EngineId } from "../../../../src/shared/providers.ts";
import { ChecklistVote, ItemVerdict } from "../../vocabulary.ts";
import type { FamilyVotes, GraderPin } from "../types.ts";
import type { GraderComplete, GraderPrompt } from "./complete.ts";
import { isSameFamily } from "./family.ts";
import { parseChecklistVote } from "./prompt.ts";

/** The fewest calls a family makes per item. */
export const MIN_VOTES_PER_FAMILY = 3;
/** The fewest yes-or-no votes a family needs before its majority means anything. */
export const MIN_DECIDED_VOTES = 2;

/** Refuse a vote count that is even (a tie would need a thumb on the scale) or below the minimum. */
export function assertVoteCount(votesPerFamily: number): void {
  const odd = Number.isInteger(votesPerFamily) && votesPerFamily % 2 === 1;
  if (!odd || votesPerFamily < MIN_VOTES_PER_FAMILY)
    throw new RangeError(`votesPerFamily must be odd and at least ${MIN_VOTES_PER_FAMILY}`);
}

/** One family's verdict from its votes: majority of the decided votes, else inconclusive. */
export function familyVerdict(votes: readonly ChecklistVote[]): { decided: number; verdict: ItemVerdict } {
  const yes = votes.filter((vote) => vote === ChecklistVote.Yes).length;
  const no = votes.filter((vote) => vote === ChecklistVote.No).length;
  const decided = yes + no;
  if (decided < MIN_DECIDED_VOTES || yes === no) return { decided, verdict: ItemVerdict.Inconclusive };
  return { decided, verdict: yes > no ? ItemVerdict.Pass : ItemVerdict.Fail };
}

/** The combined verdict: every family passes → pass, every family fails → fail, otherwise inconclusive. */
export function combineVerdicts(verdicts: readonly ItemVerdict[]): ItemVerdict {
  if (verdicts.length === 0) return ItemVerdict.Inconclusive;
  if (verdicts.every((verdict) => verdict === ItemVerdict.Pass)) return ItemVerdict.Pass;
  if (verdicts.every((verdict) => verdict === ItemVerdict.Fail)) return ItemVerdict.Fail;
  return ItemVerdict.Inconclusive;
}

/** Add one usage into a running total. */
export function addUsage(total: TokenUsage, usage: TokenUsage): TokenUsage {
  return {
    uncachedInput: total.uncachedInput + usage.uncachedInput,
    cacheWrite: total.cacheWrite + usage.cacheWrite,
    cacheRead: total.cacheRead + usage.cacheRead,
    output: total.output + usage.output,
    reasoning: total.reasoning + usage.reasoning,
  };
}

/** What one family's vote on one question needs. */
export interface FamilyVoteInput {
  complete: GraderComplete;
  pin: GraderPin;
  prompt: GraderPrompt;
  votes: number;
  /** The engines whose output is being graded, for `sameFamily`. */
  runEngines: ReadonlyArray<EngineId | null | undefined>;
  /** Reads one reply as a vote. */
  parse?: (reply: string) => ChecklistVote;
}

/** Ask one family the same question `votes` times; a failed call is an invalid vote, never a no. */
export async function voteFamily(input: FamilyVoteInput): Promise<FamilyVotes> {
  const parse = input.parse ?? parseChecklistVote;
  const votes: ChecklistVote[] = [];
  let usage = ZERO_TOKEN_USAGE;
  let servedModel: string | null = null;
  for (let call = 0; call < input.votes; call += 1) {
    try {
      const reply = await input.complete(input.pin, input.prompt);
      votes.push(parse(reply.text));
      usage = addUsage(usage, reply.usage);
      servedModel ??= reply.model;
    } catch {
      votes.push(ChecklistVote.Invalid);
    }
  }
  const { decided, verdict } = familyVerdict(votes);
  return {
    family: input.pin.family,
    model: servedModel ?? input.pin.model,
    votes,
    decided,
    verdict,
    sameFamily: isSameFamily(input.pin, input.runEngines),
    usage,
  };
}
