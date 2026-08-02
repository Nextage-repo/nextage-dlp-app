import { findCustomersInRecipients, getUserPermission } from "../src/validators/shared";
import { customer, exemption } from "./fixtures";

describe("getUserPermission", () => {
  it("returns STANDARD when no exemption matches", () => {
    expect(getUserPermission("nobody@nextage.co.il", [])).toBe("STANDARD");
  });

  it("returns the exemption type for a matching active row", () => {
    const ex = exemption({
      userEmail: "user@nextage.co.il",
      exemptionType: "CHECK_2_BYPASS",
    });
    expect(getUserPermission("user@nextage.co.il", [ex])).toBe("CHECK_2_BYPASS");
  });

  it("is case-insensitive on email", () => {
    const ex = exemption({ userEmail: "User@Nextage.CO.IL" });
    expect(getUserPermission("user@nextage.co.il", [ex])).toBe("ALL_CHECKS");
  });

  it("ignores exemptions whose expiryDate is in the past", () => {
    const ex = exemption({
      userEmail: "user@nextage.co.il",
      expiryDate: "2020-01-01T00:00:00Z",
    });
    expect(getUserPermission("user@nextage.co.il", [ex])).toBe("STANDARD");
  });
});

describe("findCustomersInRecipients", () => {
  const acme = customer({
    id: "c-acme",
    customerName: "AcmeCorp",
    primaryDomain: "acme.com",
    additionalDomains: ["acme.co.uk"],
  });
  const stark = customer({
    id: "c-stark",
    customerName: "Stark",
    primaryDomain: "stark.com",
  });

  it("matches by primary domain", () => {
    const found = findCustomersInRecipients(["finance@acme.com"], [acme, stark]);
    expect(found.map((c) => c.id)).toEqual(["c-acme"]);
  });

  it("matches by additional domain", () => {
    const found = findCustomersInRecipients(["finance@acme.co.uk"], [acme, stark]);
    expect(found.map((c) => c.id)).toEqual(["c-acme"]);
  });

  it("de-duplicates by customer id", () => {
    const found = findCustomersInRecipients(
      ["a@acme.com", "b@acme.co.uk", "c@acme.com"],
      [acme],
    );
    expect(found).toHaveLength(1);
  });

  it("skips INACTIVE customers", () => {
    const inactive = customer({ ...acme, status: "INACTIVE" });
    const found = findCustomersInRecipients(["finance@acme.com"], [inactive]);
    expect(found).toEqual([]);
  });

  // Per-customer Dokka inboxes share one domain, so a Dokka entry under
  // "דומיינים נוספים" — and ONLY such an entry — matches by full address.
  describe("Dokka inboxes in additional domains", () => {
    const aizome = customer({
      id: "c-aizome",
      customerName: "Aizome Technologies",
      primaryDomain: "aizome.ai",
      additionalDomains: ["aizome32@dokka.co.il"],
    });
    const whalo = customer({
      id: "c-whalo",
      customerName: "Whalo Games",
      primaryDomain: "whalo.com",
      additionalDomains: ["whalo-games12@dokka.co.il"],
    });

    it("matches the exact Dokka address", () => {
      const found = findCustomersInRecipients(["aizome32@dokka.co.il"], [aizome, whalo]);
      expect(found.map((c) => c.id)).toEqual(["c-aizome"]);
    });

    it("does not match another customer's inbox at the same shared domain", () => {
      const found = findCustomersInRecipients(["someone-else@dokka.co.il"], [aizome, whalo]);
      expect(found).toEqual([]);
    });

    it("leaves the customer's own domains matching by domain as before", () => {
      const found = findCustomersInRecipients(["cfo@aizome.ai"], [aizome, whalo]);
      expect(found.map((c) => c.id)).toEqual(["c-aizome"]);
    });

    it("does not apply full-address matching to non-Dokka entries", () => {
      const other = customer({
        id: "c-other",
        customerName: "Other",
        primaryDomain: "other.com",
        additionalDomains: ["billing@partner.com"],
      });
      // A non-Dokka full address stays inert, exactly as before this rule.
      expect(findCustomersInRecipients(["billing@partner.com"], [other])).toEqual([]);
    });
  });
});
