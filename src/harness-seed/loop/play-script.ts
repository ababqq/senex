/**
 * Scripted use — seed, then drive controls, then step.
 *
 * The critic cannot judge a project that only ticks the clock. A short script of clicks, typing,
 * Tab and scrolling is how two builds are compared on the same inputs.
 */
import { HostMethod } from "./host-methods.ts";
import { PageMethod } from "./page-contract.ts";
import { MAX_ACTION_MS, MAX_PLAY_SCRIPT } from "./config.ts";
import type { AnyRecord, CallParams, HarnessCtx } from "../types/harness.d.ts";
import type { HarnessHostMethod, MessageImage, PreviewInputAction } from "../types/host-api.d.ts";

/**
 * One control the harness drives: keys held or tapped, text typed, a key chord, a look, a click,
 * a drag, a pointer move, a scroll, a wait, a view switch. A declared script is normalised to
 * these (`kinds.ts`).
 */
export interface PlayAction {
  type: string;
  keys?: string[];
  /** Literal text for a `type` action. */
  text?: string;
  /** A key or `+`-joined chord ("Tab", "ctrl+z") for a `press` action, repeated `repeat` times. */
  combo?: string;
  repeat?: number;
  ms?: number;
  dx?: number;
  dy?: number;
  x?: number;
  y?: number;
  fromX?: number;
  fromY?: number;
  px?: boolean;
  button?: string;
  name?: string;
}

/** What a project that declares no script is driven with: aim at the page, tab through it, activate, scroll. */
export const CONTROL_EXERCISE: PlayAction[] = [
  { type: "click", x: 0.5, y: 0.3 },
  { type: "press", combo: "Tab", repeat: 3 },
  { type: "press", combo: "Return" },
  { type: "wait", ms: 200 },
  { type: "scroll", dx: 0, dy: 360 },
  { type: "wait", ms: 200 },
  { type: "scroll", dx: 0, dy: -360 },
];

/** How a graphics project a person walks through is driven: move, look, jump, use the primary button. */
export const WALK_EXERCISE: PlayAction[] = [
  { type: "hold", keys: ["w"], ms: 1600 },
  { type: "look", dx: 56, dy: -8 },
  { type: "tap", keys: ["space"] },
  { type: "hold", keys: ["a"], ms: 800 },
  // The primary verb: a held Mouse1 reaches the project as `Mouse1` in ctx.keys through the
  // same path a human's click takes (studio.js records mouse buttons as keys). Without it
  // a judge once reported "shotsFired stay 0 across the whole run" as a defect of the project.
  { type: "hold", keys: ["Mouse1"], ms: 320 },
];

/** The frame a stepped tap, look, click or drag is given to land in. */
const INPUT_FRAME_MS = 48;

/** What every action of a script drives through: the preview (on its lease), the clock, and the pictures taken. */
interface Drive {
  call: HarnessCtx["call"];
  stepped: boolean;
  runId?: string;
  images: MessageImage[];
}

/** A declared action, as a script carries it: any fields, read loosely. */
type ScriptAction = AnyRecord;

/** Under the stepped clock, advance the project by one input frame. */
async function stepFrame(drive: Drive): Promise<void> {
  if (drive.stepped) await drive.call(HostMethod.PreviewCall, { method: PageMethod.Step, arg: INPUT_FRAME_MS });
}

/** Let the project run for `ms`: stepped, or a wall-clock wait. */
async function runFor(drive: Drive, ms: number): Promise<void> {
  if (drive.stepped) await drive.call(HostMethod.PreviewCall, { method: PageMethod.Step, arg: ms });
  else await drive.call(HostMethod.PreviewInput, { actions: [{ type: "wait", ms }] });
}

/** One input action, then a frame for it under the stepped clock. */
async function inputThenFrame(drive: Drive, input: PreviewInputAction): Promise<void> {
  await drive.call(HostMethod.PreviewInput, { actions: [input] });
  await stepFrame(drive);
}

/** A frame budget on an input the page steps itself, under the stepped clock only. */
const frameOf = (drive: Drive): { stepMs?: number } => (drive.stepped ? { stepMs: INPUT_FRAME_MS } : {});

