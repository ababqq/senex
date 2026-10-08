/**
 * The app was called "AI Game Studio" before it was Genex, and Electron names the data folder
 * after the app: `~/Library/Application Support/<name>` on macOS, `~/.config/<name>` on Linux,
 * `%APPDATA%\<name>` on Windows. Before anything reads userData, the normal profile moves the
 * legacy folder to the new name, so projects, threads, settings and plugins carry over. Secrets do
 * not: safeStorage's key is named after the app too (`SecretStore.get` reads them as missing).
 */
import fs from "node:fs";
import path from "node:path";
import { errorMessage } from "../shared/errors.ts";

/** The app name the data folder had before the rename. */
export const LEGACY_APP_NAME = "AI Game Studio";
/** Beside the new folder: a copy is made here, then renamed into place, so a failed copy is never read. */
const STAGING_SUFFIX = ".migrating";

/** What startup did with the legacy data folder. */
export const UserDataMigrationOutcome = {
  Moved: "moved",
  Copied: "copied",
  Failed: "failed",
  Isolated: "isolated",
  CustomLocation: "custom-location",
  NoLegacyData: "no-legacy-data",
  NewDataPresent: "new-data-present",
} as const;
export type UserDataMigrationOutcome = (typeof UserDataMigrationOutcome)[keyof typeof UserDataMigrationOutcome];

/** The outcome, and for a move, copy or failure the two folders and why a step failed. */
export interface UserDataMigration {
  outcome: UserDataMigrationOutcome;
  from?: string;
  to?: string;
  error?: string;
}

/** Where this launch keeps its data, and whether it is a developer, fixture or test profile. */
export interface UserDataLocation {
  appData: string;
  userData: string;
  appName: string;
  isolated: boolean;
}

/** The folder operations the migration needs; synchronous, because nothing may read userData first. */
export interface UserDataFs {
  /** The folder's entries, or null when it does not exist. */
  entries(dir: string): string[] | null;
  rename(from: string, to: string): void;
  /** Copy a folder recursively to a path that does not exist. */
  copy(from: string, to: string): void;
  /** Remove a folder and everything in it; nothing when it is gone. */
  remove(dir: string): void;
}

/** The real filesystem. */
export const nodeUserDataFs: UserDataFs = {
  entries: (dir) => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return null;
    }
  },
  rename: (from, to) => fs.renameSync(from, to),
  copy: (from, to) => fs.cpSync(from, to, { recursive: true, errorOnExist: true, preserveTimestamps: true }),
  remove: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
};

/**
 * Move `<appData>/AI Game Studio` to this launch's userData when that is the normal profile's
 * default folder and it is missing or empty. A folder with anything in it is never merged into.
 * When the rename fails (another volume, a held file on Windows) the legacy folder is copied and
 * kept; when that fails too, nothing is left where the next launch would read it.
 */
export function migrateLegacyUserData(where: UserDataLocation, fsx: UserDataFs = nodeUserDataFs): UserDataMigration {
  if (where.isolated) return { outcome: UserDataMigrationOutcome.Isolated };
  if (where.userData !== path.join(where.appData, where.appName))
    return { outcome: UserDataMigrationOutcome.CustomLocation };
  const legacy = path.join(where.appData, LEGACY_APP_NAME);
  const hasLegacyData = legacy !== where.userData && Boolean(fsx.entries(legacy)?.length);
  if (!hasLegacyData) return { outcome: UserDataMigrationOutcome.NoLegacyData };
  const current = fsx.entries(where.userData);
  if (current?.length) return { outcome: UserDataMigrationOutcome.NewDataPresent };
  try {
    if (current) fsx.remove(where.userData);
    fsx.rename(legacy, where.userData);
    return { outcome: UserDataMigrationOutcome.Moved, from: legacy, to: where.userData };
  } catch (renameError) {
    return copyLegacy(legacy, where.userData, fsx, errorMessage(renameError));
  }
}

/** Copy the legacy folder through a staging sibling, keeping the legacy one. */
function copyLegacy(legacy: string, userData: string, fsx: UserDataFs, renameError: string): UserDataMigration {
  const staging = `${userData}${STAGING_SUFFIX}`;
  try {
    fsx.remove(staging);
    fsx.copy(legacy, staging);
    fsx.rename(staging, userData);
    return { outcome: UserDataMigrationOutcome.Copied, from: legacy, to: userData, error: renameError };
  } catch (error) {
    removeQuietly(fsx, staging);
    return { outcome: UserDataMigrationOutcome.Failed, from: legacy, to: userData, error: errorMessage(error) };
  }
}

/** Best-effort cleanup after a failed copy; the failure already reported is the one that matters. */
function removeQuietly(fsx: UserDataFs, dir: string): void {
  try {
    fsx.remove(dir);
  } catch {
    // The staging folder is never read; the next attempt removes it first.
  }
}

/** The log line for an outcome that changed or tried to change folders, or null for a no-op. */
export function userDataMigrationLine(result: UserDataMigration): string | null {
  switch (result.outcome) {
    case UserDataMigrationOutcome.Moved:
      return `moved the data folder ${result.from} to ${result.to}`;
    case UserDataMigrationOutcome.Copied:
      return `copied the data folder ${result.from} to ${result.to} and kept it (rename failed: ${result.error})`;
    case UserDataMigrationOutcome.Failed:
      return `could not move the data folder ${result.from} to ${result.to}: ${result.error}; starting with a new one`;
    default:
      return null;
  }
}
