/**
 * The shim bundle's entry — bundled by scripts/build.mjs into
 * dist/resources/vendor/studio/shim.js and served as the first script of every project page.
 *
 * It reads the options the serve layer baked into its own script tag and installs the shim
 * before any project code runs. The hook (M4.2a) and the capture and draw counters (M4.9a) attach
 * themselves to the same facade later; nothing here has to know about them.
 */
import { installStudioShim } from "./shim.ts";

function readOptions() {
  try {
    const tag = document.currentScript ?? document.querySelector("script[data-studio-shim]");
    const raw = tag?.getAttribute("data-studio-options");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

installStudioShim(readOptions());
