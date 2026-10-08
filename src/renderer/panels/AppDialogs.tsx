/**
 * Every dialog the app shell opens — the open-folder sheet, Settings, search, and a
 * project's rename, delete and cover — with their open state in one local reducer. Dialogs are UI,
 * not studio state: they live here, not in a store. App opens them through `useAppDialogs()`.
 */
import type { JSX, RefObject } from "react";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { adoptPickedFolder } from "../open-folder.ts";
import {
  isSettingsSection,
  OPEN_SETTINGS_EVENT,
  type SettingsRequest,
  SettingsSection,
} from "../settings-navigation.ts";
import { openedWords, type OpenChoice } from "../../shared/shape-words.ts";
import { useEngines, useLibrary, useThreads } from "../state/hooks.ts";
import { rootLabelChanged } from "../state/library.ts";
import { type Studio, studio } from "../state/studio.ts";
import { notifyProblem } from "../state/toasts.ts";
import type { FolderInspection, Project } from "../types.ts";
import { ProjectCoverDialog } from "./ProjectCoverDialog.tsx";
import { DeleteProjectDialog, RenameProjectDialog } from "./ProjectDialogs.tsx";
import { ProjectSearchDialog } from "./ProjectSearchDialog.tsx";
import { OpenProjectSheet } from "./OpenProjectSheet.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";

export interface DialogsState {
  searching: boolean;
  settingsOpen: boolean;
  /** The Settings section last shown; reopening Settings returns to it. */
  settingsSection: SettingsSection;
  project: { kind: "rename" | "delete" | "cover"; project: Project } | null;
  /** The picked folder, as it is on disk, while the open sheet asks what to do with it. */
  picked: FolderInspection | null;
  /** The sheet's answer is being carried out. */
  opening: boolean;
}

export type DialogAction =
  | { type: "search" | "close-search" | "close-settings" | "close-project" }
  | { type: "settings"; section?: SettingsSection }
  | { type: "section"; section: SettingsSection }
  | { type: "project"; kind: "rename" | "delete" | "cover"; project: Project }
  | { type: "picked"; inspection: FolderInspection }
  | { type: "dismiss-picked" }
  | { type: "opening"; opening: boolean }
  | { type: "opened" };

export const initialDialogs: DialogsState = {
  searching: false,
  settingsOpen: false,
  settingsSection: SettingsSection.Providers,
  project: null,
  picked: null,
  opening: false,
};

export function dialogsReducer(state: DialogsState, action: DialogAction): DialogsState {
  switch (action.type) {
    case "search":
      return { ...state, searching: true };
    case "close-search":
      return { ...state, searching: false };
    case "settings":
      return { ...state, settingsOpen: true, ...(action.section ? { settingsSection: action.section } : {}) };
    case "section":
      return { ...state, settingsSection: action.section };
    case "close-settings":
      return { ...state, settingsOpen: false };
    case "project":
      return { ...state, project: { kind: action.kind, project: action.project } };
    case "close-project":
      return { ...state, project: null };
    // Home's Open a folder… found a folder: the sheet takes over.
    case "picked":
      return { ...state, picked: action.inspection };
    // A sheet that is carrying out its answer cannot be dismissed under it.
    case "dismiss-picked":
      return state.opening ? state : { ...state, picked: null };
    case "opening":
      return { ...state, opening: action.opening };
    case "opened":
      return { ...state, picked: null };
  }
}

/** A Settings request names one of these sections; anything else opens Model Providers. */
const settingsSection = (section: unknown): SettingsSection =>
  isSettingsSection(section) ? section : SettingsSection.Providers;

export interface AppDialogs {
  state: DialogsState;
  dispatch: (action: DialogAction) => void;
  /** Where focus returns when Settings closes. */
  settingsReturnFocus: RefObject<HTMLElement | null>;
  openSettings(section?: SettingsSection, returnFocus?: HTMLElement | null): void;
}

/** The dialogs' state, plus the two ways into Settings from anywhere (the `openSettings` window event). */
export function useAppDialogs(): AppDialogs {
  const [state, dispatch] = useReducer(dialogsReducer, initialDialogs);
  const settingsReturnFocus = useRef<HTMLElement | null>(null);
  const openSettings = useCallback((section?: SettingsSection, returnFocus: HTMLElement | null = null) => {
    settingsReturnFocus.current = returnFocus;
    dispatch({ type: "settings", ...(section ? { section } : {}) });
  }, []);
  useEffect(() => {
    const open = (event: Event) => {
      const { section, returnFocus } = (event as CustomEvent<SettingsRequest>).detail ?? {};
      openSettings(settingsSection(section), returnFocus ?? null);
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, open);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, open);
  }, [openSettings]);
  return { state, dispatch, settingsReturnFocus, openSettings };
}

