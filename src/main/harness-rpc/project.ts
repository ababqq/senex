/** Harness RPC: projects and their assets — list, scaffold, read, write, validate, covers, export. */
import { workspaceContentStamp, workspaceContentStamps } from "../../substrate/workspace-content.ts";
import path from "node:path";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { ensureDir, realpathNearest, writeFileNoFollow } from "../../substrate/fsx.ts";
import { isImageFile, studioContractGeneration, type Project } from "../../substrate/project-workspace.ts";
import { ThreadKind } from "../../shared/event-log.ts";
import type { AttachReport } from "../../shared/project-folder.ts";
import {
  HostMethod,
  type HarnessHostHandlers,
  type HarnessParams,
  type HarnessResult,
} from "../../shared/harness-api.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { describeUnknownImage, sniffImage } from "../../substrate/image-sniff.ts";
import { git } from "../../substrate/snapshots.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { attachReport, noAttachment, str } from "../core/page-report.ts";
import { isBelow, throughClaudeFolder, throughGitFolder } from "../../substrate/paths.ts";

/** The largest image `project.read` hands back. */
const MAX_IMAGE_READ_MB = 8;
const MAX_IMAGE_READ_BYTES = MAX_IMAGE_READ_MB * 1024 * 1024;

/** What the harness reads when a project call is refused. */
const MESSAGE = {
  invalidRunId: "Invalid run id",
  foreignWorkspace: "Integration workspace does not belong to this project",
  exportOutsideExports: (target: string) =>
    `refused: project.export writes only into the studio's exports folder: ${target}`,
  onlyBrowserProjects: "Only browser-project scaffolding is supported in this build.",
  imageTooLarge: (file: string) => `${file} is larger than ${MAX_IMAGE_READ_MB} MB`,
  imageNotJudgeable: (file: string, what: string) =>
    `${file} is ${what}, which the judges cannot read — re-save it as JPEG or PNG`,
  claudeFolder: (file: string) =>
    `refused: ${file} is in the project's .claude folder, Claude Code's own settings, which only the person changes`,
  gitFolder: (file: string) => `refused: ${file} is in a .git folder, whose configuration and hooks the host controls`,
} as const;

/**
 * Harness-owned files that ride along with a contract upgrade: a project scaffolded before one of
 * them existed gets it. A project that predates the DOM contract keeps its old `hud.js`,
 * `materials.js`, `foliage.js` and `assets.js` as project code: the new `studio.js` imports none of
 * them, and the studio does not delete what a builder may still import.
 */
const CONTRACT_COMPANION_FILES = [
  // …the contract's own typings (M2.3): a TypeScript project whose build is `tsc -b &&
  // vite build` cannot import an untyped ./studio.js, so the declaration travels with it.
  "studio.d.ts",
];

/** The contract vintages that carry the canvas HUD and the eye cameras (see `studioContractGeneration`). */
const HUD_GENERATIONS: readonly number[] = [3, 4];

/** A run id an integration workspace is filed under: a plain slug, dots allowed. */
const RUN_ID = /^[a-z0-9][a-z0-9-_.]*$/i;

const readText = (file: string): Promise<string | null> => readFile(file, "utf8").catch(() => null);

/** A run's integration workspace, refused unless git has it registered as a worktree of this project. */
async function integrationWorkspace(core: StudioCore, project: string, runId: string): Promise<string> {
  if (!RUN_ID.test(runId)) throw new Error(MESSAGE.invalidRunId);
  await core.assertProjectAllowed(core.projects.dirFor(project));
  const workspace = await realpath(path.join(core.layout.scratch, "autopilot", runId, "integration"));
  // Git's registration ties this host-derived worktree to the authorized project.
  const listing = await git(core.projects.dirFor(project), ["worktree", "list", "--porcelain"]);
  if (!listing.split("\n").includes(`worktree ${workspace}`)) throw new Error(MESSAGE.foreignWorkspace);
  return workspace;
}

/**
 * Project settings and Git control files can execute hooks or filters in another host session.
 * The harness never writes either folder, by any spelling (case, `..`, links): check the named
 * path and its actual destination before creating directories or writing bytes.
 */
async function refuseProjectControlFolder(root: string, target: string, file: string): Promise<void> {
  const realRoot = await realpath(root).catch(() => path.resolve(root));
  const named = path.relative(path.resolve(root), path.resolve(target));
  const landing = path.relative(realRoot, await realpathNearest(target));
  if (throughClaudeFolder(named) || throughClaudeFolder(landing)) throw new Error(MESSAGE.claudeFolder(file));
  if (throughGitFolder(named) || throughGitFolder(landing)) throw new Error(MESSAGE.gitFolder(file));
}

/** TQ-1: the harness may name where inside the studio's exports folder, never elsewhere. */
async function assertExportTarget(core: StudioCore, target: string): Promise<void> {
  const real = await realpathNearest(target);
  const exportsRoot = await realpathNearest(core.layout.exports);
  if (!isBelow(exportsRoot, real)) throw new Error(MESSAGE.exportOutsideExports(target));
}

