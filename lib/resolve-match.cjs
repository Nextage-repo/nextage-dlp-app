// Recipient→customer matching for POST /api/resolve.
//
// These rules MIRROR src/shared/constants.ts and src/validators/shared.ts. They
// live in their own module for one reason: inline in server.cjs they could not be
// unit-tested, and a silent divergence from the client's rules shows up as a wrong
// "unknown domain" warning — or, worse, a missing one. If the client's rules
// change, change them here and update tests/resolve-match.test.ts.
const INTERNAL_DOMAIN = "nextage.co.il";
const SHARED_INBOX_DOMAINS = ["dokka.co.il"];

const lower = (s) => String(s == null ? "" : s).trim().toLowerCase();
const domainOf = (addr) => lower(addr).split("@")[1] || "";

// A Dokka inbox is listed by FULL address, so it is compared as an address.
// Matching on its domain alone would tie every Dokka customer to one domain.
const isSharedInboxEntry = (entry) =>
  lower(entry).includes("@") && SHARED_INBOX_DOMAINS.includes(domainOf(entry));

const additionalDomainMatches = (entry, recipient) => {
  const e = lower(entry);
  if (!e) return false;
  return isSharedInboxEntry(e) ? e === lower(recipient) : e === domainOf(recipient);
};

// Customers whose primary or additional domain matches at least one recipient.
// Returns the full records: the add-in's own matching stays authoritative, and
// this only narrows what it has to look at.
function matchCustomers(customers, recipients) {
  return customers.filter((c) =>
    recipients.some(
      (r) =>
        (c.primary_domain && lower(c.primary_domain) === domainOf(r)) ||
        (Array.isArray(c.domains) && c.domains.some((d) => additionalDomainMatches(d, r))),
    ),
  );
}

// The internal domain, every customer domain, and every advisor's domain.
// Shared-inbox entries are known by full address, so they are kept separately.
function buildKnown(customers, advisors) {
  const domains = new Set([INTERNAL_DOMAIN]);
  const addresses = new Set();
  for (const c of customers) {
    if (c.primary_domain) domains.add(lower(c.primary_domain));
    for (const d of Array.isArray(c.domains) ? c.domains : []) {
      const e = lower(d);
      if (!e) continue;
      (isSharedInboxEntry(e) ? addresses : domains).add(e);
    }
  }
  for (const a of advisors || []) {
    const d = domainOf(a.email);
    if (d) domains.add(d);
  }
  return { domains, addresses };
}

// `excluded` matters here, not just for the caller's own use: the client treats a
// recipient on the "מוחרגים" list as known and does not flag it (see
// recipientExclusionMatch in check3-subject.ts). Omitting it would raise a
// spurious "unknown domain" warning for every excluded recipient. Expired rows are
// already filtered out by the query.
function findUnknownDomains(recipients, known, excluded) {
  const isExcluded = (r) =>
    (excluded || []).some((x) =>
      x.scope === "DOMAIN" ? lower(x.email) === domainOf(r) : lower(x.email) === lower(r),
    );
  return [
    ...new Set(
      recipients
        .filter(
          (r) =>
            !known.addresses.has(lower(r)) && !known.domains.has(domainOf(r)) && !isExcluded(r),
        )
        .map((r) => domainOf(r))
        .filter(Boolean),
    ),
  ];
}

// DOMAIN-scoped rows hold a bare domain in `email`; EMAIL-scoped rows hold a full
// address.
function matchExcluded(excluded, recipients) {
  return (excluded || []).filter((x) =>
    recipients.some((r) =>
      x.scope === "DOMAIN" ? lower(x.email) === domainOf(r) : lower(x.email) === lower(r),
    ),
  );
}

const isUserExempt = (exemptions, userEmail) =>
  !!userEmail && (exemptions || []).some((e) => lower(e.email) === lower(userEmail));

module.exports = {
  INTERNAL_DOMAIN,
  SHARED_INBOX_DOMAINS,
  lower,
  domainOf,
  isSharedInboxEntry,
  additionalDomainMatches,
  matchCustomers,
  buildKnown,
  findUnknownDomains,
  matchExcluded,
  isUserExempt,
};
