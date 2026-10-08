/**
 * The field-row sender (§9.4, §20.3, M5.4): off by default, a queue under the profile, a 7-day drop,
 * anonymous POSTs (no Authorization header, no cookies), the 410 kill switch, silence in developer
 * and test launches, a rotating install id with a secret that leaves the device only as the proof
 * of its own POSTs and DELETE, and the IPC channels Settings → Privacy calls.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpDir } from "../helpers/tmp.ts";
import {
  CONTRIBUTIONS_PATH,
  DEFAULT_RUNS_ORIGIN,
  FieldPlatform,
  type FieldRunFacts,
  INSTALL_ID_PATTERN,
  INSTALL_ID_ROTATION_MS,
  INSTALL_SECRET_HEADER,
  RUN_SHARING_CONSENT_VERSION,
  RUNS_ORIGIN_ENV,
  RunSharingDeleteOutcome,
  UNSENT_ROW_TTL_MS,
  checkFieldRow,
} from "../../src/shared/run-sharing.ts";
import {
  type FinishedBuildRef,
  type RunSharingDeps,
  type LaunchShape,
  createRunSharing,
  finishedBuildRef,
  launchSends,
  runsOrigin,
} from "../../src/main/run-sharing.ts";
import { registerRunSharingIpc } from "../../src/main/ipc/run-sharing.ts";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { EndedHow, LaneModeServed, LaunchPath, TokenRole } from "../../src/shared/eval-lane.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { HOUR_MS, MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import { privacyDeleteWords } from "../../src/renderer/words.ts";

const DAY_MS = 24 * HOUR_MS;
const START = Date.parse("2026-10-01T12:00:00.000Z");

function facts(): FieldRunFacts {
  const usage = { uncachedInput: 10, cacheWrite: 0, cacheRead: 5, output: 7, reasoning: 0 };
  return {
    engine: EngineId.Codex,
    model: "gpt-6.1-sol",
    modeServed: LaneModeServed.ChatOnly,
    launch: LaunchPath.None,
    permissionMode: PermissionMode.Auto,
    endedHow: EndedHow.AgentFinished,
    buildOk: true,
    time: { wallMs: 1000, firstBootMs: null, firstPreviewMs: null, delegationP50Ms: 800, builds: 1 },
    tokens: usage,
    tokensByRole: { [TokenRole.Lead]: usage },
    context: { leadPeakPct: null, compactions: 0 },
    calls: { modelCalls: 1, tools: { total: 0, byCategory: {} } },
    inApp: { victory: null, executionStatus: null, stopCode: null, livenessMax: null, scoreboard: null },
  };
}

interface Sent {
  url: string;
  init: RequestInit;
}

/** A sender over a fresh folder, a clock the test moves and a network that answers from a script. */
async function rig(options: Partial<RunSharingDeps> & { answers?: Array<number | Error> } = {}) {
  const dir = path.join(await tmpDir("run-sharing-"), "run-sharing");
  const sent: Sent[] = [];
  const answers = options.answers ?? [];
  let clock = START;
  let hex = 0;
  const deps: RunSharingDeps = {
    dir,
    origin: DEFAULT_RUNS_ORIGIN,
    sends: true,
    app: { version: "0.1.0-rc.1", platform: FieldPlatform.Mac },
    now: () => clock,
    randomHex: () => (hex++).toString(16).padStart(32, "a"),
    fetch: async (url, init) => {
      sent.push({ url: String(url), init: init ?? {} });
      const answer = answers.shift() ?? 201;
      if (answer instanceof Error) throw answer;
      return new Response(answer === 204 ? null : JSON.stringify({ accepted: true, deleted: 2 }), { status: answer });
    },
    readFacts: async () => facts(),
    ...options,
  };
  const sharing = createRunSharing(deps);
  return {
    dir,
    sent,
    sharing,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const TURN: FinishedBuildRef = { threadId: "thread-1", messageId: "message-1" };

function headersOf(init: RequestInit): Record<string, string> {
  return Object.fromEntries(new Headers(init.headers).entries());
}

describe("the sender, off by default", () => {
  it("starts off, builds rows only for the preview and sends nothing", async () => {
    const { sharing, sent } = await rig();
    assert.deepEqual(await sharing.status(), { available: true, sends: true, on: false, paused: false, queued: 0 });
    await sharing.buildFinished(TURN);
    assert.equal(sent.length, 0);
    assert.equal((await sharing.status()).queued, 0);
    const preview = await sharing.preview();
    assert.ok(preview, "the preview shows the real next row");
    assert.equal(checkFieldRow(preview).ok, true);
    assert.equal(preview.consentVersion, RUN_SHARING_CONSENT_VERSION);
  });

  it("shows no preview before any build finished", async () => {
    const { sharing } = await rig();
    assert.equal(await sharing.preview(), null);
  });

  it("does not inherit a yes given to an older consent text", async () => {
    const { sharing, dir, sent } = await rig();
    await sharing.setOn(true);
    const file = path.join(dir, "state.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...state, consentVersion: "2020-01-01" }));
    const again = createRunSharing({
      dir,
      origin: DEFAULT_RUNS_ORIGIN,
      sends: true,
      app: { version: "0.1.0-rc.1", platform: FieldPlatform.Mac },
      fetch: async () => {
        throw new Error("no network in this test");
      },
      readFacts: async () => facts(),
    });
    assert.equal((await again.status()).on, false);
    await again.buildFinished(TURN);
    assert.equal(sent.length, 0);
  });

  it("reads a damaged state file as off and keeps working", async () => {
    const { sharing, dir } = await rig();
    await sharing.setOn(true);
    await writeFile(path.join(dir, "state.json"), "{not json");
    await writeFile(path.join(dir, "queue.json"), JSON.stringify([{ queuedAt: START, row: { prompt: "hi" } }]));
    const fresh = await rig({ dir });
    assert.deepEqual(await fresh.sharing.status(), {
      available: true,
      sends: true,
      on: false,
      paused: false,
      queued: 0,
    });
  });
});

describe("the sender, opted in", () => {
  it("posts each finished build anonymously: no Authorization header, no cookies, the install's secret as proof", async () => {
    const { sharing, sent, dir } = await rig();
    await sharing.setOn(true);
    await sharing.buildFinished(TURN);
    assert.equal(sent.length, 1);
    const [post] = sent;
    assert.ok(post);
    assert.equal(post.url, `${DEFAULT_RUNS_ORIGIN}${CONTRIBUTIONS_PATH}`);
    assert.equal(post.init.method, "POST");
    assert.equal(post.init.credentials, "omit");
    const headers = headersOf(post.init);
    assert.equal(headers.authorization, undefined);
    assert.equal(headers.cookie, undefined);
    const body = JSON.parse(String(post.init.body));
    const checked = checkFieldRow(body);
    assert.equal(checked.ok, true);
    assert.match(body.installId, INSTALL_ID_PATTERN);
    const secret = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    assert.equal(body.installId, secret.identity.installId);
    assert.equal(headers[INSTALL_SECRET_HEADER], secret.identity.installSecret, "the server owns an id by its secret");
    assert.equal(String(post.init.body).includes(secret.identity.installSecret), false);
    assert.equal((await sharing.status()).queued, 0);
  });

  it("stamps a row with the hour its build finished, never the exact instant", async () => {
    const { sharing, sent, advance } = await rig();
    await sharing.setOn(true);
    advance(34 * MINUTE_MS + 56 * SECOND_MS + 789);
    await sharing.buildFinished(TURN);
    const body = JSON.parse(String(sent[0]?.init.body));
    assert.equal(body.recordedAt, "2026-10-01T12:00:00.000Z");
    assert.equal((await sharing.preview())?.recordedAt, "2026-10-01T12:00:00.000Z");
  });

  it("keeps a row the network lost and drops it, unsent, after 7 days", async () => {
    const { sharing, sent, advance } = await rig({ answers: [new Error("offline"), new Error("offline")] });
    await sharing.setOn(true);
    await sharing.buildFinished(TURN);
    assert.equal((await sharing.status()).queued, 1);
    advance(DAY_MS);
    await sharing.flush();
    assert.equal(sent.length, 2, "tried again on the next flush");
    assert.equal((await sharing.status()).queued, 1);
    advance(UNSENT_ROW_TTL_MS);
    await sharing.flush();
    assert.equal(sent.length, 2, "an expired row is dropped without another try");
    assert.equal((await sharing.status()).queued, 0);
  });

  it("drops a row the server refused as invalid and keeps one it rate-limited", async () => {
    const refused = await rig({ answers: [400] });
    await refused.sharing.setOn(true);
    await refused.sharing.buildFinished(TURN);
    assert.equal((await refused.sharing.status()).queued, 0);
    const limited = await rig({ answers: [429] });
    await limited.sharing.setOn(true);
    await limited.sharing.buildFinished(TURN);
    assert.equal((await limited.sharing.status()).queued, 1);
  });

  it("pauses on the 410 kill switch, says so, and sends nothing more until a day has passed", async () => {
    const { sharing, sent, advance } = await rig({ answers: [410, 201, 201] });
    await sharing.setOn(true);
    await sharing.buildFinished(TURN);
    assert.equal((await sharing.status()).paused, true);
    await sharing.buildFinished(TURN);
    assert.equal(sent.length, 1, "paused: nothing more is sent");
    advance(DAY_MS + 1);
    await sharing.flush();
    assert.equal((await sharing.status()).paused, false, "the switch lifted");
    assert.equal((await sharing.status()).queued, 0);
  });

  it("forgets unsent rows when turned off", async () => {
    const { sharing } = await rig({ answers: [new Error("offline")] });
    await sharing.setOn(true);
    await sharing.buildFinished(TURN);
    const off = await sharing.setOn(false);
    assert.equal(off.on, false);
    assert.equal(off.queued, 0);
  });

  it("keeps its files readable by this user only", { skip: process.platform === "win32" }, async () => {
    const { sharing, dir } = await rig({ answers: [new Error("offline")] });
    await sharing.setOn(true);
    await sharing.buildFinished(TURN);
    for (const name of await readdir(dir)) assert.equal((await stat(path.join(dir, name))).mode & 0o077, 0, name);
  });
});

describe("the install identity", () => {
  it("proves a row queued before a rotation with the secret of the id that wrote it", async () => {
    const { sharing, sent, advance, dir } = await rig({ answers: [201, new Error("offline")] });
    await sharing.setOn(true);
    await sharing.buildFinished(TURN);
    const first = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")).identity;
    advance(INSTALL_ID_ROTATION_MS - DAY_MS);
    await sharing.buildFinished(TURN);
    assert.equal((await sharing.status()).queued, 1, "lost while the first id was current");
    advance(2 * DAY_MS);
    await sharing.buildFinished(TURN);
    const second = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")).identity;
    assert.notEqual(second.installId, first.installId);
    const proofs = sent.map((request) => [
      JSON.parse(String(request.init.body)).installId,
      headersOf(request.init)[INSTALL_SECRET_HEADER],
    ]);
    assert.deepEqual(proofs, [
      [first.installId, first.installSecret],
      [first.installId, first.installSecret],
      [first.installId, first.installSecret],
      [second.installId, second.installSecret],
    ]);
    assert.equal((await sharing.status()).queued, 0);
  });

  it("rotates after 90 days and deletes every id it used, proven by each one's secret", async () => {
    const { sharing, sent, advance, dir } = await rig();
    await sharing.setOn(true);
    await sharing.buildFinished(TURN);
    const first = JSON.parse(String(sent[0]?.init.body)).installId;
    advance(INSTALL_ID_ROTATION_MS + 1);
    await sharing.buildFinished(TURN);
    const second = JSON.parse(String(sent[1]?.init.body)).installId;
    assert.notEqual(first, second);
    const state = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    const result = await sharing.deleteShared();
    assert.equal(result.outcome, RunSharingDeleteOutcome.Deleted);
    assert.equal(result.deleted, 4);
    const deletes = sent.slice(2);
    assert.deepEqual(
      deletes.map((d) => d.url).sort(),
      [first, second].map((id) => `${DEFAULT_RUNS_ORIGIN}${CONTRIBUTIONS_PATH}/${id}`).sort(),
    );
    const secrets = [
      state.identity.installSecret,
      ...state.retired.map((r: { installSecret: string }) => r.installSecret),
    ];
    for (const request of deletes) {
      assert.equal(request.init.method, "DELETE");
      assert.equal(request.init.credentials, "omit");
      const headers = headersOf(request.init);
      assert.equal(headers.authorization, undefined);
      assert.ok(secrets.includes(headers[INSTALL_SECRET_HEADER]));
    }
    await sharing.buildFinished(TURN);
    const third = JSON.parse(String(sent.at(-1)?.init.body)).installId;
    assert.ok(![first, second].includes(third), "a fresh id after deleting");
  });

  it("keeps its ids when the delete fails, and reports the kill switch", async () => {
    const failed = await rig({ answers: [201, new Error("offline")] });
    await failed.sharing.setOn(true);
    await failed.sharing.buildFinished(TURN);
    const before = await readFile(path.join(failed.dir, "state.json"), "utf8");
    assert.equal((await failed.sharing.deleteShared()).outcome, RunSharingDeleteOutcome.Failed);
    assert.equal(await readFile(path.join(failed.dir, "state.json"), "utf8"), before);
    const paused = await rig({ answers: [201, 410, 201] });
    await paused.sharing.setOn(true);
    await paused.sharing.buildFinished(TURN);
    assert.equal((await paused.sharing.deleteShared()).outcome, RunSharingDeleteOutcome.Paused);
    // The server keeps DELETE open while contributions are paused: a 410 there is no kill switch for sending.
    assert.equal((await paused.sharing.status()).paused, false);
    await paused.sharing.buildFinished(TURN);
    assert.equal(paused.sent.length, 3, "the next build is still sent");
  });

  it("counts the rows earlier ids removed when a later id's delete fails", async () => {
    const answers: Array<Response | Error> = [
      new Response(JSON.stringify({ accepted: true }), { status: 201 }),
      new Response(JSON.stringify({ accepted: true }), { status: 201 }),
      new Response(JSON.stringify({ deleted: 12 }), { status: 200 }),
      new Error("offline"),
    ];
    const { sharing, advance, dir } = await rig({
      fetch: async () => {
        const answer = answers.shift() ?? new Error("no more answers");
        if (answer instanceof Error) throw answer;
        return answer;
      },
    });
    await sharing.setOn(true);
    await sharing.buildFinished(TURN);
    advance(INSTALL_ID_ROTATION_MS + 1);
    await sharing.buildFinished(TURN);
    const before = await readFile(path.join(dir, "state.json"), "utf8");
    assert.deepEqual(await sharing.deleteShared(), { outcome: RunSharingDeleteOutcome.Failed, deleted: 12 });
    assert.equal(await readFile(path.join(dir, "state.json"), "utf8"), before, "a retry reaches every id again");
  });
});

describe("launches that never send", () => {
  it("works the switch and the preview but opens no connection in developer and test launches", async () => {
    const { sharing, sent } = await rig({ sends: false });
    const on = await sharing.setOn(true);
    assert.equal(on.on, true);
    assert.equal(on.sends, false);
    await sharing.buildFinished(TURN);
    await sharing.flush();
    assert.ok(await sharing.preview());
    assert.deepEqual(await sharing.deleteShared(), { outcome: RunSharingDeleteOutcome.NotSent, deleted: 0 });
    assert.equal(sent.length, 0);
    assert.equal((await sharing.status()).queued, 0);
  });

  const normal: LaunchShape = {
    packaged: true,
    argv: ["/Applications/Genex.app/Contents/MacOS/Genex"],
    developerProfile: false,
    testData: false,
  };
  const launches: ReadonlyArray<[string, LaunchShape]> = [
    ["a checkout run from source", { ...normal, packaged: false }],
    ["an owned developer profile", { ...normal, developerProfile: true }],
    ["a smoke or self test", { ...normal, testData: true }],
    ["the smoke switch", { ...normal, argv: [...normal.argv, "--studio-smoke"] }],
    ["an eval lane", { ...normal, argv: [...normal.argv, "--studio-eval-lane=/tmp/spec.json"] }],
    ["a developer switch", { ...normal, argv: [...normal.argv, "--studio-dev-launch=/tmp/launch.json"] }],
  ];
  it("sends only from a packaged app started normally", () => {
    assert.equal(launchSends(normal), true);
    for (const [name, launch] of launches) assert.equal(launchSends(launch), false, name);
  });

  it("offers no switch at all where the build removed sharing", async () => {
    const { sharing, sent } = await rig({ origin: null });
    assert.equal((await sharing.status()).available, false);
    assert.equal((await sharing.setOn(true)).on, false);
    await sharing.buildFinished(TURN);
    assert.equal(sent.length, 0);
  });
});

describe("where rows go (hostile input)", () => {
  it("uses the Genex API by default, a self-hoster's https origin, or nothing when set empty", () => {
    assert.equal(runsOrigin({}), DEFAULT_RUNS_ORIGIN);
    assert.equal(runsOrigin({ [RUNS_ORIGIN_ENV]: "" }), null);
    assert.equal(runsOrigin({ [RUNS_ORIGIN_ENV]: "https://runs.example.org/" }), "https://runs.example.org");
    assert.equal(runsOrigin({ [RUNS_ORIGIN_ENV]: "http://localhost:8787" }), "http://localhost:8787");
    assert.equal(runsOrigin({ [RUNS_ORIGIN_ENV]: "http://127.0.0.1:8787" }), "http://127.0.0.1:8787");
  });
  const hostile = [
    "http://runs.example.org",
    "https://user:pass@runs.example.org",
    "https://runs.example.org/api?key=1",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "ftp://runs.example.org",
    "not a url",
    "  ",
    "https://runs.example.org/../../x",
  ];
  for (const value of hostile) {
    it(`refuses ${JSON.stringify(value)} and sends nothing`, async () => {
      const origin = runsOrigin({ [RUNS_ORIGIN_ENV]: value });
      assert.equal(origin, null);
      const { sharing, sent } = await rig({ origin });
      await sharing.setOn(true);
      await sharing.buildFinished(TURN);
      assert.equal(sent.length, 0);
    });
  }
});

describe("which events end a build", () => {
  it("names a chat turn by its thread and message, and a run by its id and project", () => {
    assert.deepEqual(
      finishedBuildRef({ type: UiEvent.CoordinatorHandled, payload: { threadId: "t1", messageId: "m1" } }),
      { threadId: "t1", messageId: "m1" },
    );
    assert.equal(
      finishedBuildRef({ type: UiEvent.CoordinatorHandled, payload: { threadId: "t1" } }),
      null,
      "a handled message that names no message cannot be tied to its own turn",
    );
    assert.deepEqual(
      finishedBuildRef({ type: UiEvent.RunFinished, payload: { runId: "r1", project: "space-frogs" } }),
      { runId: "r1", project: "space-frogs" },
    );
    assert.equal(finishedBuildRef({ type: UiEvent.CoordinatorHandled, payload: {} }), null);
    assert.equal(finishedBuildRef({ type: UiEvent.RunFinished, payload: { runId: "r1" } }), null);
    assert.equal(finishedBuildRef({ type: UiEvent.StudioReady, payload: { userData: "/tmp/x" } }), null);
  });
});

describe("what the Privacy page says after Delete what I shared", () => {
  it("never says nothing was deleted when earlier ids' rows are already gone", () => {
    for (const outcome of [RunSharingDeleteOutcome.Failed, RunSharingDeleteOutcome.Paused]) {
      const words = privacyDeleteWords({ outcome, deleted: 12 });
      assert.match(words, /12 rows/, outcome);
      assert.doesNotMatch(words, /Nothing was deleted/, outcome);
    }
  });

  it("says nothing was deleted when nothing was, and how many rows a full delete removed", () => {
    assert.match(privacyDeleteWords({ outcome: RunSharingDeleteOutcome.Failed, deleted: 0 }), /Nothing was deleted/);
    assert.match(privacyDeleteWords({ outcome: RunSharingDeleteOutcome.Paused, deleted: 0 }), /Nothing was deleted/);
    assert.match(privacyDeleteWords({ outcome: RunSharingDeleteOutcome.Deleted, deleted: 4 }), /4 rows/);
  });
});

describe("the Privacy IPC channels", () => {
  type Listener = (event: IpcSender, payload: unknown) => Promise<IpcResult>;
  const studio = { sender: "studio", senderFrame: "main-frame" };

  async function ipc(fixture = false) {
    const { sharing, sent } = await rig();
    const listeners = new Map<string, Listener>();
    const handle = createIpcHandle(
      { handle: (channel, listener) => void listeners.set(channel, listener) },
      { fixture, isStudioUi: () => true },
    );
    registerRunSharingIpc(handle, { sharing });
    const invoke = async (channel: string, payload?: unknown) => {
      const listener = listeners.get(channel);
      assert.ok(listener, `${channel} is registered`);
      return listener(studio, payload);
    };
    return { invoke, sharing, sent };
  }

  it("turns sharing on and reads the status and preview", async () => {
    const { invoke, sharing } = await ipc();
    const set = await invoke("studio:run-sharing.set", { on: true });
    assert.ok(set.ok);
    assert.equal((set.value as { on: boolean }).on, true);
    assert.equal((await sharing.status()).on, true);
    const status = await invoke("studio:run-sharing.status");
    assert.ok(status.ok);
    const preview = await invoke("studio:run-sharing.preview");
    assert.ok(preview.ok);
    assert.equal(preview.value, null);
  });

  const bad: ReadonlyArray<[string, unknown]> = [
    ["no payload", undefined],
    ["a string", "on"],
    ["on as text", { on: "true" }],
    ["on as a number", { on: 1 }],
    ["an array", [true]],
  ];
  for (const [name, payload] of bad) {
    it(`refuses ${name} and leaves sharing off`, async () => {
      const { invoke, sharing, sent } = await ipc();
      const result = await invoke("studio:run-sharing.set", payload);
      assert.equal(result.ok, false);
      assert.equal((await sharing.status()).on, false);
      assert.equal(sent.length, 0);
    });
  }

  it("refuses Delete what I shared in a fixture profile: it opens the network", async () => {
    const { invoke, sent } = await ipc(true);
    const result = await invoke("studio:run-sharing.delete");
    assert.equal(result.ok, false);
    assert.equal(sent.length, 0);
    assert.equal((await invoke("studio:run-sharing.status")).ok, true);
  });
});
