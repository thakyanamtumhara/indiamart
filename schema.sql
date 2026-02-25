-- IndiaMART leads table
-- This runs automatically on server start, but you can also run it manually:
--   psql $DATABASE_URL -f schema.sql

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
);

CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_sender_mobile ON leads (sender_mobile);
