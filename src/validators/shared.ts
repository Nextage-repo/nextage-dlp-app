// Helpers shared between Check 1/2/3. Kept here so a new check can reuse them
// without coupling sibling validator files together.

import { Customer, Exemption, ExemptionType } from "../models/customer.model";
import { INTERNAL_DOMAIN } from "../shared/constants";

export type Permission = ExemptionType | "STANDARD";

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
