/**
 * The director's tools as its engine sees them: their names (`DirectorTool`), their schemas
 * (`DIRECTOR_TOOLS`, flat string properties — both bridges), and the registry the studio's
 * `director_tool` dispatch forwards a call through to the live session's handler (tools.ts).
 */
import { FACET_POLICY } from "../facet-loop.ts";
import { KIND_NAMES } from "../kinds.ts";
import { CHECK_KINDS, MAX_DONE, MAX_MILESTONES, renderCheckGrammar } from "../spec.ts";
import { MAX_PLAN_WORKERS, MAX_WAIT_S } from "./budgets.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { LiveToolSpec } from "../../types/host-api.d.ts";

/**
 * Every call a director's session makes, by the name its engine sends. The studio forwards them
 * as they are, and the feed and the tests read them: never rename a value.
 */
export const DirectorTool = {
  RunStatus: "run_status",
  Plan: "plan",
  GoalUpdate: "goal_update",
  WorkerStart: "worker_start",
  WorkerStatus: "worker_status",
  WorkerSteer: "worker_steer",
  WorkerStop: "worker_stop",
  Wait: "wait",
  Judge: "judge",
  Playtest: "playtest",
  Integrate: "integrate",
  Show: "show",
  Note: "note",
  Finish: "finish",
  /** Not a director tool: the studio asking where a target lives (it is in no schema below). */
  ResolveRoot: "resolve_root",
} as const;
export type DirectorTool = (typeof DirectorTool)[keyof typeof DirectorTool];

