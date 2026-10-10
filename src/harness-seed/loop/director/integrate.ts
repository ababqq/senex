import { goalDecision, GoalStatus } from "./goals.ts";
/**
 * Integration and the close: merging a worker's accepted commit into the integration branch
 * (with its health pass), and the one close both roads out of a night take — the director's own
 * `finish` and the harness's clock path — which lands the branch under one rule and writes the
 * report.
 */

import { GIT_TIMEOUT_MS } from "../config.ts";
import {
  commitAll,
  GIT,
  gitAt,
  gitlinks,
  headOf,
  isAncestor,
  LABEL_SHA_LENGTH,
  mergeNoFf,
  shortFailure,
  shortSha,
  unversionedNested,
} from "../git.ts";
import { HostMethod } from "../host-methods.ts";
import { Side } from "../judge.ts";
import { learningOn } from "../learning.ts";
import {
  closeRecord,
  flagRarelyMeasurable,
  learnedTonight,
  readLedger,
  saveProjectLessons,
  trimLedger,
} from "../ledger.ts";
import { unionMergeMain } from "../merge.ts";
import { skipOptimization } from "../optimization.ts";
import { EventKind, ExecutionStatus, JournalPhase, RunEvent, writeRunArtifact } from "../run-events.ts";
import { isCommit } from "../shell.ts";
import { CheckOrigin, loadCatalogue, recordCatalogueOutcomes, saveCatalogue } from "../spec.ts";
import { CLIP_DETAIL, CLIP_REASON } from "../text.ts";
import { minutes, SECOND_MS, sleep } from "../time.ts";
import { againstWords, NotLandedReason, observedFrom, VerdictPass, VerdictRule } from "../verdict.ts";
import { randomUUID } from "node:crypto";
import { slug, yes } from "./args.ts";
import { CLOSE_SETTLE_MS, timedWorkRemaining } from "./budgets.ts";
import { workerDigest } from "./digests.ts";
import { resolveByWorker, unresolvedOf } from "./conflict-worker.ts";
import { setAsideStrays } from "./lead-session.ts";
import { LEAD_DIRTY, LEAD_FIX_NEXT, LEAD_SET_ASIDE } from "./lead-session-prompts.ts";
import type { SetAside } from "./lead-session.ts";
import { BuildTarget, WindowLease } from "./night.ts";
import { LandingHow, landingWords } from "./rules.ts";
import type { LastJudge, Night, Worker } from "./night.ts";
import type { Evidence } from "../evidence.ts";
import type { AnyRecord, HarnessCtx } from "../../types/harness.d.ts";
import type { EventData } from "../../types/host-api.d.ts";

/**
 * This part serves a lead that is its chat's own session and writes nothing (one session): a night
 * seats one only when every part it depends on says so (lead-session.ts `servesLead`).
 */
export const SERVES_LEAD = true;

/** Which merge an `integration_merge` record is (the app's run graph reads it): never rename a value. */
const MergeStage = { Director: "director" } as const;

/** How many of a health pass's problems its card on the run's thread names. */
const HEALTH_CARD_PROBLEMS = 5;

/** Why `integrate` will not merge a worker, in the sentence the director reads. */
const INTEGRATE_REFUSAL = {
  noWorker: (id: unknown) => `no worker "${id}"`,
  noCommit: (id: string) => `worker ${id} has no commit yet`,
  notACommit: (id: string) => `worker ${id}'s last commit is not a commit hash`,
  nothingNew: (id: string, commit: string) =>
    `worker ${id} has committed nothing beyond what it forked from (${shortSha(commit)}) — nothing to integrate`,
  alreadyIn: (id: string, commit: string) =>
    `worker ${id}'s commit ${shortSha(commit)} is already on the integration branch`,
  checkpoint: (error: unknown) =>
    `Asset checkpoint needs attention: ${error}. Preserve local assets; do not move them out of the project or replace them with remote URLs.`,
  dirty:
    "Your integration worktree has unrelated uncommitted edits. Host-delivered assets have been checkpointed. Resolve those edits before integrating; keep director notes in .studio/DIRECTOR.md, which the host already persists. Never move or delete assets to clear this check.",
} as const;

/** Why a close the user stopped landed nothing: the words the chat reads a stopped run by. */
const STOPPED_BY_USER = "stopped by the user";
/** Tries at writing a night's close, and the wait between them: without it the night reads as running. */
const CLOSE_APPEND_ATTEMPTS = 3;
const CLOSE_APPEND_RETRY_MS = SECOND_MS;

/** What a close that landed nothing says, and the code the verdict reads it by. */
function notLanded(reason: string, why: NotLandedReason): AnyRecord {
  return { ok: false, reason, why };
}

/** The starting point is not a night's work: said when the branch has nothing beyond it. */
const NOTHING_BEYOND_THE_START = "the integration branch has nothing beyond the starting point";

/** At most this many paths are named in a sentence about them. */
const PATHS_NAMED = 8;
/** The fewest characters of the user's own words that stand for their message (`userQuoted`). */
const MIN_USER_QUOTE_CHARS = 8;

/**
 * A file name or git's own words in a reason, with brackets for parentheses: the clock's close
 * quotes the reason in parentheses, and the card strips that clause by them.
 */
