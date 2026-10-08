/**
 * Opening a folder the user already has, in two steps that never merge: the picker's answer is a
 * folder to look at, and only the open sheet's answer adopts it. The sheet asks the question and
 * App answers it through {@link adoptPickedFolder}, so nothing is written before the user has
 * seen what the studio found (tests/conformance/project-shape.test.ts).
 */
import type { OpenChoice } from "../shared/shape-words.ts";
import type { FolderInspection, Project } from "./types.ts";

/** Home's Open a folder…: pick a folder and inspect it. Cancelling the picker inspects nothing. */
export async function inspectPickedFolder(api: {
  pickProject(): Promise<string | null>;
  inspectFolder(dir: string): Promise<FolderInspection>;
}): Promise<FolderInspection | null> {
  const dir = await api.pickProject();
  return dir ? api.inspectFolder(dir) : null;
}

/** The open sheet's answer: adopt the inspected folder the way the user chose. */
export function adoptPickedFolder(
  api: { adoptFolder(dir: string, options?: OpenChoice): Promise<Project> },
  dir: string,
  choice: OpenChoice,
): Promise<Project> {
  return api.adoptFolder(dir, choice);
}
