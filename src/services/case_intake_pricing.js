'use strict';

// services/case_intake_pricing.js
//
// CASE-FLOW REBUILD 2026-08-25 — one pricing path for every way a case is born.
//
// Until now there were two. The web wizard priced a case in routes/patient.js;
// the mobile app priced it inline inside POST /api/v1/cases. They agree today
// only because AUDIT-APP-H1 went and made them agree by hand, after the app
// path had spent months collecting NO urgency premium while still promising the
// 18h/4h SLA and showing the patient the uplifted total on the review screen.
//
// The draft flow adds a THIRD birth path (POST /cases/draft/:id/submit), and
// three hand-synchronised copies of a money calculation is not a thing anyone
// should ship. So the block moves here, once, and every path calls it.
//
// Deliberately NOT moved: the INSERT itself. The web wizard and the app write
// different column sets for good reasons (the wizard's row already exists as a
// DRAFT and is UPDATEd; the app's is INSERTed whole), and merging those would
// be a rewrite of two working writers rather than a de-duplication.
//
// ── One behaviour change, called out ────────────────────────────────────────
//
// POST /api/v1/cases read the service row through `safeGet`, which SWALLOWS a
// database error and returns null. The handler then reports "Invalid service"
// (400) — so a transient pool timeout told the patient their service does not
// exist, permanently and unretryably, and left no trace at the call site.
//
// This module uses queryOne and lets a real database failure throw. Callers map
// a thrown error to 500 (retryable, logged) and keep 400 for the case that
// genuinely is a bad service id. Identical on the happy path and on a genuine
// not-found; different only where the old behaviour was lying.

const { queryOne } = require('../pg');
const { egpChargeFromLocal } = require('../fx');
const { isUrgentWindowOpen } = require('./urgency_window');
const { computeOrderPricing } = require('./urgency_pricing');
const { isServiceBookable } = require('./service_bookable');

/**
 * A refusal the caller should surface to the patient, as opposed to a fault.
 * `code` and `status` mirror the strings POST /api/v1/cases already returns, so
 * existing mobile clients see byte-identical failures.
 */
class IntakeError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'IntakeError';
    this.code = code;
    this.status = status;
    this.expected = true;
  }
}

/**
 * Canonical urgency tier from whatever the client sent.
 *
 * Canonical names per docs/PAYOUT_AND_URGENCY_POLICY.md §2: standard/vip/urgent.
 * 'fast_track' is a legacy name from older mobile clients and is normalised to
 * 'vip' on intake (migration 031 handled the rows already in the table).
 */
function normalizeTier(rawTier, urgentFlag) {
  let tier = rawTier || (urgentFlag ? 'vip' : 'standard');
  if (tier === 'fast_track') tier = 'vip';
  return tier;
}

/**
 * Load a service and refuse it if it is not actually bookable.
 *
 * The mobile path historically checked NEITHER is_visible NOR coming_soon
 * (spec §4.5), so a stale app screen or a direct POST could mint an order for a
 * service with no active doctor behind it.
 *
 * 2026-08-25 — it also never checked the SPECIALTY's visibility, which is the
 * same hole one level up. 24 services sat under a hidden specialty and were
 * orderable through this exact function; 8 were Nephrology, hidden in migration
 * 087 BECAUSE it has no doctor. A patient could pay for a case that could never
 * reach anyone. The web wizard's step-3 POST had the check; this did not, so
 * hiding a specialty worked on one of the three paths that can create an order.
 *
 * The decision now comes from services/service_bookable.js so the three paths
 * cannot drift again. Joined rather than sub-queried here because the row is
 * fetched with SELECT * and the caller wants the reason, not just a boolean.
 *
 * @throws {IntakeError} INVALID_SERVICE | SERVICE_NOT_BOOKABLE
 */
async function resolveServiceForBooking(serviceId) {
  const service = await queryOne(
    `SELECT sv.*,
            sp.is_visible          AS specialty_is_visible,
            (sp.id IS NOT NULL)    AS specialty_exists
       FROM services sv
       LEFT JOIN specialties sp ON sp.id = sv.specialty_id
      WHERE sv.id = $1`,
    [serviceId]
  );
  if (!service) {
    throw new IntakeError('INVALID_SERVICE', 400, 'Invalid service');
  }
  // No specialty, or a specialty_id pointing at a row that does not exist
  // (orders.specialty_id has no FK — see resolveSpecialtyId below). Either way
  // auto_assign matches on specialty_id, so such a case could be paid for and
  // never routed. A missing join row leaves specialty_is_visible null, which
  // isServiceBookable reads as visible, so this has to be tested separately
  // rather than left to the verdict.
  if (!service.specialty_id || service.specialty_exists !== true) {
    throw new IntakeError(
      'SERVICE_NOT_BOOKABLE', 400, 'This service is not available for booking'
    );
  }
  const verdict = isServiceBookable(service, service.specialty_is_visible);
  if (!verdict.bookable) {
    throw new IntakeError(
      'SERVICE_NOT_BOOKABLE', 400, 'This service is not available for booking'
    );
  }
  return service;
}

/**
 * Derive specialty_id from the SERVICE row rather than trusting the client.
 *
 * AUDIT-APP-M2: orders.specialty_id has no FK, so a stale client build can
 * write a dangling id that LOOKS populated — which defeats the `no_specialty`
 * guard in auto_assign entirely and makes the case unroutable while appearing
 * fine in every admin view.
 *
 * @throws {IntakeError} SPECIALTY_SERVICE_MISMATCH
 */
