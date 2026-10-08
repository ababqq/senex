import { createCoverPainter } from "../../shared/cover-painter.ts";
import { coverFragment, COVER_VERTEX } from "../../shared/cover-shader.ts";
import {
  COVER_RECIPE_FRAGMENT,
  coverMotionRate,
  coverShaderSeed,
  coverStartTime,
  coverUniforms,
  isOrbFamily,
} from "../../shared/cover-recipe.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { coverSignature, type DisplayCover } from "../../shared/project-library.ts";
import { loadCoverStills, saveCoverStill } from "./cover-stills.ts";
import { REDUCED_MOTION_QUERY } from "./media-queries.ts";

type Painter = ReturnType<typeof createCoverPainter>;
type Program = ReturnType<Painter["compile"]>;
type Compiling = ReturnType<Painter["begin"]>;
/** The orb families' shaders: a separate chunk, loaded the first time an orb has to draw. */
type OrbShaders = typeof import("../../shared/cover-orbs.ts");
/** A sphere's own time. It only moves while that sphere moves, and survives remounting its row. */
type Clock = { t: number; v: number };
/** One tick's timing: seconds since the last, the easing factor, the latest engagement, and now. */
type Step = { dt: number; ease: number; latest: number; now: number; reduced: boolean };
/** A clock slower than this, with nothing to turn it, has stopped. */
const SETTLED = 0.004;
type Entry = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D | null;
  control: Element;
  cover: DisplayCover;
  clock: string;
  /** The saved first frame's key: what the sphere draws, at this canvas's size. */
  still: string;
  visible: boolean;
  engaged: number;
  active: boolean;
  painted: boolean;
  failed: boolean;
  /** A saved still is being decoded into the canvas. */
  restoring: boolean;
  fade: { from: HTMLCanvasElement; start: number } | null;
};

/** Largest backing square a sphere asks for: a 160px preview at 2x. */
const SIZE = 320;
/** Ease time constant (≈200 ms to settle) and speed, as approved on the Cover spheres board. */
const EASE = 0.07,
  SPEED = 1.6,
  FPS = 24,
  FADE_MS = 300;
/** How many programs stay compiled besides the shared recipe program; the oldest is dropped first. */
const MAX_PROGRAMS = 8;
/** The shared program of the six named-palette families. */
const RECIPE_PROGRAM = "recipe";
const clocks = new Map<string, Clock>();

/** Where a cover's clock starts: a recipe's own offset, a legacy surface's zero. */
const startTime = (cover: DisplayCover): number => (cover.kind === "recipe" ? coverStartTime(cover) : 0);

/**
 * One WebGL context paints every cover into its own small 2D canvas. A row at rest shows the still
 * saved the first time its sphere drew, so a restart compiles nothing; the hovered or focused project
 * eases in from its held frame. Programs compile in the background where the GPU allows, and the
 * orb families' shaders load only when one first has to draw. Nothing moves off-screen, inside
 * [inert], in a hidden window or under Reduce Motion. Without a GPU the rows keep their stills.
 */
