import {
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
  type RefObject,
} from "react";
import type { ConnectionSnapshot } from "../../shared/connections.ts";
import type { PluginInfo } from "../../shared/plugins.ts";
import type { McpConnectorView } from "../../shared/mcp.ts";
import { UiEvent, type UiEventType } from "../../shared/ui-events.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { useAsyncEffect } from "../use-async-effect.ts";
import {
  type AddMenuEntry,
  addMenuEntries,
  type EntryActions,
  EntryScope,
  IMAGES_OPTION,
  type MentionOption,
  mentionOptions,
  visibleConnectors,
} from "./add-menu-entries.ts";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";
import { ComposerTip, PickerLabel, PickerSeparator, PickerSwitch, pickerItem, pickerRow } from "./PickerPanel.tsx";
import { Shortcut } from "./Shortcut.tsx";
import { Icon } from "./icons.tsx";
import { PluginIcon } from "./PluginIcon.tsx";
import { PLAN_MODE_WORDS, SKILLS_WORDS } from "../words.ts";
import { RovingAxis, rovingTarget } from "./roving-focus.ts";
import { Pending } from "./Pending.tsx";

/** Shell navigation shared with the Plugins page. */
export const OPEN_PLUGINS_EVENT = "studio:open-plugins";
/** Lets the composer's text box steer the @ list while its own focus stays in the text. */
export interface AddMenuHandle {
  keyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean;
}

/** While the menu is open, the plugins, servers and accounts are read again this often. */
const ADD_MENU_POLL_MS = 5 * SECOND_MS;
/** The events after which the menu reads its lists again. */
const REFRESHING_EVENTS: ReadonlySet<UiEventType> = new Set<UiEventType>([
  UiEvent.PluginsChanged,
  UiEvent.McpChanged,
  UiEvent.ConnectionsChanged,
]);

/**
 * The plugins, servers and accounts the menu lists, read while it is open: at once, on every
 * change main announces, and on a poll. A read that a newer one overtook is dropped.
 */
function useAddMenuData(open: boolean, project: string | null | undefined) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [connectors, setConnectors] = useState<McpConnectorView[]>([]);
  const [connections, setConnections] = useState<ConnectionSnapshot | null>(null);
  const [error, setError] = useState("");
  // Until the first read answers, an empty list means "not read yet", not "nothing there".
  const [read, setRead] = useState(false);
  const refreshSequence = useRef(0);
  const refresh = async (isLive = () => true) => {
    const sequence = ++refreshSequence.current;
    const current = () => isLive() && sequence === refreshSequence.current;
    try {
      const [p, m, c] = await Promise.all([
        window.studio.pluginsList(),
        window.studio.mcpList(),
        window.studio.connections(undefined, project),
      ]);
      if (!current()) return;
      setPlugins(p.filter((plugin) => !plugin.removed && !plugin.unlisted));
      setConnectors(m);
      setConnections(c);
      setError("");
      setRead(true);
    } catch (e) {
      if (!current()) return;
      setConnections(null);
      setError(String(e));
      setRead(true);
    }
  };
  useAsyncEffect(
    (alive) => {
      if (!open) return;
      const update = () => void refresh(alive);
      update();
      const off = window.studio.onEvent((e) => {
        if (REFRESHING_EVENTS.has(e.type)) update();
      });
      const timer = setInterval(update, ADD_MENU_POLL_MS);
      return () => {
        off();
        clearInterval(timer);
      };
    },
    [open, project],
  );
  return { plugins, connectors, connections, error, read, setError, refresh };
}

/** What a key does in the @ list. */
const MentionKey = {
  Move: "move",
  Pick: "pick",
  Close: "close",
} as const;
type MentionKey = (typeof MentionKey)[keyof typeof MentionKey];

/** The arrows move, Enter (not a new line, not mid-composition) or Tab picks, Escape closes. */
function mentionIntent(event: KeyboardEvent<HTMLTextAreaElement>): MentionKey | null {
  if (event.key === "Escape") return MentionKey.Close;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") return MentionKey.Move;
  if (event.key === "Tab") return MentionKey.Pick;
  const enter = event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing;
  return enter ? MentionKey.Pick : null;
}

/** An option list the composer's text box drives: the @ list, and the / commands. */
export interface MentionState {
  mentioning: boolean;
  matches: MentionOption[];
  active: number;
  setHighlight: (index: number) => void;
  onClose?: () => void;
}

