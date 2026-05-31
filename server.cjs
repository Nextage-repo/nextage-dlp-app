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
        name TEXT NOT NULL
      );
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
    `);
    console.log("✅ Database tables ready");
  } catch (err) {
    console.error("❌ DB init error:", err.message);
  }
}

app.use(express.json());
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
  const { email, name } = req.body;
  const r = await pool.query(
    "INSERT INTO advisors (email, name) VALUES ($1, $2) RETURNING *",
    [email, name]
  );
  res.json(r.rows[0]);
});
app.put("/api/admin/advisors/:id", adminAuth, async (req, res) => {
  const { email, name } = req.body;
  const r = await pool.query(
    "UPDATE advisors SET email=$1, name=$2 WHERE id=$3 RETURNING *",
    [email, name, req.params.id]
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

// Audit log (read only)
app.get("/api/admin/audit", adminAuth, async (req, res) => {
  const r = await pool.query("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200");
  res.json(r.rows);
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
        <table><thead><tr><th>שם</th><th>אימייל</th><th>פעולות</th></tr></thead>
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

    <!-- AUDIT LOG -->
    <div class="section" id="section-audit">
      <div class="card">
        <div class="card-header"><h2>לוג ביקורת (200 אחרונים)</h2></div>
        <table><thead><tr><th>זמן</th><th>משתמש</th><th>פעולה</th><th>מידע</th></tr></thead>
        <tbody id="table-audit"></tbody></table>
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
  } else if (name === "audit") {
    tbody.innerHTML = data.map(r => \`<tr>
      <td class="audit-time">\${new Date(r.created_at).toLocaleString("he-IL")}</td>
      <td>\${r.user_email||""}</td>
      <td class="audit-action">\${r.action||""}</td>
      <td style="font-size:12px;color:#888">\${r.data ? JSON.stringify(r.data).substring(0,80) : ""}</td>
      </tr>\`).join("");
  }
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
  return { customers:"לקוח", advisors:"יועץ", exemptions:"פטור", exclusions:"סיומת" }[t] || t;
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
      <input id="f-email" value="\${row?.email||""}" placeholder="name@nextage.co.il"/></div>\`;
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
    email: document.getElementById("f-email").value.trim()
  };
  if (table === "exemptions") return {
    email: document.getElementById("f-email").value.trim(),
    reason: document.getElementById("f-reason").value.trim()
  };
  if (table === "exclusions") return {
    extension: document.getElementById("f-extension").value.trim().replace(".",""),
    reason: document.getElementById("f-reason").value.trim()
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
    const [customers, advisors, exemptions, exclusions] = await Promise.all([
      pool.query("SELECT * FROM customers"),
      pool.query("SELECT * FROM advisors"),
      pool.query("SELECT * FROM exemptions"),
      pool.query("SELECT * FROM exclusions"),
    ]);

    res.json({
      customers: customers.rows,
      advisors: advisors.rows,
      exemptions: exemptions.rows,
      exclusions: exclusions.rows,
    });
  } catch (err) {
    console.error("[Config] DB error:", err.message);
    res.status(500).json({ error: "Database error" });
  }
});

// Audit endpoint
app.post("/api/audit", async (req, res) => {
  try {
    const { userEmail, action, data } = req.body;
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

// Temporary seed endpoint — remove after first use
app.post("/api/seed", async (req, res) => {
  try {
    await pool.query(`
      -- Clear existing data
      TRUNCATE customers, advisors, exemptions, exclusions RESTART IDENTITY CASCADE;

      -- 3 Pseudo Customers
      INSERT INTO customers (name, domains) VALUES
        ('בנק לאומי', ARRAY['leumi.co.il', 'bankleumi.co.il', 'leumi.com']),
        ('מגדל ביטוח', ARRAY['migdal.co.il', 'migdal.com']),
        ('שירביט ביטוח', ARRAY['shirbit.co.il', 'shirbit.com']);

      -- Advisors (Nextage employees managing these customers)
      INSERT INTO advisors (email, name) VALUES
        ('mor.mordechay@nextage.co.il', 'מור מרדכי'),
        ('david.cohen@nextage.co.il', 'דוד כהן'),
        ('noa.levi@nextage.co.il', 'נועה לוי');

      -- Exemptions (emails that bypass DLP checks entirely)
      INSERT INTO exemptions (email, reason) VALUES
        ('mor.mordechay@nextage.co.il', 'מנהל מערכת'),
        ('ceo@nextage.co.il', 'מנכל חברה'),
        ('it@nextage.co.il', 'צוות IT פנימי');

      -- Exclusions (file extensions that don't require encryption)
      INSERT INTO exclusions (extension, reason) VALUES
        ('pdf', 'PDF מוגן בנפרד'),
        ('txt', 'קובץ טקסט לא רגיש'),
        ('png', 'תמונה לא רגישה'),
        ('jpg', 'תמונה לא רגישה');
    `);
    res.json({ ok: true, message: "Database seeded with 3 pseudo-customers!" });
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
