/**
 * The studio contract, typed — `src/studio.js` is the implementation, this file is its shape.
 *
 * A project the user brings is often TypeScript, and its build is `tsc -b && vite build`: the
 * moment its entry does what every brief asks it to do — `import { installStudio } from
 * "./studio.js"` — an untyped contract is TS7016/TS2307, the build exits non-zero, the preview
 * has nothing to serve, and every critic scores a black frame (skate-prod, 2026-09-06).
 * TypeScript resolves `./studio.js` to this declaration, so the same import line compiles under
 * `strict` and still runs as plain JavaScript in a folder with no build at all.
 *
 * Keep it in step with `studio.js`: a method that exists here and nowhere else is a lie the
 * compiler tells the builder.
 */

/**
 * A three-component value the harness reads both ways: `bbox("tree").size.y` and `.size[1]`
 * are the same number. Twelve iterations of one run failed on the spelling.
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
  readonly [index: number]: number;
  readonly length: 3;
}

/** World-space bounds of everything carrying a tag, or of one object and its descendants. */
export interface Bounds {
  min: Vec3;
  max: Vec3;
  size: Vec3;
}

/** Where the player is, as the studio reports it: every axis present, 0 where the project has none. */
export interface PlayerPose {
  x: number;
  y: number;
  z: number;
  yaw?: number;
  pitch?: number;
}

/**
 * Where the project says its player is. `x` plus at least one of `y`/`z` is a position: a
 * side-scroller locates its player in x/y and a top-down project in x/z, and the axis a project leaves
 * out is reported as 0 rather than missing, so a check that names `player.z` reads a number
 * whatever the genre.
 */
export interface PlayerLocation {
  x: number;
  y?: number;
  z?: number;
  yaw?: number;
  pitch?: number;
}

/**
 * An object in the project's scene graph. The studio does not own the project's library — three,
 * Phaser or the project's own classes — so the contract promises only `userData.tag`, the one
 * field every scene check reads, and leaves the rest of each object to the project's own types.
 */
export interface SceneObject {
  userData?: { tag?: string } & Record<string, unknown>;
  [key: string]: any;
}

/** The one input path: everything the player did since the last step, and nothing else. */
export interface UpdateContext {
  /** Seeded RNG — the only randomness a comparable run may use. */
  rng: () => number;
  frame: number;
  /** Held keys by `event.code` and `event.key`; mouse buttons arrive as `Mouse1`…`Mouse3`. */
  keys: Set<string>;
  /** Mouse movement in pixels since the last step (pointer lock or the harness's injectInput). */
  look: { x: number; y: number };
  wheel: { x: number; y: number };
  /** Cursor position as a fraction of the canvas, and whether the pointer is locked to it. */
  pointer: { x: number; y: number; locked: boolean };
}

/** Read-only queries over the page's own elements: only what is on screen counts. */
export interface StudioDom {
  /** How many displayed elements match. */
  count(selector: string): number;
  /** Whether at least one displayed element matches. */
  visible(selector: string): boolean;
  /** The text a person reads in each displayed match. */
  text(selector: string): string[];
  /** The text of the first displayed match, or "". */
  first(selector: string): string;
  /** The current value of the first match (an input, select or textarea), or null. */
  value(selector: string): string | null;
  /** True when the page shows no text and no visual element — a scaffold nobody has built on. */
  empty(): boolean;
  /** Up to forty displayed matches named as `tag#id.class "first words"`. */
  list(selector?: string): string[];
  /** Title, headings and counts of buttons, links, fields and landmarks. */
  summary(): DomSummary;
}

/** What `dom.summary()` and `sceneSummary()` report about the page. */
export interface DomSummary {
  title: string;
  headings: string[];
  buttons: number;
  links: number;
  fields: number;
  landmarks: number;
}

