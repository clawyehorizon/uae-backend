/**
 * routes/estimate.js — Quick Cost Estimate Endpoint
 *
 * Provides real-time cost estimates using the pricing database.
 * Called by the frontend calculator to replace hardcoded ranges
 * with actual zone-specific pricing data.
 *
 * POST /api/estimate
 * Body: { activity, setupType, visaCount, officePreference, zoneTier, proServices, familyVisas }
 * Returns: { low, high, typical, breakdown, zoneBreakdown, ... }
 */

const express = require('express');
const router = express.Router();

const { quickEstimate, ZONE_TIERS } = require('../services/cost-calculator');

/**
 * POST /api/estimate
 *
 * Returns a quick cost estimate based on partial user inputs.
 * Uses real pricing data from pricing-database.json.
 */
router.post('/', (req, res) => {
  try {
    const {
      activity,
      setupType,
      visaCount,
      officePreference,
      zoneTier,
      proServices,
      familyVisas,
    } = req.body;

    // Basic validation
    if (!activity && !setupType) {
      return res.status(400).json({
        error: 'At least one of "activity" or "setupType" is required.',
      });
    }

    const estimate = quickEstimate({
      activity: activity || 'consulting',
      setupType: setupType || 'freezone',
      visaCount: visaCount != null ? visaCount : 1,
      officePreference: officePreference || 'flexi_desk',
      zoneTier: zoneTier || 'any',
      proServices: proServices || 'not-sure',
      familyVisas: familyVisas || false,
    });

    res.json(estimate);

  } catch (err) {
    console.error('[ESTIMATE] Error:', err.message);
    res.status(500).json({
      error: 'Failed to calculate estimate. Please try again.',
    });
  }
});

/**
 * GET /api/estimate/tiers
 *
 * Returns available zone tier options for the frontend selector.
 */
router.get('/tiers', (req, res) => {
  res.json({ tiers: ZONE_TIERS });
});

module.exports = router;
