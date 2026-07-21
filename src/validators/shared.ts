// Helpers shared between Check 1/2/3. Kept here so a new check can reuse them
// without coupling sibling validator files together.

import { Customer, ExcludedRecipient, Exemption, ExemptionType, Role } from "../models/customer.model";
import { INTERNAL_DOMAIN } from "../shared/constants";

export type Permission = ExemptionType | "STANDARD";

function domainOf(email: string): string {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

/**
 * Returns the active "מוחרגים" entry that excludes this recipient from all DLP
 * checks, or null. EMAIL scope matches the exact address; DOMAIN scope matches any
 * address at the entry email's domain. Entries with a past expiryDate are ignored.
 */
export function recipientExclusionMatch(
  recipient: string,
  excluded: ExcludedRecipient[] | undefined | null,
  now: Date = new Date(),
): ExcludedRecipient | null {
  if (!recipient || !Array.isArray(excluded)) return null;
  const target = recipient.toLowerCase();
  const targetDomain = domainOf(recipient);
  return (
    excluded.find((ex) => {
      if (!ex.email) return false;
      if (ex.expiryDate && new Date(ex.expiryDate) < now) return false;
      if (ex.scope === "DOMAIN") {
        // The admin may enter a full email ("x@bigcorp.com") or a bare domain.
        const entryDomain = ex.email.includes("@") ? domainOf(ex.email) : ex.email.toLowerCase();
        return entryDomain !== "" && entryDomain === targetDomain;
      }
      return ex.email.toLowerCase() === target;
    }) ?? null
  );
}

/**
 * True when the email has at least one external recipient and EVERY external
 * recipient is covered by an active exclusion — the condition to skip all DLP.
 * Internal recipients are ignored (they already bypass via the internal fast-path).
 */
export function allExternalRecipientsExcluded(
  recipients: string[],
  excluded: ExcludedRecipient[] | undefined | null,
  now: Date = new Date(),
): boolean {
  const external = recipients.filter((r) => domainOf(r) !== INTERNAL_DOMAIN.toLowerCase());
  if (external.length === 0) return false;
  return external.every((r) => recipientExclusionMatch(r, excluded, now) !== null);
}

/**
 * Returns the ACTIVE role that bypasses the given check for this sender, or null.
 * A role bypasses a check when the sender's email is in `assignedEmails` (exact,
 * case-insensitive) and `checkNumber` is listed in the role's `bypassChecks`.
 * First match wins. Used e.g. by the CFO role to skip encryption (Check 1).
 */
export function getRoleBypass(
  userEmail: string | undefined | null,
  checkNumber: number,
  roles: Role[] | undefined | null,
): Role | null {
  if (!userEmail || !Array.isArray(roles)) return null;
  const target = userEmail.toLowerCase();
  return (
    roles.find(
      (role) =>
        role.active &&
        Array.isArray(role.bypassChecks) &&
        role.bypassChecks.includes(checkNumber) &&
        Array.isArray(role.assignedEmails) &&
        role.assignedEmails.some((e) => e != null && e.toLowerCase() === target),
    ) ?? null
  );
}

/**
 * Resolves the user's exemption permission. Returns "STANDARD" if no active
 * exemption applies. Exemptions with an expired `expiryDate` are ignored.
 */
export function getUserPermission(
  userEmail: string | undefined | null,
  exemptions: Exemption[],
  now: Date = new Date(),
): Permission {
  if (!userEmail) return "STANDARD";
  const target = userEmail.toLowerCase();
  const exemption = exemptions.find(
    (ex) =>
      ex.userEmail != null &&
      ex.userEmail.toLowerCase() === target &&
      (ex.expiryDate === null || new Date(ex.expiryDate) > now),
  );
  return exemption?.exemptionType ?? "STANDARD";
}

/**
 * Returns every ACTIVE customer whose primary or additional domain matches a
 * recipient. De-duplicated by customer id.
 */
export function findCustomersInRecipients(
  recipients: string[],
  customers: Customer[],
): Customer[] {
  const found: Customer[] = [];
  for (const r of recipients) {
    const domain = r.split("@")[1]?.toLowerCase();
    if (!domain) continue;
    // Safeguard: an internal (@INTERNAL_DOMAIN) recipient is never a "customer",
    // even if the internal domain was mistakenly added to a customer's domain
    // list in the knowledge center. Internal recipients must not impose customer
    // requirements (e.g. forcing a customer name into the subject).
    if (domain === INTERNAL_DOMAIN.toLowerCase()) continue;

    for (const c of customers) {
      if (c.status !== "ACTIVE") continue;
      const customerDomains = [
        c.primaryDomain?.toLowerCase(),
        ...c.additionalDomains.map((d) => d.toLowerCase()),
      ].filter(Boolean);

      if (customerDomains.includes(domain) && !found.find((f) => f.id === c.id)) {
        found.push(c);
      }
    }
  }
  return found;
}
