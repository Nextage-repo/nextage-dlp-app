const express = require("express");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const app = express();

// App Service terminates TLS and forwards to iisnode over plain HTTP, so without
// this `req.protocol` reports "http" and the admin CORS origin below is built as
// http://… — which matches no real browser origin. Trusting the proxy makes
// req.protocol follow X-Forwarded-Proto and yields the correct https:// origin.
app.set("trust proxy", true);

// Audit-log retention. The client sends a `ttl` field, but nothing ever acted on
// it — rows accumulated forever. purgeOldAuditRows() below enforces this instead.
const RETENTION_DAYS = parseInt(process.env.AUDIT_RETENTION_DAYS || "90");
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// PostgreSQL connection.
//
// SECURITY: `rejectUnauthorized: true` — the server's TLS certificate IS verified.
// This used to be `false`, which encrypted the connection but accepted ANY
// certificate, leaving it open to man-in-the-middle inside the Azure network.
// No `ca` is supplied on purpose: Azure Database for PostgreSQL chains to
// DigiCert Global Root G2 / Microsoft RSA Root CA 2017, both of which are in
// Node's bundled Mozilla root store — so validation works without pinning a PEM
// in the repo (and won't break when Azure rotates its intermediate certs).
const pool = new Pool({
  host: process.env.AZURE_POSTGRESQL_HOST,
  database: process.env.AZURE_POSTGRESQL_DATABASE,
  user: process.env.AZURE_POSTGRESQL_USER,
  password: process.env.AZURE_POSTGRESQL_PASSWORD,
  port: parseInt(process.env.AZURE_POSTGRESQL_PORT || "5432"),
  ssl: { rejectUnauthorized: true }
});

// Create tables if they don't exist
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        primary_domain TEXT,
        aliases TEXT[] NOT NULL DEFAULT '{}',
        domains TEXT[] NOT NULL DEFAULT '{}'
      );
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS primary_domain TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS aliases TEXT[] NOT NULL DEFAULT '{}';
      CREATE TABLE IF NOT EXISTS advisors (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        linked_customers TEXT[] NOT NULL DEFAULT '{}'
      );
      ALTER TABLE advisors ADD COLUMN IF NOT EXISTS linked_customers TEXT[] NOT NULL DEFAULT '{}';
      CREATE TABLE IF NOT EXISTS exemptions (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        reason TEXT
      );
      CREATE TABLE IF NOT EXISTS exclusions (
        id SERIAL PRIMARY KEY,
        extension TEXT NOT NULL,
        reason TEXT
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        user_email TEXT,
        action TEXT,
        data JSONB
      );
      CREATE TABLE IF NOT EXISTS rules (
        id SERIAL PRIMARY KEY,
        expression TEXT NOT NULL,
        language TEXT DEFAULT 'Hebrew',
        rule_type TEXT NOT NULL DEFAULT 'Encryption Exemption',
        active BOOLEAN NOT NULL DEFAULT TRUE
      );
      CREATE TABLE IF NOT EXISTS roles (
        id SERIAL PRIMARY KEY,
        role_name TEXT NOT NULL,
        assigned_emails TEXT[] NOT NULL DEFAULT '{}',
        bypass_checks INT[] NOT NULL DEFAULT '{}',
        active BOOLEAN NOT NULL DEFAULT TRUE
      );
      -- "מוחרגים" — trusted external recipients/domains that skip all DLP checks.
      CREATE TABLE IF NOT EXISTS excluded_recipients (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'EMAIL',
        reason TEXT,
        expiry_date DATE,
        requested_by TEXT
      );
      -- "דורשי הצפנה" — filename keywords; a file must be encrypted only if its
      -- name contains one of these (normalized, name-based encryption enforcement).
      CREATE TABLE IF NOT EXISTS encryption_keywords (
        id SERIAL PRIMARY KEY,
        keyword TEXT NOT NULL,
        note TEXT,
        active BOOLEAN NOT NULL DEFAULT TRUE
      );
      -- Indexes keep the audit-log filters fast as the table grows (200+ users).
      CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_user_email ON audit_log (user_email);
    `);

    // Seed the "חוקים" rules list once (only if empty).
    const ruleCount = await pool.query("SELECT COUNT(*)::int AS n FROM rules");
    if (ruleCount.rows[0].n === 0) {
      const seed = [
        ["חשבונית ספק", "Hebrew"],
        ["חשבוניות ספק", "Hebrew"],
        ["AP Invoice", "English"],
        ["AP Invoices", "English"],
        ["חשבונית לקוח", "Hebrew"],
        ["חשבוניות לקוח", "Hebrew"],
        ["AR Invoice", "English"],
        ["AR Invoices", "English"],
      ];
      for (const [expr, lang] of seed) {
        await pool.query(
          "INSERT INTO rules (expression, language, rule_type, active) VALUES ($1, $2, 'Encryption Exemption', TRUE)",
          [expr, lang],
        );
      }
      console.log("✅ Seeded rules (חוקים) with " + seed.length + " expressions");
    }

    // Seed the "תפקידים" roles list once (only if empty). First role: CFO,
    // which bypasses ONLY the encryption check (bypass_checks = {1}). Emails are
    // assigned per deployment via the admin panel, so seed with an empty list.
    const roleCount = await pool.query("SELECT COUNT(*)::int AS n FROM roles");
    if (roleCount.rows[0].n === 0) {
      await pool.query(
        "INSERT INTO roles (role_name, assigned_emails, bypass_checks, active) VALUES ($1, $2, $3, TRUE)",
        ["CFO", [], [1]],
      );
      console.log("✅ Seeded roles (תפקידים) with the CFO role (skips encryption)");
    }

    // Seed the "דורשי הצפנה" keyword list once (only if empty). Matching is
    // normalized (case/space/underscore/hyphen-insensitive), so one Hebrew + one
    // English form per concept covers all the punctuation/spacing variants.
    const kwCount = await pool.query("SELECT COUNT(*)::int AS n FROM encryption_keywords");
    if (kwCount.rows[0].n === 0) {
      const kwSeed = [
        ["קאש ברן", "דוח קאש ברן"], ["cash burn", "Cash burn report"],
        ["דוח חודשי", "דוח חודשי"], ["monthly report", "Monthly report"],
        ["שכר", "שכר / תלושי שכר"], ["payroll", "Payroll"], ["salary", "Salary"],
        ["תלוש", "תלוש שכר"], ["payslip", "Payslip"],
        ["טופס 106", "טופס 106"], ["form 106", "Form 106"],
        ["מאזן בוחן", "מאזן בוחן / trial balance"], ["trial balance", "Trial balance"],
        ["דוח כספי", "דוחות כספיים"], ["financial statement", "Financial statements"],
        ["תקציב", "תקציב"], ["budget", "Budget"],
      ];
      for (const [keyword, note] of kwSeed) {
        await pool.query("INSERT INTO encryption_keywords (keyword, note, active) VALUES ($1, $2, TRUE)", [keyword, note]);
      }
      console.log("✅ Seeded encryption_keywords (דורשי הצפנה) with " + kwSeed.length + " keywords");
    }
    console.log("✅ Database tables ready");
  } catch (err) {
    console.error("❌ DB init error:", err.message);
  }
}

// Parse JSON bodies. The permissive "text/plain" type is scoped to /api/audit
// ONLY — it must not apply to the admin routes, and the split is a CSRF control:
//
// A POST carrying Content-Type: text/plain is a CORS "simple" request, so the
// browser sends it WITHOUT a preflight and the CORS allowlist never gets to
// reject it. Admin auth is Easy Auth's session cookie, so while an admin is
// signed in, a page on any other origin could POST a text/plain body to
// /api/admin/* and the write would execute — the attacker never needs to read
// the response. The worst case is POST /api/admin/excluded adding a
// DOMAIN-scoped exclusion, which silently disables all three checks for a
// domain of the attacker's choosing. (PUT and DELETE are not "simple" methods,
// so those do preflight and are already blocked.) Whether the browser actually
// attaches the cookie depends on Azure's SameSite attribute, which is outside
// this repo's control — scoping the parser removes the dependency on it.
//
// The add-in genuinely needs text/plain for audit: Classic Outlook's JS-only
// send runtime cannot complete a preflight, and with the default
// (application/json only) those bodies were dropped, so audit rows were written
// with null user/action and empty data. The admin panel posts application/json
// (see saveRow), so it is unaffected by the stricter parser below.
//
// `limit` caps the body at 64 KB on both. A legitimate audit entry is well under
// 4 KB; without a cap an unauthenticated caller could push arbitrarily large
// bodies at /api/audit (the endpoint cannot require auth — see the CORS note
// below).
app.use("/api/audit", express.json({ type: ["application/json", "text/plain"], limit: "64kb" }));
// /api/resolve is called from the same send-event runtime as /api/audit, so it
// needs the same text/plain allowance to stay a CORS simple request.
app.use("/api/resolve", express.json({ type: ["application/json", "text/plain"], limit: "64kb" }));
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "dist")));

// ── Security headers ─────────────────────────────────────────────────────────
// Set by hand rather than via helmet: the runtime dependency list is deliberately
// just express + pg. A missing/pruned module here would crash server.cjs, and a
// dead backend means /api/config fails, which makes every add-in fail OPEN (i.e.
// silently disables DLP org-wide). Not worth the risk for six headers.
app.use((req, res, next) => {
  res.header("X-Content-Type-Options", "nosniff");
  res.header("X-Frame-Options", "DENY");
  res.header("Referrer-Policy", "no-referrer");
  res.header("Cross-Origin-Opener-Policy", "same-origin");
  res.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.removeHeader("X-Powered-By");
  next();
});

// ── CORS ─────────────────────────────────────────────────────────────────────
// Split by route class, because the two classes have opposite constraints:
//
// * /api/config + /api/audit MUST stay wildcard-open. Classic Outlook's JS-only
//   OnMessageSend runtime can only issue CORS "simple" requests — it cannot
//   complete a preflight — so these calls carry no Origin we can allow-list and
//   no Authorization header. Wildcard is safe here specifically because these
//   endpoints are credential-free: `*` makes browsers refuse to attach cookies,
//   and neither endpoint reads a session. Abuse is limited to volume, which the
//   rate limiter below handles.
//
// * /api/admin/* + /admin are session-authenticated via Easy Auth, so they must
//   NOT be wildcard. They now reflect only this app's own origin, so a malicious
//   page cannot read admin JSON (customer lists, the audit log) out of a signed-in
//   admin's browser.
app.use((req, res, next) => {
  const isAdminRoute = req.path === "/admin" || req.path.startsWith("/api/admin");
  if (isAdminRoute) {
    res.header("Access-Control-Allow-Origin", `${req.protocol}://${req.get("host")}`);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Credentials", "true");
  } else {
    res.header("Access-Control-Allow-Origin", "*");
  }
  res.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── Rate limiting ────────────────────────────────────────────────────────────
// Fixed-window in-memory counter, keyed by client IP. Dependency-free for the
// same reason as the headers above.
//
// LIMITATION worth knowing: the counters live in this process, so limits are
// per-instance. The Web App runs a single instance today; if it is ever scaled
// out, the effective limit multiplies by the instance count. That is acceptable
// for abuse-dampening (this is not a quota mechanism).
const rateBuckets = new Map();

