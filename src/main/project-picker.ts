/** The native folder pickers behind New project and home's folder chip: where a project goes, and a folder to open instead. */
import path from "node:path";
import type { OpenDialogOptions } from "electron";

/** Open existing's words: the folder chosen is the project. */
const OPEN_MESSAGE = {
  title: "Open project folder",
  buttonLabel: "Open",
  message: "Choose a folder, or create one. Images and notes inside it are visible to the agent.",
} as const satisfies Pick<OpenDialogOptions, "title" | "buttonLabel" | "message">;

/** The location picker's words: the folder chosen is only where the project's own folder is made. */
const LOCATION_MESSAGE = {
  title: "Choose where to create the project",
  buttonLabel: "Choose",
  message: "The project gets a new folder of its own inside the folder you choose.",
} as const satisfies Pick<OpenDialogOptions, "title" | "buttonLabel" | "message">;

/**
 * Open existing: one folder, opening in the projects root, with New Folder (`createDirectory`,
 * macOS), so a project can start in a folder made right there.
 */
export function projectPickerOptions(projectsRoot: string): OpenDialogOptions {
  return {
    ...OPEN_MESSAGE,
    defaultPath: projectsRoot,
    properties: ["openDirectory", "createDirectory"],
  };
}

/**
 * A new project's location: one folder, with New Folder (macOS). It opens beside the projects folder,
 * not inside it: every library-style folder there is a project, so a New Folder made there is one.
 */
export function projectLocationPickerOptions(projectsRoot: string): OpenDialogOptions {
  return {
    ...LOCATION_MESSAGE,
    defaultPath: path.dirname(projectsRoot),
    properties: ["openDirectory", "createDirectory"],
  };
}
