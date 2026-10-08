/** Test-owned production ChatPanel across provider authentication transitions. */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ChatPanel } from "../../src/renderer/panels/ChatPanel.tsx";
import type { ChatPanelProps } from "../../src/renderer/chat/chat-panel-props.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { EventKind, ThreadKind, type EventEnvelope } from "../../src/shared/event-log.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing fixture root");
const root = createRoot(rootElement);
const noop = () => {};
const date = "2026-09-29T00:00:00.000Z";
let sequence = 0;
function event(eventType: string, runId = "run_stop", payload = {}): EventEnvelope {
  return {
    id: `e${String(++sequence).padStart(4, "0")}`,
    thread_id: "auth-thread",
    session_id: null,
    turn_id: null,
    created_at: date,
    data: { type: EventKind.Custom, event_type: eventType, payload: { runId, project: "auth-project", ...payload } },
  };
}
const fake = fakeStudioApi();
window.studio = fake.api;
const props: ChatPanelProps = {
  events: [],
  stateEvents: [],
  history: { hasMore: false, paging: false, loadEarlier: async () => {} },
  engines: [],
  projects: [],
  activeThread: {
    id: "auth-thread",
    agent_id: "studio",
    created_at: date,
    updated_at: date,
    latest_event_id: null,
    metadata: { kind: ThreadKind.Project, project: "auth-project" },
  },
  status: "idle",
  busySince: null,
  loading: false,
  sidebarHidden: false,
  onRetryLoad: noop,
  onToggleSidebar: noop,
  onEnginesRefresh: noop,
  onRename: noop,
  onNotice: noop,
  onSend: async () => {},
};
function render(events: EventEnvelope[], status = "idle", threadId = "auth-thread") {
  const activeThread = props.activeThread ? { ...props.activeThread, id: threadId } : null;
  flushSync(() =>
    root.render(
      <ChatPanel {...props} activeThread={activeThread} events={events} stateEvents={events} status={status} />,
    ),
  );
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const settle = async () => {
  for (let i = 0; i < 12; i++) await frame();
};
const models = ["astra", "sol", "luna"].map((name) => ({
  id: `gpt-6-${name}`,
  label: `GPT-6 ${name}`,
  contextWindow: 200000,
  supportsTools: true,
  supportsVision: true,
}));
const engine = {
  id: "codex",
  label: "Codex",
  kind: "delegated" as const,
  status: { code: "ready" as const, detail: "Fixture" },
  models,
  defaultModel: null,
  supportsSessions: true,
};
async function runAuthChecks() {
  flushSync(() => root.render(null));
  localStorage.setItem("studio.model.auth-thread", "codex::gpt-6-sol");
  localStorage.setItem("studio.model.last", "codex::gpt-6-sol");
  props.engines = [engine];
  render([]);
  await settle();
  const label = () => document.querySelector('[aria-label="Model settings"]')?.textContent;
  const before = label();
  props.engines = [{ ...engine, status: { code: "needs_login", detail: "Synthetic authentication failure" } }];
  const failure = event(CustomEvent.NeedsSignin, "", { engine: "codex", message: "Synthetic 401" });
  const reply: EventEnvelope = {
    ...failure,
    id: "e9999",
    data: {
      type: EventKind.Messages,
      messages: [{ role: "assistant", content: "Codex needs you to sign in again. Your project is still here." }],
    },
  };
  render([failure, reply]);
  await settle();
  const blocked = label();
  document.querySelector<HTMLButtonElement>('[aria-label="Model settings"]')?.click();
  await settle();
  document.querySelector<HTMLButtonElement>('[data-role="planner"]')?.click();
  await settle();
  const choices = [...document.querySelectorAll<HTMLButtonElement>("[data-model-choice]")].map((button) => ({
    key: button.dataset.modelChoice,
    disabled: button.disabled,
  }));
  const text = document.body.textContent ?? "";
  props.engines = [engine];
  render([failure, reply]);
  await settle();
  return { before, blocked, choices, text, recovered: label() };
}
Object.assign(window, { runAuthChecks });

import { ModelProvidersSection } from "../../src/renderer/panels/ModelsSection.tsx";
import { ModelCatalogState, ModelCatalogSource } from "../../src/shared/model-catalog.ts";
import type { EngineDescriptor } from "../../src/shared/engine-descriptor.ts";
async function runCatalogChecks() {
  flushSync(() => root.render(null));
  const claude: EngineDescriptor = { ...engine, id: "claude-code", label: "Claude Code", account: { source: "system", afterSignOut: "signed-out", cli: { state: "ready", version: "fixture", path: "/fixture/claude" } }, catalog: { state: ModelCatalogState.Loading, revision: 0, refreshing: true }, models: [{ id: "default", label: "Claude Code default", contextWindow: 0, supportsTools: true, supportsVision: true }] };
  const settings = () => flushSync(() => root.render(<ModelProvidersSection engines={[claude]} onEnginesRefresh={noop} />));
  settings(); await settle();
  const loading = document.querySelector('[data-model-catalog="claude-code"]')?.textContent;
  claude.catalog = { state: ModelCatalogState.Ready, revision: 1, refreshing: false, source: ModelCatalogSource.Provider, refreshedAt: Date.now() };
  claude.models.push({ id: "sonnet", label: "Sonnet 5.5", resolvedModel: "claude-sonnet-5-5", contextWindow: 0, supportsTools: true, supportsVision: true });
  settings(); await settle();
  const readyLine = document.querySelector('[data-model-catalog="claude-code"]')?.textContent ?? null;
  document.querySelector('[aria-label="Claude Code account"]')?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  await settle();
  const update = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.startsWith("Update Claude Code"));
  const updateAvailable = !!update && update.dataset.disabled === undefined;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await settle();
  claude.catalog = { ...claude.catalog, state: ModelCatalogState.Stale, problem: { code: "timeout", message: "Model discovery timed out. Try again." } };
  settings(); await settle();
  const stale = document.body.textContent;
  const staleDetail = document.querySelector('[data-model-catalog="claude-code"] [title]')?.getAttribute("title") ?? null;
  flushSync(() => root.render(null));
  localStorage.setItem("studio.model.auth-thread", "claude-code::sonnet");
  localStorage.setItem("studio.model.last", "claude-code::sonnet");
  props.engines = [claude, { ...engine, models: [...models, { ...models[0], id: "gpt-6.1-sol", label: "GPT-6.1 Sol" }] }];
  render([]); await settle();
  const aliasBefore = document.querySelector('[aria-label="Model settings"]')?.textContent;
  claude.models = claude.models.map((model) => model.id === "sonnet" ? { ...model, label: "Sonnet Future", resolvedModel: "claude-sonnet-future" } : model);
  claude.catalog = { ...claude.catalog, state: ModelCatalogState.Ready, revision: 2, problem: undefined };
  props.engines = [claude, ...props.engines.slice(1)]; render([]); await settle();
  const aliasAfter = document.querySelector('[aria-label="Model settings"]')?.textContent;
  document.querySelector<HTMLButtonElement>('[aria-label="Model settings"]')?.click(); await settle();
  document.querySelector<HTMLButtonElement>('[data-role="planner"]')?.click(); await settle();
  const keys = [...document.querySelectorAll<HTMLElement>("[data-model-choice]")].map((row) => row.dataset.modelChoice);
  return { loading, readyLine, stale, staleDetail, updateAvailable, aliasBefore, aliasAfter, keys, stored: localStorage.getItem("studio.model.auth-thread") };
}
Object.assign(window, { runCatalogChecks });

