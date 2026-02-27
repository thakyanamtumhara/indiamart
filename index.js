require("dotenv").config();
const express = require("express");
const https = require("https");
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

  // Add columns for additional IndiaMART fields (safe to run repeatedly)
  const newColumns = [
    "sender_mobile_alt VARCHAR(50)",
    "sender_email_alt VARCHAR(255)",
    "sender_pincode VARCHAR(20)",
    "query_mcat_name VARCHAR(500)",
    "receiver_mobile VARCHAR(50)",
    "receiver_catalog VARCHAR(255)",
  ];
  for (const col of newColumns) {
    await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS ${col}`);
  }

  console.log("Database initialized");
}

// Shared function to insert leads into database (used by both Push and Pull)
async function insertLeads(leads) {
  let inserted = 0;
  for (const l of leads) {
    const result = await pool.query(
      `INSERT INTO leads (
        unique_query_id, query_type, query_time, sender_name,
        sender_mobile, sender_email, sender_company, sender_address,
        sender_city, sender_state, sender_country_iso,
        query_product_name, query_message, call_duration,
        sender_mobile_alt, sender_email_alt, sender_pincode,
        query_mcat_name, receiver_mobile, receiver_catalog,
        raw_data
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
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
        l.SENDER_MOBILE_ALT || null,
        l.SENDER_EMAIL_ALT || null,
        l.SENDER_PINCODE || null,
        l.QUERY_MCAT_NAME || null,
        l.RECEIVER_MOBILE || null,
        l.RECEIVER_CATALOG || null,
        JSON.stringify(l),
      ]
    );
    if (result.rowCount > 0) inserted++;
  }
  return inserted;
}

// Webhook endpoint — IndiaMART Push API sends leads here
app.post("/webhook/indiamart", async (req, res) => {
  try {
    const lead = req.body;
    const leads = Array.isArray(lead) ? lead : [lead];
    const inserted = await insertLeads(leads);

    console.log(`[Push] Received ${leads.length} lead(s), inserted ${inserted}`);
    res.status(200).json({ status: "ok", received: leads.length, inserted });
  } catch (err) {
    console.error("[Push] Webhook error:", err.message);
    // Always return 200 — IndiaMART deactivates webhook after 48hrs of non-200 responses
    res.status(200).json({ status: "error_logged", message: "received" });
  }
});

// IndiaMART Pull API — fetch leads periodically as backup
function fetchLeadsFromAPI() {
  const crmKey = process.env.INDIAMART_CRM_KEY;
  if (!crmKey) return Promise.resolve(null);

  const now = new Date();
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const fmt = (d) =>
    d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0") + " " +
    String(d.getHours()).padStart(2, "0") + ":" +
    String(d.getMinutes()).padStart(2, "0") + ":" +
    String(d.getSeconds()).padStart(2, "0");

  const params = new URLSearchParams({
    glusr_crm_key: crmKey,
    start_time: fmt(twoHoursAgo),
    end_time: fmt(now),
  });

  const url = `https://mapi.indiamart.com/wservce/enquiry/listing/?${params}`;

  return new Promise((resolve) => {
    https.get(url, (resp) => {
      let data = "";
      resp.on("data", (chunk) => (data += chunk));
      resp.on("end", async () => {
        try {
          const json = JSON.parse(data);

          // IndiaMART returns { STATUS: "SUCCESS", RESPONSE: [...leads...] }
          // or { STATUS: "SUCCESS", CODE: 200, ... } with leads in top-level array
          let leads = [];
          if (Array.isArray(json)) {
            leads = json;
          } else if (json.RESPONSE && Array.isArray(json.RESPONSE)) {
            leads = json.RESPONSE;
          } else if (json.CODE === 200 && json.STATUS === "SUCCESS") {
            // No new leads
            console.log("[Pull] No new leads found");
            return resolve({ fetched: 0, inserted: 0 });
          } else {
            console.error("[Pull] Unexpected response:", JSON.stringify(json).substring(0, 200));
            return resolve(null);
          }

          if (leads.length === 0) {
            console.log("[Pull] No new leads found");
            return resolve({ fetched: 0, inserted: 0 });
          }

          const inserted = await insertLeads(leads);
          console.log(`[Pull] Fetched ${leads.length} lead(s), inserted ${inserted}`);
          resolve({ fetched: leads.length, inserted });
        } catch (err) {
          console.error("[Pull] Parse error:", err.message);
          resolve(null);
        }
      });
    }).on("error", (err) => {
      console.error("[Pull] Request error:", err.message);
      resolve(null);
    });
  });
}

// Manual trigger to fetch leads via Pull API
app.get("/api/fetch-leads", async (req, res) => {
  if (!process.env.INDIAMART_CRM_KEY) {
    return res.status(400).json({ error: "INDIAMART_CRM_KEY not configured" });
  }
  try {
    const result = await fetchLeadsFromAPI();
    res.json({ status: "ok", result });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
        <td>${r.sender_mobile || ""}${r.sender_mobile_alt ? "<br><small>" + r.sender_mobile_alt + "</small>" : ""}</td>
        <td>${r.sender_email || ""}</td>
        <td>${r.sender_company || ""}</td>
        <td>${r.sender_city || ""}</td>
        <td>${r.query_product_name || ""}${r.query_mcat_name ? "<br><small>(" + r.query_mcat_name + ")</small>" : ""}</td>
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

      // Start Pull API polling if CRM key is configured
      if (process.env.INDIAMART_CRM_KEY) {
        const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes
        console.log("IndiaMART Pull API polling started (every 5 minutes)");
        fetchLeadsFromAPI(); // fetch once immediately on startup
        setInterval(fetchLeadsFromAPI, POLL_INTERVAL);
      } else {
        console.log("Pull API disabled (set INDIAMART_CRM_KEY to enable)");
      }
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
