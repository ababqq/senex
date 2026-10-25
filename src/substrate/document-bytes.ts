/**
 * A document the studio adds its tags to, rewritten without touching a byte of it that the studio did not
 * write. The studio reads a page as text to find where its tags go, but a page need not be UTF-8: a Korean
 * or Japanese page from before UTF-8 was the default is EUC-KR or Shift_JIS, and text decoded as UTF-8 and
 * written back as UTF-8 is a different page (every byte that is not UTF-8 became U+FFFD, then the page's own
 * `<meta charset>` was read over bytes that were no longer in that encoding).
 *
 * A page that is valid UTF-8, which is nearly all of them, is shown to the rewriter as the text it is, and
 * written back as UTF-8: that round trip loses nothing, and what the page says (a module path in Korean, a
 * folder named café) is resolved as the characters it names. Any other page is shown as text with one
 * character per byte (U+0000 to U+00FF) and written back as the bytes those characters stand for. Every
 * encoding a page is likely to be in keeps ASCII as ASCII, so the tags the studio looks for and writes (all
 * ASCII) are found and placed the same way whatever the page is written in. A UTF-8 byte order mark is the
 * document's first three bytes either way, and the rewriter does not see it.
 */

/** What a rewriter answers for a document: the text with the studio's tags in it, and whether it added any. */
export interface DocumentRewrite {
  html: string;
  injected: boolean;
}

/** What {@link rewriteDocumentBytes} hands back: the bytes to serve, and whether they carry the studio's tags. */
export interface RewrittenDocument {
  bytes: Uint8Array<ArrayBuffer>;
  injected: boolean;
}

/** The three bytes of a UTF-8 byte order mark. */
const UTF8_BOM = [0xef, 0xbb, 0xbf];

/** A byte order mark of UTF-16 or UTF-32: a document that is not ASCII-compatible, which the studio does not rewrite. */
function isWideDocument(bytes: Uint8Array): boolean {
  const [a, b, c, d] = bytes;
  const utf16 = (a === 0xff && b === 0xfe) || (a === 0xfe && b === 0xff);
  const utf32 =
    (a === 0x00 && b === 0x00 && c === 0xfe && d === 0xff) || (a === 0xff && b === 0xfe && c === 0x00 && d === 0x00);
  return utf16 || utf32;
}

/** Whether the document opens with a UTF-8 byte order mark. */
function hasUtf8Bom(bytes: Uint8Array): boolean {
  return UTF8_BOM.every((byte, at) => bytes[at] === byte);
}

/** The bytes as UTF-8 text, or null when they are not valid UTF-8. */
function bytesAsUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The bytes as text with one character each (U+0000 to U+00FF). */
function bytesAsText(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

/** The bytes a text of one-character bytes stands for, or null when a character is not one. */
function textAsBytes(text: string): Uint8Array<ArrayBuffer> | null {
  for (let at = 0; at < text.length; at++) if (text.charCodeAt(at) > 0xff) return null;
  return new Uint8Array(Buffer.from(text, "latin1"));
}

/** The document the rewriter is shown, and how what it answers is written back. */
interface Reading {
  text: string;
  write: (html: string) => Uint8Array<ArrayBuffer> | null;
}

/** How to show a document without its byte order mark: as UTF-8 text when it is valid UTF-8, else byte for byte. */
function reading(body: Uint8Array): Reading {
  const utf8 = bytesAsUtf8(body);
  if (utf8 !== null) return { text: utf8, write: (html) => new Uint8Array(new TextEncoder().encode(html)) };
  return { text: bytesAsText(body), write: textAsBytes };
}

/**
 * Show `rewrite` the document and write what it answers back as bytes. The original bytes are returned,
 * unchanged, for a document the studio does not rewrite (UTF-16 or UTF-32), for one the rewriter left alone, and
 * for an answer that cannot be written back (a character that is not a byte, in a page that is not UTF-8).
 */
export function rewriteDocumentBytes(
  bytes: Uint8Array<ArrayBuffer>,
  rewrite: (html: string) => DocumentRewrite,
): RewrittenDocument {
  if (isWideDocument(bytes)) return { bytes, injected: false };
  const bom = hasUtf8Bom(bytes) ? bytes.subarray(0, UTF8_BOM.length) : bytes.subarray(0, 0);
  const shown = reading(bytes.subarray(bom.length));
  const result = rewrite(shown.text);
  if (!result.injected) return { bytes, injected: false };
  const written = shown.write(result.html);
  if (!written) return { bytes, injected: false };
  const out = new Uint8Array(bom.length + written.length);
  out.set(bom, 0);
  out.set(written, bom.length);
  return { bytes: out, injected: true };
}
