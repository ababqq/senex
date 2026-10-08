/**
 * The credentials the core holds — credential-named environment variables, unlocked connector and
 * OAuth values, plugin account tokens — are kept out of what it persists and publishes: every
 * append to the event log (review SEC-1) and every public export (SEC-6).
 */
import assert from "node:assert/strict";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { EventData } from "../../src/shared/event-log.ts";
import type { McpConnector } from "../../src/shared/mcp.ts";
import { McpRegistry } from "../../src/substrate/mcp/registry.ts";
import { memorySecretPort } from "../../src/substrate/mcp/store.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

const ENV_NAME = "STUDIO_TEST_FAKE_API_TOKEN";
const ENV_VALUE = "env-held-FAKE-value-4411";
process.env[ENV_NAME] = ENV_VALUE;

test("the core's log redacts the credentials it holds, on the core and the harness append paths (SEC-1)", async () => {
  const lite = await coreLite();
  const { core } = lite;
  // Stand-ins for a connector value unlocked this session and an unlocked plugin account.
  core.mcp.secretValues = () => ["mcp-leased-FAKE-value"];
  core.plugins.heldCredentials = () => ["plugin-held-FAKE-token"];
  assert.deepEqual(
    ["mcp-leased-FAKE-value", "plugin-held-FAKE-token", ENV_VALUE].map((value) =>
      core.knownSecretValues().includes(value),
    ),
    [true, true, true],
  );
  const text = `env ${ENV_VALUE}; mcp mcp-leased-FAKE-value; plugin plugin-held-FAKE-token; key sk-ant-oat01-FAKE9shape`;
  await core.append([
    { type: "custom", event_type: "delegated.claude-code", payload: { kind: "tool_result", data: text } },
  ]);
  await lite.api()["events.append"]({ batch: [{ type: "error", message: text }] });
  const written = JSON.stringify((await core.store.listEvents(core.mainThread)).slice(-2));
  for (const secret of [ENV_VALUE, "mcp-leased-FAKE-value", "plugin-held-FAKE-token", "FAKE9shape"]) {
    assert.equal(written.includes(secret), false, `${secret} reached the log`);
  }
  assert.equal(written.match(/\[redacted\]/g)?.length, 8, written);
});

// Ordinary chat, prose and project code that only looks like a credential field. The log is kept for
// good and replayed as the agent's context, so it keeps these byte for byte (review B1).
const ORDINARY = [
  "Add a capability to jump twice",
  "The incapability of the boss",
  "Use the api_key field of the config",
  "Authorization: header docs",
  "const SPRITE_KEY=hero;",
  "location.href = 'project.html?code=level2'",
];

test("the log keeps ordinary chat and project code that only looks like a credential field (B1)", async () => {
  const { core } = await coreLite();
  const text = ORDINARY.join("\n");
  const batch: EventData[] = [
    {
      type: "custom",
      event_type: "coordinator_message_queued",
      payload: { messageId: "m1", action: { type: "user_message", text } },
    },
    {
      type: "custom",
      event_type: "delegated.claude-code",
      payload: {
        kind: "assistant",
        data: {
          parts: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "src/main.js", content: text } }],
        },
      },
    },
  ];
  await core.append(batch);
  const written = (await core.store.listEvents(core.mainThread)).slice(-2).map((event) => event.data);
  assert.deepEqual(written, batch);
});

const PUBLIC_URL = "https://api.example.com";

/** A real registry holding a connector whose config has a public URL and a folder beside its API key. */
async function connectorWithConfig(): Promise<McpRegistry> {
  const root = await tmpDir("studio-known-secrets-mcp-");
  const registry = new McpRegistry({ file: path.join(root, "connectors.json"), secrets: memorySecretPort(new Map()) });
  await registry.init();
  const connector = {
    id: "weather",
    name: "Weather",
    transport: "stdio",
    command: process.execPath,
    args: [],
    env: ["BASE_URL", "ALLOWED_DIR", "WEATHER_API_KEY"],
    enabled: true,
    scope: "global",
    toolPolicy: {},
    createdAt: new Date().toISOString(),
  } as McpConnector;
  await registry.save(
    connector,
    {
      "env.BASE_URL": PUBLIC_URL,
      "env.ALLOWED_DIR": "/Users/someone/Projects",
      "env.WEATHER_API_KEY": "weather-FAKE-api-key",
    },
    { trust: true },
  );
  return registry;
}

test("a connector's plain config values are not credentials: the log keeps them and a project using them exports (B2)", async () => {
  const { core } = await coreLite();
  const registry = await connectorWithConfig();
  try {
    core.mcp.secretValues = () => registry.secretValues();
    assert.deepEqual(
      ["weather-FAKE-api-key", PUBLIC_URL, "/Users/someone/Projects"].map((value) =>
        core.knownSecretValues().includes(value),
      ),
      [true, false, false],
    );
    const said = (key: string) => `fetched ${PUBLIC_URL}/forecast into /Users/someone/Projects/pong with ${key}`;
    await core.append([
      {
        type: "custom",
        event_type: "delegated.claude-code",
        payload: { kind: "tool_result", data: said("weather-FAKE-api-key") },
      },
    ]);
    const [event] = (await core.store.listEvents(core.mainThread)).slice(-1);
    assert.deepEqual(event!.data, {
      type: "custom",
      event_type: "delegated.claude-code",
      payload: { kind: "tool_result", data: said("[redacted]") },
    });

    const project = await core.projects.scaffold("forecast", { title: "Forecast" });
    await rm(path.join(project.dir, "src"), { recursive: true });
    await mkdir(path.join(project.dir, "src"));
    await writeFile(path.join(project.dir, "index.html"), '<script type="module" src="./src/config.js"></script>\n');
    await writeFile(path.join(project.dir, "src", "config.js"), `export const api = "${PUBLIC_URL}/forecast";\n`);
    await writeFile(path.join(project.dir, "studio.json"), JSON.stringify({ exportFiles: ["index.html", "src"] }));
    const result = await core.exportPublicCopy(project.name, path.join(core.layout.exports, "forecast"));
    assert.ok(result.included.includes("src/config.js"));
  } finally {
    await registry.close();
  }
});

test("a public export refuses a project file that holds a credential the core holds, from the UI and the harness alike (SEC-6)", async () => {
  const lite = await coreLite();
  const { core } = lite;
  const project = await core.projects.scaffold("leaky", { title: "Leaky" });
  // A page with no vendored library, so the only thing the exporter can object to is the value.
  await rm(path.join(project.dir, "src"), { recursive: true });
  await mkdir(path.join(project.dir, "src"));
  await writeFile(path.join(project.dir, "index.html"), '<script type="module" src="./src/config.js"></script>\n');
  await writeFile(path.join(project.dir, "src", "config.js"), `export const key = "${ENV_VALUE}";\n`);
  await writeFile(path.join(project.dir, "studio.json"), JSON.stringify({ exportFiles: ["index.html", "src"] }));
  const target = path.join(core.layout.exports, "leaky");
  await assert.rejects(core.exportPublicCopy(project.name, target), (error: Error) => {
    assert.match(error.message, /config\.js/);
    assert.equal(error.message.includes(ENV_VALUE), false, "the refusal names the file, never the value");
    return true;
  });
  await assert.rejects(lite.api()["project.export"]({ project: project.name }), /config\.js/);
  await assert.rejects(access(target), "nothing was published");
});
