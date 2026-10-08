import { CompletionPolicy } from "./completion-policy.ts";
/**
 * One user message, from the queue to its answer: which run (if any) it belongs to, the turn that
 * answers it — the chat's own, after a night its lead led too (after-night.ts), else the run's
 * coordinator — the follow-up a coordinator commissions, the paused night the chat's own session
 * resumes, the finished build it or the coordinator reopens with Loop on (reopen-run.ts), and the
 * night an interview launches.
 */
import { runTurn, type TurnOptions, type TurnOutcome } from "./turn-loop.ts";
import * as turnLoopParts from "./turn-loop.ts";
import { sayInTurn, TurnStatus, TurnStop } from "./turn-record.ts";
import { runCoordinatorTurn } from "./coordinator.ts";
import * as coordinatorParts from "./coordinator.ts";
import * as coordinatorPromptsParts from "./coordinator-prompts.ts";
import * as chatSessionParts from "./chat-session.ts";
import * as delegatedTurnParts from "./delegated-turn.ts";
import * as afterNightPromptsParts from "./after-night-prompts.ts";
import * as runDispatchParts from "./run-dispatch.ts";
import { afterLeadNight, resumeAfterReply, servesAfterNight, type AfterNight } from "./after-night.ts";
import {
  commissionHours,
  finishedNight,
  firstLoopUnused,
  keepsCommission,
  type ReopenAsk,
  reopenAfterReply,
  type ReopenModels,
  reopens,
  servesReopen,
} from "./reopen-run.ts";
import { MESSAGE as REOPEN_MESSAGE } from "./reopen-run-prompts.ts";
import { conversationThrough, latestRun } from "./run-inbox.ts";
import { eventsToMessages } from "./prompt.ts";
import { EngineId, hasSessionRoles, supportsSessions } from "./model-roles.ts";
import { withSteers } from "./chat-steer-prompts.ts";
import { HostMethod } from "./host-methods.ts";
import { StudioContract } from "./page-contract.ts";
import { EventKind, RunEvent, RunState } from "./run-events.ts";
import { HOUR_MS } from "./time.ts";
import { endClock } from "./wall-clock.ts";
import { handleRunStart, nightRefusal } from "./run-dispatch.ts";
import { runUnderWay } from "./live-chat.ts";
import { readJournal } from "./run-journal.ts";
import { followupAsk } from "./studio-prompts.ts";
import { type ActiveRun, type RunReopen, StatusLane, type Studio } from "./studio-state.ts";
import { clampRunHours } from "./config.ts";
import { CLIP_PROJECT_TITLE } from "./text.ts";
import type { AnyRecord, ForwardedCall, HarnessCtx, HarnessEvent, Host, HostCall } from "../types/harness.d.ts";
import type { ModelPreferences, RunSpec } from "../types/host-api.d.ts";
import type { QueueAction, SteerHandle } from "./message-queue.ts";

/** The night an interview commissions when it names no length, in hours. */
const DEFAULT_RUN_HOURS = 8;
/** The folder a night builds in when neither the chat nor the interview names one. */
const FALLBACK_PROJECT = "project";
/** A goal that says nothing: empty, or a missing value spelled out. */
const EMPTY_GOALS = new Set(["", "undefined", "null"]);
/** The session phase a stopped turn leaves on its thread (`session_activity`). */
const INTERRUPTED_PHASE = "interrupted";

/** What the chat is told. */
const MESSAGE = {
  studioThreadBuilds:
    "Builds happen in a project's chat — this is the Studio's own chat, which never builds. Press Start a project in the sidebar, set the hours there, and describe a feeling.",
  noGoal:
    "the interview produced no usable goal — the intake tool call must carry a real `goal`; ask again instead of launching",
  alreadyBuilding: (project: string) =>
    `a build is already running for ${project} — wait for it to finish, or stop it, before starting another`,
  couldNotLaunch: (failure: string) => `the run could not launch: ${failure}`,
  stoppedBeforeLaunch: "it was stopped before it started, and nothing new was started",
  stoppedBeforeTurn: "Stopped before it started — nothing was done. Send a message to go on.",
  turnFailed: (failure: unknown) => `turn failed: ${failure}`,
  // What the user is owed before they walk away: when to come back, that the machine has to
  // stay awake, and that a paused night is not a lost one. "until the critics are satisfied"
  // answered none of those — the first real night ended on the plan's five-hour window at 105
  // of 180 minutes and nobody had been told that could happen.
  nightPromised: (end: string) => `Building until about ${end} — keep the app open and the Mac awake. `,
  // ∞ has no end to promise; its 24 h ceiling is a date, since as a bare clock it is "now".
  untilSatisfiedPromised: (ceiling: string) =>
    `It finishes when the required outcomes are verified, with a safety stop by about ${ceiling} — keep the app open and the Mac awake. `,
  planWindow:
    "Your Claude plan's window can pause it partway; it waits out the reset and resumes itself, or one tap on Resume.",
  connectionFirst:
    " Your project doesn't have the studio's connection yet, so the first thing this build does is add it — without it nothing can tell whether a change made the project better.",
} as const;

