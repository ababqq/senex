import { type JSX, useEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";
import { ComposerTip, PickerCaption } from "./PickerPanel.tsx";
import { Icon } from "./icons.tsx";
import { contextLabel, type ModelChoice, type RoleKey } from "./ModelMenu.tsx";
import { contextReading, limitLevel, PLAN_PROVIDERS, planWords, resetWords } from "./usage-words.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { usePolling } from "../use-polling.ts";
import { GenexCredits } from "../panels/plugins/genex/GenexCredits.tsx";
import type { ProviderUsage, ProviderUsageReport } from "../../shared/provider-usage.ts";
import type { ContextUsage } from "../../shared/context.ts";
import { Pending } from "./Pending.tsx";
import { selectedCompact } from "../chat/compact-control.ts";
import { COMPACT_WORDS } from "../words.ts";
export type { ContextUsage };
/** The ring's circumference: a circle of radius 6. */
const RING = 2 * Math.PI * 6;
const ROLE_WORDS: Record<RoleKey, string> = { planner: "Main agent", builder: "Workers", judge: "Reviewers" };
/** A reading this old says when it was taken. */
const STALE_MS = 10 * MINUTE_MS;
/** A usage reading younger than this is not asked for again on hover. */
const USAGE_FRESH_MS = 30 * SECOND_MS;
/** While the panel is open, usage is read again this often. */
const USAGE_POLL_MS = MINUTE_MS;
/** From this full (percent), the context ring and meter show as full. */
const CONTEXT_FULL = 85;
/** The last reading, painted at once when the panel opens again while a fresh one is fetched. */
let lastReports: ProviderUsageReport[] | null = null;

/** Which roles a plan serves: all of them, some by name, or none. */
function rolesWords(roles: RoleKey[], allRoles: number): string {
  if (!roles.length) return "Not in use";
  return roles.length === allRoles ? "In use" : roles.map((role) => ROLE_WORDS[role]).join(" · ");
}

/** Where a plan sorts: the orchestrator's first, then others in use, then the rest. */
function planRank(roles: RoleKey[] | undefined): number {
  if (roles?.includes("planner")) return 0;
  return roles?.length ? 1 : 2;
}

/** One limit window of a plan: its name, its reset, and how much of it is used. */
function LimitWindow({ window }: { window: ProviderUsage["windows"][number] }) {
  const percent = window.percent === null ? null : Math.round(window.percent);
  const resets = resetWords(window.resetsAt);
  const usedWords = percent === null ? "Not reported" : `${percent}% used`;
  return (
    <div className="usage-limit">
      <div className="usage-limit-head">
        <span className="min-w-0 truncate">{window.label}</span>
        <span className="usage-limit-value">
          {resets && <span className="truncate">{resets}</span>}
          <span>{percent === null ? "—" : `${percent}%`}</span>
        </span>
      </div>
      <div
        className="picker-meter"
        role="progressbar"
        aria-label={window.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={[usedWords, resets].filter(Boolean).join(", ")}
      >
        <i style={{ width: `${percent ?? 0}%` }} data-level={limitLevel(percent)} />
      </div>
    </div>
  );
}

function PlanLimits({
  report,
  roles,
  showRoles,
  allRoles,
}: {
  report: ProviderUsageReport;
  roles: RoleKey[];
  showRoles: boolean;
  allRoles: number;
}) {
  const usage: ProviderUsage | null = report.usage;
  const page = PLAN_PROVIDERS[report.engine]?.usagePage;
  const title = planWords(report.engine, usage?.plan);
  const stale = usage && Date.now() - Date.parse(usage.measuredAt) > STALE_MS;
  return (
    <section className="usage-plan" data-usage-engine={report.engine}>
      <div className="usage-plan-head">
        {page ? (
          <button
            type="button"
            className="usage-plan-link"
            onClick={() => void window.studio.openUrl(page)}
            aria-label={`${title}: open usage details`}
          >
            <span className="truncate">{title}</span>
            <Icon name="chevron-right" size={12} />
          </button>
        ) : (
          <span className="truncate">{title}</span>
        )}
        {showRoles && <span className="usage-plan-roles">{rolesWords(roles, allRoles)}</span>}
      </div>
      {usage?.windows.map((window) => (
        <LimitWindow key={window.id} window={window} />
      ))}
      {!usage?.windows.length && <p className="usage-note">Usage not reported</p>}
      {stale && (
        <p className="usage-note">
          As of {new Date(usage.measuredAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
        </p>
      )}
    </section>
  );
}

/**
 * The subscriptions' plan usage: the last reading at once, a fresh one on hover or focus (unless
 * one is recent), and a poll while the panel is open.
 */
function usePlanUsage(open: boolean) {
  const [reports, setReports] = useState<ProviderUsageReport[] | null>(
    () => lastReports ?? ("providerUsage" in (window.studio ?? {}) ? null : []),
  );
  // A read that failed with no earlier reading to show: the panel says so instead of checking forever.
  const [failed, setFailed] = useState(false);
  const fetchedAt = useRef(0);
  const refresh = (force = false) => {
    if (!force && Date.now() - fetchedAt.current < USAGE_FRESH_MS) return;
    fetchedAt.current = Date.now();
    void window.studio
      .providerUsage?.()
      .then((next) => {
        lastReports = next;
        setReports(next);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  };
  useEffect(() => {
    if (open) refresh();
  }, [open]);
  usePolling(() => refresh(true), USAGE_POLL_MS, open);
  return { reports, failed, refresh };
}

/** Each subscription's plan limits, once read; until then that they are being checked, or that they cannot be. */
function PlanUsage({
  reports,
  failed,
  usedBy,
}: {
  reports: ProviderUsageReport[] | null;
  failed: boolean;
  usedBy: Record<string, RoleKey[]>;
}): JSX.Element {
  if (reports === null && failed)
    return <p className="usage-note usage-divider">Plan usage isn’t available right now.</p>;
  if (reports === null) return <Pending label="Checking plan usage…" className="usage-note usage-divider" />;
  // The orchestrator's plan first, then the others this setup draws on, then any left to switch to.
  const rank = (engineId: string) => planRank(usedBy[engineId]);
  const plans = [...reports].sort((a, b) => rank(a.engine) - rank(b.engine));
  return (
    <>
      {plans.map((report) => (
        <PlanLimits
          key={report.engine}
          report={report}
          roles={usedBy[report.engine] ?? []}
          showRoles={plans.length > 1}
          allRoles={Object.values(usedBy).flat().length}
        />
      ))}
    </>
  );
}

/** The orchestrator's context and each signed-in subscription's plan limits. The ring is the
 * context summary; the panel adds the numbers, Compact now and the plans' remaining room. */
export function ComposerLimits({
  models,
  modelKey,
  usage,
  onCompact,
  compacting,
  compactBusy,
  contexts = [],
  usedBy = {},
  project,
}: {
  models: ModelChoice[];
  modelKey: string | null;
  usage?: ContextUsage | null;
  contexts?: ContextUsage[];
  onCompact?: () => void;
  compacting?: boolean;
  /** A turn or a build is under way: Compact now waits for it. */
  compactBusy?: boolean;
  /** Which roles each subscription serves in the current setup, keyed by engine id. */
  usedBy?: Record<string, RoleKey[]>;
  /** The open project: Genex's block reads this project's spend. */
  project?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const { reports, failed, refresh } = usePlanUsage(open);
  const selected = models.find((m) => m.key === modelKey);
  const { used, capacity, percent, summary } = contextReading({
    modelKey,
    usage,
    contexts,
    modelWindow: selected?.contextWindow,
  });
  const compact = selectedCompact(models, modelKey, { compacting: Boolean(compacting), busy: Boolean(compactBusy) });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ComposerTip hidden={open} content={percent == null ? "Context and usage" : `Context · ${percent}% used`}>
        <PopoverTrigger
          render={<button type="button" />}
          aria-label="Context and usage"
          className="composer-icon composer-ring"
          onPointerEnter={() => refresh()}
          onFocus={() => refresh()}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="-rotate-90">
            <circle cx="8" cy="8" r="6" className="composer-ring-track" />
            {percent != null && percent > 0 && (
              <circle
                cx="8"
                cy="8"
                r="6"
                className="composer-ring-value"
                data-full={percent >= CONTEXT_FULL || undefined}
                strokeDasharray={`${(percent / 100) * RING} ${RING}`}
              />
            )}
          </svg>
        </PopoverTrigger>
      </ComposerTip>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="picker-panel w-[340px] max-w-(--available-width) max-h-(--available-height) overflow-y-auto p-1.5"
        aria-label="Context and usage"
      >
        <section className="px-2.5 pt-1.5 pb-2">
          <div className="usage-limit-head text-chat">
            <span>Context window</span>
            <span className="usage-limit-value tabular-nums">
              {[used, capacity]
                .filter((n): n is number => n != null && n > 0)
                .map(contextLabel)
                .join(" / ")}
            </span>
          </div>
          <div
            className="picker-meter"
            role="progressbar"
            aria-label="Context used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            aria-valuetext={summary}
          >
            <i style={{ width: `${percent ?? 0}%` }} data-full={(percent ?? 0) >= CONTEXT_FULL || undefined} />
          </div>
          <p className="mt-2 text-[12px] leading-4 text-ink-3">{summary} · Compacts automatically</p>
        </section>
        {compact.shown && onCompact && (
          <div className="flex items-center gap-2 pr-1">
            <PickerCaption>{COMPACT_WORDS.caption}</PickerCaption>
            <button type="button" className="picker-action ml-auto" disabled={compact.disabled} onClick={onCompact}>
              {compacting ? COMPACT_WORDS.running : COMPACT_WORDS.action}
            </button>
          </div>
        )}
        <PlanUsage reports={reports} failed={failed} usedBy={usedBy} />
        <GenexCredits project={project} open={open} />
      </PopoverContent>
    </Popover>
  );
}
