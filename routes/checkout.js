/**
 * routes/checkout.js — Telr Checkout Session Creation
 *
 * Creates a payment request via Telr's hosted payment page API.
 * On success, returns a checkout URL for the frontend to redirect the user to.
 *
 * Telr Hosted Payment Page Flow:
 * 1. POST to Telr API to create a payment request
 * 2. Receive a checkout URL from Telr
 * 3. Redirect user to Telr's hosted payment page
 * 4. On payment completion, Telr calls our webhook + redirects user
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const { pool } = require('../db');

// In-memory cache for quick lookup (optional)
const orders = new Map();

/**
 * POST /api/checkout
 *
 * Body:
 * {
 *   userInputs: {
 *     name: "John Doe",
 *     email: "john@example.com",
 *     phone: "+971501234567",
 *     activity: "consulting",
 *     entityType: "freezone_llc",
 *     visaCount: 2,
 *     officePreference: "flexi_desk",
 *     preferredEmirate: "dubai",
 *     budgetRange: "20000-40000"
 *   }
 * }
 */
router.post('/', async (req, res, next) => {
  try {
    const { userInputs } = req.body;

    // =========================================
    // INPUT VALIDATION
    // =========================================
    if (!userInputs) {
      return res.status(400).json({ error: 'Missing userInputs in request body.' });
    }

    const { name, email, activity } = userInputs;

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ error: 'Valid name is required.' });
    }

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Valid email is required.' });
    }

    if (!activity || typeof activity !== 'string') {
      return res.status(400).json({ error: 'Business activity is required.' });
    }

    // =========================================
    // GENERATE ORDER ID
    // =========================================
    const orderId = `ORD-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    // =========================================
    // CREATE TELR PAYMENT REQUEST
    // =========================================

    // Telr Hosted Payment Page API
    // Docs: https://telr.com/support/knowledge-base/hosted-payment-page-integration/
    const telrPayload = {
      method: 'create',
      store: process.env.TELR_STORE_ID,
      authkey: process.env.TELR_AUTH_KEY,
      order: {
        cartid: orderId,
        test: process.env.NODE_ENV === 'production' ? 0 : 1,
        amount: '149.00',
        currency: 'AED',
        description: 'UAE Business Setup Report — Personalized AI-Researched Analysis',
      },
      return: {
        authorised: `${process.env.BASE_URL}/report/thank-you?order_id=${orderId}`,
        declined: `${process.env.BASE_URL}/calculator?payment=declined`,
        cancelled: `${process.env.BASE_URL}/calculator?payment=cancelled`,
      },
      customer: {
        email: email.trim(),
        name: {
          forenames: name.trim().split(' ').slice(0, -1).join(' ') || name.trim(),
          surname: name.trim().split(' ').slice(-1)[0] || '',
        },
        phone: userInputs.phone || '',
      },
    };

    let checkoutUrl;

    try {
      // Call Telr API to create payment request
      const telrResponse = await fetch('https://secure.telr.com/gateway/order.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(telrPayload),
      });

      const telrData = await telrResponse.json();

      if (telrData.error) {
        console.error('[TELR] Error creating payment:', telrData.error);
        return res.status(502).json({
          error: 'Payment gateway error. Please try again.',
          detail: process.env.NODE_ENV === 'development' ? telrData.error : undefined,
        });
      }

      if (!telrData.order || !telrData.order.url) {
        console.error('[TELR] Unexpected response:', JSON.stringify(telrData));
        return res.status(502).json({ error: 'Payment gateway returned unexpected response.' });
      }

      checkoutUrl = telrData.order.url;

      // Save Telr order reference
      const telrOrderRef = telrData.order.ref;

      // =========================================
      // SAVE LEAD + ORDER TO DB
      // =========================================
      const sanitized = sanitizeInputs(userInputs);
      const order = {
        id: orderId,
        telrRef: telrOrderRef,
        email: email.trim(),
        name: name.trim(),
        amount: 14900, // AED 149.00 in fils
        currency: 'AED',
        status: 'pending',
        userInputs: sanitized,
        createdAt: new Date().toISOString(),
      };

      // Store lead + order in Postgres (best-effort)
      try {
        await pool.query(
          `INSERT INTO leads
            (name, email, phone, business_activity, setup_type, visas, office_type, nationality, pro_services, cost_estimate, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            sanitized.name || null,
            sanitized.email || null,
            sanitized.phone || null,
            sanitized.activity || null,
            sanitized.entityType || null,
            typeof sanitized.visaCount === 'number' ? sanitized.visaCount : null,
            sanitized.officePreference || null,
            sanitized.preferredEmirate || null,
            null, // pro_services not captured in checkout flow
            sanitized.budgetRange || null,
            'pending_payment',
          ]
        );

        await pool.query(
          `INSERT INTO orders
            (id, telr_ref, email, name, amount, currency, status, user_inputs)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            orderId,
            telrOrderRef,
            order.email,
            order.name,
            order.amount,
            order.currency,
            order.status,
            sanitized,
          ]
        );
      } catch (dbErr) {
        console.error('[CHECKOUT] Failed to save to DB:', dbErr.message);
      }

      orders.set(orderId, order);
      orders.set(`telr:${telrOrderRef}`, order);

      console.log(`[CHECKOUT] Order created: ${orderId}, Telr ref: ${telrOrderRef}`);

    } catch (fetchErr) {
      console.error('[TELR] Network error:', fetchErr.message);
      return res.status(502).json({
        error: 'Unable to reach payment gateway. Please try again later.',
      });
    }

    // =========================================
    // RETURN CHECKOUT URL
    // =========================================
    return res.status(200).json({
      checkout_url: checkoutUrl,
      order_id: orderId,
    });

  } catch (err) {
    next(err);
  }
});

// =========================================
// HELPERS
// =========================================

/**
 * Basic email validation
 */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Sanitize user inputs — strip anything unexpected, keep only known fields
 */
function sanitizeInputs(inputs) {
  const allowed = [
    'name', 'email', 'phone', 'activity', 'entityType',
    'visaCount', 'officePreference', 'preferredEmirate', 'budgetRange',
  ];

  const sanitized = {};
  for (const key of allowed) {
    if (inputs[key] !== undefined) {
      // Convert to string and trim, except numbers
      if (typeof inputs[key] === 'number') {
        sanitized[key] = inputs[key];
      } else if (typeof inputs[key] === 'string') {
        sanitized[key] = inputs[key].trim().substring(0, 200); // Max 200 chars per field
      }
    }
  }
  return sanitized;
}

// Export both router and orders store (for webhook access)
module.exports = router;
module.exports.orders = orders;
