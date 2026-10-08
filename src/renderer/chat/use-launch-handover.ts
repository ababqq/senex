/**
 * A project started from home sends its first message from its own chat, once that chat is open and
 * loaded: as if it had been typed there, so a plan to review, a Loop and pictures take the chat's
 * own routes. The words are put in the composer first, so a send the chat cannot make yet (no
 * model, a sign-in first) leaves them there instead of losing them. Then home may fade.
 */
import { type RefObject, useEffect, useRef } from "react";
import { useLaunch } from "../state/hooks.ts";
import { LaunchPhase } from "../state/launch.ts";
import { studio } from "../state/studio.ts";
import type { PromptBarHandle } from "../ui/PromptBar.tsx";
import type { Send } from "./use-submit.ts";

export function useLaunchHandover(
  threadId: string | undefined,
  loading: boolean,
  submit: Send,
  composer: RefObject<PromptBarHandle | null>,
): void {
  const launch = useLaunch((s) => s.launch);
  const handing = useRef<string | null>(null);
  const send = useRef(submit);
  send.current = submit;
  useEffect(() => {
    const ready = launch?.phase === LaunchPhase.Opened && launch.threadId === threadId && !loading;
    if (!launch || !ready || handing.current === launch.id) return;
    handing.current = launch.id;
    composer.current?.compose(launch.text);
    const handed = () => studio().launchHanded(launch.id);
    void send.current(launch.text, launch.extras).then(handed, handed);
  }, [launch, threadId, loading, composer]);
}
