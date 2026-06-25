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
// Trailer window: PDFs put the /Encrypt entry in the trailer at the end of the
// file. 8 KiB from the end is plenty to capture it.
const TRAILER_BYTES = 8192;
const BASE64_TRAILER_CHARS = 11000;

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
          // Trim to a multiple of 4 so the decoder doesn't choke on partial groups.
          const content = value.content;
          const headSample = content.slice(0, BASE64_CHARS_TO_READ);
          const headAligned = headSample.slice(0, headSample.length - (headSample.length % 4));
          const magicBytes = decodeBase64(headAligned, HEADER_BYTES);

          // Trailer: the last chunk, starting on a 4-char (3-byte) boundary so the
          // decode stays byte-aligned. Captures the PDF /Encrypt trailer at EOF.
          let trailerBytes: Uint8Array | null = null;
          if (content.length > BASE64_CHARS_TO_READ) {
            let start = Math.max(0, content.length - BASE64_TRAILER_CHARS);
            start += (4 - (start % 4)) % 4; // round up to a 4-char boundary
            trailerBytes = decodeBase64(content.slice(start), TRAILER_BYTES + 16);
          }

          resolve({ magicBytes, trailerBytes });
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      },
    );
  });
}
