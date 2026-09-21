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
 */
async function getOwedByDoctor({ limit = 200 } = {}) {
  const PAID_THIS_MONTH =
    `de.status = 'paid' AND ${PAID_AT_CAIRO_DE} >= ${MONTH_START_CAIRO}`;
  const rows = await queryAll(
    `SELECT u.id AS doctor_id,
            COALESCE(u.name, '—') AS doctor_name,
            COALESCE(SUM(de.earned_amount) FILTER (WHERE ${MONEY_ROWS} AND de.status = 'pending'), 0)
              + COALESCE(ae.owed_addons, 0) AS owed,
            COALESCE(SUM(de.earned_amount) FILTER (WHERE ${MONEY_ROWS} AND de.status = 'pending'), 0) AS owed_cases,
            COALESCE(ae.owed_addons, 0) AS owed_addons,
            COUNT(*) FILTER (WHERE ${MONEY_ROWS} AND de.status = 'pending')::int AS unpaid_cases,
            MIN(de.created_at) FILTER (WHERE ${MONEY_ROWS} AND de.status = 'pending') AS oldest_unpaid_at,
            MAX(COALESCE(de.paid_at, de.created_at)) FILTER (WHERE de.status = 'paid') AS last_paid_at,
            COALESCE(SUM(de.earned_amount) FILTER (WHERE ${MONEY_ROWS} AND ${PAID_THIS_MONTH}), 0) AS paid_this_month,
            COUNT(*) FILTER (WHERE de.created_at >= NOW() - INTERVAL '14 days') AS cycle_cases
       FROM users u
       JOIN doctor_earnings de ON de.doctor_id = u.id
       LEFT JOIN (
         SELECT doctor_id, SUM(earned_amount_egp) AS owed_addons
           FROM addon_earnings WHERE status = 'pending' GROUP BY doctor_id
       ) ae ON ae.doctor_id = u.id
      WHERE u.role = 'doctor'
      GROUP BY u.id, u.name, ae.owed_addons
     HAVING COALESCE(SUM(de.earned_amount) FILTER (WHERE ${MONEY_ROWS} AND de.status = 'pending'), 0)
              + COALESCE(ae.owed_addons, 0) > 0
         OR COALESCE(SUM(de.earned_amount) FILTER (WHERE ${MONEY_ROWS} AND ${PAID_THIS_MONTH}), 0) > 0
      ORDER BY owed DESC, paid_this_month DESC, doctor_name ASC
      LIMIT $1`,
    [limit]
  );
  return (rows || []).map((r) => ({
    doctorId: r.doctor_id,
    doctorName: r.doctor_name,
    owedEgp: money(r.owed),
    owedCasesEgp: money(r.owed_cases),
    owedAddonsEgp: money(r.owed_addons),
    unpaidCases: intOr0(r.unpaid_cases),
    oldestUnpaidAt: r.oldest_unpaid_at || null,
    lastPaidAt: r.last_paid_at || null,
    paidThisMonthEgp: money(r.paid_this_month),
    cycleCases: intOr0(r.cycle_cases)
  }));
}

/**
 * Whole-table owed totals (web admin tiles, /payouts header). Never computed
 * from a trimmed per-doctor list — the headline liability stays true even
 * when a listing is capped.
 */
async function getGlobalOwedTotals() {
  const PAID_THIS_MONTH =
    `de.status = 'paid' AND ${PAID_AT_CAIRO_DE} >= ${MONTH_START_CAIRO}`;
  const row = await queryOne(
    `SELECT COALESCE(SUM(de.earned_amount) FILTER (WHERE ${MONEY_ROWS} AND de.status = 'pending'), 0) AS owed_cases_total,
            COALESCE((SELECT SUM(earned_amount_egp) FROM addon_earnings WHERE status = 'pending'), 0) AS owed_addons_total,
            COUNT(*) FILTER (WHERE ${MONEY_ROWS} AND de.status = 'pending')::int AS unpaid_cases_total,
            COUNT(DISTINCT de.doctor_id) FILTER (WHERE ${MONEY_ROWS} AND de.status = 'pending')::int AS doctors_owed,
            MIN(de.created_at) FILTER (WHERE ${MONEY_ROWS} AND de.status = 'pending') AS oldest_unpaid_at,
            COALESCE(SUM(de.earned_amount) FILTER (WHERE ${MONEY_ROWS} AND ${PAID_THIS_MONTH}), 0) AS paid_this_month,
            COUNT(*) FILTER (WHERE ${MONEY_ROWS} AND ${PAID_THIS_MONTH})::int AS paid_this_month_cases,
            to_char(${MONTH_START_CAIRO}, 'YYYY-MM-DD"T"HH24:MI:SS') AS month_start_cairo
       FROM doctor_earnings de`
  );
  const casesEgp = money(row && row.owed_cases_total);
  const addonsEgp = money(row && row.owed_addons_total);
  return {
    owedCasesEgp: casesEgp,
    owedAddonsEgp: addonsEgp,
    owedTotalEgp: money(casesEgp + addonsEgp),
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
 *   '...90pct_clawback' → earned = 0.10 × full, so clawback = 9 × earned.
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
                WHEN de.clawback_reason = 'patient_or_operator_post_acceptance_90pct_clawback'
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
