/**
 * What the wake loop (wake.ts) says to the lead, as the model reads it: the digest at the top of
 * every message that wakes it, the question it is asked when nothing runs, why a wrap-up started,
 * the fresh start after a lost session and why it was lost, the rules of the loop, and the tool
 * set without `wait` — and the rules of the long turn it replaced, which the playbook no longer
 * names. Plain facts in, text out. It never imports briefs.ts, which reads from here.
 */
import { shortSha } from "../git.ts";
import { limitWords } from "../outage.ts";
import { clip, clipMarked } from "../text.ts";
import { minutes } from "../time.ts";
import { LEAD_CARD_RULE, LEAD_FRESH_START, LEAD_INTEGRATE_SWAP } from "./lead-session-prompts.ts";
import { DirectorTool } from "./tool-specs.ts";
import { HEARTBEAT_MS, NoteKind, WakeCause, WrapCause } from "./wake-schedule.ts";
import type { LiveToolSpec } from "../../types/host-api.d.ts";
import type { WakeReason } from "./wake-schedule.ts";

/**
 * This part serves a lead that is its chat's own session and writes nothing (one session): a night
 * seats one only when every part it depends on says so (lead-session.ts `servesLead`).
 */
export const SERVES_LEAD = true;

/** A digest names at most this many of the lines that happened, the newest. */
export const DIGEST_MAX_LINES = 40;
/** A digest names at most this many workers, the running ones first. */
export const DIGEST_MAX_WORKERS = 12;
/** The build card is at most this many lines, its title included. */
export const CARD_MAX_LINES = 15;
/** A fresh session is told this many of the log's last lines. */
export const FRESH_LOG_LINES = 20;
/** A fresh session is told this many of the lead's own notes. */
export const FRESH_NOTES = 5;
/** THE USER SAYS names at most this many of the user's messages, the newest… */
export const USER_SAYS_MAX = 20;
/** …and carries at most this much of each. */
export const USER_SAYS_CHARS = 2_000;
/** How much of one line of news, the goal and the plan's summary a digest carries. */
const HAPPENED_CHARS = 400;
const GOAL_CHARS = 300;
const PLAN_CHARS = 300;

/** One worker as the digest names it (`waitDigest` plus its title). */
export interface DigestWorker {
  id: string;
  title: string;
  state: string;
  minutesLeft?: number;
  round?: number;
  accepted?: number;
  passing?: string;
  mandatoryFix?: string | null;
  minutesInRound?: number;
  filesChanged?: number;
  violations?: string[];
  lastLook?: string | null;
  stoppedBecause?: string | null;
  /** A worker from before a pause: what it left and how to go on from it (journal.ts). */
  fromBefore?: string;
  /** What its reviewers propose for the part next: the judge's big move, the critic's biggest fix. */
  ideas?: string[];
}

/** How many workers run, and how many the machine allows at once (the user's Maximum concurrent workers). */
export interface WorkerRoom {
  running: number;
  allowed: number;
}

/** What the build card is made of: the run, its kind, and the plan. */
export interface CardFacts {
  runId: string;
  project: string;
  goal: string;
  /** A duration commission spends its working time; goal commissions finish when verified. */
  direction: boolean;
  plan: { summary: string; parts: string[] } | null;
  /**
   * The lead writes nothing (one session, `night.lead`): its card says so. Absent — a director with
   * its own hands, such as a kept director.ts from before one session drives — it keeps its memory file.
   */
  lead?: boolean;
}

/** The workers' engine's limit, as the digest names it. */
export interface WorkersLimitFacts {
  engine: string;
  kind: string;
  /** When it resets, if the engine said. */
  liftsAt: number | null;
}

