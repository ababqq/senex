# Two Rooms

Two Rooms is the shape a real project usually has and the studio's template never does: a DOM title
screen with a Start button, a DOM level select with two cards, a DOM HUD, and a menu →
level-select → level state machine that swaps both the scene and the camera when a card is
clicked. Nothing here is drawn into the canvas except the room itself, so the page the player
sees and the picture a canvas capture returns are two different pictures. It ends with one line
of its own — `window.__studio = { state: () => ({ phase, level, player, score }) }` — a page
that assigns the contract object itself and defines exactly one method on it.

Press Start, pick a room, then move with WASD. Escape goes back to the level select.

## What it proves

- A DOM first screen becomes ready instead of hanging boot: the canvas is drawing behind the
  overlay from the first frame, and readiness is not "the menu went away".
- A trusted gesture plus the setup script walks a title screen to the judged state, and `verify`
  says it landed: two placed clicks and `phase === "level"`.
- The page-side eyes see a DOM HUD the canvas capture cannot — the room number and the score are
  in the DOM and nowhere in the frame.
- A scene and camera switch is visible in the evidence, and `inspect().scenes` names two: the
  rooms are two `THREE.Scene`s with two cameras, rendered by one loop, and the level select
  renders both of them side by side into one canvas — two depth-0 renders in a single frame.
- A page that assigns `window.__studio` itself keeps every method it defined. Its `state()` must
  survive under the shim's merging facade, and every method it never defined must still work.

## Shape

`three-modules`, own, entry `index.html`, main `src/main.js`, no build, no package manager, no
`studio.json`. `kind: "graphics"` with `keyboardMove`, and `hud` is left false: this project's HUD is DOM by design
and the template's one-screen checks describe a different project.
