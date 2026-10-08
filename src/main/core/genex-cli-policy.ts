/**
 * The Genex CLI commands an agent may have Studio run, as one table, and the argv each call
 * becomes. Pure: `genexCliRequest` either answers the exact argv for the pinned CLI or throws a
 * typed {@link GenexCliRefusal} naming what to use instead. The host adds the credential, the API
 * origin, `--no-auth` and `--json` itself (`genex-cli.ts`), and `--user-approved` only here, only
 * for a paid command the user has just approved.
 */
import { GENEX_CLI_PROMPT, GENEX_VALUE_RULE, GenexStudioTool } from "./genex-cli-prompts.ts";

/** The commands Studio runs, spelled as their words. Tool arguments: never rename a value. */
export const GenexCliCommand = {
  Doctor: "doctor",
  Budget: "budget",
  LlmModels: "llm models",
  LlmStatus: "llm status",
  LlmCancel: "llm cancel",
  LlmBench: "llm bench",
  ShopList: "shop list",
  ShopAdd: "shop add",
  ShopSet: "shop set",
  ShopRemove: "shop remove",
  ShopTest: "shop test",
} as const;
export type GenexCliCommand = (typeof GenexCliCommand)[keyof typeof GenexCliCommand];

/** Why a call was refused. */
export const GenexCliRefusalCode = {
  Unavailable: "unavailable",
  UseTool: "use-tool",
  PaidTool: "paid-tool",
  FreeTool: "free-tool",
  ReservedFlag: "reserved-flag",
  UnknownOption: "unknown-option",
  InvalidValue: "invalid-value",
} as const;
export type GenexCliRefusalCode = (typeof GenexCliRefusalCode)[keyof typeof GenexCliRefusalCode];

/** A call Studio will not run; its message tells the agent what to do instead. */
export class GenexCliRefusal extends Error {
  readonly code: GenexCliRefusalCode;
  constructor(code: GenexCliRefusalCode, message: string) {
    super(message);
    this.name = "GenexCliRefusal";
    this.code = code;
  }
}

/** The approval flag the CLI demands for spending; only Studio adds it, after the user said yes. */
const USER_APPROVED_FLAG = "--user-approved";
const POSITIONAL_MAX_CHARS = 4000;
const VALUE_MAX_CHARS = 500;
const COMMAND_MAX_WORDS = 2;
const MAX_BENCH_SAMPLES = 25;
const MAX_ATTEMPT_SECONDS = 60;
/** How much of one value the consent card's summary keeps, so no value pushes another off the card. */
const CONSENT_VALUE_MAX_CHARS = 60;
const UNBOUNDED = Number.MAX_SAFE_INTEGER;
/** Line breaks, tabs and every other control character. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * Flags Studio owns or that reach outside the run: never taken from the agent, whatever the
 * command. The rest of a command's flags are refused unless its row lists them.
 */
const RESERVED_FLAGS: ReadonlySet<string> = new Set([
  "env",
  "api-url",
  "auth-url",
  "dir",
  "agents",
  "out-dir",
  "force",
  "yes",
  "user-approved",
  "source-token",
  "token",
  "no-auth",
  "json",
  "help",
  "version",
]);

/** The shapes an option's value takes. */
const OptionKind = {
  Flag: "flag",
  Toggle: "toggle",
  WholeNumber: "whole-number",
  Choice: "choice",
  Text: "text",
} as const;

type OptionSpec =
  | { kind: typeof OptionKind.Flag }
  | { kind: typeof OptionKind.Toggle }
  | { kind: typeof OptionKind.WholeNumber; min: number; max: number }
  | { kind: typeof OptionKind.Choice; values: readonly string[] }
  | { kind: typeof OptionKind.Text };

const flag = { kind: OptionKind.Flag } as const;
const toggle = { kind: OptionKind.Toggle } as const;
const text = { kind: OptionKind.Text } as const;
const wholeNumber = (min: number, max = UNBOUNDED) => ({ kind: OptionKind.WholeNumber, min, max }) as const;

