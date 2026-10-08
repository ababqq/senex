import type { ProjectCover, CoverStyle } from "./project-library.ts";
import { displayCover } from "./project-library.ts";
import { coverPosterSvg } from "./cover-recipe.ts";

const PALETTES = [
  ["#141329", "#6c5482", "#e0a6ac", "#626bac", "#a6c3c5"],
  ["#0e192d", "#345375", "#b0c9dc", "#657ba4", "#d0e2df"],
  ["#122c2e", "#426867", "#c5b395", "#617d77", "#b4cabb"],
  ["#302233", "#965e75", "#e9b38d", "#987c91", "#dfd0b1"],
];
/** A cover's five colors, darkest first. */
interface CoverColors {
  dark: string;
  sky: string;
  light: string;
  mid: string;
  pale: string;
}
type Random = () => number;

const poly = (points: string, fill: string) => `<polygon points="${points}" fill="${fill}"/>`;

/** The cover's repeatable random numbers: the same seed draws the same picture. */
function seededRandom(seed: number): Random {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** The sky, its sun and stars, and two ranges of hills: every procedural cover starts with these. */
function landscape({ dark, sky, light, mid, pale }: CoverColors, random: Random): string {
  const sunX = 150 + Math.round(random() * 45);
  const sunY = 52 + Math.round(random() * 25);
  let scene = `<rect width="256" height="256" fill="${dark}"/><rect width="256" height="155" fill="${sky}"/><circle cx="${sunX}" cy="${sunY}" r="31" fill="${light}"/>`;
  for (let i = 0; i < 24; i++) {
    const x = Math.round(random() * 256);
    const y = Math.round(random() * 112);
    scene += `<rect x="${x}" y="${y}" width="1.5" height="1.5" fill="${pale}" opacity=".6"/>`;
  }
  scene += poly("0,142 40,104 85,142 129,108 174,139 216,98 256,133 256,170 0,170", mid);
  scene += poly("0,158 42,133 91,160 162,127 204,151 256,134 256,187 0,187", dark);
  return scene;
}

/** Faceted floating terrain, a tiny ruin and water: recognisable at sidebar size. */
function worldScene({ dark, sky, light, mid, pale }: CoverColors, random: Random): string {
  const peak = 44 + Math.round(random() * 22);
  return [
    poly(`31,158 92,120 165,122 222,160 156,194 96,197`, mid),
    poly(`31,158 96,169 96,197 62,207`, sky),
    poly("96,169 156,173 156,224 96,197", dark),
    poly("156,173 222,160 193,202 156,224", sky),
    poly("31,158 92,120 132,150 96,169", pale),
    poly("92,120 165,122 132,150", light),
    poly("132,150 165,122 222,160 156,173", mid),
    poly("122,151 137,154 157,182 146,190 137,166", light),
    poly(`74,136 105,${peak} 130,145`, sky),
    poly(`105,${peak} 112,141 130,145`, dark),
    poly("154,139 154,99 177,91 177,137", dark),
    poly("177,91 189,100 189,146 177,137", sky),
    poly("154,99 177,91 189,100 168,108", pale),
    `<path d="M162 136v-17l7-3v23" fill="${light}"/>`,
  ].join("");
}

function relicScene({ dark, sky, light, mid, pale }: CoverColors): string {
  return [
    `<ellipse cx="128" cy="191" rx="70" ry="15" fill="${mid}"/>`,
    poly("128,53 185,104 164,164 128,185 71,145 73,93", pale),
    poly("128,53 128,116 73,93", light),
    poly("128,53 185,104 128,116", mid),
    poly("73,93 128,116 71,145", sky),
    poly("128,116 185,104 164,164 128,185", dark),
    poly("128,116 143,133 128,185 71,145", mid),
    `<path d="m70 144 60-29 55-12" fill="none" stroke="${pale}" stroke-width="2"/>`,
  ].join("");
}

function cityScene({ dark, light, mid }: CoverColors, random: Random): string {
  let scene = "";
  for (let i = 0; i < 8; i++) {
    const x = i * 33 - 4;
    const y = 75 + Math.round(random() * 67);
    const w = 22 + Math.round(random() * 14);
    scene += `<rect x="${x}" y="${y}" width="${w}" height="${195 - y}" fill="${i % 2 ? dark : mid}"/>`;
    for (let j = 0; j < 6; j++)
      scene += `<rect x="${x + 6}" y="${y + 9 + j * 14}" width="4" height="5" fill="${light}" opacity="${j % 2 ? ".4" : ".85"}"/>`;
  }
  scene += poly("115,148 142,148 206,256 45,256", dark);
  scene += `<path d="m128 157-1 14m-1 13-3 21m-2 19-4 32" stroke="${light}" stroke-width="3"/>`;
  return scene;
}

/** Sparse pixel dither emulates texture quantisation without expensive noise filters. */
function dither({ dark, pale }: CoverColors, random: Random): string {
  let scene = "";
  for (let i = 0; i < 130; i++)
    scene += `<rect x="${Math.floor(random() * 128) * 2}" y="${Math.floor(random() * 128) * 2}" width="2" height="2" fill="${i % 2 ? pale : dark}" opacity=".13"/>`;
  return scene;
}

/** The scene a cover's style draws over the landscape. */
function styleScene(style: CoverStyle | undefined, colors: CoverColors, random: Random): string {
  if (style === "world") return worldScene(colors, random);
  if (style === "relic") return relicScene(colors);
  return cityScene(colors, random);
}

/** Static geometry only: no scripts, requests, filters or raw user text in generated SVGs. */
export function projectCoverSvg(cover?: ProjectCover, key?: string): string {
  const shown = displayCover(cover, key);
  if (shown?.kind === "recipe") return coverPosterSvg(shown);
  if (!cover || cover.kind !== "procedural")
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><image width="256" height="256" href="${projectCoverUrl(cover, key)}"/></svg>`;
  const random = seededRandom(cover.seed || 1);
  const [dark, sky, light, mid, pale] = PALETTES[cover.palette % PALETTES.length];
  const colors: CoverColors = { dark, sky, light, mid, pale };
  // The draws happen in this order (landscape, style, dither): the same seed draws the same picture.
  const scene = landscape(colors, random);
  const styled = styleScene(cover.style, colors, random);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">${scene}${styled}${dither(colors, random)}</svg>`;
}
/** A still for `<img>`: uploads as saved, legacy custom shaders by their poster, recipes as a lit gradient. */
export function projectCoverUrl(cover?: ProjectCover, key?: string): string {
  const shown = displayCover(cover, key);
  if (shown?.kind === "shader") return shown.poster;
  return cover?.kind === "image"
    ? cover.dataUrl
    : `data:image/svg+xml,${encodeURIComponent(projectCoverSvg(cover, key))}`;
}
export const COVER_STYLES: { id: CoverStyle; label: string }[] = [
  { id: "world", label: "Low-poly world" },
  { id: "relic", label: "Chrome relic" },
  { id: "city", label: "Night city" },
];
