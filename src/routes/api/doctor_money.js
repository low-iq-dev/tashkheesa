'use strict';

/**
 * Tashkheesa — the doctor app's money surface: /api/v1/doctor/*
 *
 *   GET /earnings              this Cairo month, structured
 *   GET /earnings/lines        one line per ledger row in a month
 *   GET /statements            one statement per Cairo month
 *   GET /reviews               the doctor's visible reviews
 *   GET /analytics             90-day performance figures
 *
 * The one rule that matters here: NO earnings SQL in this file. Every figure
 * that is money comes from services/earnings_reader.js — the single place the
 * doctor_earnings / addon_earnings ledgers are aggregated — so the app, the
 * web earnings page, the dashboard tile and Command finance cannot disagree
 * about a row. The reviews and analytics queries below read orders_active,
 * reviews and doctor_assignments (not money) and mirror the portal's own SQL
 * in routes/reviews.js and routes/doctor.js's performance snapshot.
 *
 * Nothing here reads orders.price or any patient-price column: the doctor is
 * shown their fee, never what the patient paid.
 */

const express = require('express');
const { requireJWT, requireRole } = require('../../middleware/requireJWT');
const earningsReader = require('../../services/earnings_reader');
const caseLifecycle = require('../../case_lifecycle');

module.exports = function (db, helpers) {
  const { safeGet, safeAll } = helpers || {};
  const router = express.Router();

  router.use(requireJWT);
  router.use(requireRole('doctor'));

  const meId = (req) => (req.user && req.user.id ? String(req.user.id) : '');

  // Express 4 does not catch a rejected async handler; a reader throwing on a
  // DB error would otherwise hang the request. Every failure is a 500 with a
  // stable code the app can branch on.
  const guarded = (code, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      console.warn('[doctor_money] ' + code + ':', e && e.message);
      if (!res.headersSent) res.fail('Could not load data', 500, code);
    }
  };

  // Completed-status spellings, from case_lifecycle's own map — orders.status
  // holds 'completed' plus legacy 'done'/'finished' variants and only the
  // lifecycle module owns that list.
  const COMPLETED_STATUSES = [...new Set(
    caseLifecycle.dbStatusValuesFor(caseLifecycle.CASE_STATUS.COMPLETED)
      .map((v) => String(v).toLowerCase())
  )];

  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const round1 = (v) => Math.round(num(v) * 10) / 10;
  const iso = (v) => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
  };

  // ─── GET /earnings ────────────────────────────────────────
  // The current Cairo business month, structured. month_total is the reader's
  // pending + paid figure (reassigned earns 0 and is in no money figure); the
  // breakdown is the same rows split by component and sums to month_total.
  router.get('/earnings', guarded('EARNINGS_UNAVAILABLE', async (req, res) => {
    const doctorId = meId(req);
    if (!doctorId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');

    const month = earningsReader.currentCairoMonth();
    const [summary, statement, breakdown, lastPaid] = await Promise.all([
      earningsReader.getDoctorMonthSummary(doctorId),
      earningsReader.getDoctorMonthlyStatement(doctorId, { limitMonths: 24 }),
      earningsReader.getDoctorMonthBreakdown(doctorId, month),
      earningsReader.getMostRecentPaidEarning(doctorId),
    ]);

    // This month's main / add-on buckets from the statement (same reader,
    // same Cairo-by-completion bucketing as the summary).
    const mainRow = (statement.main || []).find((r) => earningsReader.monthKeyOf(r.month) === month);
    const addonRow = (statement.addons || []).find((r) => earningsReader.monthKeyOf(r.month) === month);
    const reportsTotal = earningsReader.money(mainRow ? mainRow.total : 0);
    const addonsTotal = earningsReader.money(addonRow ? addonRow.total : 0);
    // Reassigned money is 0 by policy; the reader computes it rather than
    // hardcoding it, and so does this.
    const reassignedTotal = earningsReader.money(
      (mainRow ? num(mainRow.reassigned_total) : 0) + (addonRow ? num(addonRow.reassigned_total) : 0)
    );

    // Last payout: the month the most recently paid row belongs to, with that
    // month's full paid amount — not the single row's figure.
    let last_paid = null;
    if (lastPaid && lastPaid.paidAt) {
      const paidAtMap = await earningsReader.getDoctorStatementPaidAt(doctorId, { limitMonths: 24 });
      const paidMonth = Object.keys(paidAtMap)
        .filter((k) => iso(paidAtMap[k]) === iso(lastPaid.paidAt))
        .sort()
        .pop() || null;
      const pm = paidMonth ? (statement.main || []).find((r) => earningsReader.monthKeyOf(r.month) === paidMonth) : null;
      const pa = paidMonth ? (statement.addons || []).find((r) => earningsReader.monthKeyOf(r.month) === paidMonth) : null;
      last_paid = {
        month: paidMonth,
        amount: paidMonth
          ? earningsReader.money(num(pm && pm.paid_total) + num(pa && pa.paid_total))
          : lastPaid.earnedAmount,
        paid_at: iso(lastPaid.paidAt),
      };
    }

    return res.ok({
      month,
      month_total: summary.total,
      reports_total: reportsTotal,
      addons_total: addonsTotal,
      reassigned_total: reassignedTotal,
      reassigned_count: mainRow ? num(mainRow.reassigned_count) : 0,
      breakdown: breakdown.breakdown,
      last_paid,
    });
  }));

  // ─── GET /earnings/lines?month=YYYY-MM ────────────────────
  // One line per ledger row. `ref` is the case reference, never a patient
  // name; `detail` is structured for the app to localise. A clawback is
  // applied IN PLACE by earnings_writer (earned_amount overwritten, the
  // clawed-back amount is not stored), so the line carries the post-clawback
  // amount (>= 0) with status 'clawback' and the reason — no negative figure
  // is invented.
  router.get('/earnings/lines', guarded('EARNINGS_UNAVAILABLE', async (req, res) => {
    const doctorId = meId(req);
    if (!doctorId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');
    const wanted = req.query.month != null ? String(req.query.month) : '';
    if (wanted && !earningsReader.isMonthKey(wanted)) {
      return res.fail('month must be YYYY-MM', 400, 'INVALID_MONTH');
    }
    const month = wanted || earningsReader.currentCairoMonth();
    const result = await earningsReader.getDoctorEarningLines(doctorId, month);

    const lines = (result.lines || []).map((l) => {
      let status = 'pending';
      if (l.clawback_applied_at) status = 'clawback';
      else if (l.status === 'reassigned') status = 'reassigned';
      else if (l.status === 'paid') status = 'paid';
      return {
        id: l.id,
        ref: l.reference_id || (l.source === 'addon_earnings' ? 'Add-on' : null),
        detail: { kind: l.kind, tier: l.tier || null },
        amount: l.amount,
        status,
        note: l.clawback_reason || l.reassignment_reason || null,
        at: iso(l.completed_at),
        paid_at: iso(l.paid_at),
      };
    });
    return res.ok({ month, lines });
  }));

  // ─── GET /statements ──────────────────────────────────────
  // One statement per Cairo month from the shared monthly statement. 'paid'
  // means the month is closed and nothing in it is still pending — i.e. the
  // month-end payout stamped every row. The current month is always 'open'.
  // The portal stores no payout method for a doctor, so `payout` is nulls.
  router.get('/statements', guarded('STATEMENTS_UNAVAILABLE', async (req, res) => {
    const doctorId = meId(req);
    if (!doctorId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');

    const current = earningsReader.currentCairoMonth();
    const [statement, paidAtMap] = await Promise.all([
      earningsReader.getDoctorMonthlyStatement(doctorId, { limitMonths: 24 }),
      earningsReader.getDoctorStatementPaidAt(doctorId, { limitMonths: 24 }),
    ]);

    const byMonth = {};
    const bucket = (k) => {
      if (!byMonth[k]) byMonth[k] = { main_total: 0, main_pending: 0, addon_total: 0, addon_pending: 0, reassigned_count: 0 };
      return byMonth[k];
    };
    for (const r of statement.main || []) {
      const k = earningsReader.monthKeyOf(r.month);
      if (!k) continue;
      const b = bucket(k);
      b.main_total = num(r.total);
      b.main_pending = num(r.pending_total);
      b.reassigned_count = num(r.reassigned_count);
    }
    for (const r of statement.addons || []) {
      const k = earningsReader.monthKeyOf(r.month);
      if (!k) continue;
      const b = bucket(k);
      b.addon_total = num(r.total);
      b.addon_pending = num(r.pending_total);
    }

    const statements = Object.keys(byMonth).sort().reverse().map((k) => {
      const b = byMonth[k];
      const closed = k < current && b.main_pending === 0 && b.addon_pending === 0;
      return {
        id: 'st_' + k.replace('-', '_'),
        month: k,
        amount: earningsReader.money(b.main_total + b.addon_total),
        status: closed ? 'paid' : 'open',
        paid_at: closed ? iso(paidAtMap[k]) : null,
        reassigned_count: b.reassigned_count,
      };
    });

    return res.ok({ statements, payout: { method: null, handle: null } });
  }));

  // ─── GET /reviews ─────────────────────────────────────────
  // Same predicate as routes/reviews.js (visible only), for this doctor,
  // newest first, capped at 50. The patient is never named: anonymous or
  // not, the app gets the case reference.
  router.get('/reviews', guarded('REVIEWS_UNAVAILABLE', async (req, res) => {
    const doctorId = meId(req);
    if (!doctorId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');

    const stats = await safeGet(
      `SELECT AVG(rating) AS avg_rating, COUNT(*)::int AS count
         FROM reviews WHERE doctor_id = $1 AND is_visible = true`,
      [doctorId], { avg_rating: 0, count: 0 }
    );
    const dist = await safeAll(
      `SELECT rating, COUNT(*)::int AS n
         FROM reviews WHERE doctor_id = $1 AND is_visible = true
        GROUP BY rating`,
      [doctorId], []
    );
    const rows = await safeAll(
      `SELECT r.id, r.rating, r.review_text, r.is_anonymous, r.created_at,
              o.reference_id
         FROM reviews r
         LEFT JOIN orders_active o ON o.id = r.order_id
        WHERE r.doctor_id = $1 AND r.is_visible = true
        ORDER BY r.created_at DESC
        LIMIT 50`,
      [doctorId], []
    );

    const distMap = {};
    (dist || []).forEach((d) => { distMap[num(d.rating)] = num(d.n); });
    return res.ok({
      avg: stats ? round1(stats.avg_rating) : 0,
      count: stats ? num(stats.count) : 0,
      distribution: [5, 4, 3, 2, 1].map((stars) => ({ stars, n: distMap[stars] || 0 })),
      reviews: (rows || []).map((r) => ({
        id: r.id,
        stars: num(r.rating),
        text: r.review_text || null,
        order_reference: r.reference_id || null,
        created_at: iso(r.created_at),
        anonymous: r.is_anonymous === true,
      })),
    });
  }));

  // ─── GET /analytics ───────────────────────────────────────
  // 90-day performance figures over orders_active (practice cases excluded
  // everywhere, as the dashboard snapshot does). Turnaround is accepted_at →
  // completed_at, the strict form the dashboard's 30-day figure uses, so it
  // measures the doctor's speed and not wall-clock since case creation.
  // Promised hours per tier come from case_lifecycle.SLA_HOURS_BY_TIER, the
  // single source of truth for the SLA promise.
  router.get('/analytics', guarded('ANALYTICS_UNAVAILABLE', async (req, res) => {
    const doctorId = meId(req);
    if (!doctorId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');

    const COMPLETED = `LOWER(COALESCE(o.status, '')) = ANY($2::text[])`;
    const params = [doctorId, COMPLETED_STATUSES];

    const headline = await safeGet(
      `SELECT COUNT(*) FILTER (WHERE ${COMPLETED} AND o.completed_at >= NOW() - INTERVAL '90 days')::int AS reports_issued,
              AVG(EXTRACT(EPOCH FROM (o.completed_at - o.accepted_at)) / 3600.0)
                FILTER (WHERE ${COMPLETED} AND o.completed_at IS NOT NULL AND o.accepted_at IS NOT NULL
                          AND o.completed_at >= NOW() - INTERVAL '90 days') AS avg_turnaround_h,
              COUNT(*) FILTER (WHERE (o.breached_at IS NOT NULL
                                      OR (o.completed_at IS NOT NULL AND o.deadline_at IS NOT NULL
                                          AND o.completed_at > o.deadline_at))
                                 AND COALESCE(o.breached_at, o.completed_at) >= NOW() - INTERVAL '90 days')::int AS deadlines_missed
         FROM orders_active o
        WHERE o.doctor_id = $1 AND NOT o.is_practice`,
      params, null
    );

    // Acceptance: assignments offered to this doctor in the window that were
    // accepted, over all offered. 100 when nothing was offered.
    const acceptance = await safeGet(
      `SELECT COUNT(*)::int AS offered,
              COUNT(*) FILTER (WHERE da.accepted_at IS NOT NULL)::int AS accepted
         FROM doctor_assignments da
         JOIN orders_active o ON o.id = da.case_id
        WHERE da.doctor_id = $1
          AND NOT o.is_practice
          AND COALESCE(da.assigned_at, da.accepted_at) >= NOW() - INTERVAL '90 days'`,
      [doctorId], { offered: 0, accepted: 0 }
    );

    // Completions per Cairo month, last 6 months, by completion date — the
    // same month definition the earnings reader uses.
    const monthlyRows = await safeAll(
      `SELECT to_char(date_trunc('month', o.completed_at AT TIME ZONE '${earningsReader.BUSINESS_TZ}'), 'YYYY-MM') AS label,
              COUNT(*)::int AS n
         FROM orders_active o
        WHERE o.doctor_id = $1 AND NOT o.is_practice
          AND ${COMPLETED}
          AND o.completed_at IS NOT NULL
          AND (o.completed_at AT TIME ZONE '${earningsReader.BUSINESS_TZ}')
              >= date_trunc('month', NOW() AT TIME ZONE '${earningsReader.BUSINESS_TZ}') - INTERVAL '5 months'
        GROUP BY 1
        ORDER BY 1 ASC`,
      params, []
    );

    const tierRows = await safeAll(
      `SELECT LOWER(COALESCE(o.urgency_tier, 'standard')) AS tier,
              AVG(EXTRACT(EPOCH FROM (o.completed_at - o.accepted_at)) / 3600.0) AS actual_h
         FROM orders_active o
        WHERE o.doctor_id = $1 AND NOT o.is_practice
          AND ${COMPLETED}
          AND o.completed_at IS NOT NULL AND o.accepted_at IS NOT NULL
          AND o.completed_at >= NOW() - INTERVAL '90 days'
        GROUP BY 1`,
      params, []
    );

    // Last 6 Cairo months, zero-filled, oldest first.
    const monthMap = {};
    (monthlyRows || []).forEach((r) => { monthMap[String(r.label)] = num(r.n); });
    const [cy, cm] = earningsReader.currentCairoMonth().split('-').map(Number);
    const monthly = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(cy, cm - 1 - i, 1));
      const label = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      monthly.push({ label, n: monthMap[label] || 0 });
    }

    // 'fast_track' is the legacy alias of 'vip' (case_lifecycle); fold it in.
    const actualByTier = {};
    (tierRows || []).forEach((r) => {
      const t = r.tier === 'fast_track' ? 'vip' : String(r.tier);
      if (r.actual_h != null) actualByTier[t] = round1(r.actual_h);
    });
    const turnaround = ['standard', 'vip', 'urgent'].map((tier) => ({
      tier,
      promised_h: caseLifecycle.SLA_HOURS_BY_TIER[tier],
      actual_h: actualByTier[tier] != null ? actualByTier[tier] : null,
    }));

    const offered = num(acceptance && acceptance.offered);
    const accepted = num(acceptance && acceptance.accepted);
    return res.ok({
      reports_issued: num(headline && headline.reports_issued),
      acceptance_pct: offered > 0 ? round1((accepted / offered) * 100) : 100,
      avg_turnaround_h: headline && headline.avg_turnaround_h != null ? round1(headline.avg_turnaround_h) : null,
      deadlines_missed: num(headline && headline.deadlines_missed),
      monthly,
      turnaround,
    });
  }));

  return router;
};
