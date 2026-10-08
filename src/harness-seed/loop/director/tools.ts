import { keepCheckpoint } from "./progress.ts";
import { retainSpan, timedOperation } from "./timing.ts";
import { GoalBlocker, GoalStatus, goalDecision, recordGoalEvidence, replanGoal } from "./goals.ts";
/**
 * The director's tools as its session calls them: the handler the studio forwards every call to,
 * and the tools that only look — `run_status`, `wait`, `judge`, `playtest`, `show`.
 */

import { renderScoreboard, runDeterministicChecks, summarizeScoreboard, toScoreboard, unmeasured } from "../checks.ts";
import { FACET_POLICY } from "../facet-loop.ts";
import { GIT, gitAt, headOf, shortSha } from "../git.ts";
import { HostMethod } from "../host-methods.ts";
import { askVisionBoard, blindCompare, Side, visionCheck } from "../judge.ts";
import { EngineFailure, outageDelays, withProviderPatience } from "../outage.ts";
import { isRunning, WorkerMode } from "../outcomes.ts";
import { runPlaytest } from "../playtester.ts";
import { attemptRef } from "../repo.ts";
import { RunEvent, SteeringSource } from "../run-events.ts";
import { CheckKind, CheckWeight, MoveOwner, normalizeFacetSpec, normalizeMilestone } from "../spec.ts";
import { CLIP_REASON } from "../text.ts";
import { MINUTE_MS, minutes, SECOND_MS, sleep } from "../time.ts";
import { Against, againstWords, observedFrom, VerdictPass, VerdictRule } from "../verdict.ts";
import { list, namedTitle, num, parseJson, slug, yes } from "./args.ts";
import { MAX_WAIT_S, MAX_WORKERS, workerWindows } from "./budgets.ts";
import { waitDigest, workerDigest } from "./digests.ts";
import { priorWorkerStatus, priorWorkersStatus } from "./journal.ts";
import { setAsideStrays } from "./lead-session.ts";
import { LEAD_DIRTY, LEAD_LIVE_DIRTY } from "./lead-session-prompts.ts";
import { BuildTarget, WindowLease } from "./night.ts";
import { finalJudgeQuestion } from "./close-prompts.ts";
import { plainly } from "./rules.ts";
import { DirectorTool, headSynced } from "./tool-specs.ts";
import { passDeadline } from "./wake-schedule.ts";
import { workingGoal } from "../goal-prompts.ts";
import type { LastJudge, Night, Worker } from "./night.ts";
import type { CheckResult } from "../checks.ts";
import type { Evidence, Shot } from "../evidence.ts";
import type { VisionAsk } from "../judge.ts";
import type { Check } from "../spec.ts";
import type { AnyRecord } from "../../types/harness.d.ts";

/**
 * This part serves a lead that is its chat's own session and writes nothing (one session): a night
 * seats one only when every part it depends on says so (lead-session.ts `servesLead`).
 */
export const SERVES_LEAD = true;

/** What a stopped run answers every tool call with but the studio's own. */
const STOPPED_BY_USER = "STOPPED BY THE USER: the run is over; end your session now without starting anything";
/** How much of a build's state a judge's answer quotes. */
const JUDGE_STATE_CHARS = 1_200;
/** How many GPU errors a judge's answer carries. */
const JUDGE_GPU_ERRORS = 4;
/**
 * How soon after it starts the close's own judge must be done asking (`judgeTheLanding`). The close
 * runs inside the lead's `finish` call, which the engine gives up on after ten minutes, and the
 * settle, the close's look and the judge's own look share that time.
 */
const FINAL_JUDGE_MS = 4 * MINUTE_MS;
/** judge.ts's confidence for an answer that states none — a coin flip; the close counts only a surer one. */
const COIN_FLIP = 0.5;
/** A playtest's minutes: at least two, at most eight, five unless the director says otherwise. */
const PLAYTEST_MIN_MINUTES = 2;
const PLAYTEST_MAX_MINUTES = 8;
const PLAYTEST_DEFAULT_MINUTES = 5;
/** The most actions a director's playtester takes. */
const PLAYTEST_MAX_ACTIONS = 20;
/** A `wait` that names no length waits a minute. */
const WAIT_DEFAULT_S = 60;
/** How much of a worker's brief, iterations and attempts `worker_status` carries. */
const STATUS_BRIEF_CHARS = 600;
const STATUS_ITERATIONS = 6;
const STATUS_ATTEMPTS = 4;
/** How much of a note the journal keeps, and of its plain sentence. */
const NOTE_CHARS = 2_000;
const NOTE_PLAIN_CHARS = 400;

/** A check's answer as a yes, a no, or neither. */
function answerOf(pass: boolean | null | undefined): boolean | null {
  if (pass === true) return true;
  if (pass === false) return false;
  return null;
}

/** The judge's last word on the integration branch, as `run_status` shows it. */
function lastJudgeStatus(lastJudge: AnyRecord | null): AnyRecord | null {
  if (!lastJudge) return null;
  return {
    head: shortSha(lastJudge.head),
    ok: lastJudge.ok,
    pick: lastJudge.pick ?? null,
    answer: lastJudge.answer ?? null,
    allChecksPassed: lastJudge.boardAllPass ?? null,
  };
}

/** The plan the user is reading, so a compacted or resumed session knows it has one. */
function planStatus(state: AnyRecord): AnyRecord | null {
  if (!state.plan) return null;
  const waiting = state.planReviewUntil && !state.planGo;
  return {
    summary: state.plan.summary,
    parts: state.plan.workers.map((w: Worker) => w.id),
    ...(waiting ? { waitingForTheUser: minutes(state.planReviewUntil - Date.now()) } : {}),
  };
}

/**
 * The pool as `run_status` shows it, when the studio could say: its windows, and how many
 * workers may run at once — the user's Maximum concurrent workers, the lead's own windows apart.
 */
function capacityStatus(cap: AnyRecord | null): AnyRecord | null {
  if (!cap) return null;
  const workersAtOnce = cap.headless === false ? 1 : Math.min(MAX_WORKERS, workerWindows(cap.max));
  return {
    workersAtOnce,
    windowsFree: cap.free ?? cap.max,
    windowsMax: cap.max,
    memoryFreeMb: cap.memory?.freeMb ?? null,
  };
}

/** Where the integration branch stands, as `run_status` shows it. */
function integrationStatus(night: Night): AnyRecord {
  const { baseCommit, integrationRef, integrationWorktree, ledgerLines, state } = night;
  return {
    worktree: integrationWorktree,
    head: state.integrationHead ? shortSha(state.integrationHead) : null,
    base: baseCommit ? shortSha(baseCommit) : null,
    ref: integrationRef,
    lastHealthPass: state.integrationHealthy,
    lastJudge: lastJudgeStatus(state.lastJudge),
    ...(state.ledger.length ? { defectsNobodyOwns: ledgerLines() } : {}),
  };
}

