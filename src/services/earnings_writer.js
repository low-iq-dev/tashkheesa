/**
 * Earnings ledger writer — wires `computeDoctorEarnings` into the
 * `doctor_earnings` table at the three sites P0-FIN-1 prescribes:
 *
 *   1. writePendingForCase   — at doctor acceptance
 *   2. markCaseEarningsPaid  — at case completion (UPSERT)
 *   3. recomputeOnBreach     — at SLA breach (uplift refund)
 *
 * All snapshots come from the `orders` row, never from `services` —
 * the orders row IS the historical earnings snapshot, immune to
 * future catalog edits.
 *
 * `appointment_id` on `doctor_earnings` is overloaded: the existing
 * video-addon paths use the appointments.id UUID; here we use the
 * order/case id. PK collisions are avoided via the 'earn-main-' id
 * prefix. Idempotency is enforced in code (no unique index — see
 * docs/audits/PRE_LAUNCH_AUDIT_2026-04-30.md P1-FIN-2 for the
 * known reassignment-orphan limitation).
 */

'use strict';

const { randomUUID } = require('crypto');
const { queryOne, queryAll, execute, withTransaction } = require('../pg');
const { computeDoctorEarnings } = require('./earnings_calc');

const MAIN_EARNINGS_PREFIX = 'earn-main-';
// P1-FIN-2: distinct prefix for partial-pay rows on reassignment.
// Doesn't overlap with 'earn-main-' so findExistingMainRow / writePendingForCase
// keep working unchanged for the new doctor's row.
const REASSIGN_EARNINGS_PREFIX = 'earn-reassign-';
// P1-FIN-2: doctor share of baseShare given to the original doctor when
// their case is auto-reassigned out due to SLA breach. Token amount for
// time spent reviewing. Platform absorbs this — new doctor still gets
// 100% baseShare.
const REASSIGN_PARTIAL_PCT = 10;

async function loadEarningsInputs(orderId) {
  const order = await queryOne(
    `SELECT o.id, o.doctor_id, o.doctor_fee, o.urgency_uplift_amount,
            sv.urgency_uplift_doctor_pct
       FROM orders_active o
       LEFT JOIN services sv ON sv.id = o.service_id
      WHERE o.id = $1`,
    [orderId]
  );
  if (!order) return null;

  const addons = await queryAll(
    `SELECT id, addon_service_id, price_at_purchase_egp, doctor_commission_pct_at_purchase
       FROM order_addons
      WHERE order_id = $1
        AND status IN ('paid', 'fulfilled')`,
    [orderId]
  );

  return { order, addons: addons || [] };
}

function buildResult(inputs) {
  const { order, addons } = inputs;
  const baseDoctorFee = Number(order.doctor_fee) || 0;
  const upliftAmount = Number(order.urgency_uplift_amount) || 0;
  const upliftDoctorPct = (order.urgency_uplift_doctor_pct == null)
    ? 30
    : Number(order.urgency_uplift_doctor_pct);

  return computeDoctorEarnings({
    baseDoctorFee,
    upliftAmount,
    upliftDoctorPct,
    addons
  });
}

async function findExistingMainRow(orderId, doctorId) {
  return queryOne(
    `SELECT id, status, earned_amount, gross_amount
       FROM doctor_earnings
      WHERE appointment_id = $1
        AND doctor_id = $2
        AND id LIKE '${MAIN_EARNINGS_PREFIX}%'
      LIMIT 1`,
    [orderId, doctorId]
  );
}

// Site 1 — at acceptance.
// Inserts a 'pending' row representing the doctor's main-case earnings
// (base + uplift; addons are tracked separately in addon_earnings).
// Idempotent: if a main-row already exists for this (order, doctor),
// returns it unchanged.
async function writePendingForCase(orderId) {
  const inputs = await loadEarningsInputs(orderId);
  if (!inputs || !inputs.order) return { skipped: 'order_not_found' };

  const { order } = inputs;
  if (!order.doctor_id) return { skipped: 'no_doctor_assigned' };

  const existing = await findExistingMainRow(orderId, order.doctor_id);
  if (existing) {
    return { skipped: 'already_exists', earningsId: existing.id, status: existing.status };
  }

  const result = buildResult(inputs);
  // gross_amount = base + uplift the doctor's share is computed against.
  // earned_amount = base + uplift share only (addons live in addon_earnings).
  const baseDoctorFee = Number(order.doctor_fee) || 0;
  const upliftAmount = Number(order.urgency_uplift_amount) || 0;
  const grossAmount = baseDoctorFee + upliftAmount;
  const earnedAmount = result.baseShare + result.upliftShare;
  const commissionPct = grossAmount > 0
    ? Math.round((earnedAmount / grossAmount) * 10000) / 100
    : 100;

  const earningsId = MAIN_EARNINGS_PREFIX + randomUUID();
  await execute(
    `INSERT INTO doctor_earnings
       (id, doctor_id, appointment_id, gross_amount, commission_pct, earned_amount, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())
     ON CONFLICT (id) DO NOTHING`,
    [earningsId, order.doctor_id, orderId, grossAmount, commissionPct, earnedAmount]
  );

  return {
    written: true,
    earningsId,
    status: 'pending',
    earnedAmount,
    baseShare: result.baseShare,
    upliftShare: result.upliftShare
  };
}

