/**
 * The host's git policy, as pure rules: which settings a repository's own config is pinned
 * against, which keys name a program the folder chose, how arguments and the environment are
 * made safe. The real-git rows are in host-git.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  driverOverrides,
  HOST_GIT_CONFIG,
  HostGitRefusal,
  HostGitRefusedError,
  hostGitArgs,
  hostGitEnv,
  unlessRefused,
} from "../../src/substrate/git-policy.ts";

const nul = (...keys: string[]) => keys.map((key) => `${key}\0`).join("");
const EXCLUDES = [":(glob,exclude)**/.env", ":(glob,exclude)**/.env.*"];

describe("driverOverrides: the keys a folder's config uses to name a program", () => {
  it("pins every filter, diff and merge driver key, and only 'required' to false", () => {
    assert.deepEqual(
      driverOverrides(
        nul(
          "filter.lfs.clean",
          "filter.lfs.smudge",
          "filter.lfs.process",
          "filter.lfs.required",
          "diff.pdf.textconv",
          "diff.x.command",
          "merge.m.driver",
        ),
      ),
      [
        "-c",
        "filter.lfs.clean=",
        "-c",
        "filter.lfs.smudge=",
        "-c",
        "filter.lfs.process=",
        "-c",
        "filter.lfs.required=false",
        "-c",
        "diff.pdf.textconv=",
        "-c",
        "diff.x.command=",
        "-c",
        "merge.m.driver=",
      ],
    );
  });

  it("names a key once however often the config sets it, and answers nothing for no keys", () => {
    assert.deepEqual(driverOverrides(nul("filter.a.clean", "filter.a.clean")), ["-c", "filter.a.clean="]);
    assert.deepEqual(driverOverrides(""), []);
  });

  it("leaves keys that name no program, or that a fixed pin already covers", () => {
    const harmless = [
      "diff.x.cachetextconv",
      "diff.x.binary",
      "merge.m.name",
      "merge.m.recursive",
      "filter.x.other",
      "user.name",
      "core.editor",
      "alias.add",
    ];
    assert.deepEqual(driverOverrides(nul(...harmless)), []);
  });

  it("pins a driver name of any shape exactly as git printed it", () => {
    const names = ["a b", "é", "", "a.b", " ", "\r", "x".repeat(3000), "Mixed"];
    for (const name of names) {
      const key = `filter.${name}.clean`;
      assert.deepEqual(driverOverrides(nul(key)), ["-c", `${key}=`], JSON.stringify(name).slice(0, 40));
    }
    assert.deepEqual(driverOverrides(nul("FILTER.X.CLEAN")), ["-c", "FILTER.X.CLEAN="]);
  });

  it("refuses a name `-c` cannot carry: an equals sign, a newline, or bytes that are not UTF-8", () => {
    for (const key of [
      "filter.a=b.clean",
      "diff.a=b.textconv",
      "merge.a=b.driver",
      "filter.a\nb.clean",
      "filter.�.clean",
    ]) {
      assert.throws(
        () => driverOverrides(nul(key)),
        (error: unknown) => error instanceof HostGitRefusedError && error.code === HostGitRefusal.UnsafeConfigKey,
        JSON.stringify(key),
      );
    }
  });

  it("leaves a key it was told to trust", () => {
    const listing = nul("merge.ours.driver", "merge.evil.driver", "filter.x.clean");
    assert.deepEqual(driverOverrides(listing, new Set(["merge.ours.driver"])), [
      "-c",
      "merge.evil.driver=",
      "-c",
      "filter.x.clean=",
    ]);
  });

  it("quotes at most a short stretch of a refused key", () => {
    const key = `filter.${"y".repeat(500)}=.clean`;
    assert.throws(
      () => driverOverrides(nul(key)),
      (error: unknown) => error instanceof HostGitRefusedError && error.message.length < 300,
    );
  });
});

