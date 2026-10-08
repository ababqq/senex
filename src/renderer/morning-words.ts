/**
 * The morning card's copy, as a pure function.
 *
 * The card itself is React, so nothing in a test can reach it; every sentence and every button it
 * offers is decided here instead, from the facts the log carries. The four paths a night can end
 * on — landed, kept but not made live, paused, stopped by the owner — are the four the user meets,
 * and the one thing they must never disagree about is the card's own buttons: a night the card
 * says is "Finished" must not be one whose Resume is the only thing that saves it, and a sentence
 * that promises a playable build must not appear over a card with no Play on it.
 */
import { nightWords, withoutIds } from "./words.ts";

export interface MorningNight {
  /** rounds a judge saw */
  rounds: number;
  kept: number;
  undone: number;
  landed: boolean | null;
  /** the night stopped where Resume can pick it up: a plan limit, a quit, a crash */
  paused: boolean;
  /** there is a merged build to play or make live — the same fact the buttons are gated on */
  hasBuild: boolean;
  stoppedBecause?: string | null;
  /** the night's own report to the user; a night that ended before writing one has none */
  summary?: string | null;
  /** the plain sentence the close writes about landing, when the night wrote one */
  landingLine?: string | null;
  /** what the studio's own ledger made of the night (loop/ledger.ts), when it had something to say */
  learned?: string | null;
}

/** The card's buttons, in the order they are shown; the first is the primary one. */
export const MorningAction = {
  /** pick a paused night up where it left off */
  Resume: "resume",
  /** put the live project (the landed build) on the stage */
  Play: "play",
  /** load tonight's merged build from a copy */
  PlayBuild: "play-build",
} as const;
export type MorningAction = (typeof MorningAction)[keyof typeof MorningAction];

export interface MorningWords {
  headline: string;
  /** "10 kept · 11 undone" — empty when no round was judged */
  tally: string;
  because: string;
  summary: string | null;
  /** what stands in the report's place when the night never wrote one */
  noReport: string | null;
  /** one line the studio learned about this project tonight, or null when it learned nothing worth a line */
  learned: string | null;
  actions: MorningAction[];
}

function actionsFor(night: MorningNight): MorningAction[] {
  const build: MorningAction[] = night.hasBuild ? [MorningAction.PlayBuild] : [];
  if (night.paused) return [MorningAction.Resume, ...build];
  if (night.landed === false) return build;
  return [MorningAction.Play];
}

export function morningWords(night: MorningNight): MorningWords {
  const words = nightWords({
    rounds: night.rounds,
    landed: night.landed,
    stoppedBecause: night.stoppedBecause ?? null,
    paused: night.paused,
    hasBuild: night.hasBuild,
    // A landed night's close says how it landed and whether anything checked it — the one detail
    // the user cannot see for themselves. The sentence itself is words.ts's, so the card, the run
    // pill and the Builds drawer cannot say it three ways.
    landing: night.landingLine ?? null,
  });
  const summary = (night.summary ?? "").trim();
  const learned = (night.learned ?? "").trim();
  const kept = Math.max(0, Math.trunc(night.kept || 0));
  const undone = Math.max(0, Math.trunc(night.undone || 0));
  return {
    headline: words.headline,
    tally: kept + undone > 0 ? `${kept} kept · ${undone} undone` : "",
    because: words.because,
    summary: summary || null,
    noReport: summary ? null : noReportWords(night.paused),
    // The studio's own sentence about the night, which the harness composes from its ledger of
    // outcomes. It arrives plain, but it arrives from the harness, so it goes through the same
    // scrub every other harness sentence does before it reaches a person.
    learned: learned ? withoutIds(learned) : null,
    actions: actionsFor(night),
  };
}

/** Why a night has no report of its own. */
function noReportWords(paused: boolean): string {
  return paused ? "It was paused before it could write up the build." : "It ended before it could write up the build.";
}
