// DLPValidator — orchestrates the 3 DLP checks and produces an aggregate result.

import { DLPConfig } from "../models/customer.model";
import { CheckResult, DLPResult, EmailData } from "../models/dlp-result.model";
import { SAFE_MODE } from "../shared/constants";
import { runCheck1 } from "./check1-encryption";
import { runCheck2 } from "./check2-filename";
import { runCheck3 } from "./check3-subject";
import { allExternalRecipientsExcluded } from "./shared";

export class DLPValidator {
  constructor(private readonly config: DLPConfig) {}

  async runAllChecks(email: EmailData): Promise<DLPResult> {
    // Empty recipients guard (Outlook returns [] when user hasn't pressed Tab)
    if (email.recipients.length === 0) {
      const empty: CheckResult = {
        check: 1,
        isValid: false,
        severity: "WARNING",
        message: "אין נמענים - הקלד נמען ולחץ Tab או Enter לאישור",
      };
      return {
        results: [empty, { ...empty, check: 2 }, { ...empty, check: 3 }],
        hasBlock: false,
        hasWarning: true,
        shouldBlock: false,
      };
    }

    // "מוחרגים" — if every external recipient is a trusted excluded address/domain,
    // skip ALL DLP checks. A mixed send that also reaches a non-excluded external
    // recipient still runs normally (one whitelisted address can't cover the rest).
    if (allExternalRecipientsExcluded(email.recipients, this.config.excludedRecipients)) {
      const skipped: CheckResult = {
        check: 1,
        isValid: true,
        severity: "INFO",
        message: "נמען מוחרג — לא בוצעו בדיקות DLP",
      };
      return {
        results: [skipped, { ...skipped, check: 2 }, { ...skipped, check: 3 }],
        hasBlock: false,
        hasWarning: false,
        shouldBlock: false,
      };
    }

    const check1 = runCheck1({
      attachments: email.attachments,
      recipients: email.recipients,
      userEmail: email.userEmail,
      exclusions: this.config.exclusions,
      exemptions: this.config.exemptions,
      subject: email.subject,
      rules: this.config.rules,
      roles: this.config.roles,
      encryptionKeywords: this.config.encryptionKeywords,
    });

    const check2 = runCheck2({
      attachments: email.attachments,
      recipients: email.recipients,
      userEmail: email.userEmail,
      customers: this.config.customers,
      exemptions: this.config.exemptions,
      roles: this.config.roles,
    });

    const check3 = runCheck3({
      subject: email.subject,
      recipients: email.recipients,
      userEmail: email.userEmail,
      customers: this.config.customers,
      advisors: this.config.advisors,
      exemptions: this.config.exemptions,
      exclusions: this.config.exclusions,
      roles: this.config.roles,
      excludedRecipients: this.config.excludedRecipients,
    });

    const results = [check1, check2, check3];
    const hasBlock = results.some((r) => r.severity === "BLOCK");
    const hasWarning = results.some((r) => r.severity === "WARNING");

    return {
      results,
      hasBlock,
      hasWarning,
      // In Safe Mode, BLOCK is shown red but does not actually block send.
      shouldBlock: hasBlock && !SAFE_MODE,
    };
  }
}

export { SAFE_MODE };
