/**
 * The composer usage panel's Genex block, the one place "used by this project" belongs: this project's
 * spend beside the balance every project shares. Read when the panel opens, only while Genex is on
 * and connected; otherwise the block is not there.
 */
import type { JSX } from "react";
import { useState } from "react";
import { GENEX_PLUGIN_ID, GenexAction, type GenexStatus } from "../../../../shared/genex.ts";
import { useAsyncEffect } from "../../../use-async-effect.ts";
import { GENEX_WORDS } from "../../../words.ts";
import { CreditsKind, creditsOf, isGenexStatus, spentOf } from "./genex-view.ts";

const WORDS = GENEX_WORDS.usage;
/** Credits read with the reader's own digit grouping. */
const NUMBER = new Intl.NumberFormat();

/** Genex's status for the open project, read each time the panel opens; null while off, signed out or unread. */
function useProjectStatus(project: string | null | undefined, open: boolean): GenexStatus | null {
  const [status, setStatus] = useState<GenexStatus | null>(null);
  useAsyncEffect(
    (alive) => {
      if (!open || !project) return;
      window.studio.pluginAction(GENEX_PLUGIN_ID, GenexAction.Status, {}, project).then(
        (next) => alive() && setStatus(isGenexStatus(next) && next.connected ? next : null),
        () => alive() && setStatus(null),
      );
    },
    [project, open],
  );
  return status;
}

/** The block: this project's spend, then what is left for all projects. */
export function GenexCredits({
  project,
  open,
}: {
  project: string | null | undefined;
  open: boolean;
}): JSX.Element | null {
  const status = useProjectStatus(project, open);
  if (!status) return null;
  const credits = creditsOf(status);
  const spent = spentOf(status.allowance);
  const left = credits.kind === CreditsKind.Count ? NUMBER.format(credits.count) : null;
  const balance = credits.kind === CreditsKind.Unlimited ? WORDS.unlimited : left;
  if (spent === null && balance === null) return null;
  return (
    <section className="usage-plan" aria-label={WORDS.title} data-usage-genex="">
      <div className="usage-plan-head">
        <span className="truncate">{WORDS.title}</span>
      </div>
      <dl className="usage-credits">
        {spent !== null && (
          <>
            <dt>{WORDS.thisProject}</dt>
            <dd>{NUMBER.format(spent)}</dd>
          </>
        )}
        {balance !== null && (
          <>
            <dt className="text-ink-3">{WORDS.left}</dt>
            <dd className="text-ink-3">{balance}</dd>
          </>
        )}
      </dl>
    </section>
  );
}