function unbracketed(text: unknown): string {
  return String(text).replaceAll("(", "[").replaceAll(")", "]");
}

/** Paths as the close names them: the first few, and how many more. */
function named(paths: readonly string[]): string {
  const more = paths.length > PATHS_NAMED ? ` and ${paths.length - PATHS_NAMED} more` : "";
  return `${unbracketed(paths.slice(0, PATHS_NAMED).join(", "))}${more}`;
}

/** A porcelain status line's path: the new name of a rename, without the quotes git adds. */
function changedPath(line: string): string {
  const rest = line.slice(3).trim();
  const renamed = rest.indexOf(" -> ");
  return (renamed >= 0 ? rest.slice(renamed + 4) : rest).replace(/^"(.*)"$/, "$1");
}

/**
 * Did git refuse the merge over these uncommitted paths? Its refusal lists each file it would have
 * written over on a line of its own, in any language; an untracked folder is one porcelain path
 * (`test-results/`) for the files git lists inside it. A hook, a held index lock or a timeout names
 * none of them, and is no uncommitted change's doing.
 */
function refusedOver(paths: readonly string[], error: string): boolean {
  const listed = error.split("\n").map((line) => line.trim());
  return paths.some((changed) =>
    listed.some((file) => file === changed || (changed.endsWith("/") && file.startsWith(changed))),
  );
}

/**
 * The landing's words about the project folder, to the lead (its `finish` answer, `run_status`) and on
 * the night's log. The same rule as `named`: no parentheses.
 */
const LANDING_WORDS = {
  uncommitted: (paths: readonly string[], ref: string) =>
    `git would not land this build over what is uncommitted in the project folder — ${named(paths)}. No worker did this: your own commands there or the user may have, so leave it as it is — tell the user what, and that Make it live in Builds, or land_build in this chat, lands this build from ${ref} once it is kept or undone`,
  leftInProject: (paths: readonly string[]) =>
    `the project folder still has uncommitted changes the landing left as they were — ${named(paths)}; they are not part of this build`,
} as const;

/**
 * A look at the integration worktree that may not be skipped — a merge's health pass, the
 * close's last look: whether the build runs is not a question the night may leave open, so the
 * pass takes the user's window when there is nothing else (out loud, and gives it back).
 */
function lookAtIntegration(
  night: Night,
  {
    lease,
    label,
    scaffold,
    worker = null,
  }: { lease: WindowLease; label: string; scaffold?: boolean; worker?: Worker | null },
): Promise<Evidence> {
  const { consoleInheritedBy, integrationWorktree, patientEvidence, run, withLease } = night;
  return withLease(
    lease,
    async (handle: string | null) =>
      patientEvidence(integrationWorktree, {
        handle,
        label,
        motion: 0,
        setup: run.setup ?? null,
        scaffold,
        inheritedConsole: consoleInheritedBy(worker),
      }),
    { borrow: true },
  );
}

/**
 * What a look at a head found, where every later pass reads it: whether it loads, the console
 * errors it logs anyway (so the next pass over this head does not re-blame it), and its
 * `director/<label>/verdict.json`.
 */
async function recordHeadHealth(night: Night, head: string | null, label: string, health: Evidence): Promise<void> {
  const { errorsLogged, shotsOf, state, writeVerdict } = night;
  state.healthByHead.set(head, health.ok === true);
  state.consoleByHead.set(head, errorsLogged(health));
  await writeVerdict(`director/${label}/verdict.json`, {
    head,
    ok: health.ok === true,
    problems: health.problems ?? [],
    warnings: health.warnings ?? [],
    consoleErrors: health.consoleErrors ?? [],
    attempts: health.attempts ?? 1,
    shots: shotsOf(health),
  });
}

// ── integration ──

/** The commit `integrate` would merge for this worker — or why there is nothing to merge. */
async function resolveWorkerCommit(
  night: Night,
  worker: Worker,
): Promise<{ commit: string; refusal?: undefined } | { refusal: string }> {
  const { ctx, integrationWorktree, workerCommit } = night;
  const commit = await workerCommit(worker);
  if (!commit) return { refusal: INTEGRATE_REFUSAL.noCommit(worker.id) };
  if (!isCommit(commit)) return { refusal: INTEGRATE_REFUSAL.notACommit(worker.id) };
  if (commit === worker.from) return { refusal: INTEGRATE_REFUSAL.nothingNew(worker.id, commit) };
  if (await isAncestor(ctx, integrationWorktree, commit))
    return { refusal: INTEGRATE_REFUSAL.alreadyIn(worker.id, commit) };
  return { commit };
}

/** The integration worktree made ready for a merge: why it may not go ahead, and what was set aside for a lead. */
interface MergeReadiness {
  refusal: string | null;
  setAside: SetAside | null;
}

/**
 * The integration worktree, ready to take a merge: the host's delivered assets checkpointed, and
 * nothing else uncommitted in it. A director with its own hands clears what else is there itself;
 * for a lead, which writes nothing (one session), the studio sets it aside on a ref of the run
 * (lead-session.ts `setAsideStrays`) — so a project that builds in place never stops its merges.
 */
