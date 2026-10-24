/**
 * A project's name in the library is its title in lowercase letters, digits and dashes. A title in
 * Korean, Japanese or emoji keeps none of them, and used to become `project-` (a dash left over from
 * the fallback), so the next one was `project--2`. Now it is `project`, then `project-2`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_SLUG_LENGTH, numberedSlug, PROJECT_NAME_RE, slugFromName } from "../../src/shared/project-folder-name.ts";

describe("a project's name from its title", () => {
  const readable: Array<[string, string]> = [
    ["My Cool Project", "my-cool-project"],
    ["  Spaces   everywhere  ", "spaces-everywhere"],
    ["Snow Temple 2", "snow-temple-2"],
    ["--dashes--and__underscores--", "dashes-and-underscores"],
    ["Mixed 한국어 title", "mixed-title"],
    ["한국어 예약 시스템 v2", "v2"],
  ];
  for (const [title, name] of readable)
    it(`${JSON.stringify(title)} → ${name}`, () => assert.equal(slugFromName(title), name));

  const nothingToKeep = ["호텔 예약", "日本語のタイトル", "🎮🎮🎮", "   ", "...", "---", "___", "", "—–·"];
  for (const title of nothingToKeep)
    it(`${JSON.stringify(title)} keeps no letter or digit, so the name is just "project"`, () =>
      assert.equal(slugFromName(title), "project"));

  it("is always a name the library accepts, and never starts or ends with a dash", () => {
    const titles = [
      ...readable.map(([title]) => title),
      ...nothingToKeep,
      "x".repeat(200),
      "a - b - c - ",
      `${"ab ".repeat(40)}-`,
    ];
    for (const title of titles) {
      const name = slugFromName(title);
      assert.match(name, PROJECT_NAME_RE, JSON.stringify(title));
      assert.ok(!name.endsWith("-"), `${JSON.stringify(title)} → ${name} ends with a dash`);
      assert.ok(name.length <= MAX_SLUG_LENGTH, name);
    }
  });

  it("cuts a long title at exactly the length a name may have", () => {
    assert.equal(slugFromName("x".repeat(200)), "x".repeat(63));
    assert.equal(MAX_SLUG_LENGTH, 63);
  });

  it("does not leave the dash the cut lands on", () => {
    // 62 letters, a space, then more: the 63rd character is the dash between the words.
    const title = `${"x".repeat(MAX_SLUG_LENGTH - 1)} y`;
    assert.equal(slugFromName(title), "x".repeat(MAX_SLUG_LENGTH - 1));
    assert.equal(slugFromName(`${"ab ".repeat(40)}-`), `${"ab-".repeat(20)}ab`);
  });

  it("takes what is not a string for no title at all", () => {
    assert.equal(slugFromName(undefined as unknown as string), "project");
    assert.equal(slugFromName(null as unknown as string), "project");
  });
});

describe("a numbered copy of a project's name", () => {
  it("is the name and the number, from the second on", () => {
    assert.equal(numberedSlug("project", 2), "project-2");
    assert.equal(numberedSlug("my-cool-project", 13), "my-cool-project-13");
    assert.equal(numberedSlug("project", 1), "project", "the first is the name itself");
  });

  it("stays within the length a name may have, cutting the name and never the number", () => {
    const name = "x".repeat(MAX_SLUG_LENGTH);
    for (const n of [2, 9, 10, 99, 100, 12345]) {
      const numbered = numberedSlug(name, n);
      assert.ok(numbered.length <= MAX_SLUG_LENGTH, numbered);
      assert.ok(numbered.endsWith(`-${n}`), numbered);
      assert.match(numbered, PROJECT_NAME_RE);
    }
  });

  it("leaves no double dash where the cut meets the number", () => {
    // 60 letters, a dash, then letters: the name is 63 long, and room for "-2" cuts it on the dash.
    const name = `${"a".repeat(60)}-bc`;
    assert.equal(slugFromName(`${"a".repeat(60)} bc`), name);
    assert.equal(numberedSlug(name, 2), `${"a".repeat(60)}-2`);
    for (let n = 2; n < 150; n++) assert.ok(!numberedSlug(name, n).includes("--"), `${n}: ${numberedSlug(name, n)}`);
  });
});
