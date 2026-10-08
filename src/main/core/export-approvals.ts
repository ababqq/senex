/**
 * File lists the person approved in Studio's own Publish dialog, each waiting for the one export it
 * approves. An export with exactly those files needs no second question; any other export, or one
 * that comes too late, is asked about in chat as before. Each approval is spent by the first
 * export of its plugin and project, matching or not, and withdrawn when the publish that carried it ends.
 */
import { MINUTE_MS } from "../../shared/duration.ts";
import type { ExportReview } from "../../shared/plugins.ts";

/** How long an approved file list waits for its export. */
export const EXPORT_APPROVAL_TTL_MS = 5 * MINUTE_MS;

/** A file list in one order, so two exports of the same files compare equal. */
export function sortedReview(review: ExportReview): ExportReview {
  return { included: [...review.included].sort(), excluded: [...review.excluded].sort() };
}

const sameFiles = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((file, i) => file === b[i]);

const approvalKey = (pluginId: string, project: string): string => JSON.stringify([pluginId, project]);

/** The approved lists, one per plugin and project. */
export class ExportApprovals {
  readonly #approved = new Map<string, { review: ExportReview; expires: number }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** The person approved uploading exactly `review` for `pluginId`'s next export of `project`. */
  approve(pluginId: string, project: string, review: ExportReview): void {
    const expires = this.#now() + EXPORT_APPROVAL_TTL_MS;
    this.#approved.set(approvalKey(pluginId, project), { review: sortedReview(review), expires });
  }

  /** The publish that carried an approval ended: whatever it did not spend is gone. */
  withdraw(pluginId: string, project: string): void {
    this.#approved.delete(approvalKey(pluginId, project));
  }

  /** Whether this export is the one approved; the approval is spent either way. */
  take(pluginId: string, project: string, exported: ExportReview): boolean {
    const key = approvalKey(pluginId, project);
    const approval = this.#approved.get(key);
    this.#approved.delete(key);
    if (!approval || approval.expires < this.#now()) return false;
    const actual = sortedReview(exported);
    return sameFiles(approval.review.included, actual.included) && sameFiles(approval.review.excluded, actual.excluded);
  }
}
