/**
 * Where the native project view paints. Live runs the project in a native view that main lays over the
 * stage's slot (`panels/stage/native-bounds.ts`), above the whole page: no z-index lifts anything
 * over it, so what floats beside the stage (a tooltip) keeps off it instead. The slot carries
 * `data-native-view` while the view shows there.
 */

/** The attribute the stage's slot carries while the native project view paints over it. */
export const NATIVE_VIEW_ATTRIBUTE = "data-native-view";
/** How far what floats beside the native view keeps from its edge, so it never touches the project. */
const CLEARANCE_PX = 4;

/** A rectangle in the page's pixels, as `getBoundingClientRect` gives it. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The window's size in the page's pixels. */
export interface Viewport {
  width: number;
  height: number;
}

/** How far from each edge of the window a floating box stays (a Radix `collisionPadding`). */
export type EdgePadding = Partial<Record<"top" | "right" | "bottom" | "left", number>>;

/** Where the native project view paints now, or null while it shows nowhere. */
export function nativeViewBox(): Box | null {
  return document.querySelector(`[${NATIVE_VIEW_ATTRIBUTE}]`)?.getBoundingClientRect() ?? null;
}

/**
 * How far from the window's edges something floating beside `trigger` stays to keep off the native
 * view `view`: short of the view's edge on the side the trigger stands, the side with more room when
 * it stands off a corner. Nothing when the trigger is over the view itself.
 */
export function paddingOffView(trigger: Box, view: Box, viewport: Viewport): EdgePadding {
  const sides = [
    {
      beside: trigger.right <= view.left,
      room: view.left * viewport.height,
      padding: { right: viewport.width - view.left + CLEARANCE_PX },
    },
    {
      beside: trigger.left >= view.right,
      room: (viewport.width - view.right) * viewport.height,
      padding: { left: view.right + CLEARANCE_PX },
    },
    {
      beside: trigger.bottom <= view.top,
      room: viewport.width * view.top,
      padding: { bottom: viewport.height - view.top + CLEARANCE_PX },
    },
    {
      beside: trigger.top >= view.bottom,
      room: viewport.width * (viewport.height - view.bottom),
      padding: { top: view.bottom + CLEARANCE_PX },
    },
  ].filter((side) => side.beside);
  const roomiest = sides.reduce<(typeof sides)[number] | null>(
    (best, side) => (best && best.room >= side.room ? best : side),
    null,
  );
  return roomiest?.padding ?? {};
}

/** How far from the window's edges a tooltip opening at `trigger` now stays to keep off the native view. */
export function paddingOffNativeView(trigger: Element | null): EdgePadding {
  const view = nativeViewBox();
  if (!trigger || !view) return {};
  return paddingOffView(trigger.getBoundingClientRect(), view, { width: innerWidth, height: innerHeight });
}
