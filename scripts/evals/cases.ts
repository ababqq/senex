/**
 * The case file parser (§6.1), ported from genex-demo's `runner/cases.ts` and `judge/cases.ts`.
 * `evals/cases.md` is the suite: this module holds a parser and no brief text, because a second
 * copy of a pinned brief is the drift the "never reworded" rule forbids. Each case is versioned by
 * the sha256 of its own block, never of the file, so adding or moving a case never invalidates the
 * rows of another. Holdouts are the same grammar read from `$GENEX_EVALS_HOME/cases-private.md`.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AcceptanceItem, CaseFollowUp, EvalCase } from "./case-types.ts";
import { DEFAULT_CASE_DEADLINE_MIN } from "./case-types.ts";
import { isLedgerSafeId } from "./ledger/denylist.ts";
import { SLUG_PATTERN } from "./ledger/types.ts";
import { CaseExposure, CaseMode, CaseVisibility } from "./vocabulary.ts";

/** The public case file, relative to the repository root. */
export const CASES_FILE = "evals/cases.md";
/** The private holdout file, relative to `$GENEX_EVALS_HOME`. */
export const PRIVATE_CASES_FILE = "cases-private.md";
/** The folder every `Start from:` project lives in, relative to the repository root. */
export const START_FROM_ROOT = "tests/fixtures/evals/projects";
/** Hex characters kept of a sha256 for a case or checklist version. */
export const CASE_DIGEST_CHARS = 12;

/** A parsed case: the contract's `EvalCase`, which carries its start folder (`startFrom`). */
export type ParsedCase = EvalCase;

/** The part of a case file a refusal names. */
export const CaseField = {
  Heading: "heading",
  Id: "id",
  Number: "number",
  Mode: "mode",
  Exposure: "exposure",
  Visibility: "visibility",
  Deadline: "deadline",
  Brief: "brief",
  Acceptance: "acceptance",
  Control: "control",
  FollowUps: "follow-ups",
  StartFrom: "start-from",
} as const;
export type CaseField = (typeof CaseField)[keyof typeof CaseField];

/** A case file's parse or validation failure, naming the case (when known) and the field. */
export class CaseFileError extends Error {
  readonly caseId: string | null;
  readonly field: CaseField;
  constructor(caseId: string | null, field: CaseField, detail: string) {
    super(`case file (${caseId ?? "file"}, ${field}): ${detail}`);
    this.name = "CaseFileError";
    this.caseId = caseId;
    this.field = field;
  }
}

