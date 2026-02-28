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
    "whatsapp_error TEXT",
    "whatsapp_wamid VARCHAR(255)",
  ];
  for (const col of newColumns) {
    await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS ${col}`);
  }

  // Fix existing records with invalid phone numbers — mark them as "failed"
  // This catches leads that were inserted before phone validation was added
  await pool.query(`
    UPDATE leads
    SET whatsapp_status = 'failed',
        whatsapp_error = 'Invalid number: ' || COALESCE(sender_mobile, 'none')
    WHERE whatsapp_status = 'sent'
    AND (
      sender_mobile IS NULL
      OR sender_mobile !~ '^(91)?[6-9][0-9]{9}$'
      OR sender_mobile ~ '^(91)?(\\d)\\2{9}$'
    )
  `);

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

// Validate Indian mobile number — must be 10 digits starting with 6-9
function isValidIndianMobile(phone) {
  if (!phone) return false;
  const cleaned = phone.replace(/[\s+\-()]/g, "");
  // Remove country code 91 if present
  const digits = cleaned.startsWith("91") && cleaned.length > 10 ? cleaned.substring(2) : cleaned;
  // Indian mobile: 10 digits, starts with 6-9, not all same digit
  if (!/^[6-9]\d{9}$/.test(digits)) return false;
  // Reject obviously fake numbers (all same digit like 9999999999)
  if (/^(\d)\1{9}$/.test(digits)) return false;
  return true;
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
              const wamid = json.messages && json.messages[0] ? json.messages[0].id : null;
              console.log(`[WhatsApp] Sent to ${cleanPhone}: OK (wamid: ${wamid})`);
              resolve({ status: "sent", wamid });
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
  if (!phone) {
    console.log(`[WhatsApp] No phone number for lead ${lead.UNIQUE_QUERY_ID}`);
    try {
      await pool.query(
        "UPDATE leads SET whatsapp_status = $1, whatsapp_error = $2 WHERE unique_query_id = $3",
        ["failed", "No phone number", lead.UNIQUE_QUERY_ID]
      );
    } catch (e) { /* ignore */ }
    return;
  }

  // Validate phone number before sending
  if (!isValidIndianMobile(phone)) {
    console.log(`[WhatsApp] Invalid phone number: ${phone} — skipping`);
    try {
      await pool.query(
        "UPDATE leads SET whatsapp_status = $1, whatsapp_error = $2 WHERE unique_query_id = $3",
        ["failed", "Invalid number: " + phone, lead.UNIQUE_QUERY_ID]
      );
    } catch (e) { /* ignore */ }
    return;
  }

  const match = matchProduct(lead.QUERY_PRODUCT_NAME, lead.QUERY_MESSAGE);

  let msg;
  if (!match) {
    console.log(`[WhatsApp] No product match for: "${lead.QUERY_PRODUCT_NAME}" / "${lead.QUERY_MESSAGE}" — sending generic catalog link`);
    msg = `You enquired for *${lead.QUERY_PRODUCT_NAME || "our products"}*, check our full catalog - https://sale91.com/catalog\n\nAsk if any question.`;
  } else {
    msg = `You enquired for *${match.name}*, check price and photos - ${match.url}\n\nAsk if any question.`;
  }

  const result = await sendWhatsApp(phone, msg);
  const waStatus = result ? result.status : "failed";
  const waError = result && result.error ? result.error : null;
  const waWamid = result && result.wamid ? result.wamid : null;

  // Save WhatsApp delivery status, message text, sent time, wamid, and error in DB
  try {
    await pool.query(
      "UPDATE leads SET whatsapp_status = $1, whatsapp_message = $2, whatsapp_sent_at = $3, whatsapp_error = $4, whatsapp_wamid = $5 WHERE unique_query_id = $6",
      [waStatus, msg, waStatus === "sent" ? new Date().toISOString() : null, waError, waWamid, lead.UNIQUE_QUERY_ID]
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

// WhatsApp Webhook — verification (GET) for Meta setup
app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || "indiamart-leads-verify";

  if (mode === "subscribe" && token === verifyToken) {
    console.log("[WA Webhook] Verified successfully");
    return res.status(200).send(challenge);
  }
  console.error("[WA Webhook] Verification failed");
  res.sendStatus(403);
});

