/**
 * When the stage's loader shows. A load that finishes within the first moments shows nothing (the
 * app's own rule for waits, `ui/Pending.tsx`); one that shows the loader keeps it up long enough
 * to be read, then fades it out before the project is uncovered, because the native project view cannot
 * fade in itself.
 */
import { useEffect, useRef, useState } from "react";
import { SECOND_MS } from "../../../shared/duration.ts";

/** A load shorter than this shows no loader: the same moment `Pending` waits before it shows. */
export const LOADER_DELAY_MS = 0.4 * SECOND_MS;
/** A loader that shows stays at least this long. */
export const LOADER_MIN_MS = 0.6 * SECOND_MS;
/** Its fade out, before the project is uncovered. */
export const LOADER_FADE_MS = 0.15 * SECOND_MS;

/** Where the loader is: not there, waiting out the delay, shown, or fading out. */
export const LoaderPhase = { Hidden: "hidden", Waiting: "waiting", Shown: "shown", Leaving: "leaving" } as const;
export type LoaderPhase = (typeof LoaderPhase)[keyof typeof LoaderPhase];

/**
 * The loader's next phase and how long until it, from its phase, whether a load is under way, and
 * how long it has been shown; null while nothing is due to change.
 */
export function loaderNext(
  phase: LoaderPhase,
  loading: boolean,
  shownFor: number,
): { phase: LoaderPhase; after: number } | null {
  if (phase === LoaderPhase.Hidden) return loading ? { phase: LoaderPhase.Waiting, after: 0 } : null;
  if (phase === LoaderPhase.Waiting)
    return loading ? { phase: LoaderPhase.Shown, after: LOADER_DELAY_MS } : { phase: LoaderPhase.Hidden, after: 0 };
  if (phase === LoaderPhase.Shown)
    return loading ? null : { phase: LoaderPhase.Leaving, after: Math.max(0, LOADER_MIN_MS - shownFor) };
  return loading ? { phase: LoaderPhase.Shown, after: 0 } : { phase: LoaderPhase.Hidden, after: LOADER_FADE_MS };
}

/**
 * The loader for `loading`: whether it is drawn, whether it is fading out, and whether it still
 * covers the stage (the load itself, or the loader on its way out).
 */
export function useLoaderPresence(loading: boolean): { shown: boolean; leaving: boolean; covering: boolean } {
  const [phase, setPhase] = useState<LoaderPhase>(LoaderPhase.Hidden);
  const shownAt = useRef(0);
  useEffect(() => {
    const next = loaderNext(phase, loading, Date.now() - shownAt.current);
    if (!next) return;
    const timer = setTimeout(() => {
      if (next.phase === LoaderPhase.Shown && phase === LoaderPhase.Waiting) shownAt.current = Date.now();
      setPhase(next.phase);
    }, next.after);
    return () => clearTimeout(timer);
  }, [phase, loading]);
  const shown = phase === LoaderPhase.Shown || phase === LoaderPhase.Leaving;
  return { shown, leaving: phase === LoaderPhase.Leaving, covering: loading || shown };
}
