import type { GoalLedger } from "./goals.ts";
/**
 * The director's night as one explicit object, and the functions of it every part shares (the
 * plain helpers, which need no night, are in rules.ts).
 *
 * `runDirector` used to be a single 2,300-line function whose sixty closures shared its locals
 * by capture. The night is now a plain object (`prepareNight` in setup.ts builds it): the run,
 * its clock, the integration worktree, `state` (the workers, the heads, the log), the journal
 * and the report — and every function of the night takes it as its first argument. `bindNight`
 * puts each of them on the object as well, so a function can reach the others it calls through
 * the same object it reads its data from.
 *
 * The counters that change all night (`logSeq`, `waitSeq`, `ledgerWrites`, `memoryKept`,
 * `toolCalls`) live on the object and are read and written there, never copied out.
 */

import { GIT_TIMEOUT_MS, PAGE_SEED } from "../config.ts";
import { gatherEvidence, patientEvidence as lookPatiently, withLease as leaseWindow } from "../evidence.ts";
import { headOf, shortSha, updateRef } from "../git.ts";
import { HostMethod } from "../host-methods.ts";
import { appendLedger, rarelyMeasurable } from "../ledger.ts";
import { isRunning } from "../outcomes.ts";
import {
  appendRun as appendRunEvent,
  RunEvent,
  RunMode,
  saveJournal as saveRunJournal,
  writeRunArtifact,
} from "../run-events.ts";
import { isCommit } from "../shell.ts";
import { verdictRecord } from "../verdict.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { slug, withoutFrames } from "./args.ts";
import { medianMinutes } from "./budgets.ts";
import { journalText, recordNight } from "./journal.ts";
import { directorMemoryKeep } from "./memory.ts";
import { plainly } from "./rules.ts";
import type { AnyRecord, HarnessCtx, Run } from "../../types/harness.d.ts";
import type { HarnessResult, ProjectShape } from "../../types/host-api.d.ts";
import type { Evidence, GatherOptions, Shot } from "../evidence.ts";
import type { LedgerRecord } from "../ledger.ts";
import type { EngineLimit } from "../outage.ts";
import type { WorkerMode, WorkerState } from "../outcomes.ts";
import type { RunInbox } from "../run-inbox.ts";
import type { FacetSpec } from "../spec.ts";
import type { RoundRecord } from "./digests.ts";
import type { NightClock, PriorWorker } from "./journal.ts";
import type { ConflictMerge } from "./conflict-worker.ts";
import type { LeadSeat } from "./lead-session.ts";
import type { ShelvedDefect } from "./rules.ts";
import type { NoteKind } from "./wake-schedule.ts";
import type * as integrateFunctions from "./integrate.ts";
import type * as nightFunctions from "./night.ts";
import type * as setupFunctions from "./setup.ts";
import type * as toolFunctions from "./tools.ts";
import type * as workerFunctions from "./workers.ts";

/**
 * This part serves a lead that is its chat's own session and writes nothing (one session): a night
 * seats one only when every part it depends on says so (lead-session.ts `servesLead`).
 */
export const SERVES_LEAD = true;

/**
 * One builder of the night: startWorker (workers.ts) makes the record (`newWorkerRecord`), opens
 * its worktree and its thread, and only then puts it on `state.workers`; its run fills the rest
 * in, and the journal keeps it.
 */
export interface Worker {
  id: string;
  /** Stable request outcome advanced by this worker. */
  goal?: string;
  title: string;
  mode: WorkerMode;
  brief: string;
  owns: string[];
  ownsMain: boolean;
  cameras: string[];
  identity: string[];
  setup: AnyRecord | null;
  /** The commit it forked from. */
  from: string | null;
  replaces: string | null;
  baseConsole: string[];
  worktree: string;
  handle: string | null;
  threadId: string;
  startedAt: number;
  endedAt: number | null;
  deadline: number;
  state: WorkerState;
  stopRequested: boolean;
  stopWhy: string | null;
  iterationsCap: number | undefined;
  steering: string[];
  iterations: RoundRecord[];
  roundMs: number[];
  lastIterationAt: number | null;
  monitor: AnyRecord | null;
  result: AnyRecord | null;
  lastCommit: string | null;
  /** The commit its last accepted round left, while it builds (`keepRound`): what the journal names. */
  lastAccepted?: string | null;
  summary: string;
  error: string | null;
  spec: FacetSpec | null;
  problems: string[];
  unsatisfiable: AnyRecord[];
  stateKeys: string[] | null;
  notVerified: string | null;
  rarelyMeasurable: AnyRecord[];
  policy: AnyRecord;
  policyOverrides: AnyRecord;
  loop: AnyRecord | null;
  settled: boolean;
  settle: Promise<unknown>;
  resolveSettle: () => void;
  /** Its run, once launched (`launchWorker`). */
  promise?: Promise<unknown>;
  /** The engine limit that ended its session, when one did (`noteWorkerLimit`). */
  limit?: AnyRecord;
  /** A conflict worker's merge (conflict-worker.ts): opened in its worktree before its session. */
  merging?: ConflictMerge | null;
}

