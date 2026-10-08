/** Genex BM25 search, adapted to the local library. No network or analytics. */
import { buildIndex } from "../shared/catalog-search/buildIndex.ts";
import { createSearcher } from "../shared/catalog-search/query.ts";
import { ThreadKind } from "../shared/event-log.ts";
import type { ConversationRecord, Project, ThreadMeta } from "./types.ts";

/** How many projects a search returns at most. */
const SEARCH_LIMIT = 20;
export type ProjectSearchItem = {
  id: string;
  title: string;
  detail: string;
  project?: Project;
  threadId?: string;
  searchText: string;
};
export function librarySearch(projects: Project[], threads: ConversationRecord[], firstAsks: Record<string, string>) {
  const items: ProjectSearchItem[] = projects.map((project) => ({
    id: project.name,
    title: project.title,
    detail: project.pathLabel,
    project,
    searchText: threads
      .filter((thread) => (thread.metadata as ThreadMeta)?.project === project.name)
      .map((thread) => `${thread.title} ${firstAsks[thread.id] ?? ""}`)
      .join(" "),
  }));
  // Existing drafts are recoverable; new projects no longer create a separate sidebar chat entity.
  for (const thread of threads) {
    const meta = (thread.metadata ?? {}) as ThreadMeta;
    const folderlessDraft = meta.kind === ThreadKind.Project && !meta.project && !meta.archived;
    if (folderlessDraft)
      items.push({
        id: `thread:${thread.id}`,
        title: thread.title || firstAsks[thread.id] || "Untitled conversation",
        detail: "Earlier conversation · no folder",
        threadId: thread.id,
        searchText: firstAsks[thread.id] ?? "",
      });
  }
  const byId = new Map(items.map((item) => [item.id, item]));
  const searcher = createSearcher(
    buildIndex(
      items.map((item) => ({
        id: item.id,
        slug: item.id,
        title: item.title,
        description: item.searchText,
        categories: [],
        author: item.project?.name ?? "",
        thumbnailUrl: null,
        playsCount: 0,
        multiplayer: false,
      })),
    ),
  );
  return {
    items,
    search: (query: string) =>
      searcher.search(query, SEARCH_LIMIT).flatMap((hit) => {
        const item = byId.get(hit.doc.id);
        return item ? [item] : [];
      }),
  };
}
