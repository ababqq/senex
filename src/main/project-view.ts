/**
 * What a project page's renderer is given: the `webPreferences` of every project view `preview.ts`
 * creates. Kept free of Electron so the settings are tested as values, not read out of source.
 */

/**
 * Blink features no project page gets. On-device speech recognition asks the browser for
 * `media.mojom.OnDeviceSpeechRecognition`, a binder only Chrome registers: Electron treats the
 * request as a bad Mojo message and kills the whole renderer (reason 123). An agent's diagnostic
 * probe did it six times on 2026-09-23 — `SpeechRecognition.available()` or `install()` with
 * `processLocally: true`, or `start()` on a recognizer with `processLocally` and a `lang`, is
 * enough. With these off, those members do not exist in any frame of the view, iframes and blob:
 * documents included, which a page-world stub cannot reach; plain `start()` still ends in a
 * `not-allowed` error because the microphone is never granted, and speech synthesis is untouched.
 * Chromium ignores a name it does not know, so the self test (`npm run test:e2e`) re-checks the
 * kill in real Electron, a cross-site frame included.
 */
export const PROJECT_DISABLED_BLINK_FEATURES = [
  "OnDeviceWebSpeechAvailable",
  "InstallOnDeviceSpeechRecognition",
] as const;

/** The project view's `webPreferences`, for the project session it is given. No preload, ever. */
export function projectViewPreferences<S>(projectSession: S, offscreen: boolean) {
  return {
    session: projectSession,
    offscreen,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    // Unattended runs must keep simulating while the window is occluded or in the background.
    backgroundThrottling: false,
    // Nobody clicks a hidden preview: an AudioContext must start without a gesture, or the
    // audio probes (`__studio.audio()`) measure silence forever.
    autoplayPolicy: "no-user-gesture-required" as const,
    disableBlinkFeatures: PROJECT_DISABLED_BLINK_FEATURES.join(","),
  };
}

/** The longest file name a download's console line repeats. */
const MAX_DOWNLOAD_NAME = 80;

/** What the studio does with a file the page starts downloading, and what the console is told. */
export interface DownloadDecision {
  cancel: boolean;
  note: string | null;
}

/**
 * Live is the person's window, and their own save dialog answers a download. A window an agent
 * drives has nobody to click it, so a "Download CSV" button would wait on a native dialog for the
 * rest of the night: the download is cancelled and the console names the file, so a judge can tell
 * a working Export button from a dead one.
 */
export function downloadDecision(offscreen: boolean, file: { name: string; mimeType: string }): DownloadDecision {
  if (!offscreen) return { cancel: false, note: null };
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters in a file name are replaced, not shown.
  const name = file.name.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, MAX_DOWNLOAD_NAME) || "a file";
  const kind = file.mimeType ? ` (${file.mimeType.slice(0, MAX_DOWNLOAD_NAME)})` : "";
  return {
    cancel: true,
    note: `a download of ${name}${kind} started and was not saved: the preview does not save files`,
  };
}
