/**
 * What a project's page loads, read from its HTML: the scripts it names, the bare specifiers its
 * own import map resolves, the hosts it fetches code from, and how the studio's instrumentation
 * would reach its `three`. Pure text reading; nothing here touches the disk.
 */
import { isPreviewCdnHost } from "./preview-network.ts";

/**
 * How the studio's own instrumentation would reach the page's `three` when the project installs
 * nothing itself: through the page's own import map, through the five-key map the studio
 * inserts into a page that carries none, or through a URL import inside an inline module.
 * `none` is a bundled page, a page whose three arrives inside an external module's URL import
 * (served bytes are never rewritten), or a page with no three at all.
 */
export type ContractReach = "import-map" | "inserted-map" | "inline-url" | "none";

/** The five keys the studio's own import map answers when a page carries none of its own. */
export const INSERTED_MAP_SPECIFIERS = ["three", "three/webgpu", "three/tsl", "three/addons/", "three/"];

/** Every `<script src>` a page carries, in document order — module, classic and CDN alike. */
export function pageScripts(html: string): string[] {
  const srcs: string[] = [];
  for (const [, attributes = ""] of html.matchAll(/<script\b([^>]*)>/gi)) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
    if (src) srcs.push(src.trim());
  }
  return srcs;
}

/** A URL the page fetches from somewhere else — a CDN tag names a library but is not this project's source. */
export function isRemoteSrc(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//");
}

/** `/src/main.js`, `./src/main.js` and `src/main.js?v=2` all name the same file in the project. */
export function projectRelative(src: string): string {
  return src.replace(/^\.?\//, "").split(/[?#]/)[0] ?? src;
}

/** What a page's own import map can resolve — the only way a browser reads a bare specifier. */
export function importMapKeys(html: string): string[] {
  const block = /<script\b[^>]*\btype\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1];
  if (!block) return [];
  try {
    return Object.keys((JSON.parse(block) as { imports?: Record<string, unknown> }).imports ?? {});
  } catch {
    return [];
  }
}

/** Whether an import map with these keys resolves `specifier` (a `/`-ended key is a prefix). */
export function resolvedByMap(keys: string[], specifier: string): boolean {
  return keys.some((key) => (key.endsWith("/") ? specifier.startsWith(key) : key === specifier));
}

/** Every module specifier a script's text imports: `from "x"`, `import("x")` and `import "x"`, in that order. */
export function moduleSpecifiers(text: string): string[] {
  return [
    ...[...text.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map(([, specifier = ""]) => specifier),
    ...[...text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)].map(([, specifier = ""]) => specifier),
    ...[...text.matchAll(/\bimport\s+["']([^"']+)["']/g)].map(([, specifier = ""]) => specifier),
  ];
}

/** A URL the browser fetches from another machine: `https://host/…`, `http://…` or `//host/…`. */
function remoteHost(url: string): string | null {
  const [, host] = /^(?:https?:)?\/\/([^/?#\s"'`]+)/i.exec(url.trim()) ?? [];
  return host === undefined ? null : host.toLowerCase();
}

/** The `src` of every script tag and the `href` of every stylesheet/preload link. */
function tagLoads(html: string): string[] {
  const urls: string[] = [];
  for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (src) urls.push(src);
  }
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel\s*=\s*["'][^"']*\b(?:stylesheet|modulepreload|preload)\b/i.test(tag)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (href) urls.push(href);
  }
  return urls;
}

/** Every string an import map's `imports` and `scopes` point at; a broken map is its own problem. */
function importMapTargets(body: string): string[] {
  try {
    const map = JSON.parse(body) as {
      imports?: Record<string, unknown>;
      scopes?: Record<string, Record<string, unknown>>;
    };
    const values = [
      ...Object.values(map.imports ?? {}),
      ...Object.values(map.scopes ?? {}).flatMap((scope) => Object.values(scope ?? {})),
    ];
    return values.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

/** The import maps' targets and the inline modules' specifiers, block by block. */
function inlineLoads(html: string): string[] {
  const urls: string[] = [];
  for (const [, attrs = "", body = ""] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\btype\s*=\s*["']importmap["']/i.test(attrs)) {
      urls.push(...importMapTargets(body));
      continue;
    }
    for (const [, spec = ""] of body.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"'\n]+)["']/g)) urls.push(spec);
  }
  return urls;
}

/**
 * The hosts a page loads code or styles from (R6): script and stylesheet/preload tags, import map
 * entries and inline module imports. A plain link the player clicks is not a load. The studio's
 * preview runs projects offline, so every one of these fails there.
 */
export function networkLoads(html: string): string[] {
  const urls = [...tagLoads(html), ...inlineLoads(html)];
  return [...new Set(urls.map(remoteHost).filter((host): host is string => host !== null))];
}

/** The hosts in {@link networkLoads} the preview cannot reach: everything but the public CDNs. */
export function unreachableLoads(html: string): string[] {
  return networkLoads(html).filter((host) => !isPreviewCdnHost(host));
}

/** Every specifier an inline `<script type="module">` block imports — the page's own code. */
function inlineModuleSpecifiers(html: string): string[] {
  const out: string[] = [];
  for (const [, attributes = "", text = ""] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\btype\s*=\s*["']module["']/i.test(attributes) || /\bsrc\s*=/i.test(attributes)) continue;
    out.push(...moduleSpecifiers(text));
  }
  return out;
}

/** A URL that names three itself — the specifier the serve layer can point at its own wrapper. */
function isThreeUrl(specifier: string): boolean {
  if (!/[./]/.test(specifier)) return false;
  return (
    /(^|\/)three(\.module|\.webgpu|\.tsl|\.core)?(\.min)?\.m?js(\?|#|$)/i.test(specifier) ||
    /(^|\/)three(@[^/]+)?\/build\//i.test(specifier)
  );
}

/**
 * Where the studio's own instrumentation gets onto a page that installs nothing itself. The
 * serve layer rewrites the page it composes, never the project's files: a bare `three` the page's
 * own map resolves, or the map the studio inserts when the page has none, or a three URL inside
 * an inline module. An external module's URL import is not rewritten — its bytes are the
 * project's — and a bundled page carries its three inside the bundle, where nothing can reach it.
 */
export function threeReach(evidence: {
  html: string;
  build: string | null;
  mapped: string[];
  unresolved: string[];
}): ContractReach {
  if (evidence.build) return "none";
  if (evidence.mapped.some((key) => key === "three" || key === "three/webgpu")) return "import-map";
  const inline = inlineModuleSpecifiers(evidence.html);
  if (inline.some((specifier) => isThreeUrl(specifier))) return "inline-url";
  const bare = [...evidence.unresolved, ...inline].some(
    (specifier) => !isRemoteSrc(specifier) && resolvedByMap(INSERTED_MAP_SPECIFIERS, specifier),
  );
  if (evidence.mapped.length === 0 && bare) return "inserted-map";
  return "none";
}
