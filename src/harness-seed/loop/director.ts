import { tracedContext } from "./director/trace.ts";
import { retainSpan, type OperationSpan } from "./director/timing.ts";
/**
 * The director (director, 2026-09-07) — the run as one agent's decisions, not a program's phases.
 *
 * Before this, a run was a fixed pipeline: scout → planner → base → N facet loops → merge →
 * ledger → integration facet → land. The pipeline never looked at the project; the loops decided
 * everything by rule (fair share, spikes, replans), and the one model that saw the whole run
 * — the planner — saw it once, before anything was built. Runs built the wrong map, split one
 * scene six ways and blamed one facet for another's regression, because no one was in charge.
 *
 * Now one delegated session — the director — runs the night in the run's integration worktree
 * with the computer tool on a window of its own and the harness's machinery as tools:
 *
 *   plan           the night's plan, in the user's chat, before the first worker
 *   goal_update    a required goal's external blocker, or its one replan after two attempts
 *   worker_start   a builder in a worktree of its own — a judged facet loop, or one session
 *   worker_status / worker_steer / worker_stop
 *   judge          evidence + checks + a blind verdict on any build of the run
 *   playtest       a playtester session on any build
 *   integrate      merge a worker's accepted commit into the integration worktree (+ a health pass)
 *   show           offer a build to the user's Live (its Reload plays it)
 *   look           point the director's own window at a build (computer/capture follow it)
 *   note           a decision card in the run's feed
 *   finish         land the integration branch in the live folder and close the run
 *
 * The tools live here, in the harness process (it owns the loops, the judges and the merge);
 * the studio hosts the session and forwards each call through a dispatch that answers
 * (`director_tool`). The old pipeline (autopilot.ts) stays for direct engines, which cannot
 * hold a session, and as `run.classic`.
 *
 * The session is driven by the wake loop (director/wake.ts): the director ends its turn after
 * each decision and the studio wakes the same session with a digest when something happens.
 * The long turn it replaced — `wait` in a loop, a continuation prompt whenever the turn ended
 * with time left, one wrap-up — stays behind `run.directorLoop: "turn"` for one release.
 *
 * On the wake loop the lead IS its chat's own session (one session, director/lead-session.ts): it
 * sits in the project folder and builds with its own hands in the integration worktree it leads, by
 * its full path, committing there beside the workers it hands parallel parts to — a merge conflict
 * goes to a worker of its own — and the chat goes on in the same session after the close. The long
 * turn keeps a separate director whose cwd is the integration worktree.
 */
import { plannerModel, roleEffort, RoleKey } from "./model-roles.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { GIT, gitAt } from "./git.ts";
import { MIN_DELEGATE_TIMEOUT_MS, PLAN_REVIEW_WAIT_MS } from "./config.ts";
import { HostMethod } from "./host-methods.ts";
import { EngineFailure, engineLimitOf, isEngineLimit, limitWords, StopReason } from "./outage.ts";
import { RunEvent } from "./run-events.ts";
import { isCommit } from "./shell.ts";
import { isResumeFailure } from "./chat-session.ts";
import { CLIP_QUOTE } from "./text.ts";
import { MINUTE_MS, minutes, SECOND_MS, sleep } from "./time.ts";
import { NotLandedReason } from "./verdict.ts";
import * as nightFunctions from "./director/night.ts";
import * as workerFunctions from "./director/workers.ts";
import * as toolFunctions from "./director/tools.ts";
import * as integrateFunctions from "./director/integrate.ts";
import * as setupFunctions from "./director/setup.ts";
import * as briefFunctions from "./director/briefs.ts";
import * as journalFunctions from "./director/journal.ts";
import * as journalPromptFunctions from "./director/journal-prompts.ts";
import * as wakeFunctions from "./director/wake.ts";
import * as wakePromptFunctions from "./director/wake-prompts.ts";
import * as gitParts from "./git.ts";
import { servesLiveChat } from "./live-chat-served.ts";
import { prepareNight } from "./director/setup.ts";
import { reopenMarkOf } from "./director/reopen.ts";
import { reopenNote } from "./director/reopen-prompts.ts";
import { timedWorkRemaining } from "./director/budgets.ts";
import { continuationPrompt, directorBrief, limitResumePrompt, resumeNote, wrapUpPrompt } from "./director/briefs.ts";
import { DIRECTOR_TOOLS, directors } from "./director/tool-specs.ts";
import {
  LIMIT_WAIT_MARGIN_MS,
  MAX_LIMIT_WAITS,
  runWakeLoop,
  SYSTEM_CLOCK,
  WAKE_ENDING,
  WRAP_UP_MIN_MS,
} from "./director/wake.ts";
import { longTurnRules, wakeTools } from "./director/wake-prompts.ts";
import { DirectorLoop, directorLoopOf, WRAP_UP_MARGIN_MS, WrapCause } from "./director/wake-schedule.ts";
import { openLeadLine, type LeadLine } from "./director/lead-line.ts";
import { bookmarkLead, freshChat, leadSeat, servesLead } from "./director/lead-session.ts";
import type { Night } from "./director/night.ts";
import type { DirectorTalk } from "./director/wake.ts";
import type { AnyRecord, HarnessCtx, Run } from "../types/harness.d.ts";
import type { DelegateImage, DelegateResult, LiveToolSpec, ReferenceFrame } from "../types/host-api.d.ts";