/** One key in the composer's text box while an option list is up; true when the list took it. */
export function mentionKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, mention: MentionState): boolean {
  const { matches, active } = mention;
  const intent = mention.mentioning ? mentionIntent(event) : null;
  if (intent === null) return false;
  if (intent === MentionKey.Close) {
    event.preventDefault();
    event.stopPropagation();
    mention.onClose?.();
    return true;
  }
  if (!matches.length) return false;
  event.preventDefault();
  if (intent === MentionKey.Move)
    mention.setHighlight(rovingTarget(event.key, active, matches.length, RovingAxis.Vertical) ?? active);
  else matches[active]?.pick();
  return true;
}

/** The @ list's keys, handed to the composer's text box: arrows move, Enter or Tab picks, Escape closes. */
function useMentionKeys(ref: Ref<AddMenuHandle> | undefined, mention: MentionState): void {
  const { mentioning, matches, active } = mention;
  useImperativeHandle(ref, () => ({ keyDown: (event) => mentionKeyDown(event, mention) }), [
    mentioning,
    matches,
    active,
  ]);
}

/**
 * A plugin or server row: its name, a status only when something needs doing, and its switch. Its
 * ids are by place, not by name: a server's id is the person's own.
 */
function EntryRow({
  entry,
  index,
  list,
  pending,
}: {
  entry: AddMenuEntry;
  index: number;
  list: string;
  pending: boolean;
}) {
  const id = `${list}-${entry.kind}-${index}`;
  const action = entry.status?.action;
  // Where the switch applies, while no status needs the space: a plugin is on or off for every project.
  const scope = !entry.status && entry.scope === EntryScope.AllProjects ? `${id}-scope` : undefined;
  return (
    <div className={`${pickerItem} hover:bg-control-hover`} data-plugin-row={entry.id}>
      <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 self-stretch">
        <PluginIcon name={entry.name} src={entry.icon} size="menu" />
        <span className="shrink-0">{entry.name}</span>
        {entry.status?.text && (
          <span className="picker-desc">
            {action && <span className="picker-dot" aria-hidden />}
            {entry.status.text}
          </span>
        )}
        {scope && (
          <span id={scope} className="picker-desc" data-plugin-scope={entry.scope}>
            {SKILLS_WORDS.allProjects}
          </span>
        )}
      </label>
      {action && (
        <button
          type="button"
          className="picker-action"
          disabled={pending}
          aria-label={`${action.label} ${entry.name}`}
          onClick={action.run}
        >
          {action.label}
        </button>
      )}
      <PickerSwitch
        id={id}
        checked={entry.on}
        disabled={pending || entry.locked}
        label={`Use ${entry.name}`}
        describedBy={scope}
        onChange={entry.toggle}
      />
    </div>
  );
}

/**
 * Add's Plan mode: the next message gets a plan, written in one go and reviewed in the chat
 * (Approve, Make changes, Cancel) before anything is built (`reviewPlan`). Sending resets it.
 */
export interface ComposerPlanMode {
  on: boolean;
  /** Offered where Mode's Loop is the chat's own: a build that owns the chat keeps its own plan. */
  available: boolean;
  onChange: (on: boolean) => void;
}

/** What Plan mode's row says: why it is not offered, else what a click does. */
function planRowWords(plan: ComposerPlanMode): string {
  if (!plan.available) return PLAN_MODE_WORDS.duringBuild;
  return plan.on ? PLAN_MODE_WORDS.turnOff : PLAN_MODE_WORDS.turnOn;
}

/** Plan mode, as in Codex: a row that turns it on (the bulb then shows it) or, while on, off. */
function PlanModeItem({ plan, onPicked }: { plan: ComposerPlanMode; onPicked: () => void }) {
  const description = planRowWords(plan);
  return (
    <button
      type="button"
      className={pickerRow}
      data-plan-mode-row
      aria-pressed={plan.on}
      disabled={!plan.available}
      onClick={() => {
        onPicked();
        plan.onChange(!plan.on);
      }}
    >
      <Icon name="bulb" className="text-ink" />
      <span className="shrink-0">{PLAN_MODE_WORDS.label}</span>
      <span className="picker-desc" title={description}>
        {description}
      </span>
    </button>
  );
}

/**
 * The bulb the composer shows while Add's Plan mode is on, behind a hairline as in Codex: one click
 * turns it off. Only Add turns it on; the permissions pill's Plan is another thing.
 */