/** Everything one wake's message is made of. */
export interface DigestFacts {
  now: number;
  reasons: readonly WakeReason[];
  /** The first line when it is not a wake's: a resumed night's first message (journal-prompts.ts). */
  heading?: string;
  /** What the user said since the lead last heard them, oldest first, word for word. */
  userSays: readonly string[];
  /** The user asked to finish, and no message has said so yet. */
  finishNew: boolean;
  /** The night's log since the lead last read it. */
  happened: readonly string[];
  softDeadline: number;
  finalDeadline: number;
  wrapping: boolean;
  integrationHead: string | null;
  integrationHealthy: boolean | null;
  /** Defects nobody is building (`ledgerLines`). */
  defects: readonly string[];
  workers: readonly DigestWorker[];
  /** Workers running and allowed at once; null when the studio could not say. */
  room?: WorkerRoom | null;
  /** The workers from before a pause in one line, on every digest after a resumed night's first (journal.ts). */
  priorLine?: string;
  /** When the plan window closes, while the builders still wait for the user. */
  planWindowUntil: number | null;
  workersLimit: WorkersLimitFacts | null;
  finishRequested: boolean;
  card: CardFacts;
  /** The paragraph this wake ends on: carry on, what next, or the wrap-up. */
  closing: string;
}

/** Why the lead was woken, in the header's words. */
export const REASON_WORDS = {
  [NoteKind.WorkerRound]: "a worker finished a round",
  [NoteKind.WorkerLoop]: "a worker's loop changed",
  [NoteKind.WorkerEnded]: "a worker ended",
  [NoteKind.WorkerStopped]: "a worker you stopped has settled",
  [NoteKind.WorkerLimit]: "the workers' engine hit its limit",
  [NoteKind.MonitorViolation]: "a look into a worktree found a violation",
  [NoteKind.MonitorQuiet]: "a look into a worktree",
  [NoteKind.DefectShelved]: "a defect nobody owns",
  [NoteKind.DefectRouted]: "a defect was handed to its owner",
  [NoteKind.UserToWorker]: "the user spoke to a worker",
  [WakeCause.UserMessage]: "the user spoke",
  [WakeCause.FinishRequested]: "the user asked to finish",
  [WakeCause.News]: "news",
  [WakeCause.Heartbeat]: `${minutes(HEARTBEAT_MS)} quiet minutes while workers run`,
  [WakeCause.PlanWindow]: "the plan window closed — the builders may start",
  [WakeCause.WrapUp]: "the wrap-up",
  [WakeCause.WorkersLimitLifted]: "the workers' engine limit has reset",
  [WakeCause.IdleAsk]: "nothing is running",
} as const satisfies Record<WakeReason, string>;

/** The one line a finish request adds to the user's part of a digest. */
const FINISH_ASKED = "THE USER ASKED TO FINISH: integrate what is ready and call finish.";

/** The rules every build card carries, the same on every wake: the rule of its seat goes between them. */
const CARD_RULES = [
  "- The user outranks the plan: answer them in the chat, directly and briefly, and act on what they ask; a question alone stops no worker.",
  "- What you write is the user's chat: otherwise speak only when a part lands, the build can be looked at, something broke, the plan changed, or the build is done.",
  "- Evidence, not reports: judge, playtest or look at a single session's work before you integrate (a loop's kept rounds were judged), and look at the integrated build before you finish.",
  "- Plan before worker_start; parallel workers only on independent files.",
] as const;
const CARD_RULES_AFTER = [
  "- End your turn after each decision; the studio wakes you when something happens.",
  "- run_status and worker_status have the rest.",
] as const;
/** The card's rule for a director with its own hands: the memory file it keeps. */
const HANDS_CARD_RULE = "- Keep .studio/DIRECTOR.md current: it is the memory that survives compaction and a resume.";

/** What `worker_start` answers a waking lead to do next. */
export const WAKE_START_NEXT = "end your turn, or start another worker; worker_status for detail";

/** A clock time as the digest says it. */
const utc = (ms: number): string => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

/** The header: when, and why — or the heading a message that is not a wake gives itself. */
function headerLine({ heading, now, reasons }: DigestFacts): string {
  if (heading) return heading;
  return `WOKEN AT ${utc(now)} — ${reasons.map((reason) => REASON_WORDS[reason] ?? reason).join("; ")}`;
}

