/**
 * The lane policy every runner shares: the instruction texts, the run workspace's ancestor guard
 * (a hostile table where each refusal creates nothing), the child environment, each lane's argv
 * (no permission bypass can ever appear), the host-skill list, the flags digests and the eval
 * homes. Hermetic: temporary folders only; no CLI is started.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  BANNED_ARGV,
  BannedArgvError,
  codexSandboxArgs,
  DISABLED_CODEX_FEATURES,
  EMPTY_MCP_CONFIG,
  genexAppArgv,
  hostSkillPaths,
  laneFlagsDigest,
  laneFlagsDigestFor,
  rawClaudeArgv,
  rawCodexArgv,
  writePinnedMcpConfig,
} from "../../scripts/evals/lanes/argv.ts";
import {
  answerText,
  checkWorkspaceAncestors,
  createLaneRoot,
  createRunWorkspace,
  instructionSuffix,
  laneChildEnv,
  LOOK_AT_PAGE_LINE,
  RAW_DELIVERABLE,
  rawDeliverable,
  rawPrompt,
  WorkspaceRefusal,
  WorkspaceRefusedError,
} from "../../scripts/evals/lanes/common.ts";
import {
  applyEvalHomesEnv,
  EvalHomesError,
  EvalHomesRefusal,
  evalHomesStatus,
  evalsLayout,
  evalsRoot,
  runWorkRoot,
  usesEvalHomes,
} from "../../scripts/evals/lanes/homes.ts";
import { systemRawLaneDeps } from "../../scripts/evals/lanes/raw.ts";
import { readLaneRegistry } from "../../scripts/evals/lanes/registry.ts";
import { AnswerPolicy, BrowserPin, Effort } from "../../scripts/evals/vocabulary.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { STUDIO_COMMITTER } from "../../src/substrate/snapshots.ts";

const repo = path.resolve(import.meta.dirname, "../..");
const temps: string[] = [];
const tempDir = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eval-lanes-policy-")));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("instruction texts", () => {
  it("renders the shared suffix with the case's minutes and the answer policy's sentence", () => {
    assert.equal(
      instructionSuffix(90),
      "You have about 90 minutes. Get a playable version working early, then keep improving it until the brief is fully met or time runs out. Nobody will answer questions; make reasonable assumptions and continue.",
    );
    assert.ok(instructionSuffix(45).endsWith(answerText(AnswerPolicy.NoAnswers)));
    for (const bad of [0, -5, 1.5, Number.NaN]) assert.throws(() => instructionSuffix(bad), RangeError);
  });

  it("names look-at-page only for the look-at-page browser pin", () => {
    assert.equal(rawDeliverable(BrowserPin.None), RAW_DELIVERABLE);
    assert.equal(rawDeliverable(BrowserPin.LookAtPage), `${RAW_DELIVERABLE}\n\n${LOOK_AT_PAGE_LINE}`);
    assert.equal(rawPrompt("  Make pong.\n", "S", "D"), "Make pong.\n\nS\n\nD");
  });
});

describe("run workspace guard", () => {
  /** Build a hostile tree under a fresh folder; return the work root to try. */
  type Setup = (root: string, home: string) => string;
  const hostile: Array<{ name: string; setup: Setup; refusal: WorkspaceRefusal }> = [
    {
      name: "relative path",
      setup: () => path.join("work", "run"),
      refusal: WorkspaceRefusal.NotAbsolute,
    },
    {
      name: "dot-dot segment",
      setup: (root) => `${root}/a/../work`,
      refusal: WorkspaceRefusal.NotAbsolute,
    },
    {
      name: "inside a git repository",
      setup: (root) => {
        fs.mkdirSync(path.join(root, "repo", ".git"), { recursive: true });
        return path.join(root, "repo", "evals", "work", "r1");
      },
      refusal: WorkspaceRefusal.InsideGitRepo,
    },
    {
      name: "inside a git worktree (a .git file)",
      setup: (root) => {
        fs.mkdirSync(path.join(root, "tree"), { recursive: true });
        fs.writeFileSync(path.join(root, "tree", ".git"), "gitdir: /elsewhere\n");
        return path.join(root, "tree", "work");
      },
      refusal: WorkspaceRefusal.InsideGitRepo,
    },
    ...["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"].map((file) => ({
      name: `below an ${file}`,
      setup: (root: string) => {
        fs.writeFileSync(path.join(root, file), "instructions\n");
        return path.join(root, "work", "r1");
      },
      refusal: WorkspaceRefusal.AgentInstructions,
    })),
    {
      name: "below a .claude folder under $HOME",
      setup: (_root, home) => {
        fs.mkdirSync(path.join(home, "projects", ".claude"), { recursive: true });
        return path.join(home, "projects", "work", "r1");
      },
      refusal: WorkspaceRefusal.AgentInstructions,
    },
    {
      name: "through a symlink into a git repository",
      setup: (root) => {
        fs.mkdirSync(path.join(root, "repo", ".git"), { recursive: true });
        fs.mkdirSync(path.join(root, "repo", "inner"));
        fs.symlinkSync(path.join(root, "repo", "inner"), path.join(root, "link"));
        return path.join(root, "link", "work");
      },
      refusal: WorkspaceRefusal.InsideGitRepo,
    },
    {
      name: "an existing folder that is not empty",
      setup: (root) => {
        fs.mkdirSync(path.join(root, "work"));
        fs.writeFileSync(path.join(root, "work", "left-over.txt"), "x");
        return path.join(root, "work");
      },
      refusal: WorkspaceRefusal.NotEmpty,
    },
    {
      name: "a file where the folder should be",
      setup: (root) => {
        fs.writeFileSync(path.join(root, "work"), "x");
        return path.join(root, "work");
      },
      refusal: WorkspaceRefusal.NotDirectory,
    },
  ];

  for (const row of hostile) {
    it(`refuses ${row.name} and creates nothing`, async () => {
      const root = tempDir();
      const home = path.join(root, "home");
      fs.mkdirSync(home);
      const target = row.setup(root, home);
      const before = fs.existsSync(target) ? fs.statSync(target).mtimeMs : null;
      await assert.rejects(createRunWorkspace(target, home), (error: unknown) => {
        assert.ok(error instanceof WorkspaceRefusedError);
        assert.equal(error.refusal, row.refusal);
        return true;
      });
      const after = fs.existsSync(target) ? fs.statSync(target).mtimeMs : null;
      assert.equal(after, before, "the refused target is untouched");
      assert.equal(fs.existsSync(path.join(target, "project")), false);
    });
  }

  it("creates the work root and an empty project folder in a clean place", async () => {
    const root = tempDir();
    const home = path.join(root, "home");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const workRoot = path.join(home, ".genex-evals", "work", "r1");
    const workspace = await createRunWorkspace(workRoot, home);
    assert.deepEqual(workspace, { workRoot, projectDir: path.join(workRoot, "project") });
    assert.deepEqual(fs.readdirSync(workspace.projectDir), []);
  });

  it("finds this repository when asked about a folder inside it", async () => {
    const check = await checkWorkspaceAncestors(path.join(repo, "never-created", "work"), os.homedir());
    assert.equal(check.ok, false);
  });
});

