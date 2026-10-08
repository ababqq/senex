/**
 * Preview pool — N observation ports on projects, addressed by handle.
 *
 * The visible WebContentsView is the reserved `"live"` port; headless ports are created on
 * demand by a factory the Electron layer injects (a hidden window reusing the same `project://`
 * protocol). The pool itself is Electron-free: what a port *is* stays the caller's business,
 * the pool only leases and routes.
 *
 * The live view is the person's. A harness call that names no window reaches the stand-in (a
 * hidden window of its own, `STAND_IN_HANDLE`) wherever this build can make one, so nothing the
 * harness does changes what the person is watching; a build with no headless capability still
 * has only the live view.
 */
import { shortId } from "./ids.ts";
import { DEFAULT_BUILDERS, LEAD_WINDOWS, MAX_BUILDERS } from "../shared/builders.ts";
import type { PreviewPort } from "./preview-port.ts";

export const LIVE_HANDLE = "live";
/** The hidden window that stands in for the live view when the harness names no window. */
export const STAND_IN_HANDLE = "stand-in";

const MESSAGE = {
  NoHeadless: "this build has no headless preview capability — only the live view exists",
  Exhausted: (leased: number, max: number) =>
    `preview pool exhausted (${leased}/${max} leased) — release a handle first`,
  UnknownHandle: (handle: string) => `unknown preview handle: ${handle}`,
} as const;

export interface PreviewLease {
  handle: string;
  port: PreviewPort;
}

export interface PreviewPoolOptions {
  live: PreviewPort;
  /** Absent = this build has no headless capability; `acquire` then refuses loudly. */
  createHeadless?: (options?: { purpose?: "optimization" }) => Promise<PreviewPort>;
  /** Max concurrent headless leases (the live view is not counted). */
  max?: number;
}

/**
 * The most hidden windows sessions may hold past the pool's ceiling (`acquire` with `overflow`), so
 * a session never borrows the person's window. Each is a renderer process with its own GPU context:
 * past a few, memory runs short and Chromium starts dropping the oldest WebGL contexts, which can
 * be Live's. A session past this waits for a window to close.
 */
export const OVERFLOW_WINDOWS_MAX = 2;

/** The most leases at once: past this the provider's rate limit, not the machine, decides. */
export const MAX_POOL_MAX = MAX_BUILDERS + LEAD_WINDOWS;
/** Headless leases at once by default: every builder the setting allows, plus the lead's windows. */
export const DEFAULT_POOL_MAX = DEFAULT_BUILDERS + LEAD_WINDOWS;

export class PreviewPool {
  readonly #live: PreviewPort;
  readonly #createHeadless: ((options?: { purpose?: "optimization" }) => Promise<PreviewPort>) | undefined;
  #max: number;
  /** Hidden windows held, opening or still closing: what the ceiling (and the overflow past it) counts. */
  #reserved = 0;
  readonly #creating = new Set<Promise<PreviewPort>>();
  readonly #retiring = new Map<string, Promise<void>>();
  /** The lease ceiling, for schedulers that size parallelism to it. */
  get max(): number {
    return this.#max;
  }
  /** The "agents at once" setting changes it live; leases already held are never revoked. */
  set max(value: number) {
    this.#max = Math.max(0, Math.min(MAX_POOL_MAX, Math.round(value)));
    this.#wakeWaiters();
  }
  /**
   * `owner` names who gives a lease back when its own `finally` can no longer run — a harness
   * boot (see {@link PreviewPool.releaseOwnedBy}). Leases the host holds for itself carry none.
   */
  readonly #leases = new Map<string, { port: PreviewPort; label: string; owner?: string }>();
  /**
   * The stand-in, while it is open. It is not a lease: it replaces the live view the harness used
   * to drive, so it neither takes a builder's window nor counts toward `leaseCount`.
   */
  #standIn: Promise<PreviewPort> | null = null;
  #standInPort: PreviewPort | null = null;
  /** Sessions waiting for an overflow window, in the order they asked; each looks again when a window closes. */
  readonly #waiters = new Set<() => void>();

  constructor(options: PreviewPoolOptions) {
    this.#live = options.live;
    this.#createHeadless = options.createHeadless;
    this.#max = Math.max(0, options.max ?? DEFAULT_POOL_MAX);
  }

  get leaseCount(): number {
    return this.#leases.size;
  }