/**
 * What the user said, word for word and oldest first, under the heading every message gives it —
 * bounded: the newest `USER_SAYS_MAX` messages, each cut at `USER_SAYS_CHARS`, and how many earlier
 * ones are not shown.
 */
export function userSaysBlock(userSays: readonly string[]): string {
  const shown = userSays.slice(-USER_SAYS_MAX);
  const hidden = userSays.length - shown.length;
  return [
    "THE USER SAYS (verbatim, oldest first):",
    ...(hidden ? [`- (${hidden} earlier messages not shown)`] : []),
    ...shown.map((text) => `- ${clipMarked(text, USER_SAYS_CHARS)}`),
  ].join("\n");
}

/** The user's words and a finish request — or nothing. */
function userSection({ userSays, finishNew }: DigestFacts): string {
  const lines: string[] = [];
  if (userSays.length) lines.push(userSaysBlock(userSays));
  if (finishNew) lines.push(FINISH_ASKED);
  return lines.join("\n");
}

/** The night's news since the lead last read it: the newest lines, and how many older ones were left out. */
function happenedSection(happened: readonly string[]): string {
  const shown = happened.slice(-DIGEST_MAX_LINES);
  const hidden = happened.length - shown.length;
  return [
    "WHAT HAPPENED:",
    ...(hidden ? [`- (${hidden} earlier lines not shown — run_status and worker_status have where things stand)`] : []),
    ...(shown.length ? shown.map((line) => `- ${clip(line, HAPPENED_CHARS)}`) : ["- nothing new since your last turn"]),
  ].join("\n");
}

/** The clock, as the lead plans against it. */
function timeLine({ now, softDeadline, finalDeadline, wrapping }: DigestFacts): string {
  if (wrapping)
    return `- time: wrapping up — ${minutes(finalDeadline - now)} minutes left, until ${utc(finalDeadline)}`;
  return `- time: ${minutes(softDeadline - now)} working minutes, wrap-up at ${utc(softDeadline)}, ${minutes(finalDeadline - now)} minutes in all`;
}

/** What the last health pass said about the integration head. */
function healthWords(healthy: boolean | null): string {
  if (healthy === true) return "loads";
  if (healthy === false) return "problems";
  return "not run";
}

/** One worker in a line, with no worktree path. */
function workerLine(w: DigestWorker): string {
  const parts = [
    w.state,
    w.minutesLeft === undefined ? "" : `${w.minutesLeft} min left`,
    w.round === undefined ? "" : `round ${w.round}`,
    w.accepted === undefined ? "" : `${w.accepted} accepted`,
    w.passing ? `passing ${w.passing}` : "",
    w.filesChanged ? `${w.filesChanged} files changed` : "",
    w.violations?.length ? `violations: ${w.violations.join("; ")}` : "",
    w.mandatoryFix ? `mandatory fix: ${w.mandatoryFix}` : "",
    w.lastLook ? `last look: ${w.lastLook}` : "",
    w.stoppedBecause ? `stopped because: ${w.stoppedBecause}` : "",
    w.fromBefore ?? "",
  ].filter(Boolean);
  const ideas = w.ideas?.length ? `\n  next big step, as its reviewers see it — ${w.ideas.join(" | ")}` : "";
  return `- worker ${w.id} (${w.title}): ${parts.join(" · ")}${ideas}`;
}

/**
 * The room for more workers. The golden-goal night ran three of the six its owner allowed, then
 * two, then one, and nothing it read ever said a window stood idle.
 */
function roomLine(room: WorkerRoom | null | undefined): string {
  if (!room) return "";
  const free = Math.max(0, room.allowed - room.running);
  const more = free
    ? ` — room for ${free} more: start the next area that has unbuilt work, or a deeper layer of one`
    : "";
  return `- workers: ${room.running} running, up to ${room.allowed} at once (the user's Maximum concurrent workers)${more}`;
}