async function checkpointAssets(night: Night, label: string): Promise<MergeReadiness> {
  const { ctx, integrationWorktree, run } = night;
  try {
    await ctx.call(HostMethod.AssetsCheckpoint, { project: run.project, runId: run.runId });
  } catch (error: any) {
    return { refusal: INTEGRATE_REFUSAL.checkpoint(error?.message ?? error), setAside: null };
  }
  if (night.lead) return setAsideForLead(night, label);
  const dirty = await gitAt(ctx, integrationWorktree, GIT.status, { label }).catch(() => "");
  return { refusal: dirty ? INTEGRATE_REFUSAL.dirty : null, setAside: null };
}

/** What no worker made in a lead's integration worktree, set aside — or why it could not be. */
async function setAsideForLead(night: Night, label: string): Promise<MergeReadiness> {
  try {
    return { refusal: null, setAside: await setAsideStrays(night, label) };
  } catch (error: any) {
    return { refusal: LEAD_DIRTY(error?.message ?? error), setAside: null };
  }
}

/**
 * Merge the worker's commit into the integration worktree. A conflict on the FACET WIRING block
 * alone is union-merged; anything else is aborted and the conflicted files are named — for a
 * director to resolve by hand, or, when the lead writes nothing (one session), for a worker the
 * studio starts from the integration branch to resolve (conflict-worker.ts). On a clean merge the
 * new head is protected, journalled and put on the record.
 */
async function mergeWorker(
  night: Night,
  worker: Worker,
  commit: string,
  label: string,
): Promise<{ ok: true; union: boolean } | { ok: false; answer: string }> {
  const { appendRun, ctx, integrationWorktree, journal, note, ownShape, protectHead, run, shape, state } = night;
  const previousHead = state.integrationHead;
  const merge = await mergeNoFf(ctx, integrationWorktree, commit, {
    message: `director ${run.runId}: integrate ${worker.id}`,
    noEdit: true,
    label,
    rpcErrors: "fail",
    failure: shortFailure,
    listConflicts: true,
    resolve: () =>
      unionMergeMain(
        (command) =>
          ctx.call(HostMethod.RunExec, {
            command,
            cwd: integrationWorktree,
            timeoutMs: GIT_TIMEOUT_MS.quick,
            label: `${label}:union`,
          }),
        {
          message: `director ${run.runId}: integrate ${worker.id} (union on FACET WIRING)`,
          main: shape.main,
          wiring: !ownShape,
        },
      ),
  });
  if (!merge.ok) {
    await appendRun(RunEvent.IntegrationMerge, {
      facetId: worker.id,
      commit,
      conflict: true,
      stage: MergeStage.Director,
      error: String(merge.error).slice(0, CLIP_REASON),
    });
    note(`integrate ${worker.id}: conflict in ${merge.conflicts.join(", ") || "unknown files"}`);
    if (night.lead) return { ok: false, answer: await resolveByWorker(night, worker, commit, merge.conflicts) };
    return {
      ok: false,
      answer: JSON.stringify({
        merged: false,
        conflict: merge.conflicts,
        how: `run \`git merge ${commit}\` in your worktree, resolve keeping both sides' work, then commit (\`git add -A\`, then \`git commit\`); then judge integration`,
      }),
    };
  }
  state.integrationHead = await headOf(ctx, integrationWorktree, { label });
  journal.director.integrationHead = state.integrationHead;
  await protectHead(state.integrationHead);
  await appendRun(RunEvent.IntegrationMerge, {
    facetId: worker.id,
    commit,
    head: state.integrationHead,
    previousHead,
    operationId: randomUUID(),
    conflict: false,
    union: merge.union,
    stage: MergeStage.Director,
  });
  return { ok: true, union: merge.union };
}

/**
 * The health pass: does the integrated build run, on the requested state? The user's own project
 * may be a repository of its own inside the folder. When the studio was not allowed to version
 * it, this build carries none of the work done inside it — said on the health pass rather than
 * landing a build that silently contains nothing (2026-09-07). The build runs; it is empty, and
 * only `git ls-tree` can see that (a gitlink is a path git does not walk). Answers the look, and
 * whether the build started at all.
 */
async function healthPass(
  night: Night,
  worker: Worker,
  label: string,
): Promise<{ health: Evidence; started: boolean }> {
  const { nestedGit, nestedRepos, rememberEvidence, state } = night;
  const head = state.integrationHead;
  const healthLabel = `health_${shortSha(head, LABEL_SHA_LENGTH)}`;
  const health = await lookAtIntegration(night, { lease: WindowLease.Health, label: healthLabel, worker });
  const started = health.ok === true;
  const unversioned = await unversionedNested((command) => nestedGit(command, label), nestedRepos);
  if (unversioned.length) {
    health.problems = [
      ...(health.problems ?? []),
      `${unversioned.map((rel) => `${rel}/`).join(", ")} is the user's own repository and this build carries nothing from inside it — no edit there can be integrated or made live`,
    ];
    health.ok = false;
  }
  state.integrationHealthy = health.ok === true;
  rememberEvidence(head, health);
  await recordHeadHealth(night, head, healthLabel, health);
  return { health, started };
}

/**
 * The health pass on the record, next to the merge: does the merged build run? The studio offers
 * the user a build to look at mid-night only once something has confirmed that it does.
 */