/** The run a message belongs to, when it names one (the queued action carries the same fields). */
type RunRecord = AnyRecord;

/**
 * The parts the chat's own session after a lead's night depends on: the runner that picks its
 * turn, the turn, and its brief.
 */
const AFTER_NIGHT_PARTS = [turnLoopParts, delegatedTurnParts, chatSessionParts];

/**
 * Does the chat after a lead's night go to the chat's own session (after-night.ts)? Only when its
 * runner, its turn and its brief serve it: a kept copy of any from before could give that session
 * no run controls and tell it to pick up where it left off — then the coordinator answers, as before.
 */
export function ownSessionAfterNight(): boolean {
  return servesAfterNight(AFTER_NIGHT_PARTS);
}

/**
 * What reopening a finished build depends on: the runner (its model), the turn (its tools), the note
 * (its words) and the run's start (its inbox from the ask, its own close).
 */
const REOPEN_PARTS = [turnLoopParts, delegatedTurnParts, afterNightPromptsParts, runDispatchParts];

/**
 * May a Loop message after a finished build the chat's own session led reopen that same run
 * (reopen-run.ts)? A kept older runner, turn, note or start: the message is answered as with Loop off.
 */
export function ownSessionReopens(): boolean {
  return ownSessionAfterNight() && servesReopen(REOPEN_PARTS);
}

/**
 * What the coordinator's reopen depends on: the coordinator (it passes the Loop on), its prompt (it
 * words it) and the run's start (its inbox from the ask, its own close).
 */
const COORDINATOR_REOPEN_PARTS = [coordinatorParts, coordinatorPromptsParts, runDispatchParts];

/**
 * May a Loop message after a finished build the run's coordinator answers for reopen it through the
 * coordinator's continue_build (reopen-run.ts `finishedNight`)? A kept older coordinator, prompt or
 * start: the message is answered as with Loop off.
 */
export function coordinatorReopens(): boolean {
  return servesReopen(COORDINATOR_REOPEN_PARTS);
}

/**
 * Answer one user message: route it, run its turn, and launch the night an interview asked for.
 * `steer` is the queue's door into this turn for what the person sends while it works
 * (chat-steer.ts); Studio's own chat never takes it.
 */
export async function handleUserMessage(studio: Studio, action: QueueAction, steer?: SteerHandle): Promise<void> {
  const steering = steer && !action.studioThread ? steer : undefined;
  // A turn answered by a session: what is sent while it is set up joins it (Sending…), instead
  // of showing as Queued until the session starts. Known by the engine's name at once; any
  // other session engine is found by its description below, once the turn's engine is known.
  if (steering && hasSessionRoles(action.engine)) await steering.expect();
  const existing = await routeMessage(studio, action);
  const nights = await nightsFor(studio.host, action, existing);
  const { after } = nights;
  carryMoodBoard(studio.moodBoards, action);
  const ctx = studio.scoped(action.threadId, StatusLane.Chat);
  if (steering) await expectSession(studio.host, action, existing, steering);
  if (asksStudioThreadToBuild(action)) return answerStudioThreadBuild(studio.host, ctx, action);

  ctx.setStatus("thinking");
  const turn = await studio.host.call(HostMethod.TurnBegin, {
    threadId: action.threadId,
    input: userInput(action),
    metadata: turnMetadata(action, after),
  });
  try {
    // Stopped before its turn began: nothing answers it, and the chat is told.
    if (ctx.cancelled) await stoppedBeforeTurn(studio.host, ctx, turn.turnId);
    else await answerMessage(studio, ctx, action, { turnId: turn.turnId, existing, ...nights }, steering);
  } catch (err: any) {
    await failChatTurn(studio.host, ctx, turn.turnId, err);
  } finally {
    studio.stoppedMessages?.delete(String(action.messageId));
    ctx.setStatus("idle");
  }
}

/** A turn the user stopped before it began: said in the chat, then ended as interrupted. */
async function stoppedBeforeTurn(host: Host, ctx: HarnessCtx, turnId: string): Promise<void> {
  await sayInTurn(ctx, turnId, MESSAGE.stoppedBeforeTurn);
  await endInterrupted(host, turnId);
}

/** The engine and model a turn is recorded on: the message's, or the lead's session's after its night. */
function turnMetadata(action: QueueAction, after: AfterNight | null): { engine: string; model?: string } {
  const engine = after?.engine ?? action.engine ?? EngineId.Ollama;
  const model = after ? after.model : action.model;
  return { engine, ...(model ? { model } : {}) };
}

/**
 * The turn's engine answers with a session: expect it. The message may name none, and its run's
 * engine answers (a second expect is harmless); any other session engine is known only by its
 * description.
 */
async function expectSession(
  host: Host,
  action: QueueAction,
  existing: RunRecord | null,
  steer: SteerHandle,
): Promise<void> {
  if (await answersInSession(host, turnEngine(action, existing))) await steer.expect();
}

