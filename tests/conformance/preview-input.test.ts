/**
 * Key/click mapping for preview HID — no window required.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  capActions,
  chordChar,
  clampHoldMs,
  keyChar,
  ModifierName,
  modifierOf,
  modifiersOf,
  mouseButton,
  normalizeKey,
  normalizeKeys,
  pointInView,
  studioAliases,
  typedChar,
} from "../../src/substrate/preview-input.ts";

/** The normalized key a test names; a name the mapping does not know fails the test. */
function keyNamed(name: string) {
  const key = normalizeKey(name);
  assert.ok(key, name);
  return key;
}

describe("preview input mapping", () => {
  it("keeps the key's own letter in key and the typed case in char", () => {
    const capital = normalizeKey("A");
    const lower = normalizeKey("a");
    const named = normalizeKey("KeyA");
    assert.ok(capital && lower && named);
    assert.deepEqual([capital.key, capital.code, capital.keyCode], ["a", "KeyA", "A"]);
    assert.equal(keyChar(capital), "A");
    assert.equal(keyChar(lower), "a");
    assert.equal(keyChar(named), "a", "a code name names the key; it carries no capital");
  });

  it("types a letter, its capital under shift, and nothing for a shortcut", () => {
    const [shift, ctrl, a, capital, one, enter] = ["shift", "ctrl", "a", "A", "1", "Return"].map((k) =>
      normalizeKey(k),
    );
    assert.ok(shift && ctrl && a && capital && one && enter);
    assert.equal(chordChar([], capital), "A");
    assert.equal(chordChar([shift], a), "A");
    assert.equal(chordChar([ctrl], a), null);
    assert.equal(chordChar([shift, ctrl], a), null);
    assert.equal(chordChar([], enter), "Enter");
    assert.equal(chordChar([shift], one), null, "a shifted digit needs a layout; it types nothing, as before");
    assert.equal(chordChar([], null), null);
  });

  it("names the modifiers a set of keys holds, once each, in the order they went down", () => {
    const keys = normalizeKeys(["ctrl", "w", "Shift", "ControlLeft", "option", "cmd"]);
    assert.deepEqual(modifiersOf(keys), [
      ModifierName.Control,
      ModifierName.Shift,
      ModifierName.Alt,
      ModifierName.Meta,
    ]);
    assert.equal(modifierOf(keyNamed("w")), null);
    assert.equal(modifierOf(keyNamed("Return")), null);
    assert.equal(modifierOf(keyNamed("super")), ModifierName.Meta);
    assert.deepEqual(modifiersOf([]), []);
  });

  it("types what a keyboard types with these modifiers held", () => {
    const key = keyNamed;
    const { Shift, Control, Alt, Meta } = ModifierName;
    assert.equal(typedChar([], key("a")), "a");
    assert.equal(typedChar([Shift], key("a")), "A");
    assert.equal(typedChar([Shift], key("Return")), "Enter", "shift+Return breaks a line in a text area");
    assert.equal(typedChar([Shift], key("space")), " ");
    assert.equal(typedChar([Shift], key("Tab")), null, "a key that types nothing still types nothing");
    assert.equal(typedChar([Shift], key("1")), null, "a shifted digit needs a layout; it types nothing, as before");
    for (const held of [[Control], [Alt], [Meta], [Shift, Control], [Control, Shift]]) {
      for (const name of ["a", "Return", "space"])
        assert.equal(typedChar(held, key(name)), null, `${held.join("+")}+${name} is a shortcut`);
    }
    assert.equal(typedChar([Shift], null), null);
  });

  it("maps WASD and aliases onto Electron + KeyboardEvent codes", () => {
    const w = normalizeKey("w");
    assert.equal(w?.keyCode, "W");
    assert.equal(w?.code, "KeyW");
    assert.equal(w?.key, "w");
    assert.equal(normalizeKey("KeyW")?.code, "KeyW");
    assert.equal(normalizeKey("space")?.code, "Space");
    assert.equal(normalizeKey(" ")?.code, "Space", "a typed space is the Space key, not an empty one");
    assert.equal(normalizeKey(" ")?.printable, true);
    assert.equal(normalizeKey("Enter")?.printable, true, "Enter carries a char, or Chromium never acts on it");
    assert.equal(normalizeKey("arrowup")?.keyCode, "Up");
    assert.equal(normalizeKey("Shift")?.code, "ShiftLeft");
  });

  it("dedupes chords and caps the set", () => {
    const keys = normalizeKeys(["w", "w", "KeyW", "a"]);
    assert.deepEqual(
      keys.map((k) => k.code),
      ["KeyW", "KeyA"],
    );
  });

  it("treats 0–1 pairs as a fraction of the view", () => {
    assert.deepEqual(pointInView(0.5, 0.5, 800, 600), { x: 400, y: 300 });
    assert.deepEqual(pointInView(undefined, undefined, 800, 600), { x: 400, y: 300 });
    assert.deepEqual(pointInView(10, 20, 800, 600), { x: 10, y: 20 });
  });

  it("caps a runaway script", () => {
    const actions = Array.from({ length: 80 }, () => ({ type: "tap" as const, keys: ["w"] }));
    assert.equal(capActions(actions).length, 24);
    assert.equal(clampHoldMs(99_000), 8_000);
    assert.equal(mouseButton("right").index, 2);
  });

  it("lists every alias the studio contract should remember", () => {
    const aliases = studioAliases(normalizeKeys(["w"]));
    assert.ok(aliases.includes("KeyW"));
    assert.ok(aliases.includes("w"));
    assert.ok(aliases.includes("W"));
  });
});