import { studio } from "../../src/renderer/state/studio.ts";
const ready = { code: "ready" as const, detail: "Fixture" };
const cli = (path: string) => ({ source: "system" as const, afterSignOut: "signed-out" as const, cli: { state: "ready" as const, version: "fixture", path } });
const catalogReady = { state: ModelCatalogState.Ready, revision: 1, refreshing: false, source: ModelCatalogSource.Provider, refreshedAt: Date.now() };
const listed = (id: string, label: string, extra: object = {}) => ({ id, label, contextWindow: 0, supportsTools: true, supportsVision: true, ...extra });
/** The catalogs Claude Code and Codex listed on 2026-10-01, cut to one model of each kind. */
const lineupEngines: EngineDescriptor[] = [
  {
    id: "claude-code", label: "Claude Code", kind: "delegated", status: ready, supportsSessions: true, defaultModel: null,
    account: cli("/fixture/claude"), catalog: catalogReady,
    models: [
      listed("default", "Claude Code default", { resolvedModel: "claude-opus-5-5" }),
      listed("opus", "Opus", { resolvedModel: "claude-opus-5-5", providerDefault: true }),
      listed("claude-fable-5-1", "Fable 5.1", { resolvedModel: "claude-fable-5-1" }),
      listed("sonnet", "Sonnet 5.5", { resolvedModel: "claude-sonnet-5-5" }),
      listed("haiku", "Haiku 4.5", { resolvedModel: "claude-haiku-4-5-20251001" }),
      listed("claude-opus-4-8", "Opus 4.8", { resolvedModel: "claude-opus-4-8" }),
    ],
  },
  {
    id: "codex", label: "Codex", kind: "delegated", status: ready, supportsSessions: true, defaultModel: null,
    account: cli("/fixture/codex"), catalog: catalogReady,
    models: [
      listed("default", "Codex default"),
      listed("gpt-6.1-sol", "GPT-6.1-Sol", { providerDefault: true }),
      listed("gpt-6-astra", "GPT-6-Astra"),
      listed("gpt-6-sol", "GPT-6-Sol"),
      listed("gpt-6-luna", "GPT-6-Luna"),
      listed("gpt-5.6-terra", "GPT-5.6-Terra"),
    ],
  },
];
/** The main agent's list with no pick saved: what the model button says and which rows it lists. */
async function runLineupPicker(fresh: boolean) {
  flushSync(() => root.render(null));
  if (fresh) studio().modelPicker.setState({ choices: {} }, true);
  localStorage.setItem("studio.model.auth-thread", "claude-code::default");
  props.engines = lineupEngines;
  render([]); await settle();
  const button = document.querySelector('[aria-label="Model settings"]')?.textContent ?? "";
  document.querySelector<HTMLButtonElement>('[aria-label="Model settings"]')?.click(); await settle();
  document.querySelector<HTMLButtonElement>('[data-role="planner"]')?.click(); await settle();
  const rows = [...document.querySelectorAll<HTMLElement>("[data-model-choice]")];
  return {
    button,
    keys: rows.map((row) => row.dataset.modelChoice),
    names: rows.map((row) => row.textContent),
    checked: rows.filter((row) => row.getAttribute("aria-pressed") === "true").map((row) => row.dataset.modelChoice),
  };
}
/** Settings → Model Providers: the picker's switches, then Older models opened and Haiku switched on. */
async function runLineupSettings() {
  flushSync(() => root.render(null));
  flushSync(() => root.render(<ModelProvidersSection engines={lineupEngines} onEnginesRefresh={noop} />)); await settle();
  const switches = () =>
    [...document.querySelectorAll<HTMLButtonElement>("[data-picker-model]")].map((element) => ({
      id: element.dataset.pickerModel,
      on: element.getAttribute("aria-checked") === "true",
      disabled: element.disabled,
      visible: element.checkVisibility(),
    }));
  const resetShown = () => [...document.querySelectorAll("button")].some((button) => button.textContent === "Reset");
  const before = { switches: switches(), reset: resetShown() };
  document.querySelector<HTMLButtonElement>('[data-picker-models="claude-code"] button[aria-expanded]')?.click(); await settle();
  document.querySelector<HTMLButtonElement>('[data-picker-model="haiku"]')?.click(); await settle();
  return { before, after: { switches: switches(), reset: resetShown(), stored: localStorage.getItem("studio.models.picker") } };
}
Object.assign(window, { runLineupPicker, runLineupSettings });