describe("hostGitArgs: what every host command is made to carry", () => {
  it("puts the private-environment excludes right after `--`, before the paths", () => {
    assert.deepEqual(hostGitArgs(["add", "--", "assets/x.png"]), ["add", "--", ...EXCLUDES, "assets/x.png"]);
    assert.deepEqual(hostGitArgs(["add", "-A", "--", "a", "b"]), ["add", "-A", "--", ...EXCLUDES, "a", "b"]);
  });

  it("adds `--` and the excludes to an add that named none", () => {
    assert.deepEqual(hostGitArgs(["add", "-A"]), ["add", "-A", "--", ...EXCLUDES]);
    assert.deepEqual(hostGitArgs(["add", "x.png"]), ["add", "--", ...EXCLUDES, "x.png"]);
  });

  it("leaves an add that reads its paths from stdin as it is", () => {
    assert.deepEqual(hostGitArgs(["add", "--pathspec-from-file=-", "--pathspec-file-nul"]), [
      "add",
      "--pathspec-from-file=-",
      "--pathspec-file-nul",
    ]);
  });

  it("turns off external diff and text conversion for diff, log and show, behind any global option", () => {
    const off = ["--no-ext-diff", "--no-textconv"];
    assert.deepEqual(hostGitArgs(["diff", "HEAD"]), ["diff", ...off, "HEAD"]);
    assert.deepEqual(hostGitArgs(["--no-optional-locks", "diff", "HEAD"]), [
      "--no-optional-locks",
      "diff",
      ...off,
      "HEAD",
    ]);
    assert.deepEqual(hostGitArgs(["-c", "k=v", "log", "-1"]), ["-c", "k=v", "log", ...off, "-1"]);
    assert.deepEqual(hostGitArgs(["-C", "/x", "--no-pager", "show", "HEAD"]), [
      "-C",
      "/x",
      "--no-pager",
      "show",
      ...off,
      "HEAD",
    ]);
  });

  it("leaves every other command alone", () => {
    assert.deepEqual(hostGitArgs(["merge", "--no-ff", "-m", "x", "abc"]), ["merge", "--no-ff", "-m", "x", "abc"]);
    assert.deepEqual(hostGitArgs([]), []);
    assert.deepEqual(hostGitArgs(["-c", "k=v"]), ["-c", "k=v"]);
  });
});

describe("hostGitEnv: nothing ambient routes or arms a host git command", () => {
  it("drops every ambient GIT_ variable and pins the ones that stop a program or a transport", () => {
    const ambient = {
      GIT_DIR: "/elsewhere/.git",
      GIT_WORK_TREE: "/elsewhere",
      GIT_INDEX_FILE: "/elsewhere/index",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "/bin/true",
      GIT_EXTERNAL_DIFF: "/bin/true",
      GIT_SSH_COMMAND: "/bin/true",
      GIT_ASKPASS: "/bin/true",
      GIT_EXEC_PATH: "/elsewhere",
      GIT_ALLOW_PROTOCOL: "file:ext",
      GIT_EDITOR: "/bin/true",
    };
    const saved = Object.fromEntries(Object.keys(ambient).map((key) => [key, process.env[key]]));
    Object.assign(process.env, ambient);
    try {
      const env = hostGitEnv();
      const kept = Object.keys(env)
        .filter((key) => key.startsWith("GIT_"))
        .sort();
      assert.deepEqual(kept, [
        "GIT_ALLOW_PROTOCOL",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_SYSTEM",
        "GIT_EDITOR",
        "GIT_NO_LAZY_FETCH",
        "GIT_PAGER",
        "GIT_TERMINAL_PROMPT",
      ]);
      assert.equal(env.GIT_ALLOW_PROTOCOL, "none");
      assert.equal(env.GIT_EDITOR, ":");
      assert.equal(env.GIT_NO_LAZY_FETCH, "1");
      assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
      assert.equal(env.GIT_CONFIG_SYSTEM, "/dev/null");
      assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("lets a caller's own override win, as the studio's identity does", () => {
    assert.equal(hostGitEnv({ GIT_AUTHOR_NAME: "Senex" }).GIT_AUTHOR_NAME, "Senex");
    assert.equal(hostGitEnv({ GIT_INDEX_FILE: "/private/index" }).GIT_INDEX_FILE, "/private/index");
  });
});

describe("HOST_GIT_CONFIG: settings a repository's config cannot override", () => {
  it("pins every fixed-name setting that names a program", () => {
    const pinned = new Set(HOST_GIT_CONFIG.filter((_, index) => index % 2 === 1));
    for (const setting of [
      "core.fsmonitor=",
      "core.hooksPath=/dev/null",
      "core.pager=cat",
      "core.alternateRefsCommand=",
      "gpg.program=",
      "gpg.openpgp.program=",
      "gpg.x509.program=",
      "gpg.ssh.program=",
      "credential.helper=",
      "core.askPass=",
      "commit.gpgsign=false",
      "tag.gpgsign=false",
    ])
      assert.ok(pinned.has(setting), setting);
  });

  it("is `-c` pairs and nothing else", () => {
    assert.equal(HOST_GIT_CONFIG.length % 2, 0);
    for (let index = 0; index < HOST_GIT_CONFIG.length; index += 2) assert.equal(HOST_GIT_CONFIG[index], "-c");
  });
});

describe("unlessRefused: a failure that is an answer, and a refusal that is not", () => {
  it("answers the fallback for an ordinary failure and throws a refusal on", () => {
    assert.equal(unlessRefused("none")(new Error("git failed")), "none");
    assert.equal(unlessRefused(null)("not an error"), null);
    const refusal = new HostGitRefusedError(HostGitRefusal.ForeignWorkTree, "outside");
    assert.throws(
      () => unlessRefused("none")(refusal),
      (error: unknown) => error === refusal,
    );
  });
});
