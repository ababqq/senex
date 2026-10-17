import { init, parse } from "es-module-lexer";
import path from "node:path";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
  lstat,
  stat,
  realpath,
  copyFile,
  rename,
  rm,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import type { ExportResult } from "../shared/project-folder.ts";
import { containedReal, isBelow, isInside, toPosixRelative } from "./paths.ts";
import { fileUnder, inferSiteBase, withoutSiteBase } from "./site-base.ts";
import { MIN_SECRET_LENGTH } from "../shared/redact.ts";

/** The one dot-folder a site publishes on purpose (`security.txt`, `assetlinks.json`). */
const WELL_KNOWN = ".well-known";

/**
 * Never public, whatever is being exported: dotfiles (the well-known folder aside), dependencies,
 * caches, and anything shaped like a secret, a key, a source map or a log.
 */
const neverPublic = (name: string) =>
  (name.startsWith(".") && name !== WELL_KNOWN) ||
  /^(node_modules|cache|__pycache__)$/i.test(name) ||
  /\.(pem|key|p12|pfx|jks|keystore|env|map|log)$/i.test(name) ||
  /^(id_rsa|id_ed25519|credentials|secrets|env)(\.|$)/i.test(name);

/**
 * What the studio itself writes into a project's folder — the agents' rules (`AGENTS.md`,
 * `CLAUDE.md`, `CLAUDE.own.md`) and the decision logs (`NOTES.md`, `NOTES.<facet>.md`) — which a
 * build that copies the project's files could carry into its output. Never public.
 */
const studioAuthored = (name: string) =>
  /^(AGENTS|CLAUDE)(\.own)?\.(md|markdown)$/i.test(name) || /^NOTES(\.[\w-]+)?\.(md|markdown)$/i.test(name);

/** The folder the studio keeps its reference stills in, at the root of a project. */
const REFERENCES_FOLDER = /^references$/i;

/**
 * A project's working folders and pages. They keep a project's *source* export to its public
 * files, and mean nothing in a build's output, where `docs/`, `notes.html` and a `tests/` demo
 * page are the site.
 */
const devScaffolding = (name: string) =>
  /^(references|coverage|tests?|docs|archive|research|evidence|captures|screenshots|logs)$/i.test(name) ||
  /^(NOTES|README|PLAN)(\.|$)/i.test(name);

/**
 * Which names an export leaves out: a build's output keeps every file that is not never-public or
 * the studio's own (its reference stills are the root `references/` folder, not any folder of that name).
 */
function leftOut(name: string, buildFolder: boolean, atRoot: boolean): boolean {
  if (neverPublic(name) || studioAuthored(name)) return true;
  if (buildFolder) return atRoot && REFERENCES_FOLDER.test(name);
  return devScaffolding(name);
}

/** Whether any part of a `/`- or `\`-separated path is left out, the first counting as the root. */
function leftOutPath(rel: string, buildFolder: boolean): boolean {
  return rel.split(/[\\/]/).some((part, depth) => leftOut(part, buildFolder, depth === 0));
}

/** `project.export` answers this to the harness, so it lives in `shared/project-folder.ts`. */
export type { ExportResult };

export interface ExportOptions {
  /**
   * The folder is a build's output, a dedicated folder whose every file is the site. Without it the
   * folder is a project's sources and the studio's scaffolding and working folders stay out.
   */
  buildFolder?: boolean;
  /**
   * The credential values Studio holds (the same set its log redactor uses). A public file that
   * contains one stops the export: a token an agent wrote into a project must not be published.
   */
  secretValues?: Iterable<string>;
}

/** Past this a file is an asset, not a place a token was pasted; it is not read whole to check. */
const MAX_SCANNED_BYTES = 32 * 1024 * 1024;

/** The marker file an export writes, which is what lets a later export replace the folder. */
const EXPORT_MANIFEST = ".studio-export.json";
/** What the marker file holds when the folder is an app-managed export. */
const EXPORT_MARK = '"studioExport":1';
/** The staging folder's name prefix, beside the target. */
const STAGING_PREFIX = ".studio-export-";
/** Where the vendored library sits inside an export. */
const VENDOR_DIR = "vendor";
/** The Basis transcoder KTX2Loader loads at run time, which no import names. */
const BASIS_DIR = "vendor/three/examples/jsm/libs/basis/";
const BASIS_FILES = ["basis_transcoder.js", "basis_transcoder.wasm"];

