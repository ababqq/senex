/**
 * A click on an https link in Live asks the person, then opens their browser. The page is
 * untrusted: it can navigate on its own, many times, to any string. Every row drives the gate with
 * a fake clock and a fake host (a dialog and a browser that record what they were asked) and
 * expects that nothing opens unless a person clicked and said yes.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXTERNAL_LINK_STEP,
  ExternalLinkAnswer,
  ExternalLinkChoice,
  ExternalLinkRefusal,
  type ExternalLinkHost,
  type NavigationEvent,
  LINK_GESTURE_MS,
  MAX_LINK_LENGTH,
  createExternalLinks,
  externalLinkDialog,
  externalLinkTarget,
  guardPreviewNavigation,
  liveLinkHost,
} from "../../src/main/external-link.ts";
import { assertNativeActionAllowed, classifyChannel } from "../../src/main/dev/native-policy.ts";

/** A dialog and a browser that record what they were asked, and answer as told. */
function spyHost(answer: boolean | "throw" = true, openFails = false) {
  const asked: Array<{ href: string; host: string }> = [];
  const opened: string[] = [];
  const host: ExternalLinkHost = {
    async confirm(link) {
      asked.push(link);
      if (answer === "throw") throw new Error("dialog failed");
      return answer;
    },
    async open(href) {
      if (openFails) throw new Error("no browser");
      opened.push(href);
    },
  };
  return { host, asked, opened };
}

function clock(start = 1_000_000) {
  let at = start;
  return { now: () => at, tick: (ms: number) => void (at += ms) };
}

const click = (links: { input(type: string): void }) => {
  links.input("mouseDown");
  links.input("mouseUp");
};
const settle = async (request: ReturnType<ReturnType<typeof createExternalLinks>["request"]>) => {
  assert.ok("answer" in request, JSON.stringify(request));
  return request.answer;
};

describe("externalLinkTarget: which addresses may be offered at all", () => {
  it("normalizes an https address to ASCII and names its host", () => {
    for (const raw of ["https://example.com/docs?a=1#x", "HTTPS://EXAMPLE.com/Docs"]) {
      const target = externalLinkTarget(raw);
      assert.ok(target.ok, raw);
      assert.match(target.link.href, /^[\x20-\x7e]+$/);
      assert.equal(target.link.host, "example.com");
    }
  });

  it("refuses every scheme but https", () => {
    for (const raw of [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "http://example.com/",
      "mailto:a@b.c",
      "tel:1",
      "blob:https://example.com/u",
      "filesystem:https://example.com/t/x",
      "view-source:https://example.com/",
      "project://site/a.html",
      "about:blank",
      "chrome://gpu",
    ])
      assert.deepEqual(externalLinkTarget(raw), { ok: false, refusal: ExternalLinkRefusal.NotHttps }, raw);
  });

  it("never offers an address that carries a user name or password", () => {
    for (const raw of [
      "https://user:pw@example.com/",
      "https://github.com@evil.example/",
      "https://user@example.com/",
      "https://:pw@example.com/",
    ])
      assert.deepEqual(externalLinkTarget(raw), { ok: false, refusal: ExternalLinkRefusal.HasCredentials }, raw);
    const empty = externalLinkTarget("https://:@example.com/");
    assert.ok(empty.ok);
    assert.equal(empty.link.href, "https://example.com/");
  });

  it("shows a look-alike host in punycode, and an address in percent-encoded ASCII", () => {
    const cyrillic = externalLinkTarget("https://аpple.com/");
    assert.ok(cyrillic.ok);
    assert.equal(cyrillic.link.host, "xn--pple-43d.com");
    const accented = externalLinkTarget("https://exämple.com/ü?q=ü");
    assert.ok(accented.ok);
    assert.match(accented.link.href, /^[\x20-\x7e]+$/);
    assert.equal(externalLinkTarget("https://xn--pple-43d.com/").ok, true);
  });

  it("answers a malformed or non-string address without throwing", () => {
    for (const raw of ["", "not a url", "https://", "https://exa mple.com/", "https://example.com:99999/"])
      assert.deepEqual(
        externalLinkTarget(raw),
        { ok: false, refusal: ExternalLinkRefusal.Malformed },
        JSON.stringify(raw),
      );
    for (const raw of [null, undefined, 42, {}, ["https://example.com/"]])
      assert.deepEqual(externalLinkTarget(raw), { ok: false, refusal: ExternalLinkRefusal.Malformed }, String(raw));
  });

  it("bounds the address by its length as written and as normalized", () => {
    const base = "https://example.com/";
    assert.equal(externalLinkTarget(base + "a".repeat(MAX_LINK_LENGTH - base.length)).ok, true);
    assert.deepEqual(externalLinkTarget(base + "a".repeat(MAX_LINK_LENGTH - base.length + 1)), {
      ok: false,
      refusal: ExternalLinkRefusal.TooLong,
    });
    assert.deepEqual(externalLinkTarget(`https://example.com/${"a".repeat(1024 ** 2)}`), {
      ok: false,
      refusal: ExternalLinkRefusal.TooLong,
    });
    // Short as written, long once every character is percent-encoded.
    assert.deepEqual(externalLinkTarget(`https://example.com/${"ü".repeat(900)}`), {
      ok: false,
      refusal: ExternalLinkRefusal.TooLong,
    });
  });

  it("leaves no control or direction-changing character in what the dialog will show", () => {
    for (const raw of ["https://example.com/a\tb\nc", "https://example.com/‮evil", "https://example.com/%0d%0aX"]) {
      const target = externalLinkTarget(raw);
      assert.ok(target.ok, raw);
      assert.match(target.link.href, /^[\x21-\x7e]+$/, raw);
    }
  });
});

