import * as THREE from "three";
import { buildRoom } from "./rooms.js";

// Two Rooms: a title screen, a level select, and two rooms that are two different scenes with
// two different cameras. The UI is DOM, the state machine is ordinary click listeners, and the
// only thing this page does for the studio is put its own state() on window.__studio.
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const rooms = {
  1: buildRoom({ name: "blue", floor: 0x1d2f45, accent: 0x6fc3ff, from: [0, 6, 11] }),
  2: buildRoom({ name: "amber", floor: 0x3a2a18, accent: 0xffbe5c, from: [7, 5, 7] }),
};

const titleScreen = document.getElementById("title");
const levelScreen = document.getElementById("levels");
const hud = document.getElementById("hud");
const hudLevel = document.getElementById("hud-level");
const hudScore = document.getElementById("hud-score");

let phase = "title";
let level = 0;
let score = 0;

function show() {
  titleScreen.hidden = phase !== "title";
  levelScreen.hidden = phase !== "levels";
  hud.hidden = phase !== "level";
  hudLevel.textContent = level ? String(level) : "-";
  hudScore.textContent = String(score);
}
show();

document.getElementById("start").addEventListener("click", () => {
  phase = "levels";
  show();
});

for (const card of document.querySelectorAll(".card")) {
  card.addEventListener("click", () => {
    level = Number(card.dataset.level);
    phase = "level";
    score = 0;
    show();
  });
}

const held = new Set();
addEventListener("keydown", (event) => {
  if (event.code === "Escape" && phase === "level") {
    phase = "levels";
    show();
    return;
  }
  held.add(event.code);
});
addEventListener("keyup", (event) => held.delete(event.code));

addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  for (const room of Object.values(rooms)) {
    room.camera.aspect = window.innerWidth / window.innerHeight;
    room.camera.updateProjectionMatrix();
  }
});

const SPEED = 4.5;
const started = performance.now();
let previous = started;

function frame() {
  const now = performance.now();
  const elapsed = (now - started) / 1000;
  const dt = Math.min(0.05, (now - previous) / 1000);
  previous = now;

  // The menu renders room 1 behind the overlay so the page is never a black rectangle; the
  // played room is whichever card was clicked. One loop, two scenes, two cameras.
  const room = rooms[level] ?? rooms[1];
  if (phase === "level") {
    let x = 0;
    let z = 0;
    if (held.has("KeyW") || held.has("ArrowUp")) z -= 1;
    if (held.has("KeyS") || held.has("ArrowDown")) z += 1;
    if (held.has("KeyA") || held.has("ArrowLeft")) x -= 1;
    if (held.has("KeyD") || held.has("ArrowRight")) x += 1;
    if (x !== 0 || z !== 0) {
      const length = Math.hypot(x, z);
      room.player.position.x = Math.max(-7, Math.min(7, room.player.position.x + (x / length) * SPEED * dt));
      room.player.position.z = Math.max(-7, Math.min(7, room.player.position.z + (z / length) * SPEED * dt));
      score = Math.round(elapsed * 10);
      show();
    }
  }

  const width = window.innerWidth;
  const height = window.innerHeight;
  for (const each of Object.values(rooms)) each.update(elapsed);

  if (phase === "levels") {
    // The level select shows both rooms behind its cards, so this frame renders two scenes
    // through two cameras — one draw each, side by side, scissored into half the canvas.
    renderer.setScissorTest(true);
    const half = Math.floor(width / 2);
    const halves = [rooms[1], rooms[2]];
    for (let i = 0; i < halves.length; i += 1) {
      renderer.setViewport(i * half, 0, half, height);
      renderer.setScissor(i * half, 0, half, height);
      halves[i].camera.aspect = half / height;
      halves[i].camera.updateProjectionMatrix();
      renderer.render(halves[i].scene, halves[i].camera);
    }
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, width, height);
  } else {
    room.camera.aspect = width / height;
    room.camera.updateProjectionMatrix();
    renderer.render(room.scene, room.camera);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// The page's own contract, assigned last and defining exactly one method. Under the studio's
// merging facade this state() must survive and every method it did not define must still work.
window.__studio = {
  state: () => ({
    phase,
    level,
    score,
    player: {
      x: (rooms[level] ?? rooms[1]).player.position.x,
      y: (rooms[level] ?? rooms[1]).player.position.y,
      z: (rooms[level] ?? rooms[1]).player.position.z,
      yaw: 0,
    },
  }),
};
