/**
 * The strip's Play/Stop: one button that stops the Live project (it then runs no scripts, frames or
 * sound, `stopPreview`) and plays it again (the same page, `playPreview`), with a spinner in its
 * place while either is under way. Whether the project is stopped is main's to say, on every probe.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { type Notify, ToastTone } from "../../state/toasts.ts";
import { problemWords } from "../../words.ts";
import { useProjectSound } from "./project-sound.ts";
import type { useLiveLoad } from "./live-load.ts";
import { useLoaderPresence } from "./loader-presence.ts";

/** Where the Live project is, as the Play/Stop button shows it. */
export const LiveRun = {
  Running: "running",
  Stopping: "stopping",
  Stopped: "stopped",
  Starting: "starting",
} as const;
export type LiveRun = (typeof LiveRun)[keyof typeof LiveRun];

/** The button's state: a press under way first, then what main last said. */
export function liveRun(at: { stopped: boolean; stopping: boolean; starting: boolean }): LiveRun {
  if (at.stopping) return LiveRun.Stopping;
  if (at.starting) return LiveRun.Starting;
  return at.stopped ? LiveRun.Stopped : LiveRun.Running;
}

/** Full screen has something to fill only while the running project itself is on the stage. */
export function fullScreenOffered(stage: { run: LiveRun; live: boolean; loading: boolean; empty: boolean }): boolean {
  return stage.run === LiveRun.Running && stage.live && !stage.loading && !stage.empty;
}

/** Play/Stop for this project's Live: its state and the press. */
export function useLiveRun(
  project: string | null,
  live: ReturnType<typeof useLiveLoad>,
  onNotice: Notify,
): { run: LiveRun; toggle: () => void } {
  const [stopping, setStopping] = useState(false);
  const [starting, setStarting] = useState(false);
  const { stopped, setStopped, loadLive } = live;
  const loading = Boolean(project && live.liveLoad?.project === project);
  // Starting lasts until the page Play asked for is on the stage.
  useEffect(() => {
    if (starting && !loading) setStarting(false);
  }, [starting, loading]);
  const run = liveRun({ stopped, stopping, starting });
  const toggle = useCallback(() => {
    if (!project) return;
    if (run === LiveRun.Running) {
      setStopping(true);
      window.studio
        .stopPreview()
        .then(() => setStopped(true))
        .catch((err: unknown) => onNotice(problemWords(err), ToastTone.Error))
        .finally(() => setStopping(false));
      return;
    }
    if (run !== LiveRun.Stopped) return;
    setStarting(true);
    setStopped(false);
    loadLive(project, () => window.studio.playPreview()).catch((err: unknown) => {
      setStopped(true);
      setStarting(false);
      onNotice(problemWords(err), ToastTone.Error);
    });
  }, [project, run, setStopped, loadLive, onNotice]);
  return { run, toggle };
}

/**
 * The project's controls on the stage: Play/Stop, the sound, full screen while the running project is
 * on the stage, and the loader over a load (`loader-presence.ts`). `stage` says what the stage
 * shows: Live in sight, a page still loading, the empty scaffold.
 */
export function useStageControls(
  project: string | null,
  live: ReturnType<typeof useLiveLoad>,
  stage: { onLive: boolean; loading: boolean; empty: boolean },
  onNotice: Notify,
) {
  const { run, toggle } = useLiveRun(project, live, onNotice);
  const sound = useProjectSound();
  const loader = useLoaderPresence(stage.loading);
  const { onLive, empty } = stage;
  const covering = loader.covering;
  return useMemo(
    () => ({
      run: { state: run, toggle },
      sound,
      loader,
      fullScreen: {
        offered: fullScreenOffered({ run, live: onLive, loading: covering, empty }),
        enter: () => void window.studio.previewFullScreen(),
      },
    }),
    [run, toggle, sound, loader, onLive, covering, empty],
  );
}
