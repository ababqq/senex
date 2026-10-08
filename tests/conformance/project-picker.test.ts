/**
 * The native folder pickers behind Create project: Open existing folder… opens in the projects root, the
 * location beside it; each picks exactly one folder and offers New Folder, so a project can start in a
 * folder made on the spot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { projectLocationPickerOptions, projectPickerOptions } from "../../src/main/project-picker.ts";

const PROJECTS_ROOT = "/Users/fixture/AI Projects";

test("Open existing folder… offers New Folder, and picks exactly one folder in the projects root", () => {
  const options = projectPickerOptions(PROJECTS_ROOT);
  assert.deepEqual(options.properties, ["openDirectory", "createDirectory"], "one folder, or a new one");
  assert.equal(options.defaultPath, PROJECTS_ROOT, "opens in the projects root");
});

test("Create project's location picker picks one folder beside the projects folder, offers New Folder, and says it is only where", () => {
  const options = projectLocationPickerOptions(PROJECTS_ROOT);
  assert.deepEqual(options.properties, ["openDirectory", "createDirectory"]);
  // Not inside it: every library-style folder there is a project, so a New Folder made there would be one.
  assert.equal(options.defaultPath, path.dirname(PROJECTS_ROOT));
  assert.notEqual(options.title, projectPickerOptions(PROJECTS_ROOT).title, "not the Open folder question");
});
