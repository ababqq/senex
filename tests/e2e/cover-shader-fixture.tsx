import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectAvatar } from "../../src/renderer/ui/ProjectAvatar.tsx";
import type { ProjectCover } from "../../src/shared/project-library.ts";
import { COVER_LOOKS, OrbFamily } from "../../src/shared/cover-recipe.ts";
import { createCoverPainter } from "../../src/shared/cover-painter.ts";
import { coverFragment, COVER_VERTEX } from "../../src/shared/cover-shader.ts";
declare global {
  interface Window {
    coverFixture: {
      covers: ProjectCover[];
      unmount: () => void;
      remount: () => void;
      setCover: (row: number, cover: ProjectCover) => void;
      legacySurface: string;
    };
  }
}
const legacySurface =
  "float bend=sin(p.x*2.0+time*0.42)*0.7+sin(p.y*1.7-time*0.5)*0.35; float wave=sin(p.y*2.7-p.x*1.4+bend+time*0.6); vec3 color=mix(vec3(0.15,0.06,0.31),vec3(0.52,0.39,0.76),smoothstep(-0.7,0.5,wave)); return mix(color,vec3(0.8,0.76,0.94),smoothstep(0.5,1.0,wave)*0.85);";
const fallback = new URLSearchParams(location.search).has("fallback");
// The runner loses every GPU context it created to prove held frames survive; ?fallback has none.
const original = HTMLCanvasElement.prototype.getContext;
(window as unknown as { __gl: WebGLRenderingContext[] }).__gl = [];
HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: any[]) {
  if (type !== "webgl") return original.apply(this, [type, ...args] as any);
  if (fallback) return null;
  const gl = original.apply(this, [type, ...args] as any) as WebGLRenderingContext | null;
  if (gl) (window as unknown as { __gl: WebGLRenderingContext[] }).__gl.push(gl);
  return gl;
} as typeof original;
// Legacy custom posters are baked the way the host used to, so the fallback has real pixels.
let legacyPoster =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
try {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const painter = createCoverPainter(canvas, COVER_VERTEX);
  painter.draw(painter.compile(coverFragment(legacySurface)), 0, 23);
  legacyPoster = canvas.toDataURL();
  painter.dispose();
} catch {}
// Counts program links, so a reload that shows saved stills can prove it compiled nothing.
(window as unknown as { __links: number }).__links = 0;
const link = WebGLRenderingContext.prototype.linkProgram;
WebGLRenderingContext.prototype.linkProgram = function (this: WebGLRenderingContext, program: WebGLProgram) {
  (window as unknown as { __links: number }).__links++;
  return link.call(this, program);
};
const ORBS = Object.values(OrbFamily);
/**
 * Rows 0–20: every named look. 21: legacy v2 lens field. 22: legacy v1 sphere. 23: no saved cover.
 * 24–29: more looks. 30–41: every orb family, each in its own hue slot.
 */
const covers = Array.from({ length: 30 + ORBS.length }, (_, i): ProjectCover | undefined => {
  const orb = ORBS[i - 30];
  if (orb) return { kind: "recipe", family: orb, hue: (i - 30) % 9, seed: (i * 97) % 997 };
  if (i === 21)
    return { kind: "shader", version: 2, surface: legacySurface, seed: 23, custom: true, poster: legacyPoster };
  if (i === 22)
    return { kind: "shader", version: 1, surface: legacySurface, seed: 23, custom: true, poster: legacyPoster };
  if (i === 23) return undefined;
  const [family, palette] = COVER_LOOKS[i % COVER_LOOKS.length]!;
  return { kind: "recipe", family, palette, seed: (i * 97) % 997 };
}) as ProjectCover[];
let setRowCover: (row: number, cover: ProjectCover) => void = () => {};
function App() {
  const [active, setActive] = useState(0);
  const [list, setList] = useState(covers);
  setRowCover = (row, cover) => setList((current) => current.map((value, i) => (i === row ? cover : value)));
  return (
    <main style={{ padding: 24, width: 300 }}>
      <h1 style={{ fontSize: 16, marginBottom: 16 }}>Cover sphere fixture</h1>
      <div id="rows" style={{ height: 240, overflowY: "auto" }}>
        {list.map((cover, i) => (
          <div key={i} data-project={`project-${i}`} style={{ display: "flex" }}>
            <button
              id={`row-${i}`}
              onClick={() => setActive(i)}
              aria-current={active === i ? "page" : undefined}
              style={{ display: "flex", alignItems: "center", gap: 12, padding: 8, width: "100%", cursor: "pointer" }}
            >
              <ProjectAvatar cover={cover} projectKey={`project-${i}`} active={active === i} />
              <span>Project {i}</span>
            </button>
          </div>
        ))}
      </div>
      <button
        id="uploaded"
        style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 20, cursor: "pointer" }}
      >
        <ProjectAvatar cover={{ kind: "image", dataUrl: legacyPoster }} />
        Uploaded image
      </button>
      <div id="search-cover" style={{ marginTop: 20 }}>
        <ProjectAvatar cover={covers[1]} projectKey="project-1" className="search-cover" />
      </div>
    </main>
  );
}
const root = createRoot(document.getElementById("root")!);
root.render(<App />);
let mounted = root;
window.coverFixture = {
  covers,
  legacySurface,
  unmount: () => mounted.unmount(),
  remount: () => {
    mounted.unmount();
    mounted = createRoot(document.getElementById("root")!);
    mounted.render(<App />);
  },
  setCover: (row, cover) => setRowCover(row, cover),
};
