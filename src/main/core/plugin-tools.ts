import { consentAudience, priorConsentDecline } from "./consent-audience.ts";
/**
 * Plugin and connector tools as agents call them: the consent a confirmed tool waits for, the
 * call itself with its durable record, and the MCP servers a plugin declares. Composed by
 * `StudioCore`; its state stays in the core.
 */
import { PluginConsentDeclined, type PluginMcpLaunch } from "../../substrate/plugins/registry.ts";
import { containedReal } from "../../substrate/paths.ts";
import { finishedPayload, roleOf, startedPayload } from "../plugin-activity.ts";
import type { PluginToolStartedPayload } from "../../shared/project-assets.ts";
import {
  type PluginBinding,
  type PluginConsentBy,
  type PluginConsentEvent,
  type PluginInfo,
  type PluginMcpServer,
  PLUGIN_SKILL_TOOL,
  PluginSourceKind,
  type PluginTool,
} from "../../shared/plugins.ts";
import type { McpPluginServer } from "../../substrate/mcp/registry.ts";
import type { McpLaunch } from "../../substrate/mcp/client.ts";
import { secretKey } from "../../substrate/mcp/store.ts";
import { genexTelemetryEnv } from "../../substrate/genex-telemetry.ts";
import { type ConnectorToolEvent, McpHealth, type McpChange } from "../../shared/mcp.ts";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { mkdir, writeFile } from "node:fs/promises";
import { shortId } from "../../substrate/ids.ts";
import type { LiveToolResult } from "../../substrate/engines/types.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { errorMessage } from "../../shared/errors.ts";
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { UiEvent } from "../../shared/ui-events.ts";

/** Nine minutes: under the Codex bridge's 600 s tool ceiling, so a slow answer still reaches the engine as "declined". */
export const CONSENT_TIMEOUT_MS = 9 * MINUTE_MS;

/** The consent card shows 120 characters of the arguments; the thread keeps this much of them, forever. */
export const CONSENT_ARGS_MAX = 2000;

/** How much of a connector's answer the thread event keeps. The log is a story, not a cache. */
export const CONNECTOR_RESULT_CAP = 4096;

/** An agent may send a connector a big argument, but not an unbounded one. */
export const CONNECTOR_ARGS_CAP = 256 * 1024;

/** The CLI's virtual env path; `src/genex-host/preload.mjs` serves the sign-in record beside it. */
export const GENEX_CREDENTIAL_PATH = "/__studio_genex_credentials__";
/** Where a `node` plugin server reads its bare account token: the pipe itself. */
export const PLUGIN_CREDENTIAL_FD = "/dev/fd/3";

/** A project name, as every path-joining site in this file spells it. */
export const PLUGIN_MCP_PROJECT = /^[a-zA-Z0-9_-]{1,100}$/;

/** The folder a plugin server with no project of its own works in, beside the per-project ones. */
export const PLUGIN_MCP_SHARED = "_shared";

/** Why a plugin's MCP server cannot start, as the connector panel and the agent read it. */
const MESSAGE = {
  exportConfirmation: "Review the files that will be uploaded. Approve only if this staged copy is ready to share.",
  connectorConversation: "Connector calls require a project conversation for consent",
  connectorConfirmation: "Allow this connector action? It may read or change data in the connected service.",
  unlockFirst: "Unlock this plugin's account first.",
  setSettingFirst: (key: string) => `Set "${key}" in this plugin's settings first.`,
  bundledOnly: "Only the bundled plugin may start a program Studio ships",
  inPlan:
    "The chat is in Plan mode, so this action did not run: plugin and connector actions wait until the plan is approved. Put it in your plan instead.",
} as const;

/** What a plugin call the chat's Plan mode held back answers the agent with. */
const PLAN_BLOCKER = "plan_mode";

/** The plugin whose MCP server is Studio's own Genex CLI, seeded with a tools workspace. */
const GENEX_PLUGIN_ID = "genex";

/** A manifest env source (`PluginMcpEnvValue`): its prefix, and what follows it. */
const ENV_SOURCE = {
  CredentialFile: "credential-file",
  Literal: "literal:",
  Setting: "setting:",
  Secret: "secret:",
} as const;

