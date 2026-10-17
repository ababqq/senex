/**
 * The one HTML rewriter (M4.1): where the studio's own tags land in a page it did not write.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  CHARSET_BUDGET,
  HOOK_TAG,
  MAX_REWRITE_BYTES,
  SHIM_TAG,
  HttpStatus,
  answerRequest,
  confinePreviewContents,
  cspNote,
  findMetaCsp,
  loopbackEntryUrl,
  projectRequestAllowed,
  routedDocumentUrl,
  previewNavigationAllowed,
  rewriteProjectHtml,
  shimTag,
  resolveServed,
  routeHttp,
  servableProject,
  servedLocation,
  servedRelative,
  shouldRewrite,
  spaFallback,
  tooLargeNote,
  underSiteBase,
} from "../../src/main/page-serve.ts";
import { tmpDir } from "../helpers/tmp.ts";

const FIXTURES = path.resolve("tests/fixtures/pages");
const DOCUMENTS = [
  "template.html",
  "vite-dist.html",
  "doctype-only.html",
  "map-first.html",
  "commented-head.html",
  "meta-csp.html",
];
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

describe("the served page", () => {
  it("puts the shim ahead of every module script and of the import map", () => {
    for (const name of DOCUMENTS) {
      const { html, injected } = rewriteProjectHtml(read(name));
      assert.equal(injected, true, name);
      const shim = html.indexOf(SHIM_TAG);
      assert.ok(shim >= 0, `${name} has no shim tag`);
      const firstModule = html.indexOf('<script type="module"');
      if (firstModule >= 0) assert.ok(shim < firstModule, `${name}: the shim must precede the first module`);
      const map = html.indexOf('<script type="importmap"');
      if (map >= 0) assert.ok(shim < map, `${name}: the shim must precede the import map`);
    }
  });

  it("puts the hook after the import map, because a module ahead of a map disables it", () => {
    for (const name of ["template.html", "map-first.html", "meta-csp.html"]) {
      const { html } = rewriteProjectHtml(read(name));
      const map = html.indexOf('<script type="importmap"');
      const hook = html.indexOf(HOOK_TAG);
      assert.ok(map >= 0 && hook > map, `${name}: hook at ${hook}, map at ${map}`);
      assert.ok(hook > html.indexOf("</script>", map), `${name}: the hook must follow the whole map`);
    }
  });

  it("keeps the charset declaration inside the first kilobyte", () => {
    for (const name of DOCUMENTS) {
      const { html } = rewriteProjectHtml(read(name));
      const at = html.toLowerCase().indexOf("<meta charset");
      assert.ok(at < CHARSET_BUDGET, `${name}: charset at ${at}`);
      if (read(name).toLowerCase().includes("<meta charset")) assert.ok(at >= 0, `${name} lost its charset`);
    }
  });

  it("is idempotent — a page already carrying the shim comes back unchanged", () => {
    for (const name of DOCUMENTS) {
      const once = rewriteProjectHtml(read(name));
      const twice = rewriteProjectHtml(once.html);
      assert.equal(twice.injected, false, name);
      assert.equal(twice.html, once.html, name);
    }
  });

  it("still serves the studio onto a page that merely mentions the shim's attribute", () => {
    // The idempotence guard is the injected TAG, not the string. A bare substring test meant one
    // mention anywhere — a comment, a debug line asking whether the studio is attached, a CSS
    // content value — served the page byte-identical: no shim, no hook, no map, no clock, and
    // nothing in the run to say why.
    const mentions = [
      (html: string) => html.replace("<head>", "<head>\n<!-- the studio adds data-studio-shim here -->"),
      (html: string) =>
        html.replace(
          "<head>",
          '<head>\n<script>window.__attached = !!document.querySelector("script[data-studio-shim]");</script>',
        ),
      (html: string) => html.replace("<head>", '<head>\n<style>#hint::after { content: "data-studio-shim"; }</style>'),
    ];
    for (const mention of mentions) {
      const source = mention(read("template.html"));
      const result = rewriteProjectHtml(source, { documentUrl: "project://sweep/index.html" });
      assert.equal(result.injected, true, "a page that only mentions the attribute was left untouched");
      assert.ok(result.html.includes(SHIM_TAG), "the served page has no shim");
      assert.equal(result.reach, "import-map");
      // And the real thing is still idempotent.
      assert.equal(rewriteProjectHtml(result.html, { documentUrl: "project://sweep/index.html" }).injected, false);
    }
  });

  it("does not drop its tags into a comment that mentions the head", () => {
    const { html } = rewriteProjectHtml(read("commented-head.html"));
    const comment = html.indexOf("<!-- <head>");
    const shim = html.indexOf(SHIM_TAG);
    assert.ok(shim > html.indexOf("-->", comment), "the shim landed inside the comment");
    assert.ok(shim > html.toLowerCase().indexOf("<head>"), "the shim must be inside the real head");
  });

  it("leaves the page's own import map byte-identical", () => {
    const source = read("template.html");
    const map = source.slice(
      source.indexOf('<script type="importmap"'),
      source.indexOf("</script>") + "</script>".length,
    );
    assert.ok(rewriteProjectHtml(source).html.includes(map));
  });

  it("names a meta content-security-policy instead of editing it", () => {
    const source = read("meta-csp.html");
    const csp = findMetaCsp(source);
    assert.equal(csp?.directive, "script-src");
    const { html, notes } = rewriteProjectHtml(source);
    assert.ok(notes.includes(cspNote(csp!)));
    assert.ok(html.includes(`content="default-src 'none'; script-src 'unsafe-inline'; img-src data:"`));
    assert.equal(findMetaCsp(read("template.html")), null);
  });

  it("bakes this load's shim options into the tag, and nothing when there are none", () => {
    assert.equal(shimTag(null), SHIM_TAG);
    assert.equal(shimTag({}), SHIM_TAG);
    const tag = shimTag({ readyMs: 30_000, seed: null });
    assert.match(tag, /data-studio-shim data-studio-options="/);
    const encoded = /data-studio-options="([^"]*)"/.exec(tag)?.[1] ?? "";
    assert.deepEqual(JSON.parse(encoded.replace(/&quot;/g, '"').replace(/&amp;/g, "&")), {
      readyMs: 30_000,
      seed: null,
    });
    assert.ok(rewriteProjectHtml(read("template.html"), { shim: { readyMs: 30_000, seed: null } }).html.includes(tag));
  });
});

describe("which responses receive the studio", () => {
  it("rewrites the entry, and nothing it cannot name", () => {
    assert.equal(shouldRewrite("text/html", "index.html", true, null, 400), true);
    assert.equal(shouldRewrite("text/html", "level.html", false, "", 400), false);
    assert.equal(shouldRewrite("text/html", "level.html", false, "empty", 400), false);
    assert.equal(shouldRewrite("text/html", "level.html", false, "document", 400), true);
    assert.equal(shouldRewrite("text/html", "level.html", false, "iframe", 400), true);
    assert.equal(shouldRewrite("text/html", "vendor/studio/shim.js", true, "document", 400), false);
    assert.equal(shouldRewrite("text/html", "index.html", true, "document", 9 * 1024 * 1024), false);
    assert.equal(shouldRewrite("text/javascript", "index.html", true, "document", 400), false);
    assert.equal(shouldRewrite(null, "index.html", true, null, 400), true);
    assert.equal(shouldRewrite(null, "main.js", false, "document", 400), false);
    assert.equal(shouldRewrite("text/html; charset=utf-8", "dist/index.html", true, null, null), true);
  });

  it("says why a document was left alone", () => {
    assert.equal(
      tooLargeNote("index.html", MAX_REWRITE_BYTES + 1),
      "index.html is too large to receive the studio shim (8.0 MB); the studio cannot pace this page's clock",
    );
  });
});

describe("which file a request names", () => {
  // Containment is checked on real paths, so every expected path is a real one (macOS temp
  // folders sit behind the /var → /private/var link).
  const real = (p: string) => fs.realpathSync(p);
  const touch = (file: string, text = "x\n") => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };

  it("decodes before it resolves, so an encoded step up is refused like a literal one", async () => {
    const base = await tmpDir("studio-serve-");
    touch(path.join(base, "src", "main.js"));
    touch(path.join(base, "etc", "passwd"));
    assert.equal(servedRelative("/"), "index.html");
    assert.equal(servedRelative("///level%201.html"), "level 1.html");
    assert.deepEqual(await resolveServed(base, servedRelative("/src/main.js")!), {
      ok: true,
      path: path.join(real(base), "src", "main.js"),
    });
    for (const escape of ["/../secret.txt", "/%2e%2e/secret.txt", "/src/..%2F..%2Fsecret.txt"]) {
      assert.deepEqual(await resolveServed(base, servedRelative(escape)!), { ok: false, status: 403 }, escape);
    }
    // An encoded absolute path loses its leading slashes with the rest, so it stays in the folder.
    assert.deepEqual(await resolveServed(base, servedRelative("/%2Fetc%2Fpasswd")!), {
      ok: true,
      path: path.join(real(base), "etc", "passwd"),
    });
    // Flipped (L7) from "a malformed escape throws URIError, which fails the handler": it is not a
    // path at all, and the handler answers 400.
    assert.equal(servedRelative("/%E0%A4%A"), null);
    assert.equal(servedRelative("/%"), null);
  });

  it("serves from the root it pinned at load, not a folder swapped in under the same name later (M1)", async () => {
    const holder = await tmpDir("studio-pin-");
    const outside = await tmpDir("studio-outside-");
    const worktree = path.join(holder, "facet-a");
    touch(path.join(worktree, "index.html"));
    touch(path.join(outside, "secret.txt"), "not the project's\n");
    touch(path.join(outside, "index.html"), "not the project's\n");
    const pinned = real(worktree);
    const vendor = await tmpDir("studio-vendor-");
    const roots = { vendor, projectRoot: () => worktree, pinnedProjectRoot: () => pinned };
    assert.deepEqual(await servedLocation("index.html", roots), { ok: true, path: path.join(pinned, "index.html") });
    // The worktree folder is replaced by a link out of scratch after the check.
    fs.renameSync(worktree, `${worktree}-moved`);
    fs.symlinkSync(outside, worktree);
    for (const request of ["secret.txt", "index.html", "."]) {
      assert.deepEqual(await servedLocation(request, roots), { ok: false, status: 403 }, request);
      assert.deepEqual(await resolveServed(worktree, request, pinned), { ok: false, status: 403 }, request);
    }
  });

  it("answers 404 for anything but a regular file or a folder: a FIFO would hang the reader (M4)", {
    skip: process.platform === "win32" && "Windows has no FIFOs in the file system",
  }, async () => {
    const base = await tmpDir("studio-serve-");
    const fifo = path.join(base, "pipe.json");
    execFileSync("/usr/bin/mkfifo", [fifo]);
    assert.deepEqual(await resolveServed(base, "pipe.json"), { ok: false, status: 404 });
    fs.symlinkSync(fifo, path.join(base, "alias.json"));
    assert.deepEqual(await resolveServed(base, "alias.json"), { ok: false, status: 404 });
  });

  it("serves the folder itself, and not a sibling that shares its name as a prefix", async () => {
    const base = await tmpDir("studio-serve-");
    const evil = `${base}-evil`;
    touch(path.join(evil, "index.html"));
    try {
      assert.deepEqual(await resolveServed(base, "."), { ok: true, path: real(base) });
      assert.deepEqual(await resolveServed(base, `../${path.basename(base)}-evil/index.html`), {
        ok: false,
        status: 403,
      });
    } finally {
      fs.rmSync(evil, { recursive: true, force: true });
    }
  });

  it("reads vendor paths from the studio's vendor folder and asks for a project root only otherwise", async () => {
    const vendor = await tmpDir("studio-vendor-");
    const project = await tmpDir("studio-project-");
    touch(path.join(vendor, "three.module.js"));
    touch(path.join(project, "vendorish", "a.js"));
    let asked = 0;
    const roots = { vendor, projectRoot: () => (asked++, project) };
    assert.deepEqual(await servedLocation("vendor/three.module.js", roots), {
      ok: true,
      path: path.join(real(vendor), "three.module.js"),
    });
    assert.deepEqual(await servedLocation("vendor", roots), { ok: true, path: real(vendor) });
    assert.deepEqual(await servedLocation("vendor/../../x", roots), { ok: false, status: 403 });
    assert.equal(asked, 0, "a vendor request never looks the project up");
    assert.deepEqual(await servedLocation("vendorish/a.js", roots), {
      ok: true,
      path: path.join(real(project), "vendorish", "a.js"),
    });
    assert.equal(asked, 1);
  });

  it("serves only project names the library could have made", () => {
    assert.equal(servableProject("pond-life_2"), true);
    for (const name of ["", "-lead", "Pond", "pond life", "../pond", "pond/.."])
      assert.equal(servableProject(name), false, name);
  });

  it("refuses a symlink planted in the project that leads out of it (SECUI-2)", async () => {
    // Flipped from the Stage 0 pin "follows a symlink out of the project folder (current behaviour)":
    // lexical containment passed the link, and the main process's file:// fetch followed it.
    const outside = await tmpDir("studio-outside-");
    const base = await tmpDir("studio-serve-");
    touch(path.join(outside, "secret.txt"), "not the project's\n");
    fs.mkdirSync(path.join(base, "assets"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(base, "assets", "k.txt"));
    fs.symlinkSync(outside, path.join(base, "linked-dir"));
    fs.symlinkSync(path.join(base, "assets", "k.txt"), path.join(base, "hop.txt"));
    for (const request of ["/assets/k.txt", "/linked-dir/secret.txt", "/linked-dir", "/hop.txt"]) {
      assert.deepEqual(await resolveServed(base, servedRelative(request)!), { ok: false, status: 403 }, request);
    }
  });

  it("serves a link that stays inside the project, at its real path", async () => {
    const base = await tmpDir("studio-serve-");
    touch(path.join(base, "assets", "real.png"));
    fs.symlinkSync(path.join(base, "assets", "real.png"), path.join(base, "alias.png"));
    assert.deepEqual(await resolveServed(base, "alias.png"), {
      ok: true,
      path: path.join(real(base), "assets", "real.png"),
    });
  });

  it("serves a worktree's packages through the studio's link to the live project's node_modules (R4)", async () => {
    // SnapshotEngine.worktreeAt links <worktree>/node_modules to the live project's; a project with an
    // import map onto ./node_modules/three must still load in a worker's preview.
    const live = await tmpDir("studio-live-");
    const outside = await tmpDir("studio-outside-");
    const module = path.join("node_modules", "three", "build", "three.module.js");
    touch(path.join(live, module), "export {};\n");
    touch(path.join(live, "sub", module), "export {};\n");
    touch(path.join(outside, "secret.txt"), "not the project's\n");
    touch(path.join(outside, "node_modules", "x.js"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(live, "node_modules", "planted.txt"));
    const worktree = await tmpDir("studio-worktree-");
    touch(path.join(worktree, "index.html"));
    fs.symlinkSync(path.join(live, "node_modules"), path.join(worktree, "node_modules"), "dir");
    fs.mkdirSync(path.join(worktree, "sub"));
    fs.symlinkSync(path.join(live, "sub", "node_modules"), path.join(worktree, "sub", "node_modules"), "dir");
    const vendor = await tmpDir("studio-vendor-");
    const roots = { vendor, projectRoot: () => worktree, liveRoot: () => live };
    assert.deepEqual(await servedLocation(module, roots), { ok: true, path: path.join(real(live), module) });
    assert.deepEqual(await servedLocation(`sub/${module}`, roots), {
      ok: true,
      path: path.join(real(live), "sub", module),
    });
    // Hostile rows: the exception reaches the live project's own packages and nothing else.
    fs.symlinkSync(path.join(outside, "node_modules"), path.join(worktree, "other-modules"));
    fs.mkdirSync(path.join(worktree, "evil"));
    fs.symlinkSync(path.join(outside, "node_modules"), path.join(worktree, "evil", "node_modules"));
    fs.symlinkSync(path.join(live, "node_modules"), path.join(worktree, "alias"));
    const refused = [
      "node_modules/planted.txt",
      "evil/node_modules/x.js",
      "other-modules/x.js",
      `alias/three/build/three.module.js`,
      "node_modules/../../x",
    ];
    for (const request of refused)
      assert.deepEqual(await servedLocation(request, roots), { ok: false, status: 403 }, request);
    // Without a live project to compare with (the live preview itself), nothing changes.
    assert.deepEqual(await servedLocation(module, { vendor, projectRoot: () => worktree }), { ok: false, status: 403 });
  });

  it("serves a project whose own folder is reached through a link (a linked projects root)", async () => {
    const holder = await tmpDir("studio-holder-");
    const project = await tmpDir("studio-project-");
    touch(path.join(project, "index.html"));
    const linked = path.join(holder, "pond-life");
    fs.symlinkSync(project, linked);
    assert.deepEqual(await resolveServed(linked, "index.html"), {
      ok: true,
      path: path.join(real(project), "index.html"),
    });
    assert.deepEqual(await resolveServed(linked, "."), { ok: true, path: real(project) });
  });

  it("answers 404, not a guess, when the file or the folder is missing", async () => {
    const base = await tmpDir("studio-serve-");
    assert.deepEqual(await resolveServed(base, "missing.js"), { ok: false, status: 404 });
    assert.deepEqual(await resolveServed(base, "no/such/dir/a.js"), { ok: false, status: 404 });
    assert.deepEqual(await resolveServed(path.join(base, "gone"), "index.html"), { ok: false, status: 404 });
    // A dangling link is missing too: nothing is read through it.
    fs.symlinkSync(path.join(base, "nowhere.txt"), path.join(base, "dangling.txt"));
    assert.deepEqual(await resolveServed(base, "dangling.txt"), { ok: false, status: 404 });
  });

  it("applies the same real-path check to the studio's vendor folder", async () => {
    const outside = await tmpDir("studio-outside-");
    const vendor = await tmpDir("studio-vendor-");
    touch(path.join(outside, "secret.txt"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(vendor, "three.module.js"));
    const roots = { vendor, projectRoot: () => vendor };
    assert.deepEqual(await servedLocation("vendor/three.module.js", roots), { ok: false, status: 403 });
    assert.deepEqual(await servedLocation("vendor/missing.js", roots), { ok: false, status: 404 });
  });
});

describe("a route no file answers (client-side routers)", () => {
  const NOT_FOUND = { ok: false, status: HttpStatus.NotFound } as const;
  const document = { method: "GET", dest: "document", accept: "text/html,application/xhtml+xml,*/*;q=0.8" };

  it("answers a navigation to a path no file names with the page the project loaded", () => {
    for (const route of ["about", "users/42/edit", "settings/", "dashboard/reports"]) {
      assert.equal(spaFallback(route, NOT_FOUND, "index.html", document), "index.html", route);
    }
    // A navigation that names no destination still announces a page in its Accept header.
    assert.equal(
      spaFallback("about", NOT_FOUND, "index.html", { method: "GET", dest: null, accept: "text/html" }),
      "index.html",
    );
    // HEAD asks the same question GET does.
    assert.equal(spaFallback("about", NOT_FOUND, "index.html", { ...document, method: "HEAD" }), "index.html");
    // Embedded documents are navigations too.
    assert.equal(
      spaFallback("about", NOT_FOUND, "index.html", { method: "GET", dest: "iframe", accept: null }),
      "index.html",
    );
  });

  it("keeps the 404 for everything that is not a navigation to a route", () => {
    const refused: Array<
      [string, Parameters<typeof spaFallback>[1], string | null, Parameters<typeof spaFallback>[3]]
    > = [
      ["a fetch of an API path", NOT_FOUND, "index.html", { method: "GET", dest: "empty", accept: "*/*" }],
      ["a fetch that asks for html", NOT_FOUND, "index.html", { method: "GET", dest: "empty", accept: "text/html" }],
      ["a script", NOT_FOUND, "index.html", { method: "GET", dest: "script", accept: "*/*" }],
      ["no destination and no html accepted", NOT_FOUND, "index.html", { method: "GET", dest: null, accept: "*/*" }],
      ["no headers at all", NOT_FOUND, "index.html", { method: "GET", dest: null, accept: null }],
      ["a file that exists", { ok: true, path: "/x/index.html" }, "index.html", document],
      ["a refused path", { ok: false, status: HttpStatus.Forbidden }, "index.html", document],
      ["a page that was never loaded", NOT_FOUND, null, document],
      ["an entry that is not a page", NOT_FOUND, "level.glb", document],
      ["a form post to a missing path", NOT_FOUND, "index.html", { ...document, method: "POST" }],
      ["a delete", NOT_FOUND, "index.html", { ...document, method: "DELETE" }],
    ];
    for (const [why, served, entry, request] of refused) {
      assert.equal(spaFallback("about", served, entry, request), null, why);
    }
    // A path with an extension is an asset that is missing, not a route.
    for (const asset of ["app.js", "assets/logo.png", "data/items.json", "styles/main.css", "robots.txt"]) {
      assert.equal(spaFallback(asset, NOT_FOUND, "index.html", document), null, asset);
    }
    // The studio's own files are never answered with the project's page.
    assert.equal(spaFallback("vendor/studio/shim", NOT_FOUND, "index.html", document), null);
  });

  it("never turns a refused or hostile path into the page: nothing is read, nothing is served", async () => {
    const parent = await tmpDir("studio-spa-");
    const base = path.join(parent, "site");
    fs.mkdirSync(base);
    fs.writeFileSync(path.join(base, "index.html"), "<h1>app</h1>");
    fs.writeFileSync(path.join(parent, "secret.txt"), "secret");
    fs.symlinkSync(path.join(parent, "secret.txt"), path.join(base, "leak"));
    const roots = { vendor: base, projectRoot: () => base };
    const hostile = ["/../secret.txt", "/%2e%2e/secret.txt", "/leak", "/a/..%2F..%2Fsecret.txt"];
    for (const url of hostile) {
      const served = await servedLocation(servedRelative(url)!, roots);
      assert.equal(served.ok, false, url);
      assert.equal(spaFallback(servedRelative(url)!, served, "index.html", document), null, url);
    }
    // A real route goes through the same check and ends on the real page.
    const route = await servedLocation(servedRelative("/users/42")!, roots);
    assert.deepEqual(route, NOT_FOUND);
    const entry = spaFallback("users/42", route, "index.html", document);
    assert.deepEqual(await servedLocation(entry!, roots), {
      ok: true,
      path: path.join(fs.realpathSync(base), "index.html"),
    });
  });

  it("answers a route that shares a directory's name with the app, and a directory with its own page with that page", async () => {
    const base = await tmpDir("studio-spa-dirs-");
    fs.writeFileSync(path.join(base, "index.html"), "<h1>app</h1>");
    fs.mkdirSync(path.join(base, "docs"));
    fs.writeFileSync(path.join(base, "docs", "notes.txt"), "x");
    fs.mkdirSync(path.join(base, "about"));
    fs.writeFileSync(path.join(base, "about", "index.html"), "<h1>about</h1>");
    const roots = { vendor: base, projectRoot: () => base };
    const real = fs.realpathSync(base);
    // The app owns /docs: a folder of that name is not a page to list.
    assert.deepEqual(await answerRequest("docs", roots, "index.html", document, true), {
      relative: "index.html",
      served: { ok: true, path: path.join(real, "index.html") },
      routed: true,
    });
    // …but a folder that holds its own page is that page when it is asked for as a folder (the
    // trailing slash is what makes the page's relative URLs resolve inside it).
    assert.deepEqual(await answerRequest("about/", roots, "index.html", document, true), {
      relative: "about/index.html",
      served: { ok: true, path: path.join(real, "about", "index.html") },
      routed: true,
    });
    // Without the slash a static host would redirect; this server does not, so the folder is left as named.
    const slashless = await answerRequest("about", roots, "index.html", document, true);
    assert.equal(slashless.routed, false);
    assert.deepEqual(slashless.served, { ok: true, path: path.join(real, "about") });
    // Neither applies off the loopback origin, nor to a request that is not a navigation.
    const plain = await answerRequest("docs", roots, "index.html", document, false);
    assert.deepEqual(plain, { relative: "docs", served: { ok: true, path: path.join(real, "docs") }, routed: false });
    const fetched = await answerRequest("docs", roots, "index.html", { ...document, dest: "empty" }, true);
    assert.equal(fetched.routed, false);
    // A file that exists is the file; a missing path with an extension stays missing.
    assert.equal((await answerRequest("index.html", roots, "index.html", document, true)).routed, false);
    const missing = await answerRequest("app.js", roots, "index.html", document, true);
    assert.deepEqual(missing.served, { ok: false, status: HttpStatus.NotFound });
  });

  it("never answers a navigation with a file outside the root, whatever the folder or its page is made of", async () => {
    const parent = await tmpDir("studio-spa-hostile-");
    const base = path.join(parent, "site");
    const outside = path.join(parent, "outside");
    fs.mkdirSync(base);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(base, "index.html"), "<h1>app</h1>");
    fs.writeFileSync(path.join(outside, "index.html"), "<h1>secret</h1>");
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(outside, path.join(base, "linked-folder"));
    fs.mkdirSync(path.join(base, "own-page"));
    fs.symlinkSync(path.join(outside, "index.html"), path.join(base, "own-page", "index.html"));
    const roots = { vendor: base, projectRoot: () => base };
    const inside = (served: { ok: boolean; path?: string }) =>
      !served.ok || (served.path ?? "").startsWith(fs.realpathSync(base));
    for (const url of [
      "/linked-folder/",
      "/linked-folder/index.html",
      "/own-page/",
      "/../outside/",
      "/%2e%2e/outside/index.html",
      "/..%2Foutside%2F",
      "/own-page/..%5C..%5Coutside/",
    ]) {
      const answer = await answerRequest(servedRelative(url)!, roots, "index.html", document, true);
      assert.ok(inside(answer.served), `${url} -> ${JSON.stringify(answer)}`);
    }
  });

  it("builds the routed page's address from the request's own origin, whatever the entry's name holds", () => {
    // A folder named with a character a URL gives meaning to is still one path.
    for (const [name, pathname] of [
      ["a#b/index.html", "/a%23b/index.html"],
      ["a?b/index.html", "/a%3Fb/index.html"],
      ["a b/index.html", "/a%20b/index.html"],
    ] as const) {
      const url = new URL(routedDocumentUrl("http://localhost:41234/x", name));
      assert.equal(url.pathname, pathname, name);
      assert.equal(url.hash + url.search, "", name);
    }
    assert.equal(
      routedDocumentUrl("http://localhost:41234/users/42", "index.html"),
      "http://localhost:41234/index.html",
    );
    // A backslash in an entry's file name reads as a slash in a URL: it must stay a path on this origin.
    for (const entry of ["\\evil.com\\x.html", "//evil.com/x.html", "@evil.com/x.html"]) {
      const url = new URL(routedDocumentUrl("http://localhost:41234/users/42", entry));
      assert.equal(url.origin, "http://localhost:41234", entry);
    }
  });

  it("opens a loopback page at the root, so a router sees the path the app lives at", () => {
    assert.equal(loopbackEntryUrl(41234, "index.html"), "http://localhost:41234/");
    assert.equal(
      loopbackEntryUrl(41234, "index.html?genex_local_test=1"),
      "http://localhost:41234/?genex_local_test=1",
    );
    // Any other entry keeps its own path: "/" would serve the wrong file.
    assert.equal(loopbackEntryUrl(41234, "game.html"), "http://localhost:41234/game.html");
    assert.equal(loopbackEntryUrl(41234, "sub/index.html"), "http://localhost:41234/sub/index.html");
  });
});

