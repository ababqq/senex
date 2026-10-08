/**
 * Share build metrics (§9.4, §20.3, M5.4): the sender behind Settings → Privacy. Off by default;
 * when the user turns it on (for the current consent version), each finished build becomes one
 * closed `genex-evals/field/1` row, queued in `<userData>/run-sharing/` and posted anonymously to
 * `<origin>/api/desktop/contributions`: no Authorization header, no cookies, never the user's
 * Genex login. A row the network lost waits at most 7 days; a row the server refused is dropped;
 * the server's 410 kill switch pauses sending (and Settings says so) until a day later. The kill
 * switch closes only the POST: Delete what I shared keeps working while it is on. A row carries
 * the hour its build finished, never the exact instant.
 *
 * Identity is a random install id, replaced every 90 days, with a secret that leaves this device
 * only as proof to the contributions server: on each row (the first secret an id arrives with owns
 * it there) and on Delete what I shared, which removes the rows of every id this install used. Developer, fixture, smoke, self-test and eval launches never open a connection
 * (`sends: false`): the switch and the preview work there, nothing is queued or sent.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DAY_MS, HOUR_MS, SECOND_MS } from "../shared/duration.ts";
import {
  CONSENT_VERSION_PATTERN,
  CONTRIBUTIONS_PATH,
  CONTRIBUTIONS_PAUSED_STATUS,
  DEFAULT_RUNS_ORIGIN,
  type FieldPlatform,
  type FieldRow,
  type FieldRunFacts,
  INSTALL_ID_PATTERN,
  INSTALL_ID_ROTATION_MS,
  INSTALL_SECRET_HEADER,
  INSTALL_SECRET_PATTERN,
  RUN_SHARING_CONSENT_VERSION,
  RUNS_ORIGIN_ENV,
  RunSharingDeleteOutcome,
  type RunSharingDeleteResult,
  type RunSharingStatus,
  UNSENT_ROW_TTL_MS,
  buildFieldRow,
  checkFieldRow,
  contributionDeletePath,
} from "../shared/run-sharing.ts";
import { UiEvent } from "../shared/ui-events.ts";
import { AsyncLock, atomicWriteText } from "../substrate/fsx.ts";

/** How long one request may take before it counts as lost. */
const SEND_TIMEOUT_MS = 20 * SECOND_MS;
/** How long the kill switch holds before the sender tries once more. */
const PAUSE_RECHECK_MS = DAY_MS;
/** How long a replaced install id is remembered, so Delete what I shared still reaches its rows (the server keeps rows 180 days). */
const RETIRED_ID_KEEP_MS = 180 * DAY_MS;
/** The most rows the queue holds; the oldest goes first. */
const QUEUE_MAX = 50;
/** Files and the folder are this user's only: the state holds the install secret. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const STATE_FILE = "state.json";
const QUEUE_FILE = "queue.json";
/** Plain http is allowed only for a self-hoster's server on this machine. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A finished build: the turn a project chat's handled message opened (by its thread and message), or
 * a run the chat launched (by its id and project).
 */
export type FinishedBuildRef = { threadId: string; messageId: string } | { runId: string; project: string };

/** What the sender needs; every clock, random source and connection is injected. */
export interface RunSharingDeps {
  /** `<userData>/run-sharing`. */
  dir: string;
  /** Where rows go (`runsOrigin`), or null when this build removed sharing. */
  origin: string | null;
  /** False in developer, fixture, smoke, self-test and eval launches: nothing is ever sent. */
  sends: boolean;
  /** Node's fetch, which keeps no cookies; never Electron's session fetch. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  app: { version: string; platform: FieldPlatform | null };
  /** The facts of a finished build, read from its events; null when it was no build. */
  readFacts(ref: FinishedBuildRef): Promise<FieldRunFacts | null>;
  now?: () => number;
  /** 32 lowercase hex characters from a secure source. */
  randomHex?: () => string;
}

/** Settings → Privacy's calls, and the two main makes when a build ends and at startup. */
export interface RunSharing {
  status(): Promise<RunSharingStatus>;
  setOn(on: boolean): Promise<RunSharingStatus>;
  /** The real next row: the queue's head, else the last finished build's row; null before any build. */
  preview(): Promise<FieldRow | null>;
  deleteShared(): Promise<RunSharingDeleteResult>;
  /** A build ended: when sharing is on, its row is queued and the queue sent. */
  buildFinished(ref: FinishedBuildRef): Promise<void>;
  /** Send what is queued (at startup, and after each build). */
  flush(): Promise<void>;
}

