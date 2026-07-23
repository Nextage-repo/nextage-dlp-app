import { recipientExclusionMatch, allExternalRecipientsExcluded } from "../src/validators/shared";
import { DLPValidator } from "../src/validators/validators";
import { DLPConfig } from "../src/models/customer.model";
import { attachment, customer, email, excludedRecipient, headerZipPlain } from "./fixtures";

const NOW = new Date("2026-07-20T12:00:00Z");

describe("recipientExclusionMatch", () => {
  it("EMAIL scope matches only the exact address (case-insensitive)", () => {
    const list = [excludedRecipient({ email: "Partner@BigCorp.com", scope: "EMAIL" })];
    expect(recipientExclusionMatch("partner@bigcorp.com", list, NOW)).not.toBeNull();
    expect(recipientExclusionMatch("other@bigcorp.com", list, NOW)).toBeNull();
  });

  it("DOMAIN scope matches any address at that domain", () => {
    const list = [excludedRecipient({ email: "anyone@bigcorp.com", scope: "DOMAIN" })];
    expect(recipientExclusionMatch("someone@bigcorp.com", list, NOW)).not.toBeNull();
    expect(recipientExclusionMatch("ceo@bigcorp.com", list, NOW)).not.toBeNull();
    expect(recipientExclusionMatch("x@othercorp.com", list, NOW)).toBeNull();
  });

  it("ignores an entry whose expiryDate has passed", () => {
    const list = [excludedRecipient({ email: "partner@bigcorp.com", expiryDate: "2026-07-01" })];
    expect(recipientExclusionMatch("partner@bigcorp.com", list, NOW)).toBeNull();
  });

  it("honours an entry that expires in the future, and one with no expiry", () => {
    const future = [excludedRecipient({ email: "partner@bigcorp.com", expiryDate: "2026-12-31" })];
    const never = [excludedRecipient({ email: "partner@bigcorp.com", expiryDate: null })];
    expect(recipientExclusionMatch("partner@bigcorp.com", future, NOW)).not.toBeNull();
    expect(recipientExclusionMatch("partner@bigcorp.com", never, NOW)).not.toBeNull();
  });
});

describe("allExternalRecipientsExcluded", () => {
  const list = [excludedRecipient({ email: "bigcorp.com", scope: "DOMAIN" })];

  it("true when every external recipient is excluded", () => {
    expect(allExternalRecipientsExcluded(["a@bigcorp.com", "b@bigcorp.com"], list, NOW)).toBe(true);
  });

  it("false when any external recipient is NOT excluded", () => {
    expect(allExternalRecipientsExcluded(["a@bigcorp.com", "x@other.com"], list, NOW)).toBe(false);
  });

  it("ignores internal recipients (still true if the only external one is excluded)", () => {
    expect(allExternalRecipientsExcluded(["a@bigcorp.com", "colleague@nextage.co.il"], list, NOW)).toBe(true);
  });

  it("false when there are no external recipients at all", () => {
    expect(allExternalRecipientsExcluded(["colleague@nextage.co.il"], list, NOW)).toBe(false);
  });
});

describe("DLPValidator skips all checks for excluded recipients", () => {
  function config(over: Partial<DLPConfig> = {}): DLPConfig {
    return {
      customers: [customer({ customerName: "BigCorp", primaryDomain: "bigcorp.com", aliases: [] })],
      advisors: [],
      exemptions: [],
      exclusions: [],
      rules: [],
      roles: [],
      excludedRecipients: [],
      encryptionKeywords: [],
      ...over,
    };
  }

  it("skips checks when the only recipient is excluded — even with an unencrypted file", async () => {
    const validator = new DLPValidator(
      config({ excludedRecipients: [excludedRecipient({ email: "partner@bigcorp.com", scope: "EMAIL" })] }),
    );
    const result = await validator.runAllChecks(
      email({
        recipients: ["partner@bigcorp.com"],
        subject: "no customer name here",
        attachments: [attachment("payroll.xlsx", headerZipPlain)], // unencrypted -> would normally BLOCK
      }),
    );
    expect(result.shouldBlock).toBe(false);
    expect(result.hasBlock).toBe(false);
    expect(result.results.every((r) => r.isValid)).toBe(true);
    expect(result.results[0].message).toContain("מוחרג");
  });

  it("still runs checks when a non-excluded external recipient is also present", async () => {
    const validator = new DLPValidator(
      config({
        excludedRecipients: [excludedRecipient({ email: "partner@bigcorp.com", scope: "EMAIL" })],
        encryptionKeywords: [{ id: "k", keyword: "payroll", note: "", active: true }],
      }),
    );
    const result = await validator.runAllChecks(
      email({
        recipients: ["partner@bigcorp.com", "someone@othercorp.com"],
        subject: "hi",
        attachments: [attachment("payroll.xlsx", headerZipPlain)], // keyword-matched + unencrypted
      }),
    );
    // Not all external recipients are excluded, so checks run: the keyword-matched
    // unencrypted attachment -> Check 1 blocks.
    expect(result.hasBlock).toBe(true);
  });
});
