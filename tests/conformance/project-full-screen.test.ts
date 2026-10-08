/**
 * The Live project's full screen: the window goes full screen with the project over all of it and a
 * small exit button in the top-right corner, which folds to its icon after a moment. Holding Esc
 * ends it (a tap still reaches the project), as does the button or the window leaving full screen
 * any other way.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ESC_HOLD_MS,
  EXIT_BUTTON,
  EXIT_FOLDED_AFTER_MS,
  projectFullScreen,
  type Rect,
} from "../../src/main/project-full-screen.ts";

function rig({ windowFull = false } = {}) {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const log: string[] = [];
  const state = {
    windowFull,
    fill: null as Rect | null,
    exit: null as Rect | null,
    focused: false,
  };
  const screen = projectFullScreen({
    window: {
      isFullScreen: () => state.windowFull,
      setFullScreen: (on) => {
        state.windowFull = on;
        log.push(`window ${on ? "full" : "windowed"}`);
      },
      contentSize: () => ({ width: 1440, height: 900 }),
    },
    project: {
      fill: (bounds) => {
        state.fill = bounds;
      },
      focus: () => {
        state.focused = true;
      },
    },
    exitButton: {
      show: (bounds) => {
        state.exit = bounds;
      },
      hide: () => {
        state.exit = null;
      },
    },
    stage: {
      cover: () => log.push("stage covered"),
      restore: () => log.push("stage restored"),
    },
    clock: {
      setTimeout: (fn, ms) => {
        const id = next++;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout: (id) => {
        timers.delete(id as number);
      },
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.fn();
    }
  };
  const esc = (type: "keyDown" | "keyUp", isAutoRepeat = false) => screen.key({ type, key: "Escape", isAutoRepeat });
  return { screen, state, log, advance, esc };
}

const WIDE: Rect = {
  x: 1440 - EXIT_BUTTON.margin - EXIT_BUTTON.wide,
  y: EXIT_BUTTON.margin,
  width: EXIT_BUTTON.wide,
  height: EXIT_BUTTON.height,
};
const FOLDED: Rect = {
  x: 1440 - EXIT_BUTTON.margin - EXIT_BUTTON.height,
  y: EXIT_BUTTON.margin,
  width: EXIT_BUTTON.height,
  height: EXIT_BUTTON.height,
};

describe("the project's full screen", () => {
  it("fills the window with the project and shows the exit button, unfolded, top right", () => {
    const { screen, state, log } = rig();
    screen.enter();
    assert.equal(screen.active(), true);
    assert.equal(state.windowFull, true);
    assert.deepEqual(state.fill, { x: 0, y: 0, width: 1440, height: 900 });
    assert.deepEqual(state.exit, WIDE);
    assert.equal(state.focused, true, "the project has the keyboard, so held Esc reaches main");
    assert.deepEqual(log, ["window full", "stage covered"]);
  });

  it("folds the exit button to its icon at the same right edge after a moment", () => {
    const { screen, state, advance } = rig();
    screen.enter();
    advance(EXIT_FOLDED_AFTER_MS - 1);
    assert.deepEqual(state.exit, WIDE);
    advance(1);
    assert.deepEqual(state.exit, FOLDED);
  });

  it("ends when Esc is held, and a tap is left to the project", () => {
    const { screen, state, log, advance, esc } = rig();
    screen.enter();
    esc("keyDown");
    advance(ESC_HOLD_MS - 1);
    esc("keyUp");
    advance(ESC_HOLD_MS);
    assert.equal(screen.active(), true, "a tap does not end it");
    esc("keyDown");
    advance(ESC_HOLD_MS / 2);
    esc("keyDown", true);
    advance(ESC_HOLD_MS / 2);
    assert.equal(screen.active(), false, "a key's own repeats do not restart the hold");
    assert.equal(state.windowFull, false);
    assert.equal(state.fill, null);
    assert.equal(state.exit, null);
    assert.deepEqual(log.slice(-2), ["stage restored", "window windowed"]);
  });

  it("ends from its button, and leaves a window that was already full screen as it was", () => {
    const { screen, state, log } = rig({ windowFull: true });
    screen.enter();
    screen.exit();
    assert.equal(state.windowFull, true);
    assert.deepEqual(log, ["stage covered", "stage restored"]);
  });

  it("ends when the window leaves full screen on its own", () => {
    const { screen, state, log } = rig();
    screen.enter();
    state.windowFull = false;
    screen.windowLeft();
    assert.equal(screen.active(), false);
    assert.equal(state.fill, null);
    assert.deepEqual(log, ["window full", "stage covered", "stage restored"]);
  });

  it("follows the window's size, ignores Esc when it is not on, and enters once", () => {
    const { screen, state, log, advance, esc } = rig();
    esc("keyDown");
    advance(ESC_HOLD_MS);
    assert.deepEqual(log, []);
    screen.enter();
    screen.enter();
    assert.deepEqual(log, ["window full", "stage covered"]);
    state.fill = null;
    screen.resized();
    assert.deepEqual(state.fill, { x: 0, y: 0, width: 1440, height: 900 });
  });
});
