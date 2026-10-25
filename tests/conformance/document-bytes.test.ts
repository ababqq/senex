/**
 * A page the studio adds its own tags to keeps every byte it had: the studio reads a document as text
 * to find where its tags go, but a page in EUC-KR, Shift_JIS or windows-1252 is not UTF-8, and text
 * decoded as UTF-8 and written back as UTF-8 is a different page.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { looksLikeDocument, rewriteProjectHtml } from "../../src/main/page-serve.ts";
import { rewriteDocumentBytes } from "../../src/substrate/document-bytes.ts";

/** "안녕하세요" in EUC-KR, the way a 2000s Korean page stored it. */
const EUC_KR_HELLO = Uint8Array.from([0xbe, 0xc8, 0xb3, 0xe7, 0xc7, 0xcf, 0xbc, 0xbc, 0xbf, 0xe4]);
/** "日本語" in Shift_JIS: its second and third bytes (0x93 0xfa, 0x96 0x7b) include trail bytes in the ASCII range. */
const SHIFT_JIS_NIHONGO = Uint8Array.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);

const bytesOf = (text: string) => new TextEncoder().encode(text);
const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((part) => [...part]));
/** A Node buffer as the plain bytes the studio is handed. */
const plain = (buffer: Buffer) => new Uint8Array(buffer);

/** The studio's own rewrite, as the preview applies it to a page. */
const withStudio = (html: string) => {
  const result = rewriteProjectHtml(html, { documentUrl: "project://demo/index.html" });
  return { html: result.html, injected: result.injected };
};

