const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// GET /api/leads - list recent leads
router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const { rows } = await pool.query(
      'SELECT * FROM leads ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    res.json({ leads: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/leads - create lead
router.post('/', async (req, res, next) => {
  try {
    const {
      name,
      email,
      phone,
      business_activity,
      setup_type,
      visas,
      office_type,
      nationality,
      pro_services,
      cost_estimate,
      status,
    } = req.body || {};

    if (!name || !email) {
      return res.status(400).json({ error: 'name and email are required' });
    }

    const { rows } = await pool.query(
      `INSERT INTO leads
        (name, email, phone, business_activity, setup_type, visas, office_type, nationality, pro_services, cost_estimate, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        name,
        email,
        phone || null,
        business_activity || null,
        setup_type || null,
        typeof visas === 'number' ? visas : (visas ? parseInt(visas, 10) : null),
        office_type || null,
        nationality || null,
        pro_services || null,
        cost_estimate || null,
        status || 'new',
      ]
    );

    res.status(201).json({ lead: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
