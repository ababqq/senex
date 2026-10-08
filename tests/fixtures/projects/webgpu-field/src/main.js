import * as THREE from "three/webgpu";

// Ion Field: a top-down field of ions you sweep up with the pale ring. The renderer is a
// WebGPU one, its device is awaited at module scope, and the loop is renderer.setAnimationLoop
// with renderAsync inside — three shapes at once that the studio used to assume away.
const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// A TOP-LEVEL await: the page has a canvas, and no frame at all, until the adapter answers.
// Anything that photographs this page on a fixed guess photographs black.
await renderer.init();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x04060b);

const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 300);
camera.position.set(0, 26, 10);
camera.lookAt(0, 0, 0);

scene.add(new THREE.HemisphereLight(0x8ad8ff, 0x050810, 1.7));
const key = new THREE.DirectionalLight(0xffffff, 1.2);
key.position.set(5, 18, 8);
scene.add(key);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(48, 48),
  new THREE.MeshStandardMaterial({ color: 0x0d1826, roughness: 0.95 }),
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

const ions = [];
const ionGeometry = new THREE.SphereGeometry(0.4, 16, 12);
for (let i = 0; i < 24; i += 1) {
  const ion = new THREE.Mesh(
    ionGeometry,
    new THREE.MeshStandardMaterial({ color: 0x9ff0ff, emissive: 0x2ea8d8, emissiveIntensity: 1.4 }),
  );
  const angle = (i / 24) * Math.PI * 2;
  const radius = 4 + (i % 5) * 3;
  ion.position.set(Math.cos(angle) * radius, 0.5, Math.sin(angle) * radius);
  scene.add(ion);
  ions.push(ion);
}

const player = new THREE.Mesh(
  new THREE.TorusGeometry(1, 0.18, 10, 32),
  new THREE.MeshStandardMaterial({ color: 0xf6fbff, emissive: 0x557799, emissiveIntensity: 0.6 }),
);
player.rotation.x = -Math.PI / 2;
player.position.set(0, 0.4, 0);
scene.add(player);

const held = new Set();
addEventListener("keydown", (event) => held.add(event.code));
addEventListener("keyup", (event) => held.delete(event.code));
addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const SPEED = 7;
let previous = performance.now();
let collected = 0;

// setAnimationLoop, not a hand-rolled rAF chain: it rides three's own scheduler, which rides
// the patched requestAnimationFrame, which is the only reason the studio can pace this project.
renderer.setAnimationLoop(async () => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - previous) / 1000);
  previous = now;

  let x = 0;
  let z = 0;
  if (held.has("KeyW") || held.has("ArrowUp")) z -= 1;
  if (held.has("KeyS") || held.has("ArrowDown")) z += 1;
  if (held.has("KeyA") || held.has("ArrowLeft")) x -= 1;
  if (held.has("KeyD") || held.has("ArrowRight")) x += 1;
  if (x !== 0 || z !== 0) {
    const length = Math.hypot(x, z);
    player.position.x = Math.max(-22, Math.min(22, player.position.x + (x / length) * SPEED * dt));
    player.position.z = Math.max(-22, Math.min(22, player.position.z + (z / length) * SPEED * dt));
  }

  for (const ion of ions) {
    if (!ion.visible) continue;
    ion.position.y = 0.5 + Math.sin(now / 400 + ion.position.x) * 0.15;
    if (ion.position.distanceTo(player.position) < 1.4) {
      ion.visible = false;
      collected += 1;
      player.scale.setScalar(1 + collected * 0.01);
    }
  }

  await renderer.renderAsync(scene, camera);
});