/** The project's shape (`appAtStart`, setup.ts): the host's, or the template's page and entry when it names none. */
export type NightShape = Pick<ProjectShape, "entry" | "main" | "build"> & Partial<ProjectShape>;

/** A worker being started: its worktree and its thread are not open yet (`startWorker`). */
export type StartingWorker = Omit<Worker, "worktree" | "threadId"> & {
  worktree: string | null;
  threadId: string | null;
};

/** The last judge on the integration branch (see `nightState`). */
export interface LastJudge extends AnyRecord {
  head?: string | null;
  ok?: boolean;
  pick?: string | null;
  /** The vision judge's yes or no to the question asked, when one was. */
  answer?: boolean | null;
  boardAllPass?: boolean;
  /** The close's own judge of the build it made live (integrate.ts `judgeTheLanding`), not a lead's. */
  final?: boolean;
}

/** The workers' engine's limit, when the workers run on the other subscription (`noteWorkerLimit`). */
export interface WorkerLimit extends EngineLimit {
  engine: string;
  worker: string;
}

/** One line of the night's log (`note`). */
export interface NightLogEntry {
  at: number;
  seq: number;
  text: string;
  /** What it is about, when it was written outside the lead's own turn (wake-schedule.ts decides what wakes it). */
  kind?: NoteKind;
}

/** What a commit reported when last looked at (`rememberEvidence`): a worker's checks are dry-run against it. */
export interface HeadEvidence {
  state: AnyRecord;
  demoStates: AnyRecord | null;
  demos: string[] | null;
  cameras: string[];
}

/** The night's `state` (`nightState`, setup.ts): the workers, the heads, the log — everything that changes all night. */
export interface NightState {
  goals?: GoalLedger;
  run: Run;
  threadId: string;
  projectDir: string;
  shape: NightShape;
  ownShape: boolean;
  baseCommit: string | null;
  integrationWorktree: string;
  integrationHead: string | null;
  integrationHealthy: boolean | null;
  healthByHead: Map<string | null | undefined, boolean>;
  consoleByHead: Map<string | null | undefined, string[]>;
  evidenceByHead: Map<string | null | undefined, HeadEvidence>;
  baseHeads: Set<string | null | undefined>;
  fromScratch: boolean;
  startConsole: string[];
  lastJudge: LastJudge | null;
  limit: EngineLimit | null;
  workerLimit: WorkerLimit | null;
  workers: Map<string, Worker>;
  plan: AnyRecord | null;
  planReviewUntil: number | null;
  planSaidFrom: number;
  planGo: boolean;
  facetSpecs: FacetSpec[];
  ledger: ShelvedDefect[];
  monitor: Promise<unknown> | null;
  log: NightLogEntry[];
  finish: AnyRecord | null;
  finished: boolean;
  startEvidence: Evidence | null;
  judges: number;
  plays: number;
  softDeadline: number;
  finalDeadline: number;
}

/**
 * What the night knows (`prepareNight`, setup.ts): the run and its clock, the project's shape and
 * ledger, the starting point and the integration worktree, `state`, the journal and the report,
 * and the counters that change all night.
 */
