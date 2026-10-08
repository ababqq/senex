/**
 * The night's first steps, before the director's session opens: making somebody's own project
 * judgeable (`installContract`) and building the starting point of a project with nothing in it
 * (`buildStartingPoint`) — and before both, `prepareNight`, which builds the night itself.
 */

import { DEFAULT_WALL_CLOCK_MS, MIN_DELEGATE_TIMEOUT_MS, PAGE_SEED } from "../config.ts";
import { gatherEvidence } from "../evidence.ts";
import { commitAll, GIT, gitAt, gitlinks, headOf, resetClean, shortSha } from "../git.ts";
import { HostMethod } from "../host-methods.ts";
import { AttachedContract, StudioContract } from "../page-contract.ts";
import { readDeclaredApp } from "../kinds.ts";
import { appendLedger, ledgerFromEvents, loadProjectLessons, readLedger } from "../ledger.ts";
import { writeWorktreeFile } from "../library.ts";
import { roleEffort, roleEngine, RoleKey } from "../model-roles.ts";
import { engineLimitOf, isEngineLimit } from "../outage.ts";
import { baseBrief } from "../prompts-build.ts";
import { runRef } from "../repo.ts";
import { EventKind, JournalPhase, RunEvent, RunMode } from "../run-events.ts";
import { createRunInbox } from "../run-inbox.ts";
import { isCommit } from "../shell.ts";
import { MINUTE_MS } from "../time.ts";
import { bindNight, BuildTarget, WindowLease } from "./night.ts";
import path from "node:path";
import { preparationBudgetMs } from "./budgets.ts";
import { contractBrief, preparationBudgetNote } from "./briefs.ts";
import { nightClock, restoreNight } from "./journal.ts";
import { clampDirectorMemory } from "./memory.ts";
import { outcomesAwaitPlan, reopenCommits, reopenMarkOf } from "./reopen.ts";
import { startingHeads } from "./rules.ts";
import type { AnyRecord, HarnessCtx, Run } from "../../types/harness.d.ts";
import type { ProjectShape, ReferenceFrame } from "../../types/host-api.d.ts";
import type { Evidence } from "../evidence.ts";
import type { LedgerRecord } from "../ledger.ts";
import type { Night, NightData, NightShape, NightState } from "./night.ts";

/**
 * This part serves a lead that is its chat's own session and writes nothing (one session): a night
 * seats one only when every part it depends on says so (lead-session.ts `servesLead`).
 */
export const SERVES_LEAD = true;

/** A wiring job is minutes of work, not a stage of the night: it never takes more than this. */
const CONTRACT_SESSION_MAX_MS = 20 * MINUTE_MS;
/** The shape a project has when the studio made it: the template's page and entry, no build step. */
const TEMPLATE_SHAPE = { entry: "index.html", main: "src/main.js", build: null };
/** What kind of project this is for the ledger, when its shape does not say. */
const ProjectShapeKind = { OwnScript: "own-script", StudioTemplate: "studio-template" } as const;

/**
 * What a night learns from the session before it: its journal and the director's memory file — the
 * file only for a director with its own worktree (`keepsMemory`): a lead that is its chat's own
 * session reads the night from the journal alone, and an older night's file is left where it is.
 */
async function readPriorNight(ctx: HarnessCtx, threadId: string, run: Run, resume: boolean, keepsMemory: boolean) {
  // A journal that is not there reads as null; one the host cannot read throws, and the night
  // stops on it. Read as "no journal", it restarted the night with a full budget, a fresh plan
  // and none of its heads (P09-F4).
  const priorJournal = resume
    ? await ctx.call(HostMethod.ArtifactRead, { threadId, artifactId: `autopilot_${run.runId}` })
    : null;
  /** Last session's `.studio/DIRECTOR.md`, if it kept one: the worktree it wrote it in is gone. */
  const priorMemory =
    resume && keepsMemory
      ? await ctx
          .call(HostMethod.ArtifactRead, { threadId, artifactId: `director_memory_${run.runId}` })
          .catch(() => null)
      : null;
  const memoryRestored = typeof priorMemory?.text === "string" && priorMemory.text.trim().length > 0;
  return { priorJournal, priorMemory, memoryRestored };
}

/**
 * What kind of project this is and whose shape it has, on the run record before anything is
 * judged (M4.4): the judges, the briefs and the artefact-class filter all read them from there.
 * A resumed night restores the kind its first session declared; a fresh night reads back what
 * an earlier night wrote into the project's own studio.json, which is the durable declaration
 * across nights. Without it the director wrote that block and nothing ever read it: a second
 * night on a declared board project drove mouse-look and WASD before every judgement, and no board
 * carried a HUD, look or movement check.
 */
async function declareRunApp(ctx: HarnessCtx, run: Run, ownShape: boolean, priorJournal: AnyRecord | null) {
  run.ownShape = ownShape;
  run.genres = Array.isArray(run.genres) ? run.genres : [];
  if (!run.app)
    run.app =
      priorJournal?.director?.plan?.app ??
      priorJournal?.run?.app ??
      (await readDeclaredApp(ctx, run.project).catch(() => null));
}

