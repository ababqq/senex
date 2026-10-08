import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

// The tracked Claude Code project settings: a conservative permission set plus an edit-time boundary hook.
const root = path.resolve(import.meta.dirname, "../..");
type Hook = { type: string; command: string; timeout?: number };
type Settings = {
  permissions: Record<"allow" | "deny", string[]> & { ask?: string[] };
  hooks: Record<string, { matcher?: string; hooks: Hook[] }[]>;
};
const settings = JSON.parse(fs.readFileSync(path.join(root, ".claude/settings.json"), "utf8")) as Settings;
const RULE = /^(Bash|Read|Edit|Write|WebFetch)\(.+\)$/;

test("permissions are allow/deny arrays of tool rules, each rule in one list only", () => {
  const all: string[] = [];
  for (const list of ["allow", "deny"] as const) {
    assert.ok(Array.isArray(settings.permissions[list]), `permissions.${list}`);
    for (const rule of settings.permissions[list]) {
      assert.match(rule, RULE);
      all.push(rule);
    }
  }
  assert.equal(new Set(all).size, all.length, "a rule appears twice");
});

test("destructive and owner-data rules are denied; risky commands are never pre-allowed", () => {
  const { allow, deny } = settings.permissions;
  for (const rule of [
    "Bash(git reset --hard*)",
    "Bash(git clean*)",
    "Bash(rm -rf *)",
    "Edit(~/AI Projects/**)",
    // The normal profile lives under Genex; the legacy folder stays denied while a copy fallback may keep it.
    "Read(~/Library/Application Support/Genex/**)",
    "Edit(~/Library/Application Support/Genex/**)",
    "Read(~/Library/Application Support/AI Game Studio/**)",
    "Edit(~/Library/Application Support/AI Game Studio/**)",
  ])
    assert.ok(deny.includes(rule), `deny ${rule}`);
  // The project adds no "ask" rules: they override the owner's chosen mode (even bypass) and stall
  // unattended agents. Pushes, installs and full runs are simply not pre-allowed, so the session's
  // own permission mode decides.
  assert.equal(settings.permissions.ask, undefined);
  // Nothing in allow may reach a full run, the real app, installs or history rewrites by prefix.
  for (const rule of allow)
    assert.doesNotMatch(
      rule,
      /npm (start|install|ci)|npm run (verify\)|package|hooks)|git (push|checkout|reset|clean|worktree)|rm /,
      rule,
    );
});

test("every hook is a command whose script or binary exists in this checkout", () => {
  const commands = Object.values(settings.hooks)
    .flat()
    .flatMap((group) => group.hooks);
  assert.ok(commands.length >= 1);
  for (const hook of commands) {
    assert.equal(hook.type, "command");
    const paths = [...hook.command.matchAll(/(?:^|[\s(])((?:scripts|node_modules)\/[\w./-]+)/g)].map((m) => m[1]!);
    assert.ok(paths.length, `hook names no repo script: ${hook.command}`);
    for (const rel of paths) assert.ok(fs.existsSync(path.join(root, rel)), `${rel} is missing`);
  }
  assert.equal(settings.hooks.PostToolUse?.[0]?.matcher, "Edit|Write|MultiEdit");
  assert.equal(settings.hooks.Stop, undefined, "read-only turns must not trigger verification at Stop");
});

// Claude Code checks deny, then ask, then allow; `*` in a Bash rule matches any run of characters.
const bashRule = (rule: string) =>
  new RegExp(
    `^${rule
      .slice(5, -1)
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
const decide = (command: string) =>
  (["deny", "ask", "allow"] as const).find((list) =>
    (settings.permissions[list] ?? []).some((rule) => rule.startsWith("Bash(") && bashRule(rule).test(command)),
  ) ?? "prompt";

test("studio:dev reads fixture profiles without a prompt and never pre-allows anything that can reach live providers", () => {
  for (const command of [
    "npm run studio:dev -- fixtures",
    "npm run studio:dev -- status --profile a",
    "npm run studio:dev -- snapshot --profile a --scope chat",
    "npm run studio:dev -- stop --profile a",
    "npm run studio:dev -- logs --profile a",
  ])
    assert.equal(decide(command), "allow", command);
  // start is not pre-allowed: a glob cannot exclude `--providers live` from a fixture start, and
  // without project ask rules the session's own mode decides. restart reuses the profile's stored providers; ui/diagnostics drive whatever profile they are given.
  for (const command of [
    "npm run studio:dev -- restart --profile a",
    "npm run studio:dev -- ui --profile a --json {}",
    "npm run studio:dev -- diagnostics --profile a --request -",
    "npm run studio:dev -- start --profile a --fixture app-basics --providers live",
    "npm run studio:dev -- start --profile a --providers live",
    "npm run studio:dev -- start --profile a",
    "npm run studio:dev -- start --profile a --fixture app-basics",
  ])
    assert.notEqual(decide(command), "allow", command);
});

test("the boundary hook skips with a note, never a false boundary failure, when node on PATH is not Node 24", {
  skip: process.platform === "win32" && "the developer's agent hooks run under /bin/sh",
}, () => {
  const hook = settings.hooks.PostToolUse![0]!.hooks[0]!;
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "hook-node-"));
  const run = () =>
    spawnSync("/bin/sh", ["-c", hook.command], {
      env: { PATH: `${bin}:/usr/bin:/bin`, CLAUDE_PROJECT_DIR: root },
      encoding: "utf8",
    });
  try {
    // Stands in for Node 18: check-node.mjs fails there, and so would check-boundaries.ts (.ts extension).
    fs.writeFileSync(path.join(bin, "node"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const wrong = run();
    assert.equal(wrong.status, 0, wrong.stderr);
    assert.match(wrong.stderr, /boundary hook skipped: Node 24/);
    assert.doesNotMatch(wrong.stderr, /verify:architecture failed/);
    // The runtime running this test is Node 24, and the checkout's boundaries are clean.
    fs.writeFileSync(path.join(bin, "node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
    const right = run();
    assert.equal(right.status, 0, right.stderr);
    assert.equal(right.stderr, "");
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
