/**
 * The static check run before every judged build: does the page exist, does what it loads run in
 * a browser as written, and does it load (or can the studio attach) the contract the judge reads.
 * Read-only: nothing here writes into the project folder.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ContractWord, type ProjectShape } from "../shared/project-folder.ts";
import { pathExists } from "./fsx.ts";
import {
  type ContractReach,
  importMapKeys,
  INSERTED_MAP_SPECIFIERS,
  isRemoteSrc,
  moduleSpecifiers,
  pageScripts,
  projectRelative,
  resolvedByMap,
  threeReach,
  unreachableLoads,
} from "./project-page.ts";
import { isInside, toPosixRelative } from "./paths.ts";
import { readProjectShape } from "./project-shape.ts";

/** The most modules the reachable-source walk opens; a larger project is judged on its first ones. */
const MAX_REACHABLE_SOURCES = 400;
/** How many unresolved package names the problem names before it stops listing. */
const LISTED_UNRESOLVED_IMPORTS = 3;
/** The extensions a bundler would try on a specifier written without one, in its order. */
const MODULE_EXTENSIONS = [".js", ".mjs", ".ts", ".tsx", ".jsx"];

/**
 * The one problem that decides whether a build can be judged at all. It is read by a person —
 * the Open Project sheet prints it under "Before a night can judge it" — so it says what the night
 * will do about it rather than handing the user two lines of JavaScript to type: installing the
 * contract is the base builder's first job (loop/director.ts `installContract`), and the brief
 * the engine reads is where the two lines belong.
 */
export const NO_CONTRACT_PROBLEM =
  "nothing on your page connects the studio to your project yet — the studio adds its connection to your entry before the first builder starts (until then the judge cannot score this build)";

const MESSAGE = {
  MissingFile: (file: string) => `${file} is missing`,
  UnreachableHosts: (hosts: string[]) =>
    `index.html loads code or styles from ${hosts.join(", ")}, which the studio's preview cannot reach (it allows only public library and font CDNs) — the project will not run here until those files are copied into the project folder and loaded from there`,
  UnresolvedPackages: (main: string, names: string[]) =>
    `${main} imports ${names
      .slice(0, LISTED_UNRESOLVED_IMPORTS)
      .map((name) => `"${name}"`)
      .join(
        ", ",
      )} as packages, and nothing here resolves them — this project needs a build command (studio.json "build") or an import map`,
  TypescriptUnbuilt: (file: string) =>
    `${file} is TypeScript and nothing here builds it — a browser cannot run it as written; this project needs a build command (studio.json "build")`,
  MathRandom: (file: string) => `${file} uses Math.random() — runs will not be comparable`,
  BootsPaused:
    "studio.js boots paused (`let running = false`) and nothing calls start() — the project will sit on one frozen frame",
  PredatesInspect:
    "src/studio.js predates the v2 contract (no inspect()) — scene checks and eye cameras are unavailable",
  NoPlayer: "installStudio() is called without scene/camera/player — scene checks fail and eye cameras do not exist",
} as const;

/** What `validateProjectDir` found: the problems that stop a judged build, the warnings, and the contract's word. */
export interface ProjectValidation {
  ok: boolean;
  problems: string[];
  warnings: string[];
  contract: ContractWord;
  reach: ContractReach;
  shape: ProjectShape;
}

/**
 * Which vintage of the contract module a copy of `src/studio.js` is, so an upgrade can compare
 * a project's copy against the shipped template's instead of sniffing for one feature. Every
 * generation carries the literals of the ones before it: a copy that predates M4 already holds
 * both `inspect()` and `hud: hud.api`, so those two alone cannot tell it from the current file
 * and every already-scaffolded project kept a contract nothing would replace.
 *
 * 0 no file at all, 1 predates `inspect()`, 2 has `inspect()` and no HUD, 3 the one-screen
 * contract (HUD and input), 4 the M4 contract: the HUD is a lazy facade over `./hud.js` and an
 * eye camera is borrowed from the project and given back.
 */
