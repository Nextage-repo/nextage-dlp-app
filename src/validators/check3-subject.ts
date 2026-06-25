// Check 3: Subject line + domain validation
// BLOCK: unknown recipient domain OR subject missing identified customer name
// WARNING: advisor-only recipient + subject missing linked customer

import { Advisor, Customer, Exclusion, Exemption } from "../models/customer.model";
import { CheckResult } from "../models/dlp-result.model";
import { INTERNAL_DOMAIN, SAFE_MODE } from "../shared/constants";
import { findCustomersInRecipients, getUserPermission } from "./shared";

export interface Check3Input {
  subject: string;
  recipients: string[];
  userEmail: string;
  customers: Customer[];
  advisors: Advisor[];
  exemptions: Exemption[];
  exclusions: Exclusion[];
}

export function runCheck3(input: Check3Input): CheckResult {
  const { subject, recipients, userEmail, customers, advisors, exemptions, exclusions } = input;

  const permission = getUserPermission(userEmail, exemptions);
  if (permission === "ALL_CHECKS" || permission === "CHECK_3_BYPASS") {
    return pass("המשתמש פטור מבדיקת נושא");
  }

  // Internal-only emails skip all subject checks
  if (recipients.length > 0 && recipients.every((r) => r.toLowerCase().endsWith(`@${INTERNAL_DOMAIN}`))) {
    return pass("מייל פנימי - אין בדיקת נושא");
  }

  // 1. Unknown domain check — WARNING only (alert the user). An unknown domain no
  // longer hard-blocks on its own; if there's an unencrypted attachment, Check 1
  // still blocks the send. So: unknown domain + encrypted/no file -> warning prompt
  // (Send Anyway / Don't Send); unknown domain + unencrypted file -> hard block.
  const unknownDomains = findUnknownDomains(recipients, customers, advisors, exclusions);
  if (unknownDomains.length > 0) {
    return {
      check: 3,
      isValid: false,
      severity: "WARNING",
      message: `דומיין לא מוכר: ${unknownDomains.join(", ")}. ודא שהקבצים מוצפנים לפני שליחה.`,
      details: { unknownDomains },
    };
  }

  const matchedCustomers = findCustomersInRecipients(recipients, customers);
  const matchedAdvisors = findAdvisorsInRecipients(recipients, advisors);

  if (matchedCustomers.length === 0 && matchedAdvisors.length === 0) {
    return pass("לא זוהו לקוחות או יועצים");
  }

  // 2. Customer found — subject MUST contain each customer's name or alias
  if (matchedCustomers.length > 0) {
    const subjectLower = subject.toLowerCase();
    const missing: string[] = [];

    for (const c of matchedCustomers) {
      const tokens = [c.customerName.toLowerCase(), ...c.aliases.map((a) => a.toLowerCase())];
      const found = tokens.some((t) => subjectLower.includes(t));
      if (!found) missing.push(c.customerName);
    }

    if (missing.length > 0) {
      const severity = SAFE_MODE ? "WARNING" : "BLOCK";
      const note = SAFE_MODE ? " (Safe Mode)" : "";
      return {
        check: 3,
        isValid: false,
        severity,
        message: `ה-Subject חייב להכיל את שם הלקוח: ${missing.join(", ")}${note}`,
        details: { missingCustomers: missing },
      };
    }

    return pass("✓ הנושא תואם את הלקוח");
  }

  // 3. Advisor-only — recommend linked customer name (WARNING)
  if (matchedAdvisors.length > 0) {
    const linkedSearchTokens = new Set<string>();
    const linkedDisplayNames = new Set<string>();

    matchedAdvisors.forEach((a) => {
      a.linkedCustomers.forEach((custRef) => {
        // Match by id OR by customerName (our DB stores names, not IDs)
        const customer = customers.find(
          (c) => c.id === custRef.trim() || c.customerName.toLowerCase() === custRef.trim().toLowerCase()
        );
        if (customer) {
          linkedDisplayNames.add(customer.customerName);
          linkedSearchTokens.add(customer.customerName.toLowerCase());
          customer.aliases.forEach((alias) => linkedSearchTokens.add(alias.toLowerCase()));
        } else {
          // Fallback: use the raw value as a search token
          linkedDisplayNames.add(custRef.trim());
          linkedSearchTokens.add(custRef.trim().toLowerCase());
        }
      });
    });

    if (linkedSearchTokens.size > 0) {
      const subjectLower = subject.toLowerCase();
      const found = Array.from(linkedSearchTokens).some((t) => subjectLower.includes(t));

      if (!found) {
        return {
          check: 3,
          isValid: false,
          severity: "WARNING",
          message: `מומלץ להוסיף שם לקוח: ${Array.from(linkedDisplayNames).join(", ")}`,
        };
      }
    }

    return pass("✓ זוהה יועץ ידוע");
  }

  return pass("✓ הנושא תקין");
}

function findAdvisorsInRecipients(recipients: string[], advisors: Advisor[]): Advisor[] {
  const found: Advisor[] = [];
  for (const r of recipients) {
    const domain = r.split("@")[1]?.toLowerCase();
    if (!domain) continue;

    for (const a of advisors) {
      if (a.status !== "ACTIVE") continue;
      if (a.emailDomain.toLowerCase() === domain && !found.find((f) => f.id === a.id)) {
        found.push(a);
      }
    }
  }
  return found;
}

function findUnknownDomains(
  recipients: string[],
  customers: Customer[],
  advisors: Advisor[],
  exclusions: Exclusion[],
): string[] {
  const known = new Set<string>([INTERNAL_DOMAIN.toLowerCase()]);

  customers.forEach((c) => {
    if (c.primaryDomain) known.add(c.primaryDomain.toLowerCase());
    c.additionalDomains.forEach((d) => known.add(d.toLowerCase()));
  });
  advisors.forEach((a) => {
    if (a.emailDomain) known.add(a.emailDomain.toLowerCase());
  });
  exclusions.forEach((ex) => {
    if (ex.domainPattern) known.add(ex.domainPattern.toLowerCase());
  });

  const unknown = new Set<string>();
  for (const r of recipients) {
    const domain = r.split("@")[1]?.toLowerCase();
    if (!domain) continue;
    if (!known.has(domain)) unknown.add(domain);
  }
  return Array.from(unknown);
}

function pass(message: string): CheckResult {
  return { check: 3, isValid: true, severity: "INFO", message };
}
