/**
 * services/report-generator.js — PDF Report Generator
 *
 * Loads the pricing database, calculates personalized costs,
 * renders the HTML template with Handlebars, and converts to PDF via Puppeteer.
 *
 * Pipeline:
 * 1. Calculate costs using cost-calculator.js
 * 2. Compile HTML template with Handlebars
 * 3. Launch Puppeteer, render HTML, export as PDF
 * 4. Return PDF buffer and report data
 */

const puppeteer = require('puppeteer');
const Handlebars = require('handlebars');
const fs = require('fs');
const path = require('path');

const { calculateCosts } = require('./cost-calculator');

// =========================================
// HANDLEBARS HELPERS
// =========================================

// Equality helper for conditional rendering
Handlebars.registerHelper('eq', function (a, b) {
  return a === b;
});

// Format number with commas
Handlebars.registerHelper('formatNum', function (num) {
  if (typeof num !== 'number') return num;
  return num.toLocaleString('en-US');
});

// Conditional confidence class
Handlebars.registerHelper('confidenceClass', function (level) {
  const classes = { high: 'confidence-high', medium: 'confidence-medium', low: 'confidence-low' };
  return classes[level] || 'confidence-medium';
});

// Confidence dots display
Handlebars.registerHelper('confidenceDots', function (level) {
  const dots = { high: '●●●', medium: '●●○', low: '●○○' };
  return dots[level] || '●●○';
});

// =========================================
// BROWSER INSTANCE MANAGEMENT
// =========================================

// Reuse browser instance across requests for better performance.
// In production with high volume, consider a browser pool.
let browserInstance = null;
let browserLaunchPromise = null;

/**
 * Get or create a shared Puppeteer browser instance.
 * Handles race conditions when multiple requests hit simultaneously.
 */
async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }

  // Prevent multiple simultaneous launches
  if (browserLaunchPromise) {
    return browserLaunchPromise;
  }

  browserLaunchPromise = puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',    // Prevent /dev/shm issues in Docker
      '--disable-gpu',               // Not needed for PDF rendering
      '--disable-extensions',
      '--font-render-hinting=none',  // Consistent font rendering
    ],
    // Timeout for browser launch (e.g., slow Docker start)
    timeout: 30000,
  });

  try {
    browserInstance = await browserLaunchPromise;

    // Handle unexpected disconnection
    browserInstance.on('disconnected', () => {
      console.warn('[PDF] Browser disconnected. Will relaunch on next request.');
      browserInstance = null;
    });

    console.log('[PDF] Browser launched successfully.');
    return browserInstance;
  } finally {
    browserLaunchPromise = null;
  }
}

// =========================================
// MAIN GENERATION FUNCTION
// =========================================

/**
 * Generate a personalized PDF report.
 *
 * @param {Object} userInputs - User's form data from the calculator
 * @returns {Promise<{ pdfBuffer: Buffer, reportData: Object }>}
 */
async function generateReport(userInputs) {
  const startTime = Date.now();

  // =========================================
  // STEP 1: Calculate personalized costs
  // =========================================
  console.log('[PDF] Calculating costs...');
  const reportData = calculateCosts(userInputs);

  // =========================================
  // STEP 2: Load and compile HTML template
  // =========================================
  const templatePath = path.join(__dirname, '..', '..', 'templates', 'report.html');

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Report template not found at ${templatePath}`);
  }

  const templateHtml = fs.readFileSync(templatePath, 'utf8');

  // Compile with Handlebars
  const template = Handlebars.compile(templateHtml, {
    strict: false, // Don't throw on missing variables
  });

  const renderedHtml = template(reportData);

  // =========================================
  // STEP 3: Render PDF with Puppeteer
  // =========================================
  console.log('[PDF] Rendering PDF...');
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // Set content and wait for all resources to load
    await page.setContent(renderedHtml, {
      waitUntil: 'networkidle0',
      timeout: 20000,
    });

    // Generate PDF
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: false,
      margin: {
        top: '20mm',
        bottom: '25mm',
        left: '15mm',
        right: '15mm',
      },
      // Display header/footer with watermark
      displayHeaderFooter: true,
      headerTemplate: '<div></div>', // Empty header
      footerTemplate: `
        <div style="
          width: 100%;
          font-size: 8px;
          font-family: Arial, sans-serif;
          color: #94a3b8;
          padding: 0 15mm;
          display: flex;
          justify-content: space-between;
          align-items: center;
        ">
          <span>Prepared for ${escapeHtml(reportData.userName)} — ${escapeHtml(reportData.userEmail)}</span>
          <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
        </div>
      `,
    });

    const elapsed = Date.now() - startTime;
    console.log(`[PDF] Generated successfully in ${elapsed}ms (${(pdfBuffer.length / 1024).toFixed(1)} KB)`);

    return { pdfBuffer, reportData };

  } finally {
    // Always close the page to free memory
    await page.close().catch(() => {});
  }
}

// =========================================
// CLEANUP
// =========================================

/**
 * Close the browser instance gracefully.
 * Call this on process exit.
 */
async function closeBrowser() {
  if (browserInstance) {
    try {
      await browserInstance.close();
      console.log('[PDF] Browser closed.');
    } catch (err) {
      console.error('[PDF] Error closing browser:', err.message);
    }
    browserInstance = null;
  }
}

// Graceful shutdown
process.on('SIGTERM', closeBrowser);
process.on('SIGINT', closeBrowser);

// =========================================
// HELPERS
// =========================================

/**
 * Escape HTML special characters (for footer template injection).
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// =========================================
// EXPORTS
// =========================================

module.exports = { generateReport, closeBrowser };
