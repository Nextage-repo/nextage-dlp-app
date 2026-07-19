// Customer and configuration data models (Cosmos DB schema)

export type Status = "ACTIVE" | "INACTIVE";

export interface Customer {
  id: string;
  partitionKey: "customers";
  customerName: string;
  aliases: string[];
  primaryDomain: string;
  additionalDomains: string[];
  status: Status;
  updatedAt: string;
}

export interface Advisor {
  id: string;
  partitionKey: "advisors";
  advisorName: string;
  emailDomain: string;
  linkedCustomers: string[];
  status: Status;
  updatedAt?: string;
}

export type ExemptionType =
  | "ALL_CHECKS"
  | "CHECK_1_ONLY"
  | "CHECK_2_BYPASS"
  | "CHECK_3_BYPASS"
  | "BYPASS_WARNING";

export interface Exemption {
  id: string;
  partitionKey: "exemptions";
  userEmail: string;
  fullName: string;
  exemptionType: ExemptionType;
  scope: string;
  expiryDate: string | null;
}

export interface Exclusion {
  id: string;
  partitionKey: "exclusions";
  emailAddress: string | null;
  domainPattern: string | null;
  allowUnencrypted: boolean;
  reason: string;
  expiryDate: string | null;
}

// "חוקים" (Rules) — subject-based exemption expressions. A rule whose expression
// appears (case-insensitive substring) in the email subject skips ONLY the
// encryption check (Check 1). Filename (Check 2) and subject/domain (Check 3) still run.
export interface Rule {
  id: string;
  expression: string;
  language: string;
  ruleType: string; // e.g. "Encryption Exemption"
  active: boolean;
}

// "תפקידים" (Roles) — a named policy assigned to one or more sender emails. A role
// bypasses the checks listed in `bypassChecks` for anyone whose email is assigned to
// it. First role: CFO, which bypasses ONLY the encryption check ([1]) — a CFO can send
// unencrypted files, while filename (Check 2) and subject/domain (Check 3) still run.
// Distinct from `Exemption` (per-email) — a Role defines the policy once and is shared
// across many emails, and from `Rule` (subject-matched). Note: Role ≠ Rule.
export interface Role {
  id: string;
  roleName: string;
  assignedEmails: string[];
  bypassChecks: number[]; // which checks this role skips, e.g. [1] = encryption only
  active: boolean;
}

export interface DLPConfig {
  customers: Customer[];
  advisors: Advisor[];
  exemptions: Exemption[];
  exclusions: Exclusion[];
  rules: Rule[];
  roles: Role[];
}
