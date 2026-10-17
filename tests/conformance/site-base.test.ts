/**
 * The sub-path a built site expects to be hosted at (`base: "/my-site/"` in Vite): found from the
 * built page's own root-absolute URLs, never from the bundler's config.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileUnder, inferSiteBase, withoutSiteBase } from "../../src/substrate/site-base.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** An `isFile` over a fixed set of root-relative paths. */
const files =
  (...present: string[]) =>
  async (rel: string) =>
    present.includes(rel);

describe("inferring the site base from a built page", () => {
  it("finds the prefix the built files sit without, and is silent otherwise", async () => {
    const table: Array<[string, string[], string[], string | null]> = [
      [
        "a Vite sub-path build",
        ["/my-site/assets/index-a1.js", "/my-site/assets/index-a1.css", "/my-site/favicon.svg"],
        ["assets/index-a1.js", "assets/index-a1.css", "favicon.svg"],
        "my-site",
      ],
      ["two segments: the shortest prefix that resolves", ["/org/repo/assets/x.js"], ["assets/x.js"], "org/repo"],
      ["a root build", ["/assets/x.js", "/favicon.svg"], ["assets/x.js", "favicon.svg"], null],
      [
        "relative, CDN, protocol-relative, data and fragment references",
        [
          "./assets/x.js",
          "assets/x.js",
          "https://cdn.example.com/assets/x.js",
          "//cdn.example.com/a.js",
          "data:text/plain,hi",
          "#top",
        ],
        ["assets/x.js"],
        null,
      ],
      [
        "a typo beside real evidence does not hide the base",
        ["/my-site/assets/x.js", "/my-site/assets/gone.js"],
        ["assets/x.js"],
        "my-site",
      ],
      ["a typo alone is no evidence", ["/my-site/assets/gone.js"], [], null],
      ["two different prefixes", ["/a/x.js", "/b/y.js"], ["x.js", "y.js"], null],
      ["a query and a fragment", ["/my-site/assets/x.js?v=3#frag"], ["assets/x.js"], "my-site"],
      ["an encoded space", ["/my%20site/assets/x.js"], ["assets/x.js"], "my site"],
      ["one segment names no prefix", ["/gone.js"], ["gone.js"], null],
      ["the studio's own vendor route is never a base", ["/vendor/assets/x.js"], ["assets/x.js"], null],
    ];
    for (const [what, references, present, expected] of table) {
      assert.equal(await inferSiteBase(references, files(...present)), expected, what);
    }
  });

  it("never looks at a path that climbs, escapes or cannot be decoded", async () => {
    const asked: string[] = [];
    const spy = async (rel: string) => {
      asked.push(rel);
      return false;
    };
    const hostile = [
      "/a/../../etc/passwd",
      "/a/%2e%2e/%2e%2e/etc/passwd",
      "/a/..%2f..%2fetc/passwd",
      "/a\\..\\x.js",
      "/%00/x.js",
      "/%E0%A4%A/x.js",
      "/a//x.js",
    ];
    assert.equal(await inferSiteBase(hostile, spy), null);
    for (const rel of asked) assert.doesNotMatch(rel, /\.\.|\\|\0/, rel);
  });
});

describe("taking the base off a request path", () => {
  it("strips whole leading segments only, once", () => {
    const table: Array<[string, string | null, string | null]> = [
      ["my-site/assets/x.js", "my-site", "assets/x.js"],
      ["my-site", "my-site", ""],
      ["my-site/", "my-site", ""],
      ["my-sitex/assets/x.js", "my-site", null],
      ["assets/x.js", "my-site", null],
      ["my-site/my-site/a.js", "my-site", "my-site/a.js"],
      ["org/repo/a.js", "org/repo", "a.js"],
      ["org/a.js", "org/repo", null],
      ["my-site/a.js", null, null],
    ];
    for (const [relative, base, expected] of table) {
      assert.equal(withoutSiteBase(relative, base), expected, `${relative} under ${base}`);
    }
  });
});

describe("which files a root holds", () => {
  it("answers only for a regular file inside the root, through links as well", async (t) => {
    const parent = await tmpDir("studio-site-base-");
    const root = path.join(parent, "dist");
    fs.mkdirSync(path.join(root, "assets"), { recursive: true });
    fs.writeFileSync(path.join(root, "assets", "x.js"), "1");
    fs.writeFileSync(path.join(parent, "secret.txt"), "secret");
    const present = fileUnder(root);
    assert.equal(await present("assets/x.js"), true);
    assert.equal(await present("assets"), false, "a folder is not a file");
    assert.equal(await present("../secret.txt"), false);
    assert.equal(await present(path.join(parent, "secret.txt")), false);
    assert.equal(await present("missing.js"), false);
    if (process.platform === "win32") return t.skip("creating a link needs a privilege on Windows");
    fs.symlinkSync(path.join(parent, "secret.txt"), path.join(root, "leak.txt"));
    assert.equal(await present("leak.txt"), false, "a link out of the root is not a file of it");
  });
});