export interface NightData {
  ctx: HarnessCtx;
  threadId: string;
  run: Run;
  resume: boolean;
  inbox: RunInbox;
  started: number;
  softDeadline: number;
  finalDeadline: number;
  /**
   * The night's own clock (journal.ts `nightClock`), which the journal keeps and a Resume goes on
   * with. A wrap-up that starts early moves `softDeadline`, never this. Absent on a night a kept
   * older setup.ts made.
   */
  clock?: NightClock;
  priorJournal: AnyRecord | null;
  /** The workers the journal named when this night resumed: from before the pause, none of them running (journal.ts). */
  priorWorkers?: PriorWorker[];
  memoryRestored: boolean;
  ownShape: boolean;
  shape: NightShape;
  capacity: HarnessResult<"preview.capacity"> | null;
  contractMissing: boolean;
  appKind: string;
  priorLedger: LedgerRecord[];
  projectLessons: string[];
  report: AnyRecord;
  projectDir: string;
  baseCommit: string | null;
  forkCommit: string | null;
  integrationWorktree: string;
  integrationRef: string;
  memoryFile: string;
  /** The last memory this session kept (`keepMemory`), so an unchanged file is not kept again. */
  memoryKept: string | null;
  nestedRepos: string[];
  state: NightState;
  journal: AnyRecord;
  startEvidence: Evidence | null;
  pooledWindows: boolean;
  logSeq: number;
  waitSeq: number;
  tonight: LedgerRecord[];
  ledgerWrites: Promise<unknown>;
  toolCalls: number;
  /**
   * The director's tool calls under way (tools.ts `handler`): a turn inside one is never cut short
   * for the chat (wake.ts), or the lead would never get the call's answer. Absent under a kept
   * tools.ts from before live chat.
   */
  toolsInFlight?: number;
  /**
   * The wake loop drives the lead's session (wake.ts sets it as it starts): the parts it calls
   * tell it to end its turn. Absent — the long turn, or a kept director.ts from before the wake
   * loop, whose run names no loop — they answer with the long turn's words.
   */
  waking?: boolean;
  /**
   * The lead rests between turns (wake.ts sets it): a round that lands then reaches the journal
   * with the wake it causes — or with the news the loop saves when that wake is held — not with a
   * save of its own (workers.ts `keepRound`).
   */
  resting?: boolean;
  /**
   * A waking night's lead (one session, lead-session.ts): its chat's own session, in the project
   * folder, writing nothing while the build runs — workers do, a conflict goes to a worker of its
   * own (conflict-worker.ts), and no `.studio/DIRECTOR.md` is kept. Absent — the long turn, a kept
   * older director.ts — the director works in the integration worktree with its own hands.
   */
  lead?: LeadSeat | null;
  /** The log's sequence number the journal's last save holds (`saveJournal`): news up to it is on the journal. */
  journaledSeq?: number;
  /** The journal as its last save wrote it (journal.ts `journalText`): a save that would write the same again is not made. */
  journalSaved?: string | null;
}

/** A function of the night as the night carries it: bound, so the night itself is already given. */
type Bound<F> = F extends (night: never, ...args: infer A) => infer R ? (...args: A) => R : never;
/** The names of a module's functions, as `bindNight` binds them (a constant such as `SERVES_LEAD` is not one). */
type FunctionKey<M> = { [K in keyof M]: M[K] extends (...args: never[]) => unknown ? K : never }[keyof M];
/** Every function of one of the director's modules, bound to the night (`bindNight`). */
type BoundModule<M> = { readonly [K in Exclude<FunctionKey<M>, "bindNight" | "prepareNight">]: Bound<M[K]> };

/**
 * The night: its data, and every function of the director's modules bound to it by bindNight,
 * so a function reaches the others it calls through the same object it reads its data from.
 */
export interface Night
  extends NightData,
    BoundModule<typeof nightFunctions>,
    BoundModule<typeof workerFunctions>,
    BoundModule<typeof toolFunctions>,
    BoundModule<typeof integrateFunctions>,
    BoundModule<typeof setupFunctions> {
  /**
   * Generic, so written out (`Bound` would fix its `T` to unknown). A pass that may borrow a
   * window always gets one, so only a pass that may not can be told there is none.
   */
  withLease<T>(label: WindowLease, fn: (handle: string | null) => Promise<T>, options: { borrow: true }): Promise<T>;
  withLease<T>(
    label: WindowLease,
    fn: (handle: string | null) => Promise<T>,
    options?: { borrow?: boolean },
  ): Promise<T | { noWindow: string }>;
}

/**
 * The window leases the lead's own passes take (evidence.ts `withLease`): the label a pool
 * window is acquired under. Never rename a value.
 */
export const WindowLease = {
  Base: "director-base",
  Contract: "director-contract",
  Health: "director-health",
  Close: "director-close",
  Judge: "director-judge",
  Playtest: "director-playtest",
} as const;
export type WindowLease = (typeof WindowLease)[keyof typeof WindowLease];

