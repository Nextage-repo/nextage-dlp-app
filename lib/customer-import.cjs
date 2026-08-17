// Works out what importing a reviewed customer list would change.
//
// Shared by scripts/import-customers.cjs and the admin import endpoint, so the two
// can never drift apart — the kind of split that produced a silent divergence
// earlier in this project.
//
// Rows are matched by DOMAIN, not by name. Matching by name would create a
// duplicate on every rename, and a duplicate is worse than a stale name: check 3
// requires every matched customer's name in the subject, so two rows sharing a
// domain make mail to that domain impossible to send.
//
// Nothing is ever marked for deletion. The workbook is reviewed in batches, so a
// customer missing from the file is far more likely to be mid-review than gone, and
// removing one silently switches off DLP for that customer.

const lower = (s) => String(s == null ? "" : s).trim().toLowerCase();

const keysOf = (c) =>
  [...new Set([lower(c.primary_domain), ...(c.domains || []).map(lower)])].filter(Boolean);

const sameSet = (a, b) =>
  JSON.stringify([...(a || [])].map(lower).sort()) === JSON.stringify([...(b || [])].map(lower).sort());

function planImport(existing, incoming) {
  // domain -> every existing row holding it. Keeping all of them matters: an
  // earlier version stored one row per domain, so a domain already shared by two
  // customers still resolved to whichever was seen first — and an incoming row
  // keyed on that domain would silently rename the wrong company.
  const owners = new Map();
  for (const row of existing) {
    for (const key of keysOf(row)) {
      if (!owners.has(key)) owners.set(key, []);
      if (!owners.get(key).some((r) => r.id === row.id)) owners.get(key).push(row);
    }
  }
  const conflicted = new Set([...owners].filter(([, rows]) => rows.length > 1).map(([key]) => key));

  const inserts = [];
  const updates = [];
  const renames = [];
  const ambiguous = [];

  for (const c of incoming) {
    const seen = new Map();
    for (const key of keysOf(c)) {
      for (const r of owners.get(key) || []) seen.set(r.id, r);
    }
    const matches = [...seen.values()];
    if (matches.length > 1) {
      ambiguous.push({ incoming: c, matches: matches.map((m) => m.name) });
      continue;
    }
    const row = matches[0];
    if (!row) {
      inserts.push(c);
      continue;
    }
    const renamed = lower(row.name) !== lower(c.name);
    const changed =
      lower(row.primary_domain) !== lower(c.primary_domain) ||
      !sameSet(row.domains, c.domains) ||
      !sameSet(row.aliases, c.aliases);
    if (renamed) renames.push({ id: row.id, from: row.name, to: c.name });
    if (renamed || changed) updates.push({ id: row.id, before: row, after: c, renamed });
  }

  const incomingKeys = new Set(incoming.flatMap(keysOf));
  const absent = existing
    .filter((row) => !keysOf(row).some((k) => incomingKeys.has(k)))
    .map((row) => row.name);

  return { inserts, updates, renames, ambiguous, conflicted: [...conflicted], absent };
}

module.exports = { planImport, keysOf, lower };
