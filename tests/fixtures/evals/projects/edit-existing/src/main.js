// Gem Garden: walk, jump once, collect six gems, press R to play again.
import * as THREE from "three";

const GEM_COUNT = 6;
const MOVE_SPEED = 6;
const JUMP_SPEED = 7;
const GRAVITY = 20;
const PICKUP_RADIUS = 1.1;
const GROUND_SIZE = 40;
const PLAYER_HALF_HEIGHT = 0.6;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87b5e0);
scene.fog = new THREE.Fog(0x87b5e0, 30, 70);
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);

scene.add(new THREE.HemisphereLight(0xffffff, 0x3a5a2a, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(10, 20, 8);
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE),
  new THREE.MeshStandardMaterial({ color: 0x5c9e4a }),
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const player = new THREE.Mesh(
  new THREE.BoxGeometry(0.8, PLAYER_HALF_HEIGHT * 2, 0.8),
  new THREE.MeshStandardMaterial({ color: 0xe07a5f }),
);
scene.add(player);

const gemGeometry = new THREE.OctahedronGeometry(0.4);
const gemMaterial = new THREE.MeshStandardMaterial({ color: 0x4cc9f0, emissive: 0x1b4f72 });
const gems = [];
for (let i = 0; i < GEM_COUNT; i++) {
  const gem = new THREE.Mesh(gemGeometry, gemMaterial);
  const angle = (i / GEM_COUNT) * Math.PI * 2;
  gem.userData.home = new THREE.Vector3(Math.cos(angle) * 9, 0.6, Math.sin(angle) * 9);
  gems.push(gem);
  scene.add(gem);
}

const hud = document.getElementById("hud");
const message = document.getElementById("message");
const keys = new Set();
const state = { velocityY: 0, grounded: true, collected: 0, won: false };

function updateHud() {
  hud.textContent = `Gems ${state.collected} / ${GEM_COUNT}`;
}

function restart() {
  player.position.set(0, PLAYER_HALF_HEIGHT, 0);
  state.velocityY = 0;
  state.grounded = true;
  state.collected = 0;
  state.won = false;
  for (const gem of gems) {
    gem.position.copy(gem.userData.home);
    gem.visible = true;
  }
  message.style.display = "none";
  updateHud();
}

addEventListener("keydown", (event) => {
  keys.add(event.code);
  if (event.code === "Space" && state.grounded && !state.won) {
    state.velocityY = JUMP_SPEED;
    state.grounded = false;
  }
  if (event.code === "KeyR") restart();
});
addEventListener("keyup", (event) => keys.delete(event.code));

const held = (...codes) => codes.some((code) => keys.has(code));

function movePlayer(dt) {
  const input = new THREE.Vector3(
    Number(held("KeyD", "ArrowRight")) - Number(held("KeyA", "ArrowLeft")),
    0,
    Number(held("KeyS", "ArrowDown")) - Number(held("KeyW", "ArrowUp")),
  );
  if (input.lengthSq() > 0) player.position.addScaledVector(input.normalize(), MOVE_SPEED * dt);
  const limit = GROUND_SIZE / 2 - 0.5;
  player.position.x = THREE.MathUtils.clamp(player.position.x, -limit, limit);
  player.position.z = THREE.MathUtils.clamp(player.position.z, -limit, limit);

  state.velocityY -= GRAVITY * dt;
  player.position.y += state.velocityY * dt;
  if (player.position.y <= PLAYER_HALF_HEIGHT) {
    player.position.y = PLAYER_HALF_HEIGHT;
    state.velocityY = 0;
    state.grounded = true;
  }
}

function updateGems(time) {
  for (const gem of gems) {
    if (!gem.visible) continue;
    gem.rotation.y = time * 2;
    gem.position.y = gem.userData.home.y + Math.sin(time * 3) * 0.15;
    if (gem.position.distanceTo(player.position) < PICKUP_RADIUS) {
      gem.visible = false;
      state.collected += 1;
      updateHud();
    }
  }
  if (state.collected === GEM_COUNT && !state.won) {
    state.won = true;
    message.textContent = "All gems collected! Press R to play again";
    message.style.display = "grid";
  }
}

function resize() {
  const width = Math.max(1, innerWidth);
  const height = Math.max(1, innerHeight);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!state.won) movePlayer(dt);
  updateGems(clock.elapsedTime);
  camera.position.set(player.position.x, player.position.y + 7, player.position.z + 10);
  camera.lookAt(player.position);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

restart();
requestAnimationFrame(frame);
