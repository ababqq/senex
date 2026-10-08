/**
 * Permission store: the mode a new project chat starts in and the "always allow" rules saved for
 * each project. Host-only: the file lives under engine-homes, which Claude Code's file tools may
 * neither read nor edit in any mode, the harness sandbox cannot reach, and no RPC names. (A shell
 * command a chat's session runs has the person's own access, which is what Bypass means.) Missing
 * or damaged, it reads as the defaults; writes are atomic and queued one after another.
 */
import { readFile } from "node:fs/promises";
import {
  DEFAULT_PERMISSION_MODE,
  isSteadyPermissionMode,
  type PermissionMode,
  WHOLE_TOOL_RULES,
} from "../shared/permissions.ts";
import { atomicWriteJson } from "../substrate/fsx.ts";

/** The file's format. */
const STORE_VERSION = 1;
/** A rule is Claude Code's own syntax; anything longer than this is not one a person granted. */
const RULE_MAX = 2000;
const RULES_PER_PROJECT = 500;
const PROJECT_MAX = 200;

/** Why a change is refused. */
const MESSAGE = {
  invalidProject: "Invalid project",
  notSteady: "A new chat starts in Auto, Manual or Accept edits",
} as const;

interface PermissionState {
  defaultMode: PermissionMode;
  /** Saved rules by project, in the order they were granted. */
  rules: Map<string, string[]>;
}

function validProject(project: unknown): project is string {
  return typeof project === "string" && project.length > 0 && project.length <= PROJECT_MAX;
}

/** One saved rule as the store keeps it, or null: a string, trimmed, bounded, never a whole tool. */
function cleanRule(item: unknown): string | null {
  if (typeof item !== "string") return null;
  const rule = item.trim();
  // A whole shell or file tool is never saved as "always": the card never offers one.
  if (!rule || rule.length > RULE_MAX || WHOLE_TOOL_RULES.has(rule)) return null;
  return rule;
}

/** Strings only, trimmed, bounded and each once: whatever else the file held is dropped. */
function cleanRules(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const rules: string[] = [];
  for (const item of value) {
    const rule = cleanRule(item);
    if (rule === null || rules.includes(rule)) continue;
    rules.push(rule);
    if (rules.length >= RULES_PER_PROJECT) break;
  }
  return rules;
}

/** Each project's rules the file holds, cleaned; projects with none are left out. */
function parseRules(rules: unknown): Map<string, string[]> {
  const parsed = new Map<string, string[]>();
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) return parsed;
  for (const [project, list] of Object.entries(rules)) {
    const clean = cleanRules(list);
    if (validProject(project) && clean.length) parsed.set(project, clean);
  }
  return parsed;
}

function parse(text: string): PermissionState {
  const defaults: PermissionState = { defaultMode: DEFAULT_PERMISSION_MODE, rules: new Map() };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return defaults;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return defaults;
  const { defaultMode, rules } = data as { defaultMode?: unknown; rules?: unknown };
  // Plan and Bypass are chosen chat by chat; a file that says otherwise is not believed.
  return {
    defaultMode: isSteadyPermissionMode(defaultMode) ? defaultMode : DEFAULT_PERMISSION_MODE,
    rules: parseRules(rules),
  };
}

export class PermissionStore {
  readonly file: string;
  #state: Promise<PermissionState> | null = null;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }

  #load(): Promise<PermissionState> {
    // Only a file that is not there reads as the defaults. Any other failure is retried next time
    // and fails this call, so a passing read error can never be written back over saved rules.
    this.#state ??= readFile(this.file, "utf8").then(parse, (error: NodeJS.ErrnoException) => {
      if (error?.code === "ENOENT") return parse("");
      this.#state = null;
      throw error;
    });
    return this.#state;
  }

  /** Change a copy, write it, and only then let readers see it: a failed write changes nothing. */
  async #update<T>(change: (state: PermissionState) => T): Promise<T> {
    const operation = this.#tail.then(async () => {
      const current = await this.#load();
      const next: PermissionState = {
        defaultMode: current.defaultMode,
        rules: new Map([...current.rules].map(([project, rules]) => [project, [...rules]])),
      };
      const result = change(next);
      await atomicWriteJson(this.file, {
        version: STORE_VERSION,
        defaultMode: next.defaultMode,
        rules: Object.fromEntries(next.rules),
      });
      this.#state = Promise.resolve(next);
      return result;
    });
    this.#tail = operation.catch(() => {});
    return operation;
  }

  /** The mode a chat that never chose starts in: the last steady one chosen anywhere. */
  async defaultMode(): Promise<PermissionMode> {
    return (await this.#load()).defaultMode;
  }

  async setDefaultMode(mode: PermissionMode): Promise<void> {
    if (!isSteadyPermissionMode(mode)) throw new Error(MESSAGE.notSteady);
    if ((await this.#load()).defaultMode === mode) return;
    await this.#update((state) => {
      state.defaultMode = mode;
    });
  }

  async rules(project: string): Promise<string[]> {
    return [...((await this.#load()).rules.get(project) ?? [])];
  }

  /** Save "always allow" rules for a project: new ones go last, repeats are ignored. Returns the project's rules. */
  async addRules(project: string, rules: string[]): Promise<string[]> {
    if (!validProject(project)) throw new Error(MESSAGE.invalidProject);
    const added = cleanRules(rules);
    const known = await this.rules(project);
    if (!added.some((rule) => !known.includes(rule))) return known;
    return this.#update((state) => {
      const merged = cleanRules([...(state.rules.get(project) ?? []), ...added]);
      state.rules.set(project, merged);
      return [...merged];
    });
  }

  /** Stop allowing one saved rule. False when the project had no such rule. */
  async forget(project: string, rule: string): Promise<boolean> {
    if (!(await this.rules(project)).includes(rule)) return false;
    return this.#update((state) => {
      const left = (state.rules.get(project) ?? []).filter((saved) => saved !== rule);
      if (left.length) state.rules.set(project, left);
      else state.rules.delete(project);
      return true;
    });
  }

  /** Every saved rule, by project. */
  async all(): Promise<Record<string, string[]>> {
    const state = await this.#load();
    return Object.fromEntries([...state.rules].map(([project, rules]) => [project, [...rules]]));
  }
}
