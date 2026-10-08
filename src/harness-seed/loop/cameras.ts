/**
 * The camera names the harness reads for what they are rather than as the project's own words: the
 * view every look starts from, a demo's camera and the view the user left the window on.
 */

/** The camera every look starts from: the view the page renders, whatever the project registered. */
export const DEFAULT_CAMERA = "default";

/**
 * A shot whose look is the project's own: not a demo's camera, and not the view the user left the
 * window on. Only these are compared with the reference stills.
 */
export function hasOwnStyle(shot: { camera?: string | null }): boolean {
  return !String(shot.camera ?? "").startsWith("demo:") && shot.camera !== "user:view";
}