describe("lane root placement", () => {
  const RUN_ID = "20261001T120000-tiny-pong-raw-codex-r2";
  const OTHER_RUN_ID = "20261001T120000-tiny-pong-genex-claude-r1";

  /** An evals home holding everything an agent must not stumble on: holdouts, the key, the ledger, homes, a finished run. */
  function evalsHome(root: string): string {
    const evals = path.join(root, "evals");
    fs.mkdirSync(path.join(evals, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(evals, "secrets", "genex-evals.key"), "k");
    fs.writeFileSync(path.join(evals, "cases-private.md"), "holdouts");
    fs.mkdirSync(path.join(evals, "ledger"));
    fs.mkdirSync(path.join(evals, "homes", "claude"), { recursive: true });
    fs.mkdirSync(path.join(evals, "work", OTHER_RUN_ID, "project"), { recursive: true });
    fs.writeFileSync(path.join(evals, "work", OTHER_RUN_ID, "project", "project.js"), "finished");
    return evals;
  }

  /** A folder's names, or null when this user may not list it. */
  const listing = (dir: string): string[] | null => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return null;
    }
  };
  // The superuser lists any folder, so the lanes folder's mode hides nothing from it.
  const superuser = process.getuid?.() === 0;
  /** Lanes folders this block made: listable again afterwards, so the temporary root can be removed. */
  const lanesDirs: string[] = [];
  afterEach(() => {
    for (const dir of lanesDirs.splice(0)) if (fs.existsSync(dir)) fs.chmodSync(dir, 0o700);
  });

  it("puts the agent's folder where no ancestor lists the evals home's secrets, holdouts, ledger or another run", {
    skip: superuser,
  }, async () => {
    const root = tempDir();
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    const evals = evalsHome(root);
    const lanes = path.join(root, "lanes");
    lanesDirs.push(lanes);
    const concurrent = await createLaneRoot(lanes, evals);
    fs.mkdirSync(path.join(concurrent, "project"));
    const laneRoot = await createLaneRoot(lanes, evals);
    const { workRoot, projectDir } = await createRunWorkspace(path.join(evals, "work", RUN_ID), home, laneRoot);
    assert.equal(workRoot, path.join(evals, "work", RUN_ID));
    assert.equal(projectDir, path.join(laneRoot, "project"));
    const forbidden = ["cases-private.md", "secrets", "ledger", "homes", OTHER_RUN_ID, path.basename(concurrent)];
    for (let at = path.dirname(projectDir); at !== path.dirname(root); at = path.dirname(at)) {
      const names = listing(at);
      if (names === null) {
        assert.equal(at, lanes, "only the lanes folder refuses a listing");
        continue;
      }
      for (const name of forbidden) assert.equal(names.includes(name), false, `${at} lists ${name}`);
    }
  });

  it("refuses a lanes folder inside the evals home, or one that holds it, and creates nothing", async () => {
    const root = tempDir();
    const evals = evalsHome(root);
    for (const lanes of [path.join(evals, "lanes"), root]) {
      const before = fs.readdirSync(root).sort();
      await assert.rejects(createLaneRoot(lanes, evals), (error: unknown) => {
        assert.ok(error instanceof WorkspaceRefusedError);
        assert.equal(error.refusal, WorkspaceRefusal.InsideEvalsHome);
        return true;
      });
      assert.deepEqual(fs.readdirSync(root).sort(), before);
      assert.equal(fs.existsSync(path.join(evals, "lanes")), false);
    }
  });
});

