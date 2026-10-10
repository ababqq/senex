/**
 * The words a chat turn adds to its model's prompt: the Autopilot and Loop briefings (a build is
 * allowed, not required), and the note that puts attached pictures in front of the model.
 */
import { launchDecision } from "./launch-prompts.ts";
import type { AnyRecord } from "../types/harness.d.ts";

/** The extra system text a turn runs with: a commission's briefing, or its own. */
export function turnBriefing(options: {
  autopilot?: AnyRecord | null;
  loop?: AnyRecord | null;
  extraSystem?: string;
}): string | undefined {
  if (options.autopilot) return autopilotBriefing(options.autopilot);
  if (options.loop) return loopBriefing(options.loop);
  return options.extraSystem;
}

/** The note that puts this turn's pictures in front of the model. */
export function lookAtPictures(labels: string): string {
  return `Look at these pictures (${labels}). A path is not a picture.`;
}

/** How many of a commission's stills carry pixels. */
function stillCount(commission: AnyRecord): number {
  return commission.frames?.filter((frame: AnyRecord | null) => frame?.data)?.length ?? 0;
}

function autopilotBriefing(autopilot: AnyRecord): string {
  const n = stillCount(autopilot);
  const hours = typeof autopilot.hours === "number" && autopilot.hours > 0 ? autopilot.hours : null;
  return [
    `## Autopilot is ON — a build is allowed, not required`,
    ``,
    hours
      ? `A build is capped at ${hours} hour${hours === 1 ? "" : "s"}.`
      : `No time cap — a build runs until its critics are satisfied.`,
    ...launchDecision("start_autopilot"),
    `The build decomposes the ask into facets, builds them with blind per-facet critics, and integrates.`,
    ``,
    `Before a build: chase the outcome (what they do with it and how it should feel to use — "fast like Linear", "calm"). One question at a time. Mirror their words. Recap in one breath and start.`,
    `Use ask_user for questions with concise choices, recommended first. End the turn after asking; the next user message is the answer. Do not repeat the question in prose or launch a run before it is answered.`,
    autopilotMoodBoard(n),
  ].join("\n");
}

function autopilotMoodBoard(n: number): string {
  if (n >= 2)
    return `They attached ${n} stills — the mood board. Those pixels are the visual bar; the critics will see them.`;
  if (n === 1)
    return `One still attached. For a visual build, ask for one or two more — a bar needs at least two angles. If they have none, ask for a textual reference: "name a product, site or film with the vibe".`;
  return `No stills attached. For a visual build, ask for reference images once; if they have none, ask for a textual reference ("name a product, site or film that has the vibe") and use that as the bar. Before that build, also check the project's references/ folder — earlier mood boards live there. Never refuse to start for lack of references.`;
}

function loopBriefing(loop: AnyRecord): string {
  const hours = loop.hours;
  const n = stillCount(loop);
  return [
    `## Loop is ON — an unattended build is allowed, not required`,
    ``,
    `The user set ${hours} hour${hours === 1 ? "" : "s"} for a build.`,
    ...launchDecision("start_unattended_run"),
    ``,
    `Before a build: chase the outcome (what they do with it and how it should feel to use — "fast like Linear", "calm"). A named product is a valid bar. One question at a time. Mirror their words. Never quiz them on product names. Recap in one breath and start.`,
    `Use ask_user for questions with concise choices, recommended first. End the turn after asking; the next user message is the answer. Do not repeat the question in prose or launch a run before it is answered.`,
    n >= 2
      ? `They attached ${n} stills — those pixels are the visual bar. You cannot see them; the critic will.`
      : `No stills. Direction mode: the feeling IS the bar. Do not refuse to start for lack of a named title.`,
  ].join("\n");
}
