import { preflightMultiplayer } from "../core/generation-prerequisites.ts";
/** Harness RPC: plugin and MCP connector tools, and the capabilities a builder is told about. */
import { MCP_QUALIFIED_TOOL } from "../../shared/mcp.ts";
import { HostMethod, type HarnessHostHandlers } from "../../shared/harness-api.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { CONNECTOR_ARGS_CAP } from "../core/plugin-tools.ts";
import { CapabilityAudience } from "../planning-capabilities.ts";

/** Why a plugin or connector call from the harness is refused. */
const MESSAGE = {
  noProject: "Open a project first",
  argsNotObject: "Connector arguments must be a JSON object",
  argsNotJson: "Connector arguments must be JSON",
  argsTooLarge: "Connector arguments are too large",
  unknownConnectorTool: "Unknown connector tool",
} as const;

/** The engine the local harness's own plugin calls are recorded under. */
const LOCAL_HARNESS_ENGINE = "local";

/** The binding a plugin or connector call runs under; there is none until a project is open. */
async function requirePluginBinding(core: StudioCore, project: string, threadId: string | undefined) {
  const binding = await core.pluginBinding(project, threadId);
  if (!binding) throw new Error(MESSAGE.noProject);
  return binding;
}

/** A connector call's arguments, refused unless they are a JSON object within the size cap. */
function connectorArgs(raw: unknown): Record<string, unknown> {
  const args = raw ?? {};
  const isObject = typeof args === "object" && args !== null && !Array.isArray(args);
  if (!isObject) throw new Error(MESSAGE.argsNotObject);
  let encoded: string;
  try {
    encoded = JSON.stringify(args);
  } catch {
    throw new Error(MESSAGE.argsNotJson);
  }
  if (Buffer.byteLength(encoded ?? "", "utf8") > CONNECTOR_ARGS_CAP) throw new Error(MESSAGE.argsTooLarge);
  return args as Record<string, unknown>;
}

export function pluginsRpc(core: StudioCore, x: CoreInternals) {
  return {
    [HostMethod.PluginsPreflightMultiplayer]: (p) => preflightMultiplayer(core, p.project, p.threadId),
    // One snapshot, so the local harness's tools and their guidance describe the same plugins.
    [HostMethod.PluginsTools]: async () => {
      const { tools, guidance } = core.plugins.snapshot();
      return { tools, guidance, revision: x.toolRegistryRevision };
    },
    /** What this project's builders can use, for a conversation that cannot call it (the local coordinator). */
    [HostMethod.CapabilitiesDescribe]: async (p) =>
      (await x.capabilityFacts(p.threadId, p.project, CapabilityAudience.Conversation)).text,
    [HostMethod.PluginsInvoke]: async (p) => {
      const binding = await requirePluginBinding(core, p.project, p.threadId);
      // The local harness reaches plugins here; the same record pair is written so the ledger
      // reads the same whichever engine made the call.
      return x.pluginTools.invokePluginTool(p.name, p.args, binding, undefined, { engine: LOCAL_HARNESS_ENGINE });
    },
    // Connectors, for the local harness. Two methods and no more: an agent may see what is
    // connected and use it, and nothing here can add, change, enable or remove a connector —
    // that lives in the Studio UI, behind a native trust dialog.
    [HostMethod.McpTools]: async (p = {}) => {
      const tools = await core.mcp.toolsFor(p?.project ?? null);
      return { tools, guidance: core.mcp.guidance(tools), revision: x.toolRegistryRevision };
    },
    [HostMethod.McpInvoke]: async (p) => {
      // The name is checked here as well as in the registry: this is the doorway an agent
      // reaches, and `<connector>__<tool>` is the only shape that may pass through it.
      // The host tracks this call by its project/thread. Stop aborts local waiting even when
      // the editable harness is awaiting its result. Remote cancellation is server-dependent.
      if (typeof p?.name !== "string" || !MCP_QUALIFIED_TOOL.test(p.name))
        throw new Error(MESSAGE.unknownConnectorTool);
      const args = connectorArgs(p.args);
      const binding = await requirePluginBinding(core, p.project, p.threadId);
      return x.pluginTools.invokeConnectorTool(p.name, args, binding);
    },
  } satisfies Partial<HarnessHostHandlers>;
}
