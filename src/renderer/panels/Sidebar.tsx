/** One project, one row. The chrome and navigation stay put; only the project list scrolls. */
import type { ComponentPropsWithRef, JSX, ReactNode, RefObject } from "react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { type ReadyUpdate, UpdateAction } from "../../shared/app-update.ts";
import { ThreadKind } from "../../shared/event-log.ts";
import { statusWords, UPDATE_WORDS } from "../words.ts";
import type { ConversationRecord, Project, ThreadMeta } from "../types.ts";
import { Dot, IconButton } from "../ui/kit.tsx";
import { Icon, type IconName } from "../ui/icons.tsx";
import { GenexLogo } from "../ui/GenexLogo.tsx";
import { ProjectAvatar } from "../ui/ProjectAvatar.tsx";
import { Shortcut } from "../ui/Shortcut.tsx";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip.tsx";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu.tsx";
import { NotificationsMenu } from "./NotificationsMenu.tsx";
import type { Notice } from "../notifications.ts";
import type { LaunchInSidebar } from "../state/launch.ts";
import { sidebarProjects } from "../state/threads.ts";

interface Props {
  threads: ConversationRecord[];
  projects: Project[];
  activeThreadId: string | null;
  activeProject: string | null;
  /** Home is open: nothing is selected, and the wordmark is where it is. */
  atHome: boolean;
  onHome: () => void;
  /** A project home is starting: a placeholder row until it is made, then its own row, selected and working. */
  launching: LaunchInSidebar;
  building: ReadonlySet<string>;
  busyThreads: ReadonlySet<string>;
  threadStatus: Record<string, { status: string; since: number }>;
  onSearch: () => void;
  notices: Notice[];
  onOpenNotice: (notice: Notice) => void;
  onReadNotices: () => void;
  onClearNotices: () => void;
  onToggle: () => void;
  onSettings: () => void;
  pluginsOpen: boolean;
  onPlugins: () => void;
  stagedCount: number;
  onNewProject: () => void;
  onSelectThread: (threadId: string) => void;
  onSelectProject: (project: string) => void;
  onRenameProject: (project: Project) => void;
  onPinProject: (project: Project) => void;
  onDeleteProject: (project: Project) => void;
  onChangeCover: (project: Project) => void;
  /** A new version of the app waiting for a restart or a download, or null. */
  update: ReadyUpdate | null;
  /** Quit and relaunch into it; false when main did not (the person kept a run going). */
  onRestartToUpdate: () => Promise<boolean>;
  /** Open the waiting release's download page (Linux). */
  onDownloadUpdate: () => void;
}
const meta = (thread: ConversationRecord) => (thread.metadata ?? {}) as ThreadMeta;

