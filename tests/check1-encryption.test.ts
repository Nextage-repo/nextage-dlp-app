import { runCheck1, classify } from "../src/validators/check1-encryption";
import {
  attachment,
  exclusion,
  exemption,
  headerOLE2,
  headerPdfEncrypted,
  headerPdfPlain,
  headerPdfPlainHead,
  trailerPdfEncrypted,
  trailerPdfPlain,
  headerHtmlEncrypted,
  headerHtmlEncryptedImg,
  trailerHtmlCrypto,
  headerHtmlPlain,
  headerZipEncrypted,
  headerZipPlain,
} from "./fixtures";

const externalRecipients = ["client@external.com"];

describe("classify (magic-byte detection)", () => {
  it("treats CFB/OLE2 header as ENCRYPTED", () => {
    expect(classify(attachment("payroll.xlsx", headerOLE2))).toBe("ENCRYPTED");
  });

  it("treats ZIP-signed modern Office files as UNENCRYPTED", () => {
    expect(classify(attachment("budget.xlsx", headerZipPlain))).toBe("UNENCRYPTED");
    expect(classify(attachment("contract.docx", headerZipPlain))).toBe("UNENCRYPTED");
  });

  it("treats ZIP archives with bit-0 flag set as ENCRYPTED", () => {
    expect(classify(attachment("docs.zip", headerZipEncrypted))).toBe("ENCRYPTED");
  });

  it("treats plain ZIP archives as UNENCRYPTED", () => {
    expect(classify(attachment("docs.zip", headerZipPlain))).toBe("UNENCRYPTED");
  });

  it("treats PDFs with /Encrypt as ENCRYPTED", () => {
    expect(classify(attachment("report.pdf", headerPdfEncrypted))).toBe("ENCRYPTED");
  });

  it("treats plain PDFs as UNENCRYPTED", () => {
    expect(classify(attachment("report.pdf", headerPdfPlain))).toBe("UNENCRYPTED");
  });

  it("detects /Encrypt in the PDF TRAILER (header alone is plain)", () => {
    expect(
      classify(attachment("report.pdf", headerPdfPlainHead, { trailerBytes: trailerPdfEncrypted })),
    ).toBe("ENCRYPTED");
  });

  it("treats a PDF with a plain trailer as UNENCRYPTED", () => {
    expect(
      classify(attachment("report.pdf", headerPdfPlainHead, { trailerBytes: trailerPdfPlain })),
    ).toBe("UNENCRYPTED");
  });

  it("treats the org's encrypted HTML as ENCRYPTED", () => {
    expect(classify(attachment("logo_preview_protected.html", headerHtmlEncrypted))).toBe("ENCRYPTED");
  });

  it("treats a plain HTML file as UNENCRYPTED", () => {
    expect(classify(attachment("report.html", headerHtmlPlain))).toBe("UNENCRYPTED");
  });

  it("detects encrypted HTML even when an inlined logo pushes the payload past 4 KB (CSS signature in header)", () => {
    expect(classify(attachment("mesh_summary_protected.html", headerHtmlEncryptedImg))).toBe("ENCRYPTED");
  });

  it("detects encrypted HTML via the decryption code in the trailer", () => {
    // Header has only the template title (no CSS tokens); trailer carries crypto.
    const headerTitleOnly = Uint8Array.from(
      "<!DOCTYPE html><head><title>Protected Document</title></head><body>",
      (c) => c.charCodeAt(0),
    );
    expect(
      classify(attachment("doc_protected.html", headerTitleOnly, { trailerBytes: trailerHtmlCrypto })),
    ).toBe("ENCRYPTED");
  });

  it("returns UNVERIFIABLE when header missing or too short", () => {
    expect(classify(attachment("mystery.bin", null))).toBe("UNVERIFIABLE");
    expect(classify(attachment("mystery.bin", new Uint8Array([1, 2])))).toBe("UNVERIFIABLE");
  });

  it("does NOT trust extension alone: a renamed .zip with no header data is UNVERIFIABLE", () => {
    // Was previously a CRITICAL bypass: extension-based fallback marked any
    // .zip as encrypted, letting attackers rename sensitive files to bypass.
    expect(classify(attachment("payroll.zip", null))).toBe("UNVERIFIABLE");
  });
});

describe("runCheck1", () => {
  const base = {
    recipients: externalRecipients,
    userEmail: "sender@nextage.co.il",
    exclusions: [],
    exemptions: [],
  };

  it("passes when no attachments", () => {
    const r = runCheck1({ ...base, attachments: [] });
    expect(r.isValid).toBe(true);
    expect(r.severity).toBe("INFO");
  });

  it("passes when all recipients internal", () => {
    const r = runCheck1({
      ...base,
      recipients: ["colleague@nextage.co.il"],
      attachments: [attachment("payroll.xlsx", headerZipPlain)],
    });
    expect(r.isValid).toBe(true);
  });

  it("passes when ALL_CHECKS exemption applies", () => {
    const r = runCheck1({
      ...base,
      exemptions: [exemption({ userEmail: "sender@nextage.co.il" })],
      attachments: [attachment("payroll.xlsx", headerZipPlain)],
    });
    expect(r.isValid).toBe(true);
  });

  it("BLOCKs unencrypted Office files to external recipients", () => {
    const r = runCheck1({
      ...base,
      attachments: [attachment("payroll.xlsx", headerZipPlain)],
    });
    expect(r.severity).toBe("BLOCK");
    expect(r.message).toContain("payroll.xlsx");
  });

  it("BLOCKs with 'unverifiable' message when headers cannot be read", () => {
    const r = runCheck1({
      ...base,
      attachments: [attachment("file.zip", null)],
    });
    expect(r.severity).toBe("BLOCK");
    expect(r.message).toContain("לא ניתן לאמת");
  });

  it("PASSes when ZIP is properly encrypted", () => {
    const r = runCheck1({
      ...base,
      attachments: [attachment("docs.zip", headerZipEncrypted)],
    });
    expect(r.isValid).toBe(true);
  });

  it("PASSes when an active domain exclusion covers all recipients", () => {
    const r = runCheck1({
      ...base,
      exclusions: [exclusion({ domainPattern: "external.com" })],
      attachments: [attachment("payroll.xlsx", headerZipPlain)],
    });
    expect(r.isValid).toBe(true);
  });

  it("IGNORES expired exclusions", () => {
    const r = runCheck1({
      ...base,
      exclusions: [
        exclusion({
          domainPattern: "external.com",
          expiryDate: "2020-01-01T00:00:00Z",
        }),
      ],
      attachments: [attachment("payroll.xlsx", headerZipPlain)],
    });
    expect(r.severity).toBe("BLOCK");
  });

  it("skips image attachments", () => {
    const r = runCheck1({
      ...base,
      attachments: [
        attachment("photo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
        attachment("payroll.xlsx", headerOLE2),
      ],
    });
    expect(r.isValid).toBe(true);
  });
});
