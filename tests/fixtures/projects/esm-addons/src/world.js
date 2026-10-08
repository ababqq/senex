import * as THREE from "three";

/**
 * The yard, built and kept in this module's closure. Nothing is put on `window`, nothing is
 * exported but the builder itself: the studio has to find the scene through the frames the page
 * draws, not through a global somebody remembered to set.
 */
export function createYard() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070d);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
  camera.position.set(9, 7, 12);
  camera.lookAt(0, 1, 0);

  scene.add(new THREE.HemisphereLight(0x8fb8ff, 0x090c14, 1.2));
  const key = new THREE.DirectionalLight(0xffe6bd, 1.5);
  key.position.set(6, 12, 4);
  scene.add(key);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(14, 48),
    new THREE.MeshStandardMaterial({ color: 0x121b28, roughness: 0.9, metalness: 0.1 }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // Bright, small and against a dark floor: exactly the picture a bloom pass changes, so a
  // capture that read the scene before the post pass would be visibly the wrong frame.
  const lamps = [];
  const lampGeometry = new THREE.SphereGeometry(0.42, 20, 16);
  for (let i = 0; i < 8; i += 1) {
    const angle = (i / 8) * Math.PI * 2;
    const lamp = new THREE.Mesh(
      lampGeometry,
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x7fd0ff, emissiveIntensity: 3 }),
    );
    lamp.position.set(Math.cos(angle) * 7, 1.6, Math.sin(angle) * 7);
    scene.add(lamp);
    lamps.push(lamp);
  }

  const pillars = new THREE.Group();
  for (let i = 0; i < 6; i += 1) {
    const angle = (i / 6) * Math.PI * 2 + 0.3;
    const pillar = new THREE.Mesh(
      new THREE.BoxGeometry(1, 3.4, 1),
      new THREE.MeshStandardMaterial({ color: 0x2b3a4e, roughness: 0.7 }),
    );
    pillar.position.set(Math.cos(angle) * 4, 1.7, Math.sin(angle) * 4);
    pillars.add(pillar);
  }
  scene.add(pillars);

  function update(elapsed) {
    pillars.rotation.y = elapsed * 0.12;
    for (let i = 0; i < lamps.length; i += 1) {
      lamps[i].position.y = 1.6 + Math.sin(elapsed * 1.3 + i) * 0.35;
    }
  }

  return { scene, camera, update };
}