/**
 * What earlier nights on this exact project cost (loop/ledger.ts). Loaded once: the brief carries
 * the top five, every worker's BRIEF.md carries the same five (through `run.projectLessons`), and
 * the records behind them are what warns a dry run about a check nobody has ever been able to
 * read. A project with no ledger yet simply gets nothing.
 *
 * A project whose earlier nights ran before this ledger existed has none of them written down, and
 * would pay for every one of their lessons again. Its own thread still holds them, so the first
 * night here reads that log back into the same records (`ledgerFromEvents`) before it asks what
 * this project has taught. Once only — after this the file is not empty — and never fatal: a night
 * that cannot read its own past still runs, it just starts blank.
 */
async function loadPriorLedger(ctx: HarnessCtx, threadId: string, run: Run, appKind: string) {
  const priorLedger = await readLedger(ctx.workspace, run.project!).catch((): LedgerRecord[] => []);
  if (priorLedger.length === 0) {
    const past = await ctx.call(HostMethod.EventsList, { threadId }).catch(() => []);
    const replayed = ledgerFromEvents(Array.isArray(past) ? past : [], { project: run.project, appKind }).filter(
      (record) => record.runId !== run.runId,
    );
    for (const record of replayed) await appendLedger(ctx.workspace, run.project, record).catch(() => {});
    priorLedger.push(...replayed);
  }
  return priorLedger;
}

/**
 * The record a resumed or reopened night's earlier session closed with (its last `run_finished`),
 * or null: the night goes on with it rather than writing over it (golden-boot-glory: a reopen's
 * report kept none of the thirteen workers and 31 rounds of the night it continued).
 */
async function earlierReport(ctx: HarnessCtx, threadId: string, runId: string): Promise<AnyRecord | null> {
  const events = await ctx.call(HostMethod.EventsList, { threadId }).catch(() => []);
  const close = events.findLast(
    (event) => event.data?.event_type === RunEvent.RunFinished && event.data.payload?.runId === runId,
  );
  return close?.data.payload ?? null;
}

/** A list from an earlier record, or none. */
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? [...value] : []);

/**
 * The report a night leaves behind, as it starts: a resumed or reopened night's carries its earlier
 * sessions' workers, rounds, verdicts and notes, and how many rounds they kept (`earlier`), so the
 * close adds to the record and the learning pass knows what is new.
 */
export function nightReport(run: Run, earlier: AnyRecord | null = null): AnyRecord {
  const report = freshReport(run);
  if (!earlier) return report;
  const iterations = listOf(earlier.iterations);
  const workers = earlier.workers && typeof earlier.workers === "object" ? { ...earlier.workers } : {};
  return {
    ...report,
    workers,
    iterations,
    notes: listOf(earlier.notes),
    verdicts: listOf(earlier.verdicts),
    earlier: { rounds: iterations.length },
  };
}

/** A night's report with nothing in it yet. */
function freshReport(run: Run): AnyRecord {
  return {
    runId: run.runId,
    project: run.project,
    goal: run.goal,
    reference: run.reference?.name ?? "unnamed",
    referenceStills: (run.reference?.frames ?? []).map((f: ReferenceFrame) => f.label),
    mode: RunMode.Director,
    workers: {},
    iterations: [],
    notes: [],
    /** One record per build this night judged — the fork gate, the judge, the health pass, the close. */
    verdicts: [],
    victory: false,
    stoppedBecause: "",
    landed: false,
    integrationHead: null,
  };
}

/** The night's first cards on its thread: the run started, as a director's. */
async function announceRunStart(
  ctx: HarnessCtx,
  threadId: string,
  run: Run,
  start: { resume: boolean; liveChat: boolean },
  capacity: AnyRecord | null,
) {
  const { resume, liveChat } = start;
  await ctx.call(HostMethod.EventsAppend, {
    threadId,
    batch: [
      {
        type: EventKind.Custom,
        event_type: RunEvent.RunStarted,
        payload: {
          runId: run.runId,
          goal: run.goal,
          project: run.project,
          mode: RunMode.Director,
          ...(run.engine ? { engine: run.engine } : {}),
          ...(run.model ? { model: run.model } : {}),
          ...(run.roles ? { roles: run.roles } : {}),
          ...(run.judgeModel ? { judgeModel: run.judgeModel } : {}),
          ...(run.builderEngine ? { builderEngine: run.builderEngine } : {}),
          ...(run.judgeEngine ? { judgeEngine: run.judgeEngine } : {}),
          ...(resume ? { resumed: true } : {}),
          reference: {
            name: run.reference?.name,
            shots: run.reference?.shots ?? [],
            notes: run.reference?.notes,
            kind: run.reference?.kind,
            frameCount: run.reference?.frames?.length ?? 0,
            frames: (run.reference?.frames ?? []).map((f) => f.label),
          },
          budgets: run.budgets,
          blender: run.blender ?? null,
        },
      },
      {
        type: EventKind.Custom,
        event_type: RunEvent.AutopilotStarted,
        payload: {
          runId: run.runId,
          project: run.project,
          facets: [],
          integrationNotes: "",
          maxParallel: capacity?.max ?? 1,
          director: true,
          ...(resume ? { resumed: true } : {}),
          // The composer tells the person a message reaches the lead now (renderer chat/live-chat.ts).
          ...(liveChat ? { liveChat: true } : {}),
        },
      },
    ],
  });
}

