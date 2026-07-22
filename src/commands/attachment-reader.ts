// Reads attachments + a header sample for encryption detection.
// Shared between commands.ts (OnSend) and taskpane.ts (manual check).
//
// The header sample is larger than just the magic bytes so Check 1 can:
//   - Parse the ZIP central directory's general-purpose-bit-flag (offset 0x06)
//   - Detect PDF /Encrypt entries that appear in the first few KB

import { AttachmentWithHeader } from "../models/dlp-result.model";

// Self-contained base64 decoder. We avoid the global atob() because Classic
// Outlook's JS-only event runtime (OnMessageSend) does not expose it. Uses
// Buffer when available (Node/tests) and falls back to a pure-JS implementation
// so it runs identically in the taskpane (WebView2) and the send runtime.
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeBase64(input: string, maxBytes: number): Uint8Array {
  if (typeof atob === "function") {
    const decoded = atob(input);
    const len = Math.min(maxBytes, decoded.length);
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = decoded.charCodeAt(i);
    return out;
  }
  if (typeof Buffer !== "undefined") {
    const buf = Buffer.from(input, "base64");
    return new Uint8Array(buf.subarray(0, Math.min(maxBytes, buf.length)));
  }
  // Pure-JS fallback (no atob, no Buffer) — for the JS-only send runtime.
  const lookup = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64_CHARS.length; i++) lookup[B64_CHARS.charCodeAt(i)] = i;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < input.length && out.length < maxBytes; i++) {
    const c = input.charCodeAt(i);
    if (c === 61 /* '=' */) break;
    const val = lookup[c];
    if (val === undefined || val < 0) continue; // skip whitespace/newlines
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

// 4 KiB is enough to (a) match every magic byte we care about, (b) read the
// first ZIP local file header including the general-purpose-bit-flag,
// (c) hit the leading "/Encrypt" reference for most encrypted PDFs.
const HEADER_BYTES = 4096;
// 4 KiB binary = ~5462 base64 chars. We slice a bit more for safety.
const BASE64_CHARS_TO_READ = 5600;
// Trailer window: PDFs put the /Encrypt entry in the trailer at the very end of
// the file (…/Encrypt N 0 R >> startxref … %%EOF). We read the last ~8 KiB.
const BASE64_TRAILER_CHARS = 11000;
// Byte cap when decoding the trailer slice. MUST exceed the max bytes the slice
// can yield (~8.25 KiB from BASE64_TRAILER_CHARS) — decodeBase64 keeps the FIRST
// maxBytes, so a cap below the slice size front-truncates and chops the true EOF
// (this dropped the PDF trailer's /Encrypt and mis-flagged encrypted PDFs as plain).
const TRAILER_DECODE_MAX = 12288;

export async function readAttachmentsWithHeaders(
  item: Office.MessageCompose,
): Promise<AttachmentWithHeader[]> {
  const attachments = await listAttachments(item);
  const enriched = await Promise.all(
    attachments.map(async (att) => {
      const slice = await readContentSlices(item, att.id).catch(() => null);
      return {
        id: att.id,
        name: att.name,
        size: att.size ?? 0,
        isInline: att.isInline ?? false,
        magicBytes: slice?.magicBytes ?? null,
        trailerBytes: slice?.trailerBytes ?? null,
      } satisfies AttachmentWithHeader;
    }),
  );
  return enriched;
}

function listAttachments(item: Office.MessageCompose): Promise<Office.AttachmentDetailsCompose[]> {
  return new Promise((resolve) => {
    if (typeof item.getAttachmentsAsync !== "function") {
      console.warn("[Attachments] getAttachmentsAsync unavailable");
      resolve([]);
      return;
    }
    item.getAttachmentsAsync((result) => {
      if (result.status === Office.AsyncResultStatus.Succeeded) {
        resolve((result.value ?? []) as Office.AttachmentDetailsCompose[]);
      } else {
        console.warn("[Attachments] failed:", result.error);
        resolve([]);
      }
    });
  });
}

interface ContentSlices {
  magicBytes: Uint8Array;
  trailerBytes: Uint8Array | null;
}

// Pure slicing of a base64 attachment into a header sample + an EOF trailer sample.
// Exported so the header/trailer windowing can be unit-tested without Office.js.
export function sliceHeaderAndTrailer(content: string): ContentSlices {
  const headSample = content.slice(0, BASE64_CHARS_TO_READ);
  const headAligned = headSample.slice(0, headSample.length - (headSample.length % 4));
  const magicBytes = decodeBase64(headAligned, HEADER_BYTES);

  // Trailer: the last chunk, starting on a 4-char (3-byte) boundary so the decode
  // stays byte-aligned, and decoded in FULL so it ends exactly at %%EOF. Captures
  // the PDF /Encrypt entry that lives in the last few dozen bytes of the file.
  let trailerBytes: Uint8Array | null = null;
  if (content.length > BASE64_CHARS_TO_READ) {
    let start = Math.max(0, content.length - BASE64_TRAILER_CHARS);
    start += (4 - (start % 4)) % 4; // round up to a 4-char boundary
    trailerBytes = decodeBase64(content.slice(start), TRAILER_DECODE_MAX);
  }
  return { magicBytes, trailerBytes };
}

function readContentSlices(item: Office.MessageCompose, attachmentId: string): Promise<ContentSlices> {
  return new Promise((resolve, reject) => {
    if (typeof item.getAttachmentContentAsync !== "function") {
      reject(new Error("getAttachmentContentAsync not available (mobile?)"));
      return;
    }

    item.getAttachmentContentAsync(
      attachmentId,
      { asyncContext: null },
      (result) => {
        if (result.status !== Office.AsyncResultStatus.Succeeded) {
          reject(new Error(result.error?.message ?? "Failed to read content"));
          return;
        }

        const value = result.value;
        if (value.format !== Office.MailboxEnums.AttachmentContentFormat.Base64) {
          reject(new Error(`Unsupported format: ${value.format}`));
          return;
        }

        try {
          // NOTE: do NOT use atob() here. Classic Outlook's JS-only send runtime
          // (OnMessageSend) has no browser globals, so atob is undefined there and
          // the decode would throw -> magicBytes=null -> Check 1 reports the file
          // "unverifiable" and blocks a properly-encrypted attachment. decodeBase64
          // is self-contained and works in both runtimes.
          resolve(sliceHeaderAndTrailer(value.content));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      },
    );
  });
}
