/** Called only by --studio-smoke --studio-terminal-smoke, inside a disposable profile. */
import type { BrowserWindow } from "electron";
import type { TerminalService } from "../terminal-service.ts";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { waitFor } from "./wait.ts";
import { TerminalKind } from "../../shared/terminal.ts";
import { StudioPlatform } from "../../shared/boot.ts";
import { terminalShell } from "../terminal-shell.ts";

/** The POSIX shell the fixture runs in: `/bin/sh`, or on Windows the Git Bash a project's terminal opens. */
function fixtureShell(): string {
  if (process.platform !== StudioPlatform.Windows) return "/bin/sh";
  return terminalShell(StudioPlatform.Windows)?.file ?? "/bin/sh";
}

/** What a Windows program needs in even a minimal environment: the system folder. */
function windowsBasics(): Record<string, string> {
  const systemRoot = process.env.SystemRoot;
  return process.platform === StudioPlatform.Windows && systemRoot ? { SystemRoot: systemRoot } : {};
}

export async function runTerminalAcceptance(
  terminals: TerminalService,
  win: BrowserWindow,
  root: string,
): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const check = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok, ...(detail ? { detail } : {}) });
  };
  const js = (code: string) => win.webContents.executeJavaScript(code, true);
  const until = (predicate: () => Promise<boolean>) => waitFor(predicate, { timeoutMs: 5_000, intervalMs: 25 });
  try {
    if (process.platform === "linux") {
      win.setPosition(0, 0);
      win.showInactive();
    }
    win.webContents.setBackgroundThrottling(false);
    check(
      "renderer loads before native terminal",
      await until(() => js(`!!document.querySelector('[aria-label="Toggle terminal"]')`)),
    );
    const cwd = path.join(root, "terminal fixture");
    await mkdir(cwd, { recursive: true });
    const session = terminals.open({
      file: fixtureShell(),
      args: ["-c", 'printf "PACKAGED_PTY_READY\\n"; IFS= read -r value; printf "INPUT:%s\\n" "$value"'],
      cwd,
      env: { HOME: cwd, PATH: "/usr/bin:/bin", ...windowsBasics() },
      title: "Packaged terminal fixture",
      kind: TerminalKind.Shell,
      project: "fixture-project",
    });
    check(
      "packaged native PTY and helper run from unpacked resources",
      await until(() =>
        js(`document.querySelector('[data-terminal-dock]')?.textContent.includes('PACKAGED_PTY_READY') ?? false`),
      ),
    );
    await js(`window.studio.terminalInput(${JSON.stringify(session.id)}, ${JSON.stringify("hello-from-package\r")})`);
    check(
      "packaged preload delivers input and terminal renders output",
      await until(() =>
        js(`document.querySelector('[data-terminal-dock]')?.textContent.includes('INPUT:hello-from-package') ?? false`),
      ),
    );
    check(
      "process exit reaches renderer after final output",
      await until(() =>
        js(`document.querySelector('[data-terminal-dock]')?.textContent.includes('Process finished') ?? false`),
      ),
    );
    await terminals.dispose();
    check("packaged sessions clean up", terminals.list().length === 0);
  } catch (error) {
    check("packaged terminal acceptance completed", false, String(error));
  } finally {
    await terminals.dispose();
  }
  const failed = checks.filter((check) => !check.ok).length;
  process.stdout.write(
    `\n__TERMINAL_JSON__${JSON.stringify({ platform: process.platform, arch: process.arch, electron: process.versions.electron, checks, failed })}__END__\n`,
  );
  return failed ? 1 : 0;
}