/** Everything this file exported before the night was split into parts (director/rules.ts). */
export {
  MAX_WAIT_S,
  MAX_WORKERS,
  MIN_FREE_MB,
  wrapReserveMs,
  timedWorkRemaining,
  preparationBudgetMs,
  workerWindows,
  shortBudgetWarning,
  MONITOR_TICK_MS,
  MAX_DIRECTOR_MEMORY,
  clampDirectorMemory,
  directorMemoryKeep,
  DIRECTOR_TOOLS,
  directorTool,
  startingHeads,
  landingWords,
  iterationDigest,
  plainly,
  compilePlan,
  planReviewWaitMs,
  waitForPlanGo,
  monitorEveryMs,
  monitorFindings,
  monitorNote,
  medianMinutes,
  headSynced,
  clampBoard,
  loopDigest,
  loopNote,
  workerDigest,
  waitDigest,
  makeRouteDefect,
  contractBrief,
  directorBrief,
  wrapUpPrompt,
  singleWorkerBrief,
  compileWorkerSpec,
} from "./director/rules.ts";

/** How long a pass waits for a window before it decides there is none (config.ts, where the reasoning is). */
export { WINDOW_RETRIES_MS } from "./config.ts";
/** How long the user gets to answer a plan they asked to read: the classic pipeline's window. */
export { PLAN_REVIEW_WAIT_MS };

/** The director's modules, whose functions `bindNight` puts on the night. */
const NIGHT_MODULES = [nightFunctions, workerFunctions, toolFunctions, integrateFunctions, setupFunctions];
/** Every part a lead that writes nothing depends on: its words and its hands for one (lead-session.ts `servesLead`). */
const LEAD_PARTS = [
  ...NIGHT_MODULES,
  briefFunctions,
  journalFunctions,
  journalPromptFunctions,
  wakeFunctions,
  wakePromptFunctions,
  gitParts,
];

/**
 * Does a night on this loop seat a lead that is its chat's own session (one session)? The wake
 * loop does — unless a part it depends on is a kept copy from before one session, which would tell a
 * lead in the project folder to edit and commit in its worktree: then a director with its own hands
 * leads, in the integration worktree with its memory file, as it did before.
 */
export function seatsLead(loop: DirectorLoop): boolean {
  return loop === DirectorLoop.Wake && servesLead(LEAD_PARTS);
}

/** How many reference stills the director's first turn carries. */
const MAX_REFERENCE_IMAGES = 8;
/** How often the long turn's limit wait looks at `ctx.cancelled`. */
const LIMIT_WAIT_POLL_MS = SECOND_MS;
/** A continuation that made no tool call and returned within this is empty; this many in a row end the session. */
const EMPTY_TURN_MS = SECOND_MS;
const MAX_EMPTY_CONTINUATIONS = 3;
/** A session that ended within this of its deadline ran out of time. */
const OUT_OF_TIME_MS = MINUTE_MS;
/** The harness's own close of a night the director left open waits this long for the workers. */
const OPEN_NIGHT_SETTLE_MS = 30 * SECOND_MS;
/** How much of a crash's message the report keeps. */
const FAILURE_CHARS = 500;
/** How much of an engine limit's message the decision card quotes. */
const LIMIT_MESSAGE_CHARS = 160;

