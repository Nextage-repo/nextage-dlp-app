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

// Config endpoint — dummy data for testing
app.get("/api/config", (req, res) => {
  res.json({
    customers: [
      { id: "1", name: "לקוח בדיקה", domains: ["test.com", "gmail.com"] },
      { id: "2", name: "חברת דוגמה", domains: ["example.com"] }
    ],
    advisors: [
      { id: "1", email: "mor.mordechay@nextage.co.il", name: "מור מרדכי" }
    ],
    exemptions: [
      { id: "1", email: "mor.mordechay@nextage.co.il", reason: "מנהל מערכת" }
    ],
    exclusions: [
      { id: "1", extension: "pdf", reason: "PDF לא דורש הצפנה" }
    ]
  });
});

// Audit endpoint
app.post("/api/audit", (req, res) => {
  console.log("[Audit]", req.body);
  res.json({ ok: true });
});

// Serve taskpane for all other routes
app.use((req, res) => {
  res.sendFile(path.join(__dirname, "dist", "taskpane.html"));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
