/** The project library: create, update (with its cover image), archive, remove, and what a project holds. */
import { nativeImage, shell } from "electron";
import { validateProjectCover } from "../../shared/project-library.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import type { RunSummaryReader } from "../run-summary-reader.ts";
import type { StudioCore } from "../studio-core.ts";
import type { IpcHandle } from "./registrar.ts";

/** The longest side a cover image may have, in pixels. */
const COVER_MAX_PX = 512;
/** The reference stills the Builds tab's prompt card shows: how many, and their long side in pixels. */
const PROMPT_CARD_STILLS = 6;
const PROMPT_CARD_STILL_PX = 640;

/** Why a project library request from the renderer is refused. */
const MESSAGE = {
  unreadableCover: "This image could not be read. Choose another image.",
  coverTooLarge: `Cover images must be at most ${COVER_MAX_PX} pixels across.`,
  projectRequired: "Project is required",
} as const;

export interface ProjectLibraryIpcDeps {
  core: StudioCore;
  runSummaryReader: RunSummaryReader;
  pushUiEvent(event: UiEvent): void;
}

export function registerProjectLibraryIpc(
  handle: IpcHandle,
  { core, runSummaryReader, pushUiEvent }: ProjectLibraryIpcDeps,
): void {
  // Archive = mark the chats (history is forever). Library folders go to Trash; a folder the
  // user opened from elsewhere stays on disk — closing a Cursor workspace does not delete it.
  handle("studio:project.archive", async (payload) => {
    const { dir, trash } = await core.archiveProject(payload.project);
    if (trash) await shell.trashItem(dir).catch(() => {});
    pushUiEvent({ type: UiEvent.ProjectChanged, payload: { project: payload.project } });
    return true;
  });

  // A chosen folder is the renderer's word for a path: the core checks it by its real path before
  // anything is written, as it does in `studio:project.location.pick`.
  handle("studio:project.create", async (payload) =>
    core.createProject(payload.title, {
      ...(payload.parent === undefined ? {} : { parent: payload.parent }),
      ...(payload.provisional === true ? { provisional: true } : {}),
    }),
  );
  // The request is the user's own words, read by their own model; the name only names a folder later.
  handle("studio:project.name", async (payload) => core.nameProject(payload));
  handle("studio:project.update", async (payload) => {
    const cover = payload.patch?.cover;
    if (cover?.kind === "image") {
      validateProjectCover(cover);
      const image = nativeImage.createFromDataURL(cover.dataUrl);
      if (image.isEmpty()) throw new Error(MESSAGE.unreadableCover);
      const size = image.getSize();
      if (size.width > COVER_MAX_PX || size.height > COVER_MAX_PX) throw new Error(MESSAGE.coverTooLarge);
      cover.dataUrl = image.toDataURL();
    }
    return core.updateProject(payload.project, payload.patch);
  });
  handle("studio:project.remove", async (payload) => core.removeProject(payload.project));
  handle("studio:projects", async () => core.projects.list());
  handle("studio:snapshots", async () => core.snapshotIndex.all());
  // The reference stills the user gave a project (`<project>/references/`), small, for the Builds tab's prompt card.
  handle("studio:project.references", async (payload) =>
    core.referenceStills(payload.project, { max: PROMPT_CARD_STILLS, maxPx: PROMPT_CARD_STILL_PX }),
  );
  // The Assets stage: what the project holds, joined with the project's own delivery ledger.
  handle("studio:project.asset.preview", async (payload) => core.previewProjectAsset(payload));
  handle("studio:project.asset.present", async (payload) => core.presentProjectAssets(payload));
  handle("studio:project.asset.rigs", async (payload) => core.projectModelRigs(payload));
  handle("studio:project.assets", async (payload) => {
    if (!payload || typeof payload.project !== "string") throw new Error(MESSAGE.projectRequired);
    const events = await runSummaryReader.forProject(payload.project, core.mainThread);
    return core.projectAssets(payload.project, events);
  });
  handle("studio:project.asset.still", async (payload) => core.readProjectAsset(payload));
}