/** The project, ready: scaffolded if new, on the current contract, loaded in the studio window. Answers its folder. */
async function readyTheProject(night: Night): Promise<string> {
  const { ctx, decision, run } = night;
  await ctx.call(HostMethod.ProjectScaffold, { name: run.project, title: run.project });
  const upgraded = await ctx.call(HostMethod.ProjectUpgradeContract, { project: run.project }).catch(() => null);
  if (upgraded?.upgraded)
    await decision(
      `upgraded src/studio.js to the v2 contract (the previous copy is kept as ${upgraded.backup})`,
      "updated the project's connection to the studio so this build's work can be checked",
    );
  await ctx.call(HostMethod.PreviewLoad, { project: run.project }).catch(() => {});
  const projects = await ctx.call(HostMethod.ProjectList, {}).catch(() => []);
  const projectDir = projects.find((g: AnyRecord) => g.name === run.project)?.dir ?? null;
  if (!projectDir) throw new Error(`project ${run.project} has no folder`);
  return projectDir;
}

/**
 * The start as the harness first sees it. It may simply be the empty scaffold — the one build
 * whose blank frames are honest. Only the harness's own base pass may say so (gauntlet grants
 * the exemption to `scaffold` at iterationId "base", and a conformance test keeps that lock
 * double), so it is asked that way before deciding this night cannot see where it starts.
 */
async function observeStart(night: Night): Promise<Evidence | null> {
  const { ctx, lookAtStart, run } = night;
  const seen = await lookAtStart(undefined);
  if (seen) return seen;
  const asBase = await gatherEvidence(ctx, {
    run,
    iterationId: "base",
    labelPrefix: "iter_000_base",
    seed: PAGE_SEED,
    eyes: true,
    motion: 0,
    audio: false,
    scaffold: true,
  }).catch(() => null);
  return asBase?.ok === true && asBase.emptyScene === true ? asBase : null;
}

/**
 * The director's memory. Its brief tells it to keep `.studio/DIRECTOR.md` current and a resumed
 * session is told to read that file — but `.studio/` never reaches a commit (the brief writer
 * ignores it), and the worktree it lives in is removed at the close. A night that paused on a
 * session limit was resumed into a worktree created a moment before and sent to read a file
 * that no longer existed. So the studio keeps the copy: a run artifact for the record, and a
 * thread artifact the next session restores from (`keepMemory`).
 */
async function restoreMemory(night: Night, integrationWorktree: string, priorMemory: AnyRecord | null) {
  night.memoryKept = null;
  if (!priorMemory) return;
  const restored = clampDirectorMemory(priorMemory.text);
  await writeWorktreeFile(integrationWorktree, "DIRECTOR.md", restored).catch(() => {});
  night.memoryKept = restored;
}

/** What prepareNight puts on the night once the integration worktree is open (the rest is there already). */
type NightKnown = Omit<
  NightData,
  "ctx" | "threadId" | "run" | "resume" | "integrationRef" | "memoryKept" | "priorWorkers"
>;

/** Everything `nightState` and `nightJournal` are made of. */
interface NightFacts {
  run: Run;
  threadId: string;
  projectDir: string;
  shape: NightShape;
  ownShape: boolean;
  baseCommit: string | null;
  forkCommit: string | null;
  integrationWorktree: string;
  fromScratch: boolean;
  startEvidence: Evidence | null;
  priorJournal: AnyRecord | null;
  softDeadline: number;
  finalDeadline: number;
}

/** The night's `state`: the workers, the heads, the log — everything that changes all night. */
function nightState(facts: NightFacts): NightState {
  const { run, threadId, projectDir, shape, ownShape, baseCommit, forkCommit, integrationWorktree } = facts;
  const { fromScratch, startEvidence, priorJournal, softDeadline, finalDeadline } = facts;
  return {
    run,
    threadId,
    projectDir,
    shape,
    ownShape,
    baseCommit,
    integrationWorktree,
    integrationHead: forkCommit,
    integrationHealthy: null,
    /** commit → did the harness's health pass load it (the clean-base gate for worker_start). */
    healthByHead: new Map(),
    /** commit → the console errors it logs anyway (a worker is not broken for inheriting them). */
    consoleByHead: new Map(),
    /** commit → what it reported when last looked at (state, demo end states, cameras, demos) — a worker's checks are dry-run against it. */
    evidenceByHead: new Map(),
    /** The run's own starting points (`startingHeads`): the scaffold, and the base stage's commit. */
    baseHeads: new Set(startingHeads({ fromScratch, forkCommit, priorJournal })),
    /** Did the night begin on an empty scaffold — nothing to judge against, nothing to fork from. */
    fromScratch,
    /** Every console error the run's starting build already logged: nobody in this run is to blame for them. */
    startConsole: startEvidence?.consoleBaseline ?? [],
    /**
     * The last judge on the integration branch: { head, ok, pick, answer, boardAllPass }. `ok`
     * is only "it could be looked at"; a `pick`/`answer` is the one thing that means a judge
     * preferred this build to another. The close reads both, and says which it had.
     */
    lastJudge: priorJournal?.director?.lastJudge?.head === forkCommit ? priorJournal?.director.lastJudge : null,
    /** An engine limit that ended a session: { kind, message, retryAfterMs, at }. */
    limit: null,
    /**
     * The workers' engine's limit, when the workers run on the other subscription (cross-provider
     * roles): { engine, kind, message, retryAfterMs, at, worker }. Not the director's own limit
     * and never a pause — run_status carries it so the director can wait it out or build by hand.
     */
    workerLimit: null,
    workers: new Map(),
    /**
     * The night's plan (M3.8) — the one the user reads, and the one `worker_start` is held to.
     * A resumed night keeps the plan its first session wrote; the review window is not reopened.
     */
    plan: priorJournal?.director?.plan ?? null,
    /** When the user's window to answer the plan closes, while one is open. */
    planReviewUntil: null,
    /** Instructions already in the inbox when the plan went up — not an answer to it. */
    planSaidFrom: 0,
    /** Set once the workers may start: the user said go, or nobody did and the window closed. */
    planGo: false,
    /** Every worker's contract, live: a worker started later is routed defects too (WP2d). */
    facetSpecs: [],
    /** Defects the judge named for a worker that is already finished — the director's own ledger. */
    ledger: [],
    /** The worker monitor's loop, while one is running. */
    monitor: null,
    log: [],
    finish: null,
    finished: false,
    startEvidence,
    judges: 0,
    plays: 0,
    softDeadline,
    finalDeadline,
  };
}

