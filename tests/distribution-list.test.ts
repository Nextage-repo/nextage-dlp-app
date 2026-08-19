// Sending to an internal distribution group ("#Daily"): Outlook reports the entry
// with no SMTP address and recipientType "distributionList". Before this was
// handled the mail reached the checks with an empty recipient list, and every send
// to a group raised the "אין נמענים - הקלד נמען ולחץ Tab או Enter לאישור" prompt
// three times over.

import { isInternalOnly, splitRecipients } from "../src/shared/recipients";
import { DLPValidator } from "../src/validators/validators";
import { DLPConfig } from "../src/models/customer.model";
import { attachment, email, headerZipPlain } from "./fixtures";

const group = (displayName: string) => ({
  emailAddress: "",
  displayName,
  recipientType: "distributionList",
});

function config(over: Partial<DLPConfig> = {}): DLPConfig {
  return {
    customers: [],
    advisors: [],
    exemptions: [],
    exclusions: [],
    rules: [],
    roles: [],
    excludedRecipients: [],
    encryptionKeywords: [{ id: "k", keyword: "payroll", note: "", active: true }],
    ...over,
  };
}

describe("splitRecipients", () => {
  it("separates addresses, groups and unresolved entries", () => {
    const split = splitRecipients([
      { emailAddress: "Colleague@Nextage.co.il", displayName: "Colleague", recipientType: "internal" },
      group("#Daily"),
      { emailAddress: "", displayName: "Some Typed Text", recipientType: "other" },
    ]);
    expect(split.addresses).toEqual(["colleague@nextage.co.il"]);
    expect(split.groups.map((g) => g.displayName)).toEqual(["#Daily"]);
    expect(split.unresolved.map((u) => u.displayName)).toEqual(["Some Typed Text"]);
  });

  it("de-duplicates addresses", () => {
    const split = splitRecipients([
      { emailAddress: "a@acme.com", displayName: "A" },
      { emailAddress: "A@Acme.com", displayName: "A" },
    ]);
    expect(split.addresses).toEqual(["a@acme.com"]);
  });
});

describe("isInternalOnly", () => {
  it("true for a group on its own — the send fast-path allows it", () => {
    expect(isInternalOnly(splitRecipients([group("#Daily")]))).toBe(true);
  });

  it("true for a group alongside internal addresses", () => {
    expect(
      isInternalOnly(
        splitRecipients([group("#Daily"), { emailAddress: "c@nextage.co.il", displayName: "C" }]),
      ),
    ).toBe(true);
  });

  it("false once an external address is present", () => {
    expect(
      isInternalOnly(
        splitRecipients([group("#Daily"), { emailAddress: "x@acme.com", displayName: "X" }]),
      ),
    ).toBe(false);
  });

  it("false for an addressless entry Outlook never resolved", () => {
    expect(
      isInternalOnly(splitRecipients([{ emailAddress: "", displayName: "typed", recipientType: "other" }])),
    ).toBe(false);
  });

  it("false when there are no recipients at all", () => {
    expect(isInternalOnly(splitRecipients([]))).toBe(false);
  });
});

describe("DLPValidator with a distribution group", () => {
  it("reports internal instead of 'no recipients', even with an unencrypted file", async () => {
    const result = await new DLPValidator(config()).runAllChecks(
      email({
        recipients: [],
        groupRecipients: [group("#Daily")],
        subject: "Leumi - Daily interest bearing deposit quotes",
        attachments: [attachment("payroll.xlsx", headerZipPlain)],
      }),
    );
    expect(result.hasWarning).toBe(false);
    expect(result.shouldBlock).toBe(false);
    expect(result.results).toHaveLength(3);
    expect(result.results.every((r) => r.isValid && r.severity === "INFO")).toBe(true);
    expect(result.results[0].message).toContain("קבוצת תפוצה");
  });

  it("still warns about no recipients when the fields are genuinely empty", async () => {
    const result = await new DLPValidator(config()).runAllChecks(
      email({ recipients: [], groupRecipients: [] }),
    );
    expect(result.hasWarning).toBe(true);
    expect(result.results[0].message).toContain("אין נמענים");
  });

  it("runs the checks normally when an external address joins the group", async () => {
    const result = await new DLPValidator(config()).runAllChecks(
      email({
        recipients: ["client@acme.com"],
        groupRecipients: [group("#Daily")],
        attachments: [attachment("payroll.xlsx", headerZipPlain)],
      }),
    );
    // Keyword-matched, unencrypted attachment going outside -> Check 1 blocks.
    expect(result.hasBlock).toBe(true);
  });
});
