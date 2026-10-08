/** Studio's bundled transport for the main Genex creator MCP.
 * Writes stay on the existing host tools: they own delivery, recovery and publishing consent.
 * The remote connector adds discovery without a second login, CLI install or asset ledger.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SECOND_MS } from "../../shared/duration.ts";

export const CREATOR_ENDPOINT = "https://mcp.genex.games/mcp";
export const CREATOR_TOOLS = {
  search_games: "Search the published Genex project catalog for references and remixable projects.",
  search_animations:
    "Search Genex animations for action IDs. Apply them with Studio genex__asset character.animate or creature.animate; other Genex commands run through genex__cli.",
  my_games: "List projects owned by the connected Genex account, with their status and links.",
  generation_status:
    "Read an existing Genex generation or list recent generations. This does not deliver files to the project. Retrieve files with Studio genex__asset operation wait and the generation ID; never generate again to check progress.",
} as const;

const BRIDGE_VERSION = "1.4.2";
/** The credential pipe carries one token; anything past this is not a credential. */
const MAX_CREDENTIAL_BYTES = 65_536;
const LEGACY_TOKEN_PREFIX = "GENEX_TOKEN=";
const CONNECT_TIMEOUT_MS = 8 * SECOND_MS;
const LIST_TIMEOUT_MS = 8 * SECOND_MS;
const CALL_TIMEOUT_MS = 60 * SECOND_MS;
/** The SDK's reconnection settings; with no retries a dropped stream fails the call instead. */
const RECONNECTION = {
  initialReconnectionDelay: SECOND_MS,
  maxReconnectionDelay: 5 * SECOND_MS,
  reconnectionDelayGrowFactor: 2,
  maxRetries: 0,
} as const;
const REDACTED = "[redacted]";

const MESSAGE = {
  CredentialTooLarge: "Genex credential transport is too large.",
  NoCredential: "Connect or unlock Genex in Plugins to use the Genex MCP.",
  UnexpectedEndpoint: "Genex MCP requested an unexpected endpoint.",
  Redirected: "Genex MCP redirected the connection.",
  CannotConnect: "Cannot connect to Genex MCP. Check your connection and Genex account in Plugins.",
  CannotList: "Cannot list Genex MCP tools. Check your connection and Genex account in Plugins.",
  UseHostTools:
    "Use Studio genex__asset for generation, delivery and account status, or genex__publish for publishing.",
  ReadFailed: "Genex MCP could not complete this read. Check your connection and Genex account in Plugins, then retry.",
} as const;

/** Only the host's anonymous credential pipe is accepted (the bare token, or the older `GENEX_TOKEN=` line); no env/PATH/file fallback. */
export async function readCreatorCredential(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_CREDENTIAL_BYTES) throw new Error(MESSAGE.CredentialTooLarge);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  // Studio sends a `node` plugin server the bare token; the `GENEX_TOKEN=` line is the older framing.
  const match = /^(?:GENEX_TOKEN=)?([^\s\x00-\x1f]+)$/.exec(text);
  const token = match?.[1];
  if (!token || token === LEGACY_TOKEN_PREFIX) throw new Error(MESSAGE.NoCredential);
  return token;
}

const isRedirect = (status: number) => status >= 300 && status < 400;

/** A fetch that only ever reaches the creator endpoint, and refuses to follow a redirect. */
function pinnedFetch(fetchImpl: typeof fetch): typeof fetch {
  // A server-provided redirect or auth discovery URL must never receive the saved token.
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== CREATOR_ENDPOINT) throw new Error(MESSAGE.UnexpectedEndpoint);
    const response = await fetchImpl(input, { ...init, redirect: "error" });
    if (isRedirect(response.status)) throw new Error(MESSAGE.Redirected);
    return response;
  };
}

/** A tool answer the agent reads as a failure, never a thrown protocol error. */
const errorResult = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

/** Serve the allowed creator tools, with Studio's descriptions, from the connected client. */
function serveCreatorTools(server: Server, client: Client, redact: <T>(value: T) => T): void {
  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    try {
      const result = await client.listTools(request.params, { timeout: LIST_TIMEOUT_MS, signal: extra.signal });
      return redact({
        ...result,
        tools: result.tools
          .filter((tool) => Object.hasOwn(CREATOR_TOOLS, tool.name))
          .map((tool) => ({
            ...tool,
            description: CREATOR_TOOLS[tool.name as keyof typeof CREATOR_TOOLS],
          })),
      });
    } catch {
      throw new Error(MESSAGE.CannotList);
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (!Object.hasOwn(CREATOR_TOOLS, request.params.name)) return errorResult(MESSAGE.UseHostTools);
    try {
      return redact(
        await client.callTool(request.params, undefined, { timeout: CALL_TIMEOUT_MS, signal: extra.signal }),
      );
    } catch {
      return errorResult(MESSAGE.ReadFailed);
    }
  });
}

export async function createCreatorMcp(credential: string, fetchImpl: typeof fetch = fetch) {
  const client = new Client({ name: "genex-studio", version: BRIDGE_VERSION });
  const transport = new StreamableHTTPClientTransport(new URL(CREATOR_ENDPOINT), {
    requestInit: { headers: { Authorization: `Bearer ${credential}` } },
    fetch: pinnedFetch(fetchImpl),
    reconnectionOptions: { ...RECONNECTION },
  });
  const server = new Server({ name: "genex-creator", version: BRIDGE_VERSION }, { capabilities: { tools: {} } });
  const redact = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll(credential, REDACTED)) as T;
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  } catch {
    await client.close().catch(() => {});
    throw new Error(MESSAGE.CannotConnect);
  }
  serveCreatorTools(server, client, redact);
  return {
    server,
    close: async () => {
      await Promise.allSettled([server.close(), client.close()]);
    },
  };
}
