/** The per-project terminal dock: sessions live in the terminal host, the renderer only draws them. */
import os from "node:os";
import { runnableCommand, TerminalKind } from "../../shared/terminal.ts";
import { withEnvPath } from "../../substrate/toolchain.ts";
import { commandShell, type TerminalShell, terminalShell } from "../terminal-shell.ts";
import type { StudioCore } from "../studio-core.ts";
import type { TerminalLaunch, TerminalService } from "../terminal-service.ts";
import type { IpcHandle } from "./registrar.ts";

/** Why a terminal cannot open. */
const MESSAGE = {
  unsupportedPlatform: "Terminals are supported on macOS, Windows and Linux.",
  noProject: "Open a project before starting its terminal.",
  notACommand: "This is not a single command the terminal can run.",
} as const;

/** Studio transport/engine configuration that must not become a project shell's environment. */
const STUDIO_ONLY_ENV = /^(STUDIO_|ELECTRON_|CLAUDE_CONFIG_DIR$|CODEX_HOME$)/;

export interface TerminalIpcDeps {
  core: Pick<StudioCore, "projects" | "assertProjectAllowed">;
  terminals: Pick<TerminalService, "list" | "open" | "attach" | "write" | "resize" | "acknowledge" | "stop" | "remove">;
  /** Whether macOS reports an assistive technology (VoiceOver) as active. */
  accessibilityEnabled(): boolean;
  /** The PATH the user's login shell sets up (the toolchain's). */
  shellPath(): Promise<string>;
}

/** The account's shell, or null when the OS cannot say (Windows names none). */
function accountShell(): string | null {
  try {
    return os.userInfo().shell;
  } catch {
    return null;
  }
}

/** Where a project's terminal starts: its folder, the chosen shell, and a clean environment. */
async function projectShell(
  { core, shellPath }: Pick<TerminalIpcDeps, "core" | "shellPath">,
  project: unknown,
  shell: TerminalShell | null,
): Promise<Omit<TerminalLaunch, "kind">> {
  if (!shell) throw new Error(MESSAGE.unsupportedPlatform);
  const entry = (await core.projects.list()).find((entry) => entry.name === project);
  if (!entry) throw new Error(MESSAGE.noProject);
  await core.assertProjectAllowed(entry.dir);
  const env: NodeJS.ProcessEnv = { ...withEnvPath(process.env, await shellPath()), TERM: "xterm-256color" };
  for (const key of Object.keys(env)) if (STUDIO_ONLY_ENV.test(key)) delete env[key];
  return { file: shell.file, args: shell.args, cwd: entry.dir, env, title: entry.title, project: entry.name };
}

export function registerTerminalIpc(handle: IpcHandle, deps: TerminalIpcDeps): void {
  const { terminals, accessibilityEnabled } = deps;
  handle("studio:terminal.list", () => terminals.list());
  handle("studio:terminal.accessibility", () => accessibilityEnabled());
  handle("studio:terminal.open", async (payload) => {
    const shell = terminalShell(process.platform, { userShell: accountShell() });
    return terminals.open({ ...(await projectShell(deps, payload?.project, shell)), kind: TerminalKind.Shell });
  });
  // The user pressed Run on a command a chat reply offered: it runs as that one command line,
  // visibly, in the user's own shell, exactly as if they had typed it in the project terminal.
  handle("studio:terminal.run", async (payload) => {
    const command = runnableCommand(payload?.command);
    if (command === null) throw new Error(MESSAGE.notACommand);
    const shell = commandShell(process.platform, command, { userShell: accountShell() });
    const launch = await projectShell(deps, payload?.project, shell);
    return terminals.open({ ...launch, title: command, kind: TerminalKind.Command, command });
  });
  handle("studio:terminal.attach", (payload) => terminals.attach(payload?.id));
  handle("studio:terminal.input", (payload) => terminals.write(payload?.id, payload?.data));
  handle("studio:terminal.resize", (payload) => terminals.resize(payload?.id, payload?.cols, payload?.rows));
  handle("studio:terminal.ack", (payload) => terminals.acknowledge(payload?.id, payload?.count));
  handle("studio:terminal.stop", (payload) => terminals.stop(payload?.id));
  handle("studio:terminal.remove", (payload) => terminals.remove(payload?.id));
}