  /** Whether this build can open hidden windows at all. */
  get headless(): boolean {
    return Boolean(this.#createHeadless);
  }

  leases(): Array<{ handle: string; label: string }> {
    return [...this.#leases.entries()].map(([handle, lease]) => ({ handle, label: lease.label }));
  }

  /**
   * A hidden window. `overflow` is for a host session whose only other choice was the person's own
   * window: it may go past `max` by up to `OVERFLOW_WINDOWS_MAX`, waits (until `signal` aborts) for
   * a window to close beyond that, and gives the window back from its own `finally`.
   */
  async acquire(options: {
    label: string;
    purpose?: "optimization";
    owner?: string;
    overflow?: boolean;
    signal?: AbortSignal;
  }): Promise<PreviewLease> {
    const create = this.#createHeadless;
    if (!create) {
      throw new Error(MESSAGE.NoHeadless);
    }
    if (this.#reserved >= this.#max && !options.overflow) {
      throw new Error(MESSAGE.Exhausted(this.#reserved, this.#max));
    }
    if (options.overflow) await this.#overflowRoom(options.signal);
    else this.#reserved++;
    let port: PreviewPort;
    const creation = Promise.resolve().then(() => create({ purpose: options.purpose }));
    this.#creating.add(creation);
    try {
      port = await creation;
    } catch (error) {
      this.#reserved--;
      this.#wakeWaiters();
      throw error;
    } finally {
      this.#creating.delete(creation);
    }
    const handle = shortId("pv");
    this.#leases.set(handle, { port, label: options.label, ...(options.owner ? { owner: options.owner } : {}) });
    return { handle, port };
  }

  /**
   * Wait until an overflow window fits, then reserve its place before anything else runs, so the
   * sessions woken together take the room one at a time.
   */
  async #overflowRoom(signal: AbortSignal | undefined): Promise<void> {
    while (this.#reserved >= this.#max + OVERFLOW_WINDOWS_MAX) {
      signal?.throwIfAborted();
      await this.#nextClose(signal);
    }
    signal?.throwIfAborted();
    this.#reserved++;
  }

  /** Resolves when a window closes (or the ceiling rises); rejects when `signal` aborts first. */
  #nextClose(signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const done = (): void => {
        this.#waiters.delete(done);
        signal?.removeEventListener("abort", done);
        if (signal?.aborted) reject(signal.reason);
        else resolve();
      };
      this.#waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  #wakeWaiters(): void {
    for (const wake of [...this.#waiters]) wake();
  }

  async release(handle: string): Promise<void> {
    if (handle === LIVE_HANDLE) return; // the live view is never disposed
    const retiring = this.#retiring.get(handle);
    if (retiring) return retiring;
    const lease = this.#leases.get(handle);
    if (!lease) return; // releasing twice is a no-op, not an error
    this.#leases.delete(handle);
    const disposal = Promise.resolve()
      .then(() => lease.port.dispose?.())
      .then(() => {
        this.#reserved--;
        this.#retiring.delete(handle);
        // Only a window really gone makes room for a session waiting past the ceiling.
        this.#wakeWaiters();
      });
    // A failed cleanup keeps its reservation: the underlying session is not safe to reuse.
    this.#retiring.set(handle, disposal);
    await disposal;
  }

  /**
   * Open the stand-in, or answer the one already open. `opened` says this call made it, so the
   * caller can put into it what the harness expects to find there.
   */
  async standIn(): Promise<{ handle: string; opened: boolean }> {
    const create = this.#createHeadless;
    if (!create) throw new Error(MESSAGE.NoHeadless);
    if (this.#standIn) {
      await this.#standIn;
      return { handle: STAND_IN_HANDLE, opened: false };
    }
    const opening = create();
    this.#standIn = opening;
    let port: PreviewPort;
    try {
      port = await opening;
    } catch (error) {
      if (this.#standIn === opening) this.#standIn = null;
      throw error;
    }
    // Closed while it was opening: this window is nobody's, and the caller gets a fresh one.
    if (this.#standIn !== opening) {
      await port.dispose?.();
      return this.standIn();
    }
    this.#standInPort = port;
    return { handle: STAND_IN_HANDLE, opened: true };
  }

  /** Close the stand-in; the next harness call that names no window opens a fresh one. */
  async closeStandIn(): Promise<void> {
    const port = this.#standInPort;
    this.#standIn = null;
    this.#standInPort = null;
    await port?.dispose?.();
  }

  /** Undefined or "live" ⇒ the visible view — the back-compat path every old caller takes. */
  port(handle?: string): PreviewPort {
    if (handle === undefined || handle === LIVE_HANDLE) return this.#live;
    if (handle === STAND_IN_HANDLE) {
      if (!this.#standInPort) throw new Error(MESSAGE.UnknownHandle(handle));
      return this.#standInPort;
    }
    const lease = this.#leases.get(handle);
    if (!lease) throw new Error(MESSAGE.UnknownHandle(handle));
    return lease.port;
  }

  /** Release every lease `owner` took — a dead harness never reaches its own release. Returns their handles. */
  async releaseOwnedBy(owner: string): Promise<string[]> {
    const handles = [...this.#leases.entries()].filter(([, lease]) => lease.owner === owner).map(([handle]) => handle);
    for (const handle of handles) await this.release(handle);
    return handles;
  }

  async disposeAll(): Promise<void> {
    await Promise.allSettled(this.#creating);
    const handles = [...this.#leases.keys()];
    for (const handle of handles) await this.release(handle);
    await Promise.all(this.#retiring.values());
    await this.closeStandIn();
  }
}