/**
 * One command's row: what it costs, whether it needs the hosted project, and what it takes. A
 * paid row declares the option that sets what it spends first: the consent card lists options in
 * this order (`genexCliConsentArgs`).
 */
interface CommandRow {
  paid: boolean;
  project: boolean;
  positional: boolean;
  options: Readonly<Record<string, OptionSpec>>;
  required?: readonly string[];
  /** The CLI refuses it without `--user-approved`: the spending commands, not the shop's. */
  approval?: boolean;
}

const free = (project: boolean, options: CommandRow["options"] = {}, positional = false): CommandRow => ({
  paid: false,
  project,
  positional,
  options,
});
const shopItem = (options: CommandRow["options"] = {}, required?: readonly string[]): CommandRow => ({
  paid: true,
  project: true,
  positional: true,
  options,
  ...(required ? { required } : {}),
});

/**
 * Every command Studio runs. `budget` only reads: its `--assets` allowance lives in the run folder,
 * which Studio removes after each call, and Studio's own allowance and consent govern asset spending.
 */
const GENEX_CLI_COMMANDS: Readonly<Record<GenexCliCommand, CommandRow>> = {
  [GenexCliCommand.Doctor]: free(false),
  [GenexCliCommand.Budget]: free(false),
  [GenexCliCommand.LlmModels]: free(false, { all: flag }),
  [GenexCliCommand.LlmStatus]: free(true),
  [GenexCliCommand.LlmCancel]: free(true, {}, true),
  [GenexCliCommand.LlmBench]: {
    paid: true,
    project: true,
    positional: true,
    options: {
      "max-coins": wholeNumber(1),
      samples: wholeNumber(1, MAX_BENCH_SAMPLES),
      model: text,
      "json-output": flag,
      text: flag,
      timeout: wholeNumber(1, MAX_ATTEMPT_SECONDS),
    },
    required: ["max-coins"],
    approval: true,
  },
  [GenexCliCommand.ShopList]: free(true),
  [GenexCliCommand.ShopAdd]: shopItem(
    {
      price: wholeNumber(1),
      type: { kind: OptionKind.Choice, values: ["consumable", "durable"] },
      icon: text,
      resellable: toggle,
    },
    ["price"],
  ),
  [GenexCliCommand.ShopSet]: shopItem({ rename: text, price: wholeNumber(1), icon: text, resellable: toggle }),
  [GenexCliCommand.ShopRemove]: shopItem(),
  [GenexCliCommand.ShopTest]: shopItem(),
};

/** Commands another Studio tool already covers, by their first word. */
const REPLACED_BY: Readonly<Record<string, GenexStudioTool>> = {
  preview: GenexStudioTool.Publish,
  promote: GenexStudioTool.Publish,
  publish: GenexStudioTool.Publish,
  image: GenexStudioTool.Asset,
  model: GenexStudioTool.Asset,
  texture: GenexStudioTool.Asset,
  video: GenexStudioTool.Asset,
  sfx: GenexStudioTool.Asset,
  music: GenexStudioTool.Asset,
  voice: GenexStudioTool.Asset,
  character: GenexStudioTool.Asset,
  creature: GenexStudioTool.Asset,
  animations: GenexStudioTool.Asset,
  motion: GenexStudioTool.Asset,
  wait: GenexStudioTool.Asset,
};

/** One call, ready to run: the command, its argv before Studio's own flags, and what it needs. */
export interface GenexCliRequest {
  command: GenexCliCommand;
  argv: string[];
  /** It runs against the project's hosted project, mirrored into the run folder. */
  project: boolean;
  paid: boolean;
}

const refuse = (code: GenexCliRefusalCode, message: string) => new GenexCliRefusal(code, message);
const isCommand = (words: string): words is GenexCliCommand => Object.hasOwn(GENEX_CLI_COMMANDS, words);

