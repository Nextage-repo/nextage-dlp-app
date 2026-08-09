// Audit log entry — written to Cosmos DB container dlp-audit-log

export type AuditAction =
  | "SEND_BLOCKED"
  | "SEND_ALLOWED"
  | "WARNING_SHOWN"
  | "EXEMPTION_APPLIED"
  | "MANUAL_CHECK"
  | "DLP_UNAVAILABLE";

export type AuditResult = "PASSED" | "FAILED" | "WARNED" | "EXEMPTED";

export interface AuditEntry {
  id: string;
  partitionKey: string; // userEmail
  timestamp: string;
  userEmail: string;
  action: AuditAction;
  checkNumber: 1 | 2 | 3 | 0; // 0 = aggregate event
  // The exact text shown to the user in the block/warning prompt — the popup is
  // built from the same CheckResult.message, so the log matches what they saw.
  message?: string;
  result: AuditResult;
  recipientEmails: string[];
  attachmentNames: string[];
  messageSubject: string;
  severity: "BLOCK" | "WARNING" | "INFO";
  ttl: number; // seconds — 90 days default
}
