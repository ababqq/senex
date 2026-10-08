/**
 * What every probe phase shares: the page, an injectable sleep (so a fake clock drives the phases in
 * tests), the frame log, and the project's origin. Plus the two guarded inputs every phase uses: a key
 * the focus guard may refuse, and a click the chrome guard may refuse.
 */
import type { ProbePhase } from "../../vocabulary.ts";
import type { ProbePage } from "../driver.ts";
import { type FrameLog, type LoggedFrame, writeFrame } from "../frame-log.ts";
import { blurActiveInPage, chromeAtInPage, describeFocusInPage } from "../start-control.ts";
import { chromeNameRefusal, keyFocusRefusal } from "../verdicts.ts";

/** The shared state of one probe run. */
export interface PhaseContext {
  page: ProbePage;
  sleep: (ms: number) => Promise<void>;
  frames: FrameLog;
  projectOrigin: string;
}

/** The origin of the page's current URL, or `""` when unreadable. */
export function currentOrigin(ctx: PhaseContext): string {
  try {
    return new URL(ctx.page.url()).origin;
  } catch {
    return "";
  }
}

/** Take a full-page screenshot and log it; nothing is written before the first render. */
export async function captureFrame(ctx: PhaseContext, phase: ProbePhase, label: string): Promise<LoggedFrame | null> {
  const capture = await ctx.page.screenshot();
  if (!capture) return null;
  const written = writeFrame(ctx.frames, capture, {
    phase,
    label,
    atMs: ctx.page.elapsedMs(),
    origin: currentOrigin(ctx),
  });
  return typeof written === "string" ? null : written;
}

/** Why the key guard refused a key, after its one blur-and-retry; `null` when the key may go out. */
export async function keyRefusal(ctx: PhaseContext): Promise<string | null> {
  const first = keyFocusRefusal(await ctx.page.evaluate(describeFocusInPage, undefined));
  if (first === null) return null;
  await ctx.page.evaluate(blurActiveInPage, undefined);
  return keyFocusRefusal(await ctx.page.evaluate(describeFocusInPage, undefined));
}

/** Press a key through the focus guard; false when refused or when the press failed. */
export async function guardedKey(ctx: PhaseContext, key: string, holdMs: number): Promise<boolean> {
  if ((await keyRefusal(ctx)) !== null) return false;
  return ctx.page.press(key, holdMs);
}

/** Why the chrome guard refuses a click at (x, y); `null` when it may go out. */
export async function clickRefusal(ctx: PhaseContext, x: number, y: number): Promise<string | null> {
  const target = await ctx.page.evaluate(chromeAtInPage, { x, y });
  if (typeof target === "string") return target;
  return chromeNameRefusal(target);
}

/** Click the viewport centre through the chrome guard; false when refused or when the click failed. */
export async function guardedCentreClick(ctx: PhaseContext): Promise<boolean> {
  const { width, height } = ctx.page.viewport();
  const x = width / 2;
  const y = height / 2;
  if ((await clickRefusal(ctx, x, y)) !== null) return false;
  return ctx.page.clickAt(x, y);
}
