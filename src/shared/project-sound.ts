/**
 * Project sound: the user hears only the project they play, on Live. One switch, the stage strip's
 * speaker or ⌥⌘M wherever focus is, remembered by the renderer. Main applies it to the Live view
 * and keeps every agent's window silent from the start, whatever the switch says.
 */

/** The key that turns the Live project's sound on or off, as a tooltip shows it. */
export const SOUND_SHORTCUT = "⌥⌘M";

/** A key press as both sides read it: a DOM `KeyboardEvent`, or Electron's `before-input-event` input. */
export interface SoundKey {
  code: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
}

/** ⌥⌘M (⌥⌃M where there is no ⌘), without Shift; the physical M key whatever the layout types. */
export function isSoundShortcut(key: SoundKey): boolean {
  return key.code === "KeyM" && (key.meta || key.control) && key.alt && !key.shift;
}

/** What the renderer tells main about the Live project's sound: the user's switch. */
export interface ProjectSoundRequest {
  on: boolean;
}
