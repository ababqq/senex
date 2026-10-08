/**
 * Plugin consent ledger — the wait between an agent asking to run a confirmed plugin tool and the
 * user's answer in the chat. Pure and timer-based: it holds pending questions in memory, settles
 * each one exactly once (the user's click, the timeout, the turn's abort signal, or a Stop that
 * withdraws every question in its scope) and never touches disk or the event log. Studio core
 * records the question and its answer around it. A build's lead's question outlives the chat's
 * turns (`outlivesTurn`), as its tool permission cards do (tool-permissions.ts).
 */
import type { PluginConsentBy } from "../shared/plugins.ts";

export interface PluginConsentRequest {
  consentId: string;
  pluginId: string;
  /** The namespaced tool name (`<plugin>__<tool>`). */
  tool: string;
  project: string;
  threadId?: string;
  /** The turn's abort: an aborted turn withdraws its question (`by: 'stop'`). */
  signal?: AbortSignal;
  /**
   * A build's lead's question: no turn of the chat's ending withdraws it (`cancel` with
   * `by: 'turn'`); its own session's end, a Stop, the answer or the timeout do.
   */
  outlivesTurn?: boolean;
}

export interface PluginConsentPending {
  consentId: string;
  pluginId: string;
  tool: string;
  project: string;
  threadId?: string;
  /** Epoch ms after which the question is declined on the user's behalf. */
  expiresAt: number;
}

export interface PluginConsentResult {
  approved: boolean;
  by: PluginConsentBy;
}

export interface PluginConsentOptions {
  /** How long a question waits for an answer before it is declined (`by: 'timeout'`). */
  timeoutMs: number;
  /** Clock seam for `expiresAt`; the wait itself uses real timers. */
  now?: () => number;
}

type Waiting = { entry: PluginConsentPending; outlivesTurn: boolean; settle: (result: PluginConsentResult) => void };

export class PluginConsent {
  readonly #timeoutMs: number;
  readonly #now: () => number;
  #waiting = new Map<string, Waiting>();

  constructor(options: PluginConsentOptions) {
    this.#timeoutMs = options.timeoutMs;
    this.#now = options.now ?? Date.now;
  }

  /** Ask, and wait for whichever comes first: the user's answer, the timeout, the turn's abort, or a Stop. */
  request(request: PluginConsentRequest): Promise<PluginConsentResult> {
    if (this.#waiting.has(request.consentId)) return Promise.reject(new Error("Consent request already pending"));
    if (request.signal?.aborted) return Promise.resolve({ approved: false, by: "stop" });
    return new Promise<PluginConsentResult>((resolve) => {
      const entry: PluginConsentPending = {
        consentId: request.consentId,
        pluginId: request.pluginId,
        tool: request.tool,
        project: request.project,
        ...(request.threadId !== undefined ? { threadId: request.threadId } : {}),
        expiresAt: this.#now() + this.#timeoutMs,
      };
      const onAbort = (): void => settle({ approved: false, by: "stop" });
      const timer = setTimeout(() => settle({ approved: false, by: "timeout" }), this.#timeoutMs);
      // A pending question must not keep the process alive on its own.
      timer.unref?.();
      const settle = (result: PluginConsentResult): void => {
        if (this.#waiting.get(request.consentId)?.entry !== entry) return;
        this.#waiting.delete(request.consentId);
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiting.set(request.consentId, { entry, outlivesTurn: request.outlivesTurn === true, settle });
    });
  }

  /** The user's answer. False when the id is unknown or already settled — a second click changes nothing. */
  resolve(consentId: string, approved: boolean): boolean {
    const waiting = this.#waiting.get(consentId);
    if (!waiting) return false;
    waiting.settle({ approved, by: "user" });
    return true;
  }

  /**
   * Withdraw every pending question in scope. A scope key left undefined matches everything, so
   * `{}` is the shutdown path, `{threadId}` a turn's end and `{project}` a project's Stop. A turn's
   * end leaves a question that outlives turns (`outlivesTurn`). Returns how many were settled.
   */
  cancel(scope: { project?: string; threadId?: string }, by: "stop" | "turn"): number {
    let settled = 0;
    for (const waiting of [...this.#waiting.values()]) {
      if (scope.project !== undefined && waiting.entry.project !== scope.project) continue;
      if (scope.threadId !== undefined && waiting.entry.threadId !== scope.threadId) continue;
      if (by === "turn" && waiting.outlivesTurn) continue;
      waiting.settle({ approved: false, by });
      settled += 1;
    }
    return settled;
  }

  pending(): ReadonlyArray<PluginConsentPending> {
    return [...this.#waiting.values()].map((waiting) => ({ ...waiting.entry }));
  }
}
