/**
 * A project's name in the library is its title in lowercase letters, digits and dashes. A title in
 * Korean, Japanese or emoji keeps none of them, and used to become `project-` (a dash left over from
 * the fallback), so the next one was `project--2`. Now it is `project`, then `project-2`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_SLUG_LENGTH, PROJECT_NAME_RE, slugFromName } from "../../src/shared/project-folder-name.ts";

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

  it("takes what is not a string for no title at all", () => {
    assert.equal(slugFromName(undefined as unknown as string), "project");
    assert.equal(slugFromName(null as unknown as string), "project");
  });
});