async function recordHealth(night: Night, worker: Worker, health: Evidence, started: boolean): Promise<void> {
  const { appendRun, consoleInheritedBy, decision, note, recordVerdict, saveJournal, state } = night;
  const head = state.integrationHead;
  const problems = (health.problems ?? []).join("; ");
  await appendRun(RunEvent.IntegrationHealth, {
    head,
    ok: health.ok === true,
    problems: (health.problems ?? []).slice(0, HEALTH_CARD_PROBLEMS),
  });
  await recordVerdict({
    pass: VerdictPass.Health,
    head,
    worker: worker.id,
    ...observedFrom(health),
    consoleInherited: consoleInheritedBy(worker),
    kept: health.ok === true,
    rule: health.ok === true ? VerdictRule.Starts : VerdictRule.DoesNotStart,
  });
  await saveJournal();
  note(`integrated ${worker.id} → ${shortSha(head)}; health ${health.ok ? "ok" : `problems: ${problems}`}`);
  if (health.ok) return;
  await decision(
    `the integrated build ${shortSha(head)} did not pass its health pass: ${problems} — the director must fix it or judge it before it can land`,
    started
      ? "the merged build carries nothing from the folder inside your project that keeps its own history; what was built there cannot be made live"
      : "the merged build did not start when it was checked; the lead is fixing it before it can go live",
  );
}

/** What a build that does not run after a merge asks of the lead: its own repair, or a worker's (one session). */
function fixNext(night: Night): string {
  if (night.lead) return LEAD_FIX_NEXT;
  return "the integrated build does not run — fix it in your worktree (git log shows what came in) before anything else";
}

/** What `integrate` answers after a clean merge: the new head, its health, what was set aside, and what to do next. */
function integrationAnswer(night: Night, health: Evidence, union: boolean, setAside: SetAside | null): string {
  const { ledgerLines, shotsOf, state } = night;
  return JSON.stringify({
    merged: true,
    union,
    ...(setAside ? { setAside: LEAD_SET_ASIDE(setAside.ref, setAside.files) } : {}),
    head: shortSha(state.integrationHead),
    health: {
      ok: health.ok === true,
      problems: health.problems ?? [],
      warnings: health.warnings ?? [],
      requestedState: health.requestedState ?? null,
      shots: shotsOf(health),
    },
    // Defects a judge named for a worker that had already finished: nobody is building them,
    // so the integrated build is where they get fixed — by you, or by a new worker.
    ...(state.ledger.length ? { defectsNobodyOwns: ledgerLines() } : {}),
    next: health.ok ? "judge or look at integration before you build on it" : fixNext(night),
  });
}

export async function integrate(night: Night, args: AnyRecord) {
  const { run, state } = night;
  const worker = state.workers.get(slug(args.worker));
  if (!worker) return INTEGRATE_REFUSAL.noWorker(args.worker);
  const label = `director:${run.runId}:integrate:${worker.id}`;
  // A conflict worker that left markers has nothing to merge, whatever its worktree's HEAD says.
  const unresolved = unresolvedOf(worker);
  if (unresolved) return unresolved;
  const resolved = await resolveWorkerCommit(night, worker);
  if (resolved.refusal !== undefined) return resolved.refusal;
  const ready = await checkpointAssets(night, label);
  if (ready.refusal) return ready.refusal;
  const merged = await mergeWorker(night, worker, resolved.commit, label);
  if (!merged.ok) return merged.answer;
  const { health, started } = await healthPass(night, worker, label);
  await recordHealth(night, worker, health, started);
  return integrationAnswer(night, health, merged.union, ready.setAside);
}

// ── the close ──

/** Did a judge see `head` load? Such a judge passed it, whatever a later look races into. */
function judgeSawItLoad(judged: LastJudge | null, head: string | null): boolean {
  return Boolean(judged && judged.head === head && judged.ok);
}

/**
 * The close's judge of the build it is about to make live (tools.ts `judgeTheLanding`, beside the
 * judging it shares). A kept older tools.ts has none, and would ignore the bounds this judge needs,
 * so that close lands as it always did and says it did not judge.
 */
async function judgeForTheClose(night: Night, head: string | null): Promise<void> {
  const { judgeTheLanding, note } = night;
  if (typeof judgeTheLanding === "function") return judgeTheLanding(head);
  note(`the close did not judge ${shortSha(head)}: this workspace keeps an older tools.ts without the close's judge`);
}

/**
 * The close's own look at the head the worktree stands on, its judge of that head, and the landing
 * they earn. The judge's word counts only for the head it looked at — the same sha this close
 * observed. On a resume it may be last session's, kept in the journal.
 */
