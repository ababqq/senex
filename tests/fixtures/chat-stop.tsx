/** Test-owned production ChatPanel: terminal events arrive while the harness status stays active. */
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
    thread_id: "stop-thread",
    session_id: null,
    turn_id: null,
    created_at: date,
    data: { type: EventKind.Custom, event_type: eventType, payload: { runId, project: "stop-project", ...payload } },
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
    id: "stop-thread",
    agent_id: "studio",
    created_at: date,
    updated_at: date,
    latest_event_id: null,
    metadata: { kind: ThreadKind.Project, project: "stop-project" },
  },
  status: "run run_stop",
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
function render(events: EventEnvelope[], status = "run run_stop", threadId = "stop-thread") {
  const activeThread = props.activeThread ? { ...props.activeThread, id: threadId } : null;
  flushSync(() =>
    root.render(
      <ChatPanel {...props} activeThread={activeThread} events={events} stateEvents={events} status={status} />,
    ),
  );
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
function sample() {
  const button = document.querySelector<HTMLButtonElement>(
    '[data-promptbar] button[aria-label="Stop"], [data-promptbar] button[aria-label="Send"]',
  );
  if (!button) throw new Error("Missing composer action");
  const stop = button.querySelector('[data-glyph="stop"]');
  const send = button.querySelector('[data-glyph="send"]');
  if (!stop || !send) throw new Error("Missing composer glyphs");
  return {
    state: button.dataset.state,
    label: button.getAttribute("aria-label"),
    resume: [...document.querySelectorAll("button")].some((item) => item.textContent?.trim() === "Resume"),
    stopOpacity: getComputedStyle(stop).opacity,
    sendOpacity: getComputedStyle(send).opacity,
    sendTransform: getComputedStyle(send).transform,
    animations: stop.getAnimations().length + send.getAnimations().length,
  };
}

/** Each sample is captured in the renderer, without an IPC polling delay masking a bad frame. */
async function runStopChecks() {
  flushSync(() => root.render(null));
  const start = event(CustomEvent.RunStarted);
  render([start]);
  for (let i = 0; i < 20; i++) await frame();
  const before = sample();
  const callsBefore = fake.calls.filter((call) => call.method === "cancelTurn").length;
  document.querySelector<HTMLButtonElement>('[data-promptbar] [aria-label="Stop"]')?.click();
  await frame();
  const pending = sample();
  const paused = [
    start,
    event(CustomEvent.RunFinished, "run_stop", { executionStatus: "paused", paused: true }),
    event(CustomEvent.AutopilotPaused),
  ];
  render(paused);
  const frames = [];
  for (let i = 0; i < 20; i++) {
    await frame();
    frames.push(sample());
  }
  render([...paused, event(CustomEvent.AutopilotResumed)]);
  await frame();
  const resumed = sample();
  render(paused, "idle");
  await frame();
  const idle = sample();
  const next = event(CustomEvent.RunStarted, "run_next");
  const lateClose = event(CustomEvent.AutopilotPaused);
  render([...paused, next, lateClose], "run run_next");
  await frame();
  const newRun = sample();
  const other = { ...event(CustomEvent.RunStarted, "run_other"), thread_id: "other-thread" };
  render([...paused, other], "run run_other", "other-thread");
  await frame();
  const otherThread = sample();
  render([...paused, other]);
  await frame();
  const originalThread = sample();
  const queued = event(CustomEvent.CoordinatorMessageQueued, "run_stop", {
    messageId: "follow-up",
    action: { text: "Next task" },
  });
  const processing = event(CustomEvent.CoordinatorMessageProcessing, "run_stop", { messageId: "follow-up" });
  render([...paused, queued, processing]);
  await frame();
  const followUp = sample();
  render(paused);
  await frame();
  return {
    before,
    pending,
    frames,
    resumed,
    idle,
    newRun,
    otherThread,
    originalThread,
    followUp,
    calls: fake.calls.filter((call) => call.method === "cancelTurn").length - callsBefore,
  };
}
Object.assign(window, { runStopChecks });