/** The command's words, or a refusal naming the tool that covers it. */
function commandOf(raw: unknown): GenexCliCommand {
  const words = typeof raw === "string" ? raw.trim().split(/\s+/).filter(Boolean) : [];
  const spelled = words.join(" ");
  if (isCommand(spelled) && words.length <= COMMAND_MAX_WORDS) return spelled;
  const replacement = REPLACED_BY[words[0] ?? ""];
  if (replacement) throw refuse(GenexCliRefusalCode.UseTool, GENEX_CLI_PROMPT.UseTool(spelled, replacement));
  throw refuse(GenexCliRefusalCode.Unavailable, GENEX_CLI_PROMPT.Unavailable(spelled));
}

/** The options as an object: an object parameter may arrive as its JSON text. */
function optionsOf(raw: unknown): Record<string, unknown> {
  if (raw === undefined) return {};
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw refuse(GenexCliRefusalCode.InvalidValue, GENEX_CLI_PROMPT.InvalidOptions);
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw refuse(GenexCliRefusalCode.InvalidValue, GENEX_CLI_PROMPT.InvalidOptions);
  return value as Record<string, unknown>;
}

/** A text value the CLI can only read as a value: bounded, one line, never a flag. */
function textValue(name: string, value: unknown, max: number): string {
  const ok = typeof value === "string" && value.length > 0 && value.length <= max;
  if (ok && !CONTROL_CHARACTER.test(value) && !value.startsWith("-")) return value;
  throw refuse(GenexCliRefusalCode.InvalidValue, GENEX_CLI_PROMPT.InvalidValue(name, GENEX_VALUE_RULE.Text(max)));
}

/** A whole number within its row's bounds; a digit string counts, 1.5 never does. */
function wholeNumberValue(name: string, value: unknown, spec: { min: number; max: number }): string {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n === "number" && Number.isInteger(n) && n >= spec.min && n <= spec.max) return String(n);
  throw refuse(
    GenexCliRefusalCode.InvalidValue,
    GENEX_CLI_PROMPT.InvalidValue(name, GENEX_VALUE_RULE.WholeNumber(spec.min, spec.max)),
  );
}

/** One option as argv: nothing for a false flag, `--no-x` for a false toggle. */
function optionArgv(name: string, value: unknown, spec: OptionSpec): string[] {
  const invalid = (rule: string) => refuse(GenexCliRefusalCode.InvalidValue, GENEX_CLI_PROMPT.InvalidValue(name, rule));
  switch (spec.kind) {
    case OptionKind.Flag:
      if (typeof value !== "boolean") throw invalid(GENEX_VALUE_RULE.Flag);
      return value ? [`--${name}`] : [];
    case OptionKind.Toggle:
      if (typeof value !== "boolean") throw invalid(GENEX_VALUE_RULE.Toggle);
      return [value ? `--${name}` : `--no-${name}`];
    case OptionKind.WholeNumber:
      return [`--${name}`, wholeNumberValue(name, value, spec)];
    case OptionKind.Choice:
      if (typeof value !== "string" || !spec.values.includes(value))
        throw invalid(GENEX_VALUE_RULE.Choice(spec.values));
      return [`--${name}`, value];
    case OptionKind.Text:
      return [`--${name}`, textValue(name, value, VALUE_MAX_CHARS)];
  }
}

/** Every option as argv, in the order given; reserved and unlisted names are refused. */
function optionsArgv(command: GenexCliCommand, row: CommandRow, options: Record<string, unknown>): string[] {
  const allowed = Object.keys(row.options);
  const argv: string[] = [];
  for (const [name, value] of Object.entries(options)) {
    if (RESERVED_FLAGS.has(name)) throw refuse(GenexCliRefusalCode.ReservedFlag, GENEX_CLI_PROMPT.ReservedFlag(name));
    const spec = row.options[name];
    if (!spec) throw refuse(GenexCliRefusalCode.UnknownOption, GENEX_CLI_PROMPT.UnknownOption(command, name, allowed));
    argv.push(...optionArgv(name, value, spec));
  }
  for (const name of row.required ?? [])
    if (options[name] === undefined)
      throw refuse(GenexCliRefusalCode.InvalidValue, GENEX_CLI_PROMPT.NeedsOption(command, name));
  return argv;
}

