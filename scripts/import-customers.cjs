#!/usr/bin/env node
/**
 * Applies the customer list produced by scripts/xlsx-to-customers.py to the
 * customers table.
 *
 *   node scripts/import-customers.cjs customers.json            # dry run, writes nothing
 *   node scripts/import-customers.cjs customers.json --apply    # writes
 *
 * Needs the same database environment variables server.cjs uses, so run it where
 * those are set. Nothing is written without --apply.
 *
 * Two deliberate design choices:
 *
 * 1. Rows are matched by DOMAIN, not by name. Matching by name would create a
 *    duplicate every time a customer is renamed, and duplicates are worse than a
 *    stale name: check 3 requires every matched customer's name in the subject, so
 *    two rows sharing a domain make mail to that domain unsendable.
 *
 * 2. It NEVER deletes. The workbook is reviewed in batches — only the rows marked
 *    בוצע are exported — so a customer missing from the file is far more likely to
 *    be still under review than genuinely gone. Deleting one silently switches off
 *    DLP for that customer. Removals stay a separate, explicit decision.
 *
 * A rename is reported but treated with suspicion: the same domain pointing at a
 * different company can mean a rename, an acquisition, or a mistake in the sheet.
 * --apply-renames is required before any name is overwritten.
 */
const fs = require("fs");
const { Pool } = require("pg");

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const apply = args.includes("--apply");
const applyRenames = args.includes("--apply-renames");

if (!file) {
  console.error("usage: node scripts/import-customers.cjs <customers.json> [--apply] [--apply-renames]");
  process.exit(1);
}

if (!fs.existsSync(file)) {
  console.error(`cannot find ${file}\n(paths are relative to the current directory — pass the full path if in doubt)`);
  process.exit(1);
}
const incoming = JSON.parse(fs.readFileSync(file, "utf8"));

// Fail with an explanation rather than a raw connection error. This script has to
// run somewhere that already has the database environment — in practice the App
// Service's own console, where the app's settings are present. A developer laptop
// has neither the variables nor, usually, a path through the database firewall.
const missing = ["AZURE_POSTGRESQL_HOST", "AZURE_POSTGRESQL_USER", "AZURE_POSTGRESQL_PASSWORD", "AZURE_POSTGRESQL_DATABASE"]
  .filter((k) => !process.env[k]);
if (missing.length) {
  console.error(
    `missing database environment: ${missing.join(", ")}\n\n` +
      "Run this in the App Service console, where those are already set:\n" +
      "  https://nextage-dlp-app.scm.azurewebsites.net/DebugConsole\n" +
      "  cd site\\wwwroot\n" +
      "  node scripts\\import-customers.cjs customers-done.json",
  );
  process.exit(1);
}
const lower = (s) => String(s == null ? "" : s).trim().toLowerCase();
const keysOf = (c) =>
  [...new Set([lower(c.primary_domain), ...(c.domains || []).map(lower)])].filter(Boolean);

const pool = new Pool({
  host: process.env.AZURE_POSTGRESQL_HOST,
  port: Number(process.env.AZURE_POSTGRESQL_PORT || 5432),
  user: process.env.AZURE_POSTGRESQL_USER,
  password: process.env.AZURE_POSTGRESQL_PASSWORD,
  database: process.env.AZURE_POSTGRESQL_DATABASE,
  ssl: { rejectUnauthorized: true },
});

const same = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());

(async () => {
  const existing = (await pool.query("SELECT id, name, primary_domain, aliases, domains FROM customers")).rows;
  console.log(`database: ${existing.length} customers   file: ${incoming.length} customers`);

  // domain -> existing row. A domain already shared by two rows is reported, not picked.
  const byDomain = new Map();
  const conflicted = new Set();
  for (const row of existing) {
    for (const key of keysOf(row)) {
      if (byDomain.has(key) && byDomain.get(key).id !== row.id) conflicted.add(key);
      else byDomain.set(key, row);
    }
  }

  const inserts = [];
  const updates = [];
  const renames = [];
  const ambiguous = [];

  for (const c of incoming) {
    const matches = [...new Set(keysOf(c).map((k) => byDomain.get(k)).filter(Boolean))];
    if (matches.length > 1) {
      ambiguous.push({ c, matches });
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
      !same((row.domains || []).map(lower), (c.domains || []).map(lower)) ||
      !same(row.aliases || [], c.aliases || []);
    if (renamed) renames.push({ from: row.name, to: c.name, id: row.id });
    if (renamed || changed) updates.push({ row, c, renamed });
  }

  const report = (label, items, fmt) => {
    console.log(`\n${label} (${items.length})`);
    items.slice(0, 40).forEach((i) => console.log("  " + fmt(i)));
    if (items.length > 40) console.log(`  ... and ${items.length - 40} more`);
  };

  report("ADD", inserts, (c) => `${c.name}  [${c.domains.join(", ")}]`);
  report("UPDATE", updates, ({ row, c, renamed }) => `${row.name}${renamed ? ` -> ${c.name}` : ""}  [${c.domains.join(", ")}]`);
  if (renames.length) report("RENAME — verify each one is a rename and not two different companies", renames, (r) => `${r.from}  ->  ${r.to}`);
  if (ambiguous.length) report("SKIPPED — file row matches several existing customers", ambiguous, ({ c, matches }) => `${c.name}  matches: ${matches.map((m) => m.name).join(" | ")}`);
  if (conflicted.size) report("SKIPPED — domain already shared in the database", [...conflicted], (d) => d);

  const absent = existing.filter((row) => !keysOf(row).some((k) => incoming.some((c) => keysOf(c).includes(k))));
  console.log(
    `\nIN DATABASE BUT NOT IN THIS FILE (${absent.length}) — left untouched on purpose.` +
      "\n  Most of these are the rows still with the controllers, not customers to remove." +
      "\n  Deleting one switches off DLP for that customer, so removals are a separate decision.",
  );

  if (!apply) {
    console.log("\nDRY RUN — nothing was written. Re-run with --apply to write.");
    await pool.end();
    return;
  }
  if (renames.length && !applyRenames) {
    console.log("\nSTOPPED: renames present. Re-run with --apply --apply-renames once each rename above is confirmed.");
    await pool.end();
    process.exit(2);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const c of inserts) {
      await client.query(
        "INSERT INTO customers (name, primary_domain, aliases, domains) VALUES ($1, $2, $3, $4)",
        [c.name, c.primary_domain, c.aliases, c.domains],
      );
    }
    for (const { row, c } of updates) {
      await client.query(
        "UPDATE customers SET name = $1, primary_domain = $2, aliases = $3, domains = $4 WHERE id = $5",
        [c.name, c.primary_domain, c.aliases, c.domains, row.id],
      );
    }
    await client.query("COMMIT");
    console.log(`\nAPPLIED: ${inserts.length} added, ${updates.length} updated, 0 deleted.`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("\nROLLED BACK — nothing changed:", err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})().catch((err) => {
  console.error("failed:", err.message);
  process.exit(1);
});