// Site 2 — at completion.
// UPDATE the existing pending row to status='paid'. If no row exists
// (legacy order created before P0-FIN-1 wiring), INSERT directly with
// status='paid'.  Always recomputes from the current orders snapshot
// in case uplift was zeroed by a mid-flight breach.
async function markCaseEarningsPaid(orderId, doctorId) {
  if (!orderId || !doctorId) return { skipped: 'missing_args' };

  const inputs = await loadEarningsInputs(orderId);
  if (!inputs || !inputs.order) return { skipped: 'order_not_found' };

  const { order } = inputs;
  const result = buildResult(inputs);
  const baseDoctorFee = Number(order.doctor_fee) || 0;
  const upliftAmount = Number(order.urgency_uplift_amount) || 0;
  const grossAmount = baseDoctorFee + upliftAmount;
  const earnedAmount = result.baseShare + result.upliftShare;
  const commissionPct = grossAmount > 0
    ? Math.round((earnedAmount / grossAmount) * 10000) / 100
    : 100;

  const existing = await findExistingMainRow(orderId, doctorId);

  if (existing) {
    await execute(
      `UPDATE doctor_earnings
          SET status = 'paid',
              paid_at = COALESCE(paid_at, NOW()),
              gross_amount = $1,
              commission_pct = $2,
              earned_amount = $3
        WHERE id = $4`,
      [grossAmount, commissionPct, earnedAmount, existing.id]
    );
    return { updated: true, earningsId: existing.id, earnedAmount };
  }

  // Legacy path: order completed without ever having a pending row.
  const earningsId = MAIN_EARNINGS_PREFIX + randomUUID();
  await execute(
    `INSERT INTO doctor_earnings
       (id, doctor_id, appointment_id, gross_amount, commission_pct, earned_amount, status, created_at, paid_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'paid', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [earningsId, doctorId, orderId, grossAmount, commissionPct, earnedAmount]
  );
  return { inserted_legacy: true, earningsId, earnedAmount };
}

// Site 3 — at SLA breach.
// Recompute the doctor's earnings with upliftAmount=0 (uplift refunded
// to the patient). The base fee is unchanged. If no row exists,
// no-op + warning so callers can log.
async function recomputeOnBreach(orderId) {
  if (!orderId) return { skipped: 'missing_args' };

  const order = await queryOne(
    `SELECT id, doctor_id, doctor_fee FROM orders_active WHERE id = $1`,
    [orderId]
  );
  if (!order || !order.doctor_id) return { skipped: 'order_or_doctor_not_found' };

  const existing = await findExistingMainRow(orderId, order.doctor_id);
  if (!existing) {
    return { skipped: 'no_earnings_row', orderId };
  }

  // Uplift goes to 0 post-breach. Base fee is the catalog-snapshot
  // value already on the orders row.
  const baseDoctorFee = Number(order.doctor_fee) || 0;
  const result = computeDoctorEarnings({
    baseDoctorFee,
    upliftAmount: 0,
    upliftDoctorPct: 30
  });

  const earnedAmount = result.baseShare + result.upliftShare;
  const grossAmount = baseDoctorFee;
  const commissionPct = grossAmount > 0
    ? Math.round((earnedAmount / grossAmount) * 10000) / 100
    : 100;

  await execute(
    `UPDATE doctor_earnings
        SET earned_amount = $1,
            gross_amount = $2,
            commission_pct = $3
      WHERE id = $4`,
    [earnedAmount, grossAmount, commissionPct, existing.id]
  );

  return {
    recomputed: true,
    earningsId: existing.id,
    newEarnedAmount: earnedAmount
  };
}

// P1-FIN-2 — at SLA-breach reassignment.
// Atomic two-step inside a single transaction:
//   1. Flip the original doctor's pending main row to status='reassigned',
//      stamp reassignment_reason, link via reassigned_to_earning_id.
//   2. Insert a new 'reassigned' row at REASSIGN_PARTIAL_PCT of baseShare
//      so the original doctor sees a token partial pay for review time.
// Idempotent — see guards below. The transaction also covers the orders
// audit-fields UPDATE when called from reassignCase (see case_lifecycle.js).
//
// Returns one of:
//   { written: true, oldRowId, partialRowId, partialAmount, partialPct, baseShare }
//   { skipped: 'no_main_row' }       — original doctor never had a row
//   { skipped: 'already_paid' }      — race: report submitted before reassign; no claw-back
//   { idempotent: true, partialRowId, partialAmount } — called twice, returns existing
async function markPartialPayOnReassignment(originalDoctorId, orderId, reason) {
  if (!orderId || !originalDoctorId) return { skipped: 'missing_args' };

  return withTransaction(async function (client) {
    // Step 1: lock the main row for this (order, doctor) and inspect.
    var existingResult = await client.query(
      `SELECT id, status, earned_amount
         FROM doctor_earnings
        WHERE appointment_id = $1
          AND doctor_id = $2
          AND id LIKE '${MAIN_EARNINGS_PREFIX}%'
        FOR UPDATE`,
      [orderId, originalDoctorId]
    );
    if (existingResult.rows.length === 0) {
      return { skipped: 'no_main_row', orderId: orderId, originalDoctorId: originalDoctorId };
    }
    var row = existingResult.rows[0];

    // Step 2: race guard — already paid. Don't claw back.
    if (row.status === 'paid') {
      return { skipped: 'already_paid', orderId: orderId, existingId: row.id };
    }

    // Step 3: idempotency — called twice for same (doctor, order).
    if (row.status === 'reassigned') {
      var partial = await client.query(
        `SELECT id, earned_amount FROM doctor_earnings
          WHERE id LIKE '${REASSIGN_EARNINGS_PREFIX}%'
            AND appointment_id = $1 AND doctor_id = $2
          LIMIT 1`,
        [orderId, originalDoctorId]
      );
      if (partial.rows.length > 0) {
        return {
          idempotent: true,
          oldRowId: row.id,
          partialRowId: partial.rows[0].id,
          partialAmount: Number(partial.rows[0].earned_amount) || 0,
          partialPct: REASSIGN_PARTIAL_PCT
        };
      }
      // status='reassigned' but no partial row — half-done state from a
      // prior crashed run. Fall through and finish writing the partial row.
    }

    // Step 4: compute partial pay = REASSIGN_PARTIAL_PCT% of original
    // baseShare. The earned_amount on the pending row IS already the
    // baseShare + uplift (uplift may have been zeroed by recomputeOnBreach
    // earlier in the SLA worker — that's fine, we want the post-breach value).
    var baseShare = Number(row.earned_amount) || 0;
    var partialAmount = Math.round(baseShare * (REASSIGN_PARTIAL_PCT / 100) * 100) / 100;

    // Step 5: flip the original row to 'reassigned'.
    await client.query(
      `UPDATE doctor_earnings
          SET status = 'reassigned',
              reassignment_reason = $1
        WHERE id = $2`,
      [reason || 'sla_breach', row.id]
    );

    // Step 6: insert the partial-pay row.
    var partialId = REASSIGN_EARNINGS_PREFIX + randomUUID();
    await client.query(
      `INSERT INTO doctor_earnings
         (id, doctor_id, appointment_id, gross_amount, commission_pct, earned_amount, status, reassignment_reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'reassigned', $7, NOW())`,
      [partialId, originalDoctorId, orderId, baseShare, REASSIGN_PARTIAL_PCT, partialAmount, reason || 'sla_breach']
    );

    // Step 7: link old row to new partial row for reconciliation.
    await client.query(
      `UPDATE doctor_earnings SET reassigned_to_earning_id = $1 WHERE id = $2`,
      [partialId, row.id]
    );

    return {
      written: true,
      oldRowId: row.id,
      partialRowId: partialId,
      partialAmount: partialAmount,
      partialPct: REASSIGN_PARTIAL_PCT,
      baseShare: baseShare
    };
  });
}

module.exports = {
  writePendingForCase,
  markCaseEarningsPaid,
  recomputeOnBreach,
  markPartialPayOnReassignment,
  MAIN_EARNINGS_PREFIX,
  REASSIGN_EARNINGS_PREFIX,
  REASSIGN_PARTIAL_PCT
};
