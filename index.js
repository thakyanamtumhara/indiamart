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

// In-memory cache for templates and product keywords (loaded from DB)
let cachedTemplates = {};
let cachedProducts = [];

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

  // Message templates table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_templates (
      id SERIAL PRIMARY KEY,
      template_key VARCHAR(50) UNIQUE NOT NULL,
      template_text TEXT NOT NULL,
      description VARCHAR(255),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Product keywords table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_keywords (
      id SERIAL PRIMARY KEY,
      product_name VARCHAR(255) NOT NULL,
      url_slug VARCHAR(255) NOT NULL,
      keywords TEXT[] NOT NULL DEFAULT '{}',
      sort_order INT DEFAULT 100,
      is_fallback BOOLEAN DEFAULT false,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Seed default templates if table is empty
  const tmplCount = await pool.query("SELECT COUNT(*) FROM message_templates");
  if (parseInt(tmplCount.rows[0].count) === 0) {
    await pool.query(
      `INSERT INTO message_templates (template_key, template_text, description) VALUES
        ('product_reply', E'You enquired for *{product_name}*, check price and photos - {url}\\n\\nAsk if any question.', 'Sent when a product keyword matches'),
        ('generic_reply', E'You enquired for *{product_name}*, check our full catalog - https://sale91.com/catalog\\n\\nAsk if any question.', 'Sent when no product matches')
      `
    );
    console.log("[Init] Seeded default message templates");
  }

  // Seed default product keywords if table is empty
  const kwCount = await pool.query("SELECT COUNT(*) FROM product_keywords");
  if (parseInt(kwCount.rows[0].count) === 0) {
    const defaultProducts = [
      ["Oversize 210gsm", "oversize-210gsm", ["oversize 210","210gsm oversize","210 gsm oversize"], 1, false],
      ["Oversize 240gsm", "oversize-240gsm", ["oversize 240","240gsm oversize","240 gsm oversize"], 2, false],
      ["Oversize 180gsm", "oversize-180gsm", ["oversize 180","180gsm oversize","180 gsm oversize"], 3, false],
      ["Boxy Fit", "boxy-fit", ["boxy","boxy fit"], 4, false],
      ["AcidWash Oversize", "acidwash-oversize", ["acid wash","acidwash"], 5, false],
      ["True Biowash Round Neck", "true-biowash-round-neck", ["true biowash","true bio wash"], 6, false],
      ["Biowash Round Neck", "biowash-round-neck", ["biowash","bio wash","biowash round"], 7, false],
      ["Non Bio Round Neck", "non-bio-round-neck", ["non bio","non-bio","nonbio"], 8, false],
      ["Sublimation T-Shirt", "sublimation-t-shirt", ["sublimation"], 9, false],
      ["Premium Polo", "premium-polo", ["premium polo"], 10, false],
      ["Cotton Polo", "cotton-polo", ["cotton polo"], 11, false],
      ["Zip Hoodie", "zip-hoodie", ["zip hoodie","zipper hoodie","zip-hoodie"], 12, false],
      ["Dropshoulder Hoodie 430gsm", "dropshoulder-hoodie-430gsm", ["dropshoulder hoodie","drop shoulder hoodie","430gsm hoodie dropshoulder"], 13, false],
      ["Hoodie 430gsm", "hoodie-430gsm", ["hoodie 430","430gsm hoodie"], 14, false],
      ["Hoodie 320gsm (Black)", "hoodie-320gsm-black", ["hoodie 320 black","hoodie black","black hoodie"], 15, false],
      ["Hoodie 320gsm", "hoodie-320gsm", ["hoodie 320","320gsm hoodie"], 16, false],
      ["Varsity Jacket", "varsity-jacket", ["varsity","varsity jacket"], 17, false],
      ["Sweatshirt", "sweatshirt", ["sweatshirt"], 18, false],
      ["Kids Round Neck", "kids-round-neck", ["kids","kids round","children"], 19, false],
      ["Shorts", "shorts", ["shorts","short"], 20, false],
      ["Oversize T-Shirt", "oversize-210gsm", ["oversize","over size","oversized"], 900, true],
      ["Hoodie", "hoodie-320gsm", ["hoodie","hoody"], 901, true],
      ["Polo T-Shirt", "premium-polo", ["polo"], 902, true],
      ["Round Neck T-Shirt", "biowash-round-neck", ["round neck","roundneck","tshirt","t-shirt","t shirt"], 903, true],
    ];
    for (const [name, slug, kws, order, fallback] of defaultProducts) {
      await pool.query(
        "INSERT INTO product_keywords (product_name, url_slug, keywords, sort_order, is_fallback) VALUES ($1, $2, $3, $4, $5)",
        [name, slug, kws, order, fallback]
      );
    }
    console.log("[Init] Seeded default product keywords");
  }

  // Load templates and products into cache
  await loadTemplates();
  await loadProducts();

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

  // One-time migration: clean phone numbers that were stored with +/- formatting
  await pool.query(`
    UPDATE leads
    SET sender_mobile = regexp_replace(sender_mobile, '[^0-9]', '', 'g')
    WHERE sender_mobile ~ '[^0-9]'
  `);
  // Add 91 prefix to bare 10-digit numbers
  await pool.query(`
    UPDATE leads
    SET sender_mobile = '91' || sender_mobile
    WHERE sender_mobile ~ '^[6-9][0-9]{9}$'
  `);

  // Reset leads that were wrongly marked as "failed" due to phone formatting
  // These have valid cleaned numbers now, so retry them
  await pool.query(`
    UPDATE leads
    SET whatsapp_status = NULL, whatsapp_error = NULL
    WHERE whatsapp_status = 'failed'
    AND whatsapp_error LIKE 'Invalid number:%'
    AND sender_mobile ~ '^91[6-9][0-9]{9}$'
  `);

  // Retry leads that were wrongly marked as failed (now reset to NULL)
  const pending = await pool.query(
    `SELECT unique_query_id, sender_mobile, query_product_name, query_message, sender_name
     FROM leads WHERE whatsapp_status IS NULL AND sender_mobile IS NOT NULL
     LIMIT 50`
  );
  if (pending.rows.length > 0) {
    console.log(`[Init] Retrying ${pending.rows.length} lead(s) with pending WhatsApp status...`);
    for (const row of pending.rows) {
      // Build a lead object matching autoReplyToLead expectations
      const lead = {
        UNIQUE_QUERY_ID: row.unique_query_id,
        SENDER_MOBILE: row.sender_mobile,
        QUERY_PRODUCT_NAME: row.query_product_name,
        QUERY_MESSAGE: row.query_message,
        SENDER_NAME: row.sender_name,
      };
      autoReplyToLead(lead).catch((e) => console.error(`[Init] Retry failed for ${row.unique_query_id}:`, e.message));
    }
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
        cleanPhoneNumber(l.SENDER_MOBILE) || null,
        l.SENDER_EMAIL,
        l.SENDER_COMPANY,
        l.SENDER_ADDRESS,
        l.SENDER_CITY,
        l.SENDER_STATE,
        l.SENDER_COUNTRY_ISO,
        l.QUERY_PRODUCT_NAME,
        l.QUERY_MESSAGE,
        l.CALL_DURATION,
        cleanPhoneNumber(l.SENDER_MOBILE_ALT) || null,
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

// Catalog base URL for building product links
const CATALOG_BASE = "https://sale91.com/catalog/p";

// Load templates from DB into cache
async function loadTemplates() {
  const { rows } = await pool.query("SELECT template_key, template_text FROM message_templates");
  cachedTemplates = {};
  for (const r of rows) cachedTemplates[r.template_key] = r.template_text;
  console.log(`[Cache] Loaded ${rows.length} message templates`);
}

// Load product keywords from DB into cache (sorted by sort_order)
async function loadProducts() {
  const { rows } = await pool.query("SELECT * FROM product_keywords ORDER BY sort_order ASC, id ASC");
  cachedProducts = rows;
  console.log(`[Cache] Loaded ${rows.length} product keywords`);
}

// Match lead text to a product from cached DB keywords
// Priority: longest keyword match wins, so "oversize" beats "over s"
function matchProduct(productName, message) {
  const text = `${productName || ""} ${message || ""}`.toLowerCase();
  let bestMatch = null;
  let bestLen = 0;
  for (const product of cachedProducts) {
    const keywords = product.keywords || [];
    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      if (text.includes(kwLower) && kwLower.length > bestLen) {
        bestMatch = product;
        bestLen = kwLower.length;
      }
    }
  }
  if (bestMatch) {
    return { name: bestMatch.product_name, url: `${CATALOG_BASE}/${bestMatch.url_slug}/` };
  }
  return null; // no match — send full catalog
}

// Clean phone number: remove +, -, spaces, parens → return "91XXXXXXXXXX"
function cleanPhoneNumber(phone) {
  if (!phone) return null;
  const cleaned = phone.replace(/[\s+\-()]/g, "");
  if (!cleaned) return null;
  if (cleaned.length === 10 && /^[6-9]/.test(cleaned)) return "91" + cleaned;
  if (cleaned.startsWith("91") && cleaned.length === 12) return cleaned;
  return cleaned; // return as-is if format unknown
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

// Derive product image URL from catalog page URL
// sale91.com/catalog/p/oversize-210gsm/ → bulkplaintshirt.com/catalog/images/oversize-210gsm/m.webp
function getProductImage(catalogUrl) {
  if (!catalogUrl) return null;
  const match = catalogUrl.match(/\/catalog\/p\/([^/]+)/);
  if (!match) return null;
  return `https://www.bulkplaintshirt.com/catalog/images/${match[1]}/m.webp`;
}

// Send WhatsApp message via WhatsApp Business API
// If imageUrl is provided, sends image+caption; otherwise sends text with link preview
function sendWhatsApp(phone, messageText, imageUrl) {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneId || !token) return Promise.resolve(null);

  // Clean phone number: remove +, -, spaces
  const cleanPhone = phone.replace(/[\s+\-()]/g, "");

  let payload;
  if (imageUrl) {
    // Image message with caption — guaranteed image preview
    payload = {
      messaging_product: "whatsapp",
      to: cleanPhone,
      type: "image",
      image: { link: imageUrl, caption: messageText },
    };
  } else {
    // Text message with link preview fallback
    payload = {
      messaging_product: "whatsapp",
      to: cleanPhone,
      type: "text",
      text: { preview_url: true, body: messageText },
    };
  }

  const body = JSON.stringify(payload);

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

  // Skip if already processed (prevents duplicate messages)
  try {
    const existing = await pool.query(
      "SELECT whatsapp_status FROM leads WHERE unique_query_id = $1",
      [lead.UNIQUE_QUERY_ID]
    );
    if (existing.rows.length > 0 && existing.rows[0].whatsapp_status) {
      return; // already sent/delivered/read/failed — don't re-send
    }
  } catch (e) { /* proceed if check fails */ }

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
  let imageUrl = null;
  if (!match) {
    console.log(`[WhatsApp] No product match for: "${lead.QUERY_PRODUCT_NAME}" / "${lead.QUERY_MESSAGE}" — sending generic catalog link`);
    const template = cachedTemplates.generic_reply || "You enquired for *{product_name}*, check our full catalog - https://sale91.com/catalog\n\nAsk if any question.";
    msg = template
      .replace(/{product_name}/g, lead.QUERY_PRODUCT_NAME || "our products")
      .replace(/{url}/g, "https://sale91.com/catalog")
      .replace(/{sender_name}/g, lead.SENDER_NAME || "");
  } else {
    const template = cachedTemplates.product_reply || "You enquired for *{product_name}*, check price and photos - {url}\n\nAsk if any question.";
    msg = template
      .replace(/{product_name}/g, match.name)
      .replace(/{url}/g, match.url)
      .replace(/{sender_name}/g, lead.SENDER_NAME || "");
    imageUrl = getProductImage(match.url);
  }

  const result = await sendWhatsApp(phone, msg, imageUrl);
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

// Test endpoint — send a test WhatsApp message to verify delivery
// Usage: /api/test-lead?phone=918527150400&name=Ketu
app.get("/api/test-lead", async (req, res) => {
  const phone = req.query.phone || "918527150400";
  const name = req.query.name || "Ketu";
  const product = req.query.product || "Oversize T-shirt 240gsm";
  const queryId = "TEST-" + Date.now();

  const lead = {
    UNIQUE_QUERY_ID: queryId,
    QUERY_TYPE: "W",
    QUERY_TIME: new Date().toISOString(),
    SENDER_NAME: name,
    SENDER_MOBILE: phone,
    SENDER_EMAIL: "test@test.com",
    SENDER_COMPANY: "Test",
    SENDER_CITY: "Delhi",
    QUERY_PRODUCT_NAME: product,
    QUERY_MESSAGE: "Test lead for WhatsApp delivery verification",
  };

  try {
    // Insert into DB
    await insertLeads([lead]);

    // Send WhatsApp (wait for result, don't fire-and-forget)
    await autoReplyToLead(lead);

    // Fetch the result from DB
    const { rows } = await pool.query(
      "SELECT whatsapp_status, whatsapp_wamid, whatsapp_error, whatsapp_message FROM leads WHERE unique_query_id = $1",
      [queryId]
    );

    const result = rows[0] || {};
    res.json({
      status: "ok",
      query_id: queryId,
      phone,
      name,
      whatsapp_status: result.whatsapp_status,
      whatsapp_wamid: result.whatsapp_wamid,
      whatsapp_error: result.whatsapp_error,
      message_sent: result.whatsapp_message,
      note: "Check your WhatsApp — message aana chahiye!",
    });
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

// ─── Monthly Leads API ───

// Get monthly summary — count of leads per month
app.get("/api/leads/months", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        TO_CHAR(created_at, 'YYYY-MM') AS month_key,
        TO_CHAR(created_at, 'Mon YYYY') AS month_label,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE whatsapp_status IN ('sent','delivered','read')) AS wa_success,
        COUNT(*) FILTER (WHERE whatsapp_status = 'failed') AS wa_failed,
        COUNT(*) FILTER (WHERE whatsapp_status = 'called') AS wa_called
      FROM leads
      GROUP BY month_key, month_label
      ORDER BY month_key DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get all leads for a specific month (YYYY-MM format)
app.get("/api/leads/month/:key", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM leads
       WHERE TO_CHAR(created_at, 'YYYY-MM') = $1
       ORDER BY created_at DESC`,
      [req.params.key]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Template CRUD API ───

// Get all templates
app.get("/api/templates", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM message_templates ORDER BY id");
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update a template
app.post("/api/templates", async (req, res) => {
  try {
    const { template_key, template_text } = req.body;
    if (!template_key || !template_text) return res.status(400).json({ error: "template_key and template_text required" });
    await pool.query(
      "UPDATE message_templates SET template_text = $1, updated_at = NOW() WHERE template_key = $2",
      [template_text, template_key]
    );
    await loadTemplates();
    res.json({ status: "ok" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Product Keywords CRUD API ───

// Get all products with keywords
app.get("/api/keywords", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM product_keywords ORDER BY sort_order ASC, id ASC");
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Add a new product with keywords
app.post("/api/keywords", async (req, res) => {
  try {
    const { product_name, url_slug, keywords, sort_order, is_fallback } = req.body;
    if (!product_name || !url_slug) return res.status(400).json({ error: "product_name and url_slug required" });
    const kws = Array.isArray(keywords) ? keywords : (keywords || "").split(",").map(k => k.trim()).filter(Boolean);
    await pool.query(
      "INSERT INTO product_keywords (product_name, url_slug, keywords, sort_order, is_fallback) VALUES ($1, $2, $3, $4, $5)",
      [product_name, url_slug, kws, sort_order || 100, is_fallback || false]
    );
    await loadProducts();
    res.json({ status: "ok" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update a product's keywords
app.put("/api/keywords/:id", async (req, res) => {
  try {
    const { product_name, url_slug, keywords, sort_order, is_fallback } = req.body;
    const kws = Array.isArray(keywords) ? keywords : (keywords || "").split(",").map(k => k.trim()).filter(Boolean);
    await pool.query(
      "UPDATE product_keywords SET product_name = $1, url_slug = $2, keywords = $3, sort_order = $4, is_fallback = $5, updated_at = NOW() WHERE id = $6",
      [product_name, url_slug, kws, sort_order || 100, is_fallback || false, req.params.id]
    );
    await loadProducts();
    res.json({ status: "ok" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete a product
app.delete("/api/keywords/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM product_keywords WHERE id = $1", [req.params.id]);
    await loadProducts();
    res.json({ status: "ok" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mark a failed lead as "called" (done — remove from failed list)
app.post("/api/lead/:id/called", async (req, res) => {
  try {
    await pool.query(
      "UPDATE leads SET whatsapp_status = 'called' WHERE unique_query_id = $1",
      [req.params.id]
    );
    res.json({ status: "ok" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Format any date/timestamp to IST for display on dashboard
function toIST(dateVal) {
  if (!dateVal) return "";
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return String(dateVal);
  return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });
}

// HTML-escape to prevent XSS from untrusted lead data
function esc(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Dashboard — simple HTML page to view leads
app.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM leads ORDER BY created_at DESC LIMIT 50"
    );

    // Total leads count (all time)
    const totalResult = await pool.query("SELECT COUNT(*) FROM leads");
    const totalLeads = parseInt(totalResult.rows[0].count);

    // Current month leads count
    const monthResult = await pool.query(
      "SELECT COUNT(*) FROM leads WHERE TO_CHAR(created_at, 'YYYY-MM') = TO_CHAR(NOW(), 'YYYY-MM')"
    );
    const currentMonthLeads = parseInt(monthResult.rows[0].count);
    const currentMonthName = new Date().toLocaleString("en-IN", { month: "long", year: "numeric" });

    // Leads where WhatsApp failed — need to call directly
    const { rows: failedRows } = await pool.query(
      "SELECT * FROM leads WHERE whatsapp_status = 'failed' ORDER BY created_at DESC LIMIT 50"
    );

    const failedTableRows = failedRows
      .map(
        (r) => `
      <tr id="failed-${esc(r.unique_query_id)}">
        <td>${esc(r.sender_name)}</td>
        <td><a href="tel:${esc(r.sender_mobile)}" class="call-btn">${esc(r.sender_mobile)}</a>${r.sender_mobile_alt ? '<br><a href="tel:' + esc(r.sender_mobile_alt) + '" class="call-btn alt">' + esc(r.sender_mobile_alt) + "</a>" : ""}</td>
        <td>${esc(r.sender_company)}</td>
        <td>${esc(r.sender_city)}</td>
        <td>${esc(r.query_product_name)}${r.query_mcat_name ? "<br><small>(" + esc(r.query_mcat_name) + ")</small>" : ""}</td>
        <td>${esc((r.query_message || "").substring(0, 80))}</td>
        <td>${toIST(r.query_time)}</td>
        <td><button class="btn btn-success btn-sm done-btn" onclick="markCalled('${esc(r.unique_query_id)}')">Done</button></td>
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
            waBadge = '<span class="wa-badge wa-read"><span class="wa-ticks">&#10003;&#10003;</span><span class="wa-label">Read</span></span>';
            if (r.whatsapp_sent_at) waDetails = `<br><small>${toIST(r.whatsapp_sent_at)}</small>`;
          } else if (r.whatsapp_status === "delivered") {
            waBadge = '<span class="wa-badge wa-delivered"><span class="wa-ticks">&#10003;&#10003;</span><span class="wa-label">Delivered</span></span>';
            if (r.whatsapp_sent_at) waDetails = `<br><small>${toIST(r.whatsapp_sent_at)}</small>`;
          } else if (r.whatsapp_status === "sent") {
            waBadge = '<span class="wa-badge wa-sent"><span class="wa-ticks">&#10003;</span><span class="wa-label">Sent</span></span>';
            if (r.whatsapp_sent_at) waDetails = `<br><small>${toIST(r.whatsapp_sent_at)}</small>`;
          } else if (r.whatsapp_status === "failed") {
            waBadge = '<span class="wa-badge wa-failed">&#10007; Failed</span>';
            if (r.whatsapp_error) {
              waDetails = `<br><small class="wa-error">${esc(r.whatsapp_error)}</small>`;
            }
          } else if (r.whatsapp_status === "called") {
            waBadge = '<span class="wa-badge wa-called">&#9742; Called</span>';
          } else {
            waBadge = '<span class="wa-badge wa-pending">—</span>';
          }

          // Follow-up link — open WhatsApp chat for manual follow-up
          let waLink = "";
          if (r.sender_mobile && r.whatsapp_status !== "failed") {
            const cleanNum = (r.sender_mobile || "").replace(/[\s+\-()]/g, "");
            const waNum = cleanNum.startsWith("91") ? cleanNum : "91" + cleanNum;
            waLink = '<br><a href="https://wa.me/' + waNum + '" target="_blank" class="wa-web-btn">Follow Up</a>';
          }

          // WhatsApp message sent (truncated for display)
          const waMsg = r.whatsapp_message ? `<br><small class="wa-msg">${esc((r.whatsapp_message || "").substring(0, 100))}</small>` : "";

          // Lead type badge
          const typeMap = { B: ["Buy Lead", "lead-buy"], W: ["Web Lead", "lead-web"], C: ["Call Lead", "lead-call"] };
          const [typeLabel, typeCls] = typeMap[r.query_type] || [r.query_type || "—", "lead-other"];
          const typeBadge = `<span class="lead-type ${typeCls}">${typeLabel}</span>`;

          return `
      <tr>
        <td>${esc(r.sender_name)}</td>
        <td>${esc(r.sender_mobile)}${r.sender_mobile_alt ? "<br><small>" + esc(r.sender_mobile_alt) + "</small>" : ""}</td>
        <td>${esc(r.sender_company)}</td>
        <td>${esc(r.sender_city)}</td>
        <td>${typeBadge}</td>
        <td>${esc(r.query_product_name)}${r.query_mcat_name ? "<br><small>(" + esc(r.query_mcat_name) + ")</small>" : ""}</td>
        <td>${esc((r.query_message || "").substring(0, 80))}</td>
        <td>${toIST(r.query_time)}${r.created_at ? '<br><small style="color:#16a34a">Received: ' + toIST(r.created_at) + '</small>' : ''}</td>
        <td>${waBadge}${waDetails}${waMsg}${waLink}</td>
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
    .done-btn { white-space: nowrap; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; color: white; background: #dc2626; margin-left: 8px; }
    .lead-type { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 700; white-space: nowrap; }
    .lead-buy { background: #dbeafe; color: #1d4ed8; }
    .lead-web { background: #dcfce7; color: #15803d; }
    .lead-call { background: #fef3c7; color: #b45309; }
    .lead-other { background: #f3f4f6; color: #6b7280; }
    .wa-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; font-weight: 600; white-space: nowrap; }
    .wa-ticks { font-size: 16px; letter-spacing: -4px; margin-right: 2px; }
    .wa-sent .wa-ticks { color: #9ca3af; }
    .wa-sent .wa-label { color: #9ca3af; }
    .wa-delivered .wa-ticks { color: #9ca3af; }
    .wa-delivered .wa-label { color: #6b7280; }
    .wa-read .wa-ticks { color: #53bdeb; }
    .wa-read .wa-label { color: #53bdeb; }
    .wa-failed { color: #dc2626; }
    .wa-called { color: #16a34a; font-weight: 700; }
    .wa-pending { color: #9ca3af; }
    .wa-msg { color: #6b7280; font-style: italic; }
    .wa-error { color: #dc2626; font-size: 11px; }
    .wa-web-btn { display: inline-block; margin-top: 4px; padding: 3px 10px; background: #25D366; color: white; text-decoration: none; border-radius: 4px; font-size: 12px; font-weight: 600; }
    .wa-web-btn:hover { background: #1da851; }

    /* Settings sections */
    .settings-section { margin-top: 40px; padding: 24px; background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .settings-section h2 { font-size: 18px; color: #1e293b; margin-bottom: 6px; }
    .settings-section .desc { color: #64748b; font-size: 13px; margin-bottom: 16px; }
    .tmpl-card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 14px; }
    .tmpl-card label { font-weight: 600; font-size: 14px; color: #334155; display: block; margin-bottom: 4px; }
    .tmpl-card .tmpl-desc { font-size: 12px; color: #94a3b8; margin-bottom: 8px; }
    .tmpl-card textarea { width: 100%; min-height: 80px; padding: 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-family: monospace; font-size: 13px; resize: vertical; }
    .tmpl-card .placeholders { font-size: 11px; color: #94a3b8; margin-top: 6px; }
    .tmpl-card .placeholders code { background: #f1f5f9; padding: 1px 5px; border-radius: 3px; }
    .btn { padding: 8px 20px; border: none; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; }
    .btn-primary { background: #2563eb; color: white; }
    .btn-primary:hover { background: #1d4ed8; }
    .btn-danger { background: #dc2626; color: white; }
    .btn-danger:hover { background: #b91c1c; }
    .btn-success { background: #16a34a; color: white; }
    .btn-success:hover { background: #15803d; }
    .btn-sm { padding: 4px 12px; font-size: 12px; }
    .kw-table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    .kw-table th, .kw-table td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #e2e8f0; font-size: 13px; }
    .kw-table th { background: #f8fafc; color: #475569; font-weight: 600; }
    .kw-tag { display: inline-block; background: #e0e7ff; color: #3730a3; padding: 2px 8px; border-radius: 10px; font-size: 11px; margin: 1px 2px; }
    .kw-fallback { background: #fef3c7; color: #92400e; font-size: 11px; padding: 2px 8px; border-radius: 10px; }
    .kw-url { color: #2563eb; font-size: 12px; }
    .btn-edit { background: #f59e0b; color: white; }
    .btn-edit:hover { background: #d97706; }
    .edit-row td { background: #fffbeb; }
    .edit-row input, .edit-row select { width: 100%; padding: 4px 6px; border: 1px solid #cbd5e1; border-radius: 4px; font-size: 12px; box-sizing: border-box; }
    .edit-row .kw-edit-input { min-width: 150px; }
    .add-form { border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-top: 14px; display: none; }
    .add-form .form-row { display: flex; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
    .add-form input, .add-form select { padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; }
    .add-form input[type="text"] { flex: 1; min-width: 150px; }
    .add-form input[type="number"] { width: 80px; }
    .toast { position: fixed; bottom: 20px; right: 20px; padding: 12px 24px; background: #16a34a; color: white; border-radius: 8px; font-weight: 600; font-size: 14px; display: none; z-index: 1000; }

    /* Monthly Archive */
    .month-grid { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 14px; }
    .month-card { border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px 20px; cursor: pointer; min-width: 180px; transition: all 0.15s; background: white; }
    .month-card:hover { border-color: #2563eb; box-shadow: 0 2px 8px rgba(37,99,235,0.12); }
    .month-card.active { border-color: #2563eb; background: #eff6ff; }
    .month-card .month-name { font-size: 16px; font-weight: 700; color: #1e293b; }
    .month-card .month-total { font-size: 24px; font-weight: 800; color: #2563eb; margin: 4px 0; }
    .month-card .month-stats { font-size: 11px; color: #64748b; }
    .month-card .month-stats span { margin-right: 8px; }
    .month-card .stat-ok { color: #16a34a; }
    .month-card .stat-fail { color: #dc2626; }
    .month-card .stat-call { color: #b45309; }
    .month-leads-container { margin-top: 16px; }
    .month-leads-container table th { background: #475569; }
  </style>
</head>
<body>
  <h1>IndiaMART Leads</h1>

  <div style="display:flex;gap:16px;margin-bottom:20px;flex-wrap:wrap;">
    <div style="background:white;border-radius:10px;padding:16px 24px;box-shadow:0 1px 3px rgba(0,0,0,0.1);min-width:160px;">
      <div style="font-size:12px;color:#64748b;font-weight:600;">TOTAL LEADS</div>
      <div style="font-size:32px;font-weight:800;color:#2563eb;">${totalLeads}</div>
      <div style="font-size:12px;color:#94a3b8;">All time</div>
    </div>
    <div style="background:white;border-radius:10px;padding:16px 24px;box-shadow:0 1px 3px rgba(0,0,0,0.1);min-width:160px;">
      <div style="font-size:12px;color:#64748b;font-weight:600;">${currentMonthName.toUpperCase()}</div>
      <div style="font-size:32px;font-weight:800;color:#16a34a;">${currentMonthLeads}</div>
      <div style="font-size:12px;color:#94a3b8;">This month</div>
    </div>
  </div>

  ${failedRows.length > 0 ? `
  <div class="failed-section">
    <h2>WhatsApp Failed — Call Karo <span class="badge">${failedRows.length}</span></h2>
    <p class="stats">In logon ka WhatsApp nahi hai, directly call karo</p>
    <table>
      <thead>
        <tr>
          <th>Name</th><th>Phone (Tap to Call)</th><th>Company</th>
          <th>City</th><th>Product</th><th>Message</th><th>Time</th><th>Action</th>
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
        <th>Name</th><th>Mobile</th>
        <th>Company</th><th>City</th><th>Type</th><th>Product</th><th>Message</th><th>Enquiry / Received</th><th>WhatsApp</th>
      </tr>
    </thead>
    <tbody>
      ${tableRows || '<tr><td colspan="9" class="empty">No leads yet. Waiting for IndiaMART to push data...</td></tr>'}

    </tbody>
  </table>

  <!-- ─── MONTHLY ARCHIVE SECTION ─── -->
  <div class="settings-section">
    <h2>Monthly Archive</h2>
    <p class="desc">Month pe click karo — uss month ki saari leads dikhegi</p>
    <div class="month-grid" id="month-grid">Loading...</div>
    <div class="month-leads-container" id="month-leads-container"></div>
  </div>

  <!-- ─── MESSAGE TEMPLATES SECTION ─── -->
  <div class="settings-section">
    <h2>Message Templates</h2>
    <p class="desc">WhatsApp message templates — placeholders: <code>{product_name}</code> <code>{url}</code> <code>{sender_name}</code></p>
    <div id="templates-container">Loading...</div>
  </div>

  <!-- ─── PRODUCT KEYWORDS SECTION ─── -->
  <div class="settings-section">
    <h2>Product Keywords</h2>
    <p class="desc">Description mein ye keywords match hone par uss product ka link bhejega. URL automatically banta hai slug se.</p>
    <button class="btn btn-success" onclick="document.getElementById('add-kw-form').style.display='block'">+ Add Product</button>
    <div id="add-kw-form" class="add-form">
      <div class="form-row">
        <input type="text" id="new-name" placeholder="Product Name (e.g. Oversize 210gsm)">
        <input type="text" id="new-slug" placeholder="URL Slug (e.g. oversize-210gsm)">
      </div>
      <div class="form-row">
        <input type="text" id="new-keywords" placeholder="Keywords comma separated (e.g. oversize 210, 210gsm oversize)">
        <input type="number" id="new-order" placeholder="Order" value="100">
        <label style="font-size:13px;display:flex;align-items:center;gap:4px;"><input type="checkbox" id="new-fallback"> Fallback</label>
      </div>
      <button class="btn btn-primary" onclick="addKeyword()">Save</button>
      <button class="btn" style="background:#e2e8f0" onclick="document.getElementById('add-kw-form').style.display='none'">Cancel</button>
    </div>
    <table class="kw-table">
      <thead><tr><th>Order</th><th>Product</th><th>URL</th><th>Keywords</th><th>Type</th><th>Actions</th></tr></thead>
      <tbody id="kw-tbody">Loading...</tbody>
    </table>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    function showToast(msg, ok) {
      var t = document.getElementById('toast');
      t.textContent = msg;
      t.style.background = ok ? '#16a34a' : '#dc2626';
      t.style.display = 'block';
      setTimeout(function() { t.style.display = 'none'; }, 2000);
    }

    // ─── MONTHLY ARCHIVE ───
    function loadMonths() {
      fetch('/api/leads/months').then(function(r) { return r.json(); }).then(function(data) {
        var grid = document.getElementById('month-grid');
        grid.innerHTML = '';
        if (!data.length) { grid.innerHTML = '<p style="color:#94a3b8">No leads yet</p>'; return; }
        data.forEach(function(m) {
          var card = document.createElement('div');
          card.className = 'month-card';
          card.setAttribute('data-key', m.month_key);
          card.innerHTML = '<div class="month-name">' + m.month_label + '</div>' +
            '<div class="month-total">' + m.total + ' Leads</div>' +
            '<div class="month-stats">' +
              '<span class="stat-ok">WA: ' + m.wa_success + '</span>' +
              '<span class="stat-fail">Failed: ' + m.wa_failed + '</span>' +
              '<span class="stat-call">Called: ' + m.wa_called + '</span>' +
            '</div>';
          card.onclick = function() { loadMonthLeads(m.month_key, m.month_label); };
          grid.appendChild(card);
        });
      });
    }

    function loadMonthLeads(key, label) {
      // Highlight active card
      var cards = document.querySelectorAll('.month-card');
      cards.forEach(function(c) { c.className = c.getAttribute('data-key') === key ? 'month-card active' : 'month-card'; });

      var container = document.getElementById('month-leads-container');
      container.innerHTML = '<p style="color:#64748b;padding:12px;">Loading ' + label + ' leads...</p>';

      fetch('/api/leads/month/' + key).then(function(r) { return r.json(); }).then(function(rows) {
        if (!rows.length) { container.innerHTML = '<p style="color:#94a3b8;padding:12px;">No leads in ' + label + '</p>'; return; }

        var html = '<h3 style="margin:16px 0 8px;color:#1e293b;">' + label + ' — ' + rows.length + ' Leads</h3>';
        html += '<table><thead><tr><th>Name</th><th>Mobile</th><th>Company</th><th>City</th><th>Type</th><th>Product</th><th>Message</th><th>Enquiry / Received</th><th>WhatsApp</th></tr></thead><tbody>';

        rows.forEach(function(r) {
          var typeMap = { B: ['Buy Lead','lead-buy'], W: ['Web Lead','lead-web'], C: ['Call Lead','lead-call'] };
          var tp = typeMap[r.query_type] || [r.query_type || '—', 'lead-other'];
          var typeBadge = '<span class="lead-type ' + tp[1] + '">' + tp[0] + '</span>';

          var waBadge = '';
          if (r.whatsapp_status === 'read') waBadge = '<span class="wa-badge wa-read"><span class="wa-ticks">&#10003;&#10003;</span><span class="wa-label">Read</span></span>';
          else if (r.whatsapp_status === 'delivered') waBadge = '<span class="wa-badge wa-delivered"><span class="wa-ticks">&#10003;&#10003;</span><span class="wa-label">Delivered</span></span>';
          else if (r.whatsapp_status === 'sent') waBadge = '<span class="wa-badge wa-sent"><span class="wa-ticks">&#10003;</span><span class="wa-label">Sent</span></span>';
          else if (r.whatsapp_status === 'failed') waBadge = '<span class="wa-badge wa-failed">&#10007; Failed</span>';
          else if (r.whatsapp_status === 'called') waBadge = '<span class="wa-badge wa-called">&#9742; Called</span>';
          else waBadge = '<span class="wa-badge wa-pending">—</span>';

          var name = esc(r.sender_name);
          var mobile = esc(r.sender_mobile || '');
          var company = esc(r.sender_company || '');
          var city = esc(r.sender_city || '');
          var product = esc(r.query_product_name || '');
          var msg = esc((r.query_message || '').substring(0, 80));
          var timeFmt = function(d) { if (!d) return ''; return new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }); };
          var timeCell = timeFmt(r.query_time) + (r.created_at ? '<br><small style="color:#16a34a">Received: ' + timeFmt(r.created_at) + '</small>' : '');

          html += '<tr><td>' + name + '</td><td>' + mobile + '</td><td>' + company + '</td><td>' + city + '</td><td>' + typeBadge + '</td><td>' + product + '</td><td>' + msg + '</td><td>' + timeCell + '</td><td>' + waBadge + '</td></tr>';
        });

        html += '</tbody></table>';
        container.innerHTML = html;
      });
    }

    function esc(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    // ─── MARK CALLED (Done) ───
    function markCalled(queryId) {
      fetch('/api/lead/' + queryId + '/called', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.status === 'ok') {
            var row = document.getElementById('failed-' + queryId);
            if (row) row.style.display = 'none';
            showToast('Done! List se hata diya', true);
          } else { showToast('Error', false); }
        });
    }

    // ─── TEMPLATES ───
    function loadTemplates() {
      fetch('/api/templates').then(function(r) { return r.json(); }).then(function(data) {
        var c = document.getElementById('templates-container');
        c.innerHTML = '';
        data.forEach(function(t) {
          var div = document.createElement('div');
          div.className = 'tmpl-card';
          div.innerHTML = '<label>' + t.template_key + '</label>' +
            '<div class="tmpl-desc">' + (t.description || '') + '</div>' +
            '<textarea id="tmpl-' + t.template_key + '">' + t.template_text + '</textarea>' +
            '<div class="placeholders">Placeholders: <code>{product_name}</code> <code>{url}</code> <code>{sender_name}</code></div>' +
            '<br><button class="btn btn-primary btn-sm" onclick="saveTemplate(\\'' + t.template_key + '\\')">Save Template</button>';
          c.appendChild(div);
        });
      });
    }

    function saveTemplate(key) {
      var text = document.getElementById('tmpl-' + key).value;
      fetch('/api/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_key: key, template_text: text })
      }).then(function(r) { return r.json(); }).then(function(d) {
        showToast(d.status === 'ok' ? 'Template saved!' : 'Error: ' + d.error, d.status === 'ok');
      });
    }

    // ─── KEYWORDS ───
    function loadKeywords() {
      fetch('/api/keywords').then(function(r) { return r.json(); }).then(function(data) {
        var tbody = document.getElementById('kw-tbody');
        tbody.innerHTML = '';
        data.forEach(function(p) {
          var kwTags = (p.keywords || []).map(function(k) { return '<span class="kw-tag">' + k + '</span>'; }).join(' ');
          var tr = document.createElement('tr');
          tr.id = 'kw-row-' + p.id;
          tr.innerHTML = '<td>' + p.sort_order + '</td>' +
            '<td><strong>' + p.product_name + '</strong></td>' +
            '<td><span class="kw-url">sale91.com/catalog/p/' + p.url_slug + '/</span></td>' +
            '<td>' + kwTags + '</td>' +
            '<td>' + (p.is_fallback ? '<span class="kw-fallback">Fallback</span>' : 'Specific') + '</td>' +
            '<td>' +
              '<button class="btn btn-edit btn-sm" onclick="editKeyword(' + p.id + ',' + JSON.stringify(JSON.stringify(p)) + ')">Edit</button> ' +
              '<button class="btn btn-danger btn-sm" onclick="deleteKeyword(' + p.id + ')">Delete</button>' +
            '</td>';
          tbody.appendChild(tr);
        });
      });
    }

    function editKeyword(id, jsonStr) {
      var p = JSON.parse(jsonStr);
      var row = document.getElementById('kw-row-' + id);
      if (!row) return;
      var kwStr = (p.keywords || []).join(', ');
      row.className = 'edit-row';
      row.innerHTML = '<td><input type="number" id="edit-order-' + id + '" value="' + (p.sort_order || 100) + '" style="width:50px"></td>' +
        '<td><input type="text" id="edit-name-' + id + '" value="' + (p.product_name || '') + '"></td>' +
        '<td><input type="text" id="edit-slug-' + id + '" value="' + (p.url_slug || '') + '"></td>' +
        '<td><input type="text" class="kw-edit-input" id="edit-kws-' + id + '" value="' + kwStr + '" placeholder="comma separated keywords"></td>' +
        '<td><select id="edit-fb-' + id + '"><option value="false"' + (!p.is_fallback ? ' selected' : '') + '>Specific</option><option value="true"' + (p.is_fallback ? ' selected' : '') + '>Fallback</option></select></td>' +
        '<td>' +
          '<button class="btn btn-primary btn-sm" onclick="saveKeyword(' + id + ')">Save</button> ' +
          '<button class="btn btn-sm" style="background:#e2e8f0" onclick="loadKeywords()">Cancel</button>' +
        '</td>';
    }

    function saveKeyword(id) {
      var name = document.getElementById('edit-name-' + id).value.trim();
      var slug = document.getElementById('edit-slug-' + id).value.trim();
      var kws = document.getElementById('edit-kws-' + id).value.trim();
      var order = parseInt(document.getElementById('edit-order-' + id).value) || 100;
      var fallback = document.getElementById('edit-fb-' + id).value === 'true';
      if (!name || !slug) { showToast('Product name and slug required!', false); return; }
      fetch('/api/keywords/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_name: name, url_slug: slug, keywords: kws.split(',').map(function(k){return k.trim();}).filter(Boolean), sort_order: order, is_fallback: fallback })
      }).then(function(r) { return r.json(); }).then(function(d) {
        if (d.status === 'ok') {
          showToast('Updated!', true);
          loadKeywords();
        } else { showToast('Error: ' + d.error, false); }
      });
    }

    function addKeyword() {
      var name = document.getElementById('new-name').value.trim();
      var slug = document.getElementById('new-slug').value.trim();
      var kws = document.getElementById('new-keywords').value.trim();
      var order = parseInt(document.getElementById('new-order').value) || 100;
      var fallback = document.getElementById('new-fallback').checked;
      if (!name || !slug || !kws) { showToast('Fill all fields!', false); return; }
      fetch('/api/keywords', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_name: name, url_slug: slug, keywords: kws.split(',').map(function(k){return k.trim();}), sort_order: order, is_fallback: fallback })
      }).then(function(r) { return r.json(); }).then(function(d) {
        if (d.status === 'ok') {
          showToast('Product added!', true);
          document.getElementById('add-kw-form').style.display = 'none';
          document.getElementById('new-name').value = '';
          document.getElementById('new-slug').value = '';
          document.getElementById('new-keywords').value = '';
          document.getElementById('new-order').value = '100';
          document.getElementById('new-fallback').checked = false;
          loadKeywords();
        } else { showToast('Error: ' + d.error, false); }
      });
    }

    function deleteKeyword(id) {
      if (!confirm('Delete this product?')) return;
      fetch('/api/keywords/' + id, { method: 'DELETE' })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          showToast(d.status === 'ok' ? 'Deleted!' : 'Error', d.status === 'ok');
          loadKeywords();
        });
    }

    // Load on page ready
    loadMonths();
    loadTemplates();
    loadKeywords();
  </script>
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
