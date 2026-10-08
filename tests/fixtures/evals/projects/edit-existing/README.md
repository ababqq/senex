# Gem Garden

A small hand-made Three.js project that is the starting folder of the `edit-existing` eval case: every
lane gets a copy of this folder and the same brief, so the case measures adding a mechanic to
working code without breaking it. It is synthetic, has no studio scaffold and needs no network:
`three` resolves through the import map to the copy the studio serves under `/vendor/`.

## What already works (the regression surface)

- WASD or the arrow keys move the player; the camera follows.
- Space jumps, once, from the ground.
- Six gems spin on the ground; walking into one collects it and the counter goes up.
- Collecting all six shows a win message; R restarts the round.
