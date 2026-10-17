import { test } from "node:test";
import assert from "node:assert/strict";
import { McpOAuthAccount } from "../../src/substrate/mcp/oauth.ts";
import { McpSessionSecrets } from "../../src/substrate/mcp/session-secrets.ts";
import { memorySecretPort } from "../../src/substrate/mcp/store.ts";
import { McpRegistry } from "../../src/substrate/mcp/registry.ts";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** An MCP server and its authorization server, answering discovery; `revoke` adds RFC 7009 revocation. */
function authServer(options: { revoke: boolean; failRevoke?: boolean }) {
  const issuer = "https://identity.example";
  const revocations: Array<Record<string, string>> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("oauth-protected-resource"))
      return Response.json({ resource: "https://docs.example/mcp", authorization_servers: [issuer] });
    if (url.includes("/.well-known/"))
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        response_types_supported: ["code"],
        ...(options.revoke ? { revocation_endpoint: `${issuer}/revoke` } : {}),
      });
    if (url === `${issuer}/revoke` && init?.method === "POST") {
      revocations.push(Object.fromEntries(new URLSearchParams(String(init.body))));
      return options.failRevoke ? new Response("", { status: 503 }) : new Response("", { status: 200 });
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  };
  return { fetchImpl, revocations };
}
const SAVED = JSON.stringify({
  tokens: { access_token: "access-FAKE-token", refresh_token: "refresh-FAKE-token", token_type: "Bearer" },
  client: { client_id: "studio-client" },
});

test("OAuth cannot unlock or open a browser from background provider methods; cancel invalidates pending writes", async () => {
  const values = new Map<string, string>();
  let reads = 0;
  const store = memorySecretPort(values);
  // Offline: the disconnect at the end asks for revocation, and no test reaches a real server.
  const offline: typeof fetch = async () => {
    throw new Error("offline");
  };
  const account = new McpOAuthAccount(
    "docs",
    "https://docs.example/mcp",
    {
      ...store,
      get: async (key) => {
        reads++;
        return store.get(key);
      },
    },
    () => {},
    async () => {},
    offline,
  );
  assert.throws(() => account.provider().tokens(), /Connect/);
  assert.equal(reads, 0);
  let opened = 0;
  try {
    const p = await account.begin(async () => {
      opened++;
    });
    assert.equal(reads, 1);
    await p.saveCodeVerifier("verifier");
    await p.redirectToAuthorization(new URL("https://identity.example/authorize"));
    assert.equal(opened, 1);
    assert.equal(account.state, "authorizing");
    const invalid = await fetch(`${p.redirectUrl}?state=forged&code=unused`);
    assert.equal(invalid.status, 400);
    account.cancel();
    await assert.rejects(
      Promise.resolve().then(() => p.saveTokens({ access_token: "must-not-save", token_type: "Bearer" })),
      /Connect/,
    );
    assert.equal(
      [...values.values()].some((v) => v.includes("must-not-save")),
      false,
    );
    const next = await account.begin(async () => {});
    assert.equal(reads, 1, "the unlocked session survives cancelled browser sign-in");
    await next.saveTokens({ access_token: "approved-token", token_type: "Bearer" });
    assert.ok([...values.values()].some((v) => v.includes("approved-token")));
    await account.disconnect();
    assert.equal(values.size, 0);
    assert.throws(() => next.tokens(), /Connect/);
  } finally {
    account.lock();
  }
});

test("MCP secret discovery never opens storage and explicit concurrent connects share a read", async () => {
  let reads = 0;
  const values = new Map([["mcp.docs.header.Authorization", "Bearer test"]]);
  const store = memorySecretPort(values);
  const lease = new McpSessionSecrets({
    ...store,
    get: async (key) => {
      reads++;
      return store.get(key);
    },
  });
  const connector = { id: "docs", headers: ["Authorization"] } as Parameters<typeof lease.unlock>[0];
  assert.equal((await lease.list()).length, 1);
  assert.equal(reads, 0);
  await assert.rejects(lease.get("mcp.docs.header.Authorization"), /locked/);
  await Promise.all([lease.unlock(connector), lease.unlock(connector)]);
  assert.equal(reads, 1);
  assert.equal(await lease.get("mcp.docs.header.Authorization"), "Bearer test");
  assert.equal(reads, 1);
  lease.lock("docs");
  await assert.rejects(lease.get("mcp.docs.header.Authorization"), /locked/);
});