async function landWhatRuns(night: Night): Promise<AnyRecord> {
  const { baseCommit, ctx, decision, integrationRef, landIntegration, state, syncHead } = night;
  // Whatever the director committed last is the build this close is about — not the head
  // the last integrate happened to leave behind.
  const last = await syncHead();
  // The starting point alone is not a night's work: a run that only got its base built has
  // nothing beyond the starting point, and says so instead of landing an empty world. The
  // comparison is with the run's ORIGINAL base: a resumed session forks from last night's
  // head, and measuring against that hid every merge the first session had made.
  const moved = Boolean(last && last !== baseCommit && !state.baseHeads.has(last));
  if (!moved) return notLanded(NOTHING_BEYOND_THE_START, NotLandedReason.NothingNew);
  // A director's own uncommitted edits become a commit before anybody looks, so the build the
  // close looks at and judges is the very commit it lands.
  const uncommitted = await commitFinalEdits(night);
  if (uncommitted) return uncommitted;
  const head = await syncHead();
  const label = `close_${shortSha(head, LABEL_SHA_LENGTH)}`;
  const health = await lookAtIntegration(night, {
    lease: WindowLease.Close,
    label,
    scaffold: state.baseHeads.has(head),
  });
  await recordHeadHealth(night, head, label, health);
  const before = state.lastJudge;
  await judgeForTheClose(night, head);
  // A Stop pressed while the close looked or judged is obeyed: nothing is made live.
  if (ctx.cancelled) return notLanded(STOPPED_BY_USER, NotLandedReason.Stopped);
  // A judge that saw this head load still speaks for it when the close's own judge raced the load.
  if (judgeSawItLoad(before, head) && !judgeSawItLoad(state.lastJudge, head)) state.lastJudge = before;
  // The judge's look may carry the landing, but what the landing claims is the close's own look.
  state.healthByHead.set(head, health.ok === true);
  const judged = judgeSawItLoad(state.lastJudge, head);
  if (health.ok === true || judged) return landIntegration(true);
  await decision(
    `the integration branch ${shortSha(head)} did not load at the close (${(health.problems ?? []).join("; ")}) and no judge had passed it — kept unlanded on ${integrationRef}`,
    "this build did not start when it was checked at the end, so it was not made live — you can still open and use it",
  );
  return notLanded(
    "the integrated build did not load at the close and no judge had passed it",
    NotLandedReason.DoesNotRun,
  );
}

/**
 * ONE close (M4.10). Both roads out of a night end here — the director's own `finish` and the
 * harness's clock path — and they end the same way: stop the workers, wait for them, look at
 * the head the worktree actually stands on, and land under one rule.
 *
 * THE RULE: the branch moved beyond the starting point AND (it loaded just now OR a judge
 * passed it on this same sha). Before that rule is read the close judges the head itself
 * (tools.ts `judgeTheLanding`), so no build is made live that no judge looked at, however the night
 * ended; a Stop before or during the close lands nothing. `finish land=yes` used to skip the
 * fresh look entirely and land whatever HEAD happened to be — so a director could hand the user
 * a build that does not start, while the tool's own description has always promised "when it is
 * healthy". The clock path already looked; now they are the same code and there is one thing to
 * be right about.
 *
 * `because` is a function of the landing, but the ladder it reads is computed by the CALLER
 * and closed over: everything this close knows about why the night ended is known before it
 * starts, and a `Date.now()` read after a 90-second settle would have told a different story.
 */
export async function closeTheNight(
  night: Night,
  {
    land = true,
    stopWhy = "the build is over",
    settleMs = CLOSE_SETTLE_MS,
    because = null,
    summary = null,
    victory = false,
  }: {
    land?: boolean;
    stopWhy?: string;
    settleMs?: number;
    because?: string | ((landed: AnyRecord) => string) | null;
    summary?: string | null;
    victory?: boolean;
  },
): Promise<AnyRecord> {
  const { closeRun, ctx, report, runningWorkers, settleWorkers, stopWorker } = night;
  for (const worker of runningWorkers()) await stopWorker(worker, stopWhy, "finalization");
  await settleWorkers(settleMs);
  let landed: AnyRecord;
  if (ctx.cancelled) landed = notLanded(STOPPED_BY_USER, NotLandedReason.Stopped);
  else if (!land) landed = notLanded("land=no", NotLandedReason.NotAsked);
  else landed = await landWhatRuns(night);
  report.victory = victory === true && landed.ok === true;
  if (summary !== null) report.summary = summary;
  // A Stop is the night's reason whoever was closing it: the chat marks a stopped run by these words.
  if (landed.why === NotLandedReason.Stopped) report.stoppedBecause = STOPPED_BY_USER;
  else if (typeof because === "function") report.stoppedBecause = because(landed);
  else if (because) report.stoppedBecause = because;
  await closeRun(landed);
  return landed;
}

/** What `finish` tells the director once the run is closed. */
function finishAnswer(night: Night, landed: AnyRecord): string {
  const { state } = night;
  const end = "End your session now with a one-paragraph summary for the user";
  // The close judged the build after the lead's summary was written: what the landing may claim
  // is the lead's to pass on, and no more.
  const left = landed.leftInProject
    ? ` — ${LANDING_WORDS.leftInProject(landed.leftInProject)} — tell the user, and leave them as they are`
    : "";
  if (landed.ok)
    return `the run is closed — the integrated build ${shortSha(state.integrationHead)} is live in the project folder (${landed.line})${left}. ${end}; say what the landing may claim, in brackets above, and claim no more.`;
  const outcome = landed.reason ? ` — not landed: ${landed.reason}` : "";
  return `the run is closed${outcome}. ${end}.`;
}

/**
 * Did the user write `quote` in a message delivered into this run? The lead reads what they meant;
 * this only checks the words are theirs, as `plan`'s scope_instruction is checked (goals.ts).
 */
async function userQuoted(inbox: Night["inbox"], quote: unknown): Promise<boolean> {
  const words = typeof quote === "string" ? quote.trim() : "";
  if (words.length < MIN_USER_QUOTE_CHARS) return false;
  const said = await inbox.steering(undefined, false);
  return said.some((text) => text.includes(words));
}