/** Carry out the open sheet's answer: adopt the folder and open the project. */
function openPickedFolder(
  app: Studio,
  { state, dispatch }: AppDialogs,
  choice: OpenChoice,
  onEnterProject: (name: string) => void,
): void {
  const { picked, opening } = state;
  if (!picked || opening) return;
  dispatch({ type: "opening", opening: true });
  void adoptPickedFolder(app.api, picked.dir, choice)
    .then((opened) => {
      dispatch({ type: "opened" });
      void app.library.refreshProjects();
      // A folder with a project of its own is told what the studio found and that it kept it.
      if (opened.built) app.notify(openedWords(opened.title, opened.shape));
      onEnterProject(opened.name);
    })
    .catch(notifyProblem(app.notify))
    .finally(() => dispatch({ type: "opening", opening: false }));
}

export function AppDialogs({
  dialogs,
  firstAsks,
  onEnterProject,
  onSelectThread,
  onSelectProject,
  onRemoveProject,
}: {
  dialogs: AppDialogs;
  firstAsks: Record<string, string>;
  /** Delete a project; App moves the room when the stage held it. */
  onRemoveProject: (name: string) => Promise<void>;
  /** Open a project (and, for a project just made, put the cursor in its composer). */
  onEnterProject: (name: string, focusComposer?: boolean) => void;
  onSelectThread: (threadId: string) => void;
  onSelectProject: (name: string) => void;
}): JSX.Element {
  const { state, dispatch } = dialogs;
  const projects = useLibrary((s) => s.projects);
  const rootLabel = useLibrary((s) => s.rootLabel);
  const threads = useThreads((s) => s.records);
  const engines = useEngines((s) => s.list);
  const app = studio();
  const openPicked = (choice: OpenChoice): void => openPickedFolder(app, dialogs, choice, onEnterProject);

  const dialogProject = state.project;
  return (
    <>
      {state.settingsOpen && (
        <SettingsDialog
          returnFocus={dialogs.settingsReturnFocus}
          section={state.settingsSection}
          onSection={(section) => dispatch({ type: "section", section })}
          onDismiss={() => dispatch({ type: "close-settings" })}
          engines={engines}
          // The store's own refresh: one function for the app's life. Settings keys an effect on it,
          // so a new closure per render would re-read the engines on every update while it is open.
          onEnginesRefresh={app.engines.refresh}
          projectsRootLabel={rootLabel}
          onProjectsRoot={(label) => app.library.setState((s) => rootLabelChanged(s, label), true)}
        />
      )}
      {state.searching && (
        <ProjectSearchDialog
          projects={projects}
          threads={threads}
          firstAsks={firstAsks}
          onDismiss={() => dispatch({ type: "close-search" })}
          onSelectProject={onSelectProject}
          onSelectThread={onSelectThread}
        />
      )}
      {dialogProject?.kind === "rename" && (
        <RenameProjectDialog
          project={dialogProject.project}
          onSave={(patch) => app.saveProject(dialogProject.project.name, patch)}
          onDismiss={() => dispatch({ type: "close-project" })}
        />
      )}
      {dialogProject?.kind === "delete" && (
        <DeleteProjectDialog
          project={dialogProject.project}
          onDelete={() => onRemoveProject(dialogProject.project.name)}
          onDismiss={() => dispatch({ type: "close-project" })}
        />
      )}
      {dialogProject?.kind === "cover" && (
        <ProjectCoverDialog
          project={dialogProject.project}
          onSave={(patch) => app.saveProject(dialogProject.project.name, patch)}
          onDismiss={() => dispatch({ type: "close-project" })}
        />
      )}
      {state.picked ? (
        <OpenProjectSheet
          // Another folder is another question: the sheet starts again on the row `inspect`
          // suggested for it, with its primary button focused.
          key={state.picked.dir}
          inspection={state.picked}
          busy={state.opening}
          onOpen={openPicked}
          onDismiss={() => dispatch({ type: "dismiss-picked" })}
        />
      ) : null}
    </>
  );
}