const MESSAGE = {
  InsideProject: "Export destination must be outside the project",
  ResolvesInsideProject: "Export destination must resolve outside the project",
  NotADirectory: "Export target must be an ordinary directory",
  NotAnExport: "Export target is not an app-managed export; choose an empty directory",
  InvalidPublicPath: (rel: string) => `Invalid public path: ${rel}`,
  MissingPublicPath: (rel: string) => `Selected public path is missing or unreadable: ${rel}`,
  Symlink: (rel: string) => `Export refuses symlink: ${rel}`,
  NotAFile: (rel: string) => `Not a public file: ${rel}`,
  SecretLeaked: (rel: string) =>
    `Export stopped: ${rel} contains a credential Studio holds (an API key or sign-in token). Remove it from the project and export again.`,
  NoEntry: "Export needs index.html in the public selection/build output",
  ScopedImportMap: "Export validation does not yet support scoped import maps; build this project before export",
  UnresolvedModule: (ref: string) => `Export has an unresolved module: ${ref}`,
  MissingReference: (ref: string, from: string) => `Export is missing a referenced public file: ${ref} in ${from}`,
  LeftOutReference: (ref: string, from: string) =>
    `Export left out ${ref}, which ${from} refers to: a name that looks like a secret, a dotfile, a dependency folder, a source map or a working folder is never published. Rename it, or stop referring to it, and export again.`,
} as const;

/** The first staged file that contains a held credential, byte for byte (text or binary). */
async function fileWithSecret(staging: string, files: string[], values: Iterable<string>): Promise<string | undefined> {
  const needles = [...new Set(values)]
    .filter((v) => typeof v === "string" && v.length >= MIN_SECRET_LENGTH)
    .map((v) => Buffer.from(v));
  if (!needles.length) return undefined;
  for (const rel of files) {
    const file = path.join(staging, rel);
    if ((await lstat(file)).size > MAX_SCANNED_BYTES) continue;
    const bytes = await readFile(file);
    if (needles.some((needle) => bytes.includes(needle))) return rel;
  }
  return undefined;
}

/** Either folder holds the other. */
function overlaps(a: string, b: string): boolean {
  return isInside(a, b) || isInside(b, a);
}

/** Whether an existing target folder may be replaced: empty, or an export this app wrote. */
async function isReplaceableExport(target: string): Promise<boolean> {
  if ((await readdir(target)).length === 0) return true;
  return (await readFile(path.join(target, EXPORT_MANIFEST), "utf8").catch(() => "")).includes(EXPORT_MARK);
}

/**
 * Where the export goes, resolved by realpath through its parent, and what is there now. The
 * destination may never hold the project or sit inside it, before or after links are followed.
 */
async function resolveExportTarget(
  source: string,
  requested: string,
): Promise<{ target: string; parent: string; existing: Stats | null }> {
  const lexical = path.resolve(requested);
  if (overlaps(source, lexical)) throw new Error(MESSAGE.InsideProject);
  await mkdir(path.dirname(lexical), { recursive: true });
  const parent = await realpath(path.dirname(lexical));
  const target = path.join(parent, path.basename(lexical));
  if (overlaps(source, target)) throw new Error(MESSAGE.ResolvesInsideProject);
  const existing = await lstat(target).catch(() => null);
  const plainDirectory = existing?.isDirectory() && !existing.isSymbolicLink();
  if (existing && !plainDirectory) throw new Error(MESSAGE.NotADirectory);
  if (existing && !(await isReplaceableExport(target))) throw new Error(MESSAGE.NotAnExport);
  return { target, parent, existing };
}

/** Reject interior symlinks as well as symlink leaves, including a selected nested root. */
async function refuseSymlinkOnTheWay(base: string, parts: string[], rel: string): Promise<void> {
  let parentPath = base;
  for (const part of parts) {
    parentPath = path.join(parentPath, part);
    if ((await lstat(parentPath)).isSymbolicLink()) throw new Error(MESSAGE.Symlink(rel));
  }
}