/**
 * Close the run with the lead's summary. A timed build spends its working time: only the user ends
 * it early — Finish, or their own words in a message to this run, which the lead quotes as
 * `user_asked` (golden-boot-glory: "don't run the build" was refused for 159 minutes).
 */
export async function finish(night: Night, args: AnyRecord) {
  const { closeTheNight, ctx, inbox, run, softDeadline, state } = night;
  if (state.finish) return "finish is already under way";
  const summary = String(args.summary ?? "").trim();
  if (!summary) return "finish needs a summary for the user";
  const userEnds = (await inbox.finishing()) || (await userQuoted(inbox, args.user_asked));
  if (!ctx.cancelled && timedWorkRemaining(run, softDeadline, Date.now(), userEnds)) {
    return `finish refused: ${minutes(softDeadline - Date.now())} working minutes remain in this timed build. Call run_status, plan and delegate the next concrete improvement, then test and integrate it. Keep working until the wrap-up window; do not idle or repeat finish. Only the user ends it early: when they asked you in a message to stop or finish now, call finish again with user_asked quoting their words exactly.`;
  }
  const land = yes(args.land, true);
  const victory = yes(args.victory, false);
  if (victory && state.goals && goalDecision(state.goals, state.integrationHead) !== GoalStatus.Passed) {
    return "finish cannot claim victory: required acceptance is not verified on the integrated revision. Run playtest goal=<id>, or finish with victory=no and explain the gaps.";
  }
  state.finish = { summary, land, victory, at: Date.now() };
  ctx.setStatus(`run ${run.runId} · director finishing`);
  const landed = await closeTheNight({
    land,
    stopWhy: "the build is wrapping up",
    because: "the director finished the run",
    summary,
    victory,
  });
  return finishAnswer(night, landed);
}

/** What this run can honestly claim about the head it landed (`landingWords`, above). */
export function landingClaim(
  night: Night,
  head: string | null | undefined,
): { verified: boolean; how: LandingHow; line: string } {
  const { state } = night;
  return landingWords({
    judged: state.lastJudge && state.lastJudge.head === head ? state.lastJudge : null,
    healthPassed: state.healthByHead.get(head) === true,
  });
}

/**
 * A repository of the user's own inside the project folder, which the fork holds as files (the
 * consent the Open Project sheet recorded) while the folder itself still holds it as a pointer.
 * Landing that is not a merge — the folder's own `.git` is renamed aside and the fork's
 * conversion commit joined as a second parent (`versionNestedForLanding`) — and it is the one
 * place the studio touches somebody else's version history, so it belongs to the user's own
 * button, not to the night (decision 1, 2026-09-08). Git would refuse it here anyway, over
 * files it is not tracking; this says why in words the user can act on.
 */
async function nestedRefusal(night: Night): Promise<AnyRecord | null> {
  const { ctx, nestedGit, projectDir } = night;
  const pointers = await gitlinks(ctx, projectDir, "HEAD", { timeoutMs: GIT_TIMEOUT_MS.slow });
  if (!pointers.length) return null;
  const stillPointers = await unversionedNested((command) => nestedGit(command), pointers);
  const carried = pointers.filter((rel) => !stillPointers.includes(rel));
  if (!carried.length) return null;
  return notLanded(
    `${carried.map((rel) => `${rel}/`).join(", ")} is the user's own repository inside the project folder and this build holds it as ordinary files — the studio may not add it to the project's own history from here; the user can make this build live from the outcome card`,
    NotLandedReason.NestedNotVersioned,
  );
}

/**
 * The director's own last edits, committed for it — uncommitted work would be lost with the
 * worktree. A commit that fails lands nothing: the head without those edits is not the build
 * the director finished. Answers the refusal, or null once the head holds everything.
 */
async function commitFinalEdits(night: Night): Promise<AnyRecord | null> {
  const { ctx, integrationWorktree, protectHead, run, state } = night;
  const dirty = await gitAt(ctx, integrationWorktree, GIT.status).catch(() => "");
  if (!dirty) return null;
  const commitError = await commitAll(ctx, integrationWorktree, `director ${run.runId}: final edits`, {
    label: `director:${run.runId}:final-commit`,
  }).then(
    () => null,
    (err) => String(err?.message ?? err),
  );
  if (commitError !== null)
    return notLanded(
      `the director's last edits could not be committed: ${commitError.slice(0, CLIP_DETAIL)}`,
      NotLandedReason.FinalCommitFailed,
    );
  state.integrationHead = await headOf(ctx, integrationWorktree).catch(() => state.integrationHead);
  await protectHead(state.integrationHead);
  return null;
}

/** The item a merge under way in the project folder is named by among its uncommitted paths. */
const MERGE_UNDER_WAY = "a merge under way";

/**
 * What is uncommitted in the project folder as the landing meets it (`git status --porcelain`): each
 * path, and whether the folder is held — something staged or unmerged, or a merge of its own under
 * way even with nothing to show (`MERGE_HEAD`). Git merges into no held folder, and a failed
 * merge's `--abort` would undo that merge. A folder git cannot read answers nothing.
 */