export async function statusText(night: Night) {
  const { ctx, finalDeadline, inbox, run, runRoundMinutes, softDeadline, started, state, workersEngineLimit } = night;
  const cap = await ctx.call(HostMethod.PreviewCapacity, {}).catch(() => null);
  const screens = await ctx.call(HostMethod.PreviewScreens, {}).catch(() => []);
  const pending = await inbox.backlog().catch(() => []);
  const iterationMinutes = runRoundMinutes();
  const workersLimit = workersEngineLimit();
  const before = priorWorkersStatus(night);
  return {
    time: {
      elapsedMin: minutes(Date.now() - started),
      sessionMinutesLeft: minutes(softDeadline - Date.now()),
      hardMinutesLeft: minutes(finalDeadline - Date.now()),
      ...(iterationMinutes === null ? {} : { iterationMinutes }),
    },
    integration: integrationStatus(night),
    plan: planStatus(state),
    acceptance: state.goals ?? null,
    checkpoint: night.journal.director.latestVerifiedCheckpoint ?? null,
    completion: state.goals ? goalDecision(state.goals, state.integrationHead) : null,
    workers: [...state.workers.values()].map((w) => workerDigest(w)),
    // A resumed night's workers from before the pause (the journal kept them): none runs, their work is on their refs.
    ...(before.length ? { workersBeforeThePause: before } : {}),
    // The thresholds every loop worker runs on unless its own worker_start set them. Here
    // once, so a worker's digest can carry only what it was actually given.
    assets: await ctx
      .call(HostMethod.AssetsInventory, { project: run.project })
      .catch((error: any) => ({ unavailable: String(error?.message ?? error) })),
    policy: FACET_POLICY,
    capacity: capacityStatus(cap),
    screens: (Array.isArray(screens) ? screens : []).map((s) => ({
      label: s.label,
      role: s.role,
      caption: s.caption ?? null,
    })),
    user: { unreadInstructions: pending.length, finishRequested: await inbox.finishing().catch(() => false) },
    // The workers' own subscription ran out (cross-provider roles): named here, once, with
    // when it happened and when it resets, so a director on the other subscription knows
    // its next worker_start will meet the same wall — and that its own session is fine.
    ...(workersLimit ? { workersEngineLimit: workersLimit } : {}),
  };
}

/** The workers' engine's limit as run_status shows it: which engine, since when, until when. */
export function workersEngineLimit(night: Night) {
  const { state } = night;
  const w = state.workerLimit;
  if (!w) return null;
  const resetAt = w.retryAfterMs !== null ? w.at + w.retryAfterMs : null;
  // Reset: gone from the night, so worker_start is not warned off and no wake says it again.
  if (resetAt !== null && resetAt <= Date.now()) {
    state.workerLimit = null;
    return null;
  }
  const until =
    resetAt !== null ? ` for about ${Math.max(0, minutes(resetAt - Date.now()))} more minutes` : " until it resets";
  return {
    engine: w.engine,
    kind: w.kind === EngineFailure.UsageLimit ? "usage cap" : "session limit",
    worker: w.worker,
    minutesAgo: minutes(Date.now() - w.at),
    minutesUntilReset: resetAt !== null ? Math.max(0, minutes(resetAt - Date.now())) : null,
    message: w.message,
    note: `the workers' engine (${w.engine}) is out; your own session is not. worker_start will hit the same limit${until} — wait it out, or do the work in your own worktree.`,
  };
}

// ── judge ──

/** What a judge was asked to look at and against, read off the call. */
interface JudgeAsk {
  target: ReturnType<Night["resolveRoot"]> & { root: string; label: string };
  againstKey: string;
  cameras: string[];
  checksRaw: unknown;
  question: unknown;
  n: number;
  head: string | null;
  /** The close's own judge of the build it makes live (`LastJudge.final`). */
  final: boolean;
  /** When the judge's calls must be done by, when that is sooner than the pass's deadline (`judgeRun`). */
  until: number;
}

/** How a judge is asked for: by the lead (the defaults), or by the close (`judgeTheLanding`). */
interface JudgeOptions {
  /** Look through the studio's own window when every pool window is a worker's: a judge nobody may skip. */
  borrow?: boolean;
  /** The close's own judge of the build it is about to make live. */
  final?: boolean;
  /** See `JudgeAsk.until`. */
  until?: number;
}

/** One pass of a judge, on the window it leased. */
interface JudgePass extends JudgeAsk {
  handle: string | null;
  evidence: Evidence;
  out: AnyRecord;
  judgement: AnyRecord;
}

/**
 * What is being looked at, so the pass can forgive what that build inherited and so the run's
 * own starting point is judged as a starting point. A worker that has not committed yet is its
 * own uncommitted work, not a commit anyone can fork from: it gets no entry, so nobody dry-runs
 * a later worker against it.
 */
async function judgedHead(night: Night, target: JudgeAsk["target"]): Promise<string | null> {
  const { baseCommit, ctx, integrationWorktree, projectDir, state } = night;
  if (target.root === integrationWorktree) return headOf(ctx, integrationWorktree).catch(() => state.integrationHead);
  return target.worker?.lastCommit ?? (target.root === projectDir ? baseCommit : null);
}

/** The judge's answer before anything is scored: what it saw of the build. */
function judgeOut(night: Night, label: string, evidence: Evidence): AnyRecord {
  const { shotsOf } = night;
  return {
    target: label,
    ok: evidence.ok,
    problems: evidence.problems ?? [],
    warnings: evidence.warnings ?? [],
    requestedState: evidence.requestedState ?? null,
    shots: shotsOf(evidence),
    consoleErrors: evidence.consoleErrors ?? [],
    gpuErrors: (evidence.gpuErrors ?? []).slice(0, JUDGE_GPU_ERRORS),
    state: evidence.state ? JSON.stringify(evidence.state).slice(0, JUDGE_STATE_CHARS) : null,
  };
}

/** What a judge learned about a commit, kept for every later pass over the same head. */
function rememberJudgedHead(night: Night, head: string | null, evidence: Evidence): void {
  const { errorsLogged, rememberEvidence, state } = night;
  if (!head) return;
  if (evidence.ok === true) state.healthByHead.set(head, true);
  state.consoleByHead.set(head, errorsLogged(evidence));
  rememberEvidence(head, evidence);
}

/** The frame a check is judged on: its own camera's, else the first one taken. */
const shotFor = (evidence: Evidence, camera: unknown): Shot | undefined =>
  (evidence.shots ?? []).find((s: Shot) => s.camera === camera) ?? evidence.shots?.[0];

/**
 * The board's picture questions, asked of the judge a camera at a time, not one session per
 * question: a six-question board cost six Claude sessions before (M3.10). A play check has no
 * picture to ask about; it is unmeasured here, and playtest measures it.
 */
