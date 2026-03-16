const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { pool } = require('../db');

// =========================================
// SPAM PREVENTION — Leads-specific rate limiter
// 5 submissions per 15 minutes per IP (much stricter than general)
// =========================================
const leadsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many submissions. Please try again later.',
    retryAfter: '15 minutes',
  },
});

// =========================================
// AUTH MIDDLEWARE — API Key for lead retrieval
// Set LEADS_API_KEY env var in Railway
// Pass as: Authorization: Bearer <key>  OR  ?api_key=<key>
// =========================================
function requireApiKey(req, res, next) {
  const apiKey = process.env.LEADS_API_KEY;
  if (!apiKey) {
    // If no key configured, block all access (fail-secure)
    console.error('[AUTH] LEADS_API_KEY not configured — blocking access');
    return res.status(503).json({ error: 'Endpoint not configured' });
  }

  // Check Authorization header first, then query param
  const authHeader = req.headers.authorization;
  let provided = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    provided = authHeader.slice(7);
  } else if (req.query.api_key) {
    provided = req.query.api_key;
  }

  if (!provided || provided !== apiKey) {
    return res.status(401).json({ error: 'Unauthorized — valid API key required' });
  }

  next();
}

// GET /api/leads - list recent leads (AUTH REQUIRED)
router.get('/', requireApiKey, async (req, res, next) => {
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

// POST /api/leads - create lead (spam-protected)
router.post('/', leadsLimiter, async (req, res, next) => {
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

    // =========================================
    // SPAM PREVENTION — Honeypot check
    // Hidden "company_url" field: bots fill it, humans don't see it
    // Silently accept (200) so bots think it worked, but don't store
    // =========================================
    if (req.body.company_url) {
      console.log('[SPAM] Honeypot triggered from IP:', req.ip);
      return res.status(201).json({
        lead: { id: 0, name, email, status: 'new', created_at: new Date().toISOString() }
      });
    }

    // =========================================
    // SPAM PREVENTION — Timing check
    // If form was submitted < 3 seconds after loading, likely a bot
    // =========================================
    if (req.body.form_loaded_at) {
      const loadedAt = parseInt(req.body.form_loaded_at, 10);
      const now = Date.now();
      if (!isNaN(loadedAt) && (now - loadedAt) < 3000) {
        console.log('[SPAM] Speed-submit detected from IP:', req.ip);
        return res.status(201).json({
          lead: { id: 0, name, email, status: 'new', created_at: new Date().toISOString() }
        });
      }
    }

    // =========================================
    // SPAM PREVENTION — Duplicate email within 1 hour
    // =========================================
    const { rows: existing } = await pool.query(
      `SELECT id FROM leads WHERE email = $1 AND created_at > NOW() - INTERVAL '1 hour' LIMIT 1`,
      [email]
    );
    if (existing.length > 0) {
      return res.status(409).json({
        error: 'A submission with this email was already received recently. Please try again later.',
      });
    }

    // =========================================
    // SPAM PREVENTION — Basic email format check
    // =========================================
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // =========================================
    // SPAM PREVENTION — reCAPTCHA v3 verification
    // =========================================
    const recaptchaSecret = process.env.RECAPTCHA_SECRET_KEY;
    const recaptchaToken = req.body?.recaptcha_token;

    if (!recaptchaSecret) {
      console.error('[SPAM] RECAPTCHA_SECRET_KEY not configured');
      return res.status(503).json({ error: 'Spam protection not configured' });
    }

    if (!recaptchaToken) {
      console.warn('[SPAM] Missing reCAPTCHA token from IP:', req.ip);
      return res.status(400).json({ error: 'Spam detected' });
    }

    try {
      const params = new URLSearchParams();
      params.append('secret', recaptchaSecret);
      params.append('response', recaptchaToken);

      const verifyResponse = await fetch('https://www.google.com/recaptcha/api/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      const verifyData = await verifyResponse.json();

      if (!verifyData.success || (typeof verifyData.score === 'number' && verifyData.score < 0.5)) {
        console.warn('[SPAM] reCAPTCHA rejected', {
          ip: req.ip,
          score: verifyData.score,
          action: verifyData.action,
          hostname: verifyData.hostname,
          errors: verifyData['error-codes'],
        });
        return res.status(400).json({ error: 'Spam detected' });
      }
    } catch (verifyErr) {
      console.error('[SPAM] reCAPTCHA verify failed', verifyErr);
      return res.status(502).json({ error: 'Spam protection failed' });
    }

    // =========================================
    // Insert lead
    // =========================================
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
