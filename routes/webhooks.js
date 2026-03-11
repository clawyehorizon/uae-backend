/**
 * routes/webhooks.js — Telr Webhook Handler
 *
 * Handles payment notification callbacks from Telr.
 * When a payment is successful:
 * 1. Verify the webhook authenticity
 * 2. Generate the personalized PDF report
 * 3. Send the report via email
 * 4. Update the order status
 *
 * Telr webhook flow:
 * - Telr POSTs a notification to our webhook URL after payment
 * - We verify the transaction by calling Telr's check API
 * - We process the order if payment was authorized
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const { generateReport } = require('../services/report-generator');
const { sendReportEmail } = require('../services/email');
const { orders } = require('./checkout');
const { pool } = require('../db');

// =========================================
// TELR WEBHOOK
// =========================================

/**
 * POST /api/webhooks/telr
 *
 * Telr sends a POST with the transaction reference.
 * We verify by calling Telr's check API, then process.
 */
router.post('/telr', express.json(), async (req, res) => {
  try {
    const { tran_ref, cart_id } = req.body;

    console.log(`[WEBHOOK] Received Telr notification: tran_ref=${tran_ref}, cart_id=${cart_id}`);

    // Acknowledge receipt immediately — Telr expects a quick response
    res.status(200).json({ received: true });

    // =========================================
    // VERIFY TRANSACTION WITH TELR
    // =========================================
    let order = orders.get(cart_id) || orders.get(`telr:${tran_ref}`);

    if (!order) {
      // Fallback to DB lookup
      try {
        const { getOrderById, getOrderByTelrRef } = require('../db/orders');
        order = await getOrderById(cart_id) || await getOrderByTelrRef(tran_ref);
      } catch (dbErr) {
        console.error('[WEBHOOK] Failed to lookup order in DB:', dbErr.message);
      }
    }

    if (!order) {
      console.error(`[WEBHOOK] Order not found for cart_id=${cart_id}, tran_ref=${tran_ref}`);
      return;
    }

    // Normalize order object in case it came from DB (snake_case)
    if (order.user_inputs && !order.userInputs) {
      order.userInputs = order.user_inputs;
    }

    // Idempotency: skip if already processed
    if (order.status === 'delivered' || order.status === 'processing') {
      console.log(`[WEBHOOK] Order ${order.id} already ${order.status}, skipping.`);
      return;
    }

    // Call Telr's check API to verify the payment status
    let paymentVerified = false;
    try {
      const checkPayload = {
        method: 'check',
        store: process.env.TELR_STORE_ID,
        authkey: process.env.TELR_AUTH_KEY,
        order: {
          ref: tran_ref || order.telrRef,
        },
      };

      const checkResponse = await fetch('https://secure.telr.com/gateway/order.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(checkPayload),
      });

      const checkData = await checkResponse.json();

      if (checkData.order && checkData.order.status) {
        const status = checkData.order.status;
        // Telr status codes: A = Authorised, H = Held, P = Pending, D = Declined, E = Expired
        if (status.code === 3 || status.text === 'Paid') {
          paymentVerified = true;
          console.log(`[WEBHOOK] Payment verified for order ${order.id}`);
        } else {
          console.log(`[WEBHOOK] Payment not successful for order ${order.id}: status=${status.text} (${status.code})`);
          order.status = 'payment_failed';
          order.telrStatus = status;
          try {
            await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['payment_failed', order.id]);
          } catch (dbErr) {
            console.error('[WEBHOOK] Failed to update order status:', dbErr.message);
          }
          return;
        }
      } else if (checkData.error) {
        console.error(`[WEBHOOK] Telr check error:`, checkData.error);
        // If we can't verify, still try to process if we trust the webhook
        // In production, you might want to reject here
        paymentVerified = process.env.TELR_TRUST_WEBHOOK === 'true';
      }
    } catch (verifyErr) {
      console.error(`[WEBHOOK] Telr verification failed:`, verifyErr.message);
      // Fall through — we'll attempt processing but flag it
      order.verificationError = verifyErr.message;
    }

    if (!paymentVerified) {
      console.error(`[WEBHOOK] Payment not verified for order ${order.id}. Skipping report generation.`);
      order.status = 'verification_failed';
      try {
        await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['verification_failed', order.id]);
      } catch (dbErr) {
        console.error('[WEBHOOK] Failed to update order status:', dbErr.message);
      }
      notifyAdmin(`Payment verification failed for order ${order.id}. Manual review needed.`);
      return;
    }

    // =========================================
    // GENERATE AND DELIVER REPORT
    // =========================================
    order.status = 'processing';
    order.processStartedAt = new Date().toISOString();
    try {
      await pool.query('UPDATE orders SET status = $1, process_started_at = NOW() WHERE id = $2', ['processing', order.id]);
    } catch (dbErr) {
      console.error('[WEBHOOK] Failed to update order processing status:', dbErr.message);
    }

    try {
      console.log(`[WEBHOOK] Generating report for order ${order.id}...`);

      // Generate the PDF report
      const { pdfBuffer, reportData } = await generateReport(order.userInputs);

      console.log(`[WEBHOOK] PDF generated (${(pdfBuffer.length / 1024).toFixed(1)} KB). Sending email...`);

      // Generate a signed download token for backup download
      const downloadToken = generateDownloadToken(order.id);
      order.downloadToken = downloadToken;

      // Add computed data for email template
      const emailData = {
        ...order.userInputs,
        _computed: {
          recommended_zone: reportData.recommendedZone,
          total_cost: reportData.totalCost,
          download_url: `${process.env.BASE_URL}/api/report/download/${downloadToken}`,
        },
      };

      // Send the report via email
      await sendReportEmail(order.email, pdfBuffer, emailData);

      // Update order status
      order.status = 'delivered';
      order.deliveredAt = new Date().toISOString();
      order.pdfSizeBytes = pdfBuffer.length;

      try {
        await pool.query(
          'UPDATE orders SET status = $1, delivered_at = NOW(), pdf_size_bytes = $2, download_token = $3 WHERE id = $4',
          ['delivered', pdfBuffer.length, order.downloadToken, order.id]
        );
      } catch (dbErr) {
        console.error('[WEBHOOK] Failed to update order status in DB:', dbErr.message);
      }

      // Best-effort: update lead status in DB
      try {
        await pool.query(
          'UPDATE leads SET status = $1 WHERE email = $2',
          ['paid', order.email]
        );
      } catch (dbErr) {
        console.error('[WEBHOOK] Failed to update lead status:', dbErr.message);
      }

      const processingTime = Date.now() - new Date(order.processStartedAt).getTime();
      console.log(`[WEBHOOK] Report delivered for order ${order.id} in ${processingTime}ms`);

    } catch (genErr) {
      console.error(`[WEBHOOK] Report generation/delivery failed for order ${order.id}:`, genErr);
      order.status = 'failed';
      order.error = genErr.message;
      try {
        await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['failed', order.id]);
      } catch (dbErr) {
        console.error('[WEBHOOK] Failed to update order failure status:', dbErr.message);
      }

      // Alert admin about the failure
      notifyAdmin(`Report delivery failed for order ${order.id}: ${genErr.message}`);
    }

  } catch (err) {
    console.error('[WEBHOOK] Unhandled error:', err);
    // We already sent 200, so just log
  }
});

// =========================================
// HELPERS
// =========================================

/**
 * Generate a signed download token for the report
 * Token format: orderId:timestamp:signature
 * Valid for 30 days
 */
function generateDownloadToken(orderId) {
  const timestamp = Date.now();
  const payload = `${orderId}:${timestamp}`;
  const secret = process.env.DOWNLOAD_TOKEN_SECRET;
  if (!secret) throw new Error('FATAL: DOWNLOAD_TOKEN_SECRET env var is required');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')
    .substring(0, 16); // Shortened for URL friendliness

  // Base64url encode the token
  const token = Buffer.from(`${payload}:${signature}`).toString('base64url');
  return token;
}

/**
 * Notify admin about critical events
 * In production: send email, Slack, or Telegram notification
 */
async function notifyAdmin(message) {
  console.warn(`[ADMIN ALERT] ${message}`);

  // TODO: Implement admin notification
  // Options:
  // - Send email via SendGrid to ADMIN_EMAIL
  // - Send Telegram message
  // - Send Slack webhook
  // For now, just log. The OpenClaw cron can monitor logs.
}

module.exports = router;