async function visionAsksFor(night: Night, pass: JudgePass, pending: Check[], results: CheckResult[]) {
  const { ctx, run } = night;
  const asks: VisionAsk[] = [];
  for (const check of pending) {
    if (check.kind !== CheckKind.Vision) {
      results.push(unmeasured(check, "play checks need playtest; use it"));
      continue;
    }
    const shot = shotFor(pass.evidence, check.camera);
    if (!shot) {
      results.push(unmeasured(check, "no frame for its camera"));
      continue;
    }
    let crop: { base64?: string; path?: string | null } = { base64: shot.base64, path: shot.path };
    if (check.crop && shot.path)
      crop =
        (await ctx
          .call(HostMethod.PreviewCrop, {
            runId: run.runId,
            path: shot.path,
            crop: check.crop,
            label: `director/judge_${pass.n}/crops/${check.id}`,
            ...(pass.handle ? { handle: pass.handle } : {}),
          })
          .catch(() => null)) ?? crop;
    asks.push({ check, crop, camera: shot.camera });
  }
  return asks;
}

/** Score the typed checks the director handed the judge; the checks it scored, one entry each. */
async function scoreJudgeChecks(night: Night, pass: JudgePass): Promise<CheckResult[]> {
  const { ctx, run } = night;
  const { cameras, checksRaw, evidence, handle, n, out, judgement } = pass;
  const namesChecks = Array.isArray(checksRaw) && checksRaw.length > 0;
  if (!namesChecks || !evidence.ok) return [];
  const spec = normalizeFacetSpec({ id: `judge-${n}`, title: "judge", intent: "", checks: checksRaw, cameras }, 0);
  const { results, pending } = await runDeterministicChecks(ctx, {
    spec,
    evidence,
    diffs: {},
    handle,
    references: null,
  });
  const asks = await visionAsksFor(night, pass, pending, results);
  if (asks.length) {
    const answered = await askVisionBoard(ctx, { run, asks }).catch((err) =>
      asks.map((ask) => unmeasured(ask.check, `judge unavailable: ${err?.message ?? err}`)),
    );
    results.push(...answered);
  }
  const board = toScoreboard(results);
  out.board = { summary: summarizeScoreboard(board, spec), lines: renderScoreboard(board) };
  judgement.boardAllPass = out.board.summary.total > 0 && out.board.summary.passing === out.board.summary.total;
  return Object.values(board);
}

/**
 * Until when this pass may wait out a busy provider: the working deadline while there is working
 * time, the wrap-up's own end once it is over (`passDeadline`), or the close's sooner `until`.
 */
function judgeDeadline(night: Night, pass: JudgeAsk): number {
  const { finalDeadline, softDeadline } = night;
  return Math.min(passDeadline({ now: Date.now(), softDeadline, finalDeadline }), pass.until);
}

/**
 * The run as this pass's judge calls read it. The close's judge runs inside the lead's `finish`
 * call, which the engine gives up on after ten minutes, so its calls are held to `until` the way
 * judge.ts holds any judge with a deadline (`run.optimizationDeadline`): each call times out by it,
 * no retry starts past it, and the call is the run's, so the user's Stop aborts it.
 */
function judgeRun(night: Night, pass: JudgeAsk): Night["run"] {
  const { run } = night;
  return Number.isFinite(pass.until) ? { ...run, optimizationDeadline: pass.until } : run;
}

/** The vision judge's own yes or no, when it was surer than a coin flip: null for an answer nobody could use. */
function sureAnswer(result: Partial<CheckResult>): boolean | null {
  if (!(typeof result.confidence === "number" && result.confidence > COIN_FLIP)) return null;
  if (result.answer === "yes") return true;
  if (result.answer === "no") return false;
  return null;
}

/** The one yes/no question the director asked of the vision judge, on its first (or default) camera. */
async function askJudgeQuestion(night: Night, pass: JudgePass): Promise<void> {
  const { ctx, run } = night;
  const { cameras, evidence, judgement, out, question } = pass;
  if (!question || !evidence.ok) return;
  const camera = cameras[0] ?? "default";
  const shot = shotFor(evidence, camera);
  if (!shot) return;
  const check = { id: "question", kind: CheckKind.Vision, camera: shot.camera, ask: String(question), expect: "yes" };
  const asking = () =>
    visionCheck(ctx, {
      run: judgeRun(night, pass),
      check: check as Check,
      crop: { base64: shot.base64, path: shot.path },
    });
  // The close's question waits out a busy provider until its own deadline; a lead's asks once.
  const patience = { deadline: judgeDeadline(night, pass), delays: outageDelays(run), label: "the director's judge" };
  const answer = await (pass.final ? withProviderPatience(ctx, asking, patience) : asking()).catch(
    (err): Partial<CheckResult> => ({ pass: null, reason: String(err?.message ?? err) }),
  );
  // The close's word is what the judge said, not whether it passed: an answer it could not give is no "no".
  const said = pass.final ? sureAnswer(answer) : answerOf(answer.pass);
  out.answer = { question: String(question), camera: shot.camera, yes: said, note: answer.note ?? answer.reason ?? "" };
  judgement.answer = said;
}

/** The other side of a blind comparison: the start, or another build looked at on this window. */
async function otherBuild(night: Night, pass: JudgePass): Promise<{ other: Evidence | null; worker: Worker | null }> {
  const { consoleInheritedBy, evidenceOf, resolveRoot, run, state } = night;
  const { againstKey, cameras, handle, n, out } = pass;
  if (againstKey === Against.Start) return { other: state.startEvidence, worker: null };
  const against = resolveRoot(againstKey);
  if (against.error !== undefined) {
    out.against = against.error;
    return { other: null, worker: null };
  }
  // Whose build this one is put beside — its title is what the record names, not the title of
  // the build being judged.
  const other = await evidenceOf(against.root, {
    handle,
    label: `judge_${n}_against`,
    cameras: cameras.length ? cameras : null,
    setup: against.worker?.setup ?? run.setup ?? null,
    inheritedConsole: consoleInheritedBy(against.worker),
  }).catch(() => null);
  return { other, worker: against.worker ?? null };
}

/** The blind verdict between this build and the other one, with the provider's patience. */
async function blindVerdict(night: Night, pass: JudgePass, other: Evidence): Promise<void> {
  const { ctx, run } = night;
  const { againstKey, cameras, evidence, judgement, n, out } = pass;
  // In the wrap-up the working deadline has passed (or moved to its start): the wrap-up's own end holds.
  const deadline = judgeDeadline(night, pass);
  try {
    const verdict = await withProviderPatience(
      ctx,
      () =>
        blindCompare(ctx, {
          run: judgeRun(night, pass),
          challenger: evidence,
          incumbentSnapshot: null,
          incumbentEvidence: other,
          iterationId: `director_${n}`,
          cameras: cameras.length ? cameras : null,
        }),
      { deadline, delays: outageDelays(run), label: "the director's judge" },
    );
    out.verdict = {
      against: againstKey,
      picks: verdict.facets ?? null,
      pick: verdict.pick ?? null,
      defects: verdict.defects ?? [],
      reason: verdict.reason ?? "",
    };
    judgement.against = againstKey;
    judgement.pick = out.verdict.pick ?? null;
  } catch (err: any) {
    out.verdict = { against: againstKey, error: String(err?.message ?? err) };
  }
}

