import { BrowserWindow } from "electron";
import { coverFragment, COVER_VERTEX } from "../shared/cover-shader.ts";
import { createCoverPainter } from "../shared/cover-painter.ts";
import { coverShaderSeed } from "../shared/cover-recipe.ts";
import { SECOND_MS } from "../shared/duration.ts";

/** How long a cover may take to render before the previous one is kept. */
const COVER_RENDER_TIMEOUT_MS = 8 * SECOND_MS;
/** The cover's size in pixels, both ways. */
const COVER_SIZE_PX = 128;

/** Why a cover was not replaced, as the user reads it. */
const MESSAGE = {
  noImage: "Cover rendering produced no image.",
  timedOut: "Cover rendering timed out; the previous cover was kept.",
} as const;

/** One short-lived sandbox, no preload or external resources; never evaluates generated JS. */
export async function renderProjectCover(surface: string, seed: number): Promise<string> {
  const fragment = coverFragment(surface);
  const shaderSeed = coverShaderSeed(seed);
  const win = new BrowserWindow({
    width: COVER_SIZE_PX,
    height: COVER_SIZE_PX,
    show: false,
    focusable: false,
    skipTaskbar: true,
    fullscreenable: false,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webgl: true,
      backgroundThrottling: false,
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        await win.loadURL(
          "data:text/html,<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'none'\">",
        );
        // Source is a JSON string passed to WebGL's compiler inside fixed host code.
        const result = (await win.webContents.executeJavaScript(`(() => {
          let painter;
          try {
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
            painter = (${createCoverPainter.toString()})(canvas, ${JSON.stringify(COVER_VERTEX)});
            const program = painter.compile(${JSON.stringify(fragment)});
            painter.draw(program, 1.0, ${JSON.stringify(shaderSeed)});
            painter.draw(program, 0.0, ${JSON.stringify(shaderSeed)});
            return {poster:canvas.toDataURL('image/png')};
          } catch (error) { return {error:error.message}; }
          finally { painter?.dispose(); }
        })()`)) as { poster?: string; error?: string };
        if (result.error || !result.poster) throw new Error(result.error ?? MESSAGE.noImage);
        return result.poster;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(MESSAGE.timedOut)), COVER_RENDER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (!win.isDestroyed()) win.destroy();
  }
}
