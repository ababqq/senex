/**
 * What a project page may ask the browser for. A page the studio shows gets no camera, no microphone and no
 * way to read the person's clipboard; it gets the few things an app's own controls need, so the "copy" button
 * of a project does what it says in the window the person sits at and in the window an agent drives.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PagePermission, previewPermissionAllowed } from "../../src/main/preview-permissions.ts";

describe("what a project page may ask for", () => {
  it("lets a page copy to the clipboard, in Live and in an agent's window", () => {
    assert.equal(previewPermissionAllowed(PagePermission.ClipboardWrite, false), true);
    assert.equal(previewPermissionAllowed(PagePermission.ClipboardWrite, true), true);
  });

  it("never lets a page read the clipboard, whatever it is told it may do", () => {
    for (const offscreen of [false, true]) {
      assert.equal(previewPermissionAllowed("clipboard-read", offscreen), false);
    }
  });

  it("keeps pointer lock for both windows and fullscreen for the one a person sits at", () => {
    assert.equal(previewPermissionAllowed(PagePermission.PointerLock, false), true);
    assert.equal(previewPermissionAllowed(PagePermission.PointerLock, true), true);
    assert.equal(previewPermissionAllowed(PagePermission.Fullscreen, false), true);
    assert.equal(previewPermissionAllowed(PagePermission.Fullscreen, true), false);
  });

  it("denies everything else a browser can be asked for", () => {
    const others = [
      "media",
      "geolocation",
      "notifications",
      "midi",
      "midiSysex",
      "openExternal",
      "display-capture",
      "clipboard-read",
      "idle-detection",
      "hid",
      "serial",
      "usb",
      "keyboardLock",
      "window-management",
      "",
      "pointerlock",
      "CLIPBOARD-SANITIZED-WRITE",
    ];
    for (const offscreen of [false, true]) {
      for (const permission of others) {
        assert.equal(previewPermissionAllowed(permission, offscreen), false, permission);
      }
    }
  });
});
