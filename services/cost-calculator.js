/**
 * services/cost-calculator.js — Core Pricing Logic
 *
 * Takes user inputs (activity, visa count, office preference, etc.)
 * and returns a personalized cost breakdown with zone comparison.
 *
 * Features:
 * - Reads pricing-database.json
 * - Applies activity multipliers and adjustments
 * - Calculates per-zone totals (Year 1 + Renewal)
 * - Ranks top 5 zones for the user's profile
 * - Returns structured data ready for PDF template
 */

const fs = require('fs');
const path = require('path');

// =========================================
// CONFIGURATION
// =========================================

// Activity type mappings: normalize user input to pricing DB keys
const ACTIVITY_MAP = {
  // Direct matches
  trading: 'trading',
  services: 'services',
  consulting: 'consulting',
  technology: 'technology',
  ecommerce: 'ecommerce',
  media: 'media',
  retail: 'retail',
  industrial: 'industrial',
  financial_services: 'financial_services',

  // Aliases
  it: 'technology',
  tech: 'technology',
  software: 'technology',
  'it consulting': 'consulting',
  'management consulting': 'consulting',
  'business consulting': 'consulting',
  'e-commerce': 'ecommerce',
  'online business': 'ecommerce',
  'digital marketing': 'services',
  marketing: 'services',
  design: 'services',
  'graphic design': 'media',
  'content creation': 'media',
  import_export: 'trading',
  'import/export': 'trading',
  'general trading': 'general_trading',
  manufacturing: 'industrial',
  fintech: 'technology',
  finance: 'financial_services',
};

// Office preference mappings
const OFFICE_MAP = {
  flexi_desk: 'flexi_desk',
  flexi: 'flexi_desk',
  virtual: 'flexi_desk',
  shared: 'shared_office',
  shared_office: 'shared_office',
  coworking: 'shared_office',
  physical: 'physical_office',
  private: 'physical_office',
  physical_office: 'physical_office',
};

// Zone scoring weights for ranking
const SCORING_WEIGHTS = {
  cost: 0.35,           // Lower cost = higher score
  location: 0.20,       // Preferred emirate match
  officeMatch: 0.15,    // Office type availability
  confidence: 0.15,     // Data confidence level
  reputation: 0.15,     // Zone reputation/prestige
};

// Zone reputation scores (subjective, based on market perception)
const ZONE_REPUTATION = {
  dmcc: 0.95,
  difc: 0.98,
  adgm: 0.90,
  ifza: 0.75,
  rakez: 0.70,
  meydan: 0.80,
  dso: 0.78,
  shams: 0.65,
  ajman: 0.60,
  saif: 0.65,
  dubai_ded: 0.85,
};

// =========================================
// MAIN CALCULATION FUNCTION
// =========================================

/**
 * Calculate personalized costs for all zones and rank them.
 *
 * @param {Object} userInputs - User's form data
 * @param {string} userInputs.activity - Business activity type
 * @param {number} userInputs.visaCount - Number of visas needed
 * @param {string} userInputs.officePreference - Office type preference
 * @param {string} userInputs.preferredEmirate - Preferred emirate
 * @param {string} userInputs.budgetRange - Budget range (e.g., "20000-40000")
 * @param {string} userInputs.entityType - Entity type
 * @param {string} userInputs.name - User's name
 * @param {string} userInputs.email - User's email
 *
 * @returns {Object} Report data structure for the PDF template
 */
