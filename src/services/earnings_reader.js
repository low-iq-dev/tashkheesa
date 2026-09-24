/**
 * Earnings reader — THE one place a doctor's money is aggregated.
 *
 * Batch B (fix plan 2026-09-15, B1). Before this file, at least fourteen
 * hand-written SQL aggregations fed the doctor's dashboard tile, the earnings
 * page, doctor analytics, the video dashboard, the web admin tiles, the
 * superadmin finance ledger and leaderboard, and the Command app's /payouts —
 * and they disagreed: one production row was simultaneously "owed to the
 * doctor" (doctor.js), invisible (Command finance) and "earned" (analytics).
 * Every reader now calls a function here. No caller keeps its own SQL.
 *
 * The four things every caller used to get differently, settled once:
 *
 * 1. ROW KINDS. `doctor_earnings` has no order_id and no kind column — a row's
 *    kind lives in its id prefix:
 *      'earn-main-%'      main-case fee rows; appointment_id holds the ORDER id
 *                         (services/earnings_writer.js header).
 *      'earn-reassign-%'  legacy reassignment token rows. Policy (decisions
 *                         table 2026-09-15): a reassigned case earns the
 *                         outgoing doctor ZERO, so these are NEVER money —
 *                         excluded from every sum here, which also defends
 *                         against legacy tokens still carrying an amount.
 *      everything else    standalone video-appointment rows ('earn-<uuid>'
 *                         from routes/video.js, 'earn-noshow-<id>' from
 *                         video_scheduler.js); appointment_id holds the
 *                         APPOINTMENTS id. Real money — the founder owes them
 *                         (see the Command /payouts doc block) — so they count.
 *
 * 2. STATUS. 'pending' = earned and owed, awaiting the month-end payout.
 *    'paid' = settled by the month-end payout run (earnings_writer.
 *    markMonthEndPaid stamps it; completion does NOT — see B2). 'reassigned' =
 *    the case left this doctor; earns 0 and is counted in no money figure.
 *
 * 3. THE MONTH. Africa/Cairo, by COMPLETION date. A main row is written at
 *    ACCEPTANCE (writePendingForCase), so its created_at is the acceptance
 *    date — the completion date lives on orders.completed_at (timestamptz,
 *    migration 081), joined via appointment_id. A not-yet-completed pending
 *    row falls back to its created_at (it has no completion month yet); video
 *    rows are written at the completion moment itself, so created_at IS their
 *    completion date. doctor_earnings.created_at/paid_at are naive-UTC
 *    (migration 004): the `::timestamptz` cast states the zone (the session is
 *    pinned to UTC — src/pg.js), the house form that avoids the guard-13
 *    double-shift trap (see routes/api/admin.js's Cairo-bucketing note).
 *    addon_earnings is already timestamptz and needs no cast.
 *
 * 4. MONEY. earned_amount is DOUBLE PRECISION and earned_amount_egp is
 *    INTEGER; every figure leaving this module goes through money() — Number()
 *    then round to piastres — so a float sum can never surface as
 *    1349.9999999999998. Changing the column type is a migration with its own
 *    blast radius and is deliberately NOT part of Batch B.
 */

'use strict';

const { queryOne, queryAll } = require('../pg');

const BUSINESS_TZ = 'Africa/Cairo';

// ── The four disciplines, as SQL fragments ─────────────────────────────────
// Kind predicates assume the doctor_earnings alias `de`.
const KIND_MAIN = `de.id LIKE 'earn-main-%'`;
const KIND_REASSIGN_TOKEN = `de.id LIKE 'earn-reassign-%'`;
// Money rows: everything that is not a legacy reassignment token.
const MONEY_ROWS = `de.id NOT LIKE 'earn-reassign-%'`;

// Cairo wall-clock "now", and the start of the current Cairo month.
const NOW_CAIRO = `(NOW() AT TIME ZONE '${BUSINESS_TZ}')`;
const MONTH_START_CAIRO = `date_trunc('month', ${NOW_CAIRO})`;

// The completion instant of a doctor_earnings row, as Cairo wall time.
// Requires COMPLETION_JOIN below: main rows resolve to their order's
// completed_at, everything else (video rows, in-flight pending main rows)
// falls back to the row's own created_at.
const COMPLETION_CAIRO_DE =
  `(COALESCE(o.completed_at, de.created_at::timestamptz) AT TIME ZONE '${BUSINESS_TZ}')`;
// include-deleted-ok: plain `orders`, not orders_active — earned money must
// stay countable even if the order were ever soft-deleted (same reasoning as
// the Command /breach-cost join).
const COMPLETION_JOIN =
  `LEFT JOIN orders o ON o.id = de.appointment_id AND ${KIND_MAIN}`;

// When the money actually moved (the payout stamp), as Cairo wall time.
// COALESCE to created_at for legacy paid rows that never got a paid_at.
const PAID_AT_CAIRO_DE =
  `(COALESCE(de.paid_at, de.created_at)::timestamptz AT TIME ZONE '${BUSINESS_TZ}')`;