/** The engine a message is answered on: its own, else its run's. */
function turnEngine(action: QueueAction, existing: RunRecord | null): string {
  return action.engine ?? existing?.engine ?? EngineId.Ollama;
}

/** Does this engine answer with a session: one known by name, or described so? */
async function answersInSession(host: Host, engine: string): Promise<boolean> {
  if (hasSessionRoles(engine)) return true;
  const described = await host.call(HostMethod.EngineDescribe, {}).catch(() => []);
  return supportsSessions(described.find((e) => e.id === engine));
}

/**
 * The nights a routed message answers after, resolved once: the chat's own session's (after-night.ts)
 * — its engine and model are the turn's — or, for the run's coordinator, a finished build its
 * continue_build may reopen with the message's Loop. A message for a run drops its commission, so it
 * cannot commission a second run — unless the build it answers after may be reopened with it
 * (reopen-run.ts). Decided once: from here the turn takes the messages sent meanwhile with the
 * commission it kept (message-queue.ts). A Loop dropped after a finished build is `loopUnused`.
 */
async function nightsFor(host: Host, action: QueueAction, existing: RunRecord | null): Promise<RoutedNights> {
  if (!existing) return { after: null, coordinated: null, loopUnused: false };
  // Words the chat wrote itself are never the person asking for more: whatever Loop they came with.
  if (chatWrote(action)) dropCommission(action);
  const after = await afterNightFor(host, action, existing);
  const coordinated = after ? null : await coordinatorNight(host, action, existing);
  const kept = keepsCommission(existing, after ?? coordinated);
  const commissioned = Boolean(action.autopilot ?? action.loop);
  if (!kept) dropCommission(action);
  return { after, coordinated, loopUnused: commissioned && !kept && existing.state === RunState.Finished };
}

/** The nights a message answers after (`nightsFor`). */
interface RoutedNights {
  after: AfterNight | null;
  coordinated: AfterNight | null;
  loopUnused: boolean;
}

/**
 * A finished build the run's coordinator answers for, when a Loop came with the message and the
 * coordinator may reopen it (reopen-run.ts `finishedNight`). A coordinator on a model without
 * sessions answers with tools in bounded rounds and could take a question for work: it is never
 * handed a build's hours.
 */
async function coordinatorNight(host: Host, action: QueueAction, existing: RunRecord): Promise<AfterNight | null> {
  if (!(action.autopilot ?? action.loop) || !coordinatorReopens()) return null;
  if (!(await answersInSession(host, turnEngine(action, existing)))) return null;
  return finishedNight(host, action.threadId, existing, action.messageId);
}

/** Does this run own the message's thread or the project the message is about? */
function ownsMessage(active: ActiveRun, action: QueueAction): boolean {
  if (active.threadId === action.threadId) return true;
  return Boolean(action.project) && active.run.project === action.project;
}

/**
 * The run a message is for: the one under way on its thread or project, else the thread's last one.
 * A run that has closed is the log's (finished or paused) even while its learning pass runs. Whether
 * the message keeps its commission is decided once the night it answers after is known
 * (`keepsCommission`).
 */
async function routeMessage(studio: Studio, action: QueueAction): Promise<RunRecord | null> {
  // A message never clears an active run's stop flag. Cancellation is an explicit action; a run
  // that has closed (a Stop's, settling) no longer holds it.
  const active = [...studio.activeRuns.values()].find((a) => ownsMessage(a, action) && !a.done);
  // A Stop pressed for this very message (still sending, or waiting at the front) is kept.
  const stoppedFirst = studio.stoppedMessages?.has(String(action.messageId)) === true;
  if (!active && !stoppedFirst) studio.cancels.delete(action.threadId);
  const previousRun = latestRun(await studio.host.call(HostMethod.EventsList, { threadId: action.threadId }));
  return existingRun(action, active, previousRun);
}

/**
 * Did the chat write this message itself (`origin`: a command's result), not the person? It may
 * carry the chat's Loop — sent while the chat's history loaded, or queued before an upgrade — but it
 * never keeps one for a run, nor inherits one from a question to reopen a build with.
 */
function chatWrote(action: QueueAction): boolean {
  return action.origin !== undefined && action.origin !== null;
}

/** A routed message's Loop or Autopilot commission, dropped. */
function dropCommission(action: QueueAction): void {
  delete action.autopilot;
  delete action.loop;
}

function existingRun(action: QueueAction, active: ActiveRun | undefined, previousRun: RunRecord | null) {
  // Older profiles recorded project runs in Studio. They remain history, never authority to
  // route a new Studio question into that project's coordinator or start another build.
  if (action.studioThread) return null;
  if (active) return active.run;
  // A New build queued before the composer dropped it still starts afresh.
  const startsAfresh = action.newRun === true && previousRun?.state === RunState.Finished;
  return startsAfresh ? null : previousRun;
}

