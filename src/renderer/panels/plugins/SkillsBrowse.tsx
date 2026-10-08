/** The Skills tab: Studio's own skills, this project's, each provider's global skills, and the skills plugins ship. */
import type { JSX } from "react";
import type { PluginInfo } from "../../../shared/plugins.ts";
import type { ProjectSkillInventory, ProviderSkill, ProviderSkillInventory } from "../../../shared/provider-skills.ts";
import { Icon } from "../../ui/icons.tsx";
import { SKILLS_WORDS } from "../../words.ts";
import type { PluginsPage } from "./page.ts";
import { Mark, Section } from "./rows.tsx";
import {
  projectSkillsSection,
  pluginSkillRows,
  providerNote,
  type ShownSkill,
  type SkillRow,
  SkillsSection,
  type SkillsSectionView,
  studioSkillsSection,
} from "./skills-sections.ts";
import { Pending } from "../../ui/Pending.tsx";

const NO_MATCH = "No skills match your search.";

/** A skill as the Skills tab lists it: a name, a line under it, and what opening it shows. */
function SkillButton({
  name,
  line,
  hook,
  onOpen,
  children,
}: {
  name: string;
  line: string;
  /** The row's `data-skill-row` value, for smoke checks. */
  hook?: string;
  onOpen: () => void;
  children?: JSX.Element | false;
}): JSX.Element {
  return (
    <button type="button" className="extension-open" data-skill-row={hook} onClick={onOpen}>
      <Mark kind="box" />
      <span className="extension-copy">
        <span className="extension-name">{name}</span>
        <span className="extension-description">{line}</span>
      </span>
      {children}
    </button>
  );
}

/** What a provider's skill page says: its description, where it lives, whether builders load it, and whether it is off. */
function providerSkillText(provider: ProviderSkillInventory, s: ProviderSkill): string {
  const disabled = s.enabled === false ? "\nDisabled in the provider configuration." : "";
  return `${s.description}\n\nSource: ${s.scope}\n${s.path}\n\n${providerNote(provider)}${disabled}`;
}

/** Why a provider's list is empty: the search, an unreadable inventory, or no skills at all. */
function providerEmptyWords(query: string, provider: ProviderSkillInventory): string {
  if (query) return NO_MATCH;
  return provider.warnings.length ? "Inventory unavailable. Refresh to retry." : "No global skills found.";
}

function ProviderSkills({
  provider,
  page,
  query,
  onSkill,
}: {
  provider: ProviderSkillInventory;
  page: PluginsPage;
  query: string;
  onSkill: (skill: ShownSkill) => void;
}): JSX.Element {
  const shown = provider.skills.filter((s) => page.matches(s.name, s.description, s.scope));
  return (
    <Section
      title={SKILLS_WORDS.providerTitle(provider.label)}
      count={provider.skills.length}
      hooks={{ "data-skills-section": SkillsSection.Provider, "data-skills-provider": provider.provider }}
    >
      <p className="mb-3 text-sm text-ink-3">{providerNote(provider)}</p>
      {provider.warnings.map((warning) => (
        <p key={warning} role="status" className="text-sm text-orange">
          {warning}
        </p>
      ))}
      <div className="extensions-grid">
        {shown.map((s) => (
          <SkillButton
            key={s.path}
            name={s.name}
            line={s.description || s.scope}
            onOpen={() =>
              onSkill({ plugin: "", provider: provider.label, name: s.name, text: providerSkillText(provider, s) })
            }
          >
            {s.enabled === false && <span className="text-xs text-ink-3">Disabled</span>}
          </SkillButton>
        ))}
      </div>
      {!shown.length && <p className="extensions-empty">{providerEmptyWords(query, provider)}</p>}
    </Section>
  );
}

/** What sits beside a row: the builders that load a project's skill, or whether a plugin skill's plugin is on. */
function RowTag({ row }: { row: SkillRow }): JSX.Element | false {
  if (row.tag) return <span className="shrink-0 text-xs text-ink-3">{row.tag}</span>;
  if (row.enabled === undefined) return false;
  return row.enabled ? (
    <Icon name="check" className="text-icon" />
  ) : (
    <span className="text-xs text-ink-3">Disabled</span>
  );
}

/** One section built by `skills-sections.ts`: its intro, its rows the search keeps, and what it says when empty. */
function RowsSection({
  view,
  page,
  query,
  empty,
  onSkill,
}: {
  view: SkillsSectionView;
  page: PluginsPage;
  query: string;
  empty?: string;
  onSkill: (skill: ShownSkill) => void;
}): JSX.Element {
  const shown = view.rows.filter((row) => page.matches(row.name, ...row.search));
  const emptyWords = query ? NO_MATCH : empty;
  return (
    <Section title={view.title} count={view.rows.length} hooks={{ "data-skills-section": view.id }}>
      {view.intro && <p className="mb-3 text-sm text-ink-3">{view.intro}</p>}
      {view.warnings?.map((warning) => (
        <p key={warning} role="status" className="text-sm text-orange">
          {warning}
        </p>
      ))}
      <div className="extensions-grid">
        {shown.map((row) => (
          <SkillButton key={row.key} name={row.name} line={row.line} hook={row.key} onOpen={() => onSkill(row.skill)}>
            <RowTag row={row} />
          </SkillButton>
        ))}
      </div>
      {!shown.length && emptyWords && <p className="extensions-empty">{emptyWords}</p>}
    </Section>
  );
}

/** This project's own skills, once the open project's folder has been read. */
function ProjectSkills({
  project,
  page,
  query,
  onSkill,
}: {
  project: ProjectSkillInventory;
  page: PluginsPage;
  query: string;
  onSkill: (skill: ShownSkill) => void;
}): JSX.Element {
  const view = projectSkillsSection(project);
  return <RowsSection view={view} page={page} query={query} empty={view.empty} onSkill={onSkill} />;
}

/** The Skills tab's lists, below the search. */
export function SkillsBrowse({
  plugins,
  page,
  query,
  builtins,
  project,
  providerInventory,
  skillsLoading,
  onSkill,
}: {
  plugins: PluginInfo[];
  page: PluginsPage;
  query: string;
  builtins: Array<{ name: string; text: string; description: string }>;
  project: ProjectSkillInventory | null;
  providerInventory: ProviderSkillInventory[] | null;
  skillsLoading: boolean;
  onSkill: (skill: ShownSkill) => void;
}): JSX.Element {
  const pluginsView: SkillsSectionView = {
    id: SkillsSection.Plugins,
    title: SKILLS_WORDS.pluginsTitle,
    intro: "",
    rows: pluginSkillRows(plugins),
  };
  return (
    <>
      {project && <ProjectSkills project={project} page={page} query={query} onSkill={onSkill} />}
      <RowsSection view={studioSkillsSection(builtins)} page={page} query={query} onSkill={onSkill} />
      {skillsLoading && <Pending label="Reading provider skills…" />}
      {providerInventory?.map((provider) => (
        <ProviderSkills key={provider.provider} provider={provider} page={page} query={query} onSkill={onSkill} />
      ))}
      <RowsSection
        view={pluginsView}
        page={page}
        query={query}
        empty="Installed plugins can include skills. They’ll appear here."
        onSkill={onSkill}
      />
    </>
  );
}