test("late OAuth errors redact rotated credentials after lock without retaining token authority", async () => {
  const account = new McpOAuthAccount(
    "docs",
    "https://docs.example/mcp",
    memorySecretPort(new Map()),
    () => {},
    async () => {},
  );
  try {
    const [p, other] = await Promise.all([account.begin(async () => {}), account.begin(async () => {})]);
    assert.equal(p, other, "duplicate Connect uses one callback and provider");
    const redact = account.redactor();
    await p.saveTokens({ access_token: "first-private-token", token_type: "Bearer" });
    await p.saveTokens({
      access_token: "rotated-private-token",
      refresh_token: "private-refresh",
      token_type: "Bearer",
    });
    account.lock();
    assert.throws(() => p.tokens(), /Connect/);
    assert.equal(
      redact("late first-private-token rotated-private-token private-refresh"),
      "late [redacted] [redacted] [redacted]",
    );
  } finally {
    account.lock();
  }
});

test("disconnect revokes the tokens at the authorization server when it offers revocation, then forgets them (MCP-6)", async () => {
  const values = new Map<string, string>();
  const server = authServer({ revoke: true });
  const account = new McpOAuthAccount(
    "docs",
    "https://docs.example/mcp",
    memorySecretPort(values),
    () => {},
    async () => {},
    server.fetchImpl,
  );
  values.set(account.key, SAVED);
  await account.disconnect();
  assert.equal(values.size, 0, "the local record is gone");
  assert.deepEqual(server.revocations, [
    { token: "refresh-FAKE-token", token_type_hint: "refresh_token", client_id: "studio-client" },
    { token: "access-FAKE-token", token_type_hint: "access_token", client_id: "studio-client" },
  ]);
  assert.equal(account.state, "signed-out");
});

test("a server without revocation, or one whose revocation fails, still has the account forgotten here (MCP-6)", async () => {
  for (const options of [{ revoke: false }, { revoke: true, failRevoke: true }]) {
    const values = new Map<string, string>();
    const server = authServer(options);
    const account = new McpOAuthAccount(
      "docs",
      "https://docs.example/mcp",
      memorySecretPort(values),
      () => {},
      async () => {},
      server.fetchImpl,
    );
    values.set(account.key, SAVED);
    await account.disconnect();
    assert.equal(values.size, 0);
    assert.equal(server.revocations.length, options.revoke ? 2 : 0);
  }
});

test("removing an OAuth connector revokes its tokens even when it was never connected this session (MCP-6)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-mcp-revoke-"));
  const values = new Map<string, string>();
  const server = authServer({ revoke: true });
  const registry = new McpRegistry({
    file: path.join(root, "connectors.json"),
    secrets: memorySecretPort(values),
    fetchImpl: server.fetchImpl,
  });
  try {
    await registry.init();
    await registry.save({
      id: "docs",
      name: "Docs",
      transport: "http",
      url: "https://docs.example/mcp",
      authentication: "oauth",
      enabled: true,
      scope: "global",
      toolPolicy: {},
    });
    const key = new McpOAuthAccount(
      "docs",
      "https://docs.example/mcp",
      null,
      () => {},
      async () => {},
    ).key;
    values.set(key, SAVED);
    await registry.remove("docs");
    assert.equal(values.size, 0);
    assert.deepEqual(
      server.revocations.map((r) => r.token),
      ["refresh-FAKE-token", "access-FAKE-token"],
    );
  } finally {
    await registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("registers itself with an authorization server as Senex, the name the consent page shows", () => {
  const account = new McpOAuthAccount(
    "docs",
    "https://docs.example/mcp",
    memorySecretPort(new Map<string, string>()),
    () => {},
    async () => {},
    async () => {
      throw new Error("offline");
    },
  );
  assert.equal(account.provider().clientMetadata.client_name, "Senex");
});
