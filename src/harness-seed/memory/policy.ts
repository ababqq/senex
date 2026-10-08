/**
 * Memory policy — PLAN.md §5.4.
 *
 * Memory is injected into every prompt, so it has to stay small and true. The policy is harness
 * code, which means the studio can change what it considers worth remembering as it learns what
 * actually helped.
 */
export const MAX_ENTRIES = 40;
export const MAX_VALUE_CHARS = 300;

/** Applied before memory is written. Keeps the artifact bounded without silent data loss. */
export function normalise(memory: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const entries = Object.entries(memory ?? {});
  const trimmed = entries.map(([key, value]) => [
    key,
    typeof value === "string" && value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}…` : value,
  ]);
  // Oldest keys fall off first; insertion order is preserved by object key order.
  return Object.fromEntries(trimmed.slice(-MAX_ENTRIES));
}

/**
 * What belongs in memory: durable facts about this machine, this user's taste, and hard-won
 * conclusions. What does not: anything already in the log, anything about one project's current
 * state, and anything that will be false next week.
 */
export function shouldRemember(key: string, value: unknown): boolean {
  if (!key || !value) return false;
  if (/^(current|temp|todo)/i.test(key)) return false;
  return true;
}
