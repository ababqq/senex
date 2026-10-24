import path from "node:path";
import { digest, filesBelow, fingerprints } from "../../../scripts/studio-dev/files.mjs";
import { hostGit } from "../../substrate/git-policy.ts";

/**
 * One read of the harness workspace's git, through the host policy: the in-app agent edits that
 * folder, so its own git config is not trusted. Null when git has no answer (not a repository, a
 * folder whose `.git` leads elsewhere, a failed command).
 */
async function harnessGit(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    return (await hostGit(cwd, args)).stdout.trim();
  } catch {
    return null;
  }
}

/**
 * The shipped harness seed against the harness the agent runs, and the harness's git state.
 * `sha` and `dirty` are null when git cannot say, which is not the same as a clean workspace.
 */
export async function harnessIdentity(harnessWs: string, buildRoot: string) {
  const seedDir = path.join(buildRoot, "resources/harness-seed");
  const seed = fingerprints(seedDir, filesBelow(seedDir));
  const runtime = fingerprints(harnessWs, filesBelow(harnessWs));
  const divergent = [...new Set([...Object.keys(seed), ...Object.keys(runtime)])].filter((f) => seed[f] !== runtime[f]);
  const changes = await harnessGit(harnessWs, "status", "--porcelain");
  return {
    shippedDigest: digest(seed),
    runtimeDigest: digest(runtime),
    sha: await harnessGit(harnessWs, "rev-parse", "HEAD"),
    dirty: changes === null ? null : changes !== "",
    divergentPaths: divergent,
  };
}