interface Identity {
  installId: string;
  installSecret: string;
  createdAt: number;
}
interface Retired extends Identity {
  retiredAt: number;
}
interface SharingState {
  /** The consent version the user agreed to; null when off. */
  consentVersion: string | null;
  identity: Identity | null;
  retired: Retired[];
  /** When the server last answered with the kill switch; null when not paused. */
  pausedAt: number | null;
}
interface QueuedRow {
  queuedAt: number;
  row: FieldRow;
}

const OFF: SharingState = { consentVersion: null, identity: null, retired: [], pausedAt: null };

/** How one request ended, as the queue acts on it. */
const Answer = {
  Sent: "sent",
  /** Refused as invalid (a 4xx): retrying cannot help. */
  Drop: "drop",
  /** Offline, rate-limited or a server error: try again later. */
  Keep: "keep",
  Paused: "paused",
} as const;
type Answer = (typeof Answer)[keyof typeof Answer];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isInstant = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** An identity record as stored, or null when any part of it is not one. */
function identityOf(value: unknown): Identity | null {
  if (!isRecord(value)) return null;
  const { installId, installSecret, createdAt } = value;
  const valid =
    typeof installId === "string" &&
    INSTALL_ID_PATTERN.test(installId) &&
    typeof installSecret === "string" &&
    INSTALL_SECRET_PATTERN.test(installSecret) &&
    isInstant(createdAt);
  return valid ? { installId, installSecret, createdAt } : null;
}

/** The stored state, read field by field; anything unreadable reads as off. */
function stateOf(value: unknown): SharingState {
  if (!isRecord(value)) return OFF;
  const consent = value.consentVersion;
  const retired = Array.isArray(value.retired) ? value.retired : [];
  return {
    consentVersion: typeof consent === "string" && CONSENT_VERSION_PATTERN.test(consent) ? consent : null,
    identity: identityOf(value.identity),
    retired: retired.flatMap((entry) => {
      const identity = identityOf(entry);
      return identity && isRecord(entry) && isInstant(entry.retiredAt)
        ? [{ ...identity, retiredAt: entry.retiredAt }]
        : [];
    }),
    pausedAt: isInstant(value.pausedAt) ? value.pausedAt : null,
  };
}

/** The queued rows as stored, each re-checked by the guard; a tampered row is dropped. */
function queueOf(value: unknown): QueuedRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || !isInstant(entry.queuedAt)) return [];
    const checked = checkFieldRow(entry.row);
    return checked.ok ? [{ queuedAt: entry.queuedAt, row: checked.row }] : [];
  });
}

async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** Whether sharing is on: the user agreed to the consent text this build shows. */
const agreed = (state: SharingState): boolean => state.consentVersion === RUN_SHARING_CONSENT_VERSION;

/** The state with a current identity: a new one when there is none or it is 90 days old. */
function withIdentity(state: SharingState, now: number, randomHex: () => string): SharingState {
  const current = state.identity;
  if (current && now - current.createdAt < INSTALL_ID_ROTATION_MS) return state;
  const kept = state.retired.filter((old) => now - old.retiredAt < RETIRED_ID_KEEP_MS);
  const retired = current ? [...kept, { ...current, retiredAt: now }] : kept;
  return { ...state, retired, identity: { installId: randomHex(), installSecret: randomHex(), createdAt: now } };
}

/** How the queue acts on an HTTP status. */
function answerFor(status: number): Answer {
  if (status >= 200 && status < 300) return Answer.Sent;
  if (status === CONTRIBUTIONS_PAUSED_STATUS) return Answer.Paused;
  const later = status === 429 || status >= 500;
  return later ? Answer.Keep : Answer.Drop;
}

/** The request options every call shares: no credentials of any kind, no redirects, a deadline. */
function requestInit(method: "POST" | "DELETE", headers: Record<string, string>, body?: string): RequestInit {
  return {
    method,
    headers,
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    ...(body === undefined ? {} : { body }),
  };
}

/**
 * The origin rows go to: the Genex API by default; `STUDIO_RUNS_URL` names a self-hoster's https
 * origin (plain http only on this machine), and empty removes sharing. Anything else (a path,
 * a query, credentials, another scheme) removes it too: a bad setting never sends anywhere.
 */
export function runsOrigin(env: Readonly<Record<string, string | undefined>>): string | null {
  const raw = env[RUNS_ORIGIN_ENV];
  if (raw === undefined) return DEFAULT_RUNS_ORIGIN;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const plain = !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  return plain && secure ? url.origin : null;
}

/** Every developer, smoke, self-test, acceptance and eval switch starts with this. */
const STUDIO_SWITCH_PREFIX = "--studio-";

