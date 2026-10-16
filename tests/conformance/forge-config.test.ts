/**
 * The Linux package makers find the app by its binary name. They default to the npm package name,
 * so after the product became Genex (`executableName: "genex"`) the rpm maker looked for
 * `ai-game-studio` and failed in CI. Each Linux maker must name the packaged executable.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);

test("the deb and rpm makers point at the packaged executable, not the npm package name", () => {
  const config = require("../../forge.config.cjs");
  const executable = config.packagerConfig.executableName;
  const linuxMakers = config.makers.filter((maker: { name: string }) =>
    ["@electron-forge/maker-deb", "@electron-forge/maker-rpm"].includes(maker.name),
  );
  assert.equal(linuxMakers.length, 2);
  for (const maker of linuxMakers) assert.equal(maker.config.options.bin, executable, maker.name);
});

test("Windows packages as a per-user Squirrel installer named Genex-Setup.exe, with Genex's own metadata and icon", () => {
  const config = require("../../forge.config.cjs");
  const squirrel = config.makers.find((maker: { name: string }) => maker.name === "@electron-forge/maker-squirrel");
  assert.ok(squirrel, "a Squirrel maker is configured");
  assert.deepEqual(squirrel.platforms, ["win32"]);
  assert.equal(squirrel.config.setupExe, "Genex-Setup.exe");
  assert.equal(squirrel.config.name, config.packagerConfig.executableName, "the install folder and nupkg id");
  assert.match(squirrel.config.setupIcon, /icon\.ico$/);
  assert.equal(squirrel.config.noMsi, true);
  const { CompanyName, ProductName } = config.packagerConfig.win32metadata;
  assert.deepEqual([CompanyName, ProductName], ["Genex", "Genex"]);
});

test("the Linux packages describe the product as it is, under categories freedesktop registers", () => {
  const config = require("../../forge.config.cjs");
  const linuxMakers = config.makers.filter((maker: { name: string }) =>
    ["@electron-forge/maker-deb", "@electron-forge/maker-rpm"].includes(maker.name),
  );
  const registered = new Set(["Development", "IDE", "Utility", "Building", "ProjectManagement", "WebDevelopment"]);
  for (const maker of linuxMakers) {
    const { productDescription, categories } = maker.config.options;
    assert.doesNotMatch(productDescription, /three\.js|\bgames?\b/i, `${maker.name}: ${productDescription}`);
    assert.match(productDescription, /web apps/);
    assert.ok(categories.includes("Development"), maker.name);
    for (const category of categories) assert.ok(registered.has(category), `${maker.name}: ${category}`);
  }
});
