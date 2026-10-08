/**
 * Mouse look, the way a bundled first-person project usually writes it: request the pointer lock on
 * a click, and read `movementX`/`movementY` off every `mousemove` while the lock is held. Chromium
 * grants no pointer lock to a hidden window, so `locked` stays false there and the studio's
 * synthetic look has to arrive as plain `mousemove` deltas instead.
 */
export interface Look {
  yaw: number;
  pitch: number;
  locked: boolean;
}

const PITCH_LIMIT = Math.PI / 2 - 0.05;

export function createLook(element: HTMLElement, sensitivity = 0.0022): Look {
  const look: Look = { yaw: 0, pitch: 0, locked: false };

  element.addEventListener("click", () => {
    // A page that never gets the lock must not throw on every click.
    void Promise.resolve(element.requestPointerLock?.()).catch(() => undefined);
  });

  document.addEventListener("pointerlockchange", () => {
    look.locked = document.pointerLockElement === element;
  });

  document.addEventListener("mousemove", (event: MouseEvent) => {
    const dx = event.movementX ?? 0;
    const dy = event.movementY ?? 0;
    if (dx === 0 && dy === 0) return;
    look.yaw -= dx * sensitivity;
    look.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, look.pitch - dy * sensitivity));
  });

  return look;
}