/** The journal a resume replays: the run, its plan, its starting point and the director's own record. */
function nightJournal(facts: NightFacts): AnyRecord {
  const { run, baseCommit, forkCommit, priorJournal } = facts;
  return {
    runId: run.runId,
    run: { ...run, reference: { ...(run.reference ?? {}), frames: undefined, stats: undefined } },
    mode: RunMode.Director,
    phase: JournalPhase.Director,
    plan: { facets: [], assumptions: [], scout: null, setup: run.setup ?? null },
    facets: {},
    base: priorJournal?.base ?? null,
    /** The "make it judgeable" step (M2.6): { commit, ok, error }. A resumed night keeps its own. */
    contract: priorJournal?.contract ?? null,
    director: {
      sessionId: priorJournal?.director?.sessionId ?? null,
      baseCommit,
      integrationHead: forkCommit,
      lastJudge: priorJournal?.director?.lastJudge ?? null,
      workers: {},
      notes: [],
    },
  };
}

/** The counters and the ledger chain every night starts with (see `note`, `remember`, `handler`). */
function nightCounters(): Pick<NightData, "logSeq" | "waitSeq" | "tonight" | "ledgerWrites" | "toolCalls"> {
  return {
    /**
     * The night's log, which the waker and the director's own `wait` read back (`note`) and the
     * journal keeps the newest of. Every entry carries a sequence number of its own because the
     * log is capped: a `wait` that remembered where it started as an INDEX into the array went
     * blind the moment the cap began shifting entries off the front — `slice(from)` answered
     * nothing for the rest of the night, so no worker event and no user instruction ever woke a
     * wait again.
     */
    logSeq: 0,
    waitSeq: 0,
    /**
     * The project's ledger (loop/ledger.ts) — not `state.ledger`, which is this run's own list of
     * defects nobody owns. Every outcome the night produces — a judged round, a stopped round, a
     * builder the fork gate refused, the close itself — is appended to the project's own file in
     * the studio's state as it happens (`remember`), so a night killed by a quit still teaches
     * the next one. Writes are chained rather than fired in parallel: five workers finishing a
     * round in the same second must land as five lines, in order.
     */
    tonight: [],
    ledgerWrites: Promise.resolve(),
    /** Tool calls the session has made: a continuation that makes none is not progress. */
    toolCalls: 0,
  };
}

/** The project as the night finds it: its shape, its kind, and whether it can be judged at all. */
async function appAtStart(ctx: HarnessCtx, run: Run) {
  const descriptor =
    (await ctx.call(HostMethod.ProjectList, {}).catch(() => [])).find((g) => g.name === run.project) ?? null;
  const ownShape = descriptor?.built === true;
  const shape = descriptor?.shape ?? TEMPLATE_SHAPE;
  /** What kind of project this is, for the ledger: a check that never measures on a Phaser project may measure fine on the template. */
  const appKind =
    (shape as Partial<ProjectShape>)?.kind ?? (ownShape ? ProjectShapeKind.OwnScript : ProjectShapeKind.StudioTemplate);
  return { ownShape, shape, appKind };
}

/**
 * Can this project be judged at all? A page that never loads the studio contract has no state(),
 * no cameras and no capture: every judge answers "the build does not run", the fork gate refuses
 * every builder, and `judge against=start` has no "before". launchFromIntake already asked the
 * folder (`run.readiness`); a night started any other way — the run IPC, a resume — asks here.
 * The answer is a job, not a refusal: `installContract` is the night's first step, in the run's
 * own worktree, never in the folder the user sees.
 */
async function contractIsMissing(ctx: HarnessCtx, run: Run, ownShape: boolean): Promise<boolean> {
  const readiness =
    run.readiness ?? (await ctx.call(HostMethod.ProjectValidate, { project: run.project }).catch(() => null));
  return ownShape && readiness?.contract === StudioContract.Missing;
}

/**
 * Where the night stands in the project's history: the starting point the user had (a snapshot of
 * the folder) and, on a resume, where this session picks the branch up. They are the same commit
 * on a first session and must not be on a resume: a resumed night that called its fork point
 * "the base" found "nothing beyond the starting point" at the close and hid eight merges from
 * the user. A finished build reopened starts from the folder as it is now (director/reopen.ts).
 */
