/**
 * The one HTML rewriter — M4.1.
 *
 * Every byte the studio adds to a served page is added here. The preview's file server hands a
 * document's text to {@link rewriteProjectHtml} and serves what comes back; nothing else in the
 * studio edits a project's HTML. That matters because the studio now owns the page's clock: the
 * shim has to be on the page before a single line of project code runs, on a page whose author
 * never heard of the studio, and it has to get there on the *response*, so a worker who deletes
 * the tag from index.html gets it back on the next serve.
 *
 * Pure string functions, no Electron import, so the whole insertion order is a unit test. The
 * same goes for the decisions the file server makes before it reads anything: which real file a
 * path names ({@link resolveServed}, the one function here that asks the disk), which http
 * requests are the studio's ({@link routeHttp}), and what the project partition may request or
 * navigate to at all ({@link projectRequestAllowed}, {@link previewNavigationAllowed}).
 */

import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ShimOptions } from "../substrate/preview-port.ts";
import { isPreviewCdnRead } from "../substrate/preview-network.ts";
import { isInside } from "../substrate/paths.ts";
import { withoutSiteBase } from "../substrate/site-base.ts";
import type { ContractReach } from "../substrate/project-page.ts";

/** Where the bundles live under the vendor directory (`vendor/` is already a served route). */
export const SHIM_PATH = "vendor/studio/shim.js";
export const HOOK_PATH = "vendor/studio/hook-entry.js";
export const THREE_HOOK_PATH = "vendor/studio/three-hook.js";
/** The hook module itself, imported by every wrapper this file generates. */
export const HOOK_MODULE_PATH = "vendor/studio/hook.js";

/**
 * The two import-map keys the studio points at its own wrapper (M4.2a). `three/`, `three/tsl` and
 * `three/addons/` are left byte-identical: they still resolve to the project's own copies, and the
 * wrapper re-exports the same module record, so there is still exactly one `three` on the page.
 */
export const HOOKED_KEYS = ["three", "three/webgpu"] as const;

/** The map the studio inserts into a page that has none — the template's five keys. */
export const STUDIO_MAP: Record<string, string> = {
  three: "/vendor/three.module.js",
  "three/webgpu": "/vendor/three.webgpu.js",
  "three/tsl": "/vendor/three.tsl.js",
  "three/addons/": "/vendor/three/examples/jsm/",
  "three/": "/vendor/three/",
};

/**
 * A CLASSIC script, deliberately: it runs before every module script, and it does not disturb
 * the rule that an import map must precede the first module.
 */
export const SHIM_TAG = '<script src="/vendor/studio/shim.js" data-studio-shim></script>';
/** A MODULE, and therefore inserted after the import map — a module tag ahead of a map disables it. */
export const HOOK_TAG = '<script type="module" src="/vendor/studio/hook-entry.js" data-studio-hook></script>';

/** Buffering a document to rewrite it is fine; buffering a video someone named `.html` is not. */
export const MAX_REWRITE_BYTES = 8 * 1024 * 1024;

/** The charset must survive the injection inside the first kilobyte, or Chromium sniffs it. */
export const CHARSET_BUDGET = 1024;

/** The `sec-fetch-dest` values of an in-page navigation, the ones a document is rewritten for. */
const DOCUMENT_DESTS: ReadonlySet<string> = new Set(["document", "iframe", "frame"]);

/** Whether a `sec-fetch-dest` value names a document or a frame. */
export function isDocumentDest(dest: string | null | undefined): boolean {
  return DOCUMENT_DESTS.has(fetchDest(dest));
}

/** The statuses the `project://` protocol answers with. */
export const HttpStatus = { Ok: 200, TemporaryRedirect: 307, BadRequest: 400, Forbidden: 403, NotFound: 404 } as const;
export type HttpStatus = (typeof HttpStatus)[keyof typeof HttpStatus];

/** What a refusal says when nothing more specific is known. */
const STATUS_TEXT: Record<HttpStatus, string> = {
  [HttpStatus.Ok]: "ok",
  [HttpStatus.TemporaryRedirect]: "temporary redirect",
  [HttpStatus.BadRequest]: "bad request",
  [HttpStatus.Forbidden]: "forbidden",
  [HttpStatus.NotFound]: "not found",
};

/** A plain-text protocol response: `body`, or the status's own words ("forbidden", "not found"). */
export function textResponse(status: HttpStatus, body: string = STATUS_TEXT[status]): Response {
  return new Response(body, { status });
}

