/**
 * Which renderer the probe's Chromium draws with (S5). Headless Chromium with ANGLE on Metal first:
 * frame rates measured there say something about the project. When the GPU launch fails the probe falls
 * back to SwiftShader, a faithful but slow software rasteriser, and the frame-rate rows stop gating
 * (`gates: false`) because a software frame rate cannot be attributed to the project. The mode actually
 * used is read back from the page's WebGL renderer string, never assumed from the flags.
 */
import { RendererMode } from "../vocabulary.ts";

/** Flags every probe launch carries. */
const COMMON_ARGS = [
  "--disable-dev-shm-usage",
  "--hide-scrollbars",
  // Chromium quantises `performance.memory` as a fingerprinting defence, which leaves heap growth
  // unmeasurable over a soak; the probe fully instruments the page anyway.
  "--enable-precise-memory-info",
];

const MODE_ARGS: Record<RendererMode, readonly string[]> = {
  [RendererMode.Gpu]: ["--use-gl=angle", "--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
  [RendererMode.Software]: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
};

/** WebGL renderer strings that name a software rasteriser. */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|angle \(google/i;

/** The Chromium flags for a renderer mode, kept explicit so a scorecard can print the device profile. */
export function chromiumArgs(mode: RendererMode): string[] {
  return [...MODE_ARGS[mode], ...COMMON_ARGS];
}

/** The mode a WebGL renderer string reveals; `null` when the page never reported one. */
export function classifyRenderer(glRenderer: string | null): RendererMode | null {
  if (!glRenderer) return null;
  return SOFTWARE_RENDERER.test(glRenderer) ? RendererMode.Software : RendererMode.Gpu;
}

/** Whether frame-rate rows may gate: never on a software rasteriser. */
export function fpsRowsGate(mode: RendererMode): boolean {
  return mode === RendererMode.Gpu;
}

/** A launched browser and how it was launched. */
export interface LaunchOutcome<B> {
  browser: B;
  launched: RendererMode;
  /** The GPU launch failed and SwiftShader was used instead. */
  fellBack: boolean;
}

/** Launch for the requested mode; a failed GPU launch falls back to SwiftShader, a failed software one throws. */
export async function launchWithFallback<B>(
  launch: (mode: RendererMode) => Promise<B>,
  requested: RendererMode,
): Promise<LaunchOutcome<B>> {
  if (requested === RendererMode.Software) {
    return { browser: await launch(RendererMode.Software), launched: RendererMode.Software, fellBack: false };
  }
  try {
    return { browser: await launch(RendererMode.Gpu), launched: RendererMode.Gpu, fellBack: false };
  } catch {
    return { browser: await launch(RendererMode.Software), launched: RendererMode.Software, fellBack: true };
  }
}
