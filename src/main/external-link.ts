/**
 * A click on an https link in Live: the preview never navigates there, but the person who clicked
 * is asked, in a native dialog, whether to open it in their browser. Kept free of Electron so the
 * rules are tested as values: the host (dialog and browser) and the page's events are passed in.
 *
 * The page is untrusted. A link opens only for a real click or key press in the page's view within
 * `LINK_GESTURE_MS`, one gesture pays for one dialog, only a plain https address without
 * credentials is ever offered, and the dialog and the browser get the address as `URL` normalized
 * it (ASCII, punycode host), never the page's own string. An agent window, a fixture profile and
 * an agent's driving of a lent Live window have no host or no gesture, so they stay blocked.
 */
import { SECOND_MS } from "../shared/duration.ts";
import type { NativeStep } from "./dev/native-policy.ts";

/** The longest address, as the page wrote it and as normalized, that is ever offered. */
export const MAX_LINK_LENGTH = 2048;
/** How long after a click or key press a navigation still counts as the person's (Chromium's transient activation). */
export const LINK_GESTURE_MS = 5 * SECOND_MS;
/** The native step a fixture profile refuses: it never opens a dialog or the person's browser. */
export const EXTERNAL_LINK_STEP = "studio:preview.external-link" satisfies NativeStep;

/** Why a link was not offered. */
export const ExternalLinkRefusal = {
  NotHttps: "not-https",
  Malformed: "malformed",
  HasCredentials: "has-credentials",
  TooLong: "too-long",
  /** A form post, not a link. */
  NotALink: "not-a-link",
  /** No click or key press in the page just before: a script navigated on its own. */
  NoGesture: "no-gesture",
  /** A dialog for the previous click is still open. */
  Busy: "busy",
  /** No host: an agent's window, or a fixture profile. */
  Unavailable: "unavailable",
} as const;
export type ExternalLinkRefusal = (typeof ExternalLinkRefusal)[keyof typeof ExternalLinkRefusal];

/** What became of a link that was offered. */
export const ExternalLinkAnswer = { Opened: "opened", Declined: "declined", Failed: "failed" } as const;
export type ExternalLinkAnswer = (typeof ExternalLinkAnswer)[keyof typeof ExternalLinkAnswer];

/** The dialog's buttons, by index. */
export const ExternalLinkChoice = { Cancel: 0, Open: 1 } as const;

/** The input events that can be a person's click or key press in the page. */
const GESTURE_INPUT_TYPES: ReadonlySet<string> = new Set([
  "mouseDown",
  "mouseUp",
  "rawKeyDown",
  "keyDown",
  "touchEnd",
  "gestureTap",
]);

const MESSAGE = {
  Title: (host: string) => `Open ${host} in your browser?`,
  Detail: (href: string) =>
    `${href}\n\nThis page is outside the project. It opens in your default browser, not in Senex.`,
  Cancel: "Cancel",
  Open: "Open in Browser",
} as const;

/** What the person is asked about. */
export interface ExternalLink {
  /** The address as `URL` normalized it: ASCII only. */
  href: string;
  /** Its host, in punycode, so a look-alike name cannot pass for another. */
  host: string;
}

/** The two things only the app can do: ask the person, and open their browser. */
export interface ExternalLinkHost {
  confirm(link: ExternalLink): Promise<boolean>;
  open(href: string): Promise<void>;
}

/** The address a page named, if it is one that may be offered. Never throws. */
export function externalLinkTarget(
  raw: unknown,
): { ok: true; link: ExternalLink } | { ok: false; refusal: ExternalLinkRefusal } {
  if (typeof raw !== "string") return { ok: false, refusal: ExternalLinkRefusal.Malformed };
  // Length first: a megabyte string is refused before anything parses it.
  if (raw.length > MAX_LINK_LENGTH) return { ok: false, refusal: ExternalLinkRefusal.TooLong };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, refusal: ExternalLinkRefusal.Malformed };
  }
  if (url.protocol !== "https:") return { ok: false, refusal: ExternalLinkRefusal.NotHttps };
  if (url.username !== "" || url.password !== "") return { ok: false, refusal: ExternalLinkRefusal.HasCredentials };
  if (url.href.length > MAX_LINK_LENGTH) return { ok: false, refusal: ExternalLinkRefusal.TooLong };
  return { ok: true, link: { href: url.href, host: url.host } };
}

/** The result of asking to open a link: refused at once, or an answer to wait for. */
export type ExternalLinkRequest = { refused: ExternalLinkRefusal } | { answer: Promise<ExternalLinkAnswer> };

/** The gate between a page's navigation and the person's browser. */
export interface ExternalLinks {
  /** Tell the gate about an input event delivered to the page. */
  input(type: string): void;
  /** Run `work`, which sends input events itself (an agent driving the page); they are not the person's. */
  synthetic<T>(work: () => Promise<T>): Promise<T>;
  /** Ask to open `raw`. `form` is set for a window a form post opened. */
  request(raw: unknown, options?: { form?: boolean }): ExternalLinkRequest;
}

