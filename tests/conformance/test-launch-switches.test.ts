/**
 * The self test and the smoke park their shown window off the visible desktop so capturePage has a
 * real compositor surface without taking over the screen. Windows' native occlusion tracking marks
 * such a window as hidden and stops requestAnimationFrame, so a project in it stood at frame 0 on the
 * Windows runner ("a scaffolded project animates without anyone calling start(): frame 0 -> 0").
 * Test launches on Windows turn occlusion tracking off; a normal launch never changes it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { quitsWhenLastWindowCloses, testLaunchChromiumSwitches } from "../../src/main/dev/launch-flags.ts";

test("a Windows test launch turns off native occlusion tracking for its parked window", () => {
  assert.deepEqual(testLaunchChromiumSwitches({ platform: "win32", testLaunch: true }), [
    ["disable-features", "CalculateNativeWinOcclusion"],
  ]);
});

test("normal launches and other platforms add no Chromium switch", () => {
  assert.deepEqual(testLaunchChromiumSwitches({ platform: "win32", testLaunch: false }), []);
  assert.deepEqual(testLaunchChromiumSwitches({ platform: "darwin", testLaunch: true }), []);
  assert.deepEqual(testLaunchChromiumSwitches({ platform: "linux", testLaunch: true }), []);
});

// Off macOS closing the last window quits the app. The self test destroys its window before it
// prints its report, so on the Windows runner the app went through a normal quit and exited 0
// with no report ("e2e: no report was produced (exit 0)"). A test launch's runner decides when it exits.
test("closing the last window quits a normal launch off macOS, never a test launch", () => {
  assert.equal(quitsWhenLastWindowCloses({ platform: "win32", testLaunch: false }), true);
  assert.equal(quitsWhenLastWindowCloses({ platform: "linux", testLaunch: false }), true);
  assert.equal(quitsWhenLastWindowCloses({ platform: "darwin", testLaunch: false }), false);
  assert.equal(quitsWhenLastWindowCloses({ platform: "win32", testLaunch: true }), false);
  assert.equal(quitsWhenLastWindowCloses({ platform: "linux", testLaunch: true }), false);
});
