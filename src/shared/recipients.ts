// Recipient classification shared by the send handler and the task pane.
//
// Outlook returns one entry per resolved recipient, but an internal distribution
// group ("#Daily") carries NO SMTP address — Classic Outlook reports a legacy
// Exchange DN, or nothing at all, and marks the entry recipientType
// "distributionList". Because every caller keeps only addresses containing "@",
// a mail addressed solely to a group used to arrive at the checks with an empty
// recipient list, which tripped the "אין נמענים" guard and raised the prompt on
// every send to a group.
//
// Splitting the entries keeps the three cases apart:
//   addresses  — real SMTP addresses, the only thing the checks can reason about
//   groups     — internal groups/GAL entries: internal by definition, no address
//   unresolved — anything else without an address (typed text Outlook never
//                resolved); still worth warning about, since it may be external

import { RecipientInfo } from "../models/dlp-result.model";
import { INTERNAL_DOMAIN } from "./constants";

export interface SplitRecipients {
  addresses: string[];
  groups: RecipientInfo[];
  unresolved: RecipientInfo[];
}

// recipientType values Office.js reports for an address book entry that resolves
// inside the organization. Both are internal by definition.
const INTERNAL_TYPES = ["distributionlist", "internal"];

export function splitRecipients(entries: RecipientInfo[]): SplitRecipients {
  const addresses: string[] = [];
  const groups: RecipientInfo[] = [];
  const unresolved: RecipientInfo[] = [];

  for (const entry of entries) {
    const address = (entry.emailAddress ?? "").toLowerCase().trim();
    if (address.length > 0 && address.includes("@")) {
      addresses.push(address);
    } else if (INTERNAL_TYPES.includes((entry.recipientType ?? "").toLowerCase())) {
      groups.push(entry);
    } else {
      unresolved.push(entry);
    }
  }

  return { addresses: Array.from(new Set(addresses)), groups, unresolved };
}

export function isInternalAddress(address: string): boolean {
  return address.toLowerCase().endsWith(`@${INTERNAL_DOMAIN}`);
}

// True when nothing in this mail can leave the organization: at least one
// recipient, no unresolved entries, and every SMTP address on the internal
// domain. Internal groups satisfy it on their own — the add-in cannot expand a
// group client-side, so a group is judged by its own internal type.
export function isInternalOnly(split: SplitRecipients): boolean {
  const total = split.addresses.length + split.groups.length + split.unresolved.length;
  if (total === 0) return false;
  if (split.unresolved.length > 0) return false;
  return split.addresses.every(isInternalAddress);
}