/** A tooltip that carries a shortcut chip, opening beside the sidebar (or above a control at its foot). */
function Hint({
  label,
  shortcut,
  side = "right",
  children,
}: {
  label: string;
  shortcut?: string;
  side?: "right" | "top";
  children: ReactNode;
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>
        <span className="flex items-center gap-2">
          {label}
          {shortcut && <Shortcut>{shortcut}</Shortcut>}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/** How long after the last scroll the list's scrollbar stays shown. */
const SCROLL_SETTLE_MS = 800;

/** The projects in the sidebar's order (`sidebarProjects`). */
function useSortedProjects(projects: Project[], threads: ConversationRecord[]): Project[] {
  return useMemo(() => sidebarProjects(projects, threads), [projects, threads]);
}

/**
 * The list's scroll state. The scrollbar shows while the sidebar is hovered or scrolling; the
 * fade shows once the list has moved.
 */
function useScrollState(nav: RefObject<HTMLElement | null>) {
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => () => clearTimeout(settle.current), []);
  const onScroll = (list: HTMLElement) => {
    setScrolled(list.scrollTop > 0);
    nav.current?.setAttribute("data-scrolling", "true");
    clearTimeout(settle.current);
    settle.current = setTimeout(() => nav.current?.removeAttribute("data-scrolling"), SCROLL_SETTLE_MS);
  };
  return { scrolled, onScroll };
}

export function Sidebar(props: Props): JSX.Element {
  const { threads, projects, activeThreadId } = props;
  const studio = threads.find((thread) => meta(thread).kind !== ThreadKind.Project);
  const harnessOpen = !!studio && studio.id === activeThreadId;
  const nav = useRef<HTMLElement>(null);
  const { scrolled, onScroll } = useScrollState(nav);
  const sorted = useSortedProjects(projects, threads);
  return (
    <nav
      ref={nav}
      data-pane="rail"
      id="studio-sidebar"
      aria-label="Main navigation"
      className="project-sidebar"
      data-scrolled={scrolled}
    >
      <SidebarTop {...props} studio={studio} harnessOpen={harnessOpen} />
      <div className="sidebar-list">
        <div className="sidebar-scroll" data-sidebar-scroll onScroll={(event) => onScroll(event.currentTarget)}>
          <div className="sidebar-projects">
            {sorted.map((project, index) => (
              <Fragment key={project.name}>
                {props.launching.placeholder && index === firstUnpinned(sorted) ? (
                  <LaunchRow title={props.launching.title} />
                ) : null}
                <SidebarProject {...props} project={project} harnessOpen={harnessOpen} />
              </Fragment>
            ))}
            {props.launching.placeholder && firstUnpinned(sorted) === sorted.length ? (
              <LaunchRow title={props.launching.title} />
            ) : null}
          </div>
        </div>
        <span className="sidebar-fade" aria-hidden="true" />
        {props.update?.action === UpdateAction.Download && (
          <SidebarDownload update={props.update} onDownload={props.onDownloadUpdate} />
        )}
        {props.update?.action === UpdateAction.Restart && (
          <SidebarUpdate update={props.update} onRestart={props.onRestartToUpdate} />
        )}
      </div>
    </nav>
  );
}

/** Where a new project's row goes: after the pinned ones. */
const firstUnpinned = (sorted: Project[]): number => {
  const index = sorted.findIndex((project) => !project.pinned);
  return index === -1 ? sorted.length : index;
};

/** The project home is starting, selected and working, until it is made and has its own row. */
function LaunchRow({ title }: { title: string | null }): JSX.Element {
  return (
    <div className="sidebar-project" data-launching data-active="true" data-busy="true">
      <div className="sidebar-project-select" aria-current="page">
        <span className="project-avatar project-avatar-pending" aria-hidden="true" />
        <span className={`min-w-0 flex-1 truncate ${title ? "" : "text-ink-3"}`}>{title ?? "Naming…"}</span>
        <span className="sr-only">Working</span>
      </div>
      <ProjectRowEnd busy pinned={false} />
    </div>
  );
}

/** Relaunch to update, over the foot of the project list while a downloaded version waits. */
function SidebarUpdate({ update, onRestart }: { update: ReadyUpdate; onRestart: () => Promise<boolean> }): JSX.Element {
  const [restarting, setRestarting] = useState(false);
  const restart = (): void => {
    setRestarting(true);
    // On a yes main quits; a kept run leaves the row to try again.
    void onRestart().then((quitting) => {
      if (!quitting) setRestarting(false);
    });
  };
  return (
    <div className="sidebar-footer">
      <Hint label={UPDATE_WORDS.hint(update.version)} side="top">
        <button
          type="button"
          className="sidebar-update"
          data-update-restart
          aria-busy={restarting}
          disabled={restarting}
          onClick={restart}
        >
          <span>{restarting ? UPDATE_WORDS.restarting : UPDATE_WORDS.restart}</span>
          <Icon name="reload" size={16} />
        </button>
      </Hint>
    </div>
  );
}

/** Download Genex X, over the foot of the project list while a release Linux installs by hand waits. */
function SidebarDownload({ update, onDownload }: { update: ReadyUpdate; onDownload: () => void }): JSX.Element {
  return (
    <div className="sidebar-footer">
      <Hint label={UPDATE_WORDS.downloadHint} side="top">
        <button type="button" className="sidebar-update" data-update-download onClick={onDownload}>
          <span>{UPDATE_WORDS.download(update.version)}</span>
          <Icon name="arrow-up-right" size={16} />
        </button>
      </Hint>
    </div>
  );
}

/** A project's row, open on its primary (else first) chat; busy while it builds or a chat works. */
function SidebarProject({
  project,
  threads,
  building,
  busyThreads,
  activeProject,
  launching,
  harnessOpen,
  onSelectProject,
  onRenameProject,
  onPinProject,
  onDeleteProject,
  onChangeCover,
}: Props & { project: Project; harnessOpen: boolean }): JSX.Element {
  const chats = threads.filter((thread) => meta(thread).project === project.name && !meta(thread).archived);
  const thread = chats.find((chat) => chat.id === project.primaryThreadId) ?? chats[0];
  // The project home is launching keeps its placeholder's look: selected and working.
  const launched = launching.project === project.name;
  const busy = launched || building.has(project.name) || chats.some((chat) => busyThreads.has(chat.id));
  const active = launched || activeProject === project.name;
  return (
    <ProjectRow
      project={project}
      threadId={thread?.id}
      active={active && !harnessOpen}
      busy={busy}
      onSelect={() => onSelectProject(project.name)}
      onRename={() => onRenameProject(project)}
      onPin={() => onPinProject(project)}
      onDelete={() => onDeleteProject(project)}
      onCover={() => onChangeCover(project)}
    />
  );
}

/** The fixed top: the toggle, the brand with search and notifications, the rooms, the projects heading. */
function SidebarTop({
  studio,
  harnessOpen,
  projects,
  threads,
  busyThreads,
  threadStatus,
  onSearch,
  notices,
  onOpenNotice,
  onReadNotices,
  onClearNotices,
  onToggle,
  onSettings,
  pluginsOpen,
  onPlugins,
  stagedCount,
  onNewProject,
  onSelectThread,
  atHome,
  onHome,
}: Props & { studio: ConversationRecord | undefined; harnessOpen: boolean }): JSX.Element {
  const studioStatus = studio ? threadStatus[studio.id]?.status : undefined;
  const studioBusy = Boolean(studio && busyThreads.has(studio.id));
  return (
    <div className="sidebar-fixed">
      <div className="titlebar-drag sidebar-titlebar">
        <Hint label="Hide sidebar" shortcut="⌘B">
          <button
            type="button"
            className="no-drag sidebar-toggle"
            aria-label="Hide sidebar"
            aria-controls="studio-sidebar"
            aria-expanded="true"
            onClick={onToggle}
          >
            <Icon name="sidebar" />
          </button>
        </Hint>
      </div>
      <div className="sidebar-brand-row">
        <button
          type="button"
          className="sidebar-home"
          aria-label="Home"
          aria-current={atHome ? "page" : undefined}
          onClick={onHome}
        >
          <GenexLogo className="brand sidebar-wordmark" />
        </button>
        <div className="sidebar-brand-actions">
          <IconButton
            icon="search"
            label="Search projects"
            title="Search projects · ⌘K"
            className="sidebar-icon"
            onClick={onSearch}
          />
          <NotificationsMenu
            items={notices}
            projects={projects}
            threads={threads}
            onOpen={onOpenNotice}
            onRead={onReadNotices}
            onClear={onClearNotices}
          />
        </div>
      </div>
      <div className="sidebar-nav">
        <Hint label="New project" shortcut="⌘N">
          <NavRow icon="new-project" aria-keyshortcuts="Meta+N Control+N" onClick={onNewProject}>
            New project
          </NavRow>
        </Hint>
        <NavRow icon="plugins" aria-label="Plugins" current={pluginsOpen} onClick={onPlugins}>
          Plugins
        </NavRow>
        {studio && (
          <Hint label="Harness" shortcut="⌘2">
            <NavRow
              icon="harness"
              data-thread="studio"
              current={harnessOpen}
              busy={studioBusy}
              onClick={() => onSelectThread(studio.id)}
            >
              <span className="min-w-0 flex-1 truncate">Harness</span>
              {stagedCount > 0 && (
                <span className="sidebar-badge" aria-label={`${stagedCount} skill improvements to review`}>
                  {stagedCount}
                </span>
              )}
              {studioBusy && studioStatus && <span className="sr-only">{statusWords(studioStatus).short}</span>}
            </NavRow>
          </Hint>
        )}
        <NavRow icon="settings" aria-label="Settings" aria-haspopup="dialog" onClick={onSettings}>
          Settings
        </NavRow>
      </div>
      <div className="sidebar-projects-heading">
        <span>Projects</span>
        <IconButton
          icon="plus"
          label="Create project"
          title="Create project · ⌘N"
          className="sidebar-icon"
          onClick={onNewProject}
        />
      </div>
    </div>
  );
}

/** New project, Plugins, Harness and Settings: one stack of equal rows. */
function NavRow({
  icon,
  current = false,
  busy = false,
  children,
  ...rest
}: {
  icon: IconName;
  current?: boolean;
  busy?: boolean;
  children: ReactNode;
} & ComponentPropsWithRef<"button"> &
  Record<`data-${string}`, string>): JSX.Element {
  // Tooltip triggers pass their ref and handlers through `rest`.
  return (
    <button type="button" className="sidebar-action" aria-current={current ? "page" : undefined} {...rest}>
      {busy ? <Dot tone="busy" /> : <Icon name={icon} size={18} />}
      {typeof children === "string" ? <span>{children}</span> : children}
    </button>
  );
}

/** The end of a project row: the working dot while it works, else the pin when pinned. */
function ProjectRowEnd({ busy, pinned }: { busy: boolean; pinned: boolean | undefined }) {
  if (busy) {
    return (
      <span className="sidebar-project-status" aria-hidden="true">
        <Dot tone="busy" />
      </span>
    );
  }
  if (!pinned) return null;
  return (
    <span className="sidebar-pin" aria-label="Pinned">
      <Icon name="pin" size={13} />
    </span>
  );
}

function ProjectRow({
  project,
  threadId,
  active,
  busy,
  onSelect,
  onRename,
  onPin,
  onDelete,
  onCover,
}: {
  project: Project;
  threadId?: string;
  active: boolean;
  busy: boolean;
  onSelect: () => void;
  onRename: () => void;
  onPin: () => void;
  onDelete: () => void;
  onCover: () => void;
}) {
  const [open, setOpen] = useState(false);
  // The row's end is one slot: the working dot, else the pin — and ⋯ in their place on hover.
  return (
    <div
      className="sidebar-project"
      data-project-row={project.name}
      data-active={active}
      data-busy={busy}
      data-menu-open={open}
    >
      <button
        type="button"
        data-project={project.name}
        data-thread={threadId}
        aria-current={active ? "page" : undefined}
        title={project.pathLabel}
        className="sidebar-project-select"
        onClick={onSelect}
      >
        <ProjectAvatar cover={project.cover} active={active} projectKey={project.name} />
        <span className="min-w-0 flex-1 truncate">{project.title}</span>
        {busy && <span className="sr-only">Working</span>}
      </button>
      <ProjectRowEnd busy={busy} pinned={project.pinned} />
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button type="button" className="sidebar-project-menu" aria-label={`Actions for ${project.title}`}>
                <Icon name="more" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="right">Project actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" side="right" className="w-48">
          <DropdownMenuItem data-project-action="rename" onSelect={onRename}>
            <Icon name="rename" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem data-project-action="pin" onSelect={onPin}>
            <Icon name="pin" />
            {project.pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuItem data-project-action="cover" onSelect={onCover}>
            <Icon name="image" />
            Change image…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem data-project-action="delete" disabled={busy} onSelect={onDelete} className="text-red">
            <Icon name="trash" />
            Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