export function PlanModeOff({ onOff, disabled = false }: { onOff: () => void; disabled?: boolean }) {
  return (
    <>
      <span aria-hidden className="composer-divider" />
      <ComposerTip align="start" content={PLAN_MODE_WORDS.turnOff}>
        <button
          type="button"
          aria-label={PLAN_MODE_WORDS.turnOff}
          data-plan-mode-off
          disabled={disabled}
          className="composer-icon"
          onClick={onOff}
        >
          <Icon name="bulb" />
        </button>
      </ComposerTip>
    </>
  );
}

/** The @ list: what matches the mention, with the highlighted option the text box points at. */
function MentionList({
  list,
  matches,
  read,
  active,
  optionId,
  onHighlight,
}: {
  list: string;
  matches: MentionOption[];
  /** The plugins and servers have been read: an empty list is no match, not a read on its way. */
  read: boolean;
  active: number;
  optionId: (index: number) => string;
  onHighlight: (index: number) => void;
}) {
  return (
    <div role="listbox" id={list} aria-label="Mention" data-mention-list>
      {matches.length === 0 &&
        (read ? (
          <div className={`${pickerItem} text-ink-3`}>No matches</div>
        ) : (
          <Pending label="Loading plugins…" className={pickerItem} />
        ))}
      {matches.map((item, index) => (
        <div
          key={item.id}
          id={optionId(index)}
          role="option"
          aria-selected={index === active}
          data-highlighted={index === active || undefined}
          className={`${pickerItem} cursor-pointer hover:bg-control-hover`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={item.pick}
          onMouseMove={() => onHighlight(index)}
        >
          <Icon name={item.id === IMAGES_OPTION ? "image" : "plugins"} className="text-icon-strong" />
          <span className="min-w-0 truncate">{item.name}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The full menu: Images and Plan mode, then the plugins and servers with their switches, then
 * Manage plugins.
 */
function FullMenu({
  entries,
  list,
  pending,
  error,
  plan,
  onImages,
  onPicked,
  onManage,
}: {
  entries: AddMenuEntry[];
  list: string;
  pending: boolean;
  error: string;
  plan: ComposerPlanMode | null;
  onImages: () => void;
  /** Closes the menu once a row acted. */
  onPicked: () => void;
  onManage: () => void;
}) {
  const pluginEntries = entries.filter((e) => e.kind === "plugin");
  const serverEntries = entries.filter((e) => e.kind === "mcp");
  const row = (entry: AddMenuEntry, index: number) => (
    <EntryRow key={entry.id} entry={entry} index={index} list={list} pending={pending} />
  );
  return (
    <>
      <PickerLabel first>Add</PickerLabel>
      <button type="button" className={pickerRow} onClick={onImages}>
        <Icon name="image" className="text-ink" />
        <span className="shrink-0">Images</span>
        <span className="picker-desc">Reference or mood board</span>
      </button>
      {plan && <PlanModeItem plan={plan} onPicked={onPicked} />}
      {pluginEntries.length > 0 && <PickerLabel>Plugins</PickerLabel>}
      {pluginEntries.map(row)}
      {serverEntries.length > 0 && <PickerLabel>MCP servers</PickerLabel>}
      {serverEntries.map(row)}
      {error && (
        <p role="alert" className="px-2.5 py-1.5 text-[12px] leading-4 text-red">
          {error}
        </p>
      )}
      <PickerSeparator />
      <button type="button" onClick={onManage} className={pickerRow}>
        <Icon name="plugins" className="text-ink" />
        Manage plugins
        <Icon name="chevron-right" className="ml-auto text-ink-3" />
      </button>
    </>
  );
}

/** The rows' actions, each run through the menu's `act` (one at a time, then a fresh read). */
function entryActions(
  act: (fn: () => Promise<unknown>) => Promise<void>,
  manage: (plugin?: string) => void,
  project: string | null | undefined,
): EntryActions {
  const where = project ?? undefined;
  return {
    manage,
    connect: (view) => void act(() => window.studio.mcpConnect(view.connector.id, where)),
    connectAccount: (plugin) =>
      void act(async () => {
        const name = plugin.manifest.account?.connect;
        if (name === undefined) return;
        const action = plugin.manifest.actions.find((a) => a.name === name);
        const review = action?.confirmation
          ? await window.studio.pluginReview(plugin.manifest.id, name, {}, where)
          : undefined;
        await window.studio.pluginAction(plugin.manifest.id, name, {}, where, review?.ticket);
      }),
    enablePlugin: (plugin, on) => void act(() => window.studio.pluginEnable(plugin.manifest.id, on)),
    enableServer: (view, on) => void act(() => window.studio.mcpSave({ ...view.connector, enabled: on })),
  };
}

/** Add: images and Plan mode, then plugins and MCP servers with their switches. Typing @ in the
 * composer opens the same list to mention one by name. A status appears only when something needs
 * doing, with the action that fixes it beside it. */
export function ComposerAddMenu({
  onReferences,
  anchor,
  disabled = false,
  project,
  plan = null,
  mention = null,
  listId,
  onMention,
  onMentionClose,
  onActiveOption,
  ref,
}: {
  onReferences: () => void;
  anchor: RefObject<HTMLDivElement | null>;
  disabled?: boolean;
  project?: string | null;
  /** Plan mode's row; null where the composer offers none. */
  plan?: ComposerPlanMode | null;
  /** The text after an @ at the caret, or null when the caret is not in a mention. */
  mention?: string | null;
  onMention?: (text: string | null) => void;
  onMentionClose?: () => void;
  /** The @ list's id and its highlighted option, for the text box's aria-controls/activedescendant. */
  listId?: string;
  onActiveOption?: (id: string | null) => void;
  ref?: Ref<AddMenuHandle>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const ownId = useId();
  const list = listId ?? ownId;
  const mentioning = mention !== null && !menuOpen;
  const open = menuOpen || mentioning;
  // A mention list stays a mention list until it has fully closed, and focus stays in the text
  // throughout: switching to the full menu mid-exit would pull focus into it.
  const viaMention = useRef(false);
  if (menuOpen) viaMention.current = false;
  else if (mentioning) viaMention.current = true;
  const listMode = viaMention.current;
  const data = useAddMenuData(open, project);
  useEffect(() => setHighlight(0), [mention]);
  const act = async (fn: () => Promise<unknown>) => {
    setPending(true);
    data.setError("");
    try {
      await fn();
      await data.refresh();
    } catch (e) {
      data.setError(String(e));
    } finally {
      setPending(false);
    }
  };
  const manage = (plugin?: string) => {
    setMenuOpen(false);
    onMentionClose?.();
    window.dispatchEvent(new CustomEvent(OPEN_PLUGINS_EVENT, { detail: { plugin } }));
  };
  const actions = entryActions(act, manage, project);
  const visible = visibleConnectors(data.connectors, data.plugins, project);
  const entries = addMenuEntries(data.plugins, visible, data.connections, actions);
  const pickImages = () => {
    onMention?.(null);
    onReferences();
  };
  const matches = mentionOptions(mention, entries, pickImages, (name) => onMention?.(`@${name} `));
  const active = Math.min(highlight, Math.max(0, matches.length - 1));
  useMentionKeys(ref, { mentioning, matches, active, setHighlight, onClose: onMentionClose });

  const optionId = (index: number) => `${list}-${index}`;
  const activeOption = mentioning && matches.length ? optionId(active) : null;
  useEffect(() => onActiveOption?.(activeOption), [activeOption]);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) onMentionClose?.();
        setMenuOpen(next);
      }}
    >
      <ComposerTip
        hidden={open}
        align="start"
        content={
          <span className="flex items-center gap-2">
            Add images and more <Shortcut>@</Shortcut>
          </span>
        }
      >
        <PopoverTrigger
          render={<button type="button" />}
          disabled={disabled}
          aria-label="Add images and more"
          className="composer-icon composer-add"
        >
          <Icon name="plus" />
        </PopoverTrigger>
      </ComposerTip>
      <PopoverContent
        anchor={anchor}
        side="top"
        align="start"
        sideOffset={8}
        initialFocus={!listMode}
        finalFocus={() => !viaMention.current}
        className="picker-panel composer-add-panel w-(--anchor-width) max-h-(--available-height) overflow-y-auto p-1.5"
        aria-label="Add"
      >
        {listMode ? (
          <MentionList {...{ list, matches, active, optionId }} read={data.read} onHighlight={setHighlight} />
        ) : (
          <FullMenu
            entries={entries}
            list={list}
            pending={pending}
            error={data.error}
            plan={plan}
            onPicked={() => setMenuOpen(false)}
            onImages={() => {
              setMenuOpen(false);
              onReferences();
            }}
            onManage={() => manage()}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