/** Copy one approved public path (a file, or a folder walked recursively) into staging. */
async function stagePath(
  staging: string,
  result: ExportResult,
  base: string,
  rel: string,
  options: { buildFolder: boolean },
  destRel = rel,
): Promise<void> {
  const parts = rel.split(/[\\/]/);
  if (path.isAbsolute(rel) || parts.includes("..")) throw new Error(MESSAGE.InvalidPublicPath(rel));
  if (leftOutPath(rel, options.buildFolder)) {
    result.excluded.push(destRel);
    return;
  }
  const src = path.join(base, rel);
  const st = await lstat(src).catch(() => null);
  if (!st) throw new Error(MESSAGE.MissingPublicPath(rel));
  await refuseSymlinkOnTheWay(base, parts, rel);
  if (st.isDirectory()) {
    for (const name of await readdir(src)) {
      // `/`-joined on every platform: these are the export's own names, listed and compared as such.
      await stagePath(staging, result, base, path.posix.join(rel, name), options, path.posix.join(destRel, name));
    }
    return;
  }
  if (!st.isFile()) throw new Error(MESSAGE.NotAFile(rel));
  const dest = path.join(staging, destRel);
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(src, dest);
  result.included.push(destRel);
}

/** Whether `rel` is a staged file of the vendored library (only when one was staged). */
function isVendorFile(rel: string, vendor: string | undefined): boolean {
  return Boolean(vendor) && rel.startsWith(`${VENDOR_DIR}/`);
}

/** Stage the page, rewritten so root-relative vendor and source URLs work from any folder. */
async function rewriteEntry(staging: string): Promise<{ entry: string; html: string }> {
  const entry = path.join(staging, "index.html");
  const original = await readFile(entry, "utf8").catch(() => null);
  if (original === null) throw new Error(MESSAGE.NoEntry);
  const html = original.replaceAll('"/vendor/', '"./vendor/').replaceAll('"/src/', '"./src/');
  await writeFile(entry, html);
  return { entry, html };
}

/** The page's import map (`imports` only; a scoped map is refused). */
function importMapOf(html: string): Record<string, string> {
  const imports: Record<string, string> = {};
  for (const { attributes, body } of pageParts(html).scripts) {
    if (attributes.get("type")?.trim().toLowerCase() !== "importmap") continue;
    const map = JSON.parse(body);
    for (const [key, value] of Object.entries(map.imports ?? {})) if (typeof value === "string") imports[key] = value;
    if (map.scopes && Object.keys(map.scopes).length) throw new Error(MESSAGE.ScopedImportMap);
  }
  return imports;
}

/** What the reference check walks with: the staged page, its import map, and the modules still to read. */
interface ReferenceCheck {
  staging: string;
  entry: string;
  imports: Record<string, string>;
  queue: string[];
  visited: Set<string>;
  /** Vendored files something in the export actually loads. */
  neededVendor: Set<string>;
  /** What the export left out on purpose (`ExportResult.excluded`): a reference to one is not a typo. */
  leftOut: readonly string[];
  /** The sub-path the built page names its files under (`/my-site/…`), when the files sit without it. */
  siteBase: string | null;
  /** When set, references are gathered into it (as paths in the folder) instead of checked: see {@link siteRoots}. */
  collect?: Set<string>;
  /** A project module imports by a name only the running page knows (`import(cond ? "a" : "b")`). */
  opaqueImport: boolean;
}

/** A bare module specifier through the import map: the longest key that answers it wins. */
function mapBareSpecifier(imports: Record<string, string>, ref: string): string {
  const match = Object.entries(imports)
    .sort(([a], [b]) => b.length - a.length)
    .find(([key]) => key === ref || (key.endsWith("/") && ref.startsWith(key)));
  if (!match) throw new Error(MESSAGE.UnresolvedModule(ref));
  const [key, target] = match;
  return target + ref.slice(key.length);
}

/** Whether `file` is a regular file inside the export. */
async function isStagedFile(staging: string, file: string): Promise<boolean> {
  return isInside(staging, file) && (await lstat(file).catch(() => null))?.isFile() === true;
}

/**
 * The staged file a reference means. A path is read from the page it is in, or from the export's
 * root when it begins with a slash; a root-absolute one that names no file is read again without
 * the site base the page was built for, which is where its file is.
 */
