/**
 * Where home's next project is saved: a quiet chip under the composer naming the folder, and its
 * menu — the projects folder, another folder the user picks, or a folder with a project they already
 * have (which the Open Project sheet takes over).
 */
import type { JSX } from "react";
import { useState } from "react";
import type { FolderInspection, ProjectLocation } from "../../shared/project-folder.ts";
import { inspectPickedFolder } from "../open-folder.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import { Icon } from "../ui/icons.tsx";
import { problemWords } from "../words.ts";

/** The chip's words. */
const MESSAGE = {
  where: "Where this project is saved",
  saveIn: "Save the new project in",
  another: "Another folder…",
  open: "Open a folder…",
  openHint: "Keep working on a project you already have",
} as const;

/** The menu's two places: the projects folder, or the folder the user chose. */
const Place = { Projects: "projects", Chosen: "chosen" } as const;

/** The last part of a folder's label: `~/AI Projects` → `AI Projects`. */
const folderName = (pathLabel: string): string => pathLabel.split("/").filter(Boolean).at(-1) ?? pathLabel;

/** One row's two lines: what it is, and a path (mono) or a few words saying more. */
function FolderLines({ title, path, hint }: { title: string; path?: string; hint?: string }): JSX.Element {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-chat text-ink">{title}</span>
      {path ? <span className="truncate font-mono text-xs text-ink-3">{path}</span> : null}
      {hint ? <span className="text-xs text-ink-3">{hint}</span> : null}
    </span>
  );
}

export function HomeFolderChip({
  rootLabel,
  location,
  disabled = false,
  onLocation,
  onInspect,
  onProblem,
}: {
  /** The projects folder, as the UI shows it (`~/AI Projects`). */
  rootLabel: string;
  /** The folder chosen for the next project, or null for the projects folder. */
  location: ProjectLocation | null;
  disabled?: boolean;
  onLocation: (location: ProjectLocation | null) => void;
  /** A folder with a project in it was picked and looked at: the Open Project sheet takes over. */
  onInspect: (inspection: FolderInspection) => void;
  onProblem: (words: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const label = folderName(location?.pathLabel ?? rootLabel);
  const ask = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      onProblem(problemWords(error));
    } finally {
      setBusy(false);
    }
  };
  const chooseAnother = () =>
    ask(async () => {
      const chosen = await window.studio.pickProjectLocation();
      if (chosen) onLocation(chosen);
    });
  const openFolder = () =>
    ask(async () => {
      const inspected = await inspectPickedFolder(window.studio);
      if (inspected) onInspect(inspected);
    });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-home-folder
          className="home-folder-chip"
          title={MESSAGE.where}
          aria-label={`${MESSAGE.where}: ${label}`}
          disabled={disabled || busy}
        >
          <Icon name="folder" size={15} />
          <span className="truncate">{label}</span>
          <Icon name="chevron-down" size={13} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={6} className="w-80">
        <DropdownMenuLabel>{MESSAGE.saveIn}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={location ? Place.Chosen : Place.Projects}>
          <DropdownMenuRadioItem value={Place.Projects} onSelect={() => onLocation(null)}>
            <span className="flex min-w-0 items-center gap-2.5">
              <Icon name="folder" size={16} />
              <FolderLines title={folderName(rootLabel)} path={rootLabel} />
            </span>
          </DropdownMenuRadioItem>
          {/* Picking this row asks for a folder every time, even when one is chosen already. */}
          <DropdownMenuRadioItem value={Place.Chosen} onSelect={() => void chooseAnother()}>
            <span className="flex min-w-0 items-center gap-2.5">
              <Icon name="folder-plus" size={16} />
              <FolderLines
                title={location ? folderName(location.pathLabel) : MESSAGE.another}
                path={location?.pathLabel}
              />
            </span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-2.5" onSelect={() => void openFolder()}>
          <Icon name="folder-open" size={16} />
          <FolderLines title={MESSAGE.open} hint={MESSAGE.openHint} />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