export function projectRpc(core: StudioCore, x: CoreInternals) {
  return {
    [HostMethod.AssetsInventory]: async (p) => {
      await core.assertProjectAllowed(core.projects.dirFor(p.project));
      return core.projectAssets(p.project);
    },
    [HostMethod.AssetsCheckpoint]: async (p) => {
      const workspace = await integrationWorkspace(core, p.project, p.runId);
      return core.assetCheckpoints.checkpoint(p.project, workspace, p.assetIds);
    },
    // — projects —
    [HostMethod.ProjectList]: async () => core.projects.list(),
    [HostMethod.ProjectSetCover]: async (p) => x.setProjectCover(p.project, p, p.threadId),
    // Harnesses installed before recipes still author custom GLSL covers through this.
    [HostMethod.ProjectSetCoverShader]: async (p) => x.setProjectCoverShader(p.project, p.surface, p.threadId),
    // `split` answers both stamps from one walk; a caller that does not ask gets the old string.
    [HostMethod.ProjectContentStamp]: async (p) =>
      p.split
        ? workspaceContentStamps(core.projects.dirFor(p.project))
        : workspaceContentStamp(core.projects.dirFor(p.project)),
    [HostMethod.ProjectRecents]: async () => core.projects.recents(),
    [HostMethod.ProjectScaffold]: async (p) => scaffold(core, x, p),
    // No `project.adopt` here (ARCH-1): adopting a folder widens the sandbox, so it is the user's
    // Open Project sheet's to do (`adoptProject`), never the agent-editable harness's.
    [HostMethod.ProjectValidate]: async (p) =>
      p.candidateId
        ? core.projects.validateAt((await core.candidates.get(p.candidateId, p.project)).root)
        : core.projects.validate(p.project),
    // The live half of the same question. `project.validate` reads the folder; this serves the
    // page, waits for it to boot and asks what the hook got hold of — so a night stops asking
    // for the two lines from a project the studio already attached to on its own. A HOST call,
    // made by the run for the director: no MCP tool and no bridge entry, so both engines see
    // exactly the tools they saw before.
    [HostMethod.ProjectAttached]: async (p) => attached(core, x, p),
    // v2 contract upgrade: a project whose studio.js predates
    // `inspect()` gets the shipped template's copy; the old file is kept beside it.
    [HostMethod.ProjectUpgradeContract]: async (p) => upgradeContract(core, p.project),
    [HostMethod.ProjectRead]: async (p) => {
      const target = p.candidateId
        ? await core.candidates.file(p.candidateId, p.project, p.file)
        : await x.delegation.projectFile(p.project, p.file, "read");
      if (isImageFile(target)) return readImage(target, p.file);
      return readFile(target, "utf8");
    },
    [HostMethod.ProjectWrite]: async (p) => {
      const target = p.candidateId
        ? await core.candidates.file(p.candidateId, p.project, p.file, true)
        : await x.delegation.projectFile(p.project, p.file, "write");
      const root = p.candidateId
        ? (await core.candidates.get(p.candidateId, p.project)).root
        : core.projects.dirFor(p.project);
      await refuseProjectControlFolder(root, target, p.file);
      await ensureDir(path.dirname(target));
      await writeFileNoFollow(target, p.contents);
      if (!p.candidateId) core.emit(UiEvent.ProjectChanged, { project: p.project, file: p.file });
      return { bytes: p.contents.length };
    },
    [HostMethod.ProjectTree]: async (p) =>
      p.candidateId ? core.candidates.tree(p.candidateId, p.project) : x.delegation.projectTree(p.project),
    [HostMethod.ProjectExport]: async (p) => {
      await x.assertHarnessRoot(p.project, null);
      if (p.target !== undefined && p.target !== null) await assertExportTarget(core, String(p.target));
      return core.projects.export(p.project, p.target ?? path.join(core.layout.exports, p.project), undefined, {
        secretValues: core.knownSecretValues(),
      });
    },
    // The stills in <project>/references/, sniffed and resized, for a run whose board is
    // empty (a resume, or a board attached in an earlier chat).
    [HostMethod.ProjectReferences]: async (p) => core.referenceStills(p.project, { max: p?.max, maxPx: p?.maxPx }),
  } satisfies Partial<HarnessHostHandlers>;
}

async function scaffold(
  core: StudioCore,
  x: CoreInternals,
  p: HarnessParams<typeof HostMethod.ProjectScaffold>,
): Promise<HarnessResult<typeof HostMethod.ProjectScaffold>> {
  if (p.kind && p.kind !== "studio-template") throw new Error(MESSAGE.onlyBrowserProjects);
  const project = await core.projects.scaffold(p.name, p.title ? { title: p.title } : {});
  await x.readyProject(project);
  // A brief sent from an unbound "new project" thread names that thread the moment the
  // folder exists — the chat and the project become one thing.
  if (p.threadId && p.threadId !== core.mainThread) {
    const record = await core.store.getRecord(p.threadId).catch(() => null);
    const meta = record?.metadata as { kind?: string; project?: string | null } | undefined;
    if (meta?.kind === ThreadKind.Project && !meta.project) await core.bindThreadToProject(p.threadId, project.name);
  }
  return project;
}

