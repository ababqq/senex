/**
 * Home's composer model: what a new project's chat would open with. Home reads the last model and
 * effort picked in any project chat, every time it opens, and a pick made there is the next project's
 * (`stored-model.ts`); its own key is forgotten so it never keeps a stale pick of its own.
 */
import { useState } from "react";
import { ThreadKind } from "../../shared/event-log.ts";
import { useComposerModel } from "../chat/use-composer-model.ts";
import { safeStorage, storageKeyFor, type KeyValueStorage } from "../storage.ts";
import type { EngineDescriptor, ThreadMeta } from "../types.ts";

/** The chat home's composer stands in for: a project chat with no project yet. */
const HOME_CHAT: { id: string; meta: ThreadMeta } = { id: "home", meta: { kind: ThreadKind.Project, project: null } };

/** Home opens on the last project pick, not on one it pinned the last time it was open. */
function forgetHomePick(storage: KeyValueStorage): typeof HOME_CHAT {
  storage.removeItem(storageKeyFor.threadModel(HOME_CHAT.id));
  storage.removeItem(storageKeyFor.threadEffort(HOME_CHAT.id));
  return HOME_CHAT;
}

/** The model, effort and roles home's first message is sent with. */
export function useHomeComposerModel(engines: EngineDescriptor[], onEnginesRefresh: () => void) {
  const [storage] = useState(safeStorage);
  const [thread] = useState(() => forgetHomePick(storage));
  return useComposerModel({ thread, engines, onEnginesRefresh, storage });
}