describe("a page the studio rewrites keeps its own bytes", () => {
  it("leaves an EUC-KR page's Korean text exactly as it was, and adds the studio's tags", () => {
    const page = concat(
      bytesOf('<!doctype html><html><head><meta charset="euc-kr"><title>'),
      EUC_KR_HELLO,
      bytesOf("</title></head><body>"),
      EUC_KR_HELLO,
      bytesOf("</body></html>"),
    );
    const out = rewriteDocumentBytes(page, withStudio);
    assert.equal(out.injected, true);
    const text = Buffer.from(out.bytes).toString("latin1");
    assert.ok(text.includes("data-studio-shim"), "the shim is on the page");
    const hello = Buffer.from(EUC_KR_HELLO).toString("latin1");
    assert.equal(text.split(hello).length - 1, 2, "both Korean runs are the same bytes as before");
    assert.ok(
      !Buffer.from(out.bytes).includes(Buffer.from([0xef, 0xbf, 0xbd])),
      "no U+FFFD, which UTF-8 text puts where a byte was not UTF-8",
    );
  });

  it("keeps a Shift_JIS page whose trail bytes look like markup characters", () => {
    const page = concat(bytesOf("<html><head></head><body>"), SHIFT_JIS_NIHONGO, bytesOf("</body></html>"));
    const out = rewriteDocumentBytes(page, withStudio);
    assert.equal(out.injected, true);
    assert.ok(Buffer.from(out.bytes).includes(Buffer.from(SHIFT_JIS_NIHONGO)));
  });

  it("keeps the bytes of a page that is not touched at all, even ones no UTF-8 text can hold", () => {
    const page = concat(bytesOf("<p>"), EUC_KR_HELLO, bytesOf("</p>"));
    const out = rewriteDocumentBytes(page, (html) => ({ html, injected: false }));
    assert.equal(out.injected, false);
    assert.deepEqual([...out.bytes], [...page]);
  });

  it("keeps a UTF-8 page's text, its byte order mark and a stray byte that is no UTF-8 at all", () => {
    const page = concat(
      Uint8Array.from([0xef, 0xbb, 0xbf]),
      bytesOf("<html><head></head><body>안녕 😀 "),
      Uint8Array.from([0xff]),
      bytesOf("</body></html>"),
    );
    const out = rewriteDocumentBytes(page, withStudio);
    assert.equal(out.injected, true);
    assert.deepEqual([...out.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "the byte order mark stays");
    assert.ok(Buffer.from(out.bytes).includes(Buffer.from("안녕 😀 ")));
    assert.ok(Buffer.from(out.bytes).includes(Buffer.from([0xff])), "the stray byte is still one byte");
  });

  it("shows a UTF-8 page as the text it is, so a link to a page saved with a byte order mark is still a document", () => {
    const page = concat(
      Uint8Array.from([0xef, 0xbb, 0xbf]),
      bytesOf("<!doctype html><html><head></head><body>안녕</body></html>"),
    );
    let seen = "";
    const out = rewriteDocumentBytes(page, (html) => {
      seen = html;
      return withStudio(html);
    });
    assert.ok(looksLikeDocument(seen), JSON.stringify(seen.slice(0, 12)));
    assert.equal(out.injected, true);
    assert.deepEqual(
      [...out.bytes.subarray(0, 3)],
      [0xef, 0xbb, 0xbf],
      "the byte order mark is still the first three bytes",
    );
    assert.ok(Buffer.from(out.bytes).includes(Buffer.from("안녕")));
    const twice = concat(Uint8Array.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), bytesOf("<html><head></head></html>"));
    assert.deepEqual(
      [...rewriteDocumentBytes(twice, withStudio).bytes.subarray(0, 6)],
      [0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf],
    );
  });

  it("resolves a non-ASCII path in a UTF-8 page once, not once per byte", () => {
    /** What the studio's hook is told the page's own three is: the `real=` it was rewritten to, decoded once. */
    const realOf = (bytes: Uint8Array) =>
      [
        ...Buffer.from(bytes)
          .toString("utf8")
          .matchAll(/real=([^"'&]+)/g),
      ].map((match) => decodeURIComponent(match[1] ?? ""));
    const korean = rewriteDocumentBytes(
      bytesOf(
        '<!doctype html><html><head><script type="importmap">{"imports":{"three":"./라이브러리/three.module.js"}}</script></head><body></body></html>',
      ),
      withStudio,
    );
    assert.deepEqual(realOf(korean.bytes), [
      "project://demo/%EB%9D%BC%EC%9D%B4%EB%B8%8C%EB%9F%AC%EB%A6%AC/three.module.js",
    ]);
    const accented = rewriteDocumentBytes(
      bytesOf(
        '<html><head><script type="module">import * as THREE from "./café/three.module.js";</script></head></html>',
      ),
      withStudio,
    );
    assert.ok(
      realOf(accented.bytes).includes("project://demo/caf%C3%A9/three.module.js"),
      realOf(accented.bytes).join(" "),
    );
  });

  it("leaves a UTF-16 page alone: its bytes are not ASCII, and the studio's tags would break it", () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("<html><head></head></html>", "utf16le")]);
    let asked = false;
    const out = rewriteDocumentBytes(plain(utf16), (html) => {
      asked = true;
      return { html, injected: true };
    });
    assert.equal(asked, false, "the rewriter is not even shown it");
    assert.equal(out.injected, false);
    assert.deepEqual([...out.bytes], [...utf16]);
    const bigEndian = Buffer.from([0xfe, 0xff, 0x00, 0x3c]);
    assert.equal(rewriteDocumentBytes(plain(bigEndian), withStudio).injected, false);
  });

  it("writes an answer that names a character back as UTF-8 for a UTF-8 page, and refuses it for any other", () => {
    const utf8 = bytesOf("<html><head></head><body>x</body></html>");
    const written = rewriteDocumentBytes(utf8, (html) => ({ html: `${html}한`, injected: true }));
    assert.equal(written.injected, true);
    assert.equal(Buffer.from(written.bytes).toString("utf8"), "<html><head></head><body>x</body></html>한");

    const legacy = concat(bytesOf("<html><head></head><body>"), EUC_KR_HELLO, bytesOf("</body></html>"));
    const refused = rewriteDocumentBytes(legacy, (html) => ({ html: `${html}한`, injected: true }));
    assert.equal(refused.injected, false, "a character that is not a byte cannot be written into EUC-KR bytes");
    assert.deepEqual([...refused.bytes], [...legacy]);
  });
});
