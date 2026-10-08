/**
 * A frozen eval case as `evals/cases.md` (and the private holdout file) declares it (§6.1). The
 * parser in `cases.ts` builds these; graders and reports read them. A pinned brief is never
 * reworded: a change is a new id, and `version` is the sha256 of the case block, never of the file.
 */
import type { CaseExposure, CaseMode, CaseVisibility } from "./vocabulary.ts";

/** One acceptance line: `[ ] text <- "brief phrase"`, with `KEY:` and `full assets only:` prefixes. */
export interface AcceptanceItem {
  /** Stable within the case: `<case id>-<index>` in file order. */
  id: string;
  text: string;
  /** The brief phrase the item traces to, or null when the line gave none. */
  tracesTo: string | null;
  /** A `KEY:` item; its failure weighs like any other but is named first in reports. */
  key: boolean;
  /** Skipped under `assets: none`. */
  assetsOnly: boolean;
  /** The absurd control item (§8.4); a grade that passes it is void. */
  control: boolean;
}

/** A follow-up turn for a multi-turn case (M3). */
export interface CaseFollowUp {
  index: number;
  text: string;
}

/** One frozen case. */
export interface EvalCase {
  id: string;
  /** The `C<n>` number in the file. */
  number: number;
  label: string;
  brief: string;
  mode: CaseMode;
  exposure: CaseExposure;
  /** The reason given after `dev-tuned`, or null. */
  exposureReason: string | null;
  visibility: CaseVisibility;
  acceptance: AcceptanceItem[];
  followUps: CaseFollowUp[];
  /** Minutes the lane is given; the default when the case names none. */
  deadlineMin: number;
  /** sha256(case block)[:12]. */
  version: string;
  /** sha256 of the acceptance block, so adding cases never invalidates old rows. */
  checklistVersion: string;
  /** The committed folder an edit case starts from, repository-relative under `tests/fixtures/evals/projects`, or null. */
  startFrom: string | null;
}

/** The default deadline a case gets when it names none (§5.2). */
export const DEFAULT_CASE_DEADLINE_MIN = 90;