/** Read-only scene-graph helpers a `scene` check is evaluated against. */
export interface StudioInspect {
  /** True once there is something to answer about — see {@link StudioUnavailable}. */
  available?: true;
  /** The 3D scene, or null on a page of DOM (its scene helpers then throw `reason`). */
  scene: unknown;
  /** Why there is no scene, on a page of DOM. */
  reason?: string;
  renderer: unknown;
  camera: unknown;
  state: StudioState;
  player: PlayerPose | null;
  objects(tag?: string): SceneObject[];
  meshes(tag?: string): SceneObject[];
  materials(tag?: string): SceneObject[];
  lights(): SceneObject[];
  tags(): string[];
  untagged(): number;
  count(tag?: string): number;
  bbox(tag?: string): Bounds | null;
  bboxOf(obj: SceneObject | null | undefined): Bounds | null;
  /** Displayed DOM elements, named as `dom.list()` names them. */
  domUi(): string[];
  /** The page's own elements: forms, lists, headings, dialogs. */
  dom: StudioDom;
  renderTargets(): Array<{ width: number; height: number }>;
  audio(): AudioProbe;
}

/**
 * What `inspect()` answers with before a 3D page has drawn its first frame: a project the studio
 * attached to has no scene until its first `renderer.render(scene, camera)`, and a scene check
 * waits rather than fails. `dom` always works; every scene helper throws with the reason. A page
 * that draws no 3D world at all answers {@link StudioInspect} with `scene: null` instead.
 */
export interface StudioUnavailable {
  available: false;
  reason: string;
  scene: null;
  renderer: unknown;
  camera: unknown;
  dom: StudioDom;
  [helper: string]: unknown;
}

/** RMS level and spectral centroid of whatever `config.audio()` analyses. */
export interface AudioProbe {
  available: boolean;
  rms: number;
  centroid: number;
}

/** What the page reports about how it was used, with no help from the project. */
export interface UiActivity {
  version: number;
  clicks: number;
  keys: number;
  /** Edits to text fields, selects and checkboxes. */
  edits: number;
  focusMoves: number;
  navigations: number;
  /** Interactions the page answered with a visible change within a moment. */
  reactions: number;
  errors: number;
  lastError: string | null;
  /** The location or route the page is showing. */
  view: string;
  /** Interactive elements with no accessible name. */
  unnamedControls: number;
  unnamedSample: string[];
  /** Whether the page scrolls sideways. */
  overflowX: boolean;
}

/** The JSON snapshot every judge and every `state.*` check reads, plus the project's own probes. */
export interface StudioState {
  version: number;
  seed: number;
  frame: number;
  simulatedMs: number;
  running: boolean;
  fps: number;
  held: string[];
  pointerLock: boolean;
  /** The screen the last `debugCamera()` showed; `default` is the page as it loads. */
  camera: string;
  error: string | null;
  player: PlayerPose | null;
  /** What people did to the page, reported by the studio itself — see {@link UiActivity}. */
  ui?: UiActivity;
  [probe: string]: unknown;
}

/**
 * What the project hands the studio. NOTHING is required.
 *
 * Pass `update` and the studio drives a fixed-step loop and owns the clock verbs; leave it out
 * and the studio's own shim paces the loop the project already has, and this object's job is only
 * to say the things a page cannot: what its state means, which screens to photograph, which flows
 * to run. `installStudio({ probes })` is the whole of the two-line install.
 */
export interface StudioConfig {
  /** Simulation step in milliseconds; defaults to 1000/60. */
  fixedStepMs?: number;
  /** The fixed-step simulation. With it, `step()`/`pause()`/`start()` are this object's; without it, the studio's. */
  update?(dtSeconds: number, ctx: UpdateContext): void;
  /** Draws the project's frame (a canvas, a chart); may return a promise. Omit it for a page of DOM. */
  render?(): unknown;
  /** Named readings of the project's own state — what `state.<name>` checks measure. */
  probes?: () => Record<string, unknown>;
  /** Named screens (a route, a tab, a dialog, an empty state), so two builds are photographed on the same one. May be async. */
  views?: Record<string, () => unknown>;
  /** The older spelling of `views`. */
  cameras?: Record<string, () => unknown>;
  /** Scripted workflows the generic run cannot reach; each ends on its last screen. May be async. */
  demos?: Record<string, () => unknown>;
  /** Back to a known state for this seed: empty the store, seed the fixtures. */
  reset?: (seed: number) => void;
  /** The canvas of a project that draws one. */
  canvas?: HTMLCanvasElement;
  /** A 3D or canvas world's scene graph, renderer and camera — whatever library they come from. */
  scene?: unknown;
  renderer?: unknown;
  camera?: unknown;
  /** Where the user's avatar is, for a project that has one (a map, a 3D viewer). */
  player?: () => PlayerLocation | null | undefined;
  audio?: () => AnalyserNode | null;
  /** Pointer lock is opt-in: a page of forms and lists keeps its cursor. */
  input?: { pointerLock?: boolean };
}