class CoverRenderer {
  entries = new Set<Entry>();
  gl = document.createElement("canvas");
  painter: Painter | null = null;
  programs = new Map<string, Program>();
  compiling = new Map<string, Compiling>();
  orbs: OrbShaders | null = null;
  orbsLoading = false;
  /** Saved stills by key; null until IndexedDB has answered. */
  stills: Map<string, Blob> | null = null;
  saving = new Set<string>();
  disabled = false;
  timer: ReturnType<typeof setTimeout> | undefined;
  frame = 0;
  running = false;
  last = 0;
  reduced = matchMedia(REDUCED_MOTION_QUERY);
  inertObserver = new MutationObserver(() => this.wake());
  observer = new IntersectionObserver((records) => {
    for (const record of records)
      for (const entry of this.entries) if (entry.canvas === record.target) entry.visible = record.isIntersecting;
    this.wake();
  });
  constructor() {
    this.gl.width = this.gl.height = SIZE;
    this.gl.addEventListener("webglcontextlost", this.lost);
    this.reduced.addEventListener("change", this.wake);
    document.addEventListener("visibilitychange", this.wake);
    this.inertObserver.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ["inert"],
    });
    void loadCoverStills().then((stills) => {
      this.stills = stills;
      this.wake();
    });
  }
  /** Painted canvases keep their last frame; only animation stops. */
  lost = () => {
    this.disabled = true;
    this.stop();
  };
  /** Load the orb families' chunk once; the loop wakes when it arrives. */
  loadOrbs() {
    if (this.orbsLoading) return;
    this.orbsLoading = true;
    import("../../shared/cover-orbs.ts").then(
      (orbs) => {
        this.orbs = orbs;
        this.wake();
      },
      () => {
        this.orbsLoading = false;
      },
    );
  }
  /** The fragment a cover draws with, or null while the orb families' chunk loads. */
  source(cover: DisplayCover): string | null {
    if (cover.kind !== "recipe") return coverFragment(cover.surface, cover.version);
    if (!isOrbFamily(cover.family)) return COVER_RECIPE_FRAGMENT;
    if (this.orbs) return this.orbs.orbFragment(cover.family);
    this.loadOrbs();
    return null;
  }
  programKey(cover: DisplayCover): string {
    if (cover.kind !== "recipe") return `${cover.version}:${cover.surface}`;
    return isOrbFamily(cover.family) ? `orb:${cover.family}` : RECIPE_PROGRAM;
  }
  /** The compiled program for a cover, or null while it still loads or compiles; throws if it cannot. */
  program(cover: DisplayCover): Program | null {
    this.painter ??= createCoverPainter(this.gl, COVER_VERTEX);
    const key = this.programKey(cover);
    const compiled = this.programs.get(key);
    if (compiled) return compiled;
    let compiling = this.compiling.get(key);
    if (!compiling) {
      const source = this.source(cover);
      if (source === null) return null;
      compiling = this.painter.begin(source);
      this.compiling.set(key, compiling);
    }
    if (!compiling.ready()) return null;
    this.compiling.delete(key);
    const program = compiling.finish();
    const others = [...this.programs.keys()].filter((name) => name !== RECIPE_PROGRAM);
    const [oldest] = others;
    if (others.length >= MAX_PROGRAMS && oldest !== undefined) this.evict(oldest);
    this.programs.set(key, program);
    return program;
  }
  /** Drop one compiled program and free it on the GPU. */
  evict(key: string) {
    const evicted = this.programs.get(key);
    if (evicted) this.painter?.remove(evicted.program);
    this.programs.delete(key);
  }
  eligible(entry: Entry): boolean {
    return (
      entry.visible &&
      !entry.failed &&
      !document.hidden &&
      !entry.canvas.closest("[inert]") &&
      entry.canvas.checkVisibility({ visibilityProperty: true })
    );
  }
  stop() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.running = false;
  }
  wake = () => {
    if (this.running || this.disabled) return;
    this.running = true;
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  };
  clockFor(entry: Entry): Clock {
    let clock = clocks.get(entry.clock);
    if (!clock) clocks.set(entry.clock, (clock = { t: startTime(entry.cover), v: 0 }));
    return clock;
  }
  /** The entries that may move now, grouped by the clock they share. */
  eligibleGroups(): Map<string, Entry[]> {
    const groups = new Map<string, Entry[]>();
    for (const entry of this.entries)
      if (this.eligible(entry)) groups.set(entry.clock, [...(groups.get(entry.clock) ?? []), entry]);
    return groups;
  }
  /**
   * Move one clock and paint its covers. It turns while one of them is the most
   * recently engaged, easing in and out; true while anything in the group still moves or waits.
   */
  advance(list: Entry[], { dt, ease, latest, now, reduced }: Step): boolean {
    const [first] = list;
    if (!first) return false;
    const clock = this.clockFor(first);
    const cover = first.cover;
    const rate = cover.kind === "recipe" ? coverMotionRate(cover) : 1;
    const engagedLast = (entry: Entry): boolean => latest > 0 && entry.engaged === latest;
    const engaged = list.some(engagedLast);
    const live = !reduced && rate > 0 && engaged;
    clock.v += ((live ? 1 : 0) - clock.v) * ease;
    if (!live && clock.v < SETTLED) clock.v = 0;
    if (clock.v > 0) clock.t += dt * clock.v * SPEED * rate;
    let waiting = false;
    for (const entry of list) {
      const due = clock.v > 0 || !entry.painted || entry.fade !== null;
      if (!due || this.restore(entry, clock)) continue;
      if (!this.paint(entry, clock.t, now, reduced)) waiting = true;
    }
    return live || clock.v > 0 || waiting || list.some((entry) => entry.fade);
  }
  /**
   * A row at rest whose clock has not moved shows its saved still instead of compiling anything.
   * True when the entry is taken care of: the still is being drawn, or the saved stills are
   * still loading (their arrival wakes the loop).
   */
  restore(entry: Entry, clock: Clock): boolean {
    const atStart = clock.v === 0 && !entry.painted && entry.fade === null && clock.t === startTime(entry.cover);
    if (!atStart) return false;
    if (!this.stills) return true;
    const blob = this.stills.get(entry.still);
    if (!blob) return false;
    if (entry.restoring) return true;
    entry.restoring = true;
    createImageBitmap(blob).then(
      (bitmap) => {
        entry.restoring = false;
        if (!this.entries.has(entry) || entry.painted) return bitmap.close();
        entry.context?.clearRect(0, 0, entry.canvas.width, entry.canvas.height);
        entry.context?.drawImage(bitmap, 0, 0, entry.canvas.width, entry.canvas.height);
        bitmap.close();
        this.painted(entry, clock.t);
        entry.canvas.dataset.still = "1";
      },
      () => {
        entry.restoring = false;
        this.stills?.delete(entry.still);
        this.wake();
      },
    );
    return true;
  }
  tick = () => {
    this.frame = 0;
    const now = performance.now(),
      dt = Math.min(0.1, (now - this.last) / SECOND_MS);
    this.last = now;
    if (this.disabled) {
      this.stop();
      return;
    }
    const reduced = this.reduced.matches;
    const groups = this.eligibleGroups();
    // Only the most recently hovered or focused sphere turns.
    const latest = Math.max(0, ...[...this.entries].map((entry) => entry.engaged));
    const step: Step = { dt, ease: 1 - Math.exp(-dt / EASE), latest, now, reduced };
    let busy = false;
    try {
      for (const list of groups.values()) if (this.advance(list, step)) busy = true;
    } catch {
      this.disabled = true;
      this.stop();
      return;
    }
    // Nothing moves unseen: a sphere that is not on screen stops where it is.
    for (const [key, clock] of clocks) if (!groups.has(key)) clock.v = 0;
    if (!busy) {
      this.running = false;
      return;
    }
    this.timer = setTimeout(() => {
      this.frame = requestAnimationFrame(this.tick);
    }, SECOND_MS / FPS);
  };
  /** The uniforms a cover's program reads, beyond time and seed. */
  uniforms(cover: DisplayCover, size: number, time: number): Record<string, number | number[]> | undefined {
    if (cover.kind !== "recipe") return undefined;
    if (!isOrbFamily(cover.family)) return coverUniforms(cover, size);
    return this.orbs?.orbUniforms(cover, size, time);
  }
  /** Paint one frame; false while its program still loads or compiles. */
  paint(entry: Entry, time: number, now: number, reduced: boolean): boolean {
    const { canvas, context, cover } = entry;
    if (!context) return true;
    const size = Math.min(SIZE, canvas.width);
    this.painter ??= createCoverPainter(this.gl, COVER_VERTEX);
    let program: Program | null;
    // A legacy surface that no longer compiles keeps its poster; the other spheres carry on.
    try {
      program = this.program(cover);
    } catch {
      entry.failed = true;
      return true;
    }
    if (!program) return false;
    const atStart = !entry.painted && entry.fade === null && time === startTime(cover);
    this.painter.draw(program, time, coverShaderSeed(cover.seed), size, this.uniforms(cover, size, time));
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(this.gl, 0, SIZE - size, size, size, 0, 0, canvas.width, canvas.height);
    if (entry.fade) {
      const k = reduced ? 1 : Math.min(1, (now - entry.fade.start) / FADE_MS);
      if (k < 1) {
        context.globalAlpha = 1 - k;
        context.drawImage(entry.fade.from, 0, 0, canvas.width, canvas.height);
        context.globalAlpha = 1;
      } else entry.fade = null;
    }
    this.painted(entry, time);
    if (atStart) this.keep(entry);
    return true;
  }
  painted(entry: Entry, time: number) {
    const { canvas, cover } = entry;
    entry.painted = true;
    canvas.dataset.painted = coverSignature(cover);
    canvas.dataset.time = time.toFixed(3);
    canvas.dataset.frames = String(Number(canvas.dataset.frames ?? 0) + 1);
  }
  /** Save a sphere's first frame as its still, once per key. */
  keep(entry: Entry) {
    if (!this.stills || this.stills.has(entry.still) || this.saving.has(entry.still)) return;
    this.saving.add(entry.still);
    void saveCoverStill(entry.still, entry.canvas).then((blob) => {
      this.saving.delete(entry.still);
      if (blob) this.stills?.set(entry.still, blob);
    });
  }
  register(canvas: HTMLCanvasElement, cover: DisplayCover, key: string | undefined, active: boolean) {
    const signature = coverSignature(cover);
    const scale = Math.min(
      SIZE,
      Math.round((canvas.getBoundingClientRect().width || 28) * Math.max(1, devicePixelRatio)),
    );
    // A different cover on a canvas that already shows one cross-fades over 300 ms.
    let fade: Entry["fade"] = null;
    const replacing = Boolean(canvas.dataset.painted) && canvas.dataset.painted !== signature && canvas.width > 0;
    if (replacing) {
      const from = document.createElement("canvas");
      from.width = canvas.width;
      from.height = canvas.height;
      from.getContext("2d")?.drawImage(canvas, 0, 0);
      fade = { from, start: performance.now() };
    }
    if (canvas.width !== scale) {
      canvas.width = canvas.height = scale;
    }
    const control = canvas.closest("[data-project]") ?? canvas.closest('button, [role="option"]') ?? canvas;
    const entry: Entry = {
      canvas,
      context: canvas.getContext("2d"),
      control,
      cover,
      clock: `${key ?? ""}\n${signature}`,
      still: `${signature}@${scale}`,
      visible: false,
      engaged: 0,
      active,
      painted: false,
      failed: false,
      restoring: false,
      fade,
    };
    const engage = () => {
      entry.engaged = control.matches(":hover, :focus-visible, :has(:focus-visible)") ? performance.now() : 0;
      this.wake();
    };
    const release = () => requestAnimationFrame(engage);
    control.addEventListener("pointerenter", engage);
    control.addEventListener("pointerleave", release);
    control.addEventListener("focusin", engage);
    control.addEventListener("focusout", release);
    this.entries.add(entry);
    this.observer.observe(canvas);
    this.wake();
    return {
      active: (value: boolean) => {
        entry.active = value;
        this.wake();
      },
      dispose: () => {
        control.removeEventListener("pointerenter", engage);
        control.removeEventListener("pointerleave", release);
        control.removeEventListener("focusin", engage);
        control.removeEventListener("focusout", release);
        this.observer.unobserve(canvas);
        this.entries.delete(entry);
        if (!this.entries.size) this.dispose();
      },
    };
  }
  dispose() {
    this.stop();
    this.observer.disconnect();
    this.inertObserver.disconnect();
    document.removeEventListener("visibilitychange", this.wake);
    this.reduced.removeEventListener("change", this.wake);
    this.gl.removeEventListener("webglcontextlost", this.lost);
    this.painter?.dispose();
    this.programs.clear();
    this.compiling.clear();
    singleton = null;
  }
}
let singleton: CoverRenderer | null = null;
export type CoverHandle = ReturnType<CoverRenderer["register"]>;
/** Paint `cover` into `canvas`; `key` (a project's name) keeps its clock across remounts. */
export function animateCover(
  canvas: HTMLCanvasElement,
  cover: DisplayCover,
  key: string | undefined,
  active: boolean,
): CoverHandle {
  return (singleton ??= new CoverRenderer()).register(canvas, cover, key, active);
}
