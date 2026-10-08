/**
 * Model-written text on a git command line (HQ-1). `run.exec` hands its command to `/bin/sh -c`,
 * and a judge's reason, a build error or a worker's title used to reach it inside double quotes
 * with only `"` replaced — so a backtick or `$(…)` in that text ran as a command and the commit
 * message lost it. `loop/shell.ts` single-quotes such text; these tests run it through a real
 * shell, in a real repository.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { isCommit, shellQuote } from "../../src/harness-seed/loop/shell.ts";
import { enforceOwnership, reviewAttempt } from "../../src/harness-seed/loop/review.ts";
import { unversionedNested } from "../../src/harness-seed/loop/gauntlet.ts";
import { unionMergeMain } from "../../src/harness-seed/loop/merge.ts";
import { STUDIO_AS } from "../../src/harness-seed/loop/repo.ts";
import { readProjectShape } from "../../src/substrate/project-workspace.ts";
import { runSpike } from "../../src/harness-seed/loop/spike.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";
import { fixtureGit } from "../helpers/snapshot-fixtures.ts";
import { shellExec as sh } from "../helpers/posix-shell.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** Text a model could write that a shell would act on, each piece leaving a file behind if it ran. */
const HOSTILE = [
  "a judge's `touch backtick` reason",
  "$(touch dollar) and ${HOME} and $HOME",
  "it's \"quoted\" and 'single' and \\ back",
  "semi; touch semi && touch and || touch or | cat",
  "new\nline and\ttab and * glob ? and ~ tilde and # hash",
  "'; touch escaped; echo '",
];

describe("shellQuote", () => {
  it("hands every hostile string to the program exactly and runs none of it", async () => {
    const dir = await tmpDir("studio-quote-");
    for (const text of HOSTILE) {
      const out = await sh(`printf '%s' ${shellQuote(text)}`, dir);
      assert.equal(out.code, 0, out.stderr);
      assert.equal(out.stdout, text);
    }
    assert.deepEqual(await readdir(dir), [], "nothing in the text ran");
  });
});

describe("a spike's commit message, through a real shell", () => {
  it("keeps a reason with backticks and $(…) as text, and runs none of it", async () => {
    const root = await tmpDir("studio-spike-quote-");
    const worktree = path.join(root, "spike-feel-jump-arc");
    await mkdir(worktree, { recursive: true });
    await fixtureGit(worktree, ["init", "-q", "-b", "main"]);
    await writeFile(path.join(worktree, "index.html"), "<canvas></canvas>\n");
    await fixtureGit(worktree, ["add", "-A"]);
    await fixtureGit(worktree, ["commit", "-q", "-m", "incumbent"]);
    const reason = 'the page `touch backtick` never $(touch dollar) loaded — it\'s "broken"';
    const recorder = ctxRecorder({
      handlers: {
        "engine.describe": () => [{ id: "claude-code", kind: "delegated" }],
        "engine.delegate": () => ({ ok: false, errorText: reason, summary: "" }),
        "events.append": () => true,
        "snapshot.worktree": () => ({ path: worktree, commit: "HEAD" }),
        "run.exec": (p) => sh(String(p.command), String(p.cwd)),
      },
    });
    const check = { id: "jump-arc", kind: "vision", camera: "default" };
    const outcome = await runSpike(recorder.ctx, {
      run: { runId: "run_q", project: "pong", engine: "claude-code" },
      spec: { id: "feel", title: "Project feel", intent: "weighty", checks: [check] },
      check,
      iteration: 1,
      facetThreadId: "facet-thread",
      deadline: Date.now() + 60 * 60_000,
      worktree: true,
      incumbentCommit: "HEAD",
    } as never);
    assert.ok(outcome.branch, "the attempt was committed and bookmarked");
    assert.equal(
      await fixtureGit(worktree, ["log", "-1", "--format=%B"]),
      `spike feel/jump-arc: did not pass — ${reason}`,
    );
    assert.deepEqual((await readdir(worktree)).sort(), [".git", "index.html"], "nothing in the reason ran");
  });
});

/**
 * M3: a file name is the contractor's to choose, a commit hash comes back from a tool, and a
 * project's own studio.json names its entry. Each reached `/bin/sh -c` inside double quotes or bare.
 */
const HOSTILE_FILE = "a$(touch PWNED)`touch PWNED2`.js";
const ran = async (dir: string) => (await readdir(dir)).filter((name) => name.startsWith("PWNED"));

async function repoWith(files: Record<string, string>): Promise<string> {
  const dir = await tmpDir("studio-hostile-repo-");
  await fixtureGit(dir, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(dir, "index.html"), "<canvas></canvas>\n");
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  await fixtureGit(dir, ["add", "-A"]);
  await fixtureGit(dir, ["commit", "-q", "-m", "incumbent"]);
  return dir;
}

