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
// AUDIT (2026-08-17, regression F5): refund_eligibility.maxRefundableEgp is
// deliberately NOT imported here any more. It is the refund CEILING
// (price + add-ons) and was standing in as the clawback denominator, mixing
// add-on money into a ratio that scales a case-fee-only earning. The
// denominator is caseFeeCollectedEgp() below.

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

// AUDIT-2026-08-22 (M3, P0): the marker recomputeOnBreach stamps into
// clawback_reason. `doctor_earnings` has no column for "an adjustment has been
// applied to this row" other than clawback_applied_at, and no migration is in
// this change's scope, so the breach write now uses the SAME two columns — with
// its own reason value so recomputeOnRefund can still tell a stage-1 breach
// zeroing (uplift removed, base intact) apart from a finished clawback and
// carry out the documented second stage.
const BREACH_UPLIFT_CLAWBACK = 'sla_breach_uplift_zeroed';

// The CASE-FEE portion of what the patient paid, in EGP to 2dp — i.e.
// maxRefundableEgp minus the add-on lines. This, not the full invoice, is the
// denominator of the refund ratio in recomputeOnRefund: `doctor_earnings` only
// ever holds the doctor's share of the case fee (doctor_fee + urgency uplift
// share); add-on revenue is settled in `addon_earnings` by
// services/addons/*.onPurchase and is untouched by this file. See the
// regression-F5 note at the call site.
//
// Per migration 037, base_price + urgency_uplift_amount = price, so `price`
// already contains the uplift — the two branches are alternatives, never a sum.
function caseFeeCollectedEgp(order) {
  if (!order) return 0;
  const price = Number(order.price);
  if (Number.isFinite(price) && price > 0) return Math.round(price * 100) / 100;
  const base = Number(order.base_price) || 0;
  const uplift = Number(order.urgency_uplift_amount) || 0;
  const sum = base + uplift;
  return sum > 0 ? Math.round(sum * 100) / 100 : 0;
}

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
  // Side issue #43 — include clawback_* columns so recomputeOnRefund can
  // enforce idempotency without a second query. Existing callers
  // (recomputeOnBreach, writePendingForCase) ignore the extra columns.
  return queryOne(
    `SELECT id, status, earned_amount, gross_amount,
            clawback_reason, clawback_applied_at
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

  // (buildResult and the three amounts above are pure functions of the order
  // snapshot; hoisted above the existing-row check by AUDIT-2026-08-22 (R4)
  // so the re-assignment branch below can reuse them. No behaviour change on
  // the insert path.)
  const existing = await findExistingMainRow(orderId, order.doctor_id);
  if (existing) {
    // ── AUDIT-2026-08-22 (R4, P0): A → B → A pays A nothing ─────────────────
    //
    // findExistingMainRow is keyed on (order, doctor), NOT on the current
    // assignment. When a case is reassigned away from A, M4 zeroes A's main row
    // and flips it to status='reassigned'. If the case later lands back on A —
    // routine: case_sla_worker.js:513 excludes only the CURRENT holder and
    // routes/api/admin.js:1446 excludes nobody — this function found that
    // zeroed row and returned 'already_exists', so no pending row was ever
    // re-opened, and markCaseEarningsPaid then settled A at 0 for a report A
    // actually delivered.
    //
    // The row belongs to the doctor the order is assigned to RIGHT NOW (that is
    // what order.doctor_id means here), so a 'reassigned' row found at this
    // point means exactly one thing: the case has come back. Re-open it at the
    // current snapshot figures.
    if (String(existing.status) === 'reassigned') {
      await execute(
        `UPDATE doctor_earnings
            SET status = 'pending',
                gross_amount = $1,
                commission_pct = $2,
                earned_amount = $3
          WHERE id = $4
            AND status = 'reassigned'`,
        [grossAmount, commissionPct, earnedAmount, existing.id]
      );

      // The 10% token in the separate 'earn-reassign-%' row compensated A for a
      // case A did NOT deliver. A is delivering it now and is being paid the
      // full fee above, so leaving the token standing recreates precisely the
      // 110% double-count M4 removed. The ROW stays (services/doctor_pause.js
      // counts these rows by id prefix + status to drive the pause policy, and
      // the reassignment did happen) — only its money goes to zero.
      await execute(
        `UPDATE doctor_earnings
            SET earned_amount = 0,
                commission_pct = 0
          WHERE appointment_id = $1
            AND doctor_id = $2
            AND id LIKE '${REASSIGN_EARNINGS_PREFIX}%'
            AND status = 'reassigned'
            AND earned_amount <> 0`,
        [orderId, order.doctor_id]
      );

      return {
        reopened: true,
        earningsId: existing.id,
        status: 'pending',
        earnedAmount,
        baseShare: result.baseShare,
        upliftShare: result.upliftShare
      };
    }
    return { skipped: 'already_exists', earningsId: existing.id, status: existing.status };
  }

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
    // ── AUDIT-2026-08-22 (M3, P0): completing a case SILENTLY REVERSED an
    // applied clawback ────────────────────────────────────────────────────
    //
    // This UPDATE recomputed earned_amount from the orders snapshot with no
    // check on clawback_applied_at, unlike recomputeOnRefund which has guarded
    // on it since side issue #43. So:
    //
    //   refund marked paid → recomputeOnRefund sets earned_amount to the
    //   clawed-back figure (0 on the sla_breach policy) and stamps
    //   clawback_applied_at → the doctor later submits the report → this line
    //   restored the FULL fee and marked it 'paid'.
    //
    // A late submission on a refunded case therefore paid the doctor in full
    // out of money that had already been returned to the patient, and left no
    // trace: clawback_applied_at was still set, so the row looked clawed back.
    //
    // Completion is still allowed to settle the row — the STATUS legitimately
    // moves to 'paid' — but an applied adjustment is a settled fact and the
    // AMOUNT is left exactly as the clawback left it.
    //
    // AUDIT-2026-08-22 (R4, P0) — M4's `|| status === 'reassigned'` clause is
    // REMOVED from this guard. It paid ZERO to a doctor who delivered.
    //
    // M4 reasoned that a 'reassigned' row is settled. It is not, in the one
    // case that reaches here with that status: this function is called at
    // COMPLETION with the doctor who completed, so a 'reassigned' main row for
    // that doctor means the case was reassigned away and then came back to
    // them (A → B → A, which case_sla_worker.js:513 and
    // routes/api/admin.js:1446 both permit) and they then delivered the report.
    // writePendingForCase re-opens the row on that re-assignment now; this
    // guard would have overridden the re-open and settled it at 0 anyway.
    //
    // The 110% double-count M4 was protecting against is closed at its source
    // instead: writePendingForCase zeroes the 'earn-reassign-%' token when it
    // re-opens the main row, so the doctor is paid 100% once and never 110%.
    // A case reassigned away and NOT returned never reaches this branch — the
    // new holder has no main row, so completion takes the legacy-insert path
    // below and the old doctor's zeroed row is left alone.
    //
    // clawback_applied_at remains the sole preserve condition: an applied
    // adjustment IS a settled fact and completion must never reverse it.
    const adjusted = !!existing.clawback_applied_at;
    if (adjusted) {
      await execute(
        `UPDATE doctor_earnings
            SET status = 'paid',
                paid_at = COALESCE(paid_at, NOW())
          WHERE id = $1`,
        [existing.id]
      );
      const preserved = Number(existing.earned_amount);
      return {
        updated: true,
        earningsId: existing.id,
        earnedAmount: Number.isFinite(preserved) ? preserved : null,
        clawbackPreserved: true,
        clawbackReason: existing.clawback_reason || null,
        clawbackAppliedAt: existing.clawback_applied_at || null,
        previousStatus: existing.status || null
      };
    }

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

    // AUDIT-2026-08-22 (R4): settling a row that was still 'reassigned' means
    // the case came back to this doctor and they delivered it, WITHOUT
    // writePendingForCase having re-opened the row (not every re-assignment
    // path calls it — routes/api/admin.js:1446 assigns directly). Zero the 10%
    // token here too, for the same reason writePendingForCase does: the doctor
    // is being paid 100% for a case they delivered, so the not-delivered token
    // must not stack on top of it. The row itself stays for doctor_pause.js.
    if (String(existing.status) === 'reassigned') {
      await execute(
        `UPDATE doctor_earnings
            SET earned_amount = 0,
                commission_pct = 0
          WHERE appointment_id = $1
            AND doctor_id = $2
            AND id LIKE '${REASSIGN_EARNINGS_PREFIX}%'
            AND status = 'reassigned'
            AND earned_amount <> 0`,
        [orderId, doctorId]
      );
    }

    return { updated: true, earningsId: existing.id, earnedAmount, reopenedFromReassigned: String(existing.status) === 'reassigned' };
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

  // AUDIT-2026-08-22 (M3, P0): this UPDATE was unguarded, exactly like
  // markCaseEarningsPaid's. A breach recompute firing after the refund
  // mark-paid clawback had already zeroed the row (a re-breach, or the SLA
  // sweep re-running a tick later) restored the whole base fee on a case whose
  // money had been returned. A settled adjustment is never reversed here; the
  // row is already at or below the standard-tier figure this function writes.
  //
  // AUDIT-2026-08-22 (R8, P2): the guard was UNCONDITIONAL while the symmetric
  // one in recomputeOnRefund was narrowed to let the breach marker through.
  // The asymmetry meant that once ANY refund clawback had stamped the row, the
  // uplift could never be removed — even though the breach is refunding it. A
  // small partial refund leaves the row at `full × (1 − 0.9r)`, which for a
  // large uplift is comfortably ABOVE the base-only figure this function
  // writes, so the doctor kept a share of an uplift that had gone back to the
  // patient.
  //
  // It is safe to let it through because this function only ever writes DOWN:
  // the clamp below keeps the lower of (post-breach figure, current row). What
  // must NOT happen is the stamp being rewritten — overwriting a finished
  // settlement's clawback_reason with BREACH_UPLIFT_CLAWBACK would re-open
  // recomputeOnRefund's guard and let a second refund clawback run. So an
  // existing stamp is PRESERVED verbatim (reason and timestamp both), and only
  // an unstamped row is marked as a stage-1 breach write-down.
  const priorClawbackApplied = !!existing.clawback_applied_at;

  // Uplift goes to 0 post-breach. Base fee is the catalog-snapshot
  // value already on the orders row.
  const baseDoctorFee = Number(order.doctor_fee) || 0;
  const result = computeDoctorEarnings({
    baseDoctorFee,
    upliftAmount: 0,
    upliftDoctorPct: 30
  });

  let earnedAmount = result.baseShare + result.upliftShare;
  // AUDIT-2026-08-22 (M3): belt and braces — a breach recompute is a write-DOWN
  // by definition (the uplift is being refunded). If the row is already lower
  // than the standard-tier figure for any reason this function does not know
  // about, keep the lower number rather than paying the difference back out.
  const prevEarned = Number(existing.earned_amount);
  if (Number.isFinite(prevEarned) && prevEarned >= 0 && earnedAmount > prevEarned) {
    earnedAmount = prevEarned;
  }
  const grossAmount = baseDoctorFee;
  const commissionPct = grossAmount > 0
    ? Math.round((earnedAmount / grossAmount) * 10000) / 100
    : 100;

  // AUDIT-2026-08-22 (M3): stamp the adjustment so every other writer in this
  // file can see that this row has been written down. Without the stamp,
  // markCaseEarningsPaid had nothing to test and a late report submission
  // restored the uplift the patient had just been refunded — the breach half
  // of the same bug. BREACH_UPLIFT_CLAWBACK (rather than a generic value) is
  // what lets recomputeOnRefund still apply the documented stage-2 full
  // clawback at breach-refund mark-paid time; see the guard there.
  // AUDIT-2026-08-22 (R8): COALESCE keeps the FIRST settlement's marker. See
  // the note on priorClawbackApplied above — re-stamping a finished clawback
  // as a breach write-down would unlock a second refund clawback.
  const clawbackReasonToStamp = priorClawbackApplied
    ? (existing.clawback_reason || BREACH_UPLIFT_CLAWBACK)
    : BREACH_UPLIFT_CLAWBACK;
  await execute(
    `UPDATE doctor_earnings
        SET earned_amount = $1,
            gross_amount = $2,
            commission_pct = $3,
            clawback_reason = $4,
            clawback_applied_at = COALESCE(clawback_applied_at, NOW())
      WHERE id = $5`,
    [earnedAmount, grossAmount, commissionPct, clawbackReasonToStamp, existing.id]
  );

  return {
    recomputed: true,
    earningsId: existing.id,
    newEarnedAmount: earnedAmount,
    priorClawbackPreserved: priorClawbackApplied,
    clawbackReason: clawbackReasonToStamp
  };
}

// Site 4 — at refund mark-paid (Side issue #43).
//
// Policy (decided 2026-05-12 by Ziad):
//
//   reason='sla_breach'
//     → earned_amount = 0 (full clawback)
//     → recomputeOnBreach (Site 3, called at breach detection) zeroes
//       only the uplift mid-flight. This Site 4 path fires at the
//       SLA-breach refund's mark-paid time and zeroes the base too.
//       Hooks are intentionally decoupled — the breach event is a
//       state transition (uplift refunded immediately), the mark-paid
//       is the final settlement (base claw-back when the patient
//       actually receives the refund money).
//
//   reason='patient_request' OR 'operator_refund' + earnings row exists
//     → earned_amount = full × (1 − 0.9 × refundRatio), where
//         refundRatio = min(1, refundAmountEgp / caseFeeCollectedEgp(order))
//       The denominator is the CASE FEE (orders.price, or base_price + uplift
//       on legacy rows) — NOT the refund ceiling. See regression F5 below.
//       i.e. the 90% claw-back SCALES LINEARLY with how much of the
//       order was actually returned to the patient. A full refund
//       leaves the doctor 10% (the historical behaviour); a 50%
//       refund leaves 55%; a 10% refund leaves 91%.
//       The existence of the earnings row IS the post-acceptance
//       signal: writePendingForCase only fires at doctor acceptance,
//       so a pre-acceptance refund hits the "no row" branch and skips.
//
//       AUDIT 2026-08-17: this used to be an unconditional
//       `full * 0.10` with no amount argument at all, so refunding
//       50 EGP of a 2000 EGP order clawed back 90% of the doctor's
//       whole fee. It was also the only unrounded money expression in
//       this file. Both fixed.
//
//       Degradation is deliberate: when the caller supplies no
//       refundAmountEgp (or the order total can't be established) we
//       fall back to refundRatio = 1, i.e. the previous full 90%
//       claw-back. Failing towards the platform, never towards
//       silently paying out on a refunded case.
//
//   else (no earnings row, or unknown reason)
//     → skip. Pre-acceptance refunds don't touch earnings (no doctor
//       work to compensate); unknown reasons fail loud.
//
// Idempotency: clawback_applied_at is set on every successful recompute.
// A second call with the row already stamped returns
// `{ skipped: 'clawback_already_applied' }` without mutating the row.
// This makes the mark-paid route safe against double-clicks and
// operator-side retries.
async function recomputeOnRefund(orderId, opts) {
  const reason = opts && opts.reason;
  if (!orderId || !reason) return { skipped: 'missing_args' };

  // price / base_price / urgency_uplift_amount feed caseFeeCollectedEgp, the
  // denominator of the refund ratio when the caller doesn't pass an explicit
  // totalCollectedEgp. The addons_json / video_consultation_* columns are kept
  // in the projection deliberately: they are no longer part of the denominator
  // (regression F5) but they are what a future scope-aware caller will need,
  // and they cost nothing here. orders_active projects every orders column
  // (migrations 069 / 077 assert full parity), so these are safe to select.
  const order = await queryOne(
    `SELECT id, doctor_id, doctor_fee, urgency_uplift_amount,
            price, base_price, addons_json,
            video_consultation_selected, video_consultation_price
       FROM orders_active WHERE id = $1`,
    [orderId]
  );
  if (!order || !order.doctor_id) return { skipped: 'order_or_doctor_not_found' };

  const existing = await findExistingMainRow(orderId, order.doctor_id);
  if (!existing) {
    // Pre-acceptance: no earnings row exists because writePendingForCase
    // hasn't fired. Refund processes cleanly without touching earnings.
    return { skipped: 'pre_acceptance_no_earnings_row', orderId };
  }

  // Idempotency — never claw-back twice on the same earnings row.
  //
  // AUDIT-2026-08-22 (M3): recomputeOnBreach now stamps these same two columns
  // (it had no way to protect its write otherwise — see the note at the top of
  // this file). That stage-1 marker must NOT be read as "a clawback already
  // ran": the breach settlement is deliberately two-stage (uplift zeroed at
  // breach detection, base clawed back when the refund is actually paid), and
  // a patient/operator refund on a breached case still has to apply its own
  // policy. Both stage-2 outcomes only ever move the amount DOWN — `full`
  // below is computed from orders.urgency_uplift_amount, which sla_breach.js
  // has already set to 0 — and the clamp before the UPDATE enforces that.
  // Any OTHER stamp is a finished settlement and still blocks.
  if (existing.clawback_applied_at && existing.clawback_reason !== BREACH_UPLIFT_CLAWBACK) {
    return {
      skipped: 'clawback_already_applied',
      orderId,
      earningsId: existing.id,
      previousReason: existing.clawback_reason || null,
      previousAppliedAt: existing.clawback_applied_at
    };
  }

  // ── ADD-ON-ONLY REFUNDS (regression F5, second half) ──────────────────────
  //
  // A refund of ONLY an add-on (the video consultation, the prescription) must
  // not touch doctor_earnings at all: that table holds the doctor's share of
  // the CASE FEE, while add-on revenue lives in addon_earnings. Clawing the
  // report fee because a 200 EGP prescription was refunded is simply wrong.
  //
  // It CANNOT be detected from the data. The refunds table (migration 028 +
  // 048) has no add-on linkage — no line items, no scope column — and both
  // create-refund paths (routes/superadmin.js and services/admin_refund.js)
  // write a single free-typed amount bounded by maxRefundableEgp. "800 EGP of
  // an 1800 EGP invoice" is therefore genuinely ambiguous between "the add-on"
  // and "most of the case fee", and guessing by matching the amount against
  // the add-on prices would silently skip real clawbacks whenever the two
  // numbers happen to coincide.
  //
  // So: an explicit opt-in, and no inference. A caller that KNOWS the refund is
  // add-on-only (a future add-on-refund flow, or an operator form that captures
  // scope) passes { scope: 'addon' } and this returns without writing.
  // Everything else keeps the case-fee policy below.
  //
  // Residual, documented: until the refund form captures scope, an operator
  // refunding only an add-on through the generic form WILL claw back a
  // proportional slice of the doctor's case fee. Handing this file a scope is
  // the fix; see the handoff notes.
  if (opts && (opts.scope === 'addon' || opts.addonOnly === true)) {
    return { skipped: 'addon_only_refund', orderId, earningsId: existing.id };
  }

  let newEarned;
  let policyApplied;
  let refundRatio = null;
  let totalCollectedEgp = null;
  let refundAmountEgp = null;
  if (reason === 'sla_breach') {
    // Separate policy path — the SLA-breach settlement is all-or-nothing and
    // does NOT scale with the refunded amount. Left untouched deliberately.
    newEarned = 0;
    policyApplied = 'sla_breach_full_clawback';
  } else if (reason === 'patient_request' || reason === 'operator_refund') {
    // Compute the full earning from canonical inputs (doctor_fee +
    // urgency_uplift_amount on the order) so the policy is stable even if
    // the existing row's earned_amount drifted via partial-pay paths.
    const fullEarning = computeDoctorEarnings({
      baseDoctorFee:  Number(order.doctor_fee) || 0,
      upliftAmount:   Number(order.urgency_uplift_amount) || 0,
      upliftDoctorPct: 30
    });
    const full = fullEarning.baseShare + fullEarning.upliftShare;

    // Denominator: the CASE-FEE money, not the whole invoice.
    //
    // AUDIT (2026-08-17, regression F5) — this used to fall back to
    // maxRefundableEgp(order), which is `price + add-ons` (the refund ceiling).
    // `full` above is the doctor's share of the CASE FEE only; add-on revenue
    // is settled separately in addon_earnings and never contributes to it. Two
    // numerators over the wrong denominator, both wrong in opposite
    // directions:
    //   * Refund 800 of an add-on on a 1000 case (ceiling 1800): ratio 0.44,
    //     clawing ~40% of a report fee that was fully earned and is not being
    //     refunded at all.
    //   * Refund the whole 1000 case fee (ceiling 1800): ratio 0.56, leaving
    //     the doctor ~50% when the policy floor for a full case refund is 10%.
    // Using the case portion makes "the patient got the case fee back" come
    // out at exactly ratio 1, which is what the 90%/10% policy is defined on.
    //
    // price is the canonical case charge (migration 037:
    // base_price + urgency_uplift_amount = price, so price ALREADY includes the
    // uplift and must not have it added again). base_price + uplift is the
    // reconstruction for legacy rows that carry no price — the same two-step
    // maxRefundableEgp uses for the case portion, minus the add-on lines.
    const optTotal = Number(opts && opts.totalCollectedEgp);
    totalCollectedEgp = (Number.isFinite(optTotal) && optTotal > 0)
      ? optTotal
      : caseFeeCollectedEgp(order);

    const optRefund = Number(opts && opts.refundAmountEgp);
    refundAmountEgp = (Number.isFinite(optRefund) && optRefund > 0) ? optRefund : null;

    if (refundAmountEgp != null && Number.isFinite(totalCollectedEgp) && totalCollectedEgp > 0) {
      refundRatio = Math.min(1, refundAmountEgp / totalCollectedEgp);
    } else {
      // No usable amount → previous behaviour: treat as a full refund and
      // claw back 90%. Never silently skip the clawback.
      refundRatio = 1;
    }

    // Linear scaling: a refundRatio of r claws back 90% of r of the fee.
    newEarned = full * (1 - 0.9 * refundRatio);
    // Round to 2dp like every other monetary expression in this file.
    newEarned = Math.round(newEarned * 100) / 100;
    if (!Number.isFinite(newEarned) || newEarned < 0) newEarned = 0;
    policyApplied = 'patient_or_operator_post_acceptance_scaled_90pct_clawback';
  } else {
    return { skipped: 'unrecognised_reason', reason };
  }

  // AUDIT-2026-08-22 (M3): a clawback only ever moves the amount DOWN. If a
  // prior adjustment (the stage-1 breach zeroing this function is now allowed
  // to run after, or the reassignment write-down in
  // markPartialPayOnReassignment) already left the row lower than the policy
  // figure, keep the lower number — paying the difference back out on a case
  // that is being refunded is the failure this whole series is closing.
  const prevEarnedOnRow = Number(existing.earned_amount);
  if (Number.isFinite(prevEarnedOnRow) && prevEarnedOnRow >= 0 && newEarned > prevEarnedOnRow) {
    newEarned = prevEarnedOnRow;
  }

  const grossAmount = Number(order.doctor_fee) || 0;
  const commissionPct = grossAmount > 0
    ? Math.round((newEarned / grossAmount) * 10000) / 100
    : 0;

  await execute(
    `UPDATE doctor_earnings
        SET earned_amount = $1,
            commission_pct = $2,
            clawback_reason = $3,
            clawback_applied_at = NOW()
      WHERE id = $4`,
    [newEarned, commissionPct, policyApplied, existing.id]
  );

  return {
    recomputed: true,
    earningsId: existing.id,
    newEarnedAmount: newEarned,
    policyApplied: policyApplied,
    reason: reason,
    // Exposed so the two mark-paid routes can audit HOW MUCH was clawed back
    // and why. null on the sla_breach path (ratio is not part of that policy).
    refundRatio: refundRatio,
    refundAmountEgp: refundAmountEgp,
    totalCollectedEgp: totalCollectedEgp
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
    //
    // ── AUDIT-2026-08-22 (M4): the original doctor was credited 110% ────────
    //
    // This UPDATE changed only `status`, leaving the original row's
    // earned_amount at the FULL fee, and Step 6 then inserted a SECOND
    // 'reassigned' row worth another 10%. Both rows carry status='reassigned'
    // and the doctor statement (routes/doctor.js:1136 / :1194) sums
    // earned_amount over every row for the doctor and reports
    // SUM(...) FILTER (WHERE status='reassigned') as one figure — so one
    // reassigned case showed 110% of the fee, for a case the doctor did not
    // deliver. The header comment at the top of this function (and the
    // REASSIGN_PARTIAL_PCT constant) says the intent is a 10% token only.
    //
    // The 10% lives in the Step 6 row — services/doctor_pause.js counts those
    // rows by the 'earn-reassign-%' id prefix, so it must keep being written —
    // therefore the ORIGINAL row goes to zero. gross_amount is left untouched
    // as the reconciliation record of what the case was worth.
    //
    // Idempotency: re-running lands in the Step 3 guard above (status is now
    // 'reassigned' and the partial row exists) and returns without writing, so
    // the zeroing cannot compound. The Step 3 half-done fall-through reads
    // earned_amount BEFORE this UPDATE on a fresh run; on a legacy half-done
    // row it reads whatever that run left, which is the full fee (the old code
    // never wrote this column) — i.e. it still recovers the right 10%.
    await client.query(
      `UPDATE doctor_earnings
          SET status = 'reassigned',
              earned_amount = 0,
              commission_pct = 0,
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
      baseShare: baseShare,
      // AUDIT-2026-08-22 (M4): the original row's earned_amount is now 0, so
      // partialAmount IS the doctor's total for this case. Exposed so the
      // reassignment audit rows can say so.
      originalRowZeroed: true
    };
  });
}

module.exports = {
  writePendingForCase,
  markCaseEarningsPaid,
  recomputeOnBreach,
  recomputeOnRefund,
  markPartialPayOnReassignment,
  MAIN_EARNINGS_PREFIX,
  REASSIGN_EARNINGS_PREFIX,
  REASSIGN_PARTIAL_PCT,
  // AUDIT-2026-08-22 (M3): exported so tests and reconciliation queries can
  // tell a stage-1 breach write-down apart from a finished clawback.
  BREACH_UPLIFT_CLAWBACK
};
