/**
 * The one token instrument (Rule 13): the transcripts the CLIs wrote into the run's eval-owned
 * homes, read with the transcript census's own readers (`scripts/transcript-census.ts`) for each
 * session's identity, working folder and role, and deduplicated by message or response id for
 * the per-call timeline. Homes are injected, never `~`: only sessions whose working folder is
 * inside the run's roots and that started inside the run's window are counted, plus, for a Genex
 * lane only, the scratch folders the studio names (`studio-judge-*`, `studio-playtest-*`) whose
 * session started between that run's prompt and its end. Those folders are shared by every run in
 * the home, so a raw lane never counts one and no slack widens their window.
 *
 * Roles: the lead (the raw lane's main session, the Genex chat, a director), workers
 * (`worker:*`), judges (`judge:*`, the playtester), sub-agents (Claude side chains and Codex
 * rollouts chained by `parent_thread_id`) and auxiliary sessions (the intake, the replanner,
 * SkillOpt, the ledger's lessons). Codex judges run `--ephemeral` and write no rollout: their only
 * record is the event log's `completion_call`, which the observer adds beside these (M4.5);
 * `criticSessions` tells it whether a Claude critic's own session is already here.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineId } from "../../../src/shared/providers.ts";
import { isInside } from "../../../src/substrate/paths.ts";
import { sha256File } from "../ledger/hash.ts";
import {
  ownedByStudio,
  readClaudeSession,
  readCodexSession,
  type Homes,
  type Role,
  type Session,
} from "../../transcript-census.ts";
import { claudeUsage } from "./claude-stream.ts";
import { readRolloutFiles, type RolloutReading } from "./codex-subagents.ts";
import { epochMs, parseObject, recordField, stringField, type TraceReading } from "./honesty.ts";
import type { CompactionEvent, ModelCallEvent, ObservationEvent, SessionRef } from "./observation.ts";
import { maxUsage, promptTokens } from "./usage.ts";
import { ObservationEventKind, ObservationSource, ServedModelRole } from "../vocabulary.ts";

/** How deep below `projects/` Claude transcripts are looked for (`<slug>/<session>/subagents/` is three). */
const MAX_PROJECT_DEPTH = 4;
const PROJECTS_DIR = "projects";
const SUBAGENTS_DIR = "subagents";
const SYNTHETIC_MODEL = "<synthetic>";
const Row = { Assistant: "assistant", System: "system" } as const;
const COMPACT_BOUNDARY = "compact_boundary";

/** Census roles by the served role they count under; anything unlisted is auxiliary. */
const WORKER_PREFIX = "worker:";
const JUDGE_PREFIX = "judge:";
const LEAD_ROLES: ReadonlySet<Role> = new Set(["other", "director"]);
const JUDGE_ROLES: ReadonlySet<Role> = new Set(["playtester"]);

/** Where to look and what belongs to the run. */
export interface TranscriptOptions {
  engine: EngineId;
  /** The engine's eval-owned home: `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. */
  home: string;
  /** The run's folders; a session counts only when its working folder is inside one. */
  roots: string[];
  /** Epoch milliseconds; a session counts only when it started inside this window. */
  window: { startMs: number; endMs: number };
  promptAtMs: number;
  /** The raw lane's main session or thread id, from the stream; null for a Genex lane. */
  leadSessionId: string | null;
  /** The temp folder studio scratch sessions (`studio-judge-*`) sit in; defaults to the OS one. */
  tmpDir?: string;
  /**
   * A Genex lane's own span (epoch ms, its prompt to its end, no slack): a studio scratch session
   * counts only when it started inside it. Absent for a raw lane, which never counts one.
   */
  scratch?: { startMs: number; endMs: number };
}

/** One counted session, by basename, role and call count; never its text. */
export interface TranscriptSession {
  file: string;
  sessionId: string | null;
  parentSessionId: string | null;
  role: ServedModelRole;
  censusRole: Role;
  model: string | null;
  calls: number;
}

/** The transcripts of one run. */
export interface TranscriptReading {
  sessions: TranscriptSession[];
  /** Model calls and compactions of every counted session, and Codex sub-agents' tool calls. */
  events: ObservationEvent[];
  servedMain: string | null;
  effortServed: string | null;
  cliVersion: string | null;
  trace: TraceReading;
  /** Sessions in the home that were left out: another folder or another time. */
  dropped: number;
  /** Counted sessions whose census role is a critic (`judge:*`), not the playtester. */
  criticSessions: number;
  /**
   * sha256 over every counted transcript's path (relative to the home) and content digest, so the
   * same transcripts digest alike wherever the home is; null when none was counted.
   */
  sha256: string | null;
}

