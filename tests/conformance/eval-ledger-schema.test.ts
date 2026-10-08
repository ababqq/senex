/**
 * The ledger's closed schema and its guard (§9.1, §9.3): the synthetic fixtures validate, every
 * hostile shape is refused by the field it sits in (unknown keys at any depth, free-text pins,
 * non-finite numbers, open maps), refusal messages never echo the value, and the denylist catches
 * what a pattern alone lets through (an internal domain or a key spelled as a model id).
 * Hostile strings are assembled at run time so the committed-data scan never sees them whole.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { denylistRule, GuardRule } from "../../scripts/evals/ledger/denylist.ts";
import { LedgerGuardError, guardRow } from "../../scripts/evals/ledger/guard.ts";
import {
  LedgerSchemaError,
  validateHumanRow,
  validateLedgerRow,
  validatePairwiseRow,
  validateRunRow,
} from "../../scripts/evals/ledger/schema.ts";

const fixtures = path.resolve(import.meta.dirname, "../fixtures/evals/ledger");
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(fixtures, `${name}.json`), "utf8"));
/** A hostile string, joined here so no committed file spells it whole. */
const spell = (...parts: string[]) => parts.join("");

type Row = Record<string, unknown>;
const run = (): Row => fixture("run-row");
const USAGE = { uncachedInput: 1, cacheWrite: 2, cacheRead: 3, output: 4, reasoning: 0 };

/** The object holding the last segment of a dotted path, in `row`. */
function parentOf(row: Row, keys: string[]): Row {
  let at = row;
  for (const key of keys) at = at[key] as Row;
  return at;
}

/** Set a dotted path on a clone of `row`. */
function withField(row: Row, dotted: string, value: unknown): Row {
  const copy = structuredClone(row);
  const keys = dotted.split(".");
  const last = keys.pop() as string;
  parentOf(copy, keys)[last] = value;
  return copy;
}

/** Remove a dotted path from a clone of `row`. */
function withoutField(row: Row, dotted: string): Row {
  const copy = structuredClone(row);
  const keys = dotted.split(".");
  const last = keys.pop() as string;
  delete parentOf(copy, keys)[last];
  return copy;
}

function refusedAt(validate: (value: unknown) => unknown, value: unknown, field: string): void {
  assert.throws(
    () => validate(value),
    (error: unknown) => error instanceof LedgerSchemaError && error.field === field,
    `expected a refusal at ${field}`,
  );
}

