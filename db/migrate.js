const { pool } = require('./index');

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

async function migrate() {
  try {
    console.log('[DB] Running migrations...');
    await pool.query(createSql);
    console.log('[DB] Migrations completed.');
  } catch (err) {
    console.error('[DB] Migration error:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrate();
