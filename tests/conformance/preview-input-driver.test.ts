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
import { type ModifierName, type PreviewInputAction } from "../../src/substrate/preview-input.ts";

type Beat = { native: NativeInputEvent } | { page: PageDispatch } | { step: number };

function recorder(start = { x: 400, y: 300 }): {
  target: InputTarget;
  beats: Beat[];
  at: () => { x: number; y: number };
  held: Set<ModifierName>;
} {
  const beats: Beat[] = [];
  const held = new Set<ModifierName>();
  let pointer = start;
  const target: InputTarget = {
    width: 800,
    height: 600,
    held,
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
  return { target, beats, at: () => pointer, held };
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

/** Several actions on one target, as a play script gives them: what is held stays held between them. */
async function runAll(actions: PreviewInputAction[]) {
  const rec = recorder();
  for (const action of actions) await applyInputAction(rec.target, action);
  return rec;
}

/** Every native key event as [type, keyCode, modifiers it carries], in the order it was sent. */
const keyEvents = (beats: Beat[]) =>
  beats.flatMap((beat) => {
    if (!("native" in beat)) return [];
    const event = beat.native;
    if (event.type !== "keyDown" && event.type !== "char" && event.type !== "keyUp") return [];
    return [[event.type, event.keyCode, event.modifiers ?? []]];
  });

/** Every page-side key copy as [type, key, modifiers it carries], in the order it was dispatched. */
const keyCopies = (beats: Beat[]) =>
  beats.flatMap((beat) =>
    "page" in beat
      ? (beat.page.dom ?? []).flatMap((entry) =>
          entry.kind === "key" ? [[entry.type, entry.key, entry.modifiers ?? []]] : [],
        )
      : [],
  );

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

  it("types a character outside the first plane, a Hangul syllable and Unicode spaces, each as one stroke", async () => {
    const text = "a😀가\u00a0\u3000";
    const { beats } = await run({ type: "type", text });
    assert.deepEqual(charsOf(beats), ["a", "😀", "가", "\u00a0", "\u3000"]);
    assert.deepEqual(
      nativeTypes(beats),
      Array.from(text).flatMap(() => ["keyDown", "char", "keyUp"]),
    );
    assert.deepEqual(
      keyCopies(beats)
        .filter(([type]) => type === "keydown")
        .map(([, key]) => key),
      Array.from(text),
    );
  });

  it("skips half of a surrogate pair instead of sending Chromium a broken character", async () => {
    const { beats } = await run({ type: "type", text: "a\ud83db" });
    assert.deepEqual(charsOf(beats), ["a", "b"]);
  });

  it("an action with no keys, or of an unknown type, sends nothing", async () => {
    assert.deepEqual((await run({ type: "down", keys: [] })).beats, []);
    assert.deepEqual((await run({ type: "bogus" } as unknown as PreviewInputAction)).beats, []);
  });

  describe("the modifiers a chord holds", () => {
    it("carries ctrl on the S it strikes and on its own key, and drops it as it lets go", async () => {
      const { beats } = await run({ type: "press", combo: "ctrl+s" });
      assert.deepEqual(keyEvents(beats), [
        ["keyDown", "Control", ["control"]],
        ["keyDown", "S", ["control"]],
        ["keyUp", "S", ["control"]],
        ["keyUp", "Control", []],
      ]);
      assert.deepEqual(keyCopies(beats), [
        ["keydown", "Control", ["control"]],
        ["keydown", "s", ["control"]],
        ["keyup", "s", ["control"]],
        ["keyup", "Control", []],
      ]);
    });

    it("adds each modifier as it goes down and takes them off in the reverse order", async () => {
      const { beats } = await run({ type: "press", combo: "ctrl+shift+s" });
      assert.deepEqual(keyEvents(beats), [
        ["keyDown", "Control", ["control"]],
        ["keyDown", "Shift", ["control", "shift"]],
        ["keyDown", "S", ["control", "shift"]],
        ["keyUp", "S", ["control", "shift"]],
        ["keyUp", "Shift", ["control"]],
        ["keyUp", "Control", []],
      ]);
      assert.deepEqual(
        keyCopies(beats).map(([type, key]) => `${type} ${key}`),
        ["keydown Control", "keydown Shift", "keydown s", "keyup s", "keyup Shift", "keyup Control"],
        "the page hears them in the order Chromium does",
      );
    });

    it("sends a key with nothing held exactly as it did before: no modifiers at all", async () => {
      const { beats } = await run({ type: "tap", keys: ["w"] });
      assert.deepEqual(
        beats.flatMap((beat) => ("native" in beat ? [Object.keys(beat.native)] : [])),
        [
          ["type", "keyCode"],
          ["type", "keyCode"],
          ["type", "keyCode"],
        ],
      );
      assert.deepEqual(keyCopies(beats), [
        ["keydown", "w", []],
        ["keyup", "w", []],
      ]);
    });

    it("types a newline for shift+Return, and the space of shift+space, with shift on them", async () => {
      const enter = (await run({ type: "press", combo: "shift+Return" })).beats;
      assert.deepEqual(keyEvents(enter), [
        ["keyDown", "Shift", ["shift"]],
        ["keyDown", "Enter", ["shift"]],
        ["char", "\r", ["shift"]],
        ["keyUp", "Enter", ["shift"]],
        ["keyUp", "Shift", []],
      ]);
      const space = (await run({ type: "press", combo: "shift+space" })).beats;
      assert.deepEqual(
        keyEvents(space).filter(([type]) => type === "char"),
        [["char", "Space", ["shift"]]],
      );
    });

    it("types nothing for ctrl+Return, a shortcut, but still sends the key with ctrl on it", async () => {
      const { beats } = await run({ type: "press", combo: "ctrl+Return" });
      assert.deepEqual(
        keyEvents(beats).map(([type]) => type),
        ["keyDown", "keyDown", "keyUp", "keyUp"],
      );
      assert.deepEqual(keyEvents(beats)[1], ["keyDown", "Enter", ["control"]]);
    });

    it("lets a held key combine with the next one: down shift, tap a, up shift", async () => {
      const { beats, held } = await runAll([
        { type: "down", keys: ["shift"] },
        { type: "tap", keys: ["a"] },
        { type: "up", keys: ["shift"] },
        { type: "tap", keys: ["a"] },
      ]);
      assert.deepEqual(keyEvents(beats), [
        ["keyDown", "Shift", ["shift"]],
        ["keyDown", "A", ["shift"]],
        ["char", "A", ["shift"]],
        ["keyUp", "A", ["shift"]],
        ["keyUp", "Shift", []],
        ["keyDown", "A", []],
        ["char", "a", []],
        ["keyUp", "A", []],
      ]);
      assert.equal(held.size, 0, "nothing is left held once every key was let go");
    });

    it("types no character for a held ctrl+a, and the capital for a held shift+w", async () => {
      const ctrlA = await run({ type: "hold", keys: ["ctrl", "a"], ms: 1 });
      assert.deepEqual(
        keyEvents(ctrlA.beats).filter(([type]) => type === "char"),
        [],
      );
      const shiftW = await run({ type: "hold", keys: ["ShiftLeft", "KeyW"], ms: 1 });
      assert.deepEqual(
        keyEvents(shiftW.beats).filter(([type]) => type === "char"),
        [["char", "W", ["shift"]]],
      );
    });

    it("carries a held modifier on the mouse and the wheel as well as on keys", async () => {
      const { beats } = await runAll([
        { type: "down", keys: ["ctrl"] },
        { type: "click", x: 5, y: 5, px: true },
        { type: "scroll", dy: 100 },
      ]);
      const mouse = beats.flatMap((beat) =>
        "native" in beat &&
        beat.native.type !== "keyDown" &&
        beat.native.type !== "keyUp" &&
        beat.native.type !== "char"
          ? [[beat.native.type, (beat.native as Electron.MouseInputEvent).modifiers ?? []]]
          : [],
      );
      assert.deepEqual(mouse, [
        ["mouseMove", ["control"]],
        ["mouseDown", ["control"]],
        ["mouseUp", ["control"]],
        ["mouseWheel", ["control"]],
      ]);
      const copies = beats.flatMap((beat) => ("page" in beat ? (beat.page.dom ?? []) : []));
      const wheel = copies.find((entry) => entry.kind === "wheel");
      assert.deepEqual(wheel?.modifiers, ["control"]);
      const click = copies.find((entry) => entry.type === "click");
      assert.deepEqual(click?.modifiers, ["control"], "a ctrl-click's page copy says ctrl");
    });

    it("presses a click's own modifiers only when they are not already held, and lets go of just those", async () => {
      const { beats, held } = await runAll([
        { type: "down", keys: ["shift"] },
        { type: "click", x: 5, y: 5, px: true, modifiers: ["shift", "ctrl"] },
      ]);
      const keys = keyEvents(beats);
      assert.deepEqual(
        keys.map(([type, key]) => `${type} ${key}`),
        ["keyDown Shift", "keyDown Control", "keyUp Control"],
        "shift was already down: it is not pressed again, and the click does not let it go",
      );
      assert.deepEqual([...held], ["shift"]);
      const down = beats.find((beat) => "native" in beat && beat.native.type === "mouseDown");
      assert.ok(down && "native" in down);
      assert.deepEqual((down.native as Electron.MouseInputEvent).modifiers, ["shift", "control"]);
    });

    it("keeps modifiers off a drag's glide when none is held, and puts a held one on it", async () => {
      const bare = await run({ type: "drag", fromX: 0, fromY: 0, x: 60, y: 0, px: true });
      for (const beat of bare.beats) assert.ok(!("native" in beat) || !("modifiers" in beat.native));
      const held = await runAll([
        { type: "down", keys: ["alt"] },
        { type: "drag", fromX: 0, fromY: 0, x: 60, y: 0, px: true },
      ]);
      const mouse = held.beats.flatMap((beat) =>
        "native" in beat && beat.native.type.startsWith("mouse")
          ? [(beat.native as Electron.MouseInputEvent).modifiers ?? []]
          : [],
      );
      assert.ok(mouse.length > 0 && mouse.every((modifiers) => modifiers.join() === "alt"), JSON.stringify(mouse));
    });
  });
});