async function stagedFile(check: ReferenceCheck, pathname: string, from: string): Promise<string> {
  if (!pathname.startsWith("/")) return path.resolve(path.dirname(from), pathname);
  const asWritten = path.resolve(check.staging, `.${pathname}`);
  const stripped = withoutSiteBase(pathname.slice(1), check.siteBase);
  if (!stripped || (await isStagedFile(check.staging, asWritten))) return asWritten;
  return path.resolve(check.staging, stripped);
}

/**
 * Gather one reference instead of checking it: a file (or a link, which staging refuses by name)
 * inside the folder is a public file; a folder, a path outside it and a path nothing answers are
 * not. A style sheet or a module that is not left out is read in turn.
 */
async function collectReference(
  check: ReferenceCheck,
  collect: Set<string>,
  file: string,
  module: boolean,
): Promise<void> {
  const inside = isInside(check.staging, file) && file !== check.staging;
  const info = inside ? await lstat(file).catch(() => null) : null;
  if (!info || !(info.isFile() || info.isSymbolicLink())) return;
  const rel = toPosixRelative(path.relative(check.staging, file));
  if (collect.has(rel)) return;
  collect.add(rel);
  const readable = info.isFile() && !leftOutPath(rel, false);
  const asModule = module && /\.m?js$/i.test(file);
  if (readable && (asModule || /\.css$/i.test(file))) check.queue.push(file);
}

/**
 * One reference from a staged file: it must name a regular file inside the export. A module
 * reference is followed (queued); a vendored file it reaches is kept. Remote URLs, fragments and
 * a bare specifier the map sends off-machine are not the export's to check.
 */
