// Test fixtures for DLP validator tests.

import { Advisor, Customer, Exclusion, Exemption } from "../src/models/customer.model";
import { AttachmentWithHeader, EmailData } from "../src/models/dlp-result.model";

// ----------------------------------------------------------------------------
// Magic-byte / header samples
// ----------------------------------------------------------------------------

/** CFB/OLE2 signature (encrypted Office files). */
export const headerOLE2 = new Uint8Array([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00, 0x00, 0x00,
]);

/** Plain ZIP local header — flags = 0x0000 (not encrypted). */
export const headerZipPlain = (() => {
  const buf = new Uint8Array(32);
  buf[0] = 0x50;
  buf[1] = 0x4b;
  buf[2] = 0x03;
  buf[3] = 0x04;
  buf[4] = 0x14;
  buf[5] = 0x00;
  buf[6] = 0x00;
  buf[7] = 0x00; // flags = 0
  return buf;
})();

/** ZIP local header with general-purpose bit 0 set (password-protected). */
export const headerZipEncrypted = (() => {
  const buf = new Uint8Array(32);
  buf[0] = 0x50;
  buf[1] = 0x4b;
  buf[2] = 0x03;
  buf[3] = 0x04;
  buf[4] = 0x14;
  buf[5] = 0x00;
  buf[6] = 0x01;
  buf[7] = 0x00; // flags = 0x0001
  return buf;
})();

/** PDF header without /Encrypt — unencrypted. */
export const headerPdfPlain = (() => {
  const s = "%PDF-1.7\n%aaaa\n1 0 obj\n<< /Type /Catalog >>\nendobj\n";
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
})();

/** PDF header containing /Encrypt — password-protected PDF. */
export const headerPdfEncrypted = (() => {
  const s = "%PDF-1.7\n%aaa\ntrailer << /Size 5 /Encrypt 4 0 R /Root 1 0 R >>\n";
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
})();

const toBytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** Realistic case: plain PDF header, /Encrypt only in the trailer at EOF. */
export const headerPdfPlainHead = toBytes("%PDF-1.7\n%aaaa\n1 0 obj\n<< /Type /Catalog >>\nstream\n....binary....");
export const trailerPdfEncrypted = toBytes("xref\n0 5\ntrailer\n<< /Size 208 /Root 1 0 R /Encrypt 207 0 R >>\nstartxref\n750000\n%%EOF\n");
export const trailerPdfPlain = toBytes("xref\n0 5\ntrailer\n<< /Size 208 /Root 1 0 R /Info 2 0 R >>\nstartxref\n750000\n%%EOF\n");

/** Org encrypted-HTML header: lock-screen + inlined ciphertext. */
export const headerHtmlEncrypted = toBytes(
  '<!DOCTYPE html><html><head><title>Protected Document</title></head><body>' +
    '<input type="password" id="pw"><button onclick="unlock()">Unlock</button>' +
    '<script>const DATA = "qQJ0MUOIwv/wh8HROq58R+nGqcnHKtTAk6JUjs";</script>',
);

/** Plain HTML page — must be treated as UNENCRYPTED. */
export const headerHtmlPlain = toBytes(
  "<!DOCTYPE html><html><head><title>Quarterly Report</title></head><body><h1>Hello</h1><p>Some content.</p></body></html>",
);

// ----------------------------------------------------------------------------
// Attachments
// ----------------------------------------------------------------------------

export function attachment(
  name: string,
  magicBytes: Uint8Array | null,
  overrides: Partial<AttachmentWithHeader> = {},
): AttachmentWithHeader {
  return {
    id: `att-${name}`,
    name,
    contentType: "application/octet-stream",
    size: 1024,
    isInline: false,
    magicBytes,
    trailerBytes: null,
    ...overrides,
  };
}

// ----------------------------------------------------------------------------
// Config rows
// ----------------------------------------------------------------------------

export function customer(p: Partial<Customer> = {}): Customer {
  return {
    id: p.id ?? "cust-1",
    partitionKey: "customers",
    customerName: p.customerName ?? "AcmeCorp",
    aliases: p.aliases ?? ["Acme"],
    primaryDomain: p.primaryDomain ?? "acme.com",
    additionalDomains: p.additionalDomains ?? [],
    status: p.status ?? "ACTIVE",
    updatedAt: p.updatedAt ?? "2024-01-01T00:00:00Z",
  };
}

export function advisor(p: Partial<Advisor> = {}): Advisor {
  return {
    id: p.id ?? "adv-1",
    partitionKey: "advisors",
    advisorName: p.advisorName ?? "Advisor One",
    emailDomain: p.emailDomain ?? "advisor.example",
    linkedCustomers: p.linkedCustomers ?? [],
    status: p.status ?? "ACTIVE",
    updatedAt: p.updatedAt ?? "2024-01-01T00:00:00Z",
  };
}

export function exemption(p: Partial<Exemption> = {}): Exemption {
  return {
    id: p.id ?? "ex-1",
    partitionKey: "exemptions",
    userEmail: p.userEmail ?? "user@nextage.co.il",
    fullName: p.fullName ?? "User Name",
    exemptionType: p.exemptionType ?? "ALL_CHECKS",
    scope: p.scope ?? "global",
    expiryDate: p.expiryDate ?? null,
  };
}

export function exclusion(p: Partial<Exclusion> = {}): Exclusion {
  return {
    id: p.id ?? "exc-1",
    partitionKey: "exclusions",
    emailAddress: p.emailAddress ?? null,
    domainPattern: p.domainPattern ?? null,
    allowUnencrypted: p.allowUnencrypted ?? true,
    reason: p.reason ?? "test",
    expiryDate: p.expiryDate ?? null,
  };
}

export function email(p: Partial<EmailData> = {}): EmailData {
  return {
    subject: p.subject ?? "",
    userEmail: p.userEmail ?? "sender@nextage.co.il",
    to: p.to ?? [],
    cc: p.cc ?? [],
    bcc: p.bcc ?? [],
    recipients: p.recipients ?? [],
    attachments: p.attachments ?? [],
  };
}
