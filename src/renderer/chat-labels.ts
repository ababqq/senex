/**
 * How a chat names itself in the rail and the header.
 *
 * Titles on the thread record are durable (a `thread_updated` event). This module only *displays*:
 * when the stored title is still a placeholder or just the folder name, we show the first real
 * ask so two chats in one folder are distinguishable.
 */

import { DAY_MS, HOUR_MS, MINUTE_MS } from "../shared/duration.ts";
import { EventKind } from "../shared/event-log.ts";
import { providerInfo } from "../shared/providers.ts";
import type { EventEnvelope } from "./types.ts";

const PLACEHOLDERS = new Set(["", "New chat", "New project"]);

/** Provider-reported identity takes precedence; a requested model is explicitly labelled. */
export function contractorIdentity(
  engine: string,
  reportedModel?: string,
  requestedModel?: string,
): { label: string; chip: string } {
  const label = providerInfo(engine)?.label ?? (engine || "Contractor");
  return {
    label,
    chip: reportedModel || requestedModelChip(requestedModel),
  };
}

/** What the chip says when the builder did not report its model: what was asked for, if anything. */
function requestedModelChip(requestedModel: string | undefined): string {
  if (requestedModel === "default") return "Default model";
  return requestedModel ? `${requestedModel} (selected)` : "Model not reported";
}

export function clipAsk(text: string, max = 40): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function displayChatTitle(opts: {
  title?: string | null;
  projectTitle?: string | null;
  firstAsk?: string | null;
  unbound?: boolean;
}): string {
  // A chat with no folder yet is the door's own chat: it is named by the first sentence the
  // moment there is one, and until then it says what it is for. "Unbound" is the harness's word
  // for the same fact and means nothing to the person reading the rail.
  if (opts.unbound) return opts.firstAsk?.trim() || "New chat";
  const title = opts.title?.trim() ?? "";
  const project = opts.projectTitle?.trim() ?? "";
  const generic = PLACEHOLDERS.has(title) || title === project;
  if (!generic) return title;
  if (opts.firstAsk?.trim()) return opts.firstAsk.trim();
  return title || project || "New chat";
}

/** Oldest user line per thread — the log is append-only, so first match is the original ask. */
export function firstAsksFromEvents(events: EventEnvelope[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const event of events) {
    if (out[event.thread_id]) continue;
    if (event.data.type !== EventKind.Messages) continue;
    const user = event.data.messages.find((message) => message.role === "user" && message.content.trim());
    if (user) out[event.thread_id] = clipAsk(user.content);
  }
  return out;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const delta = Math.max(0, now - then);
  if (delta < MINUTE_MS) return "now";
  if (delta < HOUR_MS) return `${Math.floor(delta / MINUTE_MS)}m`;
  if (delta < 2 * DAY_MS) return `${Math.floor(delta / HOUR_MS)}h`;
  return `${Math.floor(delta / DAY_MS)}d`;
}

export function formatTokens(n: number): string {
  return n >= 1_000 ? `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);
}
