/**
 * The static server every grader loads a snapshot through (§8.2 Serving). Written fresh: the
 * genex-demo calibration server contained paths with `startsWith`, which lets `/root-evil` pass
 * for `/root` and follows a symlink anywhere it points.
 *
 * It binds `127.0.0.1` only and answers GET and HEAD. A request path is decoded once (a malformed
 * escape or a NUL is refused), resolved against its root, and served only when the resolved
 * *real* path — every symlink on the way followed — still lies under the root's own real path:
 * `path.relative(realRoot, realTarget)` may not climb out or be absolute. `/vendor/**` maps to
 * the app's `resources/vendor`, the three.js the template's import map names; a vendor folder that
 * does not exist is a typed refusal (`vendor-missing`), never a quiet fall-through to the snapshot,
 * which would fail every template project's boot. A Host header that is not this server is refused, so
 * a page elsewhere cannot rebind a name onto it.
 */
import { createReadStream } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createHash } from "node:crypto";
import type { SandboxOptions } from "../../../src/substrate/spawn.ts";
import type { EvalsPaths } from "../ledger/paths.ts";
import {
  type CopyRequest,
  type PreparedCopy,
  type SandboxRun,
  buildSandboxOptions,
  createCopyBuilder,
} from "./build-copy.ts";
import type { ServeHandle, ServeOptions, ServeSnapshot } from "./types.ts";
import { type NoBuild, ShimMode, type ServedVia } from "../vocabulary.ts";

/** The only address the grader's server ever binds. */
export const SERVE_HOST = "127.0.0.1";
/** The URL prefix served from the app's vendor folder instead of the snapshot. */
export const VENDOR_PREFIX = "/vendor/";
/** The file a usable vendor folder holds: the three.js module the template's import map names first. */
export const VENDOR_ENTRY = "three.module.js";
/** What a folder request serves. */
const INDEX_FILE = "index.html";
/** How many hex characters of the snapshot path's digest name its copy folder. */
const COPY_NAME_LENGTH = 16;
/** The type a file with an unknown extension is served as; `nosniff` keeps it inert. */
const DEFAULT_MIME = "application/octet-stream";

/** Content types by extension: everything a web project ships, from modules to compressed textures. */
export const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".ktx2": "image/ktx2",
  ".basis": "application/octet-stream",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
  ".hdr": "image/vnd.radiance",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

/** The statuses the server answers with. */
const Status = {
  Ok: 200,
  BadRequest: 400,
  Forbidden: 403,
  NotFound: 404,
  MethodNotAllowed: 405,
} as const;
type Status = (typeof Status)[keyof typeof Status];

/** Why serving a snapshot was refused. */
export const ServeErrorCode = {
  /** `inject-for-all` was asked, and no shim exists to inject until spike S3 says one is needed. */
  ShimUnsupported: "shim-unsupported",
  /** The vendor folder `/vendor/**` maps to does not exist (no `npm run build`, or a missing app build). */
  VendorMissing: "vendor-missing",
} as const;
export type ServeErrorCode = (typeof ServeErrorCode)[keyof typeof ServeErrorCode];

/** A typed refusal to serve. */
export class ServeError extends Error {
  readonly code: ServeErrorCode;

  constructor(code: ServeErrorCode) {
    super(code);
    this.name = "ServeError";
    this.code = code;
  }
}

/** The real roots one server answers from. */
interface ServedRoots {
  root: string;
  vendor: string | null;
}

/** A request resolved to a contained regular file, or the status that refuses it. */
type Resolution = { file: string } | { status: Status };

/** What a static server needs: the folder to serve, the vendor folder and how the folder came to be. */
export interface StaticServerOptions {
  root: string;
  vendorDir: string | null;
  servedVia: ServedVia;
  /** How the copy's build typed a snapshot with no page (`PreparedCopy.noBuild`); null by default. */
  noBuild?: NoBuild | null;
  /** The query the entry is opened with (`genex_local_test=1` for a Genex project), without `?`. */
  entryQuery?: string;
  /** 0 (the default) picks a free port. */
  port?: number;
}

