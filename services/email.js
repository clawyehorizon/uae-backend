/**
 * services/email.js — SendGrid Email Service
 *
 * Sends the generated PDF report to the customer via email.
 * Uses SendGrid's API with dynamic templates for professional formatting.
 *
 * Features:
 * - PDF attachment (up to 10 MB)
 * - Dynamic template with personalized data
 * - Retry logic with exponential backoff
 * - Fallback plain text email if template fails
 */

const sgMail = require('@sendgrid/mail');

// Initialize SendGrid with API key
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
} else {
  console.warn('[EMAIL] SENDGRID_API_KEY not set. Email delivery will fail.');
}

// =========================================
// CONFIGURATION
// =========================================

const FROM_EMAIL = process.env.FROM_EMAIL || 'reports@ehorizon.ae';
const FROM_NAME = process.env.FROM_NAME || 'eHorizon Business Setup Reports';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000; // 5 seconds base delay (multiplied by attempt number)
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10 MB

// =========================================
// MAIN SEND FUNCTION
// =========================================

/**
 * Send the report PDF via email.
 *
 * @param {string} to - Recipient email address
 * @param {Buffer} pdfBuffer - PDF file as a Buffer
 * @param {Object} userData - User data for email personalization
 * @param {string} userData.name - User's full name
 * @param {string} userData.activity - Business activity
 * @param {Object} userData._computed - Computed report data
 * @param {string} userData._computed.recommended_zone - Recommended zone name
 * @param {string} userData._computed.total_cost - Formatted total cost
 * @param {string} userData._computed.download_url - Backup download URL
 *
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
async function sendReportEmail(to, pdfBuffer, userData) {
  // Validate inputs
  if (!to || !isValidEmail(to)) {
    throw new Error(`Invalid recipient email: ${to}`);
  }

  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
    throw new Error('Invalid PDF buffer');
  }

  if (pdfBuffer.length > MAX_ATTACHMENT_SIZE) {
    throw new Error(`PDF too large: ${(pdfBuffer.length / (1024 * 1024)).toFixed(1)} MB exceeds ${MAX_ATTACHMENT_SIZE / (1024 * 1024)} MB limit`);
  }

  if (!SENDGRID_API_KEY) {
    throw new Error('SendGrid API key not configured. Set SENDGRID_API_KEY env var.');
  }

  // Extract personalization data
  const firstName = userData.name?.split(' ')[0] || 'there';
  const computed = userData._computed || {};

  // =========================================
  // BUILD EMAIL MESSAGE
  // =========================================

  // Generate filename
  const safeName = (userData.name || 'Report').replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-');
  const filename = `UAE-Business-Setup-Report-${safeName}-${Date.now()}.pdf`;

  const msg = {
    to: to.trim(),
    from: {
      email: FROM_EMAIL,
      name: FROM_NAME,
    },
    subject: 'Your UAE Business Setup Report is Ready ✅',

    // If using a SendGrid dynamic template:
    ...(process.env.SENDGRID_TEMPLATE_ID ? {
      templateId: process.env.SENDGRID_TEMPLATE_ID,
      dynamicTemplateData: {
        first_name: firstName,
        activity: userData.activity || 'N/A',
        recommended_zone: computed.recommended_zone || 'N/A',
        total_cost: computed.total_cost || 'N/A',
        download_url: computed.download_url || '#',
        support_email: process.env.SUPPORT_EMAIL || 'support@ehorizon.ae',
        current_year: new Date().getFullYear(),
      },
    } : {
      // Fallback: plain HTML email (when no dynamic template configured)
      html: buildFallbackHtml(firstName, userData, computed),
      text: buildFallbackText(firstName, userData, computed),
    }),

    // PDF attachment
    attachments: [{
      content: pdfBuffer.toString('base64'),
      filename,
      type: 'application/pdf',
      disposition: 'attachment',
    }],

    // Tracking
    trackingSettings: {
      clickTracking: { enable: false },    // Don't rewrite links
      openTracking: { enable: true },      // Track opens
    },

    // Categories for SendGrid analytics
    categories: ['business-setup-report', 'premium-purchase'],
  };

  // =========================================
  // SEND WITH RETRY
  // =========================================
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const [response] = await sgMail.send(msg);

      console.log(`[EMAIL] Sent to ${to} (attempt ${attempt}/${MAX_RETRIES}), status: ${response.statusCode}`);

      return {
        success: true,
        messageId: response.headers?.['x-message-id'],
        statusCode: response.statusCode,
      };

    } catch (err) {
      lastError = err;
      const statusCode = err.code || err.response?.statusCode || 'unknown';

      console.error(
        `[EMAIL] Send failed (attempt ${attempt}/${MAX_RETRIES}): ` +
        `status=${statusCode}, error=${err.message}`
      );

      // Don't retry on client errors (4xx) — they won't succeed on retry
      if (err.response && err.response.statusCode >= 400 && err.response.statusCode < 500) {
        console.error(`[EMAIL] Client error (${err.response.statusCode}). Not retrying.`);
        break;
      }

      // Wait before retrying (exponential backoff)
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * attempt;
        console.log(`[EMAIL] Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  // All retries failed
  const errorMsg = lastError?.response?.body?.errors?.[0]?.message
    || lastError?.message
    || 'Unknown SendGrid error';

  throw new Error(`Failed to send email after ${MAX_RETRIES} attempts: ${errorMsg}`);
}

// =========================================
// FALLBACK EMAIL TEMPLATES
// =========================================

/**
 * Build fallback HTML email (used when no SendGrid dynamic template is configured).
 */