describe("lane child environment", () => {
  const homes = { claude: "/evals/homes/claude", codex: "/evals/homes/codex" };
  /** Credentials an operator's shell may export; no raw lane's agent may receive any of them (SEC-2). */
  const HOSTILE: NodeJS.ProcessEnv = {
    GITHUB_TOKEN: "ghp_x",
    GH_TOKEN: "gho_x",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    GPG_AGENT_INFO: "/tmp/gpg",
    AWS_SECRET_ACCESS_KEY: "aws",
    AWS_SESSION_TOKEN: "aws-session",
    NPM_TOKEN: "npm",
    CLOUDFLARE_API_TOKEN: "cf",
    GIT_CONFIG_KEY_0: "http.extraheader",
    GIT_CONFIG_VALUE_0: "Authorization: Bearer x",
    DATABASE_URL: "postgres://u:pw@h/db",
    ANTHROPIC_API_KEY: "sk-ant",
    OPENAI_API_KEY: "sk-oai",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    GENEX_TOKEN: "genex",
  };
  const BASICS: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/home/op", LANG: "en_US.UTF-8" };

  for (const engine of [EngineId.ClaudeCode, EngineId.Codex] as const) {
    it(`gives a ${engine} raw lane none of the operator's credentials, keeping the basics and the eval homes`, () => {
      const env = laneChildEnv({ ...BASICS, ...HOSTILE }, homes, engine, ["/work/bin"]);
      for (const name of Object.keys(HOSTILE)) assert.equal(env[name], undefined, name);
      assert.equal(env.PATH, `/work/bin${path.delimiter}/usr/bin`);
      assert.equal(env.HOME, "/home/op");
      assert.equal(env.LANG, "en_US.UTF-8");
      assert.equal(env.CLAUDE_CONFIG_DIR, homes.claude);
      assert.equal(env.CODEX_HOME, homes.codex);
      assert.equal(env.DISABLE_AUTOUPDATER, "1");
    });
  }

  it("drops the other vendor's variables: no OpenAI or Codex switch for Claude, no Anthropic or Claude one for Codex", () => {
    const parent: NodeJS.ProcessEnv = {
      ...BASICS,
      OPENAI_ORG: "org",
      CODEX_SANDBOX: "x",
      ANTHROPIC_MODEL: "m",
      CLAUDE_DEBUG: "1",
    };
    const claude = laneChildEnv(parent, homes, EngineId.ClaudeCode);
    assert.equal(claude.OPENAI_ORG, undefined);
    assert.equal(claude.CODEX_SANDBOX, undefined);
    assert.equal(claude.ANTHROPIC_MODEL, "m");
    const codex = laneChildEnv(parent, homes, EngineId.Codex);
    assert.equal(codex.ANTHROPIC_MODEL, undefined);
    assert.equal(codex.CLAUDE_DEBUG, undefined);
    assert.equal(codex.OPENAI_ORG, "org");
    assert.equal(codex.CLAUDE_CONFIG_DIR, homes.claude, "the eval homes are set after the vendor filter");
  });

  it("strips metered keys, CLI switches and Genex variables, commits as the studio, and points both CLIs at the eval homes", () => {
    const env = laneChildEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/op",
        ANTHROPIC_API_KEY: "k",
        ANTHROPIC_BASE_URL: "u",
        CLAUDE_CODE_OAUTH_TOKEN: "t",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_AGENT_SDK_VERSION: "x",
        OPENAI_API_KEY: "k",
        CODEX_API_KEY: "k",
        GENEX_TOKEN: "t",
        GENEX_EVALS_HOME: "/evals",
        CLAUDE_CONFIG_DIR: "/home/op/.claude",
        CODEX_HOME: "/home/op/.codex",
      },
      homes,
      EngineId.ClaudeCode,
      ["/work/bin"],
    );
    assert.deepEqual(env, {
      PATH: `/work/bin${path.delimiter}/usr/bin`,
      HOME: "/home/op",
      GIT_AUTHOR_NAME: STUDIO_COMMITTER.name,
      GIT_AUTHOR_EMAIL: STUDIO_COMMITTER.email,
      GIT_COMMITTER_NAME: STUDIO_COMMITTER.name,
      GIT_COMMITTER_EMAIL: STUDIO_COMMITTER.email,
      CLAUDE_CONFIG_DIR: homes.claude,
      CODEX_HOME: homes.codex,
      DISABLE_AUTOUPDATER: "1",
    });
  });
});