/** The director's playbook (skills/director.md — SkillOpt trains it), without its front matter. */
async function directorSkill(ctx: HarnessCtx): Promise<string> {
  try {
    const skill = await readFile(path.join(ctx.workspace, "skills", "director.md"), "utf8");
    return skill.replace(/^---[\s\S]*?---\n?/, "");
  } catch {
    return "";
  }
}

/** The reference stills the director's first turn carries. */
function referenceImages(run: Run): DelegateImage[] {
  return (run.reference?.frames ?? [])
    .filter((f: ReferenceFrame | null) => f?.data)
    .slice(0, MAX_REFERENCE_IMAGES)
    .map((f: ReferenceFrame) => ({
      label: `REFERENCE ${f.label}`,
      mimeType: f.mimeType ?? "image/jpeg",
      data: f.data,
    }));
}

/**
 * The run tools a director's session is offered: a waking lead has no `wait`, and one that writes
 * nothing hands a conflict to a worker (wake-prompts.ts `wakeTools`).
 */
function runTools(loop: DirectorLoop, night: Night): LiveToolSpec[] {
  return loop === DirectorLoop.Wake ? wakeTools(DIRECTOR_TOOLS, { lead: Boolean(night.lead) }) : DIRECTOR_TOOLS;
}

/**
 * One turn of the director's own session, on its own engine and model. A lead that is its chat's
 * own session (one session, director/lead-session.ts) sits in the project folder — no `cwd` — seated
 * as a lead (`readOnly`, which the host reads as the lead's seat, not a lock); its grant names the
 * integration worktree it leads and builds in (`root`). A long turn's director works in that worktree.
 */
function delegateTurn(
  night: Night,
  images: DelegateImage[],
  tools: LiveToolSpec[],
  prompt: string,
  sessionId: string | null | undefined,
  timeoutMs: number,
): Promise<DelegateResult> {
  const { ctx, integrationWorktree, lead, run, threadId } = night;
  return ctx.call(HostMethod.EngineDelegate, {
    engine: run.engine,
    prompt,
    project: run.project,
    ...(lead ? { readOnly: true } : { cwd: integrationWorktree }),
    threadId,
    // The director's session is the orchestrator: its own engine, its own model — never the
    // workers', which may belong to the other subscription (cross-provider roles).
    ...(plannerModel(run) ? { model: plannerModel(run) } : {}),
    effort: roleEffort(run, RoleKey.Planner),
    preferences: run.preferences,
    timeoutMs: Math.max(MIN_DELEGATE_TIMEOUT_MS, timeoutMs),
    ...(sessionId ? { resume: sessionId } : {}),
    // A waking lead answers the chat while its build runs: what the person sends reaches its turn
    // under way (`engine.steer`, addressed by the run; director/wake.ts).
    ...(night.waking ? { chatTurn: { messageId: run.runId } } : {}),
    director: {
      runId: run.runId,
      threadId,
      project: run.project,
      root: integrationWorktree,
      setup: run.setup ?? null,
      tools,
      ...(lead?.chatSession ? { chatSession: true } : {}),
    },
    ...(images.length ? { images } : {}),
  });
}

/**
 * The director's session. A session that dies of the engine's limit is not the director failing:
 * remember the limit and let the close choose between waiting, pausing and landing. (A night
 * once ended as a plain "error", retried the wrap-up into the same limit two seconds later, and
 * landed nothing.) What a turn answers with: the delegation's own result, or the limit it died of.
 */
