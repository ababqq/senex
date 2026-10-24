/**
 * An agent's hidden window has nobody to click a browser dialog: an `alert`, `confirm`, `prompt` or
 * `window.print` froze the page for ever and with it the judge or builder driving it. The shim
 * answers them in that window (and only there): the dialog is dismissed the way a person who
 * pressed Cancel would, the console says which one it was, and a page that opens them in a loop
 * does not push its own output out of the console.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import vm from "node:vm";
import * as esbuild from "esbuild";
import { installDialogAnswers, MAX_DIALOG_NOTES } from "../../src/page/dialogs.ts";

/** A page whose native dialogs would block: calling one is the failure. */
function page() {
  const notes: string[] = [];
  const blocked = (name: string) => () => {
    throw new Error(`native ${name}() would have frozen the page`);
  };
  const win: Record<string, unknown> = {
    alert: blocked("alert"),
    confirm: blocked("confirm"),
    prompt: blocked("prompt"),
    print: blocked("print"),
  };
  installDialogAnswers(win, (line) => notes.push(line));
  const call = (name: string, ...args: unknown[]) => (win[name] as (...a: unknown[]) => unknown)(...args);
  return { win, notes, call };
}

describe("the dialogs an agent's window answers by itself", () => {
  it("dismisses an alert, answers a confirm no, cancels a prompt and does nothing for print", () => {
    const { call } = page();
    assert.equal(call("alert", "Saved!"), undefined);
    assert.equal(call("confirm", "Delete everything?"), false);
    assert.equal(call("prompt", "Your name?", "Ada"), null, "a default value is not an answer");
    assert.equal(call("print"), undefined);
  });

  it("says on the console which dialog it was and what it said", () => {
    const { call, notes } = page();
    call("alert", "Saved!");
    call("confirm", "Delete everything?");
    call("prompt", "Your name?");
    call("print");
    assert.equal(notes.length, 4);
    assert.match(notes[0] ?? "", /alert/);
    assert.match(notes[0] ?? "", /Saved!/);
    assert.match(notes[1] ?? "", /confirm/);
    assert.match(notes[1] ?? "", /Delete everything\?/);
    assert.match(notes[1] ?? "", /\bno\b/i, "the answer it gave");
    assert.match(notes[2] ?? "", /prompt/);
    assert.match(notes[3] ?? "", /print/);
  });

  it("works when the page keeps the function and calls it on its own, as a bundle does", () => {
    const { win } = page();
    const { confirm } = win as { confirm: (message?: string) => boolean };
    assert.equal(confirm("Sure?"), false);
  });

  it("writes what a page chose to say as one short line of plain text", () => {
    const { call, notes } = page();
    call("alert", `first\nsecond\u0000${"x".repeat(500)}`);
    const line = notes[0] ?? "";
    assert.ok(
      [...line].every((ch) => ch.charCodeAt(0) > 0x1f),
      JSON.stringify(line),
    );
    assert.ok(line.length < 200, `${line.length} characters`);
    call("alert");
    call("alert", { toString: () => "an object" });
    call("alert", Symbol("a symbol"));
    assert.equal(notes.length, 4, "an odd argument is still one answered dialog");
  });

  it("names the first few dialogs, then says once that there were more, and answers them all", () => {
    const { call, notes } = page();
    for (let i = 0; i < 10_000; i++) assert.equal(call("confirm", `question ${i}`), false);
    assert.equal(notes.length, MAX_DIALOG_NOTES + 1);
    assert.match(notes.at(-1) ?? "", /more/i);
    assert.match(notes[0] ?? "", /question 0/);
  });

  it("installs all four on a window that had none of them, as a bare frame is", () => {
    const notes: string[] = [];
    const win: Record<string, unknown> = {};
    installDialogAnswers(win, (line) => notes.push(line));
    assert.deepEqual(Object.keys(win).sort(), ["alert", "confirm", "print", "prompt"]);
  });

  it("survives a page whose dialog functions cannot be replaced", () => {
    const notes: string[] = [];
    const win: Record<string, unknown> = {};
    Object.defineProperty(win, "alert", { value: () => "native", writable: false, configurable: false });
    assert.doesNotThrow(() => installDialogAnswers(win, (line) => notes.push(line)));
    assert.equal(typeof win.confirm, "function", "the others are still answered");
  });
});

describe("the shim bundle a project page is served", () => {
  const root = path.resolve(import.meta.dirname, "../..");

  /** The page bundle as scripts/build.mjs makes it (`src/page/entry.ts`, a classic script). */
  async function bundle(): Promise<string> {
    const built = await esbuild.build({
      entryPoints: [path.join(root, "src/page/entry.ts")],
      bundle: true,
      write: false,
      platform: "browser",
      target: "es2022",
      format: "iife",
      external: ["/vendor/studio/hook.js"],
      logLevel: "silent",
    });
    return built.outputFiles[0]?.text ?? "";
  }

  /** A bare page whose native dialogs would block, running the bundle with the options its tag carries. */
  function run(code: string, optionsAttribute: string | null) {
    const warnings: string[] = [];
    const native = (): never => {
      throw new Error("a native dialog would have frozen the window");
    };
    const page: Record<string, unknown> = {
      alert: native,
      confirm: native,
      prompt: native,
      print: native,
      console: { warn: (line: string) => warnings.push(line), log() {}, error() {}, info() {}, debug() {} },
      setTimeout: () => 0,
      setInterval: () => 0,
      clearTimeout() {},
      clearInterval() {},
      document: {
        currentScript: { getAttribute: (name: string) => (name === "data-studio-options" ? optionsAttribute : null) },
        querySelector: () => null,
        addEventListener() {},
        createElement: () => ({}),
        readyState: "loading",
      },
    };
    page.window = page;
    page.self = page;
    page.globalThis = page;
    vm.runInContext(code, vm.createContext(page));
    return { page, warnings, native };
  }

  it("answers the page's dialogs when its tag says nobody is there, and says so on the console", async () => {
    const { page, warnings } = run(await bundle(), JSON.stringify({ dialogs: "answer" }));
    assert.equal((page.confirm as (m: string) => boolean)("Delete?"), false);
    assert.equal((page.prompt as (m: string) => string | null)("Name?"), null);
    assert.equal(warnings.length, 2);
  });

  it("leaves the page's dialogs alone when its tag does not say so: a person is there", async () => {
    const code = await bundle();
    for (const attribute of [null, "{}", JSON.stringify({ seed: null }), JSON.stringify({ dialogs: "ask" })]) {
      const { page, native, warnings } = run(code, attribute);
      assert.equal(page.confirm, native, String(attribute));
      assert.deepEqual(warnings, []);
    }
  });
});
