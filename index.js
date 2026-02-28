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
    "whatsapp_status VARCHAR(20)",
    "whatsapp_message TEXT",
    "whatsapp_sent_at TIMESTAMP",
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

// Product catalog — keyword-to-URL mapping for auto-reply
const CATALOG_BASE = "https://sale91.com/catalog/p";
const PRODUCT_CATALOG = [
  { keywords: ["oversize 210", "210gsm oversize", "210 gsm oversize"], url: `${CATALOG_BASE}/oversize-210gsm/`, name: "Oversize 210gsm" },
  { keywords: ["oversize 240", "240gsm oversize", "240 gsm oversize"], url: `${CATALOG_BASE}/oversize-240gsm/`, name: "Oversize 240gsm" },
  { keywords: ["oversize 180", "180gsm oversize", "180 gsm oversize"], url: `${CATALOG_BASE}/oversize-180gsm/`, name: "Oversize 180gsm" },
  { keywords: ["boxy", "boxy fit"], url: `${CATALOG_BASE}/boxy-fit/`, name: "Boxy Fit" },
  { keywords: ["acid wash", "acidwash"], url: `${CATALOG_BASE}/acidwash-oversize/`, name: "AcidWash Oversize" },
  { keywords: ["true biowash", "true bio wash"], url: `${CATALOG_BASE}/true-biowash-round-neck/`, name: "True Biowash Round Neck" },
  { keywords: ["biowash", "bio wash", "biowash round"], url: `${CATALOG_BASE}/biowash-round-neck/`, name: "Biowash Round Neck" },
  { keywords: ["non bio", "non-bio", "nonbio"], url: `${CATALOG_BASE}/non-bio-round-neck/`, name: "Non Bio Round Neck" },
  { keywords: ["sublimation"], url: `${CATALOG_BASE}/sublimation-t-shirt/`, name: "Sublimation T-Shirt" },
  { keywords: ["premium polo"], url: `${CATALOG_BASE}/premium-polo/`, name: "Premium Polo" },
  { keywords: ["cotton polo"], url: `${CATALOG_BASE}/cotton-polo/`, name: "Cotton Polo" },
  { keywords: ["zip hoodie", "zipper hoodie", "zip-hoodie"], url: `${CATALOG_BASE}/zip-hoodie/`, name: "Zip Hoodie" },
  { keywords: ["dropshoulder hoodie", "drop shoulder hoodie", "430gsm hoodie dropshoulder"], url: `${CATALOG_BASE}/dropshoulder-hoodie-430gsm/`, name: "Dropshoulder Hoodie 430gsm" },
  { keywords: ["hoodie 430", "430gsm hoodie"], url: `${CATALOG_BASE}/hoodie-430gsm/`, name: "Hoodie 430gsm" },
  { keywords: ["hoodie 320 black", "hoodie black", "black hoodie"], url: `${CATALOG_BASE}/hoodie-320gsm-black/`, name: "Hoodie 320gsm (Black)" },
  { keywords: ["hoodie 320", "320gsm hoodie"], url: `${CATALOG_BASE}/hoodie-320gsm/`, name: "Hoodie 320gsm" },
  { keywords: ["varsity", "varsity jacket"], url: `${CATALOG_BASE}/varsity-jacket/`, name: "Varsity Jacket" },
  { keywords: ["sweatshirt"], url: `${CATALOG_BASE}/sweatshirt/`, name: "Sweatshirt" },
  { keywords: ["kids", "kids round", "children"], url: `${CATALOG_BASE}/kids-round-neck/`, name: "Kids Round Neck" },
  { keywords: ["shorts", "short"], url: `${CATALOG_BASE}/shorts/`, name: "Shorts" },
  // Generic fallbacks (checked last — match broad terms)
  { keywords: ["oversize", "over size", "oversized"], url: `${CATALOG_BASE}/oversize-210gsm/`, name: "Oversize T-Shirt" },
  { keywords: ["hoodie", "hoody"], url: `${CATALOG_BASE}/hoodie-320gsm/`, name: "Hoodie" },
  { keywords: ["polo"], url: `${CATALOG_BASE}/premium-polo/`, name: "Polo T-Shirt" },
  { keywords: ["round neck", "roundneck", "tshirt", "t-shirt", "t shirt"], url: `${CATALOG_BASE}/biowash-round-neck/`, name: "Round Neck T-Shirt" },
];

