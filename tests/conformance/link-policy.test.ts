/**
 * Links inside the studio window never navigate it (2026-09-06: a contractor's
 * "[Base handoff](/…/NOTES.base-builder.md)" link turned the whole app black). A file link opens
 * only a real document inside a project folder; anything else is shown in Finder or refused, so a
 * contractor's link can never run what it wrote (SECUI-1).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { routeStudioLink } from "../../src/main/link-policy.ts";
import { tmpDir } from "../helpers/tmp.ts";

const link = (file: string) => pathToFileURL(file).href;
const real = (file: string) => fs.realpathSync(file);
const touch = (file: string, text = "x\n", mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.chmodSync(file, mode);
};

async function folders() {
  const projects = await tmpDir("studio-links-");
  const project = path.join(projects, "skate-prod");
  const spaced = path.join(projects, "AI Projects", "hi");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(spaced, { recursive: true });
  const outside = await tmpDir("studio-outside-");
  return { projects, project, spaced, outside, projectDirs: [project, path.dirname(spaced)] };
}

describe("studio link policy", () => {
  it("opens https outside the window and refuses plain http", async () => {
    const { projectDirs } = await folders();
    assert.deepEqual(await routeStudioLink("https://example.com/x", { projectDirs }), {
      action: "external",
      url: "https://example.com/x",
    });
    assert.equal((await routeStudioLink("http://example.com/x", { projectDirs })).action, "refuse");
  });

  it("hands a document inside a project folder to its own app, never to the window", async () => {
    const { project, spaced, projectDirs } = await folders();
    touch(path.join(project, "NOTES.base-builder.md"));
    touch(path.join(spaced, "NOTES.md"));
    const route = await routeStudioLink(link(path.join(project, "NOTES.base-builder.md")), { projectDirs });
    assert.deepEqual(route, { action: "open-path", target: path.join(real(project), "NOTES.base-builder.md") });
    // Spaces arrive percent-encoded from the renderer.
    assert.ok(link(path.join(spaced, "NOTES.md")).includes("%20"));
    assert.deepEqual(await routeStudioLink(link(path.join(spaced, "NOTES.md")), { projectDirs }), {
      action: "open-path",
      target: path.join(real(spaced), "NOTES.md"),
    });
    // Every allowlisted type, whatever its case.
    for (const name of [
      "a.txt",
      "b.json",
      "c.html",
      "d.PNG",
      "e.jpeg",
      "f.svg",
      "g.mp3",
      "h.glb",
      "i.csv",
      "j.log",
      "k.webm",
    ]) {
      touch(path.join(project, "docs", name));
      assert.equal(
        (await routeStudioLink(link(path.join(project, "docs", name)), { projectDirs })).action,
        "open-path",
        name,
      );
    }
  });

  it("refuses files outside the project folders, including traversal out of one", async () => {
    const { project, outside, projectDirs } = await folders();
    touch(path.join(outside, "id_rsa"));
    touch(path.join(`${project}-evil`, "NOTES.md"));
    try {
      assert.equal((await routeStudioLink(link(path.join(outside, "id_rsa")), { projectDirs })).action, "refuse");
      const climb = `${link(project)}/../../${path.basename(outside)}/id_rsa`;
      assert.equal((await routeStudioLink(climb, { projectDirs })).action, "refuse");
      assert.equal(
        (await routeStudioLink(link(path.join(`${project}-evil`, "NOTES.md")), { projectDirs })).action,
        "refuse",
        "a sibling that merely shares the prefix",
      );
    } finally {
      fs.rmSync(`${project}-evil`, { recursive: true, force: true });
    }
  });

  it("refuses a link inside a project folder that leads out of it", async () => {
    const { project, outside, projectDirs } = await folders();
    touch(path.join(outside, "secret.md"));
    fs.symlinkSync(path.join(outside, "secret.md"), path.join(project, "notes.md"));
    fs.symlinkSync(outside, path.join(project, "linked"));
    for (const target of [
      path.join(project, "notes.md"),
      path.join(project, "linked", "secret.md"),
      path.join(project, "linked"),
    ]) {
      assert.equal((await routeStudioLink(link(target), { projectDirs })).action, "refuse", target);
    }
  });

  it("refuses a file that does not exist, and a link whose target does not", async () => {
    const { project, projectDirs } = await folders();
    fs.symlinkSync(path.join(project, "nowhere.md"), path.join(project, "dangling.md"));
    for (const target of [
      path.join(project, "NOTES.md"),
      path.join(project, "dangling.md"),
      path.join(project, "no", "such", "dir.md"),
    ]) {
      assert.equal((await routeStudioLink(link(target), { projectDirs })).action, "refuse", target);
    }
    // A project folder that is gone contains nothing.
    const gone = path.join(path.dirname(project), "gone");
    assert.equal((await routeStudioLink(link(path.join(gone, "NOTES.md")), { projectDirs: [gone] })).action, "refuse");
  });

  it("never opens what a contractor could run: launchers, bundles and executables are shown in Finder", async () => {
    const { project, projectDirs } = await folders();
    touch(path.join(project, "tools", "Run Me.command"), "#!/bin/sh\necho hi\n", 0o755);
    touch(path.join(project, "x.terminal"));
    touch(path.join(project, "a.pkg"));
    touch(path.join(project, "go.sh"), "#!/bin/sh\n", 0o755);
    touch(path.join(project, "plain.command"), "echo hi\n", 0o644);
    fs.mkdirSync(path.join(project, "Evil.app", "Contents", "MacOS"), { recursive: true });
    touch(path.join(project, "Evil.app", "Contents", "MacOS", "Evil"), "#!/bin/sh\n", 0o755);
    // Windows runs by extension: its launchers are shown like the Mac's.
    const windowsLaunchers = ["setup.exe", "run.bat", "run.cmd", "run.ps1", "notes.lnk", "go.vbs", "go.js", "x.hta"];
    for (const name of windowsLaunchers) touch(path.join(project, name));
    // An allowlisted name is not enough: the exec bit makes it a program. Windows files have none.
    const execBit = process.platform !== "win32";
    if (execBit) touch(path.join(project, "NOTES.md"), "#!/bin/sh\n", 0o755);
    // A document name that links to a launcher inside the project is the launcher.
    fs.symlinkSync(path.join(project, "tools", "Run Me.command"), path.join(project, "handoff.md"));
    const cases: Array<[string, string]> = [
      [path.join(project, "tools", "Run Me.command"), path.join(real(project), "tools", "Run Me.command")],
      [path.join(project, "x.terminal"), path.join(real(project), "x.terminal")],
      [path.join(project, "a.pkg"), path.join(real(project), "a.pkg")],
      [path.join(project, "go.sh"), path.join(real(project), "go.sh")],
      [path.join(project, "plain.command"), path.join(real(project), "plain.command")],
      [path.join(project, "Evil.app"), path.join(real(project), "Evil.app")],
      ...windowsLaunchers.map((name): [string, string] => [path.join(project, name), path.join(real(project), name)]),
      [path.join(project, "handoff.md"), path.join(real(project), "tools", "Run Me.command")],
    ];
    if (execBit) cases.push([path.join(project, "NOTES.md"), path.join(real(project), "NOTES.md")]);
    for (const [target, shown] of cases) {
      assert.deepEqual(
        await routeStudioLink(link(target), { projectDirs }),
        { action: "reveal", target: shown },
        target,
      );
    }
  });

  it("decides by the last extension only, and shows anything without an openable one (L3)", async () => {
    const { project, projectDirs } = await folders();
    touch(path.join(project, "a.command.md"));
    touch(path.join(project, "a.md.command"));
    touch(path.join(project, "README"));
    fs.mkdirSync(path.join(project, "x.md"));
    assert.deepEqual(await routeStudioLink(link(path.join(project, "a.command.md")), { projectDirs }), {
      action: "open-path",
      target: path.join(real(project), "a.command.md"),
    });
    for (const name of ["a.md.command", "README", "x.md"]) {
      assert.deepEqual(
        await routeStudioLink(link(path.join(project, name)), { projectDirs }),
        { action: "reveal", target: path.join(real(project), name) },
        name,
      );
    }
  });

  it("shows a project folder, or a folder in it, in Finder rather than opening it", async () => {
    const { project, projectDirs } = await folders();
    fs.mkdirSync(path.join(project, "assets"));
    assert.deepEqual(await routeStudioLink(link(project), { projectDirs }), {
      action: "reveal",
      target: real(project),
    });
    assert.deepEqual(await routeStudioLink(link(path.join(project, "assets")), { projectDirs }), {
      action: "reveal",
      target: path.join(real(project), "assets"),
    });
  });

  it("refuses other schemes, remote file hosts and non-links in words", async () => {
    const { project, projectDirs } = await folders();
    touch(path.join(project, "NOTES.md"));
    const remote = link(path.join(project, "NOTES.md")).replace("file://", "file://attacker.example");
    for (const raw of ["javascript:alert(1)", "mailto:a@b.c", "not a url", "", remote]) {
      const route = await routeStudioLink(raw, { projectDirs });
      assert.equal(route.action, "refuse", raw);
      assert.ok(route.action === "refuse" && route.reason.length > 0);
    }
  });
});