/** How this launch started, as main knows it before the core exists. */
export interface LaunchShape {
  /** A packaged app: an unpackaged run is a developer's checkout. */
  packaged: boolean;
  argv: readonly string[];
  /** An owned `studio:dev` profile (fixture or live). */
  developerProfile: boolean;
  /** A smoke or self test with its own throwaway data folder. */
  testData: boolean;
}

/** Whether a launch may ever send: only a packaged app started normally, with no `--studio-*` switch. */
export function launchSends(launch: LaunchShape): boolean {
  const switched = launch.argv.some((arg) => arg.startsWith(STUDIO_SWITCH_PREFIX));
  const normal = !launch.developerProfile && !launch.testData && !switched;
  return launch.packaged && normal;
}

/** A non-empty string. */
const named = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * The build a UI event says ended: a handled chat message (its thread and message, so only the
 * turn that message opened is read), or a finished run.
 */
export function finishedBuildRef(event: UiEvent): FinishedBuildRef | null {
  if (event.type === UiEvent.CoordinatorHandled) {
    const { threadId, messageId } = event.payload ?? {};
    return named(threadId) && named(messageId) ? { threadId, messageId } : null;
  }
  if (event.type !== UiEvent.RunFinished) return null;
  const { runId, project } = event.payload ?? {};
  return named(runId) && named(project) ? { runId, project } : null;
}

/** The sender over its folder. */
export function createRunSharing(deps: RunSharingDeps): RunSharing {
  const sender = new Sender(deps);
  return {
    status: () => sender.locked(() => sender.status()),
    setOn: (on) => sender.locked(() => sender.setOn(on)),
    preview: () => sender.locked(() => sender.preview()),
    deleteShared: () => sender.locked(() => sender.deleteShared()),
    buildFinished: (ref) => sender.locked(() => sender.buildFinished(ref)),
    flush: () => sender.locked(() => sender.flush()),
  };
}

/** The sender's state machine; every public call runs under one lock. */
class Sender {
  readonly #deps: RunSharingDeps;
  readonly #lock = new AsyncLock();
  readonly #now: () => number;
  readonly #randomHex: () => string;
  #lastBuild: FinishedBuildRef | null = null;

  constructor(deps: RunSharingDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#randomHex = deps.randomHex ?? (() => randomBytes(16).toString("hex"));
  }

  locked<T>(fn: () => Promise<T>): Promise<T> {
    return this.#lock.run(fn);
  }

  #file(name: string): string {
    return path.join(this.#deps.dir, name);
  }