describe("the gate: nothing opens without a click and a yes", () => {
  it("refuses a request with no click, and with only input that is not a click", () => {
    const { host, asked } = spyHost();
    const links = createExternalLinks(host, clock().now);
    assert.deepEqual(links.request("https://example.com/"), { refused: ExternalLinkRefusal.NoGesture });
    for (const type of ["mouseMove", "mouseEnter", "mouseWheel", "keyUp", "char", "contextMenu"]) links.input(type);
    assert.deepEqual(links.request("https://example.com/"), { refused: ExternalLinkRefusal.NoGesture });
    assert.equal(asked.length, 0);
  });

  it("asks once for a click, opens on yes, and opens nothing on no", async () => {
    for (const [answer, expected] of [
      [true, ExternalLinkAnswer.Opened],
      [false, ExternalLinkAnswer.Declined],
    ] as const) {
      const { host, asked, opened } = spyHost(answer);
      const links = createExternalLinks(host, clock().now);
      click(links);
      assert.equal(await settle(links.request("https://example.com/a")), expected);
      assert.deepEqual(asked, [{ href: "https://example.com/a", host: "example.com" }]);
      assert.deepEqual(opened, answer ? ["https://example.com/a"] : []);
    }
  });

  it("counts a key press, a tap and a touch as a gesture too", () => {
    for (const type of ["rawKeyDown", "keyDown", "touchEnd", "gestureTap", "mouseUp", "mouseDown"]) {
      const links = createExternalLinks(spyHost().host, clock().now);
      links.input(type);
      assert.ok("answer" in links.request("https://example.com/"), type);
    }
  });

  it("gives a gesture exactly LINK_GESTURE_MS to be used", () => {
    const time = clock();
    const links = createExternalLinks(spyHost().host, time.now);
    click(links);
    time.tick(LINK_GESTURE_MS);
    assert.ok("answer" in links.request("https://example.com/"), "at the limit it still asks");
    const later = createExternalLinks(spyHost().host, time.now);
    click(later);
    time.tick(LINK_GESTURE_MS + 1);
    assert.deepEqual(later.request("https://example.com/"), { refused: ExternalLinkRefusal.NoGesture });
  });

  it("lets one click pay for one dialog, however often the page asks", async () => {
    const { host, asked } = spyHost();
    const links = createExternalLinks(host, clock().now);
    click(links);
    const first = links.request("https://example.com/");
    assert.ok("answer" in first);
    for (let again = 0; again < 100; again++)
      assert.deepEqual(
        links.request("https://example.com/"),
        { refused: ExternalLinkRefusal.Busy },
        "while it is open",
      );
    await first.answer;
    for (let again = 0; again < 100; again++)
      assert.deepEqual(
        links.request("https://example.com/"),
        { refused: ExternalLinkRefusal.NoGesture },
        "once answered",
      );
    assert.equal(asked.length, 1);
    click(links);
    assert.ok("answer" in links.request("https://example.com/b"), "a new click is a new dialog");
  });

  it("is Unavailable without a host (an agent's window, a fixture profile), whatever the clicks", () => {
    const links = createExternalLinks(undefined, clock().now);
    click(links);
    assert.deepEqual(links.request("https://example.com/"), { refused: ExternalLinkRefusal.Unavailable });
  });

  it("is a failure, not a throw, when the dialog or the browser fails, and asks again after", async () => {
    for (const host of [spyHost("throw").host, spyHost(true, true).host]) {
      const links = createExternalLinks(host, clock().now);
      click(links);
      assert.equal(await settle(links.request("https://example.com/")), ExternalLinkAnswer.Failed);
      click(links);
      assert.ok("answer" in links.request("https://example.com/"), "the dialog slot was released");
    }
  });

  it("does not take an agent's click in a lent window for the person's", async () => {
    const { host, asked } = spyHost();
    const links = createExternalLinks(host, clock().now);
    await links.synthetic(async () => {
      click(links);
    });
    assert.deepEqual(links.request("https://example.com/"), { refused: ExternalLinkRefusal.NoGesture });
    await assert.rejects(
      links.synthetic(async () => {
        click(links);
        throw new Error("the drive failed");
      }),
    );
    assert.deepEqual(links.request("https://example.com/"), { refused: ExternalLinkRefusal.NoGesture });
    assert.equal(asked.length, 0, "no dialog for an agent's clicks");
    click(links);
    assert.ok("answer" in links.request("https://example.com/"), "the person's own click works again");
  });

  it("does not open a window a form post made", () => {
    const links = createExternalLinks(spyHost().host, clock().now);
    click(links);
    assert.deepEqual(links.request("https://example.com/", { form: true }), { refused: ExternalLinkRefusal.NotALink });
  });

  it("refuses every hostile address with a click in hand, asking and opening nothing", () => {
    const { host, asked, opened } = spyHost();
    const links = createExternalLinks(host, clock().now);
    click(links);
    for (const raw of [
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "file:///etc/passwd",
      "http://example.com/",
      "mailto:a@b.c",
      "https://u:p@example.com/",
      `https://example.com/${"x".repeat(3000)}`,
      "",
      undefined,
    ])
      assert.ok("refused" in links.request(raw), String(raw).slice(0, 40));
    assert.equal(asked.length + opened.length, 0);
    assert.ok("answer" in links.request("https://example.com/"), "the click was not spent by the refusals");
  });
});

