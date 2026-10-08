/**
 * Permission store — the mode new chats start in and each project's "always allow" rules survive a
 * restart, and a missing or damaged file reads as the defaults instead of failing a chat.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, readdir, writeFile, mkdir, rm } from "node:fs/promises";
import { test } from "node:test";
import { PermissionStore } from "../../src/main/permission-store.ts";
import { DEFAULT_PERMISSION_MODE } from "../../src/shared/permissions.ts";
import { tmpDir } from "../helpers/tmp.ts";

test("a missing file reads as the defaults and is not created by reading", async () => {
  const dir = await tmpDir("permission-store-");
  const file = path.join(dir, "engine-homes", "permissions.json");
  const store = new PermissionStore(file);
  assert.equal(await store.defaultMode(), DEFAULT_PERMISSION_MODE);
  assert.deepEqual(await store.rules("pong"), []);
  assert.deepEqual(await store.all(), {});
  await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });
});

test("a damaged file reads as the defaults; junk inside a valid file is dropped", async () => {
  const dir = await tmpDir("permission-store-");
  const broken = path.join(dir, "broken.json");
  await writeFile(broken, "{not json");
  assert.equal(await new PermissionStore(broken).defaultMode(), DEFAULT_PERMISSION_MODE);
  assert.deepEqual(await new PermissionStore(broken).all(), {});

  const junk = path.join(dir, "junk.json");
  await writeFile(
    junk,
    JSON.stringify({
      version: 1,
      defaultMode: "yolo",
      rules: {
        pong: ["Bash(npm test:*)", 7, "", " Bash(npm test:*) ", null, "WebFetch(domain:x.com)"],
        "": ["Bash(ls)"],
        tetris: "Bash(ls)",
      },
    }),
  );
  const store = new PermissionStore(junk);
  assert.equal(await store.defaultMode(), DEFAULT_PERMISSION_MODE);
  assert.deepEqual(await store.all(), { pong: ["Bash(npm test:*)", "WebFetch(domain:x.com)"] });

  const list = path.join(dir, "list.json");
  await writeFile(list, "[1,2,3]");
  assert.deepEqual(await new PermissionStore(list).all(), {});
});

test("rules are added in order, once, forgotten one by one, and survive a reload", async () => {
  const dir = await tmpDir("permission-store-");
  const file = path.join(dir, "permissions.json");
  const store = new PermissionStore(file);
  assert.deepEqual(await store.addRules("pong", ["Bash(npm install:*)", "Read(//Users/me/refs/**)"]), [
    "Bash(npm install:*)",
    "Read(//Users/me/refs/**)",
  ]);
  assert.deepEqual(
    await store.addRules("pong", ["Read(//Users/me/refs/**)", "WebFetch(domain:x.com)", "WebFetch(domain:x.com)"]),
    ["Bash(npm install:*)", "Read(//Users/me/refs/**)", "WebFetch(domain:x.com)"],
  );
  await store.addRules("tetris", ["Bash(ls:*)"]);
  await assert.rejects(store.addRules("", ["Bash(ls:*)"]), /Invalid project/);

  const reloaded = new PermissionStore(file);
  assert.deepEqual(await reloaded.all(), {
    pong: ["Bash(npm install:*)", "Read(//Users/me/refs/**)", "WebFetch(domain:x.com)"],
    tetris: ["Bash(ls:*)"],
  });
  assert.equal(await reloaded.forget("pong", "Read(//Users/me/refs/**)"), true);
  assert.equal(await reloaded.forget("pong", "Read(//Users/me/refs/**)"), false);
  assert.equal(await reloaded.forget("tetris", "Bash(ls:*)"), true);
  assert.deepEqual(
    await new PermissionStore(file).all(),
    { pong: ["Bash(npm install:*)", "WebFetch(domain:x.com)"] },
    "a project with no rules left is gone",
  );
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.version, 1);
  assert.equal(saved.defaultMode, DEFAULT_PERMISSION_MODE);
});

test("the default mode persists, rejects junk, and concurrent writes all land", async () => {
  const dir = await tmpDir("permission-store-");
  await mkdir(path.join(dir, "homes"));
  const file = path.join(dir, "homes", "permissions.json");
  const store = new PermissionStore(file);
  await store.setDefaultMode("default");
  await assert.rejects(store.setDefaultMode("yolo" as never), /starts in/);
  // Plan and Bypass are chosen chat by chat: never the mode a new chat starts in.
  await assert.rejects(store.setDefaultMode("bypassPermissions"), /starts in/);
  await assert.rejects(store.setDefaultMode("plan"), /starts in/);
  assert.equal(await new PermissionStore(file).defaultMode(), "default");

  await Promise.all([
    store.setDefaultMode("acceptEdits"),
    ...Array.from({ length: 12 }, (_, index) => store.addRules("pong", [`Bash(step${index}:*)`])),
  ]);
  const reloaded = new PermissionStore(file);
  assert.equal(await reloaded.defaultMode(), "acceptEdits");
  assert.equal((await reloaded.rules("pong")).length, 12);
  assert.deepEqual(
    (await readdir(path.join(dir, "homes"))).filter((name) => name.startsWith(".tmp-")),
    [],
    "no temp file is left behind",
  );
});

test("a read that fails for any reason but a missing file is retried, never written over", async () => {
  const dir = await tmpDir("permission-store-");
  const file = path.join(dir, "permissions.json");
  // A directory where the file belongs: the read fails with EISDIR, not ENOENT.
  await mkdir(file);
  const store = new PermissionStore(file);
  await assert.rejects(store.defaultMode());
  await assert.rejects(store.addRules("rift", ["Bash(npm test:*)"]), "nothing is written from a read that failed");
  await rm(file, { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, defaultMode: "default", rules: { rift: ["Read(//refs/**)"] } }));
  assert.equal(await store.defaultMode(), "default", "the next call reads again");
  assert.deepEqual(await store.rules("rift"), ["Read(//refs/**)"]);
});

test("a file that names Bypass as the default, or a whole-tool rule, is not believed", async () => {
  const dir = await tmpDir("permission-store-");
  const file = path.join(dir, "permissions.json");
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      defaultMode: "bypassPermissions",
      rules: { rift: ["Bash", "Bash(npm test:*)", "Edit"] },
    }),
  );
  const store = new PermissionStore(file);
  assert.equal(await store.defaultMode(), DEFAULT_PERMISSION_MODE);
  assert.deepEqual(await store.rules("rift"), ["Bash(npm test:*)"]);
});