// WhatsApp Webhook — receive status updates (POST) from Meta
app.post("/webhook/whatsapp", async (req, res) => {
  // Always return 200 quickly
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!body.entry) return;

    for (const entry of body.entry) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value || {};

        // Status updates (sent → delivered → read → failed)
        const statuses = value.statuses || [];
        for (const s of statuses) {
          const wamid = s.id;
          const status = s.status; // sent, delivered, read, failed
          const recipientPhone = s.recipient_id;
          const timestamp = s.timestamp ? new Date(parseInt(s.timestamp) * 1000).toISOString() : new Date().toISOString();

          console.log(`[WA Webhook] Status: ${status} for ${recipientPhone} (wamid: ${wamid})`);

          // Update lead status by wamid — only upgrade status (don't downgrade read→delivered)
          const statusOrder = { sent: 1, delivered: 2, read: 3, failed: 0 };
          const newStatus = status;

          try {
            // Only update if new status is higher priority (or it's a failure)
            if (status === "failed") {
              const errorInfo = s.errors && s.errors[0] ? s.errors[0].title : "Unknown error";
              await pool.query(
                "UPDATE leads SET whatsapp_status = $1, whatsapp_error = $2 WHERE whatsapp_wamid = $3",
                ["failed", errorInfo, wamid]
              );
            } else {
              // Upgrade: sent → delivered → read
              const result = await pool.query(
                `UPDATE leads SET whatsapp_status = $1
                 WHERE whatsapp_wamid = $2
                 AND (
                   whatsapp_status IS NULL
                   OR whatsapp_status = 'sent'
                   OR ($1 = 'read' AND whatsapp_status = 'delivered')
                 )`,
                [newStatus, wamid]
              );
              if (result.rowCount > 0) {
                console.log(`[WA Webhook] Updated lead status to '${status}' for wamid ${wamid}`);
              }
            }
          } catch (e) {
            console.error("[WA Webhook] DB update error:", e.message);
          }
        }

        // Incoming messages from buyers (optional — log them)
        const messages = value.messages || [];
        for (const m of messages) {
          const from = m.from;
          const text = m.text ? m.text.body : "(media/other)";
          console.log(`[WA Webhook] Incoming from ${from}: ${text}`);
        }
      }
    }
  } catch (err) {
    console.error("[WA Webhook] Error:", err.message);
  }
});

// Date formatter for IndiaMART API — DD-MON-YYYY format (no encoding issues)
// e.g. "28-FEB-2026" — IndiaMART's recommended format 1
function fmtIST(d) {
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const ist = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
  return String(ist.getUTCDate()).padStart(2, "0") + "-" +
    months[ist.getUTCMonth()] + "-" +
    ist.getUTCFullYear();
}