async function checkReference(
  check: ReferenceCheck,
  reference: string,
  referrer: string,
  module = false,
  /** A module specifier, which the import map names, rather than a URL a tag spells (`src="main.js"`). */
  specifier = module,
): Promise<void> {
  if (/^(?:[a-z]+:|\/\/|#)/i.test(reference)) return;
  let ref = reference;
  let from = referrer;
  const bareSpecifier = specifier && !ref.startsWith(".") && !ref.startsWith("/");
  if (bareSpecifier) {
    ref = mapBareSpecifier(check.imports, ref);
    from = check.entry;
    if (/^(?:[a-z]+:|\/\/)/i.test(ref)) return;
  }
  const pathname = decodeURIComponent(ref.split(/[?#]/)[0] ?? "");
  if (!pathname) return;
  const { staging } = check;
  const file = await stagedFile(check, pathname, from);
  if (check.collect) return collectReference(check, check.collect, file, module);
  if (!(await isStagedFile(staging, file))) {
    const named = toPosixRelative(path.relative(staging, file));
    const cause = check.leftOut.some((rel) => named === rel || named.startsWith(`${rel}/`))
      ? MESSAGE.LeftOutReference
      : MESSAGE.MissingReference;
    throw new Error(cause(ref, toPosixRelative(path.relative(staging, from))));
  }
  if (isBelow(path.join(staging, VENDOR_DIR), file))
    check.neededVendor.add(toPosixRelative(path.relative(staging, file)));
  if (module && /\.m?js$/i.test(file)) check.queue.push(file);
}

/** A left-out root as the staged tree spells its files: `/`-separated, with no `./` and no trailing slash. */
function stagedName(rel: string): string {
  return path.posix.normalize(rel.replaceAll("\\", "/")).replace(/\/+$/, "");
}

/**
 * Check what a script's imports name. `tolerant` is for a classic script, which the lexer may not
 * be able to read at all: then there is nothing to follow, and nothing is refused for it.
 */
async function scanModule(check: ReferenceCheck, text: string, file: string, tolerant = false): Promise<void> {
  let specifiers: ReturnType<typeof parse>[0];
  try {
    [specifiers] = parse(text);
  } catch (error) {
    if (tolerant) return;
    throw error;
  }
  const vendored = isBelow(path.join(check.staging, VENDOR_DIR), file);
  for (const specifier of specifiers) {
    if (specifier.n !== undefined) {
      await checkReference(check, specifier.n, file, true);
      continue;
    }
    const computed = specifier.d > -1 && !namesProjectFile(text.slice(specifier.s, specifier.e));
    if (computed && !vendored) check.opaqueImport = true;
  }
}

/** Whether a computed `import()` argument starts as a path (`"./pages/" + name`): a file of the project, never a map name. */
function namesProjectFile(expression: string): boolean {
  return /^\s*["'`](?:\.{1,2}\/|\/)/.test(expression);
}

/** Tags whose `src` names a file the page loads. */
const SRC_TAGS: ReadonlySet<string> = new Set([
  "script",
  "img",
  "image",
  "source",
  "video",
  "audio",
  "track",
  "iframe",
  "embed",
  "input",
]);
/** SVG tags whose `href` (or `xlink:href`) names a file. */
const HREF_TAGS: ReadonlySet<string> = new Set(["image", "use"]);
/** The `rel` values of a `<link>` whose `href` names a file the page loads, as against a page it points to. */
const LOADED_RELS: ReadonlySet<string> = new Set([
  "stylesheet",
  "icon",
  "shortcut",
  "mask-icon",
  "preload",
  "modulepreload",
  "prefetch",
  "manifest",
]);

/** One attribute of a tag: its name, and its value quoted either way or not at all. */
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
/**
 * What a page is made of, in document order: a comment (skipped), an element whose body is text
 * (`script`, `style`, `textarea`: what is inside is code, never tags) and any other tag. A tag's
 * quoted values may hold a `>`, and `<script-loader>` is not a script.
 */
const PAGE_NODE =
  /<!--(?:-?>|[\s\S]*?-->)|<(script|style|textarea)(?![\w:-])((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/\1\s*>|<([a-z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;

/** A tag's attributes by lower-case name, as a browser reads them: the first of a name wins. */
function attributesOf(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const [, name = "", double, single, bare] of text.matchAll(ATTRIBUTE)) {
    const key = name.toLowerCase();
    if (!attributes.has(key)) attributes.set(key, double ?? single ?? bare ?? "");
  }
  return attributes;
}

/** What a page loads and runs: the files its tags name, and its scripts with their bodies. */
interface PageParts {
  files: string[];
  scripts: Array<{ attributes: Map<string, string>; body: string }>;
}

/**
 * The files a page's own tags load. A link to another page (`<a href>`, `<area>`, `<base>`, a
 * canonical or alternate `<link>`) is navigation: it may name the site's root, a folder, a clean
 * URL or another site, none of which is a file the export has to hold.
 */
function pageParts(html: string): PageParts {
  const parts: PageParts = { files: [], scripts: [] };
  for (const [node, rawName, rawAttributes = "", body = "", tagName, tagAttributes = ""] of html.matchAll(PAGE_NODE)) {
    if (node.startsWith("<!--")) continue;
    const name = (rawName ?? tagName ?? "").toLowerCase();
    const attributes = attributesOf(rawName ? rawAttributes : tagAttributes);
    parts.files.push(...filesOfTag(name, attributes));
    if (name === "script" && rawName) parts.scripts.push({ attributes, body });
  }
  return parts;
}

/** The sub-path a page's root-absolute file URLs agree on, judged by the files under `root`. */
function pageSiteBase(html: string, root: string): Promise<string | null> {
  return inferSiteBase(pageParts(html).files, fileUnder(root));
}

/**
 * The site base a built entry page names its files under, found on the files of `root` (null when
 * the page names none, the entry is missing or unreadable, or it is not a file inside `root`).
 * The entry is read only through a contained real path.
 */
export async function siteBaseOfEntry(root: string, entry: string): Promise<string | null> {
  try {
    const file = await containedReal(root, entry.split(/[?#]/)[0] ?? "");
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_SCANNED_BYTES) return null;
    return await pageSiteBase(await readFile(file, "utf8"), root);
  } catch {
    return null;
  }
}

/** The files one tag loads: a media tag's `src` (and a video's poster), a `<link>`'s `href` when its `rel` says so. */
function filesOfTag(name: string, attributes: Map<string, string>): string[] {
  const named = (...keys: string[]): string[] =>
    keys.flatMap((key) => (attributes.get(key) ? [attributes.get(key) ?? ""] : []));
  if (name === "link") {
    const rels = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/);
    const loaded = rels.some((rel) => LOADED_RELS.has(rel) || rel.startsWith("apple-touch"));
    return loaded ? named("href") : [];
  }
  const hrefs = HREF_TAGS.has(name) ? named("href", "xlink:href") : [];
  if (!SRC_TAGS.has(name)) return hrefs;
  if (name === "input" && attributes.get("type")?.toLowerCase() !== "image") return hrefs;
  return [...hrefs, ...(name === "video" ? named("src", "poster") : named("src"))];
}

/** Whether a script's `type` makes it code the page runs, and as a module or as a classic script. */
function scriptKind(type: string | undefined): "module" | "classic" | null {
  const kind = (type ?? "").trim().toLowerCase();
  if (kind === "module") return "module";
  return kind === "" || /^(?:text|application)\/(?:x-)?(?:java|ecma)script$/.test(kind) ? "classic" : null;
}

async function scanHtml(check: ReferenceCheck, text: string, file: string): Promise<void> {
  const { files, scripts } = pageParts(text);
  // A tag's `src="main.js"` is a URL relative to the page; only a module's own imports are names.
  for (const ref of files) await checkReference(check, ref, file, /\.m?js(?:[?#]|$)/i.test(ref), false);
  for (const { attributes, body } of scripts) {
    // A script with a source ignores its body.
    if (attributes.has("src")) continue;
    const kind = scriptKind(attributes.get("type"));
    // A classic script can still `import()` a library: its body is read for that alone.
    if (kind !== null) await scanModule(check, body, file, kind === "classic");
  }
}

/** One staged project file: HTML and CSS references are checked, modules queued. */
async function scanStagedFile(check: ReferenceCheck, rel: string): Promise<void> {
  if (!/\.(html|m?js|css)$/i.test(rel)) return;
  const file = path.join(check.staging, rel);
  const text = await readFile(file, "utf8");
  if (/\.html$/i.test(rel)) await scanHtml(check, text, file);
  if (/\.m?js$/i.test(rel)) check.queue.push(file);
  if (/\.css$/i.test(rel)) await scanStyles(check, text, file);
}

/** The files a style sheet loads: its `url()`s, and (when gathering) its string `@import`s. */
async function scanStyles(check: ReferenceCheck, text: string, file: string): Promise<void> {
  for (const [, url = ""] of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g))
    await checkReference(check, url.trim(), file);
  // `@import "tailwindcss"` names a package, not a file: it is only followed to gather what exists.
  if (!check.collect) return;
  for (const [, url = ""] of text.matchAll(/@import\s+["']([^"']+)["']/g)) await checkReference(check, url, file);
}

/**
 * Follow actual module specifiers, not strings in comments/examples: every reference the staged
 * page, its styles and its modules make must be a file in the export. Returns the vendored files
 * those references reach.
 */
async function checkReferences(
  staging: string,
  page: { entry: string; html: string },
  included: string[],
  leftOut: readonly string[],
  vendor: string | undefined,
  collect?: Set<string>,
): Promise<Set<string>> {
  await init;
  const check: ReferenceCheck = {
    staging,
    entry: page.entry,
    imports: importMapOf(page.html),
    queue: [],
    visited: new Set(),
    neededVendor: new Set(),
    leftOut: leftOut.map(stagedName),
    siteBase: await pageSiteBase(page.html, staging),
    ...(collect ? { collect } : {}),
    opaqueImport: false,
  };
  for (const rel of included) {
    if (isVendorFile(rel, vendor)) continue;
    await scanStagedFile(check, rel);
  }
  await drainModules(check);
  // A name only the running page can work out (`import(gpu ? "three/webgpu" : "three")`) may reach
  // any library the page's import map names: with one in the project, those entries and what they
  // import stay (a prefix entry like `three/addons/` is not followed). A page that imports only
  // what it spells out ships only what it reaches — a todo list on the starter's map ships none of
  // the 3D library.
  if (check.opaqueImport) {
    for (const ref of Object.values(check.imports))
      if (!ref.endsWith("/")) await checkReference(check, ref, page.entry, true);
    await drainModules(check);
  }
  return check.neededVendor;
}

/** Read every queued module once, following its imports into the queue. */
async function drainModules(check: ReferenceCheck): Promise<void> {
  for (let file = check.queue.pop(); file !== undefined; file = check.queue.pop()) {
    if (check.visited.has(file)) continue;
    check.visited.add(file);
    const text = await readFile(file, "utf8");
    if (/\.css$/i.test(file)) await scanStyles(check, text, file);
    else await scanModule(check, text, file);
  }
}

/** Drop the vendored files nothing loads (licences and notices stay), moving them to `excluded`. */
async function pruneUnusedVendor(staging: string, result: ExportResult, neededVendor: Set<string>): Promise<void> {
  if ([...neededVendor].some((file) => file.endsWith("/KTX2Loader.js")))
    for (const file of BASIS_FILES) neededVendor.add(BASIS_DIR + file);
  const unused = result.included.filter(
    (rel) => rel.startsWith(`${VENDOR_DIR}/`) && !neededVendor.has(rel) && !/LICENSE|NOTICE|VERSION/i.test(rel),
  );
  for (const rel of unused) await rm(path.join(staging, rel));
  result.excluded.push(...unused);
  const removed = new Set(unused);
  result.included = result.included.filter((rel) => !removed.has(rel));
}

/** Put the staged export where the target was, keeping the previous one until the swap succeeded. */
async function swapIntoPlace(staging: string, target: string, existing: Stats | null): Promise<void> {
  const backup = `${target}.previous-${Date.now()}`;
  if (existing) await rename(target, backup);
  try {
    await rename(staging, target);
  } catch (e) {
    if (existing) await rename(backup, target);
    throw e;
  }
  if (existing) await rm(backup, { recursive: true, force: true });
}

/** The pages under `rel`: `.html` files in folders that are not left out, links neither followed nor counted. */
async function findPages(source: string, rel: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(source, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (leftOut(entry.name, false, rel === "")) continue;
    if (entry.isDirectory()) found.push(...(await findPages(source, child)));
    else if (entry.isFile() && /\.html$/i.test(entry.name)) found.push(child);
  }
  return found;
}

/**
 * The public files of a site no build made: every page in the folder and each file those pages,
 * their style sheets and their modules load (the walk the export check makes, run over the
 * source). Nothing a page does not name is public by default — a backup, a manifest, the studio's
 * own files — and a folder is never proposed whole. A file a page names but export leaves out is
 * proposed too, so staging says why. Read-only; the errors of the walk (a scoped import map, an
 * unresolved module) surface as the export would raise them.
 */
export async function siteRoots(sourceDir: string): Promise<string[]> {
  const source = await realpath(sourceDir);
  const pages = await findPages(source, "");
  const entry = path.join(source, "index.html");
  const html = await readFile(entry, "utf8").catch(() => "");
  const collect = new Set(pages);
  await checkReferences(source, { entry, html }, pages, [], undefined, collect);
  return [...collect].sort();
}

/** Assemble only approved public roots, never a recursive copy of a development project. */
export async function exportPublicProject(
  sourceDir: string,
  targetDir: string,
  roots: string[],
  vendor?: string,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const source = await realpath(sourceDir);
  const { target, parent, existing } = await resolveExportTarget(source, targetDir);
  const staging = await mkdtemp(path.join(parent, STAGING_PREFIX));
  const result: ExportResult = { dir: target, files: 0, included: [], excluded: [] };
  try {
    const staged = { buildFolder: options.buildFolder === true };
    for (const root of roots) await stagePath(staging, result, source, root, staged);
    if (vendor) {
      const names = await readdir(vendor);
      for (const name of names)
        await stagePath(staging, result, await realpath(vendor), name, staged, path.posix.join(VENDOR_DIR, name));
    }
    // Studio's own vendored library is not the project's to leak into; everything else is checked.
    const leaked = options.secretValues
      ? await fileWithSecret(
          staging,
          result.included.filter((rel) => !isVendorFile(rel, vendor)),
          options.secretValues,
        )
      : undefined;
    if (leaked) throw new Error(MESSAGE.SecretLeaked(leaked));
    const page = await rewriteEntry(staging);
    const neededVendor = await checkReferences(staging, page, result.included, result.excluded, vendor);
    if (vendor) await pruneUnusedVendor(staging, result, neededVendor);
    result.files = result.included.length;
    await writeFile(
      path.join(staging, EXPORT_MANIFEST),
      JSON.stringify({ studioExport: 1, included: result.included }),
    );
    await swapIntoPlace(staging, target, existing);
    return result;
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    throw e;
  }
}
