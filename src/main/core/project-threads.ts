/**
 * Project chats: the one canonical conversation per project, legacy unbound drafts, titles and bindings,
 * and the repair that re-binds a chat the old binding gap orphaned. Composed by `StudioCore`.
 */
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import { EventKind, ThreadKind } from "../../shared/event-log.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import type { ConversationRecord, EventEnvelope } from "../../substrate/types.ts";
import type { StudioCore } from "../studio-core.ts";

/** Why a thread change is refused. */
const MESSAGE = {
  chatNeedsName: "a chat needs a name",
} as const;

/** The title a project's own conversation starts with. */
export const NEW_CHAT_TITLE = "New chat";
/** The title an unbound project draft starts with. */
export const NEW_PROJECT_TITLE = "New project";
/** Characters kept of a chat's new name. */
const THREAD_TITLE_MAX = 80;
/** The tool that scaffolds a project: its `name` argument is the project it built. */
const NEW_PROJECT_TOOL = "new_project";

type ProjectThreadMeta = { kind?: string; project?: string | null; archived?: boolean };

const metaOf = (thread: ConversationRecord): ProjectThreadMeta => (thread.metadata ?? {}) as ProjectThreadMeta;

/** A live project chat bound to a folder. */
function isBoundProjectThread(meta: ProjectThreadMeta): meta is ProjectThreadMeta & { project: string } {
  return meta.kind === ThreadKind.Project && Boolean(meta.project) && !meta.archived;
}

/** A live project chat bound to nothing yet: a draft. */
function isUnboundProjectThread(meta: ProjectThreadMeta): boolean {
  return meta.kind === ThreadKind.Project && !meta.project && !meta.archived;
}

export class ProjectThreadService {
  readonly #core: StudioCore;

  constructor(core: StudioCore) {
    this.#core = core;
  }

  async threadForProject(project: string): Promise<string> {
    const threads = (await this.#core.store.listThreads())
      .filter((t) => {
        const meta = metaOf(t);
        return meta.kind === ThreadKind.Project && meta.project === project && !meta.archived;
      })
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    const primary = (await this.#core.projects.presentation(project)).primaryThreadId;
    const current = threads.find((thread) => thread.id === primary) ?? threads[0];
    if (current) {
      if (primary !== current.id) await this.#core.projects.rememberThread(project, current.id);
      return current.id;
    }
    const id = await this.#core.store.createThread({
      title: NEW_CHAT_TITLE,
      metadata: { kind: ThreadKind.Project, project },
    });
    await this.#core.projects.rememberThread(project, id);
    this.#core.emit(UiEvent.ThreadCreated, { threadId: id, project });
    await this.#core.projects.touch(project).catch(() => {});
    return id;
  }

  /**
   * A project always reuses its canonical conversation. Unbound drafts remain a legacy API
   * for existing callers; the desktop creates a named folder before opening its conversation.
   */
  async createProjectThread(project?: string): Promise<string> {
    const threads = await this.#core.store.listThreads();
    if (project) return this.#core.threadForProject(project);
    for (const thread of threads) {
      if (!isUnboundProjectThread(metaOf(thread))) continue;
      if (await this.threadIsEmpty(thread.id)) return thread.id;
    }
    const id = await this.#core.store.createThread({
      title: NEW_PROJECT_TITLE,
      metadata: { kind: ThreadKind.Project, project: null },
    });
    this.#core.emit(UiEvent.ThreadCreated, { threadId: id, project: null });
    return id;
  }

  /** Retitle a chat. The record is the index; `thread_updated` is the durable truth. */
  async renameThread(threadId: string, title: string): Promise<ConversationRecord> {
    const next = title.trim().slice(0, THREAD_TITLE_MAX);
    if (!next) throw new Error(MESSAGE.chatNeedsName);
    const record = await this.#core.store.updateThread(threadId, { title: next });
    this.#core.emit(UiEvent.ThreadUpdated, { threadId, title: next });
    return record;
  }

  /** Nothing but the `thread_created` event — nobody has spoken in this chat yet. */
  async threadIsEmpty(threadId: string): Promise<boolean> {
    const events = await this.#core.store.listEvents(threadId).catch(() => []);
    return events.every((e) => e.data.type === EventKind.ThreadCreated);
  }

  async bindThreadToProject(threadId: string, project: string): Promise<void> {
    await this.#core.store.getRecord(threadId);
    // Keep the first-ask title (or "New chat"). Naming the chat after the folder made every
    // row in that folder identical — the rail then had nothing to tell chats apart.
    // updateThread merges: only the keys this changes, so a stale copy never overwrites others.
    await this.#core.store.updateThread(threadId, { metadata: { kind: ThreadKind.Project, project } });
    this.#core.emit(UiEvent.ThreadBound, { threadId, project });
  }

  /**
   * Adopt chats the old binding gap orphaned. A chat that scaffolded a project but was never named
   * after it shows up as a permanent "New project" row holding a real conversation, while the project
   * it built answers to a different, empty chat. Both halves are repaired here — the chat is
   * bound to the project it actually built, and the empty stand-in is archived. Anything ambiguous
   * (two chats with real history claiming one project) is left exactly as it is: the point is to
   * recover history, never to choose between two of them.
   */
  async adoptOrphanedProjectThreads(): Promise<void> {
    const projects = new Set((await this.#core.projects.list()).map((g) => g.name));
    if (projects.size === 0) return;
    const threads = await this.#core.store.listThreads();
    const bound = new Map<string, ConversationRecord>();
    for (const t of threads) {
      const m = metaOf(t);
      if (isBoundProjectThread(m)) bound.set(m.project, t);
    }

    for (const thread of threads) {
      if (!isUnboundProjectThread(metaOf(thread))) continue;
      const events = await this.#core.store.listEvents(thread.id).catch(() => []);
      const project = this.projectBuiltIn(events, projects);
      if (!project) continue;
      if (await this.#adopt(thread, project, bound.get(project))) bound.set(project, thread);
    }
  }

  /** Bind an orphaned chat to the project it built, archiving an empty stand-in; false when both have history. */
  async #adopt(thread: ConversationRecord, project: string, incumbent: ConversationRecord | undefined) {
    if (incumbent) {
      if (!(await this.threadIsEmpty(incumbent.id))) return false; // two real chats — not ours to merge
      await this.#core.store.updateThread(incumbent.id, { metadata: { archived: true } });
    }
    await this.#core.bindThreadToProject(thread.id, project);
    await this.#core.append([customEventData(CustomEvent.ThreadAdopted, { threadId: thread.id, project })]);
    return true;
  }

  /** The project a chat actually worked in, read back off its own log. */
  projectBuiltIn(events: EventEnvelope[], projects: Set<string>): string | null {
    let found: string | null = null;
    for (const event of events) {
      const data = event.data as { type?: string; request?: { name?: string; arguments?: Record<string, unknown> } };
      if (data.type !== EventKind.ToolRequested) continue;
      const args = data.request?.arguments ?? {};
      const named = data.request?.name === NEW_PROJECT_TOOL ? args.name : args.project;
      if (typeof named === "string" && projects.has(named)) found = named;
    }
    return found;
  }
}
