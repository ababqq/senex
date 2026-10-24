/**
 * A site's own 404 page on project://: a navigation no file answers gets the project's `404.html`,
 * sent as a 404. A bundled app's unknown route (the loopback origin) keeps its entry page.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HttpStatus, MAX_REWRITE_BYTES, answerRequest, servedRelative } from "../../src/main/page-serve.ts";
import { tmpDir } from "../helpers/tmp.ts";

describe("a site's own 404 page", () => {
  // Electron hands a protocol handler no `sec-fetch-dest`: a page is told from a fetch by its Accept.
  const navigation = { method: "GET", dest: null, accept: "text/html,application/xhtml+xml,*/*;q=0.8" };
  const NOT_FOUND = { ok: false, status: HttpStatus.NotFound } as const;

  async function siteWith404() {
    const base = await tmpDir("studio-404-");
    const write = (rel: string, text = rel) => {
      fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
      fs.writeFileSync(path.join(base, rel), text);
    };
    for (const rel of ["index.html", "about.html", "404.html", "blog/index.html"]) write(rel);
    write("docs/n.txt");
    return { base, real: fs.realpathSync(base), roots: { vendor: base, projectRoot: () => base } };
  }

  /** A site folder beside an `outside` folder holding a page that must never be served. */
  async function plantedSite(plant: (site: string, outside: string) => void) {
    const parent = await tmpDir("studio-404-plant-");
    const site = path.join(parent, "site");
    const outside = path.join(parent, "outside");
    fs.mkdirSync(site);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.html"), "secret");
    fs.writeFileSync(path.join(site, "index.html"), "<h1>app</h1>");
    plant(site, outside);
    return { parent, site, real: fs.realpathSync(site), roots: { vendor: site, projectRoot: () => site } };
  }

  it("answers a navigation no file answers with 404.html, sent as a 404", async () => {
    const { real, roots } = await siteWith404();
    const page = {
      relative: "404.html",
      served: { ok: true, path: path.join(real, "404.html") },
      routed: false,
      status: HttpStatus.NotFound,
    };
    const asked: Array<[string, Parameters<typeof answerRequest>[3]]> = [
      ["nope", navigation],
      ["a/b/c", navigation],
      ["nope.html", navigation],
      ["photo.png", navigation],
      ["docs/", navigation],
      ["docs", navigation],
      ["nope", { ...navigation, method: "HEAD" }],
      ["nope", { method: "GET", dest: "document", accept: null }],
      ["nope", { method: "GET", dest: "iframe", accept: null }],
    ];
    for (const [name, request] of asked) {
      assert.deepEqual(
        await answerRequest(name, roots, "index.html", request, false),
        page,
        `${name} ${request.method} ${request.dest}`,
      );
    }
  });

  it("answers a page, a folder's page and a slash redirect before it turns to 404.html", async () => {
    const { real, roots } = await siteWith404();
    const ask = (name: string) => answerRequest(name, roots, "index.html", navigation, false);
    assert.deepEqual(await ask("about"), {
      relative: "about.html",
      served: { ok: true, path: path.join(real, "about.html") },
      routed: true,
    });
    assert.deepEqual(await ask("blog/"), {
      relative: "blog/index.html",
      served: { ok: true, path: path.join(real, "blog", "index.html") },
      routed: true,
    });
    const folder = await ask("blog");
    assert.equal(folder.redirect, "/blog/");
    assert.equal(folder.status, undefined);
  });

  it("keeps the plain 404 for a script, a style sheet, an image, a fetch and a post: only a page gets the page", async () => {
    const { roots } = await siteWith404();
    const asked: Array<[string, string, Parameters<typeof answerRequest>[3]]> = [
      ["a script", "app.js", { method: "GET", dest: null, accept: "*/*" }],
      ["a style sheet", "main.css", { method: "GET", dest: null, accept: "text/css,*/*;q=0.1" }],
      ["an image", "logo.png", { method: "GET", dest: null, accept: "image/avif,image/webp,*/*;q=0.8" }],
      ["a fetch", "api/items", { method: "GET", dest: "empty", accept: "*/*" }],
      ["a request with no headers", "nope", { method: "GET", dest: null, accept: null }],
      ["a form post", "nope", { ...navigation, method: "POST" }],
      ["a delete", "nope", { ...navigation, method: "DELETE" }],
    ];
    for (const [why, name, request] of asked) {
      const answer = await answerRequest(name, roots, "index.html", request, false);
      assert.deepEqual(answer, { relative: name, served: NOT_FOUND, routed: false }, why);
    }
  });

  it("leaves a bundled app's unknown route to its entry, whatever 404.html the project holds", async () => {
    const { real, roots } = await siteWith404();
    const entry = { relative: "index.html", served: { ok: true, path: path.join(real, "index.html") }, routed: true };
    for (const route of ["nope", "users/42/edit", "docs"]) {
      assert.deepEqual(await answerRequest(route, roots, "index.html", navigation, true), entry, route);
    }
    // A missing file by name is still a 404 there, and not the page.
    const missing = await answerRequest("nope.html", roots, "index.html", navigation, true);
    assert.deepEqual(missing, { relative: "nope.html", served: NOT_FOUND, routed: false });
  });

  it("shows 404.html as itself, with a 200, when it is asked for by name", async () => {
    const { real, roots } = await siteWith404();
    for (const name of ["404.html", "404"]) {
      const answer = await answerRequest(name, roots, "index.html", navigation, false);
      assert.deepEqual(answer.served, { ok: true, path: path.join(real, "404.html") }, name);
      assert.equal(answer.status, undefined, name);
    }
  });

  it("never turns a refused path into the page", async () => {
    const { roots } = await plantedSite((site, outside) => {
      fs.writeFileSync(path.join(site, "404.html"), "<h1>gone</h1>");
      fs.symlinkSync(path.join(outside, "secret.html"), path.join(site, "leak"));
      fs.symlinkSync(outside, path.join(site, "linked-folder"));
    });
    const refused = [
      "/../secret.html",
      "/%2e%2e/secret.html",
      "/a/..%2F..%2Fsecret.html",
      "/..%2foutside/secret.html",
      "/leak",
      "/linked-folder/secret.html",
      "/linked-folder/",
      "/x%00y",
    ];
    for (const url of refused) {
      const answer = await answerRequest(servedRelative(url)!, roots, "index.html", navigation, false);
      assert.deepEqual(answer.served, { ok: false, status: HttpStatus.Forbidden }, url);
      assert.equal(answer.status, undefined, url);
      assert.notEqual(answer.relative, "404.html", url);
    }
    assert.equal(servedRelative("/%E0%A4%A"), null);
    // The studio's own route is not the project's to answer.
    const vendor = await answerRequest("vendor/studio/none.js", roots, "index.html", navigation, false);
    assert.deepEqual(vendor, { relative: "vendor/studio/none.js", served: NOT_FOUND, routed: false });
  });

  it("takes 404.html only when it is a regular, non-empty file inside the root", async () => {
    const cases: Array<[string, (site: string, outside: string) => void]> = [
      [
        "a link out of the root",
        (site, outside) => fs.symlinkSync(path.join(outside, "secret.html"), path.join(site, "404.html")),
      ],
      ["a dangling link", (site) => fs.symlinkSync(path.join(site, "gone.html"), path.join(site, "404.html"))],
      ["a folder", (site) => fs.mkdirSync(path.join(site, "404.html"))],
      ["an empty file", (site) => fs.writeFileSync(path.join(site, "404.html"), "")],
    ];
    for (const [why, plant] of cases) {
      const { roots } = await plantedSite(plant);
      const answer = await answerRequest("nope", roots, "index.html", navigation, false);
      assert.deepEqual(answer, { relative: "nope", served: NOT_FOUND, routed: false }, why);
    }
  });

  it("follows a link to a page inside the root, and sends a very large page as it is", async () => {
    const linked = await plantedSite((site) => {
      fs.writeFileSync(path.join(site, "gone.html"), "<h1>gone</h1>");
      fs.symlinkSync("gone.html", path.join(site, "404.html"));
    });
    const answer = await answerRequest("nope", linked.roots, "index.html", navigation, false);
    assert.deepEqual(answer.served, { ok: true, path: path.join(linked.real, "gone.html") });
    assert.equal(answer.status, HttpStatus.NotFound);
    // Nothing is read here: the page is streamed, and rewritten only under the rewrite cap.
    const large = await plantedSite((site) => {
      fs.writeFileSync(path.join(site, "404.html"), "x");
      fs.truncateSync(path.join(site, "404.html"), MAX_REWRITE_BYTES + 1);
    });
    const big = await answerRequest("nope", large.roots, "index.html", navigation, false);
    assert.equal(big.status, HttpStatus.NotFound);
    assert.equal(big.served.ok, true);
  });

  it("does not wait on a pipe named 404.html", {
    skip: process.platform === "win32" && "Windows has no FIFOs in the file system",
  }, async () => {
    const { roots } = await plantedSite((site) => execFileSync("/usr/bin/mkfifo", [path.join(site, "404.html")]));
    const answer = await answerRequest("nope", roots, "index.html", navigation, false);
    assert.deepEqual(answer, { relative: "nope", served: NOT_FOUND, routed: false });
  });

  it("serves nothing from a root swapped after the page loaded, 404.html included", async () => {
    const { parent, roots } = await plantedSite((site) =>
      fs.writeFileSync(path.join(site, "404.html"), "<h1>gone</h1>"),
    );
    const swapped = { ...roots, pinnedProjectRoot: () => path.join(parent, "pinned-elsewhere") };
    const answer = await answerRequest("nope", swapped, "index.html", navigation, false);
    assert.deepEqual(answer, { relative: "nope", served: NOT_FOUND, routed: false });
  });
});
