/**
 * Live Loop validation, second pass (2026-10-11): an agent's preview window is hidden and never the
 * OS-focused one, so the page inside it reported no focus and drew no focus ring; the tester then
 * reported "I never saw a focus ring" as a failed defect. The window's page now answers as focused
 * (a DevTools focus emulation), and only for an offscreen agent window, never Live.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CDP_VERSION, CdpMethod, emulatePageFocus, type FocusDebugger } from "../../src/main/preview-focus.ts";

function recorder(options: { attached?: boolean; attachThrows?: boolean; commandRejects?: boolean } = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  let attached = options.attached ?? false;
  const debuggerFake: FocusDebugger = {
    isAttached: () => attached,
    attach: (version) => {
      calls.push(["attach", version]);
      if (options.attachThrows) throw new Error("Debugger is already attached to the target");
      attached = true;
    },
    sendCommand: async (method, params) => {
      calls.push(["sendCommand", method, params]);
      if (options.commandRejects) throw new Error("Target closed");
      return {};
    },
  };
  return { contents: { debugger: debuggerFake }, calls };
}

describe("an agent's preview window answers as focused", () => {
  it("attaches once and turns focus emulation on for an offscreen window", async () => {
    const { contents, calls } = recorder();
    assert.equal(await emulatePageFocus(contents, { offscreen: true }), true);
    assert.deepEqual(calls, [
      ["attach", CDP_VERSION],
      ["sendCommand", CdpMethod.SetFocusEmulationEnabled, { enabled: true }],
    ]);
  });

  it("does not attach twice to a window whose debugger is already attached", async () => {
    const { contents, calls } = recorder({ attached: true });
    assert.equal(await emulatePageFocus(contents, { offscreen: true }), true);
    assert.deepEqual(calls, [["sendCommand", CdpMethod.SetFocusEmulationEnabled, { enabled: true }]]);
  });

  it("never touches the debugger of Live or of a window that says nothing about being offscreen", async () => {
    for (const options of [{}, { offscreen: false }, { offscreen: undefined }]) {
      const { contents, calls } = recorder();
      assert.equal(await emulatePageFocus(contents, options), false, JSON.stringify(options));
      assert.deepEqual(calls, [], "Live keeps the real focus and a debugger of its own for dev control");
    }
  });

  it("leaves the window working, unfocused, when the debugger is not ours or the page is gone", async () => {
    const owned = recorder({ attachThrows: true });
    assert.equal(await emulatePageFocus(owned.contents, { offscreen: true }), false);
    const closed = recorder({ commandRejects: true });
    assert.equal(await emulatePageFocus(closed.contents, { offscreen: true }), false);
    assert.equal(await emulatePageFocus(closed.contents, { offscreen: true }), false, "a second try is still allowed");
  });
});