describe('a site built for a sub-path (Vite `base: "/my-site/"`)', () => {
  const document = { method: "GET", dest: "document", accept: "text/html,application/xhtml+xml,*/*;q=0.8" };
  const script = { method: "GET", dest: "script", accept: "*/*" };
  const fetched = { method: "GET", dest: "empty", accept: "*/*" };

  /** A build output: the files sit at the root of the folder while its page names them under /my-site/. */
  async function dist() {
    const base = await tmpDir("studio-site-base-serve-");
    fs.mkdirSync(path.join(base, "assets"));
    fs.mkdirSync(path.join(base, "docs"));
    fs.writeFileSync(path.join(base, "index.html"), '<script src="/my-site/assets/x.js"></script>');
    fs.writeFileSync(path.join(base, "assets", "x.js"), "1");
    fs.writeFileSync(path.join(base, "docs", "index.html"), "<h1>docs</h1>");
    fs.writeFileSync(path.join(base, "docs", "guide.html"), "<h1>guide</h1>");
    const roots = { vendor: base, projectRoot: () => base, siteBase: () => "my-site" };
    return { base, real: fs.realpathSync(base), roots };
  }

  it("opens a loopback page under the base, so a router that reads it sees its own path", () => {
    const table: Array<[string, string | null, string]> = [
      ["index.html", "my-site", "http://localhost:41234/my-site/"],
      ["index.html?genex_local_test=1", "my-site", "http://localhost:41234/my-site/?genex_local_test=1"],
      ["game.html", "my-site", "http://localhost:41234/my-site/game.html"],
      ["sub/index.html", "org/repo", "http://localhost:41234/org/repo/sub/index.html"],
      ["index.html", "my site", "http://localhost:41234/my%20site/"],
      ["index.html", null, "http://localhost:41234/"],
    ];
    for (const [entry, base, expected] of table) {
      assert.equal(loopbackEntryUrl(41234, entry, base), expected, `${entry} under ${base}`);
    }
  });

  it("takes the base off a path, and never reaches the studio's own route with it", () => {
    const table: Array<[string, string | null, string | null]> = [
      ["my-site/assets/x.js", "my-site", "assets/x.js"],
      ["my-site", "my-site", "index.html"],
      ["my-site/", "my-site", "index.html"],
      ["my-site/docs/", "my-site", "docs/"],
      ["my-site/vendor/x.js", "my-site", null],
      ["assets/x.js", "my-site", null],
      ["my-site/x", null, null],
    ];
    for (const [relative, base, expected] of table) {
      assert.equal(underSiteBase(relative, base), expected, `${relative} under ${base}`);
    }
  });

  it("serves the file under the base when the name as asked is missing, and the named file when it is not", async () => {
    const { real, roots } = await dist();
    const asset = await answerRequest("my-site/assets/x.js", roots, "index.html", script, true);
    assert.deepEqual(asset, {
      relative: "assets/x.js",
      served: { ok: true, path: path.join(real, "assets", "x.js") },
      routed: false,
    });
    assert.equal((await answerRequest("assets/x.js", roots, "index.html", script, true)).relative, "assets/x.js");
    for (const home of ["my-site/", "my-site"]) {
      const page = await answerRequest(home, roots, "index.html", document, true);
      assert.deepEqual(page.served, { ok: true, path: path.join(real, "index.html") }, home);
      assert.equal(page.routed, false, home);
    }
    // The router's routes and the folders' pages are answered on the path without the base.
    assert.equal((await answerRequest("my-site/about", roots, "index.html", document, true)).routed, true);
    const folder = await answerRequest("my-site/docs/", roots, "index.html", document, true);
    assert.equal(folder.relative, "docs/index.html");
    const page = await answerRequest("my-site/docs/guide.html", roots, "index.html", document, true);
    assert.equal(page.relative, "docs/guide.html");
    assert.equal(page.routed, false);
    // A real file at the name as asked wins over the one under the base.
    const nested = path.join(real, "my-site", "assets");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "real.js"), "2");
    const named = await answerRequest("my-site/assets/real.js", roots, "index.html", script, true);
    assert.equal(named.relative, "my-site/assets/real.js");
  });

  it("keeps a broken request broken and takes nothing from the studio's vendor route", async () => {
    const { roots } = await dist();
    for (const [url, request] of [
      ["my-site/assets/gone.js", script],
      ["my-site/api/items", fetched],
      ["my-site/vendor/studio/shim.js", script],
    ] as const) {
      const answer = await answerRequest(url, roots, "index.html", request, true);
      assert.deepEqual(answer.served, { ok: false, status: HttpStatus.NotFound }, url);
    }
  });

  it("is what it was with no base to strip", async () => {
    const { base, real } = await dist();
    for (const siteBase of [undefined, () => null]) {
      const roots = { vendor: base, projectRoot: () => base, ...(siteBase ? { siteBase } : {}) };
      const asset = await answerRequest("my-site/assets/x.js", roots, "index.html", script, true);
      assert.deepEqual(asset.served, { ok: false, status: HttpStatus.NotFound });
      const home = await answerRequest("my-site/", roots, "index.html", document, true);
      assert.deepEqual(home, {
        relative: "index.html",
        served: { ok: true, path: path.join(real, "index.html") },
        routed: true,
      });
    }
  });

  it("never turns a hostile path under the base into a file outside the root", async () => {
    const parent = await tmpDir("studio-site-base-hostile-");
    const base = path.join(parent, "dist");
    const outside = path.join(parent, "outside");
    fs.mkdirSync(base);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(base, "index.html"), "<h1>app</h1>");
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(base, "leak"));
    fs.symlinkSync(outside, path.join(base, "linked-folder"));
    const roots = { vendor: base, projectRoot: () => base, siteBase: () => "my-site" };
    const real = fs.realpathSync(base);
    for (const url of [
      "/my-site/../secret.txt",
      "/my-site/%2e%2e%2f..%2fsecret.txt",
      "/my-site/leak",
      "/my-site/linked-folder/secret.txt",
      "/my-site/linked-folder/",
    ]) {
      const rel = servedRelative(url);
      if (rel === null) continue;
      const answer = await answerRequest(rel, roots, "index.html", document, true);
      const inside = !answer.served.ok || answer.served.path.startsWith(real);
      assert.ok(inside, `${url} -> ${JSON.stringify(answer)}`);
      if (!answer.served.ok && rel.includes("leak")) assert.equal(answer.served.status, HttpStatus.Forbidden, url);
    }
    // A root swapped for a link after the page loaded is refused as it was, not retried under the base.
    const swapped = { ...roots, pinnedProjectRoot: () => path.join(parent, "pinned-elsewhere") };
    const refused = await answerRequest("my-site/index.html", swapped, "index.html", script, true);
    assert.equal(refused.served.ok, false);
  });
});