// Match lead text to a product catalog URL
function matchProduct(productName, message) {
  const text = `${productName || ""} ${message || ""}`.toLowerCase();
  for (const product of PRODUCT_CATALOG) {
    if (product.keywords.some((kw) => text.includes(kw))) {
      return product;
    }
  }
  return null; // no match — send full catalog
}

// Send WhatsApp message via WhatsApp Business API
function sendWhatsApp(phone, messageText) {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneId || !token) return Promise.resolve(null);

  // Clean phone number: remove +, -, spaces
  const cleanPhone = phone.replace(/[\s+\-()]/g, "");

  const body = JSON.stringify({
    messaging_product: "whatsapp",
    to: cleanPhone,
    type: "text",
    text: { body: messageText },
  });

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "graph.facebook.com",
        path: `/v21.0/${phoneId}/messages`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
      (resp) => {
        let data = "";
        resp.on("data", (chunk) => (data += chunk));
        resp.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json.error) {
              console.error(`[WhatsApp] Failed for ${cleanPhone}: ${json.error.message}`);
              resolve({ status: "failed", error: json.error.message });
            } else {
              console.log(`[WhatsApp] Sent to ${cleanPhone}: OK`);
              resolve({ status: "sent" });
            }
          } catch (e) {
            console.error("[WhatsApp] Parse error:", e.message);
            resolve({ status: "failed", error: e.message });
          }
        });
      }
    );
    req.on("error", (err) => {
      console.error("[WhatsApp] Request error:", err.message);
      resolve({ status: "failed", error: err.message });
    });
    req.write(body);
    req.end();
  });
}

// Auto-reply to a lead via WhatsApp with matching catalog link
async function autoReplyToLead(lead) {
  if (!process.env.WHATSAPP_PHONE_NUMBER_ID) return;

  const phone = lead.SENDER_MOBILE;
  if (!phone) return;

  const match = matchProduct(lead.QUERY_PRODUCT_NAME, lead.QUERY_MESSAGE);
  const buyerName = lead.SENDER_NAME || "there";

  let msg;
  if (!match) {
    console.log(`[WhatsApp] No product match for: "${lead.QUERY_PRODUCT_NAME}" / "${lead.QUERY_MESSAGE}" — sending generic catalog link`);
    msg = `You enquired for *${lead.QUERY_PRODUCT_NAME || "our products"}*, check our full catalog - https://sale91.com/catalog\n\nAsk if any question.`;
  } else {
    msg = `You enquired for *${match.name}*, check price and photos - ${match.url}\n\nAsk if any question.`;
  }

  const result = await sendWhatsApp(phone, msg);
  const waStatus = result ? result.status : "failed";

  // Save WhatsApp delivery status, message text, and sent time in DB
  try {
    await pool.query(
      "UPDATE leads SET whatsapp_status = $1, whatsapp_message = $2, whatsapp_sent_at = $3 WHERE unique_query_id = $4",
      [waStatus, msg, new Date().toISOString(), lead.UNIQUE_QUERY_ID]
    );
  } catch (e) {
    console.error("[WhatsApp] Failed to update status in DB:", e.message);
  }
}

// Store last webhook payloads for debugging (keep last 10)
const debugLog = [];

