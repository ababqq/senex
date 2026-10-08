/** Window events the terminal dock listens for. */

/** Ask the terminal dock to show its open terminal (a sign-in running in Studio's own terminal, for one). */
export const SHOW_TERMINAL_EVENT = "studio:show-terminal";

/** Show the terminal dock at this session (a command a reply offered), or at its open terminal. */
export const showTerminal = (sessionId?: string): void => {
  window.dispatchEvent(new CustomEvent(SHOW_TERMINAL_EVENT, { detail: { sessionId } }));
};

/** The session a show-terminal event asks for, if it names one. */
export const shownSession = (event: Event): string | undefined =>
  event instanceof CustomEvent && typeof event.detail?.sessionId === "string" ? event.detail.sessionId : undefined;

/** Show the terminal dock, or hide it when it is showing (Cmd/Ctrl+`). */
export const TOGGLE_TERMINAL_EVENT = "studio:toggle-terminal";

/** Open a new terminal in the project's folder. */
export const OPEN_TERMINAL_EVENT = "studio:open-terminal";

/** Whether a key press is the terminal's own chord, Cmd/Ctrl+`. */
export const isTerminalChord = (event: { metaKey: boolean; ctrlKey: boolean; code: string }): boolean =>
  (event.metaKey || event.ctrlKey) && event.code === "Backquote";
