/**
 * What a fixture is allowed to warn about.
 *
 * `expectWarnings` is the list a fixture MUST produce, and for a long time it was the only list:
 * a fixture that named none asserted nothing, so a warning that started firing on every pass — a
 * page-UI probe that widened, a boot that slowed — left the sheet green and the manifest's own
 * `[]` false. The upper bound lives here. Every warning a run collects has to be named by the
 * fixture, in `expectWarnings` or in `allowWarnings`, or be one of the warnings about the machine
 * rather than the project.
 *
 * Both lists are substrings, matched the way the harness's own sentences read: a warning carries
 * measured numbers, so the fixture names the part that does not change.
 */
export interface WarningPolicy {
  /** Warnings this fixture must produce. */
  expectWarnings: string[];
  /** Warnings this fixture may produce and does not have to. */
  allowWarnings?: string[];
}

/**
 * The warnings a slow machine earns, not the project: a boot that crosses five seconds says
 * something about the laptop the suite runs on. These are the only sentences a fixture does not
 * have to name. `tests/conformance/shapes-fixtures.test.ts` asserts each is still a literal in
 * the harness seed, so a reworded warning cannot silently widen the tolerance.
 */
export const MACHINE_WARNINGS: readonly string[] = ["to report itself ready — every pass of the run pays that boot"];

const named = (policy: WarningPolicy): string[] => [...policy.expectWarnings, ...(policy.allowWarnings ?? [])];

/** The warnings the fixture promised and the run did not produce. */
export function missingWarnings(warnings: readonly string[], policy: WarningPolicy): string[] {
  return policy.expectWarnings.filter((expected) => !warnings.some((warning) => warning.includes(expected)));
}

/** The warnings the run produced and no list names — the half that used to go unasserted. */
export function undeclaredWarnings(warnings: readonly string[], policy: WarningPolicy): string[] {
  const allowed = [...named(policy), ...MACHINE_WARNINGS];
  return warnings.filter((warning) => !allowed.some((sentence) => warning.includes(sentence)));
}
