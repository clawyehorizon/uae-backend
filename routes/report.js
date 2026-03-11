/**
 * routes/report.js — Report Download Endpoint
 *
 * Provides a signed-token-based download mechanism for PDF reports.
 * Tokens are generated when the report is delivered and are valid for 30 days.
 *
 * Flow:
 * 1. User receives email with download link containing signed token
 * 2. User clicks link → hits this endpoint
 * 3. We verify the token signature and expiry
 * 4. We regenerate or serve the cached PDF
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const { generateReport } = require('../services/report-generator');
const { orders } = require('./checkout');
const { getOrderById } = require('../db/orders');

// Token validity: 30 days
const TOKEN_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * GET /api/report/download/:token
 *
 * Verify the signed token and serve the PDF report.
 */
router.get('/download/:token', async (req, res, next) => {
  try {
    const { token } = req.params;

    // =========================================
    // VERIFY TOKEN
    // =========================================
    const verification = verifyDownloadToken(token);

    if (!verification.valid) {
      return res.status(403).json({
        error: verification.reason || 'Invalid or expired download token.',
        hint: 'If your link has expired, please contact support with your Report ID.',
      });
    }

    const { orderId } = verification;

    // =========================================
    // FIND ORDER
    // =========================================
    let order = orders.get(orderId);

    if (!order) {
      // Fallback to DB lookup
      try {
        order = await getOrderById(orderId);
      } catch (dbErr) {
        console.error('[REPORT] DB lookup failed:', dbErr.message);
      }
    }

    if (!order) {
      return res.status(404).json({
        error: 'Order not found.',
        hint: 'The report may no longer be available. Contact support with your Report ID.',
      });
    }

    if (order.status !== 'delivered') {
      return res.status(400).json({
        error: `Order status is "${order.status}". Report may still be processing.`,
        hint: 'Please wait a few minutes and try again. If the issue persists, contact support.',
      });
    }

    // =========================================
    // REGENERATE PDF
    // =========================================
    // In Phase 1, we regenerate on download rather than caching to S3.
    // Phase 2: serve from S3/R2 bucket for faster downloads.

    console.log(`[REPORT] Download requested for order ${orderId}`);

    const userInputs = order.userInputs || order.user_inputs;
    const { pdfBuffer } = await generateReport(userInputs);

    // Track download count
    order.downloadCount = (order.downloadCount || 0) + 1;
    order.lastDownloadAt = new Date().toISOString();

    // =========================================
    // SERVE PDF
    // =========================================
    const filename = `UAE-Business-Setup-Report-${userInputs?.name?.replace(/\s+/g, '-') || 'Report'}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Cache-Control', 'private, no-cache');

    return res.send(pdfBuffer);

  } catch (err) {
    next(err);
  }
});

// =========================================
// TOKEN VERIFICATION
// =========================================

/**
 * Verify a signed download token.
 *
 * Token format (base64url encoded): orderId:timestamp:signature
 *
 * @param {string} token - Base64url encoded token
 * @returns {{ valid: boolean, orderId?: string, reason?: string }}
 */
function verifyDownloadToken(token) {
  try {
    // Decode from base64url
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parts = decoded.split(':');

    if (parts.length < 3) {
      return { valid: false, reason: 'Malformed token.' };
    }

    // Reconstruct: last part is signature, everything before is payload
    const signature = parts.pop();
    const payload = parts.join(':');
    const [orderId, timestampStr] = [parts.slice(0, -1).join(':'), parts[parts.length - 1]];

    // Actually, parse more carefully: orderId may contain dashes
    // Format is: ORD-timestamp-hex:timestamp:signature
    // So split on the LAST two colons
    const lastColonIdx = decoded.lastIndexOf(':');
    const secondLastColonIdx = decoded.lastIndexOf(':', lastColonIdx - 1);

    if (lastColonIdx === -1 || secondLastColonIdx === -1) {
      return { valid: false, reason: 'Malformed token structure.' };
    }

    const extractedOrderId = decoded.substring(0, secondLastColonIdx);
    const extractedTimestamp = decoded.substring(secondLastColonIdx + 1, lastColonIdx);
    const extractedSignature = decoded.substring(lastColonIdx + 1);

    // Verify signature
    const secret = process.env.DOWNLOAD_TOKEN_SECRET;
    if (!secret) throw new Error('FATAL: DOWNLOAD_TOKEN_SECRET env var is required');
    const expectedPayload = `${extractedOrderId}:${extractedTimestamp}`;
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(expectedPayload)
      .digest('hex')
      .substring(0, 16);

    if (!crypto.timingSafeEqual(
      Buffer.from(extractedSignature, 'utf8'),
      Buffer.from(expectedSignature, 'utf8')
    )) {
      return { valid: false, reason: 'Invalid token signature.' };
    }

    // Check expiry
    const tokenTimestamp = parseInt(extractedTimestamp, 10);
    if (isNaN(tokenTimestamp)) {
      return { valid: false, reason: 'Invalid token timestamp.' };
    }

    const age = Date.now() - tokenTimestamp;
    if (age > TOKEN_VALIDITY_MS) {
      return { valid: false, reason: 'Token has expired (valid for 30 days).' };
    }

    if (age < 0) {
      return { valid: false, reason: 'Token timestamp is in the future.' };
    }

    return { valid: true, orderId: extractedOrderId };

  } catch (err) {
    console.error('[REPORT] Token verification error:', err.message);
    return { valid: false, reason: 'Token verification failed.' };
  }
}

module.exports = router;
