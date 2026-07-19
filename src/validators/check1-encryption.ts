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
import { Exclusion, Exemption, Role, Rule } from "../models/customer.model";
import {
  ARCHIVE_EXTENSIONS_REGEX,
  IMAGE_EXTENSIONS_REGEX,
  INTERNAL_DOMAIN,
  MAGIC_BYTES,
  OFFICE_EXTENSIONS_REGEX,
  PDF_EXTENSION_REGEX,
  SAFE_MODE,
  TEXT_EXTENSIONS_REGEX,
} from "../shared/constants";
import { getRoleBypass, getUserPermission } from "./shared";
import { findEncryptionExemption } from "./rules-exemption";

export interface Check1Input {
  attachments: AttachmentWithHeader[];
  recipients: string[];
  userEmail: string;
  exclusions: Exclusion[];
  exemptions: Exemption[];
  subject: string;
  rules: Rule[];
  roles?: Role[];
}

type EncryptionStatus = "ENCRYPTED" | "UNENCRYPTED" | "UNVERIFIABLE";

export function runCheck1(input: Check1Input): CheckResult {
  const { attachments, recipients, userEmail, exclusions, exemptions, subject, rules, roles } = input;

  // 1. User exemption
  const permission = getUserPermission(userEmail, exemptions);
  if (permission === "ALL_CHECKS" || permission === "CHECK_1_ONLY") {
    return pass("המשתמש פטור מבדיקת הצפנה");
  }

  // 1b. Role bypass (e.g. CFO): the sender's role skips the encryption check.
  const roleBypass = getRoleBypass(userEmail, 1, roles);
  if (roleBypass) {
    return pass(`פטור מהצפנה לפי תפקיד: ${roleBypass.roleName}`);
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

  // 5. Subject-based encryption exemption ("חוקים"): if the subject contains an
  // active rule expression, skip ONLY the encryption check. Checks 2 & 3 still run.
  const exemptRule = findEncryptionExemption(subject, rules);
  if (exemptRule) {
    return {
      check: 1,
      isValid: true,
      severity: "INFO",
      message: `פטור מהצפנה לפי חוק: «${exemptRule.expression}»`,
      details: { encryptionExemptExpression: exemptRule.expression, ruleId: exemptRule.id },
    };
  }

  // 5. Classify each non-image attachment
  const unencrypted: string[] = [];
  const unverifiable: string[] = [];
  for (const att of attachments) {
    // Images are always skipped
    if (IMAGE_EXTENSIONS_REGEX.test(att.name)) continue;
    // Plain text never requires encryption
    if (TEXT_EXTENSIONS_REGEX.test(att.name)) continue;
    // RAR/7Z are always considered encrypted (no detection implemented yet).
    // .zip is NOT skipped here — classify() inspects its real encryption bit.
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
        `צור קשר עם IT.${note}`,
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
  // lock-screen template plus the AES-GCM ciphertext inlined as `const DATA`. A
  // plain HTML file has none of these markers, so we can tell them apart.
  if (HTML_EXTENSION_REGEX.test(att.name)) {
    const headerText = toLatin1(header);
    const trailerText = att.trailerBytes ? toLatin1(att.trailerBytes) : "";
    return htmlIsEncrypted(headerText, trailerText) ? "ENCRYPTED" : "UNENCRYPTED";
  }

  // Anything else: assume unencrypted unless we have evidence otherwise.
  return "UNENCRYPTED";
}

const HTML_EXTENSION_REGEX = /\.html?$/i;

// Detects the org's self-decrypting encrypted-HTML format.
//
// The template always opens with <title>Protected Document</title> and a fixed
// lock-screen <style> block (in the first 4 KB), then inlines the AES-GCM
// ciphertext as `const DATA = "..."` followed by the crypto.subtle decryption
// code near the END of the file. A large inlined logo image can push the payload
// and password input past the 4 KB header window, so we must NOT rely on those
// alone — we gate on the template title plus ANY corroborating signal found in
// the header OR the trailer.
function htmlIsEncrypted(headerText: string, trailerText: string): boolean {
  // Must be the encryptor's lock-screen template.
  if (!/Protected Document/i.test(headerText)) return false;

  const combined = headerText + "\n" + trailerText;
  // Lock-screen CSS tokens live in the top <style> block — always within the
  // first 4 KB, before any inlined image.
  const cssTokens = ["body.viewing", ".prog-bar", ".prog-text", ".pw-row", ".eye"];
  const cssHits = cssTokens.reduce((n, t) => (headerText.includes(t) ? n + 1 : n), 0);
  const hasPayload = /const\s+DATA\s*=\s*["'`]/.test(combined);
  const hasCrypto =
    /crypto\.subtle/.test(combined) || /AES-GCM/.test(combined) || /PBKDF2/.test(combined);
  const hasLock = /id=["']pw["']/i.test(combined) || /\bunlock\s*\(/.test(combined);

  // Title + at least one technical/structural signal => the org's encrypted HTML.
  return cssHits >= 2 || hasPayload || hasCrypto || hasLock;
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
