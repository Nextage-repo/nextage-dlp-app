import { runCheck3 } from "../src/validators/check3-subject";
import { advisor, customer, exemption, excludedRecipient } from "./fixtures";

describe("runCheck3 (subject + domain validation)", () => {
  const matchingCustomer = customer({
    id: "cust-1",
    customerName: "AcmeCorp",
    aliases: ["Acme"],
    primaryDomain: "acme.com",
  });

  it("WARNs on unknown recipient domain (encryption check handles blocking)", () => {
    const r = runCheck3({
      subject: "anything",
      recipients: ["someone@unknown.example"],
      userEmail: "sender@nextage.co.il",
      customers: [matchingCustomer],
      advisors: [],
      exemptions: [],
      exclusions: [],
    });
    expect(r.severity).toBe("WARNING");
    expect(r.isValid).toBe(false);
    expect(r.message).toContain("unknown.example");
  });

  it("BLOCKs when subject is missing the matched customer name", () => {
    const r = runCheck3({
      subject: "Q3 figures",
      recipients: ["finance@acme.com"],
      userEmail: "sender@nextage.co.il",
      customers: [matchingCustomer],
      advisors: [],
      exemptions: [],
      exclusions: [],
    });
    expect(r.severity).toBe("BLOCK");
  });

  it("PASSes when subject contains customer name", () => {
    const r = runCheck3({
      subject: "AcmeCorp Q3 figures",
      recipients: ["finance@acme.com"],
      userEmail: "sender@nextage.co.il",
      customers: [matchingCustomer],
      advisors: [],
      exemptions: [],
      exclusions: [],
    });
    expect(r.isValid).toBe(true);
  });

  it("PASSes when subject contains alias", () => {
    const r = runCheck3({
      subject: "Acme report",
      recipients: ["finance@acme.com"],
      userEmail: "sender@nextage.co.il",
      customers: [matchingCustomer],
      advisors: [],
      exemptions: [],
      exclusions: [],
    });
    expect(r.isValid).toBe(true);
  });

  it("PASSes internal-only recipients (nextage domain is implicit)", () => {
    const r = runCheck3({
      subject: "internal note",
      recipients: ["colleague@nextage.co.il"],
      userEmail: "sender@nextage.co.il",
      customers: [],
      advisors: [],
      exemptions: [],
      exclusions: [],
    });
    expect(r.isValid).toBe(true);
  });

  it("WARNs advisor-only when subject lacks linked customer name", () => {
    const adv = advisor({
      emailDomain: "advisor.example",
      linkedCustomers: ["cust-1"],
    });
    const r = runCheck3({
      subject: "general note",
      recipients: ["adv@advisor.example"],
      userEmail: "sender@nextage.co.il",
      customers: [matchingCustomer],
      advisors: [adv],
      exemptions: [],
      exclusions: [],
    });
    expect(r.severity).toBe("WARNING");
  });

  it("PASSes when CHECK_3_BYPASS exemption applies", () => {
    const r = runCheck3({
      subject: "anything",
      recipients: ["someone@unknown.example"],
      userEmail: "sender@nextage.co.il",
      customers: [matchingCustomer],
      advisors: [],
      exemptions: [
        exemption({ userEmail: "sender@nextage.co.il", exemptionType: "CHECK_3_BYPASS" }),
      ],
      exclusions: [],
    });
    expect(r.isValid).toBe(true);
  });

  // Regression: excluded ("מוחרגים") recipients must count as KNOWN domains, so a
  // mixed send (one excluded + one customer) does not warn "unknown domain".
  it("does NOT flag an excluded recipient as an unknown domain", () => {
    const r = runCheck3({
      subject: "AcmeCorp update",
      recipients: ["someone@team.co.il", "finance@acme.com"],
      userEmail: "sender@nextage.co.il",
      customers: [matchingCustomer],
      advisors: [],
      exemptions: [],
      exclusions: [],
      excludedRecipients: [excludedRecipient({ email: "team.co.il", scope: "DOMAIN" })],
    });
    expect(r.isValid).toBe(true);
    expect(r.message).not.toContain("team.co.il");
  });

  it("EMAIL-scope exclusion clears only the exact address, not the whole domain", () => {
    const r = runCheck3({
      subject: "hi",
      recipients: ["other@team.co.il"], // NOT the excluded address
      userEmail: "sender@nextage.co.il",
      customers: [matchingCustomer],
      advisors: [],
      exemptions: [],
      exclusions: [],
      excludedRecipients: [excludedRecipient({ email: "test@team.co.il", scope: "EMAIL" })],
    });
    expect(r.severity).toBe("WARNING");
    expect(r.message).toContain("team.co.il");
  });

  it("EMAIL-scope exclusion: the exact excluded address is NOT flagged as unknown", () => {
    const r = runCheck3({
      subject: "hi",
      recipients: ["test@team.co.il"],
      userEmail: "sender@nextage.co.il",
      customers: [matchingCustomer],
      advisors: [],
      exemptions: [],
      exclusions: [],
      excludedRecipients: [excludedRecipient({ email: "test@team.co.il", scope: "EMAIL" })],
    });
    expect(r.isValid).toBe(true);
  });
});
