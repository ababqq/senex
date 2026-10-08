/**
 * When the user hears the Live project, kept free of Electron so the rule is tested as a table.
 * Agents' windows are never heard: `ProjectPreview`'s `muted` option silences them when they are made.
 */
import { isSoundShortcut, type SoundKey } from "../shared/project-sound.ts";

/** Everything the Live project's sound depends on. */
export interface LiveSound {
  /** The user's switch: the stage strip's speaker, or ⌥⌘M. */
  on: boolean;
  /** The Live tab has the stage: its view has a rectangle on screen. */
  shown: boolean;
  /** Genex is the app in front. */
  foreground: boolean;
  /** An agent's session is looking through the user's own window (a build with no hidden ones). */
  lent: boolean;
}

/** Audible only while the user can see their own project, in front, with the switch on. */
export function liveAudible(sound: LiveSound): boolean {
  if (!sound.on || sound.lent) return false;
  return sound.shown && sound.foreground;
}

/** The part of Electron's `before-input-event` input the shortcut reads. */
interface KeyInput extends SoundKey {
  type: string;
  isAutoRepeat: boolean;
}

/** A page's contents as far as the shortcut listens to them: Electron's `WebContents`. */
interface KeyedContents {
  on(event: "before-input-event", listener: (event: { preventDefault(): void }, input: KeyInput) => void): unknown;
}

/** ⌥⌘M pressed while `contents` has the keyboard: the page never sees it, and `toggle` runs once a press. */
export function onSoundShortcut(contents: KeyedContents, toggle: () => void): void {
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat || !isSoundShortcut(input)) return;
    event.preventDefault();
    toggle();
  });
}
