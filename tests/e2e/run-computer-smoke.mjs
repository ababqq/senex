import { resolveElectron, fixtureElectronArgs, fixtureElectronEnv } from "../../scripts/electron-runtime.mjs";
/** The computer tool over a real hidden window, through the real app; no paid model calls. */
import { spawn } from "node:child_process";
import path from "node:path";
import { startFakeOllama } from "../helpers/fake-ollama.ts";
const server = await startFakeOllama({ respond: () => ({ text: "Smoke fixture" }) });
try {
  const args = process.argv.slice(2).filter((arg) => arg.startsWith("--studio-computer-shot="));
  const packaged = process.env.STUDIO_PACKAGE_DIR;
  const binary = packaged ? path.join(packaged, "Genex.app/Contents/MacOS/genex") : resolveElectron();
  const child = spawn(
    binary,
    fixtureElectronArgs([
      ...(packaged ? [] : ["."]),
      "--studio-smoke",
      "--studio-computer-smoke",
      `--ollama-host=${server.host}`,
      ...args,
    ]),
    { env: fixtureElectronEnv(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  console.log("Driving a fixture project with the computer tool in an isolated app…");
  const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.on("exit", resolve);
      child.on("error", reject);
    });
  } finally {
    clearTimeout(timer);
  }
  const match = /__SMOKE_JSON__([\s\S]*?)__END__/.exec(stdout);
  if (!match) throw new Error(`No smoke report. ${stderr.slice(-2000)}`);
  const report = JSON.parse(match[1]);
  for (const check of report.checks)
    console.log(`${check.ok ? "✔" : "✖"} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
  console.log(`${report.checks.length - report.failed}/${report.checks.length} checks passed`);
  process.exitCode = report.failed === 0 && code === 0 ? 0 : 1;
} finally {
  await server.close();
}