// Normalize IndiaMART field names — Push API uses different names than Pull API
function normalizeLeadFields(lead) {
  const normalized = { ...lead };

  // SENDER_PHONE → SENDER_MOBILE (Push API uses SENDER_PHONE)
  if (!normalized.SENDER_MOBILE && normalized.SENDER_PHONE) {
    normalized.SENDER_MOBILE = normalized.SENDER_PHONE;
  }
  // SENDER_MOBILE_WAPP — some versions send this
  if (!normalized.SENDER_MOBILE && normalized.SENDER_MOBILE_WAPP) {
    normalized.SENDER_MOBILE = normalized.SENDER_MOBILE_WAPP;
  }
  // SUBJECT → QUERY_PRODUCT_NAME (Push API uses SUBJECT)
  if (!normalized.QUERY_PRODUCT_NAME && normalized.SUBJECT) {
    normalized.QUERY_PRODUCT_NAME = normalized.SUBJECT;
  }
  // SENDER_PHONE_ALT → SENDER_MOBILE_ALT
  if (!normalized.SENDER_MOBILE_ALT && normalized.SENDER_PHONE_ALT) {
    normalized.SENDER_MOBILE_ALT = normalized.SENDER_PHONE_ALT;
  }
  // SENDER_COMPANY_IM → SENDER_COMPANY
  if (!normalized.SENDER_COMPANY && normalized.SENDER_COMPANY_IM) {
    normalized.SENDER_COMPANY = normalized.SENDER_COMPANY_IM;
  }

  return normalized;
}

// Extract leads array from various IndiaMART payload formats
function extractLeads(body) {
  // Format 1: Direct array of leads — [{ UNIQUE_QUERY_ID, ... }, ...]
  if (Array.isArray(body)) {
    return body.map(normalizeLeadFields);
  }

  // Format 2: Wrapped in { CODE, STATUS, RESPONSE } — Push API format
  if (body.CODE !== undefined && body.RESPONSE) {
    const resp = body.RESPONSE;
    // RESPONSE can be a single object or array
    if (Array.isArray(resp)) {
      return resp.map(normalizeLeadFields);
    }
    if (typeof resp === "object" && resp !== null) {
      return [normalizeLeadFields(resp)];
    }
  }

  // Format 3: Single lead object with UNIQUE_QUERY_ID
  if (body.UNIQUE_QUERY_ID) {
    return [normalizeLeadFields(body)];
  }

  // Format 4: Single lead with SENDER_NAME (but no wrapper) — fallback
  if (body.SENDER_NAME || body.SENDER_PHONE || body.SENDER_MOBILE) {
    return [normalizeLeadFields(body)];
  }

  console.error("[Push] Unknown payload format:", JSON.stringify(body).substring(0, 500));
  return [];
}

// Webhook endpoint — IndiaMART Push API sends leads here
app.post("/webhook/indiamart", async (req, res) => {
  const timestamp = new Date().toISOString();
  const rawBody = req.body;

  // Log full incoming data for debugging
  console.log(`[Push] ${timestamp} — Raw payload:`, JSON.stringify(rawBody).substring(0, 1000));

  // Save to debug log (keep last 10)
  debugLog.unshift({ timestamp, payload: rawBody });
  if (debugLog.length > 10) debugLog.pop();

  try {
    const leads = extractLeads(rawBody);

    if (leads.length === 0) {
      console.log(`[Push] ${timestamp} — No valid leads found in payload`);
      return res.status(200).json({ status: "ok", received: 0, inserted: 0, note: "no_valid_leads_in_payload" });
    }

    const inserted = await insertLeads(leads);

    // Auto-reply via WhatsApp for new leads (don't block response)
    if (inserted > 0) {
      for (const l of leads) {
        autoReplyToLead(l).catch((e) => console.error("[WhatsApp] Auto-reply failed:", e.message));
      }
    }

    console.log(`[Push] ${timestamp} — Received ${leads.length} lead(s), inserted ${inserted}`);
    res.status(200).json({ status: "ok", received: leads.length, inserted });
  } catch (err) {
    console.error(`[Push] ${timestamp} — Webhook error:`, err.message, err.stack);
    // Always return 200 — IndiaMART deactivates webhook after 48hrs of non-200 responses
    res.status(200).json({ status: "error_logged", message: "received" });
  }
});

