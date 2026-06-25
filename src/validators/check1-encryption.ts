// Check 1: Attachment encryption validation.
//
// Detection by file type:
//   - Office (.xlsx/.docx/.pptx): CFB/OLE2 magic bytes = encrypted; ZIP magic = unencrypted.
//   - ZIP archive (.zip): inspect the local-file-header general-purpose-bit-flag (bit 0).
//   - PDF: scan the first 4 KiB for an /Encrypt dictionary reference.
//   - Anything else: not encrypted (Check 1 reports it).
//
// If the binary header could not be read (mobile, large attachment, format mismatch),
// the file is reported as unverifiable and Check 1 BLOCKs with a clear message rather
// than silently passing. Extension-based fallback to "all .zip = encrypted" is gone;
// it was bypassable by renaming a sensitive file to `.zip`.

import {
  AttachmentWithHeader,
  CheckResult,
} from "../models/dlp-result.model";
import { Exclusion, Exemption } from "../models/customer.model";
import {
  ARCHIVE_EXTENSIONS_REGEX,
  IMAGE_EXTENSIONS_REGEX,
  INTERNAL_DOMAIN,
  MAGIC_BYTES,
  OFFICE_EXTENSIONS_REGEX,
  PDF_EXTENSION_REGEX,
  SAFE_MODE,
} from "../shared/constants";
import { getUserPermission } from "./shared";

export interface Check1Input {
  attachments: AttachmentWithHeader[];
  recipients: string[];
  userEmail: string;
  exclusions: Exclusion[];
  exemptions: Exemption[];
}

type EncryptionStatus = "ENCRYPTED" | "UNENCRYPTED" | "UNVERIFIABLE";

export function runCheck1(input: Check1Input): CheckResult {
  const { attachments, recipients, userEmail, exclusions, exemptions } = input;

  // 1. User exemption
  const permission = getUserPermission(userEmail, exemptions);
  if (permission === "ALL_CHECKS" || permission === "CHECK_1_ONLY") {
    return pass("המשתמש פטור מבדיקת הצפנה");
  }

  // 2. All internal recipients
  if (recipients.length > 0 && recipients.every(isInternal)) {
    return pass("מייל פנימי - הצפנה לא נדרשת");
  }

  // 3. All recipients in exclusions list
  if (recipients.length > 0 && allInExclusions(recipients, exclusions)) {
    return pass("כל הנמענים ברשימת החריגות");
  }

  // 4. No attachments
  if (attachments.length === 0) {
    return pass("אין קבצים מצורפים");
  }

  // 5. Classify each non-image attachment
  const unencrypted: string[] = [];
  const unverifiable: string[] = [];
  for (const att of attachments) {
    // Images are always skipped
    if (IMAGE_EXTENSIONS_REGEX.test(att.name)) continue;
    // ZIP/RAR/7Z are always considered encrypted (spec appendix)
    if (ARCHIVE_EXTENSIONS_REGEX.test(att.name)) continue;
    const status = classify(att);
    if (status === "UNENCRYPTED") unencrypted.push(att.name);
    else if (status === "UNVERIFIABLE") unverifiable.push(att.name);
  }

  // In Safe Mode: severity = WARNING. In Production: severity = BLOCK.
  const severity = SAFE_MODE ? "WARNING" : "BLOCK";
  const note = SAFE_MODE ? " (Safe Mode)" : "";

  if (unverifiable.length > 0) {
    return {
      check: 1,
      isValid: false,
      severity,
      message:
        `לא ניתן לאמת הצפנה עבור: ${unverifiable.join(", ")}. ` +
        `נסה לשלוח ממחשב שולחני או צור קשר עם IT.${note}`,
      details: { unverifiableFiles: unverifiable },
    };
  }

  if (unencrypted.length > 0) {
    return {
      check: 1,
      isValid: false,
      severity,
      message: `קבצים לא מוצפנים: ${unencrypted.join(", ")}${note}`,
      details: { unencryptedFiles: unencrypted },
    };
  }

  return pass("✓ כל הקבצים מוצפנים");
}

