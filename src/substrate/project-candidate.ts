/** Host-owned optimizer worktrees. Failure never restores/reset-cleans the live project. */
import path from "node:path";
import { lstat, readdir, mkdir, readFile, writeFile, realpath, rm } from "node:fs/promises";
import { claudeFolderChanges, git, type SnapshotEngine } from "./snapshots.ts";
import { shortId } from "./ids.ts";
import type { OptimizationCandidate, Revision } from "../shared/optimization.ts";
import { isBelow, toPosixRelative } from "./paths.ts";

type Candidate = OptimizationCandidate;

/** The most files a candidate worktree may hold. */
const MAX_CANDIDATE_FILES = 20_000;
/** The largest diff a preservation review is asked to read. */
const MAX_REVIEWED_DIFF_CHARS = 120_000;

const MESSAGE = {
  InvalidRunId: "invalid run id",
  BaselineChanged: "baseline changed",
  InvalidCandidateId: "invalid candidate id",
  InvalidRegistration: "invalid candidate registration",
  InvalidBaseline: "invalid baseline identity",
  OtherProject: "candidate belongs to another project",
  Closed: "candidate is closed",
  Frozen: "candidate is frozen",
  EscapesSource: "candidate path escapes source",
  SymlinkPath: "candidate symlink is not allowed",
  RootChanged: "candidate root changed",
  ContainsSymlink: "candidate contains a symlink",
  TreeTooLarge: "candidate tree too large",
  DiffTooLarge: "candidate diff too large for preservation review",
  ChangedAfterFreeze: "candidate changed after freeze",
  UnregisteredRevision: "unregistered profile revision",
  SourceChanged: "measurement source changed",
  IdentityMismatch: "promotion identity mismatch",
  MissingValidation: "missing durable candidate validation",
  TreeMismatch: "promotion tree mismatch",
  LiveChanged: "Live project changed; candidate was not applied",
  ClaudeFolder: (files: string[]) =>
    `candidate changes the project's .claude folder (${files.join(", ")}), Claude Code's own settings; it was not applied`,
} as const;

/** Which tree the live project holds: the candidate's, the baseline's, or neither. Wire values. */
export const RetainedState = {
  Candidate: "candidate",
  Baseline: "baseline",
  Changed: "changed",
} as const;
export type RetainedState = (typeof RetainedState)[keyof typeof RetainedState];

/** How a promotion ended. Wire values: the harness reads them. */
export const PromotionOutcome = {
  Promoted: "promoted",
  BaselineChanged: "baseline_changed",
  Failed: "failed",
} as const;
export type PromotionOutcome = (typeof PromotionOutcome)[keyof typeof PromotionOutcome];

/** The preservation status a validation must report before its candidate is promoted. */
const PRESERVED = "preserved";

/** What `promote` reads from a durable validation artifact. */
interface ValidationRecord {
  runId?: unknown;
  candidate?: { tree?: unknown; commit?: unknown };
  preservation?: { status?: unknown };
  scenarios?: Array<{ comparison?: { comparable?: boolean; improved?: boolean } }>;
}

/** Ignored files that may vary outside the measured revision: studio metadata and notes. */
function isIgnorableMetadata(file: string): boolean {
  return file.startsWith(".studio/") || file.endsWith(".md") || file === ".DS_Store";
}

/** `a` and `b` name the same commit and tree. */
function sameRevision(a: Revision, b: Revision | null): boolean {
  return b !== null && a.commit === b.commit && a.tree === b.tree;
}

/** A path a candidate file request must never name: empty, absolute, or through `..` or `.git`. */
function isForbiddenRel(rel: string): boolean {
  if (!rel || path.isAbsolute(rel)) return true;
  return rel.split(/[\\/]/).some((part) => part === ".." || part === ".git");
}

/**
 * Whether a validation artifact vouches for promoting `verified` from run `runId`: it names that
 * candidate, preserved the project, compared every scenario and improved at least one.
 */