/**
 * Before a run exists, "keep going" can be the answer to its intake interview. Preserve the
 * explicitly selected mode and launch tool: the mood board a message brings is kept for the
 * thread, and a message without one gets the thread's.
 */
function carryMoodBoard(moodBoards: Studio["moodBoards"], action: QueueAction): void {
  if (!action.autopilot) return;
  if (action.autopilot.frames?.length) {
    moodBoards.set(action.threadId, action.autopilot.frames);
    return;
  }
  const kept = moodBoards.get(action.threadId);
  if (kept?.length) action.autopilot.frames = kept;
}

/**
 * The host rewound this chat (its log reads without the withdrawn turns). A Loop interview's
 * mood board rides in memory between messages: it becomes the one the remaining messages gave,
 * when the withdrawn ones had changed it. Absent `frames` leaves the board untouched.
 */
export function rewindMoodBoard(
  moodBoards: Studio["moodBoards"],
  action: { threadId: string; frames?: unknown[] | null },
): void {
  if (!("frames" in action)) return;
  if (action.frames?.length) moodBoards.set(action.threadId, action.frames);
  else moodBoards.delete(action.threadId);
}

function asksStudioThreadToBuild(action: QueueAction): boolean {
  return Boolean(action.studioThread && (action.loop || action.autopilot));
}

/** The user's words as the turn's input; a queued message is already in the log. */
function userInput(action: QueueAction) {
  return action.messageId ? [] : [{ role: "user" as const, content: action.text as string }];
}

/** The Studio's own chat never builds: say where builds happen instead. */
async function answerStudioThreadBuild(host: Host, ctx: HarnessCtx, action: QueueAction): Promise<void> {
  const content = MESSAGE.studioThreadBuilds;
  ctx.setStatus("thinking");
  const turn = await host.call(HostMethod.TurnBegin, {
    threadId: action.threadId,
    input: userInput(action),
    metadata: { engine: action.engine ?? EngineId.Ollama },
  });
  try {
    await host.call(HostMethod.TurnAppend, {
      turnId: turn.turnId,
      batch: [{ type: EventKind.Messages, messages: [{ role: "assistant", content }] }],
    });
    host.notify("chat.message", { role: "assistant", content });
    await host.call(HostMethod.TurnEnd, { turnId: turn.turnId, status: TurnStatus.Ok });
  } catch (err: any) {
    await host.call(HostMethod.TurnEnd, { turnId: turn.turnId, status: TurnStatus.Error });
    host.notify("chat.error", { message: err?.message ?? String(err) });
  } finally {
    ctx.setStatus("idle");
  }
}

/** The turn a message is answered in: its id, the run it is about, and the nights it answers after. */
interface AnswerTurn extends RoutedNights {
  turnId: string;
  existing: RunRecord | null;
}

/**
 * The turn itself: the chat's own turn — after a night its lead led too, with the run's controls —
 * or the run's coordinator with any follow-up it commissions; then what the reply asked for.
 */
async function answerMessage(
  studio: Studio,
  ctx: HarnessCtx,
  action: QueueAction,
  turn: AnswerTurn,
  steer: SteerHandle | undefined,
): Promise<void> {
  const { turnId, existing, after, coordinated } = turn;
  // The Loop that came with it cannot continue this finished build: said once, not on every message.
  if (turn.loopUnused && firstLoopUnused(studio, String(existing?.runId)))
    await sayInTurn(ctx, turnId, REOPEN_MESSAGE.loopUnused);
  const turnCtx = threadViewCtx(ctx, action);
  const outcome =
    existing && !after
      ? await coordinatorAnswer(studio.host, ctx, turnCtx, { action, turnId, existing, steer, coordinated })
      : await runTurn(turnCtx, chatTurnOptions(action, turnId, steer, after));
  if (ctx.cancelled) {
    // A Stop the engine answered with a stopped result reads as one it threw (`failChatTurn`).
    await endInterrupted(studio.host, turnId);
    return;
  }
  // How the loop ended it stays on the turn's own record: a throttled or round-capped turn is not
  // an answer (P07-F3).
  const stopped = outcome?.stopped;
  await studio.host.call(HostMethod.TurnEnd, {
    turnId,
    status: TurnStatus.Ok,
    ...(stopped ? { outcome: stopped } : {}),
  });
  await afterTheReply(studio, ctx, action, outcome, turn);
}

/**
 * The night the chat's own session answers after (after-night.ts), with the message it answers;
 * null when the coordinator answers: a run under way, a night no lead of the chat's own led, an
 * engine without sessions, or a kept chat turn or brief that does not serve it.
 */
async function afterNightFor(host: Host, action: QueueAction, existing: RunRecord): Promise<AfterNight | null> {
  if (!ownSessionAfterNight()) return null;
  const night = await afterLeadNight(host, action, existing);
  if (!night) return null;
  return {
    ...night,
    ...(action.messageId ? { messageId: action.messageId } : {}),
    // Its finished build may be reopened only when every part the reopen depends on serves it, and
    // only by the person's own words: a question's Loop a command's result would inherit is not theirs.
    ...(ownSessionReopens() && !chatWrote(action) ? { reopenable: true } : {}),
  };
}