const HEADING = /^##\s+C(\d+)\s+·\s+`([^`]+)`\s+—\s+(.*)$/;
const CASE_LIKE_HEADING = /^##\s+C\d+\b/;
const BLOCK_END = /^#{1,2}\s/;
const FENCE = /^```/;
const FIELD_LINE = /^\*\*([A-Za-z -]+):\*\*\s*(.*)$/;
const ITEM_OPEN = "[ ]";
const TICKED_ITEM = /^\[[xX]\]/;
const TRACE_TAIL = /^(.*?)\s*(?:<-|←)\s*"(.+)"\s*$/;
const KEY_PREFIX = /^KEY:\s*/;
const ASSETS_PREFIX = /^full assets only:\s*/i;
const EXPOSURE_VALUE = /^`?([a-z-]+)`?(?:\s*\((.+)\))?$/;
const DEADLINE_VALUE = /^(\d+)\s*min$/;
const LIST_ITEM = /^(?:\d+\.|-)\s+(.*)$/;
const START_FROM_VALUE = new RegExp(`^${START_FROM_ROOT}/[a-z0-9][a-z0-9-]*$`);
const PINNED_MARK = /✅\s*PINNED/g;
const LABEL_NOTE = /\*\(.*?\)\*/g;

const KNOWN_FIELDS: Record<string, CaseField> = {
  Mode: CaseField.Mode,
  Exposure: CaseField.Exposure,
  Visibility: CaseField.Visibility,
  Deadline: CaseField.Deadline,
  Acceptance: CaseField.Acceptance,
  Control: CaseField.Control,
  "Follow-ups": CaseField.FollowUps,
  "Start from": CaseField.StartFrom,
};

/** One `**Name:** value` line of a block, by field, with the line index it sits on. */
interface FieldLine {
  value: string;
  index: number;
}

/** A case block as cut from the file: its heading parts and its own lines. */
interface CaseBlock {
  number: number;
  id: string;
  label: string;
  lines: string[];
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, CASE_DIGEST_CHARS);
const stripTicks = (value: string) => value.replace(/^`|`$/g, "").trim();
const isVocabulary = <T extends string>(table: Record<string, T>, value: string): value is T =>
  (Object.values(table) as string[]).includes(value);

/** Whether each line sits inside a fenced block (fence lines themselves count as inside). */
function fenceMask(lines: readonly string[]): boolean[] {
  let inside = false;
  return lines.map((line) => {
    if (!FENCE.test(line.trim())) return inside;
    inside = !inside;
    return true;
  });
}

/** The line where the block starting at `start` ends: the next H1/H2 outside a fence. */
function blockEnd(lines: readonly string[], fenced: readonly boolean[], start: number): number {
  for (let i = start + 1; i < lines.length; i++) if (!fenced[i] && BLOCK_END.test(lines[i] ?? "")) return i;
  return lines.length;
}

/** The block without the blank lines and `---` rules that trail it, so separators never move a version. */
function trimBlock(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && /^(?:\s*|-{3,})$/.test(lines[end - 1] ?? "")) end--;
  return lines.slice(0, end);
}

function cleanLabel(raw: string): string {
  return raw.replace(PINNED_MARK, "").replace(LABEL_NOTE, "").trim();
}

/** Every case block in the file, in file order; a `## C<n>` heading of the wrong shape is refused. */
function caseBlocks(markdown: string): CaseBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const fenced = fenceMask(lines);
  const blocks: CaseBlock[] = [];
  lines.forEach((line, index) => {
    if (fenced[index]) return;
    const match = HEADING.exec(line);
    if (!match) {
      if (CASE_LIKE_HEADING.test(line)) throw new CaseFileError(null, CaseField.Heading, `malformed heading: ${line}`);
      return;
    }
    blocks.push({
      number: Number(match[1]),
      id: match[2] ?? "",
      label: cleanLabel(match[3] ?? ""),
      lines: trimBlock(lines.slice(index, blockEnd(lines, fenced, index))),
    });
  });
  if (!blocks.length) throw new CaseFileError(null, CaseField.Heading, "no case headings found");
  return blocks;
}

/** The block's known `**Field:**` lines outside fences and blockquotes; a repeated field is refused. */
function fieldLines(block: CaseBlock): Map<CaseField, FieldLine> {
  const fenced = fenceMask(block.lines);
  const fields = new Map<CaseField, FieldLine>();
  block.lines.forEach((line, index) => {
    const match = fenced[index] ? null : FIELD_LINE.exec(line.trim());
    const field = match ? KNOWN_FIELDS[match[1] ?? ""] : undefined;
    if (!field) return;
    if (fields.has(field)) throw new CaseFileError(block.id, field, "the field is repeated");
    fields.set(field, { value: (match?.[2] ?? "").trim(), index });
  });
  return fields;
}

/** The first `> ` run in the block, unwrapped: hard wraps are typography, not content. */
function firstBlockquote(block: CaseBlock): string {
  const start = block.lines.findIndex((line) => line.trim().startsWith(">"));
  if (start < 0) throw new CaseFileError(block.id, CaseField.Brief, "no brief blockquote");
  const collected: string[] = [];
  for (const line of block.lines.slice(start)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(">")) break;
    collected.push(trimmed.replace(/^>\s?/, ""));
  }
  const brief = collected.join(" ").replace(/\s+/g, " ").trim();
  if (!brief) throw new CaseFileError(block.id, CaseField.Brief, "the brief blockquote is empty");
  return brief;
}

