import { test } from "node:test";
import assert from "node:assert/strict";
import { toolbarItems, toolbarStatusFrom } from "../../src/shared/plugin-toolbar.ts";
import type { PluginInfo, PluginToolbarItem } from "../../src/shared/plugins.ts";

const item = (over: Partial<PluginToolbarItem> = {}): PluginToolbarItem => ({
  id: "demo",
  label: "Example",
  ariaLabel: "Example plugin demo",
  target: { kind: "panel", id: "demo" },
  ...over,
});
const plugin = (id: string, toolbar: PluginToolbarItem[] | undefined, over: Partial<PluginInfo> = {}): PluginInfo => ({
  manifest: {
    apiVersion: 2,
    id,
    version: "1.0.0",
    name: id,
    publisher: "t",
    description: "t",
    backend: "backend.mjs",
    capabilities: [],
    tools: [],
    skills: [],
    panels: [{ id: "demo", title: "Demo", file: "panel.html", placement: "settings" }],
    settings: [],
    actions: [],
    ...(toolbar ? { toolbar } : {}),
  },
  source: "local",
  enabled: true,
  removed: false,
  health: "stopped",
  state: "enabled",
  ...over,
});

test("toolbarItems keeps enabled installed plugins only and honours requiresProject", () => {
  const plugins = [
    plugin("a", [
      item(),
      item({ id: "two", ariaLabel: "Two", requiresProject: false }),
      item({ id: "three", ariaLabel: "Three", requiresProject: true }),
    ]),
    plugin("off", [item()], { enabled: false, state: "disabled" }),
    plugin("gone", [item()], { removed: true, enabled: false, state: "disabled" }),
    plugin("dropped", [item()], { unlisted: true, state: "not-enabled" }),
    plugin("none", undefined),
  ];
  assert.deepEqual(
    toolbarItems(plugins, "project").map((e) => e.key),
    ["a:demo", "a:two", "a:three"],
  );
  assert.deepEqual(
    toolbarItems(plugins, null).map((e) => e.key),
    ["a:two"],
  );
  assert.deepEqual(
    toolbarItems(plugins, undefined).map((e) => e.key),
    ["a:two"],
  );
  assert.deepEqual(
    toolbarItems(plugins, "").map((e) => e.key),
    ["a:two"],
  );
  const [first] = toolbarItems(plugins, "project");
  assert.equal(first!.plugin.manifest.id, "a");
  assert.deepEqual(first!.item, item());
  assert.deepEqual(toolbarItems([], "project"), []);
});
test("toolbarStatusFrom sanitizes badge, title, disabled and tone and rejects non-objects", () => {
  for (const value of [null, undefined, "Draft", 3, true, ["Draft"]]) assert.equal(toolbarStatusFrom(value), null);
  assert.deepEqual(toolbarStatusFrom({}), {});
  assert.deepEqual(toolbarStatusFrom({ badge: "Draft", title: "Draft is online", disabled: false, tone: "ok" }), {
    badge: "Draft",
    title: "Draft is online",
    disabled: false,
    tone: "ok",
  });
  assert.deepEqual(toolbarStatusFrom({ badge: "x".repeat(40) }), { badge: "x".repeat(16) });
  assert.deepEqual(toolbarStatusFrom({ title: "y".repeat(200) }), { title: "y".repeat(120) });
  assert.deepEqual(toolbarStatusFrom({ badge: "  Live \n now  ", title: "\tready\n" }), {
    badge: "Live now",
    title: "ready",
  });
  assert.deepEqual(toolbarStatusFrom({ badge: 7 }), { badge: "7" });
  assert.deepEqual(toolbarStatusFrom({ badge: "", title: "", disabled: 1 }), { disabled: true });
  assert.deepEqual(toolbarStatusFrom({ disabled: "", tone: "loud" }), { disabled: false });
  assert.deepEqual(toolbarStatusFrom({ badge: {}, title: ["x"], tone: "warn", extra: "dropped" }), { tone: "warn" });
  assert.deepEqual(toolbarStatusFrom({ kind: "toolbar", item: "publish", badge: "Live", tone: "ok" }), {
    badge: "Live",
    tone: "ok",
  });
});
test("toolbarStatusFrom keeps attention as a boolean", () => {
  assert.deepEqual(toolbarStatusFrom({ attention: true }), { attention: true });
  assert.deepEqual(toolbarStatusFrom({ attention: 0, title: "Up to date" }), { attention: false, title: "Up to date" });
  assert.deepEqual(toolbarStatusFrom({ kind: "toolbar", item: "publish", attention: "yes" }), { attention: true });
  assert.deepEqual(toolbarStatusFrom({ badge: "Draft" }), { badge: "Draft" });
});
