#!/usr/bin/env python3
"""Turn the controllers' customer workbook into JSON for scripts/import-customers.cjs.

    python scripts/xlsx-to-customers.py "<path to .xlsx>" out.json

Only rows whose סטטוס column reads "בוצע" are exported: the rest are still with the
controllers, and importing a half-reviewed row would put unverified data in front of
DLP enforcement.

The workbook is filled in by hand, so this validates rather than trusts:

* Domains are split on comma, semicolon, newline, slash and apostrophe. The
  instruction sheet says commas, but real rows have used " / " and "' ", which a
  comma-only split would swallow into one unusable value.
* Surrounding double quotes are stripped — several rows carry alias text like
  "capsule" in the domains column.
* Anything that still does not look like a domain or an address is reported and
  dropped, never guessed at.
* A name containing a double space is reported: check 3 looks for the customer name
  as a substring of the subject, so "Arrakis  security" would never match a subject
  typed with one space, and that customer would be blocked on every send.
* A domain claimed by more than one customer is reported. Check 3 requires EVERY
  matched customer's name in the subject, so a shared domain means mail to it can
  never satisfy the check. The instruction sheet tells controllers to flag these
  rather than guess, and so does this script.
"""
import json
import re
import sys
from collections import defaultdict

try:
    import openpyxl
except ImportError:
    sys.exit("openpyxl is required: python -m pip install openpyxl")

DONE = "בוצע"
STATUS_COL, NAME_COL, PRIMARY_COL, ALIAS_COL, DOMAIN_COL = 5, 0, 1, 2, 3
SPLIT = re.compile(r"[,;\n/']+")
DOMAIN_RE = re.compile(r"^[a-z0-9.-]+\.[a-z]{2,}$")
ADDRESS_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$")


def text(v):
    return "" if v is None else str(v).strip()


def parts(v):
    return [p for p in (x.strip().strip('"').strip() for x in SPLIT.split(text(v))) if p]


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    src, dest = sys.argv[1], sys.argv[2]

    sheet = openpyxl.load_workbook(src, data_only=True, read_only=True)["לקוחות"]
    rows = list(sheet.iter_rows(values_only=True))
    header = next(i for i, r in enumerate(rows) if r and text(r[NAME_COL]) == "שם לקוח")

    customers, dropped, pending, owners = [], [], 0, defaultdict(set)
    for line, row in enumerate(rows[header + 1:], start=header + 2):
        name = text(row[NAME_COL])
        if not name:
            continue
        if text(row[STATUS_COL]) != DONE:
            pending += 1
            continue

        domains = []
        for entry in (d.lower() for d in parts(row[DOMAIN_COL])):
            if ADDRESS_RE.match(entry):
                domains.append(entry)
            elif DOMAIN_RE.match(entry):
                domains.append(entry)
                owners[entry].add(name)
            else:
                dropped.append((line, name, entry))

        customers.append({
            "row": line,
            "name": name,
            "primary_domain": text(row[PRIMARY_COL]).lower(),
            "aliases": parts(row[ALIAS_COL]),
            "domains": domains,
        })

    spaced = [(c["row"], c["name"]) for c in customers if "  " in c["name"]]
    shared = {d: sorted(v) for d, v in owners.items() if len(v) > 1}
    blank = [(c["row"], c["name"]) for c in customers if not c["domains"] and not c["primary_domain"]]

    print(f"exported {len(customers)} customers marked '{DONE}'  (skipped {pending} not yet done)")

    for label, items in (
        ("dropped — not a domain or address", [f"row {r}  {n}  ->  {e!r}" for r, n, e in dropped]),
        ("BLOCKS EVERY SEND — double space in name", [f"row {r}  {n!r}" for r, n in spaced]),
        ("BLOCKS EVERY SEND — domain shared by several customers",
         [f"{d}  ->  {' | '.join(v)}" for d, v in shared.items()]),
        ("no domain at all — cannot ever match", [f"row {r}  {n}" for r, n in blank]),
    ):
        if items:
            print(f"\n{label}  ({len(items)})")
            for item in items:
                print(f"  {item}")

    with open(dest, "w", encoding="utf-8") as fh:
        json.dump(customers, fh, ensure_ascii=False, indent=1)
    print(f"\nwrote {dest}")

    if spaced or shared:
        print("\nFix the two 'BLOCKS EVERY SEND' categories before importing.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
