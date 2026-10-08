/**
 * Claude Code permissions for project chats: the settings, the composer's mode picker, the answer to a
 * card, and Stop allowing a saved rule. Studio UI only: `studio:permissions.*` is main-frame guarded
 * like `studio:plugins.*`, and the core's RPC table has none of these, so no agent can pick its own
 * mode or answer its own request.
 */
import type { StudioCore } from "../studio-core.ts";
import type { IpcHandle } from "./registrar.ts";

/** Why a call from the page is refused before it reaches the core. */
const MESSAGE = {
  invalidMode: "Invalid permission mode",
} as const;

export interface PermissionsIpcDeps {
  core: Pick<StudioCore, "permissionSettings" | "setPermissionMode" | "answerPermission" | "forgetPermission">;
}

export function registerPermissionsIpc(handle: IpcHandle, { core }: PermissionsIpcDeps): void {
  handle("studio:permissions.get", async () => core.permissionSettings());
  handle("studio:permissions.mode", async (p) => {
    const threadId = p?.threadId;
    if (threadId !== null && typeof threadId !== "string") throw new Error(MESSAGE.invalidMode);
    return core.setPermissionMode(threadId, p.mode);
  });
  // The core checks the answer field by field: the page is a browser.
  handle("studio:permissions.answer", async (p) => ({ resolved: core.answerPermission(p?.requestId, p?.answer) }));
  handle("studio:permissions.forget", async (p) => core.forgetPermission(p?.project, p?.rule));
}
