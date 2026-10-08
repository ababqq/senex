import { type JSX, useState } from "react";
import type { AgentScreenFrame } from "../../shared/agent-screen.ts";
import { capWords } from "../run-steps.ts";
import { Elapsed, useStartedAt } from "../ui/LoadingState.tsx";
import { BuildCard } from "./BuildCard.tsx";

/**
 * A build running while the chat itself is free — the only thing the chat shows for it. Its one
 * line is what is happening now, one thing at a time; the picture is the lead's own view of the
 * project, small, once there is something in it to see. Its clock sits on the right: how long it has
 * run, and under it the most it was given ("up to 10h"), a cap the build may finish well inside.
 * The whole card opens Builds.
 */
export function BuildStatus({
  since,
  budgetMs,
  caption,
  frame,
  onOpenBuilds,
}: {
  since?: number;
  /** the time the build was given, when it was given one */
  budgetMs?: number | null;
  caption: string;
  frame?: AgentScreenFrame;
  onOpenBuilds?: () => void;
}): JSX.Element {
  // Ticks every second without re-rendering the card.
  const startedAt = useStartedAt(since);
  // A first picture arriving while the card is on show slides in; one already there is simply there.
  const [arrives] = useState(!frame);
  return (
    <section data-build-status aria-label="Build running" className="min-w-0">
      <BuildCard
        title="Building"
        {...(frame
          ? {
              picture: (
                <img
                  src={`data:image/jpeg;base64,${frame.jpeg}`}
                  alt=""
                  draggable={false}
                  className={`h-[55px] w-[88px] shrink-0 rounded-[10px] bg-inset object-cover ${arrives ? "build-picture-in" : ""}`}
                />
              ),
            }
          : {})}
        {...(onOpenBuilds ? { open: { onClick: onOpenBuilds } } : {})}
        line={
          <p role="status" title={caption} className="m-0 truncate text-chat-sub text-ink-3">
            {caption}
          </p>
        }
        aside={
          <p className="m-0 shrink-0 pe-2 text-end text-chat-sub">
            <span className="block min-h-[1lh] text-ink">
              <Elapsed since={startedAt} />
            </span>
            {budgetMs ? <span className="block text-ink-3">{capWords(budgetMs)}</span> : null}
          </p>
        }
      />
    </section>
  );
}