function buildFallbackHtml(firstName, userData, computed) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; color: #1e293b; line-height: 1.6; max-width: 600px; margin: 0 auto; }
    .header { background: #0f172a; color: white; padding: 24px; text-align: center; border-radius: 8px 8px 0 0; }
    .header h1 { margin: 0; font-size: 20px; }
    .content { padding: 24px; background: #f8fafc; border: 1px solid #e2e8f0; }
    .highlight { background: #d1fae5; border: 1px solid #059669; padding: 16px; border-radius: 8px; margin: 16px 0; }
    .highlight strong { color: #059669; }
    .cta { display: inline-block; background: #1d4ed8; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold; margin: 16px 0; }
    .footer { padding: 16px; text-align: center; font-size: 12px; color: #94a3b8; }
    .stats { display: flex; gap: 20px; justify-content: center; margin: 16px 0; }
    .stat { text-align: center; }
    .stat-value { font-size: 24px; font-weight: bold; color: #1d4ed8; }
    .stat-label { font-size: 12px; color: #64748b; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Your UAE Business Setup Report is Ready ✅</h1>
  </div>
  <div class="content">
    <p>Hi ${escapeHtml(firstName)},</p>
    <p>Great news! Your personalized UAE business setup report has been generated and is attached to this email as a PDF.</p>

    <div class="highlight">
      <strong>Our Recommendation:</strong> ${escapeHtml(computed.recommended_zone || 'See attached report')}<br>
      <strong>Estimated Total Cost:</strong> AED ${escapeHtml(computed.total_cost || 'See report')}<br>
      <strong>Business Activity:</strong> ${escapeHtml(userData.activity || 'N/A')}
    </div>

    <p>Your report includes:</p>
    <ul>
      <li>📊 Detailed cost breakdown (line-by-line)</li>
      <li>🏢 Top 5 zone comparison tailored to your profile</li>
      <li>📋 Step-by-step setup guide with timeline</li>
      <li>📑 Document checklist</li>
      <li>⚠️ Hidden costs to watch for</li>
      <li>⚖️ Mainland vs. Free Zone analysis</li>
    </ul>

    ${computed.download_url ? `
    <p>If you can't open the attachment, use this backup download link:</p>
    <p><a href="${escapeHtml(computed.download_url)}" class="cta">Download Your Report</a></p>
    <p style="font-size: 12px; color: #94a3b8;">Link valid for 30 days.</p>
    ` : ''}

    <hr style="border: 1px solid #e2e8f0; margin: 24px 0;">

    <p><strong>Need help with the next step?</strong></p>
    <p>Book a free 15-minute consultation with our business setup experts:</p>
    <p><a href="${process.env.CONSULTATION_URL || 'https://ehorizon.ae/consultation'}" class="cta">Book Free Consultation</a></p>

    <p>Questions about your report? Reply to this email — we're here to help!</p>

    <p>Best regards,<br>The eHorizon Solutions Team</p>
  </div>
  <div class="footer">
    <p>© ${new Date().getFullYear()} eHorizon Solutions. All rights reserved.</p>
    <p>${process.env.SUPPORT_EMAIL || 'support@ehorizon.ae'}</p>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Build fallback plain text email.
 */
function buildFallbackText(firstName, userData, computed) {
  return `
Hi ${firstName},

Your UAE Business Setup Report is ready! 🎉

Our Recommendation: ${computed.recommended_zone || 'See attached report'}
Estimated Total Cost: AED ${computed.total_cost || 'See report'}
Business Activity: ${userData.activity || 'N/A'}

Your PDF report is attached to this email. It includes:
• Detailed cost breakdown (line-by-line)
• Top 5 zone comparison tailored to your profile
• Step-by-step setup guide with timeline
• Document checklist
• Hidden costs to watch for
• Mainland vs. Free Zone analysis

${computed.download_url ? `Backup download link: ${computed.download_url}\n(Valid for 30 days)\n` : ''}

Need help with the next step?
Book a free consultation: ${process.env.CONSULTATION_URL || 'https://ehorizon.ae/consultation'}

Questions? Reply to this email — we're here to help!

Best regards,
The eHorizon Solutions Team
${process.env.SUPPORT_EMAIL || 'support@ehorizon.ae'}
  `.trim();
}

// =========================================
// HELPERS
// =========================================

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =========================================
// EXPORTS
// =========================================

module.exports = { sendReportEmail };
