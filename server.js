const express = require("express");
const path = require("path");
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "dist")));

// CORS headers for Office add-in
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Config endpoint — returns DLP rules from PostgreSQL (hardcoded for now)
app.get("/api/config", (req, res) => {
  res.json({
    customers: [],
    advisors: [],
    exemptions: [],
    exclusions: []
  });
});

// Audit endpoint
app.post("/api/audit", (req, res) => {
  console.log("[Audit]", req.body);
  res.json({ ok: true });
});

// Serve taskpane for all other routes
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "taskpane.html"));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
