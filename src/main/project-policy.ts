/** Where a development launch may keep its projects: only below the profile's own projects root. */
import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { isBelow } from "../substrate/paths.ts";

/** Why a development project is refused. */
const MESSAGE = {
  outsideRoot: (project: string) => `Project is outside the owned development projects root: ${project}`,
  alias: (project: string) => `Project alias is not allowed: ${project}`,
} as const;

/** Development-only containment. Check before adopting/indexing/granting project writes. */
export async function assertOwnedProject(root: string | undefined, project: string): Promise<void> {
  if (!root) return;
  const canonicalRoot = await realpath(root);
  const requested = path.resolve(project);
  const actual = await realpath(project);
  if (requested !== actual || !isBelow(canonicalRoot, actual)) throw new Error(MESSAGE.outsideRoot(project));
  let current = canonicalRoot;
  for (const part of path.relative(canonicalRoot, requested).split(path.sep)) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error(MESSAGE.alias(project));
  }
}