export function directorTalk(night: Night, images: DelegateImage[], tools: LiveToolSpec[]): DirectorTalk {
  const { ctx, decision, journal, lead, priorJournal, run, saveJournal, state, threadId } = night;
  // The reference stills reach a new session, and a lead's first turn in the chat's own session.
  let stillsSeen = false;
  const stillsFor = (sid: string | null | undefined): DelegateImage[] => {
    const show = !sid || (Boolean(lead) && !stillsSeen);
    stillsSeen = true;
    return show ? images : [];
  };
  const talk: DirectorTalk = {
    sessionId: lead ? lead.sessionId : (priorJournal?.director?.sessionId ?? null),
    session: async (prompt, sid, timeoutMs) => {
      try {
        // A fresh lead session knows nothing of the chat it leads for: it is told the chat so far first.
        const chat = lead && !sid ? await freshChat(ctx, threadId) : "";
        const asked = chat ? `${chat}\n\n${prompt}` : prompt;
        return await delegateTurn(night, stillsFor(sid), tools, asked, sid, timeoutMs);
      } catch (err: any) {
        if (!isEngineLimit(err?.kind)) throw err;
        state.limit = engineLimitOf(err);
        await decision(
          `the engine hit its ${limitWords(err.kind)}: ${String(err.message ?? err).slice(0, LIMIT_MESSAGE_CHARS)}`,
          `your plan's ${limitWords(err.kind)} paused the build`,
        );
        return {
          ok: false,
          stopReason: err.kind,
          errorText: String(err.message ?? err),
          ...(sid ? { sessionId: sid } : {}),
        };
      }
    },
    keep: async (result) => {
      if (!result?.sessionId) return;
      talk.sessionId = result.sessionId;
      // The chat goes on in the session its lead answered with (one session).
      if (lead) await bookmarkLead(ctx, { threadId, run, seat: lead }, result.sessionId);
      // The session the journal already names: nothing new to keep, and the store keeps every version.
      if (journal.director.sessionId === talk.sessionId) return;
      journal.director.sessionId = talk.sessionId;
      await saveJournal();
    },
  };
  return talk;
}

/**
 * What the last session left on the branch, so a resumed night knows it has something to land — and,
 * for a finished build reopened, where it goes on from (director/reopen.ts).
 */
async function resumeWords(night: Night): Promise<string | null> {
  const { baseCommit, ctx, forkCommit, integrationWorktree, lead, memoryRestored, priorJournal, run } = night;
  if (!priorJournal?.director) return null;
  const moved = isCommit(forkCommit) && isCommit(baseCommit) && forkCommit !== baseCommit;
  const aheadOfBase = moved
    ? Number(
        await gitAt(ctx, integrationWorktree, GIT.revListCount(baseCommit, forkCommit), {
          label: `director:${run.runId}:ahead`,
        }).catch(() => "0"),
      ) || 0
    : 0;
  const note = resumeNote({
    runId: run.runId,
    forkCommit,
    baseCommit,
    aheadOfBase,
    priorDirector: priorJournal.director,
    memoryRestored,
    leads: Boolean(lead),
  });
  if (!reopenMarkOf(priorJournal)) return note;
  return `${reopenNote({ inFolder: forkCommit === baseCommit, forkCommit })} ${note}`;
}

/**
 * What the director stands on before its first turn. A project the user brought that cannot be
 * judged is made judgeable first (M2.6). Once that has worked it is never redone — the commit is
 * on the branch a resumed night stands on — but an attempt that failed (a session limit
 * mid-wiring, say) is worth one more try, since a night that gives up on this one is blind for
 * the rest of its hours. A night from scratch builds its starting point first — once per run: a
 * resumed run stands on the one it already has. (The two are exclusive: an own-shape project is
 * never from scratch.)
 */
async function prepareTheStart(night: Night): Promise<{ contract: AnyRecord | null; startingPoint: AnyRecord | null }> {
  const { baseCommit, buildStartingPoint, contractMissing, ctx, installContract, journal, priorJournal } = night;
  const { shotsOf, startEvidence, state, writeVerdict } = night;
  const firstNightOnABuild = !priorJournal?.director && !state.fromScratch;
  if (firstNightOnABuild && startEvidence) {
    await writeVerdict("director/start/verdict.json", {
      commit: baseCommit,
      ok: true,
      shots: shotsOf(startEvidence),
    });
  }
  const contract =
    contractMissing && !journal.contract?.ok && !ctx.cancelled ? await installContract() : journal.contract;
  const needsStartingPoint =
    state.fromScratch && !journal.base && !priorJournal?.director?.integrationHead && !ctx.cancelled;
  const startingPoint = needsStartingPoint ? await buildStartingPoint() : journal.base;
  return { contract, startingPoint };
}

