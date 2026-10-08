/**
 * The public shape of a project folder: what the library lists, how a project runs, and what the Open
 * Project sheet shows about a picked folder. `substrate/project-workspace.ts` decides and writes these
 * and re-exports the types; the renderer reads them through `window.studio`.
 */
import type { ProjectLibraryEntry } from "./project-library.ts";

export interface Project {
  primaryThreadId?: string;
  pinned?: boolean;
  cover?: ProjectLibraryEntry["cover"];
  lastOpenedAt?: string;
  name: string;
  dir: string;
  title: string;
  createdAt: string;
  /** `~/AI Projects/pong` or `~/coding/my-project` — what the UI shows. */
  pathLabel: string;
  /** False when this folder is not a child of the default library. */
  library: boolean;
  /** How the project runs — the studio's own no-build shape, or a project with its own build. */
  shape: ProjectShape;
  /** `shape.own`: the folder brought its own project, so the studio builds it and serves its output. */
  built: boolean;
  /** Named before anyone said what the project is: its first idea renames it in place (`nameFromIdea`). */
  provisional?: boolean;
}

/**
 * What kind of project a folder holds, decided from the libraries and runtimes it actually loads —
 * never from the entry filename. `src/main.js` is Vite's stock layout as much as the studio's,
 * and reading it as "the template" is what served the user's own three.js project raw, with a bare
 * `three` import nothing could resolve (flautout-remix/wreckage, 2026-09-07).
 *
 * The kind says what the project *is*; `build` and `serve` say how it runs. A bundled Phaser project
 * is `phaser`, not `three-vite`.
 */
export type ProjectKind =
  | "studio-template"
  | "three-vite"
  | "three-modules"
  | "canvas2d"
  | "phaser"
  | "engine-export"
  | "own-script";

/**
 * How a project runs. The studio's own template needs no build: `index.html` loads `src/main.js`
 * as a native ES module. A folder the user brings — Vite, TypeScript, any bundler — keeps its
 * own entry and build; the studio runs the build and serves its output instead of the sources
 * (skate-prod, 2026-09-06: served raw, `/src/main.ts` was refused by the browser and every
 * critic judged a black frame).
 */
export interface ProjectShape {
  /** The page the preview serves, relative to the project — inside the build output when there is a build. */
  entry: string;
  /** The project's real entry module: what the main owner edits and other facets wire into. */
  main: string;
  /** Shell command that produces `entry` from the sources; null when the project runs as written. */
  build: string | null;
  /**
   * What "Install packages" runs — the manager the folder's own lockfile names, because
   * `npm install` in a pnpm project writes a second, divergent node_modules. Null when the
   * folder declares no dependencies at all.
   */
  install: string | null;
  /**
   * The folder brought its own project. Explicit, because no filename can carry it: a project may keep
   * the template's entry name and still be entirely its own, and the studio must never write its
   * scaffold beside a real one.
   */
  own: boolean;
  /** What the folder is, from its own evidence. */
  kind: ProjectKind;
  /** The folder the served page lives in, relative to the project; "." when it is served as written. */
  serve: string;
  /**
   * How long this project asks the studio to wait for it to boot, in milliseconds — clamped to a
   * minute, so a rewritten studio.json can cost at most that much patience. The user's knob (or
   * a worker's): the studio reads it and never writes it. Absent when the folder declares none,
   * and then the studio waits its own default.
   */
  bootMs?: number;
}

/** What the served page does with the contract the judge reads — a word, not a sentence. Wire values: never rename one. */
export const ContractWord = {
  Loaded: "loaded",
  Attached: "attached",
  Missing: "missing",
} as const;
export type ContractWord = (typeof ContractWord)[keyof typeof ContractWord];

/** A project found in a picked folder, or one folder under it. */
export interface ProjectCandidate {
  /** Where it sits inside the folder the user picked: "." for the folder itself. */
  rel: string;
  dir: string;
  shape: ProjectShape;
  /** The evidence that made this folder a project, in the words the sheet shows. */
  why: string[];
}

/** What would stop a night on a candidate — read before anything is written. */
export interface FolderPreflight {
  /** The page the preview will serve, relative to the candidate. */
  entry: string;
  build: string | null;
  serve: string;
  /** What "Install packages" would run here — the folder's own manager. */
  install: string | null;
  /** Dependencies are declared and `node_modules` is not there: the build cannot run yet. */
  needsInstall: boolean;
  /** Whether the page the studio serves actually loads the contract the judge reads. */
  contract: ContractWord;
  /** The candidate's own repository, and any repository one folder under it. */
  git: "none" | "repo";
  nested: string[];
  problems: string[];
  warnings: string[];
  /** Every file adopting this candidate would add to it, in the order it is written. */
  writes: string[];
}

/** A folder the user chose for a new project: the path for main, and how the dialog shows it. */
/** What a project started from its first request is named from: the request, and the model the user picked. */
export interface ProjectNameRequest {
  prompt: string;
  engine?: string;
  model?: string;
}

/** The name a project started from its first request gets (`main/core/project-naming.ts`). */
export interface ProjectName {
  title: string;
  /** The message named no project (a greeting, a test) or the model gave no name: the title waits for an idea. */
  provisional?: boolean;
}

export interface ProjectLocation {
  dir: string;
  /** `~/Projects` — what the UI shows. */
  pathLabel: string;
}

/** What a picked folder holds, without touching it. */
export interface FolderInspection {
  dir: string;
  pathLabel: string;
  candidates: Array<ProjectCandidate & { pathLabel: string; preflight: FolderPreflight }>;
  /** The candidate the studio would open — `rel` of one of them, or null when it must ask. */
  suggested: string | null;
  /** Repositories of their own directly inside the picked folder — what keeping it has to answer for. */
  nested: string[];
  /**
   * What opening the picked folder *itself* would write into it: the starter project when no project
   * was found, and only the studio's own files when the project is one level down (keeping the
   * parent never writes a project beside the real one). Empty when the folder is a project of its own
   * — its own candidate answers that instead.
   */
  starter: string[];
}

export interface ProjectRecent {
  name: string;
  title: string;
  pathLabel: string;
  dir: string;
  openedAt: string;
}

/**
 * A project folder's content stamps from one walk (`project.contentStamp` with `split`): everything,
 * and the project's sources without docs/ and Markdown. Null is unknown: the preview check runs.
 */
export interface ContentStamps {
  all: string | null;
  source: string | null;
}

/** What `project.export` wrote: the public roots it assembled, and what it left out. */
export interface ExportResult {
  dir: string;
  files: number;
  included: string[];
  excluded: string[];
}

/**
 * What the studio's instrumentation actually got hold of on a page it just served (M4.2b).
 *
 * `project.validate` answers the same question from the folder's sources — a static judgement
 * about a page nobody loaded. This is the live one: the page is served, waited for and asked
 * what the hook attached to. `installed` is a project that calls `installStudio` itself,
 * `attached` is a project the hook found by watching it render, `none` is neither.
 */
export interface AttachReport {
  ok: boolean;
  contract: "installed" | "attached" | "none";
  /**
   * Did the studio's own page layer load at all? Every number below is read through it, so a
   * `false` here says the report is empty because the instrumentation never arrived — not
   * because the project is unconnected.
   */
  shim: boolean;
  reach: string | null;
  renderer: string | null;
  scene: string | null;
  camera: string | null;
  cameras: string[];
  eyes: string[];
  player: boolean;
  renders: number;
  frames: number;
  three: string[];
  reason: string | null;
  loadError: string | null;
  consoleErrors: number | null;
}
