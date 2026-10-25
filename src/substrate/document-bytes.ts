/**
 * A document the studio adds its tags to, rewritten without touching a byte of it that the studio did not
 * write. The studio reads a page as text to find where its tags go, but a page need not be UTF-8: a Korean
 * or Japanese page from before UTF-8 was the default is EUC-KR or Shift_JIS, and text decoded as UTF-8 and
 * written back as UTF-8 is a different page (every byte that is not UTF-8 became U+FFFD, then the page's own
 * `<meta charset>` was read over bytes that were no longer in that encoding). So the text the rewriter sees
 * holds each byte as one character, U+0000 to U+00FF, and what it returns is written back byte for byte.
 * Every encoding a page is likely to be in keeps ASCII as ASCII, so the tags the studio looks for and writes
 * (all ASCII) are found and placed the same way whatever the page is written in.
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

/** A byte order mark of UTF-16 or UTF-32: a document that is not ASCII-compatible, which the studio does not rewrite. */
function isWideDocument(bytes: Uint8Array): boolean {
  const [a, b, c, d] = bytes;
  const utf16 = (a === 0xff && b === 0xfe) || (a === 0xfe && b === 0xff);
  const utf32 =
    (a === 0x00 && b === 0x00 && c === 0xfe && d === 0xff) || (a === 0xff && b === 0xfe && c === 0x00 && d === 0x00);
  return utf16 || utf32;
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

/**
 * Show `rewrite` the document as text of one-character bytes and write what it answers back as the bytes
 * they stand for. The original bytes are returned, unchanged, for a document the studio does not rewrite (UTF-16
 * or UTF-32), for one the rewriter left alone, and for an answer that holds a character that is not a byte.
 */
export function rewriteDocumentBytes(
  bytes: Uint8Array<ArrayBuffer>,
  rewrite: (html: string) => DocumentRewrite,
): RewrittenDocument {
  if (isWideDocument(bytes)) return { bytes, injected: false };
  const result = rewrite(bytesAsText(bytes));
  if (!result.injected) return { bytes, injected: false };
  const rewritten = textAsBytes(result.html);
  return rewritten ? { bytes: rewritten, injected: true } : { bytes, injected: false };
}
