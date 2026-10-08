/**
 * What a project under probe may reach (Rule 8: network is an explicit pin). The same rule as the
 * product's preview (`projectRequestAllowed` in `src/main/page-serve.ts`): the page's own grade server,
 * content it already holds (`data:`, `blob:`), and https reads of the public CDNs in
 * `PREVIEW_CDN_HOSTS`. Everything else is refused: other hosts, other loopback ports (an Ollama on
 * the operator's Mac), writes to a CDN, `file:` and WebSockets. So a project that only loads in the
 * eval because it reached a host the preview blocks does not pass there, and what an agent wrote
 * cannot be posted anywhere from the grading browser.
 */
import { createHash } from "node:crypto";
import { PREVIEW_CDN_HOSTS, isPreviewCdnRead } from "../../../src/substrate/preview-network.ts";

/** The policy's name in the grading pins; the digest of the CDN list follows it. */
const POLICY_NAME = "preview-cdn-allowlist";
/** Hex characters of the CDN list's digest in the pin. */
const POLICY_DIGEST_CHARS = 12;
/** The failure text a request the policy refused is recorded with (`NetworkEntry.failure`). */
export const BLOCKED_BY_POLICY = "blocked-by-policy";

/** Schemes whose content the page already holds. */
const LOCAL_SCHEMES: ReadonlySet<string> = new Set(["data:", "blob:"]);

/** A digest of the allowed CDN hosts: the policy's identity, carried in `PROBER_VERSION`. */
export const PROBE_NETWORK_POLICY_DIGEST = createHash("sha256")
  .update([...PREVIEW_CDN_HOSTS].sort().join("\n"))
  .digest("hex")
  .slice(0, POLICY_DIGEST_CHARS);

/** This policy by name and CDN-list digest, as a log line or a report names it. */
export const PROBE_NETWORK_POLICY = `${POLICY_NAME}@${PROBE_NETWORK_POLICY_DIGEST}`;

/** A URL, or null when it does not parse. */
function parsed(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** The origin a probe was opened on (`http://127.0.0.1:<port>`), or null for an unparseable URL. */
export function serveOriginOf(url: string): string | null {
  const target = parsed(url);
  if (target === null || (target.protocol !== "http:" && target.protocol !== "https:")) return null;
  return target.origin;
}

/** Whether a page opened on `serveOrigin` may send this request. */
export function probeRequestAllowed(url: string, method: string, serveOrigin: string | null): boolean {
  const target = parsed(url);
  if (target === null) return false;
  if (LOCAL_SCHEMES.has(target.protocol)) return true;
  const ownServer = serveOrigin !== null && target.origin === serveOrigin && target.username === "";
  return ownServer || isPreviewCdnRead(target, method);
}