// `onLimit` lets a route degrade instead of rejecting. /api/config uses it to
// serve a cached copy, because a 429 there is worse than the abuse it prevents
// (see the note above the limiter definitions).
function rateLimit({ windowMs, max, name, onLimit }) {
  return (req, res, next) => {
    // Take the LAST X-Forwarded-For entry, not the first. A client can send its
    // own X-Forwarded-For and App Service appends the real peer address to it, so
    // the leftmost value is attacker-controlled — keying on it would let a caller
    // rotate that header and sidestep the limit entirely. The rightmost entry is
    // the one App Service added. Port suffixes are stripped so the same client
    // does not get a fresh bucket per source port.
    const xff = (req.headers["x-forwarded-for"] || "").toString().split(",");
    const ip = (xff[xff.length - 1] || "").trim().replace(/:\d+$/, "")
      || req.socket.remoteAddress
      || "unknown";
    const key = `${name}:${ip}`;
    const now = Date.now();
    const b = rateBuckets.get(key);
    if (!b || now >= b.resetAt) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (b.count >= max) {
      if (onLimit && onLimit(req, res)) return;
      res.header("Retry-After", Math.ceil((b.resetAt - now) / 1000));
      return res.status(429).json({ error: "Too many requests" });
    }
    b.count++;
    next();
  };
}

// Evict expired buckets so the map cannot grow without bound (a spray of unique
// source IPs would otherwise be a slow memory leak). `unref()` keeps this timer
// from holding the event loop open.
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of rateBuckets) if (now >= b.resetAt) rateBuckets.delete(key);
}, 10 * 60 * 1000).unref();

// ⚠️ These limits MUST stay generous, and the reason is specific to this app.
//
// Every user sits behind the same corporate NAT, so all ~200 of them share one
// public IP: a per-IP limit cannot tell an attacker apart from the whole company.
// Client-side config caching is 60 minutes, which means the cache expires in
// waves — Monday morning, everyone opens Outlook at once and the burst arrives
// from a single address. A measured test confirmed the earlier 60/min ceiling
// rejected 20 of 80 requests from one IP.
//
// A rejected /api/config is not a harmless retry: the add-in FAILS OPEN when it
// cannot load config, so throttling our own users would silently switch DLP off
// during the busiest sending hour of the week. That is strictly worse than the
// flooding this is meant to dampen.
//
// Correction to an earlier version of this note, which claimed these endpoints
// expose no user data: /api/config does. It returns advisor names and emails, the
// exempt user's address, and the full excluded-recipient list — see the exposure
// table in DLP-Guard-Security-Spec.docx. The limits below are still sized for
// availability rather than confidentiality, and a single request retrieves
// everything, so rate limiting is not a control against that exposure.
//
// So the limits are set to catch only obvious abuse, and /api/config degrades to
// a cached copy instead of rejecting (see serveCachedConfig).
const configLimiter = rateLimit({
  windowMs: 60 * 1000, max: 600, name: "config",
  onLimit: (req, res) => serveCachedConfig(res, "rate-limit"),
});
// Audit is more permissive still: one email writes several rows (one per failed
// check), and a dropped row is a lost compliance record.
const auditLimiter = rateLimit({ windowMs: 60 * 1000, max: 1200, name: "audit" });
// Resolve is called about once per send, like config, so it gets the same ceiling.
// Unlike config it has no cached fallback (a stale roster would answer "unknown"
// for a new customer), so it rejects instead of degrading.
const resolveLimiter = rateLimit({ windowMs: 60 * 1000, max: 600, name: "resolve" });

// Server-side memo of the last successful /api/config payload. Two jobs: it lets
// a burst be answered without hitting Postgres, and it is what the limiter falls
// back to so the add-in keeps working instead of failing open.
const CONFIG_MEMO_MS = 30 * 1000;
let configMemo = null; // { payload, at }

// ── Recipient-scoped resolve ─────────────────────────────────────────────────
// /api/config hands the whole customer roster to anyone who asks. /api/resolve
// answers a question instead: "for these recipients, which customers match, and
// which domains are unknown?" The roster never leaves the server, so it cannot be
// enumerated — a caller must already know a domain to learn its customer name.
//
// The matching rules mirror the client's and live in lib/resolve-match.cjs so they
// can be unit-tested (tests/resolve-match.test.ts). Do not reimplement them here.
const { planImport } = require("./lib/customer-import.cjs");
const {
  matchCustomers,
  buildKnown,
  findUnknownDomains,
  matchExcluded,
  isUserExempt,
} = require("./lib/resolve-match.cjs");

const RESOLVE_MEMO_MS = 30 * 1000;
let resolveMemo = null; // { data, at }

// Memoised for the same reason as configMemo: one send can resolve several
// recipients, and the roster changes only when an admin edits it.
async function loadResolveData() {
  if (resolveMemo && Date.now() - resolveMemo.at < RESOLVE_MEMO_MS) return resolveMemo.data;
  const [customers, advisors, exemptions, excluded] = await Promise.all([
    pool.query("SELECT id, name, primary_domain, aliases, domains FROM customers"),
    pool.query("SELECT id, email FROM advisors"),
    pool.query("SELECT id, email FROM exemptions"),
    pool.query(
      "SELECT id, email, scope, expiry_date FROM excluded_recipients WHERE expiry_date IS NULL OR expiry_date >= CURRENT_DATE",
    ),
  ]);
  const data = {
    customers: customers.rows,
    advisors: advisors.rows,
    exemptions: exemptions.rows,
    excluded: excluded.rows,
  };
  resolveMemo = { data, at: Date.now() };
  return data;
}

function serveCachedConfig(res, reason) {
  if (!configMemo) return false;
  res.header("X-Config-Cache", reason);
  res.json(configMemo.payload);
  return true;
}

// ── Admin auth ───────────────────────────────────────────────────────────────
// Entra ID only, via App Service Easy Auth: the caller must be signed in AND be a
// member of the ADMIN_GROUP_ID security group. There is no password fallback.
// Easy Auth strips inbound X-MS-CLIENT-PRINCIPAL* headers, so the principal can't
// be forged — but that guarantee only holds while the App Service Authentication
// module is enabled. Never run this app with it turned off.
const ADMIN_GROUP_ID = (process.env.ADMIN_GROUP_ID || "").trim();

function getPrincipal(req) {
  const raw = req.headers["x-ms-client-principal"];
  if (!raw) return null;
  try {
    const p = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    const claims = p.claims || [];
    const vals = (t) => claims.filter(c => c.typ === t || c.typ.endsWith("/" + t)).map(c => c.val);
    return {
      email: (vals("preferred_username")[0] || vals("emailaddress")[0] || vals("upn")[0] || "").toLowerCase(),
      name: vals("name")[0] || "",
      groups: vals("groups")
    };
  } catch {
    return null;
  }
}

// Fails closed: no group configured means nobody gets in.
function isAdminUser(p) {
  if (!p || !ADMIN_GROUP_ID) return false;
  return p.groups.includes(ADMIN_GROUP_ID);
}

function adminAuth(req, res, next) {
  const p = getPrincipal(req);
  if (!p) return res.status(401).json({ error: "Not signed in" });
  if (!isAdminUser(p)) return res.status(403).json({ error: "Forbidden" });
  req.adminUser = p;

  // Reject a write whose body was never parsed. Only /api/audit accepts
  // text/plain (see the parser note above), so a POST/PUT arriving here with any
  // other content type leaves req.body undefined. Without this the handlers
  // destructure undefined and throw, which turns a rejected request into a 500.
  // The panel always sends application/json, so this only fires on requests that
  // were not made by the panel — including the cross-site POST the parser split
  // is there to stop.
  if ((req.method === "POST" || req.method === "PUT") &&
      (req.body === null || typeof req.body !== "object")) {
    return res.status(400).json({ error: "Expected Content-Type: application/json" });
  }

  next();
}

// Guards the /admin page itself: redirects to sign-in instead of returning JSON.
function adminPage(req, res, next) {
  const p = getPrincipal(req);
  if (!p) {
    return res.redirect("/.auth/login/aad?post_login_redirect_uri=" + encodeURIComponent(req.originalUrl));
  }
  if (!isAdminUser(p)) {
    return res.status(403).send(`<!DOCTYPE html>
<html lang="he" dir="rtl"><head><meta charset="UTF-8"/><title>אין הרשאה</title></head>
<body style="font-family:'Segoe UI',sans-serif;text-align:center;padding:80px 20px;background:#f5f6f8">
  <h1 style="font-size:28px;color:#1a1a2e">⛔ אין הרשאה</h1>
  <p style="color:#555;font-size:15px">המשתמש <b>${p.email}</b> אינו חבר בקבוצת מנהלי DLP Guard.</p>
  <p style="margin-top:24px"><a href="/.auth/logout?post_logout_redirect_uri=%2Fadmin" style="color:#0078d4">התחבר עם משתמש אחר</a></p>
</body></html>`);
  }
  req.adminUser = p;
  next();
}

// ── ADMIN API ENDPOINTS ──────────────────────────────────────────────────────