/** The positional argument as argv, when the command takes one. */
function positionalArgv(command: GenexCliCommand, row: CommandRow, raw: unknown): string[] {
  const given = raw !== undefined && raw !== "";
  if (!row.positional && given) throw refuse(GenexCliRefusalCode.InvalidValue, GENEX_CLI_PROMPT.NoPositional(command));
  if (!row.positional) return [];
  if (!given) throw refuse(GenexCliRefusalCode.InvalidValue, GENEX_CLI_PROMPT.NeedsPositional(command));
  return [textValue("args", raw, POSITIONAL_MAX_CHARS)];
}

/** The option `budget` would set a spend allowance with, which no Studio run keeps. */
const BUDGET_ALLOWANCE_OPTION = "assets";

/**
 * The argv for one `genex__cli` or `genex__cli-paid` call, or a typed refusal. `tool.paid` says
 * which tool asked: a paid command never runs through the free tool (which asked nobody), and a
 * free one never through the paid tool (which asked for nothing).
 */
export function genexCliRequest(args: Record<string, unknown>, tool: { paid: boolean }): GenexCliRequest {
  const command = commandOf(args.command);
  const options = optionsOf(args.options);
  const row = GENEX_CLI_COMMANDS[command];
  const setsAllowance = command === GenexCliCommand.Budget && Object.hasOwn(options, BUDGET_ALLOWANCE_OPTION);
  if (setsAllowance) throw refuse(GenexCliRefusalCode.UnknownOption, GENEX_CLI_PROMPT.BudgetAllowance);
  if (row.paid && !tool.paid) throw refuse(GenexCliRefusalCode.PaidTool, GENEX_CLI_PROMPT.PaidTool(command));
  if (!row.paid && tool.paid) throw refuse(GenexCliRefusalCode.FreeTool, GENEX_CLI_PROMPT.FreeTool(command));
  const argv = [
    ...command.split(" "),
    ...positionalArgv(command, row, args.args),
    ...optionsArgv(command, row, options),
    ...(row.paid && row.approval ? [USER_APPROVED_FLAG] : []),
  ];
  return { command, argv, project: row.project, paid: row.paid };
}

/** A value as the consent card shows it: one line, clipped. */
function consentValue(value: string): string {
  return value.length > CONSENT_VALUE_MAX_CHARS ? `${value.slice(0, CONSENT_VALUE_MAX_CHARS - 1)}…` : value;
}

/** The option names in the order the card lists them: the row's own order, text last. */
function consentOrder(row: CommandRow): string[] {
  const names = Object.keys(row.options);
  const isText = (name: string) => row.options[name]?.kind === OptionKind.Text;
  return [...names.filter((name) => !isText(name)), ...names.filter(isText)];
}

/**
 * What the consent card shows for a `genex__cli-paid` call, made by Studio from the call it would
 * run: the command, then every option in the row's order (what it spends first, free text last),
 * then the agent's own positional text, each clipped. A call Studio would refuse throws here, so
 * nobody is asked about it.
 */
export function genexCliConsentArgs(args: Record<string, unknown>, tool: { paid: boolean }): Record<string, string> {
  const request = genexCliRequest(args, tool);
  const row = GENEX_CLI_COMMANDS[request.command];
  const options = optionsOf(args.options);
  const shown: Record<string, string> = { command: request.command };
  for (const name of consentOrder(row)) {
    const value = options[name];
    if (value !== undefined) shown[name] = consentValue(typeof value === "string" ? value : JSON.stringify(value));
  }
  if (row.positional) shown.args = consentValue(String(args.args));
  return shown;
}