function calculateCosts(userInputs) {
  // Load pricing database
  const dbPath = path.join(__dirname, '..', 'data', 'pricing-database.json');

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Pricing database not found at ${dbPath}`);
  }

  const pricingDb = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

  // Normalize inputs
  const activity = normalizeActivity(userInputs.activity);
  const visaCount = Math.max(0, Math.min(20, parseInt(userInputs.visaCount, 10) || 1));
  const officePreference = normalizeOffice(userInputs.officePreference);
  const preferredEmirate = (userInputs.preferredEmirate || '').toLowerCase().trim();
  const budget = parseBudget(userInputs.budgetRange);

  // =========================================
  // CALCULATE COSTS FOR EACH ZONE
  // =========================================
  const zoneResults = [];

  // Process free zones
  for (const zone of pricingDb.zones) {
    const result = calculateZoneCost(zone, activity, visaCount, officePreference);
    if (result) {
      result.zoneType = 'freezone';
      zoneResults.push(result);
    }
  }

  // Process mainland
  if (pricingDb.mainland && pricingDb.mainland.dubai_ded) {
    const mainlandResult = calculateZoneCost(
      pricingDb.mainland.dubai_ded,
      activity,
      visaCount,
      officePreference
    );
    if (mainlandResult) {
      mainlandResult.zoneType = 'mainland';
      zoneResults.push(mainlandResult);
    }
  }

  // =========================================
  // RANK ZONES
  // =========================================
  const rankedZones = rankZones(zoneResults, preferredEmirate, budget, officePreference);

  // =========================================
  // BUILD REPORT DATA
  // =========================================
  const topZone = rankedZones[0];
  if (!topZone) {
    throw new Error('No suitable zones found for the given criteria.');
  }

  const reportData = buildReportData(
    userInputs,
    topZone,
    rankedZones.slice(0, 5),
    pricingDb,
    activity,
    visaCount,
    officePreference
  );

  return reportData;
}

// =========================================
// ZONE COST CALCULATION
// =========================================

/**
 * Calculate total Year 1 and renewal costs for a single zone.
 */
function calculateZoneCost(zone, activity, visaCount, officePreference) {
  const pricing = zone.pricing;
  if (!pricing) return null;

  // Check if zone supports this activity
  const supportedActivities = zone.supported_activities || [];
  // Use fallback activity if exact match not found
  let resolvedActivity = activity;
  if (!supportedActivities.includes(activity)) {
    // Try fallback: consulting → services, ecommerce → trading, etc.
    const fallbacks = {
      consulting: 'services',
      technology: 'services',
      ecommerce: 'trading',
      media: 'services',
      general_trading: 'trading',
    };
    resolvedActivity = fallbacks[activity] || 'services';
    if (!supportedActivities.includes(resolvedActivity)) {
      // Zone doesn't support this activity at all
      return null;
    }
  }

  const costs = {
    year1: { items: [], total: 0 },
    renewal: { items: [], total: 0 },
  };

  // ---- LICENSE FEE ----
  const licenseFees = pricing.license_fees || {};
  const licenseEntry = licenseFees[resolvedActivity] || licenseFees[activity]
    || licenseFees.services || licenseFees.trading;

  if (licenseEntry) {
    const licenseCost = licenseEntry.value || 0;
    costs.year1.items.push({
      description: `License Fee (${formatActivity(resolvedActivity)})`,
      cost: licenseCost,
      frequency: licenseEntry.frequency || 'annual',
      confidence: licenseEntry.confidence || 'medium',
      verifiedDate: licenseEntry.last_verified || 'N/A',
      category: 'license',
    });
    costs.year1.total += licenseCost;

    // Renewal: same license fee annually
    costs.renewal.items.push({
      description: `License Fee Renewal`,
      cost: licenseCost,
      frequency: 'annual',
      confidence: licenseEntry.confidence || 'medium',
      verifiedDate: licenseEntry.last_verified || 'N/A',
      category: 'license',
    });
    costs.renewal.total += licenseCost;
  }

  // ---- VISA COSTS ----
  if (visaCount > 0) {
    const visaCosts = pricing.visa_costs || {};
    const visaPerPerson = (visaCosts.employment_visa?.value || 0)
      + (visaCosts.medical_fitness?.value || 0)
      + (visaCosts.emirates_id?.value || 0);
    const visaDeposit = visaCosts.visa_deposit?.value || 0;

    const totalVisaCost = visaPerPerson * visaCount;
    const totalVisaDeposit = visaDeposit * visaCount;

    if (totalVisaCost > 0) {
      costs.year1.items.push({
        description: `Employment Visa (×${visaCount})`,
        cost: totalVisaCost,
        frequency: 'one-time per visa',
        confidence: visaCosts.employment_visa?.confidence || 'medium',
        verifiedDate: visaCosts.employment_visa?.last_verified || 'N/A',
        category: 'visa',
      });
      costs.year1.total += totalVisaCost;
    }

    if (totalVisaDeposit > 0) {
      costs.year1.items.push({
        description: `Visa Deposit (×${visaCount}, refundable)`,
        cost: totalVisaDeposit,
        frequency: 'one-time (refundable)',
        confidence: visaCosts.visa_deposit?.confidence || 'medium',
        verifiedDate: visaCosts.visa_deposit?.last_verified || 'N/A',
        category: 'visa',
      });
      costs.year1.total += totalVisaDeposit;
    }

    // Visa renewal is typically every 2–3 years; annualize at ~50% of initial
    const annualVisaRenewal = Math.round(totalVisaCost * 0.5);
    if (annualVisaRenewal > 0) {
      costs.renewal.items.push({
        description: `Visa Renewal Reserve (annualized)`,
        cost: annualVisaRenewal,
        frequency: 'annual (estimated)',
        confidence: 'low',
        verifiedDate: 'N/A',
        category: 'visa',
      });
      costs.renewal.total += annualVisaRenewal;
    }
  }

  // ---- OFFICE COSTS ----
  const officeCosts = pricing.office_costs || {};
  // Try preferred office type, then fallback
  const officeEntry = officeCosts[officePreference]
    || officeCosts.flexi_desk
    || officeCosts.shared_office
    || officeCosts.physical_office;

  if (officeEntry && officeEntry.value > 0) {
    costs.year1.items.push({
      description: `Office (${formatOffice(officePreference)})`,
      cost: officeEntry.value,
      frequency: officeEntry.frequency || 'annual',
      confidence: officeEntry.confidence || 'medium',
      verifiedDate: officeEntry.last_verified || 'N/A',
      category: 'office',
    });
    costs.year1.total += officeEntry.value;

    costs.renewal.items.push({
      description: `Office Renewal`,
      cost: officeEntry.value,
      frequency: 'annual',
      confidence: officeEntry.confidence || 'medium',
      verifiedDate: officeEntry.last_verified || 'N/A',
      category: 'office',
    });
    costs.renewal.total += officeEntry.value;
  }

  // ---- GOVERNMENT FEES ----
  const govFees = pricing.government_fees || {};
  let govYear1 = 0;
  let govRenewal = 0;

  for (const [key, entry] of Object.entries(govFees)) {
    if (!entry || typeof entry.value !== 'number') continue;

    // Skip share capital from total (it's special)
    if (key === 'share_capital') continue;

    costs.year1.items.push({
      description: `${formatFeeKey(key)}`,
      cost: entry.value,
      frequency: entry.frequency || 'one-time',
      confidence: entry.confidence || 'medium',
      verifiedDate: entry.last_verified || 'N/A',
      category: 'government',
    });
    govYear1 += entry.value;

    // Annual fees repeat on renewal; one-time fees don't
    if (entry.frequency === 'annual') {
      govRenewal += entry.value;
      costs.renewal.items.push({
        description: `${formatFeeKey(key)} (renewal)`,
        cost: entry.value,
        frequency: 'annual',
        confidence: entry.confidence || 'medium',
        verifiedDate: entry.last_verified || 'N/A',
        category: 'government',
      });
    }
  }

  costs.year1.total += govYear1;
  costs.renewal.total += govRenewal;

  // ---- PRO FEES ----
  const proFees = pricing.pro_fees || {};
  let proYear1 = 0;
  let proRenewal = 0;

  for (const [key, entry] of Object.entries(proFees)) {
    if (!entry || typeof entry.value !== 'number' || entry.value === 0) continue;

    costs.year1.items.push({
      description: `${formatFeeKey(key)}`,
      cost: entry.value,
      frequency: entry.frequency || 'one-time',
      confidence: entry.confidence || 'medium',
      verifiedDate: entry.last_verified || 'N/A',
      category: 'pro',
    });
    proYear1 += entry.value;

    if (entry.frequency === 'annual') {
      proRenewal += entry.value;
      costs.renewal.items.push({
        description: `${formatFeeKey(key)} (renewal)`,
        cost: entry.value,
        frequency: 'annual',
        confidence: entry.confidence || 'medium',
        verifiedDate: entry.last_verified || 'N/A',
        category: 'pro',
      });
    }
  }

  costs.year1.total += proYear1;
  costs.renewal.total += proRenewal;

  // ---- LOCAL SERVICE AGENT (Mainland only) ----
  if (pricing.local_service_agent && pricing.local_service_agent.annual_fee) {
    const lsaFee = pricing.local_service_agent.annual_fee.value || 0;
    if (lsaFee > 0) {
      costs.year1.items.push({
        description: 'Local Service Agent (annual)',
        cost: lsaFee,
        frequency: 'annual',
        confidence: pricing.local_service_agent.annual_fee.confidence || 'medium',
        verifiedDate: pricing.local_service_agent.annual_fee.last_verified || 'N/A',
        category: 'pro',
      });
      costs.year1.total += lsaFee;

      costs.renewal.items.push({
        description: 'Local Service Agent (renewal)',
        cost: lsaFee,
        frequency: 'annual',
        confidence: 'medium',
        verifiedDate: 'N/A',
        category: 'pro',
      });
      costs.renewal.total += lsaFee;
    }
  }

  // ---- HIDDEN COSTS BUFFER (5%) ----
  const buffer = Math.round(costs.year1.total * 0.05);

  return {
    zoneId: zone.zone_id,
    zoneName: zone.zone_name,
    emirate: zone.emirate,
    website: zone.website,
    costs,
    totalYear1: costs.year1.total,
    totalYear1WithBuffer: costs.year1.total + buffer,
    buffer,
    renewalCost: costs.renewal.total,
    overallConfidence: calculateOverallConfidence(costs.year1.items),
    pros: zone.pros || [],
    cons: zone.cons || [],
    packages: zone.packages || [],
  };
}

// =========================================
// ZONE RANKING
// =========================================

/**
 * Rank zones by a weighted scoring system.
 */
function rankZones(zoneResults, preferredEmirate, budget, officePreference) {
  if (zoneResults.length === 0) return [];

  // Find cost range for normalization
  const costs = zoneResults.map(z => z.totalYear1WithBuffer);
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);
  const costRange = maxCost - minCost || 1;

  // Score each zone
  const scored = zoneResults.map(zone => {
    let score = 0;

    // Cost score: lower is better (inverted, 0-1)
    const costScore = 1 - (zone.totalYear1WithBuffer - minCost) / costRange;
    score += costScore * SCORING_WEIGHTS.cost;

    // Location score: match preferred emirate
    const locationScore = preferredEmirate
      ? (zone.emirate?.toLowerCase() === preferredEmirate ? 1.0 : 0.3)
      : 0.5; // No preference = neutral
    score += locationScore * SCORING_WEIGHTS.location;

    // Office match: does zone have the preferred office type?
    const zoneOfficeTypes = Object.keys(zone.costs.year1.items
      .filter(i => i.category === 'office')
      .reduce((acc, i) => { acc[i.description] = true; return acc; }, {}));
    const officeScore = zone.costs.year1.items.some(i => i.category === 'office') ? 0.8 : 0.4;
    score += officeScore * SCORING_WEIGHTS.officeMatch;

    // Confidence score
    const confMap = { high: 1.0, medium: 0.6, low: 0.3 };
    const confidenceScore = confMap[zone.overallConfidence] || 0.5;
    score += confidenceScore * SCORING_WEIGHTS.confidence;

    // Reputation score
    const reputationScore = ZONE_REPUTATION[zone.zoneId] || 0.5;
    score += reputationScore * SCORING_WEIGHTS.reputation;

    // Budget fit bonus: if within budget range, add bonus
    if (budget.max > 0) {
      if (zone.totalYear1WithBuffer <= budget.max && zone.totalYear1WithBuffer >= budget.min) {
        score += 0.1; // Bonus for fitting budget
      } else if (zone.totalYear1WithBuffer > budget.max) {
        score -= 0.05; // Slight penalty for exceeding budget
      }
    }

    return { ...zone, score };
  });

  // Sort by score (descending)
  scored.sort((a, b) => b.score - a.score);

  // Assign ranks and match scores (stars)
  return scored.map((zone, index) => ({
    ...zone,
    rank: index + 1,
    matchScore: scoreToStars(zone.score),
  }));
}

// =========================================
// REPORT DATA BUILDER
// =========================================

/**
 * Build the complete data object for the Handlebars PDF template.
 */
function buildReportData(userInputs, topZone, top5Zones, pricingDb, activity, visaCount, officePreference) {
  // Aggregate cost categories for summary table
  const categoryCosts = aggregateByCat(topZone.costs.year1.items);

  // Year comparison
  const yearComparison = buildYearComparison(topZone);

  // Mainland comparison (find mainland result)
  const mainlandZone = top5Zones.find(z => z.zoneType === 'mainland');
  const freezoneTop = top5Zones.find(z => z.zoneType === 'freezone') || topZone;

  // Determine setup timeline based on zone type
  const setupTimeline = topZone.zoneType === 'mainland' ? '4–6 weeks' : '2–4 weeks';

  // Build mainland vs freezone advice
  const mainlandVsFreezoneAdvice = buildMainlandAdvice(userInputs, topZone, mainlandZone, freezoneTop);

  return {
    // User data
    userName: userInputs.name || 'Valued Client',
    userEmail: userInputs.email || '',
    activity: formatActivity(activity),
    entityType: formatEntityType(userInputs.entityType),
    visaCount,
    officePreference: formatOffice(officePreference),
    budgetRange: userInputs.budgetRange || 'Not specified',
    preferredEmirate: userInputs.preferredEmirate || 'Any',

    // Report metadata
    reportId: `RPT-${Date.now().toString(36).toUpperCase()}`,
    reportDate: new Date().toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric',
    }),
    dataVerifiedDate: pricingDb.last_updated
      ? new Date(pricingDb.last_updated).toLocaleDateString('en-GB', {
          day: 'numeric', month: 'long', year: 'numeric',
        })
      : 'N/A',
    currentYear: new Date().getFullYear(),

    // Recommendation
    recommendedZone: topZone.zoneName,
    recommendedZoneUrl: topZone.website || '#',
    recommendationReason: buildRecommendationReason(topZone, userInputs),
    totalCost: formatNumber(topZone.totalYear1WithBuffer),
    renewalCost: formatNumber(topZone.renewalCost),
    setupTimeline,

    // Cost summary
    costLicense: formatNumber(categoryCosts.license || 0),
    costVisas: formatNumber(categoryCosts.visa || 0),
    costOffice: formatNumber(categoryCosts.office || 0),
    costGovernment: formatNumber(categoryCosts.government || 0),
    costPro: formatNumber(categoryCosts.pro || 0),
    costSubtotal: formatNumber(topZone.totalYear1),
    costBuffer: formatNumber(topZone.buffer),

    // Detailed costs
    detailedCosts: topZone.costs.year1.items.map(item => ({
      ...item,
      cost: formatNumber(item.cost),
    })),

    // Year comparison
    totalYear1: formatNumber(topZone.totalYear1WithBuffer),
    yearComparison,
    totalSavings: formatNumber(topZone.totalYear1WithBuffer - topZone.renewalCost),

    // Zone comparison table
    zoneComparison: top5Zones.map((zone, idx) => {
      const cats = aggregateByCat(zone.costs.year1.items);
      let badge = null;
      let badgeType = null;

      // Assign badges
      if (idx === 0) {
        badge = 'Best Match'; badgeType = 'best-activity';
      } else if (zone.totalYear1WithBuffer === Math.min(...top5Zones.map(z => z.totalYear1WithBuffer))) {
        badge = 'Best Budget'; badgeType = 'best-budget';
      } else if ((ZONE_REPUTATION[zone.zoneId] || 0) >= 0.90) {
        badge = 'Most Prestigious'; badgeType = 'best-prestige';
      }

      return {
        rank: zone.rank,
        zoneName: zone.zoneName,
        license: formatNumber(cats.license || 0),
        visas: formatNumber(cats.visa || 0),
        office: formatNumber(cats.office || 0),
        totalY1: formatNumber(zone.totalYear1WithBuffer),
        renewalY2: formatNumber(zone.renewalCost),
        matchScore: zone.matchScore,
        pros: zone.pros.slice(0, 3),
        cons: zone.cons.slice(0, 3),
        badge,
        badgeType,
      };
    }),

    // Mainland vs. Freezone
    mainlandCost: mainlandZone
      ? formatNumber(mainlandZone.totalYear1WithBuffer)
      : 'N/A',
    mainlandRenewal: mainlandZone
      ? formatNumber(mainlandZone.renewalCost)
      : 'N/A',
    freezoneCost: formatNumber(freezoneTop.totalYear1WithBuffer),
    freezoneRenewal: formatNumber(freezoneTop.renewalCost),
    mainlandVsFreezoneAdvice,

    // CTA links
    consultationUrl: process.env.CONSULTATION_URL || 'https://ehorizon.ae/consultation',
    supportEmail: process.env.SUPPORT_EMAIL || 'support@ehorizon.ae',
  };
}

// =========================================
// HELPER FUNCTIONS
// =========================================

function normalizeActivity(input) {
  if (!input) return 'services';
  const normalized = input.toLowerCase().trim();
  return ACTIVITY_MAP[normalized] || normalized;
}

function normalizeOffice(input) {
  if (!input) return 'flexi_desk';
  const normalized = input.toLowerCase().trim();
  return OFFICE_MAP[normalized] || 'flexi_desk';
}

function parseBudget(range) {
  if (!range || typeof range !== 'string') return { min: 0, max: 0 };
  const match = range.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (match) return { min: parseInt(match[1], 10), max: parseInt(match[2], 10) };
  return { min: 0, max: 0 };
}

function formatActivity(activity) {
  const names = {
    trading: 'Trading',
    general_trading: 'General Trading',
    services: 'Professional Services',
    consulting: 'Consulting',
    technology: 'Technology / IT',
    ecommerce: 'E-Commerce',
    media: 'Media & Creative',
    industrial: 'Industrial / Manufacturing',
    retail: 'Retail',
    financial_services: 'Financial Services',
  };
  return names[activity] || activity.charAt(0).toUpperCase() + activity.slice(1);
}

function formatOffice(office) {
  const names = {
    flexi_desk: 'Flexi Desk',
    shared_office: 'Shared Office',
    physical_office: 'Physical Office',
  };
  return names[office] || office;
}

function formatEntityType(type) {
  const names = {
    freezone_llc: 'Free Zone LLC',
    freezone_fze: 'Free Zone Establishment (FZE)',
    mainland_llc: 'Mainland LLC',
    sole_proprietor: 'Sole Proprietorship',
    branch: 'Branch Office',
  };
  return names[type] || type || 'Free Zone LLC';
}

function formatFeeKey(key) {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function formatNumber(num) {
  if (typeof num !== 'number') return '0';
  return num.toLocaleString('en-US');
}

function calculateOverallConfidence(items) {
  if (items.length === 0) return 'low';
  const confValues = { high: 3, medium: 2, low: 1 };
  const avg = items.reduce((sum, item) =>
    sum + (confValues[item.confidence] || 1), 0
  ) / items.length;

  if (avg >= 2.5) return 'high';
  if (avg >= 1.5) return 'medium';
  return 'low';
}

function scoreToStars(score) {
  if (score >= 0.8) return '★★★★★';
  if (score >= 0.65) return '★★★★☆';
  if (score >= 0.5) return '★★★☆☆';
  if (score >= 0.35) return '★★☆☆☆';
  return '★☆☆☆☆';
}

function aggregateByCat(items) {
  return items.reduce((acc, item) => {
    acc[item.category] = (acc[item.category] || 0) + item.cost;
    return acc;
  }, {});
}

function buildYearComparison(zone) {
  const y1Cats = aggregateByCat(zone.costs.year1.items);
  const y2Cats = aggregateByCat(zone.costs.renewal.items);
  const categories = [...new Set([...Object.keys(y1Cats), ...Object.keys(y2Cats)])];

  return categories.map(cat => ({
    category: formatFeeKey(cat),
    year1: formatNumber(y1Cats[cat] || 0),
    year2: formatNumber(y2Cats[cat] || 0),
    savings: formatNumber((y1Cats[cat] || 0) - (y2Cats[cat] || 0)),
  }));
}

function buildRecommendationReason(zone, inputs) {
  const parts = [];

  if (zone.totalYear1WithBuffer < 25000) {
    parts.push('offers excellent value for your budget');
  } else if (zone.totalYear1WithBuffer < 50000) {
    parts.push('balances cost and quality well');
  } else {
    parts.push('provides premium positioning');
  }

  if (zone.emirate?.toLowerCase() === (inputs.preferredEmirate || '').toLowerCase()) {
    parts.push(`is located in your preferred emirate (${zone.emirate})`);
  }

  if (zone.pros && zone.pros.length > 0) {
    parts.push(zone.pros[0].toLowerCase());
  }

  return `${zone.zoneName} ${parts.join(', ')}.`;
}

function buildMainlandAdvice(inputs, topZone, mainlandZone, freezoneTop) {
  if (!mainlandZone) {
    return `Based on your profile as a ${formatActivity(inputs.activity)} business, we recommend a free zone setup at ${freezoneTop.zoneName}. Free zones offer simpler processes, lower costs, and are ideal for international and digital businesses.`;
  }

  const costDiff = mainlandZone.totalYear1WithBuffer - freezoneTop.totalYear1WithBuffer;

  if (costDiff > 0) {
    return `For your ${formatActivity(inputs.activity)} business, a free zone setup at ${freezoneTop.zoneName} saves you approximately AED ${formatNumber(costDiff)} compared to mainland. Unless you need direct access to the UAE local market or government contracts, the free zone offers better value. Many businesses start in a free zone and add a mainland branch later when needed.`;
  } else {
    return `Mainland Dubai (DED) is competitive for your ${formatActivity(inputs.activity)} business, costing approximately AED ${formatNumber(Math.abs(costDiff))} less than ${freezoneTop.zoneName}. If you need direct UAE market access or plan to work with government clients, mainland is the right choice. However, expect more paperwork and potentially higher annual renewal costs.`;
  }
}

// =========================================
// EXPORTS
// =========================================

// =========================================
// QUICK ESTIMATE (for frontend /api/estimate)
// =========================================

/**
 * Zone tier definitions for the frontend selector.
 */
const ZONE_TIERS = {
  budget: {
    label: 'Most Affordable',
    emoji: '💰',
    zones: ['ifza', 'rakez', 'shams', 'ajman'],
    description: 'Zones in RAK, Sharjah, Fujairah, Ajman',
  },
  dubai: {
    label: 'Dubai Presence',
    emoji: '🏙️',
    zones: ['dmcc', 'meydan', 'dso'],
    description: 'DMCC, Meydan, Dubai Silicon Oasis',
  },
  financial: {
    label: 'Financial / Regulated',
    emoji: '🏦',
    zones: ['difc', 'adgm'],
    description: 'DIFC (Dubai), ADGM (Abu Dhabi)',
  },
  any: {
    label: 'Not Sure Yet',
    emoji: '🤷',
    zones: null, // all zones
    description: "We'll recommend the best match",
  },
};

/**
 * Quick estimate for the frontend calculator.
 * Returns cost ranges based on partial inputs, using real pricing data.
 *
 * @param {Object} inputs
 * @param {string} inputs.activity - Business activity
 * @param {string} inputs.setupType - mainland/freezone/offshore/not-sure
 * @param {number} inputs.visaCount - Number of visas
 * @param {string} inputs.officePreference - Office type
 * @param {string} inputs.zoneTier - budget/dubai/financial/any
 * @param {string} inputs.proServices - yes/no/not-sure
 * @param {boolean} inputs.familyVisas - Include family visa costs
 *
 * @returns {Object} Estimate with low/high/typical totals and breakdown
 */
function quickEstimate(inputs) {
  // Load pricing database
  const dbPath = path.join(__dirname, '..', 'data', 'pricing-database.json');
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Pricing database not found at ${dbPath}`);
  }
  const pricingDb = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

  const activity = normalizeActivity(inputs.activity);
  const visaCount = Math.max(0, Math.min(20, parseInt(inputs.visaCount, 10) || 1));
  const officePreference = normalizeOffice(inputs.officePreference);
  const setupType = (inputs.setupType || 'freezone').toLowerCase().trim();
  const zoneTier = inputs.zoneTier || 'any';
  const proServices = inputs.proServices || 'not-sure';
  const familyVisas = inputs.familyVisas || false;

  // Determine which zones to consider
  const tierConfig = ZONE_TIERS[zoneTier] || ZONE_TIERS.any;
  const allowedZoneIds = tierConfig.zones; // null = all

  // Calculate costs for each matching zone
  const zoneResults = [];

  // Freezone zones
  if (setupType !== 'mainland') {
    for (const zone of pricingDb.zones) {
      if (allowedZoneIds && !allowedZoneIds.includes(zone.zone_id)) continue;
      const result = calculateZoneCost(zone, activity, visaCount, officePreference);
      if (result) {
        result.zoneType = 'freezone';
        zoneResults.push(result);
      }
    }
  }

  // Mainland
  if (setupType !== 'freezone' && setupType !== 'offshore' && pricingDb.mainland?.dubai_ded) {
    const mainlandResult = calculateZoneCost(pricingDb.mainland.dubai_ded, activity, visaCount, officePreference);
    if (mainlandResult) {
      mainlandResult.zoneType = 'mainland';
      zoneResults.push(mainlandResult);
    }
  }

  // Offshore fallback (simplified)
  if (setupType === 'offshore') {
    return {
      low: 8000,
      high: 16000,
      typical: 12000,
      zoneCount: 0,
      confidence: 'medium',
      cheapestZone: null,
      bestMatchZone: null,
      zoneTier,
      setupType,
      breakdown: [
        { item: 'Offshore License & Registration', low: 8000, high: 16000, notes: 'Offshore license, registration & registered agent fees.' },
        { item: 'TOTAL (Year 1)', low: 8000, high: 16000, notes: '', isTotal: true },
      ],
    };
  }

  if (zoneResults.length === 0) {
    // Fallback to hardcoded if no zones matched
    return buildFallbackEstimate(inputs);
  }

  // Sort by total cost
  zoneResults.sort((a, b) => a.totalYear1WithBuffer - b.totalYear1WithBuffer);

  // Build breakdown from the range of zone results
  const allTotals = zoneResults.map(z => z.totalYear1WithBuffer);
  const lowTotal = Math.min(...allTotals);
  const highTotal = Math.max(...allTotals);
  const typicalTotal = Math.round(allTotals.reduce((a, b) => a + b, 0) / allTotals.length);

  // Build a meaningful breakdown using the cheapest and most expensive zone
  const cheapestZone = zoneResults[0];
  const expensiveZone = zoneResults[zoneResults.length - 1];

  // Aggregate categories across zones for range
  const catLow = aggregateByCat(cheapestZone.costs.year1.items);
  const catHigh = aggregateByCat(expensiveZone.costs.year1.items);
  const allCats = [...new Set([...Object.keys(catLow), ...Object.keys(catHigh)])];

  const breakdown = [];
  const catLabels = {
    license: 'License & Registration',
    visa: 'Visa Costs',
    office: 'Office (Annual)',
    government: 'Government Fees',
    pro: 'PRO Services',
  };

  for (const cat of allCats) {
    const low = catLow[cat] || 0;
    const high = catHigh[cat] || 0;
    breakdown.push({
      item: catLabels[cat] || formatFeeKey(cat),
      low: Math.min(low, high),
      high: Math.max(low, high),
      notes: '',
    });
  }

  // Add health insurance estimate if visas > 0
  if (visaCount > 0) {
    const healthLow = 1000 * visaCount;
    const healthHigh = 2000 * visaCount;
    breakdown.push({
      item: `Health Insurance (×${visaCount})`,
      low: healthLow,
      high: healthHigh,
      notes: 'Mandatory health insurance per visa holder (estimate).',
    });
    // Adjust totals
    const adjustedLow = lowTotal + healthLow;
    const adjustedHigh = highTotal + healthHigh;
    breakdown.push({ item: 'TOTAL (Year 1)', low: adjustedLow, high: adjustedHigh, notes: '', isTotal: true });

    return {
      low: adjustedLow,
      high: adjustedHigh,
      typical: Math.round((adjustedLow + adjustedHigh) / 2),
      zoneCount: zoneResults.length,
      confidence: zoneResults.length <= 4 ? 'high' : 'medium',
      cheapestZone: cheapestZone.zoneName,
      bestMatchZone: cheapestZone.zoneName,
      zoneTier,
      setupType,
      breakdown,
      zoneBreakdown: zoneResults.slice(0, 5).map(z => ({
        zoneName: z.zoneName,
        zoneId: z.zoneId,
        emirate: z.emirate,
        totalYear1: z.totalYear1WithBuffer,
        renewalCost: z.renewalCost,
        confidence: z.overallConfidence,
      })),
    };
  }

  // No visas
  breakdown.push({ item: 'TOTAL (Year 1)', low: lowTotal, high: highTotal, notes: '', isTotal: true });

  return {
    low: lowTotal,
    high: highTotal,
    typical: typicalTotal,
    zoneCount: zoneResults.length,
    confidence: zoneResults.length <= 4 ? 'high' : 'medium',
    cheapestZone: cheapestZone.zoneName,
    bestMatchZone: cheapestZone.zoneName,
    zoneTier,
    setupType,
    breakdown,
    zoneBreakdown: zoneResults.slice(0, 5).map(z => ({
      zoneName: z.zoneName,
      zoneId: z.zoneId,
      emirate: z.emirate,
      totalYear1: z.totalYear1WithBuffer,
      renewalCost: z.renewalCost,
      confidence: z.overallConfidence,
    })),
  };
}