async function startingCommits(ctx: HarnessCtx, run: Run, priorJournal: AnyRecord | null) {
  const incumbent = await ctx.call(HostMethod.SnapshotCreate, {
    scope: "game",
    reason: `run ${run.runId}: director starting point`,
    project: run.project,
  });
  const live = incumbent?.git?.game ?? null;
  const reopened = reopenMarkOf(priorJournal);
  if (reopened && isCommit(live)) {
    const facts = { project: run.project, runId: run.runId, finishedHead: reopened.finishedHead, liveHead: live };
    return { liveHead: live, ...(await reopenCommits(ctx, facts)) };
  }
  const baseCommit = priorJournal?.director?.baseCommit ?? priorJournal?.director?.integrationHead ?? live;
  const forkCommit = priorJournal?.director?.integrationHead ?? baseCommit;
  return { liveHead: live ?? baseCommit, baseCommit, forkCommit };
}

/**
 * The integration worktree, forked from where the night stands. Worktrees are detached: removing
 * one leaves its commits unreferenced. A ref in the project's repo keeps the night's integration
 * reachable whatever happens to the worktree (a run once lost 122 files of merged work to
 * teardown because nothing pointed at the head).
 */
async function openIntegration(night: Night, forkCommit: string | null): Promise<string> {
  const { ctx, protectHead, run } = night;
  const wt = await ctx.call(HostMethod.SnapshotWorktree, {
    project: run.project,
    ...(forkCommit ? { commit: forkCommit } : {}),
    name: BuildTarget.Integration,
    runId: run.runId,
  });
  night.integrationRef = runRef(run.runId, BuildTarget.Integration);
  await protectHead(forkCommit);
  return wt.path;
}

/**
 * Everything a night knows before its first tool call, as one object: the run and its clock, the
 * project's shape and ledger, the starting point and the integration worktree forked from it, the
 * report, `state` and the journal. Every function of the night is put on it (`bindNight`) before
 * the first of them runs, so the setup below calls them the way the rest of the night does.
 *
 * `modules` are the director's module namespaces (`bindNight`).
 */
export async function prepareNight(
  ctx: HarnessCtx,
  {
    threadId,
    run,
    resume = false,
    oneSession = false,
    liveChat = false,
  }: { threadId: string; run: Run; resume?: boolean; oneSession?: boolean; liveChat?: boolean },
  modules: ReadonlyArray<Record<string, unknown>>,
): Promise<Night> {
  const night = bindNight({ ctx, threadId, run, resume }, modules);
  const { lookAtStart, saveJournal, rememberEvidence } = night;
  const inbox = ctx.runInbox ?? createRunInbox(ctx, { threadId, runId: run.runId });

  ctx.setStatus(`run ${run.runId} · director`);

  // A lead that is its chat's own session (`oneSession`, lead-session.ts) keeps no memory file.
  const prior = await readPriorNight(ctx, threadId, run, resume, !oneSession);
  const { priorJournal, priorMemory, memoryRestored } = prior;
  // A Resume goes on with the working time the night had left: the budget is the night's, not
  // each session's, and time spent paused does not count.
  const clock = nightClock({
    saved: resume ? priorJournal?.director?.clock : null,
    now: Date.now(),
    totalMs: run.budgets?.wallClockMs ?? DEFAULT_WALL_CLOCK_MS,
  });
  const { started, softDeadline, finalDeadline } = clock;
  const { ownShape, shape, appKind } = await appAtStart(ctx, run);
  await declareRunApp(ctx, run, ownShape, priorJournal);
  const capacity = await ctx.call(HostMethod.PreviewCapacity, {}).catch(() => null);
  const contractMissing = await contractIsMissing(ctx, run, ownShape);
  const priorLedger = await loadPriorLedger(ctx, threadId, run, appKind);
  const projectLessons = await loadProjectLessons(ctx.workspace, run.project).catch(() => []);
  run.projectLessons = projectLessons;
  const report = nightReport(run, resume ? await earlierReport(ctx, threadId, run.runId) : null);
  await announceRunStart(ctx, threadId, run, { resume, liveChat }, capacity);

  // A project that came with its own shape is photographed BEFORE the studio touches it: the
  // scaffold and the contract upgrade below write the studio's own files into the folder, and
  // a "start" gathered after them is a picture of the template, not of the night's before.
  // (A project on the studio template has nothing to lose that way, and pays no second pass.)
  let startEvidence = ownShape ? await lookAtStart("iter_000_before") : null;
  const projectDir = await readyTheProject(night);
  const { liveHead, baseCommit, forkCommit } = await startingCommits(ctx, run, priorJournal);
  if (!startEvidence) startEvidence = await observeStart(night);
  // A night from scratch: the project is still the empty scaffold. Nothing can be judged against
  // it, no worker may fork from it, and the first thing this run owes the user is a starting
  // point (the base stage below). An own-shape project is never this: it has a project already.
  const fromScratch = !ownShape && startEvidence?.emptyScene === true;
  const integrationWorktree = await openIntegration(night, forkCommit);
  const memoryFile = path.join(integrationWorktree, ".studio", "DIRECTOR.md");
  await restoreMemory(night, integrationWorktree, memoryRestored ? priorMemory : null);
  // The user's project may carry its own git repositories (a nested repo is a bare pointer in the
  // studio's history and empty in a worktree until the studio copies it in).
  const nestedRepos = forkCommit ? await gitlinks(ctx, { project: run.project }, forkCommit) : [];
  const facts: NightFacts = {
    run,
    threadId,
    projectDir,
    shape,
    ownShape,
    baseCommit,
    forkCommit,
    integrationWorktree,
    fromScratch,
    startEvidence,
    priorJournal,
    softDeadline,
    finalDeadline,
  };
  Object.assign(night, {
    inbox,
    started,
    finalDeadline,
    softDeadline,
    clock,
    priorJournal,
    memoryRestored,
    ownShape,
    shape,
    capacity,
    contractMissing,
    appKind,
    priorLedger,
    projectLessons,
    report,
    projectDir,
    baseCommit,
    forkCommit,
    integrationWorktree,
    memoryFile,
    nestedRepos,
    state: nightState(facts),
    journal: nightJournal(facts),
    /** The start as this session first saw it, before a contract or a base stage replaced it on `state`. */
    startEvidence,
    /** This studio has windows of its own to lend; without them the live view is the only one there is. */
    pooledWindows: capacity?.headless !== false,
    ...nightCounters(),
  } satisfies NightKnown);
  // What the journal kept of the night before the pause, read back before this night writes a line.
  restoreNight(night);
  outcomesAwaitPlan(night);
  await saveJournal();
  // The starting point was observed before the worktree existed; it is the live folder's state,
  // which on a resume is still the commit the night began on.
  rememberEvidence(liveHead, startEvidence);
  return night;
}