/**
 * The builds a director names by word rather than by worker id: the integration branch (its own
 * worktree) and the live folder the user sees. Worker ids may not take these names.
 */
export const BuildTarget = {
  Integration: "integration",
  Live: "live",
} as const;
export type BuildTarget = (typeof BuildTarget)[keyof typeof BuildTarget];

/** The part functions that make a night rather than act on one: never bound to it. */
const UNBOUND_FUNCTIONS = new Set(["bindNight", "prepareNight"]);

/** The night's log keeps this many lines; the waker and `wait` read them by sequence number, not by index. */
const MAX_NIGHT_LOG = 400;
/** The report keeps this many verdicts, the most recent. */
const MAX_REPORT_VERDICTS = 200;
/** How many times a pass looks at a build whose load raced the window (`patientEvidence`). */
const PATIENT_LOOKS = 3;

/** One custom event on the run's thread, stamped with the run (run-events.ts: a failed write is logged, never thrown). */
export function appendRun(night: Night, event_type: RunEvent, payload: AnyRecord): Promise<unknown> {
  const { ctx, run, threadId } = night;
  return appendRunEvent(ctx, threadId, event_type, payload, { runId: run.runId });
}

/**
 * A decision card. `text` (and `decision`, its older name) is the record — shas, worker ids,
 * the engine's own words. `plain` is the one sentence the chat shows someone who is not
 * reading git; every card the director writes carries one, because the first night's cards
 * reached the owner as `run_fixture123456`, `attempt/shine/3-stopped` and a rate-limit error.
 */
export function decision(night: Night, text: string, plain?: string | null): Promise<unknown> {
  const { appendRun } = night;
  return appendRun(RunEvent.AutopilotDecision, {
    decision: text,
    text,
    plain: plainly(plain ?? text),
    at: new Date().toISOString(),
  });
}

export async function protectHead(night: Night, head: string | null | undefined): Promise<void> {
  const { ctx, integrationRef, run } = night;
  if (!isCommit(head)) return;
  await updateRef(ctx, { project: run.project }, integrationRef, head, {
    label: `director:${run.runId}:protect`,
  }).catch(() => {});
}

export async function keepMemory(night: Night) {
  const { ctx, lead, memoryFile, note, run, threadId } = night;
  // A lead that is its chat's own session keeps no memory file: the journal and its digests carry the night.
  if (lead) return;
  const raw = await readFile(memoryFile, "utf8").catch(() => null);
  if (raw === null) return;
  // Clamped on the way out, so the artifact the next session restores from is already the
  // size a session can afford; the pre-clamp size is logged so the number can be set from
  // what nights actually write rather than from a guess — once per change, never once per
  // tool call (see directorMemoryKeep).
  const kept = directorMemoryKeep(raw, night.memoryKept);
  if (!kept.changed) return;
  if (kept.note) note(kept.note);
  const text = kept.text;
  night.memoryKept = text;
  await ctx
    .call(HostMethod.ArtifactWrite, {
      threadId,
      artifactId: `director_memory_${run.runId}`,
      value: { text, at: new Date().toISOString() },
    })
    .catch(() => {});
  await writeRunArtifact(ctx, run.runId, "director/DIRECTOR.md", text);
}

/**
 * Save the run's journal, with the night's record on it (journal.ts `recordNight`): what a Resume
 * goes on from. The store keeps every version it is given and a fork copies them all, so a save
 * that would write what the last one wrote (the count of worked time aside) is not made.
 */
export async function saveJournal(night: Night): Promise<number | void> {
  const { ctx, journal, run, threadId } = night;
  recordNight(night);
  const seq = night.logSeq;
  const text = journalText(journal);
  // Saves overlap (a round's, a wake's): the log a slower one holds is never taken for a newer one's.
  const heldUpTo = () => {
    night.journaledSeq = Math.max(night.journaledSeq ?? 0, seq);
  };
  if (text !== null && text === night.journalSaved) {
    heldUpTo();
    return;
  }
  night.journalSaved = text;
  const version = await saveRunJournal(ctx, threadId, run.runId, journal);
  if (version !== undefined) heldUpTo();
  // A write that failed is owed again by the next save, however little changed.
  else if (night.journalSaved === text) night.journalSaved = null;
  return version;
}

