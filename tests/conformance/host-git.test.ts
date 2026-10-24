/**
 * A project folder is somebody else's data: its `.git/config` and `.gitattributes` name programs
 * (filters, merge and diff drivers, a signature checker, an editor, a transport) and git runs
 * them. Host git must never run one. Every row plants a program that leaves a marker file where it
 * runs, drives the real git through `hostGit`, and expects no marker. POSIX only: the planted
 * programs are shell scripts.
 */
import assert from "node:assert/strict";
import { appendFile, chmod, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { describe, it } from "node:test";
import { HostGitRefusal, hostGit, hostGitContext, hostGitCommand } from "../../src/substrate/git-policy.ts";
import { GIT_ENV } from "../../src/substrate/snapshots.ts";
import { fixtureGit } from "../helpers/snapshot-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";

const POSIX = process.platform !== "win32";
const exists = (target: string): Promise<boolean> =>
  stat(target).then(
    () => true,
    () => false,
  );

interface Planted {
  /** The folder under attack: a repository with one commit holding `a.txt`. */
  dir: string;
  /** A file the planted programs create when they run. */
  marker: string;
  /** A script that creates the marker and then behaves as `cat`: a filter or a driver. */
  program: string;
  /** A script that creates the marker and fails at once, so it never waits on input: a transport, an editor. */
  failing: string;
  /** The same as a shell one-liner, for config values. */
  command: string;
}

async function planted(): Promise<Planted> {
  const outside = await tmpDir("host-git-outside-");
  const marker = path.join(outside, "RAN");
  const program = path.join(outside, "program.sh");
  await writeFile(program, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
  await chmod(program, 0o755);
  const failing = path.join(outside, "failing.sh");
  await writeFile(failing, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  await chmod(failing, 0o755);
  const dir = path.join(await tmpDir("host-git-repo-"), "project");
  await mkdir(dir, { recursive: true });
  await fixtureGit(dir, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(dir, "a.txt"), "one\n");
  await fixtureGit(dir, ["add", "-A"]);
  await fixtureGit(dir, ["commit", "-q", "-m", "one"]);
  await writeFile(path.join(dir, "a.txt"), "two\n");
  await fixtureGit(dir, ["commit", "-q", "-am", "two"]);
  return { dir, marker, program, failing, command: `touch '${marker}'; cat` };
}

/** Text appended to the folder's `.git/config`, byte for byte (a name git writes could be any bytes). */
const config = (dir: string, text: string | Buffer) => appendFile(path.join(dir, ".git", "config"), text);
const attributes = (dir: string, text: string | Buffer) => writeFile(path.join(dir, ".gitattributes"), text);

const refused = (code: string) => (error: unknown) => (error as { code?: unknown })?.code === code;

describe("host git never runs a program a folder's config names", { skip: !POSIX && "shell-script fixtures" }, () => {
  const FILTER_NAMES: Array<{ label: string; name: string | Buffer; select: boolean; outcome: "works" | "refused" }> = [
    { label: "plain", name: "hostile", select: true, outcome: "works" },
    { label: "a space (config only)", name: "a b", select: false, outcome: "works" },
    { label: "non-ASCII", name: "é", select: true, outcome: "works" },
    { label: "a dot", name: "a.b", select: true, outcome: "works" },
    { label: "mixed case", name: "Hostile", select: true, outcome: "works" },
    { label: "U+2028", name: "a b", select: true, outcome: "works" },
    // Git never selects these from an attribute line (a carriage return is whitespace there, and a line
    // over 2048 bytes is ignored), so they are set in the config only; the pure table holds the rest.
    { label: "a carriage return (config only)", name: "a\rb", select: false, outcome: "works" },
    { label: "3000 characters (config only)", name: "x".repeat(3000), select: false, outcome: "works" },
    { label: "an equals sign", name: "a=b", select: true, outcome: "refused" },
    { label: "a byte that is not UTF-8", name: Buffer.from([0x68, 0xff, 0x69]), select: true, outcome: "refused" },
  ];

  for (const row of FILTER_NAMES)
    for (const locale of ["C.UTF-8", "C"])
      it(`neutralizes a filter named with ${row.label}, whatever the locale (${locale})`, async () => {
        const { dir, marker, command } = await planted();
        const name = Buffer.isBuffer(row.name) ? row.name : Buffer.from(row.name);
        const section = (verb: string, value: string) =>
          Buffer.concat([Buffer.from(`[filter "`), name, Buffer.from(`"]\n\t${verb} = ${value}\n`)]);
        for (const [verb, value] of [
          ["clean", command],
          ["smudge", command],
          ["process", command],
          ["required", "true"],
        ] as const)
          await config(dir, section(verb, value));
        if (row.select) await attributes(dir, Buffer.concat([Buffer.from("* filter="), name, Buffer.from("\n")]));
        await writeFile(path.join(dir, "new.txt"), "raw bytes\n");
        const env = { LANG: locale, LC_ALL: locale };
        if (row.outcome === "refused") {
          await assert.rejects(() => hostGit(dir, ["add", "-A"], { env }), refused(HostGitRefusal.UnsafeConfigKey));
        } else {
          await hostGit(dir, ["add", "-A"], { env });
          assert.equal(await fixtureGit(dir, ["cat-file", "-p", ":new.txt"]), "raw bytes");
          await writeFile(path.join(dir, "a.txt"), "edited\n");
          await hostGit(dir, ["reset", "-q", "--hard", "HEAD"], { env });
          assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "two\n");
        }
        assert.equal(await exists(marker), false, "the filter never ran");
      });

  it("neutralizes a filter an included file defines, and ignores an include that is not there", async () => {
    const { dir, marker, command } = await planted();
    const extra = path.join(path.dirname(marker), "extra.config");
    await writeFile(extra, `[filter "viaInclude"]\n\tclean = ${command}\n\tsmudge = ${command}\n`);
    await config(dir, `[include]\n\tpath = ${extra}\n\tpath = ${path.join(path.dirname(marker), "missing.config")}\n`);
    await config(dir, `[includeIf "gitdir:${dir}/"]\n\tpath = ${extra}\n`);
    await attributes(dir, "* filter=viaInclude\n");
    await writeFile(path.join(dir, "new.txt"), "x\n");
    await hostGit(dir, ["add", "-A"]);
    assert.equal(await exists(marker), false);
  });

  it("does not wait on an include that reads standard input", async () => {
    const { dir } = await planted();
    await config(dir, `[include]\n\tpath = /dev/stdin\n`);
    // The git that macOS ships reads /dev/stdin and blocks until the scan's timeout kills it; others fail
    // at once or read an empty file. Either answer is fine; waiting is not.
    const outcome = await hostGit(dir, ["status", "--porcelain"]).then(
      () => "answered",
      (error: { killed?: boolean }) => (error.killed === true ? "waited" : "answered"),
    );
    assert.equal(outcome, "answered");
  });

  it("never proceeds unpinned on a key too long to pass to git", async () => {
    const { dir, marker, program } = await planted();
    const long = "y".repeat(200_000);
    // Chosen by the config, which has no length limit: an attribute line over 2048 bytes is ignored.
    await config(dir, `[merge]\n\tdefault = ${long}\n[merge "${long}"]\n\tdriver = ${program} %O %A %B\n`);
    await fixtureGit(dir, ["checkout", "-q", "-b", "build", "HEAD~1"]);
    await writeFile(path.join(dir, "a.txt"), "build side\n");
    await fixtureGit(dir, ["commit", "-q", "-am", "build"]);
    await fixtureGit(dir, ["checkout", "-q", "main"]);
    await assert.rejects(() => hostGit(dir, ["merge", "--no-ff", "-m", "land", "build"], { env: GIT_ENV }));
    assert.equal(await exists(marker), false);
  });

  it("neutralizes a merge driver chosen by .git/info/attributes or merge.default, and a landing that depends on it conflicts", async () => {
    for (const how of ["attributes", "default"] as const) {
      const { dir, marker, program } = await planted();
      await config(dir, `[merge "evil"]\n\tdriver = ${program} %O %A %B\n`);
      if (how === "attributes") {
        await mkdir(path.join(dir, ".git", "info"), { recursive: true });
        await writeFile(path.join(dir, ".git", "info", "attributes"), "a.txt merge=evil\n");
      } else {
        await config(dir, `[merge]\n\tdefault = evil\n`);
      }
      await fixtureGit(dir, ["checkout", "-q", "-b", "build", "HEAD~1"]);
      await writeFile(path.join(dir, "a.txt"), "build side\n");
      await fixtureGit(dir, ["commit", "-q", "-am", "build"]);
      await fixtureGit(dir, ["checkout", "-q", "main"]);
      await assert.rejects(() => hostGit(dir, ["merge", "--no-ff", "-m", "land", "build"]), how);
      assert.equal(await exists(marker), false, `merge driver via ${how} never ran`);
      await hostGit(dir, ["merge", "--abort"]).catch(() => undefined);
      assert.equal(await fixtureGit(dir, ["rev-parse", "HEAD"]), await fixtureGit(dir, ["rev-parse", "main"]));
    }
  });

  /** Two branches that both rewrite a.txt, `a.txt` set to merge with `driver`; the checked-out one is `main`. */
  async function divergedOn(dir: string, driver: string) {
    await mkdir(path.join(dir, ".git", "info"), { recursive: true });
    await writeFile(path.join(dir, ".git", "info", "attributes"), `a.txt merge=${driver}\n`);
    await fixtureGit(dir, ["checkout", "-q", "-b", "build", "HEAD~1"]);
    await writeFile(path.join(dir, "a.txt"), "build side\n");
    await fixtureGit(dir, ["commit", "-q", "-am", "build"]);
    await fixtureGit(dir, ["checkout", "-q", "main"]);
  }

  it("keeps the keep-mine merge driver a person set (`true`), so a landing that relies on it still lands", async () => {
    const { dir, marker } = await planted();
    await config(dir, `[merge "ours"]\n\tdriver = true\n`);
    await divergedOn(dir, "ours");
    await hostGit(dir, ["merge", "--no-ff", "-m", "land", "build"], { env: GIT_ENV });
    assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "two\n", "the checked-out side was kept");
    assert.equal(await exists(marker), false);
  });

  it("still neutralizes a merge driver that is more than `true` or `false`", async () => {
    for (const driver of ["true && touch MARKER", "true %A", "/bin/true", "false && touch MARKER"]) {
      const { dir, marker } = await planted();
      await config(dir, `[merge "ours"]\n\tdriver = ${driver.replace("MARKER", `'${marker}'`)}\n`);
      await divergedOn(dir, "ours");
      await assert.rejects(() => hostGit(dir, ["merge", "--no-ff", "-m", "land", "build"], { env: GIT_ENV }), driver);
      assert.equal(await exists(marker), false, driver);
    }
  });

  it("neutralizes a merge driver set twice when the value git uses is a program, whichever comes first", async () => {
    for (const [first, second] of [
      ["true", "PROGRAM"],
      ["PROGRAM", "true"],
      ["false", "PROGRAM"],
    ] as const) {
      const { dir, marker, program } = await planted();
      const value = (word: string) => (word === "PROGRAM" ? `${program} %O %A %B` : word);
      await config(dir, `[merge "ours"]\n\tdriver = ${value(first)}\n\tdriver = ${value(second)}\n`);
      await divergedOn(dir, "ours");
      await assert.rejects(
        () => hostGit(dir, ["merge", "--no-ff", "-m", "land", "build"], { env: GIT_ENV }),
        `${first} then ${second}`,
      );
      assert.equal(await exists(marker), false, `${first} then ${second}`);
    }
  });

  it("refuses a merge driver whose name cannot be passed to git, running nothing", async () => {
    const { dir, marker, program } = await planted();
    await config(dir, `[merge "a=b"]\n\tdriver = ${program} %O %A %B\n`);
    await mkdir(path.join(dir, ".git", "info"), { recursive: true });
    await writeFile(path.join(dir, ".git", "info", "attributes"), "a.txt merge=a=b\n");
    await fixtureGit(dir, ["checkout", "-q", "-b", "build", "HEAD~1"]);
    await writeFile(path.join(dir, "a.txt"), "build side\n");
    await fixtureGit(dir, ["commit", "-q", "-am", "build"]);
    await fixtureGit(dir, ["checkout", "-q", "main"]);
    await assert.rejects(
      () => hostGit(dir, ["merge", "--no-ff", "-m", "land", "build"]),
      refused(HostGitRefusal.UnsafeConfigKey),
    );
    assert.equal(await exists(marker), false);
  });

  it("neutralizes diff text conversion, a diff command and diff.external, behind any leading option", async () => {
    const { dir, marker, program, command } = await planted();
    await config(
      dir,
      `[diff "evil"]\n\ttextconv = ${program}\n\tcommand = ${program}\n[diff]\n\texternal = ${program}\n`,
    );
    await attributes(dir, "* diff=evil\n");
    for (const args of [
      ["--no-pager", "log", "-p", "-1"],
      ["diff", "HEAD~1"],
      ["--no-optional-locks", "diff", "HEAD~1"],
      ["-c", "core.pager=cat", "show", "HEAD"],
    ])
      await hostGit(dir, args).catch(() => undefined);
    assert.equal(await exists(marker), false, command);
  });

  it("never runs a signature checker, for a log that shows signatures or a merge that verifies them", async () => {
    const { dir, marker, failing } = await planted();
    await config(
      dir,
      `[gpg]\n\tprogram = ${failing}\n[log]\n\tshowSignature = true\n[merge]\n\tverifySignatures = true\n`,
    );
    const tree = await fixtureGit(dir, ["rev-parse", "HEAD^{tree}"]);
    const parent = await fixtureGit(dir, ["rev-parse", "HEAD~1"]);
    const forged = [
      `tree ${tree}`,
      `parent ${parent}`,
      "author A <a@example.invalid> 1700000000 +0000",
      "committer A <a@example.invalid> 1700000000 +0000",
      "gpgsig -----BEGIN PGP SIGNATURE-----",
      " ",
      " AAAA",
      " -----END PGP SIGNATURE-----",
      "",
      "forged",
      "",
    ].join("\n");
    await writeFile(path.join(path.dirname(marker), "forged.txt"), forged);
    const hash = await fixtureGit(dir, [
      "hash-object",
      "-t",
      "commit",
      "-w",
      path.join(path.dirname(marker), "forged.txt"),
    ]);
    await fixtureGit(dir, ["update-ref", "refs/heads/forged", hash]);
    await hostGit(dir, ["log", "-1", "--format=%G?", "forged"]).catch(() => undefined);
    await hostGit(dir, ["log", "-1", "--format=%H", "forged"]).catch(() => undefined);
    await assert.rejects(() => hostGit(dir, ["merge", "--no-ff", "-m", "x", "forged"]));
    assert.equal(await exists(marker), false);
  });

  it("never lets auto-maintenance run the program a gc.recentObjectsHook names", async () => {
    const { dir, marker, failing } = await planted();
    await config(dir, `[gc]\n\tauto = 1\n\tpruneExpire = now\n\trecentObjectsHook = ${failing} TAG\n`);
    // Enough loose objects for `gc --auto` to run: it counts the files in objects/17 and scales by 256.
    await mkdir(path.join(dir, ".git", "objects", "17"), { recursive: true });
    for (const name of ["a".repeat(38), "b".repeat(38)])
      await writeFile(path.join(dir, ".git", "objects", "17", name), "not an object");
    await hostGit(dir, ["commit", "--allow-empty", "-m", "x"], { env: GIT_ENV }).catch(() => undefined);
    await hostGit(dir, ["merge", "--no-ff", "-m", "y", "HEAD"], { env: GIT_ENV }).catch(() => undefined);
    assert.equal(await exists(marker), false);
  });

  it("never lets auto-maintenance run a hook that the merge itself brings in through an include", async () => {
    const { dir, marker, failing } = await planted();
    await fixtureGit(dir, ["checkout", "-q", "-b", "build", "HEAD~1"]);
    await mkdir(path.join(dir, ".inc"));
    await writeFile(path.join(dir, ".inc", "gc.cfg"), `[gc]\n\trecentObjectsHook = ${failing} TAG\n`);
    await fixtureGit(dir, ["add", ".inc/gc.cfg"]);
    await fixtureGit(dir, ["commit", "-q", "-m", "build"]);
    await fixtureGit(dir, ["checkout", "-q", "main"]);
    // The file is not there yet, so a scan finds nothing to turn off; the landing writes it, and the
    // auto-maintenance that follows the merge reads the config again.
    await config(dir, `[include]\n\tpath = ../.inc/gc.cfg\n[gc]\n\tauto = 1\n\tpruneExpire = now\n`);
    await mkdir(path.join(dir, ".git", "objects", "17"), { recursive: true });
    for (const name of ["a".repeat(38), "b".repeat(38)])
      await writeFile(path.join(dir, ".git", "objects", "17", name), "not an object");
    await hostGit(dir, ["merge", "--no-ff", "-m", "land", "build"], { env: GIT_ENV });
    assert.equal(await exists(path.join(dir, ".inc", "gc.cfg")), true, "the landing brought the included file in");
    assert.equal(await exists(marker), false);
  });

  it("never opens an editor, whatever core.editor says", async () => {
    const { dir, marker, failing } = await planted();
    await config(dir, `[core]\n\teditor = ${failing}\n`);
    await writeFile(path.join(dir, "a.txt"), "three\n");
    await fixtureGit(dir, ["add", "-A"]);
    await hostGit(dir, ["commit"], { env: GIT_ENV }).catch(() => undefined);
    assert.equal(await exists(marker), false);
  });

  it("keeps a fsmonitor, a hooks folder and a pager from running", async () => {
    const { dir, marker, program, failing } = await planted();
    const hooks = path.join(path.dirname(marker), "hooks");
    await mkdir(hooks);
    for (const hook of ["pre-commit", "post-commit", "reference-transaction"]) {
      await writeFile(path.join(hooks, hook), `#!/bin/sh\ntouch '${marker}'\n`);
      await chmod(path.join(hooks, hook), 0o755);
    }
    await config(dir, `[core]\n\tfsmonitor = ${failing}\n\thooksPath = ${hooks}\n\tpager = ${program}\n`);
    await writeFile(path.join(dir, "a.txt"), "three\n");
    await hostGit(dir, ["add", "-A"]);
    await hostGit(dir, ["commit", "-q", "-m", "three"], { env: GIT_ENV });
    await hostGit(dir, ["--no-pager", "log", "-1"]);
    assert.equal(await exists(marker), false);
  });

  it("allows no transport at all: ssh, a git proxy, ext:: and a credential helper", async () => {
    const { dir, marker, failing } = await planted();
    await config(
      dir,
      [
        "[core]",
        `\tsshCommand = ${failing}`,
        `\tgitProxy = ${failing}`,
        '[protocol "ext"]',
        "\tallow = always",
        "[credential]",
        `\thelper = !${failing}`,
        "[core]",
        `\taskPass = ${failing}`,
        "",
      ].join("\n"),
    );
    for (const url of ["ssh://host.invalid/x", "git://host.invalid/x", `ext::sh -c touch% ${marker}`])
      await assert.rejects(() => hostGit(dir, ["ls-remote", url]), url);
    await hostGit(dir, ["credential", "fill"], { input: "protocol=https\nhost=example.invalid\n\n" }).catch(
      () => undefined,
    );
    assert.equal(await exists(marker), false);
  });

  it("does not let a promisor remote's lazy fetch run an ext:: program", async () => {
    const { dir, marker } = await planted();
    await config(
      dir,
      [
        "[core]",
        "\trepositoryformatversion = 1",
        "[extensions]",
        "\tpartialclone = origin",
        '[protocol "ext"]',
        "\tallow = always",
        '[remote "origin"]',
        `\turl = ext::sh -c touch% ${marker} x`,
        "\tpromisor = true",
        "\tpartialclonefilter = blob:none",
        "",
      ].join("\n"),
    );
    const blob = await fixtureGit(dir, ["rev-parse", "HEAD:a.txt"]);
    await rm(path.join(dir, ".git", "objects", blob.slice(0, 2), blob.slice(2)), { force: true });
    await rm(path.join(dir, "a.txt"));
    await hostGit(dir, ["reset", "-q", "--hard", "HEAD"]).catch(() => undefined);
    await hostGit(dir, ["cat-file", "blob", "HEAD:a.txt"]).catch(() => undefined);
    assert.equal(await exists(marker), false);
  });
});

describe("hostGit with a large config or input", { skip: !POSIX && "POSIX paths" }, () => {
  it("reads a config with ten thousand branches, which lists past a megabyte", async () => {
    const { dir } = await planted();
    const branches = Array.from(
      { length: 12_000 },
      (_, index) =>
        `[branch "feature/team-a/ticket-${index}-some-descriptive-name"]\n\tremote = origin\n\tmerge = refs/heads/x\n`,
    ).join("");
    await config(dir, branches);
    assert.equal((await hostGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim(), "main");
  });

  it("ends with the command's own result when it exits without reading the input written to it", async () => {
    const module = pathToFileURL(path.resolve("src/substrate/git-policy.ts")).href;
    const probe = `
      import { execFileSync } from "node:child_process";
      import { setImmediate as nextTurn } from "node:timers/promises";
      import { hostGit, hostGitContext } from ${JSON.stringify(module)};
      const dir = process.argv.at(-1);
      execFileSync("git", ["init", "-q"], { cwd: dir });
      const context = await hostGitContext(dir);
      const answers = [];
      for (let run = 0; run < 5; run++)
        answers.push((await hostGit(dir, ["rev-parse", "--is-inside-work-tree"], { context, input: "x".repeat(8_000_000) })).stdout.trim());
      await nextTurn();
      console.log(JSON.stringify(answers));
    `;
    const repository = await realpath(await tmpDir("host-git-epipe-"));
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", probe, repository], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "[]"), Array(5).fill("true"));
  });

  /** A `git` first on the PATH that runs `before` (shell, with the log's path as $LOG) and then the real one. */
  async function gitThatFirst(before: string) {
    const bin = await tmpDir("host-git-shim-");
    const log = path.join(bin, "calls.log");
    const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    await writeFile(path.join(bin, "git"), `#!/bin/sh\nLOG='${log}'\n${before}\nexec '${real}' "$@"\n`);
    await chmod(path.join(bin, "git"), 0o755);
    return { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, log };
  }

  it("closes the standard input of every call a scan makes, as the git that macOS ships needs", async () => {
    const { dir } = await planted();
    await config(dir, `[merge "ours"]\n\tdriver = true\n`);
    // This git reads its standard input to the end before it does anything, as /dev/stdin does there.
    const { PATH } = await gitThatFirst("cat > /dev/null");
    const context = await hostGitContext(dir, { PATH });
    assert.equal(context.config.includes("merge.ours.driver="), false, "the keep-mine driver was read and kept");
  });

  it("neutralizes a merge driver whose value it could not read", async () => {
    const { dir, marker, program } = await planted();
    await config(dir, `[merge "ours"]\n\tdriver = ${program} %O %A %B\n`);
    await mkdir(path.join(dir, ".git", "info"), { recursive: true });
    await writeFile(path.join(dir, ".git", "info", "attributes"), "a.txt merge=ours\n");
    await fixtureGit(dir, ["checkout", "-q", "-b", "build", "HEAD~1"]);
    await writeFile(path.join(dir, "a.txt"), "build side\n");
    await fixtureGit(dir, ["commit", "-q", "-am", "build"]);
    await fixtureGit(dir, ["checkout", "-q", "main"]);
    // The listing of the keys works; reading the values of the merge drivers does not.
    const { PATH } = await gitThatFirst('case "$*" in *--get-regexp*) exit 1;; esac');
    await assert.rejects(() =>
      hostGit(dir, ["merge", "--no-ff", "-m", "land", "build"], { env: { ...GIT_ENV, PATH } }),
    );
    assert.equal(await exists(marker), false);
  });

  it("reads all the merge drivers in one call, however many the folder sets", async () => {
    const counts: number[] = [];
    for (const drivers of [1, 40]) {
      const { dir } = await planted();
      for (let index = 0; index < drivers; index++) await config(dir, `[merge "d${index}"]\n\tdriver = true\n`);
      const { PATH, log } = await gitThatFirst('echo call >> "$LOG"');
      await hostGitContext(dir, { PATH });
      counts.push((await readFile(log, "utf8")).split("\n").filter(Boolean).length);
    }
    assert.equal(counts[1], counts[0], `calls for 1 driver and for 40: ${counts.join(" and ")}`);
  });
});

describe("host git stays in its folder", { skip: !POSIX && "symbolic links and shell fixtures" }, () => {
  async function aboveAndOutside() {
    const root = await tmpDir("host-git-worktree-");
    const dir = path.join(root, "project");
    await mkdir(dir, { recursive: true });
    await fixtureGit(dir, ["init", "-q", "-b", "main"]);
    await writeFile(path.join(dir, "inside.txt"), "inside\n");
    await fixtureGit(dir, ["add", "-A"]);
    await fixtureGit(dir, ["commit", "-q", "-m", "inside"]);
    await mkdir(path.join(root, "sibling"));
    await writeFile(path.join(root, "top.txt"), "outside, tracked by nobody\n");
    await writeFile(path.join(root, "sibling", "secret.txt"), "outside\n");
    return { root, dir };
  }
  // A relative core.worktree is read from the git directory, so `..` is the folder itself.
  for (const worktree of ["../..", "../../sibling"] as const) {
    it(`refuses a folder whose core.worktree points at ${worktree}, before reading or rewriting anything outside`, async () => {
      const { root, dir } = await aboveAndOutside();
      const target = path.resolve(dir, worktree);
      await config(dir, `[core]\n\tworktree = ${worktree}\n`);
      const before = await readFile(path.join(root, "top.txt"), "utf8");
      for (const args of [
        ["add", "-A"],
        ["reset", "-q", "--hard", "HEAD"],
        ["status", "--porcelain"],
      ])
        await assert.rejects(() => hostGit(dir, args), refused(HostGitRefusal.ForeignWorkTree), args.join(" "));
      assert.equal(await readFile(path.join(root, "top.txt"), "utf8"), before);
      assert.equal(await exists(path.join(target, "inside.txt")), false, "nothing was written outside the folder");
    });
  }

  it("fails, and changes nothing, when core.worktree names a folder that is not there", async () => {
    const { root, dir } = await aboveAndOutside();
    await config(dir, `[core]\n\tworktree = ../missing\n`);
    // Git's own failure (exit 128), not a refusal: the policy cannot say where the work tree is.
    await assert.rejects(
      () => hostGit(dir, ["add", "-A"]),
      (error: unknown) => (error as { code?: unknown }).code === 128,
    );
    assert.equal(await exists(path.join(root, "missing")), false);
  });

  it("refuses the core.worktree of a separate git directory that a .git file names", async () => {
    const { root } = await aboveAndOutside();
    const separate = path.join(root, "separate");
    const gitdir = path.join(root, "gitdir");
    await mkdir(separate);
    await fixtureGit(separate, ["init", "-q", "-b", "main", `--separate-git-dir=${gitdir}`]);
    await appendFile(path.join(gitdir, "config"), `[core]\n\tworktree = ..\n`);
    await writeFile(path.join(root, "top.txt"), "outside, tracked by nobody\n");
    await assert.rejects(() => hostGit(separate, ["add", "-A"]), refused(HostGitRefusal.ForeignWorkTree));
  });

  it("refuses an outside core.worktree whatever work tree the process environment names", async () => {
    const { root, dir } = await aboveAndOutside();
    await config(dir, `[core]\n\tworktree = ../..\n`);
    const before = process.env.GIT_WORK_TREE;
    process.env.GIT_WORK_TREE = dir;
    try {
      await assert.rejects(() => hostGit(dir, ["add", "-A"]), refused(HostGitRefusal.ForeignWorkTree));
    } finally {
      if (before === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = before;
    }
    assert.equal(await readFile(path.join(root, "top.txt"), "utf8"), "outside, tracked by nobody\n");
  });

  it("refuses a work tree an enclosing repository sends elsewhere, though the folder has no .git of its own", async () => {
    const { root } = await aboveAndOutside();
    const outside = path.join(root, "victim");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "not the project's\n");
    const parent = path.join(root, "enclosing");
    await mkdir(path.join(parent, "proj"), { recursive: true });
    await fixtureGit(parent, ["init", "-q", "-b", "main"]);
    await config(parent, `[core]\n\tworktree = ${outside}\n`);
    await writeFile(path.join(parent, "proj", "a.txt"), "a\n");
    await assert.rejects(
      () => hostGit(path.join(parent, "proj"), ["ls-files", "--others"]),
      refused(HostGitRefusal.ForeignWorkTree),
    );
  });

  it("still works for a folder inside a larger repository whose work tree contains it", async () => {
    const { root } = await aboveAndOutside();
    const parent = path.join(root, "larger");
    await mkdir(path.join(parent, "proj"), { recursive: true });
    await fixtureGit(parent, ["init", "-q", "-b", "main"]);
    await config(parent, `[core]\n\tworktree = ${parent}\n`);
    await writeFile(path.join(parent, "proj", "a.txt"), "a\n");
    assert.match((await hostGit(path.join(parent, "proj"), ["ls-files", "--others"])).stdout, /a\.txt/);
  });

  it("still works for a folder inside a larger repository when it is reached through a link", async () => {
    const { root } = await aboveAndOutside();
    const parent = path.join(root, "larger");
    await mkdir(path.join(parent, "proj"), { recursive: true });
    await fixtureGit(parent, ["init", "-q", "-b", "main"]);
    await config(parent, `[core]\n\tworktree = ${parent}\n`);
    await writeFile(path.join(parent, "proj", "a.txt"), "a\n");
    const link = path.join(root, "link");
    await symlink(parent, link);
    assert.match((await hostGit(path.join(link, "proj"), ["ls-files", "--others"])).stdout, /a\.txt/);
  });

  it("works in a folder whose name ends in a space, with its work tree set to itself", async () => {
    const { root } = await aboveAndOutside();
    const dir = path.join(root, "trailing ");
    await mkdir(dir);
    await fixtureGit(dir, ["init", "-q", "-b", "main"]);
    await config(dir, `[core]\n\tworktree = ..\n`);
    await writeFile(path.join(dir, "a.txt"), "a\n");
    assert.match((await hostGit(dir, ["ls-files", "--others"])).stdout, /a\.txt/);
  });

  /** How a downloaded folder can point its `.git` at the repository of the person's other project. */
  const POINTERS: Array<{
    label: string;
    plant: (hostile: string, victim: string, root: string) => Promise<void>;
  }> = [
    {
      label: "an absolute gitdir file",
      plant: (hostile, victim) => writeFile(path.join(hostile, ".git"), `gitdir: ${path.join(victim, ".git")}\n`),
    },
    {
      label: "a relative gitdir file",
      plant: (hostile, victim) =>
        writeFile(path.join(hostile, ".git"), `gitdir: ${path.relative(hostile, path.join(victim, ".git"))}\n`),
    },
    {
      label: "a gitdir file with a carriage return",
      plant: (hostile, victim) => writeFile(path.join(hostile, ".git"), `gitdir: ${path.join(victim, ".git")}\r\n`),
    },
    {
      label: "a gitdir file naming a link to the git directory",
      plant: async (hostile, victim) => {
        await symlink(path.join(victim, ".git"), path.join(hostile, "innocent"));
        await writeFile(path.join(hostile, ".git"), "gitdir: ./innocent\n");
      },
    },
    {
      label: "a .git that is itself a link to the git directory",
      plant: (hostile, victim) => symlink(path.join(victim, ".git"), path.join(hostile, ".git")),
    },
    {
      label: "a gitdir file naming the folder of the other project's linked worktree",
      plant: async (hostile, victim, root) => {
        await fixtureGit(victim, ["worktree", "add", "--detach", path.join(root, "its-worktree"), "HEAD"]);
        await writeFile(
          path.join(hostile, ".git"),
          `gitdir: ${path.join(victim, ".git", "worktrees", "its-worktree")}\n`,
        );
      },
    },
  ];
  for (const { label, plant } of POINTERS)
    it(`refuses ${label}, writing nothing to the other project`, async () => {
      const { root, dir: victim } = await aboveAndOutside();
      const hostile = path.join(root, "downloaded");
      await mkdir(hostile);
      await writeFile(path.join(hostile, "index.html"), "<h1>hi</h1>");
      await plant(hostile, victim, root);
      const state = async () =>
        [
          await fixtureGit(victim, ["rev-list", "--all", "--count"]),
          await fixtureGit(victim, ["rev-parse", "HEAD"]),
          await fixtureGit(victim, ["status", "--porcelain"]),
          await fixtureGit(victim, ["count-objects"]),
        ].join("|");
      const before = await state();
      for (const args of [
        ["add", "-A"],
        ["commit", "-q", "--allow-empty", "-m", "senex snapshot"],
        ["reset", "-q", "--hard", "HEAD"],
      ])
        await assert.rejects(
          () => hostGit(hostile, args, { env: GIT_ENV }),
          refused(HostGitRefusal.ForeignGitDir),
          args.join(" "),
        );
      assert.equal(await state(), before);
    });

  it("refuses a folder whose .git is an empty directory inside a larger repository, leaving that repository alone", async () => {
    const { root } = await aboveAndOutside();
    const enclosing = path.join(root, "enclosing");
    await mkdir(path.join(enclosing, "proj", ".git"), { recursive: true });
    await fixtureGit(enclosing, ["init", "-q", "-b", "main"]);
    await writeFile(path.join(enclosing, "v.txt"), "v\n");
    await fixtureGit(enclosing, ["add", "v.txt"]);
    await fixtureGit(enclosing, ["commit", "-q", "-m", "v"]);
    await writeFile(path.join(enclosing, "proj", "a.txt"), "a\n");
    await writeFile(path.join(enclosing, "outside.txt"), "the person's own edit, outside the project\n");
    const before = await fixtureGit(enclosing, ["rev-parse", "HEAD"]);
    for (const args of [
      ["add", "-A"],
      ["reset", "-q", "--hard", "HEAD"],
      ["clean", "-qfd"],
    ])
      await assert.rejects(
        () => hostGit(path.join(enclosing, "proj"), args, { env: GIT_ENV }),
        refused(HostGitRefusal.ForeignGitDir),
        args.join(" "),
      );
    assert.equal(await fixtureGit(enclosing, ["rev-parse", "HEAD"]), before);
    assert.equal(
      await readFile(path.join(enclosing, "outside.txt"), "utf8"),
      "the person's own edit, outside the project\n",
    );
  });

  it("refuses a dangling .git link inside a larger repository too", async () => {
    const { root } = await aboveAndOutside();
    const enclosing = path.join(root, "enclosing");
    await mkdir(path.join(enclosing, "proj"), { recursive: true });
    await fixtureGit(enclosing, ["init", "-q", "-b", "main"]);
    await symlink(path.join(root, "nowhere"), path.join(enclosing, "proj", ".git"));
    await assert.rejects(
      () => hostGit(path.join(enclosing, "proj"), ["add", "-A"], { env: GIT_ENV }),
      refused(HostGitRefusal.ForeignGitDir),
    );
  });

  it("refuses an absolute core.worktree too", async () => {
    const { root, dir } = await aboveAndOutside();
    await config(dir, `[core]\n\tworktree = ${root}\n`);
    await assert.rejects(() => hostGit(dir, ["add", "-A"]), refused(HostGitRefusal.ForeignWorkTree));
  });

  it("still works for the layouts git itself writes: the folder named as its own work tree, a link, a gitdir file", async () => {
    const { root, dir } = await aboveAndOutside();
    await config(dir, `[core]\n\tworktree = ..\n`);
    await hostGit(dir, ["status", "--porcelain"]);
    const link = path.join(root, "link");
    await symlink(dir, link);
    await hostGit(link, ["status", "--porcelain"]);

    const separate = path.join(await tmpDir("host-git-separate-"), "project");
    const gitdir = path.join(path.dirname(separate), "gitdir");
    await mkdir(separate, { recursive: true });
    await fixtureGit(separate, ["init", "-q", "-b", "main", `--separate-git-dir=${gitdir}`]);
    await writeFile(path.join(separate, "f.txt"), "f\n");
    await hostGit(separate, ["add", "-A"]);
    assert.match(await hostGit(separate, ["status", "--porcelain"]).then((r) => r.stdout), /f\.txt/);
  });

  for (const inside of [".hidden-git", path.join("vendor", ".git")])
    it(`still works when the .git file names a git directory inside the folder (${inside})`, async () => {
      const { root } = await aboveAndOutside();
      const dir = path.join(root, "inner");
      await mkdir(dir);
      await mkdir(path.join(dir, path.dirname(inside)), { recursive: true });
      await fixtureGit(dir, ["init", "-q", "-b", "main", `--separate-git-dir=${path.join(dir, inside)}`]);
      await writeFile(path.join(dir, "f.txt"), "f\n");
      assert.match((await hostGit(dir, ["status", "--porcelain"])).stdout, /f\.txt/);
    });

  it("still works in a linked worktree of the folder's own repository, reached by its .git file", async () => {
    const { root, dir } = await aboveAndOutside();
    const linked = path.join(root, "linked-own");
    await fixtureGit(dir, ["worktree", "add", "--detach", linked, "HEAD"]);
    await writeFile(path.join(linked, "g.txt"), "g\n");
    assert.match((await hostGit(linked, ["status", "--porcelain"])).stdout, /g\.txt/);
  });

  it("still works in a linked worktree while the main repository's config redirects core.worktree", async () => {
    const { root, dir } = await aboveAndOutside();
    await config(dir, `[core]\n\tworktree = ${dir}\n`);
    const linked = path.join(root, "linked");
    await fixtureGit(dir, ["worktree", "add", "--detach", linked, "HEAD"]);
    await hostGit(linked, ["status", "--porcelain"]);
  });
});

describe("hostGit(add) with a private environment file beside the files it names", {
  skip: !POSIX && "POSIX paths",
}, () => {
  it("stages an explicit untracked file and leaves the sibling .env out", async () => {
    const { dir } = await planted();
    await mkdir(path.join(dir, "assets"));
    await writeFile(path.join(dir, "assets", "hero.png"), "png");
    await writeFile(path.join(dir, "assets", ".env"), "SECRET=1");
    await hostGit(dir, ["add", "--", "assets/hero.png"]);
    assert.equal(await fixtureGit(dir, ["diff", "--cached", "--name-only"]), "assets/hero.png");
  });

  it("keeps .env out of a whole-folder add, a directory add and a named .env", async () => {
    const { dir } = await planted();
    await mkdir(path.join(dir, "assets"));
    await writeFile(path.join(dir, "assets", "hero.png"), "png");
    await writeFile(path.join(dir, "assets", ".env.local"), "SECRET=1");
    await writeFile(path.join(dir, ".env"), "SECRET=2");
    await hostGit(dir, ["add", "-A"]);
    assert.equal(await fixtureGit(dir, ["diff", "--cached", "--name-only"]), "assets/hero.png");
    await hostGit(dir, ["add", "--", ".env", "assets"]);
    assert.equal(await fixtureGit(dir, ["diff", "--cached", "--name-only"]), "assets/hero.png");
  });
});

describe("hostGitContext and hostGitCommand", { skip: !POSIX && "POSIX paths" }, () => {
  it("scans the folder once and builds the command a streaming caller spawns", async () => {
    const { dir } = await planted();
    const context = await hostGitContext(dir, { GIT_INDEX_FILE: path.join(dir, ".git", "private-index") });
    const command = hostGitCommand(context, ["status", "--porcelain"]);
    assert.deepEqual(command.args.slice(-4), ["-C", dir, "status", "--porcelain"]);
    assert.equal(command.env.GIT_INDEX_FILE, path.join(dir, ".git", "private-index"));
    assert.equal(command.env.GIT_ALLOW_PROTOCOL, "none");
  });

  it("answers the output of a host command as a string, or as bytes when asked", async () => {
    const { dir } = await planted();
    assert.equal((await hostGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim(), "main");
    const bytes = await hostGit(dir, ["cat-file", "blob", "HEAD:a.txt"], { encoding: "buffer" });
    assert.equal(Buffer.isBuffer(bytes.stdout), true);
    assert.equal(bytes.stdout.toString("utf8"), "two\n");
  });

  it("ignores an ambient GIT_DIR, which would send a command to another repository", async () => {
    const { dir } = await planted();
    const other = await planted();
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(other.dir, ".git");
    try {
      const top = (await hostGit(dir, ["rev-parse", "--show-toplevel"])).stdout.trim();
      assert.equal(top, await realpath(dir));
      assert.notEqual(top, await realpath(other.dir));
      // The command itself, not only the scan before it, runs in the folder's own git directory.
      const gitDir = (await hostGit(dir, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
      assert.equal(gitDir, path.join(await realpath(dir), ".git"));
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });
});
