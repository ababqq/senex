import type { ThreadKind } from "../shared/event-log.ts";
import type { PermissionMode } from "../shared/permissions.ts";

export * from "../shared/studio-api.ts";

export interface ThreadMeta {
  kind?: ThreadKind;
  project?: string | null;
  archived?: boolean;
  extraReads?: string[];
  contractor?: { engine: string; sessionId: string; project?: string; model?: string; effort?: string };
  lastEngine?: string;
  lastModel?: string;
  lastEffort?: string;
  /** Claude Code permission mode this chat runs in; absent, the mode new chats start in. */
  permissionMode?: PermissionMode;
}
