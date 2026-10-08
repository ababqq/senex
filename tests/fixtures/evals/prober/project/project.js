// A synthetic probe fixture: a textured 2D scene behind a PLAY button that hides on click, and a
// player square that moves while a key is held. Nothing is loaded from the network.
const canvas = document.getElementById("project");
const ctx = canvas.getContext("2d");
const held = new Set();
let playing = false;
let x = 320;
let y = 180;

document.getElementById("start").addEventListener("click", () => {
  playing = true;
  document.getElementById("menu").style.display = "none";
});
addEventListener("keydown", (e) => held.add(e.code));
addEventListener("keyup", (e) => held.delete(e.code));

function step() {
  if (playing) {
    if (held.has("KeyW") || held.has("ArrowUp")) y -= 4;
    if (held.has("KeyS")) y += 4;
    if (held.has("KeyA")) x -= 4;
    if (held.has("KeyD")) x += 4;
  }
  for (let ty = 0; ty < 360; ty += 20) {
    for (let tx = 0; tx < 640; tx += 20) {
      const shade = 60 + (((tx + ty) / 20) % 5) * 25;
      ctx.fillStyle = `rgb(${shade}, ${shade + 20}, ${shade + 40})`;
      ctx.fillRect(tx, ty, 20, 20);
    }
  }
  ctx.fillStyle = "#f0c040";
  ctx.fillRect(x - 30, y - 30, 60, 60);
  requestAnimationFrame(step);
}
requestAnimationFrame(step);
