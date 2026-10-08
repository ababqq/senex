import type { RefObject } from "react";
import { useMemo } from "react";
import type { AppDialogs as Dialogs } from "../panels/AppDialogs.tsx";
import { useRailView } from "../state/hooks.ts";
import { railThreadIds } from "../state/threads.ts";
import type { PromptBarHandle } from "../ui/PromptBar.tsx";
import { useAppShortcuts } from "../use-app-shortcuts.ts";
import type { Navigation } from "./use-navigation.ts";
import type { ShellChrome } from "./use-shell-chrome.ts";

/** The app's keyboard, over the rail's order. */
export function useShellShortcuts(
  dialogs: Dialogs,
  chrome: ShellChrome,
  navigation: Navigation,
  composer: RefObject<PromptBarHandle | null>,
): void {
  const { records: threads, activeThreadId, projects } = useRailView();
  const railIds = useMemo(() => railThreadIds(threads, projects), [threads, projects]);
  useAppShortcuts({
    blocked: dialogs.state.picked !== null,
    search: () => dialogs.dispatch({ type: "search" }),
    toggleSidebar: chrome.toggleSidebar,
    closeDrawer: chrome.closeDrawer,
    newProject: navigation.newProject,
    returnToProject: navigation.returnToProject,
    enterStudio: navigation.enterStudio,
    focusComposer: () => composer.current?.focus(),
    stepRail: (step) => {
      const index = activeThreadId ? railIds.indexOf(activeThreadId) : -1;
      const target = railIds[Math.max(0, Math.min(railIds.length - 1, index + step))];
      if (target) navigation.selectThread(target);
    },
  });
}
