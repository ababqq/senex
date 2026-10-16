/**
 * The wall clock a build's promise names — "when can I look?" is answered by a clock, not a
 * duration. A module of its own: chat-dispatch.ts reads it, and a seed upgrade keeps an older copy
 * of that file the agent edited, which never imported it.
 */

/** The language of the clock a promise names: the sentence around it is English, so the day and the hour are too. */
const CLOCK_LOCALE = "en-US";

/** Days from the local calendar day of `from` to that of `to`. */
function calendarDays(from: Date, to: Date): number {
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.round((day(to) - day(from)) / (24 * 60 * 60 * 1000));
}

/**
 * "1:44 PM" — the local wall clock `ms` after `now`, always as English 12-hour (the harness's own
 * default language is whatever LANG the app was launched with, and a Korean "오후 1:44" inside an
 * English sentence reads as broken), with its day when that is not today: a 24-hour build ends at the
 * minute it began, and "until about 1:44 PM" without "tomorrow" reads as now.
 */
export function endClock(ms: number, now: number): string {
  const end = new Date(now + ms);
  const time = end.toLocaleTimeString(CLOCK_LOCALE, { hour: "numeric", minute: "2-digit" });
  const days = calendarDays(new Date(now), end);
  if (days === 0) return time;
  if (days === 1) return `${time} tomorrow`;
  return `${time} on ${end.toLocaleDateString(CLOCK_LOCALE, { weekday: "long" })}`;
}
