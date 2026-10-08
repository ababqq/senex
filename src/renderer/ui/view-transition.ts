/**
 * Moving between home and a project as one change on screen: the browser's view transition holds
 * the old frame, the update is applied at once, and the two are animated into each other (named
 * parts such as the composer glide to their new place; styles in theme.css). Under Reduce Motion,
 * or where the browser has none, the update simply happens.
 */
import { flushSync } from "react-dom";
import { prefersReducedMotion } from "./media-queries.ts";

/** Apply `update` (a synchronous store change) as one animated change of the whole window. */
export function withViewTransition(update: () => void): void {
  if (typeof document.startViewTransition !== "function" || prefersReducedMotion()) {
    update();
    return;
  }
  document.startViewTransition(() => flushSync(update));
}
