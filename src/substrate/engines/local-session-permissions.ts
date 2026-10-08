/**
 * A local session's chat mode (`local-session.ts`): which of its tool calls wait for the person
 * and how their answer reads to the model. Only a project chat's own session the person answers has a
 * mode (`DelegateRequest.permissions`); unattended work never asks. The studio runs these tools
 * itself, so it asks before each change as Claude Code does: Manual before every edit and command,
 * Accept edits before every command, Auto never; Plan refuses every change until the plan is
 * approved (the host asks for that once the turn ends: `main/core/plan-approval.ts`). Bonsai's
 * commands always run in the studio's sandbox, so it honours no Bypass (`permissionModesFor`).
 */
import path from "node:path";
import { engineMode, PermissionDecision, PermissionMode } from "../../shared/permissions.ts";
import { EngineId } from "../../shared/providers.ts";
import type { ToolCall } from "../types.ts";
import { LocalTool } from "./local-session-tools.ts";
import { deniedWithWords, LOCAL_NOTE } from "./local-session-prompts.ts";
import type { DelegatePermissions, PermissionAsk, PermissionReply } from "./types.ts";

/** What a change tool does, as the modes tell them apart. */
const ChangeKind = { Edit: "edit", Command: "command" } as const;
type ChangeKind = (typeof ChangeKind)[keyof typeof ChangeKind];

/** The local tools that change something, by what they change. Every other tool only looks or is the studio's own. */
const CHANGE_TOOLS: Readonly<Record<string, ChangeKind>> = {
  [LocalTool.EditFile]: ChangeKind.Edit,
  [LocalTool.WriteFile]: ChangeKind.Edit,
  [LocalTool.RunCommand]: ChangeKind.Command,
};

/** What each mode asks the person about before it runs. */
const ASKS: Record<PermissionMode, ReadonlySet<ChangeKind>> = {
  [PermissionMode.Auto]: new Set(),
  [PermissionMode.Manual]: new Set([ChangeKind.Edit, ChangeKind.Command]),
  [PermissionMode.AcceptEdits]: new Set([ChangeKind.Command]),
  [PermissionMode.Plan]: new Set(),
  [PermissionMode.Bypass]: new Set(),
};

/** Claude Code's tool names, which the card (`PermissionRequest`) reads a request by. Vendor names. */
const CardTool = { Shell: "Bash", Edit: "Edit", Write: "Write" } as const;

/** The card's own sentence, as Claude Code words its questions. */
const ASK_TITLE = {
  command: "Bonsai wants to run a command",
  edit: (file: string) => `Bonsai wants to edit ${path.basename(file)}`,
  write: (file: string) => `Bonsai wants to write ${path.basename(file)}`,
} as const;

/** A chat's mode as Bonsai honours it: Bypass, which it has not, runs as Auto. */
export function bonsaiMode(mode: PermissionMode): PermissionMode {
  return engineMode(EngineId.Bonsai, mode);
}

/** The mode a chat session the person answers runs in, as Bonsai honours it; null for unattended work. */
export function localMode(permissions: DelegatePermissions | undefined): PermissionMode | null {
  return permissions ? bonsaiMode(permissions.mode) : null;
}

/** Whether a tool changes something, so Plan withholds it from the model. */
export function changesSomething(name: string): boolean {
  return Object.hasOwn(CHANGE_TOOLS, name);
}

/** A string argument, or none. */
function text(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * The question for one call, in Claude Code's tool names so the card reads as Claude's do: a
 * command as `Bash`, an edit as `Edit`, a whole file as `Write`. Null for arguments that are not an
 * object: the tool refuses those itself without running.
 */
export function localAsk(call: ToolCall, cwd: string): PermissionAsk | null {
  const args = call.arguments;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  const input = args as Record<string, unknown>;
  const base = { toolUseId: call.id, always: [] };
  if (call.name === LocalTool.RunCommand)
    return {
      ...base,
      tool: CardTool.Shell,
      title: ASK_TITLE.command,
      input: { command: text(input, "command") ?? "" },
    };
  const file = path.resolve(cwd, text(input, "path") ?? "");
  if (call.name === LocalTool.WriteFile)
    return {
      ...base,
      tool: CardTool.Write,
      title: ASK_TITLE.write(file),
      input: { file_path: file, content: text(input, "content") ?? "" },
    };
  return {
    ...base,
    tool: CardTool.Edit,
    title: ASK_TITLE.edit(file),
    input: { file_path: file, old_string: text(input, "oldText") ?? "", new_string: text(input, "newText") ?? "" },
  };
}

/** The person's answer as the model reads it: null to go ahead, else why the call did not run. */
function refusal(reply: PermissionReply): string | null {
  if (reply.decision !== PermissionDecision.Deny) return null;
  if ("withdrawn" in reply) return reply.message;
  const words = reply.message?.trim();
  return words ? deniedWithWords(words) : LOCAL_NOTE.denied;
}

/**
 * Whether a call may run in the session's mode now: null to run it, else the words the model reads
 * instead of its result. A change in Plan is refused without asking; one the mode asks about waits
 * for the person's answer (or the work ending around it).
 */
export async function permitCall(input: {
  mode: PermissionMode | null;
  call: ToolCall;
  cwd: string;
  permissions: DelegatePermissions | undefined;
  signal: AbortSignal;
}): Promise<string | null> {
  const { mode, call, permissions } = input;
  if (!changesSomething(call.name) || !permissions || mode === null) return null;
  if (mode === PermissionMode.Plan) return LOCAL_NOTE.planModeRefused;
  if (!ASKS[mode].has(CHANGE_TOOLS[call.name])) return null;
  const ask = localAsk(call, input.cwd);
  if (!ask) return null;
  return refusal(await permissions.ask(ask, input.signal));
}
