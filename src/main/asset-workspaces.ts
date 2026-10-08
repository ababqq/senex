import path from "node:path";
import { isBelow, toPosixRelative } from "../substrate/paths.ts";
import type { AssetWorkspace } from "./project-assets.ts";

const MAX_LISTED_WORKSPACES = 32;

/** Worktree porcelain already carries each HEAD; a listing needs no per-worktree git spawn. */
export function assetWorkspaces(listing: string, scratch: string, allowedRoot: string): AssetWorkspace[] {
  const workspaces: AssetWorkspace[] = [];
  for (const block of listing.split("\0\0")) {
    const fields = block.split("\0");
    const root = fields.find((field) => field.startsWith("worktree "))?.slice(9);
    if (!root || !isBelow(allowedRoot, root)) continue;
    const revision = fields.find((field) => field.startsWith("HEAD "))?.slice(5);
    workspaces.push({
      id: toPosixRelative(path.relative(scratch, root)),
      root,
      scope: path.basename(root) === "integration" ? "integration" : "worker",
      ...(revision ? { revision } : {}),
    });
  }
  return workspaces.slice(-MAX_LISTED_WORKSPACES);
}