/** The permissions panel on an engine: each row's one-line description, and what sits on its title line. */
async function runPermissionPanel(modelKey: string) {
  flushSync(() => root.render(null));
  localStorage.setItem("studio.model.auth-thread", modelKey);
  props.engines = lineupEngines;
  render([]); await settle();
  document.querySelector<HTMLButtonElement>('[aria-label="Permissions"]')?.click(); await settle();
  const centre = (element: Element | null | undefined) => {
    const box = element?.getBoundingClientRect();
    return box ? box.top + box.height / 2 : Number.NaN;
  };
  return [...document.querySelectorAll<HTMLButtonElement>("[data-permission-mode]")].map((row) => {
    const description = row.querySelector<HTMLElement>("[data-permission-description]");
    const title = row.querySelector("span > span > span");
    const end = row.lastElementChild;
    return {
      mode: row.dataset.permissionMode,
      text: description?.textContent,
      oneLine: !!description && description.scrollWidth <= description.clientWidth && description.getBoundingClientRect().height < 24,
      iconOnTitle: Math.abs(centre(row.querySelector("svg")) - centre(title)) <= 2,
      endOnTitle: Math.abs(centre(end) - centre(title)) <= 2,
      end: end?.querySelector("kbd")?.textContent ?? (end?.querySelector("svg") ? "check" : ""),
      disabled: row.disabled,
    };
  });
}
Object.assign(window, { runPermissionPanel });
