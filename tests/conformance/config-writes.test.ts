/**
 * Read-modify-write of a user's own config file never turns a file Studio could not read into a
 * fresh one: studio.json is "explicit and editable", and a hand edit with a trailing comma used to
 * be replaced by only the detected shape (exportFiles, versionNested consent and bootMs lost).
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { ProjectWorkspaces } from "../../src/substrate/project-workspace.ts";
import { tmpDir } from "../helpers/tmp.ts";

const repo = path.resolve(import.meta.dirname, "../..");

async function workspaces() {
  const base = await tmpDir("studio-config-writes-");
  const projects = new ProjectWorkspaces({
    root: path.join(base, "library"),
    templateDir: path.join(repo, "src", "project-template"),
    vendorDir: path.join(base, "vendor"),
    indexFile: path.join(base, "projects.json"),
    userData: path.join(base, "userData"),
    homeDir: base,
  });
  return { projects, base };
}

/** A project of its own (a Vite build), so adoption records its shape in studio.json. */
async function ownProject(dir: string): Promise<void> {
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(
    path.join(dir, "index.html"),
    `<!doctype html><title>OWN</title><script type="module" src="/src/main.ts"></script>\n`,
  );
  await writeFile(path.join(dir, "src", "main.ts"), `export const scene = {};\n`);
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "own",
      type: "module",
      scripts: { build: "vite build" },
      devDependencies: { vite: "^5.4.10" },
    }),
  );
}

const handEdited = `{\n  "exportFiles": ["dist"],\n  "versionNested": true,\n  "bootMs": 9000,\n}\n`;

describe("config read-modify-write", () => {
  it("adoption never rewrites a studio.json it cannot parse, and says which file", async () => {
    const { projects, base } = await workspaces();
    const dir = path.join(base, "own");
    await ownProject(dir);
    await writeFile(path.join(dir, "studio.json"), handEdited);
    await assert.rejects(
      projects.adopt(dir),
      (error: Error) => /studio\.json/.test(error.message) && /not valid JSON/.test(error.message),
    );
    assert.equal(await readFile(path.join(dir, "studio.json"), "utf8"), handEdited, "the user's file is untouched");
  });

  it("recording nested-repository consent never rewrites a studio.json it cannot parse", async () => {
    const { projects, base } = await workspaces();
    const dir = path.join(base, "consent");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "studio.json"), handEdited);
    await assert.rejects(projects.adopt(dir, { versionNested: true }), /studio\.json/);
    assert.equal(await readFile(path.join(dir, "studio.json"), "utf8"), handEdited);
  });

  it("a missing studio.json is still written, and a readable one keeps the user's keys", async () => {
    const { projects, base } = await workspaces();
    const fresh = path.join(base, "fresh");
    await ownProject(fresh);
    await projects.adopt(fresh);
    assert.equal(JSON.parse(await readFile(path.join(fresh, "studio.json"), "utf8")).build, "npm run build");

    const kept = path.join(base, "kept");
    await ownProject(kept);
    await writeFile(path.join(kept, "studio.json"), JSON.stringify({ exportFiles: ["dist"], bootMs: 9000 }));
    await projects.adopt(kept, { versionNested: true });
    const meta = JSON.parse(await readFile(path.join(kept, "studio.json"), "utf8"));
    assert.deepEqual(meta.exportFiles, ["dist"]);
    assert.equal(meta.bootMs, 9000);
    assert.equal(meta.versionNested, true);
    assert.equal(meta.build, "npm run build");
  });
});
