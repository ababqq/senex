/**
 * Where each calibration fixture comes from (§6.2): four hand-made folders under
 * `tests/fixtures/evals/calibration/`, and `template-untouched`, which is the app's own project template
 * copied at run time so it can never drift from the starter a Genex lane really begins with. Every
 * fixture is copied into a fresh work folder first, so probing and building never write into the
 * committed tree.
 */
import { cp } from "node:fs/promises";
import path from "node:path";
import { CalibrationFixture } from "../vocabulary.ts";

/** The committed fixtures folder, relative to the repository root. */
export const CALIBRATION_FIXTURES_DIR = "tests/fixtures/evals/calibration";
/** The project template `template-untouched` is copied from, relative to the repository root. */
export const PROJECT_TEMPLATE_DIR = "src/project-template";

/** Folders never copied into a work folder. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git"]);

/** Where the fixtures are read from and copied to. */
export interface FixtureSources {
  fixturesDir: string;
  templateDir: string;
  /** A fresh folder of the calibration's own; each fixture lands in `<workDir>/<fixture>`. */
  workDir: string;
}

/** Every fixture, in the order calibration runs them. */
export const CALIBRATION_ORDER: readonly CalibrationFixture[] = Object.values(CalibrationFixture);

/** The folder a fixture is copied from. */
export function fixtureSource(fixture: CalibrationFixture, sources: FixtureSources): string {
  if (fixture === CalibrationFixture.TemplateUntouched) return sources.templateDir;
  return path.join(sources.fixturesDir, fixture);
}

/** Copy one fixture into its own work folder and return that folder; an existing copy is refused. */
export async function materializeFixture(fixture: CalibrationFixture, sources: FixtureSources): Promise<string> {
  const target = path.join(sources.workDir, fixture);
  await cp(fixtureSource(fixture, sources), target, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (source) => !SKIPPED_DIRS.has(path.basename(source)),
  });
  return target;
}
