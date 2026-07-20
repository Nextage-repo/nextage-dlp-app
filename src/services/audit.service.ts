// Writes audit log entries to Azure Functions proxy. Fire-and-forget; never blocks send.

import { AuditAction, AuditEntry, AuditResult } from "../models/audit.model";
import { DLPResult, EmailData } from "../models/dlp-result.model";
import { API_BASE_URL, API_TIMEOUT_MS, AUDIT_TTL_SECONDS } from "../shared/constants";
import { postJson } from "../shared/http";
import { createId } from "../shared/id";

export class AuditService {
  constructor(private readonly accessToken: string) {}

  // Returns a promise that resolves once all entries have been POSTed. The OnSend
  // caller MUST await this before event.completed(): Classic Outlook's JS-only send
  // runtime tears down after event.completed() and kills any in-flight request, so a
  // fire-and-forget write never reaches the server. Never rejects (uses allSettled).
  async writeAudit(email: EmailData, result: DLPResult): Promise<void> {
    const entries = this.buildEntries(email, result);
    const outcomes = await Promise.allSettled(entries.map((entry) => this.postEntry(entry)));
    outcomes.forEach((o) => {
      if (o.status === "rejected") console.warn("[Audit] write failed:", o.reason);
    });
  }

  async recordUnavailable(reason: string, partialEmail?: Partial<EmailData>): Promise<void> {
    const entry: AuditEntry = {
      id: createId(),
      partitionKey: partialEmail?.userEmail ?? "unknown",
      timestamp: new Date().toISOString(),
      userEmail: partialEmail?.userEmail ?? "unknown",
      action: "DLP_UNAVAILABLE",
      checkNumber: 0,
      result: "FAILED",
      recipientEmails: partialEmail?.recipients ?? [],
      attachmentNames: (partialEmail?.attachments ?? []).map((a) => a.name),
      messageSubject: partialEmail?.subject ?? "",
      severity: "BLOCK",
      ttl: AUDIT_TTL_SECONDS,
    };

    await this.postEntry({ ...entry, details: { reason } } as AuditEntry & { details: { reason: string } })
      .catch((err) => console.warn("[Audit] unavailable-event write failed:", err));
  }

  // Logs a "חוקים" encryption exemption: the subject matched a rule expression,
  // so Check 1 (encryption) was skipped for this email.
  async recordExemption(email: EmailData, expression: string): Promise<void> {
    const entry: AuditEntry = {
      id: createId(),
      partitionKey: email.userEmail,
      timestamp: new Date().toISOString(),
      userEmail: email.userEmail,
      action: "EXEMPTION_APPLIED",
      checkNumber: 1,
      result: "EXEMPTED",
      recipientEmails: email.recipients,
      attachmentNames: email.attachments.map((a) => a.name),
      messageSubject: email.subject,
      severity: "INFO",
      ttl: AUDIT_TTL_SECONDS,
    };
    // `data` is what the server persists (JSONB) — include the matched expression.
    await this.postEntry({
      ...entry,
      data: { type: "ENCRYPTION_EXEMPT", expression, subject: email.subject, recipients: email.recipients },
    } as AuditEntry & { data: unknown })
      .catch((err) => console.warn("[Audit] exemption write failed:", err));
  }

  private buildEntries(email: EmailData, result: DLPResult): AuditEntry[] {
    const baseEntry = {
      partitionKey: email.userEmail,
      timestamp: new Date().toISOString(),
      userEmail: email.userEmail,
      recipientEmails: email.recipients,
      attachmentNames: email.attachments.map((a) => a.name),
      messageSubject: email.subject,
      ttl: AUDIT_TTL_SECONDS,
    };

    return result.results
      .filter((r) => !r.isValid)
      .map((r) => ({
        ...baseEntry,
        id: createId(),
        action: this.mapAction(r.severity, result.shouldBlock),
        checkNumber: r.check,
        result: this.mapResult(r.severity),
        severity: r.severity,
      }));
  }

  private mapAction(severity: string, blocked: boolean): AuditAction {
    if (severity === "BLOCK" && blocked) return "SEND_BLOCKED";
    if (severity === "BLOCK") return "WARNING_SHOWN";
    if (severity === "WARNING") return "WARNING_SHOWN";
    return "SEND_ALLOWED";
  }

  private mapResult(severity: string): AuditResult {
    switch (severity) {
      case "BLOCK":
        return "FAILED";
      case "WARNING":
        return "WARNED";
      default:
        return "PASSED";
    }
  }

  private async postEntry(entry: AuditEntry): Promise<void> {
    // Use text/plain (a CORS "simple" content type) and no Authorization header
    // so the POST skips the preflight OPTIONS. Classic Outlook's JS-only runtime
    // cannot complete a preflight. The server's body parser is configured to parse
    // text/plain as JSON (express.json({ type: [...] })), so the entry is persisted.
    void this.accessToken;
    await postJson(`${API_BASE_URL}/audit`, { "Content-Type": "text/plain" }, entry, API_TIMEOUT_MS);
  }
}