// addon_earnings is timestamptz already; its rows are written at delivery
// (video fulfilment / prescription settlement at completion), so created_at
// is the completion anchor.
const COMPLETION_CAIRO_AE = `(ae.created_at AT TIME ZONE '${BUSINESS_TZ}')`;
const PAID_AT_CAIRO_AE =
  `(COALESCE(ae.paid_at, ae.created_at) AT TIME ZONE '${BUSINESS_TZ}')`;

// EGP to piastres. NULL/'' (SUM over an empty group) becomes 0, never NaN.
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function intOr0(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

// ── Doctor-facing summaries ────────────────────────────────────────────────

/**
 * Current-Cairo-month summary for the doctor dashboard tile.
 * approved = paid; notYetApproved = pending ONLY. 'reassigned' earns zero by
 * policy and is counted in NO money figure — the old tile summed it into
 * "Not yet approved", which is how a doctor was shown money the platform
 * would never pay (the earn-reassign token defect this batch removes).
 */
async function getDoctorMonthSummary(doctorId) {
  const row = await queryOne(
    `SELECT
       COALESCE((SELECT SUM(de.earned_amount)
          FROM doctor_earnings de ${COMPLETION_JOIN}
         WHERE de.doctor_id = $1 AND ${MONEY_ROWS} AND de.status = 'paid'
           AND ${COMPLETION_CAIRO_DE} >= ${MONTH_START_CAIRO}
           AND ${COMPLETION_CAIRO_DE} <  ${MONTH_START_CAIRO} + INTERVAL '1 month'), 0)
     + COALESCE((SELECT SUM(ae.earned_amount_egp)
          FROM addon_earnings ae
         WHERE ae.doctor_id = $1 AND ae.status = 'paid'
           AND ${COMPLETION_CAIRO_AE} >= ${MONTH_START_CAIRO}
           AND ${COMPLETION_CAIRO_AE} <  ${MONTH_START_CAIRO} + INTERVAL '1 month'), 0) AS approved,
       COALESCE((SELECT SUM(de.earned_amount)
          FROM doctor_earnings de ${COMPLETION_JOIN}
         WHERE de.doctor_id = $1 AND ${MONEY_ROWS} AND de.status = 'pending'
           AND ${COMPLETION_CAIRO_DE} >= ${MONTH_START_CAIRO}
           AND ${COMPLETION_CAIRO_DE} <  ${MONTH_START_CAIRO} + INTERVAL '1 month'), 0)
     + COALESCE((SELECT SUM(ae.earned_amount_egp)
          FROM addon_earnings ae
         WHERE ae.doctor_id = $1 AND ae.status = 'pending'
           AND ${COMPLETION_CAIRO_AE} >= ${MONTH_START_CAIRO}
           AND ${COMPLETION_CAIRO_AE} <  ${MONTH_START_CAIRO} + INTERVAL '1 month'), 0) AS not_yet_approved`,
    [doctorId]
  );
  const approved = money(row && row.approved);
  const notYetApproved = money(row && row.not_yet_approved);
  return { approved, notYetApproved, total: money(approved + notYetApproved) };
}

/**
 * Per-Cairo-month statement for /portal/doctor/earnings. One row per month,
 * main and add-on buckets side by side. 'reassigned' is exposed as a COUNT
 * (the fact belongs on the statement) but its money is always 0 by policy —
 * the reassigned_total columns the page renders are kept, computed over the
 * money-row set, so a legacy token amount can never resurface there.
 */
async function getDoctorMonthlyStatement(doctorId, { limitMonths = 24 } = {}) {
  const main = await queryAll(
    `SELECT date_trunc('month', ${COMPLETION_CAIRO_DE})::date AS month,
            COUNT(*) FILTER (WHERE ${MONEY_ROWS}) AS case_count,
            COALESCE(SUM(de.earned_amount) FILTER (WHERE ${MONEY_ROWS}), 0) AS total,
            COALESCE(SUM(de.earned_amount) FILTER (WHERE ${MONEY_ROWS} AND de.status='paid'), 0) AS paid_total,
            COALESCE(SUM(de.earned_amount) FILTER (WHERE ${MONEY_ROWS} AND de.status='pending'), 0) AS pending_total,
            0::float8 AS reassigned_total,
            COUNT(*) FILTER (WHERE de.status='reassigned' AND ${KIND_MAIN}) AS reassigned_count
       FROM doctor_earnings de ${COMPLETION_JOIN}
      WHERE de.doctor_id = $1
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT $2`,
    [doctorId, limitMonths]
  );
  const addons = await queryAll(
    `SELECT date_trunc('month', ${COMPLETION_CAIRO_AE})::date AS month,
            COALESCE(SUM(ae.earned_amount_egp), 0) AS total,
            COALESCE(SUM(ae.earned_amount_egp) FILTER (WHERE ae.status='paid'), 0) AS paid_total,
            COALESCE(SUM(ae.earned_amount_egp) FILTER (WHERE ae.status='pending'), 0) AS pending_total,
            0::float8 AS reassigned_total
       FROM addon_earnings ae
      WHERE ae.doctor_id = $1
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT $2`,
    [doctorId, limitMonths]
  );
  return { main: main || [], addons: addons || [] };
}

/**
 * Lifetime totals across both ledgers. `reassigned` is always 0 by policy —
 * returned for the page's existing Lifetime = Paid + Pending + Reassigned
 * identity, computed (not hardcoded) over the money rows so a legacy token
 * amount shows up as a discrepancy in tests rather than in a doctor's pocket.
 */
async function getDoctorLifetimeTotals(doctorId) {
  const m = await queryOne(
    `SELECT COALESCE(SUM(de.earned_amount) FILTER (WHERE ${MONEY_ROWS}), 0) AS total,
            COALESCE(SUM(de.earned_amount) FILTER (WHERE ${MONEY_ROWS} AND de.status='paid'), 0) AS paid,
            COALESCE(SUM(de.earned_amount) FILTER (WHERE ${MONEY_ROWS} AND de.status='pending'), 0) AS pending,
            COALESCE(SUM(de.earned_amount) FILTER (WHERE ${MONEY_ROWS} AND de.status='reassigned'), 0) AS reassigned
       FROM doctor_earnings de
      WHERE de.doctor_id = $1`,
    [doctorId]
  );
  const a = await queryOne(
    `SELECT COALESCE(SUM(ae.earned_amount_egp), 0) AS total,
            COALESCE(SUM(ae.earned_amount_egp) FILTER (WHERE ae.status='paid'), 0) AS paid,
            COALESCE(SUM(ae.earned_amount_egp) FILTER (WHERE ae.status='pending'), 0) AS pending,
            COALESCE(SUM(ae.earned_amount_egp) FILTER (WHERE ae.status='reassigned'), 0) AS reassigned
       FROM addon_earnings ae
      WHERE ae.doctor_id = $1`,
    [doctorId]
  );
  return {
    total: money(money(m && m.total) + money(a && a.total)),
    paid: money(money(m && m.paid) + money(a && a.paid)),
    pending: money(money(m && m.pending) + money(a && a.pending)),
    reassigned: money(money(m && m.reassigned) + money(a && a.reassigned))
  };
}

/**
 * Total earned from a given instant (doctor analytics headline; also the
 * video dashboard's stat). pending + paid across both ledgers; reassigned and
 * token rows contribute nothing. `fromDate` is an instant (Date/ISO); the
 * window is by completion date like every other figure here.
 */
async function getDoctorTotalEarned(doctorId, { fromDate } = {}) {
  const params = [doctorId];
  let deWindow = '';
  let aeWindow = '';
  if (fromDate) {
    params.push(fromDate);
    deWindow = ` AND ${COMPLETION_CAIRO_DE} >= ($2::timestamptz AT TIME ZONE '${BUSINESS_TZ}')`;
    aeWindow = ` AND ${COMPLETION_CAIRO_AE} >= ($2::timestamptz AT TIME ZONE '${BUSINESS_TZ}')`;
  }
  const row = await queryOne(
    `SELECT
       COALESCE((SELECT SUM(de.earned_amount)
          FROM doctor_earnings de ${COMPLETION_JOIN}
         WHERE de.doctor_id = $1 AND ${MONEY_ROWS}
           AND de.status IN ('pending','paid')${deWindow}), 0)
     + COALESCE((SELECT SUM(ae.earned_amount_egp)
          FROM addon_earnings ae
         WHERE ae.doctor_id = $1
           AND ae.status IN ('pending','paid')${aeWindow}), 0) AS total`,
    params
  );
  return money(row && row.total);
}

/**
 * Cairo-month earnings series for the analytics chart. Replaces the
 * TO_CHAR(created_at,'YYYY-MM') UTC-calendar/creation-date bucketing.
 */
async function getDoctorMonthlySeries(doctorId, { fromDate } = {}) {
  const params = [doctorId];
  let deWindow = '';
  if (fromDate) {
    params.push(fromDate);
    deWindow = ` AND ${COMPLETION_CAIRO_DE} >= ($2::timestamptz AT TIME ZONE '${BUSINESS_TZ}')`;
  }
  const rows = await queryAll(
    `SELECT to_char(date_trunc('month', ${COMPLETION_CAIRO_DE}), 'YYYY-MM') AS month,
            COALESCE(SUM(de.earned_amount), 0) AS earnings,
            COUNT(*) AS cases
       FROM doctor_earnings de ${COMPLETION_JOIN}
      WHERE de.doctor_id = $1 AND ${MONEY_ROWS}
        AND de.status IN ('pending','paid')${deWindow}
      GROUP BY 1
      ORDER BY 1 ASC`,
    params
  );
  return (rows || []).map((r) => ({
    month: r.month,
    earnings: money(r.earnings),
    cases: intOr0(r.cases)
  }));
}

/**
 * The per-case fee for a doctor's recent cases (analytics table). The fee is
 * the MAIN row for (order, doctor) — the same row earnings_writer settles —
 * never a token row (the old LEFT JOIN matched any row and could surface the
 * 10% token as "the fee"). Returns a map orderId → earned_amount for the ids
 * given; the route keeps its own orders query (and its A4 redaction) and
 * merges.
 */
async function getCaseFeesForOrders(doctorId, orderIds) {
  const ids = (orderIds || []).filter(Boolean).map(String);
  if (!ids.length) return {};
  const rows = await queryAll(
    `SELECT de.appointment_id AS order_id, de.earned_amount
       FROM doctor_earnings de
      WHERE de.doctor_id = $1
        AND ${KIND_MAIN}
        AND de.appointment_id = ANY($2::text[])`,
    [doctorId, ids]
  );
  const map = {};
  (rows || []).forEach((r) => { map[String(r.order_id)] = money(r.earned_amount); });
  return map;
}

/** Most recent PAID earning for the dashboard payout tile. Money rows only. */
async function getMostRecentPaidEarning(doctorId) {
  const re = await queryOne(
    `SELECT de.id,
            de.earned_amount,
            de.paid_at,
            COALESCE(ap.order_id, o.id) AS resolved_order_id
       FROM doctor_earnings de
       LEFT JOIN appointments ap ON ap.id = de.appointment_id
       LEFT JOIN orders_active o ON o.id = de.appointment_id
      WHERE de.doctor_id = $1
        AND ${MONEY_ROWS}
        AND de.status = 'paid'
        AND de.paid_at IS NOT NULL
      ORDER BY de.paid_at DESC
      LIMIT 1`,
    [doctorId]
  );
  if (!re) return null;
  return {
    id: re.id,
    earnedAmount: money(re.earned_amount),
    paidAt: re.paid_at,
    orderId: re.resolved_order_id || null
  };
}

// ── Finance / operator surfaces ────────────────────────────────────────────

/**
 * Per-doctor owed + paid-this-month rows for the payout surfaces (Command
 * /payouts, superadmin finance ledger). owed = pending across BOTH ledgers
 * (earnings_writer keeps add-ons out of doctor_earnings by design; only the
 * sum is what the doctor is shown). "paid this month" is by the PAYOUT stamp
 * (paid_at), current Cairo month — that is when the money moved.
 *
 * Fix round 2026-09-21 (adversarial M-1): `owedSettleableEgp` is the part of
 * owed that markMonthEndPaid can actually stamp — pending rows whose work is
 * DELIVERED (main rows require the order's completed_at; video rows and
 * add-on rows are written at the delivery moment, so all of theirs counts).
 * `owedInFlightEgp` is the accepted-but-undelivered remainder. The operator
 * transfers off this screen; without the split they could pay out the
 * in-flight figure for work not yet delivered — money a later reassignment
 * says was never earned.
 */
async function getOwedByDoctor({ limit = 200 } = {}) {
  const PAID_THIS_MONTH =
    `de.status = 'paid' AND ${PAID_AT_CAIRO_DE} >= ${MONTH_START_CAIRO}`;
  const PENDING = `${MONEY_ROWS} AND de.status = 'pending'`;
  const SETTLEABLE =
    `${PENDING} AND (de.id NOT LIKE 'earn-main-%' OR o.completed_at IS NOT NULL)`;
  const rows = await queryAll(
    `SELECT u.id AS doctor_id,
            COALESCE(u.name, '—') AS doctor_name,
            COALESCE(SUM(de.earned_amount) FILTER (WHERE ${PENDING}), 0)
              + COALESCE(ae.owed_addons, 0) AS owed,
            COALESCE(SUM(de.earned_amount) FILTER (WHERE ${PENDING}), 0) AS owed_cases,
            COALESCE(SUM(de.earned_amount) FILTER (WHERE ${SETTLEABLE}), 0)
              + COALESCE(ae.owed_addons, 0) AS owed_settleable,
            COALESCE(ae.owed_addons, 0) AS owed_addons,
            COUNT(*) FILTER (WHERE ${PENDING})::int AS unpaid_cases,
            MIN(de.created_at) FILTER (WHERE ${PENDING}) AS oldest_unpaid_at,
            MAX(COALESCE(de.paid_at, de.created_at)) FILTER (WHERE de.status = 'paid') AS last_paid_at,
            COALESCE(SUM(de.earned_amount) FILTER (WHERE ${MONEY_ROWS} AND ${PAID_THIS_MONTH}), 0) AS paid_this_month,
            COUNT(*) FILTER (WHERE de.created_at >= NOW() - INTERVAL '14 days') AS cycle_cases
       FROM users u
       JOIN doctor_earnings de ON de.doctor_id = u.id
       ${COMPLETION_JOIN}
       LEFT JOIN (
         SELECT doctor_id, SUM(earned_amount_egp) AS owed_addons
           FROM addon_earnings WHERE status = 'pending' GROUP BY doctor_id
       ) ae ON ae.doctor_id = u.id
      WHERE u.role = 'doctor'
      GROUP BY u.id, u.name, ae.owed_addons
     HAVING COALESCE(SUM(de.earned_amount) FILTER (WHERE ${PENDING}), 0)
              + COALESCE(ae.owed_addons, 0) > 0
         OR COALESCE(SUM(de.earned_amount) FILTER (WHERE ${MONEY_ROWS} AND ${PAID_THIS_MONTH}), 0) > 0
      ORDER BY owed DESC, paid_this_month DESC, doctor_name ASC
      LIMIT $1`,
    [limit]
  );
  return (rows || []).map((r) => {
    const owed = money(r.owed);
    const settleable = money(r.owed_settleable);
    return {
      doctorId: r.doctor_id,
      doctorName: r.doctor_name,
      owedEgp: owed,
      owedCasesEgp: money(r.owed_cases),
      owedAddonsEgp: money(r.owed_addons),
      owedSettleableEgp: settleable,
      owedInFlightEgp: money(owed - settleable),
      unpaidCases: intOr0(r.unpaid_cases),
      oldestUnpaidAt: r.oldest_unpaid_at || null,
      lastPaidAt: r.last_paid_at || null,
      paidThisMonthEgp: money(r.paid_this_month),
      cycleCases: intOr0(r.cycle_cases)
    };
  });
}

/**
 * Whole-table owed totals (web admin tiles, /payouts header). Never computed
 * from a trimmed per-doctor list — the headline liability stays true even
 * when a listing is capped.
 */
async function getGlobalOwedTotals() {
  const PAID_THIS_MONTH =
    `de.status = 'paid' AND ${PAID_AT_CAIRO_DE} >= ${MONTH_START_CAIRO}`;
  const PENDING = `${MONEY_ROWS} AND de.status = 'pending'`;
  const SETTLEABLE =
    `${PENDING} AND (de.id NOT LIKE 'earn-main-%' OR o.completed_at IS NOT NULL)`;
  const row = await queryOne(
    `SELECT COALESCE(SUM(de.earned_amount) FILTER (WHERE ${PENDING}), 0) AS owed_cases_total,
            COALESCE(SUM(de.earned_amount) FILTER (WHERE ${SETTLEABLE}), 0) AS owed_settleable_cases_total,
            COALESCE((SELECT SUM(earned_amount_egp) FROM addon_earnings WHERE status = 'pending'), 0) AS owed_addons_total,
            COUNT(*) FILTER (WHERE ${PENDING})::int AS unpaid_cases_total,
            COUNT(DISTINCT de.doctor_id) FILTER (WHERE ${PENDING})::int AS doctors_owed,
            MIN(de.created_at) FILTER (WHERE ${PENDING}) AS oldest_unpaid_at,
            COALESCE(SUM(de.earned_amount) FILTER (WHERE ${MONEY_ROWS} AND ${PAID_THIS_MONTH}), 0) AS paid_this_month,
            COUNT(*) FILTER (WHERE ${MONEY_ROWS} AND ${PAID_THIS_MONTH})::int AS paid_this_month_cases,
            to_char(${MONTH_START_CAIRO}, 'YYYY-MM-DD"T"HH24:MI:SS') AS month_start_cairo
       FROM doctor_earnings de
       ${COMPLETION_JOIN}`
  );
  const casesEgp = money(row && row.owed_cases_total);
  const addonsEgp = money(row && row.owed_addons_total);
  const settleableEgp = money(money(row && row.owed_settleable_cases_total) + addonsEgp);
  const totalEgp = money(casesEgp + addonsEgp);
  return {
    owedCasesEgp: casesEgp,
    owedAddonsEgp: addonsEgp,
    owedTotalEgp: totalEgp,
    // Fix round (adversarial M-1): what a month-end payout run can actually
    // settle today vs the accepted-but-undelivered remainder. See
    // getOwedByDoctor.
    owedSettleableEgp: settleableEgp,
    owedInFlightEgp: money(totalEgp - settleableEgp),
    unpaidCases: intOr0(row && row.unpaid_cases_total),
    doctorsOwed: intOr0(row && row.doctors_owed),
    oldestUnpaidAt: (row && row.oldest_unpaid_at) || null,
    paidThisMonthEgp: money(row && row.paid_this_month),
    paidThisMonthCases: intOr0(row && row.paid_this_month_cases),
    monthStartCairo: (row && row.month_start_cairo) || null
  };
}

/**
 * Owed per doctor for an id list (the superadmin doctors leaderboard merges
 * this into its own stats query instead of keeping four correlated
 * subqueries). Returns { [doctorId]: { owedCasesEgp, owedAddonsEgp, owedEgp } }.
 */
async function getOwedForDoctorIds(doctorIds) {
  const ids = (doctorIds || []).filter(Boolean).map(String);
  if (!ids.length) return {};
  const rows = await queryAll(
    `SELECT d.id AS doctor_id,
            COALESCE((SELECT SUM(de.earned_amount) FROM doctor_earnings de
               WHERE de.doctor_id = d.id AND ${MONEY_ROWS} AND de.status = 'pending'), 0) AS owed_cases,
            COALESCE((SELECT SUM(ae.earned_amount_egp) FROM addon_earnings ae
               WHERE ae.doctor_id = d.id AND ae.status = 'pending'), 0) AS owed_addons
       FROM unnest($1::text[]) AS d(id)`,
    [ids]
  );
  const map = {};
  (rows || []).forEach((r) => {
    const c = money(r.owed_cases);
    const a = money(r.owed_addons);
    map[String(r.doctor_id)] = { owedCasesEgp: c, owedAddonsEgp: a, owedEgp: money(c + a) };
  });
  return map;
}

/**
 * Clawback summary by policy for the Command /breach-cost surface. The
 * clawed-back AMOUNT is not stored (recomputeOnRefund overwrites
 * earned_amount in place), so it is derived from the policy string that fired:
 *   'sla_breach_full_clawback' (legacy rows, pre-Batch-B policy) → the
 *     pre-clawback value was the base share = orders.doctor_fee.
 *   the 90% policy → earned = 0.10 × full at a full refund, so clawback =
 *     9 × earned. Fix round 2026-09-21 (adversarial m-1): the writer has
 *     stamped '…scaled_90pct_clawback' since the 2026-08-17 scaling change,
 *     while this arm (carried over from the old inline query) matched only
 *     the retired unscaled string — so every modern 90% clawback reported
 *     0 EGP on the ops money surface. Both strings now match. For a PARTIAL
 *     refund under the scaled policy the ratio is not stored, so 9 × earned
 *     is exact at ratio 1 and an UPPER BOUND below it — the surface already
 *     flags the whole figure as derived, and a stated bound beats a silent
 *     zero.
 *   'sla_breach_uplift_zeroed' (the breach write-down, and post-Batch-B the
 *     sla_breach refund settlement) and anything unknown → counted, 0 EGP —
 *     the reversed uplift is not derivable from the row once sla_breach.js
 *     has zeroed orders.urgency_uplift_amount.
 * `fromCairoSql` is a SQL expression producing the Cairo wall-clock lower
 * bound (the caller already builds its window that way).
 */
async function getClawbackSummaryByPolicy({ fromCairoSql }) {
  const rows = await queryAll(
    `SELECT COALESCE(de.clawback_reason, 'unknown') AS policy,
            COUNT(*)::int AS n,
            COALESCE(SUM(
              CASE
                WHEN de.clawback_reason = 'sla_breach_full_clawback'
                  THEN COALESCE(o.doctor_fee, 0)
                WHEN de.clawback_reason IN ('patient_or_operator_post_acceptance_90pct_clawback',
                                            'patient_or_operator_post_acceptance_scaled_90pct_clawback')
                  THEN COALESCE(de.earned_amount, 0) * 9
                ELSE 0
              END), 0) AS egp
       FROM doctor_earnings de
       -- include-deleted-ok: settled money stays countable on a soft-deleted order
       JOIN orders o ON o.id = de.appointment_id
      WHERE de.clawback_applied_at IS NOT NULL
        AND ${KIND_MAIN}
        AND (de.clawback_applied_at::timestamptz AT TIME ZONE '${BUSINESS_TZ}') >= ${fromCairoSql}
      GROUP BY 1
      ORDER BY egp DESC`
  );
  return (rows || []).map((r) => ({
    policy: r.policy,
    n: intOr0(r.n),
    egp: money(r.egp)
  }));
}


// ── Doctor app additions (routes/api/doctor_money.js, 2026-09-24) ──────────
// Same four disciplines as everything above: Cairo month by completion date,
// MONEY_ROWS only, reassigned earns 0, every figure through money().

// The 'YYYY-MM' key of a completion instant — the same expression
// markMonthEndPaid stamps by, so a statement month and a payout month can
// never disagree.
const MONTH_KEY_DE = `to_char(date_trunc('month', ${COMPLETION_CAIRO_DE}), 'YYYY-MM')`;
const MONTH_KEY_AE = `to_char(date_trunc('month', ${COMPLETION_CAIRO_AE}), 'YYYY-MM')`;
const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function isMonthKey(v) {
  return MONTH_KEY_RE.test(String(v || ''));
}

// Current Cairo business month as 'YYYY-MM', computed in JS for callers that
// need the key without a round-trip (defaults, labels). Intl is DST-aware;
// Egypt observes DST again since 2023, so offset arithmetic is not safe here.
function currentCairoMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit'
  }).formatToParts(now);
  const pick = (t) => (parts.find((p) => p.type === t) || {}).value;
  return `${pick('year')}-${pick('month')}`;
}