/** The brief the director's session opens with (`directorBrief`), from what the night knows. */
function openingBrief(
  night: Night,
  skill: string,
  resume: string | null,
  start: AnyRecord,
  loop: DirectorLoop,
): string {
  const { capacity, finalDeadline, projectLessons, integrationWorktree, lead, nestedRepos, ownShape, run, shape } =
    night;
  const { softDeadline, state } = night;
  return directorBrief({
    run,
    shape,
    ownShape,
    capacity,
    skill,
    softDeadline,
    finalDeadline,
    resume,
    integrationWorktree,
    baseCommit: state.integrationHead,
    nestedRepos,
    startingPoint: start.startingPoint,
    startObserved: Boolean(state.startEvidence),
    projectLessons,
    contract: start.contract,
    loop,
    lead: lead ? { projectFolder: lead.folder } : null,
  });
}

/** The session's first turn: resumed where the last one left off, or opened afresh when that session is gone. */
async function openSession(night: Night, talk: DirectorTalk, brief: string): Promise<Partial<DelegateResult>> {
  const { softDeadline } = night;
  let result: Partial<DelegateResult>;
  try {
    result = await talk.session(brief, talk.sessionId, softDeadline - Date.now());
  } catch (err: any) {
    if (!talk.sessionId || !isResumeFailure(err)) throw err;
    talk.sessionId = null;
    result = await talk.session(brief, null, softDeadline - Date.now());
  }
  await talk.keep(result);
  return result;
}

/**
 * A session limit that resets well before the session's own deadline is waited out, the
 * workers running on; the director then continues its own session.
 */
async function waitOutLimits(
  night: Night,
  talk: DirectorTalk,
  first: Partial<DelegateResult>,
): Promise<Partial<DelegateResult>> {
  const { ctx, decision, softDeadline, state } = night;
  let result = first;
  const limited = () => !state.finished && !ctx.cancelled && state.limit?.kind === EngineFailure.RateLimit;
  for (let waits = 0; limited() && waits < MAX_LIMIT_WAITS; waits++) {
    const wait = state.limit?.retryAfterMs ?? 0;
    if (!wait || Date.now() + wait + LIMIT_WAIT_MARGIN_MS > softDeadline) break;
    await decision(
      `waiting ${minutes(wait)} minutes for the engine's limit to reset; the workers keep going`,
      `waiting about ${minutes(wait)} minutes for that limit to reset; the builders keep working`,
    );
    const until = Date.now() + wait;
    while (Date.now() < until && !ctx.cancelled) await sleep(LIMIT_WAIT_POLL_MS);
    if (ctx.cancelled) break;
    state.limit = null;
    result = await talk.session(limitResumePrompt(minutes(wait)), talk.sessionId, softDeadline - Date.now());
    await talk.keep(result);
  }
  return result;
}

/** Is the timed build still the session's to continue: nothing ended it, and working time is left? */
async function keepsBuilding(night: Night, result: Partial<DelegateResult>): Promise<boolean> {
  const { ctx, inbox, run, softDeadline, state } = night;
  if (state.finished || ctx.cancelled || state.limit || !result?.ok) return false;
  return timedWorkRemaining(run, softDeadline, Date.now(), await inbox.finishing());
}

/**
 * A model turn is not the user's build duration. Continue the same session while the working
 * budget remains; provider errors still take the existing failure/pause paths.
 */
async function continueTimedBuild(
  night: Night,
  talk: DirectorTalk,
  first: Partial<DelegateResult>,
): Promise<Partial<DelegateResult>> {
  const { appendRun, report, softDeadline, state } = night;
  let result = first;
  let emptyContinuations = 0;
  while (await keepsBuilding(night, result)) {
    await appendRun(RunEvent.DirectorContinued, { minutesLeft: minutes(softDeadline - Date.now()) });
    const turnStarted = Date.now();
    const toolsBefore = night.toolCalls;
    result = await talk.session(
      continuationPrompt(minutes(softDeadline - Date.now())),
      talk.sessionId,
      softDeadline - Date.now(),
    );
    await talk.keep(result);
    // A provider repeatedly returning empty turns must not spin or burn the remaining budget.
    const emptyTurn = night.toolCalls === toolsBefore && Date.now() - turnStarted < EMPTY_TURN_MS;
    emptyContinuations = emptyTurn ? emptyContinuations + 1 : 0;
    if (!state.finished && emptyContinuations >= MAX_EMPTY_CONTINUATIONS) {
      report.failure = { message: "The director returned without continuing the timed build." };
      return { ok: false, stopReason: StopReason.NoProgress };
    }
  }
  return result;
}

