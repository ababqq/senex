import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { createYard } from "./world.js";

// Orbit Yard: no player, no keys. The camera is the project — drag to orbit, wheel to zoom — and
// every frame the page draws goes through a composer, never through renderer.render().
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const { scene, camera, update } = createYard();
camera.aspect = window.innerWidth / window.innerHeight;
camera.updateProjectionMatrix();

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.2, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 6;
controls.maxDistance = 30;
controls.update();

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(
  new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.1, 0.5, 0.2),
);
composer.setSize(window.innerWidth, window.innerHeight);

addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

const started = performance.now();
function frame() {
  const elapsed = (performance.now() - started) / 1000;
  update(elapsed);
  controls.update();
  composer.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