function parseMode(block: CaseBlock, field: FieldLine | undefined): CaseMode {
  if (!field) return CaseMode.Build;
  const value = stripTicks(field.value);
  if (!isVocabulary(CaseMode, value)) throw new CaseFileError(block.id, CaseField.Mode, `unknown mode ${value}`);
  return value;
}

function parseExposure(
  block: CaseBlock,
  field: FieldLine | undefined,
): { exposure: CaseExposure; reason: string | null } {
  if (!field) throw new CaseFileError(block.id, CaseField.Exposure, "every case declares its exposure");
  const match = EXPOSURE_VALUE.exec(field.value);
  const value = match?.[1] ?? "";
  if (!isVocabulary(CaseExposure, value)) throw new CaseFileError(block.id, CaseField.Exposure, `unknown ${value}`);
  const reason = match?.[2]?.trim() || null;
  if ((value === CaseExposure.DevTuned) !== (reason !== null))
    throw new CaseFileError(block.id, CaseField.Exposure, "dev-tuned names its reason in parentheses; none has none");
  return { exposure: value, reason };
}

function parseVisibility(block: CaseBlock, field: FieldLine | undefined, source: CaseVisibility): CaseVisibility {
  if (!field) return source;
  const value = stripTicks(field.value);
  if (value !== source)
    throw new CaseFileError(block.id, CaseField.Visibility, `a ${value} case cannot live in the ${source} file`);
  return source;
}

function parseDeadline(block: CaseBlock, field: FieldLine | undefined): number {
  if (!field) return DEFAULT_CASE_DEADLINE_MIN;
  const minutes = Number(DEADLINE_VALUE.exec(field.value)?.[1] ?? Number.NaN);
  if (!Number.isInteger(minutes) || minutes <= 0)
    throw new CaseFileError(block.id, CaseField.Deadline, "a deadline is `<minutes> min`");
  return minutes;
}

function parseStartFrom(block: CaseBlock, field: FieldLine | undefined): string | null {
  if (!field) return null;
  const value = stripTicks(field.value);
  if (!START_FROM_VALUE.test(value))
    throw new CaseFileError(block.id, CaseField.StartFrom, `a start folder is one folder under ${START_FROM_ROOT}`);
  return value;
}

/** The fenced block after the `**Acceptance:**` line: its raw lines, fences excluded. */
function acceptanceFence(block: CaseBlock, field: FieldLine): string[] {
  const rest = block.lines.slice(field.index + 1);
  const open = rest.findIndex((line) => line.trim() !== "");
  if (open < 0 || !FENCE.test(rest[open]?.trim() ?? ""))
    throw new CaseFileError(block.id, CaseField.Acceptance, "the acceptance label is followed by a fenced block");
  const close = rest.findIndex((line, i) => i > open && FENCE.test(line.trim()));
  if (close < 0) throw new CaseFileError(block.id, CaseField.Acceptance, "the acceptance fence is not closed");
  return rest.slice(open + 1, close);
}

/** The fence's `[ ]` items, each with its wrapped continuation lines joined. */
function acceptanceLines(block: CaseBlock, fence: readonly string[]): string[] {
  const items: string[] = [];
  for (const line of fence) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (TICKED_ITEM.test(trimmed)) throw new CaseFileError(block.id, CaseField.Acceptance, "a pinned item is `[ ]`");
    if (trimmed.startsWith(ITEM_OPEN)) items.push(trimmed.slice(ITEM_OPEN.length).trim());
    else if (items.length) items[items.length - 1] = `${items[items.length - 1]} ${trimmed}`;
    else throw new CaseFileError(block.id, CaseField.Acceptance, `a line before the first item: ${trimmed}`);
  }
  if (!items.length) throw new CaseFileError(block.id, CaseField.Acceptance, "the acceptance block is empty");
  return items;
}

