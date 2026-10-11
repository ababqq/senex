/**
 * Key/click mapping for preview HID — no window required.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  capActions,
  clampHoldMs,
  mouseButton,
  normalizeKey,
  normalizeKeys,
  pointInView,
  studioAliases,
} from "../../src/substrate/preview-input.ts";

describe("preview input mapping", () => {
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