describe("lane argv", () => {
  it("builds raw Claude's argv (Appendix B)", () => {
    assert.deepEqual(
      rawClaudeArgv({
        model: "claude-opus-5-5",
        effort: Effort.High,
        mcpConfigPath: "/evals/pinned/empty-mcp.json",
        permissionMode: PermissionMode.Auto,
        prompt: "Make pong.",
      }),
      [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "claude-opus-5-5",
        "--effort",
        "high",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        "/evals/pinned/empty-mcp.json",
        "--permission-mode",
        "auto",
        "Make pong.",
      ],
    );
  });

  it("builds raw Codex's argv with the app's sandbox, the network pin and every host skill disabled", () => {
    const argv = rawCodexArgv({
      model: "gpt-6.1-sol",
      effort: Effort.High,
      workspace: "/w/project",
      network: true,
      disabledSkillPaths: ["/home/op/.agents/skills/a/SKILL.md", '/home/op/.agents/skills/q"b/SKILL.md'],
    });
    assert.deepEqual(argv, [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "-m",
      "gpt-6.1-sol",
      "-c",
      'model_reasoning_effort="high"',
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'approval_policy="never"',
      "-c",
      'sandbox_workspace_write.writable_roots=["/w/project"]',
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-c",
      "allow_login_shell=false",
      "-c",
      'forced_login_method="chatgpt"',
      "-c",
      'skills.config=[{path="/home/op/.agents/skills/a/SKILL.md",enabled=false},{path="/home/op/.agents/skills/q\\"b/SKILL.md",enabled=false}]',
      "--disable",
      "computer_use",
      "--disable",
      "in_app_browser",
      "--disable",
      "browser_use",
      "--disable",
      "browser_use_external",
      "-",
    ]);
    assert.deepEqual(DISABLED_CODEX_FEATURES, [
      "computer_use",
      "in_app_browser",
      "browser_use",
      "browser_use_external",
    ]);
    assert.ok(codexSandboxArgs("/w", false).includes("sandbox_workspace_write.network_access=false"));
    const noSkills = rawCodexArgv({
      model: "m1",
      effort: Effort.Low,
      workspace: "/w",
      network: false,
      disabledSkillPaths: [],
    });
    assert.equal(
      noSkills.some((arg) => arg.startsWith("skills.config")),
      false,
    );
  });

  it("builds the Genex smoke sub-runner launch", () => {
    const argv = { buildDir: "/b", userDataRoot: "/w/userdata", specPath: "/w/lane-spec.json", fixture: false };
    assert.deepEqual(genexAppArgv(argv), [
      "/b",
      "--studio-smoke",
      "--userdata=/w/userdata",
      "--studio-eval-lane=/w/lane-spec.json",
    ]);
    assert.equal(genexAppArgv({ ...argv, fixture: true }).at(-1), "--studio-eval-fixture");
  });

  it("never lets a permission bypass or a full-access sandbox into any lane's argv", () => {
    const registry = readLaneRegistry(repo);
    for (const effort of Object.values(Effort))
      for (const network of [true, false]) {
        const argvs = [
          rawCodexArgv({ model: "m1", effort, workspace: "/w", network, disabledSkillPaths: ["/s/SKILL.md"] }),
          rawClaudeArgv({ model: "m1", effort, mcpConfigPath: "/p", permissionMode: PermissionMode.Auto, prompt: "p" }),
          genexAppArgv({ buildDir: "/b", userDataRoot: "/u", specPath: "/s", fixture: network }),
        ];
        for (const argv of argvs)
          for (const banned of BANNED_ARGV)
            assert.equal(
              argv.some((arg) => arg === banned || arg.includes(banned)),
              false,
            );
      }
    assert.ok(BANNED_ARGV.includes("bypassPermissions"));
    assert.ok(BANNED_ARGV.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.throws(
      () =>
        rawClaudeArgv({
          model: "m1",
          effort: Effort.High,
          mcpConfigPath: "/p",
          permissionMode: PermissionMode.Bypass,
          prompt: "p",
        }),
      BannedArgvError,
    );
    assert.throws(
      () => rawCodexArgv({ model: "m1", effort: "turbo", workspace: "/w", network: true, disabledSkillPaths: [] }),
      RangeError,
    );
    assert.ok(registry.lanes.every((lane) => /^[0-9a-f]{12}$/.test(laneFlagsDigest(lane))));
  });

  it("gives every lane a distinct flags digest that moves when a flag moves", () => {
    const lanes = readLaneRegistry(repo).lanes;
    assert.equal(new Set(lanes.map(laneFlagsDigest)).size, lanes.length);
    const raw = lanes.find((lane) => lane.id === "raw-codex");
    assert.ok(raw);
    assert.notEqual(laneFlagsDigest({ ...raw, network: "off" }), laneFlagsDigest(raw));
    assert.equal(laneFlagsDigest(structuredClone(raw)), laneFlagsDigest(raw));
  });

  it("pins raw Claude's digest to the permission mode the runtime launches it with", () => {
    const rawClaude = readLaneRegistry(repo).lanes.find((lane) => lane.id === "raw-claude");
    assert.ok(rawClaude);
    const runtime = systemRawLaneDeps(evalsLayout(tempDir())).permissionMode;
    assert.equal(laneFlagsDigest(rawClaude), laneFlagsDigestFor(rawClaude, runtime));
    const other = runtime === PermissionMode.AcceptEdits ? PermissionMode.Auto : PermissionMode.AcceptEdits;
    assert.notEqual(laneFlagsDigestFor(rawClaude, other), laneFlagsDigest(rawClaude), "the digest moves with the mode");
  });

  it("lists host skills by path, sorted, skipping folders without a SKILL.md", async () => {
    const dir = tempDir();
    for (const name of ["zeta", "alpha", "empty"]) fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, "zeta", "SKILL.md"), "z");
    fs.writeFileSync(path.join(dir, "alpha", "SKILL.md"), "a");
    fs.writeFileSync(path.join(dir, "stray.md"), "s");
    assert.deepEqual(await hostSkillPaths(dir), [
      path.join(dir, "alpha", "SKILL.md"),
      path.join(dir, "zeta", "SKILL.md"),
    ]);
    assert.deepEqual(await hostSkillPaths(path.join(dir, "missing")), []);
  });

  it("lists a linked host skill by its link and by its real path, as the Genex Codex lane does", async () => {
    const root = tempDir();
    const dir = path.join(root, "skills");
    for (const name of ["zeta", "alpha"]) fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, "zeta", "SKILL.md"), "z");
    fs.writeFileSync(path.join(dir, "alpha", "SKILL.md"), "a");
    fs.mkdirSync(path.join(root, "repo", "linked"), { recursive: true });
    fs.writeFileSync(path.join(root, "repo", "linked", "SKILL.md"), "l");
    fs.symlinkSync(path.join(root, "repo", "linked"), path.join(dir, "linked"));
    assert.deepEqual(await hostSkillPaths(dir), [
      path.join(dir, "alpha", "SKILL.md"),
      path.join(dir, "linked", "SKILL.md"),
      fs.realpathSync(path.join(root, "repo", "linked", "SKILL.md")),
      path.join(dir, "zeta", "SKILL.md"),
    ]);
  });

  it("writes the pinned empty MCP config", async () => {
    const file = await writePinnedMcpConfig(path.join(tempDir(), "pinned"));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), EMPTY_MCP_CONFIG);
  });
});

