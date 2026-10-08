/**
 * The one place a project preview may reach beyond the studio's own servers: well-known public CDNs
 * that serve libraries and fonts. Reads only (GET/HEAD over https on the default port), exact
 * host names, so a page can load `three` from jsdelivr but cannot post what an agent wrote into
 * it to a host of its own choosing. Used by the preview's request filter (main/page-serve.ts) and
 * by the page validation that tells the user what the preview cannot reach (project-workspace.ts).
 */
export const PREVIEW_CDN_HOSTS: ReadonlySet<string> = new Set([
  "cdn.jsdelivr.net",
  "unpkg.com",
  "esm.sh",
  "cdnjs.cloudflare.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
]);

const READS = new Set(["GET", "HEAD"]);

export function isPreviewCdnHost(host: string): boolean {
  return PREVIEW_CDN_HOSTS.has(host.toLowerCase());
}

/** A request the preview may send to a public CDN: an https read of an allowlisted host, default port. */
export function isPreviewCdnRead(url: URL, method = "GET"): boolean {
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    isPreviewCdnHost(url.hostname) &&
    READS.has(method.toUpperCase())
  );
}
