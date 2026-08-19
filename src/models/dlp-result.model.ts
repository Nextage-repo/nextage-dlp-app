// DLP check result models

export type Severity = "INFO" | "WARNING" | "BLOCK";
export type CheckNumber = 1 | 2 | 3;

export interface CheckResult {
  check: CheckNumber;
  isValid: boolean;
  severity: Severity;
  message: string;
  details?: Record<string, unknown>;
}

export interface DLPResult {
  results: CheckResult[];
  hasBlock: boolean;
  hasWarning: boolean;
  shouldBlock: boolean; // hasBlock && !SAFE_MODE — decisive output for OnSend
}

export interface AttachmentWithHeader {
  id: string;
  name: string;
  size: number;
  isInline: boolean;
  // Office.js attachment kind: "file" | "item" | "cloud". "item" means an
  // attached Outlook item (an email message). Optional so older callers/tests
  // that don't set it keep working.
  attachmentType?: string;
  magicBytes: Uint8Array | null;
  // Last ~8 KiB of the file. PDFs declare encryption with an /Encrypt entry in
  // the trailer at the END of the file, so the header alone is not enough.
  trailerBytes: Uint8Array | null;
}

export interface RecipientInfo {
  emailAddress: string;
  displayName: string;
  // Office.js EmailAddressDetails.recipientType — "distributionList" | "internal"
  // | "external" | "other". Optional so older callers/tests keep working.
  recipientType?: string;
}

export interface EmailData {
  subject: string;
  userEmail: string;
  to: RecipientInfo[];
  cc: RecipientInfo[];
  bcc: RecipientInfo[];
  recipients: string[]; // unique emailAddresses, lowercased
  attachments: AttachmentWithHeader[];
  // Internal distribution groups on this mail. They carry no SMTP address, so they
  // never appear in `recipients` — kept here so "addressed only to a group" is not
  // mistaken for "no recipients at all". See shared/recipients.ts.
  groupRecipients?: RecipientInfo[];
}
