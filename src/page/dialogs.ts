/**
 * The browser dialogs of a window nobody is sitting at. A hidden window an agent drives has no one
 * to click `alert`, `confirm`, `prompt` or the print dialog, and Chromium holds the page still
 * until someone does, so the judge or builder driving it waited for ever. The shim answers them
 * the way a person who pressed Cancel would, and the console says which dialog it was. Installed
 * only where the studio asks (`dialogs: "answer"`): in Live a person is there, and the dialog is
 * the page's to show.
 */
import type { Foreign } from "./foreign.ts";

/** How many dialogs a page gets named on the console before one line says there were more. */
export const MAX_DIALOG_NOTES = 5;
/** The longest stretch of a dialog's own text a note repeats. */
const MAX_DIALOG_TEXT = 80;

const NOBODY = "nobody can click it in this window";
const MESSAGE = {
  alert: (text: string) => `alert(${text}) was dismissed: ${NOBODY}`,
  confirm: (text: string) => `confirm(${text}) was answered no: ${NOBODY}`,
  prompt: (text: string) => `prompt(${text}) was cancelled: ${NOBODY}`,
  print: "print() did nothing: this window has no printer",
  more: `more dialogs followed and were answered the same way: ${NOBODY}`,
} as const;

/** What a page passed a dialog, as one short line of plain text: it may be anything, and it is the page's own. */
function dialogText(value: Foreign): string {
  let text: string;
  try {
    text = String(value ?? "");
  } catch {
    text = "[unprintable]";
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters in page-chosen text are replaced, not shown.
  const plain = text.replace(/[\u0000-\u001f\u007f]/g, "?");
  return JSON.stringify(plain.slice(0, MAX_DIALOG_TEXT));
}

/**
 * Replace the window's dialogs with answers. `note` receives one line per named dialog, the first
 * `MAX_DIALOG_NOTES`, then once a line that says there were more; every dialog is answered either
 * way. A dialog the page made unreplaceable stays as it is (the view's `disableDialogs` answers it).
 */
export function installDialogAnswers(win: Foreign, note: (line: string) => void): void {
  let named = 0;
  let saidMore = false;
  const say = (line: string) => {
    if (named < MAX_DIALOG_NOTES) {
      named++;
      note(line);
    } else if (!saidMore) {
      saidMore = true;
      note(MESSAGE.more);
    }
  };
  const answers: Record<string, (message?: Foreign) => Foreign> = {
    alert: (message) => void say(MESSAGE.alert(dialogText(message))),
    confirm: (message) => {
      say(MESSAGE.confirm(dialogText(message)));
      return false;
    },
    prompt: (message) => {
      say(MESSAGE.prompt(dialogText(message)));
      return null;
    },
    print: () => void say(MESSAGE.print),
  };
  for (const [name, answer] of Object.entries(answers)) {
    try {
      win[name] = answer;
    } catch {
      // Not replaceable: left as the page has it.
    }
  }
}
