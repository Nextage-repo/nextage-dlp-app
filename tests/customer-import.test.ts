// Guards the import planner. Every case here maps to a way this could quietly
// damage enforcement rather than merely be untidy.
/* eslint-disable @typescript-eslint/no-var-requires */
const { planImport } = require("../lib/customer-import.cjs");

const row = (id: number, name: string, primary: string, domains: string[], aliases: string[] = []) => ({
  id,
  name,
  primary_domain: primary,
  domains,
  aliases,
});

describe("planImport", () => {
  it("adds a customer whose domains are unknown", () => {
    const plan = planImport([], [row(0, "New Co", "new.com", ["new.com"])]);
    expect(plan.inserts.map((c: any) => c.name)).toEqual(["New Co"]);
    expect(plan.updates).toEqual([]);
  });

  // Matching by name would insert a second row here, and two rows sharing a domain
  // make mail to that domain unsendable — worse than the stale name it "fixed".
  it("updates in place on a rename instead of duplicating", () => {
    const existing = [row(7, "Old Name", "same.com", ["same.com"])];
    const plan = planImport(existing, [row(0, "New Name", "same.com", ["same.com"])]);
    expect(plan.inserts).toEqual([]);
    expect(plan.updates).toHaveLength(1);
    expect(plan.renames).toEqual([{ id: 7, from: "Old Name", to: "New Name" }]);
  });

  // The case Mor spotted: same name, but the reviewed row carries aliases the
  // database lacks. Aliases decide whether the subject check passes, so missing
  // them means false blocks — and a name-only comparison would call this unchanged.
  it("updates when only aliases differ", () => {
    const existing = [row(3, "Regulus Cyber", "regulus.com", ["regulus.com"], ["Regulus"])];
    const incoming = [row(0, "Regulus Cyber", "regulus.com", ["regulus.com"], ["Regulus", "רגולוס"])];
    const plan = planImport(existing, incoming);
    expect(plan.updates).toHaveLength(1);
    expect(plan.renames).toEqual([]);
  });

  it("reports nothing to do when the rows already match", () => {
    const same = [row(1, "Same", "a.com", ["a.com"], ["A"])];
    const plan = planImport(same, [row(0, "Same", "a.com", ["a.com"], ["A"])]);
    expect(plan.updates).toEqual([]);
    expect(plan.inserts).toEqual([]);
  });

  it("ignores case and whitespace when comparing", () => {
    const existing = [row(1, "Acme", "ACME.com", [" acme.com "], ["Ac"])];
    const plan = planImport(existing, [row(0, "Acme", "acme.com", ["acme.com"], ["Ac"])]);
    expect(plan.updates).toEqual([]);
  });

  // Guessing here could move a domain to the wrong company, so the row is skipped.
  it("skips a row that matches several existing customers", () => {
    const existing = [
      row(1, "First", "one.com", ["one.com", "shared.com"]),
      row(2, "Second", "two.com", ["two.com", "shared.com"]),
    ];
    const plan = planImport(existing, [row(0, "Whoever", "shared.com", ["shared.com"])]);
    expect(plan.inserts).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.ambiguous).toHaveLength(1);
    expect(plan.conflicted).toContain("shared.com");
  });

  // Absent rows are reported for a human to read, never queued for deletion:
  // the file only carries the batch the controllers have finished reviewing.
  it("lists database rows missing from the file without deleting them", () => {
    const existing = [row(1, "Kept", "a.com", ["a.com"]), row(2, "Pending Review", "b.com", ["b.com"])];
    const plan = planImport(existing, [row(0, "Kept", "a.com", ["a.com"])]);
    expect(plan.absent).toEqual(["Pending Review"]);
    expect(plan).not.toHaveProperty("deletes");
  });
});
