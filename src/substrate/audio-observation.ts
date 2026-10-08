/** Per-file evidence from Chromium's media stream, not physical speaker output. */
import type { AudioPlaybackEvidence } from "../shared/audio-observation.ts";

/**
 * Serialized into the authorized preview. Never starts the project's media or changes its volume.
 *
 * It runs from its own source text (`observeMediaPlayback.toString()`, studio-core), so
 * everything it uses — its limits included — is declared inside it: a helper or a constant of
 * this module would not exist in the page.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: evaluated in the page from its own source, so it stays one self-contained function
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: evaluated in the page from its own source, so it stays one self-contained function
export async function observeMediaPlayback(files: string[]): Promise<AudioPlaybackEvidence[]> {
  const RESUME_TIMEOUT_MS = 1000;
  const METER_FFT_SIZE = 2048;
  const METER_READS = 20;
  const METER_READ_INTERVAL_MS = 25;
  /** Below this RMS the stream is silence, not a quiet sound. */
  const SILENCE_RMS = 0.0001;
  const results: AudioPlaybackEvidence[] = [];
  for (const file of files) {
    const url = new URL(file, location.href).href;
    const elements = [...document.querySelectorAll<HTMLMediaElement>("audio,video")].filter(
      (e) => e.currentSrc === url || e.src === url,
    );
    if (!elements.length) {
      results.push({
        file,
        state: "unavailable",
        rms: null,
        advancedSeconds: 0,
        detail:
          "No matching HTML media element; detached players and Web Audio buffers are not observed by this probe.",
      });
      continue;
    }
    // Do not mistake another playing element for this delivered file.
    let best: AudioPlaybackEvidence | undefined;
    for (const element of elements) {
      let context: AudioContext | undefined;
      let stream: MediaStream | undefined;
      const result: AudioPlaybackEvidence = {
        file,
        state: "unavailable",
        rms: null,
        advancedSeconds: 0,
        detail: "Media stream capture unavailable.",
      };
      try {
        if (element.error) {
          result.state = "failed";
          result.detail = `Media decode/network error ${element.error.code}`;
        } else if (element.muted || element.volume === 0) {
          result.state = "muted";
          result.detail = "The matched media element is muted or has zero volume.";
        } else if (element.paused || element.ended) {
          result.state = "paused";
          result.detail = "Media is paused, ended, or has not started; autoplay permission is not inferred.";
        } else {
          const capture = (element as HTMLMediaElement & { captureStream?: () => MediaStream }).captureStream;
          if (capture) {
            stream = capture.call(element);
            if (stream.getAudioTracks().length) {
              context = new AudioContext();
              let resumeTimer: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([
                  context.resume(),
                  new Promise<never>((_, reject) => {
                    resumeTimer = setTimeout(
                      () => reject(new Error("Audio measurement context did not start")),
                      RESUME_TIMEOUT_MS,
                    );
                  }),
                ]);
              } finally {
                clearTimeout(resumeTimer);
              }
              const source = context.createMediaStreamSource(stream);
              const meter = context.createAnalyser();
              meter.fftSize = METER_FFT_SIZE;
              source.connect(meter);
              const samples = new Float32Array(meter.fftSize);
              const before = element.currentTime;
              let peakRms = 0;
              for (let sample = 0; sample < METER_READS; sample++) {
                await new Promise((resolve) => setTimeout(resolve, METER_READ_INTERVAL_MS));
                meter.getFloatTimeDomainData(samples);
                const rms = Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length);
                if (Number.isFinite(rms)) peakRms = Math.max(peakRms, rms);
              }
              result.rms = peakRms;
              result.advancedSeconds = Math.max(0, element.currentTime - before);
              const playbackError = element.error as MediaError | null;
              if (playbackError) {
                result.state = "failed";
                result.detail = `Media error ${playbackError.code}`;
              } else if ((element.currentSrc || element.src) !== url) {
                result.state = "unavailable";
                result.detail = "Media source changed during observation.";
              } else if (element.muted || element.volume === 0) {
                result.state = "muted";
                result.detail = "Media became muted during observation.";
              } else if (context.state !== "running") {
                result.state = "unavailable";
                result.detail = "The measurement AudioContext did not run.";
              } else if (result.advancedSeconds <= 0) {
                result.state = "paused";
                result.detail = "Playback did not advance during observation (including loop boundaries).";
              } else {
                result.state = peakRms > SILENCE_RMS ? "playing" : "silent";
                result.detail =
                  result.state === "playing"
                    ? "Non-silent per-file media stream and advancing playback observed; physical output and downstream Web Audio routing are not certified."
                    : "Playback advanced but no non-silent signal was measured.";
              }
            } else result.detail = "The matching media stream has no observable audio track.";
          }
        }
      } catch (error) {
        result.state = "unavailable";
        result.detail = `Audio measurement unavailable: ${String(error)}`;
      } finally {
        for (const track of stream?.getTracks() ?? []) track.stop();
        if (context) await context.close().catch(() => {});
      }
      if (!best || result.state === "playing") best = result;
      if (result.state === "playing") break;
    }
    if (best) results.push(best);
  }
  return results;
}