async function projectFolderChanges(night: Night): Promise<{ paths: string[]; held: boolean }> {
  const { ctx, run } = night;
  const label = `director:${run.runId}:land-status`;
  const at = { project: run.project };
  const status = await gitAt(ctx, at, GIT.status, { label }).catch(() => "");
  const lines = status.split("\n").filter((line) => line.trim());
  const paths = lines.map(changedPath);
  let merging = false;
  try {
    merging = (await gitAt(ctx, at, GIT.catFileExists("MERGE_HEAD", ""), { label })).trim() === "yes";
  } catch {}
  return {
    paths: merging ? [MERGE_UNDER_WAY, ...paths] : paths,
    held: merging || lines.some((line) => line[0] !== " " && line[0] !== "?"),
  };
}

/**
 * Land the integrated build in the project folder: one `--no-ff` merge, aborted on a conflict, and
 * never forced. This used to answer a conflict with `git reset --hard` onto the run's head — the
 * night overwriting commits nobody asked it to touch. Now the build stays on its ref, the close
 * says why, and "Make it live" lands it once the folder can take it (studio-core `landBuild`, which
 * refuses a folder with uncommitted changes). Those changes may be the user's or a lead's own
 * commands' (it runs in the project folder), so they are named, never blamed on anyone — only when
 * git's refusal names them: a hook or a held lock is not theirs to answer for. A held folder
 * (`projectFolderChanges`) is not merged into at all.
 */
export async function landIntegration(night: Night, land: boolean): Promise<AnyRecord> {
  const { baseCommit, ctx, integrationRef, landingClaim, note, projectDir, report, run, state, syncHead } = night;
  if (!land) return notLanded("land=no", NotLandedReason.NotAsked);
  await syncHead();
  if (!isCommit(state.integrationHead) || state.integrationHead === baseCommit)
    return notLanded(NOTHING_BEYOND_THE_START, NotLandedReason.NothingNew);
  const nested = await nestedRefusal(night);
  if (nested) return nested;
  const uncommitted = await commitFinalEdits(night);
  if (uncommitted) return uncommitted;
  const changed = await projectFolderChanges(night);
  if (changed.held)
    return notLanded(LANDING_WORDS.uncommitted(changed.paths, integrationRef), NotLandedReason.UncommittedChanges);
  const merge = await mergeNoFf(ctx, { project: run.project }, state.integrationHead, {
    message: `director ${run.runId}: integrated build`,
    label: `director:${run.runId}:land`,
    listConflicts: true,
  });
  if (!merge.ok) {
    // Git refused to write over uncommitted changes, or the build conflicts with commits made in
    // the folder since the night began (the merge was aborted: its conflicts were listed first).
    if (!merge.conflicts.length && refusedOver(changed.paths, merge.error))
      return notLanded(LANDING_WORDS.uncommitted(changed.paths, integrationRef), NotLandedReason.UncommittedChanges);
    return notLanded(
      `merge into the live folder conflicted with changes of your own: ${unbracketed(merge.error.slice(0, CLIP_DETAIL))}`,
      NotLandedReason.CouldNotLand,
    );
  }
  report.landed = true;
  report.deliveredHead = await headOf(ctx, projectDir).catch(() => null);
  report.integrationHead = state.integrationHead;
  await ctx.call(HostMethod.PreviewLoad, { project: run.project }).catch(() => {});
  if (changed.paths.length) note(LANDING_WORDS.leftInProject(changed.paths));
  return {
    ok: true,
    ...landingClaim(state.integrationHead),
    ...(changed.paths.length ? { leftInProject: changed.paths } : {}),
  };
}

/**
 * What the project keeps from tonight: the lessons file the next night's briefs read, and the
 * check catalogue weighted by what could actually be measured. The catalogue side is what the
 * classic pipeline has always done at its close and the director never did — the lead's own
 * checks, with their thresholds, become reusable — plus the `rarelyMeasurable` flag, which is
 * how a check that has told nobody anything for three rounds stops being written again.
 */
export async function keepProjectLessons(night: Night) {
  const { ctx, priorLedger, run, state, tonight } = night;
  const records = await trimLedger(
    ctx.workspace,
    run.project,
    await readLedger(ctx.workspace, run.project).catch(() => []),
  ).catch(() => []);
  const all = records.length ? records : [...priorLedger, ...tonight];
  await saveProjectLessons(ctx.workspace, run.project, all).catch(() => {});
  const catalogue = await loadCatalogue(ctx.workspace).catch(() => null);
  if (!catalogue) return;
  for (const worker of state.workers.values()) {
    if (worker.spec && worker.result?.board)
      recordCatalogueOutcomes(catalogue, worker.spec, worker.result.board, CheckOrigin.Director, {
        runId: run.runId,
        genres: run.genres ?? [],
        kind: run.app?.kind ?? null,
      });
  }
  flagRarelyMeasurable(catalogue, all);
  await saveCatalogue(ctx.workspace, catalogue).catch(() => {});
}

/**
 * One line the morning card can read: what happened to the build, and whether anybody judged
 * it better than what the user had. "It loaded" is not "it is better".
 */
function landingResult(landed: AnyRecord): AnyRecord {
  const line = landed.line ?? (landed.ok ? "made live, not judged better" : "nothing was made live");
  return { ...landed, verified: landed.verified === true, how: landed.how ?? LandingHow.NotLanded, line };
}

