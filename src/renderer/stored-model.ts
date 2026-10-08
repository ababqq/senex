import { ThreadKind } from "../shared/event-log.ts";
import { modelKey } from "./model-key.ts";
import { STORAGE_KEYS, storageKeyFor } from "./storage.ts";
import type { ThreadMeta } from "./types.ts";

export const LAST_MODEL_KEY = STORAGE_KEYS.lastModel;
export const STUDIO_CHAT_MODEL_KEY = STORAGE_KEYS.studioChatModel;
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/** Studio's assistant keeps its own model, effort and context choices apart from project chats. */
export function modelStoreKeys(studio: boolean): {
  effort: (key: string | null) => string;
  preferences: (key: string | null) => string;
} {
  return {
    effort: (key) => storageKeyFor.effort(studio, key),
    preferences: (key) => storageKeyFor.preferences(studio, key),
  };
}

/** Existing chats keep their own pick. Only a fresh chat inherits the last selection; Studio
 * starts from it once and then remembers its own. */
export function storedChatModel(storage: Storage, threadId: string, meta: ThreadMeta): string | null {
  if (meta.kind !== ThreadKind.Project)
    return storage.getItem(STUDIO_CHAT_MODEL_KEY) ?? storage.getItem(LAST_MODEL_KEY);
  return (
    storage.getItem(storageKeyFor.threadModel(threadId)) ??
    (meta.lastEngine ? modelKey(meta.lastEngine, meta.lastModel ?? "") : storage.getItem(LAST_MODEL_KEY))
  );
}

/** A Studio pick never becomes the model new projects inherit. */
export function rememberChatModel(storage: Storage, threadId: string, key: string, studio = false): void {
  if (studio) {
    storage.setItem(STUDIO_CHAT_MODEL_KEY, key);
    return;
  }
  storage.setItem(storageKeyFor.threadModel(threadId), key);
  storage.setItem(LAST_MODEL_KEY, key);
}

/**
 * The effort a chat opens with. A project chat keeps its own: the one picked in it, else the one its
 * last turn ran at, else the effort saved for its model (which seeds fresh chats), else the last
 * effort picked anywhere. Studio's assistant keeps only its per-model effort.
 */
export function storedChatEffort(
  storage: Storage,
  thread: { id: string; meta: ThreadMeta },
  modelKey: string | null,
): string | null {
  const studio = thread.meta.kind !== ThreadKind.Project;
  const saved = storage.getItem(storageKeyFor.effort(studio, modelKey));
  if (studio) return saved;
  return (
    storage.getItem(storageKeyFor.threadEffort(thread.id)) ??
    thread.meta.lastEffort ??
    saved ??
    storage.getItem(STORAGE_KEYS.effort) ??
    null
  );
}

/** A project chat's effort pick is its own; null forgets it, so the chat falls back as it opens. */
export function rememberChatEffort(
  storage: Storage & Pick<globalThis.Storage, "removeItem">,
  threadId: string,
  value: string | null,
): void {
  if (value) storage.setItem(storageKeyFor.threadEffort(threadId), value);
  else storage.removeItem(storageKeyFor.threadEffort(threadId));
}
