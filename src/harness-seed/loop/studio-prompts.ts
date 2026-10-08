/**
 * The words the loop's dispatch hands a model: the follow-up a coordinator commissions, and the
 * note a restarted harness finds in its own log.
 */

/** How much of the saved plan a follow-up turn is shown. */
const FOLLOWUP_PLAN_CHARS = 24_000;
/** How much of the previous run's record a follow-up turn is shown. */
const FOLLOWUP_RESULT_CHARS = 12_000;

/** The ask of a follow-up the coordinator commissioned on a project with work behind it. */
export function followupAsk(text: string, plan: unknown, previous: unknown): string {
  return `${text}\n\nContinue this project's existing work. Retain its prior decisions and completed work. Inspect the current files before editing.\nSaved plan: ${JSON.stringify(plan ?? null).slice(0, FOLLOWUP_PLAN_CHARS)}\nPrevious result: ${JSON.stringify(previous).slice(0, FOLLOWUP_RESULT_CHARS)}`;
}

/** The first-person trace a restarted harness leaves itself, so the next prompt says what happened. */
export function restartNote(reason: string, detail: string | undefined): string {
  return (
    `You were restarted (${reason}${detail ? `: ${detail}` : ""}). ` +
    `Your workspace may have been rewound to the last healthy snapshot. ` +
    `Check what you were doing in the log before continuing, and do not repeat the change that broke you.`
  );
}
