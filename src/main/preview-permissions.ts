/**
 * What a project page may ask the browser for. The session grants the few things an app's own controls
 * need and denies every other permission: no camera, microphone or location, and no way to read the
 * person's clipboard.
 */

/** The browser permissions a project page is granted, spelled as Electron names them. */
export const PagePermission = {
  /** First-person mouse-look is core interaction; denying it silently killed look controls. */
  PointerLock: "pointerLock",
  /** Some engines request fullscreen alongside pointer lock. */
  Fullscreen: "fullscreen",
  /** A project's "copy" button: `navigator.clipboard.writeText`, which is denied without it. */
  ClipboardWrite: "clipboard-sanitized-write",
} as const;
export type PagePermission = (typeof PagePermission)[keyof typeof PagePermission];

/** What an agent's window grants: it has no screen of its own to fill, so no fullscreen. */
const AGENT_WINDOW_PERMISSIONS: ReadonlySet<string> = new Set([
  PagePermission.PointerLock,
  PagePermission.ClipboardWrite,
]);
/** What the window a person sits at grants. */
const LIVE_WINDOW_PERMISSIONS: ReadonlySet<string> = new Set([...AGENT_WINDOW_PERMISSIONS, PagePermission.Fullscreen]);

/** Whether a project page may be granted `permission` in its window (`offscreen`: an agent's). */
export function previewPermissionAllowed(permission: string, offscreen: boolean): boolean {
  return (offscreen ? AGENT_WINDOW_PERMISSIONS : LIVE_WINDOW_PERMISSIONS).has(permission);
}
