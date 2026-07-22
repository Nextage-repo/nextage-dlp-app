import { sliceHeaderAndTrailer } from "../src/commands/attachment-reader";
import { classify } from "../src/validators/check1-encryption";
import { AttachmentWithHeader } from "../src/models/dlp-result.model";

const toBytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

// Mirrors the real samples: a standard-encrypted PDF where the /Encrypt reference
// lives in the trailer, ~40 bytes before %%EOF, in a file large enough that only
// a proper EOF-anchored trailer read will see it.
function makePdf(withEncrypt: boolean): Uint8Array {
  const header = "%PDF-1.4\r\n%\xe2\xe3\xcf\xd3\r\n";
  const body = "1 0 obj\r\n<< /Type /Page >>\r\nendobj\r\n".repeat(220); // ~7.7 KB filler
  const encRef = withEncrypt ? "/Encrypt 31 0 R" : "/Info 3 0 R";
  const trailer =
    "trailer\r\n<< /Root 1 0 R /Size 32 " +
    "/ID [<738C24F86051DEF827E049A0293287F1><738C24F86051DEF827E049A0293287F1>]" +
    encRef +
    "\r\n>>\r\nstartxref\r\n121146\r\n%%EOF";
  return toBytes(header + body + trailer);
}

function attFromContent(name: string, bytes: Uint8Array): AttachmentWithHeader {
  const { magicBytes, trailerBytes } = sliceHeaderAndTrailer(b64(bytes));
  return { id: "a", name, size: bytes.length, isInline: false, magicBytes, trailerBytes };
}

describe("attachment-reader trailer window (PDF /Encrypt at EOF)", () => {
  it("builds a file large enough to exercise the separate trailer read", () => {
    expect(makePdf(true).length).toBeGreaterThan(6000);
  });

  it("captures /Encrypt sitting in the final ~40 bytes of a large PDF -> ENCRYPTED", () => {
    // Regression: the trailer read used to front-truncate and chop these final
    // bytes, mis-detecting standard-encrypted PDFs as plain.
    expect(classify(attFromContent("VYP.CO.06.2026.pdf", makePdf(true)))).toBe("ENCRYPTED");
  });

  it("a large plain PDF (no /Encrypt) is still UNENCRYPTED", () => {
    expect(classify(attFromContent("report.pdf", makePdf(false)))).toBe("UNENCRYPTED");
  });

  it("trailer slice ends at %%EOF", () => {
    const { trailerBytes } = sliceHeaderAndTrailer(b64(makePdf(true)));
    const tail = Buffer.from(trailerBytes!).toString("latin1");
    expect(tail.endsWith("%%EOF")).toBe(true);
    expect(tail).toContain("/Encrypt");
  });
});
