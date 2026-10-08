import * as THREE from "three";

/** One room: its own scene, its own camera, its own player. Two of these exist at once. */
export function buildRoom({ name, floor, accent, from }) {
  const scene = new THREE.Scene();
  scene.name = `room-${name}`;
  scene.background = new THREE.Color(floor).multiplyScalar(0.35);

  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 200);
  camera.name = `camera-${name}`;
  camera.position.set(from[0], from[1], from[2]);
  camera.lookAt(0, 0.8, 0);

  scene.add(new THREE.HemisphereLight(accent, 0x080b12, 1.5));
  const lamp = new THREE.DirectionalLight(0xffffff, 1.1);
  lamp.position.set(4, 9, 5);
  scene.add(lamp);

  const ground = new THREE.Mesh(
    new THREE.BoxGeometry(16, 0.4, 16),
    new THREE.MeshStandardMaterial({ color: floor, roughness: 0.9 }),
  );
  ground.position.y = -0.2;
  scene.add(ground);

  const props = new THREE.Group();
  for (let i = 0; i < 5; i += 1) {
    const angle = (i / 5) * Math.PI * 2;
    const prop = new THREE.Mesh(
      new THREE.ConeGeometry(0.7, 2.2, 6),
      new THREE.MeshStandardMaterial({ color: accent, roughness: 0.5, emissive: accent, emissiveIntensity: 0.25 }),
    );
    prop.position.set(Math.cos(angle) * 5, 1.1, Math.sin(angle) * 5);
    props.add(prop);
  }
  scene.add(props);

  const player = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.4, 1, 6, 12),
    new THREE.MeshStandardMaterial({ color: 0xf2f6ff, roughness: 0.4 }),
  );
  player.name = `player-${name}`;
  player.position.set(0, 0.9, 0);
  scene.add(player);

  function update(elapsed) {
    props.rotation.y = elapsed * 0.25;
    player.rotation.y = elapsed * 0.8;
  }

  return { scene, camera, player, update };
}
