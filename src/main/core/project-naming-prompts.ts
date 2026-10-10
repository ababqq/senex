/** What the model reads when it names a project from a message about it (`project-naming.ts`). Model-facing. */

/** What the model answers when the message describes no project to make. */
export const NO_PROJECT_REPLY = "NONE";

/** The instruction for the one tool-free completion that names a new project. */
export const PROJECT_NAME_SYSTEM_PROMPT = `You name software projects: apps, sites, tools and games. Read a message someone sent about a project they want to make. If it describes a project (what it is, what a person does with it, who it is for or its mood), reply with a short, memorable title for it: two to four words, in the message's language. If it describes no project (a greeting, a test, thanks, a question about you), reply ${NO_PROJECT_REPLY}. Reply with the title or ${NO_PROJECT_REPLY} only: no quotes, no punctuation at the end, no explanation, no questions.`;

/** The one user message a project is named from. */
export function projectNameRequest(request: string): string {
  return `Message about the project:\n${request}`;
}