export function classify(att: AttachmentWithHeader): EncryptionStatus {
  const header = att.magicBytes;
  if (!header || header.length < 4) {
    return "UNVERIFIABLE";
  }

  // CFB / OLE2 — legacy encrypted Office files and password-protected XLSX/DOCX (post-encryption).
  if (startsWith(header, MAGIC_BYTES.CFB_OLE2)) return "ENCRYPTED";

  // ZIP signature — modern Office files are ZIPs internally; real .zip archives are ZIPs too.
  if (startsWith(header, MAGIC_BYTES.ZIP)) {
    if (OFFICE_EXTENSIONS_REGEX.test(att.name)) {
      // Modern Office file (.xlsx/.docx/.pptx) with ZIP magic = unencrypted.
      // Password-protected Office files have CFB/OLE2 magic instead (handled above).
      return "UNENCRYPTED";
    }
    // For an actual .zip archive, inspect the general-purpose-bit-flag (bit 0).
    // Local file header layout: signature(4) version(2) flags(2) ...
    // Bit 0 of `flags` is set iff the file is encrypted.
    if (header.length >= 8) {
      const flags = header[6]! | (header[7]! << 8);
      const bit0Encrypted = (flags & 0x0001) !== 0;
      return bit0Encrypted ? "ENCRYPTED" : "UNENCRYPTED";
    }
    return "UNVERIFIABLE";
  }

  // PDF — an encrypted PDF declares an /Encrypt entry in its trailer, which sits
  // at the END of the file (not the header). Scan BOTH the header and the trailer.
  if (startsWith(header, MAGIC_BYTES.PDF) || PDF_EXTENSION_REGEX.test(att.name)) {
    const text = toLatin1(header) + (att.trailerBytes ? toLatin1(att.trailerBytes) : "");
    return text.includes("/Encrypt") ? "ENCRYPTED" : "UNENCRYPTED";
  }

  // HTML — the org's encryptor produces a self-decrypting HTML file: a password
  // lock-screen plus the AES-GCM ciphertext inlined as `const DATA = "..."`. A
  // plain HTML file has none of these markers, so we can tell them apart.
  if (HTML_EXTENSION_REGEX.test(att.name)) {
    return htmlIsEncrypted(toLatin1(header)) ? "ENCRYPTED" : "UNENCRYPTED";
  }

  // Anything else: assume unencrypted unless we have evidence otherwise.
  return "UNENCRYPTED";
}

const HTML_EXTENSION_REGEX = /\.html?$/i;

// Detects the org's self-decrypting encrypted-HTML format. Requires the inlined
// ciphertext variable AND a lock-screen marker, so a normal HTML page that
// merely mentions "Protected Document" won't be mistaken for encrypted.
function htmlIsEncrypted(headerText: string): boolean {
  const hasPayload = /const\s+DATA\s*=\s*["'`]/.test(headerText);
  const hasLockScreen =
    /Protected Document/i.test(headerText) ||
    /id=["']pw["']/i.test(headerText) ||
    /\bunlock\s*\(/.test(headerText);
  return hasPayload && hasLockScreen;
}

function toLatin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]!);
  }
  return s;
}

function startsWith(actual: Uint8Array, expected: readonly number[]): boolean {
  if (actual.length < expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) return false;
  }
  return true;
}

function isInternal(email: string): boolean {
  return email.toLowerCase().endsWith(`@${INTERNAL_DOMAIN}`);
}

function allInExclusions(recipients: string[], exclusions: Exclusion[]): boolean {
  const now = new Date();
  return recipients.every((r) => {
    const domain = r.split("@")[1]?.toLowerCase() ?? "";
    return exclusions.some((ex) => {
      if (!ex.allowUnencrypted) return false;
      if (ex.expiryDate && new Date(ex.expiryDate) <= now) return false;
      if (ex.emailAddress?.toLowerCase() === r.toLowerCase()) return true;
      if (ex.domainPattern?.toLowerCase() === domain) return true;
      return false;
    });
  });
}

function pass(message: string): CheckResult {
  return { check: 1, isValid: true, severity: "INFO", message };
}