// IndiaMART Pull API — fetch leads for a given time window
function fetchLeadsFromAPI(startTime, endTime) {
  const crmKey = process.env.INDIAMART_CRM_KEY;
  if (!crmKey) return Promise.resolve({ fetched: 0, inserted: 0, error: "INDIAMART_CRM_KEY not set in environment" });

  const start = startTime || new Date(Date.now() - 2 * 60 * 60 * 1000);
  const end = endTime || new Date();

  // Use DD-MON-YYYY format — no URL encoding issues (no spaces/colons)
  const url = `https://mapi.indiamart.com/wservce/crm/crmListing/v2/?glusr_crm_key=${crmKey}&start_time=${fmtIST(start)}&end_time=${fmtIST(end)}`;
  console.log(`[Pull] Fetching leads: ${fmtIST(start)} → ${fmtIST(end)}`);
  console.log(`[Pull] URL: ${url.replace(crmKey, "***")}`);

  return new Promise((resolve) => {
    https.get(url, (resp) => {
      let data = "";
      resp.on("data", (chunk) => (data += chunk));
      resp.on("end", async () => {
        try {
          const json = JSON.parse(data);
          console.log(`[Pull] Response CODE=${json.CODE}, STATUS=${json.STATUS}`);

          let leads = [];
          if (Array.isArray(json)) {
            leads = json.map(normalizeLeadFields);
          } else if (json.RESPONSE && Array.isArray(json.RESPONSE)) {
            leads = json.RESPONSE.map(normalizeLeadFields);
          } else if (json.CODE === 200 && json.STATUS === "SUCCESS") {
            // Single lead in RESPONSE (like Push API format)
            if (json.RESPONSE && typeof json.RESPONSE === "object") {
              leads = [normalizeLeadFields(json.RESPONSE)];
            } else {
              console.log("[Pull] No new leads found");
              return resolve({ fetched: 0, inserted: 0 });
            }
          } else {
            const detail = JSON.stringify(json).substring(0, 500);
            console.error("[Pull] Unexpected response:", detail);
            return resolve({ fetched: 0, inserted: 0, error: `API error: CODE=${json.CODE}, STATUS=${json.STATUS}, MSG=${json.MESSAGE || json.message || detail.substring(0, 200)}` });
          }

          if (leads.length === 0) {
            console.log("[Pull] No new leads found");
            return resolve({ fetched: 0, inserted: 0 });
          }

          const inserted = await insertLeads(leads);

          // Auto-reply via WhatsApp for newly inserted leads
          if (inserted > 0) {
            for (const l of leads) {
              autoReplyToLead(l).catch((e) => console.error("[WhatsApp] Auto-reply failed:", e.message));
            }
          }

          console.log(`[Pull] Fetched ${leads.length} lead(s), inserted ${inserted}`);
          resolve({ fetched: leads.length, inserted });
        } catch (err) {
          console.error("[Pull] Parse error:", err.message, "| Raw:", data.substring(0, 300));
          resolve({ fetched: 0, inserted: 0, error: `Parse error: ${err.message} | Raw: ${data.substring(0, 200)}` });
        }
      });
    }).on("error", (err) => {
      console.error("[Pull] Request error:", err.message);
      resolve({ fetched: 0, inserted: 0, error: `Request error: ${err.message}` });
    });
  });
}

// Fetch leads for multiple days by splitting into day-sized chunks
// IndiaMART API works best with smaller time windows
async function fetchLeadsForDays(days) {
  const now = new Date();
  let totalFetched = 0;
  let totalInserted = 0;
  const results = [];

  for (let i = days; i > 0; i--) {
    const dayStart = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const dayEnd = new Date(now.getTime() - (i - 1) * 24 * 60 * 60 * 1000);
    // Last chunk should end at current time
    if (i === 1) dayEnd.setTime(now.getTime());

    console.log(`[Pull] Fetching day ${days - i + 1}/${days}: ${fmtIST(dayStart)} → ${fmtIST(dayEnd)}`);
    const result = await fetchLeadsFromAPI(dayStart, dayEnd);
    totalFetched += result.fetched || 0;
    totalInserted += result.inserted || 0;
    results.push({ day: fmtIST(dayStart).split(" ")[0], ...result });
  }

  return { totalFetched, totalInserted, days: results };
}

