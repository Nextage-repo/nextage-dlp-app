// "חוקים" (Rules) — subject-based encryption exemption.
//
// If the outgoing email's subject CONTAINS any active rule expression
// (case-insensitive substring — not exact match), the encryption check (Check 1)
// is skipped for that email. Filename (Check 2) and subject/domain (Check 3) still run.
//
// Fail-safe: if there are no rules (e.g. the config fetch failed), no exemption is
// applied and the encryption rule runs as normal.

import { Rule } from "../models/customer.model";

/**
 * Returns the first active rule whose expression is a case-insensitive substring
 * of `subject`, or null if none match.
 */
export function findEncryptionExemption(subject: string, rules: Rule[] | undefined | null): Rule | null {
  if (!subject || !Array.isArray(rules) || rules.length === 0) return null;
  const subjectLower = subject.toLowerCase();
  for (const rule of rules) {
    if (!rule.active) continue;
    const expr = rule.expression?.trim().toLowerCase();
    if (expr && subjectLower.includes(expr)) return rule;
  }
  return null;
}

/** Convenience boolean form. */
export function isEncryptionExempt(subject: string, rules: Rule[] | undefined | null): boolean {
  return findEncryptionExemption(subject, rules) !== null;
}