export function studioContractGeneration(source: string | null): number {
  if (source === null) return 0;
  if (/\bcreateHudFacade\s*[(=]/.test(source) || /\bborrowedCamera\b/.test(source)) return 4;
  if (!/\binspect\s*[(:]/.test(source)) return 1;
  return /\bhud\s*:\s*hud\.api/.test(source) ? 3 : 2;
}

/**
 * A browser runs JavaScript. Inserting an import map does not make TypeScript run in Chromium,
 * so a folder whose reachable sources are `.ts` is not attachable however its three resolves —
 * telling a night the page attaches and then judging a blank screen is the failure this whole
 * milestone exists to remove.
 */
function nonExecutableSource(sources: string[]): string | null {
  return sources.find((file) => /\.(ts|tsx|jsx)$/.test(file)) ?? null;
}

/**
 * A dev-only project (Vite with no build script) is served exactly as written, and the browser
 * has no bundler: `import … from "three"` simply fails and the stage goes black. Say so here
 * rather than let a night be judged on a page that never ran. The exception is what the
 * studio's own inserted map answers: a page with no map of its own gets the five vendored
 * keys from the serve layer, so `three` there is resolved, not missing.
 */
function unresolvedImportsProblem(shape: ProjectShape, mapped: string[], unresolved: string[]): string | null {
  const unresolvedHere =
    mapped.length === 0 ? unresolved.filter((name) => !resolvedByMap(INSERTED_MAP_SPECIFIERS, name)) : unresolved;
  const servedAsWritten = shape.own && !shape.build;
  if (!servedAsWritten || unresolvedHere.length === 0) return null;
  return MESSAGE.UnresolvedPackages(shape.main, unresolvedHere);
}

/** What the page's own sources do with the contract, as `scanContractUse` reads them. */
interface ContractUse {
  installsContract: boolean;
  hasPlayer: boolean;
  hasInspect: boolean;
  bootsPaused: boolean;
  callsStart: boolean;
  /** Project sources (relative to the folder) that call `Math.random()`, in the order read. */
  randomUsers: string[];
}

/** Read every reachable source for the contract's traces: the module itself, and the project's calls into it. */
async function scanContractUse(dir: string, sources: string[]): Promise<ContractUse> {
  const use: ContractUse = {
    installsContract: false,
    hasPlayer: false,
    hasInspect: false,
    bootsPaused: false,
    callsStart: false,
    randomUsers: [],
  };
  for (const file of sources) {
    const text = await readFile(file, "utf8").catch(() => "");
    // `studio.js` is the contract itself: it contains both literals whatever the project does
    // with it, and counting it made every folder holding the file report "loaded" — which is
    // how a project the studio could only attach to was told to install what was never called.
    if (file.endsWith("studio.js")) noteContractModule(use, text);
    else noteProjectSource(use, toPosixRelative(path.relative(dir, file)), text);
  }
  return use;
}

function noteContractModule(use: ContractUse, text: string): void {
  if (/inspect/.test(text)) use.hasInspect = true;
  // The declaration only — seed() and pause() legitimately assign `running = false`.
  if (/let\s+running\s*=\s*false/.test(text)) use.bootsPaused = true;
}

function noteProjectSource(use: ContractUse, rel: string, text: string): void {
  const installs = /installStudio\s*\(/.test(text);
  if (/window\.__studio\s*=/.test(text) || installs) use.installsContract = true;
  if (installs && /\bplayer\s*[:(]/.test(text)) use.hasPlayer = true;
  if (/\bMath\.random\s*\(/.test(text)) use.randomUsers.push(rel);
  if (/\.start\s*\(/.test(text)) use.callsStart = true;
}

/**
 * Attached, not installed: the serve layer points the page's own `three` at the studio's
 * wrapper, and the hook reads the scene, camera and renderer off the frames the project draws
 * (M4.2a). That only works on a page a browser can actually run, so a TypeScript entry with
 * no build is `missing` with the build's own sentence, never `attached`.
 */
function contractWord(installsContract: boolean, reach: ContractReach, nonExecutable: string | null): ContractWord {
  if (installsContract) return ContractWord.Loaded;
  if (reach !== "none" && !nonExecutable) return ContractWord.Attached;
  return ContractWord.Missing;
}

/** The warnings about an installed contract: a paused boot nothing starts, and a contract too old or too bare to score. */
function contractWarnings(use: ContractUse): string[] {
  if (!use.installsContract) return [];
  const warnings: string[] = [];
  if (use.bootsPaused && !use.callsStart) warnings.push(MESSAGE.BootsPaused);
  // The v2 contract (scene checks, eye cameras) is a warning, not a problem: an older project
  // still judges by taste; it just cannot be scored mechanically.
  if (!use.hasInspect) warnings.push(MESSAGE.PredatesInspect);
  else if (!use.hasPlayer) warnings.push(MESSAGE.NoPlayer);
  return warnings;
}

/**
 * Static check run before every judged build. It catches the two failures that would otherwise
 * waste a whole gauntlet iteration: a missing entry point, and a project that abandoned the
 * contract (hard-coded `Math.random`, no `window.__studio`).
 */
export async function validateProjectDir(dir: string): Promise<ProjectValidation> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const shape = await readProjectShape(dir);
  const indexExists = await pathExists(path.join(dir, "index.html"));
  if (!indexExists) problems.push(MESSAGE.MissingFile("index.html"));
  if (!(await pathExists(path.join(dir, shape.main)))) problems.push(MESSAGE.MissingFile(shape.main));

  // Only what the page actually loads. A template `src/main.js` left beside a Godot export or
  // a Vite project used to prove the contract on the studio's own dead scaffold, so validation
  // passed and every judge then reported "window.__studio is missing" on the real page.
  const { files: sources, unresolved } = await reachableSources(dir, shape);
  const html = (await readFile(path.join(dir, "index.html"), "utf8").catch(() => "")) ?? "";
  const mapped = importMapKeys(html);
  // R6: the preview reaches only the public library/font CDNs (preview-network.ts). Said here,
  // where both the Open Project sheet and a builder's validate call read it, rather than as a
  // console warning on a page that already failed.
  const remote = unreachableLoads(html);
  if (remote.length > 0) problems.push(MESSAGE.UnreachableHosts(remote));
  // No page, nothing to compose: the serve layer rewrites the page it serves, and there is none.
  const reach: ContractReach = indexExists ? threeReach({ html, build: shape.build, mapped, unresolved }) : "none";
  const unresolvedProblem = unresolvedImportsProblem(shape, mapped, unresolved);
  if (unresolvedProblem) problems.push(unresolvedProblem);

  const use = await scanContractUse(dir, sources);
  warnings.push(...use.randomUsers.map((rel) => MESSAGE.MathRandom(rel)));
  const nonExecutable = reach === "none" ? null : nonExecutableSource(sources);
  if (nonExecutable) problems.push(MESSAGE.TypescriptUnbuilt(toPosixRelative(path.relative(dir, nonExecutable))));
  // The one problem the night can do something about on its own: a page that never loads the
  // contract is unjudgeable, and installing it is the first thing a run does (loop/director.ts
  // `installContract`). Answered as a word rather than left for every caller to match the
  // sentence in `problems` — the folder sheet already read it that way.
  const contract = contractWord(use.installsContract, reach, nonExecutable);
  if (contract === ContractWord.Missing) problems.push(NO_CONTRACT_PROBLEM);
  warnings.push(...contractWarnings(use));
  return { ok: problems.length === 0, problems, warnings, contract, reach, shape };
}

/** The reachable-source walk's state: what it found, what it still has to open, and what it has seen. */
interface SourceWalk {
  dir: string;
  files: string[];
  unresolved: Set<string>;
  queue: string[];
  /** Queue a project-relative path, once, and only when it stays inside the folder. */
  enqueue: (rel: string) => void;
}

function sourceWalk(dir: string): SourceWalk {
  const seen = new Set<string>();
  const walk: SourceWalk = {
    dir,
    files: [],
    unresolved: new Set(),
    queue: [],
    enqueue: (rel) => {
      const full = path.resolve(dir, rel);
      if (!isInside(dir, full) || seen.has(full)) return;
      seen.add(full);
      walk.queue.push(full);
    },
  };
  return walk;
}

/**
 * One specifier a module imports: a project path is walked next, a bare name either resolves
 * through the page's own map or is recorded as unresolved, and a remote URL is not the folder's.
 */
function followSpecifier(walk: SourceWalk, from: string, specifier: string, mapped: string[]): void {
  if (isRemoteSrc(specifier)) return;
  if (specifier.startsWith("/")) {
    walk.enqueue(projectRelative(specifier));
    return;
  }
  if (specifier.startsWith(".")) {
    walk.enqueue(toPosixRelative(path.relative(walk.dir, path.resolve(path.dirname(from), specifier))));
    return;
  }
  if (!resolvedByMap(mapped, specifier)) walk.unresolved.add(specifier);
}

/**
 * The files the served page really runs: every local `<script src>` on `index.html`, then
 * everything those modules import, transitively. `index.html` is the source page even for a
 * bundled project — Vite builds *from* it — so the walk works before any build has run.
 *
 * Bare specifiers (`three`, `phaser`) belong to the import map or the bundler, not to the
 * folder, and stop the walk; so does anything outside the project. The bare ones nothing
 * resolves come back too — a browser cannot load them, so they decide whether the project can be
 * served as written at all.
 */
async function reachableSources(dir: string, shape: ProjectShape): Promise<{ files: string[]; unresolved: string[] }> {
  const walk = sourceWalk(dir);
  const html = await readFile(path.join(dir, "index.html"), "utf8").catch(() => null);
  for (const src of html === null ? [] : pageScripts(html)) {
    if (!isRemoteSrc(src)) walk.enqueue(projectRelative(src));
  }
  // A page the studio cannot read still has a recorded entry — judge that rather than nothing.
  if (walk.queue.length === 0) walk.enqueue(shape.main);
  const mapped = html === null ? [] : importMapKeys(html);

  while (walk.files.length < MAX_REACHABLE_SOURCES) {
    const file = walk.queue.shift();
    if (file === undefined) break;
    const resolved = await resolveModule(file);
    if (!resolved) continue;
    walk.files.push(resolved);
    const text = await readFile(resolved, "utf8").catch(() => "");
    for (const specifier of moduleSpecifiers(text)) followSpecifier(walk, resolved, specifier, mapped);
  }
  return { files: walk.files, unresolved: [...walk.unresolved] };
}

/** A specifier without an extension is a file with one — the resolution a bundler would do. */
async function resolveModule(file: string): Promise<string | null> {
  // .html because a page may install the contract from an inline module and import from there.
  if (/\.(js|mjs|ts|tsx|jsx|html)$/.test(file) && (await pathExists(file))) return file;
  for (const candidate of [file, `${file}/index`]) {
    for (const ext of MODULE_EXTENSIONS) {
      if (await pathExists(`${candidate}${ext}`)) return `${candidate}${ext}`;
    }
  }
  // `import "./studio.js"` in a TypeScript project means studio.ts — the compiler's own rule.
  const swapped = file.replace(/\.js$/, ".ts");
  if (swapped !== file && (await pathExists(swapped))) return swapped;
  return null;
}