/** The digest of the counted transcripts (`TranscriptReading.sha256`); null for none. */
async function countedDigest(home: string, files: readonly string[]): Promise<string | null> {
  if (files.length === 0) return null;
  const hash = createHash("sha256");
  const entries = files.map((file) => ({ rel: path.relative(home, file).split(path.sep).join("/"), file }));
  entries.sort((a, b) => (a.rel < b.rel ? -1 : Number(a.rel > b.rel)));
  for (const { rel, file } of entries) hash.update(`${rel}\0${await sha256File(file)}\n`);
  return hash.digest("hex");
}

/** A census role as the served role it counts under. */
export function servedRoleOf(role: Role): ServedModelRole {
  if (role.startsWith(WORKER_PREFIX)) return ServedModelRole.Worker;
  if (role.startsWith(JUDGE_PREFIX) || JUDGE_ROLES.has(role)) return ServedModelRole.Judge;
  if (LEAD_ROLES.has(role)) return ServedModelRole.Main;
  return ServedModelRole.Auxiliary;
}

async function jsonlFiles(dir: string, depth: number): Promise<string[]> {
  if (depth > MAX_PROJECT_DEPTH) return [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await jsonlFiles(full, depth + 1)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

/** Every Claude transcript under `<home>/projects`, never through a symlink or out of the home. */
export async function listClaudeTranscripts(home: string): Promise<string[]> {
  const projects = path.join(home, PROJECTS_DIR);
  const [realHome, realProjects] = await Promise.all([
    fs.promises.realpath(home).catch(() => null),
    fs.promises.realpath(projects).catch(() => null),
  ]);
  const stat = await fs.promises.lstat(projects).catch(() => null);
  if (!realHome || !realProjects || !stat?.isDirectory() || !isInside(realHome, realProjects)) return [];
  return jsonlFiles(projects, 0);
}

function censusHomes(options: TranscriptOptions): Homes {
  return {
    appDir: "",
    claudeIsolated: "",
    claudeSystem: "",
    codexIsolated: "",
    codexSystem: "",
    projectRoots: options.roots,
    tmpDir: options.tmpDir ?? os.tmpdir(),
  };
}

const startedWithin = (started: number, span: { startMs: number; endMs: number }): boolean =>
  started >= span.startMs && started <= span.endMs;

/**
 * Whether a census session belongs to the run: its folder is the run's and it started inside the
 * window, or (a Genex lane only) it is a studio scratch session started inside the run's own span.
 */
function belongsToRun(session: Session, options: TranscriptOptions): boolean {
  const started = epochMs(session.firstAt);
  const cwd = session.cwd;
  if (started === null || !cwd) return false;
  if (options.roots.some((root) => isInside(root, cwd))) return startedWithin(started, options.window);
  const scratch = options.scratch;
  if (!scratch || !ownedByStudio(cwd, censusHomes(options))) return false;
  return startedWithin(started, scratch);
}

interface ClaudeTranscript {
  calls: Map<string, ModelCallEvent>;
  compactions: CompactionEvent[];
  trace: TraceReading;
}

function claudeSessionRef(row: Record<string, unknown>, file: string, lead: SessionRef): SessionRef {
  const underSubagents = path.basename(path.dirname(file)) === SUBAGENTS_DIR;
  if (row.isSidechain !== true && !underSubagents) return lead;
  const agent = stringField(row, "agentId") ?? path.basename(file, ".jsonl");
  return { sessionId: agent, parentSessionId: stringField(row, "sessionId"), role: ServedModelRole.Subagent };
}

function readClaudeCall(read: ClaudeTranscript, row: Record<string, unknown>, ref: SessionRef, atMs: number): void {
  const message = recordField(row, "message");
  const id = stringField(message, "id");
  const model = stringField(message, "model");
  if (!id || !model || model === SYNTHETIC_MODEL) return;
  const usage = claudeUsage(recordField(message, "usage"));
  const known = read.calls.get(id);
  if (known) {
    known.usage = maxUsage(known.usage, usage);
    known.contextTokens = promptTokens(known.usage);
    return;
  }
  read.calls.set(id, {
    kind: ObservationEventKind.ModelCall,
    atMs,
    source: ObservationSource.Transcript,
    id,
    session: ref,
    model,
    usage,
    contextTokens: promptTokens(usage),
    contextWindow: null,
    effortServed: null,
    endMs: null,
    ttftMs: null,
  });
}

/** One Claude transcript's model calls (deduplicated by `message.id`, field-wise maximum) and compactions. */
export function readClaudeTranscript(
  text: string,
  file: string,
  lead: SessionRef,
  promptAtMs: number,
): ClaudeTranscript {
  const read: ClaudeTranscript = {
    calls: new Map(),
    compactions: [],
    trace: { parseFailures: 0, partialTail: false, sawTerminal: true },
  };
  const rows = text.split("\n");
  rows.forEach((line, index) => {
    if (!line.trim()) return;
    const row = parseObject(line);
    if (!row) {
      if (index === rows.length - 1) read.trace.partialTail = true;
      else read.trace.parseFailures += 1;
      return;
    }
    const atMs = (epochMs(row.timestamp) ?? promptAtMs) - promptAtMs;
    const ref = claudeSessionRef(row, file, lead);
    const type = stringField(row, "type");
    if (type === Row.Assistant) readClaudeCall(read, row, ref, atMs);
    if (type === Row.System && stringField(row, "subtype") === COMPACT_BOUNDARY)
      read.compactions.push({
        kind: ObservationEventKind.Compaction,
        atMs,
        source: ObservationSource.Transcript,
        session: ref,
      });
  });
  return read;
}

function emptyReading(): TranscriptReading {
  return {
    sessions: [],
    events: [],
    servedMain: null,
    effortServed: null,
    cliVersion: null,
    trace: { parseFailures: 0, partialTail: false, sawTerminal: true },
    dropped: 0,
    criticSessions: 0,
    sha256: null,
  };
}

function addTrace(reading: TranscriptReading, trace: TraceReading): void {
  reading.trace.parseFailures += trace.parseFailures;
  reading.trace.partialTail ||= trace.partialTail;
}

function leadRole(sessionId: string | null, census: Role, options: TranscriptOptions): ServedModelRole {
  if (options.leadSessionId !== null && sessionId === options.leadSessionId) return ServedModelRole.Main;
  return servedRoleOf(census);
}

async function readClaudeHome(options: TranscriptOptions): Promise<TranscriptReading> {
  const reading = emptyReading();
  const counted: string[] = [];
  for (const file of await listClaudeTranscripts(options.home)) {
    const census = await readClaudeSession(file);
    if (!census || !belongsToRun(census, options)) {
      reading.dropped += 1;
      continue;
    }
    const lead: SessionRef = {
      sessionId: census.id ?? "",
      parentSessionId: null,
      role: leadRole(census.id, census.role, options),
    };
    const read = readClaudeTranscript(await fs.promises.readFile(file, "utf8"), file, lead, options.promptAtMs);
    counted.push(file);
    const calls = [...read.calls.values()];
    addTrace(reading, read.trace);
    reading.events.push(...calls, ...read.compactions);
    const first = calls[0];
    reading.sessions.push({
      file: census.file,
      sessionId: census.id,
      parentSessionId: first?.session.parentSessionId ?? null,
      role: first?.session.role ?? lead.role,
      censusRole: census.role,
      model: first?.model ?? null,
      calls: calls.length,
    });
    // A side chain shares its parent's session id, so the file's lead role is no proof: only a
    // call that itself counts as the main loop names the served main model.
    const mainCall = calls.find((call) => call.session.role === ServedModelRole.Main);
    if (mainCall && reading.servedMain === null) reading.servedMain = mainCall.model;
  }
  reading.sha256 = await countedDigest(options.home, counted);
  return reading;
}

/** A rollout's calls relabelled with the lead or census role; sub-agent rollouts keep theirs. */
function relabel(rollout: RolloutReading, role: ServedModelRole): ObservationEvent[] {
  if (rollout.parentSessionId) return [...rollout.calls, ...rollout.compactions, ...rollout.tools];
  const events = [...rollout.calls, ...rollout.compactions];
  for (const event of events) event.session = { ...event.session, role };
  return events;
}

async function readCodexHome(options: TranscriptOptions): Promise<TranscriptReading> {
  const reading = emptyReading();
  const counted: string[] = [];
  for (const { path: file, rollout } of await readRolloutFiles(options.home, options.promptAtMs)) {
    const census = await readCodexSession(file);
    if (!census || !belongsToRun(census, options)) {
      reading.dropped += 1;
      continue;
    }
    counted.push(file);
    const role = rollout.parentSessionId ? ServedModelRole.Subagent : leadRole(rollout.sessionId, census.role, options);
    addTrace(reading, rollout.trace);
    reading.events.push(...relabel(rollout, role));
    reading.sessions.push({
      file: rollout.file,
      sessionId: rollout.sessionId,
      parentSessionId: rollout.parentSessionId,
      role,
      censusRole: census.role,
      model: rollout.model,
      calls: rollout.calls.length,
    });
    if (role !== ServedModelRole.Main || reading.servedMain !== null) continue;
    reading.servedMain = rollout.model;
    reading.effortServed = rollout.effort;
    reading.cliVersion = rollout.cliVersion;
  }
  reading.sha256 = await countedDigest(options.home, counted);
  return reading;
}

async function readHome(options: TranscriptOptions): Promise<TranscriptReading> {
  if (options.engine === EngineId.Codex) return readCodexHome(options);
  if (options.engine === EngineId.ClaudeCode) return readClaudeHome(options);
  return emptyReading();
}

/** One run's transcripts from its eval-owned home, by engine. */
export async function readTranscripts(options: TranscriptOptions): Promise<TranscriptReading> {
  const reading = await readHome(options);
  reading.criticSessions = reading.sessions.filter((session) => session.censusRole.startsWith(JUDGE_PREFIX)).length;
  return reading;
}