function resolveSpecialtyId(service, clientSpecialtyId) {
  if (
    clientSpecialtyId &&
    service.specialty_id &&
    String(clientSpecialtyId) !== String(service.specialty_id)
  ) {
    throw new IntakeError(
      'SPECIALTY_SERVICE_MISMATCH', 400,
      'Selected specialty does not match the chosen service.'
    );
  }
  return service.specialty_id || clientSpecialtyId || null;
}

/**
 * Urgent cases are only sold inside the Cairo working window.
 *
 * DST-aware via services/urgency_window — Egypt has observed DST again since
 * April 2023, so a fixed UTC offset would be wrong for half the year.
 *
 * @throws {IntakeError} URGENT_UNAVAILABLE
 */
function assertUrgentWindowOpen(urgencyTier) {
  if (urgencyTier === 'urgent' && !isUrgentWindowOpen()) {
    throw new IntakeError(
      'URGENT_UNAVAILABLE', 400,
      'Urgent orders are only available between 7:00am and 7:00pm Cairo time. Please select standard or fast-track.'
    );
  }
}

/**
 * Price a case for the patient's market.
 *
 * ALWAYS-CHARGE-EGP: look up the patient's LOCAL market price (their real
 * country, NOT clamped to a launch market), then convert to the EGP charge
 * base. The card is charged in EGP; display_* carry the local figures for show.
 *
 * ── display_price is returned UN-MULTIPLIED, deliberately ───────────────────
 *
 * AUDIT (2026-08-17). A `computeOrderPricing({ basePrice: charge.displayPrice,
 * ... })` block used to run here and its totalPrice was stored in
 * display_price. That breaks the column's contract: both readers assert the
 * opposite invariant — display_price is the LOCAL BASE, and the tier multiplier
 * is re-derived as (price / base_price) and applied at RENDER time.
 *   * routes/patient.js  — pay page / order review
 *   * src/notification_worker.js — payment-success receipt
 * Pre-multiplying made a VIP order render at base x 1.3 x 1.3 — a 69%
 * overstatement of what the patient is told they paid, against an EGP charge
 * that is correctly base x 1.3. Anything writing display_price from this
 * result must write `charge.displayPrice`, never `pricing.totalPrice`.
 *
 * @param {object}  args
 * @param {object}  args.service      row from resolveServiceForBooking
 * @param {string}  args.country      the patient's ISO country ('EG' default)
 * @param {string}  args.urgencyTier  canonical tier from normalizeTier
 * @returns {Promise<{displayCountry, charge, pricing, slaHours, urgencyFlag, urgencyTier}>}
 * @throws {IntakeError} UNSUPPORTED_CURRENCY
 */
async function priceCaseForMarket({ service, country, urgencyTier }) {
  const displayCountry = String(country || 'EG').trim().toUpperCase() || 'EG';

  const regionalPrice = await queryOne(
    "SELECT tashkheesa_price, currency FROM service_regional_prices " +
    "WHERE service_id = $1 AND country_code = $2 AND COALESCE(status, 'active') = 'active'",
    [service.id, displayCountry]
  );

  const localBase =
    regionalPrice && regionalPrice.tashkheesa_price != null
      ? regionalPrice.tashkheesa_price
      : service.base_price;
  const localCurrency =
    (regionalPrice && regionalPrice.currency) || service.currency || 'EGP';

  let charge;
  try {
    charge = egpChargeFromLocal(localBase, localCurrency);
  } catch (fxErr) {
    throw new IntakeError(
      'UNSUPPORTED_CURRENCY', 400, 'Unsupported currency for this market'
    );
  }

  // Same helper the web wizard uses, so app, web and draft price identically —
  // including any per-service vip_multiplier / urgent_multiplier override.
  const pricing = computeOrderPricing({
    basePrice: charge.egpBase,
    urgencyTier: urgencyTier,
    servicesRow: service
  });

  // Canonical SLA map, so this can never drift from the web funnel or from the
  // doctor acceptance-window calculation again (AUDIT-P0-8).
  const slaHours = require('../case_lifecycle').slaHoursForTier(urgencyTier);

  return {
    displayCountry,
    charge,
    pricing,
    slaHours,
    urgencyFlag: urgencyTier !== 'standard',
    urgencyTier
  };
}

/**
 * The whole intake decision in one call: validate the service, reconcile the
 * specialty, check the urgent window, and price it.
 *
 * Every case-birth path should call THIS rather than the pieces, so a future
 * step added to intake cannot be added to two of the three paths.
 */
async function resolveAndPriceIntake({ serviceId, specialtyId, country, urgencyTier, urgent }) {
  const tier = normalizeTier(urgencyTier, urgent);
  const service = await resolveServiceForBooking(serviceId);
  const resolvedSpecialtyId = resolveSpecialtyId(service, specialtyId);
  assertUrgentWindowOpen(tier);
  const priced = await priceCaseForMarket({ service, country, urgencyTier: tier });
  return { service, resolvedSpecialtyId, ...priced };
}

module.exports = {
  IntakeError,
  normalizeTier,
  resolveServiceForBooking,
  resolveSpecialtyId,
  assertUrgentWindowOpen,
  priceCaseForMarket,
  resolveAndPriceIntake
};
