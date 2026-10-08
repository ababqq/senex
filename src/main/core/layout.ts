/** Where the studio keeps its own state under userData: the event store, workspaces, runs and homes. */
import path from "node:path";

// A type alias, not an interface: the bootstrap hands it to the renderer as `Record<string, string>`.
export type StudioLayout = {
  exoharness: string;
  workspaces: string;
  harnessWs: string;
  projectsRoot: string;
  secrets: string;
  scratch: string;
  runs: string;
  updates: string;
  engineHomes: string;
  exports: string;
};

export function layoutFor(userData: string): StudioLayout {
  return {
    exoharness: path.join(userData, "exoharness"),
    workspaces: path.join(userData, "workspaces"),
    harnessWs: path.join(userData, "workspaces", "harness"),
    projectsRoot: path.join(userData, "workspaces", "games"),
    secrets: path.join(userData, "secrets"),
    scratch: path.join(userData, "scratch"),
    runs: path.join(userData, "runs"),
    updates: path.join(userData, "updates"),
    engineHomes: path.join(userData, "engine-homes"),
    exports: path.join(userData, "exports"),
  };
}
