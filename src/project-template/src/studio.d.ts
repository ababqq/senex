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

/** Where a HUD item is drawn: fractions of the frame, y from the top. */
export interface HudPlacement {
  x?: number;
  y?: number;
  size?: number;
  color?: string;
  align?: "left" | "center" | "right";
}

/** The only UI a template project may have: one quad tagged `hud`, drawn into the canvas. */
export interface StudioHud {
  text(id: string, text: string, opts?: HudPlacement): void;
  bar(id: string, fraction: number, opts?: HudPlacement & { w?: number; h?: number }): void;
  crosshair(opts?: {
    size?: number;
    gap?: number;
    thickness?: number;
    color?: string;
    visible?: boolean;
    spread?: number;
  }): void;
  flash(color?: string, alpha?: number): void;
  remove(id: string): void;
  clear(): void;
  get(id: string): unknown;
  items(): string[];
  enable(on?: boolean): void;
}

/** What the HUD is showing, as `state()` reports it. */
export interface HudSummary {
  items: string[];
  crosshair: boolean;
  flash: number;
}

/** Read-only scene-graph helpers a `scene` check is evaluated against. */
export interface StudioInspect {
  /** True once there is a scene to answer about — see {@link StudioUnavailable}. */
  available?: true;
  scene: unknown;
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
  /** Visible DOM elements outside the canvas — the UI a canvas capture never sees. */
  domUi(): string[];
  hud(): HudSummary;
  renderTargets(): Array<{ width: number; height: number }>;
  audio(): AudioProbe;
}

/**
 * What `inspect()` answers with before anything has been rendered: a project the studio attached to
 * has no scene until its first `renderer.render(scene, camera)`, and a check must be able to say
 * "not measured yet" instead of failing. Every helper on this object throws with the reason.
 */
export interface StudioUnavailable {
  available: false;
  reason: string;
  scene: null;
  renderer: unknown;
  camera: unknown;
  [helper: string]: unknown;
}

/** RMS level and spectral centroid of whatever `config.audio()` analyses. */
export interface AudioProbe {
  available: boolean;
  rms: number;
  centroid: number;
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
  hud: HudSummary;
  camera: string;
  error: string | null;
  player: PlayerPose | null;
  [probe: string]: unknown;
}

/**
 * What the project hands the studio. NOTHING is required.
 *
 * Pass `update` and the studio drives a fixed-step loop and owns the clock verbs; leave it out
 * and the studio's own shim paces the loop the project already has, and this object's job is only
 * to say the things a page cannot: where the player is, what a named camera looks at, what a
 * probe measures. `installStudio({ renderer, player })` is the whole of the two-line install.
 */
export interface StudioConfig {
  /** Simulation step in milliseconds; defaults to 1000/60. */
  fixedStepMs?: number;
  /** The fixed-step simulation. With it, `step()`/`pause()`/`start()` are this object's; without it, the studio's. */
  update?(dtSeconds: number, ctx: UpdateContext): void;
  /** May return a promise (a WebGPU `renderAsync`); `capture()` awaits it. Omit it and the studio photographs the frame the project drew itself. */
  render?(): unknown;
  /** `false` turns the HUD off entirely — a project whose UI is its own never loads `./hud.js`. */
  hud?: false;
  /** Named readings of the project's own mechanics — what `state.<name>` checks measure. */
  probes?: () => Record<string, unknown>;
  /** Named viewpoints, so two builds are photographed from the same place. */
  cameras?: Record<string, () => void>;
  /** Scripted demonstrations the generic playthrough cannot reach; each ends paused. */
  demos?: Record<string, () => unknown>;
  reset?: (seed: number) => void;
  canvas?: HTMLCanvasElement;
  /** The project's scene graph, renderer and camera — whatever library they come from. */
  scene?: unknown;
  renderer?: unknown;
  camera?: unknown;
  player?: () => PlayerLocation | null | undefined;
  eyeHeight?: number;
  audio?: () => AnalyserNode | null;
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
  debugCamera(name: string): { ok: true; camera: string } | { ok: false; available?: string[]; reason?: string };
  cameras(): string[];
  /** `eye:spawn`, `eye:here`, `eye:down`, `eye:back` — available once `camera` and `player()` are passed in. */
  eyes(): string[];
  eye(
    name: string,
  ): { ok: true; camera: string; player: PlayerPose | null } | { ok: false; available?: string[]; reason?: string };
  /** Re-render and read the canvas in the same turn — the critic's screenshot path. */
  capture(): Promise<string | null>;
  hud: StudioHud;
  demos(): string[];
  demo(name: string): { ok: true; demo: string; result: unknown } | { ok: false; available: string[] };
  /** The critic's hands: key names (`KeyW`, `w`) and mouse deltas in pixels. */
  injectInput(input: {
    down?: string[];
    up?: string[];
    look?: { dx?: number; dy?: number };
    wheel?: { dx?: number; dy?: number };
  }): { keys: string[]; look: { x: number; y: number }; wheel: { x: number; y: number } };
  inspect(): StudioInspect | StudioUnavailable;
  sceneSummary(): {
    meshes: number;
    untagged: number;
    byTag: Record<string, number>;
    lights: string[];
    renderTargets: Array<{ width: number; height: number }>;
  };
  audio(): AudioProbe;
}

/** Deterministic RNG (mulberry32): same seed ⇒ same run ⇒ comparable screenshots. */
export function makeRng(seed: number): () => number;

/**
 * Install the contract on `window.__studio`. Returns the same object.
 *
 * ```js
 * installStudio({ renderer, player: () => ({ x: player.position.x, z: player.position.z }) });
 * ```
 *
 * That is the whole of it for a project with its own loop: the studio already paces the page, seeds
 * its randomness and photographs its frames, and those two lines tell it which renderer is the
 * project's and where the player stands. Pass `update` as well and the studio drives the loop.
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