/**
 * What a commit reported, kept for the next worker's dry run. Every pass the harness makes
 * (the fork gate, a health pass, a judge) already gathers it; nothing extra is captured, and
 * a commit nobody has looked at simply has no entry.
 */
export function rememberEvidence(
  night: Night,
  commit: string | null | undefined,
  evidence: Evidence | null | undefined,
): void {
  const { state } = night;
  if (!commit || evidence?.ok !== true) return;
  if (!evidence.state || evidence.state.__missing) return;
  state.evidenceByHead.set(commit, {
    state: evidence.state,
    demoStates: evidence.demoStates ?? null,
    demos: Array.isArray(evidence.registeredDemos) ? evidence.registeredDemos : null,
    // `demo:x`, `eye:y` and `user:view` are the harness's own frames, not registered cameras.
    cameras: [
      ...new Set(
        (evidence.shots ?? [])
          .map((s: Shot) => s.camera)
          .filter((c: unknown) => typeof c === "string" && !c.includes(":")),
      ),
    ],
  });
}

/** git in the integration worktree for a question an empty answer settles (`unversionedNested`). */
export function nestedGit(night: Night, command: string, label?: string | null): Promise<string> {
  const { ctx, integrationWorktree } = night;
  return ctx
    .call(HostMethod.RunExec, {
      command,
      cwd: integrationWorktree,
      timeoutMs: GIT_TIMEOUT_MS.quick,
      ...(label ? { label } : {}),
    })
    .then((r: { stdout?: string }) => String(r.stdout ?? ""))
    .catch(() => "");
}

/**
 * A line in the night's log (`logSeq`, see prepareNight): what wakes a resting lead (wake.ts) and
 * what its next digest — or a `wait` — answers with. `kind` says what a line written outside the
 * lead's own turn is about; the waker decides by it, never by the words.
 */
export function note(night: Night, text: string, kind?: NoteKind): void {
  const { state } = night;
  night.logSeq += 1;
  state.log.push({ at: Date.now(), seq: night.logSeq, text, ...(kind ? { kind } : {}) });
  if (state.log.length > MAX_NIGHT_LOG) state.log.shift();
}

/** Every line the lead has not been told yet (the waker's digest or `wait`), including ones that arrived between. */
export function notesSince(night: Night, seq: number): NightLogEntry[] {
  const { state } = night;
  return state.log.filter((entry) => (entry.seq ?? 0) > seq);
}

/** What every ledger record of this night carries. */
export function ledgerFacts(night: Night) {
  const { appKind, run } = night;
  return { runId: run.runId, mode: RunMode.Director, project: run.project, appKind };
}

/**
 * An outcome on the project's own ledger, chained behind the last one so five rounds finishing in
 * the same second land as five lines, in order (`ledgerWrites`, see prepareNight).
 */
export function remember(night: Night, record: LedgerRecord): Promise<unknown> {
  const { ctx, run, tonight } = night;
  tonight.push(record);
  night.ledgerWrites = night.ledgerWrites.then(() => appendLedger(ctx.workspace, run.project, record)).catch(() => {});
  return night.ledgerWrites;
}

/** Checks this kind of project has never been able to measure — the dry run warns about them. */
export function neverMeasured(night: Night) {
  const { appKind, priorLedger, tonight } = night;
  return rarelyMeasurable([...priorLedger, ...tonight], { kind: appKind });
}

/** What the integration worktree actually stands on right now — the one source of truth. */
export function currentHead(night: Night) {
  const { ctx, integrationWorktree, run } = night;
  return headOf(ctx, integrationWorktree, { label: `director:${run.runId}:head` });
}

/**
 * The director edits in its worktree and commits with its own hands; `integrationHead` used
 * to move only on integrate, so a director commit made the judge, the health pass, the close
 * and the merge disagree about which build they were talking about (one night judged a fix
 * the close then left unreachable). Every tool call starts here: whatever HEAD says is the
 * integration head, it is protected by the ref, written to the journal, and named to the
 * director so it knows the studio saw what it did.
 */
export async function syncHead(night: Night) {
  const { appendRun, currentHead, journal, note, protectHead, saveJournal, state } = night;
  const head = await currentHead().catch(() => null);
  if (!head || head === state.integrationHead) return state.integrationHead;
  state.integrationHead = head;
  journal.director.integrationHead = head;
  await protectHead(head);
  await saveJournal();
  await appendRun(RunEvent.DirectorProgress, { head });
  note(`you committed ${shortSha(head)} — it is now the integration head`);
  return head;
}