/** The comparison the director asked for; answers the worker whose build this one was put beside. */
async function compareJudged(night: Night, pass: JudgePass): Promise<Worker | null> {
  const { state } = night;
  const { againstKey, evidence, out } = pass;
  if (!evidence.ok || againstKey === Against.None) return null;
  if (againstKey === Against.Start && state.fromScratch) {
    // A night that began on an empty scaffold has no "before": a blind verdict against a
    // blank frame is a coin toss dressed as evidence, and answering "the other build could
    // not be observed" made the run's own first look read like a failure.
    out.verdict = {
      against: Against.Start,
      firstBuild: true,
      pick: null,
      note: "first build — nothing to compare: this run began from an empty starting point, so this build is judged on its own evidence (its checks, a question, or against another build)",
    };
    return null;
  }
  if (againstKey === Against.Start && !state.startEvidence) {
    // The night began on a build nobody could photograph. Saying "the other build could
    // not be observed" sent directors back to judge it again and again; say what is true
    // and what to do instead, once.
    out.verdict = {
      against: Against.Start,
      pick: null,
      note: "no start evidence: the starting build rendered black, so there is nothing to compare with — judge this build on its own evidence (checks, a question) or against another build",
    };
    return null;
  }
  const { other, worker } = await otherBuild(night, pass);
  if (other?.ok) await blindVerdict(night, pass, other);
  else out.verdict = { against: againstKey, error: "the other build could not be observed" };
  return worker;
}

/**
 * Which of the four things this pass actually established, in the order the user cares about: a
 * preference over another build, then a first build with nothing to compare, then whether it ran
 * at all. Saying "the judge passed it" for any of the others is the lie the first night's landing
 * told — so a pass that only looked decides nothing (`kept: null`).
 */
function judgeRule(evidence: Evidence, verdict: AnyRecord | undefined): VerdictRule {
  if (!evidence.ok) return VerdictRule.DoesNotStart;
  if (verdict?.firstBuild) return VerdictRule.FirstBuild;
  if (verdict?.pick === Side.Challenger) return VerdictRule.Preferred;
  if (verdict?.pick) return VerdictRule.NotPreferred;
  return VerdictRule.Starts;
}

/** What a judge's rule keeps: only a preference keeps a build, and a look alone decides nothing. */
function keptByJudge(rule: VerdictRule): boolean | null {
  if (rule === VerdictRule.Preferred) return true;
  if (rule === VerdictRule.Starts || rule === VerdictRule.FirstBuild) return null;
  return false;
}

/** The judge's one line in the night's log. */
function judgedNote(label: string, evidence: Evidence, out: AnyRecord): string {
  const seen = evidence.ok ? "observed" : `not judgeable (${(evidence.problems ?? []).join("; ")})`;
  let verdict = "";
  if (out.verdict?.pick) verdict = `, verdict ${out.verdict.pick}`;
  else if (out.verdict?.firstBuild) verdict = ", the first build — nothing to compare it with";
  return `judged ${label}: ${seen}${verdict}`;
}

/** The judge's record: its verdict file, the verdict every pass writes, and the evidence card. */
async function recordJudgement(night: Night, pass: JudgePass, scored: CheckResult[], againstWorker: Worker | null) {
  const { appendRun, ctx, recordVerdict, run, consoleInheritedBy } = night;
  const { againstKey, evidence, head, n, out, target } = pass;
  await ctx
    .call(HostMethod.RunArtifact, {
      runId: run.runId,
      name: `director/judge_${n}/verdict.json`,
      base64: Buffer.from(JSON.stringify(out, null, 2)).toString("base64"),
    })
    .catch(() => {});
  const rule = judgeRule(evidence, out.verdict);
  await recordVerdict({
    pass: VerdictPass.Judge,
    head,
    worker: target.worker?.id ?? null,
    against: out.verdict?.pick ? againstWords(againstKey, { workerTitle: namedTitle(againstWorker) }) : null,
    ...observedFrom(evidence),
    consoleInherited: consoleInheritedBy(target.worker),
    planned: scored,
    unmeasured: scored.filter((entry) => entry.pass !== true && entry.pass !== false).map((entry) => entry.id),
    pick: out.verdict?.pick ?? null,
    question: out.answer?.question ?? null,
    answer: out.answer?.yes ?? null,
    judgeCalls: out.verdict?.pick ? 1 : 0,
    kept: keptByJudge(rule),
    rule,
  });
  if (out.answer?.question)
    await appendRun(RunEvent.RunVisualEvidence, {
      head,
      question: out.answer.question,
      answer: out.answer.yes,
      note: out.answer.note ?? null,
    }).catch(() => {});
}

/** One judge pass on the window it leased: look, score, ask, compare, and write it all down. */
async function judgeOnWindow(night: Night, ask: JudgeAsk, handle: string | null): Promise<string> {
  const { consoleInheritedBy, ctx, integrationWorktree, journal, note, patientEvidence, run, saveJournal, state } =
    night;
  const { target, n, head, cameras } = ask;
  ctx.setStatus(`run ${run.runId} · director judging ${target.label}`);
  const evidence = await patientEvidence(target.root, {
    handle,
    label: `judge_${n}`,
    cameras: cameras.length ? cameras : null,
    setup: target.worker?.setup ?? run.setup ?? null,
    scaffold: state.baseHeads.has(head),
    inheritedConsole: consoleInheritedBy(target.worker),
  });
  const onIntegration = target.root === integrationWorktree;
  rememberJudgedHead(night, head, evidence);
  // The judge's word on the integration branch counts at the close, next to the health
  // pass — but only for what it is. Filled in below with the pick, what the pick was
  // against, the answer and the board, because "the judge could look at it" is not "the
  // judge preferred it", and a pick over a worker's dead end is not one over the start.
  const judgement: AnyRecord = {
    head,
    ok: evidence.ok === true,
    against: null,
    pick: null,
    answer: null,
    boardAllPass: null,
    at: Date.now(),
    ...(ask.final ? { final: true } : {}),
  };
  if (onIntegration) state.lastJudge = judgement;
  const pass: JudgePass = { ...ask, handle, evidence, out: judgeOut(night, target.label, evidence), judgement };
  /** The checks this pass scored, one entry each — the verdict record keeps them, not only their tally. */
  const scored = await scoreJudgeChecks(night, pass);
  await askJudgeQuestion(night, pass);
  /** The worker whose build this one was put beside, when it was put beside one. */
  const againstWorker = await compareJudged(night, pass);
  pass.out.head = head ?? null;
  if (onIntegration) {
    journal.director.lastJudge = judgement;
    await saveJournal();
  }
  await recordJudgement(night, pass, scored, againstWorker);
  note(judgedNote(target.label, evidence, pass.out));
  ctx.setStatus(`run ${run.runId} · director`);
  return JSON.stringify(pass.out);
}

