// DLPValidator — orchestrates the 3 DLP checks and produces an aggregate result.

import { DLPConfig } from "../models/customer.model";
import { CheckResult, DLPResult, EmailData } from "../models/dlp-result.model";
import { SAFE_MODE } from "../shared/constants";
import { runCheck1 } from "./check1-encryption";
import { runCheck2 } from "./check2-filename";
import { runCheck3 } from "./check3-subject";
import { allExternalRecipientsExcluded } from "./shared";

export interface ValidatorOptions {
  /**
   * Unknown domains as determined by POST /api/resolve. Required once the add-in
   * stops receiving the full customer roster, because it can no longer work this
   * out locally.
   */
  unknownDomains?: string[];
  /**
   * Set when /api/resolve could not be reached. Checks 2 and 3 depend on
   * recipient-scoped data that only the server holds, so they cannot run; check 1
   * (encryption) uses cached global lists and still runs, and still blocks.
   * Two WARNING results are added so the user is told which checks were skipped
   * rather than being left to assume everything passed.
   */
  degraded?: boolean;
}

export class DLPValidator {
  constructor(
    private readonly config: DLPConfig,
    private readonly options: ValidatorOptions = {},
  ) {}

  async runAllChecks(email: EmailData): Promise<DLPResult> {
    // Addressed only to internal distribution groups. Those carry no SMTP address,
    // so `recipients` is empty even though the mail has recipients — treat it as the
    // internal mail it is instead of reporting "no recipients" three times.
    if (email.recipients.length === 0 && (email.groupRecipients?.length ?? 0) > 0) {
      const internal: CheckResult = {
        check: 1,
        isValid: true,
        severity: "INFO",
        message: "קבוצת תפוצה פנימית — לא נדרשות בדיקות DLP",
      };
      return {
        results: [internal, { ...internal, check: 2 }, { ...internal, check: 3 }],
        hasBlock: false,
        hasWarning: false,
        shouldBlock: false,
      };
    }

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

    if (this.options.degraded) {
      const unavailable = (check: 2 | 3, what: string): CheckResult => ({
        check,
        isValid: false,
        severity: "WARNING",
        message: `${what} לא בוצעה — השרת אינו זמין. יש לוודא ידנית לפני השליחה.`,
        details: { reason: "resolve-unavailable" },
      });

      const degradedResults = [
        check1,
        unavailable(2, "בדיקת שם הקובץ"),
        unavailable(3, "בדיקת נושא ודומיין"),
      ];
      const degradedBlock = degradedResults.some((r) => r.severity === "BLOCK");
      return {
        results: degradedResults,
        hasBlock: degradedBlock,
        hasWarning: true,
        shouldBlock: degradedBlock && !SAFE_MODE,
      };
    }

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
      unknownDomainsOverride: this.options.unknownDomains,
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
