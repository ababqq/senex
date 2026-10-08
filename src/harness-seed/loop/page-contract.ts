/**
 * The studio contract between the harness and a project's page, as the harness reads it: the
 * `window.__studio` verbs it calls, and the words the host uses for whether a project has the
 * contract at all. The template's `studio.d.ts` and the host define them, and every project the user
 * built answers to these names: never rename a value.
 */
import type { AttachReport, ContractWord } from "../types/host-api.d.ts";

/**
 * The project page's own verbs: the `window.__studio` methods the harness calls through
 * `preview.call` (`ctx.call(HostMethod.PreviewCall, { method: PageMethod.Step, arg: ms })`).
 */
export const PageMethod = {
  Seed: "seed",
  Start: "start",
  Pause: "pause",
  Step: "step",
  DebugCamera: "debugCamera",
  Cameras: "cameras",
  Eyes: "eyes",
  Demos: "demos",
  Demo: "demo",
  Audio: "audio",
} as const;
export type PageMethod = (typeof PageMethod)[keyof typeof PageMethod];

/** What `project.validate` says of a project's `src/studio.js` (`contract`): loaded, attached by the hook, or missing. */
export const StudioContract = {
  Loaded: "loaded",
  Attached: "attached",
  Missing: "missing",
} as const satisfies Record<string, ContractWord>;
export type StudioContract = (typeof StudioContract)[keyof typeof StudioContract];

/** What `project.attached` found on the served page (`contract`): the project installs the studio, the hook attached, or neither. */
export const AttachedContract = {
  Installed: "installed",
  Attached: "attached",
  None: "none",
} as const satisfies Record<string, AttachReport["contract"]>;
export type AttachedContract = (typeof AttachedContract)[keyof typeof AttachedContract];
