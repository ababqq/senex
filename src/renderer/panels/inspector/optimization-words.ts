import { capitalise } from "./format.ts";

const MESSAGE = { defaultView: "Default view", demo: "Demo" };

/**
 * The header of one optimization scenario: the project's own demo name as words (`add-task` → "Demo: Add
 * task"), or the default view when the scenario ran no demo. A name that is not text is not a name.
 */
export function scenarioLabel(workload: Record<string, unknown> | null | undefined): string {
  const demo = workload?.demo;
  const words = typeof demo === "string" ? demo.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim() : "";
  return words ? `${MESSAGE.demo}: ${capitalise(words)}` : MESSAGE.defaultView;
}