/** How a session that ended by itself ended: its stop reason, or whether it simply stopped or failed. */
const endedHow = (result: Partial<DelegateResult>, onItsOwn: string): string =>
  result?.stopReason ?? (result?.ok ? onItsOwn : "failed");

/** A session that ended without finishing gets the rest of the night to wrap up in, when there is enough of it. */
async function wrapUp(night: Night, talk: DirectorTalk, result: Partial<DelegateResult>): Promise<void> {
  const { ctx, decision, finalDeadline, journal, report, run, state } = night;
  if (state.finished || ctx.cancelled || state.limit || report.failure) return;
  const left = finalDeadline - Date.now();
  if (left <= WRAP_UP_MIN_MS) return;
  await decision(
    `director session ended (${endedHow(result, "stopped on its own")}) without finishing — a wrap-up session gets the last ${minutes(left)} minutes`,
    `the lead stopped before wrapping up; it gets the last ${minutes(left)} minutes to finish the build`,
  );
  const wrap = await talk
    .session(
      wrapUpPrompt({
        run,
        finalDeadline,
        integrationHead: state.integrationHead,
        integrationHealthy: state.integrationHealthy,
        workers: [...state.workers.values()],
        fromScratch: state.fromScratch,
      }),
      talk.sessionId,
      left - WRAP_UP_MARGIN_MS,
    )
    .catch((err): Partial<DelegateResult> => ({ ok: false, errorText: String(err?.message ?? err) }));
  if (wrap?.sessionId) journal.director.sessionId = wrap.sessionId;
}

/**
 * Why the SESSION ended, in the sentence the report keeps. It is computed before the close,
 * which takes up to ninety seconds settling workers: reading the clock after that told a night
 * that had ended on a limit that it "ran out of time". A waking lead's wrap-up that did not
 * start on the clock (`wrapCause`) says its own reason: its working deadline was moved up to it.
 */
function sessionEndWords(
  night: Night,
  result: Partial<DelegateResult>,
  at: number,
  wrapCause?: WrapCause | null,
): string {
  const { ctx, softDeadline, state } = night;
  if (ctx.cancelled) return "stopped by the user";
  if (state.limit)
    return `the engine hit its ${limitWords(state.limit.kind)} before the director called finish (${String(state.limit.message).slice(0, CLIP_QUOTE)}); the run is paused — Resume it when the limit resets`;
  if (wrapCause === WrapCause.Idle || wrapCause === WrapCause.Finish) return WAKE_ENDING[wrapCause];
  const onTheClock = wrapCause !== WrapCause.Failed && at >= softDeadline - OUT_OF_TIME_MS;
  if (onTheClock) return "the director ran out of time without calling finish";
  return `the director's session ended (${endedHow(result, "on its own")}) before it called finish`;
}

/**
 * The night the director left open: the harness stops the workers, looks at the integration
 * branch once more on a window of its own, and lands what runs — the same close `finish` takes
 * (M4.10). The judge's last word on the same head counts too: a health pass that raced the load
 * must not keep a build the judge passed from the user.
 */
async function closeLeftOpen(
  night: Night,
  result: Partial<DelegateResult>,
  wrapCause: WrapCause | null = null,
): Promise<void> {
  const { closeTheNight, ctx } = night;
  const why = sessionEndWords(night, result, Date.now(), wrapCause);
  await closeTheNight({
    land: true,
    stopWhy: "the build is over",
    settleMs: OPEN_NIGHT_SETTLE_MS,
    because: (landed: AnyRecord) =>
      ctx.cancelled
        ? why
        : `${why}; ${landed.ok ? `the integration branch was landed (${landed.how})` : `nothing was landed (${landed.reason})`}`,
  });
}

/**
 * A night that threw before it closed. What ends up on the morning card is a sentence, never an
 * exception: a night once greeted its owner with "the director failed: ENOENT: no such file or
 * directory, open '/Users/…'". The message itself stays in the report, where a developer can
 * read it.
 */
