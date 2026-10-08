import type { EngineId } from "./providers.ts";

/**
 * Whether a provider's own global skills reach Studio's builders (`ProviderSkillInventory.builders`),
 * which follows the sign-in the builders use. Read by the Skills page: never rename a value.
 */
export const ProviderBuilderUse = {
  /** Builders never load these skills (Claude Code runs with project settings only). */
  NotLoaded: "not-loaded",
  /** Builders use Studio's own profile, so its skills folder, not the user's. */
  StudioProfile: "studio-profile",
  /** Builders borrow the CLI's own login, and with it the user's global skills. */
  BorrowedLogin: "borrowed-login",
  /** No login yet: nothing reaches a builder until one exists. */
  NoLogin: "no-login",
} as const;
export type ProviderBuilderUse = (typeof ProviderBuilderUse)[keyof typeof ProviderBuilderUse];

export interface ProviderSkill {
  name: string;
  description: string;
  path: string;
  scope: string;
  enabled?: boolean;
}
export interface ProviderSkillInventory {
  provider: "codex" | "claude-code";
  label: string;
  source: "native-catalog" | "installed-files";
  skills: ProviderSkill[];
  note: string;
  warnings: string[];
  /** Whether these skills reach Studio's builders. */
  builders: ProviderBuilderUse;
}

/** A skill or command a project folder carries (`.claude/skills`, `.claude/commands`, `.agents/skills`). */
export interface ProjectSkill {
  name: string;
  description: string;
  /** Project-relative path of the skill's file. */
  path: string;
  kind: "skill" | "command";
  /** The builders that load it from the project folder. */
  engines: EngineId[];
}
/** The skills one project folder gives its builders. */
export interface ProjectSkillInventory {
  project: string;
  skills: ProjectSkill[];
  warnings: string[];
}