describe("the closed schema", () => {
  it("accepts the three synthetic rows and dispatches on their schema id", () => {
    assert.equal(validateRunRow(run()).runId, "20261002T101500-genex-claude-sample-case-r1");
    assert.equal(validatePairwiseRow(fixture("pairwise-row")).family, "gpt");
    assert.equal(validateHumanRow(fixture("human-row")).pick, "a");
    for (const name of ["run-row", "pairwise-row", "human-row"])
      assert.deepEqual(validateLedgerRow(fixture(name)), fixture(name));
  });

  it("accepts a raw lane with n/a Genex pins and no in-app block", () => {
    let row = withField(run(), "lane.agent", "claude-cli");
    row = withField(row, "pins.run.appSha", { na: true });
    row = withField(row, "pins.run.harnessSeedDigest", { na: true });
    row = withField(row, "inApp", null);
    row = withField(row, "probe", null);
    row = withField(row, "checklist", null);
    assert.equal(validateRunRow(row).inApp, null);
  });

  const hostile: Array<[string, Row | unknown, string]> = [
    ["not an object", "row", "row"],
    ["an array", [], "row"],
    ["an unknown top-level key", { ...run(), comment: "hi" }, "comment"],
    ["an unknown nested key", withField(run(), "lane.extra", "x"), "lane.extra"],
    ["an own __proto__ key", JSON.parse(`{"__proto__":{"x":1},${JSON.stringify(run()).slice(1)}`), "__proto__"],
    ["a missing field", withoutField(run(), "notes"), "notes"],
    ["another schema id", withField(run(), "schema", "genex-evals/run/2"), "schema"],
    ["an ending outside the vocabulary", withField(run(), "outcome.endedHow", "finished"), "outcome.endedHow"],
    ["a runId off pattern", withField(run(), "runId", "run-1"), "runId"],
    [
      "a free-text unavailable reason",
      withField(run(), "cost.apiEquivalentUsd", { unavailable: true, reason: "because" }),
      "cost.apiEquivalentUsd",
    ],
    ["an n/a pin with extra keys", withField(run(), "pins.run.appSha", { na: true, why: "x" }), "pins.run.appSha"],
    ["a false n/a pin", withField(run(), "pins.run.appSha", { na: false }), "pins.run.appSha"],
    ["a non-finite number", withField(run(), "cost.apiEquivalentUsd", Number.NaN), "cost.apiEquivalentUsd"],
    ["a negative count", withField(run(), "outcome.questionsAsked", -1), "outcome.questionsAsked"],
    ["a fractional count", withField(run(), "output.files", 1.5), "output.files"],
    ["a gradeSeq of zero", withField(run(), "gradeSeq", 0), "gradeSeq"],
    ["a role outside the closed map", withField(run(), "tokens.byRole.boss", USAGE), "tokens.byRole.boss"],
    ["a model key off pattern", withField(run(), "tokens.byModel", { "Big Model": USAGE }), "tokens.byModel.<key>"],
    ["a probe row outside the vocabulary", withField(run(), "probe.rows.l9", "pass"), "probe.rows.l9"],
    ["free text in notes", withField(run(), "notes", ["looked fine to me"]), "notes.0"],
    ["a share above one", withField(run(), "checklist.scoreAllRuns", 1.2), "checklist.scoreAllRuns"],
    ["a string where a number belongs", withField(run(), "time.wallMs", "3912000"), "time.wallMs"],
    ["a done time on a run the rail stopped", withField(run(), "outcome.endedHow", "deadline"), "time.toDoneMs"],
    ["a digest that is not hex", withField(run(), "digests.streamSha256", "z".repeat(64)), "digests.streamSha256"],
    [
      "an endpoints pin that is not sha256[:12]",
      withField(run(), "pins.grading.endpointsSha", "e".repeat(64)),
      "pins.grading.endpointsSha",
    ],
    [
      "an API error status that is no HTTP status",
      withField(run(), "outcome.providerNoise.apiErrorStatus", 42),
      "outcome.providerNoise.apiErrorStatus",
    ],
    [
      "provider noise without its status",
      withoutField(run(), "outcome.providerNoise.apiErrorStatus"),
      "outcome.providerNoise.apiErrorStatus",
    ],
  ];
  for (const [name, value, field] of hostile)
    it(`refuses ${name}, naming ${field}`, () => refusedAt(validateRunRow, value, field));

  it("refuses a pairwise row missing a facet and a human row with a named reviewer", () => {
    refusedAt(validatePairwiseRow, withoutField(fixture("pairwise-row"), "picks.play"), "picks.play");
    refusedAt(validateHumanRow, withField(fixture("human-row"), "reviewerId", "ivan"), "reviewerId");
    refusedAt(validateLedgerRow, withField(fixture("human-row"), "schema", "genex-evals/other/1"), "schema");
  });

  it("never echoes the refused value in its message", () => {
    const key = spell("sk-", "ant-", "a".repeat(30));
    assert.throws(
      () => validateRunRow(withField(run(), "case.id", `Case ${key}`)),
      (error: unknown) => error instanceof LedgerSchemaError && !error.message.includes(key),
    );
  });
});