describe("eval homes", () => {
  it("lays out the evals home and refuses a relative override or a non-run id", () => {
    assert.equal(evalsRoot({}, "/home/op"), "/home/op/.genex-evals");
    assert.equal(evalsRoot({ GENEX_EVALS_HOME: "/data/evals" }, "/home/op"), "/data/evals");
    assert.throws(() => evalsRoot({ GENEX_EVALS_HOME: "evals" }, "/home/op"));
    const layout = evalsLayout("/data/evals");
    assert.deepEqual(layout.homes, { claude: "/data/evals/homes/claude", codex: "/data/evals/homes/codex" });
    assert.equal(
      runWorkRoot(layout, "20261001T120000-village-raw-claude-r1"),
      "/data/evals/work/20261001T120000-village-raw-claude-r1",
    );
    for (const bad of ["../etc", "r1", "20261001T120000-village-raw/../x-r1"])
      assert.throws(() => runWorkRoot(layout, bad));
  });

  it("points this process at the eval homes, refusing a variable that names another home", () => {
    const homes = evalsLayout("/data/evals").homes;
    const env: NodeJS.ProcessEnv = {};
    assert.equal(usesEvalHomes(homes, env), false);
    applyEvalHomesEnv(homes, env);
    assert.equal(usesEvalHomes(homes, env), true);
    const other: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: "/home/op/.claude" };
    assert.throws(() => applyEvalHomesEnv(homes, other));
    assert.equal(other.CODEX_HOME, undefined);
  });

  it("refuses another home with a typed error and leaves every variable as it was", () => {
    const homes = evalsLayout("/data/evals").homes;
    const table: Array<[NodeJS.ProcessEnv, string]> = [
      [{ CLAUDE_CONFIG_DIR: "/home/op/.claude" }, "CLAUDE_CONFIG_DIR"],
      [{ CODEX_HOME: "/home/op/.codex" }, "CODEX_HOME"],
    ];
    for (const [env, variable] of table) {
      const before = { ...env };
      assert.throws(
        () => applyEvalHomesEnv(homes, env),
        (error: unknown) =>
          error instanceof EvalHomesError && error.code === EvalHomesRefusal.OtherHome && error.variable === variable,
      );
      assert.deepEqual(env, before, "nothing is half-applied");
    }
  });

  it("asks each CLI for its eval home's sign-in state and flags a Codex API-key login", async () => {
    const asked: string[] = [];
    const status = await evalHomesStatus(
      { claude: "/h/claude", codex: "/h/codex" },
      {
        claude: async (home) => {
          asked.push(home);
          return { loggedIn: true };
        },
        codex: async (home) => {
          asked.push(home);
          return { loggedIn: true, method: "api_key" };
        },
      },
    );
    assert.deepEqual(asked, ["/h/claude", "/h/codex"]);
    assert.deepEqual(status, [
      { engine: EngineId.ClaudeCode, home: "/h/claude", loggedIn: true, apiKeyLogin: false },
      { engine: EngineId.Codex, home: "/h/codex", loggedIn: true, apiKeyLogin: true },
    ]);
  });
});
