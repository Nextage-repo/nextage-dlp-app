const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const app = express();

// PostgreSQL connection
const pool = new Pool({
  host: process.env.AZURE_POSTGRESQL_HOST,
  database: process.env.AZURE_POSTGRESQL_DATABASE,
  user: process.env.AZURE_POSTGRESQL_USER,
  password: process.env.AZURE_POSTGRESQL_PASSWORD,
  port: parseInt(process.env.AZURE_POSTGRESQL_PORT || "5432"),
  ssl: { rejectUnauthorized: false }
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
    console.log("✅ Database tables ready");
  } catch (err) {
    console.error("❌ DB init error:", err.message);
  }
}

// Parse JSON bodies. IMPORTANT: also parse "text/plain" — the add-in posts audit
// entries with Content-Type: text/plain so the request stays a CORS "simple"
// request (Classic Outlook's JS-only send runtime cannot complete a preflight).
// With the default (application/json only) those bodies were dropped, so audit
// rows were written with null user/action and empty data.
app.use(express.json({ type: ["application/json", "text/plain"] }));
app.use(express.static(path.join(__dirname, "dist")));

// CORS headers
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Simple admin auth middleware
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "nextage-admin-2025";
function adminAuth(req, res, next) {
  const auth = req.headers["x-admin-password"];
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
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
app.get("/api/admin/audit.csv", adminAuth, async (req, res) => {
  const { whereSql, params } = buildAuditFilter(req.query);
  const r = await pool.query(
    `SELECT created_at, user_email, action, data FROM audit_log ${whereSql} ORDER BY created_at DESC LIMIT 50000`,
    params,
  );
  const esc = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const lines = ["created_at,user_email,action,data"];
  for (const row of r.rows) {
    const data = typeof row.data === "string" ? row.data : JSON.stringify(row.data ?? "");
    lines.push([esc(new Date(row.created_at).toISOString()), esc(row.user_email), esc(row.action), esc(data)].join(","));
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="audit-log.csv"');
  res.send("﻿" + lines.join("\n")); // BOM so Excel reads Hebrew correctly
});

// Admin UI
app.get("/admin", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Nextage DLP — Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #f0f2f5; color: #1a1a2e; direction: rtl; }
    #login-screen { display: flex; align-items: center; justify-content: center; height: 100vh; }
    .login-box { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.12); width: 340px; text-align: center; }
    .login-box h1 { font-size: 22px; margin-bottom: 8px; color: #0078d4; }
    .login-box p { color: #666; margin-bottom: 24px; font-size: 14px; }
    .login-box input { width: 100%; padding: 10px 14px; border: 1px solid #ddd; border-radius: 8px; font-size: 15px; margin-bottom: 14px; text-align: center; }
    .btn { padding: 10px 20px; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; transition: all 0.2s; }
    .btn-primary { background: #0078d4; color: white; }
    .btn-primary:hover { background: #005fa3; }
    .btn-danger { background: #d13438; color: white; }
    .btn-danger:hover { background: #a4262c; }
    .btn-success { background: #107c10; color: white; }
    .btn-success:hover { background: #0b5e0b; }
    .btn-sm { padding: 5px 12px; font-size: 12px; }
    #app { display: none; }
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
    .audit-time { font-size: 12px; color: #888; }
    .audit-action { font-weight: 600; color: #0078d4; }
  </style>
</head>
<body>

<div id="login-screen">
  <div class="login-box">
    <h1>🔐 Nextage DLP Admin</h1>
    <p>הכנס סיסמת מנהל כדי להמשיך</p>
    <input type="password" id="pwd-input" placeholder="סיסמה" onkeydown="if(event.key==='Enter')login()"/>
    <button class="btn btn-primary" style="width:100%" onclick="login()">כניסה</button>
    <p id="login-error" style="color:#d13438;font-size:13px;margin-top:12px;display:none">סיסמה שגויה</p>
  </div>
</div>

<div id="app">
  <header>
    <h1>🛡️ Nextage DLP — ממשק ניהול</h1>
    <span>מחובר כמנהל מערכת</span>
  </header>
  <nav>
    <button class="active" onclick="showTab('customers',this)">👥 לקוחות</button>
    <button onclick="showTab('advisors',this)">🧑‍💼 יועצים</button>
    <button onclick="showTab('exemptions',this)">✅ פטורים</button>
    <button onclick="showTab('exclusions',this)">📎 סיומות קבצים</button>
    <button onclick="showTab('rules',this)">📜 חוקים</button>
    <button onclick="showTab('roles',this)">🎫 תפקידים</button>
    <button onclick="showTab('excluded',this)">🚫 מוחרגים</button>
    <button onclick="showTab('audit',this)">📋 לוג ביקורת</button>
  </nav>
  <main>

    <!-- CUSTOMERS -->
    <div class="section active" id="section-customers">
      <div class="card">
        <div class="card-header">
          <h2>לקוחות</h2>
          <button class="btn btn-success btn-sm" onclick="openModal('customers')">+ הוסף לקוח</button>
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
          <button class="btn btn-success btn-sm" onclick="openModal('advisors')">+ הוסף יועץ</button>
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
          <button class="btn btn-success btn-sm" onclick="openModal('exemptions')">+ הוסף פטור</button>
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
          <button class="btn btn-success btn-sm" onclick="openModal('exclusions')">+ הוסף סיומת</button>
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
          <button class="btn btn-success btn-sm" onclick="openModal('rules')">+ הוסף חוק</button>
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
          <button class="btn btn-success btn-sm" onclick="openModal('roles')">+ הוסף תפקיד</button>
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
          <button class="btn btn-success btn-sm" onclick="openModal('excluded')">+ הוסף החרגה</button>
        </div>
        <table><thead><tr><th>מייל</th><th>היקף</th><th>סיבה</th><th>תוקף</th><th>ביקש/ה</th><th>פעולות</th></tr></thead>
        <tbody id="table-excluded"></tbody></table>
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
let PWD = "";
let currentTable = "";
let editingId = null;

function login() {
  PWD = document.getElementById("pwd-input").value;
  fetch("/api/admin/customers", { headers: { "x-admin-password": PWD } })
    .then(r => {
      if (r.status === 401) {
        document.getElementById("login-error").style.display = "block";
      } else {
        document.getElementById("login-screen").style.display = "none";
        document.getElementById("app").style.display = "block";
        loadAll();
      }
    });
}

function showTab(name, btn) {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  document.querySelectorAll("nav button").forEach(b => b.classList.remove("active"));
  document.getElementById("section-" + name).classList.add("active");
  btn.classList.add("active");
  if (name === "audit") { loadAudit(true); return; }
  loadTable(name);
}

function loadAll() {
  loadTable("customers");
}

async function loadTable(name) {
  const res = await fetch("/api/admin/" + name, { headers: { "x-admin-password": PWD } });
  const data = await res.json();
  const tbody = document.getElementById("table-" + name);
  if (!data.length) { tbody.innerHTML = '<tr><td colspan="4" class="empty">אין נתונים</td></tr>'; return; }

  if (name === "customers") {
    tbody.innerHTML = data.map(r => \`<tr>
      <td><strong>\${r.name}</strong></td>
      <td>\${r.primary_domain ? \`<span class="tag tag-green">\${r.primary_domain}</span>\` : '<span style="color:#aaa">—</span>'}</td>
      <td>\${(r.aliases||[]).map(a=>\`<span class="tag tag-gray">\${a}</span>\`).join("") || '<span style="color:#aaa">—</span>'}</td>
      <td>\${(r.domains||[]).map(d=>\`<span class="tag">\${d}</span>\`).join("") || '<span style="color:#aaa">—</span>'}</td>
      <td class="actions">
        <button class="btn btn-primary btn-sm" onclick='editRow("customers",\${JSON.stringify(r)})'>✏️ ערוך</button>
        <button class="btn btn-danger btn-sm" onclick='deleteRow("customers",\${r.id})'>🗑️</button>
      </td></tr>\`).join("");
  } else if (name === "advisors") {
    tbody.innerHTML = data.map(r => \`<tr>
      <td><strong>\${r.name}</strong></td>
      <td>\${r.email}</td>
      <td>\${(r.linked_customers||[]).map(c=>\`<span class="tag tag-green">\${c}</span>\`).join("") || '<span style="color:#aaa">—</span>'}</td>
      <td class="actions">
        <button class="btn btn-primary btn-sm" onclick='editRow("advisors",\${JSON.stringify(r)})'>✏️ ערוך</button>
        <button class="btn btn-danger btn-sm" onclick='deleteRow("advisors",\${r.id})'>🗑️</button>
      </td></tr>\`).join("");
  } else if (name === "exemptions") {
    tbody.innerHTML = data.map(r => \`<tr>
      <td>\${r.email}</td>
      <td>\${r.reason||""}</td>
      <td class="actions">
        <button class="btn btn-primary btn-sm" onclick='editRow("exemptions",\${JSON.stringify(r)})'>✏️ ערוך</button>
        <button class="btn btn-danger btn-sm" onclick='deleteRow("exemptions",\${r.id})'>🗑️</button>
      </td></tr>\`).join("");
  } else if (name === "exclusions") {
    tbody.innerHTML = data.map(r => \`<tr>
      <td><span class="tag tag-gray">.\${r.extension}</span></td>
      <td>\${r.reason||""}</td>
      <td class="actions">
        <button class="btn btn-primary btn-sm" onclick='editRow("exclusions",\${JSON.stringify(r)})'>✏️ ערוך</button>
        <button class="btn btn-danger btn-sm" onclick='deleteRow("exclusions",\${r.id})'>🗑️</button>
      </td></tr>\`).join("");
  } else if (name === "rules") {
    tbody.innerHTML = data.map(r => \`<tr>
      <td><strong>\${r.expression}</strong></td>
      <td>\${r.language||""}</td>
      <td><span class="tag">\${r.rule_type||""}</span></td>
      <td>\${r.active ? '<span class="tag tag-green">פעיל</span>' : '<span class="tag tag-gray">לא פעיל</span>'}</td>
      <td class="actions">
        <button class="btn btn-primary btn-sm" onclick='editRow("rules",\${JSON.stringify(r)})'>✏️ ערוך</button>
        <button class="btn btn-danger btn-sm" onclick='deleteRow("rules",\${r.id})'>🗑️</button>
      </td></tr>\`).join("");
  } else if (name === "roles") {
    tbody.innerHTML = data.map(r => \`<tr>
      <td><strong>\${r.role_name}</strong></td>
      <td>\${(r.assigned_emails||[]).map(e=>\`<span class="tag">\${e}</span>\`).join("") || '<span style="color:#aaa">—</span>'}</td>
      <td>\${(r.bypass_checks||[]).map(c=>\`<span class="tag tag-gray">\${checkLabel(c)}</span>\`).join("") || '<span style="color:#aaa">—</span>'}</td>
      <td>\${r.active ? '<span class="tag tag-green">פעיל</span>' : '<span class="tag tag-gray">לא פעיל</span>'}</td>
      <td class="actions">
        <button class="btn btn-primary btn-sm" onclick='editRow("roles",\${JSON.stringify(r)})'>✏️ ערוך</button>
        <button class="btn btn-danger btn-sm" onclick='deleteRow("roles",\${r.id})'>🗑️</button>
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
        : (expired ? \`<span class="tag tag-red">פג (\${new Date(r.expiry_date).toLocaleDateString("he-IL")})</span>\`
                   : \`<span class="tag">\${new Date(r.expiry_date).toLocaleDateString("he-IL")}</span>\`);
      return \`<tr>
      <td><strong>\${r.email}</strong></td>
      <td>\${scopeTag}</td>
      <td>\${r.reason||""}</td>
      <td>\${validTag}</td>
      <td>\${r.requested_by||""}</td>
      <td class="actions">
        <button class="btn btn-primary btn-sm" onclick='editRow("excluded",\${JSON.stringify(r)})'>✏️ ערוך</button>
        <button class="btn btn-danger btn-sm" onclick='deleteRow("excluded",\${r.id})'>🗑️</button>
      </td></tr>\`;
    }).join("");
  }
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

function auditRowsHtml(data) {
  return data.map(r => {
    const detail = r.data ? JSON.stringify(r.data) : "";
    return \`<tr>
      <td class="audit-time">\${esc(new Date(r.created_at).toLocaleString("he-IL"))}</td>
      <td>\${esc(r.user_email)}</td>
      <td class="audit-action">\${esc(r.action)}</td>
      <td style="font-size:12px;color:#888" title="\${esc(detail)}">\${esc(detail.substring(0,90))}</td>
      </tr>\`;
  }).join("");
}

// reset=true starts a fresh query from the current filters; reset=false pages older rows.
async function loadAudit(reset) {
  if (reset) auditOffset = 0;
  const p = auditQueryString();
  p.set("limit", AUDIT_PAGE);
  p.set("offset", auditOffset);
  const res = await fetch("/api/admin/audit?" + p.toString(), { headers: { "x-admin-password": PWD } });
  const data = await res.json();
  const tbody = document.getElementById("table-audit");
  const html = auditRowsHtml(data);
  if (reset) {
    tbody.innerHTML = html || '<tr><td colspan="4" class="empty">אין נתונים</td></tr>';
  } else {
    tbody.innerHTML += html;
  }
  auditOffset += data.length;
  document.getElementById("audit-more").style.display = data.length < AUDIT_PAGE ? "none" : "";
}

function applyAuditFilter() { loadAudit(true); }
function clearAuditFilter() {
  document.getElementById("audit-date").value = "";
  document.getElementById("audit-user").value = "";
  loadAudit(true);
}

async function exportAudit() {
  const res = await fetch("/api/admin/audit.csv?" + auditQueryString().toString(), { headers: { "x-admin-password": PWD } });
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
  return { customers:"לקוח", advisors:"יועץ", exemptions:"פטור", exclusions:"סיומת", rules:"חוק", roles:"תפקיד", excluded:"החרגה" }[t] || t;
}

function buildForm(table, row) {
  if (table === "customers") return \`
    <div class="form-group"><label>שם לקוח</label>
      <input id="f-name" value="\${row?.name||""}" placeholder="בנק לאומי"/></div>
    <div class="form-group"><label>דומיין ראשי</label>
      <input id="f-primary-domain" value="\${row?.primary_domain||""}" placeholder="leumi.co.il"/>
      <small>הדומיין הרשמי העיקרי של הלקוח</small></div>
    <div class="form-group"><label>כינויים (Aliases)</label>
      <input id="f-aliases" value="\${(row?.aliases||[]).join(", ")}" placeholder="bankleumi.co.il, leumi.com"/>
      <small>שמות חלופיים — הפרד בפסיק</small></div>
    <div class="form-group"><label>דומיינים נוספים</label>
      <input id="f-domains" value="\${(row?.domains||[]).join(", ")}" placeholder="leumi.co.il, bankleumi.co.il"/>
      <small>כל הדומיינים לבדיקת DLP — הפרד בפסיק</small></div>\`;
  if (table === "advisors") return \`
    <div class="form-group"><label>שם</label>
      <input id="f-name" value="\${row?.name||""}" placeholder="ישראל ישראלי"/></div>
    <div class="form-group"><label>אימייל</label>
      <input id="f-email" value="\${row?.email||""}" placeholder="name@nextage.co.il"/></div>
    <div class="form-group"><label>לקוחות מקושרים</label>
      <input id="f-linked" value="\${(row?.linked_customers||[]).join(", ")}" placeholder="בנק לאומי, מגדל ביטוח"/>
      <small>שמות לקוחות מדויקים כפי שמופיעים בטבלת לקוחות — הפרד בפסיק</small></div>\`;
  if (table === "exemptions") return \`
    <div class="form-group"><label>אימייל</label>
      <input id="f-email" value="\${row?.email||""}" placeholder="name@nextage.co.il"/></div>
    <div class="form-group"><label>סיבה</label>
      <input id="f-reason" value="\${row?.reason||""}" placeholder="מנהל מערכת"/></div>\`;
  if (table === "exclusions") return \`
    <div class="form-group"><label>סיומת קובץ</label>
      <input id="f-extension" value="\${row?.extension||""}" placeholder="pdf"/>
      <small>ללא נקודה</small></div>
    <div class="form-group"><label>סיבה</label>
      <input id="f-reason" value="\${row?.reason||""}" placeholder="PDF מוגן בנפרד"/></div>\`;
  if (table === "rules") return \`
    <div class="form-group"><label>ביטוי (Expression)</label>
      <input id="f-expression" value="\${row?.expression||""}" placeholder="חשבונית ספק"/>
      <small>מחרוזת שתיבדק כתת-מחרוזת בתוך נושא המייל (לא תלוי רישיות)</small></div>
    <div class="form-group"><label>שפה</label>
      <select id="f-language">
        <option value="Hebrew" \${row?.language!=="English"?"selected":""}>Hebrew</option>
        <option value="English" \${row?.language==="English"?"selected":""}>English</option>
      </select></div>
    <div class="form-group"><label>סוג חוק</label>
      <input id="f-rule-type" value="\${row?.rule_type||"Encryption Exemption"}"/>
      <small>ברירת מחדל: Encryption Exemption</small></div>
    <div class="form-group"><label>פעיל</label>
      <select id="f-active">
        <option value="true" \${row?.active!==false?"selected":""}>כן</option>
        <option value="false" \${row?.active===false?"selected":""}>לא</option>
      </select></div>\`;
  if (table === "roles") { const bc = row?.bypass_checks || []; return \`
    <div class="form-group"><label>שם תפקיד</label>
      <input id="f-role-name" value="\${row?.role_name||""}" placeholder="CFO"/></div>
    <div class="form-group"><label>אימיילים משויכים</label>
      <input id="f-assigned-emails" value="\${(row?.assigned_emails||[]).join(", ")}" placeholder="cfo@nextage.co.il, name@nextage.co.il"/>
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
      <input id="f-email" value="\${row?.email||""}" placeholder="partner@bigcorp.com"/>
      <small>כתובת המייל החיצונית להחרגה</small></div>
    <div class="form-group"><label>היקף ההחרגה</label>
      <select id="f-scope">
        <option value="EMAIL" \${row?.scope!=="DOMAIN"?"selected":""}>מייל בלבד — רק הכתובת הזו</option>
        <option value="DOMAIN" \${row?.scope==="DOMAIN"?"selected":""}>כל הדומיין — כל כתובת באותו דומיין</option>
      </select>
      <small>"כל הדומיין" מחריג כל כתובת בדומיין של המייל שהוזן</small></div>
    <div class="form-group"><label>סיבה להחרגה</label>
      <input id="f-reason" value="\${row?.reason||""}" placeholder="שותף עסקי מאובטח"/></div>
    <div class="form-group"><label>תאריך תוקף</label>
      <input type="date" id="f-expiry" value="\${exp}"/>
      <small>לאחר תאריך זה ההחרגה אינה פעילה. השאר ריק ללא תפוגה.</small></div>
    <div class="form-group"><label>מי ביקש/ה את ההחרגה</label>
      <input id="f-requested-by" value="\${row?.requested_by||""}" placeholder="שם המבקש/ת"/></div>\`; }
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
}

async function saveModal() {
  const data = getFormData(currentTable);
  const url = "/api/admin/" + currentTable + (editingId ? "/" + editingId : "");
  const method = editingId ? "PUT" : "POST";
  await fetch(url, { method, headers: { "Content-Type":"application/json", "x-admin-password": PWD }, body: JSON.stringify(data) });
  closeModal();
  loadTable(currentTable);
  toast(editingId ? "עודכן בהצלחה ✅" : "נוסף בהצלחה ✅");
}

async function deleteRow(table, id) {
  if (!confirm("האם למחוק?")) return;
  await fetch("/api/admin/" + table + "/" + id, { method: "DELETE", headers: { "x-admin-password": PWD } });
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
app.get("/api/config", async (req, res) => {
  try {
    const [customers, advisors, exemptions, exclusions, rules, roles, excluded] = await Promise.all([
      pool.query("SELECT * FROM customers"),
      pool.query("SELECT * FROM advisors"),
      pool.query("SELECT * FROM exemptions"),
      pool.query("SELECT * FROM exclusions"),
      pool.query("SELECT * FROM rules WHERE active = TRUE"),
      pool.query("SELECT * FROM roles WHERE active = TRUE"),
      pool.query("SELECT * FROM excluded_recipients WHERE expiry_date IS NULL OR expiry_date >= CURRENT_DATE"),
    ]);

    res.json({
      customers: customers.rows,
      advisors: advisors.rows,
      exemptions: exemptions.rows,
      exclusions: exclusions.rows,
      rules: rules.rows,
      roles: roles.rows,
      excludedRecipients: excluded.rows,
    });
  } catch (err) {
    console.error("[Config] DB error:", err.message);
    res.status(500).json({ error: "Database error" });
  }
});

// Audit endpoint
app.post("/api/audit", async (req, res) => {
  try {
    const b = req.body || {};
    // The client sends a rich entry (recipients, subject, attachments, severity,
    // check, result). Previously only `data` was persisted, and block/warning
    // entries don't set `data` — so the מידע column was always empty. Fall back to
    // assembling a detail object from the entry fields so the log is useful.
    const data =
      b.data !== undefined && b.data !== null
        ? b.data
        : {
            check: b.checkNumber,
            result: b.result,
            severity: b.severity,
            subject: b.messageSubject,
            recipients: b.recipientEmails,
            attachments: b.attachmentNames,
          };
    await pool.query(
      "INSERT INTO audit_log (user_email, action, data) VALUES ($1, $2, $3)",
      [b.userEmail, b.action, JSON.stringify(data)]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("[Audit] DB error:", err.message);
    res.json({ ok: false });
  }
});

// Seed endpoint — loads exact test data from spec document
app.post("/api/seed", async (req, res) => {
  try {
    await pool.query(`
      TRUNCATE customers, advisors, exemptions, exclusions RESTART IDENTITY CASCADE;
    `);

    // Customers — exact data from spec test scenarios
    await pool.query(`
      INSERT INTO customers (name, primary_domain, aliases, domains) VALUES
        ('ClientCorp Inc',     'clientcorp.com',    ARRAY['ClientCorp','CC'],          ARRAY['clientcorp.com']),
        ('Tech Solutions Ltd', 'techsol.co.il',     ARRAY['TechSol','TS'],             ARRAY['techsol.co.il']),
        ('Global Finance',     'globalfinance.net', ARRAY['GF','Finance Corp'],        ARRAY['globalfinance.net']);
    `);

    // Advisors — domain-based (each advisor represents an external firm's domain)
    await pool.query(`
      INSERT INTO advisors (email, name, linked_customers) VALUES
        ('consultant@advisor1.com', 'Advisor Test 1', ARRAY['ClientCorp Inc']),
        ('consultant@advisor2.com', 'Advisor Test 2', ARRAY['Tech Solutions Ltd']),
        ('consultant@advisor3.com', 'Advisor Test 3', ARRAY['Global Finance']);
    `);

    // Exemptions — only scenario 18 user has ALL_CHECKS bypass
    await pool.query(`
      INSERT INTO exemptions (email, reason) VALUES
        ('test@randomdomain.com', 'ALL_CHECKS - בדיקת תרחיש 18');
    `);

    // Exclusions — file extensions that skip Check 1
    // (images are already hardcoded in code, these are extras)
    await pool.query(`
      INSERT INTO exclusions (extension, reason) VALUES
        ('pdf',  'PDF נבדק בנפרד'),
        ('txt',  'טקסט לא רגיש'),
        ('png',  'תמונה'),
        ('jpg',  'תמונה'),
        ('jpeg', 'תמונה'),
        ('gif',  'תמונה');
    `);

    res.json({ ok: true, message: "Seeded with spec test data — all 20 scenarios ready!" });
  } catch (err) {
    console.error("[Seed] error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Serve taskpane for all other routes
app.use((req, res) => {
  res.sendFile(path.join(__dirname, "dist", "taskpane.html"));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initDB();
});