async function closeAfterCrash(night: Night, err: any): Promise<void> {
  const { closeRun, ctx, report, runningWorkers, state, stopWorker } = night;
  if (state.finished) return;
  for (const worker of runningWorkers()) await stopWorker(worker, "the build ended early", "cleanup");
  const aborted = err?.kind === EngineFailure.Aborted || ctx.cancelled;
  if (!aborted) report.failure = { message: String(err?.message ?? err).slice(0, FAILURE_CHARS) };
  report.stoppedBecause = aborted ? "stopped by the user" : "the build hit a problem and stopped early";
  await closeRun({
    ok: false,
    reason: report.stoppedBecause,
    why: aborted ? NotLandedReason.Stopped : NotLandedReason.Crashed,
  });
}

/**
 * The user's window must not be left pointing into a folder that is about to stop existing.
 * Whatever put it there — a borrowed look, a `show target=<worker>`, a studio with one window
 * and no pool — the worktrees below go now, and a window inside a removed one shows nothing at
 * all. Only then: a build the stage swapped in lives in the studio's own shadow, and the user
 * chose it.
 */
async function bringTheWindowHome(night: Night): Promise<void> {
  const { ctx, integrationWorktree, run, state } = night;
  const showingAtClose = await ctx.call(HostMethod.PreviewShowing, {}).catch(() => null);
  const runFolders = [integrationWorktree, ...[...state.workers.values()].map((w) => w.worktree)].filter(
    (folder): folder is string => Boolean(folder),
  );
  const inside = (folder: string) =>
    showingAtClose?.root === folder || String(showingAtClose?.root).startsWith(`${folder}${path.sep}`);
  if (showingAtClose?.root && runFolders.some(inside)) {
    await ctx.call(HostMethod.PreviewLoad, { project: run.project }).catch(() => {});
  }
}

/**
 * Worktrees are done. Everything they hold is on a ref before they go — each worker's own, the
 * integration branch's (protectHead) — because a detached worktree's commits are unreachable the
 * moment it is removed. On a pause the integration head is in the journal and the worktree is
 * recreated at resume, memory file and all.
 */
async function tearDown(night: Night): Promise<void> {
  const { ctx, integrationWorktree, protectWorker, run, state } = night;
  directors.delete(run.runId);
  await bringTheWindowHome(night);
  for (const worker of state.workers.values()) {
    // The settle above is bounded: a worker still judging when it expires has commits in a
    // worktree about to be removed. Its ref is written from that worktree's HEAD first.
    await protectWorker(worker).catch(() => {});
    if (worker.worktree)
      await ctx
        .call(HostMethod.SnapshotRemoveWorktree, { project: run.project, path: worker.worktree })
        .catch(() => {});
  }
  await ctx
    .call(HostMethod.SnapshotRemoveWorktree, { project: run.project, path: integrationWorktree })
    .catch(() => {});
  ctx.setStatus("idle");
}

/**
 * The long turn, kept behind `run.directorLoop: "turn"` for one release: open the session with
 * the brief and the long turn's own rules (the playbook names neither loop), wait out a limit on
 * the first turn, continue a timed build with continuation prompts, then one wrap-up session.
 */
async function runTurnLoop(night: Night, talk: DirectorTalk, brief: string): Promise<void> {
  let result = await openSession(night, talk, `${brief}\n\n${longTurnRules()}`);
  result = await waitOutLimits(night, talk, result);
  result = await continueTimedBuild(night, talk, result);
  await wrapUp(night, talk, result);
  if (!night.state.finished) await closeLeftOpen(night, result);
}

/**
 * The line a waking lead takes the chat on (live chat), open from the moment the night exists: a
 * message sent while it prepares is handed to the lead's first message. What the lead hears is
 * recorded on the run's log. The long turn opens none, and its chat waits for the night as it
 * always did.
 */
function leadLine(night: Night, loop: DirectorLoop): LeadLine | null {
  if (loop !== DirectorLoop.Wake) return null;
  const { ctx, report, run, state, threadId } = night;
  return openLeadLine(run.runId, threadId, () => !state.finished && !ctx.cancelled && !report.failure, ctx);
}

/** The wake loop's night, and the close of whatever its lead left open — what it never heard goes back to the chat first. */
async function wakeNight(night: Night, talk: DirectorTalk, brief: () => string, line: LeadLine | null): Promise<void> {
  const outcome = await runWakeLoop(night, talk, brief, SYSTEM_CLOCK, line);
  await line?.release();
  if (!night.state.finished) await closeLeftOpen(night, outcome.failed ?? outcome.result, outcome.wrapCause);
}