// Customers
app.get("/api/admin/customers", adminAuth, async (req, res) => {
  const r = await pool.query("SELECT * FROM customers ORDER BY id");
  res.json(r.rows);
});
app.post("/api/admin/customers", adminAuth, async (req, res) => {
  const { name, primary_domain, aliases, domains } = req.body;
  const r = await pool.query(
    "INSERT INTO customers (name, primary_domain, aliases, domains) VALUES ($1, $2, $3, $4) RETURNING *",
    [name, primary_domain, aliases, domains]
  );
  res.json(r.rows[0]);
});
app.put("/api/admin/customers/:id", adminAuth, async (req, res) => {
  const { name, primary_domain, aliases, domains } = req.body;
  const r = await pool.query(
    "UPDATE customers SET name=$1, primary_domain=$2, aliases=$3, domains=$4 WHERE id=$5 RETURNING *",
    [name, primary_domain, aliases, domains, req.params.id]
  );
  res.json(r.rows[0]);
});
app.delete("/api/admin/customers/:id", adminAuth, async (req, res) => {
  await pool.query("DELETE FROM customers WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// Advisors
app.get("/api/admin/advisors", adminAuth, async (req, res) => {
  const r = await pool.query("SELECT * FROM advisors ORDER BY id");
  res.json(r.rows);
});
app.post("/api/admin/advisors", adminAuth, async (req, res) => {
  const { email, name, linked_customers } = req.body;
  const r = await pool.query(
    "INSERT INTO advisors (email, name, linked_customers) VALUES ($1, $2, $3) RETURNING *",
    [email, name, linked_customers || []]
  );
  res.json(r.rows[0]);
});
app.put("/api/admin/advisors/:id", adminAuth, async (req, res) => {
  const { email, name, linked_customers } = req.body;
  const r = await pool.query(
    "UPDATE advisors SET email=$1, name=$2, linked_customers=$3 WHERE id=$4 RETURNING *",
    [email, name, linked_customers || [], req.params.id]
  );
  res.json(r.rows[0]);
});
app.delete("/api/admin/advisors/:id", adminAuth, async (req, res) => {
  await pool.query("DELETE FROM advisors WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// Exemptions
app.get("/api/admin/exemptions", adminAuth, async (req, res) => {
  const r = await pool.query("SELECT * FROM exemptions ORDER BY id");
  res.json(r.rows);
});
app.post("/api/admin/exemptions", adminAuth, async (req, res) => {
  const { email, reason } = req.body;
  const r = await pool.query(
    "INSERT INTO exemptions (email, reason) VALUES ($1, $2) RETURNING *",
    [email, reason]
  );
  res.json(r.rows[0]);
});
app.put("/api/admin/exemptions/:id", adminAuth, async (req, res) => {
  const { email, reason } = req.body;
  const r = await pool.query(
    "UPDATE exemptions SET email=$1, reason=$2 WHERE id=$3 RETURNING *",
    [email, reason, req.params.id]
  );
  res.json(r.rows[0]);
});
app.delete("/api/admin/exemptions/:id", adminAuth, async (req, res) => {
  await pool.query("DELETE FROM exemptions WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// Exclusions
app.get("/api/admin/exclusions", adminAuth, async (req, res) => {
  const r = await pool.query("SELECT * FROM exclusions ORDER BY id");
  res.json(r.rows);
});
app.post("/api/admin/exclusions", adminAuth, async (req, res) => {
  const { extension, reason } = req.body;
  const r = await pool.query(
    "INSERT INTO exclusions (extension, reason) VALUES ($1, $2) RETURNING *",
    [extension, reason]
  );
  res.json(r.rows[0]);
});
app.put("/api/admin/exclusions/:id", adminAuth, async (req, res) => {
  const { extension, reason } = req.body;
  const r = await pool.query(
    "UPDATE exclusions SET extension=$1, reason=$2 WHERE id=$3 RETURNING *",
    [extension, reason, req.params.id]
  );
  res.json(r.rows[0]);
});
app.delete("/api/admin/exclusions/:id", adminAuth, async (req, res) => {
  await pool.query("DELETE FROM exclusions WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// Rules (חוקים) — subject-based encryption-exemption expressions
app.get("/api/admin/rules", adminAuth, async (req, res) => {
  const r = await pool.query("SELECT * FROM rules ORDER BY id");
  res.json(r.rows);
});
app.post("/api/admin/rules", adminAuth, async (req, res) => {
  const { expression, language, rule_type, active } = req.body;
  const r = await pool.query(
    "INSERT INTO rules (expression, language, rule_type, active) VALUES ($1, $2, $3, $4) RETURNING *",
    [expression, language || "Hebrew", rule_type || "Encryption Exemption", active !== false]
  );
  res.json(r.rows[0]);
});
app.put("/api/admin/rules/:id", adminAuth, async (req, res) => {
  const { expression, language, rule_type, active } = req.body;
  const r = await pool.query(
    "UPDATE rules SET expression=$1, language=$2, rule_type=$3, active=$4 WHERE id=$5 RETURNING *",
    [expression, language || "Hebrew", rule_type || "Encryption Exemption", active !== false, req.params.id]
  );
  res.json(r.rows[0]);
});
app.delete("/api/admin/rules/:id", adminAuth, async (req, res) => {
  await pool.query("DELETE FROM rules WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// Roles (תפקידים) — named policies (e.g. CFO) that bypass specific checks per email
function normalizeEmails(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === "string")
    return v.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
  return [];
}
function normalizeChecks(v) {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;\s]+/) : [];
  return arr.map((n) => parseInt(n, 10)).filter((n) => n === 1 || n === 2 || n === 3);
}
app.get("/api/admin/roles", adminAuth, async (req, res) => {
  const r = await pool.query("SELECT * FROM roles ORDER BY id");
  res.json(r.rows);
});
app.post("/api/admin/roles", adminAuth, async (req, res) => {
  const { role_name, assigned_emails, bypass_checks, active } = req.body;
  const r = await pool.query(
    "INSERT INTO roles (role_name, assigned_emails, bypass_checks, active) VALUES ($1, $2, $3, $4) RETURNING *",
    [role_name, normalizeEmails(assigned_emails), normalizeChecks(bypass_checks), active !== false]
  );
  res.json(r.rows[0]);
});
app.put("/api/admin/roles/:id", adminAuth, async (req, res) => {
  const { role_name, assigned_emails, bypass_checks, active } = req.body;
  const r = await pool.query(
    "UPDATE roles SET role_name=$1, assigned_emails=$2, bypass_checks=$3, active=$4 WHERE id=$5 RETURNING *",
    [role_name, normalizeEmails(assigned_emails), normalizeChecks(bypass_checks), active !== false, req.params.id]
  );
  res.json(r.rows[0]);
});
app.delete("/api/admin/roles/:id", adminAuth, async (req, res) => {
  await pool.query("DELETE FROM roles WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// Excluded recipients (מוחרגים) — email/domain destinations that skip all DLP
function normalizeScope(v) {
  return String(v).toUpperCase() === "DOMAIN" ? "DOMAIN" : "EMAIL";
}
function normalizeExpiry(v) {
  const s = v == null ? "" : String(v).trim();
  return s === "" ? null : s; // DATE column; empty -> never expires
}
app.get("/api/admin/excluded", adminAuth, async (req, res) => {
  const r = await pool.query("SELECT * FROM excluded_recipients ORDER BY id");
  res.json(r.rows);
});
app.post("/api/admin/excluded", adminAuth, async (req, res) => {
  const { email, scope, reason, expiry_date, requested_by } = req.body;
  const r = await pool.query(
    "INSERT INTO excluded_recipients (email, scope, reason, expiry_date, requested_by) VALUES ($1, $2, $3, $4, $5) RETURNING *",
    [String(email || "").trim(), normalizeScope(scope), reason || "", normalizeExpiry(expiry_date), requested_by || ""]
  );
  res.json(r.rows[0]);
});
app.put("/api/admin/excluded/:id", adminAuth, async (req, res) => {
  const { email, scope, reason, expiry_date, requested_by } = req.body;
  const r = await pool.query(
    "UPDATE excluded_recipients SET email=$1, scope=$2, reason=$3, expiry_date=$4, requested_by=$5 WHERE id=$6 RETURNING *",
    [String(email || "").trim(), normalizeScope(scope), reason || "", normalizeExpiry(expiry_date), requested_by || "", req.params.id]
  );
  res.json(r.rows[0]);
});
app.delete("/api/admin/excluded/:id", adminAuth, async (req, res) => {
  await pool.query("DELETE FROM excluded_recipients WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// Encryption keywords (דורשי הצפנה) — filenames containing these require encryption
app.get("/api/admin/encwords", adminAuth, async (req, res) => {
  const r = await pool.query("SELECT * FROM encryption_keywords ORDER BY id");
  res.json(r.rows);
});
app.post("/api/admin/encwords", adminAuth, async (req, res) => {
  const { keyword, note, active } = req.body;
  const r = await pool.query(
    "INSERT INTO encryption_keywords (keyword, note, active) VALUES ($1, $2, $3) RETURNING *",
    [String(keyword || "").trim(), note || "", active !== false]
  );
  res.json(r.rows[0]);
});
app.put("/api/admin/encwords/:id", adminAuth, async (req, res) => {
  const { keyword, note, active } = req.body;
  const r = await pool.query(
    "UPDATE encryption_keywords SET keyword=$1, note=$2, active=$3 WHERE id=$4 RETURNING *",
    [String(keyword || "").trim(), note || "", active !== false, req.params.id]
  );
  res.json(r.rows[0]);
});
app.delete("/api/admin/encwords/:id", adminAuth, async (req, res) => {
  await pool.query("DELETE FROM encryption_keywords WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// Audit log (read only). Supports filtering by day and by user, plus paging.
// The full history is always stored; these params control what is returned.
//   ?date=YYYY-MM-DD  — only events on that calendar day (Israel time)
//   ?user=<substring> — only rows whose user_email matches (case-insensitive)
//   ?limit=&offset=   — paging (default 200; max 1000 per page)
function buildAuditFilter(query) {
  const where = [];
  const params = [];
  if (query.date) {
    params.push(query.date);
    // Compare in Israel local time so "a day" matches what the admin sees.
    where.push(`(created_at AT TIME ZONE 'Asia/Jerusalem')::date = $${params.length}::date`);
  }
  if (query.user) {
    params.push("%" + String(query.user).trim() + "%");
    where.push(`user_email ILIKE $${params.length}`);
  }
  return { whereSql: where.length ? "WHERE " + where.join(" AND ") : "", params };
}

app.get("/api/admin/audit", adminAuth, async (req, res) => {
  const { whereSql, params } = buildAuditFilter(req.query);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  params.push(limit, offset);
  const r = await pool.query(
    `SELECT * FROM audit_log ${whereSql} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json(r.rows);
});

// CSV export of the filtered audit log (all matching rows, capped at 50k).
function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

app.get("/api/admin/audit.csv", adminAuth, async (req, res) => {
  const { whereSql, params } = buildAuditFilter(req.query);
  const r = await pool.query(
    `SELECT created_at, user_email, action, data FROM audit_log ${whereSql} ORDER BY created_at DESC LIMIT 50000`,
    params,
  );
  // Quoting alone does NOT stop formula injection: Excel still evaluates a field
  // that begins with = + - @ (or a leading tab/CR) even inside quotes. That matters
  // here because audit content is writable by UNAUTHENTICATED callers via
  // /api/audit — so a subject like  =cmd|' /C calc'!A0  would be stored, exported,
  // and executed on the workstation of whichever admin opened the CSV. Prefixing a
  // single quote makes Excel treat the value as text; it is visible in the cell but
  // harmless, and the underlying audit row is untouched.
  const esc = (v) => {
    let s = String(v == null ? "" : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  // `message` gets its own column so Excel users can read the alert without
  // digging through the JSON blob.
  const lines = ["created_at,user_email,action,message,data"];
  for (const row of r.rows) {
    const parsed = typeof row.data === "string" ? safeParse(row.data) : (row.data ?? null);
    const message = parsed && typeof parsed.message === "string" ? parsed.message : "";
    const data = typeof row.data === "string" ? row.data : JSON.stringify(row.data ?? "");
    lines.push([
      esc(new Date(row.created_at).toISOString()),
      esc(row.user_email),
      esc(row.action),
      esc(message),
      esc(data),
    ].join(","));
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="audit-log.csv"');
  res.send("﻿" + lines.join("\n")); // BOM so Excel reads Hebrew correctly
});

// Admin UI
app.get("/admin", adminPage, (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Nextage DLP — Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #f0f2f5; color: #1a1a2e; direction: rtl; }
    .btn { padding: 10px 20px; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; transition: all 0.2s; }
    .btn-primary { background: #0078d4; color: white; }
    .btn-primary:hover { background: #005fa3; }
    .btn-danger { background: #d13438; color: white; }
    .btn-danger:hover { background: #a4262c; }
    .btn-success { background: #107c10; color: white; }
    .btn-success:hover { background: #0b5e0b; }
    .btn-sm { padding: 5px 12px; font-size: 12px; }
    header { background: #0078d4; color: white; padding: 14px 28px; display: flex; align-items: center; justify-content: space-between; box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
    header h1 { font-size: 20px; font-weight: 700; }
    header span { font-size: 13px; opacity: 0.85; }
    nav { background: white; border-bottom: 2px solid #e1e4e8; display: flex; padding: 0 20px; gap: 4px; }
    nav button { padding: 14px 20px; border: none; background: none; cursor: pointer; font-size: 14px; font-weight: 600; color: #555; border-bottom: 3px solid transparent; margin-bottom: -2px; transition: all 0.2s; }
    nav button.active { color: #0078d4; border-bottom-color: #0078d4; }
    nav button:hover { color: #0078d4; background: #f5f8ff; }
    main { padding: 28px; max-width: 1100px; margin: 0 auto; }
    .card { background: white; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.07); overflow: hidden; }
    .card-header { padding: 18px 24px; border-bottom: 1px solid #eee; display: flex; align-items: center; justify-content: space-between; }
    .card-header { gap: 12px; flex-wrap: wrap; }
    .header-tools { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .search-box { padding: 7px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 13px; font-family: inherit; width: 230px; }
    .search-box:focus { outline: none; border-color: #0078d4; box-shadow: 0 0 0 3px rgba(0,120,212,0.1); }
    .search-count { font-size: 12px; color: #888; white-space: nowrap; }
    .search-count.filtered { color: #0078d4; font-weight: 600; }
    .card-header h2 { font-size: 17px; color: #1a1a2e; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #f8f9fa; padding: 12px 16px; text-align: right; font-size: 13px; color: #555; font-weight: 600; border-bottom: 1px solid #eee; }
    td { padding: 12px 16px; border-bottom: 1px solid #f0f0f0; font-size: 14px; vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #fafbff; }
    .tag { display: inline-block; background: #e8f4fd; color: #0078d4; padding: 2px 8px; border-radius: 12px; font-size: 12px; margin: 2px; }
    .tag-green { background: #e8f5e9; color: #107c10; }
    .tag-gray { background: #f0f0f0; color: #555; }
    .actions { display: flex; gap: 6px; justify-content: flex-end; }
    .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 1000; align-items: center; justify-content: center; }
    .modal-overlay.open { display: flex; }
    .modal { background: white; border-radius: 12px; padding: 28px; width: 460px; max-width: 95vw; box-shadow: 0 8px 40px rgba(0,0,0,0.2); }
    .modal h3 { font-size: 17px; margin-bottom: 20px; color: #1a1a2e; }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; font-size: 13px; font-weight: 600; color: #444; margin-bottom: 6px; }
    .form-group input, .form-group textarea { width: 100%; padding: 9px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; font-family: inherit; }
    .form-group input:focus, .form-group textarea:focus { outline: none; border-color: #0078d4; box-shadow: 0 0 0 3px rgba(0,120,212,0.1); }
    .form-group small { color: #888; font-size: 12px; margin-top: 4px; display: block; }
    .modal-footer { display: flex; justify-content: flex-end; gap: 10px; margin-top: 24px; }
    .empty { text-align: center; padding: 48px; color: #aaa; font-size: 15px; }
    .badge { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; }
    .badge-blue { background: #dbeafe; color: #1d4ed8; }
    .badge-red { background: #fee2e2; color: #b91c1c; }
    .section { display: none; }
    .section.active { display: block; }
    #toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: #107c10; color: white; padding: 12px 24px; border-radius: 8px; font-size: 14px; font-weight: 600; opacity: 0; transition: opacity 0.3s; z-index: 9999; pointer-events: none; }
    #toast.show { opacity: 1; }
    .audit-time { font-size: 12px; color: #888; white-space: nowrap; }
    .audit-action { font-weight: 600; color: #0078d4; white-space: nowrap; }
    .audit-msg { font-size: 13px; color: #1a1a2e; line-height: 1.45; white-space: pre-wrap; }
    .audit-context { font-size: 11px; color: #999; margin-top: 4px; }
  </style>
</head>
<body>

<div id="app">
  <header>
    <h1>🛡️ Nextage DLP — ממשק ניהול</h1>
    <span>${req.adminUser
      ? `מחובר: ${req.adminUser.email} · <a href="/.auth/logout?post_logout_redirect_uri=%2Fadmin" style="color:#fff;text-decoration:underline">יציאה</a>`
      : "מחובר כמנהל מערכת"}</span>
  </header>
  <nav>
    <button class="active" onclick="showTab('customers',this)">👥 לקוחות</button>
    <button onclick="showTab('advisors',this)">🧑‍💼 יועצים</button>
    <button onclick="showTab('exemptions',this)">✅ פטורים</button>
    <button onclick="showTab('exclusions',this)">📎 סיומות קבצים</button>
    <button onclick="showTab('rules',this)">📜 חוקים</button>
    <button onclick="showTab('roles',this)">🎫 תפקידים</button>
    <button onclick="showTab('excluded',this)">🚫 מוחרגים</button>
    <button onclick="showTab('encwords',this)">🔐 דורשי הצפנה</button>
    <button onclick="showTab('audit',this)">📋 לוג ביקורת</button>
  </nav>
  <main>

    <!-- CUSTOMERS -->
    <div class="section active" id="section-customers">
      <div class="card">
        <div class="card-header">
          <h2>לקוחות</h2>
          <div class="header-tools">
            <span class="search-count" id="count-customers"></span>
            <input type="search" class="search-box" id="search-customers" placeholder="🔍 חיפוש בטבלה..." oninput="filterTable('customers')" onkeydown="if(event.key==='Escape'){this.value='';filterTable('customers')}"/>
            <button class="btn btn-success btn-sm" onclick="openModal('customers')">+ הוסף לקוח</button>
          </div>
        </div>
        <table><thead><tr><th>שם</th><th>דומיין ראשי</th><th>כינויים</th><th>דומיינים</th><th>פעולות</th></tr></thead>
        <tbody id="table-customers"></tbody></table>
      </div>
    </div>

    <!-- ADVISORS -->
    <div class="section" id="section-advisors">
      <div class="card">
        <div class="card-header">
          <h2>יועצים</h2>
          <div class="header-tools">
            <span class="search-count" id="count-advisors"></span>
            <input type="search" class="search-box" id="search-advisors" placeholder="🔍 חיפוש בטבלה..." oninput="filterTable('advisors')" onkeydown="if(event.key==='Escape'){this.value='';filterTable('advisors')}"/>
            <button class="btn btn-success btn-sm" onclick="openModal('advisors')">+ הוסף יועץ</button>
          </div>
        </div>
        <table><thead><tr><th>שם</th><th>אימייל</th><th>לקוחות מקושרים</th><th>פעולות</th></tr></thead>
        <tbody id="table-advisors"></tbody></table>
      </div>
    </div>

    <!-- EXEMPTIONS -->
    <div class="section" id="section-exemptions">
      <div class="card">
        <div class="card-header">
          <h2>פטורים מ-DLP</h2>
          <div class="header-tools">
            <span class="search-count" id="count-exemptions"></span>
            <input type="search" class="search-box" id="search-exemptions" placeholder="🔍 חיפוש בטבלה..." oninput="filterTable('exemptions')" onkeydown="if(event.key==='Escape'){this.value='';filterTable('exemptions')}"/>
            <button class="btn btn-success btn-sm" onclick="openModal('exemptions')">+ הוסף פטור</button>
          </div>
        </div>
        <table><thead><tr><th>אימייל</th><th>סיבה</th><th>פעולות</th></tr></thead>
        <tbody id="table-exemptions"></tbody></table>
      </div>
    </div>

    <!-- EXCLUSIONS -->
    <div class="section" id="section-exclusions">
      <div class="card">
        <div class="card-header">
          <h2>סיומות קבצים ללא הצפנה</h2>
          <div class="header-tools">
            <span class="search-count" id="count-exclusions"></span>
            <input type="search" class="search-box" id="search-exclusions" placeholder="🔍 חיפוש בטבלה..." oninput="filterTable('exclusions')" onkeydown="if(event.key==='Escape'){this.value='';filterTable('exclusions')}"/>
            <button class="btn btn-success btn-sm" onclick="openModal('exclusions')">+ הוסף סיומת</button>
          </div>
        </div>
        <table><thead><tr><th>סיומת</th><th>סיבה</th><th>פעולות</th></tr></thead>
        <tbody id="table-exclusions"></tbody></table>
      </div>
    </div>

    <!-- RULES (חוקים) -->
    <div class="section" id="section-rules">
      <div class="card">
        <div class="card-header">
          <h2>חוקים — פטור מהצפנה לפי נושא המייל</h2>
          <div class="header-tools">
            <span class="search-count" id="count-rules"></span>
            <input type="search" class="search-box" id="search-rules" placeholder="🔍 חיפוש בטבלה..." oninput="filterTable('rules')" onkeydown="if(event.key==='Escape'){this.value='';filterTable('rules')}"/>
            <button class="btn btn-success btn-sm" onclick="openModal('rules')">+ הוסף חוק</button>
          </div>
        </div>
        <table><thead><tr><th>ביטוי</th><th>שפה</th><th>סוג חוק</th><th>פעיל</th><th>פעולות</th></tr></thead>
        <tbody id="table-rules"></tbody></table>
      </div>
    </div>

    <!-- ROLES (תפקידים) -->
    <div class="section" id="section-roles">
      <div class="card">
        <div class="card-header">
          <h2>תפקידים — פטור מבדיקות לפי תפקיד המשתמש</h2>
          <div class="header-tools">
            <span class="search-count" id="count-roles"></span>
            <input type="search" class="search-box" id="search-roles" placeholder="🔍 חיפוש בטבלה..." oninput="filterTable('roles')" onkeydown="if(event.key==='Escape'){this.value='';filterTable('roles')}"/>
            <button class="btn btn-success btn-sm" onclick="openModal('roles')">+ הוסף תפקיד</button>
          </div>
        </div>
        <table><thead><tr><th>שם תפקיד</th><th>אימיילים משויכים</th><th>בדיקות שמדולגות</th><th>פעיל</th><th>פעולות</th></tr></thead>
        <tbody id="table-roles"></tbody></table>
      </div>
    </div>

    <!-- EXCLUDED RECIPIENTS -->
    <div class="section" id="section-excluded">
      <div class="card">
        <div class="card-header">
          <h2>מוחרגים — נמענים/דומיינים שלא עוברים בדיקות DLP</h2>
          <div class="header-tools">
            <span class="search-count" id="count-excluded"></span>
            <input type="search" class="search-box" id="search-excluded" placeholder="🔍 חיפוש בטבלה..." oninput="filterTable('excluded')" onkeydown="if(event.key==='Escape'){this.value='';filterTable('excluded')}"/>
            <button class="btn btn-success btn-sm" onclick="openModal('excluded')">+ הוסף החרגה</button>
          </div>
        </div>
        <table><thead><tr><th>מייל</th><th>היקף</th><th>סיבה</th><th>תוקף</th><th>ביקש/ה</th><th>פעולות</th></tr></thead>
        <tbody id="table-excluded"></tbody></table>
      </div>
    </div>

    <!-- ENCRYPTION KEYWORDS -->
    <div class="section" id="section-encwords">
      <div class="card">
        <div class="card-header">
          <h2>דורשי הצפנה — קבצים שחייבים הצפנה לפי שם הקובץ</h2>
          <div class="header-tools">
            <span class="search-count" id="count-encwords"></span>
            <input type="search" class="search-box" id="search-encwords" placeholder="🔍 חיפוש בטבלה..." oninput="filterTable('encwords')" onkeydown="if(event.key==='Escape'){this.value='';filterTable('encwords')}"/>
            <button class="btn btn-success btn-sm" onclick="openModal('encwords')">+ הוסף מילה</button>
          </div>
        </div>
        <p style="color:#666;font-size:13px;margin:0 0 12px">קובץ יידרש להיות מוצפן רק אם שם הקובץ מכיל אחת מהמילים הבאות. ההתאמה מתעלמת מרווחים, מקפים, קווים תחתונים ואותיות גדולות/קטנות. אם הרשימה ריקה — אף קובץ לא יידרש הצפנה.</p>
        <table><thead><tr><th>מילה</th><th>הערה</th><th>פעיל</th><th>פעולות</th></tr></thead>
        <tbody id="table-encwords"></tbody></table>
      </div>
    </div>

    <!-- AUDIT LOG -->
    <div class="section" id="section-audit">
      <div class="card">
        <div class="card-header">
          <h2>לוג ביקורת</h2>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input type="date" id="audit-date" style="padding:7px 10px;border:1px solid #ddd;border-radius:8px;font-size:13px"/>
            <input type="text" id="audit-user" placeholder="סינון לפי אימייל" style="padding:7px 10px;border:1px solid #ddd;border-radius:8px;font-size:13px" onkeydown="if(event.key==='Enter')applyAuditFilter()"/>
            <input type="search" class="search-box" id="search-audit" placeholder="🔍 חיפוש בשורות שנטענו..." style="width:200px" oninput="filterTable('audit')" onkeydown="if(event.key==='Escape'){this.value='';filterTable('audit')}"/>
            <span class="search-count" id="count-audit"></span>
            <button class="btn btn-primary btn-sm" onclick="applyAuditFilter()">🔍 סנן</button>
            <button class="btn btn-sm" onclick="clearAuditFilter()">נקה</button>
            <button class="btn btn-success btn-sm" onclick="exportAudit()">⬇️ ייצוא CSV</button>
          </div>
        </div>
        <table><thead><tr><th>זמן</th><th>משתמש</th><th>פעולה</th><th>מידע</th></tr></thead>
        <tbody id="table-audit"></tbody></table>
        <div style="text-align:center;padding:16px">
          <button class="btn btn-sm" id="audit-more" style="display:none" onclick="loadAudit(false)">טען עוד ↓</button>
        </div>
      </div>
    </div>

  </main>
</div>

<!-- MODAL -->
<div class="modal-overlay" id="modal-overlay" onclick="if(event.target===this)closeModal()">
  <div class="modal">
    <h3 id="modal-title">הוסף / ערוך</h3>
    <div id="modal-body"></div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()" style="background:#f0f0f0">ביטול</button>
      <button class="btn btn-primary" onclick="saveModal()">שמור</button>
    </div>
  </div>
</div>

<div id="toast"></div>

<script>
let currentTable = "";
let editingId = null;

// The server already authorised this request before rendering the page, and the
// Easy Auth cookie rides along on every fetch below — no client-side gate needed.
loadAll();

function showTab(name, btn) {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  document.querySelectorAll("nav button").forEach(b => b.classList.remove("active"));
  document.getElementById("section-" + name).classList.add("active");
  btn.classList.add("active");
  if (name === "audit") { loadAudit(true); return; }
  loadTable(name);
}

// ── Table search ─────────────────────────────────────────────────────────────
// Filters the rendered rows in place — no refetch. Matches every word in the
// query independently (order-free) against the row's data cells; the actions
// column is excluded so "ערוך" doesn't match every row.
function filterTable(name) {
  const box = document.getElementById("search-" + name);
  const tbody = document.getElementById("table-" + name);
  const counter = document.getElementById("count-" + name);
  if (!box || !tbody) return;

  const terms = box.value.trim().toLowerCase().split(/\\s+/).filter(Boolean);
  const rows = Array.from(tbody.querySelectorAll("tr")).filter(tr => !tr.dataset.placeholder);
  let shown = 0;

  rows.forEach(tr => {
    if (!tr.dataset.haystack) {
      tr.dataset.haystack = Array.from(tr.querySelectorAll("td:not(.actions)"))
        .map(td => td.textContent).join(" ").replace(/\\s+/g, " ").toLowerCase();
    }
    const hit = terms.every(t => tr.dataset.haystack.includes(t));
    tr.style.display = hit ? "" : "none";
    if (hit) shown++;
  });

  const old = tbody.querySelector("tr[data-placeholder='noresults']");
  if (old) old.remove();
  if (terms.length && shown === 0 && rows.length) {
    const tr = document.createElement("tr");
    tr.dataset.placeholder = "noresults";
    tr.innerHTML = '<td colspan="9" class="empty">לא נמצאו תוצאות עבור "' + esc(box.value.trim()) + '"</td>';
    tbody.appendChild(tr);
  }

  if (counter) {
    counter.textContent = terms.length ? shown + " מתוך " + rows.length : (rows.length ? rows.length + " רשומות" : "");
    counter.classList.toggle("filtered", terms.length > 0 && shown < rows.length);
  }
}

function loadAll() {
  loadTable("customers");
}

async function loadTable(name) {
  const res = await fetch("/api/admin/" + name);
  const data = await res.json();
  const tbody = document.getElementById("table-" + name);
  if (!data.length) {
    tbody.innerHTML = '<tr data-placeholder="empty"><td colspan="9" class="empty">אין נתונים</td></tr>';
    filterTable(name);
    return;
  }

  // Every row value below goes through esc(). These fields are admin-written, but
  // customer rows are bulk-imported from a spreadsheet, so treat them as untrusted:
  // an unescaped value like <img src=x onerror=...> in a customer name would run in
  // the browser of every other admin who opens this page, with their session.
  // Row ids go through Number() so only a numeric literal can land in the handler.
  if (name === "customers") {
    tbody.innerHTML = data.map(r => \`<tr>
      <td><strong>\${esc(r.name)}</strong></td>
      <td>\${r.primary_domain ? \`<span class="tag tag-green">\${esc(r.primary_domain)}</span>\` : '<span style="color:#aaa">—</span>'}</td>
      <td>\${(r.aliases||[]).map(a=>\`<span class="tag tag-gray">\${esc(a)}</span>\`).join("") || '<span style="color:#aaa">—</span>'}</td>
      <td>\${(r.domains||[]).map(d=>\`<span class="tag">\${esc(d)}</span>\`).join("") || '<span style="color:#aaa">—</span>'}</td>
      <td class="actions">
        <button class="btn btn-primary btn-sm" onclick='editRow("customers",\${attrJson(r)})'>✏️ ערוך</button>
        <button class="btn btn-danger btn-sm" onclick='deleteRow("customers",\${Number(r.id)})'>🗑️</button>
      </td></tr>\`).join("");
  } else if (name === "advisors") {
    tbody.innerHTML = data.map(r => \`<tr>
      <td><strong>\${esc(r.name)}</strong></td>
      <td>\${esc(r.email)}</td>
      <td>\${(r.linked_customers||[]).map(c=>\`<span class="tag tag-green">\${esc(c)}</span>\`).join("") || '<span style="color:#aaa">—</span>'}</td>
      <td class="actions">
        <button class="btn btn-primary btn-sm" onclick='editRow("advisors",\${attrJson(r)})'>✏️ ערוך</button>
        <button class="btn btn-danger btn-sm" onclick='deleteRow("advisors",\${Number(r.id)})'>🗑️</button>
      </td></tr>\`).join("");
  } else if (name === "exemptions") {
    tbody.innerHTML = data.map(r => \`<tr>
      <td>\${esc(r.email)}</td>
      <td>\${esc(r.reason||"")}</td>
      <td class="actions">
        <button class="btn btn-primary btn-sm" onclick='editRow("exemptions",\${attrJson(r)})'>✏️ ערוך</button>
        <button class="btn btn-danger btn-sm" onclick='deleteRow("exemptions",\${Number(r.id)})'>🗑️</button>
      </td></tr>\`).join("");
  } else if (name === "exclusions") {
    tbody.innerHTML = data.map(r => \`<tr>
      <td><span class="tag tag-gray">.\${esc(r.extension)}</span></td>
      <td>\${esc(r.reason||"")}</td>
      <td class="actions">
        <button class="btn btn-primary btn-sm" onclick='editRow("exclusions",\${attrJson(r)})'>✏️ ערוך</button>
        <button class="btn btn-danger btn-sm" onclick='deleteRow("exclusions",\${Number(r.id)})'>🗑️</button>
      </td></tr>\`).join("");
  } else if (name === "rules") {
    tbody.innerHTML = data.map(r => \`<tr>
      <td><strong>\${esc(r.expression)}</strong></td>
      <td>\${esc(r.language||"")}</td>
      <td><span class="tag">\${esc(r.rule_type||"")}</span></td>
      <td>\${r.active ? '<span class="tag tag-green">פעיל</span>' : '<span class="tag tag-gray">לא פעיל</span>'}</td>
      <td class="actions">
        <button class="btn btn-primary btn-sm" onclick='editRow("rules",\${attrJson(r)})'>✏️ ערוך</button>
        <button class="btn btn-danger btn-sm" onclick='deleteRow("rules",\${Number(r.id)})'>🗑️</button>
      </td></tr>\`).join("");
  } else if (name === "roles") {
    tbody.innerHTML = data.map(r => \`<tr>
      <td><strong>\${esc(r.role_name)}</strong></td>
      <td>\${(r.assigned_emails||[]).map(e=>\`<span class="tag">\${esc(e)}</span>\`).join("") || '<span style="color:#aaa">—</span>'}</td>
      <td>\${(r.bypass_checks||[]).map(c=>\`<span class="tag tag-gray">\${esc(checkLabel(c))}</span>\`).join("") || '<span style="color:#aaa">—</span>'}</td>
      <td>\${r.active ? '<span class="tag tag-green">פעיל</span>' : '<span class="tag tag-gray">לא פעיל</span>'}</td>
      <td class="actions">
        <button class="btn btn-primary btn-sm" onclick='editRow("roles",\${attrJson(r)})'>✏️ ערוך</button>
        <button class="btn btn-danger btn-sm" onclick='deleteRow("roles",\${Number(r.id)})'>🗑️</button>
      </td></tr>\`).join("");
  } else if (name === "excluded") {
    const today = new Date(); today.setHours(0,0,0,0);
    tbody.innerHTML = data.map(r => {
      const expired = r.expiry_date && new Date(r.expiry_date) < today;
      const scopeTag = r.scope === "DOMAIN"
        ? '<span class="tag tag-green">כל הדומיין</span>'
        : '<span class="tag tag-gray">מייל בלבד</span>';
      const validTag = !r.expiry_date
        ? '<span class="tag tag-green">ללא תפוגה</span>'
        : (expired ? \`<span class="tag tag-red">פג (\${esc(new Date(r.expiry_date).toLocaleDateString("he-IL"))})</span>\`
                   : \`<span class="tag">\${esc(new Date(r.expiry_date).toLocaleDateString("he-IL"))}</span>\`);
      return \`<tr>
      <td><strong>\${esc(r.email)}</strong></td>
      <td>\${scopeTag}</td>
      <td>\${esc(r.reason||"")}</td>
      <td>\${validTag}</td>
      <td>\${esc(r.requested_by||"")}</td>
      <td class="actions">
        <button class="btn btn-primary btn-sm" onclick='editRow("excluded",\${attrJson(r)})'>✏️ ערוך</button>
        <button class="btn btn-danger btn-sm" onclick='deleteRow("excluded",\${Number(r.id)})'>🗑️</button>
      </td></tr>\`;
    }).join("");
  } else if (name === "encwords") {
    tbody.innerHTML = data.map(r => \`<tr>
      <td><strong>\${esc(r.keyword)}</strong></td>
      <td>\${esc(r.note||"")}</td>
      <td>\${r.active ? '<span class="tag tag-green">פעיל</span>' : '<span class="tag tag-gray">לא פעיל</span>'}</td>
      <td class="actions">
        <button class="btn btn-primary btn-sm" onclick='editRow("encwords",\${attrJson(r)})'>✏️ ערוך</button>
        <button class="btn btn-danger btn-sm" onclick='deleteRow("encwords",\${Number(r.id)})'>🗑️</button>
      </td></tr>\`).join("");
  }

  // Rows were replaced, so the cached haystacks are gone — re-apply any active query.
  filterTable(name);
}

// ── Audit log: filter by day / user, paging, CSV export ──────────────────────
let auditOffset = 0;
const AUDIT_PAGE = 200;

function auditQueryString() {
  const date = document.getElementById("audit-date").value;
  const user = document.getElementById("audit-user").value.trim();
  const p = new URLSearchParams();
  if (date) p.set("date", date);
  if (user) p.set("user", user);
  return p;
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Serialises a row for embedding in a single-quoted HTML attribute, e.g.
//   onclick='editRow("customers", \${attrJson(r)})'
// JSON.stringify alone is NOT safe here: it leaves apostrophes untouched, so a
// value like O'Brien closed the attribute early and let the rest of the field be
// parsed as markup/handler code. esc() covers & < > " and the extra replace
// covers ' — the browser decodes the entities back before parsing the JS, so the
// JSON still arrives intact.
function attrJson(o) {
  return esc(JSON.stringify(o)).replace(/'/g, "&#39;");
}

// The מידע column shows the prompt text the user actually saw. Rows written before
// the message was captured have no data.message, so fall back to the raw JSON.
function auditRowsHtml(data) {
  return data.map(r => {
    const d = r.data || {};
    const raw = r.data ? JSON.stringify(r.data) : "";
    const msg = typeof d.message === "string" && d.message.trim() ? d.message.trim() : "";
    const context = [
      d.subject ? "נושא: " + d.subject : "",
      (d.attachments && d.attachments.length) ? "קבצים: " + d.attachments.join(", ") : "",
      (d.recipients && d.recipients.length) ? "נמענים: " + d.recipients.join(", ") : ""
    ].filter(Boolean).join(" · ");

    const cell = msg
      ? \`<div class="audit-msg">\${esc(msg)}</div>\` +
        (context ? \`<div class="audit-context">\${esc(context)}</div>\` : "")
      : \`<span style="font-size:12px;color:#888">\${esc(raw.substring(0, 90))}</span>\`;

    return \`<tr>
      <td class="audit-time">\${esc(new Date(r.created_at).toLocaleString("he-IL"))}</td>
      <td>\${esc(r.user_email)}</td>
      <td class="audit-action">\${esc(r.action)}</td>
      <td title="\${esc(raw)}">\${cell}</td>
      </tr>\`;
  }).join("");
}

// reset=true starts a fresh query from the current filters; reset=false pages older rows.
async function loadAudit(reset) {
  if (reset) auditOffset = 0;
  const p = auditQueryString();
  p.set("limit", AUDIT_PAGE);
  p.set("offset", auditOffset);
  const res = await fetch("/api/admin/audit?" + p.toString());
  const data = await res.json();
  const tbody = document.getElementById("table-audit");
  const html = auditRowsHtml(data);
  if (reset) {
    tbody.innerHTML = html || '<tr data-placeholder="empty"><td colspan="4" class="empty">אין נתונים</td></tr>';
  } else {
    tbody.innerHTML += html;
  }
  auditOffset += data.length;
  document.getElementById("audit-more").style.display = data.length < AUDIT_PAGE ? "none" : "";
  filterTable("audit");
}

function applyAuditFilter() { loadAudit(true); }
function clearAuditFilter() {
  document.getElementById("audit-date").value = "";
  document.getElementById("audit-user").value = "";
  loadAudit(true);
}

async function exportAudit() {
  const res = await fetch("/api/admin/audit.csv?" + auditQueryString().toString());
  if (!res.ok) { toast("ייצוא נכשל"); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "audit-log.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function checkLabel(n) {
  return { 1: "1 · הצפנה", 2: "2 · שם קובץ", 3: "3 · נושא ודומיין" }[n] || String(n);
}

function openModal(table, row) {
  currentTable = table;
  editingId = row ? row.id : null;
  document.getElementById("modal-title").textContent = (editingId ? "ערוך" : "הוסף") + " — " + tableLabel(table);
  document.getElementById("modal-body").innerHTML = buildForm(table, row);
  document.getElementById("modal-overlay").classList.add("open");
}

function editRow(table, row) { openModal(table, row); }

function tableLabel(t) {
  return { customers:"לקוח", advisors:"יועץ", exemptions:"פטור", exclusions:"סיומת", rules:"חוק", roles:"תפקיד", excluded:"החרגה", encwords:"מילת הצפנה" }[t] || t;
}

function buildForm(table, row) {
  if (table === "customers") return \`
    <div class="form-group"><label>שם לקוח</label>
      <input id="f-name" value="\${esc(row?.name||"")}" placeholder="בנק לאומי"/></div>
    <div class="form-group"><label>דומיין ראשי</label>
      <input id="f-primary-domain" value="\${esc(row?.primary_domain||"")}" placeholder="leumi.co.il"/>
      <small>הדומיין הרשמי העיקרי של הלקוח</small></div>
    <div class="form-group"><label>כינויים (Aliases)</label>
      <input id="f-aliases" value="\${esc((row?.aliases||[]).join(", "))}" placeholder="bankleumi.co.il, leumi.com"/>
      <small>שמות חלופיים — הפרד בפסיק</small></div>
    <div class="form-group"><label>דומיינים נוספים</label>
      <input id="f-domains" value="\${esc((row?.domains||[]).join(", "))}" placeholder="leumi.co.il, bankleumi.co.il"/>
      <small>כל הדומיינים לבדיקת DLP — הפרד בפסיק</small></div>\`;
  if (table === "advisors") return \`
    <div class="form-group"><label>שם</label>
      <input id="f-name" value="\${esc(row?.name||"")}" placeholder="ישראל ישראלי"/></div>
    <div class="form-group"><label>אימייל</label>
      <input id="f-email" value="\${esc(row?.email||"")}" placeholder="name@nextage.co.il"/></div>
    <div class="form-group"><label>לקוחות מקושרים</label>
      <input id="f-linked" value="\${esc((row?.linked_customers||[]).join(", "))}" placeholder="בנק לאומי, מגדל ביטוח"/>
      <small>שמות לקוחות מדויקים כפי שמופיעים בטבלת לקוחות — הפרד בפסיק</small></div>\`;
  if (table === "exemptions") return \`
    <div class="form-group"><label>אימייל</label>
      <input id="f-email" value="\${esc(row?.email||"")}" placeholder="name@nextage.co.il"/></div>
    <div class="form-group"><label>סיבה</label>
      <input id="f-reason" value="\${esc(row?.reason||"")}" placeholder="מנהל מערכת"/></div>\`;
  if (table === "exclusions") return \`
    <div class="form-group"><label>סיומת קובץ</label>
      <input id="f-extension" value="\${esc(row?.extension||"")}" placeholder="pdf"/>
      <small>ללא נקודה</small></div>
    <div class="form-group"><label>סיבה</label>
      <input id="f-reason" value="\${esc(row?.reason||"")}" placeholder="PDF מוגן בנפרד"/></div>\`;
  if (table === "rules") return \`
    <div class="form-group"><label>ביטוי (Expression)</label>
      <input id="f-expression" value="\${esc(row?.expression||"")}" placeholder="חשבונית ספק"/>
      <small>מחרוזת שתיבדק כתת-מחרוזת בתוך נושא המייל (לא תלוי רישיות)</small></div>
    <div class="form-group"><label>שפה</label>
      <select id="f-language">
        <option value="Hebrew" \${row?.language!=="English"?"selected":""}>Hebrew</option>
        <option value="English" \${row?.language==="English"?"selected":""}>English</option>
      </select></div>
    <div class="form-group"><label>סוג חוק</label>
      <input id="f-rule-type" value="\${esc(row?.rule_type||"Encryption Exemption")}"/>
      <small>ברירת מחדל: Encryption Exemption</small></div>
    <div class="form-group"><label>פעיל</label>
      <select id="f-active">
        <option value="true" \${row?.active!==false?"selected":""}>כן</option>
        <option value="false" \${row?.active===false?"selected":""}>לא</option>
      </select></div>\`;
  if (table === "roles") { const bc = row?.bypass_checks || []; return \`
    <div class="form-group"><label>שם תפקיד</label>
      <input id="f-role-name" value="\${esc(row?.role_name||"")}" placeholder="CFO"/></div>
    <div class="form-group"><label>אימיילים משויכים</label>
      <input id="f-assigned-emails" value="\${esc((row?.assigned_emails||[]).join(", "))}" placeholder="cfo@nextage.co.il, name@nextage.co.il"/>
      <small>כתובות המייל שמשויכות לתפקיד — הפרד בפסיק</small></div>
    <div class="form-group"><label>בדיקות שמדולגות</label>
      <div style="display:flex;gap:16px;padding:4px 0">
        <label style="font-weight:400"><input type="checkbox" id="f-check-1" \${bc.includes(1)?"checked":""}/> 1 · הצפנה</label>
        <label style="font-weight:400"><input type="checkbox" id="f-check-2" \${bc.includes(2)?"checked":""}/> 2 · שם קובץ</label>
        <label style="font-weight:400"><input type="checkbox" id="f-check-3" \${bc.includes(3)?"checked":""}/> 3 · נושא ודומיין</label>
      </div>
      <small>מי שמשויך לתפקיד ידלג על הבדיקות המסומנות. CFO = הצפנה בלבד.</small></div>
    <div class="form-group"><label>פעיל</label>
      <select id="f-active">
        <option value="true" \${row?.active!==false?"selected":""}>כן</option>
        <option value="false" \${row?.active===false?"selected":""}>לא</option>
      </select></div>\`; }
  if (table === "excluded") { const exp = row?.expiry_date ? String(row.expiry_date).substring(0,10) : ""; return \`
    <div class="form-group"><label>מייל חיצוני</label>
      <input id="f-email" value="\${esc(row?.email||"")}" placeholder="partner@bigcorp.com"/>
      <small>כתובת המייל החיצונית להחרגה</small></div>
    <div class="form-group"><label>היקף ההחרגה</label>
      <select id="f-scope">
        <option value="EMAIL" \${row?.scope!=="DOMAIN"?"selected":""}>מייל בלבד — רק הכתובת הזו</option>
        <option value="DOMAIN" \${row?.scope==="DOMAIN"?"selected":""}>כל הדומיין — כל כתובת באותו דומיין</option>
      </select>
      <small>"כל הדומיין" מחריג כל כתובת בדומיין של המייל שהוזן</small></div>
    <div class="form-group"><label>סיבה להחרגה</label>
      <input id="f-reason" value="\${esc(row?.reason||"")}" placeholder="שותף עסקי מאובטח"/></div>
    <div class="form-group"><label>תאריך תוקף</label>
      <input type="date" id="f-expiry" value="\${esc(exp)}"/>
      <small>לאחר תאריך זה ההחרגה אינה פעילה. השאר ריק ללא תפוגה.</small></div>
    <div class="form-group"><label>מי ביקש/ה את ההחרגה</label>
      <input id="f-requested-by" value="\${esc(row?.requested_by||"")}" placeholder="שם המבקש/ת"/></div>\`; }
  if (table === "encwords") return \`
    <div class="form-group"><label>מילה בשם הקובץ</label>
      <input id="f-keyword" value="\${esc(row?.keyword||"")}" placeholder="cash burn"/>
      <small>קובץ שֵשמו מכיל מילה זו יידרש להיות מוצפן. מתעלם מרווחים, מקפים ואותיות גדולות/קטנות.</small></div>
    <div class="form-group"><label>הערה</label>
      <input id="f-note" value="\${esc(row?.note||"")}" placeholder="דוח קאש ברן"/></div>
    <div class="form-group"><label>פעיל</label>
      <select id="f-active">
        <option value="true" \${row?.active!==false?"selected":""}>כן</option>
        <option value="false" \${row?.active===false?"selected":""}>לא</option>
      </select></div>\`;
}

function getFormData(table) {
  if (table === "customers") return {
    name: document.getElementById("f-name").value.trim(),
    primary_domain: document.getElementById("f-primary-domain").value.trim(),
    aliases: document.getElementById("f-aliases").value.split(",").map(d=>d.trim()).filter(Boolean),
    domains: document.getElementById("f-domains").value.split(",").map(d=>d.trim()).filter(Boolean)
  };
  if (table === "advisors") return {
    name: document.getElementById("f-name").value.trim(),
    email: document.getElementById("f-email").value.trim(),
    linked_customers: document.getElementById("f-linked").value.split(",").map(d=>d.trim()).filter(Boolean)
  };
  if (table === "exemptions") return {
    email: document.getElementById("f-email").value.trim(),
    reason: document.getElementById("f-reason").value.trim()
  };
  if (table === "exclusions") return {
    extension: document.getElementById("f-extension").value.trim().replace(".",""),
    reason: document.getElementById("f-reason").value.trim()
  };
  if (table === "rules") return {
    expression: document.getElementById("f-expression").value.trim(),
    language: document.getElementById("f-language").value,
    rule_type: document.getElementById("f-rule-type").value.trim() || "Encryption Exemption",
    active: document.getElementById("f-active").value === "true"
  };
  if (table === "roles") {
    const checks = [];
    if (document.getElementById("f-check-1").checked) checks.push(1);
    if (document.getElementById("f-check-2").checked) checks.push(2);
    if (document.getElementById("f-check-3").checked) checks.push(3);
    return {
      role_name: document.getElementById("f-role-name").value.trim(),
      assigned_emails: document.getElementById("f-assigned-emails").value.split(",").map(d=>d.trim()).filter(Boolean),
      bypass_checks: checks,
      active: document.getElementById("f-active").value === "true"
    };
  }
  if (table === "excluded") return {
    email: document.getElementById("f-email").value.trim(),
    scope: document.getElementById("f-scope").value,
    reason: document.getElementById("f-reason").value.trim(),
    expiry_date: document.getElementById("f-expiry").value || null,
    requested_by: document.getElementById("f-requested-by").value.trim()
  };
  if (table === "encwords") return {
    keyword: document.getElementById("f-keyword").value.trim(),
    note: document.getElementById("f-note").value.trim(),
    active: document.getElementById("f-active").value === "true"
  };
}

async function saveModal() {
  const data = getFormData(currentTable);
  const url = "/api/admin/" + currentTable + (editingId ? "/" + editingId : "");
  const method = editingId ? "PUT" : "POST";
  await fetch(url, { method, headers: { "Content-Type":"application/json" }, body: JSON.stringify(data) });
  closeModal();
  loadTable(currentTable);
  toast(editingId ? "עודכן בהצלחה ✅" : "נוסף בהצלחה ✅");
}

async function deleteRow(table, id) {
  if (!confirm("האם למחוק?")) return;
  await fetch("/api/admin/" + table + "/" + id, { method: "DELETE" });
  loadTable(table);
  toast("נמחק ✅");
}

function closeModal() {
  document.getElementById("modal-overlay").classList.remove("open");
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2500);
}
</script>
</body>
</html>`);
});

// Config endpoint — reads from PostgreSQL
// This endpoint is unauthenticated by necessity (see the CORS note at the top), so
// it must return the MINIMUM the add-in needs — nothing more.
//
// Columns are now listed explicitly instead of `SELECT *`, for two reasons:
//   1. The free-text admin fields are no longer published. `exemptions.reason`,
//      `exclusions.reason`, `excluded_recipients.reason`, `.requested_by` and
//      `encryption_keywords.note` are operator notes ("פטור עבור קבצי התביעה של
//      לקוח X") that no validator reads — only roles.role_name is used, in the
//      exemption message. They were being served to anyone on the internet.
//   2. `SELECT *` publishes any column added later by default. Explicit lists
//      fail closed: a new column stays server-side until someone opts it in.
//
// The authoritative list of what the client consumes is the mapper in
// src/services/config.service.ts — keep the two in sync when adding a field.
app.get("/api/config", configLimiter, async (req, res) => {
  try {
    // Serve the memo when it is fresh. The payload changes only when an admin
    // edits something, and clients cache it for an hour anyway, so a 30s memo is
    // invisible to users while flattening a login-storm burst into one query.
    if (configMemo && Date.now() - configMemo.at < CONFIG_MEMO_MS) {
      return serveCachedConfig(res, "fresh");
    }

    // Recipient-independent lists ONLY. customers, advisors, exemptions and
    // excludedRecipients used to be here, which meant this unauthenticated endpoint
    // handed anyone the full client roster of the firm, the addresses that bypass
    // DLP entirely, and employee names — see POST /api/resolve, which answers those
    // per recipient instead. Do not add a recipient-scoped list back here.
    //
    // What remains is deliberately public: the add-in needs it for check 1 on every
    // send, and it is discoverable from inside anyway (an employee can rename a file
    // until the encryption prompt stops appearing).
    //
    // Empty arrays are still sent for the removed keys so that a client running the
    // pre-948f06c bundle gets a well-formed payload rather than a crash. Such a
    // client will warn on every external domain, which is loud and self-reporting —
    // restarting Outlook picks up the current bundle.
    const [exclusions, rules, roles, encwords] = await Promise.all([
      pool.query("SELECT id, extension FROM exclusions"),
      pool.query("SELECT id, expression, rule_type, active FROM rules WHERE active = TRUE"),
      pool.query("SELECT id, role_name, assigned_emails, bypass_checks, active FROM roles WHERE active = TRUE"),
      pool.query("SELECT id, keyword, active FROM encryption_keywords WHERE active = TRUE"),
    ]);

    const payload = {
      customers: [],
      advisors: [],
      exemptions: [],
      exclusions: exclusions.rows,
      rules: rules.rows,
      roles: roles.rows,
      excludedRecipients: [],
      encryptionKeywords: encwords.rows,
    };
    configMemo = { payload, at: Date.now() };
    res.json(payload);
  } catch (err) {
    console.error("[Config] DB error:", err.message);
    // A transient DB blip would otherwise 500 and make every add-in fail open.
    // Serving the last known-good config keeps enforcement running; it is at most
    // a few minutes stale, and admins already tolerate a 60-minute client cache.
    if (serveCachedConfig(res, "db-error")) return;
    res.status(500).json({ error: "Database error" });
  }
});

// ── Audit input sanitisation ─────────────────────────────────────────────────
// /api/audit is unauthenticated (see the CORS note at the top), so a caller can
// post anything. Previously whatever arrived was stringified straight into JSONB,
// so a single request could store megabytes of attacker-chosen content and the
// admin log would render it. These helpers bound every field: strings are capped,
// arrays are capped in length and per-element size, and unknown keys are dropped.
const MAX_STR = 500;
const MAX_ARR = 50;
const AUDIT_ACTIONS = new Set([
  "SEND_BLOCKED", "SEND_ALLOWED", "WARNING_SHOWN",
  "EXEMPTION_APPLIED", "MANUAL_CHECK", "DLP_UNAVAILABLE",
]);

function str(v, max = MAX_STR) {
  if (v === null || v === undefined) return null;
  return String(v).slice(0, max);
}

function strArray(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX_ARR).map((x) => str(x));
}

// Audit endpoint
// TEMPORARY — remove once the v14 customer list has been imported.
//
// The import belongs in scripts/import-customers.cjs, but that has to run where the
// database credentials are, and the App Service SSH console turned out not to have
// working ones: same host, user and password variables as this process uses, same
// SSL settings, yet Postgres rejects the password there. Rather than keep debugging
// Azure's configuration plumbing, this runs the identical plan through the
// connection that demonstrably works — this one.
//
// Same admin gate as the rest of the panel, so it is exactly as reachable as the
// customer editor already is. It takes no request body: the data comes from a file
// deployed with the app, so there is nothing to inject. Dry run unless ?apply=1.
// It never deletes — see lib/customer-import.cjs.
// GET is the dry run and can never write, whatever the query string says. It exists
// so the report can be read by opening a URL — pasting a fetch() into the DevTools
// console meant fighting Chrome's paste protection for no benefit.
app.get("/api/admin/import-customers", adminAuth, (req, res) => {
  req.query = {};
  return importCustomers(req, res);
});

app.post("/api/admin/import-customers", adminAuth, (req, res) => importCustomers(req, res));

async function importCustomers(req, res) {
  const apply = req.query.apply === "1";
  const withRenames = req.query.renames === "1";

  try {
    const incoming = JSON.parse(
      fs.readFileSync(path.join(__dirname, "customers-done.json"), "utf8"),
    );
    const existing = (
      await pool.query("SELECT id, name, primary_domain, aliases, domains FROM customers")
    ).rows;
    const plan = planImport(existing, incoming);

    const summary = {
      dryRun: !apply,
      file: incoming.length,
      database: existing.length,
      willAdd: plan.inserts.length,
      willUpdate: plan.updates.length,
      renames: plan.renames.map((r) => `${r.from} -> ${r.to}`),
      skippedAmbiguous: plan.ambiguous.map((a) => `${a.incoming.name} matches ${a.matches.join(" | ")}`),
      sharedDomainsInDatabase: plan.conflicted,
      inDatabaseNotInFile: plan.absent,
      neverDeletes: true,
    };

    if (!apply) {
      return res.json({ ...summary, note: "Nothing written. Add ?apply=1 to write." });
    }
    if (plan.renames.length && !withRenames) {
      return res.status(409).json({
        ...summary,
        error: "Renames present. Confirm each one, then add &renames=1 to proceed.",
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const c of plan.inserts) {
        await client.query(
          "INSERT INTO customers (name, primary_domain, aliases, domains) VALUES ($1, $2, $3, $4)",
          [c.name, c.primary_domain, c.aliases, c.domains],
        );
      }
      for (const u of plan.updates) {
        await client.query(
          "UPDATE customers SET name = $1, primary_domain = $2, aliases = $3, domains = $4 WHERE id = $5",
          [u.after.name, u.after.primary_domain, u.after.aliases, u.after.domains, u.id],
        );
      }
      await client.query("COMMIT");
      configMemo = null;
      resolveMemo = null;
      res.json({ ...summary, applied: true, added: plan.inserts.length, updated: plan.updates.length });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[Import] rolled back:", err.message);
      res.status(500).json({ error: "Rolled back — nothing changed", detail: err.message });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("[Import] failed:", err.message);
    res.status(500).json({ error: "Import failed", detail: err.message });
  }
}

// A page with a button, so running the import needs no console and no pasting.
// Same admin gate; the Apply button POSTs, which is what the CSRF guard expects.
app.get("/admin/import", adminAuth, (req, res) => {
  res.header("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<title>ייבוא לקוחות</title><style>
body{font-family:Segoe UI,sans-serif;margin:24px;background:#f7f8fa;color:#111}
h1{font-size:20px;color:#080056} button{font:inherit;padding:10px 18px;border:0;border-radius:6px;cursor:pointer}
#dry{background:#323A9F;color:#fff} #go{background:#DA4A54;color:#fff;display:none}
pre{background:#fff;border:1px solid #dde;border-radius:6px;padding:12px;max-height:60vh;overflow:auto;white-space:pre-wrap;font-size:12px}
.note{color:#555;font-size:13px;margin:8px 0 16px}
</style></head><body>
<h1>ייבוא רשימת לקוחות</h1>
<p class="note">«בדיקה» אינה כותבת דבר. «בצע ייבוא» מוסיף ומעדכן בתוך טרנזקציה אחת, ואינו מוחק אף לקוח.</p>
<button id="dry">בדיקה (ללא כתיבה)</button>
<button id="go">בצע ייבוא</button>
<pre id="out">—</pre>
<script>
const out=document.getElementById("out");
// Built rather than written as an escape: this page is inside a template literal in
// server.cjs, so a backslash-n there is consumed by Node and arrives as a real line
// break, which splits the string literal and stops the whole script parsing — which
// is exactly what silently killed these buttons once already.
const NL=String.fromCharCode(10);
async function call(qs){
  out.textContent="רץ...";
  try{
    const r=await fetch("/api/admin/import-customers"+qs,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:"{}"});
    // Read as text first. An empty or non-JSON body — a platform error page, an auth
    // redirect — used to surface only as "Unexpected end of JSON input", which says
    // nothing about what actually happened.
    const raw=await r.text();
    if(!raw){ out.textContent="HTTP "+r.status+" "+r.statusText+NL+"(תשובה ריקה — אין גוף)"+NL+"content-type: "+(r.headers.get("content-type")||"-"); return; }
    let j=null; try{ j=JSON.parse(raw); }catch(_){}
    if(!j){ out.textContent="HTTP "+r.status+NL+"content-type: "+(r.headers.get("content-type")||"-")+NL+NL+raw.slice(0,1500); return; }
    out.textContent="HTTP "+r.status+NL+JSON.stringify(j,null,1);
    if(j.dryRun) document.getElementById("go").style.display="inline-block";
  }catch(e){ out.textContent="נכשל לפני קבלת תשובה: "+e.message; }
}
document.getElementById("dry").onclick=()=>call("");
document.getElementById("go").onclick=()=>{
  if(confirm("לכתוב לבסיס הנתונים? הפעולה מוסיפה ומעדכנת, ואינה מוחקת.")) call("?apply=1&renames=1");
};
</script></body></html>`);
});

// Returns only what the current recipients justify. Unauthenticated for the same
// reason as /api/audit — the send-event runtime cannot preflight — so it carries
// the same defences: capped body (see the parser above), rate limit, and strict
// input validation. It never returns a full list on any path.
app.post("/api/resolve", resolveLimiter, async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "Expected a JSON object" });
  }

  const userEmail = typeof body.userEmail === "string" ? body.userEmail.slice(0, 254) : "";
  // Cap the recipient count: this is the only unauthenticated input that drives a
  // roster scan, so an unbounded array would let one request cost 365 × N work.
  const recipients = Array.isArray(body.recipients)
    ? body.recipients.filter((r) => typeof r === "string").slice(0, 100).map((r) => r.slice(0, 254))
    : [];
  if (!recipients.length) {
    return res.status(400).json({ error: "recipients must be a non-empty array of strings" });
  }

  try {
    const { customers, advisors, exemptions, excluded } = await loadResolveData();

    res.json({
      // Full records, so the add-in's own matching stays authoritative — this
      // narrows what it looks at rather than deciding for it.
      matchedCustomers: matchCustomers(customers, recipients),
      unknownDomains: findUnknownDomains(recipients, buildKnown(customers, advisors), excluded),
      excludedRecipients: matchExcluded(excluded, recipients).map((x) => ({
        email: x.email,
        scope: x.scope,
        expiry_date: x.expiry_date,
      })),
      userExempt: isUserExempt(exemptions, userEmail),
    });
  } catch (err) {
    console.error("[Resolve] DB error:", err.message);
    // No cached fallback here on purpose: a stale roster would silently answer
    // "domain unknown" for a customer added since, so failing is the honest
    // outcome. The add-in treats a failure as checks 2-3 unavailable and warns
    // the user, per the agreed policy.
    res.status(500).json({ error: "Database error" });
  }
});

app.post("/api/audit", auditLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    // The client sends a rich entry (recipients, subject, attachments, severity,
    // check, result). Previously only `data` was persisted, and block/warning
    // entries don't set `data` — so the מידע column was always empty. Fall back to
    // assembling a detail object from the entry fields so the log is useful.
    // `message` is the exact prompt text the user saw — keep it first so the admin
    // log can show it instead of the raw check number.
    //
    // Every field is rebuilt through str()/strArray() rather than passed through, so
    // only known keys with bounded sizes are persisted. `src` is the exemption
    // payload when present (recordExemption) and the flat entry otherwise.
    const src = b.data !== undefined && b.data !== null ? b.data : b;
    const data = {
      message: str(src.message ?? b.message, 1000),
      check: Number.isInteger(b.checkNumber) ? b.checkNumber : null,
      result: str(b.result, 20),
      severity: str(b.severity, 20),
      subject: str(src.subject ?? b.messageSubject),
      recipients: strArray(src.recipients ?? b.recipientEmails),
      attachments: strArray(src.attachments ?? b.attachmentNames),
    };
    // Carry the exemption-specific fields only when this really is one.
    if (src.type === "ENCRYPTION_EXEMPT") {
      data.type = "ENCRYPTION_EXEMPT";
      data.expression = str(src.expression, 200);
    }
    // recordUnavailable() sends the failure cause under `details.reason`; it was
    // being dropped on the floor before, which made DLP_UNAVAILABLE rows useless
    // for diagnosing why enforcement failed open.
    if (b.details && b.details.reason) data.reason = str(b.details.reason, 500);

    // An unrecognised action would make the admin log unfilterable, so pin it to
    // the known set instead of storing arbitrary text.
    const action = AUDIT_ACTIONS.has(b.action) ? b.action : "UNKNOWN";
    // Bounded, and only stored when it looks like an address at all.
    const rawEmail = str(b.userEmail, 320);
    const userEmail = rawEmail && rawEmail.includes("@") ? rawEmail.toLowerCase() : "unknown";

    // Emit a distinctive line to the server log for the one action that means
    // enforcement stopped working. The audit row alone is not enough: nothing reads
    // the table, so a silent failure stayed invisible until someone happened to open
    // the admin log. This marker is what an Azure alert rule matches on — keep the
    // string stable, an alert rule depends on it. Logged BEFORE the insert so a DB
    // failure cannot swallow the signal.
    if (action === "DLP_UNAVAILABLE") {
      console.error(
        `DLP_ENFORCEMENT_FAILED_OPEN user=${userEmail} reason=${data.reason || "unknown"}`,
      );
    }

    await pool.query(
      "INSERT INTO audit_log (user_email, action, data) VALUES ($1, $2, $3)",
      [userEmail, action, JSON.stringify(data)]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("[Audit] DB error:", err.message);
    res.json({ ok: false });
  }
});

// ⚠️ REMOVED (security): POST /api/seed used to TRUNCATE customers/advisors/
// exemptions/exclusions and re-insert spec test data — with NO authentication.
// Any unauthenticated caller could wipe the production config in one request,
// which silently disables every DLP check org-wide. Nothing referenced it (not
// the admin UI, not the add-in, not CI), so it was deleted rather than gated.
// If test data is ever needed again, seed it from the /admin UI or a local
// psql script — never from an unauthenticated HTTP route.

// ── Audit-log retention ──────────────────────────────────────────────────────
// The stated policy is 90 days, but nothing enforced it: the add-in sends a `ttl`
// field that no code path ever read (a leftover from the original Cosmos DB design,
// where Cosmos expired rows itself). On Postgres rows simply accumulated, so a log
// holding sender addresses, recipients and subject lines was retained forever.
//
// DELETE is idempotent, so it stays correct if the Web App is ever scaled out and
// several instances run this concurrently.
async function purgeOldAuditRows() {
  try {
    const r = await pool.query(
      `DELETE FROM audit_log WHERE created_at < NOW() - ($1 || ' days')::INTERVAL`,
      [String(RETENTION_DAYS)],
    );
    if (r.rowCount > 0) {
      console.log(`🧹 Audit retention: deleted ${r.rowCount} row(s) older than ${RETENTION_DAYS} days`);
    }
  } catch (err) {
    // Never throw: a failed purge must not take the backend down, because a dead
    // backend makes every add-in fail open (DLP silently disabled).
    console.error("[Retention] purge failed:", err.message);
  }
}

// Serve taskpane for all other routes
app.use((req, res) => {
  res.sendFile(path.join(__dirname, "dist", "taskpane.html"));
});

const PORT = process.env.PORT || 8080;
// Error handler — must stay last, after every route. Express's default handler
// serialises the stack trace into the response unless NODE_ENV=production, and
// NODE_ENV is not set by the deploy workflow or web.config, so any unhandled
// throw was answering with absolute file paths, line numbers and the module
// layout. Log the detail server-side (where the Http5xx alert will also see it)
// and return a body that says nothing about internals.
// A client error must keep its 4xx status. body-parser raises malformed JSON and
// an over-limit body as errors carrying status 400 / 413, and collapsing those to
// 500 would both mislabel them and trip the Http5xx alert rule on ordinary bad
// input — which is how an alert earns a reputation for crying wolf.
// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature.
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode;
  const clientError = Number.isInteger(status) && status >= 400 && status < 500;

  if (clientError) {
    console.warn(`[${status}] ${req.method} ${req.path}: ${err.message}`);
  } else {
    console.error(`[Unhandled] ${req.method} ${req.path}:`, err.stack || err.message);
  }

  if (res.headersSent) return;
  res.status(clientError ? status : 500).json({
    error: clientError ? "Bad request" : "Internal server error",
  });
});

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initDB();
  await purgeOldAuditRows();
  setInterval(purgeOldAuditRows, PURGE_INTERVAL_MS).unref();
});