/** What the coordinator answers with: the message it answers, the run it answers for, and the steer. */
interface CoordinatorAsk {
  action: QueueAction;
  turnId: string;
  existing: RunRecord;
  steer: SteerHandle | undefined;
  /** The finished build its continue_build may reopen with the message's Loop (`coordinatorNight`). */
  coordinated: AfterNight | null;
}

/**
 * The run's coordinator answers, and the builder takes the work it commissioned in this same chat
 * turn — or, when the message kept its Loop for a finished build, the same build goes on with it,
 * reopened once the reply ends.
 */
async function coordinatorAnswer(
  host: Host,
  ctx: HarnessCtx,
  turnCtx: HarnessCtx,
  { action, turnId, existing, steer, coordinated }: CoordinatorAsk,
): Promise<TurnOutcome | undefined> {
  const commission = action.autopilot ?? action.loop;
  // The stills it is shown reach the reopened build only as its words (`coordinatorReopenRules`).
  const frameCount = action.stills?.length ?? 0;
  const reopen = reopens(coordinated, commission) ? { hours: commissionHours(commission), frameCount } : null;
  await runCoordinatorTurn(ctx, { ...action, turnId, run: existing, ...(steer ? { steer } : {}), reopen });
  const followup = ctx.cancelled ? null : await followupFor(host, action, existing);
  if (!followup) return undefined;
  // A contained change is one builder turn, Loop or not: only more work reopens the build.
  if (reopen && !followup.contained) return reopenOutcome(reopen.hours, reopenRequest(followup.text, steer));
  return runTurn(turnCtx, followupOptions(action, turnId, followup, existing, steer));
}

/** The coordinator's continued work as a reopen of the same build, done once the reply ends (`afterTheReply`). */
function reopenOutcome(hours: number | null, text: string): TurnOutcome {
  return { stopped: TurnStop.Done, round: 0, details: { reopenRun: { hours, text } } };
}

/**
 * What the reply asked for, done once it has ended: the paused night the chat's own session asked
 * to resume (its lead is that same session), the finished build it or the run's coordinator asked to
 * reopen, or the night an interview launched.
 */
async function afterTheReply(
  studio: Studio,
  ctx: HarnessCtx,
  action: QueueAction,
  outcome: TurnOutcome | undefined,
  { after, coordinated }: RoutedNights,
): Promise<void> {
  const resume = after ? outcome?.details?.resumeRun : null;
  if (after && resume) return resumeAfterReply(studio, ctx, after, resume);
  const night = after ?? coordinated;
  const reopen: ReopenAsk | null = night ? outcome?.details?.reopenRun : null;
  // The chat's own session's reopen takes the message's models; the coordinator's keeps the build's.
  if (night && reopen)
    return reopenOrSayWhy(studio, ctx, action, night, { ...reopen, models: sessionModels(action, after, reopen) });
  const spec = outcome?.stopped === TurnStop.LaunchRun ? outcome.details?.run : null;
  if (spec) await launchOrSayWhy(studio, ctx, action, spec);
}

/**
 * What the reopened build's lead, workers and judges run on after the chat's own session's reopen:
 * the model it answers on, the Loop's roles and the message's effort and preferences, as a launch
 * from that message takes them; none (the build's own) after the coordinator's.
 */
function sessionModels(action: QueueAction, after: AfterNight | null, ask: ReopenAsk): ReopenModels | null {
  if (!after) return null;
  return { model: after.model, ...(ask.roles ? { roles: ask.roles } : {}), ...commissionedWith(action) };
}

/**
 * Reopen the finished build the chat's own session or the coordinator asked for (reopen-run.ts), or say why not: the
 * same run started again as a resume from its ask on, like a launch from this turn — a Stop since
 * this message began is for it (`keepStop`).
 */
function reopenOrSayWhy(
  studio: Studio,
  ctx: HarnessCtx,
  action: QueueAction,
  night: AfterNight,
  ask: ReopenAsk & { models: ReopenModels | null },
): Promise<void> {
  const { threadId } = action;
  const start = (run: RunSpec & AnyRecord, reopen: RunReopen): Promise<void> =>
    handleRunStart(studio, { type: "run_start", threadId, run, resume: true, reopen }, { keepStop: true });
  return reopenAfterReply(studio, ctx, night, { ...ask, words: String(action.text ?? "") }, start);
}

/**
 * The ctx the chat's own turn runs with: a queued message sees its thread only up to itself.
 * The live `cancelled` getter is kept; an object spread would freeze cancellation at turn start.
 */
