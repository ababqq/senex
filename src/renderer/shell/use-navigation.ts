import { useCallback, useMemo } from "react";
import { useThreads } from "../state/hooks.ts";
import type { Studio } from "../state/studio.ts";
import { returnTarget, Room, roomOf, studioThreadOf } from "../state/threads.ts";
import { withViewTransition } from "../ui/view-transition.ts";
import type { ComposerHandoff } from "./use-composer-handoff.ts";
import type { ShellChrome } from "./use-shell-chrome.ts";

/** Leaving home or going back to it is one animated change; anything else switches at once. */
const fromHome = (app: Studio) => (select: () => void) => {
  if (roomOf(app.threads.getState()) === Room.Home) withViewTransition(select);
  else select();
};

/** Moving between conversations and projects: each closes Plugins and the drawer on the way. */
export function useNavigation(app: Studio, chrome: ShellChrome, handoff: ComposerHandoff) {
  const { setPluginsOpen, setDrawerOpen, closeOverlays } = chrome;
  const studioThread = useThreads(studioThreadOf);
  const selectThread = useCallback(
    (threadId: string) => {
      fromHome(app)(() => {
        setPluginsOpen(false);
        app.selectThread(threadId);
      });
      setDrawerOpen(false);
    },
    [app, setPluginsOpen, setDrawerOpen],
  );
  /** Home: no conversation open, and the composer that starts a new project. */
  const goHome = useCallback(() => {
    const atHome = roomOf(app.threads.getState()) === Room.Home;
    const go = () => {
      setPluginsOpen(false);
      app.goHome();
    };
    if (atHome) go();
    else withViewTransition(go);
    setDrawerOpen(false);
  }, [app, setPluginsOpen, setDrawerOpen]);
  const enterStudio = useCallback(() => {
    if (studioThread) selectThread(studioThread.id);
  }, [studioThread, selectThread]);
  const { focusWhenOpen, focusOnly } = handoff;
  const enterProject = useCallback(
    (name: string, focusComposer = false): Promise<void> => {
      setPluginsOpen(false);
      return app.enterProject(name, { open: fromHome(app) }).then((record) => {
        if (!record) return;
        if (focusComposer) focusWhenOpen(record.id);
        setDrawerOpen(false);
      });
    },
    [app, setPluginsOpen, setDrawerOpen, focusWhenOpen],
  );
  /** Back to the project chat last open, else the first project; `focusComposer` puts the cursor in it. */
  const returnToProject = useCallback(
    (focusComposer = false) => {
      const { projects } = app.library.getState();
      const target = returnTarget(app.threads.getState(), projects);
      if (!target) {
        if (projects[0]) void enterProject(projects[0].name, focusComposer);
        return;
      }
      if (focusComposer) focusOnly(target);
      selectThread(target);
    },
    [app, selectThread, enterProject, focusOnly],
  );
  const selectProject = useCallback((name: string) => enterProject(name), [enterProject]);
  const removeProject = useCallback(
    async (name: string) => {
      if (await app.removeProject(name)) closeOverlays();
    },
    [app, closeOverlays],
  );
  /** New project is home, the wordmark's room, with the cursor in its composer (already there or not). */
  const newProject = useCallback(() => {
    goHome();
    requestAnimationFrame(() => handoff.homeComposer.current?.focus());
  }, [goHome, handoff.homeComposer]);
  return useMemo(
    () => ({
      selectThread,
      enterStudio,
      returnToProject,
      enterProject,
      selectProject,
      removeProject,
      newProject,
      goHome,
    }),
    [selectThread, enterStudio, returnToProject, enterProject, selectProject, removeProject, newProject, goHome],
  );
}

/** The navigation the shell's hooks and parts share. */
export type Navigation = ReturnType<typeof useNavigation>;
