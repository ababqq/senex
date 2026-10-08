import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertNativeActionAllowed,
  classifyChannel,
  FIXTURE_BLOCKED_CHANNELS,
  FIXTURE_SAFE_CHANNELS,
} from "../../src/main/dev/native-policy.ts";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";

// main/index.ts registers every channel through createIpcHandle, whose channel parameter is a key
// of the channel map (shared/ipc-channels.ts), every one of which the policy table classifies:
// `npm run typecheck` fails on an unknown channel. Handlers answer with their channel's result.
type Listener = (event: IpcSender, payload: unknown) => Promise<IpcResult>;
function recorder() {
  const listeners = new Map<string, Listener>();
  return {
    listeners,
    ipc: {
      handle(channel: string, listener: Listener) {
        assert.ok(!listeners.has(channel), `${channel} registered twice`);
        listeners.set(channel, listener);
      },
    },
  };
}
const studio = { sender: "studio-webcontents", senderFrame: "studio-main-frame" };
const isStudioUi = (event: IpcSender) => event.sender === studio.sender && event.senderFrame === studio.senderFrame;

test("an unclassified channel does not typecheck as a registration", () => {
  const { ipc, listeners } = recorder();
  const handle = createIpcHandle(ipc, { fixture: true, isStudioUi });
  handle("studio:threads", () => []);
  // @ts-expect-error classify it in src/main/dev/native-policy.ts first
  handle("studio:brand-new.native", () => 1);
  assert.deepEqual([...listeners.keys()], ["studio:threads", "studio:brand-new.native"]);
});
test("a fixture profile runs fixture-safe channels, refuses native and unclassified ones, and wraps results", async () => {
  const { ipc, listeners } = recorder();
  const handle = createIpcHandle(ipc, { fixture: true, isStudioUi });
  const ran: string[] = [];
  handle("studio:send", (payload: { text: string }) => {
    ran.push(payload.text);
    return true;
  });
  handle("studio:open-url", () => {
    ran.push("opened");
    return true;
  });
  handle("studio:project.create", () => {
    throw new Error("title taken");
  });
  // @ts-expect-error an unclassified channel, registered anyway to prove the runtime refusal
  handle("studio:brand-new.native", () => {
    ran.push("new");
  });
  assert.deepEqual(await listeners.get("studio:send")!(studio, { text: "hi" }), { ok: true, value: true });
  assert.deepEqual(await listeners.get("studio:open-url")!(studio, {}), {
    ok: false,
    error: "unsupported-in-fixture: native accounts, dialogs, downloads and external actions require a live profile",
  });
  assert.deepEqual(await listeners.get("studio:project.create")!(studio, {}), { ok: false, error: "title taken" });
  assert.deepEqual(await listeners.get("studio:brand-new.native")!(studio, {}), {
    ok: false,
    error: "unsupported-in-fixture: studio:brand-new.native is not classified in src/main/dev/native-policy.ts",
  });
  assert.deepEqual(ran, ["hi"]);
});
test("a live profile runs native channels", async () => {
  const { ipc, listeners } = recorder();
  const handle = createIpcHandle(ipc, { fixture: false, isStudioUi });
  handle("studio:open-url", () => true);
  assert.deepEqual(await listeners.get("studio:open-url")!(studio, {}), { ok: true, value: true });
});
test("plugin, connector and terminal channels answer only Studio's main frame", async () => {
  const { ipc, listeners } = recorder();
  const handle = createIpcHandle(ipc, { fixture: false, isStudioUi });
  let ran = 0;
  handle("studio:plugins.list", () => {
    ran++;
    return [];
  });
  handle("studio:mcp.list", () => {
    ran++;
    return [];
  });
  handle("studio:terminal.list", () => {
    ran++;
    return [];
  });
  handle("studio:projects", () => {
    ran++;
    return [];
  });
  const subframe = { sender: studio.sender, senderFrame: "plugin-panel-frame" },
    other = { sender: "project-webcontents", senderFrame: "project-frame" };
  for (const channel of ["studio:plugins.list", "studio:mcp.list", "studio:terminal.list"]) {
    for (const event of [subframe, other])
      assert.deepEqual(
        await listeners.get(channel)!(event, {}),
        { ok: false, error: "This action is restricted to Studio UI" },
        channel,
      );
    assert.equal((await listeners.get(channel)!(studio, {})).ok, true, channel);
  }
  assert.deepEqual(await listeners.get("studio:projects")!(other, {}), { ok: true, value: [] });
  assert.equal(ran, 4);
});
test("a channel is never both fixture-safe and native", () => {
  assert.deepEqual(
    [...FIXTURE_SAFE_CHANNELS].filter((channel) => FIXTURE_BLOCKED_CHANNELS.has(channel)),
    [],
  );
});
test("native accounts, terminals, plugin installs, external opens and Genex are refused in fixtures only", () => {
  for (const channel of [
    "studio:terminal.open",
    "studio:plugins.install",
    "studio:plugins.install-github",
    "studio:plugins.lookup-github",
    "studio:plugins.github-versions",
    "studio:plugins.update",
    "studio:plugins.approval",
    "studio:plugins.host-cli",
    "studio:plugins.host-package",
    "studio:open-url",
    "studio:reveal-project",
    "studio:project.pick",
    // Create project's location is chosen in the native folder picker.
    "studio:project.location.pick",
    "studio:export",
    "studio:packages.install",
    "studio:mcp.trust",
    "studio:mcp.authorize",
    "studio:notify",
    "studio:project-file.reveal",
    // A file the chat names opens in another app or the file manager, outside the profile.
    "studio:chat-file.open",
    "studio:subscription.signin",
    "studio:claude-login.browser",
    "studio:codex-login.browser",
    "studio:genex.connect",
    "studio:genex.disconnect",
    "studio:genex.enable",
    "studio:genex.allowance",
    "studio:genex.approve",
    // Set up creates a Windows user account and network filters, behind an administrator prompt.
    "studio:boot.setup",
  ]) {
    assert.equal(classifyChannel(channel), "native", channel);
    assert.throws(() => assertNativeActionAllowed(true, channel), /unsupported-in-fixture/, channel);
    assert.doesNotThrow(() => assertNativeActionAllowed(false, channel), channel);
  }
});
test("fixture-safe channels run in fixtures and an unclassified one is refused there but not live", () => {
  for (const channel of [
    // The sandbox setup screen: its state, Retry, and the window controls' colours.
    "studio:boot",
    "studio:boot.retry",
    "studio:window.controls",
    "studio:bootstrap",
    "studio:send",
    "studio:terminal.list",
    "studio:plugins.index",
    "studio:mcp.save",
    "studio:project.adopt",
    "studio:project-file.read",
    // Asking which names are files only looks.
    "studio:chat-files.resolve",
    "studio:message-images",
    "studio:provider-usage",
    "studio:badge",
  ]) {
    assert.equal(classifyChannel(channel), "fixture-safe", channel);
    assert.doesNotThrow(() => assertNativeActionAllowed(true, channel), channel);
  }
  assert.equal(classifyChannel("studio:brand-new.native"), "unclassified");
  assert.throws(
    () => assertNativeActionAllowed(true, "studio:brand-new.native"),
    /unsupported-in-fixture: studio:brand-new\.native is not classified/,
  );
  assert.doesNotThrow(() => assertNativeActionAllowed(false, "studio:brand-new.native"));
});
