/**
 * Tashkheesa Command — bulk auto-assign (superadmin, production WRITE).
 *
 * Assign many unassigned cases in one shot. The selection rule is the
 * ESTABLISHED one (least active caseload within specialty — same metric as
 * auto_assign.js / the candidates picker), expressed in single-assign's exact
 * eligibility terms (active, not paused, specialty match, under capacity). The
 * per-case WRITE is byte-for-byte single-assign's first-assign branch
 * (orders UPDATE + doctor_assignments INSERT + order_events + admin audit).
 *
 * Guarantees, all in ONE outer transaction:
 *   - per-case atomicity   — each case's 4 writes happen under a SAVEPOINT, so
 *                            a mid-case fault rolls back just that case;
 *   - cumulative capacity  — a projected-load map seeded from the in-txn COUNT
 *                            is incremented as the batch fills, so a doctor at
 *                            4/5 takes exactly one more then drops out;
 *   - partial success      — un-assignable cases are skipped-with-reason, the
 *                            rest still commit;
 *   - manual-review respect— manual_queue / manual_pending / manual_claimed are
 *                            never auto-routed (skipped flagged_manual_review).
 *
 * dryRun runs the identical plan then ROLLBACKs — it is the recap source AND
 * the prove-it-safe mechanism (prod BEGIN…ROLLBACK across real rows).
 *
 * Silent by design (v1): NO notifications, NO accepted_at/deadline_at (the SLA
 * clock starts at doctor ACCEPTANCE, not assignment). Bulk is first-assign only
 * — it never reassigns an already-assigned case.
 *
 * The caller owns the pg client lifecycle (db.connect()/release()); this
 * function owns the BEGIN…COMMIT/ROLLBACK on it.
 */

'use strict';

const { randomUUID } = require('crypto');
const {
  normalizeStatus,
  doctorSupportsTier,
  capFor,
  acceptByIso,
} = require('../routes/api/_assign_helpers');

// Assignment states that mean "a human flagged this case for review" — never
// auto-route these (low classifier confidence, or auto-assign already found no
// eligible doctor). The operator can still single-assign one by hand.
const MANUAL_REVIEW_STATES = new Set(['manual_queue', 'manual_pending', 'manual_claimed']);

// Active-caseload definition — identical to single-assign's capacity COUNT.
const LOAD_EXCLUDED_STATUSES = ['completed', 'cancelled', 'expired_unpaid', 'refunded'];

/**
 * @param {import('pg').PoolClient} client  already-connected pg client
 * @param {{ caseIds: string[], actorId: string, dryRun?: boolean }} opts
 * @returns {Promise<{ dryRun, requested, assigned, skipped, counts }>}
 */
