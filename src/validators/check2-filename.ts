// Check 2: Filename-to-client matching (WARNING only, never blocks).
//
// Token matching uses word boundaries so a customer alias of "CC" doesn't
// accidentally match the filename "account_ccharge_2024.xlsx".

import { Customer, Exemption, Role } from "../models/customer.model";
import { AttachmentWithHeader, CheckResult } from "../models/dlp-result.model";
import { findCustomersInRecipients, getRoleBypass, getUserPermission } from "./shared";

export interface Check2Input {
  attachments: AttachmentWithHeader[];
  recipients: string[];
  userEmail: string;
  customers: Customer[];
  exemptions: Exemption[];
  roles?: Role[];
}

export function runCheck2(input: Check2Input): CheckResult {
  const { attachments, recipients, userEmail, customers, exemptions, roles } = input;

  const permission = getUserPermission(userEmail, exemptions);
  if (permission === "ALL_CHECKS" || permission === "CHECK_2_BYPASS") {
    return pass("המשתמש פטור מבדיקת שם קובץ");
  }

  const roleBypass = getRoleBypass(userEmail, 2, roles);
  if (roleBypass) {
    return pass(`פטור מבדיקת שם קובץ לפי תפקיד: ${roleBypass.roleName}`);
  }

  if (attachments.length === 0) {
    return pass("אין קבצים מצורפים");
  }

  const matched = findCustomersInRecipients(recipients, customers);
  if (matched.length === 0) {
    return pass("לא זוהה לקוח לפי הנמענים");
  }

  // Per-customer coverage: every matched customer should have at least one
  // attachment whose name contains the customer's name or an alias. List the
  // customers with NO matching file as a warning. This catches an email sent to
  // two customers where a file is named for only one of them — the other
  // customer would receive a file that isn't theirs.
  const uncovered: string[] = [];
  for (const c of matched) {
    const tokens = [c.customerName.toLowerCase(), ...c.aliases.map((a) => a.toLowerCase())].filter(
      (t) => t.length > 0,
    );
    const covered = attachments.some((a) => nameMatchesAnyToken(a.name, tokens));
    if (!covered) uncovered.push(c.customerName);
  }

  if (uncovered.length === 0) {
    return pass("✓ שמות הקבצים תואמים את הלקוחות");
  }

  return {
    check: 2,
    isValid: false,
    severity: "WARNING",
    message: `לא נמצא קובץ מצורף התואם ללקוח: ${uncovered.join(", ")}`,
    details: { uncoveredCustomers: uncovered },
  };
}

function nameMatchesAnyToken(name: string, tokens: string[]): boolean {
  const lower = name.toLowerCase();
  // QA fix: prefer substring match. For long tokens (>3 chars) any
  // occurrence counts — "ClientCorpData.xlsx" matches "clientcorp".
  // Short aliases (≤3 chars like "CC", "TS") still require word boundaries
  // to avoid false matches like "CC" inside "account".
  return tokens.some((token) => {
    const idx = lower.indexOf(token);
    if (idx < 0) return false;
    if (token.length > 3) return true;
    const before = idx === 0 ? null : lower.charAt(idx - 1);
    const afterIdx = idx + token.length;
    const after = afterIdx >= lower.length ? null : lower.charAt(afterIdx);
    return isBoundary(before) && isBoundary(after);
  });
}

function isBoundary(ch: string | null): boolean {
  if (ch === null) return true;
  // Letters/digits are NOT boundaries; punctuation, whitespace, and dots are.
  // Includes Hebrew (֐-׿) and Arabic (؀-ۿ) ranges so an
  // alias in those scripts isn't incorrectly bounded.
  return !/[a-z0-9֐-׿؀-ۿ]/.test(ch);
}

function pass(message: string): CheckResult {
  return { check: 2, isValid: true, severity: "INFO", message };
}