function acceptanceItem(caseId: string, index: number, line: string): AcceptanceItem {
  const traced = TRACE_TAIL.exec(line);
  const body = (traced ? (traced[1] ?? "") : line).trim();
  const key = KEY_PREFIX.test(body);
  const unkeyed = body.replace(KEY_PREFIX, "");
  const assetsOnly = ASSETS_PREFIX.test(unkeyed);
  return {
    id: itemId(caseId, index),
    text: unkeyed.replace(ASSETS_PREFIX, "").trim(),
    tracesTo: traced?.[2] ?? null,
    key,
    assetsOnly,
    control: false,
  };
}

const itemId = (caseId: string, index: number) => `${caseId}-${String(index + 1).padStart(2, "0")}`;

/** The checklist: the acceptance items and the control, and the raw text its version hashes. */
function parseChecklist(
  block: CaseBlock,
  fields: Map<CaseField, FieldLine>,
): { items: AcceptanceItem[]; text: string } {
  const label = fields.get(CaseField.Acceptance);
  const control = fields.get(CaseField.Control);
  if (!label && !control) return { items: [], text: "" };
  if (!label) throw new CaseFileError(block.id, CaseField.Control, "a control belongs to a checklist");
  if (!control?.value) throw new CaseFileError(block.id, CaseField.Control, "every checklist carries one control item");
  const fence = acceptanceFence(block, label);
  const items = acceptanceLines(block, fence).map((line, i) => acceptanceItem(block.id, i, line));
  const controlItem: AcceptanceItem = {
    id: itemId(block.id, items.length),
    text: control.value,
    tracesTo: null,
    key: false,
    assetsOnly: false,
    control: true,
  };
  return { items: [...items, controlItem], text: [...fence, block.lines[control.index] ?? ""].join("\n") };
}

/** The `**Follow-ups:**` list: numbered or bulleted items, wrapped lines joined, ending at a blank line. */
function parseFollowUps(block: CaseBlock, field: FieldLine | undefined): CaseFollowUp[] {
  if (!field) return [];
  const texts: string[] = [];
  for (const line of block.lines.slice(field.index + 1)) {
    const trimmed = line.trim();
    const item = LIST_ITEM.exec(trimmed);
    if (!trimmed) {
      if (texts.length) break;
    } else if (item) texts.push(item[1] ?? "");
    else if (texts.length && /^\s/.test(line)) texts[texts.length - 1] = `${texts[texts.length - 1]} ${trimmed}`;
    else throw new CaseFileError(block.id, CaseField.FollowUps, `not a list item: ${trimmed}`);
  }
  if (!texts.length) throw new CaseFileError(block.id, CaseField.FollowUps, "the follow-up list is empty");
  return texts.map((text, i) => ({ index: i + 1, text }));
}

/** The mode's structural requirements: a follow-up case has follow-ups, an edit case a start folder. */
function checkModeShape(c: ParsedCase): void {
  if ((c.mode === CaseMode.FollowUp) !== c.followUps.length > 0)
    throw new CaseFileError(c.id, CaseField.FollowUps, "follow-ups belong to, and are required by, a follow-up case");
  if ((c.mode === CaseMode.EditExisting) !== (c.startFrom !== null))
    throw new CaseFileError(c.id, CaseField.StartFrom, "a start folder belongs to, and is required by, an edit case");
}