function threadViewCtx(ctx: HarnessCtx, action: QueueAction): HarnessCtx {
  const turnCtx: HarnessCtx = {
    ...ctx,
    call: (async (method: string, p?: AnyRecord) => {
      const readsLog = method === HostMethod.EventsList || method === HostMethod.EventsMessages;
      const readsThisThread = readsLog && p?.threadId === action.threadId;
      if (action.messageId && readsThisThread) {
        const view = conversationThrough(await ctx.call(HostMethod.EventsList, p), action.messageId);
        return method === HostMethod.EventsMessages ? eventsToMessages(view) : view;
      }
      return (ctx.call as ForwardedCall)(method, p);
    }) as HostCall,
  };
  // Preserve the live getter; object spread would freeze cancellation at turn start.
  Object.defineProperty(turnCtx, "cancelled", { get: () => ctx.cancelled });
  return turnCtx;
}

/** A chat turn's options: the message's own fields, and the optional ones only when set. */
function chatTurnOptions(
  action: QueueAction,
  turnId: string,
  steer: SteerHandle | undefined,
  after: AfterNight | null,
): TurnOptions {
  return {
    text: action.text,
    threadId: action.threadId,
    turnId,
    engine: action.engine ?? EngineId.Ollama,
    model: action.model,
    effort: action.effort,
    preferences: action.preferences,
    project: action.project,
    newProject: action.newProject,
    studioThread: action.studioThread,
    resume: action.resume,
    ...(action.projectDir ? { projectDir: action.projectDir } : {}),
    ...(action.extraReads ? { extraReads: action.extraReads } : {}),
    ...(action.stills ? { stills: action.stills } : {}),
    ...(action.loop ? { loop: action.loop } : {}),
    ...(action.autopilot ? { autopilot: action.autopilot } : {}),
    ...(steer ? { steer } : {}),
    ...(after ? afterNightOptions(after) : {}),
  };
}

/**
 * The chat's own session after its night: the night it answers after, on the lead's engine — also
 * for a message that names none — and on the model it led on when the message names none: the same
 * session on the same model, which a Resume's lead continues.
 */
function afterNightOptions(after: AfterNight): Partial<TurnOptions> {
  return { afterNight: after, engine: after.engine, ...(after.model ? { model: after.model } : {}) };
}

/**
 * The builder's turn for the work the coordinator commissioned, in this same chat turn: the
 * latest request, plus what the person steered into the coordinator's turn that it did not restate.
 */
function followupOptions(
  action: QueueAction,
  turnId: string,
  followup: { text: string; plan: unknown },
  existing: RunRecord,
  steer: SteerHandle | undefined,
): TurnOptions {
  const steered = steeredForBuilder(steer, followup.text);
  const stills = steered.flatMap((message) => message.stills ?? []);
  const request = withSteers(
    followup.text,
    steered.map((message) => String(message.text)),
  );
  return {
    ...action,
    loop: undefined,
    autopilot: undefined,
    followupOf: String(existing.runId),
    turnId,
    ...(steer ? { steer } : {}),
    ...(stills.length ? { stills: [...(action.stills ?? []), ...stills] } : {}),
    text: followupAsk(request, followup.plan, existing),
  };
}

/**
 * What the person steered into the coordinator's turn reaches the builder too, unless the
 * coordinator already wrote it into the request. A replay's carried messages are left out: the
 * builder's own first prompt carries them already (chat-steer.ts).
 */
function steeredForBuilder(steer: SteerHandle | undefined, request: string): QueueAction[] {
  if (!steer) return [];
  return unrestated(
    steer.delivered.filter((message) => !steer.carried.includes(message)),
    request,
  );
}

/** The messages with words that the request does not already restate. */
function unrestated(messages: readonly QueueAction[], request: string): QueueAction[] {
  const asked = request.toLowerCase();
  return messages.filter((message) => {
    const text = String(message.text ?? "").trim();
    return Boolean(text) && !asked.includes(text.toLowerCase());
  });
}

/**
 * The ask a coordinator's continued work reopens the build with: its request, plus what the person
 * steered into its turn that it did not restate — a replay's carried messages too, since the
 * reopened night's inbox reads only from this ask on.
 */
function reopenRequest(request: string, steer: SteerHandle | undefined): string {
  const steered = unrestated(steer?.delivered ?? [], request);
  return withSteers(
    request,
    steered.map((message) => String(message.text)),
  );
}

/** The follow-up the coordinator asked for on this message, with the plan the work was saved under. */
async function followupFor(
  host: Host,
  action: QueueAction,
  existing: RunRecord,
): Promise<{ text: string; plan: unknown; contained: boolean } | null> {
  const events = await host.call(HostMethod.EventsList, { threadId: action.threadId });
  // The latest request for this message: the coordinator may have restated it after a steer.
  const followup = events
    .filter(
      (e) =>
        e.data?.event_type === RunEvent.RunFollowupRequested && e.data.payload?.sourceMessageId === action.messageId,
    )
    .at(-1)?.data.payload;
  if (!followup) return null;
  const journal = await readJournal(host, action.threadId, existing.runId);
  const plan = journal?.director?.plan ?? journal?.plan ?? lastReviewedPlan(events);
  return { text: followup.text, plan, contained: followup.build === false };
}