function vouchesFor(validation: ValidationRecord, runId: string, verified: Revision): boolean {
  const { candidate } = validation;
  const namesCandidate =
    validation.runId === runId && candidate?.tree === verified.tree && candidate?.commit === verified.commit;
  if (!namesCandidate || validation.preservation?.status !== PRESERVED) return false;
  const scenarios = validation.scenarios ?? [];
  if (!scenarios.length) return false;
  return scenarios.every((s) => s.comparison?.comparable) && scenarios.some((s) => s.comparison?.improved);
}

/** Which tree the live project holds now: the candidate's, the baseline's, or something else (or uncommitted work). */
function retainedState(
  revision: Revision,
  known: { dirty: boolean; baseline: Revision; candidate: Revision | null },
): RetainedState {
  if (known.dirty) return RetainedState.Changed;
  if (known.candidate && revision.tree === known.candidate.tree) return RetainedState.Candidate;
  if (revision.tree === known.baseline.tree) return RetainedState.Baseline;
  return RetainedState.Changed;
}

export class ProjectCandidates {
  #entries = new Map<string, Candidate>();
  readonly snapshots: SnapshotEngine;
  readonly scratch: string;
  constructor(snapshots: SnapshotEngine, scratch: string) {
    this.snapshots = snapshots;
    this.scratch = scratch;
  }
  async revision(project: string, snapshotId: string | null = null): Promise<Revision> {
    const dir = this.snapshots.dirFor(project);
    return {
      snapshotId,
      commit: (await git(dir, ["rev-parse", "HEAD"])).trim(),
      tree: (await git(dir, ["rev-parse", "HEAD^{tree}"])).trim(),
    };
  }
  async #dirty(dir: string): Promise<boolean> {
    if ((await git(dir, ["status", "--porcelain", "--untracked-files=all"])).trim()) return true;
    // Git-ignored playable files would evade immutable tree attribution. Metadata can be
    // ignored; a runtime dependency cannot quietly vary outside the measured revision.
    const ignored = (await git(dir, ["ls-files", "--others", "--ignored", "--exclude-standard"]))
      .split("\n")
      .filter(Boolean);
    return ignored.some((file) => !isIgnorableMetadata(file));
  }
  async open(project: string, runId: string, snapshotId: string, commit: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error(MESSAGE.InvalidRunId);
    const live = await this.revision(project, snapshotId);
    if (live.commit !== commit || (await this.#dirty(this.snapshots.dirFor(project))))
      throw new Error(MESSAGE.BaselineChanged);
    const candidateId = shortId("opt");
    const root = path.join(this.scratch, candidateId);
    const baselineRoot = path.join(this.scratch, `${candidateId}-baseline`);
    await mkdir(this.scratch, { recursive: true });
    await this.snapshots.worktreeAt(project, commit, root);
    try {
      await this.snapshots.worktreeAt(project, commit, baselineRoot);
    } catch (e) {
      await this.snapshots.removeWorktree(project, root);
      throw e;
    }
    const c: Candidate = {
      candidateId,
      project,
      runId,
      root,
      baselineRoot,
      baseline: live,
      frozen: null,
      closed: false,
    };
    this.#entries.set(candidateId, c);
    try {
      await this.tree(candidateId, project);
      await this.#save(c);
    } catch (e) {
      await this.snapshots.removeWorktree(project, root);
      await this.snapshots.removeWorktree(project, baselineRoot);
      this.#entries.delete(candidateId);
      throw e;
    }
    return { ...c };
  }
  async #save(c: Candidate) {
    await writeFile(path.join(this.scratch, `${c.candidateId}.json`), JSON.stringify(c));
  }
  async get(id: string, project?: string): Promise<Candidate> {
    if (!/^opt_[a-zA-Z0-9]+$/.test(id)) throw new Error(MESSAGE.InvalidCandidateId);
    let c = this.#entries.get(id);
    if (!c) {
      c = JSON.parse(await readFile(path.join(this.scratch, `${id}.json`), "utf8")) as Candidate;
      // Serialized paths are never authority. Reconstruct them and verify the registered git objects.
      const reconstructed =
        c.candidateId === id &&
        c.root === path.join(this.scratch, id) &&
        c.baselineRoot === path.join(this.scratch, `${id}-baseline`);
      if (!reconstructed) throw new Error(MESSAGE.InvalidRegistration);
      const dir = this.snapshots.dirFor(c.project);
      if ((await git(dir, ["rev-parse", `${c.baseline.commit}^{tree}`])).trim() !== c.baseline.tree)
        throw new Error(MESSAGE.InvalidBaseline);
      this.#entries.set(id, c);
    }
    if (project && c.project !== project) throw new Error(MESSAGE.OtherProject);
    if (c.closed) throw new Error(MESSAGE.Closed);
    return c;
  }
  async file(id: string, project: string, rel: string, write = false) {
    const c = await this.get(id, project);
    if (write && c.frozen) throw new Error(MESSAGE.Frozen);
    if (isForbiddenRel(rel)) throw new Error(MESSAGE.EscapesSource);
    const target = path.resolve(c.root, rel);
    if (!isBelow(c.root, target)) throw new Error(MESSAGE.EscapesSource);
    // Reject every symlink, including a directory symlink and a missing leaf below one.
    let walk = c.root;
    for (const part of path.relative(c.root, target).split(path.sep)) {
      walk = path.join(walk, part);
      const s = await lstat(walk).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
      if (s?.isSymbolicLink()) throw new Error(MESSAGE.SymlinkPath);
    }
    if ((await realpath(c.root)) !== path.join(await realpath(this.scratch), path.basename(c.root)))
      throw new Error(MESSAGE.RootChanged);
    return target;
  }
  async tree(id: string, project: string) {
    const c = await this.get(id, project);
    const files: string[] = [];
    const walk = async (dir: string) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.name === ".git") continue;
        if (e.isSymbolicLink()) throw new Error(MESSAGE.ContainsSymlink);
        if (e.isDirectory()) await walk(path.join(dir, e.name));
        else files.push(toPosixRelative(path.relative(c.root, path.join(dir, e.name))));
        if (files.length > MAX_CANDIDATE_FILES) throw new Error(MESSAGE.TreeTooLarge);
      }
    };
    await walk(c.root);
    return files;
  }
  async freeze(id: string) {
    const c = await this.get(id);
    if (c.frozen) {
      await this.assertFrozen(c);
      return { revision: c.frozen, ...(await this.diff(c, c.frozen)) };
    }
    await this.tree(id, c.project); // no source symlinks, including new files
    // The coordinator's transient brief must never become project content or an optimization diff.
    const brief = await git(c.root, ["show", `${c.baseline.commit}:.studio/BRIEF.md`]).catch(() => null);
    if (brief === null) await rm(path.join(c.root, ".studio/BRIEF.md"), { force: true });
    else await writeFile(path.join(c.root, ".studio/BRIEF.md"), brief);
    // Worker may commit; it may not change ancestry or another worktree's identity.
    await git(c.root, ["merge-base", "--is-ancestor", c.baseline.commit, "HEAD"]);
    await git(c.root, ["add", "-A"]);
    await git(c.root, ["commit", "-q", "--allow-empty", "-m", `optimization ${c.runId}: frozen candidate`]);
    c.frozen = {
      snapshotId: null,
      commit: (await git(c.root, ["rev-parse", "HEAD"])).trim(),
      tree: (await git(c.root, ["rev-parse", "HEAD^{tree}"])).trim(),
    };
    await git(c.root, ["update-ref", `refs/optimization/${id}`, c.frozen.commit]);
    await this.#save(c);
    return { revision: c.frozen, ...(await this.diff(c, c.frozen)) };
  }
  /** What the frozen commit changed against the baseline, for the preservation review. */
  async diff(c: Candidate, frozen: Revision) {
    const diff = await git(c.root, ["diff", "--no-ext-diff", c.baseline.commit, frozen.commit, "--"]);
    if (diff.length > MAX_REVIEWED_DIFF_CHARS) throw new Error(MESSAGE.DiffTooLarge);
    const changedFiles = (await git(c.root, ["diff", "--name-only", c.baseline.commit, frozen.commit, "--"]))
      .trim()
      .split("\n")
      .filter(Boolean);
    return { diff, changedFiles };
  }
  async assertFrozen(c: Candidate) {
    const frozen = c.frozen;
    if (!frozen) throw new Error(MESSAGE.ChangedAfterFreeze);
    const head = (await git(c.root, ["rev-parse", "HEAD"])).trim();
    if (head !== frozen.commit || (await this.#dirty(c.root))) throw new Error(MESSAGE.ChangedAfterFreeze);
  }
  async source(id: string, revision: Revision) {
    const c = await this.get(id);
    const candidate = sameRevision(revision, c.frozen);
    const baseline = sameRevision(revision, c.baseline);
    if (!candidate && !baseline) throw new Error(MESSAGE.UnregisteredRevision);
    if (candidate) await this.assertFrozen(c);
    const root = candidate ? c.root : c.baselineRoot;
    if ((await git(root, ["rev-parse", "HEAD^{tree}"])).trim() !== revision.tree || (await this.#dirty(root)))
      throw new Error(MESSAGE.SourceChanged);
    return { root, project: c.project, runId: c.runId };
  }
  async promote(id: string, expected: Revision, verified: Revision, validationArtifact: string) {
    const c = await this.get(id);
    await this.assertFrozen(c);
    const identified = sameRevision(expected, c.baseline) && sameRevision(verified, c.frozen);
    if (!identified) throw new Error(MESSAGE.IdentityMismatch);
    const validation = JSON.parse(await readFile(validationArtifact, "utf8")) as ValidationRecord;
    if (!vouchesFor(validation, c.runId, verified)) throw new Error(MESSAGE.MissingValidation);
    const dir = this.snapshots.dirFor(c.project);
    const live = await this.revision(c.project);
    if (!sameRevision(live, expected) || (await this.#dirty(dir)))
      return { outcome: PromotionOutcome.BaselineChanged, revision: live, reason: MESSAGE.LiveChanged };
    // Claude Code's project settings and hooks load into the person's own session in the project:
    // no candidate brings them, however it was validated.
    const settings = await claudeFolderChanges(dir, live.commit, verified.commit);
    if (settings.length)
      return { outcome: PromotionOutcome.Failed, revision: live, reason: MESSAGE.ClaudeFolder(settings) };
    try {
      // git checks local modifications itself. Never add a forced-reset fallback.
      await git(dir, ["-c", "core.hooksPath=/dev/null", "merge", "--ff-only", "--no-edit", verified.commit]);
      const retained = await this.revision(c.project);
      if (retained.tree !== verified.tree) throw new Error(MESSAGE.TreeMismatch);
      return { outcome: PromotionOutcome.Promoted, revision: retained, reason: null };
    } catch (e) {
      return { outcome: PromotionOutcome.Failed, revision: await this.revision(c.project), reason: String(e) };
    }
  }
  async reconcile(project: string, baseline: Revision, candidate: Revision | null) {
    const revision = await this.revision(project);
    const dirty = await this.#dirty(this.snapshots.dirFor(project));
    return { revision, retained: retainedState(revision, { dirty, baseline, candidate }) };
  }
  async close(id: string) {
    const c = await this.get(id).catch(() => null);
    if (!c) return { closed: true };
    if (!c.frozen) {
      // A discarded attempt remains addressable for diagnosis; it is never validation or
      // an adoption candidate. Do not let archival failure touch the baseline.
      await git(c.root, ["add", "-A"])
        .then(() => git(c.root, ["commit", "-q", "--allow-empty", "-m", `optimization ${c.runId}: discarded attempt`]))
        .then(() => git(c.root, ["update-ref", `refs/optimization/${id}-discarded`, "HEAD"]))
        .catch(() => {});
    }
    await this.snapshots.removeWorktree(c.project, c.root);
    await this.snapshots.removeWorktree(c.project, c.baselineRoot);
    c.closed = true;
    await this.#save(c);
    return { closed: true };
  }
}
