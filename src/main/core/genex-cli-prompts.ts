/** What an agent reads back from `genex__cli`, `genex__cli-paid` and `genex__package`. */

/** The Studio tools a refusal can point to instead. */
export const GenexStudioTool = {
  Cli: "genex__cli",
  CliPaid: "genex__cli-paid",
  Asset: "genex__asset",
  Publish: "genex__publish",
  Package: "genex__package",
} as const;
export type GenexStudioTool = (typeof GenexStudioTool)[keyof typeof GenexStudioTool];

/** Refusals and failures of a Studio-run Genex CLI command or package install. */
export const GENEX_CLI_PROMPT = {
  Unavailable: (command: string) =>
    `\`genex ${command}\` is not available in Studio. Available: doctor, budget, llm models, llm status, llm cancel and shop list through genex__cli; llm bench and shop add|set|remove|test through genex__cli-paid. Say so rather than work around it.`,
  UseTool: (command: string, tool: GenexStudioTool) =>
    `\`genex ${command}\` is ${tool} in Studio: call that tool instead.`,
  PaidTool: (command: string) =>
    `\`genex ${command}\` spends coin or credits or changes what the project sells: call genex__cli-paid, which asks the user first.`,
  FreeTool: (command: string) => `\`genex ${command}\` spends nothing: call genex__cli.`,
  ReservedFlag: (name: string) => `--${name} is set by Studio and cannot be passed.`,
  UnknownOption: (command: string, name: string, allowed: readonly string[]) =>
    `\`genex ${command}\` takes no ${name} option here. ${allowed.length ? `It takes: ${allowed.join(", ")}.` : "It takes no options."} Name flags without dashes; a flag that names a file cannot be read in Studio.`,
  BudgetAllowance:
    "Studio does not set a Genex asset allowance: its own asset allowance and the user's consent govern asset spending. genex__cli budget shows the balance.",
  InvalidOptions: 'options must be an object of flags by name, for example {"all": true}.',
  InvalidValue: (name: string, rule: string) => `${name} ${rule}.`,
  NoPositional: (command: string) => `\`genex ${command}\` takes no positional argument; leave args out.`,
  NeedsPositional: (command: string) => `\`genex ${command}\` needs its positional argument in args.`,
  NeedsOption: (command: string, name: string) => `\`genex ${command}\` needs the ${name} option.`,
  Locked: "Genex is locked: ask the user to unlock Genex in Studio's Plugins page, then try again.",
  NoDraft:
    'This project has no hosted Genex project yet. Publish a draft first with genex__publish {"operation":"draft"}, then run the command again.',
  TimedOut: (command: string, seconds: number) =>
    `\`genex ${command}\` did not finish within ${seconds} seconds and was stopped. Check with genex__cli before repeating anything that spends.`,
  Stopped: (command: string) => `\`genex ${command}\` was stopped before it finished.`,
  UnknownPackage: (name: string, allowed: readonly string[]) =>
    `${name} is not a package genex__package adds. It adds: ${allowed.join(", ")}.`,
  NoPackageJson:
    "This project has no package.json (it uses Studio's template and its /vendor/ import maps), so it cannot add Genex packages. Multiplayer needs a project with its own build.",
  ForeignFolder:
    "This call is not bound to the project's own folder or one of its Studio worktrees; nothing was installed.",
} as const;

/** How each value rule reads in a refusal. */
export const GENEX_VALUE_RULE = {
  Flag: "is a flag: pass true, or leave it out",
  Toggle: "takes true or false",
  WholeNumber: (min: number, max: number) =>
    max === Number.MAX_SAFE_INTEGER
      ? `takes a whole number, ${min} or more`
      : `takes a whole number from ${min} to ${max}`,
  Choice: (values: readonly string[]) => `takes one of ${values.join(", ")}`,
  Text: (max: number) =>
    `takes text of at most ${max} characters, with no line breaks or control characters, not starting with -`,
} as const;
