import { useEffect, useRef } from "react";
import type { PromptBarHandle } from "../ui/PromptBar.tsx";

/**
 * The composer a new project's chat opens with focus in, and the idea typed at the welcome that
 * waits for home's composer (or, failing that, the next project's). Once the chat is on screen and
 * loaded, the cursor goes in.
 */
export function useComposerHandoff(contentReady: boolean, activeThreadId: string | null) {
  const composer = useRef<PromptBarHandle>(null);
  const focusComposerFor = useRef<string | null>(null);
  // First launch: the welcome covers the app; the idea typed there waits for the first project's composer.
  const pendingIdea = useRef<string | null>(null);
  const composeFor = useRef<{ threadId: string; text: string } | null>(null);
  useEffect(() => {
    if (!contentReady || !activeThreadId) return;
    if (focusComposerFor.current !== activeThreadId) return;
    focusComposerFor.current = null;
    const idea = composeFor.current?.threadId === activeThreadId ? composeFor.current.text : null;
    composeFor.current = null;
    requestAnimationFrame(() => (idea ? composer.current?.compose(idea) : composer.current?.focus()));
  }, [contentReady, activeThreadId]);
  // Home's composer: its own, since the chat's stays mounted beneath home.
  const homeComposer = useRef<PromptBarHandle>(null);
  return {
    composer,
    homeComposer,
    /** The welcome's idea, for the composer that opens next: home's, or a project chat's. */
    holdIdea: (idea: string | null) => {
      pendingIdea.current = idea;
    },
    /** Home takes the welcome's idea, once. */
    takeIdea: (): string | null => {
      const idea = pendingIdea.current;
      pendingIdea.current = null;
      return idea;
    },
    /** Put the cursor (and a waiting idea) in this chat's composer once it is on screen. */
    focusWhenOpen: (threadId: string) => {
      focusComposerFor.current = threadId;
      if (pendingIdea.current) composeFor.current = { threadId, text: pendingIdea.current };
      pendingIdea.current = null;
    },
    /** Put the cursor in this chat's composer once it is on screen. */
    focusOnly: (threadId: string) => {
      focusComposerFor.current = threadId;
    },
  };
}

/** The composer handoff the navigation and the welcome's exit share. */
export type ComposerHandoff = ReturnType<typeof useComposerHandoff>;