/** One look at the live project folder, as the run's "before". Null unless it can be observed. */
export async function lookAtStart(night: Night, labelPrefix?: string) {
  const { ctx, run } = night;
  try {
    await ctx.call(HostMethod.PreviewLoad, { project: run.project });
    const evidence = await gatherEvidence(ctx, {
      run,
      iterationId: "000",
      labelPrefix,
      seed: PAGE_SEED,
      eyes: true,
      motion: 0,
      audio: false,
    });
    return evidence?.ok === true ? evidence : null;
  } catch {
    return null;
  }
}

// ── the sessions that prepare the night ──

/** What one preparation session is: its brief, its clock, and how its frames and failure are named. */
interface PreparationSession {
  prompt: string;
  timeoutMs: number;
  facetId: string;
  label: string;
  unfinished: string;
}

/**
 * One builder session in the run's own integration worktree — never the folder the user sees.
 * A session that dies of the engine's limit leaves the limit on the night, for the close to
 * weigh. Answers whether it finished and, if not, why.
 */
async function prepareInWorktree(
  night: Night,
  session: PreparationSession,
): Promise<{ ok: boolean; error: string | null }> {
  const { ctx, integrationWorktree, run, state, threadId } = night;
  try {
    const delegation = await ctx.call(HostMethod.EngineDelegate, {
      engine: roleEngine(run, RoleKey.Builder),
      prompt: session.prompt,
      project: run.project,
      cwd: integrationWorktree,
      threadId,
      ...(run.model ? { model: run.model } : {}),
      ...(roleEffort(run, RoleKey.Builder) ? { effort: roleEffort(run, RoleKey.Builder) } : {}),
      timeoutMs: session.timeoutMs,
      selfCapture: {
        project: run.project,
        root: integrationWorktree,
        runId: run.runId,
        facetId: session.facetId,
        iteration: 0,
        ...(run.setup ? { setup: run.setup } : {}),
        label: session.label,
      },
    });
    const ok = delegation.ok === true;
    return { ok, error: ok ? null : delegation.errorText || delegation.stopReason || session.unfinished };
  } catch (err: any) {
    if (isEngineLimit(err?.kind)) state.limit = engineLimitOf(err);
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/** What the session left uncommitted in the integration worktree ("" when nothing). */
function worktreeChanges(night: Night, label: string): Promise<string> {
  const { ctx, integrationWorktree } = night;
  return gitAt(ctx, integrationWorktree, GIT.status, { label }).catch(() => "");
}

/** The session's work, committed: answers the new head. */
async function commitPreparation(night: Night, message: string, labels: { commit: string; head: string }) {
  const { ctx, integrationWorktree } = night;
  await commitAll(ctx, integrationWorktree, message, { label: labels.commit });
  return headOf(ctx, integrationWorktree, { label: labels.head });
}

/**
 * A committed preparation becomes the night's start: what workers fork from, what "start" means
 * to a judge, the console it is forgiven (the user's own project already logs what it logs; nobody
 * in this run introduced those), and the head the ref protects. A base stage's commit is one of
 * the run's own starting points as well.
 */
async function adoptAsStart(night: Night, commit: string, evidence: Evidence, { base }: { base: boolean }) {
  const { errorsLogged, journal, protectHead, rememberEvidence, state } = night;
  state.integrationHead = commit;
  if (base) state.baseHeads.add(commit);
  state.healthByHead.set(commit, true);
  state.consoleByHead.set(commit, errorsLogged(evidence));
  state.startConsole = errorsLogged(evidence);
  state.startEvidence = evidence;
  rememberEvidence(commit, evidence);
  journal.director.integrationHead = commit;
  await protectHead(commit);
}

/**
 * Nothing half-written is left for a builder to fork from, whichever way the step ended: the
 * lead is told to do it by hand instead, and a worktree with somebody's abandoned edits would
 * fail every gate silently.
 */
async function resetUnfinished(night: Night, commit: string | null, changed: string, label: string) {
  const { ctx, integrationWorktree } = night;
  if (commit || !changed) return;
  await resetClean(ctx, integrationWorktree, "HEAD", { label }).catch(() => {});
}

/**
 * A second opinion, before a whole session is spent on wiring (M4.2b). `readiness.contract`
 * is a judgement about SOURCES; `project.attached` loads the served page and reports what the
 * studio actually managed to attach to on it. A page the studio can attach to on its own
 * needs no wiring session at all — and a page that does need one is only wired once the same
 * call says so.
 */
export async function pageAttaches(night: Night) {
  const { ctx, run } = night;
  const report = await ctx.call(HostMethod.ProjectAttached, { project: run.project }).catch(() => null);
  return report?.ok === true && report.contract !== AttachedContract.None;
}

// ── make it judgeable ──

/** Why the wiring left no commit, when the session itself finished. */
function contractFailure(changed: string, evidence: Evidence | null, attachedNow: boolean): string {
  if (!changed) return "the session changed nothing";
  const problems = (evidence?.problems ?? []).join("; ");
  if (problems) return problems;
  return attachedNow
    ? "the page installs the contract but the evidence pass could not read it"
    : "the page still does not load the contract";
}

/** The wiring's outcome, said twice: in the night's log, and on a decision card. */
async function sayContract(night: Night, commit: string | null, error: string | null) {
  const { decision, note, shape } = night;
  note(
    commit
      ? `the studio contract is wired and committed (${shortSha(commit)}) — this is the run's "before"`
      : `the studio contract could not be wired in: ${error}`,
  );
  await decision(
    commit
      ? `the studio contract is wired into ${shape?.main ?? "the entry"} and committed (${shortSha(commit)}); it is the run's starting point and what \`judge against=start\` compares with`
      : `the studio contract could not be wired in (${error}): the director must do it by hand before any worker can start`,
    commit
      ? "your project is connected to the studio now, so this build's work can be compared with the project you had"
      : "the studio could not add its connection to your project, so the lead is doing it by hand before any builder starts",
  );
}

/**
 * The first step of a night on a project the user brought that never loads the studio contract
 * (M2.6). Without it the run is blind: `window.__studio` is missing, so every evidence pass
 * reports a build that does not run, the fork gate refuses every builder, and `judge
 * against=start` can only answer "the other build could not be observed" — which is what the
 * first real night on somebody's own project actually did, while its lead spent the opening hour
 * hand-wiring the contract itself.
 *
 * One session, with the base builder's own-shape wording (`contractBrief`), in the run's own
 * integration worktree — never the folder the user sees, which stays untouched until finish.
 * Verified the only way that counts: a full evidence pass, which cannot succeed unless the
 * page really does install the contract. Then one commit, and that commit becomes the run's
 * "before": from here `judge against=start` compares two builds that can both be looked at.
 */
export async function installContract(night: Night) {
  const { ctx, decision, journal, note, pageAttaches, patientEvidence, run, saveJournal, shape, shotsOf } = night;
  const { softDeadline, withLease, writeVerdict, integrationWorktree } = night;
  ctx.setStatus(`run ${run.runId} · making the project judgeable`);
  // The sources said nothing installs the contract. If the running page says otherwise, the
  // night keeps its hour: nothing is wired, nothing is committed, and the brief says so.
  if (await pageAttaches()) {
    journal.contract = { commit: null, ok: true, attached: true, error: null };
    note("the studio attaches to this project's page on its own — no wiring session was needed");
    await saveJournal();
    return journal.contract;
  }
  await decision(
    `this project's page never loads the studio contract: wiring it into ${shape?.main ?? "the entry"} in the integration worktree before anything is planned`,
    "your project doesn't have the studio's connection yet, so the studio is adding it before anything else",
  );
  const session = await prepareInWorktree(night, {
    prompt: contractBrief({ run, projectLabel: run.project, shape }),
    // A wiring job is minutes of work, not a stage of the night: it never eats the session.
    timeoutMs: Math.max(MIN_DELEGATE_TIMEOUT_MS, Math.min(CONTRACT_SESSION_MAX_MS, softDeadline - Date.now())),
    facetId: "contract",
    label: "the studio contract",
    unfinished: "the session did not finish",
  });
  const changed = await worktreeChanges(night, `director:${run.runId}:contract`);
  // The proof is the project answering, not the session saying it wired it: an evidence pass
  // drives window.__studio, so it cannot pass on a page that never installed it. No scaffold
  // exemption — this is somebody's real project, and it drew something before the studio arrived.
  const wired = session.ok && Boolean(changed);
  const attachedNow = wired ? await pageAttaches() : false;
  const evidence = wired
    ? await withLease(
        WindowLease.Contract,
        async (handle: string | null) => patientEvidence(integrationWorktree, { handle, label: "contract", motion: 0 }),
        { borrow: true },
      )
    : null;
  let commit = null;
  let error = session.error;
  if (evidence?.ok) {
    commit = await commitPreparation(night, "studio: install contract", {
      commit: `director:${run.runId}:contract-commit`,
      head: `director:${run.runId}:contract-head`,
    });
    // The run's "before" is the project the user brought plus the studio's connection, and
    // nothing else — the fairest comparison a night on somebody's own project can have.
    await adoptAsStart(night, commit, evidence, { base: false });
  } else if (session.ok) error = contractFailure(changed, evidence, attachedNow);
  await resetUnfinished(night, commit, changed, `director:${run.runId}:contract-reset`);
  journal.contract = { commit, ok: Boolean(commit), error: commit ? null : error };
  await saveJournal();
  await writeVerdict("director/contract/verdict.json", {
    commit,
    ok: journal.contract.ok,
    error: journal.contract.error,
    problems: evidence?.problems ?? [],
    warnings: evidence?.warnings ?? [],
    consoleErrors: evidence?.consoleErrors ?? [],
    shots: shotsOf(evidence),
  });
  await sayContract(night, commit, error);
  ctx.setStatus(`run ${run.runId} · director`);
  return journal.contract;
}

// ── the starting point ──

/** The base session's brief: the builder's own base brief, held to the preparation budget. */
function startingPointPrompt(night: Night, budget: number): string {
  const { ownShape, run, shape } = night;
  const brief = baseBrief({
    run,
    plan: { facets: [], integrationNotes: "" },
    projectLabel: run.project,
    shape,
    ownShape,
    setup: run.setup ?? null,
  });
  return `${brief}\n\n${preparationBudgetNote(Math.max(1, Math.floor(budget / MINUTE_MS)))}`;
}

/** Why the base stage left no commit, when its session itself finished. */
function startingPointFailure(changed: string, evidence: Evidence | null): string {
  if (!changed) return "the base session changed nothing";
  return (evidence?.problems ?? []).join("; ") || "the starting point did not load";
}

/** The base stage's outcome: on the thread, in the night's log, and on a decision card. */
async function sayStartingPoint(night: Night, commit: string | null, error: string | null) {
  const { appendRun, decision, journal, note } = night;
  await appendRun(RunEvent.AutopilotBase, {
    ok: journal.base.ok,
    commit,
    error: journal.base.error,
    empty: journal.base.empty,
  });
  note(
    commit
      ? `the starting point is committed (${shortSha(commit)})`
      : `the starting point could not be built: ${error}`,
  );
  await decision(
    commit
      ? `the starting point is built and committed (${shortSha(commit)})${journal.base.empty ? " — an empty world with working cameras; the workers fill it" : ""}`
      : `the starting point could not be built (${error}): the director starts on the empty scaffold and must make it run itself before any worker can`,
    commit
      ? `the starting point is ready${journal.base.empty ? " — an empty world the builders will fill" : ""}`
      : "the starting point could not be built, so the lead makes the project run itself before any builder starts",
  );
}

/**
 * A new project is an empty scaffold: no camera can photograph it, the fork gate refuses every
 * worker forked from it, and every judge answers "renders effectively black". The classic
 * pipeline always built a shared base before the facets forked; a director's night gets the
 * same stage — one builder session in the run's own integration worktree, one look allowed to
 * accept blank pixels, one commit — so its first worker forks from something that runs and
 * its first judge has something to look at. (The first director night spent twelve minutes
 * with the director writing the world by hand, unjudged, because no worker could start.)
 */
export async function buildStartingPoint(night: Night) {
  const { appendRun, consoleInheritedBy, ctx, decision, journal, patientEvidence, run, saveJournal } = night;
  const { shotsOf, softDeadline, withLease, writeVerdict, integrationWorktree } = night;
  const budget = preparationBudgetMs(softDeadline - Date.now());
  if (!budget) return null; // The lead uses the remaining time directly.
  await appendRun(RunEvent.AutopilotBaseStarted, {});
  ctx.setStatus(`run ${run.runId} · building the starting point`);
  await decision(
    "this project is an empty project: building the starting point every worker forks from, before the director's session opens",
    "this project is empty, so the studio is building the starting point first",
  );
  const session = await prepareInWorktree(night, {
    prompt: startingPointPrompt(night, budget),
    timeoutMs: budget,
    facetId: "base",
    label: "the starting point",
    unfinished: "the base session did not finish",
  });
  const changed = await worktreeChanges(night, `director:${run.runId}:base`);
  // The base's own look: the one pass allowed to accept blank pixels — an empty world with
  // working cameras IS a starting point — and never allowed to accept one that does not load.
  const evidence =
    session.ok && changed
      ? await withLease(
          WindowLease.Base,
          async (handle: string | null) =>
            patientEvidence(integrationWorktree, {
              handle,
              label: "base",
              motion: 0,
              scaffold: true,
              inheritedConsole: consoleInheritedBy(),
            }),
          { borrow: true },
        )
      : null;
  let commit = null;
  let error = session.error;
  if (evidence?.ok) {
    commit = await commitPreparation(night, `director ${run.runId}: the starting point`, {
      commit: `director:${run.runId}:base-commit`,
      head: `director:${run.runId}:base-head`,
    });
    // The night starts here now: this is what workers fork from and what "start" means.
    await adoptAsStart(night, commit, evidence, { base: true });
  } else if (session.ok) error = startingPointFailure(changed, evidence);
  // A session that timed out mid-file used to leave its edits in the worktree while the brief
  // said the director stood on the empty scaffold, and then `integrate` and `playtest` both
  // refused it for uncommitted work.
  await resetUnfinished(night, commit, changed, `director:${run.runId}:base-reset`);
  journal.base = { commit, ok: Boolean(commit), empty: evidence?.emptyScene === true, error: commit ? null : error };
  await saveJournal();
  await writeVerdict("director/base/verdict.json", {
    commit,
    ok: journal.base.ok,
    empty: journal.base.empty,
    error: journal.base.error,
    problems: evidence?.problems ?? [],
    warnings: evidence?.warnings ?? [],
    consoleErrors: evidence?.consoleErrors ?? [],
    shots: shotsOf(evidence),
  });
  await sayStartingPoint(night, commit, error);
  ctx.setStatus(`run ${run.runId} · director`);
  return journal.base;
}
