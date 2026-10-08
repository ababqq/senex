/**
 * The `notifications` fixture: a library of projects that will each have something to say, and the
 * news that arrives once the window is up — builds that land, fail and pause, a sign-in, a
 * plugin's question, a plan waiting for a go and an interview question.
 */
import { ALL_COVER_LOOKS } from "../../shared/cover-recipe.ts";
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import { EventKind, type EventData } from "../../shared/event-log.ts";
import { EngineId } from "../../shared/providers.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import type { StudioCore } from "../studio-core.ts";
import { FIXTURE_MODEL, fixtureRun } from "./fixture-kit.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { ExecutionStatus } from "../../shared/run-state.ts";

/** Why the notifications fixture cannot be seeded. */
const MESSAGE = {
  missingProject: "fixture project notify-orbit is missing",
} as const;

/** One piece of news every half second. */
const ARRIVAL_GAP_MS = 500;
/** News starts after the window has read its first feed, so it arrives as news. */
export const NOTIFICATIONS_START_MS = 4000;

const NOTIFY_PROJECTS = [
  ["notify-lunar", "Lunar garden"],
  ["notify-neon", "Neon drift"],
  ["notify-orbit", "Orbit racer"],
  ["notify-desert", "Desert kingdom"],
  ["notify-snow", "Snowbound temple"],
  ["notify-glass", "Glass cathedral"],
] as const;

/** A library whose projects will each have something to say; one build already ended before launch. */
export async function seedNotificationProjects(core: StudioCore): Promise<void> {
  for (const [n, [name, title]] of NOTIFY_PROJECTS.entries()) {
    await core.projects.scaffold(name, { title });
    await core.threadForProject(name);
    const look = ALL_COVER_LOOKS[(n * 7) % ALL_COVER_LOOKS.length];
    if (!look) continue;
    await core.projects.update(name, {
      cover: { kind: "recipe", ...look, seed: (n * 131) % 997, placeholder: true },
    });
  }
  const snow = await core.threadForProject("notify-snow");
  await core.append(
    finishedBuild("notify-snow", "Snow on the temple steps", {
      landed: true,
      executionStatus: ExecutionStatus.Completed,
      summary: "Snow settles on the temple steps.",
    }),
    snow,
  );
}

/** A build of one notify project, started and finished with `outcome`. */
function finishedBuild(project: string, goal: string, outcome: Record<string, unknown>): EventData[] {
  const run = fixtureRun({ runId: `fixture-${project}`, project });
  return [run(CustomEvent.RunStarted, { goal }), run(CustomEvent.RunFinished, outcome)];
}

/** The news, one piece at a time. */
export async function notificationArrivals(core: StudioCore): Promise<void> {
  const orbit = await core.threadForProject("notify-orbit");
  await say(
    core,
    orbit,
    finishedBuild("notify-orbit", "Tighter drifting", {
      landed: true,
      executionStatus: ExecutionStatus.Completed,
      summary: "Drifting holds the racing line.",
    }),
  );
  const desert = await core.threadForProject("notify-desert");
  await say(
    core,
    desert,
    finishedBuild("notify-desert", "A market in the dunes", {
      executionStatus: ExecutionStatus.Failed,
      failure: { message: "The project stopped responding while it loaded the market." },
    }),
  );
  const glass = await core.threadForProject("notify-glass");
  await say(core, glass, [
    ...finishedBuild("notify-glass", "Stained glass light", {
      landed: false,
      executionStatus: ExecutionStatus.Paused,
      stoppedBecause: "usage limit reached",
    }),
    fixtureRun({ runId: "fixture-notify-glass", project: "notify-glass" })(CustomEvent.AutopilotPaused),
  ]);
  await say(core, glass, [
    customEventData(CustomEvent.NeedsSignin, { engine: EngineId.ClaudeCode, message: "fixture: signed out" }),
  ]);
  await askToUseTrackTexture(core, orbit);
  await step();
  await planWaitingForGo(core);
  await interviewQuestion(core);
}

async function say(core: StudioCore, threadId: string, events: EventData[]): Promise<void> {
  await core.append(events, threadId);
  core.emit(UiEvent.ChatMessage, { threadId });
  await step();
}

function step(): Promise<unknown> {
  return sleep(ARRIVAL_GAP_MS);
}

/** A plugin asks before it changes the project; the real consent ledger holds it until answered. */
async function askToUseTrackTexture(core: StudioCore, orbit: string): Promise<void> {
  const project = (await core.projects.list()).find((candidate) => candidate.name === "notify-orbit");
  if (!project) throw new Error(MESSAGE.missingProject);
  void core
    .requestConsent(
      "Image studio",
      {
        name: "save_texture",
        description: "Save the generated texture",
        parameters: { type: "object", properties: {} },
        confirmation: "Use the new track texture in Orbit racer?",
      },
      { file: "assets/track-texture.png" },
      { project: "notify-orbit", directory: project.dir, threadId: orbit },
    )
    .catch(() => {});
}

async function planWaitingForGo(core: StudioCore): Promise<void> {
  const neon = await core.threadForProject("notify-neon");
  const review = {
    id: "fixture-notify-plan",
    state: "waiting" as const,
    text: "Make the city streets rain-soaked",
    plan: "1. Wet asphalt with neon reflections.\n2. Light rain that thickens at night.\n3. Puddles the car splashes through.",
    options: { thread: neon, engine: EngineId.Codex, model: FIXTURE_MODEL, reviewPlan: true },
  };
  await core.store.updateThread(neon, { metadata: { planReview: review } });
  const { options: _options, ...reviewPayload } = review;
  await say(core, neon, [customEventData(CustomEvent.PlanReview, { ...reviewPayload, project: "notify-neon" })]);
}

async function interviewQuestion(core: StudioCore): Promise<void> {
  const lunar = await core.threadForProject("notify-lunar");
  await say(core, lunar, [
    { type: EventKind.Messages, messages: [{ role: "user", content: "Make the garden feel magical at night." }] },
    customEventData(CustomEvent.InterviewQuestion, {
      project: "notify-lunar",
      question: "Should the flowers glow on their own, or only where moonlight touches them?",
      choices: [
        { id: "glow", label: "Glow on their own" },
        { id: "moon", label: "Only in moonlight" },
      ],
    }),
  ]);
}
