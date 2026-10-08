/**
 * Taking a picture of a preview for an agent: the surface asked for and the one the port says it
 * took, in the words the model was given.
 */
import type { PreviewPixelStats, PreviewPort } from "../../substrate/preview-port.ts";
import { CaptureSurface } from "../../shared/preview-contract.ts";

/** JPEG quality of a look at the project, when the caller names none. */
export const DEFAULT_SHOT_QUALITY = 80;
/** JPEG quality of a crop cut from a judged frame or a resized still, when the caller names none. */
export const DEFAULT_STILL_QUALITY = 85;
/** Height of a LEFT | RIGHT reference pair, when the caller names none. */
export const DEFAULT_PAIR_HEIGHT = 360;
/** JPEG quality of a LEFT | RIGHT reference pair. */
export const PAIR_QUALITY = 80;
/** How long a camera switch settles before the page's state is read or the picture taken. */
export const CAMERA_SETTLE_MS = 60;

/**
 * A studio that cannot see outside the canvas answers this, never null: one shape to read.
 *
 * It is deliberately NOT a `PageUi` (`substrate/page-ui.ts`): `viewport: null` says the studio
 * could not look, where `{ width: 0, height: 0 }` would claim it looked and found nothing. The
 * port's own answer is already folded by `readPageUi` inside `ProjectPreview.pageUi()`, so this
 * call passes it through rather than folding a second time. `CaptureSurface` itself is the
 * preview contract's (`shared/preview-contract.ts`); nothing about a surface is re-declared here.
 */
export const NO_PAGE_UI = { entries: [] as string[], coverage: 0, canvas: null, viewport: null, uiPrimary: false };

/** An encoded still as an RPC answers it: where it was saved, and the bytes. */
export function encodedJpeg<P extends string | null>(jpeg: Buffer, path: P) {
  return { path, base64: jpeg.toString("base64"), bytes: jpeg.length };
}

/**
 * One capture, on the surface the caller asked for. A port that predates the surface option
 * still takes the picture — the legacy `page` flag carries the one case it understood — and a
 * port with no stats at all still yields the frame, which is the only thing a look must never
 * lose. `surface` in the answer is what the port says it took, or the concrete thing that was
 * asked for; `auto` resolved by a silent port is reported as nothing, not as a guess.
 */
export async function captureSurface(
  port: PreviewPort,
  quality: number,
  surface: CaptureSurface,
): Promise<{ jpeg: Buffer; stats: PreviewPixelStats | null; surface: CaptureSurface | null }> {
  if (!port.screenshotWithStats) return { jpeg: await port.screenshot(quality), stats: null, surface: null };
  const shot = await port.screenshotWithStats(quality, {
    surface,
    ...(surface === CaptureSurface.Page ? { page: true } : {}),
  });
  const took = shot.surface ?? (surface === CaptureSurface.Auto ? null : surface);
  return { jpeg: shot.jpeg, stats: shot.stats ?? null, surface: took };
}

/**
 * Did that frame come back from the whole page? Only `surface` says so. `stats.source` reports
 * WHICH PATH read the frame (`page` = the page read its own canvas, `compositor` = Electron's
 * capturePage), not which surface was photographed, so a plain canvas read reports `page` there
 * and reading it here claimed the DOM was in nearly every picture (M4.9a).
 */
export function tookPage(shot: { stats: PreviewPixelStats | null; surface: CaptureSurface | null }): boolean {
  return shot.surface === CaptureSurface.Page;
}

/** The studio's surfaces in the words the model was given; `auto` has no word. */
const SURFACE_WORDS: Record<CaptureSurface, string | null> = {
  [CaptureSurface.Page]: "screen",
  [CaptureSurface.Canvas]: "canvas",
  [CaptureSurface.Auto]: null,
};

/** The surfaces the model may name, as the preview names them. */
const REQUESTED_SURFACES: Record<"screen" | "canvas", CaptureSurface> = {
  screen: CaptureSurface.Page,
  canvas: CaptureSurface.Canvas,
};

/** The studio's word for a surface (`page`) in the words the model was given (`screen`). */
export function surfaceWord(surface: CaptureSurface | null): string | null {
  if (!surface || !Object.hasOwn(SURFACE_WORDS, surface)) return null;
  return SURFACE_WORDS[surface];
}

/** A computer request's surface as the preview names it; nothing asked means the studio picks. */
export function requestedSurface(request: { surface?: "screen" | "canvas" }): CaptureSurface {
  if (!request.surface || !Object.hasOwn(REQUESTED_SURFACES, request.surface)) return CaptureSurface.Auto;
  return REQUESTED_SURFACES[request.surface];
}
