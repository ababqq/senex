/**
 * `dispatchLookDeltasInPage` replayed against a FAKE DOM in a bare `node:vm` context, which also
 * proves the payload names only globals. What is pinned is the SHAPE OF THE GESTURE: a drag-to-look
 * handler reads either `e.buttons & 1` or `clientX - lastX`, and a single shape with no button and
 * frozen coordinates defeats both; under a real lock the old shape must not move. Ported from
 * genex-demo's `prober/test/look-dispatch.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { dispatchLookDeltasInPage } from "../../scripts/evals/prober/start-control.ts";

/** Which part of a four-step drag step `i` is. */
const phaseOf = (i: number) => {
  if (i === 0) return "start";
  return i === 3 ? "end" : "move";
};

type Sent = { type: string; clientX: number; clientY: number; buttons: number; movementX: number; movementY: number };

/**
 * A page with one canvas and, optionally, a lock element. `elementFromPoint`
 * and layout are not modelled: the payload reads `getBoundingClientRect` and
 * `document.querySelectorAll('canvas')`, and nothing else about the tree.
 */
function fakePage(opts: { locked?: boolean; width?: number; height?: number }) {
  const sent: Sent[] = [];
  const width = opts.width ?? 1280;
  const height = opts.height ?? 720;
  const canvas = {
    tagName: "CANVAS",
    width,
    height,
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height, right: width, bottom: height }),
    dispatchEvent: (e: Sent) => {
      sent.push(e);
      return true;
    },
  };
  class FakeEvent {
    constructor(type: string, init: Record<string, unknown>) {
      Object.assign(this, init, { type });
    }
  }
  const document = {
    pointerLockElement: opts.locked ? canvas : null,
    querySelectorAll: (sel: string) => (sel === "canvas" ? [canvas] : []),
  };
  return { sent, globals: { document, PointerEvent: FakeEvent, MouseEvent: FakeEvent } };
}

function inPage<T>(globals: Record<string, unknown>, arg: unknown): T {
  const ctx = vm.createContext({ ...globals, __arg: arg });
  return vm.runInContext(`(${dispatchLookDeltasInPage.toString()})(__arg)`, ctx) as T;
}

/** Only the mouse half — the pointer half carries the identical init. */
const mouseOnly = (sent: Sent[]) => sent.filter((e) => e.type.startsWith("mouse"));

test("NO LOCK: the events go out as a real drag — down, moves with the button held, up", () => {
  const page = fakePage({});
  const out: Array<{ target: string; dispatched: number }> = [];
  const per = 42;
  for (let i = 0; i < 4; i++) {
    out.push(inPage(page.globals, { dx: per, dy: 0, offsetX: per * (i + 1), offsetY: 0, phase: phaseOf(i) }));
  }
  assert.deepEqual(
    out.map((o) => o.target),
    ["canvas", "canvas", "canvas", "canvas"],
  );
  const m = mouseOnly(page.sent);
  assert.deepEqual(
    m.map((e) => e.type),
    ["mousedown", "mousemove", "mousemove", "mousemove", "mousemove", "mouseup"],
  );

  // THE BUTTON. `e.buttons & 1` is one of the two ways the handler is written.
  assert.deepEqual(
    m.filter((e) => e.type === "mousemove").map((e) => e.buttons),
    [1, 1, 1, 1],
  );

  // THE COORDINATE. `clientX - lastX` is the other. Centre is 640; the press
  // lands there and each move advances by `per`.
  assert.equal(m[0]?.clientX, 640, "the press is at the centre, BEFORE the first move");
  assert.deepEqual(
    m.filter((e) => e.type === "mousemove").map((e) => e.clientX),
    [640 + per, 640 + per * 2, 640 + per * 3, 640 + per * 4],
  );

  // And movementX still rides every move, for a handler that reads that instead.
  assert.deepEqual(
    m.filter((e) => e.type === "mousemove").map((e) => e.movementX),
    [per, per, per, per],
  );
  // The release is at the end of the travel and carries no button.
  assert.equal(m[m.length - 1]?.clientX, 640 + per * 4);
  assert.equal(m[m.length - 1]?.buttons, 0);
});

test("LOCKED: byte-for-byte the shape that already works — no press, no button, frozen coordinates", () => {
  // Under a real lock Chromium freezes clientX/clientY and the project reads
  // movementX with no button held. This is the path measured delivering 158°
  // of sweep on the bare village, and it must not move.
  const page = fakePage({ locked: true });
  for (let i = 0; i < 4; i++) {
    const r = inPage<{ target: string; dispatched: number }>(page.globals, {
      dx: 42,
      dy: 0,
      offsetX: 42 * (i + 1),
      offsetY: 0,
      phase: phaseOf(i),
    });
    assert.equal(r.target, "lock");
    assert.equal(r.dispatched, 2, "one pointermove and one mousemove, and nothing else");
  }
  const m = mouseOnly(page.sent);
  assert.deepEqual(
    m.map((e) => e.type),
    ["mousemove", "mousemove", "mousemove", "mousemove"],
  );
  assert.deepEqual(
    m.map((e) => e.buttons),
    [0, 0, 0, 0],
  );
  assert.deepEqual(
    m.map((e) => e.clientX),
    [640, 640, 640, 640],
    "the offset is ignored under a lock",
  );
  assert.deepEqual(
    m.map((e) => e.movementX),
    [42, 42, 42, 42],
  );
});

test("a call with no drag arguments at all is still a valid move — an older caller is not broken", () => {
  const page = fakePage({});
  const r = inPage<{ target: string; dispatched: number }>(page.globals, { dx: 10, dy: -4 });
  assert.equal(r.target, "canvas");
  const m = mouseOnly(page.sent);
  assert.deepEqual(
    m.map((e) => e.type),
    ["mousemove"],
    "no phase means no press and no release",
  );
  assert.equal(m[0]?.clientX, 640, "no offset means the centre");
  assert.equal(m[0]?.movementY, -4);
});

test("no canvas and no lock: nothing is dispatched and it says so", () => {
  const document = { pointerLockElement: null, querySelectorAll: () => [] };
  const ctx = vm.createContext({ document, __arg: { dx: 10, dy: 0, phase: "start" } });
  const r = vm.runInContext(`(${dispatchLookDeltasInPage.toString()})(__arg)`, ctx) as {
    target: string;
    dispatched: number;
  };
  assert.equal(r.target, "none");
  assert.equal(r.dispatched, 0);
});

test("a page with no PointerEvent still gets the mouse half of every event", () => {
  const page = fakePage({});
  const globals = { ...page.globals, PointerEvent: undefined };
  inPage(globals, { dx: 42, dy: 0, offsetX: 42, offsetY: 0, phase: "start" });
  assert.deepEqual(
    page.sent.map((e) => e.type),
    ["mousedown", "mousemove"],
  );
});
