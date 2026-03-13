/**
 * routes/migrate.js — One-time database migration endpoint
 * Visit this URL once to create tables, then disable it.
 */

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

const createSql = `
CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  business_activity TEXT,
  setup_type TEXT,
  visas INTEGER,
  office_type TEXT,
  nationality TEXT,
  pro_services TEXT,
  cost_estimate TEXT,
  status TEXT DEFAULT 'new',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  telr_ref TEXT,
  email TEXT,
  name TEXT,
  amount INTEGER,
  currency TEXT,
  status TEXT DEFAULT 'pending',
  user_inputs JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  download_token TEXT,
  pdf_size_bytes INTEGER,
  process_started_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_orders_telr_ref ON orders(telr_ref);
CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(email);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
`;

router.get('/', async (req, res) => {
  try {
    console.log('[MIGRATE] Running database migrations...');
    await pool.query(createSql);
    console.log('[MIGRATE] Migrations completed successfully.');
    
    res.json({
      success: true,
      message: 'Database tables created successfully! You can now disable this endpoint.',
      tables: ['leads', 'orders'],
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[MIGRATE] Migration error:', err.message);
    res.status(500).json({
      success: false,
      error: 'Migration failed. Check Railway logs for details.',
      message: err.message,
    });
  }
});

module.exports = router;
