import { runCheck2 } from "../src/validators/check2-filename";
import { attachment, customer, exemption, headerZipPlain } from "./fixtures";

describe("runCheck2 (filename matching)", () => {
  const matchingCustomer = customer({
    customerName: "AcmeCorp",
    aliases: ["Acme", "ACM"],
    primaryDomain: "acme.com",
  });

  it("passes when filename contains customer name", () => {
    const r = runCheck2({
      attachments: [attachment("AcmeCorp_invoice_2025.xlsx", headerZipPlain)],
      recipients: ["finance@acme.com"],
      userEmail: "sender@nextage.co.il",
      customers: [matchingCustomer],
      exemptions: [],
    });
    expect(r.isValid).toBe(true);
  });

  it("passes when filename contains an alias", () => {
    const r = runCheck2({
      attachments: [attachment("Acme_report.pdf", headerZipPlain)],
      recipients: ["finance@acme.com"],
      userEmail: "sender@nextage.co.il",
      customers: [matchingCustomer],
      exemptions: [],
    });
    expect(r.isValid).toBe(true);
  });

  it("WARNS when filename does not contain customer name", () => {
    const r = runCheck2({
      attachments: [attachment("Unrelated_file.xlsx", headerZipPlain)],
      recipients: ["finance@acme.com"],
      userEmail: "sender@nextage.co.il",
      customers: [matchingCustomer],
      exemptions: [],
    });
    expect(r.severity).toBe("WARNING");
  });

  it("uses word-boundary matching: short alias 'ACM' does NOT match 'tacmore.xlsx'", () => {
    const r = runCheck2({
      attachments: [attachment("tacmore.xlsx", headerZipPlain)],
      recipients: ["finance@acme.com"],
      userEmail: "sender@nextage.co.il",
      customers: [matchingCustomer],
      exemptions: [],
    });
    expect(r.severity).toBe("WARNING");
  });

  it("treats underscores and dots as boundaries", () => {
    const r = runCheck2({
      attachments: [attachment("invoice.ACM.pdf", headerZipPlain)],
      recipients: ["finance@acme.com"],
      userEmail: "sender@nextage.co.il",
      customers: [matchingCustomer],
      exemptions: [],
    });
    expect(r.isValid).toBe(true);
  });

  it("passes when no customer matches the recipient domain", () => {
    const r = runCheck2({
      attachments: [attachment("anything.xlsx", headerZipPlain)],
      recipients: ["nobody@unknown.example"],
      userEmail: "sender@nextage.co.il",
      customers: [matchingCustomer],
      exemptions: [],
    });
    expect(r.isValid).toBe(true);
  });

  it("passes when CHECK_2_BYPASS exemption applies", () => {
    const r = runCheck2({
      attachments: [attachment("Unrelated.xlsx", headerZipPlain)],
      recipients: ["finance@acme.com"],
      userEmail: "sender@nextage.co.il",
      customers: [matchingCustomer],
      exemptions: [
        exemption({ userEmail: "sender@nextage.co.il", exemptionType: "CHECK_2_BYPASS" }),
      ],
    });
    expect(r.isValid).toBe(true);
  });

  it("a role that bypasses ONLY check 1 (CFO) does NOT bypass check 2", () => {
    const r = runCheck2({
      attachments: [attachment("Unrelated.xlsx", headerZipPlain)],
      recipients: ["finance@acme.com"],
      userEmail: "sender@nextage.co.il",
      customers: [matchingCustomer],
      exemptions: [],
      roles: [
        { id: "role-cfo", roleName: "CFO", assignedEmails: ["sender@nextage.co.il"], bypassChecks: [1], active: true },
      ],
    });
    expect(r.severity).toBe("WARNING");
  });

  it("a role whose bypassChecks includes 2 bypasses check 2", () => {
    const r = runCheck2({
      attachments: [attachment("Unrelated.xlsx", headerZipPlain)],
      recipients: ["finance@acme.com"],
      userEmail: "sender@nextage.co.il",
      customers: [matchingCustomer],
      exemptions: [],
      roles: [
        { id: "role-x", roleName: "Auditor", assignedEmails: ["sender@nextage.co.il"], bypassChecks: [2], active: true },
      ],
    });
    expect(r.isValid).toBe(true);
    expect(r.message).toContain("Auditor");
  });
});