function lastReviewedPlan(events: readonly HarnessEvent[]): unknown {
  return events.filter((e) => e.data?.event_type === RunEvent.PlanReview && e.data.payload?.plan).at(-1)?.data.payload
    ?.plan;
}

/** Launch the night an interview asked for, or say in the chat why it did not start. */
async function launchOrSayWhy(studio: Studio, ctx: HarnessCtx, action: QueueAction, spec: AnyRecord): Promise<void> {
  const { host } = studio;
  await launchFromIntake(studio, ctx, action, spec).catch(async (err: any) => {
    const failure = err?.message ?? String(err);
    // A launch that dies before run_started needs no run_finished — but it still owes the
    // chat a durable word, not just a push that vanishes with the window.
    await host
      .call(HostMethod.EventsAppend, {
        threadId: action.threadId,
        batch: [{ type: EventKind.Error, message: MESSAGE.couldNotLaunch(failure) }],
      })
      .catch(() => {});
    host.notify("run.failed", { error: failure });
  });
}

/** A stopped turn's durable trace: it says it was interrupted, and ends cancelled. */
async function endInterrupted(host: Host, turnId: string): Promise<void> {
  await host.call(HostMethod.TurnAppend, {
    turnId,
    batch: [{ type: EventKind.Custom, event_type: RunEvent.SessionActivity, payload: { phase: INTERRUPTED_PHASE } }],
  });
  await host.call(HostMethod.TurnEnd, { turnId, status: TurnStatus.Cancelled });
}

/** A turn that threw: a stop is an interruption, anything else an error the chat is told about. */
async function failChatTurn(host: Host, ctx: HarnessCtx, turnId: string, err: any): Promise<void> {
  if (ctx.cancelled) {
    await endInterrupted(host, turnId);
    return;
  }
  await host.call(HostMethod.TurnAppend, {
    turnId,
    batch: [{ type: EventKind.Error, message: MESSAGE.turnFailed(err?.message ?? err) }],
  });
  await host.call(HostMethod.TurnEnd, { turnId, status: TurnStatus.Error });
  host.notify("chat.error", { message: err?.message ?? String(err) });
}

/**
 * Launch the night an interview commissioned. Throws the sentence the chat is owed when it cannot
 * start: no goal, a folder that refuses, or a build already running for this chat or project.
 */
export async function launchFromIntake(
  studio: Studio,
  ctx: HarnessCtx,
  action: QueueAction,
  spec: AnyRecord,
): Promise<void> {
  const { host } = studio;
  requireGoal(spec);
  const projects = await host.call(HostMethod.ProjectList, {});
  const project = intakeProject(action, spec, projects);
  if (!projects.some((g) => g.name === project)) {
    await ctx.call(HostMethod.ProjectScaffold, {
      name: project,
      title: spec.goal?.slice(0, CLIP_PROJECT_TITLE) || project,
      threadId: action.threadId,
    });
  }
  // What the folder itself refuses (nightRefusal): a page that cannot load, a project that is
  // already compiled. Said in chat now, instead of found out at 3am.
  const readiness = await host.call(HostMethod.ProjectValidate, { project }).catch(() => null);
  const refusal = nightRefusal(projects.find((g) => g.name === project) ?? null, readiness?.problems ?? []);
  if (refusal) throw new Error(refusal);
  const run = intakeRun(spec, action, project, readiness);
  // A promise the night cannot keep is worse than no promise: a second Overnight for a project
  // that already owns a run is refused below, and the only record of that refusal is an event
  // no chat surface renders. Ask the same question here, before anything is promised — once a
  // run that has closed there is past its learning pass, which a new night waits out.
  const busy = await runUnderWay(studio, action.threadId, project);
  if (busy) throw new Error(MESSAGE.alreadyBuilding(busy.run.project));
  // Stop while that pass was waited out was for this night too.
  if (ctx.cancelled) throw new Error(MESSAGE.stoppedBeforeLaunch);
  // The board did its job — the run spec carries the frames now; the next interview on this
  // thread starts with a clean slate.
  studio.moodBoards.delete(action.threadId);
  await host
    .call(HostMethod.EventsAppend, {
      threadId: action.threadId,
      batch: [
        {
          type: EventKind.Messages,
          messages: [{ role: "assistant", content: launchPromise(run.budgets, run.readiness, Date.now()) }],
        },
      ],
    })
    .catch(() => {});
  // Same thread: the night is this chat's story. handleRunStart holds keep-awake via notify.
  // The commission is handled at launch, so restart cannot replay it. Synchronous run
  // reservation keeps later queued messages behind the build until it saves and settles.
  // A Stop since this message is for this build: the start keeps it (`keepStop`).
  void handleRunStart(studio, { type: "run_start", threadId: action.threadId, run }, { keepStop: true }).catch(
    (err: unknown) => host.notify("run.failed", { error: String(err) }),
  );
}

/**
 * A run without a goal is judged against nothing — one interview leaked its goal into the
 * reference field and a 4-hour run launched with goal "undefined". Refuse loudly instead.
 */
