/** Where the native project view sits: over the stage's slot, or nowhere while something else owns the stage. */
import type { RefObject } from "react";
import { useEffect } from "react";
import { NATIVE_VIEW_ATTRIBUTE } from "../../native-view.ts";
import { scheduleBounds } from "./bounds-schedule.ts";

type Bounds = { x: number; y: number; width: number; height: number };

/** The native view, out of sight. */
const HIDDEN_BOUNDS: Bounds = { x: 0, y: 0, width: 0, height: 0 };

/** The floating panels a native view would paint over; the developer colour tweaker is dragged like one. */
const FLOATING_PANELS = '[data-slot="popover-content"], [data-slot="dropdown-menu-content"], [data-color-tweaker]';
/** Cards docked in a window corner (the Genex promo): they hold still, so no frame-by-frame tracking. */
const DOCKED_CARDS = "[data-genex-promo]";
const OVERLAY_MOTION_MS = 400;
const OVERLAY_MOTION_EVENTS = ["animationstart", "animationend", "transitionrun", "transitionend"];
const MODAL_DIALOG = '[data-slot="dialog-content"]';

/** Whether a floating panel is on screen over the slot's rectangle. */
function overlaps(panel: Element, rect: DOMRect): boolean {
  const bounds = panel.getBoundingClientRect();
  const visible = bounds.width > 0 && bounds.height > 0;
  return (
    visible &&
    bounds.left < rect.right &&
    bounds.right > rect.left &&
    bounds.top < rect.bottom &&
    bounds.bottom > rect.top
  );
}

/** Why the native view gives the rectangle back to the DOM: anything on the stage that is not the running project. */
export interface StageCover {
  project: string | null;
  visible: boolean;
  sidebarOverlay: boolean;
  buildsOpen: boolean;
  assetsOpen: boolean;
  fileOpen: boolean;
  showEmpty: boolean;
  liveLoading: boolean;
  toolbarOpen: boolean;
  /** The person stopped the project: its view holds a blank page, and the stage says it is stopped. */
  stopped: boolean;
  /** The person watches a project in Live, whatever briefly covers it (`stage.ts` `watchingLive`); main tells a chat's show by it. */
  watching: boolean;
}

/** Whether the stage shows the running project at all. */
const showsProject = (cover: StageCover): boolean =>
  cover.visible &&
  Boolean(cover.project) &&
  ![
    cover.sidebarOverlay,
    cover.buildsOpen,
    cover.assetsOpen,
    cover.fileOpen,
    cover.showEmpty,
    cover.liveLoading,
    cover.toolbarOpen,
    cover.stopped,
  ].some(Boolean);

// Keep the native view aligned with this element through resizes and layout changes — and
// hand the rectangle back to the DOM while Builds is open (the native view would otherwise
// paint over it).
/** Report the slot's rectangle to main while the project shows, and zero it the moment anything covers it. */
export function useNativeViewBounds(slot: RefObject<HTMLDivElement | null>, cover: StageCover): void {
  const {
    project,
    buildsOpen,
    assetsOpen,
    fileOpen,
    showEmpty,
    liveLoading,
    visible,
    sidebarOverlay,
    toolbarOpen,
    watching,
    stopped,
  } = cover;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each cover reason re-reports the rectangle, as it always has
  useEffect(() => {
    const element = slot.current;
    if (!element) return;
    if (!showsProject(cover)) {
      element.removeAttribute(NATIVE_VIEW_ATTRIBUTE);
      void window.studio.previewBounds({ ...HIDDEN_BOUNDS, watching });
      return;
    }
    let lastBounds = "";
    const report = (): void => {
      const rect = element.getBoundingClientRect();
      const panels = [...document.querySelectorAll(FLOATING_PANELS)];
      const cards = [...document.querySelectorAll(DOCKED_CARDS)];
      // A native view paints above DOM overlays. Modal dialogs must take it away;
      // an anchored panel in the chat must not blank an unrelated project surface.
      const covered =
        Boolean(document.querySelector(MODAL_DIALOG)) || [...panels, ...cards].some((panel) => overlaps(panel, rect));
      const bounds = covered
        ? HIDDEN_BOUNDS
        : { x: rect.left, y: rect.top, width: Math.max(0, rect.width), height: Math.max(0, rect.height) };
      // What floats beside the stage reads where the project paints from here (native-view.ts).
      element.toggleAttribute(NATIVE_VIEW_ATTRIBUTE, !covered);
      // The window size it was measured in lets main carry the slot through a resize in progress.
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const key = JSON.stringify([bounds, viewport]);
      if (key !== lastBounds) {
        lastBounds = key;
        void window.studio.previewBounds({ ...bounds, watching, viewport });
      }
      // Overlay style mutations report positioning and exit changes without an idle frame loop.
    };
    report();
    const layout = scheduleBounds(report, window);
    const schedule = layout.signal;
    const stopOverlays = observeOverlays(report);
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener("resize", schedule);
    return () => {
      observer.disconnect();
      stopOverlays();
      layout.stop();
      window.removeEventListener("resize", schedule);
      element.removeAttribute(NATIVE_VIEW_ATTRIBUTE);
      void window.studio.previewBounds({ ...HIDDEN_BOUNDS, watching: false });
    };
  }, [
    project,
    buildsOpen,
    assetsOpen,
    fileOpen,
    showEmpty,
    liveLoading,
    visible,
    sidebarOverlay,
    toolbarOpen,
    watching,
    stopped,
  ]);
}

/** Track only overlay movement, with no animation frame left running after it settles. */
function observeOverlays(report: () => void): () => void {
  const selector = `${FLOATING_PANELS}, ${DOCKED_CARDS}, ${MODAL_DIALOG}`;
  const relevant = (node: Node): boolean =>
    node instanceof Element && (Boolean(node.closest(selector)) || Boolean(node.querySelector(selector)));
  let frame = 0;
  let until = 0;
  const tick = () => {
    report();
    frame = performance.now() < until ? requestAnimationFrame(tick) : 0;
  };
  const moving = () => {
    report();
    until = performance.now() + OVERLAY_MOTION_MS;
    if (!frame) frame = requestAnimationFrame(tick);
  };
  const motion = (event: Event) => {
    if (event.target instanceof Node && relevant(event.target)) moving();
  };
  const overlays = new MutationObserver((records) => {
    const changed = records.some((record) =>
      record.type === "attributes"
        ? relevant(record.target)
        : [...record.addedNodes, ...record.removedNodes].some(relevant),
    );
    if (changed) moving();
  });
  overlays.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "data-state", "data-open", "data-closed"],
  });
  for (const event of OVERLAY_MOTION_EVENTS) document.addEventListener(event, motion, true);
  return () => {
    overlays.disconnect();
    cancelAnimationFrame(frame);
    for (const event of OVERLAY_MOTION_EVENTS) document.removeEventListener(event, motion, true);
  };
}