export async function judge(
  night: Night,
  args: AnyRecord,
  { borrow = false, final = false, until = Number.POSITIVE_INFINITY }: JudgeOptions = {},
) {
  const { resolveRoot, state, withLease } = night;
  const target = resolveRoot(args.target);
  if (target.error !== undefined) return target.error;
  const againstKey = String(args.against ?? Against.Start).trim() || Against.Start;
  const cameras = list(args.cameras);
  const checksRaw = parseJson(args.checks);
  if (checksRaw?.__error) return `checks: ${checksRaw.__error}`;
  const n = ++state.judges;
  const head = await judgedHead(night, target);
  const ask: JudgeAsk = {
    target,
    againstKey,
    cameras,
    checksRaw,
    question: args.question,
    n,
    head,
    final,
    until,
  };
  // The lead's judge is a choice, not an obligation: when every window is a worker's, the director
  // is told so and picks its moment, rather than the studio taking the user's window for it. The
  // close's judge of what it makes live is not a choice, and borrows the window as the close's look does.
  const looked = await withLease(WindowLease.Judge, (handle: string | null) => judgeOnWindow(night, ask, handle), {
    borrow,
  });
  return typeof looked === "string" ? looked : looked.noWindow;
}

/**
 * Whether the judge standing on `head` is already the final word the close owes: the close's own
 * verdict or answer (one that came to nothing, on a resume, is asked again), or a lead's blind pick
 * over the build the user had. A lead's free-text question, or a pick over a worker's branch, is
 * not that judgement, and the close judges again.
 */
function finallyJudged(judged: LastJudge | null, head: string | null): boolean {
  if (!judged || judged.head !== head) return false;
  if (judged.final === true) return Boolean(judged.pick) || typeof judged.answer === "boolean";
  const againstTheStart = judged.against === Against.Start || judged.against === Against.Live;
  return againstTheStart && Boolean(judged.pick);
}

/**
 * The close's judge of the build it is about to make live (integrate.ts `landWhatRuns`), whoever
 * ended the night and however fast the user wanted it. Judging was the lead's choice, and every
 * prompt of a hurried night (the wrap-up, the user's finish, the goal card) sent it straight to
 * finish, so builds went live with no judge having looked. A build the user had a picture of is
 * compared blind with it; a new project, or one whose start nobody could photograph, is asked whether
 * it shows what the user asked for. It looks through the studio's window when every other is
 * taken, its calls end by `FINAL_JUDGE_MS` (and with the user's Stop), and its word is kept as
 * every judge's is (`state.lastJudge`, a judge verdict), for the landing's claim.
 */
export async function judgeTheLanding(night: Night, head: string | null): Promise<void> {
  const { ctx, note, run, state } = night;
  if (ctx.cancelled || finallyJudged(state.lastJudge, head)) return;
  const comparable = !state.fromScratch && Boolean(state.startEvidence);
  const ask = comparable
    ? { target: BuildTarget.Integration, against: Against.Start }
    : { target: BuildTarget.Integration, against: Against.None, question: finalJudgeQuestion(workingGoal(run)) };
  const options = { borrow: true, final: true, until: Date.now() + FINAL_JUDGE_MS };
  await judge(night, ask, options).catch((err: unknown) =>
    note(
      `the close could not judge ${shortSha(head)}: ${String((err as Error)?.message ?? err).slice(0, CLIP_REASON)}`,
    ),
  );
}

// ── playtest ──

/** A playtester's answer, three ways: its pass as a word, as a status, and as a yes/no. */
const PLAY_WORDS = {
  yes: { status: "passed", said: "yes", answer: "yes" },
  no: { status: "failed", said: "no", answer: "no" },
  none: { status: "incomplete", said: "no answer", answer: "unmeasured" },
} as const;
const playWords = (pass: boolean | null | undefined) => {
  if (pass === true) return PLAY_WORDS.yes;
  if (pass === false) return PLAY_WORDS.no;
  return PLAY_WORDS.none;
};

/**
 * The playtester is a session of its own, and the studio allows one session per folder: the
 * director's own session lives in the integration worktree — or, for a lead that is its chat's
 * own session, in the project folder — so a playtest of the folder it sits in gets a worktree of its
 * own at the same commit (a night once had every playtest of the integrated build refused for
 * this), and so does one of integration, which a merge may move under it. Answers the folder to
 * play in, or the refusal.
 */
async function playFolder(
  night: Night,
  root: string,
  n: number,
): Promise<{ playRoot: string; tempWorktree: string | null } | { refusal: string }> {
  const { ctx, integrationWorktree, lead, run, state } = night;
  const leadSits = lead?.folder === root;
  if (root !== integrationWorktree && !leadSits) return { playRoot: root, tempWorktree: null };
  const refusal = await dirtyRefusal(night, root, leadSits);
  if (refusal) return { refusal };
  const head = await headOf(ctx, root).catch(() => (leadSits ? null : state.integrationHead));
  const tempWorktree = (
    await ctx.call(HostMethod.SnapshotWorktree, {
      project: run.project,
      commit: head ?? undefined,
      name: `play-${n}`,
      runId: run.runId,
    })
  ).path;
  return { playRoot: tempWorktree, tempWorktree };
}

/**
 * Why a folder with uncommitted changes cannot be played from a copy of its commit, or null once it
 * is clean: the project folder a lead sits in is the user's own; a director with its own hands commits
 * first; and for a lead that writes nothing the studio sets aside what no worker made in the
 * integration worktree (lead-session.ts `setAsideStrays`).
 */
async function dirtyRefusal(night: Night, root: string, leadSits: boolean): Promise<string | null> {
  const { ctx, lead, run } = night;
  const dirty = await gitAt(ctx, root, GIT.status).catch(() => "");
  if (!dirty) return null;
  if (leadSits) return LEAD_LIVE_DIRTY;
  if (!lead)
    return "your integration worktree has uncommitted edits — commit them first so the playtester plays what you see";
  try {
    await setAsideStrays(night, `director:${run.runId}:playtest`);
    return null;
  } catch (err: any) {
    return LEAD_DIRTY(err?.message ?? err);
  }
}

/** Is the folder clean and where is it: a play only counts as evidence on a head nobody moved. */
async function folderState(night: Night, root: string): Promise<{ head: string | null; clean: boolean }> {
  const { ctx } = night;
  const head = await headOf(ctx, root).catch(() => null);
  const clean = await gitAt(ctx, root, GIT.status)
    .then((status) => !status)
    .catch(() => false);
  return { head, clean };
}

