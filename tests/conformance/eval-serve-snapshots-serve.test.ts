/**
 * The grader's static server (`scripts/evals/grade/serve.ts`, §8.2): it binds 127.0.0.1 only,
 * serves a snapshot's files with the right content types, maps `/vendor/**` to the app's vendor
 * folder, and refuses every hostile path — traversal, encoded traversal, symlink escape, absolute
 * paths, malformed escapes, a foreign Host — without reading anything outside the served roots.
 * Hermetic: temp folders and a loopback socket; no build, no browser.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  MIME_TYPES,
  SERVE_HOST,
  ServeError,
  ServeErrorCode,
  createServeSnapshot,
  sandboxedServe,
  startStaticServer,
} from "../../scripts/evals/grade/serve.ts";
import { evalsPaths } from "../../scripts/evals/ledger/paths.ts";
import type { SandboxOptions } from "../../src/substrate/spawn.ts";
import type { ServeHandle } from "../../scripts/evals/grade/types.ts";
import { NoBuild, ServedVia, ShimMode } from "../../scripts/evals/vocabulary.ts";
import { tmpDir } from "../helpers/tmp.ts";

const SECRET = "outside-the-root-sentinel";

interface Reply {
  status: number;
  type: string | undefined;
  body: string;
}

/** One raw request, the path sent byte for byte (fetch would normalise `..` away). */
function rawGet(
  handle: ServeHandle,
  rawPath: string,
  options: { host?: string; method?: string } = {},
): Promise<Reply> {
  const { port } = new URL(handle.origin);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: SERVE_HOST,
        port: Number(port),
        path: rawPath,
        method: options.method ?? "GET",
        headers: { host: options.host ?? `${SERVE_HOST}:${port}` },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            type: response.headers["content-type"],
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

describe("eval static server", () => {
  let base = "";
  let root = "";
  let vendor = "";
  let handle: ServeHandle;

  before(async () => {
    base = await tmpDir("eval-serve-");
    root = path.join(base, "snapshot");
    vendor = path.join(base, "vendor");
    const outside = path.join(base, "outside");
    await mkdir(path.join(root, "assets", "sub"), { recursive: true });
    await mkdir(vendor, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(root, "index.html"), "<!doctype html><title>project</title>");
    await writeFile(path.join(root, "assets", "sub", "index.html"), "nested index");
    await writeFile(path.join(root, "assets", "level.glb"), "glTF");
    await writeFile(path.join(root, "assets", "tex.ktx2"), "ktx2");
    await writeFile(path.join(root, "assets", "sound.ogg"), "ogg");
    await writeFile(path.join(root, "assets", "blob.unknownext"), "blob");
    await writeFile(path.join(root, "project.wasm"), "wasm");
    await writeFile(path.join(root, "..hidden"), "dot-dot-named file");
    await writeFile(path.join(vendor, "three.webgpu.js"), "export const three = 1;");
    await writeFile(path.join(outside, "secret.txt"), SECRET);
    await writeFile(path.join(base, "secret.txt"), SECRET);
    await symlink(outside, path.join(root, "escape-dir"));
    await symlink(path.join(outside, "secret.txt"), path.join(root, "escape-file.txt"));
    await symlink(path.join(root, "assets", "level.glb"), path.join(root, "inside-link.glb"));
    handle = await startStaticServer({ root, vendorDir: vendor, servedVia: ServedVia.AsIs });
  });

  after(async () => {
    await handle.close();
  });

  it("binds the loopback address and names its origin", () => {
    assert.equal(new URL(handle.origin).hostname, SERVE_HOST);
    assert.ok(handle.url.startsWith(handle.origin));
    assert.equal(handle.servedVia, ServedVia.AsIs);
  });

  it("serves the entry at / and a folder's own index", async () => {
    const top = await rawGet(handle, "/");
    assert.equal(top.status, 200);
    assert.match(top.type ?? "", /^text\/html/);
    assert.equal((await rawGet(handle, "/assets/sub/")).body, "nested index");
  });

  it("types every project asset format, and unknown ones as octet-stream", async () => {
    const cases: Array<[string, string]> = [
      ["/assets/level.glb", MIME_TYPES[".glb"] ?? ""],
      ["/assets/tex.ktx2", MIME_TYPES[".ktx2"] ?? ""],
      ["/assets/sound.ogg", MIME_TYPES[".ogg"] ?? ""],
      ["/project.wasm", "application/wasm"],
      ["/vendor/three.webgpu.js", MIME_TYPES[".js"] ?? ""],
      ["/assets/blob.unknownext", "application/octet-stream"],
    ];
    for (const [url, type] of cases) {
      const reply = await rawGet(handle, url);
      assert.equal(reply.status, 200, url);
      assert.equal(reply.type, type, url);
    }
    for (const ext of [".html", ".js", ".mjs", ".css", ".wasm", ".ktx2", ".glb", ".gltf", ".png", ".jpg"]) {
      assert.ok(MIME_TYPES[ext], ext);
    }
    for (const ext of [".webp", ".wav", ".mp3", ".ogg", ".json"]) assert.ok(MIME_TYPES[ext], ext);
  });

  it("maps /vendor/** to the app's vendor folder, not the snapshot", async () => {
    const reply = await rawGet(handle, "/vendor/three.webgpu.js");
    assert.equal(reply.body, "export const three = 1;");
  });

  it("follows a symlink that stays inside the root", async () => {
    assert.equal((await rawGet(handle, "/inside-link.glb")).body, "glTF");
  });

  it("serves a file whose name merely starts with two dots", async () => {
    assert.equal((await rawGet(handle, "/..hidden")).status, 200);
  });

  const hostile: Array<{ name: string; url: string; statuses: number[] }> = [
    { name: "plain traversal", url: "/../secret.txt", statuses: [403, 404] },
    { name: "deep traversal", url: "/assets/../../secret.txt", statuses: [403, 404] },
    { name: "encoded dots", url: "/%2e%2e/secret.txt", statuses: [403, 404] },
    { name: "encoded slash traversal", url: "/..%2fsecret.txt", statuses: [403, 404] },
    { name: "double encoded traversal", url: "/%252e%252e/secret.txt", statuses: [403, 404] },
    { name: "encoded absolute path", url: "/%2Fetc%2Fpasswd", statuses: [403, 404] },
    { name: "absolute path via double slash", url: `//${path.join(base, "secret.txt")}`, statuses: [403, 404] },
    { name: "vendor traversal", url: "/vendor/..%2f..%2fsecret.txt", statuses: [403, 404] },
    { name: "symlinked folder escape", url: "/escape-dir/secret.txt", statuses: [403] },
    { name: "symlinked file escape", url: "/escape-file.txt", statuses: [403] },
    { name: "nul byte", url: "/index.html%00.png", statuses: [400] },
    { name: "malformed escape", url: "/%E0%A4%A", statuses: [400] },
    { name: "not a path", url: "*", statuses: [400] },
    { name: "missing file", url: "/nope.js", statuses: [404] },
  ];
  for (const row of hostile) {
    it(`refuses ${row.name} and reads nothing outside the root`, async () => {
      const reply = await rawGet(handle, row.url);
      assert.ok(row.statuses.includes(reply.status), `${row.url} answered ${reply.status}`);
      assert.ok(!reply.body.includes(SECRET), `${row.url} leaked the outside file`);
    });
  }

  it("refuses a request whose Host is not the loopback server (DNS rebinding)", async () => {
    const reply = await rawGet(handle, "/", { host: "attacker.example" });
    assert.equal(reply.status, 403);
  });

  it("refuses writes", async () => {
    assert.equal((await rawGet(handle, "/index.html", { method: "POST" })).status, 405);
  });

  it("answers HEAD without a body", async () => {
    const reply = await rawGet(handle, "/index.html", { method: "HEAD" });
    assert.equal(reply.status, 200);
    assert.equal(reply.body, "");
  });
});

describe("serving a snapshot through the copy builder", () => {
  it("serves the folder the builder prepared, with its servedVia and entry query", async () => {
    const base = await tmpDir("eval-serve-snap-");
    const built = path.join(base, "copy", "dist");
    await mkdir(built, { recursive: true });
    await writeFile(path.join(built, "index.html"), "built page");
    const asked: string[] = [];
    const serve = createServeSnapshot({
      copiesRoot: path.join(base, "copies"),
      prepare: async (request) => {
        asked.push(request.snapshotDir);
        return { servedDir: built, servedVia: ServedVia.Rebuilt, entryQuery: "genex_local_test=1", noBuild: null };
      },
    });
    await mkdir(path.join(base, "vendor"), { recursive: true });
    const handle = await serve({
      root: path.join(base, "snap"),
      vendorDir: path.join(base, "vendor"),
      shimMode: ShimMode.None,
      npmCacheDir: path.join(base, "cache"),
    });
    try {
      assert.deepEqual(asked, [path.join(base, "snap")]);
      assert.equal(handle.servedVia, ServedVia.Rebuilt);
      assert.equal(handle.noBuild, null);
      assert.equal(new URL(handle.url).search, "?genex_local_test=1");
      assert.equal((await rawGet(handle, "/")).body, "built page");
    } finally {
      await handle.close();
    }
  });

  it("carries how a failed rebuild typed itself, and null whenever there is a page", async () => {
    const base = await tmpDir("eval-serve-nobuild-");
    for (const noBuild of [NoBuild.NoDist, NoBuild.BuildFailed]) {
      const serve = createServeSnapshot({
        copiesRoot: path.join(base, "copies"),
        prepare: async () => ({ servedDir: null, servedVia: ServedVia.RebuildFailed, entryQuery: "", noBuild }),
      });
      const handle = await serve({ root: base, vendorDir: base, shimMode: ShimMode.None, npmCacheDir: base });
      try {
        assert.equal(handle.servedVia, ServedVia.RebuildFailed);
        assert.equal(handle.noBuild, noBuild);
      } finally {
        await handle.close();
      }
    }
  });

  it("refuses a vendor folder that does not exist, before building anything, instead of serving /vendor from the copy", async () => {
    const base = await tmpDir("eval-serve-vendor-missing-");
    let prepared = 0;
    const serve = createServeSnapshot({
      copiesRoot: path.join(base, "copies"),
      prepare: async () => {
        prepared += 1;
        return { servedDir: base, servedVia: ServedVia.AsIs, entryQuery: "", noBuild: null };
      },
    });
    const missing = path.join(base, "dist", "resources", "vendor");
    await assert.rejects(
      serve({ root: base, vendorDir: missing, shimMode: ShimMode.None, npmCacheDir: base }),
      (error: unknown) => error instanceof ServeError && error.code === ServeErrorCode.VendorMissing,
    );
    assert.equal(prepared, 0);
    await assert.rejects(
      startStaticServer({ root: base, vendorDir: missing, servedVia: ServedVia.AsIs }),
      (error: unknown) => error instanceof ServeError && error.code === ServeErrorCode.VendorMissing,
    );
  });

  it("refuses to inject a shim it does not have, before building anything", async () => {
    const base = await tmpDir("eval-serve-shim-");
    let prepared = 0;
    const serve = createServeSnapshot({
      copiesRoot: base,
      prepare: async () => {
        prepared += 1;
        return { servedDir: base, servedVia: ServedVia.AsIs, entryQuery: "", noBuild: null };
      },
    });
    await assert.rejects(
      serve({ root: base, vendorDir: base, shimMode: ShimMode.InjectForAll, npmCacheDir: base }),
      (error: unknown) => error instanceof ServeError && error.code === ServeErrorCode.ShimUnsupported,
    );
    assert.equal(prepared, 0);
  });
});

describe("the sandboxed snapshot server grading and the canary share", () => {
  it("keeps copies, the npm cache and the sandbox's scratch at the evals home's one layout, starting one sandbox", async () => {
    const base = await tmpDir("eval-serve-layout-");
    const paths = evalsPaths(path.join(base, "home"));
    const snap = path.join(base, "snap");
    await mkdir(snap, { recursive: true });
    await writeFile(path.join(snap, "index.html"), "<title>as is</title>");
    const vendor = path.join(base, "vendor");
    await mkdir(vendor, { recursive: true });
    const started: SandboxOptions[] = [];
    const serve = sandboxedServe(paths, async (options) => {
      started.push(options);
      return { run: async () => assert.fail("a page served as-is builds nothing") };
    });
    for (let round = 0; round < 2; round++) {
      const handle = await serve({
        root: snap,
        vendorDir: vendor,
        shimMode: ShimMode.None,
        npmCacheDir: paths.npmCache,
      });
      try {
        assert.equal((await rawGet(handle, "/")).body, "<title>as is</title>");
      } finally {
        await handle.close();
      }
    }
    assert.deepEqual(started, [{ writableRoots: [paths.npmCache], scratchDir: paths.sandboxScratch, secretPaths: [] }]);
    assert.equal((await readdir(paths.serveCopies)).length, 1, "the snapshot's one copy");
  });
});
