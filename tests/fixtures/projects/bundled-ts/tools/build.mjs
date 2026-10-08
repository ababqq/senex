/**
 * Corridor's build: one esbuild call and one rewritten page. esbuild rather than Vite because
 * this fixture must build with no install and no network — esbuild and three are already this
 * repository's own devDependencies, and Vite is not. What the studio sees is identical either
 * way: `kindOf` reads three-in-dependencies plus a build script and answers `three-vite`,
 * `outputDir` answers `dist`, `packageCommands` answers `npm run build`, and the studio
 * shadow-builds and serves `dist/index.html`.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "dist");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: [path.join(root, "src/main.ts")],
  outfile: path.join(out, "main.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  sourcemap: false,
  logLevel: "warning",
});

// The bundler's job on the page is one line: point it at what was bundled.
const page = await readFile(path.join(root, "index.html"), "utf8");
await writeFile(path.join(out, "index.html"), page.replace('src="/src/main.ts"', 'src="./main.js"'));