describe("which http requests are the studio's", () => {
  const ports = new Map([[41234, "pond-life"]]);

  it("serves a project on the loopback port it was given, under either loopback name", () => {
    assert.deepEqual(routeHttp("http://localhost:41234/index.html", ports), { route: "serve", project: "pond-life" });
    assert.deepEqual(routeHttp(new URL("http://127.0.0.1:41234/src/main.js"), ports), {
      route: "serve",
      project: "pond-life",
    });
  });

  it("denies every other http request instead of fetching it from the main process (SECUI-3)", () => {
    // Flipped from the Stage 0 pin "passes every other http request through (current behaviour)".
    for (const url of [
      "http://localhost:41235/",
      "http://localhost/",
      "http://[::1]:41234/",
      "http://example.com:41234/",
      "http://localhost.evil:41234/",
      "http://example.com/",
    ]) {
      assert.deepEqual(routeHttp(url, ports), { route: "deny" }, url);
    }
  });
});

describe("what the project partition may request (SECUI-3)", () => {
  const ports = new Map([[41234, "pond-life"]]);

  it("allows the studio's own schemes and the project's registered loopback port", () => {
    for (const url of [
      "project://pond-life/index.html",
      "project://pond-life/vendor/three.module.js",
      "data:image/png;base64,AAAA",
      "blob:project://pond-life/1b4a2f",
      "devtools://devtools/bundled/devtools_app.html",
      "http://localhost:41234/index.html",
      "http://127.0.0.1:41234/assets/a.png",
    ])
      assert.equal(projectRequestAllowed(url, ports), true, url);
  });

  it("refuses the network: remote hosts, unregistered loopback ports and every other scheme", () => {
    for (const url of [
      "https://attacker.example/x",
      "http://attacker.example/x",
      "wss://attacker.example/socket",
      "ws://localhost:41234/",
      "https://localhost:41234/",
      "http://localhost:41235/",
      "http://localhost/",
      "http://[::1]:41234/",
      "http://localhost:41234@attacker.example/",
      "http://localhost.attacker.example:41234/",
      "file:///etc/passwd",
      "ftp://example.com/",
      "chrome-extension://abc/x.js",
      "not a url",
      "",
      // L2: other spellings of "this machine", which reach a server the project did not get.
      "http://localhost.:41234/",
      "http://0.0.0.0:41234/",
      "http://a.localhost:41234/",
      "http://[::ffff:127.0.0.1]:41234/",
      "filesystem:project://pond-life/temporary/x",
      "chrome://gpu",
    ])
      assert.equal(projectRequestAllowed(url, ports), false, url);
    // The URL parser lowercases the host: this is the registered origin, not another one.
    assert.equal(projectRequestAllowed("http://LOCALHOST:41234/", ports), true);
  });

  it("lets a project read its libraries and fonts from the well-known public CDNs, and nothing else there", () => {
    for (const url of [
      "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
      "https://unpkg.com/three@0.170.0/build/three.module.js",
      "https://esm.sh/three@0.170.0",
      "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js",
      "https://fonts.googleapis.com/css2?family=Inter",
      "https://fonts.gstatic.com/s/inter/v13/abc.woff2",
    ]) {
      assert.equal(projectRequestAllowed(url, ports, "GET"), true, url);
      assert.equal(projectRequestAllowed(url, ports, "HEAD"), true, url);
      assert.equal(projectRequestAllowed(url, ports), true, `${url} (method unknown means a read)`);
    }
    for (const [url, method] of [
      ["https://cdn.jsdelivr.net/npm/three/x.js", "POST"],
      ["https://unpkg.com/x", "PUT"],
      ["http://cdn.jsdelivr.net/npm/three/x.js", "GET"],
      ["wss://esm.sh/socket", "GET"],
      ["https://cdn.jsdelivr.net.attacker.example/x.js", "GET"],
      ["https://evil.cdn.jsdelivr.net/x.js", "GET"],
      ["https://cdn.jsdelivr.net@attacker.example/x.js", "GET"],
      ["https://attacker.example/?host=cdn.jsdelivr.net", "GET"],
      ["https://unpkg.com:8443/x.js", "GET"],
      // A punycode lookalike: Cyrillic "е" in jsdelivr.
      ["https://cdn.jsdеlivr.net/npm/three/x.js", "GET"],
      ["https://cdn.jsdelivr.net./npm/three/x.js", "GET"],
    ] as const)
      assert.equal(projectRequestAllowed(url, ports, method), false, `${method} ${url}`);
  });
});