// A statement `month` cell (date_trunc(...)::date) arrives as a JS Date
// (node-postgres parses DATE at LOCAL midnight) or, under a custom type
// parser, as 'YYYY-MM-DD'. Local getters are correct for the former; a UTC
// conversion of a local midnight could roll into the previous month.
function monthKeyOf(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}`;
  }
  const s = String(v || '');
  return isMonthKey(s.slice(0, 7)) ? s.slice(0, 7) : null;
}

/**
 * Per-component breakdown of one Cairo month (default: current) for the app's
 * earnings summary. Sums to getDoctorMonthSummary(...).total for the same
 * month: same rows (MONEY_ROWS, status pending|paid), same completion-month
 * bucket.
 *
 * Main rows are split back into base vs uplift by inverting the writer's
 * arithmetic (earnings_writer.writePendingForCase / settleCaseEarningsOnCompletion:
 * earned = doctor_fee + round2(urgency_uplift_amount x pct/100)): the uplift
 * share is whatever the settled amount exceeds orders.doctor_fee by, the base
 * is the rest. Two cases fold entirely into service_fees with uplift 0,
 * deliberately:
 *   - rows with clawback_applied_at set: recomputeOnRefund overwrites
 *     earned_amount in place with full x (1 - 0.9 x ratio) and the ratio is
 *     not stored, so the post-clawback base/uplift split is NOT derivable
 *     (a breach write-down leaves earned == doctor_fee, which the formula
 *     would also read as uplift 0 — same answer). The TOTAL stays exact.
 *   - rows whose order cannot be joined (legacy): no doctor_fee to split by.
 * Standalone video-appointment rows ('earn-<uuid>', 'earn-noshow-%') are
 * 'video'. Add-on rows are keyed by addon_services.type through order_addons;
 * only video_consult and prescription add-ons ever write addon_earnings
 * (services/addons/*.onComplete), so any other type is reported under 'other'
 * rather than silently folded into a named bucket.
 */
async function getDoctorMonthBreakdown(doctorId, month) {
  const key = isMonthKey(month) ? String(month) : currentCairoMonth();
  const UPLIFT_PART =
    `CASE WHEN ${KIND_MAIN} AND o.id IS NOT NULL AND de.clawback_applied_at IS NULL
          THEN GREATEST(de.earned_amount - COALESCE(o.doctor_fee, 0), 0)
          ELSE 0 END`;
  const main = await queryOne(
    `SELECT COUNT(*) FILTER (WHERE ${KIND_MAIN})::int AS report_count,
            COALESCE(SUM(de.earned_amount) FILTER (WHERE ${KIND_MAIN}), 0) AS report_total,
            COALESCE(SUM(${UPLIFT_PART}), 0) AS uplift_total,
            COUNT(*) FILTER (WHERE ${UPLIFT_PART} > 0)::int AS uplift_count,
            COUNT(*) FILTER (WHERE NOT (${KIND_MAIN}))::int AS video_count,
            COALESCE(SUM(de.earned_amount) FILTER (WHERE NOT (${KIND_MAIN})), 0) AS video_total
       FROM doctor_earnings de ${COMPLETION_JOIN}
      WHERE de.doctor_id = $1
        AND ${MONEY_ROWS}
        AND de.status IN ('pending','paid')
        AND ${MONTH_KEY_DE} = $2`,
    [doctorId, key]
  );
  const addons = await queryAll(
    `SELECT COALESCE(ads.type, 'unknown') AS addon_type,
            COUNT(*)::int AS n,
            COALESCE(SUM(ae.earned_amount_egp), 0) AS amount
       FROM addon_earnings ae
       JOIN order_addons oa ON oa.id = ae.order_addon_id
       LEFT JOIN addon_services ads ON ads.id = oa.addon_service_id
      WHERE ae.doctor_id = $1
        AND ae.status IN ('pending','paid')
        AND ${MONTH_KEY_AE} = $2
      GROUP BY 1`,
    [doctorId, key]
  );

  const reportTotal = money(main && main.report_total);
  const upliftTotal = money(main && main.uplift_total);
  const buckets = {
    service_fees: { count: intOr0(main && main.report_count), amount: money(reportTotal - upliftTotal) },
    uplift_share: { count: intOr0(main && main.uplift_count), amount: upliftTotal },
    video: { count: intOr0(main && main.video_count), amount: money(main && main.video_total) },
    prescription: { count: 0, amount: 0 },
    other: { count: 0, amount: 0 }
  };
  const ADDON_KEY = { video_consult: 'video', prescription: 'prescription' };
  (addons || []).forEach((r) => {
    const k = ADDON_KEY[String(r.addon_type)] || 'other';
    buckets[k].count += intOr0(r.n);
    buckets[k].amount = money(buckets[k].amount + money(r.amount));
  });
  const breakdown = ['service_fees', 'uplift_share', 'video', 'prescription']
    .map((k) => ({ key: k, count: buckets[k].count, amount: buckets[k].amount }));
  if (buckets.other.count > 0) {
    breakdown.push({ key: 'other', count: buckets.other.count, amount: buckets.other.amount });
  }
  return { month: key, breakdown };
}

/**
 * One line per ledger row in a Cairo month (default: current) — every
 * doctor_earnings money row (main and standalone video) and every
 * addon_earnings row — for the app's earnings detail list. Money is the
 * stored figure: a clawback is applied IN PLACE by recomputeOnRefund /
 * recomputeOnBreach (earned_amount overwritten, clawback_applied_at stamped;
 * there is no separate negative row and the clawed-back amount is not stored
 * — see getClawbackSummaryByPolicy), so a clawed-back line carries its
 * post-clawback amount (>= 0) plus the stamp and reason, never an invented
 * negative. A 'reassigned' main row is listed at 0 with its reason: the fact
 * belongs on the statement even though it is never money.
 *
 * `ref` is orders.reference_id (or null when the order is gone) — never a
 * patient name. Month bucketing uses COMPLETION_JOIN (plain orders, include-
 * deleted-ok, like every sum here) so lines reconcile to the totals; the
 * display fields come from orders_active so a soft-deleted order shows no
 * reference.
 */
async function getDoctorEarningLines(doctorId, month) {
  const key = isMonthKey(month) ? String(month) : currentCairoMonth();
  const mainRows = await queryAll(
    `SELECT de.id,
            CASE WHEN ${KIND_MAIN} THEN 'report' ELSE 'video' END AS kind,
            oa.reference_id,
            oa.urgency_tier AS tier,
            de.earned_amount AS amount,
            de.status,
            de.clawback_reason,
            de.clawback_applied_at,
            de.reassignment_reason,
            de.paid_at,
            COALESCE(o.completed_at, de.created_at::timestamptz) AS completed_at
       FROM doctor_earnings de ${COMPLETION_JOIN}
       LEFT JOIN orders_active oa ON oa.id = de.appointment_id AND ${KIND_MAIN}
      WHERE de.doctor_id = $1
        AND ${MONEY_ROWS}
        AND ${MONTH_KEY_DE} = $2
      ORDER BY 11 DESC, de.id ASC`,
    [doctorId, key]
  );
  const addonRows = await queryAll(
    `SELECT ae.id,
            CASE WHEN ads.type = 'prescription' THEN 'prescription' ELSE 'video' END AS kind,
            o.reference_id,
            o.urgency_tier AS tier,
            ae.earned_amount_egp AS amount,
            ae.status,
            ae.paid_at,
            ae.created_at AS completed_at
       FROM addon_earnings ae
       JOIN order_addons oda ON oda.id = ae.order_addon_id
       LEFT JOIN addon_services ads ON ads.id = oda.addon_service_id
       LEFT JOIN orders_active o ON o.id = oda.order_id
      WHERE ae.doctor_id = $1
        AND ${MONTH_KEY_AE} = $2
      ORDER BY ae.created_at DESC, ae.id ASC`,
    [doctorId, key]
  );
  const norm = (r, src) => ({
    id: String(r.id),
    source: src,
    kind: r.kind,
    reference_id: r.reference_id || null,
    tier: r.tier || null,
    amount: money(r.amount),
    status: String(r.status || 'pending'),
    clawback_reason: r.clawback_reason || null,
    clawback_applied_at: r.clawback_applied_at || null,
    reassignment_reason: r.reassignment_reason || null,
    paid_at: r.paid_at || null,
    completed_at: r.completed_at || null
  });
  const lines = (mainRows || []).map((r) => norm(r, 'doctor_earnings'))
    .concat((addonRows || []).map((r) => norm(r, 'addon_earnings')));
  lines.sort((a, b) => {
    const ta = a.completed_at ? new Date(a.completed_at).getTime() : 0;
    const tb = b.completed_at ? new Date(b.completed_at).getTime() : 0;
    return tb - ta;
  });
  return { month: key, lines };
}

/**
 * When each Cairo month's payout landed: the latest paid_at across both
 * ledgers, keyed by completion month — the companion of
 * getDoctorMonthlyStatement for a statement's paid_at column. Returns
 * { 'YYYY-MM': <timestamp> } for months that have at least one paid row.
 */
async function getDoctorStatementPaidAt(doctorId, { limitMonths = 24 } = {}) {
  const rows = await queryAll(
    `SELECT month, MAX(paid_at) AS paid_at FROM (
        SELECT ${MONTH_KEY_DE} AS month, de.paid_at
          FROM doctor_earnings de ${COMPLETION_JOIN}
         WHERE de.doctor_id = $1 AND ${MONEY_ROWS} AND de.status = 'paid' AND de.paid_at IS NOT NULL
        UNION ALL
        SELECT ${MONTH_KEY_AE} AS month, ae.paid_at
          FROM addon_earnings ae
         WHERE ae.doctor_id = $1 AND ae.status = 'paid' AND ae.paid_at IS NOT NULL
      ) p
      GROUP BY month
      ORDER BY month DESC
      LIMIT $2`,
    [doctorId, limitMonths]
  );
  const map = {};
  (rows || []).forEach((r) => { if (r.month) map[String(r.month)] = r.paid_at; });
  return map;
}

module.exports = {
  getDoctorMonthSummary,
  getDoctorMonthlyStatement,
  getDoctorLifetimeTotals,
  getDoctorTotalEarned,
  getDoctorMonthlySeries,
  getCaseFeesForOrders,
  getMostRecentPaidEarning,
  getOwedByDoctor,
  getGlobalOwedTotals,
  getOwedForDoctorIds,
  getClawbackSummaryByPolicy,
  // Doctor app additions (2026-09-24)
  getDoctorMonthBreakdown,
  getDoctorEarningLines,
  getDoctorStatementPaidAt,
  currentCairoMonth,
  monthKeyOf,
  isMonthKey,
  // Exported for tests and for the writer's month-end stamp, so the payout
  // action and every reader share one definition of the boundary.
  BUSINESS_TZ,
  MONTH_START_CAIRO,
  COMPLETION_CAIRO_DE,
  COMPLETION_JOIN,
  COMPLETION_CAIRO_AE,
  PAID_AT_CAIRO_DE,
  KIND_MAIN,
  KIND_REASSIGN_TOKEN,
  MONEY_ROWS,
  money
};
