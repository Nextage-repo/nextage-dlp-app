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
        domains TEXT[] NOT NULL DEFAULT '{}'
      );
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
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
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
      INSERT INTO customers (name, domains) VALUES
        ('Leumi Bank', ARRAY['leumi.co.il', 'bankleumi.co.il']),
        ('Hapoalim Bank', ARRAY['bankhapoalim.co.il']),
        ('Example Corp', ARRAY['example.com'])
      ON CONFLICT DO NOTHING;

      INSERT INTO advisors (email, name) VALUES
        ('mor.mordechay@nextage.co.il', 'מור מרדכי')
      ON CONFLICT DO NOTHING;

      INSERT INTO exemptions (email, reason) VALUES
        ('mor.mordechay@nextage.co.il', 'מנהל מערכת')
      ON CONFLICT DO NOTHING;

      INSERT INTO exclusions (extension, reason) VALUES
        ('pdf', 'PDF מוגן בעצמו'),
        ('txt', 'קובץ טקסט לא רגיש')
      ON CONFLICT DO NOTHING;
    `);
    res.json({ ok: true, message: "Database seeded successfully!" });
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
