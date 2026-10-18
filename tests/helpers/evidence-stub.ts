/**
 * A fake harness `ctx` for the evidence pass: a preview that answers every host call
 * `gatherEvidence` makes from a few options (screenshots, cameras, the page's UI probe, the clock
 * witness), so a test can run a whole pass with no browser. Shared by the evidence suite and the
 * incident rows that pin what the pass tells a judge.
 */
import { gatherEvidence } from "../../src/harness-seed/loop/gauntlet.ts";

export interface StubOptions {
  /** Base64 payload per screenshot call, in order; repeats simulate a stale compositor frame. */
  frames: string[];
  cameras?: unknown;
  demos?: unknown;
  /** What the page logged: `error` entries are the ones a build is judged on. */
  console?: Array<{ level: string; message: string; blocked?: string }>;
  /** What `preview.ready` answers. `null` is an older studio that has no such host call. */
  ready?: Record<string, unknown> | null;
  /** What `preview.pageUi` answers. Absent is a studio that cannot see outside the canvas. */
  pageUi?: Record<string, unknown> | null;
  /** The user:view-vs-canvas diff fraction; `null` means it could not be computed. */
  diff?: number | null;
  /** The step witness, read three times per pass. `null` is a page with no studio clock. */
  witness?: ((tick: number) => unknown) | null;
  /** Pixel stats per shot, in screenshot order. */
  stats?: Array<Record<string, unknown> | null>;
  /** What `debugCamera` answers; the default registers every name asked for. */
  debugCamera?: (name: string) => unknown;
  /** What surface the port says it PHOTOGRAPHED; absent is a port that does not say. */
  shotSurface?: (payload: Record<string, unknown>) => string | undefined;
  /** Return a message to make that screenshot throw. */
  failShot?: (payload: Record<string, unknown>) => string | null;
  /** A message to make the console read throw — the one call outside the drive block's catch. */
  failConsole?: string;
  /** Answers for `preview.evaluate` that are not the step witness. */
  evaluate?: (expression: string) => unknown;
  /** Fields the page's `state()` carries beside its frame counter. */
  state?: Record<string, unknown>;
}

export const READY_NOW = {
  ready: true,
  ms: 0,
  pageMs: 0,
  timedOut: false,
  budgetMs: 15_000,
  via: "shim",
  phase: "ready",
  reason: null,
  polls: 1,
  gesture: { needed: false, done: false, reasons: [] },
};

export function stubCtx(options: StubOptions) {
  let shotIndex = 0;
  let tick = 0;
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const ctx = {
    cancelled: false,
    setStatus: () => {},
    call: async (method: string, payload: Record<string, unknown> = {}) => {
      calls.push({ method, payload });
      switch (method) {
        case "preview.reload":
        case "preview.load":
          return {};
        case "preview.ready":
          if (options.ready === null) throw new Error("no such host call: preview.ready");
          return { ...READY_NOW, ...(options.ready ?? {}) };
        case "preview.pageUi":
          if (!options.pageUi) throw new Error("no such host call: preview.pageUi");
          return options.pageUi;
        case "preview.diff":
          return options.diff === undefined
            ? { compared: 1_000, diffFraction: 0 }
            : options.diff === null
              ? { compared: 0 }
              : { compared: 1_000, diffFraction: options.diff };
        case "preview.status":
          return { loadError: null, crashed: false };
        case "preview.state":
          return { version: 1, frame: shotIndex, ...(options.state ?? {}) };
        case "preview.gesture":
          return { knocked: true, trusted: null };
        case "preview.input":
          return { ok: true, applied: 1, width: 800, height: 600 };
        case "preview.console":
          if (options.failConsole) throw new Error(options.failConsole);
          return options.console ?? [];
        case "preview.gpuErrors":
          return [];
        case "preview.evaluate": {
          const expression = String(payload.expression);
          if (expression.includes("studio step witness")) {
            tick++;
            if (options.witness === null) return null;
            return options.witness
              ? options.witness(tick)
              : {
                  steppedFrames: tick * 8,
                  drawCalls: tick * 40,
                  now: tick * 320,
                  canvas: true,
                  simulatedMs: tick * 320,
                };
          }
          return options.evaluate ? options.evaluate(expression) : false;
        }
        case "preview.screenshot": {
          const failure = options.failShot?.(payload);
          if (failure) throw new Error(failure);
          const base64 = options.frames[Math.min(shotIndex, options.frames.length - 1)];
          const stats = options.stats?.[Math.min(shotIndex, options.stats.length - 1)] ?? null;
          shotIndex++;
          const surface = options.shotSurface?.(payload);
          return {
            base64,
            bytes: base64.length,
            path: `/runs/shots/${shotIndex}.jpg`,
            stats,
            ...(surface ? { surface } : {}),
          };
        }
        case "preview.call": {
          const m = payload.method;
          if (m === "cameras") return options.cameras ?? { ok: false };
          if (m === "demos") return options.demos ?? { ok: false };
          if (m === "demo") return { ok: true, demo: payload.arg, result: { done: true } };
          if (m === "debugCamera" && options.debugCamera) return options.debugCamera(String(payload.arg));
          return { ok: true };
        }
        default:
          return {};
      }
    },
  };
  return { ctx, calls };
}

export const run = { runId: "run_test", project: "proj" };

/** The .mjs destructure makes TS see every option as required; the loop passes them optionally. */
export function gather(ctx: unknown, extra: Record<string, unknown> = {}) {
  return gatherEvidence(ctx as never, { run, iterationId: "001", seed: 1, ...extra } as never);
}

/** Every camera the pass photographed, in order — the demo and user frames included. */
export function cameraList(evidence: { shots: Array<{ camera: string }> }): string[] {
  return evidence.shots.map((shot) => shot.camera);
}