/** The workers, running ones first, at most `DIGEST_MAX_WORKERS` of them. */
function workerLines(workers: readonly DigestWorker[]): string[] {
  const ordered = [...workers].sort(
    (a, b) => Number(b.minutesLeft !== undefined) - Number(a.minutesLeft !== undefined),
  );
  const shown = ordered.slice(0, DIGEST_MAX_WORKERS).map(workerLine);
  const more = ordered.length - DIGEST_MAX_WORKERS;
  return more > 0
    ? [...shown, `- and ${more} more workers — worker_status lists every one, those from before a pause too`]
    : shown;
}

/** The workers' engine limit, in a line. */
function workersLimitLine(limit: WorkersLimitFacts): string {
  const resets = limit.liftsAt === null ? "no reset time was given" : `it resets at ${utc(limit.liftsAt)}`;
  return `- the workers' engine (${limit.engine}) hit its ${limitWords(limit.kind)} — ${resets}`;
}

/** Where the night stands: the clock, the integration head, the workers, the plan window, the user. */
function standsSection(facts: DigestFacts): string {
  const { defects, integrationHead, now, planWindowUntil, workersLimit } = facts;
  return [
    "WHERE THE RUN STANDS:",
    timeLine(facts),
    `- integration: ${integrationHead ? shortSha(integrationHead) : "no commit yet"}, last health pass ${healthWords(facts.integrationHealthy)}`,
    defects.length ? `- defects nobody owns: ${defects.join(" | ")}` : "",
    roomLine(facts.room),
    ...workerLines(facts.workers),
    facts.priorLine ?? "",
    planWindowUntil === null
      ? ""
      : `- the plan window: the builders wait for the user until ${utc(planWindowUntil)} (${minutes(planWindowUntil - now)} min)`,
    workersLimit ? workersLimitLine(workersLimit) : "",
    `- the user asked to finish: ${facts.finishRequested ? "yes" : "no"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The build card: what a compacted session must still know — the run, its rule, its plan, its clock and the rules. */
/** The build card a wake digest carries: the run, its kind, its plan and its clock. */
export function buildCard({ card, softDeadline, finalDeadline }: DigestFacts): string {
  const plan = card.plan
    ? `- Plan: ${clip(card.plan.summary, PLAN_CHARS)} — parts: ${card.plan.parts.join(", ") || "none named"}`
    : "- Plan: none yet — call plan before your first worker.";
  return [
    "BUILD CARD:",
    `- Run ${card.runId} on "${card.project}": ${clip(card.goal, GOAL_CHARS)}`,
    card.direction
      ? "- An explicit duration commission: spend the working time building, testing and improving; finish in the wrap-up, or when the user asks."
      : "- Finish when the required goal is verified and integrated. Remaining time is a safety ceiling, not a target. If a required prerequisite is blocked, preserve progress and report it; do not continue optional polish.",
    plan,
    `- Deadlines: the wrap-up starts at ${utc(softDeadline)}; the run ends at ${utc(finalDeadline)}.`,
    ...CARD_RULES,
    card.lead ? LEAD_CARD_RULE : HANDS_CARD_RULE,
    ...CARD_RULES_AFTER,
  ].join("\n");
}

/**
 * The message that wakes the lead: why, the user's words verbatim, what happened, where the
 * night stands, the build card, and this wake's closing paragraph — in that order, so what the
 * user said is the first thing the lead reads.
 */
export function wakeDigest(facts: DigestFacts, includeCard = true): string {
  return [
    headerLine(facts),
    userSection(facts),
    happenedSection(facts.happened),
    standsSection(facts),
    includeCard ? buildCard(facts) : "",
    facts.closing,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** What was said and what happened while the lead waited out its engine's limit, or nothing. */
export function sinceThen({
  userSays,
  happened,
}: {
  userSays: readonly string[];
  happened: readonly string[];
}): string {
  if (!userSays.length && !happened.length) return "";
  return [
    "SINCE THEN:",
    ...(userSays.length ? [userSaysBlock(userSays)] : []),
    ...(happened.length ? ["WHAT HAPPENED:", ...happened.map((line) => `- ${clip(line, HAPPENED_CHARS)}`)] : []),
  ].join("\n");
}

/** The closing of an ordinary wake. */
export function carryOn(): string {
  return "Decide, act, and end your turn — the studio wakes you when something happens.";
}

/** The closing when the lead's last turn ended with nothing running: asked once, what next. */
export function idleAsk({ direction, minutesLeft }: { direction: boolean; minutesLeft: number }): string {
  const lead = direction
    ? `The timed build still has ${minutesLeft} working minutes and nothing is running. What next?`
    : `Nothing is running and ${minutesLeft} working minutes remain. What next?`;
  const what = direction
    ? "Plan and start a worker for the most valuable unfinished feature or verification gap; inspect, integrate and show progress."
    : "Start the next part the goal still needs, or verify, integrate and finish if it is met.";
  return `${lead} ${what} If you end this turn with nothing running, the studio starts the wrap-up.`;
}

/** Why a wrap-up that is not the deadline's started. */
const WRAP_LEADS = {
  [WrapCause.Deadline]: "",
  [WrapCause.Idle]: "Nothing was running and your last turn started nothing, so the studio starts the wrap-up now.",
  [WrapCause.Failed]: "Your last turn failed, so the studio starts the wrap-up now.",
  [WrapCause.Finish]: "The user asked to finish, so the studio starts the wrap-up now.",
} as const satisfies Record<WrapCause, string>;

/** The wrap-up prompt (briefs.ts `wrapUpPrompt`), with why it started when that was not the deadline. */
export function wrapLead(cause: WrapCause, wrapUp: string): string {
  const lead = WRAP_LEADS[cause];
  return lead ? `${lead}\n${wrapUp}` : wrapUp;
}

/** Why a fresh session carries the night, in the words its first line gives (`freshStart`). */
export const SESSION_LOST_WHY = {
  resumeFailed: "the session could not be resumed",
  contextFull: "its context was full",
  contextOverflowed: "its context overflowed",
  /** A later turn found no session to resume: the one before it ended without one (a limit before it began). */
  noSession: "no session was left to resume",
} as const;

/**
 * What a fresh session is told when the lead's own was lost: the brief, the rules, its notes, the
 * night and the news — and, for a director with its own hands (`lead` absent), its memory file first.
 */
export function freshStart({
  why,
  brief,
  rules,
  notes,
  recent,
  digest,
  card = "",
  lead = false,
}: {
  why: string;
  brief: string;
  rules: string;
  notes: readonly string[];
  recent: readonly string[];
  digest: string;
  /** The build card when the digest left it out (the lost session had seen it): a new one has not. */
  card?: string;
  lead?: boolean;
}): string {
  return [
    lead
      ? LEAD_FRESH_START(why)
      : `YOUR EARLIER SESSION WAS LOST (${why}) — this is a fresh one. Read .studio/DIRECTOR.md in your worktree first: it is the memory you kept. Then carry on from where the run stands.`,
    brief,
    rules,
    [
      `YOUR NOTES (the last ${FRESH_NOTES} you left in the feed):`,
      ...(notes.length ? notes.map((n) => `- ${n}`) : ["- none"]),
    ].join("\n"),
    [
      `THE RUN SO FAR (the log's last ${FRESH_LOG_LINES} lines):`,
      ...(recent.length ? recent.map((line) => `- ${clip(line, HAPPENED_CHARS)}`) : ["- nothing yet"]),
    ].join("\n"),
    ...(card ? [card] : []),
    digest,
  ].join("\n\n");
}