async function bulkAutoAssign(client, opts) {
  const caseIds = [...new Set((opts && opts.caseIds ? opts.caseIds : []).map((x) => String(x)))];
  const actorId = opts && opts.actorId ? opts.actorId : null;
  const dryRun = !!(opts && opts.dryRun);

  const assigned = [];
  const skipped = [];
  const projected = new Map();   // doctorId -> projected active load
  const poolCache = new Map();    // specialtyId -> doctor rows
  const foundIds = new Set();

  await client.query('BEGIN');
  try {
    // Lock + load the selected cases. Order: urgent-first → soonest deadline →
    // oldest created, so when capacity fills mid-batch the scarce slots go to
    // the most time-critical cases. Deterministic → dry-run recap == real run.
    const { rows: cases } = await client.query(
      `SELECT id, reference_id, doctor_id, status, payment_status, paid_at,
              specialty_id, urgency_tier, sla_hours, assignment_status,
              deadline_at, created_at
         FROM orders
        WHERE id = ANY($1::text[]) AND deleted_at IS NULL
        ORDER BY (LOWER(COALESCE(urgency_tier,'standard')) = 'urgent') DESC,
                 (deadline_at IS NULL), deadline_at::timestamptz ASC, created_at ASC
        FOR UPDATE`,
      [caseIds]
    );
    cases.forEach((c) => foundIds.add(c.id));

    let i = 0;
    for (const c of cases) {
      const ref = c.reference_id || null;
      const sp = 'sp_bulk_' + (i++);

      // ── case-level validations (single-assign's rules, first-assign only) ──
      if (c.doctor_id) { skipped.push({ caseId: c.id, reference: ref, reason: 'already_assigned' }); continue; }

      const paid = !!c.paid_at && (String(c.payment_status || '').toLowerCase() === 'paid'
        || (!c.payment_status && String(c.status || '').toLowerCase() === 'paid'));
      if (!paid) { skipped.push({ caseId: c.id, reference: ref, reason: 'payment_not_confirmed' }); continue; }

      if (normalizeStatus(c.status) !== 'paid') { skipped.push({ caseId: c.id, reference: ref, reason: 'not_assignable' }); continue; }
      if (!c.specialty_id) { skipped.push({ caseId: c.id, reference: ref, reason: 'no_specialty' }); continue; }
      if (MANUAL_REVIEW_STATES.has(String(c.assignment_status || '').toLowerCase())) {
        skipped.push({ caseId: c.id, reference: ref, reason: 'flagged_manual_review' });
        continue;
      }

      // ── doctor pool for the specialty (cached; projected load seeded once) ──
      let pool = poolCache.get(c.specialty_id);
      if (!pool) {
        pool = (await client.query(
          `SELECT id, name, is_active, is_paused, max_active_cases, max_active_cases_urgent, sla_tiers_supported
             FROM users WHERE role = 'doctor' AND specialty_id = $1`,
          [c.specialty_id]
        )).rows;
        poolCache.set(c.specialty_id, pool);
        for (const d of pool) {
          if (!projected.has(d.id)) {
            const load = Number((await client.query(
              `SELECT COUNT(*) AS load FROM orders
                WHERE doctor_id = $1 AND deleted_at IS NULL
                  AND LOWER(COALESCE(status,'')) NOT IN ('completed','cancelled','expired_unpaid','refunded')`,
              [d.id]
            )).rows[0].load) || 0;
            projected.set(d.id, load);
          }
        }
      }

      // ── pick least projected-load eligible doctor (tie → tier-support, name) ──
      let best = null;
      let sawAvailable = false;       // active && !paused
      for (const d of pool) {
        if (!d.is_active || d.is_paused) continue;
        sawAvailable = true;
        const cap = capFor(d, c.urgency_tier);
        const load = projected.get(d.id) || 0;
        if (cap !== 0 && load >= cap) continue;   // at capacity (cap 0 = uncapped)
        const supports = doctorSupportsTier(d.sla_tiers_supported, c.urgency_tier);
        const better =
          best === null ||
          load < best.load ||
          (load === best.load && supports && !best.supports) ||
          (load === best.load && supports === best.supports &&
            String(d.name || '').localeCompare(String(best.name || '')) < 0);
        if (better) best = { id: d.id, name: d.name, load, supports, cap };
      }
      if (!best) {
        const reason = pool.length === 0 ? 'no_doctor_for_specialty'
          : !sawAvailable ? 'no_available_doctor'
          : 'all_doctors_at_capacity';
        skipped.push({ caseId: c.id, reference: ref, reason });
        continue;
      }

      // ── write under a per-case savepoint (single-assign's first-assign 4 writes) ──
      await client.query('SAVEPOINT ' + sp);
      try {
        const now = new Date().toISOString();
        await client.query(
          `UPDATE orders SET doctor_id = $1, status = 'ASSIGNED', assignment_status = 'assigned', updated_at = NOW()
             WHERE id = $2`,
          [best.id, c.id]
        );
        await client.query(
          `INSERT INTO doctor_assignments (id, case_id, doctor_id, assigned_at, accept_by_at, reassigned_from_doctor_id)
             VALUES ($1, $2, $3, $4, $5, NULL)`,
          [randomUUID(), c.id, best.id, now, acceptByIso(c.sla_hours)]
        );
        await client.query(
          `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
             VALUES ($1, $2, $3, $4, NOW(), $5, 'superadmin')`,
          [randomUUID(), c.id, `Case assigned to ${best.name} by superadmin (bulk auto-assign)`,
            JSON.stringify({ doctorId: best.id, bulk: true, projectedLoad: best.load + 1, cap: best.cap }), actorId]
        );
        await client.query(
          `INSERT INTO error_logs (id, level, category, message, user_id, context)
             VALUES ($1, 'audit', 'admin_audit', $2, $3, $4)`,
          [randomUUID(), `bulk-assigned case ${c.id} to doctor ${best.id}`, actorId,
            JSON.stringify({ action: 'case_bulk_assigned', caseId: c.id, doctorId: best.id, batch: caseIds.length })]
        );
        await client.query('RELEASE SAVEPOINT ' + sp);
        projected.set(best.id, best.load + 1);
        assigned.push({
          caseId: c.id, reference: ref, doctorId: best.id, doctorName: best.name,
          projectedLoad: best.load + 1, cap: best.cap,
        });
      } catch (werr) {
        await client.query('ROLLBACK TO SAVEPOINT ' + sp);
        try { await client.query('RELEASE SAVEPOINT ' + sp); } catch (_) { /* savepoint gone */ }
        skipped.push({ caseId: c.id, reference: ref, reason: 'write_error' });
      }
    }

    if (dryRun) {
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
    }
  } catch (fatal) {
    // Any unexpected error (incl. a forced pre-COMMIT fault) aborts the WHOLE
    // batch — nothing persists. Re-thrown so the route returns 500.
    try { await client.query('ROLLBACK'); } catch (_) { /* already aborted */ }
    throw fatal;
  }

  // Requested ids the locked SELECT never returned were absent / soft-deleted.
  for (const id of caseIds) {
    if (!foundIds.has(id)) skipped.push({ caseId: id, reference: null, reason: 'not_found' });
  }

  return {
    dryRun,
    requested: caseIds.length,
    assigned,
    skipped,
    counts: { requested: caseIds.length, assigned: assigned.length, skipped: skipped.length },
  };
}

module.exports = { bulkAutoAssign, MANUAL_REVIEW_STATES, LOAD_EXCLUDED_STATUSES };
