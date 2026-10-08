/** The stage: the live preview's bounds and state, a run's builds, and the project's own build. */
import type { ProjectPreview } from "../preview.ts";
import type { StudioCore } from "../studio-core.ts";
import type { IpcHandle } from "./registrar.ts";

/** The last rectangle the renderer asked the native project view to take; the build smoke reads it. */
/** What the renderer reads when the stage has no project view to ask. */
const MESSAGE = {
  noProjectView: "the studio window has no project view",
  noProject: "a project name is required",
} as const;

export interface PreviewBoundsRecord {
  last: { x: number; y: number; width: number; height: number } | null;
}

export interface PreviewIpcDeps {
  core: StudioCore;
  /** The window's live preview; replaced when the window is. */
  preview(): ProjectPreview | null;
  previewBoundsSeen: PreviewBoundsRecord;
  /** The project's full screen (`project-full-screen.ts`); absent where there is no window to fill. */
  fullScreen?: { enter(): void; active(): boolean };
}

export function registerPreviewIpc(
  handle: IpcHandle,
  { core, preview, previewBoundsSeen, fullScreen }: PreviewIpcDeps,
): void {
  const livePreview = (): ProjectPreview => {
    const view = preview();
    if (!view) throw new Error(MESSAGE.noProjectView);
    return view;
  };
  handle("studio:preview.load", async (payload) => {
    await core.projects.touch(payload.project).catch(() => {});
    // Through the core, not the port: a project with its own build is built and served from its output.
    return core.loadPreview({ project: payload.project });
  });
  handle("studio:build.preview", async (payload) => core.buildPreview(payload));
  handle("studio:preview.screens", async () => core.agentScreens());
  handle("studio:run.still", async (payload) => core.readRunStill(payload?.file ?? "", payload?.maxPx));
  handle("studio:review.play", async (payload) => core.playProjectSnapshot(payload.snapshotId, payload.project));
  // A run's build, landed or not: play it from a worktree, or make it the live project folder.
  handle("studio:build.show", async (payload) => core.showBuild(payload.project, payload.commit));
  handle("studio:build.land", async (payload) => core.landBuild(payload.project, payload.commit));
  handle("studio:preview.bounds", async (payload) => {
    previewBoundsSeen.last = { x: payload.x, y: payload.y, width: payload.width, height: payload.height };
    // In full screen the project covers the window whatever the page under it measures; the slot is
    // placed again when full screen ends.
    if (fullScreen?.active()) return true;
    // Anything but a plain `false` counts as watching: Live then only offers a chat's show.
    await core.previewStageVisible(payload.width > 0 && payload.height > 0, payload.watching !== false);
    preview()?.setBounds(
      {
        x: Math.round(payload.x),
        y: Math.round(payload.y),
        width: Math.round(payload.width),
        height: Math.round(payload.height),
      },
      measuredViewport(payload.viewport),
    );
    return true;
  });
  handle("studio:preview.stop", async () => {
    await core.stopLive();
    return true;
  });
  handle("studio:preview.play", async () => {
    await core.playLive();
    return true;
  });
  handle("studio:preview.fullscreen", async () => {
    fullScreen?.enter();
    return true;
  });
  // Anything but a plain `false` leaves the sound on.
  handle("studio:preview.sound", async (payload) => {
    core.previewSound({ on: payload?.on !== false });
    return true;
  });
  handle("studio:preview.reload", async (payload) => {
    // The person's Reload: what waits for Live (`live.behind`) if anything does. `retry` is the
    // build-failure strip's own button: drop the memoised failure and build again.
    await core.reloadLive({ retry: payload?.retry === true });
    return true;
  });
  // What waits for Live's Reload and the build Live shows: the stage reads it on mount, so a
  // renderer that reloaded (or mounted after the event) still lights Reload.
  handle("studio:live.behind", async (payload) => {
    if (typeof payload?.project !== "string" || !payload.project) throw new Error(MESSAGE.noProject);
    return core.liveState(payload.project);
  });
  handle("studio:preview.state", async () => livePreview().studioState());
  handle("studio:preview.live", async () => livePreview().liveStatus());
  // Why the stage is not showing the project's own build, and the one button that opens the network.
  handle("studio:build.problem", async (payload) => core.buildProblem(payload.project));
  handle("studio:packages.install", async (payload) => core.installPackages(payload.project));
}

/** The window size a slot was measured in, when the renderer sent a usable one. */
function measuredViewport(viewport: { width: number; height: number } | undefined): Electron.Size | null {
  if (!viewport) return null;
  const usable = [viewport.width, viewport.height].every((n) => Number.isFinite(n) && n > 0);
  return usable ? { width: Math.round(viewport.width), height: Math.round(viewport.height) } : null;
}