/**
 * Fallback estimate using hardcoded ranges (graceful degradation).
 */
function buildFallbackEstimate(inputs) {
  const setupType = (inputs.setupType || 'freezone').toLowerCase();
  const visaCount = parseInt(inputs.visaCount, 10) || 1;
  const officeType = inputs.officePreference || 'flexi-desk';

  const baseCosts = {
    freezone: { min: 12000, max: 25000 },
    mainland: { min: 15000, max: 35000 },
    offshore: { min: 8000, max: 16000 },
  };

  const base = baseCosts[setupType] || baseCosts.freezone;
  const visaCost = { min: 3000 * visaCount, max: 6000 * visaCount };
  const officeCost = officeType === 'flexi-desk' || officeType === 'flexi_desk'
    ? { min: 5000, max: 12000 }
    : officeType === 'dedicated-office' || officeType === 'physical_office'
      ? { min: 15000, max: 50000 }
      : { min: 0, max: 0 };

  const low = base.min + visaCost.min + officeCost.min;
  const high = base.max + visaCost.max + officeCost.max;

  return {
    low,
    high,
    typical: Math.round((low + high) / 2),
    zoneCount: 0,
    confidence: 'low',
    cheapestZone: null,
    bestMatchZone: null,
    zoneTier: inputs.zoneTier || 'any',
    setupType,
    breakdown: [
      { item: 'License & Registration', low: base.min, high: base.max, notes: 'Estimated range.' },
      { item: `Visa Costs (×${visaCount})`, low: visaCost.min, high: visaCost.max, notes: '' },
      { item: 'Office (Annual)', low: officeCost.min, high: officeCost.max, notes: '' },
      { item: 'TOTAL (Year 1)', low, high, notes: '', isTotal: true },
    ],
  };
}

module.exports = { calculateCosts, quickEstimate, ZONE_TIERS };