/** Who made a plugin call: its engine, the run session it works for, and whether it is a build's lead's. */
export interface PluginCallContext {
  engine: string;
  selfCapture?: { runId?: string; facetId?: string; iteration?: number } | null;
  director?: { runId?: string } | null;
  /**
   * A build's lead's call, the chat's main agent's: its consent card outlives the chat's turns, as
   * its tool permission cards do, and is asked each time, never answered by an earlier decline in
   * its run, as the chat's own session's.
   */
  lead?: boolean;
}

export class PluginToolService {
  readonly #core: StudioCore;
  readonly #x: Pick<
    CoreInternals,
    "activeConnectorCalls" | "consent" | "mcpSecrets" | "planning" | "pluginCallAttribution"
  >;

  constructor(
    core: StudioCore,
    x: Pick<CoreInternals, "activeConnectorCalls" | "consent" | "mcpSecrets" | "planning" | "pluginCallAttribution">,
  ) {
    this.#core = core;
    this.#x = x;
  }

  // ── plugin consent ───────────────────────────────────────────────────────────────────────
  /**
   * An agent asked to run a plugin tool the manifest marks `confirmation`. The question goes
   * into the thread's log as a `plugin_consent` card, the UI is nudged, and the call waits for
   * the user's answer (or the timeout, the turn's end, or Stop); the answer is logged the same
   * way. The registry calls this through `plugins.consent`; nothing an engine can reach does.
   */
  async requestConsent(
    pluginId: string,
    tool: PluginTool,
    args: Record<string, unknown>,
    binding: PluginBinding,
    signal?: AbortSignal,
    exportReview?: PluginConsentEvent["exportReview"],
  ): Promise<{ approved: boolean; by: PluginConsentBy }> {
    const consentId = shortId("consent");
    const attribution = this.#x.pluginCallAttribution.get(binding);
    const threadId = await consentAudience(this.#core, binding, attribution?.runId);
    const name = `${pluginId}__${tool.name}`;
    const declined = await this.#declinedBefore(attribution, threadId, name, args);
    if (declined) return declined;
    const pluginName = this.#pluginName(pluginId);
    const base = {
      consentId,
      pluginId,
      pluginName,
      tool: name,
      args: consentArgsDigest(args),
      project: binding.project,
      ...(binding.threadId ? { threadId: binding.threadId } : {}),
      ...(binding.threadId && threadId !== binding.threadId ? { originThreadId: binding.threadId } : {}),
      ...(attribution?.runId ? { runId: attribution.runId } : {}),
      ...(attribution?.facetId ? { facetId: attribution.facetId } : {}),
      prompt: tool.confirmation ?? "",
      ...(exportReview ? { exportReview } : {}),
    };
    const asked: PluginConsentEvent = {
      ...base,
      state: "pending",
      expiresAt: Date.now() + (this.#core.options.consentTimeoutMs ?? CONSENT_TIMEOUT_MS),
    };
    const waitStarted = performance.now();
    const waiting = this.#x.consent.request({
      consentId,
      pluginId,
      tool: name,
      project: binding.project,
      ...(binding.threadId ? { threadId: binding.threadId } : {}),
      ...(signal ? { signal } : {}),
      // A build's lead is not the chat's turn: another turn ending leaves its question waiting.
      ...(attribution?.lead ? { outlivesTurn: true } : {}),
    });
    try {
      await this.#core.append([customEventData(CustomEvent.PluginConsent, { ...asked })], threadId);
      this.#core.emit(UiEvent.PluginConsent, {
        consentId,
        threadId,
        project: binding.project,
        state: asked.state,
      });
    } catch (error) {
      this.#x.consent.resolve(consentId, false);
      await waiting;
      throw error;
    }
    const result = await waiting;
    const answered: PluginConsentEvent = {
      ...base,
      state: result.approved ? "approved" : "declined",
      by: result.by,
      durationMs: performance.now() - waitStarted,
    };
    await this.#core.append([customEventData(CustomEvent.PluginConsent, { ...answered })], threadId);
    this.#core.emit(UiEvent.PluginConsent, {
      consentId,
      threadId,
      project: binding.project,
      state: answered.state,
    });
    return result;
  }

  /**
   * The answer a run's session already gave: declined once, it is not asked again until the run is
   * resumed. A build's lead, the chat's main agent, is asked each time, as the chat's own session is.
   */
  async #declinedBefore(
    attribution: { runId?: string; lead?: boolean } | undefined,
    threadId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ approved: boolean; by: PluginConsentBy } | null> {
    if (attribution?.lead) return null;
    return priorConsentDecline(this.#core, threadId, attribution?.runId, name, consentArgsDigest(args));
  }

  /**
   * Whether the chat a call answers to — the chat itself, or the chat a run's call reports to —
   * is in Plan mode.
   */
  async #planning(project: string, threadId: string | undefined, runId?: string): Promise<boolean> {
    if (!threadId) return false;
    const binding: PluginBinding = { project, directory: this.#core.projects.dirFor(project), threadId };
    return this.#x.planning(await consentAudience(this.#core, binding, runId));
  }

  /** The name a consent card shows: the connector's or plugin's own, else its id. */
  #pluginName(pluginId: string): string {
    return (
      this.#core.mcp.nameOf(pluginId) ??
      this.#core.plugins.list().find((p) => p.manifest.id === pluginId)?.manifest.name ??
      pluginId
    );
  }

  /** A plugin gets the staged public copy only after the person reviews its exact file set. */
  async reviewExport(
    pluginId: string,
    binding: PluginBinding,
    result: { included: string[]; excluded: string[] },
  ): Promise<void> {
    const tool: PluginTool = {
      name: "export_review",
      description: MESSAGE.exportConfirmation,
      confirmation: MESSAGE.exportConfirmation,
      parameters: { type: "object", properties: {} },
    };
    const review = { included: [...result.included].sort(), excluded: [...result.excluded].sort() };
    const grant = await this.requestConsent(pluginId, tool, { files: review.included }, binding, undefined, review);
    if (!grant.approved) throw new PluginConsentDeclined(tool.name, grant.by);
  }

  /**
   * Run a plugin tool for an agent, on either path (an engine's live tool or the harness's
   * `plugins.invoke`). The host writes the `plugin_tool_started` / `plugin_tool` pair around the
   * call so the chat and the Builds graph see it start and end; a declined consent is an answer
   * the agent can read, never an error.
   */
  async invokePluginTool(
    name: string,
    args: Record<string, unknown>,
    binding: PluginBinding,
    signal: AbortSignal | undefined,
    ctx: PluginCallContext,
  ): Promise<unknown> {
    const runId = this.#x.pluginCallAttribution.get(binding)?.runId;
    if (!readsSkill(name) && (await this.#planning(binding.project, binding.threadId, runId)))
      return { consent: "declined", blocker: PLAN_BLOCKER, message: MESSAGE.inPlan };
    const started = await this.pluginToolStarted(name, args, binding, ctx);
    let result: unknown;
    try {
      result = await this.#core.plugins.tool(name, args, binding, signal);
    } catch (err) {
      await this.pluginToolFinished(started, { error: err }, 0, binding);
      if (err instanceof PluginConsentDeclined)
        return {
          consent: "declined",
          blocker: "approval_required",
          by: err.by,
          message: CONSENT_DECLINED_MESSAGES[err.by],
        };
      throw err;
    }
    // Counted before the bytes are split off downstream: the record that reaches the log never holds them.
    const returned = (result as { images?: unknown } | null)?.images;
    const count = Array.isArray(returned) ? returned.length : 0;
    await this.pluginToolFinished(started, { result }, count, binding);
    return result;
  }

  /**
   * Run one connector tool for an agent, on either path (an engine's live tool or the harness's
   * `mcp.invoke`), and write the `connector_tool` record either way. It is its own event: a
   * connector is not a plugin, it reaches a service outside this Mac, and reusing `plugin_tool`
   * would put a name in the ledger that no installed plugin answers to.
   *
   * The record holds what the call was and how it ended — never the bytes. Image parts are
   * counted; the answer's text is cut to 4 KiB, because a log is a story, not a cache. A build's
   * lead's call outlives the chat's turns (`outlivesTurn`): its session's end or a Stop ends it.
   */
  async invokeConnectorTool(
    name: string,
    args: Record<string, unknown>,
    binding: { project?: string | null; threadId?: string } | undefined,
    signal?: AbortSignal,
    { outlivesTurn = false }: { outlivesTurn?: boolean } = {},
  ): Promise<LiveToolResult> {
    const started = Date.now();
    const controller = new AbortController();
    this.#x.activeConnectorCalls.set(controller, { ...binding, ...(outlivesTurn ? { outlivesTurn } : {}) });
    const callSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const connectorId = name.slice(0, Math.max(0, name.indexOf("__")));
    const exposedName = name.slice(connectorId.length + 2);
    const write = async (event: ConnectorToolEvent): Promise<void> => {
      // Bookkeeping never fails a tool call: a log that cannot be written loses the record, not the work.
      await this.#core
        .append([customEventData(CustomEvent.ConnectorTool, { ...event })], binding?.threadId)
        .catch(() => {});
    };
    try {
      await this.#connectorConsent(name, args, binding, callSignal, outlivesTurn);
      const result = await this.#core.mcp.tool(name, args, binding, callSignal);
      const text = typeof result === "string" ? result : result.text;
      const images = typeof result === "string" ? 0 : (result.images?.length ?? 0);
      await write({
        connectorId,
        tool: this.#core.mcp.rawName(name) ?? exposedName,
        exposedName,
        ok: true,
        durationMs: Date.now() - started,
        result: String(text ?? "").slice(0, CONNECTOR_RESULT_CAP),
        ...(images ? { images } : {}),
      });
      return result;
    } catch (err) {
      await write({
        connectorId,
        tool: this.#core.mcp.rawName(name) ?? exposedName,
        exposedName,
        ok: false,
        durationMs: Date.now() - started,
        error: String(errorMessage(err)).slice(0, CONNECTOR_RESULT_CAP),
      });
      throw err;
    } finally {
      this.#x.activeConnectorCalls.delete(controller);
    }
  }

  /**
   * The person's say before a connector action nobody saved "always allow" for. A build's lead's
   * card outlives the chat's other turns (`outlivesTurn`), as its call does.
   */
  async #connectorConsent(
    name: string,
    args: Record<string, unknown>,
    binding: { project?: string | null; threadId?: string } | undefined,
    signal: AbortSignal,
    outlivesTurn: boolean,
  ): Promise<void> {
    if (!binding?.project) throw new Error(MESSAGE.connectorConversation);
    // Before any saved grant: "always allow" is for work the person approved, and a plan is not yet.
    if (await this.#planning(binding.project, binding.threadId)) throw new Error(MESSAGE.inPlan);
    if (await this.#core.mcp.toolAutoApproved(name, binding.project, signal)) return;
    const split = name.indexOf("__");
    const tool: PluginTool = {
      name: name.slice(split + 2),
      description: "Connector action",
      parameters: { type: "object", properties: {} },
      confirmation: MESSAGE.connectorConfirmation,
    };
    const asking: PluginBinding = {
      project: binding.project,
      directory: this.#core.projects.dirFor(binding.project),
      ...(binding.threadId ? { threadId: binding.threadId } : {}),
    };
    if (outlivesTurn) this.#x.pluginCallAttribution.set(asking, { lead: true });
    const grant = await this.requestConsent(name.slice(0, split), tool, args, asking, signal);
    if (!grant.approved) throw new PluginConsentDeclined(name, grant.by);
  }

  /**
   * Publish one plugin's declared MCP servers as connectors that plugin owns.
   *
   * The manifest names sources, never values, and this is where they become a launch: a script
   * inside the package (or the one CLI Studio itself ships) run as `process.execPath` with
   * `ELECTRON_RUN_AS_NODE`, because a packaged app has no `node` on its PATH; a working directory
   * under the plugin's own storage, never the package, which an update replaces; a `HOME` inside
   * that directory, so a CLI's startup cannot reach the user's own dotfiles; and an environment
   * holding only what the manifest asked for.
   *
   * A credential never travels in that environment. `credential-file` sends it down an anonymous
   * pipe on fd 3, read at the moment the child starts — so a plugin locked or disconnected since
   * it was registered gets an empty pipe rather than a live token. A `node` server gets the bare
   * token and `/dev/fd/3` as the variable; Studio's own Genex CLI (`host-cli`) gets the
   * `GENEX_TOKEN=` line and the virtual path its preload answers.
   *
   * A server whose requirements are not met is published switched off with the reason on it.
   * Listing it is the point: the user can see what is missing and finish it.
   */
  async registerPluginMcpServers(pluginId: string, servers: PluginMcpServer[], launch: PluginMcpLaunch): Promise<void> {
    // Replace the plugin's whole set: a manifest that dropped a server must not leave it running.
    await this.#core.mcp.unregisterPlugin(pluginId);
    const installed = this.#core.plugins.list().find((p) => p.manifest.id === pluginId);
    const pluginName = installed?.manifest.name ?? pluginId;
    const settings = await launch.settings().catch(() => ({}) as Record<string, unknown>);
    const unlocked = (await launch.credential().catch(() => undefined)) !== undefined;
    for (const server of servers) {
      try {
        await this.#core.mcp.registerPluginServer(
          pluginId,
          await this.pluginMcpDefinition(pluginName, installed?.source, server, launch, settings, unlocked),
          this.pluginMcpLaunch(pluginId, server, launch),
        );
      } catch (error) {
        // A tool source that did not appear is not a silent non-event: it is logged and the card
        // hears about it, so a server missing from the list has a reason a person can read.
        const message = errorMessage(error);
        this.#core.options.onLog?.(
          `[core] plugin ${pluginId}: MCP server ${server.id} was not published — ${message}`,
          "stderr",
        );
        this.#core.emit(UiEvent.McpChanged, {
          id: `${pluginId}-${server.id}`,
          health: McpHealth.Failed,
          error: message,
        } satisfies McpChange);
      }
    }
  }

  async pluginMcpDefinition(
    pluginName: string,
    source: PluginInfo["source"] | undefined,
    server: PluginMcpServer,
    launch: PluginMcpLaunch,
    settings: Record<string, unknown>,
    unlocked: boolean,
  ): Promise<McpPluginServer> {
    let unavailable: string | undefined;
    if (server.requires?.credential && !unlocked) unavailable = MESSAGE.unlockFirst;
    for (const key of server.requires?.settings ?? []) {
      const value = settings[key];
      if (value === undefined || value === "") unavailable ??= MESSAGE.setSettingFirst(key);
    }
    // `node` runs a script the package contains, resolved through the same containment check an
    // install uses; `host-cli` runs Studio's own Genex CLI behind the preload that feeds it fd 3.
    // The manifest validator reserves `host-cli` for the id `genex`; an id is not a provenance, so
    // the code that actually starts it asks where the package came from as well.
    if (server.command !== "node" && source !== PluginSourceKind.Bundled) throw new Error(MESSAGE.bundledOnly);
    const args = await pluginMcpArgs(server, launch.packageDir);
    return {
      id: server.id,
      name: `${pluginName} · ${server.id}`,
      // The digest the plugin's install dialog stands behind covers exactly this.
      command: process.execPath,
      args,
      ...(server.toolPolicy ? { toolPolicy: server.toolPolicy } : {}),
      ...(server.maxTools ? { maxTools: server.maxTools } : {}),
      ...(server.callTimeoutMs ? { callTimeoutMs: server.callTimeoutMs } : {}),
      description: server.description,
      ...(unavailable ? { unavailable } : {}),
    };
  }

  pluginMcpLaunch(pluginId: string, server: PluginMcpServer, launch: PluginMcpLaunch): McpLaunch {
    const wantsCredential = Object.values(server.env ?? {}).includes(ENV_SOURCE.CredentialFile);
    const credentialPipe: Pick<McpLaunch, "extraStdio" | "stdioExtra"> = {
      extraStdio: ["pipe"],
      stdioExtra: (child: ChildProcess) => {
        const pipe = child.stdio[3] as Writable | null;
        if (!pipe) return;
        pipe.on("error", () => {
          /* the child may exit before it reads; that is not our failure */
        });
        // Read at the moment the child starts, so a plugin locked or disconnected since it was
        // published closes the pipe empty instead of handing over a live token.
        const content = server.command === "node" ? launch.credential() : launch.credentialFile();
        void content.then(
          (value) => pipe.end(value ?? ""),
          () => pipe.end(""),
        );
      },
    };
    return {
      execPath: process.execPath,
      perProject: server.cwd === "storage:project",
      resolve: async (project) => {
        const dir =
          server.cwd === "storage:project"
            ? await launch.projectStorage(project && PLUGIN_MCP_PROJECT.test(project) ? project : PLUGIN_MCP_SHARED)
            : path.join(await launch.storageRoot(), "mcp");
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const home = path.join(dir, "home");
        await mkdir(home, { recursive: true, mode: 0o700 });
        if (pluginId === GENEX_PLUGIN_ID) {
          // A tools workspace, exactly as the asset adapter seeds one: the CLI then keeps its own
          // bookkeeping here instead of in the project folder or the user's home.
          await mkdir(path.join(dir, ".genex"), { recursive: true, mode: 0o700 });
          await writeFile(
            path.join(dir, ".genex", "workspace.json"),
            `${JSON.stringify({ mode: "tools", version: 1 })}\n`,
          );
        }
        const env = await this.pluginMcpEnv(pluginId, server, launch);
        // Everything secret this start hands the child, so the connection takes it back out of
        // whatever the server answers (SEC-4): stored `secret:` values and the account token.
        const secrets = Object.entries(server.env ?? {}).flatMap(([name, source]) =>
          source.startsWith(ENV_SOURCE.Secret) && env[name] ? [env[name]] : [],
        );
        const token = wantsCredential ? await launch.credential().catch(() => undefined) : undefined;
        if (token) secrets.push(token);
        return { cwd: dir, extraEnv: { ...env, HOME: home }, ...(secrets.length ? { secrets } : {}) };
      },
      ...(wantsCredential ? credentialPipe : {}),
    };
  }

  /**
   * The manifest's env sources turned into values, at the moment the child starts. Studio's own
   * Genex CLI (`host-cli`) also gets the asset adapter's telemetry rule: crash reporting off
   * unless the user turned it on. The manifest's own entries come after, as it declared them.
   */
  async pluginMcpEnv(
    pluginId: string,
    server: PluginMcpServer,
    launch: PluginMcpLaunch,
  ): Promise<Record<string, string>> {
    // A packaged app's `process.execPath` is Electron; without this it would launch a second app.
    const env: Record<string, string> = {
      ELECTRON_RUN_AS_NODE: "1",
      NO_COLOR: "1",
      ...(server.command === "host-cli" ? genexTelemetryEnv(process.env) : {}),
    };
    const settings = await launch.settings().catch(() => ({}) as Record<string, unknown>);
    for (const [name, source] of Object.entries(server.env ?? {})) {
      const value = await this.#envValue(pluginId, server, source, settings);
      if (value !== null) env[name] = value;
    }
    return env;
  }

  /** One manifest env source's value at start, or null when it has none to give. */
  async #envValue(
    pluginId: string,
    server: PluginMcpServer,
    source: string,
    settings: Record<string, unknown>,
  ): Promise<string | null> {
    if (source === ENV_SOURCE.CredentialFile)
      return server.command === "node" ? PLUGIN_CREDENTIAL_FD : GENEX_CREDENTIAL_PATH;
    if (source.startsWith(ENV_SOURCE.Literal)) return source.slice(ENV_SOURCE.Literal.length);
    if (source.startsWith(ENV_SOURCE.Setting)) {
      const value = settings[source.slice(ENV_SOURCE.Setting.length)];
      return value !== undefined && value !== "" ? String(value) : null;
    }
    const stored = await this.#x.mcpSecrets
      ?.get(secretKey(`${pluginId}-${server.id}`, "env", source.slice(ENV_SOURCE.Secret.length)))
      .catch(() => null);
    return stored || null;
  }

  /**
   * One plugin tool call, opened. Every engine path goes through here — the delegated ones from
   * `onLiveTool`, the local harness from the `plugins.invoke` RPC — so the log holds the same
   * pair whoever asked. `runId`/`facetId`/`iteration` sit at the payload's top level because the
   * Builds graph drops any custom event whose top-level `runId` is not the run's.
   */
  async pluginToolStarted(
    name: string,
    args: Record<string, unknown>,
    binding: PluginBinding,
    ctx: PluginCallContext,
  ): Promise<{ callId: string; startedAt: number; payload: PluginToolStartedPayload }> {
    const [pluginId = "", tool = ""] = name.split("__");
    const installed = this.#core.plugins.list().find((p) => p.manifest.id === pluginId);
    // The same order the Blender record uses: the worker that owns the worktree first, then the
    // modelling ask, then the director's own session.
    const sources = [ctx.selfCapture, ctx.director].filter(
      (s): s is { runId?: string; facetId?: string; iteration?: number } => !!s,
    );
    const asked = sources.find((s) => typeof s.runId === "string" && s.runId) ?? null;
    const payload = startedPayload({
      pluginId,
      pluginName: installed?.manifest.name ?? pluginId,
      tool,
      toolName: name,
      args,
      project: binding.project,
      ...(binding.threadId ? { threadId: binding.threadId } : {}),
      ...(asked?.runId ? { runId: asked.runId } : {}),
      ...(asked?.facetId ? { facetId: asked.facetId } : {}),
      ...(asked?.iteration !== undefined ? { iteration: asked.iteration } : {}),
      engine: ctx.engine,
      role: roleOf({
        ...(ctx.director ? { director: ctx.director } : {}),
        ...(ctx.selfCapture ? { selfCapture: ctx.selfCapture } : {}),
      }),
    });
    if (asked || ctx.lead)
      this.#x.pluginCallAttribution.set(binding, { ...asked, ...(ctx.lead ? { lead: true } : {}) });
    // Bookkeeping never fails a tool call: a log that cannot be written loses the record, not the work.
    await this.#core
      .append([customEventData(CustomEvent.PluginToolStarted, { ...payload })], binding.threadId)
      .catch(() => {});
    return { callId: payload.callId, startedAt: Date.now(), payload };
  }

  /** The same call, closed: what it answered or what it threw, with the image count taken before the bytes were stripped. */
  async pluginToolFinished(
    started: { startedAt: number; payload: PluginToolStartedPayload },
    outcome: { result: unknown } | { error: unknown },
    images: number,
    binding?: PluginBinding,
  ): Promise<void> {
    if (binding) this.#x.pluginCallAttribution.delete(binding);
    const version = this.#core.plugins.list().find((p) => p.manifest.id === started.payload.pluginId)?.manifest.version;
    const payload = finishedPayload(
      started.payload,
      { ...outcome, ...(version ? { version } : {}) },
      images,
      Date.now() - started.startedAt,
    );
    await this.#core
      .append([customEventData(CustomEvent.PluginTool, { ...payload })], started.payload.threadId)
      .catch(() => {});
  }
}