/** A gate over `host`; with none, every request is refused as `Unavailable`. `now` is injectable. */
export function createExternalLinks(host: ExternalLinkHost | undefined, now: () => number = Date.now): ExternalLinks {
  let sequence = 0;
  let gesture: { sequence: number; at: number } | null = null;
  let spent = 0;
  let agentInput = 0;
  let asking = false;

  const ask = async (link: ExternalLink, target: ExternalLinkHost): Promise<ExternalLinkAnswer> => {
    try {
      if (!(await target.confirm(link))) return ExternalLinkAnswer.Declined;
      await target.open(link.href);
      return ExternalLinkAnswer.Opened;
    } catch {
      return ExternalLinkAnswer.Failed;
    } finally {
      asking = false;
    }
  };

  return {
    input(type) {
      if (agentInput > 0 || !GESTURE_INPUT_TYPES.has(type)) return;
      sequence += 1;
      gesture = { sequence, at: now() };
    },
    async synthetic(work) {
      agentInput += 1;
      try {
        return await work();
      } finally {
        agentInput -= 1;
      }
    },
    request(raw, options = {}) {
      if (options.form) return { refused: ExternalLinkRefusal.NotALink };
      const target = externalLinkTarget(raw);
      if (!target.ok) return { refused: target.refusal };
      if (!host) return { refused: ExternalLinkRefusal.Unavailable };
      if (asking) return { refused: ExternalLinkRefusal.Busy };
      if (!gesture || gesture.sequence <= spent || now() - gesture.at > LINK_GESTURE_MS)
        return { refused: ExternalLinkRefusal.NoGesture };
      spent = gesture.sequence;
      asking = true;
      return { answer: ask(target.link, host) };
    },
  };
}

/** The native dialog's options for a link, as plain values. Cancel is the default and the Escape button. */
export function externalLinkDialog(link: ExternalLink) {
  return {
    type: "question" as const,
    buttons: [MESSAGE.Cancel, MESSAGE.Open],
    defaultId: ExternalLinkChoice.Cancel,
    cancelId: ExternalLinkChoice.Cancel,
    message: MESSAGE.Title(link.host),
    detail: MESSAGE.Detail(link.href),
  };
}

/** The dialog and browser of the real app, as `liveLinkHost` is given them. */
export interface NativeLinkDeps {
  showMessageBox(options: ReturnType<typeof externalLinkDialog>): Promise<{ response: number }>;
  openExternal(href: string): Promise<void>;
  /** Throws in a fixture profile (`assertNativeActionAllowed`). */
  assertAllowed(step: string): void;
}

/** The host for Live, or none in a fixture profile, which never opens a dialog or a browser. */
export function liveLinkHost(fixture: boolean, native: NativeLinkDeps): ExternalLinkHost | undefined {
  if (fixture) return undefined;
  return {
    async confirm(link) {
      native.assertAllowed(EXTERNAL_LINK_STEP);
      const { response } = await native.showMessageBox(externalLinkDialog(link));
      return response === ExternalLinkChoice.Open;
    },
    open: (href) => native.openExternal(href),
  };
}

/** How `guardPreviewNavigation` reaches a page's `webContents`: its registrations, as plain functions. */
export interface NavigationHooks {
  /** `setWindowOpenHandler`: the handler's answer is always a denial. */
  windowOpen(handler: (details: { url: string; postBody?: unknown }) => { action: "deny" }): void;
  willNavigate(listener: (event: NavigationEvent) => void): void;
  willFrameNavigate(listener: (event: NavigationEvent) => void): void;
  /** Every input event delivered to the page, by its type. */
  inputEvent(listener: (type: string) => void): void;
}

/** The part of Electron's navigation events used here. */
export interface NavigationEvent {
  url: string;
  isMainFrame?: boolean;
  preventDefault(): void;
}

/** What the preview says about a refused navigation (`blockedNote` kinds). */
export type NavigationNoteKind = "window" | "tab" | "navigation";

export interface NavigationGuardDeps {
  /** Whether the preview itself may go to `url` (a page of the project, its loopback origin). */
  allowed(url: string, mainFrame: boolean): boolean;
  links: ExternalLinks;
  /** Put a console line about a refused navigation. */
  note(kind: NavigationNoteKind, url: string): void;
  /** Whether input events are watched at all: only when a person can be asked. */
  asks: boolean;
}

/**
 * The preview's rules for where a page may go. Nothing leaves the project in the view: a window
 * is denied, a navigation is prevented. An https link the person clicked is then offered to their
 * browser, once, and only after they say yes.
 */
export function guardPreviewNavigation(hooks: NavigationHooks, deps: NavigationGuardDeps): void {
  const offer = (kind: NavigationNoteKind, url: string, options?: { form?: boolean }): void => {
    const request = deps.links.request(url, options);
    if ("refused" in request) {
      // A second event for the click already being answered says nothing new.
      if (request.refused !== ExternalLinkRefusal.Busy) deps.note(kind, url);
      return;
    }
    void request.answer.then((answer) => {
      if (answer === ExternalLinkAnswer.Failed) deps.note(kind, url);
    });
  };
  hooks.windowOpen(({ url, postBody }) => {
    if (deps.allowed(url, true)) deps.note("tab", url);
    else offer("window", url, { form: postBody !== undefined });
    return { action: "deny" };
  });
  // The page stays on project:// or its loopback origin: a remote page inside the studio's chrome,
  // which has no URL bar, is a sign-in form nobody can tell from the studio's own (SECUI-3).
  hooks.willNavigate((event) => {
    if (deps.allowed(event.url, true)) return;
    event.preventDefault();
    offer("navigation", event.url);
  });
  hooks.willFrameNavigate((event) => {
    const mainFrame = event.isMainFrame ?? true;
    if (deps.allowed(event.url, mainFrame)) return;
    event.preventDefault();
    // A frame the page inserted never asks: only the page itself, clicked, can.
    if (mainFrame) offer("navigation", event.url);
    else deps.note("navigation", event.url);
  });
  if (deps.asks) hooks.inputEvent((type) => deps.links.input(type));
}