/** Whether `target` lies outside `base`: its relative path climbs out or is absolute. */
function escapes(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/** The request's path decoded once, or null when it is not a plain path or does not decode. */
function decodePath(rawUrl: string): string | null {
  const [pathOnly = ""] = rawUrl.split(/[?#]/, 1);
  if (!pathOnly.startsWith("/")) return null;
  try {
    const decoded = decodeURIComponent(pathOnly);
    return decoded.includes("\0") ? null : decoded;
  } catch {
    return null;
  }
}

/** The real path of `candidate` when it exists and stays under `base`; a status otherwise. */
async function containedReal(base: string, candidate: string): Promise<{ real: string } | { status: Status }> {
  if (escapes(base, candidate)) return { status: Status.Forbidden };
  const real = await realpath(candidate).catch(() => null);
  if (real === null) return { status: Status.NotFound };
  if (escapes(base, real)) return { status: Status.Forbidden };
  return { real };
}

/** Resolve a request path to a regular file inside its root, following a folder to its index. */
async function resolveRequest(roots: ServedRoots, rawUrl: string): Promise<Resolution> {
  const decoded = decodePath(rawUrl);
  if (decoded === null) return { status: Status.BadRequest };
  const vendored = roots.vendor !== null && decoded.startsWith(VENDOR_PREFIX);
  const base = vendored && roots.vendor !== null ? roots.vendor : roots.root;
  const rel = (vendored ? decoded.slice(VENDOR_PREFIX.length) : decoded).replace(/^\/+/, "");
  const found = await containedReal(base, path.resolve(base, rel));
  if ("status" in found) return found;
  const info = await stat(found.real).catch(() => null);
  if (info?.isFile()) return { file: found.real };
  if (!info?.isDirectory()) return { status: Status.NotFound };
  const index = await containedReal(base, path.join(found.real, INDEX_FILE));
  if ("status" in index) return index;
  const indexInfo = await stat(index.real).catch(() => null);
  return indexInfo?.isFile() ? { file: index.real } : { status: Status.NotFound };
}

/** Answer with a bare status. */
function refuse(response: http.ServerResponse, status: Status): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  response.end(String(status));
}

/** Stream one resolved file. */
async function sendFile(request: http.IncomingMessage, response: http.ServerResponse, file: string): Promise<void> {
  const info = await stat(file);
  response.writeHead(Status.Ok, {
    "content-type": MIME_TYPES[path.extname(file).toLowerCase()] ?? DEFAULT_MIME,
    "content-length": info.size,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const stream = createReadStream(file);
  stream.on("error", () => response.destroy());
  stream.pipe(response);
}

/** The Host values a request to this server may carry. */
function allowedHosts(port: number): Set<string> {
  return new Set([`${SERVE_HOST}:${port}`, `localhost:${port}`]);
}

/** Handle one request against the served roots. */
async function handle(
  roots: ServedRoots,
  hosts: () => Set<string>,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const readOnly = request.method === "GET" || request.method === "HEAD";
  if (!readOnly) return refuse(response, Status.MethodNotAllowed);
  if (!hosts().has(request.headers.host ?? "")) return refuse(response, Status.Forbidden);
  const resolved = await resolveRequest(roots, request.url ?? "");
  if ("status" in resolved) return refuse(response, resolved.status);
  await sendFile(request, response, resolved.file);
}

/** Whether a vendor folder holds the template's three.js (`VENDOR_ENTRY`) as a regular file. */
export async function vendorReady(dir: string): Promise<boolean> {
  const info = await stat(path.join(dir, VENDOR_ENTRY)).catch(() => null);
  return info?.isFile() === true;
}

/** The vendor folder's real path; a named folder that does not exist is refused, never dropped. */
async function realVendor(vendorDir: string | null): Promise<string | null> {
  if (vendorDir === null) return null;
  const real = await realpath(vendorDir).catch(() => null);
  if (real === null) throw new ServeError(ServeErrorCode.VendorMissing);
  return real;
}

/** Start a loopback static server over one folder (and the app's vendor folder). */
export async function startStaticServer(options: StaticServerOptions): Promise<ServeHandle> {
  const roots: ServedRoots = {
    root: await realpath(options.root),
    vendor: await realVendor(options.vendorDir),
  };
  let port = 0;
  const server = http.createServer((request, response) => {
    handle(roots, () => allowedHosts(port), request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else refuse(response, Status.NotFound);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, SERVE_HOST, () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  const origin = `http://${SERVE_HOST}:${port}`;
  const query = options.entryQuery ? `?${options.entryQuery}` : "";
  return {
    url: `${origin}/${query}`,
    origin,
    root: roots.root,
    servedVia: options.servedVia,
    noBuild: options.noBuild ?? null,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Prepares a snapshot's copy for serving; `build-copy.ts` provides the real one. */
export type PrepareCopy = (request: CopyRequest) => Promise<PreparedCopy>;

/** What serving snapshots needs: where copies go and how a copy is prepared. */
export interface ServeSnapshotDeps {
  copiesRoot: string;
  prepare: PrepareCopy;
}

/** The copy folder for one snapshot: stable per snapshot path, so a re-probe reuses it. */
function copyDirFor(copiesRoot: string, snapshotDir: string): string {
  const name = createHash("sha256").update(path.resolve(snapshotDir)).digest("hex").slice(0, COPY_NAME_LENGTH);
  return path.join(copiesRoot, name);
}

/**
 * The grader's {@link ServeSnapshot}: prepare a copy of the (read-only) snapshot, then serve what
 * the copy produced. A copy that produced nothing is still served (its own folder), so the caller
 * sees `servedVia` and decides — `rebuild-failed` is unknown, never "did not boot".
 */
export function createServeSnapshot(deps: ServeSnapshotDeps): ServeSnapshot {
  return async (options: ServeOptions) => {
    if (options.shimMode !== ShimMode.None) throw new ServeError(ServeErrorCode.ShimUnsupported);
    await realVendor(options.vendorDir);
    const copyDir = copyDirFor(deps.copiesRoot, options.root);
    const prepared = await deps.prepare({ snapshotDir: options.root, copyDir, npmCacheDir: options.npmCacheDir });
    // Nothing to serve is still served — an empty folder answers 404 — so the handle carries servedVia.
    if (prepared.servedDir === null) await mkdir(copyDir, { recursive: true });
    return await startStaticServer({
      root: prepared.servedDir ?? copyDir,
      vendorDir: options.vendorDir,
      servedVia: prepared.servedVia,
      noBuild: prepared.noBuild,
      entryQuery: prepared.entryQuery,
    });
  };
}

/** Starts the sandbox copies are built in: `ProcessSandbox.create` on the machine. */
export type CreateSandbox = (options: SandboxOptions) => Promise<{ run: SandboxRun }>;

/**
 * The snapshot server grading and the campaign's canary share, on the evals home's one layout:
 * copies in `paths.serveCopies`, each build writing only its copy and `paths.npmCache`, the
 * sandbox's scratch in `paths.sandboxScratch`. One sandbox, started on first use.
 */
export function sandboxedServe(paths: EvalsPaths, createSandbox: CreateSandbox): ServeSnapshot {
  let started: Promise<ServeSnapshot> | null = null;
  const start = async (): Promise<ServeSnapshot> => {
    await mkdir(paths.serveCopies, { recursive: true });
    const sandbox = await createSandbox(
      buildSandboxOptions({ npmCacheDir: paths.npmCache, scratchDir: paths.sandboxScratch }),
    );
    return createServeSnapshot({
      copiesRoot: paths.serveCopies,
      prepare: createCopyBuilder({ run: (request) => sandbox.run(request) }).prepare,
    });
  };
  return async (options) => {
    started ??= start();
    return (await started)(options);
  };
}