  async #state(): Promise<SharingState> {
    return stateOf(await readJsonFile(this.#file(STATE_FILE)));
  }

  async #queue(): Promise<QueuedRow[]> {
    return queueOf(await readJsonFile(this.#file(QUEUE_FILE)));
  }

  async #write(name: string, value: unknown): Promise<void> {
    await mkdir(this.#deps.dir, { recursive: true, mode: DIR_MODE });
    await atomicWriteText(this.#file(name), `${JSON.stringify(value)}\n`, { mode: FILE_MODE });
  }

  /** Whether this launch sends at all, and the user agreed. */
  #sending(state: SharingState): boolean {
    return this.#deps.sends && this.#deps.origin !== null && agreed(state);
  }

  async status(): Promise<RunSharingStatus> {
    const state = await this.#state();
    const available = this.#deps.origin !== null;
    return {
      available,
      sends: this.#deps.sends,
      on: available && agreed(state),
      paused: state.pausedAt !== null,
      queued: (await this.#queue()).length,
    };
  }

  async setOn(on: boolean): Promise<RunSharingStatus> {
    if (this.#deps.origin === null) return this.status();
    const state = await this.#state();
    await this.#write(STATE_FILE, { ...state, consentVersion: on ? RUN_SHARING_CONSENT_VERSION : null });
    if (!on) await this.#write(QUEUE_FILE, []);
    await this.flush();
    return this.status();
  }

  /** A row for `facts`, stamped with the current identity (made or rotated first, and saved). */
  async #row(facts: FieldRunFacts): Promise<FieldRow | null> {
    const platform = this.#deps.app.platform;
    if (!platform) return null;
    const before = await this.#state();
    const state = withIdentity(before, this.#now(), this.#randomHex);
    if (state !== before) await this.#write(STATE_FILE, state);
    const identity = state.identity as Identity;
    const built = buildFieldRow(facts, {
      installId: identity.installId,
      consentVersion: RUN_SHARING_CONSENT_VERSION,
      // The hour, not the instant: the exact finish time could link a row to other activity.
      recordedAt: new Date(Math.floor(this.#now() / HOUR_MS) * HOUR_MS).toISOString(),
      app: { version: this.#deps.app.version, platform },
    });
    return built.ok ? built.row : null;
  }

  async #factsOf(ref: FinishedBuildRef): Promise<FieldRunFacts | null> {
    return this.#deps.readFacts(ref).catch(() => null);
  }

  async preview(): Promise<FieldRow | null> {
    const [head] = await this.#queue();
    if (head) return head.row;
    const facts = this.#lastBuild ? await this.#factsOf(this.#lastBuild) : null;
    return facts ? this.#row(facts) : null;
  }

  async buildFinished(ref: FinishedBuildRef): Promise<void> {
    this.#lastBuild = ref;
    if (!this.#sending(await this.#state())) return;
    const facts = await this.#factsOf(ref);
    const row = facts ? await this.#row(facts) : null;
    if (!row) return;
    const queue = [...(await this.#queue()), { queuedAt: this.#now(), row }].slice(-QUEUE_MAX);
    await this.#write(QUEUE_FILE, queue);
    await this.flush();
  }

  /** One row, proven by the secret of the install that wrote it (the server owns an id by its first secret). */
  async #post(row: FieldRow, state: SharingState): Promise<Answer> {
    const owner = [state.identity, ...state.retired].find((identity) => identity?.installId === row.installId);
    // A row whose install's secret is gone can never be proven again: drop it rather than retry.
    if (!owner) return Answer.Drop;
    const url = `${this.#deps.origin}${CONTRIBUTIONS_PATH}`;
    const headers = { "content-type": "application/json", [INSTALL_SECRET_HEADER]: owner.installSecret };
    const init = requestInit("POST", headers, JSON.stringify(row));
    try {
      return answerFor((await this.#deps.fetch(url, init)).status);
    } catch {
      return Answer.Keep;
    }
  }

  async flush(): Promise<void> {
    const state = await this.#state();
    if (!this.#sending(state)) return;
    const now = this.#now();
    const queue = (await this.#queue()).filter((entry) => now - entry.queuedAt < UNSENT_ROW_TTL_MS);
    const pausedNow = state.pausedAt !== null && now - state.pausedAt < PAUSE_RECHECK_MS;
    let pausedAt = pausedNow ? state.pausedAt : null;
    let sentUpTo = 0;
    for (const entry of pausedNow ? [] : queue) {
      const answer = await this.#post(entry.row, state);
      if (answer === Answer.Paused) pausedAt = now;
      if (answer === Answer.Paused || answer === Answer.Keep) break;
      sentUpTo += 1;
    }
    await this.#write(QUEUE_FILE, queue.slice(sentUpTo));
    if (pausedAt !== state.pausedAt) await this.#write(STATE_FILE, { ...state, pausedAt });
  }

  /**
   * One install's DELETE: rows removed, or the answer that stops the whole delete. The server keeps
   * DELETE open while contributions are paused, so a 410 here is only a defensive fallback.
   */
  async #delete(identity: Identity): Promise<number | RunSharingDeleteOutcome> {
    const url = `${this.#deps.origin}${contributionDeletePath(identity.installId)}`;
    try {
      const response = await this.#deps.fetch(
        url,
        requestInit("DELETE", { [INSTALL_SECRET_HEADER]: identity.installSecret }),
      );
      if (response.status === CONTRIBUTIONS_PAUSED_STATUS) return RunSharingDeleteOutcome.Paused;
      if (response.status === 404) return 0;
      if (response.status < 200 || response.status >= 300) return RunSharingDeleteOutcome.Failed;
      const body: unknown = await response.json().catch(() => null);
      const deleted = isRecord(body) ? body.deleted : null;
      return typeof deleted === "number" && Number.isInteger(deleted) && deleted >= 0 ? deleted : 0;
    } catch {
      return RunSharingDeleteOutcome.Failed;
    }
  }

  async deleteShared(): Promise<RunSharingDeleteResult> {
    if (!this.#deps.sends || this.#deps.origin === null)
      return { outcome: RunSharingDeleteOutcome.NotSent, deleted: 0 };
    const state = await this.#state();
    const identities = [...(state.identity ? [state.identity] : []), ...state.retired];
    let deleted = 0;
    for (const identity of identities) {
      const answer = await this.#delete(identity);
      // A stop leaves every id in place, so a retry reaches them all; `deleted` counts what went first.
      // A DELETE's 410 never pauses sending: the kill switch is the POST's answer.
      if (typeof answer !== "number") return { outcome: answer, deleted };
      deleted += answer;
    }
    await this.#write(STATE_FILE, { ...state, identity: null, retired: [] });
    await this.#write(QUEUE_FILE, []);
    return { outcome: RunSharingDeleteOutcome.Deleted, deleted };
  }
}