describe("externalLinkDialog", () => {
  it("makes Cancel the default and the Escape button, and shows only the destination", () => {
    const options = externalLinkDialog({ href: "https://xn--pple-43d.com/a", host: "xn--pple-43d.com" });
    assert.equal(options.type, "question");
    assert.equal(options.buttons[ExternalLinkChoice.Cancel], "Cancel");
    assert.equal(options.buttons[ExternalLinkChoice.Open], "Open in Browser");
    assert.equal(options.defaultId, ExternalLinkChoice.Cancel);
    assert.equal(options.cancelId, ExternalLinkChoice.Cancel);
    assert.match(options.message, /xn--pple-43d\.com/);
    assert.equal(options.detail.split("https://xn--pple-43d.com/a").length - 1, 1, "the address once");
  });
});

describe("liveLinkHost", () => {
  const native = (response: number, log: string[] = []) => ({
    showMessageBox: async () => ({ response }),
    openExternal: async (href: string) => void log.push(href),
    assertAllowed: (step: string) => void log.push(`allowed:${step}`),
  });

  it("is none in a fixture profile, which never opens a dialog or a browser", () => {
    assert.equal(liveLinkHost(true, native(ExternalLinkChoice.Open)), undefined);
  });

  it("is the person's yes only for the Open button, and opens exactly the address it is given", async () => {
    for (const [response, expected] of [
      [ExternalLinkChoice.Open, true],
      [ExternalLinkChoice.Cancel, false],
      [7, false],
      [-1, false],
    ] as const) {
      const log: string[] = [];
      const host = liveLinkHost(false, native(response, log));
      assert.ok(host);
      assert.equal(
        await host.confirm({ href: "https://example.com/", host: "example.com" }),
        expected,
        String(response),
      );
      assert.deepEqual(log, [`allowed:${EXTERNAL_LINK_STEP}`]);
      await host.open("https://example.com/");
      assert.deepEqual(log.slice(1), ["https://example.com/"]);
    }
  });

  it("asks the native policy first, so a fixture that got here anyway opens no dialog", async () => {
    let shown = false;
    const host = liveLinkHost(false, {
      showMessageBox: async () => {
        shown = true;
        return { response: ExternalLinkChoice.Open };
      },
      openExternal: async () => {},
      assertAllowed: () => {
        throw new Error("unsupported-in-fixture");
      },
    });
    assert.ok(host);
    await assert.rejects(host.confirm({ href: "https://example.com/", host: "example.com" }), /unsupported-in-fixture/);
    assert.equal(shown, false);
  });

  it("names a native step that fixture profiles refuse", () => {
    assert.equal(classifyChannel(EXTERNAL_LINK_STEP), "native");
    assert.throws(() => assertNativeActionAllowed(true, EXTERNAL_LINK_STEP), /unsupported-in-fixture/);
    assert.doesNotThrow(() => assertNativeActionAllowed(false, EXTERNAL_LINK_STEP));
  });
});

