/** The Builds tab's status bar, its Play button, and the zoom pill in the canvas corner. */
import type { JSX, ReactNode } from "react";
import { useState } from "react";
import type { statusLine } from "../../run-steps.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/icons.tsx";
import { TONE, WORKING_PULSE } from "../inspector/tone.tsx";

/** An earlier build on show: its name, and the way back to the latest one. */
export interface EarlierBuild {
  label: string;
  onLatest: () => void;
}

/**
 * The run in one line: a dot in its tone, the strong words and the rest — after the name of an
 * earlier build when one is shown, with Show latest beside it. Along its bottom edge, how much of
 * the time it was given a live run has used.
 */
export function BuildStatus({
  status,
  earlier,
  progress,
  action,
}: {
  status: ReturnType<typeof statusLine>;
  earlier: EarlierBuild | null;
  progress: number | null;
  action: ReactNode;
}): JSX.Element {
  const live = status.tone === "live";
  const shown = earlier ? `${earlier.label} · ` : "";
  return (
    <div
      data-testid="build-status"
      className="relative flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line pr-3 pl-4"
    >
      {/* How much of the time it was given the run has used — the same fact as "9 of 30 min". */}
      {progress !== null ? (
        <span
          aria-hidden="true"
          data-build-progress
          className="absolute bottom-[-1px] left-0 h-0.5 rounded-r-full bg-accent transition-[width] duration-500"
          style={{ width: `${progress * 100}%` }}
        />
      ) : null}
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-full"
        style={{
          background: status.tone === "live" ? "var(--accent)" : TONE[status.tone],
          animation: live ? WORKING_PULSE : undefined,
        }}
      />
      <p
        className="min-w-0 flex-1 truncate text-chat-sub text-ink"
        title={`${shown}${status.strong} · ${status.rest}`}
        role="status"
      >
        {earlier ? <span className="text-ink-3">{shown}</span> : null}
        <strong className="font-semibold">{status.strong}</strong>
        {status.rest ? <span className="text-ink-3"> · {status.rest}</span> : null}
      </p>
      {earlier ? (
        <Button variant="ghost" onClick={earlier.onLatest}>
          Show latest
        </Button>
      ) : null}
      {action}
    </div>
  );
}

/** Play the run's build in Live; it says Opening… until Live has it. */
export function PlayButton({
  label,
  quiet = false,
  onPlay,
}: {
  label: string;
  quiet?: boolean;
  onPlay: () => Promise<void> | void;
}): JSX.Element {
  const [opening, setOpening] = useState(false);
  return (
    <Button
      variant={quiet ? "secondary" : "default"}
      disabled={opening}
      onClick={async () => {
        setOpening(true);
        try {
          await onPlay();
        } finally {
          setOpening(false);
        }
      }}
    >
      <Icon name="arrow-up-right" size={13} />
      {opening ? "Opening…" : label}
    </Button>
  );
}

const ICON_BUTTON =
  "inline-flex size-[26px] cursor-pointer items-center justify-center rounded-[7px] text-ink-3 hover:bg-control-hover hover:text-control-text-hover focus-visible:outline-2 focus-visible:outline-accent";
const TEXT_BUTTON =
  "h-[26px] cursor-pointer rounded-[7px] px-2.5 font-mono text-xs text-ink-2 hover:bg-control-hover hover:text-control-text-hover focus-visible:outline-2 focus-visible:outline-accent";

/** Zoom out, the zoom level, zoom in, fit everything, and — while a run is live — jump back to its work. */
export function ZoomPill({
  pct,
  onOut,
  onIn,
  onFit,
  onNow,
}: {
  pct: number;
  onOut: () => void;
  onIn: () => void;
  onFit: () => void;
  onNow: (() => void) | null;
}): JSX.Element {
  return (
    <div
      className="absolute bottom-3 left-3 z-[3] flex h-8 items-center gap-0.5 rounded-[11px] bg-surface px-[3px] shadow-card"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <button type="button" aria-label="Zoom out" title="Zoom out" className={ICON_BUTTON} onClick={onOut}>
        <Icon name="minus" size={13} />
      </button>
      <span className="w-10 text-center font-mono text-xs text-ink-3 tabular-nums" aria-label={`Zoom ${pct}%`}>
        {pct}%
      </span>
      <button type="button" aria-label="Zoom in" title="Zoom in" className={ICON_BUTTON} onClick={onIn}>
        <Icon name="plus" size={13} />
      </button>
      <span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-line-strong" />
      <button type="button" title="Fit everything (0)" className={TEXT_BUTTON} onClick={onFit}>
        Fit
      </button>
      {onNow ? (
        <button type="button" className={`${TEXT_BUTTON} text-accent-ink`} onClick={onNow}>
          Jump to now
        </button>
      ) : null}
    </div>
  );
}
