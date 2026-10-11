/**
 * Page focus for an agent's preview window. Those windows are hidden and never the OS-focused one, so
 * Chromium reports the page as unfocused: `:focus` and `:focus-visible` match nothing, no focus ring is
 * drawn, and a tester looking at the window can never see one. `webContents.focus()` does not help (a
 * no-op on an offscreen view, and on macOS it can order a hidden host window onto the screen); DevTools'
 * focus emulation answers "focused" to the page alone and leaves the host window as it is.
 * Electron-free (a structural contents type), so node:test can fake it.
 */

/** The DevTools protocol version `webContents.debugger.attach` is given. */
export const CDP_VERSION = "1.3";

/** The DevTools methods the preview calls. */
export const CdpMethod = { SetFocusEmulationEnabled: "Emulation.setFocusEmulationEnabled" } as const;
export type CdpMethod = (typeof CdpMethod)[keyof typeof CdpMethod];

/** The part of `webContents.debugger` the preview uses. */
export interface FocusDebugger {
  isAttached(): boolean;
  attach(version?: string): void;
  sendCommand(method: string, params?: object): Promise<unknown>;
}

/**
 * Make an offscreen (agent) window's page answer as focused; Live is never touched, because it has the
 * real focus and dev control owns its debugger. Resolves false, never throws, when the window keeps
 * working unfocused (another tool owns the debugger, or the page is gone).
 */
export async function emulatePageFocus(
  contents: { debugger: FocusDebugger },
  options: { offscreen?: boolean | undefined },
): Promise<boolean> {
  if (options.offscreen !== true) return false;
  const tool = contents.debugger;
  try {
    if (!tool.isAttached()) tool.attach(CDP_VERSION);
    await tool.sendCommand(CdpMethod.SetFocusEmulationEnabled, { enabled: true });
    return true;
  } catch {
    return false;
  }
}
