require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// Initialize database table
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      unique_query_id VARCHAR(255) UNIQUE NOT NULL,
      query_type VARCHAR(50),
      query_time TIMESTAMP,
      sender_name VARCHAR(255),
      sender_mobile VARCHAR(50),
      sender_email VARCHAR(255),
      sender_company VARCHAR(255),
      sender_address TEXT,
      sender_city VARCHAR(100),
      sender_state VARCHAR(100),
      sender_country_iso VARCHAR(10),
      query_product_name VARCHAR(500),
      query_message TEXT,
      call_duration VARCHAR(50),
      raw_data JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log("Database initialized");
}

// Webhook endpoint — IndiaMART Push API sends leads here
app.post("/webhook/indiamart", async (req, res) => {
  try {
    const lead = req.body;

    // IndiaMART may send data as a single object or wrapped in an array
    const leads = Array.isArray(lead) ? lead : [lead];

    let inserted = 0;
    for (const l of leads) {
      const result = await pool.query(
        `INSERT INTO leads (
          unique_query_id, query_type, query_time, sender_name,
          sender_mobile, sender_email, sender_company, sender_address,
          sender_city, sender_state, sender_country_iso,
          query_product_name, query_message, call_duration, raw_data
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT (unique_query_id) DO NOTHING
        RETURNING id`,
        [
          l.UNIQUE_QUERY_ID,
          l.QUERY_TYPE,
          l.QUERY_TIME || null,
          l.SENDER_NAME,
          l.SENDER_MOBILE,
          l.SENDER_EMAIL,
          l.SENDER_COMPANY,
          l.SENDER_ADDRESS,
          l.SENDER_CITY,
          l.SENDER_STATE,
          l.SENDER_COUNTRY_ISO,
          l.QUERY_PRODUCT_NAME,
          l.QUERY_MESSAGE,
          l.CALL_DURATION,
          JSON.stringify(l),
        ]
      );
      if (result.rowCount > 0) inserted++;
    }

    console.log(`Received ${leads.length} lead(s), inserted ${inserted}`);
    res.status(200).json({ status: "ok", received: leads.length, inserted });
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.status(500).json({ status: "error", message: err.message });
  }
});

// JSON API — for future integrations (WhatsApp, CRM, etc.)
app.get("/api/leads", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM leads ORDER BY created_at DESC LIMIT 100"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dashboard — simple HTML page to view leads
app.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM leads ORDER BY created_at DESC LIMIT 50"
    );

    const tableRows = rows
      .map(
        (r) => `
      <tr>
        <td>${r.unique_query_id}</td>
        <td>${r.sender_name || ""}</td>
        <td>${r.sender_mobile || ""}</td>
        <td>${r.sender_email || ""}</td>
        <td>${r.sender_company || ""}</td>
        <td>${r.sender_city || ""}</td>
        <td>${r.query_product_name || ""}</td>
        <td>${(r.query_message || "").substring(0, 80)}</td>
        <td>${r.query_time || ""}</td>
      </tr>`
      )
      .join("");

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>IndiaMART Leads Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; padding: 20px; }
    h1 { margin-bottom: 20px; color: #333; }
    .stats { margin-bottom: 20px; color: #666; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #eee; font-size: 14px; }
    th { background: #2563eb; color: white; font-weight: 600; }
    tr:hover { background: #f8fafc; }
    .empty { text-align: center; padding: 40px; color: #999; }
  </style>
</head>
<body>
  <h1>IndiaMART Leads</h1>
  <p class="stats">Showing ${rows.length} most recent leads</p>
  <table>
    <thead>
      <tr>
        <th>Query ID</th><th>Name</th><th>Mobile</th><th>Email</th>
        <th>Company</th><th>City</th><th>Product</th><th>Message</th><th>Time</th>
      </tr>
    </thead>
    <tbody>
      ${tableRows || '<tr><td colspan="9" class="empty">No leads yet. Waiting for IndiaMART to push data...</td></tr>'}
    </tbody>
  </table>
</body>
</html>`);
  } catch (err) {
    res.status(500).send("Error loading dashboard: " + err.message);
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

const PORT = process.env.PORT || 3000;

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Dashboard: http://localhost:${PORT}`);
      console.log(`Webhook URL: http://localhost:${PORT}/webhook/indiamart`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
