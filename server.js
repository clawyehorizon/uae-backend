/**
 * server.js â€” Express application entry point
 *
 * eHorizon Solutions UAE Business Setup Calculator Backend
 *
 * Handles:
 * - Payment checkout sessions (Telr)
 * - Payment webhook processing
 * - PDF report generation and delivery
 * - Signed report download links
 */

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

// Import routes
const checkoutRoutes = require('./routes/checkout');
const webhookRoutes = require('./routes/webhooks');
const reportRoutes = require('./routes/report');
const leadsRoutes = require('./routes/leads');
const migrateRoutes = require('./routes/migrate');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for Railway/production deployment (fixes rate limiter crash)
app.set('trust proxy', 1);


// =========================================
// SECURITY MIDDLEWARE
// =========================================

// Helmet: secure HTTP headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  // Allow cross-origin for API usage
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// CORS: allow frontend origin
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
    : ['http://localhost:3000'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// =========================================
// RATE LIMITING
// =========================================

// General API rate limit: 100 requests per 15 minutes per IP
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests. Please try again later.',
    retryAfter: '15 minutes',
  },
});

// Checkout rate limit: 10 attempts per 15 minutes per IP (stricter)
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many checkout attempts. Please try again later.',
    retryAfter: '15 minutes',
  },
});

// Apply general limiter to all routes
app.use(generalLimiter);

// =========================================
// BODY PARSING
// =========================================

// Webhooks need raw body for signature verification â€” handle before JSON parser
// The webhook route uses its own raw body parser internally
app.use('/api/webhooks', webhookRoutes);

// JSON body parser for all other routes
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// =========================================
// ROUTES
// =========================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ehorizon-biz-setup-backend',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Checkout: create payment session
app.use('/api/checkout', checkoutLimiter, checkoutRoutes);

// Report: download via signed token
app.use('/api/report', reportRoutes);

// Leads: capture form leads
app.use('/api/leads', leadsRoutes);

// Migrate: one-time database setup (DISABLE after first run)
app.use('/api/migrate', migrateRoutes);

// =========================================
// ERROR HANDLING
// =========================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.originalUrl,
  });
});

// Global error handler
app.use((err, req, res, _next) => {
  console.error(`[ERROR] ${err.message}`, {
    stack: err.stack,
    path: req.originalUrl,
    method: req.method,
    timestamp: new Date().toISOString(),
  });

  // Don't leak internal errors to client
  const statusCode = err.statusCode || 500;
  const message = statusCode === 500
    ? 'Internal server error. Please try again later.'
    : err.message;

  res.status(statusCode).json({ error: message });
});

// =========================================
// START SERVER
// =========================================

app.listen(PORT, () => {
  console.log(`[SERVER] eHorizon Business Setup API running on port ${PORT}`);
  console.log(`[SERVER] Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[SERVER] Health check: http://localhost:${PORT}/api/health`);
});

module.exports = app;