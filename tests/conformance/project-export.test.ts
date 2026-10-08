import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { exportPublicProject } from "../../src/substrate/project-export.ts";

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
