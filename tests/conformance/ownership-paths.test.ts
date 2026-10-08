/**
 * The repo-relative path the ownership rule reads, from whatever a contractor's tool call names:
 * POSIX paths, and on Windows drive letters, either slash, any case and UNC shares. A path that
 * leaves the workspace in any spelling reads as `..`, which the hook blocks.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { relativeProjectPath } from "../../src/substrate/ownership.ts";

const WINDOWS_CWD = "C:\\Users\\Ada\\AI Projects\\marsh";

describe("relativeProjectPath on Windows", () => {
  const rows: Array<[string, string, string | null]> = [
    ["an absolute path inside", "C:\\Users\\Ada\\AI Projects\\marsh\\src\\a.js", "src/a.js"],
    ["forward slashes", "C:/Users/Ada/AI Projects/marsh/src/a.js", "src/a.js"],
    ["another case for the drive and folders", "c:\\users\\ada\\ai projects\\MARSH\\src\\a.js", "src/a.js"],
    ["a relative path with backslashes", "src\\enemies\\boss.js", "src/enemies/boss.js"],
    ["a ./ relative path", ".\\src\\a.js", "src/a.js"],
    ["the workspace itself", "C:\\Users\\Ada\\AI Projects\\marsh\\", null],
    ["a sibling folder", "C:\\Users\\Ada\\AI Projects\\other\\src\\a.js", ".."],
    ["a folder whose name extends the workspace's", "C:\\Users\\Ada\\AI Projects\\marsh2\\a.js", ".."],
    ["a climb out through the workspace", "C:\\Users\\Ada\\AI Projects\\marsh\\..\\other\\a.js", ".."],
    ["another drive", "D:\\marsh\\src\\a.js", ".."],
    ["a UNC share", "\\\\server\\share\\marsh\\src\\a.js", ".."],
    ["a drive-relative path", "C:src\\a.js", ".."],
    ["a rooted path on the current drive", "\\Windows\\system32\\drivers\\etc\\hosts", ".."],
    ["a relative climb", "..\\other\\a.js", "../other/a.js"],
  ];
  for (const [name, input, expected] of rows) {
    it(`reads ${name}`, () => {
      assert.equal(relativeProjectPath(input, WINDOWS_CWD, "win32"), expected);
    });
  }
});

describe("relativeProjectPath on macOS keeps its reading", () => {
  const rows: Array<[string, string | null]> = [
    ["/w/marsh/src/a.js", "src/a.js"],
    ["./src/a.js", "src/a.js"],
    ["/w/marsh", null],
    ["/w/marsh2/a.js", ".."],
    ["/elsewhere/x.js", ".."],
    ["src\\a.js", "src\\a.js"],
  ];
  for (const [input, expected] of rows) {
    it(`reads ${input}`, () => {
      assert.equal(relativeProjectPath(input, "/w/marsh", "darwin"), expected);
    });
  }
});

describe("relativeProjectPath on POSIX reads what a climb resolves to (P02-F2)", () => {
  const rows: Array<[string, string, string | null]> = [
    ["a climb out of an owned folder, relative", "src/sky/../../index.html", "index.html"],
    ["a climb out of an owned folder, absolute", "/w/marsh/src/sky/../../index.html", "index.html"],
    ["a climb out of the workspace through it", "/w/marsh/src/../../other/a.js", ".."],
    ["a relative climb out of the workspace", "src/../../other/a.js", "../other/a.js"],
    ["a doubled slash", "/w/marsh//src//a.js", "src/a.js"],
    ["a dot segment", "/w/marsh/./src/./a.js", "src/a.js"],
    ["a climb back into the workspace", "/w/marsh/../marsh/src/a.js", "src/a.js"],
  ];
  for (const [name, input, expected] of rows) {
    it(`reads ${name}`, () => {
      assert.equal(relativeProjectPath(input, "/w/marsh", "darwin"), expected);
    });
  }
});
