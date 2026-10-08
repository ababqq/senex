import type { JSX } from "react";
import { useMemo } from "react";
import type { AppDialogs as Dialogs } from "../panels/AppDialogs.tsx";
import { BootstrapGate } from "../panels/BootstrapGate.tsx";
import { Sidebar } from "../panels/Sidebar.tsx";
import { useLaunch, useSidebarLibrary, useThreadsView, useUpdate } from "../state/hooks.ts";
import { launchInSidebar } from "../state/launch.ts";
import type { Studio } from "../state/studio.ts";
import { busyThreadIds, Room } from "../state/threads.ts";
import { notifyProblem } from "../state/toasts.ts";
import { LoadFailed } from "../ui/LoadFailed.tsx";
import type { Notifications } from "../use-notifications.ts";
import type { Navigation } from "./use-navigation.ts";
import type { ShellChrome } from "./use-shell-chrome.ts";

const SIDEBAR_PANE = "h-full border-r border-line bg-base px-3 pt-12";

/** The sidebar: projects, chats and notifications, behind the bootstrap's own loading and failure. */
export function AppSidebar({
  app,
  chrome,
  dialogs,
  navigation,
  notices,
  welcoming,
}: {
  app: Studio;
  chrome: ShellChrome;
  dialogs: Dialogs;
  navigation: Navigation;
  notices: Notifications;
  welcoming: boolean;
}): JSX.Element {
  const { records: threads, status: threadStatus, activeThreadId, project, room } = useThreadsView();
  const launch = useLaunch((s) => s.launch);
  const atHome = room === Room.Home && !launch;
  const { projects, building, stagedCount } = useSidebarLibrary();
  // A project home is starting has one row: a placeholder until it is made and listed, then its own.
  const launching = useMemo(
    () => launchInSidebar(launch, (name) => projects.some((entry) => entry.name === name)),
    [launch, projects],
  );
  const update = useUpdate((s) => s.ready);
  const busyThreads = useMemo(() => busyThreadIds(threadStatus), [threadStatus]);
  const { pluginsOpen } = chrome;
  const hidden = !chrome.sidebarVisible || welcoming;
  const notifyFailure = notifyProblem(app.notify);
  const restartToUpdate = (): Promise<boolean> =>
    app.api.restartToUpdate().catch((error: unknown) => {
      notifyFailure(error);
      return false;
    });
  const downloadUpdate = (): void => {
    void app.api.openUpdateDownload().catch(notifyFailure);
  };
  return (
    <aside className="studio-sidebar" inert={hidden} aria-hidden={hidden}>
      <BootstrapGate
        failed={({ error, retry, retrying }) => (
          <div className={SIDEBAR_PANE}>
            <LoadFailed
              what="projects and chats"
              error={error ?? undefined}
              onRetry={retry}
              retrying={retrying}
              className="text-ink-2"
              detailClassName="mt-2 break-words"
            />
          </div>
        )}
      >
        <Sidebar
          onSearch={() => dialogs.dispatch({ type: "search" })}
          notices={notices.visible}
          onOpenNotice={notices.open}
          onReadNotices={notices.readAll}
          onClearNotices={notices.clear}
          onToggle={chrome.toggleSidebar}
          pluginsOpen={pluginsOpen}
          onPlugins={chrome.openPlugins}
          onSettings={() => dialogs.openSettings()}
          stagedCount={stagedCount}
          threads={threads}
          projects={projects}
          activeThreadId={pluginsOpen ? null : activeThreadId}
          activeProject={pluginsOpen || room === Room.Home ? null : project}
          atHome={atHome && !pluginsOpen}
          onHome={navigation.goHome}
          launching={launching}
          building={building}
          busyThreads={busyThreads}
          threadStatus={threadStatus}
          onNewProject={navigation.newProject}
          onSelectThread={navigation.selectThread}
          onSelectProject={navigation.selectProject}
          onRenameProject={(entry) => dialogs.dispatch({ type: "project", kind: "rename", project: entry })}
          onPinProject={(entry) => {
            void app.saveProject(entry.name, { pinned: !entry.pinned }).catch(notifyFailure);
          }}
          onDeleteProject={(entry) => dialogs.dispatch({ type: "project", kind: "delete", project: entry })}
          onChangeCover={(entry) => dialogs.dispatch({ type: "project", kind: "cover", project: entry })}
          update={update}
          onRestartToUpdate={restartToUpdate}
          onDownloadUpdate={downloadUpdate}
        />
      </BootstrapGate>
    </aside>
  );
}
