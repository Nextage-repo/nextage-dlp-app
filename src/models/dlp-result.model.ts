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
  magicBytes: Uint8Array | null;
  // Last ~8 KiB of the file. PDFs declare encryption with an /Encrypt entry in
  // the trailer at the END of the file, so the header alone is not enough.
  trailerBytes: Uint8Array | null;
}

export interface RecipientInfo {
  emailAddress: string;
  displayName: string;
}

export interface EmailData {
  subject: string;
  userEmail: string;
  to: RecipientInfo[];
  cc: RecipientInfo[];
  bcc: RecipientInfo[];
  recipients: string[]; // unique emailAddresses, lowercased
  attachments: AttachmentWithHeader[];
}