/**
 * The night as one outcome, and then what the project's whole ledger now amounts to. This runs on
 * every close — finish, the clock, a limit, a quit, a crash — and never asks a model: writing
 * down what happened is a record, not a self-change, so no switch gates it. The sentence is the
 * close verdict's, which says *why* nothing was made live rather than repeating that nothing was.
 * What the next night learns from it is kept only while the user lets Studio improve itself.
 */
async function keepTheRecord(night: Night, landed: AnyRecord, because: string): Promise<void> {
  const { ctx, keepProjectLessons, ledgerFacts, remember, report, tonight } = night;
  await remember(closeRecord({ ...ledgerFacts(), landed: landed.ok === true, because }));
  await night.ledgerWrites;
  if (await learningOn(ctx)) {
    report.learned = learnedTonight(tonight);
    await keepProjectLessons();
  }
}

/** How a close describes the run: failed, paused (a resume picks it up) or completed. */
function executionStatusOf(report: AnyRecord, phase: string): ExecutionStatus {
  if (report.failure) return ExecutionStatus.Failed;
  if (phase === JournalPhase.Paused) return ExecutionStatus.Paused;
  return ExecutionStatus.Completed;
}

/** The close on the run's thread (`run_finished`, and `autopilot_paused` for a pause) and in its folder. */
async function announceClose(night: Night): Promise<void> {
  const { ctx, journal, report, run, threadId } = night;
  const paused = journal.phase === JournalPhase.Paused;
  await appendClose(ctx, threadId, [
    { type: EventKind.Custom, event_type: RunEvent.RunFinished, payload: report },
    ...(paused
      ? [
          {
            type: EventKind.Custom,
            event_type: RunEvent.AutopilotPaused,
            payload: { runId: run.runId, project: run.project },
          },
        ]
      : []),
  ]).catch(() => {});
  await writeRunArtifact(ctx, run.runId, "report.json", report);
}

/**
 * A night's close, written to its thread — tried again when the log refuses it: a `run_finished`
 * that is never written leaves the night running for good, with nothing to Resume (P19-F6).
 * Throws the last refusal.
 */
export async function appendClose(ctx: HarnessCtx, threadId: string, batch: EventData[]): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await ctx.call(HostMethod.EventsAppend, { threadId, batch });
      return;
    } catch (err) {
      if (attempt >= CLOSE_APPEND_ATTEMPTS) throw err;
      await sleep(CLOSE_APPEND_RETRY_MS);
    }
  }
}

export async function closeRun(night: Night, landed: AnyRecord): Promise<void> {
  const { baseCommit, ctx, integrationRef, journal, keepMemory, protectHead, recordVerdict, report, run, saveJournal } =
    night;
  const { state, threadId } = night;
  if (state.finished) return;
  state.finished = true;
  // The worktree goes in the teardown below; the memory file in it does not go with it.
  await keepMemory();
  report.integrationHead = state.integrationHead;
  report.baseCommit = baseCommit;
  report.integrationRef = integrationRef;
  // A resumed or reopened night adds to the record its earlier sessions closed with (setup.ts `nightReport`).
  const workers = Object.fromEntries([...state.workers.values()].map((w) => [w.id, workerDigest(w)]));
  report.workers = { ...report.workers, ...workers };
  report.notes = [...report.notes, ...(journal.director.notes ?? [])];
  report.landingResult = landingResult(landed);
  // The night's last verdict, in the same shape as every other: what became of the build, and
  // whether anybody preferred it. Emitted here rather than at each caller so a close by finish,
  // by the clock, by a limit, by a quit or by a crash all leave one.
  const closeVerdict = await recordVerdict({
    pass: VerdictPass.Close,
    head: state.integrationHead,
    against: landed.verified ? againstWords(BuildTarget.Live) : null,
    ok: state.healthByHead.get(state.integrationHead) ?? null,
    pick: landed.verified ? Side.Challenger : null,
    kept: landed.ok === true,
    rule: landed.ok ? VerdictRule.Landed : VerdictRule.NotLanded,
    landingLine: report.landingResult.line,
    notLanded: landed.why ?? null,
  });
  await keepTheRecord(night, landed, closeVerdict.because);
  if (state.limit)
    report.limit = {
      kind: state.limit.kind,
      message: String(state.limit.message ?? "").slice(0, CLIP_REASON),
      retryAfterMs: state.limit.retryAfterMs ?? null,
    };
  report.optimization = await skipOptimization(ctx, {
    threadId,
    run,
    reason: "Director runs finish without the optimization stage",
  }).catch(() => null);
  report.finishedAt = new Date().toISOString();
  // A run the user stopped, or one the engine's limit cut short, is paused: Resume picks it up
  // at its integration head (kept reachable by the ref) once the user or the limit allows.
  const pausedByStopOrLimit = !state.finish && (ctx.cancelled || Boolean(state.limit));
  const goalsBlocked = state.goals && goalDecision(state.goals, state.integrationHead) === GoalStatus.Blocked;
  journal.phase = pausedByStopOrLimit || goalsBlocked ? JournalPhase.Paused : JournalPhase.Done;
  report.executionStatus = executionStatusOf(report, journal.phase);
  journal.director.integrationHead = state.integrationHead;
  await protectHead(state.integrationHead);
  await saveJournal();
  await announceClose(night);
}
