/**
 * The command-line switches a launch reads, and the one parser for them. The smoke, self test and
 * acceptance runners and the developer launch are chosen by these; a normal launch has none.
 * Kept apart from `launch-context.ts`, which main imports only for a developer launch because it
 * reads the checkout's `scripts/studio-dev` files.
 */
import { StudioPlatform } from "../../shared/boot.ts";

/** Every switch main and its runners read. Values are the argv spelling runners pass: never rename one. */
export const StudioFlag = {
  /** Boot the real app, report whether it came up clean, quit. */
  Smoke: "--studio-smoke",
  /** Enable bounded performance diagnostics without developer control. */
  Diagnostics: "--studio-diagnostics",
  /** The in-app end-to-end self test. */
  SelfTest: "--studio-selftest",
  /** Any developer switch; a developer launch also carries {@link StudioFlag.DevLaunch}. */
  Dev: "--studio-dev",
  /** `=<launch.json>`: the owned developer profile to launch into. */
  DevLaunch: "--studio-dev-launch",
  BuildSmoke: "--studio-build-smoke",
  /** `=<png>`: where the build smoke saves its screenshots. */
  BuildShot: "--studio-build-shot",
  ComputerSmoke: "--studio-computer-smoke",
  /** `=<png>`: where the computer smoke saves its screenshot. */
  ComputerShot: "--studio-computer-shot",
  TerminalSmoke: "--studio-terminal-smoke",
  /** `=<png>`: where the smoke saves the sign-in screenshot. */
  LoginShot: "--studio-login-shot",
  /** `=<png>`: a PNG of the smoke window when it finishes. */
  Shot: "--studio-shot",
  /** `=<dir>`: the asset previews the smoke opens. */
  AssetsSmokeDir: "--studio-assets-smoke-dir",
  /** `=<root>`: the live provider acceptance's disposable root. */
  ProviderAcceptance: "--studio-provider-acceptance",
  /** `=<root>`: the local Bonsai acceptance's disposable root. */
  BonsaiAcceptance: "--studio-bonsai-acceptance",
  /** `=<spec.json>`: run one eval lane (`smoke/eval-lane.ts`); a smoke launch only. */
  EvalLane: "--studio-eval-lane",
  /** The eval lane runs on the scripted fixture engines instead of real providers. */
  EvalFixture: "--studio-eval-fixture",
  /** `=<model>`: the Bonsai model the acceptance pulls. */
  BonsaiModel: "--bonsai-model",
  /** `=<url>`: the Ollama the engines and the smoke talk to. */
  OllamaHost: "--ollama-host",
  /** `=<dir>`: the test run's data folder instead of a fresh temporary one. */
  UserData: "--userdata",
  /** Keep the self test's temporary data folder. */
  KeepUserData: "--keep-userdata",
  /** Show the self test's window. */
  Show: "--show",
} as const;
export type StudioFlag = (typeof StudioFlag)[keyof typeof StudioFlag];

/** `--studio-expected-<engine>=<status>`: the connection status the smoke expects for one engine. */
export type ExpectedStatusFlag = `--studio-expected-${string}`;

/** The switch that names the status the smoke expects for `engine`. */
export function expectedStatusFlag(engine: string): ExpectedStatusFlag {
  return `--studio-expected-${engine}`;
}

/** A Chromium command-line switch and its value, as `app.commandLine.appendSwitch` takes them. */
export type ChromiumSwitch = readonly [name: string, value: string];

/**
 * Switches a test launch needs before the app is ready. The self test and the smoke park a shown
 * window off the visible desktop; Windows' native occlusion tracking would call it hidden and stop
 * requestAnimationFrame, freezing the project under test. A normal launch never changes Chromium.
 */
export function testLaunchChromiumSwitches(launch: {
  platform: NodeJS.Platform;
  testLaunch: boolean;
}): ChromiumSwitch[] {
  if (!launch.testLaunch || launch.platform !== StudioPlatform.Windows) return [];
  return [["disable-features", "CalculateNativeWinOcclusion"]];
}

/**
 * Does closing the last window quit? Off macOS it does, except in a test launch: the self test
 * closes its window before it prints its report, and its runner decides when the app exits.
 */
export function quitsWhenLastWindowCloses(launch: { platform: NodeJS.Platform; testLaunch: boolean }): boolean {
  return launch.platform !== StudioPlatform.Mac && !launch.testLaunch;
}

/** Is the bare switch on the command line? */
export function hasFlag(flag: StudioFlag, argv: readonly string[] = process.argv): boolean {
  return argv.includes(flag);
}

/** The value of `flag=value` on the command line, or undefined when the switch is absent. */
export function flagValue(flag: StudioFlag | ExpectedStatusFlag, argv: readonly string[] = process.argv) {
  return argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
}
