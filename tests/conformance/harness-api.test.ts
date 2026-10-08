/**
 * The harness → host RPC contract (`src/shared/harness-api.ts`).
 *
 * The harness is agent-editable JavaScript, so its params are checked where its messages arrive:
 * `HarnessHost` refuses a path-bearing call whose params have the wrong shape before the handler
 * runs, and passes every other call through exactly as it was sent. These tests drive a real
 * `HarnessHost` over a fake child's pipes — the same line protocol the sandboxed process speaks —
 * and hold `StudioCore.api()` to the method map at compile time.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { z } from "zod";
import { StudioPlatform } from "../../src/shared/boot.ts";
import {
  HARNESS_PARAM_SCHEMAS,
  harnessParamsProblem,
  type HarnessHostHandlers,
  type HarnessParams,
  type PathBearingMethod,
} from "../../src/shared/harness-api.ts";
import { encode, LineCodec, type RpcResponse } from "../../src/shared/protocol.ts";
import { HarnessHost } from "../../src/substrate/harness-host.ts";
import type { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { coreLite } from "../helpers/core-lite.ts";

/** A child process as `HarnessHost` sees it: three pipes, a pid it never needs, and an exit. */
function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: undefined,
    kill(signal: string) {
      setImmediate(() => child.emit("exit", null, signal));
      return true;
    },
  });
  return child;
}

interface Pipe {
  host: HarnessHost;
  calls: Array<{ method: string; params: unknown }>;
  rpc(method: string, params: unknown): Promise<RpcResponse>;
  stop(): Promise<void>;
}

/** A started host whose every api method records the params it received and answers "handled". */
async function pipe(methods: string[]): Promise<Pipe> {
  const child = fakeChild();
  const calls: Pipe["calls"] = [];
  const api = Object.fromEntries(
    methods.map((method) => [
      method,
      async (params: unknown) => {
        calls.push({ method, params });
        return "handled";
      },
    ]),
  );
  const sandbox = { spawnLongLived: async () => ({ child, sandboxed: false }) } as unknown as ProcessSandbox;
  const host = new HarnessHost({
    workspace: "/nowhere",
    bootstrap: "/nowhere/bootstrap.mjs",
    execPath: process.execPath,
    sandbox,
    api,
    updatesDir: "/nowhere/updates",
    // The fake child speaks only stdio; a Windows host would answer over its loopback inbox.
    platform: StudioPlatform.Linux,
  });
  const answers = new Map<number, (response: RpcResponse) => void>();
  const codec = new LineCodec();
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => {
    for (const message of codec.push<{ kind: string; id: number }>(chunk)) {
      if (message.kind === "rpc-result") answers.get(message.id)?.(message as RpcResponse);
    }
  });
  const started = host.start();
  child.stdout.write(encode({ kind: "ready", harnessVersion: "test", capabilities: [] }));
  await started;
  let nextId = 1;
  return {
    host,
    calls,
    rpc(method, params) {
      const id = nextId++;
      const answered = new Promise<RpcResponse>((resolve) => answers.set(id, resolve));
      child.stdout.write(encode({ kind: "rpc", id, method, params }));
      return answered;
    },
    stop: () => host.stop(50),
  };
}

const PATH_BEARING = Object.keys(HARNESS_PARAM_SCHEMAS) as PathBearingMethod[];

test("malformed params for a path-bearing method are refused with a clear error before the handler runs", async () => {
  const harness = await pipe(PATH_BEARING);
  try {
    const refusals: Array<[string, unknown, string]> = [
      ["project.read", { project: "pong", file: 42 }, "file"],
      ["project.write", { project: "pong", contents: "x" }, "file"],
      ["project.read", { file: "src/main.js" }, "project"],
      ["snapshot.removeWorktree", { project: "pong", path: { toString: "/" } }, "path"],
      ["snapshot.worktree", { project: "pong", name: 7 }, "name"],
      ["preview.load", { project: "pong", root: ["/etc"] }, "root"],
      ["project.export", { project: "pong", target: 1 }, "target"],
      ["run.exec", { command: "ls", cwd: false }, "cwd"],
      [
        "engine.delegate",
        { project: "pong", prompt: "go", selfCapture: { project: "pong", root: 5 } },
        "selfCapture.root",
      ],
      ["engine.delegate", { project: "pong", prompt: "go", extraReads: ["/refs", 3] }, "extraReads.1"],
      ["preview.pair", { runId: "r1", left: { path: 9 }, right: {} }, "left.path"],
      ["run.artifact", { runId: "r1", name: null, base64: "" }, "name"],
      ["project.scaffold", undefined, "params"],
    ];
    for (const [method, params, field] of refusals) {
      const answer = await harness.rpc(method, params);
      assert.equal(answer.ok, false, method);
      assert.equal(answer.error?.name, "InvalidParams", method);
      assert.match(
        answer.error?.message ?? "",
        new RegExp(`^invalid params for ${method.replace(".", "\\.")}: `),
        method,
      );
      const data = answer.error?.data as { method: string; issues: Array<{ path: string }> } | undefined;
      assert.equal(data?.method, method);
      const issues = data?.issues ?? [];
      assert.ok(
        issues.some((issue) => issue.path === field),
        `${method}: ${JSON.stringify(issues)} names ${field}`,
      );
    }
    assert.deepEqual(harness.calls, [], "no refused call reached a handler");
  } finally {
    await harness.stop();
  }
});