function parseBlock(block: CaseBlock, source: CaseVisibility): ParsedCase {
  if (!SLUG_PATTERN.test(block.id)) throw new CaseFileError(block.id, CaseField.Id, "an id is a lowercase slug");
  if (!isLedgerSafeId(block.id))
    throw new CaseFileError(block.id, CaseField.Id, "an id must pass the ledger guard (no credential shape)");
  const fields = fieldLines(block);
  const { exposure, reason } = parseExposure(block, fields.get(CaseField.Exposure));
  const checklist = parseChecklist(block, fields);
  const parsed: ParsedCase = {
    id: block.id,
    number: block.number,
    label: block.label,
    brief: firstBlockquote(block),
    mode: parseMode(block, fields.get(CaseField.Mode)),
    exposure,
    exposureReason: reason,
    visibility: parseVisibility(block, fields.get(CaseField.Visibility), source),
    acceptance: checklist.items,
    followUps: parseFollowUps(block, fields.get(CaseField.FollowUps)),
    deadlineMin: parseDeadline(block, fields.get(CaseField.Deadline)),
    version: sha(block.lines.join("\n")),
    checklistVersion: sha(checklist.text),
    startFrom: parseStartFrom(block, fields.get(CaseField.StartFrom)),
  };
  checkModeShape(parsed);
  return parsed;
}

function checkUnique(cases: readonly ParsedCase[]): void {
  const ids = new Set<string>();
  const numbers = new Set<number>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new CaseFileError(c.id, CaseField.Id, "the id is used twice");
    if (numbers.has(c.number)) throw new CaseFileError(c.id, CaseField.Number, `C${c.number} is used twice`);
    ids.add(c.id);
    numbers.add(c.number);
  }
}

/**
 * Every case in a case file, in file order. `visibility` is the file's: the public file's cases
 * are public, the private file's are holdouts, and a case declaring the other one is refused.
 */
export function parseCases(markdown: string, visibility: CaseVisibility = CaseVisibility.Public): ParsedCase[] {
  const cases = caseBlocks(markdown).map((block) => parseBlock(block, visibility));
  checkUnique(cases);
  return cases;
}

/** The committed public cases (`evals/cases.md`) of the repository at `root`. */
export function readCases(root: string): ParsedCase[] {
  return parseCases(fs.readFileSync(path.join(root, CASES_FILE), "utf8"), CaseVisibility.Public);
}

/** The private holdout cases under an absolute evals home; none when the private file is absent. */
export function readHoldoutCases(evalsHome: string): ParsedCase[] {
  if (!path.isAbsolute(evalsHome)) throw new CaseFileError(null, CaseField.Visibility, "the evals home is absolute");
  const file = path.join(evalsHome, PRIVATE_CASES_FILE);
  if (!fs.existsSync(file)) return [];
  return parseCases(fs.readFileSync(file, "utf8"), CaseVisibility.Holdout);
}

/** The case with this id, if the list has one. */
export function caseById<T extends { id: string }>(cases: readonly T[], id: string): T | undefined {
  return cases.find((c) => c.id === id);
}

/** The real path, or null when nothing is there. */
function realPath(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/**
 * The real folder an edit case starts from: one directory directly under `START_FROM_ROOT` of
 * `root`, reached without a symlink. Anything else (a climb, an absolute path, a symlink, a file,
 * a missing folder) is refused; the check only reads.
 */
export function resolveStartFrom(root: string, evalCase: Pick<ParsedCase, "id" | "startFrom">): string {
  const refuse = (detail: string) => new CaseFileError(evalCase.id, CaseField.StartFrom, detail);
  const startFrom = evalCase.startFrom;
  if (startFrom === null || !START_FROM_VALUE.test(startFrom))
    throw refuse("no start folder under the fixture projects");
  const projectsRoot = realPath(path.join(root, START_FROM_ROOT));
  const real = realPath(path.join(root, startFrom));
  if (projectsRoot === null || real === null) throw refuse("the start folder does not exist");
  const expected = path.join(projectsRoot, path.basename(startFrom));
  if (real !== expected) throw refuse("the start folder is reached through a symlink");
  if (!fs.statSync(real).isDirectory()) throw refuse("the start folder is not a directory");
  return real;
}