describe("grader-validation labels", () => {
  /** A grader-validation label (§10.7): one run on both sides, no pick, no request answers, and the item. */
  const label = (): Row => {
    const row = withField(fixture("human-row"), "runIds.b", "20261002T101500-genex-claude-sample-case-r1");
    return {
      ...row,
      pick: null,
      requestSatisfied: null,
      item: { id: "sample-case-03", verdicts: { claude: "pass", gpt: "fail" }, human: "fail" },
    };
  };

  it("accepts a grader-validation label beside the pair review, both through the guard", () => {
    assert.equal(validateHumanRow(label()).item?.human, "fail");
    assert.deepEqual(guardRow(label()), label());
    assert.equal(validateHumanRow(fixture("human-row")).item, undefined);
  });

  const hostileLabels: Array<[string, Row, string]> = [
    ["a label with a pick", withField(label(), "pick", "a"), "pick"],
    [
      "a label with request answers",
      withField(label(), "requestSatisfied", { a: "pass", b: "pass" }),
      "requestSatisfied",
    ],
    ["a label naming two runs", withField(label(), "runIds.b", "20261002T101500-raw-claude-sample-case-r1"), "runIds"],
    ["a pair review with no pick", withField(fixture("human-row"), "pick", null), "pick"],
    [
      "a pair review with no request answers",
      withField(fixture("human-row"), "requestSatisfied", null),
      "requestSatisfied",
    ],
    ["an item id off pattern", withField(label(), "item.id", "Item three"), "item.id"],
    ["a verdict outside the vocabulary", withField(label(), "item.verdicts.gpt", "maybe"), "item.verdicts.gpt"],
    ["a family outside the vocabulary", withField(label(), "item.verdicts.bard", "pass"), "item.verdicts.bard"],
    ["an unknown key on the item", withField(label(), "item.note", "x"), "item.note"],
  ];
  for (const [name, value, field] of hostileLabels)
    it(`refuses ${name}, naming ${field}`, () => refusedAt(validateHumanRow, value, field));
});

describe("the denylist", () => {
  const hits: Array<[string, string, GuardRule]> = [
    ["a macOS home path", spell("/Us", "ers/someone/project"), GuardRule.AbsolutePath],
    ["a Linux home path", spell("/ho", "me/someone"), GuardRule.AbsolutePath],
    ["a Windows drive path", spell("C:", "\\Projects\\x"), GuardRule.AbsolutePath],
    ["a tilde path", spell("~", "/notes"), GuardRule.AbsolutePath],
    ["an email", spell("someone", "@", "example.org"), GuardRule.Email],
    ["an API key", spell("sk-", "ant-", "abcdef123456"), GuardRule.Secret],
    ["a bearer header", spell("Bearer ", "abc.def"), GuardRule.Secret],
    ["a JWT head", spell("ey", "JhbGciOiJIUzI1NiJ9"), GuardRule.Jwt],
    ["an eval ingest key", spell("genex_", "sk_v1_", "abc"), GuardRule.IngestKey],
    ["a long base64 run", "QUJD".repeat(70), GuardRule.Base64],
    ["a string over 120 characters", "word ".repeat(30), GuardRule.TooLong],
    ["the product domain", spell("api.", "genex", ".games"), GuardRule.InternalDomain],
    ["the old domain", spell("x.auras", ".cc"), GuardRule.InternalDomain],
    ["a public bucket host", spell("pub-1.r2", ".dev"), GuardRule.InternalDomain],
    ["a bucket endpoint", spell("a.r2.cloudflare", "storage.com"), GuardRule.InternalDomain],
  ];
  for (const [name, text, rule] of hits) it(`flags ${name} as ${rule}`, () => assert.equal(denylistRule(text), rule));

  it("passes the codes and patterns a row is made of", () => {
    for (const text of [
      "genex-prober/6+desktop.1",
      "claude-opus-5-5",
      "2026-10-02T12:05:11Z",
      "darwin-25.6.0",
      "l1.builds_and_boots",
    ])
      assert.equal(denylistRule(text), null, text);
  });
});

describe("guardRow", () => {
  it("passes a clean row unchanged", () => {
    assert.deepEqual(guardRow(run()), run());
  });

  const refusals: Array<[string, Row | unknown, string, GuardRule]> = [
    ["a schema failure", withField(run(), "runId", "x"), "runId", GuardRule.Schema],
    [
      "an internal domain spelled as a model id",
      withField(run(), "model.requested", spell("api.", "genex", ".games")),
      "model.requested",
      GuardRule.InternalDomain,
    ],
    [
      "a key spelled as a model id",
      withField(run(), "model.main", spell("sk-", "ant-", "abcdef123456")),
      "model.main",
      GuardRule.Secret,
    ],
    [
      "a key in a map key",
      withField(run(), "tokens.byModel", { [spell("r2", ".dev")]: USAGE }),
      "tokens.byModel",
      GuardRule.InternalDomain,
    ],
  ];
  for (const [name, value, field, rule] of refusals)
    it(`refuses ${name} as ${rule} at ${field}`, () =>
      assert.throws(
        () => guardRow(value),
        (error: unknown) => error instanceof LedgerGuardError && error.rule === rule && error.field === field,
      ));
});