export function resolveRoot(
  night: Night,
  target: unknown,
):
  | { root: string; label: string; worker?: Worker; error?: undefined }
  | { error: string; root?: undefined; label?: undefined; worker?: undefined } {
  const { integrationWorktree, projectDir, state } = night;
  const t = String(target ?? BuildTarget.Integration).trim() || BuildTarget.Integration;
  if (t === BuildTarget.Integration) return { root: integrationWorktree, label: BuildTarget.Integration };
  if (t === BuildTarget.Live) return { root: projectDir, label: BuildTarget.Live };
  const worker = state.workers.get(slug(t));
  if (worker?.worktree) return { root: worker.worktree, label: worker.id, worker };
  const besideTheRun = path.isAbsolute(t) && path.resolve(t).startsWith(path.dirname(integrationWorktree) + path.sep);
  if (besideTheRun) return { root: path.resolve(t), label: t };
  const started = [...state.workers.keys()].join(", ") || "none started";
  return {
    error: `no build called "${t}" — targets are integration, live, or a worker id (${started})`,
  };
}

/** The workers still running. */
export function runningWorkers(night: Night) {
  const { state } = night;
  return [...state.workers.values()].filter((w: Worker) => isRunning(w));
}

/** Every round this run has finished, whichever worker ran it. */
export function runRoundMs(night: Night) {
  const { state } = night;
  return [...state.workers.values()].flatMap((w: Worker) => w.roundMs ?? []);
}

export function runRoundMinutes(night: Night) {
  const { runRoundMs } = night;
  return medianMinutes(runRoundMs());
}