/** A redirect to a root-relative address: 307 and never cached, since the folder it names is being rewritten. */
export function redirectResponse(location: string): Response {
  return new Response(null, {
    status: HttpStatus.TemporaryRedirect,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}

export interface RewriteOptions {
  /** Absolute URL of the document being served — M4.2a resolves relative three URLs against it. */
  documentUrl?: string;
  /** Insert the studio's own import map when the page has none (M4.2a). */
  insertMap?: boolean;
  /** Baked into the shim tag and read back by the page bundle. */
  shim?: Partial<ShimOptions> | null;
}

export interface RewriteResult {
  html: string;
  injected: boolean;
  /** How the studio reached the page's `three`. */
  reach: ContractReach;
  /** Import-map key → the URL the studio pointed it at (M4.2a). */
  hooked: Record<string, string>;
  /** Anything the studio wants said on the project's console about this page. */
  notes: string[];
}

/**
 * Should this response body be rewritten?
 *
 * The primary rule is that the path resolves to the entry this port loaded — the studio knows
 * that without asking Chromium anything. `sec-fetch-dest` is an additional allow for in-page
 * navigations; an unknown dest is never rewritten, so a project's own `fetch('level.html')` comes
 * back byte-identical.
 */
export function shouldRewrite(
  contentType: string | null | undefined,
  relPath: string,
  isEntryPath: boolean,
  secFetchDest: string | null | undefined,
  byteLength: number | null | undefined,
  /** The request is a page navigation by its other headers (Electron sends no `sec-fetch-dest` to a protocol handler). */
  asNavigation = false,
): boolean {
  if (isVendorPath(relPath)) return false;
  const tooLarge = typeof byteLength === "number" && Number.isFinite(byteLength) && byteLength > MAX_REWRITE_BYTES;
  if (tooLarge) return false;
  if (!isHtmlLike(contentType, relPath)) return false;
  if (isEntryPath) return true;
  return asNavigation || DOCUMENT_DESTS.has(fetchDest(secFetchDest));
}

/**
 * Whether a body is a whole page rather than a fragment: it has a doctype, `<html>`, `<head>` or
 * `<body>` after leading comments. A script that asks for a fragment with an `Accept: text/html`
 * of its own must not get the studio's tags inside it.
 */
export function looksLikeDocument(html: string): boolean {
  return /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype\b|html\b|head\b|body\b)/i.test(html);
}

/** What a refused request, navigation, new window or new tab is called in the project's console. */
const BLOCKED_WHAT = {
  request: "a network request to",
  navigation: "a navigation to",
  window: "opening a new window to",
  tab: "opening a new tab to",
} as const;
/** Why: an offline preview refuses requests and navigations; it shows one window, and only the project. */
const BLOCKED_WHY = {
  request: "projects run offline in the preview",
  navigation: "projects run offline in the preview",
  window: "the preview shows only the project, so a link that leaves it does not open",
  tab: "the preview shows one window, so a link that opens a page of the project in a new tab does not open (let it open in this window)",
} as const;

/**
 * The console line for something the preview refused, and the key that says it once per origin per
 * load. The origin is named, not the whole address (a query can hold a token); a `mailto:` or
 * `tel:` link has no origin, so its scheme stands for it. A `tab` is a page of the project itself:
 * it is named by its path, since every such link is a different page.
 */
export function blockedNote(
  kind: keyof typeof BLOCKED_WHAT,
  raw: string,
): { key: string; text: string; origin: string } {
  let origin = raw;
  try {
    const url = new URL(raw);
    const named = url.origin !== "null" ? url.origin : url.protocol;
    origin = kind === "tab" ? url.pathname : named;
  } catch {
    /* not a URL: noted as given */
  }
  return {
    key: `${kind} ${origin}`,
    text: `the studio blocked ${BLOCKED_WHAT[kind]} ${origin}: ${BLOCKED_WHY[kind]}`,
    origin,
  };
}

/**
 * The line that says which origins the preview refused, for whoever reads the page's console
 * errors: a failed `fetch` is a page error with no URL, and without this the block looks like a
 * bug in the project. Null when nothing was blocked.
 */
export function blockedLine(entries: ReadonlyArray<{ blocked?: string }>): string | null {
  const origins = [...new Set(entries.map((entry) => entry.blocked).filter((origin) => typeof origin === "string"))];
  if (!origins.length) return null;
  return `blocked by the preview's offline policy: ${origins.join(", ")} — an error from these is the preview, not the project`;
}

/** The console line for a document too large to buffer. Its shape is asserted. */
export function tooLargeNote(relPath: string, byteLength: number): string {
  const mb = (byteLength / (1024 * 1024)).toFixed(1);
  return `${relPath || "index.html"} is too large to receive the studio shim (${mb} MB); the studio cannot pace this page's clock`;
}

export function isVendorPath(relPath: string): boolean {
  const clean = String(relPath ?? "").replace(/^\/+/, "");
  return clean === "vendor" || clean.startsWith("vendor/");
}

function isHtmlLike(contentType: string | null | undefined, relPath: string): boolean {
  const type = String(contentType ?? "")
    .trim()
    .toLowerCase();
  if (type) return type.startsWith("text/html") || type.startsWith("application/xhtml+xml");
  return /\.x?html?(?:$|[?#])/i.test(String(relPath ?? ""));
}

/** The shim tag, with this load's options baked into it when they differ from the defaults. */
export function shimTag(options?: Partial<ShimOptions> | null): string {
  const payload = options && Object.keys(options).length ? JSON.stringify(options) : "";
  if (!payload) return SHIM_TAG;
  return SHIM_TAG.replace(" data-studio-shim>", ` data-studio-shim data-studio-options="${escapeAttribute(payload)}">`);
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Put the studio on the page.
 *
 * Order of the emitted head: the page's own `<meta charset>` (so it stays inside the first
 * kilobyte), then the shim, then the page's own import map, then the hook, then the page's own
 * scripts. Idempotent: a document already carrying `data-studio-shim` comes back unchanged.
 */
export function rewriteProjectHtml(html: string, options: RewriteOptions = {}): RewriteResult {
  const source = String(html ?? "");
  const notes: string[] = [];
  const untouched = (): RewriteResult => ({ html: source, injected: false, reach: "none", hooked: {}, notes });

  // The injected TAG, not the string. A bare substring test over the whole document meant that
  // one mention of `data-studio-shim` anywhere — an HTML comment, a debug line asking whether
  // the studio is attached, a CSS content value — served the page byte-identical: no shim, no
  // hook, no import-map rewrite, no seeded RNG, no draw counters and no virtual clock, with
  // nothing in the run to say why.
  if (matchOutsideComments(source, /<script\b[^>]*\bdata-studio-shim\b/i)) return untouched();

  const csp = findMetaCsp(source);
  if (csp) notes.push(cspNote(csp));

  const documentUrl = options.documentUrl ?? null;
  // Inline modules first: a page can import three by URL with no map at all, and rewriting the
  // body moves every offset below it.
  const inline = documentUrl ? rewriteInlineModules(source, documentUrl) : { html: source, hooked: {} };
  const hooked: Record<string, string> = { ...inline.hooked };
  const head = insertHead({
    working: inline.html,
    documentUrl,
    insertMap: options.insertMap !== false,
    shim: shimTag(options.shim ?? null),
    hooked,
    reach: Object.keys(inline.hooked).length ? "inline-url" : "none",
  });
  return { html: head.html, injected: true, reach: head.reach, hooked, notes };
}

type Reach = RewriteResult["reach"];

/** One page's head insertion: the page after its inline modules were rewritten, and what they reached. */
interface HeadInsertion {
  working: string;
  documentUrl: string | null;
  insertMap: boolean;
  shim: string;
  /** Filled in place with every key the head insertion points at the wrapper. */
  hooked: Record<string, string>;
  reach: Reach;
}

/** Insert the shim, the import map (the page's own, rewritten, or the studio's) and the hook. */
function insertHead(input: HeadInsertion): { html: string; reach: Reach } {
  const { working, documentUrl, shim } = input;
  const at = insertionPoint(working);
  const map = findImportMap(working, at);
  if (map) return withPageMap(input, at, map);
  if (documentUrl && input.insertMap) return withStudioMap(input, at, documentUrl);
  return { html: `${working.slice(0, at)}${shim}${HOOK_TAG}${working.slice(at)}`, reach: input.reach };
}

function withPageMap(
  input: HeadInsertion,
  at: number,
  map: { start: number; end: number; text: string },
): { html: string; reach: Reach } {
  const { working, documentUrl, shim, hooked } = input;
  const rewritten = documentUrl ? rewriteImportMap(map.text, documentUrl) : { text: map.text, hooked: {} };
  for (const [key, url] of Object.entries(rewritten.hooked)) hooked[key] = url;
  // The page's own map is the strongest reach there is: it is how the project asked for three.
  const reach = Object.keys(rewritten.hooked).length ? "import-map" : input.reach;
  return {
    html: `${working.slice(0, at)}${shim}${working.slice(at, map.start)}${rewritten.text}${HOOK_TAG}${working.slice(map.end)}`,
    reach,
  };
}

/**
 * A page with no map of its own runs on the studio's vendored three. Reported as
 * `inserted-map`, never refused: a project the user brought may name another version in its
 * package.json and never install it, and a black screen is worse than a version note.
 */
function withStudioMap(input: HeadInsertion, at: number, documentUrl: string): { html: string; reach: Reach } {
  const { working, shim, hooked } = input;
  const inserted = studioMapTag(documentUrl);
  // An import already pointed at the wrapper keeps the URL it was pointed at: the page reaches
  // three by that URL, and the inserted map only answers for the keys nothing has claimed.
  for (const [key, url] of Object.entries(inserted.hooked)) if (!(key in hooked)) hooked[key] = url;
  // A map nothing has asked for yet is weaker evidence than an import already pointed at the
  // wrapper, so an inline URL that was actually rewritten keeps the reach it earned.
  const reach = input.reach === "inline-url" ? "inline-url" : "inserted-map";
  return { html: `${working.slice(0, at)}${shim}${inserted.tag}${HOOK_TAG}${working.slice(at)}`, reach };
}

/** The URL of the wrapper module for one map key, carrying the real module's URL with it. */
export function threeHookUrl(real: string, key: string): string {
  return `/${THREE_HOOK_PATH}?key=${encodeURIComponent(key)}&real=${encodeURIComponent(real)}`;
}

/**
 * The wrapper module itself: it re-exports the page's own `three` (so there is still exactly one
 * of it) and hands the namespace to the hook, which watches every renderer class it exports.
 */
export function threeHookModule(real: string, key: string): string | null {
  if (!isAbsoluteUrl(real)) return null;
  const url = JSON.stringify(String(real));
  return [
    `import * as __t from ${url};`,
    `export * from ${url};`,
    `import { hook } from "/${HOOK_MODULE_PATH}";`,
    `hook(__t, ${JSON.stringify(String(key || "three"))}, ${url});`,
    "",
  ].join("\n");
}

/** Only a real, absolute URL may be re-exported: everything else is a 400, never a guess. */
export function isAbsoluteUrl(value: string): boolean {
  return /^(?:https?|project|data|blob|file):/i.test(String(value ?? "").trim());
}

/**
 * Which hooked key a URL is three. Bare specifiers are the import map's business; `three/tsl`,
 * `three/addons/` and `three/` are left alone, so only the two module entry points are wrapped.
 */
export function threeUrlKey(spec: string): "three" | "three/webgpu" | null {
  const text = String(spec ?? "").trim();
  if (!text) return null;
  if (!/^(?:https?:|project:|blob:|file:|\/|\.{1,2}\/)/i.test(text)) return null;
  const file = (text.split(/[?#]/)[0] ?? "").split("/").pop() ?? "";
  if (/^three\.webgpu(?:\.nodes)?(?:\.min)?\.m?js$/i.test(file)) return "three/webgpu";
  if (/^three(?:\.module|\.core)?(?:\.min)?\.m?js$/i.test(file)) return "three";
  return null;
}

export function isThreeUrl(spec: string): boolean {
  return threeUrlKey(spec) !== null;
}

/**
 * Point the page's own map at the wrapper, and change nothing else. The map's text is edited in
 * place rather than re-serialised: a project's map keeps its own formatting, its comments-by-spacing
 * and every scope byte-identical, and the diff of a served page is two URLs.
 */
export function rewriteImportMap(
  mapText: string,
  documentUrl: string,
): { text: string; hooked: Record<string, string> } {
  const hooked: Record<string, string> = {};
  const span = importsSpan(mapText);
  if (!span) return { text: mapText, hooked };
  const head = mapText.slice(0, span.start);
  let body = mapText.slice(span.start, span.end);
  const tail = mapText.slice(span.end);
  for (const key of HOOKED_KEYS) {
    const pattern = new RegExp(`("${escapeRegExp(key)}"\\s*:\\s*)"([^"]*)"`);
    const match = pattern.exec(body);
    if (!match) continue;
    const real = absolute(match[2] ?? "", documentUrl);
    if (!real) continue;
    const url = threeHookUrl(real, key);
    body = `${body.slice(0, match.index)}${match[1]}"${url}"${body.slice(match.index + match[0].length)}`;
    hooked[key] = url;
  }
  return { text: `${head}${body}${tail}`, hooked };
}

/** The studio's own five-key map, with the two entry points already pointed at the wrapper. */
export function studioMapTag(documentUrl: string): { tag: string; hooked: Record<string, string> } {
  const hooked: Record<string, string> = {};
  const imports: Record<string, string> = {};
  for (const [key, value] of Object.entries(STUDIO_MAP)) {
    const real = (HOOKED_KEYS as readonly string[]).includes(key) ? absolute(value, documentUrl) : null;
    if (real) {
      imports[key] = threeHookUrl(real, key);
      hooked[key] = imports[key];
    } else {
      imports[key] = value;
    }
  }
  return { tag: `<script type="importmap" data-studio-map>${JSON.stringify({ imports })}</script>`, hooked };
}

/**
 * A single-file page whose inline module imports three by URL has no map to rewrite, so the
 * specifier is rewritten where it is written. Only inline modules: an external `.js` or `.ts`
 * file is never edited — served bytes would differ from the bytes on disk, and the brief names
 * the two-line install for that page instead.
 */
export function rewriteInlineModules(
  html: string,
  documentUrl: string,
): { html: string; hooked: Record<string, string> } {
  const hooked: Record<string, string> = {};
  const out = String(html).replace(
    /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,
    (whole, attrs: string, body: string) => {
      if (!/\btype\s*=\s*["']?module["']?/i.test(attrs)) return whole;
      if (/\bsrc\s*=/i.test(attrs)) return whole;
      const rewritten = body.replace(
        /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"'\n]+)\2/g,
        (call: string, lead: string, quote: string, spec: string) => {
          const key = threeUrlKey(spec);
          if (!key) return call;
          const real = absolute(spec, documentUrl);
          if (!real) return call;
          const url = threeHookUrl(real, key);
          hooked[key] = url;
          return `${lead}${quote}${url}${quote}`;
        },
      );
      return `<script${attrs}>${rewritten}</script>`;
    },
  );
  return { html: out, hooked };
}

function absolute(value: string, documentUrl: string): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  try {
    const resolved = new URL(text, documentUrl).toString();
    return isAbsoluteUrl(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

/** The span of the map's `imports` object, so a scope that names `three` is never touched. */
function importsSpan(text: string): { start: number; end: number } | null {
  const key = /"imports"\s*:\s*\{/.exec(text);
  if (!key) return null;
  const open = key.index + key[0].length - 1;
  const close = matchingBrace(text, open);
  return close < 0 ? null : { start: open, end: close + 1 };
}

/** The index of the `}` that closes the `{` at `open`, skipping JSON strings; -1 when none does. */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      i = stringEnd(text, i);
      continue;
    }
    if (ch === "{") depth++;
    if (ch !== "}") continue;
    depth--;
    if (depth === 0) return i;
  }
  return -1;
}

/** The index of the quote that closes the JSON string opened at `start` (past the end if none). */
function stringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i;
  }
  return text.length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Where the studio's own tags go: after the page's `<meta charset>` when it has one near the
 * top, otherwise straight after `<head>` (or `<html>`, or the doctype, or the very start).
 */
export function insertionPoint(html: string): number {
  const head = matchOutsideComments(html, /<head\b[^>]*>/i);
  let at = 0;
  if (head) at = head.index + head.text.length;
  else {
    const htmlTag = matchOutsideComments(html, /<html\b[^>]*>/i);
    if (htmlTag) at = htmlTag.index + htmlTag.text.length;
    else {
      const doctype = matchOutsideComments(html, /<!doctype[^>]*>/i);
      if (doctype) at = doctype.index + doctype.text.length;
    }
  }
  // A charset declaration only counts if it is already ahead of the page's first script.
  const firstScript = matchOutsideComments(html.slice(at), /<script\b/i);
  const limit = at + (firstScript ? firstScript.index : html.length - at);
  const charset = matchOutsideComments(html.slice(at, limit), /<meta\b[^>]*charset[^>]*>/i);
  if (charset) return at + charset.index + charset.text.length;
  return at;
}

/** The page's own import map, if it has one after `at`. */
export function findImportMap(html: string, at = 0): { start: number; end: number; text: string } | null {
  const open = matchOutsideComments(html.slice(at), /<script\b[^>]*\btype\s*=\s*["']?importmap["']?[^>]*>/i);
  if (!open) return null;
  const start = at + open.index;
  const close = html.toLowerCase().indexOf("</script>", start + open.text.length);
  if (close < 0) return null;
  return { start, end: close + "</script>".length, text: html.slice(start, close + "</script>".length) };
}

/**
 * The first match that is not inside an HTML comment — a page whose head is preceded by a
 * `<!-- <head> -->` comment must not have the studio's tags dropped into the comment.
 */
function matchOutsideComments(html: string, pattern: RegExp): { index: number; text: string } | null {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  for (let match = re.exec(html); match; match = re.exec(html)) {
    if (!insideComment(html, match.index)) return { index: match.index, text: match[0] };
    re.lastIndex = match.index + 1;
  }
  return null;
}

function insideComment(html: string, index: number): boolean {
  const open = html.lastIndexOf("<!--", index);
  if (open < 0) return false;
  const close = html.indexOf("-->", open);
  return close < 0 || close > index;
}

interface MetaCsp {
  directive: string;
  content: string;
}

/** A page's own `<meta http-equiv="content-security-policy">`, which the studio never edits. */
export function findMetaCsp(html: string): MetaCsp | null {
  const meta = matchOutsideComments(html, /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/i);
  if (!meta) return null;
  const content = /content\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(meta.text);
  const value = content ? (content[1] ?? content[2] ?? content[3] ?? "") : "";
  const script = /(?:^|;)\s*(script-src(?:-elem)?)\s/i.exec(value);
  const fallback = /(?:^|;)\s*(default-src)\s/i.exec(value);
  return { directive: script?.[1] ?? fallback?.[1] ?? "content-security-policy", content: value };
}

/**
 * One console line, not a rewrite. The shim and the hook are same-origin with the page and are
 * inserted as the first children of the head, so their fetches begin before a meta policy is
 * parsed; loosening someone's policy to make that true on paper would be a lie.
 */
export function cspNote(csp: MetaCsp): string {
  return `this page declares a meta content-security-policy (${csp.directive}); if it blocks same-origin scripts the studio cannot pace this page's clock`;
}

// ── what a request is served from ─────────────────────────────────────────────────────────

/** Project names the file server answers for; anything else is refused before a file is touched. */
const SERVABLE_PROJECT = /^[a-z0-9][a-z0-9-_]*$/;

export function servableProject(project: string): boolean {
  return SERVABLE_PROJECT.test(project);
}

/**
 * A request path as the file table reads it: percent-decoded, leading slashes gone, and the root
 * meaning `index.html`. Decoding comes first so an encoded `..` is resolved — and refused — like a
 * literal one. A malformed escape names no path at all: null, which the handler answers with 400.
 */
export function servedRelative(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  return decoded.replace(/^\/+/, "") || "index.html";
}

export type Served =
  | { ok: true; path: string }
  | { ok: false; status: typeof HttpStatus.Forbidden | typeof HttpStatus.NotFound };

/** Nothing there to serve: a missing file, a missing folder on the way, or a dangling link. */
function missing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * The real file `rel` names under `base`, or a refusal. A path that climbs out lexically is
 * refused before the disk is touched; then both sides are realpathed and containment is checked
 * again on the real paths, because the file server reads through links and an agent confined by
 * ProcessSandbox may still plant one (`assets/k.txt -> ~/.ssh/id_ed25519`, SECUI-2). The base is
 * realpathed on every call: a review worktree override can change it between requests. `base`
 * itself is servable, a sibling that merely shares its prefix is not, and a missing file, folder
 * or link target is a 404. The path returned is the real one, so what is read has no links in it.
 *
 * `pinnedRoot` is the real root the preview recorded when it loaded the page (M1): containment is
 * then checked against that, so a folder swapped in under the same name later serves nothing.
 * Only a regular file or a folder is served; a FIFO, socket or device is a 404, because opening
 * one blocks the reader (M4).
 */
export async function resolveServed(base: string, rel: string, pinnedRoot?: string | null): Promise<Served> {
  const root = path.resolve(base);
  const lexical = path.resolve(root, rel);
  if (!isInside(root, lexical)) return { ok: false, status: HttpStatus.Forbidden };
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = pinnedRoot ?? (await realpath(root));
  } catch (err) {
    return { ok: false, status: missing(err) ? HttpStatus.NotFound : HttpStatus.Forbidden };
  }
  try {
    realTarget = await realpath(lexical);
  } catch (err) {
    return { ok: false, status: missing(err) ? HttpStatus.NotFound : HttpStatus.Forbidden };
  }
  if (!isInside(realRoot, realTarget)) return { ok: false, status: HttpStatus.Forbidden };
  const kind = await stat(realTarget).catch(() => null);
  const servable = kind?.isFile() || kind?.isDirectory();
  if (!servable) return { ok: false, status: HttpStatus.NotFound };
  return { ok: true, path: realTarget };
}

/** Where `servedLocation` reads from: the studio's vendor folder, the project, and a worktree's live folder. */
export interface ServedRoots {
  vendor: string;
  projectRoot: () => string;
  liveRoot?: () => string;
  pinnedProjectRoot?: () => string | null;
  /** The sub-path the served page was built for (`my-site`): a missing path is read again without it. */
  siteBase?: () => string | null;
}

/**
 * {@link resolveServed} against the right root: `vendor/…` is the studio's own vendor directory,
 * everything else the project's folder. `projectRoot` is asked only for a project path, because resolving
 * a project's root can consult the library.
 *
 * `liveRoot` is the project's own folder when `projectRoot` is a worktree of it (R4): a worktree's
 * `node_modules` is SnapshotEngine's link to the live project's, so a project that imports straight
 * from `./node_modules/three/…` would otherwise be a broken build in every worker's preview.
 */
export async function servedLocation(relative: string, roots: ServedRoots): Promise<Served> {
  if (isVendorPath(relative)) return resolveServed(roots.vendor, relative.slice("vendor/".length) || ".");
  const root = roots.projectRoot();
  const served = await resolveServed(root, relative, roots.pinnedProjectRoot?.() ?? null);
  const forbidden = !served.ok && served.status === HttpStatus.Forbidden;
  if (!forbidden || !roots.liveRoot) return served;
  const live = roots.liveRoot();
  if (path.resolve(live) === path.resolve(root)) return served;
  return (await resolveLinkedModules(root, live, relative)) ?? served;
}

/** What a request says about itself that decides whether a missing path is a route of the app. */
export interface NavigationRequest {
  /** The HTTP method: only a GET or HEAD asks for a page. */
  method: string;
  /** The `sec-fetch-dest` header: `document` for a page, `empty` for a script's fetch. */
  dest: string | null;
  /** The `accept` header: a browser asks for `text/html` when it navigates. */
  accept: string | null;
}

/** The methods that ask for a page rather than send something to it. */
const PAGE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/** A `sec-fetch-dest` value as compared: trimmed, lower-cased, empty when absent. */
function fetchDest(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

/** Whether a request is a browser navigating to a page: a document, or a page asked for by name when no destination is sent. */
export function isNavigation(request: NavigationRequest): boolean {
  if (!PAGE_METHODS.has(request.method.toUpperCase())) return false;
  const dest = fetchDest(request.dest);
  return dest === "" ? /\btext\/html\b/i.test(request.accept ?? "") : DOCUMENT_DESTS.has(dest);
}

/**
 * The page to answer with when a navigation names a path no file answers. A client-side router
 * (`BrowserRouter`, a Vue history mode) owns paths like `/about` or `/users/42`: a reload or a
 * copied link asks the server for them, and the server's answer is the app's one page. Only a
 * GET/HEAD navigation to an extensionless path under a page the studio loaded gets it: a script's
 * `fetch` of a missing API path, a form post, a missing `app.js` and anything refused (`..`, a
 * planted link) keep their 404/403, so a broken request still fails where the app and the console
 * can see it.
 */
export function spaFallback(
  relative: string,
  served: Served,
  entryPath: string | null,
  request: NavigationRequest,
): string | null {
  const missingRoute = !served.ok && served.status === HttpStatus.NotFound;
  const entryIsPage = entryPath !== null && /\.html?$/i.test(entryPath);
  const ownsPath = missingRoute && entryIsPage && !isVendorPath(relative);
  if (!ownsPath) return null;
  const last = relative.split("/").findLast((part) => part !== "") ?? "";
  if (path.posix.extname(last) !== "") return null;
  return isNavigation(request) ? entryPath : null;
}

/** What {@link answerRequest} decided: the path to read, where it resolved, and whether the app's routes answered. */
export interface Answer {
  relative: string;
  served: Served;
  routed: boolean;
  /** Present when the request should go to this root-relative address instead (a folder asked for without its slash). */
  redirect?: string;
}

/**
 * `relative` without the site base, as the file the served page means by it: the entry for the base
 * itself, null when it is not under the base or would reach the studio's own vendor route.
 */
export function underSiteBase(relative: string, siteBase: string | null): string | null {
  const stripped = withoutSiteBase(relative, siteBase);
  if (stripped === null) return null;
  const file = stripped === "" ? "index.html" : stripped;
  return isVendorPath(file) ? null : file;
}

/**
 * Where `asked` is found: as named first, and only when nothing is there, without the site base
 * (`under` is that base then, "" otherwise). A refusal is never retried.
 */
async function locate(asked: string, roots: ServedRoots): Promise<{ requested: string; found: Served; under: string }> {
  const found = await servedLocation(asked, roots);
  const siteBase = roots.siteBase?.() ?? null;
  const stripped = !found.ok && found.status === HttpStatus.NotFound ? underSiteBase(asked, siteBase) : null;
  if (stripped === null || siteBase === null) return { requested: asked, found, under: "" };
  return { requested: stripped, found: await servedLocation(stripped, roots), under: siteBase };
}

/** A regular file the roots serve, or null: a folder, a refusal and a missing path all answer null. */
async function servedFile(relative: string, roots: ServedRoots): Promise<{ ok: true; path: string } | null> {
  const served = await servedLocation(relative, roots);
  if (!served.ok) return null;
  return (await stat(served.path).catch(() => null))?.isFile() ? served : null;
}

/** The root-relative address of a folder, always with its slash: one path on the same origin, whatever its name holds. */
export function folderAddress(folder: string): string {
  const parts = path.posix
    .normalize(folder.replace(/^\/+/, ""))
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  return `/${parts.map((part) => `${encodeURIComponent(part)}/`).join("")}`;
}

/** `/about` is `about.html` when that file exists, before a folder of the same name is looked at, as on a static host. */
async function cleanUrl(requested: string, roots: ServedRoots): Promise<Answer | null> {
  const last = requested.split("/").findLast((part) => part !== "") ?? "";
  if (requested.endsWith("/") || path.posix.extname(last) !== "") return null;
  const relative = `${requested}.html`;
  const served = await servedFile(relative, roots);
  return served ? { relative, served, routed: true } : null;
}

/** A folder with a page of its own: that page asked for with the slash, a redirect to the slash without it. */
async function folderPage(requested: string, found: Served, roots: ServedRoots, under: string): Promise<Answer | null> {
  const isFolder = found.ok && (await stat(found.path).catch(() => null))?.isDirectory() === true;
  if (!isFolder) return null;
  const folder = requested.replace(/\/+$/, "");
  const relative = path.posix.join(folder, "index.html");
  const served = await servedFile(relative, roots);
  if (!served) return null;
  if (requested.endsWith("/")) return { relative, served, routed: true };
  return { relative: requested, served: found, routed: false, redirect: folderAddress(path.posix.join(under, folder)) };
}

/**
 * The file a request is answered from. A navigation is answered as a static host answers it: a file
 * as named, `/about` as `about.html`, a folder asked for with its slash as its `index.html` and
 * without it by a redirect to the slash (so the page's relative URLs resolve inside the folder). On
 * a bundled project that owns its paths (`routes`) a navigation no file answers gets the app's entry
 * (`spaFallback`), a folder without a page of its own included. Everything else is read as named. A
 * site built for a sub-path is read the same way on the path without its base.
 */
export async function answerRequest(
  asked: string,
  roots: ServedRoots,
  entryPath: string | null,
  request: NavigationRequest,
  routes: boolean,
): Promise<Answer> {
  const { requested, found, under } = await locate(asked, roots);
  const asNamed: Answer = { relative: requested, served: found, routed: false };
  const refused = !found.ok && found.status !== HttpStatus.NotFound;
  if (!isNavigation(request) || isVendorPath(requested) || refused) return asNamed;
  if (found.ok && (await stat(found.path).catch(() => null))?.isFile()) return asNamed;
  const page = (await cleanUrl(requested, roots)) ?? (await folderPage(requested, found, roots, under));
  if (page) return page;
  if (!routes) return asNamed;
  const missing: Served = found.ok ? { ok: false, status: HttpStatus.NotFound } : found;
  const route = spaFallback(requested, missing, entryPath, request);
  if (route === null) return asNamed;
  const served = await servedLocation(route, roots);
  return served.ok ? { relative: route, served, routed: true } : asNamed;
}

/**
 * The address the studio treats a routed response as being served from: this request's own
 * protocol and host (`project://` has an opaque origin) and the entry's path, so a file name that reads as an authority (`\\host\\x`) stays a path.
 */
export function routedDocumentUrl(requestUrl: string, relative: string): string {
  const encoded = relative.split("/").map(encodeURIComponent).join("/");
  const { protocol, host } = new URL(requestUrl);
  return `${protocol}//${host}/${encoded}`;
}

/**
 * Where a loopback page is opened. The entry `index.html` is the app's root, so it is opened at
 * `/` — or at its site base, `/my-site/`, for a page built for a sub-path: a router that reads
 * `location.pathname` then sees the path its routes are written for, not `/index.html`. Any other
 * entry keeps its own path; its query rides along either way.
 */
export function loopbackEntryUrl(port: number, entry: string, siteBase: string | null = null): string {
  const cut = entry.search(/[?#]/);
  const file = cut < 0 ? entry : entry.slice(0, cut);
  const rest = cut < 0 ? "" : entry.slice(cut);
  const under = siteBase ? `${siteBase.split("/").map(encodeURIComponent).join("/")}/` : "";
  return `http://localhost:${port}/${under}${file === "index.html" ? "" : file}${rest}`;
}

/**
 * A request under a worktree's `node_modules` (at its root, or beside a nested repository's
 * package.json), served from the live project's packages — only when that `node_modules` resolves to
 * exactly the live folder's own at the same place, and the file's real path stays inside it.
 * Null when the request is not one of those.
 */
async function resolveLinkedModules(base: string, liveRoot: string, rel: string): Promise<Served | null> {
  const root = path.resolve(base);
  const lexical = path.resolve(root, rel);
  if (!isInside(root, lexical)) return null;
  const parts = path.relative(root, lexical).split(path.sep);
  const at = parts.indexOf("node_modules");
  if (at < 0) return null;
  const prefix = parts.slice(0, at + 1);
  let own: string;
  try {
    const linked = await realpath(path.join(root, ...prefix));
    own = await realpath(path.join(path.resolve(liveRoot), ...prefix));
    if (linked !== own) return null;
  } catch {
    return null;
  }
  return resolveServed(own, parts.slice(at + 1).join(path.sep) || ".");
}

/** What {@link routeHttp} decides for one request: serve it from a project's folder, or refuse it. */
export const HttpRouteKind = { Serve: "serve", Deny: "deny" } as const;
export type HttpRouteKind = (typeof HttpRouteKind)[keyof typeof HttpRouteKind];

/**
 * What the project partition's http handler does with a request. A loopback origin on a port handed
 * out by `loopbackPortFor` is that project's file server; everything else is a 403 (SECUI-3). It used
 * to be re-fetched from the main process, which sent a project's plain-http beacon out of the machine.
 */
export type HttpRoute = { route: typeof HttpRouteKind.Serve; project: string } | { route: typeof HttpRouteKind.Deny };

/** The host names that reach this Mac's own loopback interface. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);

/** A plain-http address on this Mac's loopback interface. */
function isLoopbackHttp(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

export function routeHttp(url: string | URL, loopbackPorts: ReadonlyMap<number, string>): HttpRoute {
  const parsed = typeof url === "string" ? new URL(url) : url;
  const project = isLoopbackHttp(parsed) ? loopbackPorts.get(Number(parsed.port)) : undefined;
  return project ? { route: HttpRouteKind.Serve, project } : { route: HttpRouteKind.Deny };
}

function parseUrl(url: string | URL): URL | null {
  if (url instanceof URL) return url;
  try {
    return new URL(String(url ?? ""));
  } catch {
    return null;
  }
}

/**
 * What the preview's contents are told beyond the request filter (M7). WebRTC's ICE and STUN
 * traffic is UDP that `webRequest` never sees; with non-proxied UDP disabled a page cannot open a
 * peer connection that carries data off the machine. (Electron offers no per-session switch for
 * DNS prefetch; a redirect from an allowed CDN to another host is a new request, and
 * `onBeforeRequest` filters it again.)
 */
export function confinePreviewContents(contents: {
  setWebRTCIPHandlingPolicy(policy: "disable_non_proxied_udp"): void;
}): void {
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
}

/**
 * The project partition's network allowlist (SECUI-3), for `webRequest.onBeforeRequest`. A project may
 * reach the studio's own `project:` server, inline `data:`/`blob:` content, DevTools, the loopback
 * port the studio handed this project, and https reads of the public library/font CDNs in
 * substrate/preview-network.ts. Everything else — other hosts, writes to a CDN, websockets, other
 * loopback ports, `file:` — is cancelled, so what an agent wrote into a project cannot leave the
 * machine when the studio loads the page to look at it. `method` defaults to a read.
 */
export function projectRequestAllowed(
  url: string | URL,
  loopbackPorts: ReadonlyMap<number, string>,
  method = "GET",
): boolean {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  switch (parsed.protocol) {
    case "project:":
    case "data:":
    case "blob:":
    case "devtools:":
      return true;
    case "http:":
      return routeHttp(parsed, loopbackPorts).route === HttpRouteKind.Serve;
    case "https:":
      return isPreviewCdnRead(parsed, method);
    default:
      return false;
  }
}

/**
 * Where a page in the preview may navigate (SECUI-3), for `will-navigate`/`will-frame-navigate`.
 * The top level stays on `project:` or the project's registered loopback origin, so a project cannot put a
 * remote page — a fake sign-in form — inside the studio's chrome, which has no URL bar. An
 * embedded frame may also hold content the page already has (`about:blank`, `about:srcdoc`,
 * `data:`, `blob:`); nothing remote either way.
 */
export function previewNavigationAllowed(
  url: string | URL,
  loopbackPorts: ReadonlyMap<number, string>,
  frame: { mainFrame: boolean },
): boolean {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  if (parsed.protocol === "project:") return true;
  if (parsed.protocol === "http:") return routeHttp(parsed, loopbackPorts).route === HttpRouteKind.Serve;
  if (frame.mainFrame) return false;
  if (parsed.protocol === "about:") return parsed.pathname === "blank" || parsed.pathname === "srcdoc";
  return parsed.protocol === "data:" || parsed.protocol === "blob:";
}