// Manual trigger to fetch leads via Pull API
// Usage: /api/fetch-leads?days=2 (default: fetch last 2 hours)
app.get("/api/fetch-leads", async (req, res) => {
  if (!process.env.INDIAMART_CRM_KEY) {
    return res.status(400).json({ error: "INDIAMART_CRM_KEY not configured. Set INDIAMART_CRM_KEY environment variable." });
  }
  try {
    const days = parseInt(req.query.days) || 0;
    let result;
    if (days > 0) {
      // Cap at 7 days (IndiaMART API limit)
      const cappedDays = Math.min(days, 7);
      console.log(`[Pull] Manual fetch triggered: last ${cappedDays} days`);
      result = await fetchLeadsForDays(cappedDays);
    } else {
      console.log("[Pull] Manual fetch triggered: last 2 hours");
      result = await fetchLeadsFromAPI();
    }
    res.json({ status: "ok", result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug: Test IndiaMART API raw response
app.get("/debug/test-pull-api", (req, res) => {
  const crmKey = process.env.INDIAMART_CRM_KEY;
  if (!crmKey) return res.status(400).json({ error: "INDIAMART_CRM_KEY not set" });

  const now = new Date();
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

  const url = `https://mapi.indiamart.com/wservce/crm/crmListing/v2/?glusr_crm_key=${crmKey}&start_time=${fmtIST(twoHoursAgo)}&end_time=${fmtIST(now)}`;

  https.get(url, (resp) => {
    let data = "";
    resp.on("data", (chunk) => (data += chunk));
    resp.on("end", () => {
      res.json({
        url: url.replace(crmKey, "***"),
        http_status: resp.statusCode,
        raw_response: data.substring(0, 2000),
      });
    });
  }).on("error", (err) => {
    res.json({ error: err.message });
  });
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

// Format any date/timestamp to IST for display on dashboard
function toIST(dateVal) {
  if (!dateVal) return "";
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return String(dateVal);
  return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });
}

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
        <td>${toIST(r.query_time)}</td>
      </tr>`
      )
      .join("");

    const tableRows = rows
      .map(
        (r) => {
          // WhatsApp status badge with details
          let waBadge = "";
          let waDetails = "";

          if (r.whatsapp_status === "read") {
            waBadge = '<span class="wa-badge wa-read">Read</span>';
            if (r.whatsapp_sent_at) waDetails = `<br><small>${toIST(r.whatsapp_sent_at)}</small>`;
          } else if (r.whatsapp_status === "delivered") {
            waBadge = '<span class="wa-badge wa-delivered">Delivered</span>';
            if (r.whatsapp_sent_at) waDetails = `<br><small>${toIST(r.whatsapp_sent_at)}</small>`;
          } else if (r.whatsapp_status === "sent") {
            waBadge = '<span class="wa-badge wa-sent">Sent</span>';
            if (r.whatsapp_sent_at) waDetails = `<br><small>${toIST(r.whatsapp_sent_at)}</small>`;
          } else if (r.whatsapp_status === "failed") {
            waBadge = '<span class="wa-badge wa-failed">Failed</span>';
            if (r.whatsapp_error) {
              waDetails = `<br><small class="wa-error">${r.whatsapp_error}</small>`;
            }
          } else {
            waBadge = '<span class="wa-badge wa-pending">—</span>';
          }

          // WhatsApp link — opens native WhatsApp app with pre-filled message
          let waLink = "";
          if (r.sender_mobile) {
            const cleanNum = (r.sender_mobile || "").replace(/[\s+\-()]/g, "");
            const waNum = cleanNum.startsWith("91") ? cleanNum : "91" + cleanNum;
            const waText = r.whatsapp_message || ("You enquired for *" + (r.query_product_name || "our products") + "*, check our full catalog - https://sale91.com/catalog\n\nAsk if any question.");
            const encoded = encodeURIComponent(waText);
            waLink = '<br><a href="https://api.whatsapp.com/send?phone=' + waNum + '&text=' + encoded + '" target="_blank" class="wa-web-btn">Chat on WhatsApp</a>';
          }

          return `
      <tr>
        <td>${r.unique_query_id}</td>
        <td>${r.sender_name || ""}</td>
        <td>${r.sender_mobile || ""}${r.sender_mobile_alt ? "<br><small>" + r.sender_mobile_alt + "</small>" : ""}</td>
        <td>${r.sender_company || ""}</td>
        <td>${r.sender_city || ""}</td>
        <td>${r.query_product_name || ""}${r.query_mcat_name ? "<br><small>(" + r.query_mcat_name + ")</small>" : ""}</td>
        <td>${(r.query_message || "").substring(0, 80)}</td>
        <td>${toIST(r.query_time)}</td>
        <td>${waBadge}${waDetails}${waLink}</td>
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
    .wa-sent { background: #f59e0b; }
    .wa-delivered { background: #16a34a; }
    .wa-read { background: #2563eb; }
    .wa-failed { background: #dc2626; }
    .wa-pending { background: #9ca3af; }
    .wa-msg { color: #6b7280; font-style: italic; }
    .wa-error { color: #dc2626; font-size: 11px; }
    .wa-web-btn { display: inline-block; margin-top: 4px; padding: 3px 10px; background: #25D366; color: white; text-decoration: none; border-radius: 4px; font-size: 12px; font-weight: 600; }
    .wa-web-btn:hover { background: #1da851; }
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