describe("traffic the request filter never sees (M7)", () => {
  it("sends no WebRTC UDP around the proxy: ICE candidates would leave the machine unfiltered", () => {
    const policies: string[] = [];
    confinePreviewContents({ setWebRTCIPHandlingPolicy: (policy: string) => void policies.push(policy) });
    assert.deepEqual(policies, ["disable_non_proxied_udp"]);
  });
});

describe("where a project page may navigate (SECUI-3)", () => {
  const ports = new Map([[41234, "pond-life"]]);

  it("keeps the page on project:// and its registered loopback origin", () => {
    for (const url of [
      "project://pond-life/level-2.html",
      "http://localhost:41234/index.html?genex_local_test=1",
      "http://127.0.0.1:41234/",
    ]) {
      assert.equal(previewNavigationAllowed(url, ports, { mainFrame: true }), true, url);
      assert.equal(previewNavigationAllowed(url, ports, { mainFrame: false }), true, url);
    }
  });

  it("refuses a remote page in the preview, top level or embedded", () => {
    for (const url of [
      "https://attacker.example/sign-in",
      "http://attacker.example/",
      "http://localhost:41235/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "not a url",
      "http://localhost.:41234/",
      "http://0.0.0.0:41234/",
      "http://a.localhost:41234/",
      "http://[::ffff:127.0.0.1]:41234/",
      "filesystem:project://pond-life/temporary/x",
      "chrome://gpu",
    ]) {
      assert.equal(previewNavigationAllowed(url, ports, { mainFrame: true }), false, url);
      assert.equal(previewNavigationAllowed(url, ports, { mainFrame: false }), false, url);
    }
  });

  it("lets an embedded frame hold content the page already has, never the top level", () => {
    for (const url of ["about:blank", "about:srcdoc", "data:text/html,<p>hi</p>", "blob:project://pond-life/1b4a2f"]) {
      assert.equal(previewNavigationAllowed(url, ports, { mainFrame: false }), true, url);
      assert.equal(previewNavigationAllowed(url, ports, { mainFrame: true }), false, url);
    }
  });
});