/** The same in milliseconds, for the loop's own start gate. */
export function medianRoundMs(night: Night) {
  const { runRoundMs } = night;
  const sorted = runRoundMs().sort((a: number, b: number) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

/** The run's ledger of defects nobody is building any more, oldest first, in words. */
export function ledgerLines(night: Night) {
  const { state } = night;
  return state.ledger.map(
    (d: AnyRecord) => `${d.text} — worker ${d.owner}'s, named while judging ${d.from}; nobody is building it`,
  );
}

/**
 * A window to look through (evidence.ts `withLease`): a judge or a playtest can wait and is told
 * no window is free; a pass that cannot be skipped looks through the studio's stand-in.
 */
export function withLease<T>(
  night: Night,
  label: WindowLease,
  fn: (handle: string | null) => Promise<T>,
  { borrow = false }: { borrow?: boolean } = {},
): Promise<T | { noWindow: string }> {
  const { ctx, pooledWindows } = night;
  return leaseWindow(ctx, label, fn, { borrow, pooled: pooledWindows });
}

/**
 * One look at a build. Two things every pass here needs and none of them had until now: the
 * console errors the build INHERITED (an error it did not introduce is not its fault — one
 * shader line in a base nobody owned cost four first-round iterations, every judge of a night
 * and its landing), and the base exemption for this run's own starting point (a scaffold is
 * allowed to be blank; a project is not).
 *
 * `scaffold` reaches gauntlet as its base pass — iterationId "base" is the stage's name
 * there, not this pass's label, and the frames still land under `director/<label>`.
 */
export async function evidenceOf(
  night: Night,
  root: string,
  {
    handle,
    label,
    cameras = null,
    setup,
    motion = 6,
    scaffold = false,
    inheritedConsole = [],
  }: {
    handle?: string | null;
    label: string;
    cameras?: string[] | null;
    setup?: AnyRecord | null;
    motion?: number;
    scaffold?: boolean;
    inheritedConsole?: string[];
  },
): Promise<Evidence> {
  const { ctx, run } = night;
  return gatherEvidence(ctx, {
    run,
    iterationId: scaffold ? "base" : label,
    seed: PAGE_SEED,
    ...(handle ? { handle } : {}),
    root,
    labelPrefix: `director/${label}`,
    cameras,
    eyes: true,
    motion,
    audio: true,
    maxDemos: Infinity,
    setup: setup === undefined ? run.setup : setup,
    scaffold,
    inheritedConsole,
  });
}

/** Every distinct console error a build logged — the baseline the next pass forgives, not the five a prompt shows. */
export function errorsLogged(_night: Night, evidence: Evidence | null | undefined): string[] {
  return evidence?.consoleBaseline ?? evidence?.consoleErrors ?? [];
}

/** What a build is not to blame for: the run's starting errors, plus a worker's own fork point's. */
export function consoleInheritedBy(night: Night, worker: Worker | null = null): string[] {
  const { state } = night;
  return [...new Set([...(state.startConsole ?? []), ...(worker?.baseConsole ?? [])])];
}

// A load that raced the window (no __studio yet, a capture before the first frame) is not a
// broken build: look again before saying so. Eight health passes in one night failed this way
// while the judge, forty seconds later, found every one of those builds fine (evidence.ts
// `loadRaced` decides what a race is).
export async function patientEvidence(
  night: Night,
  root: string,
  options: Omit<GatherOptions, "run"> & { label: string; [option: string]: unknown },
): Promise<Evidence> {
  const { ctx, evidenceOf, note } = night;
  const evidence = await lookPatiently(ctx, () => evidenceOf(root, options), {
    attempts: PATIENT_LOOKS,
    onRace: (raced: Evidence) =>
      note(`${options.label}: the window raced the load (${raced.problems[0]}) — looking again`),
  });
  // Only a patient look given no attempts comes back empty, and this one always has some.
  if (!evidence) throw new Error(`${options.label}: no look was taken`);
  return evidence;
}

export function writeVerdict(night: Night, name: string, value: unknown): Promise<unknown> {
  const { ctx, run } = night;
  return writeRunArtifact(ctx, run.runId, name, withoutFrames(value));
}

/**
 * Every build this night judges gets the same record, on the same event path as `director_worker`.
 * Before this, the lead's four passes wrote `verdict.json` files and in-memory notes that no
 * screen could read, so the app's build box showed boilerplate about a run instead of what the
 * last look at the build actually found.
 */
export async function recordVerdict(night: Night, fields: Parameters<typeof verdictRecord>[0]) {
  const { appendRun, report } = night;
  const record = verdictRecord(fields);
  report.verdicts.push(record);
  if (report.verdicts.length > MAX_REPORT_VERDICTS) report.verdicts.shift();
  await appendRun(RunEvent.DirectorVerdict, record);
  return record;
}

export function shotsOf(_night: Night, evidence: Evidence | null | undefined): AnyRecord[] {
  return (evidence?.shots ?? []).map((s: Shot) => ({
    camera: s.camera,
    path: s.path,
    ...(s.stats
      ? {
          litFraction: Number(s.stats.litFraction?.toFixed?.(2) ?? s.stats.litFraction),
          meanLuma: Math.round(s.stats.meanLuma ?? 0),
        }
      : {}),
  }));
}

/** A worker's last commit: the one its loop accepted, or whatever its worktree stands on. */
export async function workerCommit(night: Night, worker: Worker): Promise<string | null> {
  const { ctx } = night;
  if (worker.lastCommit) return worker.lastCommit;
  // A worker still building stands on whatever its round has just committed — an attempt the
  // judge may yet reject — so only what it accepted is its work until it ends (P10-F3): the
  // commit its last accepted round left (`lastAccepted`). Reading only `lastCommit`, which is
  // set when a worker ends, told the golden-goal night's lead "no commit yet" about three
  // workers with accepted rounds, and it merged every one of them by hand.
  if (isRunning(worker)) return worker.lastAccepted ?? null;
  if (!worker.worktree) return null;
  return headOf(ctx, worker.worktree).catch(() => null);
}

/**
 * Put every function of the night on the object, bound to it, so a function destructures the
 * ones it calls from the night it was handed. `modules` are the director's module namespaces.
 */
export function bindNight(
  data: Pick<NightData, "ctx" | "threadId" | "run" | "resume">,
  modules: ReadonlyArray<Record<string, unknown>>,
): Night {
  // The one place the night is assembled: its functions are attached here, and prepareNight
  // (setup.ts) assigns the rest of its data before any function reads it.
  const night = data as Night;
  const slots = night as unknown as Record<string, unknown>;
  for (const module of modules) {
    for (const [name, fn] of Object.entries(module)) {
      if (typeof fn !== "function" || UNBOUND_FUNCTIONS.has(name)) continue;
      slots[name] = (...args: unknown[]) => fn(night, ...args);
    }
  }
  return night;
}