/** `window.__studio` — every method here is one the harness calls. Never remove one. */
export interface StudioApi {
  version: number;
  /** Reseed, reset — and pause, so judging starts from a known frame. */
  seed?(value: number): number;
  /** Resume live play. The project runs from the moment `installStudio` returns. */
  start?(): boolean;
  pause?(): boolean;
  /** Present when the project passed `update`; otherwise the studio's shim owns the clock verbs. */
  step?(dtMs?: number): { frame: number; simulatedMs: number };
  state(): StudioState;
  /** Show a named screen (see `views`), let the page settle and report which one is up. */
  debugCamera(
    name: string,
  ): Promise<{ ok: true; camera: string } | { ok: false; available?: string[]; reason?: string }>;
  /** The screens the project declared, or `["default"]`. */
  cameras(): string[];
  /** Always empty: eye cameras belong to the 3D contract this page no longer carries. */
  eyes(): string[];
  /** Read the page (or the canvas) as the critic's screenshot path does. */
  capture(): Promise<string | null>;
  demos(): string[];
  demo(name: string): Promise<{ ok: true; demo: string; result: unknown } | { ok: false; available: string[] }>;
  /** The critic's hands: key names (`KeyW`, `w`) and mouse deltas in pixels. */
  injectInput(input: {
    down?: string[];
    up?: string[];
    look?: { dx?: number; dy?: number };
    wheel?: { dx?: number; dy?: number };
  }): { keys: string[]; look: { x: number; y: number }; wheel: { x: number; y: number } };
  inspect(): StudioInspect | StudioUnavailable;
  sceneSummary(): DomSummary & {
    available: boolean;
    reason?: string;
    meshes?: number;
    untagged?: number;
    byTag?: Record<string, number>;
    lights?: string[];
    renderTargets?: Array<{ width: number; height: number }>;
  };
  audio(): AudioProbe;
}

/** Deterministic RNG (mulberry32): same seed ⇒ same run ⇒ comparable screenshots. */
export function makeRng(seed: number): () => number;

/**
 * Install the contract on `window.__studio`. Returns the same object.
 *
 * ```js
 * installStudio({ probes: () => ({ items: store.items.length, route: location.hash }) });
 * ```
 *
 * That is the whole of it for a project with its own loop: the studio already paces the page, seeds
 * its randomness, photographs its screens and reports what people did to it, and that line tells it
 * what the project's state means. Pass `update` as well and the studio drives the loop.
 */
export function installStudio(config: StudioConfig): StudioApi;

/** The studio's own clock, installed on every served page before a line of project code runs. */
export interface StudioClock {
  version: number;
  mode(): "wall" | "studio";
  frozen(): boolean;
  now(): number;
  pause(): boolean;
  start(): boolean;
  /** Simulate exactly `round(ms / frameMs)` frames. Asynchronous: the stepper yields a
   * microtask between frames so a project whose animation callback awaits still advances. */
  step(ms: number): Promise<unknown>;
  seed(value: number): number;
  stats(): Record<string, unknown>;
  boot(): Record<string, unknown>;
  afterFrame(fn: () => void): () => void;
  pumpFrame(dtMs: number): boolean;
  canvases(): { elements: HTMLCanvasElement[]; descriptors: Array<Record<string, unknown>> };
}

/** The renderer hook: what the studio saw the project draw, with nothing added to the project. */
export interface StudioHook {
  version: number;
  wrapRenderer(instance: unknown): boolean;
  current(): { renderer: unknown; scene: unknown; camera: unknown; canvas: HTMLCanvasElement | null } | null;
  scenes(): unknown[];
  inspect(options?: Record<string, unknown>): StudioInspect | StudioUnavailable;
  cameras(): string[];
  state(): Record<string, unknown>;
}

declare global {
  interface Window {
    __studio?: StudioApi;
    /** The studio's clock — present on every page the studio serves. */
    __studioClock?: StudioClock;
    /** The renderer hook — how a project with no contract at all is still judgeable. */
    __studioHook?: StudioHook;
    /** The last fatal the page reported — `state().error` reads it. */
    __studio_error?: string | null;
  }
}