/** One playtest in a folder that is the build: play it, record what it established, and answer. */
async function playIn(
  night: Night,
  { target, ask, n, playRoot, handle, budget, goalId, scenario }: AnyRecord,
): Promise<string> {
  const { appendRun, ctx, finalDeadline, note, run, softDeadline } = night;
  const before = await folderState(night, playRoot);
  // A playtest in the wrap-up plays until the wrap-up's end, not the working deadline behind it.
  const until = passDeadline({ now: Date.now(), softDeadline, finalDeadline });
  const played = await runPlaytest(ctx, {
    run: { ...run, setup: target.worker?.setup ?? run.setup ?? null },
    spec: { id: `play-${n}`, title: "director playtest", intent: ask, cameras: ["default"] },
    checks: [{ id: "director-play", kind: CheckKind.Play, ask, expect: "yes", weight: CheckWeight.Normal }] as Check[],
    root: playRoot,
    handle,
    deadline: Math.min(until, Date.now() + budget),
    iteration: n,
    labelPrefix: `director/play_${n}`,
    maxActions: PLAYTEST_MAX_ACTIONS,
  });
  const after = await folderState(night, playRoot);
  const untouched = before.clean && after.clean && before.head === after.head;
  const result = played?.results?.[0] ?? null;
  const words = playWords(result?.pass);
  await appendRun(RunEvent.RunInteractionEvidence, {
    head: untouched ? before.head : null,
    label: ask,
    status: words.status,
    note: result?.note ?? result?.reason ?? null,
    source: "independent-playtester",
  }).catch(() => {});
  if (goalId && night.state.goals && untouched && before.head && target.root === night.integrationWorktree) {
    recordGoalEvidence(night.state.goals, goalId, before.head, result?.pass ?? undefined, scenario);
    await keepCheckpoint(night, before.head);
    await night.saveJournal();
  }
  const bigMove = played?.report?.bigMove ?? null;
  note(`playtested ${target.label}: ${words.said}${bigMove ? ` — the player's big step: ${bigMove.what}` : ""}`);
  return JSON.stringify({
    target: target.label,
    question: ask,
    answer: words.answer,
    note: result?.note ?? result?.reason ?? "",
    actions: played?.report?.actions ?? 0,
    report: played?.report?.report ?? "",
    bigMove,
  });
}

export async function playtest(night: Night, args: AnyRecord) {
  const { ctx, resolveRoot, run, state, withLease } = night;
  const target = resolveRoot(args.target);
  if (target.error !== undefined) return target.error;
  const goal = state.goals?.entries.find((entry) => entry.id === args.goal);
  if (args.goal && !goal) return "Unknown required goal; read run_status.";
  if (goal && target.root !== night.integrationWorktree) return "Goal evidence must verify the integration revision.";
  const scenario = args.scenario === undefined ? undefined : Number(args.scenario);
  if (
    goal &&
    scenario !== undefined &&
    (!Number.isInteger(scenario) || scenario < 0 || scenario >= goal.acceptance.length)
  )
    return "scenario must name a zero-based acceptance index from run_status";
  const scenarios = scenario === undefined ? goal?.acceptance : [goal?.acceptance[scenario]];
  const ask = goal
    ? `Verify every required scenario through actual interaction: ${scenarios?.join("; ")}. Report no or unmeasured when a dependency or hosted two-client route is unavailable. Screenshots and protocol tests alone cannot prove multiplayer.`
    : String(args.ask ?? "").trim();
  if (!ask) return "playtest needs one yes/no question (ask)";
  const n = ++state.plays;
  const budget =
    Math.min(PLAYTEST_MAX_MINUTES, Math.max(PLAYTEST_MIN_MINUTES, num(args.minutes, PLAYTEST_DEFAULT_MINUTES))) *
    MINUTE_MS;
  // A playtest is a whole session of its own; it waits for a window rather than taking the user's.
  const answer = await withLease(WindowLease.Playtest, async (handle: string | null) => {
    ctx.setStatus(`run ${run.runId} · director playtesting ${target.label}`);
    const folder = await playFolder(night, target.root, n);
    if ("refusal" in folder) return folder.refusal;
    try {
      return await playIn(night, {
        target,
        ask,
        n,
        playRoot: folder.playRoot,
        handle,
        budget,
        goalId: goal?.id,
        scenario,
      });
    } catch (err: any) {
      return `playtest failed: ${err?.message ?? err}`;
    } finally {
      if (folder.tempWorktree)
        await ctx
          .call(HostMethod.SnapshotRemoveWorktree, { project: run.project, path: folder.tempWorktree })
          .catch(() => {});
      ctx.setStatus(`run ${run.runId} · director`);
    }
  });
  await finishBlockedGoals(night);
  return typeof answer === "string" ? answer : answer.noWindow;
}

export async function show(night: Night, args: AnyRecord) {
  const { appendRun, ctx, projectDir, resolveRoot, run } = night;
  const target = resolveRoot(args.target);
  if (target.error !== undefined) return target.error;
  try {
    await ctx.call(HostMethod.PreviewLoad, {
      project: run.project,
      ...(target.root !== projectDir ? { root: target.root } : {}),
    });
    await appendRun(RunEvent.DirectorShow, { target: target.label, root: target.root });
    const what = target.root === projectDir ? "the project folder" : target.label;
    return `Live's Reload now offers ${what}: the user sees it when they press it`;
  } catch (err: any) {
    return `could not show ${target.label}: ${err?.message ?? err}`;
  }
}

/** Does this line of the night's log wake a `wait` that asked only about `only` (or about nobody)? */
const wakes = (only: string | null, text: string): boolean =>
  !only || text.includes(`worker ${only}`) || text.startsWith("USER");

export async function wait(night: Night, args: AnyRecord) {
  const { ctx, finalDeadline, inbox, ledgerLines, note, notesSince, routeUserSteers, softDeadline, state } = night;
  const seconds = Math.min(MAX_WAIT_S, Math.max(1, num(args.seconds, WAIT_DEFAULT_S)));
  const only = args.worker ? slug(args.worker) : null;
  const from = night.waitSeq;
  const until = Date.now() + seconds * SECOND_MS;
  const finishing0 = await inbox.finishing().catch(() => false);
  while (Date.now() < until && !ctx.cancelled) {
    // Only the steers no wait this night has passed on yet: the director hears each one once. A
    // resumed night says them all once more, since its director may be a fresh session.
    const fresh = await inbox.steering(undefined, true, { onlyNew: true }).catch(() => []);
    for (const text of fresh) note(`USER SAYS: ${text}`);
    await routeUserSteers().catch(() => {});
    const finishing = await inbox.finishing().catch(() => false);
    if (finishing && !finishing0)
      note("USER ASKS TO FINISH: wrap up the current work, integrate what is ready, and call finish");
    if (notesSince(from).some((entry: { text: string }) => wakes(only, entry.text))) break;
    await sleep(SECOND_MS);
  }
  const unread = notesSince(from);
  const happened = unread.map((e: { text: string }) => e.text);
  // Snapshot before the later status awaits: a note arriving during those awaits belongs
  // to the next response. Never consume a notification that has not been returned.
  const lastUnread = unread.at(-1);
  if (lastUnread) night.waitSeq = Math.max(night.waitSeq, lastUnread.seq);
  // What a waiting director needs is what changed: the news, one line per worker (the monitor's
  // included), where integration stands and what the user has said. It used to be answered with
  // the whole status blob — every board, the window pool, the screen strip — twenty-three times
  // in one night, and every turn carried it again. `run_status` is one call away for the rest.
  const now = Date.now();
  return JSON.stringify({
    waitedSeconds: Math.round(seconds - Math.max(0, until - now) / SECOND_MS),
    happened: happened.length ? happened : ["nothing yet"],
    status: {
      time: { sessionMinutesLeft: minutes(softDeadline - now), hardMinutesLeft: minutes(finalDeadline - now) },
      integration: {
        head: state.integrationHead ? shortSha(state.integrationHead) : null,
        lastHealthPass: state.integrationHealthy,
        ...(state.ledger.length ? { defectsNobodyOwns: ledgerLines() } : {}),
      },
      workers: [...state.workers.values()].map((w) => waitDigest(w, now)),
      // What the user said is already in `happened`, as USER SAYS; this is the standing request.
      user: { finishRequested: await inbox.finishing().catch(() => false) },
    },
  });
}

// ── the tools that act on one worker, and the note ──

/** Every worker: this session's, then those from before a pause (what the journal kept of them). */
function everyWorkerStatus(night: Night): string {
  const { state } = night;
  return JSON.stringify([...[...state.workers.values()].map((w) => workerDigest(w)), ...priorWorkersStatus(night)]);
}

/** One worker in detail — one from before a pause as the journal kept it — or every worker when no id is given. */
function workerStatus(night: Night, args: AnyRecord): string {
  const { state } = night;
  if (!args.id) return everyWorkerStatus(night);
  const worker = state.workers.get(slug(args.id));
  if (!worker) {
    const prior = priorWorkerStatus(night, slug(args.id));
    return prior ? JSON.stringify(prior) : `no worker "${args.id}"`;
  }
  return JSON.stringify({
    ...workerDigest(worker),
    brief: worker.brief.slice(0, STATUS_BRIEF_CHARS),
    iterationsDetail: worker.iterations.slice(-STATUS_ITERATIONS),
    attempts: (worker.result?.attempts ?? []).slice(-STATUS_ATTEMPTS),
    summary: worker.summary || undefined,
    problems: worker.problems.length ? worker.problems : undefined,
    unsatisfiable: worker.unsatisfiable?.length ? worker.unsatisfiable : undefined,
    steeringQueued: worker.steering.length,
    board: worker.result?.board ? renderScoreboard(worker.result.board) : undefined,
  });
}

/**
 * A rung on the running worker's ladder (M3.3). The loop reads `spec.milestones` at the top of
 * every iteration, and a `steered` rung goes ahead of the rest of the ladder, so the next one
 * builds this and not what the harness would have named, nor the rung it was on — and from here
 * on the ladder is the director's. Answers the rung, or why there is none.
 */
function addRung(worker: Worker, moveText: string): { rung: AnyRecord } | { refusal: string } {
  if (!worker.spec)
    return {
      refusal: `worker ${worker.id} has no ladder to add a move to — it is a single session; send it text instead`,
    };
  const climbed = worker.spec.milestones ?? [];
  const milestone = normalizeMilestone({ what: moveText }, climbed.length);
  if (!milestone) return { refusal: "move: one sentence saying what the project IS after this iteration" };
  // The same sentence twice is a new rung, not the one already climbed.
  const id = climbed.some((m: { id: string }) => m.id === milestone.id)
    ? `${milestone.id}-${climbed.length + 1}`
    : milestone.id;
  const rung = { ...milestone, id, steered: true };
  worker.spec.milestones = [...climbed, rung];
  worker.spec.moveOwner = MoveOwner.Director;
  return { rung };
}

/** Where a steer is now: interrupted into the build turn, waiting a minute for the next one, or queued. */
function arrivalWords(worker: Worker, text: string, reached: boolean, nowAsked: boolean): string {
  if (!text) return "";
  if (reached)
    return `${worker.id}'s build turn was interrupted and it is carrying on with your instruction in front of everything`;
  if (nowAsked)
    return `${worker.id} is between turns; it reads your instruction at the top of the next one, a minute away`;
  return `queued for ${worker.id}'s next round`;
}

/** The answer to a steer: where the instruction is, and the move its next round builds. */
function steerAnswer(worker: Worker, arrival: string, rung: AnyRecord | null, text: string): string {
  if (rung && text) return `${arrival}. Its next round builds the move you named.`;
  if (rung) return `${worker.id}'s next round builds it as THE MOVE (mandatory)`;
  return arrival;
}

async function steerWorker(night: Night, args: AnyRecord): Promise<string> {
  const { appendRun, interruptWorker, state } = night;
  const worker = state.workers.get(slug(args.id));
  if (!worker) return `no worker "${args.id}"`;
  const text = String(args.text ?? "").trim();
  const moveText = String(args.move ?? "").trim();
  if (!text && !moveText) return "worker_steer needs text, move, or both";
  if (!isRunning(worker))
    return `worker ${worker.id} is ${worker.state}; start a new worker with the instruction in its brief`;
  let rung = null;
  if (moveText) {
    const added = addRung(worker, moveText);
    if ("refusal" in added) return added.refusal;
    rung = added.rung;
  }
  // A single session is only ever steered now — it has no boundary to wait for.
  const nowAsked = worker.mode !== WorkerMode.Loop || yes(args.now, false);
  if (text) worker.steering.push(text);
  await appendRun(RunEvent.RunSteering, {
    text: text || `the next move: ${moveText}`,
    facetId: worker.id,
    source: SteeringSource.Director,
    now: nowAsked,
    at: new Date().toISOString(),
  });
  const reached = text && nowAsked ? await interruptWorker(worker) : false;
  return steerAnswer(worker, arrivalWords(worker, text, reached, nowAsked), rung, text);
}

async function stopWorkerTool(night: Night, args: AnyRecord): Promise<string> {
  const { decision, run, state, stopWorker } = night;
  const worker = state.workers.get(slug(args.id));
  if (!worker) return `no worker "${args.id}"`;
  if (!isRunning(worker)) return `worker ${worker.id} is already ${worker.state}`;
  const why = String(args.why ?? "").trim();
  const at = worker.mode === WorkerMode.Loop ? worker.iterations.length + 1 : 1;
  await stopWorker(worker, why);
  await decision(
    `director stopped worker ${worker.id}${why ? `: ${why}` : ""}`,
    `stopped the builder working on ${worker.title}${why ? ` — ${why}` : ""}`,
  );
  // What actually happens, so the director does not have to guess: the edits it had
  // written are committed where they stand, the round is recorded as stopped rather
  // than judged, and integrate still takes only what the loop accepted.
  return [
    `stop requested for ${worker.id}${why ? ` (${why})` : ""}.`,
    worker.mode === WorkerMode.Loop
      ? `Its unfinished edits are committed in ${worker.worktree}, kept on ${attemptRef(run.runId, worker.id, at, { stopped: true })} — nothing is reset, and that round is recorded as stopped, not judged.`
      : `Whatever it had written is committed in ${worker.worktree} as its last commit.`,
    `Its last accepted commit${worker.lastCommit ? ` (${shortSha(worker.lastCommit)})` : ""} is what integrate would take; worker_status once it settles.`,
  ].join(" ");
}

async function noteTool(night: Night, args: AnyRecord): Promise<string> {
  const { decision, journal, saveJournal } = night;
  const text = String(args.text ?? "").trim();
  if (!text) return "note needs text";
  journal.director.notes.push({
    at: new Date().toISOString(),
    text: text.slice(0, NOTE_CHARS),
    plain: plainly(String(args.plain ?? "").trim() || text).slice(0, NOTE_PLAIN_CHARS),
  });
  await saveJournal();
  await decision(`director: ${text}`, String(args.plain ?? "").trim() || null);
  return "noted";
}

/** Pause only when no independent required work remains; preserve the integrated checkpoint. */
async function finishBlockedGoals(night: Night): Promise<void> {
  const ledger = night.state.goals;
  if (!ledger || goalDecision(ledger, night.state.integrationHead) !== GoalStatus.Blocked) return;
  const blockers = ledger.entries
    .filter((goal) => goal.status === GoalStatus.Blocked)
    .map((goal) => `${goal.id}: ${goal.blocker}`);
  await night.finish({
    summary: `Required work is blocked (${blockers.join("; ")}). The integration checkpoint is retained. Resolve the prerequisite or revise the approach, then Resume.`,
    land: "no",
    victory: "no",
  });
}

/** Goal updates can explain missing work, but cannot create acceptance evidence. */
async function updateGoal(night: Night, args: AnyRecord): Promise<string> {
  const goal = night.state.goals?.entries.find((entry) => entry.id === args.goal);
  if (!goal) return "Unknown required goal; read run_status.";
  const blocker = Object.values(GoalBlocker).find((code) => code === args.blocker);
  if (blocker) {
    goal.status = GoalStatus.Blocked;
    goal.blocker = blocker;
  } else if (!replanGoal(goal, args.replan))
    return "Supply a typed blocker or the one concrete replan; passing requires independent playtest evidence.";

  await night.saveJournal();
  await finishBlockedGoals(night);
  return JSON.stringify(goal);
}

/** A tool's answer to the director's session: a sentence, or a JSON string. */
type ToolAnswer = unknown;
type Tool = (night: Night, args: AnyRecord) => ToolAnswer | Promise<ToolAnswer>;

/**
 * The night's plan and its worker starts, one at a time. A lead that calls them in parallel (a
 * Codex lead does) had a start read the plan another call was still writing, and two starts claim
 * the same id or window (P09-F2). Each waits for the one before; a failure does not block the next.
 */
const PLAN_CHANGES = new WeakMap<Night, Promise<unknown>>();

function oneAtATime<T>(night: Night, change: () => T | Promise<T>): Promise<T> {
  const next = (PLAN_CHANGES.get(night) ?? Promise.resolve()).then(change);
  PLAN_CHANGES.set(
    night,
    next.catch(() => {}),
  );
  return next;
}

/**
 * The tools another part of the night answers (workers.ts, integrate.ts, the looks above). The
 * handler returns their answer as it comes, as the switch it replaced always did: a failure in one
 * of them rejects the dispatch instead of becoming a `<tool> failed: …` sentence.
 */
const HANDED_OFF = {
  [DirectorTool.Plan]: (night, args) => oneAtATime(night, () => night.setPlan(args)),
  [DirectorTool.WorkerStart]: (night, args) => oneAtATime(night, () => night.startWorker(args)),
  [DirectorTool.Wait]: (night, args) => night.wait(args),
  [DirectorTool.Judge]: (night, args) => night.judge(args),
  [DirectorTool.Playtest]: (night, args) => night.playtest(args),
  [DirectorTool.Integrate]: (night, args) => night.integrate(args),
  [DirectorTool.Show]: (night, args) => night.show(args),
  [DirectorTool.Finish]: (night, args) => night.finish(args),
} satisfies Partial<Record<DirectorTool, Tool>>;

/** The tools this handler answers itself: it waits for each, so a failure is said as a sentence. */
const ANSWERED_HERE = {
  [DirectorTool.ResolveRoot]: (night, args) => {
    const target = night.resolveRoot(args.target);
    return target.error ?? target.root;
  },
  [DirectorTool.RunStatus]: async (night) => JSON.stringify(await night.statusText()),
  [DirectorTool.WorkerStatus]: workerStatus,
  [DirectorTool.WorkerSteer]: steerWorker,
  [DirectorTool.WorkerStop]: stopWorkerTool,
  [DirectorTool.Note]: noteTool,
  [DirectorTool.GoalUpdate]: updateGoal,
} satisfies Record<Exclude<DirectorTool, keyof typeof HANDED_OFF>, Tool>;

/** A tool by the name the session called it, or null for a name the night does not answer. */
function toolNamed(name: string): { tool: Tool; answeredHere: boolean } | null {
  if (Object.hasOwn(ANSWERED_HERE, name))
    return { tool: ANSWERED_HERE[name as keyof typeof ANSWERED_HERE], answeredHere: true };
  if (Object.hasOwn(HANDED_OFF, name))
    return { tool: HANDED_OFF[name as keyof typeof HANDED_OFF], answeredHere: false };
  return null;
}

export async function handler(night: Night, name: string, args: AnyRecord): Promise<unknown> {
  if (night.ctx.cancelled && name !== DirectorTool.ResolveRoot) return STOPPED_BY_USER;
  night.toolCalls++;
  // Counted until its answer settles: the chat never cuts a turn short inside a call (wake.ts).
  night.toolsInFlight = (night.toolsInFlight ?? 0) + 1;
  try {
    return await timedOperation(
      name,
      typeof args.goal === "string" ? args.goal : null,
      () => answer(night, name, args),
      (span) => {
        const director = night.journal?.director;
        if (!director) return;
        retainSpan(director, { ...span, runId: night.run.runId, head: night.state.integrationHead });
      },
    );
  } finally {
    night.toolsInFlight = (night.toolsInFlight ?? 1) - 1;
    if (night.state.finished) await night.saveJournal().catch(() => {});
  }
}

/** One tool call's answer: a sentence, or the answer the part it hands off to gives. */
async function answer(night: Night, name: string, args: AnyRecord): Promise<unknown> {
  const { keepMemory, syncHead } = night;
  try {
    // Every declared tool starts at the head the worktree actually stands on (`headSynced`).
    if (headSynced(name)) await syncHead();
    // Whatever the director last wrote into its memory file, kept where a resume can read it.
    await keepMemory();
    const named = toolNamed(name);
    if (!named) return `unknown director tool: ${name}`;
    if (named.answeredHere) return await named.tool(night, args);
    // Not awaited on purpose: a handed-off tool's rejection passes this catch (see HANDED_OFF).
    return named.tool(night, args);
  } catch (err: any) {
    return `${name} failed: ${err?.message ?? err}`;
  }
}
