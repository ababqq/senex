/**
 * What the stub CLIs share: a recording's lines filled with this run's values, and the replay that
 * writes each event to stdout after its recorded gap (so the lane's receive timestamps keep the
 * recorded pacing) and writes the recorded project into the working folder where the recording says.
 * The recordings are synthetic and redacted: no real path, id, account or file content.
 */
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** The recordings the stubs replay. */
const RECORDINGS = path.join(import.meta.dirname, "recordings");
/** The project every recorded build wrote: the calibration's known-good mini golf. */
const PROJECT_DIR = path.resolve(import.meta.dirname, "../calibration/known-good-mini-golf");

/** A value spliced into a JSON string, escaped as JSON would escape it. */
const inJson = (value) => JSON.stringify(String(value)).slice(1, -1);

/** A recording's lines, `{{NAME}}` filled from `values`, parsed. */
export async function recording(name, values) {
  const text = await readFile(path.join(RECORDINGS, name), "utf8");
  const filled = text.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) => (key in values ? inJson(values[key]) : whole));
  return filled
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Copy the recorded project into `dir`. */
async function writeProject(dir) {
  await mkdir(dir, { recursive: true });
  for (const name of await readdir(PROJECT_DIR)) await copyFile(path.join(PROJECT_DIR, name), path.join(dir, name));
}

/** Replay a stream: each line after its gap; `onEvent` sees each event as it is written. */
export async function replay(lines, { cwd, onEvent = async () => {} }) {
  for (const line of lines) {
    await sleep(line.afterMs ?? 0);
    if (line.writeProject) {
      await writeProject(cwd);
      continue;
    }
    process.stdout.write(`${JSON.stringify(line.event)}\n`);
    await onEvent(line.event);
  }
}

/** Standard input, read to its end. */
export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** An ISO timestamp of now. */
export const nowIso = () => new Date().toISOString();

/** Leave quietly on the rail's SIGTERM, as a CLI does. */
export function exitOnTerm() {
  process.on("SIGTERM", () => process.exit(143));
}