function requireGoal(spec: AnyRecord): void {
  const goal = typeof spec.goal === "string" ? spec.goal.trim() : "";
  if (EMPTY_GOALS.has(goal)) throw new Error(MESSAGE.noGoal);
}

/**
 * Where the night builds is the chat's answer, never the interviewer's. A thread bound to a
 * folder keeps it; otherwise the loop's own resolved folder rides on the spec (turn-loop
 * stamps it), and only a chat with no folder at all falls back to the tool's slug. The
 * slug once won over the binding and the run built in a second, empty folder — with the
 * user typing into the chat attached to the first.
 */
function intakeProject(action: QueueAction, spec: AnyRecord, projects: readonly { name: string }[]): string {
  const bound = typeof action.project === "string" && projects.some((g) => g.name === action.project);
  if (bound) return action.project;
  const named = typeof spec.project === "string" ? spec.project.trim() : "";
  return named || FALLBACK_PROJECT;
}

/**
 * The time a commissioned run is given: its hours (held to the run limits), and whether the
 * composer asked for ∞, which runs until the judge is satisfied with those hours as the ceiling.
 * The app reads these back (`src/shared/run-state.ts` `recordedRunLoop`).
 */
export function intakeBudgets(spec: AnyRecord): RunSpec["budgets"] {
  const hours = clampRunHours(Number(spec.hours) || DEFAULT_RUN_HOURS);
  return {
    wallClockMs: Math.round(hours * HOUR_MS),
    completionPolicy: spec.untilSatisfied === true ? CompletionPolicy.Goal : CompletionPolicy.Duration,
    ...(spec.untilSatisfied === true ? { untilSatisfied: true } : {}),
  };
}

/** The run an interview commissioned, as `run_start` takes it. */
function intakeRun(
  spec: AnyRecord,
  action: QueueAction,
  project: string,
  readiness: { contract?: string; problems?: string[] } | null,
): RunSpec & AnyRecord {
  return {
    runId: `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    goal: spec.goal,
    project,
    reference: spec.reference,
    budgets: intakeBudgets(spec),
    // What the folder still needs, as `project.validate` found it a moment ago. Not a refusal —
    // `nightRefusal` above decides those — but the night's own first job: a page that never
    // loads the studio contract cannot be judged at all, so the run carries the fact and the
    // director installs it before anyone builds (M2.6, loop/director.ts `installContract`).
    ...(readiness
      ? { readiness: { contract: readiness.contract ?? "loaded", problems: readiness.problems ?? [] } }
      : {}),
    ...(spec.reviewPlan ? { reviewPlan: true } : {}),
    ...(spec.mode ? { mode: spec.mode } : {}),
    ...(spec.engine ? { engine: spec.engine } : {}),
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.roles ? { roles: spec.roles } : {}),
    // The run inherits the interview's effort: builders work at exactly the model and effort
    // the user generates with, never a quieter tier than the chat that commissioned them.
    ...commissionedWith(action),
  };
}

/** The effort and preferences a message commissions a build with: a launch's (`intakeRun`) and a reopen's. */
function commissionedWith(action: QueueAction): { effort?: string; preferences?: ModelPreferences } {
  return {
    ...(action.effort ? { effort: action.effort } : {}),
    ...(action.preferences ? { preferences: action.preferences } : {}),
  };
}

/**
 * The one sentence a night owes the user before they walk away when their project cannot yet be
 * judged: the studio has to wire its own connection into the project before it can tell whether
 * anything it changes is an improvement, and that is the first thing tonight does (M2.6). Said
 * here, in the chat, rather than discovered in the morning as "the other build could not be
 * observed" — the words no one outside the harness could read.
 */
export function judgeableFirst(readiness: { contract?: string } | null | undefined): string {
  if (readiness?.contract !== StudioContract.Missing) return "";
  return MESSAGE.connectionFirst;
}

/** What the chat promises the moment a commissioned run launches at `now`: when it ends, and what it needs. */
export function launchPromise(
  budgets: RunSpec["budgets"],
  readiness: { contract?: string } | null | undefined,
  now: number,
): string {
  const when = budgets.untilSatisfied
    ? MESSAGE.untilSatisfiedPromised(dayAndClockAfter(budgets.wallClockMs, now))
    : MESSAGE.nightPromised(clockAfter(budgets.wallClockMs, now));
  return when + MESSAGE.planWindow + judgeableFirst(readiness);
}

/** "Sunday 10:05 PM" — the day and wall clock this many milliseconds after `now`. */
function dayAndClockAfter(ms: number, now: number): string {
  return new Date(now + ms).toLocaleString([], { weekday: "long", hour: "numeric", minute: "2-digit" });
}

/**
 * "07:10", or "13:44 tomorrow" — the local wall clock this many milliseconds after `now`, with its
 * day when that is not today (wall-clock.ts): a 24-hour build ends at the minute it began. A
 * duration is not an answer to "when can I look?".
 */
function clockAfter(ms: number, now: number): string {
  return endClock(ms, now);
}