/** How the night runs, said once in the first message (and again in a fresh one). */
export function wakeRules({ heartbeatMinutes }: { heartbeatMinutes: number }): string {
  return [
    "HOW THIS RUN WORKS — ONE DECISION PER TURN:",
    "- Act, then end your turn: there is no wait tool. Between your turns nothing of yours runs; the workers keep building.",
    `- The studio wakes you in this same session when something happens — the user speaks or asks to finish, a worker lands a round or ends, a look into a worktree finds a violation, the plan window closes, the wrap-up starts — and every ${heartbeatMinutes} minutes while workers run.`,
    "- Each wake opens with a digest: the user's words, what happened, where the run stands, and your build card.",
    "- End a turn with nothing running and the studio asks once what next; end the next one idle too and it starts the wrap-up.",
  ].join("\n");
}

/**
 * How the long turn runs (`directorLoop: "turn"`), said once in its first message. The playbook
 * names neither loop — the wake rules say the other one — so a lead on the long turn is never
 * told to end its turn after each decision, which there ends its working time.
 */
export function longTurnRules(): string {
  return [
    "HOW THIS RUN WORKS — ONE LONG TURN:",
    "- `wait` is your loop: act, then wait — it returns when the user speaks or asks to finish, a worker lands a round or ends, or a look into a worktree finds a violation.",
    "- Stay in this turn while there is working time: when it ends, the run goes to its wrap-up (a timed build is asked to carry on first).",
    "- Your own hands: you are a director of your own, not the chat's session — you edit and commit in your integration worktree, and resolve a merge conflict there yourself.",
  ].join("\n");
}

