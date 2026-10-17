import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { exportPublicProject } from "../../src/substrate/project-export.ts";
import { removeTree } from "../helpers/tmp.ts";

it("exports public runtime files without nested credentials or private directories; fails safely on symlinks", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-export-"));
  const source = path.join(temp, "project"),
    target = path.join(temp, "public");
  try {
    await mkdir(path.join(source, "assets"), { recursive: true });
    await mkdir(path.join(source, "src"));
    await writeFile(path.join(source, "index.html"), '<script type="module" src="./src/main.js"></script>');
    await writeFile(path.join(source, "src/main.js"), 'console.log("project")');
    await writeFile(path.join(source, "assets/texture.png"), "fixture");
    for (const p of [
      ".env",
      "private.pem",
      "assets/.env",
      "assets/private.key",
      "assets/production.env",
      "src/env.local",
      "assets/keys.jks",
    ])
      await writeFile(path.join(source, p), "PRIVATE FIXTURE");
    const result = await exportPublicProject(source, target, ["index.html", "src", "assets", ".env", "private.pem"]);
    assert.deepEqual(result.included.sort(), ["assets/texture.png", "index.html", "src/main.js"]);
    await assert.rejects(
      exportPublicProject(source, target, ["index.html", "src", "missing-public-file"]),
      /Selected public path is missing/,
    );
    assert.equal(await readFile(path.join(target, "assets/.env"), "utf8").catch(() => null), null);
    await symlink(path.join(source, ".env"), path.join(source, "assets/leak.txt"));
    await assert.rejects(exportPublicProject(source, target, ["index.html", "src", "assets"]), /symlink/);
    assert.match(await readFile(path.join(target, "index.html"), "utf8"), /main.js/);
    await assert.rejects(exportPublicProject(source, path.join(source, "export"), ["index.html"]), /outside/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

it("validates module dependencies, ignores commented examples and keeps only reachable vendored files", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-export-modules-"));
  const project = path.join(temp, "project"),
    vendor = path.join(temp, "vendor");
  try {
    await mkdir(project);
    await mkdir(vendor);
    await writeFile(
      path.join(project, "index.html"),
      '<script type="importmap">{"imports":{"engine":"/vendor/engine.js"}}</script><script type="module" src="./main.js"></script>',
    );
    await writeFile(
      path.join(project, "main.js"),
      '// import "./not-real.js";\nimport {value} from "engine"; console.log(value);',
    );
    await writeFile(path.join(vendor, "engine.js"), 'export {value} from "./part.js";');
    await writeFile(path.join(vendor, "part.js"), "export const value=1;");
    await writeFile(path.join(vendor, "unused.js"), 'import "./missing-example.js";');
    await writeFile(path.join(vendor, "LICENSE"), "notice");
    const result = await exportPublicProject(project, path.join(temp, "public"), ["index.html", "main.js"], vendor);
    assert.ok(result.included.includes("vendor/part.js"));
    assert.ok(result.included.includes("vendor/LICENSE"));
    assert.ok(!result.included.includes("vendor/unused.js"));
    await writeFile(path.join(project, "main.js"), 'import "./missing.js";');
    await assert.rejects(
      exportPublicProject(project, path.join(temp, "public"), ["index.html", "main.js"], vendor),
      /missing.js/,
    );
    assert.match(
      await readFile(path.join(temp, "public/main.js"), "utf8"),
      /not-real/,
      "a failed replacement preserves the last valid export",
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

it("refuses to export a file that holds a credential Studio knows, and leaves the last export in place (SEC-6)", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-export-secrets-"));
  const source = path.join(temp, "project"),
    target = path.join(temp, "public");
  const secret = "genex-FAKE-token-value";
  try {
    await mkdir(path.join(source, "src"), { recursive: true });
    await mkdir(path.join(source, "assets"));
    await writeFile(path.join(source, "index.html"), '<script type="module" src="./src/main.js"></script>');
    await writeFile(path.join(source, "src/main.js"), 'console.log("project")');
    await writeFile(path.join(source, "assets/data.bin"), Buffer.from([1, 2, 3]));
    await exportPublicProject(source, target, ["index.html", "src", "assets"], undefined, {
      secretValues: [secret, "short"],
    });
    await writeFile(path.join(source, "src/main.js"), `const KEY='${secret}';console.log("project")`);
    await assert.rejects(
      exportPublicProject(source, target, ["index.html", "src", "assets"], undefined, { secretValues: [secret] }),
      (error: Error) => {
        assert.match(error.message, /src\/main\.js/);
        assert.equal(error.message.includes(secret), false, "the refusal does not repeat the value");
        return true;
      },
    );
    assert.equal(
      await readFile(path.join(target, "src/main.js"), "utf8"),
      'console.log("project")',
      "the previous export is untouched",
    );
    await writeFile(path.join(source, "src/main.js"), 'console.log("project")');
    await writeFile(
      path.join(source, "assets/data.bin"),
      Buffer.concat([Buffer.from([0, 1]), Buffer.from(secret), Buffer.from([2])]),
    );
    await assert.rejects(
      exportPublicProject(source, target, ["index.html", "src", "assets"], undefined, { secretValues: [secret] }),
      /assets\/data\.bin/,
      "binary files are checked too",
    );
    const names = (await readdir(temp)).filter((n) => n.startsWith(".studio-export-"));
    assert.deepEqual(names, [], "no staging directory is left behind");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

/** A project folder the export tests fill: files by relative path. */
async function site(files: Record<string, string>): Promise<{ temp: string; source: string; target: string }> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-export-site-"));
  const source = path.join(temp, "site");
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await writeFile(path.join(source, file), text);
  }
  return { temp, source, target: path.join(temp, "public") };
}

it("exports a page whose links are navigation: the site root, a section, a folder, a clean URL, a mail address", async () => {
  const { temp, source, target } = await site({
    "index.html": [
      '<base href="/">',
      '<link rel="canonical" href="https://example.com/">',
      '<link rel="stylesheet" href="./site.css">',
      '<a href="/">Home</a> <a href="/#features">Features</a> <a href="/about/">About</a>',
      '<a href="/pricing">Pricing</a> <a href="mailto:hi@example.com">Mail</a>',
      '<a href="docs/index.html">Docs</a>',
      '<script src="./app.js"></script>',
    ].join("\n"),
    "site.css": "body { color: black }",
    "app.js": "console.log(1);",
    "about/index.html": "<h1>About</h1>",
  });
  try {
    const result = await exportPublicProject(source, target, ["index.html", "site.css", "app.js", "about"]);
    assert.deepEqual(result.included.sort(), ["about/index.html", "app.js", "index.html", "site.css"]);
  } finally {
    await removeTree(temp);
  }
});

it("still stops on a resource the page needs and the export does not have", async () => {
  const missing: Array<[string, string]> = [
    ["a script", '<script src="./gone.js"></script>'],
    ["a stylesheet", '<link rel="stylesheet" href="./gone.css">'],
    ["an image", '<img src="./gone.png" alt="">'],
    ["an icon", '<link rel="icon" href="./gone.ico">'],
    ["a module preload", '<link rel="modulepreload" href="./gone.js">'],
    ["a media file", '<video src="./gone.mp4"></video>'],
  ];
  for (const [what, tag] of missing) {
    const { temp, source, target } = await site({ "index.html": `<a href="/">Home</a>${tag}` });
    try {
      await assert.rejects(
        exportPublicProject(source, target, ["index.html"]),
        /missing a referenced public file/,
        what,
      );
    } finally {
      await removeTree(temp);
    }
  }
  // …and so does a stylesheet's own reference, and a module's.
  const css = await site({
    "index.html": '<link rel="stylesheet" href="./a.css">',
    "a.css": "p { background: url(./gone.png) }",
  });
  try {
    await assert.rejects(exportPublicProject(css.source, css.target, ["index.html", "a.css"]), /gone\.png/);
  } finally {
    await removeTree(css.temp);
  }
  const mod = await site({
    "index.html": '<script type="module" src="./m.js"></script>',
    "m.js": 'import "./gone.js";',
  });
  try {
    await assert.rejects(exportPublicProject(mod.source, mod.target, ["index.html", "m.js"]), /gone\.js/);
  } finally {
    await removeTree(mod.temp);
  }
});

it("says a referenced file was left out on purpose when its name looks like a secret, and keeps saying missing for a typo", async () => {
  const leftOut: Array<[string, Record<string, string>, RegExp]> = [
    [
      "a module named env.js",
      {
        "index.html": '<script type="module" src="./main.js"></script>',
        "main.js": 'import "./env.js";',
        "env.js": "x",
      },
      /left out.*env\.js/s,
    ],
    [
      "a module in a secrets folder",
      {
        "index.html": '<script type="module" src="./main.js"></script>',
        "main.js": 'import "./src/secrets/keys.js";',
        "src/secrets/keys.js": "x",
      },
      /left out.*src\/secrets\/keys\.js/s,
    ],
    [
      "a source map the page asks for",
      { "index.html": '<script src="./app.js.map"></script>', "app.js.map": "{}" },
      /left out.*app\.js\.map/s,
    ],
  ];
  for (const [what, files, expected] of leftOut) {
    const { temp, source, target } = await site(files);
    try {
      await assert.rejects(
        exportPublicProject(source, target, ["index.html", ...Object.keys(files).filter((f) => f !== "index.html")]),
        (error: Error) => {
          assert.match(error.message, expected, what);
          assert.doesNotMatch(error.message, /missing a referenced/, what);
          return true;
        },
      );
    } finally {
      await removeTree(temp);
    }
  }
  const typo = await site({
    "index.html": '<script type="module" src="./main.js"></script>',
    "main.js": 'import "./enb.js";',
    "env.js": "x",
  });
  try {
    await assert.rejects(
      exportPublicProject(typo.source, typo.target, ["index.html", "main.js", "env.js"]),
      /missing a referenced public file: \.\/enb\.js/,
    );
  } finally {
    await removeTree(typo.temp);
  }
});

it("leaves the studio's 3D library out of a page that never loads it, and keeps it for one that loads it by a name only the page knows", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-export-three-"));
  const vendor = path.join(temp, "vendor");
  const map =
    '<script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/webgpu":"/vendor/three.webgpu.js"}}</script>';
  try {
    await mkdir(vendor);
    for (const file of ["three.module.js", "three.core.js", "three.webgpu.js"]) {
      await writeFile(path.join(vendor, file), `export const name = "${file}";`);
    }
    await writeFile(path.join(vendor, "LICENSE"), "MIT");

    // A todo list: the starter page carries the map, its code is DOM and imports nothing.
    const dom = path.join(temp, "dom");
    await mkdir(dom);
    await writeFile(path.join(dom, "index.html"), `${map}<script type="module" src="./main.js"></script>`);
    await writeFile(path.join(dom, "main.js"), 'document.body.append("todo");');
    const kept = await exportPublicProject(dom, path.join(temp, "out-dom"), ["index.html", "main.js"], vendor);
    assert.deepEqual(kept.included.filter((file) => file.startsWith("vendor/")).sort(), ["vendor/LICENSE"]);

    // Named by a specifier the lexer cannot read: the map's libraries must stay.
    const dynamic = path.join(temp, "dynamic");
    await mkdir(dynamic);
    await writeFile(path.join(dynamic, "index.html"), `${map}<script type="module" src="./main.js"></script>`);
    await writeFile(
      path.join(dynamic, "main.js"),
      'const gpu = location.hash === "#gpu";\nawait import(gpu ? "three/webgpu" : "three");',
    );
    const both = await exportPublicProject(dynamic, path.join(temp, "out-dynamic"), ["index.html", "main.js"], vendor);
    assert.ok(both.included.includes("vendor/three.module.js"), both.included.join(", "));
    assert.ok(both.included.includes("vendor/three.webgpu.js"), both.included.join(", "));

    // A plain import of the library keeps just what it reaches.
    const direct = path.join(temp, "direct");
    await mkdir(direct);
    await writeFile(path.join(direct, "index.html"), `${map}<script type="module" src="./main.js"></script>`);
    await writeFile(path.join(direct, "main.js"), 'import { name } from "three"; console.log(name);');
    const one = await exportPublicProject(direct, path.join(temp, "out-direct"), ["index.html", "main.js"], vendor);
    assert.ok(one.included.includes("vendor/three.module.js"));
    assert.ok(!one.included.includes("vendor/three.webgpu.js"), "a library nothing loads is not shipped");
  } finally {
    await removeTree(temp);
  }
});

it("exports every page a build wrote, documentation and notes pages included, and still no secret, key or package", async () => {
  const { temp, source, target } = await site({
    "index.html":
      '<a href="docs/index.html">Docs</a><a href="notes.html">Notes</a><a href="tests/demo.html">Demo</a><link rel="stylesheet" href="./a.css">',
    "a.css": "body {}",
    "docs/index.html": "<h1>Docs</h1>",
    "notes.html": "<h1>Notes</h1>",
    "plan.html": "<h1>Plan</h1>",
    "tests/demo.html": "<h1>Demo</h1>",
    ".well-known/security.txt": "Contact: mailto:security@example.com",
    ".env": "SECRET=1",
    "deploy.pem": "KEY",
    "a.css.map": "{}",
    "node_modules/x/index.js": "1",
    ".DS_Store": "x",
  });
  try {
    // Pointed at a project's source folder, the development folders stay out of the export (a link
    // to one is just a link).
    const sources = await exportPublicProject(source, target, ["index.html", "a.css", "docs", "notes.html", "tests"]);
    assert.deepEqual(sources.included.sort(), ["a.css", "index.html"]);
    assert.deepEqual(sources.excluded.sort(), ["docs", "notes.html", "tests"]);

    // Pointed at a build's output, they are the site.
    const result = await exportPublicProject(source, target, await readdir(source), undefined, { buildFolder: true });
    assert.deepEqual(result.included.sort(), [
      ".well-known/security.txt",
      "a.css",
      "docs/index.html",
      "index.html",
      "notes.html",
      "plan.html",
      "tests/demo.html",
    ]);
    for (const never of [".env", "deploy.pem", "a.css.map", "node_modules", ".DS_Store"]) {
      assert.ok(!result.included.some((file) => file.startsWith(never)), `${never} is never public`);
    }
  } finally {
    await removeTree(temp);
  }
});

it("reads a page's tags as a browser does: what it loads must exist, what is only text or a link need not", async () => {
  const page = (body: string, extra: Record<string, string> = {}) => ({ "index.html": body, ...extra });
  const fine: Array<[string, Record<string, string>]> = [
    ["a plain relative script (no ./)", page('<script src="main.js"></script>', { "main.js": "1;" })],
    ["a commented-out tag", page('<!-- <script src="./gone.js"></script> --><p>hi</p>')],
    ["a data attribute that looks like src", page('<img data-src="./gone.png" alt="">')],
    ["a template string in a script", page('<script>el.innerHTML = `<img src="${url}">`;</script>')],
    ["a fragment reference", page('<svg><use href="#icon"></use></svg>')],
    ["an input that is not an image", page('<input type="text" src="./gone.png">')],
    ["a link the page only points to", page('<link rel="alternate" href="/feed.xml"><a href="/x">x</a>')],
    [
      "a quoted src inside another attribute",
      page('<img alt=\'see src="./gone.png"\' src="ok.png">', { "ok.png": "png" }),
    ],
    [
      "a script that has a src ignores its body",
      page('<script src="main.js">import "./gone.js";</script>', { "main.js": "1;" }),
    ],
  ];
  const missing: Array<[string, Record<string, string>]> = [
    ["a '>' inside a quoted attribute", page('<img alt="a > b" src="./gone.png">')],
    ["a tag after an empty comment", page('<!--><img src="./gone.png"><!-- c -->')],
    ["a custom element that starts like a script", page('<script-loader></script-loader><img src="./gone.png">')],
    ["a comment opener inside a script string", page('<script>var s = "<!--";</script><img src="./gone.png">')],
    ["a quoted src inside another attribute, then the real one", page('<img alt=\'src="./ok.png"\' src="./gone.png">')],
    ["an image written as <image>", page('<image src="./gone.png">')],
    ["an SVG image with xlink:href", page('<svg><image xlink:href="./gone.png"/></svg>')],
    ["a classic script's dynamic import", page('<script>import("./gone.js");</script>')],
    ["an SVG image", page('<svg><image href="./gone.png"/></svg>')],
    ["an unquoted attribute", page("<link rel=stylesheet href=./gone.css>")],
    ["a video poster", page('<video poster="./gone.jpg"></video>')],
    ["an image input", page('<input type="image" src="./gone.png">')],
    ["a precomposed touch icon", page('<link rel="apple-touch-icon-precomposed" href="./gone.png">')],
    ["an uppercase tag", page('<IMG SRC="./gone.png">')],
  ];
  for (const [what, files] of fine) {
    const { temp, source, target } = await site(files);
    try {
      await exportPublicProject(source, target, Object.keys(files));
    } catch (error) {
      assert.fail(`${what}: ${(error as Error).message}`);
    } finally {
      await removeTree(temp);
    }
  }
  for (const [what, files] of missing) {
    const { temp, source, target } = await site(files);
    try {
      await assert.rejects(exportPublicProject(source, target, Object.keys(files)), /gone\./, what);
    } finally {
      await removeTree(temp);
    }
  }
});

it("never ships what the studio wrote into a project, even from a build that copied the project's files, and still ships pages that share those names", async () => {
  const { temp, source, target } = await site({
    "index.html":
      '<a href="notes.html">Notes</a><a href="agents/">Agents</a><img src="claude.png"><img src="assets/references/x.png">',
    "notes.html": "<h1>Notes app</h1>",
    "agents/index.html": "<h1>Agents directory</h1>",
    "claude.png": "png",
    "assets/references/x.png": "png",
    "CLAUDE.md": "rules",
    "CLAUDE.own.md": "rules",
    "AGENTS.md": "rules",
    "NOTES.md": "decisions",
    "NOTES.f1.md": "decisions",
    "references/mood.png": "png",
  });
  try {
    const result = await exportPublicProject(source, target, await readdir(source), undefined, { buildFolder: true });
    assert.deepEqual(result.included.sort(), [
      "agents/index.html",
      "assets/references/x.png",
      "claude.png",
      "index.html",
      "notes.html",
    ]);
  } finally {
    await removeTree(temp);
  }
});

it("keeps the 3D library for a classic inline script that imports it, and ships none for a lazy-loaded project page", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-export-lazy-"));
  const vendor = path.join(temp, "vendor");
  const map = '<script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>';
  try {
    await mkdir(vendor);
    await writeFile(path.join(vendor, "three.module.js"), 'export const name = "three";');
    await writeFile(path.join(vendor, "LICENSE"), "MIT");

    const classic = path.join(temp, "classic");
    await mkdir(classic);
    await writeFile(
      path.join(classic, "index.html"),
      `${map}<script>import("three").then((m) => console.log(m));</script>`,
    );
    const kept = await exportPublicProject(classic, path.join(temp, "out-classic"), ["index.html"], vendor);
    assert.ok(kept.included.includes("vendor/three.module.js"), kept.included.join(", "));

    const lazy = path.join(temp, "lazy");
    await mkdir(path.join(lazy, "pages"), { recursive: true });
    await writeFile(path.join(lazy, "index.html"), `${map}<script type="module" src="./main.js"></script>`);
    await writeFile(
      path.join(lazy, "main.js"),
      'const page = await import("./pages/" + location.hash.slice(1) + ".js");',
    );
    await writeFile(path.join(lazy, "pages", "home.js"), "export default 1;");
    const shipped = await exportPublicProject(
      lazy,
      path.join(temp, "out-lazy"),
      ["index.html", "main.js", "pages"],
      vendor,
    );
    assert.deepEqual(
      shipped.included.filter((file) => file.startsWith("vendor/")),
      ["vendor/LICENSE"],
    );
  } finally {
    await removeTree(temp);
  }
});