describe("hostile names and hashes on the loop's command lines (M3)", () => {
  it("isCommit takes a hash or HEAD and nothing a shell or git would act on", () => {
    for (const ok of ["0123abc", "a".repeat(40), "b".repeat(64), "HEAD"]) assert.equal(isCommit(ok), true, ok);
    for (const bad of [
      "",
      "abc",
      "HEAD; touch PWNED",
      "$(touch PWNED)",
      "--output=/tmp/x",
      "a".repeat(65),
      "0123ABZ",
      "main",
      null,
      42,
    ])
      assert.equal(isCommit(bad), false, String(bad));
  });

  it("reviewAttempt diffs a file named like a command, and runs none of it", async () => {
    const worktree = await repoWith({});
    const incumbent = await fixtureGit(worktree, ["rev-parse", "HEAD"]);
    await writeFile(path.join(worktree, HOSTILE_FILE), "export const a = 1;\n");
    await fixtureGit(worktree, ["add", "-A"]);
    await fixtureGit(worktree, ["commit", "-q", "-m", "integration"]);
    const integration = await fixtureGit(worktree, ["rev-parse", "HEAD"]);
    await writeFile(path.join(worktree, HOSTILE_FILE), "export const a = 2;\n");
    await fixtureGit(worktree, ["commit", "-q", "-am", "attempt"]);
    const recorder = ctxRecorder({ handlers: { "run.exec": (p) => sh(String(p.command), String(p.cwd)) } });
    const review = await reviewAttempt(recorder.ctx, {
      run: { runId: "run_q", project: "pong" },
      spec: { id: "hud", owns: ["src/hud.js"] },
      worktree,
      incumbentCommit: incumbent,
      integrationHead: ["$(touch PWNED3)", integration],
      model: false,
    } as never);
    assert.equal(review.merged, true);
    assert.deepEqual(review.files, [HOSTILE_FILE], "the file was still reviewed");
    assert.deepEqual(await ran(worktree), []);
  });

  it("enforceOwnership quarantines a file named like a command, and refuses a base that is no commit", async () => {
    const worktree = await repoWith({});
    const base = await fixtureGit(worktree, ["rev-parse", "HEAD"]);
    await writeFile(path.join(worktree, HOSTILE_FILE), "stray\n");
    const git = async (command: string) => {
      const out = await sh(command, worktree);
      if (out.code !== 0) throw new Error(out.stderr);
      return out.stdout.trim();
    };
    const violations = [{ source: "mechanical", what: "outside this facet's ownership", file: HOSTILE_FILE }];
    for (const hostileBase of ["HEAD; touch PWNED4", "$(touch PWNED5)"]) {
      await assert.rejects(
        enforceOwnership(git, { base: hostileBase, violations, iterationId: "it-1" }),
        /not a commit/,
      );
    }
    const enforced = await enforceOwnership(git, {
      base,
      integrationHeads: ["$(touch PWNED6)"],
      violations,
      iterationId: "it-1",
    });
    assert.deepEqual(enforced, [{ file: HOSTILE_FILE, action: "quarantined to .studio/quarantine/it-1" }]);
    assert.deepEqual(await readdir(path.join(worktree, ".studio", "quarantine", "it-1")), [HOSTILE_FILE]);
    assert.deepEqual(await ran(worktree), []);
  });

  it("unversionedNested asks about a nested path named like a command, and runs none of it", async () => {
    const worktree = await repoWith({});
    assert.deepEqual(
      await unversionedNested(
        (command: string) => sh(command, worktree).then((out) => out.stdout),
        ["$(touch PWNED7)", "`touch PWNED8`"],
      ),
      [],
    );
    assert.deepEqual(await ran(worktree), []);
  });

  it("unionMergeMain merges an entry named like a command, with a message like one, and runs none of it", async () => {
    const main = "src/main.js; touch PWNED9";
    const wiring = (line: string) => `import "./base.js";\n// ── FACET WIRING\n${line}\n// ── END FACET WIRING\n`;
    const worktree = await repoWith({ [main]: wiring("") });
    await fixtureGit(worktree, ["checkout", "-q", "-b", "theirs"]);
    await writeFile(path.join(worktree, main), wiring('import "./theirs.js";'));
    await fixtureGit(worktree, ["commit", "-q", "-am", "theirs"]);
    await fixtureGit(worktree, ["checkout", "-q", "main"]);
    await writeFile(path.join(worktree, main), wiring('import "./ours.js";'));
    await fixtureGit(worktree, ["commit", "-q", "-am", "ours"]);
    // With the studio's identity, as the loop's own merge has it: a runner whose email git cannot
    // work out (Windows: user@host.(none)) refuses an anonymous merge before it conflicts.
    const conflicted = await sh(`git ${STUDIO_AS} merge -q theirs`, worktree);
    assert.equal(conflicted.code, 1, `the merge conflicts: ${conflicted.stderr}`);
    const merged = await unionMergeMain((command: string) => sh(command, worktree), {
      main,
      message: "merge $(touch PWNED10) `touch PWNED11`",
    });
    assert.equal(merged.ok, true, merged.reason);
    assert.match(
      await readFile(path.join(worktree, main), "utf8"),
      /ours\.js[\s\S]*theirs\.js|theirs\.js[\s\S]*ours\.js/,
    );
    assert.equal(await fixtureGit(worktree, ["log", "-1", "--format=%s"]), "merge $(touch PWNED10) `touch PWNED11`");
    assert.deepEqual(await ran(worktree), []);
  });

  it("a project's studio.json cannot name an entry that is not a plain relative path", async () => {
    for (const main of ["src/main.js; touch PWNED", "/etc/passwd", "../outside.js", "src/$(x).js", "a\nb.js"]) {
      const dir = await tmpDir("studio-shape-main-");
      await writeFile(path.join(dir, "studio.json"), JSON.stringify({ entry: "index.html", main }));
      assert.equal((await readProjectShape(dir)).main, "src/main.js", JSON.stringify(main));
    }
    const dir = await tmpDir("studio-shape-main-");
    await writeFile(
      path.join(dir, "studio.json"),
      JSON.stringify({ entry: "index.html", main: "project/Main Scene.js" }),
    );
    assert.equal(
      (await readProjectShape(dir)).main,
      "project/Main Scene.js",
      "an ordinary name with a space still counts",
    );
  });
});
