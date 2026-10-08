/**
 * The stub CLIs a raw fixture lane (B/C) runs instead of a provider's (§13.8): executables in
 * `tests/fixtures/evals/bin`, named after the CLI they stand in for (`<binary>-stub`), that replay a
 * recorded, redacted stream with its receive timing and write the recorded project. A fixture lane is
 * pinned to them here, so no fixture lane ever resolves the machine's own CLI; every other lane
 * keeps the app's CLI discovery.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { CodingProvider } from "../../../src/shared/coding-cli.ts";
import { SECOND_MS } from "../../../src/shared/duration.ts";
import { cliVersion, codingCliBinary } from "../../../src/substrate/engines/external-cli.ts";
import type { CliResolver } from "./argv.ts";
import type { LaneRegistryRow } from "./types.ts";

const run = promisify(execFile);

/** The repository these scripts ship in. */
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
/** Where the stub CLIs live, relative to the repository root. */
export const FIXTURE_STUB_DIR = path.join("tests", "fixtures", "evals", "bin");
/** The suffix a stub carries after the binary name it stands in for. */
const STUB_SUFFIX = "-stub";
/** How long a stub may take to print its version. */
const VERSION_TIMEOUT_MS = 10 * SECOND_MS;

/** The stub standing in for `engine`'s CLI. */
export function fixtureStubPath(engine: CodingProvider, root: string = REPO_ROOT): string {
  return path.join(root, FIXTURE_STUB_DIR, `${codingCliBinary(engine)}${STUB_SUFFIX}`);
}

/** Resolve the stubs as the app's discovery resolves a CLI: its path and the version it prints; a missing stub throws. */
export function fixtureStubResolver(root: string = REPO_ROOT): CliResolver {
  return async (engine) => {
    const file = fixtureStubPath(engine, root);
    const { stdout } = await run(file, ["--version"], { timeout: VERSION_TIMEOUT_MS });
    return { path: file, version: cliVersion(stdout.trim()) ?? null };
  };
}

/** The resolver a lane runs with: a fixture lane's stubs, else the machine's CLI. */
export function laneCliResolver(
  lane: Pick<LaneRegistryRow, "fixture">,
  machine: CliResolver,
  stubs: CliResolver = fixtureStubResolver(),
): CliResolver {
  return lane.fixture ? stubs : machine;
}