/** How each action type is driven; an unknown type does nothing. */
const ACTION_STEPS = new Map<string, (drive: Drive, action: ScriptAction) => Promise<void>>([
  [
    "hold",
    async (drive, action) => {
      const keys = asKeys(action.keys ?? action.key);
      await drive.call(HostMethod.PreviewInput, { actions: [{ type: "down", keys }] });
      await runFor(drive, clamp(action.ms ?? 400, 16, MAX_ACTION_MS));
      await drive.call(HostMethod.PreviewInput, { actions: [{ type: "up", keys }] });
    },
  ],
  [
    "tap",
    // `stepMs` straddles the press and the release with a frame: a project that reads a key on
    // the frame it was pressed used to see the down and the up inside one frame and nothing
    // between them, so a tap reached nothing.
    (drive, action) =>
      inputThenFrame(drive, { type: "tap", keys: asKeys(action.keys ?? action.key), ...frameOf(drive) }),
  ],
  [
    "look",
    (drive, action) => inputThenFrame(drive, { type: "look", dx: Number(action.dx) || 0, dy: Number(action.dy) || 0 }),
  ],
  // Literal text, one character at a time the way a keyboard delivers it; the frame after lets a
  // field that formats or validates as you type answer.
  ["type", (drive, action) => inputThenFrame(drive, { type: "type", text: String(action.text ?? "") })],
  [
    "press",
    (drive, action) =>
      inputThenFrame(drive, {
        type: "press",
        combo: String(action.combo ?? ""),
        ...(Number(action.repeat) > 1 ? { repeat: Number(action.repeat) } : {}),
      }),
  ],
  [
    "click",
    (drive, action) =>
      inputThenFrame(drive, {
        type: "click",
        x: action.x,
        y: action.y,
        button: action.button,
        ...(action.px === true ? { px: true } : {}),
        ...frameOf(drive),
      }),
  ],
  [
    "drag",
    // A board is dragged, not walked, and so is a builder's camera: the drag glides through
    // intermediate moves, which is what an orbit control or a dragged piece listens for.
    (drive, action) =>
      inputThenFrame(drive, {
        type: "drag",
        fromX: action.fromX,
        fromY: action.fromY,
        x: action.x ?? action.toX,
        y: action.y ?? action.toY,
        ...(action.button ? { button: action.button } : {}),
        ...(action.px === true ? { px: true } : {}),
      }),
  ],
  [
    "move",
    async (drive, action) => {
      await drive.call(HostMethod.PreviewInput, { actions: [{ type: "move", x: action.x, y: action.y }] });
    },
  ],
  [
    "scroll",
    async (drive, action) => {
      await drive.call(HostMethod.PreviewInput, { actions: [{ type: "scroll", dx: action.dx, dy: action.dy }] });
    },
  ],
  [
    "step",
    async (drive, action) => {
      await drive.call(HostMethod.PreviewCall, {
        method: PageMethod.Step,
        arg: clamp(action.ms ?? 16, 16, MAX_ACTION_MS),
      });
    },
  ],
  // Under the stepped clock the project is paused: a wall-clock wait advances nothing while the
  // PROJECT line tells the judge the project waited. Wait means "let the project run", so it steps the
  // clock by the same milliseconds.
  ["wait", (drive, action) => runFor(drive, clamp(action.ms ?? 100, 0, MAX_ACTION_MS))],
  [
    "pause",
    async (drive) => {
      await drive.call(HostMethod.PreviewCall, { method: PageMethod.Pause });
    },
  ],
  [
    "start",
    async (drive) => {
      await drive.call(HostMethod.PreviewCall, { method: PageMethod.Start });
    },
  ],
  [
    "camera",
    async (drive, action) => {
      if (action.name)
        await drive.call(HostMethod.PreviewCall, { method: PageMethod.DebugCamera, arg: String(action.name) });
    },
  ],
  ["screenshot", screenshotStep],
]);

/** A screenshot, from a named camera when the action names one, kept as a picture for the judge. */
async function screenshotStep(drive: Drive, action: ScriptAction): Promise<void> {
  if (action.camera)
    await drive.call(HostMethod.PreviewCall, { method: PageMethod.DebugCamera, arg: String(action.camera) });
  const shot = await drive.call(HostMethod.PreviewScreenshot, {
    ...(drive.runId ? { runId: drive.runId } : {}),
    ...(action.label ? { label: String(action.label) } : {}),
  });
  const image = shotToImage(shot, action.label || action.camera || "play");
  if (image) drive.images.push(image);
}

/** Drive a play script against the preview and hand back the screenshots it took. */
export async function applyPlayScript(
  ctx: HarnessCtx,
  script: unknown,
  options: { clock?: string; handle?: string; runId?: string } = {},
): Promise<{ images: MessageImage[] }> {
  const actions = Array.isArray(script) ? script.slice(0, MAX_PLAY_SCRIPT) : [];
  // Autopilot facets drive a pooled observation port; no handle = the live view, as ever.
  const h = options.handle ? { handle: options.handle } : {};
  const baseCall = ctx.call;
  const drive: Drive = {
    call: <M extends HarnessHostMethod>(method: M, payload = {} as CallParams<M>) =>
      baseCall(method, (method.startsWith("preview.") ? { ...payload, ...h } : payload) as CallParams<M>),
    stepped: options.clock !== "wall",
    runId: options.runId,
    images: [],
  };
  for (const action of actions) {
    const step = typeof action?.type === "string" ? ACTION_STEPS.get(action.type) : undefined;
    if (step) await step(drive, action);
  }
  return { images: drive.images };
}

export function shotToImage(shot: { base64?: string } | null | undefined, label: unknown): MessageImage | null {
  if (!shot?.base64) return null;
  return { mimeType: "image/jpeg", data: shot.base64, label: String(label || "screenshot") };
}

function asKeys(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (raw == null || raw === "") return [];
  return [String(raw)];
}

function clamp(value: unknown, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
