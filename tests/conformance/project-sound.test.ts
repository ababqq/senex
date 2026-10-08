/**
 * Project sound (2026-09-28): the user hears only the project on Live, and only while it is on screen,
 * Genex is in front, no agent has the window and the switch is on. Agents' windows are never heard.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { registerPreviewIpc } from "../../src/main/ipc/preview.ts";
import { liveAudible, type LiveSound } from "../../src/main/project-sound.ts";
import type { StudioCore } from "../../src/main/studio-core.ts";
import { storedProjectSound, storeProjectSound } from "../../src/renderer/panels/stage/project-sound.ts";
import type { KeyValueStorage } from "../../src/renderer/storage.ts";
import { type ProjectSoundRequest, isSoundShortcut, type SoundKey } from "../../src/shared/project-sound.ts";
import type { PreviewPort } from "../../src/substrate/preview-port.ts";
import { coreLite } from "../helpers/core-lite.ts";

describe("when Live is heard", () => {
  it("only with the switch on, on screen, in front and not lent to an agent", () => {
    const flags = [false, true];
    for (const on of flags)
      for (const shown of flags)
        for (const foreground of flags)
          for (const lent of flags) {
            const sound: LiveSound = { on, shown, foreground, lent };
            const expected = on && shown && foreground && !lent;
            assert.equal(liveAudible(sound), expected, JSON.stringify(sound));
          }
  });
});

describe("the sound shortcut", () => {
  const key = (code: string, mods: Partial<Omit<SoundKey, "code">> = {}): SoundKey => ({
    code,
    meta: false,
    control: false,
    alt: false,
    shift: false,
    ...mods,
  });
  const cases: Array<[string, SoundKey, boolean]> = [
    ["⌥⌘M", key("KeyM", { meta: true, alt: true }), true],
    ["⌥⌃M where there is no ⌘", key("KeyM", { control: true, alt: true }), true],
    ["⌘M is the window's minimize", key("KeyM", { meta: true }), false],
    ["⌥M types a character", key("KeyM", { alt: true }), false],
    ["⇧⌥⌘M", key("KeyM", { meta: true, alt: true, shift: true }), false],
    ["⌥⌘N", key("KeyN", { meta: true, alt: true }), false],
    ["a bare M", key("KeyM"), false],
  ];
  for (const [name, pressed, expected] of cases)
    it(`${name}: ${expected ? "toggles" : "does nothing"}`, () => assert.equal(isSoundShortcut(pressed), expected));
});

describe("the remembered switch", () => {
  const memory = (): KeyValueStorage & { values: Map<string, string> } => {
    const values = new Map<string, string>();
    return {
      values,
      getItem: (k) => values.get(k) ?? null,
      setItem: (k, v) => void values.set(k, v),
      removeItem: (k) => void values.delete(k),
    };
  };
  it("is on until the user turns it off, and stays off", () => {
    const storage = memory();
    assert.equal(storedProjectSound(storage), true);
    storeProjectSound(false, storage);
    assert.equal(storedProjectSound(storage), false);
    storeProjectSound(true, storage);
    assert.equal(storedProjectSound(storage), true);
  });
  it("reads anything it did not write, or storage that throws, as on", () => {
    const storage = memory();
    storage.values.set("studio.projectSound", "muted?");
    assert.equal(storedProjectSound(storage), true);
    const broken: KeyValueStorage = {
      getItem: () => {
        throw new Error("locked profile");
      },
      setItem: () => {
        throw new Error("full disk");
      },
      removeItem: () => {},
    };
    assert.equal(storedProjectSound(broken), true);
    assert.doesNotThrow(() => storeProjectSound(false, broken));
    assert.equal(storedProjectSound(null), true);
  });
});

/** A Live view that records what the core does to its speakers. */
function recordingLive(): PreviewPort & { muted: boolean[] } {
  const muted: boolean[] = [];
  return {
    muted,
    setAudioMuted: (value: boolean) => void muted.push(value),
    setVisible: () => {},
    setObserved: () => {},
  } as unknown as PreviewPort & { muted: boolean[] };
}

describe("the core applies the switch to Live", () => {
  it("mutes Live whenever any one condition fails, and unmutes when all hold again", async () => {
    const live = recordingLive();
    const { core, close } = await coreLite({ preview: live });
    const now = (): boolean | undefined => live.muted.at(-1);
    try {
      core.previewSound({ on: true });
      assert.equal(now(), false, "on, shown, in front: heard");
      core.previewForeground(false);
      assert.equal(now(), true, "Genex behind another app");
      core.previewForeground(true);
      assert.equal(now(), false);
      await core.previewStageVisible(false);
      assert.equal(now(), true, "Builds or Assets has the stage");
      await core.previewStageVisible(true);
      assert.equal(now(), false);
      core.previewSound({ on: false });
      assert.equal(now(), true, "the user turned it off");
      core.previewSound({ on: true });
      assert.equal(now(), false);
    } finally {
      await close();
    }
  });
});

describe("studio:preview.sound", () => {
  type Listener = (event: IpcSender, payload: unknown) => Promise<IpcResult>;
  function registrar() {
    const listeners = new Map<string, Listener>();
    const requests: ProjectSoundRequest[] = [];
    const core = { previewSound: (request: ProjectSoundRequest) => void requests.push(request) };
    const handle = createIpcHandle(
      { handle: (channel, listener) => void listeners.set(channel, listener) },
      { fixture: false, isStudioUi: () => true },
    );
    registerPreviewIpc(handle, {
      core: core as unknown as StudioCore,
      preview: () => null,
      previewBoundsSeen: { last: null },
    });
    const invoke = (payload: unknown) =>
      listeners.get("studio:preview.sound")!({ sender: "studio", senderFrame: "main-frame" }, payload);
    return { invoke, requests };
  }

  it("turns sound off only for a plain false", async () => {
    const { invoke, requests } = registrar();
    const hostile: Array<[unknown, ProjectSoundRequest]> = [
      [{ on: false }, { on: false }],
      [{ on: true }, { on: true }],
      [undefined, { on: true }],
      [null, { on: true }],
      [{ on: "false" }, { on: true }],
      [{ on: 0 }, { on: true }],
      ["off", { on: true }],
      [{ on: false, borrowed: true, extra: "ignored" }, { on: false }],
    ];
    for (const [payload] of hostile) {
      const result = await invoke(payload);
      assert.equal(result.ok, true, JSON.stringify(payload));
    }
    assert.deepEqual(
      requests,
      hostile.map(([, expected]) => expected),
    );
  });
});
