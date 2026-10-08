/** Harness RPC: a run's sandboxed commands and artifacts, and notices to the UI. */
import path from "node:path";
import { harnessUiEvent, isHostOnlyUiEvent } from "../../shared/ui-events.ts";
import { HostMethod, type HarnessHostHandlers } from "../../shared/harness-api.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";

/** What in the harness workspace runs or type-checks as code: never written by a `run.exec` shell. */
export function harnessCodePaths(harnessWs: string): string[] {
  return ["loop", "tools", "memory", "types", "tsconfig.json", "package.json"].map((rel) => path.join(harnessWs, rel));
}

export function runsRpc(core: StudioCore, _x: CoreInternals) {
  return {
    // — sandboxed execution —
    [HostMethod.RunExec]: async (p) => {
      const cwd = p.project ? core.projects.dirFor(p.project) : (p.cwd ?? core.layout.harnessWs);
      return core.sandbox.run({
        command: p.command,
        cwd,
        ...(p.timeoutMs ? { timeoutMs: p.timeoutMs } : {}),
        ...(p.label ? { label: p.label } : {}),
        // The harness's own code changes only through the self-edit gate (write_own_file,
        // install_tool: type-checked, booted in a fork, snapshotted before and after). A shell
        // here runs with the workspaces writable — the harness's included, and its folder is the
        // default cwd — so without this a `sed -i` or `cat >` rewrote the code around every check.
        // The loop's own git runs in projects and worktrees; the harness's through the host.
        policy: { denyWrite: harnessCodePaths(core.layout.harnessWs) },
      });
    },
    // — runs —
    [HostMethod.RunArtifact]: async (p) => core.saveRunArtifact(p.runId, p.name, Buffer.from(p.base64, "base64")),
    // — ui —
    [HostMethod.UiNotify]: async (p) => {
      if (isHostOnlyUiEvent(p.type)) return false;
      core.options.onUiEvent?.(harnessUiEvent(p.type, p.payload ?? null));
      return true;
    },
  } satisfies Partial<HarnessHostHandlers>;
}
