// Guards the server-side matching used by POST /api/resolve against divergence
// from the client's rules in src/validators/shared.ts. A divergence here produces
// a wrong "unknown domain" warning, or a missing one — a silent enforcement gap.
/* eslint-disable @typescript-eslint/no-var-requires */
const m = require("../lib/resolve-match.cjs");

type Customer = {
  id: number;
  name: string;
  primary_domain: string;
  domains: string[];
};

const customers: Customer[] = [
  { id: 1, name: "Bank Leumi", primary_domain: "leumi.co.il", domains: ["leumi.co.il", "bankleumi.co.il"] },
  { id: 2, name: "Dokka Client A", primary_domain: "", domains: ["clienta@dokka.co.il"] },
  { id: 3, name: "Dokka Client B", primary_domain: "", domains: ["clientb@dokka.co.il"] },
];
const advisors = [{ id: 1, email: "cpa@advisor.co.il" }];

const resolve = (recipients: string[]) => ({
  matched: m.matchCustomers(customers, recipients).map((c: Customer) => c.name),
  unknown: m.findUnknownDomains(recipients, m.buildKnown(customers, advisors)),
});

describe("resolve: customer matching", () => {
  it("matches on the primary domain", () => {
    expect(resolve(["cfo@leumi.co.il"])).toEqual({ matched: ["Bank Leumi"], unknown: [] });
  });

  it("matches on an additional domain", () => {
    expect(resolve(["x@bankleumi.co.il"])).toEqual({ matched: ["Bank Leumi"], unknown: [] });
  });

  it("ignores case and surrounding whitespace", () => {
    expect(resolve(["  CFO@LEUMI.CO.IL "])).toEqual({ matched: ["Bank Leumi"], unknown: [] });
  });

  it("returns no customer for an internal recipient", () => {
    expect(resolve(["me@nextage.co.il"])).toEqual({ matched: [], unknown: [] });
  });

  it("handles a mix of known and unknown recipients", () => {
    expect(resolve(["cfo@leumi.co.il", "x@stranger.com"])).toEqual({
      matched: ["Bank Leumi"],
      unknown: ["stranger.com"],
    });
  });
});

describe("resolve: unknown domains", () => {
  it("flags a domain that belongs to nobody", () => {
    expect(resolve(["someone@stranger.com"]).unknown).toEqual(["stranger.com"]);
  });

  it("treats an advisor's domain as known", () => {
    expect(resolve(["cpa@advisor.co.il"]).unknown).toEqual([]);
  });

  it("collapses duplicates", () => {
    expect(resolve(["a@s.com", "b@s.com"]).unknown).toEqual(["s.com"]);
  });
});

// The subtle pair. A shared document portal is listed by full address, so the
// domain itself must stay unknown — otherwise one Dokka address would make every
// Dokka customer match, and any stranger at that domain would look known.
describe("resolve: shared-inbox (Dokka) entries", () => {
  it("ties a listed full address to exactly one customer", () => {
    expect(resolve(["clienta@dokka.co.il"])).toEqual({ matched: ["Dokka Client A"], unknown: [] });
  });

  it("treats an unlisted address at the shared domain as unknown", () => {
    expect(resolve(["nobody@dokka.co.il"])).toEqual({ matched: [], unknown: ["dokka.co.il"] });
  });
});

describe("resolve: exclusions and exemptions", () => {
  const excluded = [
    { id: 1, email: "team.co.il", scope: "DOMAIN" },
    { id: 2, email: "one.person@partner.com", scope: "EMAIL" },
  ];

  it("matches a DOMAIN-scoped row against any address at that domain", () => {
    expect(m.matchExcluded(excluded, ["anyone@team.co.il"]).map((x: any) => x.id)).toEqual([1]);
  });

  it("matches an EMAIL-scoped row only on the exact address", () => {
    expect(m.matchExcluded(excluded, ["other@partner.com"])).toEqual([]);
    expect(m.matchExcluded(excluded, ["one.person@partner.com"]).map((x: any) => x.id)).toEqual([2]);
  });

  // The client treats an excluded recipient as known and does not warn about it.
  // Before this was mirrored server-side, every excluded recipient produced a
  // spurious "unknown domain" warning.
  it("does not flag an excluded recipient as an unknown domain", () => {
    const known = m.buildKnown([], []);
    expect(m.findUnknownDomains(["anyone@team.co.il"], known, excluded)).toEqual([]);
    expect(m.findUnknownDomains(["one.person@partner.com"], known, excluded)).toEqual([]);
    // A different address at an EMAIL-scoped domain is still unknown.
    expect(m.findUnknownDomains(["other@partner.com"], known, excluded)).toEqual(["partner.com"]);
    // And with no exclusions supplied at all, nothing changes.
    expect(m.findUnknownDomains(["anyone@team.co.il"], known, [])).toEqual(["team.co.il"]);
  });

  it("reports an exempt user, case-insensitively", () => {
    const exemptions = [{ id: 1, email: "Boss@nextage.co.il" }];
    expect(m.isUserExempt(exemptions, "boss@nextage.co.il")).toBe(true);
    expect(m.isUserExempt(exemptions, "someone@nextage.co.il")).toBe(false);
    expect(m.isUserExempt(exemptions, "")).toBe(false);
  });
});

// Each of these domains hosts one mailbox per customer. An address at a domain that
// is NOT in SHARED_INBOX_DOMAINS gets compared against the recipient's domain and can
// therefore never match, so mail to it stops being tied to its customer — which is
// what had happened to 25 dokka.me and 14 escalon.services entries.
describe("resolve: every shared-inbox domain is recognised", () => {
  const two = [
    { id: 1, name: "Sanoculis", primary_domain: "sanoculis.com", domains: ["sanoculis.com", "sanoculis@escalon.services"], aliases: [] },
    { id: 2, name: "Oligo Cyber", primary_domain: "oligosecurity.io", domains: ["oligosecurity.io", "oligosecurity@escalon.services"], aliases: [] },
    { id: 3, name: "Vivid Security", primary_domain: "vivid.security", domains: ["vivid.security", "vivid-sec-inc52@dokka.me"], aliases: [] },
  ];

  it("ties an escalon.services mailbox to its own customer only", () => {
    expect(m.matchCustomers(two, ["sanoculis@escalon.services"]).map((c: any) => c.name)).toEqual(["Sanoculis"]);
    expect(m.matchCustomers(two, ["oligosecurity@escalon.services"]).map((c: any) => c.name)).toEqual(["Oligo Cyber"]);
  });

  it("ties a dokka.me mailbox to its own customer", () => {
    expect(m.matchCustomers(two, ["vivid-sec-inc52@dokka.me"]).map((c: any) => c.name)).toEqual(["Vivid Security"]);
  });

  it("leaves the shared domains themselves unknown", () => {
    const known = m.buildKnown(two, []);
    expect(m.findUnknownDomains(["nobody@escalon.services"], known, [])).toEqual(["escalon.services"]);
    expect(m.findUnknownDomains(["nobody@dokka.me"], known, [])).toEqual(["dokka.me"]);
  });
});