/**
 * What the plugin was asked to do, clipped. The call itself still receives the arguments in full —
 * this is only the durable record, and a tool argument can be a whole prompt or a base64 payload,
 * which has no business sitting in the thread log at its original size.
 */
export function consentArgsDigest(args: Record<string, unknown>): Record<string, unknown> {
  const digest: Record<string, unknown> = {};
  let left = CONSENT_ARGS_MAX;
  for (const [key, value] of Object.entries(args)) {
    if (left <= 0) {
      digest["…"] = "clipped";
      break;
    }
    const encoded = typeof value === "string" ? value : JSON.stringify(value);
    const text = typeof encoded === "string" ? encoded : String(value);
    const room = Math.max(1, left - key.length);
    digest[key] = text.length > room ? `${text.slice(0, room - 1)}…` : text;
    left -= key.length + Math.min(text.length, room);
  }
  return digest;
}

/** A plugin's skill tool: reading how to use the plugin is planning, never an action. */
function readsSkill(name: string): boolean {
  return name.slice(name.indexOf("__") + 2) === PLUGIN_SKILL_TOOL;
}

/** What the agent reads when its plugin request was not approved — an answer, never an error. */
export const CONSENT_DECLINED_MESSAGES: Record<PluginConsentBy, string> = {
  user: "The user declined this request. Do not retry unless they ask.",
  timeout: `Nobody answered within ${CONSENT_TIMEOUT_MS / MINUTE_MS} minutes; the request was declined. Ask the user before trying again.`,
  stop: "The turn was stopped before the user answered.",
  turn: "The turn was stopped before the user answered.",
  restart: "The studio restarted before the user answered. Ask again before trying this action.",
};

