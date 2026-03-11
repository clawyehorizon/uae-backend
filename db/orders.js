const { pool } = require('./index');

async function getOrderById(id) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getOrderByTelrRef(telrRef) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE telr_ref = $1', [telrRef]);
  return rows[0] || null;
}

module.exports = { getOrderById, getOrderByTelrRef };