/** The two sentences of the brief's rules a waking lead reads instead of the long turn's. */
export const WAKE_BRIEF = {
  planReview:
    ' THE USER ASKED TO READ IT FIRST: your first worker waits for their word (they may simply say "go") and builds the plan as it stands if they say nothing — end your turn after plan; you are woken when they answer or the window closes.',
  userSays:
    "- The user speaks in this project's chat: their words open your next wake (THE USER SAYS) or reach you mid-turn. They outrank your plan; answer them there, briefly, and act on them.",
} as const;

/** What `worker_start` answers a waking lead while the builders wait for the user's word. */
export function planHeldWords(id: string, until: number, now: number): string {
  return `the user asked to read the plan first and has not answered yet; the builders wait until ${utc(until)} (${minutes(until - now)} min) and then build it as it stands. End your turn now: you are woken the moment they answer or when the window closes — then start "${id}" again.`;
}

/** What `plan` answers a waking lead when the user asked to read the plan first. */
export function planSetWords(waitMinutes: number): string {
  return `the plan is in the user's chat. They asked to read it before the run builds, so your first worker waits for their word — up to ${waitMinutes} min, and then it builds the plan as it stands. End your turn now; you are woken when they answer or the window closes.`;
}

/** The sentence of a tool's description a waking lead reads instead of the long turn's. */
const WAKE_TOOL_SWAPS = new Map<string, readonly [string, string]>([
  [
    DirectorTool.WorkerStart,
    [
      "— use wait and worker_status.",
      "— end your turn; the studio wakes you when it lands a round or ends (worker_status for detail).",
    ],
  ],
]);

/** …and the ones a lead that writes nothing reads besides (one session, lead-session.ts): a merge conflict goes to a worker. */
const LEAD_TOOL_SWAPS = new Map<string, readonly [string, string]>([[DirectorTool.Integrate, LEAD_INTEGRATE_SWAP]]);

/**
 * The run tools a waking lead is offered: no `wait`, and descriptions that say to end the turn —
 * and, for a lead that writes nothing (`lead`), that a conflict goes to a worker. A director with
 * its own hands on the wake loop (a kept director.ts from before one session) resolves it itself.
 */
export function wakeTools(tools: readonly LiveToolSpec[], { lead = false }: { lead?: boolean } = {}): LiveToolSpec[] {
  return tools
    .filter((tool) => tool.name !== DirectorTool.Wait)
    .map((tool) => {
      const swap = WAKE_TOOL_SWAPS.get(tool.name) ?? (lead ? LEAD_TOOL_SWAPS.get(tool.name) : undefined);
      return swap ? { ...tool, description: tool.description.replace(swap[0], swap[1]) } : tool;
    });
}