/**
 * Seat a waking night's lead (director/lead-session.ts): the chat's own session when it can
 * continue it, and on the journal whether it is the chat's, so a Resume knows the session it had.
 */
async function seatTheLead(night: Night): Promise<void> {
  const { ctx, journal, priorJournal, projectDir, run, saveJournal, threadId } = night;
  const events = await ctx.call(HostMethod.EventsList, { threadId }).catch(() => []);
  night.lead = leadSeat({ events, run, folder: projectDir, priorJournal });
  journal.director.lead = { chatSession: night.lead.chatSession };
  await saveJournal();
}

/**
 * Run a night under a director. Returns the report (also written as run_finished).
 *
 * The night is one explicit object (`prepareNight`, director/setup.ts) that every part of it takes
 * as its first argument: director/workers.ts starts, runs and stops the workers, director/tools.ts
 * answers the session's tool calls, director/integrate.ts merges and closes the night. What stays
 * here is the director's own session: its turns (the wake loop, director/wake.ts, or the long
 * turn), the close of whatever it left open, and the teardown of the night's worktrees whatever
 * happened.
 */
export async function runDirector(
  ctx: HarnessCtx,
  { threadId, run, resume = false }: { threadId: string; run: Run; resume?: boolean },
): Promise<AnyRecord> {
  // The run's own word, else the studio's environment (a shipped build's way back to the long turn).
  const loop = directorLoopOf(run, process.env);
  // A waking night's lead is its chat's own session (one session): it keeps no memory file.
  const oneSession = seatsLead(loop);
  // A waking night's lead takes the chat while it builds (`leadLine` below), and its start says so
  // when the chat's queue hands messages to it (a kept older queue keeps them behind the build).
  const liveChat = loop === DirectorLoop.Wake && servesLiveChat();
  const timings: { operationSpans?: OperationSpan[]; omittedSpans?: number } = {};
  let tracing: Night | undefined;
  const measured = tracedContext(ctx, run, (span) =>
    retainSpan(timings, {
      ...span,
      goal: span.worker ? (tracing?.state.workers.get(span.worker)?.goal ?? null) : null,
      head: tracing?.state.integrationHead ?? null,
    }),
  );
  const night = await prepareNight(measured, { threadId, run, resume, oneSession, liveChat }, NIGHT_MODULES);
  tracing = night;
  const prior = night.priorJournal?.director?.hostTimings;
  const current = timings.operationSpans ?? [];
  if (Array.isArray(prior?.operationSpans)) {
    timings.operationSpans = [];
    timings.omittedSpans = Number(prior.omittedSpans) || 0;
    for (const span of [...prior.operationSpans, ...current]) retainSpan(timings, span);
  }
  night.journal.director.hostTimings = timings;
  night.report.hostTimings = timings;
  const { report } = night;
  if (oneSession) await seatTheLead(night);
  const skill = await directorSkill(ctx);
  const talk = directorTalk(night, referenceImages(run), runTools(loop, night));
  directors.set(run.runId, night.handler);
  const resumeNoteText = await resumeWords(night);
  const line = leadLine(night, loop);
  // Until the lead's loop takes the line, nobody has heard a word the chat handed it.
  let looping = false;
  try {
    const start = await prepareTheStart(night);
    // A Stop while the night prepared (the starting point, the contract): no session opens, and
    // the night closes as the user's stop — a session has Edit and Bash and would work on.
    if (night.ctx.cancelled) {
      // Its lead never heard a word: what the chat handed it goes back before the close.
      await line?.release({ heardNone: true });
      await closeLeftOpen(night, {});
      return report;
    }
    const brief = () => openingBrief(night, skill, resumeNoteText, start, loop);
    if (loop === DirectorLoop.Turn) {
      await runTurnLoop(night, talk, brief());
      return report;
    }
    looping = true;
    await wakeNight(night, talk, brief, line);
  } catch (err: any) {
    // Given back before the close: after `run_finished` a message loses its Queued state in the paged chat.
    await line?.release({ heardNone: !looping });
    await closeAfterCrash(night, err);
  } finally {
    await line?.release();
    await tearDown(night);
  }
  return report;
}