/** A page's contents as the guard sees them: registrations are recorded, and events are fired by the test. */
function fakeContents() {
  const state = {
    open: undefined as undefined | ((details: { url: string; postBody?: unknown }) => { action: "deny" }),
    navigate: undefined as undefined | ((event: NavigationEvent) => void),
    frame: undefined as undefined | ((event: NavigationEvent) => void),
    input: undefined as undefined | ((type: string) => void),
  };
  const hooks = {
    windowOpen: (handler: NonNullable<typeof state.open>) => void (state.open = handler),
    willNavigate: (listener: NonNullable<typeof state.navigate>) => void (state.navigate = listener),
    willFrameNavigate: (listener: NonNullable<typeof state.frame>) => void (state.frame = listener),
    inputEvent: (listener: NonNullable<typeof state.input>) => void (state.input = listener),
  };
  const navigation = (url: string, isMainFrame = true) => {
    const event = { url, isMainFrame, prevented: false, preventDefault: () => void (event.prevented = true) };
    return event;
  };
  return { state, hooks, navigation };
}

describe("guardPreviewNavigation: what the preview does with where a page tries to go", () => {
  const ofTheProject = (url: string) => url.startsWith("project://") || url === "http://localhost:3000/";
  function guarded(host: ExternalLinkHost | undefined) {
    const contents = fakeContents();
    const notes: string[] = [];
    const time = clock();
    const links = createExternalLinks(host, time.now);
    guardPreviewNavigation(contents.hooks, {
      allowed: (url, mainFrame) => ofTheProject(url) || (!mainFrame && /^(about:blank|data:|blob:)/.test(url)),
      links,
      note: (kind, url) => void notes.push(`${kind} ${url}`),
      asks: host !== undefined,
    });
    return { ...contents, notes, links, time };
  }
  const settleLater = () => new Promise<void>((resolve) => setImmediate(resolve));

  it("without a host behaves as the preview always did: deny, prevent, note", () => {
    const g = guarded(undefined);
    assert.deepEqual(g.state.open?.({ url: "https://docs.example/a" }), { action: "deny" });
    assert.deepEqual(g.state.open?.({ url: "project://site/page.html" }), { action: "deny" });
    const outside = g.navigation("https://docs.example/a");
    g.state.navigate?.(outside);
    const inside = g.navigation("project://site/b.html");
    g.state.navigate?.(inside);
    const loopback = g.navigation("http://localhost:3000/");
    g.state.frame?.(loopback);
    const iframeBlank = g.navigation("about:blank", false);
    g.state.frame?.(iframeBlank);
    const iframeHttps = g.navigation("https://docs.example/", false);
    g.state.frame?.(iframeHttps);
    const topBlank = g.navigation("about:blank", true);
    g.state.frame?.(topBlank);
    assert.deepEqual(
      [outside, inside, loopback, iframeBlank, iframeHttps, topBlank].map((event) => event.prevented),
      [true, false, false, false, true, true],
    );
    assert.deepEqual(g.notes, [
      "window https://docs.example/a",
      "tab project://site/page.html",
      "navigation https://docs.example/a",
      "navigation https://docs.example/",
      "navigation about:blank",
    ]);
    assert.equal(g.state.input, undefined, "no host, no input listener");
  });

  it("offers a clicked https link: denies the window, asks once, opens on yes, and notes nothing", async () => {
    const { host, asked, opened } = spyHost(true);
    const g = guarded(host);
    g.state.input?.("mouseDown");
    g.state.input?.("mouseUp");
    assert.deepEqual(g.state.open?.({ url: "https://docs.example/a" }), { action: "deny" });
    await settleLater();
    assert.deepEqual(asked, [{ href: "https://docs.example/a", host: "docs.example" }]);
    assert.deepEqual(opened, ["https://docs.example/a"]);
    assert.deepEqual(g.notes, []);
  });

  it("opens nothing on Cancel, and a main-frame navigation click is prevented and offered", async () => {
    const { host, asked, opened } = spyHost(false);
    const g = guarded(host);
    g.state.input?.("mouseUp");
    const event = g.navigation("https://docs.example/b");
    g.state.navigate?.(event);
    await settleLater();
    assert.equal(event.prevented, true);
    assert.equal(asked.length, 1);
    assert.deepEqual(opened, []);
    assert.deepEqual(g.notes, []);
  });

  it("asks once when a single click fires both navigation events", async () => {
    const { host, asked } = spyHost(true);
    const g = guarded(host);
    g.state.input?.("mouseUp");
    const first = g.navigation("https://docs.example/c");
    const second = g.navigation("https://docs.example/c");
    g.state.frame?.(first);
    g.state.navigate?.(second);
    await settleLater();
    assert.equal(first.prevented && second.prevented, true);
    assert.equal(asked.length, 1);
    assert.deepEqual(g.notes, [], "the second event adds no line");
  });

  it("never asks for a frame the page inserted, only notes it", async () => {
    const { host, asked } = spyHost(true);
    const g = guarded(host);
    g.state.input?.("mouseUp");
    const event = g.navigation("https://docs.example/d", false);
    g.state.frame?.(event);
    await settleLater();
    assert.equal(event.prevented, true);
    assert.equal(asked.length, 0);
    assert.deepEqual(g.notes, ["navigation https://docs.example/d"]);
  });

  it("notes, and asks nothing, for a script that navigates with no click, or opens a window with a form post", async () => {
    const { host, asked } = spyHost(true);
    const g = guarded(host);
    g.state.open?.({ url: "https://docs.example/e" });
    g.state.navigate?.(g.navigation("https://docs.example/e"));
    g.state.input?.("mouseDown");
    g.state.open?.({ url: "https://docs.example/f", postBody: { data: [] } });
    await settleLater();
    assert.equal(asked.length, 0);
    assert.equal(g.notes.length, 3);
  });

  it("refuses every other kind of address at all three entry points, clicked or not", async () => {
    const { host, asked, opened } = spyHost(true);
    const g = guarded(host);
    const hostile = [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "http://example.com/",
      "mailto:a@b.c",
      "https://u:p@h.example/",
      `https://h.example/${"x".repeat(3000)}`,
    ];
    for (const url of hostile) {
      g.state.input?.("mouseUp");
      g.state.open?.({ url });
      g.state.navigate?.(g.navigation(url));
      g.state.frame?.(g.navigation(url, false));
    }
    await settleLater();
    assert.equal(asked.length + opened.length, 0);
    // Three entry points each, except a data: frame, which the preview lets an embedded frame hold.
    assert.equal(g.notes.length, hostile.length * 3 - 1);
  });

  it("notes the destination when the dialog or the browser fails", async () => {
    const { host } = spyHost("throw");
    const g = guarded(host);
    g.state.input?.("mouseUp");
    g.state.open?.({ url: "https://docs.example/g" });
    await settleLater();
    assert.deepEqual(g.notes, ["window https://docs.example/g"]);
  });
});