export const requireFromHere = createRequire(import.meta.url);

/**
 * How a plugin MCP server starts: a `node` server runs the package's own script (resolved through
 * the containment check an install uses), `host-cli` runs Studio's Genex CLI behind its preload.
 */
async function pluginMcpArgs(server: PluginMcpServer, packageDir: string): Promise<string[]> {
  if (server.command === "node") {
    const [script = "", ...rest] = server.args;
    return [await containedReal(packageDir, script), ...rest];
  }
  // A file URL: on Windows Node reads a bare `C:\…` after --import as a URL with the scheme `c:`.
  const preload = pathToFileURL(await containedReal(packageDir, "preload.mjs")).href;
  return ["--import", preload, genexCliPath(packageDir), ...server.args];
}

/**
 * The Genex CLI, resolved the way the asset adapter resolves it: the plugin's own copy when the
 * package ships one, Studio's otherwise, and rewritten out of the asar either way — a packaged
 * app cannot spawn a file that only exists inside the archive.
 */
export function genexCliPath(packageDir: string): string {
  let pkg: string;
  try {
    pkg = createRequire(path.join(packageDir, "package.json")).resolve("@genex-ai/cli-demo/package.json");
  } catch {
    pkg = requireFromHere.resolve("@genex-ai/cli-demo/package.json");
  }
  return path.join(path.dirname(pkg), "dist/index.js").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
}