/** The run tools, as the studio's engines see them (flat string properties — both bridges). */
export const DIRECTOR_TOOLS: LiveToolSpec[] = [
  {
    name: DirectorTool.GoalUpdate,
    description:
      "Record an external blocker or the one concrete replan after two unsuccessful attempts. Cannot mark a goal passed; only playtest goal=<id> can do that. Required goal ids and acceptance are frozen by the first plan.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Initial required goal id from run_status." },
        blocker: {
          type: "string",
          description: "approval_required, network_unavailable, or hosted_verification_unavailable.",
        },
        replan: {
          type: "string",
          description: "A materially different approach after two attempts; one replan per unresolved gap.",
        },
      },
      required: ["goal"],
    },
  },
  {
    name: DirectorTool.RunStatus,
    description:
      "Run status: time, integration branch, worker progress and budgets, pool slots, free memory, loop thresholds and user guidance. Read when the wake snapshot is stale or incomplete. Boards show the first failing and unmeasured checks; worker_status returns the whole board.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: DirectorTool.Plan,
    description:
      "Post the plan in the user's chat before worker_start: purpose, worker parts and ids, fork point and risks. Workers refuse without a plan. If the user requested review, the first worker waits for their word before building. Call again when the plan changes.",
    parameters: {
      type: "object",
      properties: {
        scope_instruction: {
          type: "string",
          description:
            "Only for a user-requested scope change: quote the new user steer exactly. Routine replans leave initial acceptance unchanged.",
        },
        summary: {
          type: "string",
          description:
            "What this run is for, in two or three sentences someone who has never seen a terminal would understand.",
        },
        workers: {
          type: "string",
          description: `JSON array of the parts you mean to hand out, 1–${MAX_PLAN_WORKERS}: [{"id":"plaza-lighting","title":"Plaza lighting","seam":"the plaza's light and sky — nothing else touches it","owns":"src/plaza.js, src/sky.js","done":["the plaza reads as dusk from every camera"],"minutes":45}]. Set multiplayer:true on each outcome requiring Genex online play; its host prerequisites are checked before delegation. Use the same id in worker_start; a part you drop or add later is a new plan.`,
        },
        base: {
          type: "string",
          description:
            "What every worker forks from, in a sentence — the starting point the studio built, the branch as it stands, what you fixed first.",
        },
        risks: {
          type: "string",
          description: "What could go wrong in this run and what you will do about it — one per line, or a JSON array.",
        },
        kind: {
          type: "string",
          description: `What kind of project this is, one of: ${KIND_NAMES.join(", ")}. The harness drives that kind's controls before every judgement and puts only the checks it can pass on the board; declare nothing and it assumes nothing.`,
        },
        play_script: {
          type: "string",
          description:
            'The controls the harness drives before every judgement, when the kind\'s own script is wrong for this project: JSON array of [{"type":"hold","keys":["w"],"ms":800},{"type":"look","dx":56,"dy":-8},{"type":"click","x":480,"y":300},{"type":"drag","fromX":100,"fromY":100,"x":300,"y":200}].',
        },
      },
      required: ["summary", "workers"],
    },
  },
  {
    name: DirectorTool.WorkerStart,
    description:
      "Start a background builder with its own git worktree and hidden preview. loop (default): build, gather evidence, check, compare blindly, accept or roll back; repeat until done passes or budget ends, committing accepted builds. Supply 2–4 measurable done outcomes. single: one session, committed without a judge; you assess it. Returns a worker id — use wait and worker_status. One area a player can name per worker, on files of its own; start every independent area, up to the workers run_status allows at once.",
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description:
            "The initial required goal this worker advances; defaults to its id. Renaming a worker never resets attempts.",
        },
        id: {
          type: "string",
          description: "A slug (letters, digits, dashes) unique in this run, e.g. plaza-lighting.",
        },
        title: { type: "string", description: "A short title for the feed." },
        brief: {
          type: "string",
          description:
            "The brief — what to build, where it is in the code, what done looks like, what not to touch. Everything the builder needs; it does not see your conversation.",
        },
        mode: {
          type: "string",
          description: "loop (judged iterations, default) or single (one session, your judgement).",
        },
        minutes: {
          type: "string",
          description: "Its time budget in minutes (default 45; capped at what the run has left).",
        },
        iterations: {
          type: "string",
          description: "loop only: the most iterations it may run (default from minutes).",
        },
        owns: {
          type: "string",
          description:
            'Comma-separated files, folders or globs this worker owns — its seam (src/plaza.js, src/world/, "src/ui/*.tsx", "app/**/hud.*"). In a glob * and ? stop at a slash and ** crosses them; a pattern containing * or ? must be QUOTED, because on Codex this arrives as a shell command line and an unquoted glob is expanded before the studio sees it. Edits elsewhere are reverted by the reviewer; empty means src/ on the studio\'s template, and everything but the entry, the contract and index.html in a project of its own — name a seam whenever more than one worker runs.',
        },
        owns_main: {
          type: "string",
          description:
            "yes|no — may it edit the entry module beyond the FACET WIRING block (default: yes when it is the only worker, else no).",
        },
        cameras: {
          type: "string",
          description: "Comma-separated registered camera names its evidence is taken from (default: default).",
        },
        done: {
          type: "string",
          description: `loop only: JSON array of 2–${MAX_DONE} measurable {"what","check"} outcomes: [{"what":"a car keeps its speed after hitting a bin","check":{"id":"props-dont-stop-cars","kind":"probe","demo":"prop-run","expr":"state.contact.speedKept >= 0.7"}}]. Identity checks must pass with judge agreement to finish. Write before the brief. Same grammar as checks.`,
        },
        checks: {
          type: "string",
          // One grammar, rendered from spec.ts (M4.8a): the planner skill, the planner's
          // fallback and this schema had each grown a copy, and the three had stopped agreeing
          // about which helpers exist. `helpers: false` is the tool-schema voice — every
          // session pays for this description on every turn.
          description: [
            `loop only: JSON array of the other typed checks, scored every iteration next to done. Each is {"id":"kebab","kind":\u2026} plus its kind's fields; "hard":true marks one that needs a technique spike. The grammar:`,
            renderCheckGrammar({ kinds: CHECK_KINDS, indent: "  ", helpers: false }),
            `Every check is dry-run against the state the fork point reports before the worker starts; ones that cannot be read there come back as unsatisfiable, with the paths that do exist.`,
          ].join("\n"),
        },
        move: {
          type: "string",
          description:
            "loop only: the ONE structural change this worker builds first, in a sentence — what the project IS afterwards. The harness hands it to the builder as THE MOVE of the iteration and a build without it loses. Give it, or the harness's own planner will invent one.",
        },
        milestones: {
          type: "string",
          description: `loop only: JSON array of 2–${MAX_MILESTONES} ORDERED structural steps after the move, each a transformation of the area (a system, a layer of depth, a reworked feel) that one accepted round builds — never a list of small fixes: [{"what":"herons wade and the reeds sway","check":{"kind":"scene","js":"count('heron') >= 3"}}] ("check" optional). The worker climbs one rung per accepted build; a rung the judge finds already built climbs by itself. While you own the ladder the harness never names a move of its own; when it is climbed the worker builds its reviewer's big move until you add a rung with worker_steer move=.`,
        },
        identity: {
          type: "string",
          description:
            "Comma-separated identity features (what must be visibly true when it is done); a check that names one is scored as identity too. Prefer done.",
        },
        setup: {
          type: "string",
          description:
            'JSON: the state its window and its judges open on — {"actions":[{"type":"tap","keys":["i"]},{"type":"click","x":480,"y":300,"px":true}],"verify":{"path":"maps.activeId","equals":"macba"},"note":"…"} or {"demo":"name","verify":{…}}. Default: the run\'s setup.',
        },
        kind: {
          type: "string",
          description: `What kind of project this part is, when it differs from the run's: ${KIND_NAMES.join(", ")}. Default: the kind the plan declared.`,
        },
        critic: {
          type: "string",
          description:
            "Which critic reviews this part every round: screen for software a person reads and operates (is it readable, does it say the project's state, does every action answer on screen), place for a world a person moves through. Default: the kind's.",
        },
        traits: {
          type: "string",
          description:
            "Comma-separated project traits the harness adds its own checks for: ui, navigation, typing, mouseLook, keyboardMove. Only what you name is added — an unnamed trait is not declared false, it is simply not measured.",
        },
        policy: {
          type: "string",
          description: `loop only: JSON object setting this worker's loop thresholds — ${Object.keys(FACET_POLICY).join(", ")}. What you leave out keeps the harness's own value; run_status reports those.`,
        },
        from: {
          type: "string",
          description:
            "What to fork from: integration (default: the integration branch HEAD), a worker id (its last commit), or a commit hash. The studio looks at it once per commit before the worker starts and refuses a fork point that does not run.",
        },
        replaces: {
          type: "string",
          description: "Id of the worker you are restarting, so Builds groups its rounds into one part.",
        },
      },
      required: ["id", "brief"],
    },
  },
  {
    name: DirectorTool.WorkerStatus,
    description:
      "Full worker scoreboard, iterations, attempts, last commit, notes, phase and current gap. Omit id for all workers.",
    parameters: { type: "object", properties: { id: { type: "string", description: "The worker id; omit for all." } } },
  },
  {
    name: DirectorTool.WorkerSteer,
    description:
      "Hand a running worker an instruction (a correction, a priority, something you saw) and/or the next structural move it must build. By default a loop worker reads it at the top of its next round, which can be twenty minutes away; now=yes interrupts its build turn and it carries on with your instruction in front of everything — use that whenever waiting would waste the round. A single session is always steered now: it has no round boundary to wait for.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        text: { type: "string", description: "The instruction, with enough context for a builder." },
        now: {
          type: "string",
          description:
            "yes to interrupt the build turn and hand it over immediately (it keeps everything it has read and written); default no — at the top of its next round.",
        },
        move: {
          type: "string",
          description:
            "The next rung of its ladder, in a sentence — what the project IS after this iteration. It becomes THE MOVE of the worker's next iteration (mandatory), ahead of the rest of its ladder and of anything the harness would have named.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: DirectorTool.WorkerStop,
    description:
      "Stop a worker now. Whatever it had already written is committed in its worktree (nothing is rolled back), the round it was in is recorded as stopped rather than judged, and its last accepted commit stays where integrate can find it.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        why: {
          type: "string",
          description:
            'Why you are stopping it, in one line — the owner reads this instead of "at the user\'s request".',
        },
      },
      required: ["id"],
    },
  },
  {
    name: DirectorTool.Wait,
    description: `Wait for worker completion, an accepted iteration, new inspection evidence, user guidance or timeout (default 60 seconds, maximum ${MAX_WAIT_S}). Returns worker progress, touched files, contract violations, inspection and integration status. Use instead of polling; call again to wait longer.`,
    parameters: {
      type: "object",
      properties: {
        seconds: { type: "string", description: `1–${MAX_WAIT_S}` },
        worker: { type: "string", description: "Only wake for this worker (still wakes for the user)." },
      },
    },
  },
  {
    name: DirectorTool.Judge,
    description:
      "Load a build, replay setup with seeded controls for thirty simulated seconds, capture cameras and player eyes, state and console. Optionally score typed checks, ask a vision question or compare blindly with another build. Returns frame paths; read them to inspect the evidence.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "integration (default), live, or a worker id." },
        against: {
          type: "string",
          description:
            "start (the project as the run began, default), none, integration, live, or a worker id — the other side of the blind comparison.",
        },
        cameras: { type: "string", description: "Comma-separated camera names (default: every registered camera)." },
        checks: {
          type: "string",
          description: "JSON array of typed checks to score on this build — the same grammar as worker_start's checks.",
        },
        question: {
          type: "string",
          description: "One yes/no question for the vision judge about the default (or first listed) camera.",
        },
      },
    },
  },
  {
    name: DirectorTool.Playtest,
    description:
      "Send a playtester into a build with one question (can you reach X, does Y work, is Z fun). It plays with the computer tool for a few minutes and answers yes/no with a report. Costs minutes; use it for what only play can tell.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "integration (default), live, or a worker id." },
        goal: {
          type: "string",
          description:
            "Required goal to verify on integration. Uses its frozen acceptance scenarios, not the caller's question; unavailable hosted prerequisites must be reported as blocked.",
        },
        scenario: {
          type: "string",
          description:
            "Optional zero-based acceptance scenario to verify; only independently passed scenarios reset no-progress attempts.",
        },
        ask: { type: "string", description: "One yes/no question (ignored when goal is supplied)." },
        minutes: { type: "string", description: "2–8, default 5." },
      },
      required: [],
    },
  },
  {
    name: DirectorTool.Integrate,
    description:
      "Merge a worker's last accepted commit into the integration branch (your worktree), union-merging the FACET WIRING block. A conflict elsewhere is left for you: the merge is aborted and the files listed — resolve it yourself with git in your worktree, then commit. After a clean merge the studio loads the integrated build and reports whether it runs (a health pass, not a verdict).",
    parameters: {
      type: "object",
      properties: { worker: { type: "string", description: "The worker id." } },
      required: ["worker"],
    },
  },
  {
    name: DirectorTool.Show,
    description:
      "Offer a build to Live, the project view the user is looking at: integration (default), live, or a worker id. Live never changes under the user: its Reload button lights up and plays the build when they press it. Nothing is changed on disk.",
    parameters: { type: "object", properties: { target: { type: "string" } } },
  },
  {
    name: DirectorTool.Note,
    description:
      "Leave a decision card in the run's feed — what you decided and why, what you verified, what you are giving up on. The user reads these; write them at every turn of the run.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The card, in your own words — shas, worker ids and file paths are fine here.",
        },
        plain: {
          type: "string",
          description:
            "The same thing in one sentence for someone who has never seen a terminal: no shas, no ids, no branch names, no error text. This is what the chat shows.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: DirectorTool.Finish,
    description:
      "Close the run: stop any workers, land the integration branch in the live project folder (land=yes, the default, when it is healthy) or keep it unlanded (land=no), write the report. victory=yes only when you verified the goal was met. Call it before your deadline; an unfinished run lands nothing.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "What was built, what was verified, what remains — the user's report.",
        },
        land: { type: "string", description: "yes (default) or no." },
        victory: { type: "string", description: "yes or no (default)." },
        user_asked: {
          type: "string",
          description:
            "A timed build with working time left: the user's words asking to stop or finish now, quoted exactly from their message to this run.",
        },
      },
      required: ["summary"],
    },
  },
];

