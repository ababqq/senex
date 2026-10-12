/**
 * The order of native and page-side events one preview input action produces — no window
 * required: the driver acts on a recording target.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyInputAction,
  type InputTarget,
  type NativeInputEvent,
  type PageDispatch,
} from "../../src/main/preview-input-driver.ts";
import type { PreviewInputAction } from "../../src/substrate/preview-input.ts";

type Beat = { native: NativeInputEvent } | { page: PageDispatch } | { step: number };

function recorder(start = { x: 400, y: 300 }): {
  target: InputTarget;
  beats: Beat[];
  at: () => { x: number; y: number };
} {
  const beats: Beat[] = [];
  let pointer = start;
  const target: InputTarget = {
    width: 800,
    height: 600,
    send: (event) => {
      beats.push({ native: event });
    },
    dispatch: async (payload) => {
      beats.push({ page: structuredClone(payload) });
    },
    stepClock: async (ms) => {
      beats.push({ step: ms });
    },
    pointer: () => pointer,
    movePointer: (point) => {
      pointer = point;
    },
  };
  return { target, beats, at: () => pointer };
}

function beatKind(beat: Beat): string {
  if ("native" in beat) return beat.native.type;
  return "page" in beat ? "page" : "step";
}

const nativeTypes = (beats: Beat[]) => beats.flatMap((beat) => ("native" in beat ? [beat.native.type] : []));
const domTypes = (beats: Beat[]) =>
  beats.flatMap((beat) => ("page" in beat ? (beat.page.dom ?? []).map((entry) => String(entry.type)) : []));

async function run(action: PreviewInputAction, start?: { x: number; y: number }) {
  const rec = recorder(start);
  await applyInputAction(rec.target, action);
  return rec;
}

describe("preview input driver", () => {
  it("holds a click's modifiers around the click and carries them on the mouse events", async () => {
    const { beats, at } = await run({ type: "click", x: 100, y: 50, px: true, modifiers: ["shift", "ctrl"] });
    assert.deepEqual(nativeTypes(beats), ["keyDown", "keyDown", "mouseMove", "mouseDown", "mouseUp", "keyUp", "keyUp"]);
    const down = beats.find((beat) => "native" in beat && beat.native.type === "mouseDown");
    assert.ok(down && "native" in down);
    assert.deepEqual((down.native as Electron.MouseInputEvent).modifiers, ["shift", "control"]);
    assert.deepEqual(domTypes(beats), [
      "keydown",
      "keydown",
      "mousemove",
      "mousedown",
      "mouseup",
      "click",
      "keyup",
      "keyup",
    ]);
    assert.deepEqual(at(), { x: 100, y: 50 });
  });

  it("a double click reports detail 1 and 2 and a dblclick after the second release", async () => {
    const { beats } = await run({ type: "click", x: 10, y: 10, px: true, clicks: 2, button: "right" });
    const page = beats.flatMap((beat) => ("page" in beat ? (beat.page.dom ?? []) : []));
    assert.deepEqual(
      page.map((entry) => [entry.type, entry.detail ?? null, entry.buttons ?? null]),
      [
        ["mousemove", null, null],
        ["mousedown", 1, 2],
        ["mouseup", 1, 0],
        ["click", 1, 0],
        ["mousedown", 2, 2],
        ["mouseup", 2, 0],
        ["click", 2, 0],
        ["dblclick", 2, 0],
      ],
    );
  });

  it("a click with stepMs straddles a stepped frame between press and release", async () => {
    const { beats } = await run({ type: "click", x: 5, y: 5, px: true, stepMs: 20 });
    const kinds = beats.map(beatKind);
    assert.deepEqual(kinds, ["mouseMove", "mouseDown", "page", "step", "mouseUp", "page"]);
  });

  it("a tap presses, steps the clock when asked, and releases", async () => {
    const { beats } = await run({ type: "tap", keys: ["w"], stepMs: 33 });
    const kinds = beats.map(beatKind);
    assert.deepEqual(kinds, ["keyDown", "char", "page", "step", "keyUp", "page"]);
    assert.deepEqual(beats[2], {
      page: {
        studio: { down: ["KeyW", "w", "W"] },
        dom: [{ kind: "key", type: "keydown", key: "w", code: "KeyW", keyCode: 87 }],
      },
    });
  });

  it("look moves the pointer by the delta, clamped to the view", async () => {
    const { at } = await run({ type: "look", dx: 1000, dy: -1000 }, { x: 400, y: 300 });
    assert.deepEqual(at(), { x: 799, y: 0 });
  });

  it("a drag glides in six held moves from press to release", async () => {
    const { beats, at } = await run({ type: "drag", fromX: 0, fromY: 0, x: 60, y: 0, px: true });
    assert.deepEqual(nativeTypes(beats), [
      "mouseMove",
      "mouseDown",
      ...Array.from({ length: 6 }, () => "mouseMove"),
      "mouseUp",
    ]);
    assert.deepEqual(at(), { x: 60, y: 0 });
  });

  it("scroll turns the wheel at the pointer, deltas inverted for Chromium and capped", async () => {
    const { beats } = await run({ type: "scroll", dy: 10_000 }, { x: 7, y: 8 });
    assert.deepEqual(beats[0], { native: { type: "mouseWheel", x: 7, y: 8, deltaX: -0, deltaY: -6000 } });
    assert.deepEqual(beats[1], { page: { studio: {}, dom: [{ kind: "wheel", dx: 0, dy: 6000, x: 7, y: 8 }] } });
  });

  // Flipped (live validation, 2026-10-11): Enter used to send no char, so a focused button was never
  // clicked, a form was never submitted and a textarea got no newline from the harness's Return.
  it("types a newline as Enter, with the char Chromium needs to act on it, and Tab as a key alone", async () => {
    const { beats } = await run({ type: "type", text: "a\n\t" });
    assert.deepEqual(nativeTypes(beats), ["keyDown", "char", "keyUp", "keyDown", "char", "keyUp", "keyDown", "keyUp"]);
  });

  const charsOf = (beats: Beat[]) =>
    beats.flatMap((beat) => ("native" in beat && beat.native.type === "char" ? [beat.native.keyCode] : []));

  it("types a space and keeps a capital a capital", async () => {
    const { beats } = await run({ type: "type", text: "Ada Lovelace, 42 (Buy milk)!" });
    assert.deepEqual(charsOf(beats), [
      "A",
      "d",
      "a",
      "Space",
      "L",
      "o",
      "v",
      "e",
      "l",
      "a",
      "c",
      "e",
      ",",
      "Space",
      "4",
      "2",
      "Space",
      "(",
      "B",
      "u",
      "y",
      "Space",
      "m",
      "i",
      "l",
      "k",
      ")",
      "!",
    ]);
  });

  // Live validation, 2026-10-11 (second pass): a tapped "A" arrived as "a".
  it("a tapped, held or pressed capital types a capital; lowercase stays lowercase", async () => {
    assert.deepEqual(charsOf((await run({ type: "tap", keys: ["A"] })).beats), ["A"]);
    assert.deepEqual(charsOf((await run({ type: "tap", keys: ["a"] })).beats), ["a"]);
    assert.deepEqual(charsOf((await run({ type: "down", keys: ["Q"] })).beats), ["Q"]);
    assert.deepEqual(charsOf((await run({ type: "press", combo: "A" })).beats), ["A"]);
    assert.deepEqual(charsOf((await run({ type: "press", combo: "a" })).beats), ["a"]);
  });

  it("shift plus a letter types its capital, and every other shortcut types nothing", async () => {
    for (const combo of ["shift+a", "Shift+A"])
      assert.deepEqual(charsOf((await run({ type: "press", combo })).beats), ["A"], combo);
    for (const combo of ["ctrl+a", "alt+a", "cmd+a", "ctrl+shift+a", "shift", "shift+Tab"])
      assert.deepEqual(charsOf((await run({ type: "press", combo })).beats), [], combo);
  });

  it("a held W is still the w key to a game and a capital W to a text field", async () => {
    const { beats } = await run({ type: "hold", keys: ["W"], ms: 1 });
    assert.deepEqual(charsOf(beats), ["W"]);
    const page = beats.flatMap((beat) => ("page" in beat ? [beat.page] : []));
    assert.deepEqual(page[0]?.dom?.[0], { kind: "key", type: "keydown", key: "w", code: "KeyW", keyCode: 87 });
    assert.deepEqual(page[0]?.studio?.down, ["KeyW", "w", "W"]);
  });

  it("hold_key's code names carry no case, and the modifiers' code names are the modifiers", async () => {
    assert.deepEqual(charsOf((await run({ type: "hold", keys: ["KeyW"], ms: 1 })).beats), ["w"]);
    const { beats } = await run({ type: "hold", keys: ["ShiftLeft", "KeyW"], ms: 1 });
    const down = beats.flatMap((beat) =>
      "native" in beat && beat.native.type === "keyDown" ? [beat.native.keyCode] : [],
    );
    assert.deepEqual(down, ["Shift", "W"]);
  });

  it("a computer-use click's code-named modifiers reach its mouse events", async () => {
    const { beats } = await run({ type: "click", x: 5, y: 5, px: true, modifiers: ["ShiftLeft", "ControlLeft"] });
    const down = beats.find((beat) => "native" in beat && beat.native.type === "mouseDown");
    assert.ok(down && "native" in down);
    assert.deepEqual((down.native as Electron.MouseInputEvent).modifiers, ["shift", "control"]);
  });

  it("presses Enter with its char, so a focused button is clicked and a form submits", async () => {
    const { beats } = await run({ type: "press", combo: "Return" });
    assert.deepEqual(nativeTypes(beats), ["keyDown", "char", "keyUp"]);
    assert.deepEqual(charsOf(beats), ["\r"]);
  });

  it("an action with no keys, or of an unknown type, sends nothing", async () => {
    assert.deepEqual((await run({ type: "down", keys: [] })).beats, []);
    assert.deepEqual((await run({ type: "bogus" } as unknown as PreviewInputAction)).beats, []);
  });
});