// Debug endpoint — see last 10 webhook payloads
app.get("/debug/last-webhook", (req, res) => {
  res.json({
    total_received: debugLog.length,
    payloads: debugLog,
  });
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

    // Leads where WhatsApp failed — need to call directly
    const { rows: failedRows } = await pool.query(
      "SELECT * FROM leads WHERE whatsapp_status = 'failed' ORDER BY created_at DESC LIMIT 50"
    );

    const failedTableRows = failedRows
      .map(
        (r) => `
      <tr>
        <td>${r.sender_name || ""}</td>
        <td><a href="tel:${r.sender_mobile || ""}" class="call-btn">${r.sender_mobile || ""}</a>${r.sender_mobile_alt ? '<br><a href="tel:' + r.sender_mobile_alt + '" class="call-btn alt">' + r.sender_mobile_alt + "</a>" : ""}</td>
        <td>${r.sender_company || ""}</td>
        <td>${r.sender_city || ""}</td>
        <td>${r.query_product_name || ""}${r.query_mcat_name ? "<br><small>(" + r.query_mcat_name + ")</small>" : ""}</td>
        <td>${(r.query_message || "").substring(0, 80)}</td>
        <td>${r.query_time || ""}</td>
      </tr>`
      )
      .join("");

    const tableRows = rows
      .map(
        (r) => {
          // WhatsApp status badge
          let waBadge = '<span class="wa-badge wa-pending">Pending</span>';
          if (r.whatsapp_status === "sent") {
            waBadge = '<span class="wa-badge wa-sent">Sent</span>';
          } else if (r.whatsapp_status === "failed") {
            waBadge = '<span class="wa-badge wa-failed">Failed</span>';
          }

          // WhatsApp sent time (readable format)
          let waTime = "";
          if (r.whatsapp_sent_at) {
            const d = new Date(r.whatsapp_sent_at);
            waTime = d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true });
          }

          // WhatsApp message preview (truncate)
          const waMsg = r.whatsapp_message ? r.whatsapp_message.replace(/\n/g, " ").substring(0, 60) + (r.whatsapp_message.length > 60 ? "..." : "") : "";

          return `
      <tr>
        <td>${r.unique_query_id}</td>
        <td>${r.sender_name || ""}</td>
        <td>${r.sender_mobile || ""}${r.sender_mobile_alt ? "<br><small>" + r.sender_mobile_alt + "</small>" : ""}</td>
        <td>${r.sender_company || ""}</td>
        <td>${r.sender_city || ""}</td>
        <td>${r.query_product_name || ""}${r.query_mcat_name ? "<br><small>(" + r.query_mcat_name + ")</small>" : ""}</td>
        <td>${(r.query_message || "").substring(0, 80)}</td>
        <td>${r.query_time || ""}</td>
        <td>${waBadge}${waTime ? "<br><small>" + waTime + "</small>" : ""}${waMsg ? '<br><small class="wa-msg">' + waMsg + "</small>" : ""}</td>
      </tr>`;
        }
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
    .call-btn { display: inline-block; padding: 4px 10px; background: #16a34a; color: white; text-decoration: none; border-radius: 4px; font-weight: 600; }
    .call-btn.alt { background: #6b7280; }
    .call-btn:hover { opacity: 0.85; }
    .failed-section { margin-bottom: 30px; }
    .failed-section h2 { color: #dc2626; margin-bottom: 10px; }
    .failed-section table th { background: #dc2626; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; color: white; background: #dc2626; margin-left: 8px; }
    .wa-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; color: white; }
    .wa-sent { background: #16a34a; }
    .wa-failed { background: #dc2626; }
    .wa-pending { background: #9ca3af; }
    .wa-msg { color: #6b7280; font-style: italic; }
  </style>
</head>
<body>
  <h1>IndiaMART Leads</h1>

  ${failedRows.length > 0 ? `
  <div class="failed-section">
    <h2>WhatsApp Failed — Call Karo <span class="badge">${failedRows.length}</span></h2>
    <p class="stats">In logon ka WhatsApp nahi hai, directly call karo</p>
    <table>
      <thead>
        <tr>
          <th>Name</th><th>Phone (Tap to Call)</th><th>Company</th>
          <th>City</th><th>Product</th><th>Message</th><th>Time</th>
        </tr>
      </thead>
      <tbody>
        ${failedTableRows}
      </tbody>
    </table>
  </div>
  ` : ""}

  <p class="stats">Showing ${rows.length} most recent leads</p>
  <table>
    <thead>
      <tr>
        <th>Query ID</th><th>Name</th><th>Mobile</th>
        <th>Company</th><th>City</th><th>Product</th><th>Message</th><th>Time</th><th>WhatsApp</th>
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
