/**
 * A new project's name from the first thing the user asked for, so its folder is named before
 * anything is written in it: one short, tool-free completion on the model the user picked. A
 * model that cannot answer in time, or answers nothing usable, leaves the name to the request's
 * own first words; the project is never left waiting for a name. A first message that describes no
 * project ("Hello") makes it Untitled project, and its first idea then renames it in place
 * (`nameFromIdea`), the folder staying where it is.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import type { ProjectLibraryEntry, ProjectUpdate } from "../../shared/project-library.ts";
import type { ProjectName, ProjectNameRequest } from "../../shared/project-folder.ts";
import { WorkClass } from "../../shared/harness-api.ts";
import type { CompleteRequest, CompleteResponse, Engine } from "../../substrate/engines/types.ts";
import { PROJECT_NAME_SYSTEM_PROMPT, projectNameRequest, NO_PROJECT_REPLY } from "./project-naming-prompts.ts";

/** The longest the model may take before the request's own words name the project. */
const NAMING_TIMEOUT_MS = 20 * SECOND_MS;
/** A name is a few words: the model gets room for them and no more. */
const NAMING_MAX_TOKENS = 64;
/** The longest name kept, in characters: a title may be 80, but a folder reads better short. */
const NAME_MAX_CHARS = 40;
/** How much of the request the model reads, in characters. */
const REQUEST_MAX_CHARS = 2_000;
/** Naming is quick work: no model should think long about it. */
const NAMING_EFFORT = "low";

/** The name of a project whose request has no words to name it by. */
export const UNTITLED_PROJECT = "Untitled project";

/** Wrapping a reply may come in: Markdown marks and quotation marks, at either end. */
const WRAPPING = /^[\s#>*_`"'“”‘’«»„]+|[\s*_`"'“”‘’«»„]+$/g;
/** End punctuation a title does not keep. */
const TRAILING_PUNCTUATION = /[\s.!?,;:…。！？]+$/u;
/** Characters no name keeps. */
const CONTROL = /[\x00-\x1f\x7f]/g;
/** Where a request's first sentence ends. */
const SENTENCE_END = /[.!?。！？\n]/u;

/** What naming needs from the core: its engines, its budget, and (for tests) its patience. */
export interface NamingDeps {
  engines: { get(id: string): Engine; firstReady(): Promise<Engine | null> };
  budget: {
    run<T extends { usage?: unknown }>(workClass: WorkClass, work: () => Promise<T>, engine?: string): Promise<T>;
  };
  timeoutMs?: number;
}

/** `text` with no control characters, its spaces collapsed, cut on a word to a name's length. */
function tidy(text: string): string {
  const words = text.replace(/\s+/g, " ").replace(CONTROL, "").trim();
  if (words.length <= NAME_MAX_CHARS) return words;
  const cut = words.slice(0, NAME_MAX_CHARS + 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut.slice(0, NAME_MAX_CHARS)).trim();
}

/** The name in a model's reply: its first line, unwrapped and tidied; null when there is none. */
export function nameFromReply(reply: string): string | null {
  const line = reply.split("\n").find((candidate) => candidate.replace(WRAPPING, "").trim()) ?? "";
  const name = tidy(line.replace(WRAPPING, "").replace(TRAILING_PUNCTUATION, "").replace(WRAPPING, ""));
  return name || null;
}

/** The name a request gives itself: its first sentence, cut to a name's length, with a capital. */
export function nameFromRequest(request: string): string {
  const sentence = request.split(SENTENCE_END).find((part) => /[\p{L}\p{N}]/u.test(part)) ?? "";
  const name = tidy(sentence).replace(TRAILING_PUNCTUATION, "");
  if (!name) return UNTITLED_PROJECT;
  return name.charAt(0).toLocaleUpperCase() + name.slice(1);
}

/** The engine that names the project: the one picked, else the first ready; null when none can complete. */
async function namingEngine(deps: NamingDeps, engineId: string | undefined): Promise<Engine | null> {
  try {
    const engine = engineId ? deps.engines.get(engineId) : await deps.engines.firstReady();
    return typeof engine?.complete === "function" ? engine : null;
  } catch {
    return null;
  }
}

/** The model's reply, or null when it fails or runs out of time. */
async function askForName(deps: NamingDeps, engine: Engine, request: ProjectNameRequest): Promise<string | null> {
  const timeoutMs = deps.timeoutMs ?? NAMING_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const ask: CompleteRequest = {
    ...(request.model ? { model: request.model } : {}),
    effort: NAMING_EFFORT,
    signal,
    timeoutMs,
    maxTokens: NAMING_MAX_TOKENS,
    systemPrompt: PROJECT_NAME_SYSTEM_PROMPT,
    messages: [{ role: "user", content: projectNameRequest(request.prompt.slice(0, REQUEST_MAX_CHARS)) }],
    tools: [],
  };
  const answered = deps.budget.run(
    WorkClass.User,
    () => engine.complete?.(ask) as Promise<CompleteResponse>,
    engine.id,
  );
  // An engine that does not honour the signal still does not hold the project back.
  const timedOut = new Promise<null>((resolve) => signal.addEventListener("abort", () => resolve(null)));
  try {
    const response = await Promise.race([answered, timedOut]);
    const content = response?.message.content;
    return typeof content === "string" ? content : null;
  } catch {
    return null;
  } finally {
    answered.catch(() => {});
  }
}

/** Did the model say the message describes no project? */
const describesNoProject = (name: string): boolean => name.toUpperCase() === NO_PROJECT_REPLY;

/**
 * A name for a project started from `request.prompt`: the model's; Untitled project, waiting for an
 * idea, when the message describes none; else the request's own words, waiting for the model's.
 */
export async function nameProject(deps: NamingDeps, request: ProjectNameRequest): Promise<ProjectName> {
  if (typeof request?.prompt !== "string") throw new Error("A project is named from text.");
  const engine = await namingEngine(deps, request.engine);
  const reply = engine && request.prompt.trim() ? await askForName(deps, engine, request) : null;
  const named = reply ? nameFromReply(reply) : null;
  if (named && describesNoProject(named)) return { title: UNTITLED_PROJECT, provisional: true };
  if (named) return { title: named };
  return { title: nameFromRequest(request.prompt), provisional: true };
}

/** What renaming a project from its first idea needs: the library, the namer, and who to tell. */
export interface IdeaNamingDeps {
  projects: {
    presentation(name: string): Promise<ProjectLibraryEntry>;
    update(name: string, patch: ProjectUpdate): Promise<unknown>;
  };
  name(request: ProjectNameRequest): Promise<ProjectName>;
  changed(project: string): void;
}

/**
 * A project whose title still waits (its first message named no project) takes the name a later
 * message gives it, in place: the title changes, the folder stays. True when it was renamed. A
 * title the person gave meanwhile is theirs and is never replaced.
 */
export async function nameFromIdea(
  deps: IdeaNamingDeps,
  project: string,
  request: ProjectNameRequest,
): Promise<boolean> {
  if (!(await deps.projects.presentation(project)).provisional) return false;
  const named = await deps.name(request);
  if (named.provisional) return false;
  // The person may have renamed it while the model answered.
  if (!(await deps.projects.presentation(project)).provisional) return false;
  await deps.projects.update(project, { title: named.title });
  deps.changed(project);
  return true;
}
