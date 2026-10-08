/**
 * Scrolling a long chat fast, both ways, must never paint a blank block where messages should be.
 * Builds the production ChatPanel fixture (`tests/fixtures/chat-scroll.tsx`) and its Electron
 * driver (`chat-scroll-electron.ts`). Evidence: .studio-dev/evidence/chat-scroll-<time>/
 * (report.json, frames per scene, the worst painted frame, fling.cpuprofile, fling.trace.json).
 */
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildDesignGallery } from "../../scripts/design-gallery.mjs";
import { fixtureElectronArgs, fixtureElectronEnv, resolveElectron } from "../../scripts/electron-runtime.mjs";

const RUN_TIMEOUT_MS = 300_000;
/**
 * `--build owned`: the renderer a live owned studio:dev build runs (development React under
 * StrictMode, journey marks, no Profiler); `--build production` (the default): a packaged app's.
 */
const BUILDS = {
  production: { "process.env.NODE_ENV": '"production"', __STUDIO_PERFORMANCE__: "false" },
  owned: { "process.env.NODE_ENV": '"development"', __STUDIO_PERFORMANCE__: "true" },
};
const buildAt = process.argv.indexOf("--build");
const flavor = buildAt >= 0 ? process.argv[buildAt + 1] : "production";
if (!Object.hasOwn(BUILDS, flavor)) throw new Error(`--build takes ${Object.keys(BUILDS).join(" or ")}, not ${flavor}`);
const out = await buildDesignGallery();
const evidence = path.resolve(".studio-dev/evidence", `chat-scroll-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const bundle = path.join(out, "chat-scroll.js");
await build({
  entryPoints: ["tests/fixtures/chat-scroll.tsx"],
  outfile: bundle,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  platform: "browser",
  define: BUILDS[flavor],
});
const html = path.join(out, "chat-scroll.html");
await writeFile(
  html,
  '<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="gallery.css"></head><body style="margin:0"><div id="root" style="display:flex;height:100vh;width:640px"></div><script type="module" src="chat-scroll.js"></script></body></html>',
);
const driver = path.join(evidence, "driver.mjs");
await build({
  entryPoints: ["tests/e2e/chat-scroll-electron.ts"],
  outfile: driver,
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["electron"],
});
const child = spawn(resolveElectron(), fixtureElectronArgs([driver]), {
  stdio: "inherit",
  env: {
    ...fixtureElectronEnv(),
    STUDIO_CHAT_SCROLL_PAGE: html,
    STUDIO_CHAT_SCROLL_BUNDLE: bundle,
    STUDIO_CHAT_SCROLL_EVIDENCE: evidence,
    STUDIO_CHAT_SCROLL_BUILD: flavor,
    STUDIO_CHAT_SCROLL_PROJECT: path.resolve("tests/fixtures/gpu-load.html"),
  },
});
const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
try {
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error(`chat scroll check failed (${code}); see ${evidence}/report.json`);
  console.log(`PASS chat scroll; ${path.relative(process.cwd(), path.join(evidence, "report.json"))}`);
} finally {
  clearTimeout(timer);
}