/** `project.attached`: serve the page in a window of its own and ask what the hook got hold of. */
async function attached(
  core: StudioCore,
  x: CoreInternals,
  p: HarnessParams<typeof HostMethod.ProjectAttached>,
): Promise<AttachReport> {
  const checked = await x.assertHarnessRoot(p.project, p.candidateId ? null : p.root);
  const root = p.candidateId ? (await core.candidates.get(p.candidateId, p.project)).root : checked;
  const session = x.previews.sessionPortFor({ label: `attach:${p.project}` });
  try {
    const port = await session.get();
    const loaded = await x.previews.loadServed(port, p.project, root, p.entry);
    const status = port.status();
    if (loaded.problem) return noAttachment(loaded.problem, status.loadError, status.consoleErrors);
    const answered = await (port.attachReport?.().catch(() => null) ?? Promise.resolve(null));
    const reported = answered && typeof answered === "object" ? (answered as unknown as Record<string, unknown>) : null;
    if (!reported) {
      return noAttachment(
        loaded.note ?? "this page reports nothing about the studio contract",
        status.loadError,
        status.consoleErrors,
      );
    }
    // The port's report is the page's own account of itself: read field by field, so a
    // page that answers a shape nobody expected cannot become this call's answer.
    const base = noAttachment(str(reported.reason) ?? loaded.note ?? null, status.loadError, status.consoleErrors);
    return attachReport(reported, base);
  } finally {
    await session.release();
  }
}

/** An image in the project, as the judges read it: the bytes decide the type. */
async function readImage(target: string, file: string) {
  const data = await readFile(target);
  if (data.length > MAX_IMAGE_READ_BYTES) throw new Error(MESSAGE.imageTooLarge(file));
  // The bytes decide the type, never the extension: an AVIF named .jpg is refused.
  const sniffed = sniffImage(data);
  if (!sniffed) throw new Error(MESSAGE.imageNotJudgeable(file, describeUnknownImage(data)));
  return {
    kind: "image" as const,
    mimeType: sniffed.mimeType,
    data: data.toString("base64"),
    bytes: data.length,
    file,
  };
}

async function upgradeContract(core: StudioCore, project: string): Promise<HarnessResult<"project.upgradeContract">> {
  const dir = core.projects.dirFor(project);
  const target = path.join(dir, "src", "studio.js");
  const current = await readText(target);
  // Which vintage the project holds, against which the shipped template is compared below.
  // Feature-sniffing decided this before and could not see past the file it was written
  // for: `inspect()` and `hud: hud.api` are in every copy since the one-screen contract,
  // so every project scaffolded before M4 answered "current" and kept its old contract while
  // the director and autopilot called this believing it brought the project up to date.
  const generation = studioContractGeneration(current);
  const materialsAdded = await addCompanionFiles(core, dir);
  await addContractPage(core, project, dir);
  const template = await readText(path.join(core.projects.templateDir, "src", "studio.js"));
  if (template === null) return { upgraded: false, reason: "no template studio.js" };
  // Only a copy older than the shipped one is replaced, so a project that already holds the
  // current contract is left alone and a template that ever moves backwards writes nothing. The
  // HUD vintages are left alone too: their builders call `__studio.hud` and `eye:*`, which the DOM
  // contract no longer carries, so replacing the file would break a project that works.
  if (generation >= studioContractGeneration(template) || HUD_GENERATIONS.includes(generation)) {
    return { upgraded: false, materialsAdded };
  }
  let backup: string | null = null;
  if (current !== null) {
    backup = `src/studio.v${generation}.js`;
    await writeFile(path.join(dir, backup), current);
  }
  await ensureDir(path.dirname(target));
  await writeFile(target, template);
  core.emit(UiEvent.ProjectChanged, { project, file: "src/studio.js" });
  return { upgraded: true, backup };
}

/** Copy each companion file the project lacks from the template; true when any was added. */
async function addCompanionFiles(core: StudioCore, dir: string): Promise<boolean> {
  let added = false;
  for (const file of CONTRACT_COMPANION_FILES) {
    const target = path.join(dir, "src", file);
    if (await readText(target)) continue;
    const source = await readText(path.join(core.projects.templateDir, "src", file));
    if (source === null) continue;
    await ensureDir(path.dirname(target));
    await writeFile(target, source);
    added = true;
  }
  return added;
}

/**
 * The contract page describes the studio's own empty project — "no build step, no package
 * manager, no network". A project the user brought is none of those things, and adoption
 * deliberately keeps that page out of their folder; a run must not put it back.
 */
async function addContractPage(core: StudioCore, project: string, dir: string): Promise<void> {
  const projects = await core.projects.list().catch(() => [] as Project[]);
  const own = projects.find((g) => g.name === project)?.built === true;
  const docsTarget = path.join(dir, "docs", "CONTRACT.md");
  if (own || (await readText(docsTarget))) return;
  const contract = await readText(path.join(core.projects.templateDir, "docs", "CONTRACT.md"));
  if (contract === null) return;
  await ensureDir(path.dirname(docsTarget));
  await writeFile(docsTarget, contract);
}