/** runId → the tool handler of the live director session (the dispatch `director_tool` lands here). */
export const directors = new Map<string, (name: string, args: AnyRecord) => Promise<unknown>>();

/** The studio forwards a director's tool call; a run without a director answers with a sentence. */
export async function directorTool({
  runId,
  name,
  args,
}: {
  runId: string;
  name: unknown;
  args: unknown;
}): Promise<unknown> {
  const handler = directors.get(runId);
  if (!handler) return `no director session for run ${runId} — the run is not active in this harness`;
  return handler(String(name ?? ""), args && typeof args === "object" ? (args as AnyRecord) : {});
}

/**
 * Does this tool start at the integration worktree's real HEAD? (M4.10.)
 *
 * It used to be a set of eight names, and the five outside it — plan, worker_status,
 * worker_steer, worker_stop and note — are exactly the calls a director makes right after
 * committing by hand: it commits, writes a note about it, and the studio still believes the
 * head is where the last integrate left it. `syncHead` returns early when nothing moved, so
 * the honest rule is the cheap one: every tool the director has. `resolve_root` is not a
 * director tool at all — it is the studio asking where a target lives — and answering it must
 * not touch git.
 */
export function headSynced(name: unknown): boolean {
  return String(name ?? "") !== DirectorTool.ResolveRoot;
}