test("a well-formed call reaches its handler with the params exactly as the harness sent them", async () => {
  const harness = await pipe([...PATH_BEARING, "preview.state", "engine.abort"]);
  try {
    // Shapes the seed sends today, including fields the schema does not check and the nulls a
    // handler reads as "not given".
    const accepted: Array<[string, unknown]> = [
      ["project.read", { project: "pong", file: "NOTES.md" }],
      ["project.export", { project: "pong", candidateId: "opt-1" }],
      ["mcp.tools", { project: null }],
      ["snapshot.worktree", { project: "pong", commit: null, name: "integration", runId: "run-1" }],
      ["preview.load", { project: "pong", root: null, entry: "index.html", handle: "stage-1" }],
      [
        "preview.pair",
        {
          runId: "r1",
          left: { base64: "AAAA", mimeType: "image/png" },
          right: { path: "/runs/r1/a.jpg" },
          label: "pair",
        },
      ],
      ["preview.statsOf", undefined],
      [
        "engine.delegate",
        {
          project: "pong",
          prompt: "go",
          cwd: "/scratch/w1",
          selfCapture: { project: "pong", root: "/scratch/w1", runId: "r1", facetId: "build", iteration: 1 },
        },
      ],
      ["project.setCover", { project: "pong", threadId: "t1", family: "dunes", palette: "dusk", seed: 3 }],
      // Not path-bearing: nothing is checked, whatever arrives.
      ["preview.state", 5],
      // Stop is never refused on its params.
      ["engine.abort", { cwd: 42 }],
    ];
    for (const [method, params] of accepted) {
      const answer = await harness.rpc(method, params);
      assert.deepEqual(answer, { kind: "rpc-result", id: answer.id, ok: true, value: "handled" }, method);
    }
    assert.deepEqual(
      harness.calls,
      accepted.map(([method, params]) => ({ method, params })),
    );
  } finally {
    await harness.stop();
  }
});

test("an unknown method is still answered as unknown, before any params check", async () => {
  const harness = await pipe(["project.read"]);
  try {
    const answer = await harness.rpc("project.delete", { project: 1 });
    assert.equal(answer.ok, false);
    assert.equal(answer.error?.name, "UnknownMethod");
  } finally {
    await harness.stop();
  }
});

test("every params schema names a method the core serves, and stop control is deliberately unchecked", async () => {
  const { api } = await coreLite({ init: false });
  const served = new Set(Object.keys(api()));
  for (const method of PATH_BEARING) assert.ok(served.has(method), method);
  assert.ok(PATH_BEARING.length >= 30, `only ${PATH_BEARING.length} path-bearing methods`);
  for (const method of ["engine.abort", "engine.interrupt"])
    assert.equal(harnessParamsProblem(method, { cwd: 1 }), null, method);
  assert.equal(harnessParamsProblem("not.a.method", { project: 1 }), null);
});

// ── compile-time contract: checked by the typecheck, never called ─────────────────────────────

/** Every schema accepts every params value its method's type allows: no typed call is refused. */
type SchemaAccepts = {
  [K in PathBearingMethod]: HarnessParams<K> extends z.input<(typeof HARNESS_PARAM_SCHEMAS)[K]> ? true : false;
};
type EverySchemaAccepts = false extends SchemaAccepts[PathBearingMethod] ? false : true;
const everySchemaAcceptsItsType: EverySchemaAccepts = true;
void everySchemaAcceptsItsType;

function typecheckOnly(api: HarnessHostHandlers): void {
  // Params and results come from the map.
  const url: Promise<string> = api["preview.load"]({ project: "pong" });
  const tree: Promise<string[]> = api["project.tree"]({ project: "pong" });
  void url;
  void tree;
  // @ts-expect-error: project.read needs the file it reads
  void api["project.read"]({ project: "pong" });
  // @ts-expect-error: a folder is a string, never a number
  void api["snapshot.removeWorktree"]({ project: "pong", path: 1 });
  // @ts-expect-error: preview.load answers a URL, not a boolean
  const wrong: Promise<boolean> = api["preview.load"]({ project: "pong" });
  void wrong;
  // @ts-expect-error: no such method
  void api["project.delete"];
}
void typecheckOnly;
