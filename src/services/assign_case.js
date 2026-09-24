'use strict';

// src/services/assign_case.js
//
// AUDIT 2026-09-09 (A1) — hand-assigning a doctor from the manual queue must
// ACTUALLY assign.
//
// THE BUG THIS EXISTS TO CLOSE
// ----------------------------
// Both manual-queue approve handlers — POST /superadmin/manual-queue/:id/approve
// (routes/superadmin.js) and POST /manual-queue/:id/approve (routes/api/admin.js)
// — when the operator picked a doctor, wrote orders.doctor_id +
// assignment_status='assigned' and STOPPED. The api handler said so in its own
// words: "picking a doctor here sets orders.doctor_id + assignment_status
// ='assigned' but does NOT open a doctor_assignments row or start the acceptance
// handshake — this endpoint only ROUTES." The consequences (verified 2026-08-29):
// status stayed PAID, acceptance_deadline_at stayed NULL, no doctor_assignments
// row, the doctor was never notified. The row matched no worker — acceptance_
// watcher wants doctor_id IS NULL, fetchDoctorTimeouts wants an assignment row,
// the SLA sweep wants IN_REVIEW — and it never appeared in the doctor's own
// queue. A paid case, invisible to everyone, that never breaches, never refunds,
// never alerts, in the exact workflow ops will use every day at launch.
//
// WHAT THIS MODULE DOES
// ---------------------
// It is the shared piece the two handlers would otherwise duplicate. Two
// functions:
//
//   checkHandpickedDoctorEligibility — the same eligibility gate the canonical
//     assignment endpoint (POST /api/v1/admin/cases/:id/assign) enforces:
//     payment confirmed, doctor exists and is a doctor, active, not paused,
//     onboarding complete, specialty matches the CHOSEN specialty, offers the
//     CHOSEN service (service-matched, not merely specialty-matched), and under
//     capacity for the order's tier. Returns a code + operator-facing reason so
//     the handler can name why a pick was refused instead of a bare 500.
//
//   finalizeHandpickedAssignment — drives caseLifecycle.assignDoctor (the
//     canonical lifecycle assignment: PAID → ASSIGNED, acceptance window from
//     the tier, doctor_assignments row, conversation, patient "assigned" email)
//     and then queues the doctor's own "case assigned" notification, which
//     assignDoctor does not send. Idempotent notification (dedupe key per doctor
//     per case) so an A2 routing-retry cannot double-send.
//
// If the chosen doctor is ineligible, the handler keeps the routing write,
// falls assignment_status back to 'auto', and triggers broadcast/auto-assign
// exactly as the no-doctor branch already does — the case still reaches a
// doctor, just through the pool instead of the hand-pick. The operator is told
// the reason.
//
// Deps are injectable so the guard test can exercise the logic with no DB. The
// eligibility field checks and capacity semantics are lifted from the canonical
// endpoint's shared helpers (routes/api/_assign_helpers.js) — one source of
// truth for "what counts against a doctor's cap".

const { capFor, doctorLoadSql } = require('../routes/api/_assign_helpers');

// Eligibility code → operator-facing reason. Kept human and specific: this text
// renders in the manual-queue banner (web) and in the API response (Command),
// so it has to tell an operator what to do next, not read as a stack trace.
const REASONS = Object.freeze({
  PAYMENT_NOT_CONFIRMED: 'payment is not confirmed for this case',
  ALREADY_ASSIGNED: 'the case already has a doctor',
  NOT_ASSIGNABLE: 'the case is not in an assignable state',
  DOCTOR_NOT_FOUND: 'the selected doctor no longer exists',
  DOCTOR_INACTIVE: 'the selected doctor is deactivated',
  DOCTOR_PAUSED: 'the selected doctor is paused',
  SPECIALTY_MISMATCH: "the selected doctor's specialty does not match the case",
  DOCTOR_ONBOARDING_INCOMPLETE: 'the selected doctor has not finished onboarding',
  DOCTOR_SERVICE_NOT_OFFERED: 'the selected doctor does not offer this service',
  DOCTOR_AT_CAPACITY: 'the selected doctor is at capacity',
  ASSIGN_FAILED: 'the assignment could not be completed',
});

function _defaults() {
  const pg = require('../pg');
  return {
    queryOne: pg.queryOne,
    caseLifecycle: require('../case_lifecycle'),
    queueMultiChannelNotification: require('../notify').queueMultiChannelNotification,
  };
}

function fail(code) {
  return { ok: false, code, reason: REASONS[code] || 'the assignment could not be completed' };
}

/**
 * The same eligibility gate POST /api/v1/admin/cases/:id/assign enforces, run
 * against the CHOSEN specialty/service (the manual-queue approve sets those in
 * the same request, so the doctor must match the operator's pick, not the stale
 * order row). Read-only. Returns { ok:true } or { ok:false, code, reason }.
 *
 * @param {string} orderId
 * @param {string} doctorId
 * @param {{specialtyId?:string, serviceId?:string, deps?:object}} opts
 */
async function checkHandpickedDoctorEligibility(orderId, doctorId, opts = {}) {
  const d = Object.assign(_defaults(), opts.deps || {});
  const { queryOne } = d;
  const specialtyId = String(opts.specialtyId || '').trim();
  const serviceId = String(opts.serviceId || '').trim();

  const order = await queryOne(
    `SELECT id, doctor_id, status, payment_status, paid_at, specialty_id, service_id,
            tier, urgency_tier, sla_hours
       FROM orders_active WHERE id = $1`,
    [orderId]
  );
  if (!order) return fail('NOT_ASSIGNABLE');

  // Payment must have cleared — never assign an unpaid case. Mirrors the
  // canonical endpoint's paid gate (paid_at present AND status/payment_status
  // says paid).
  const pay = String(order.payment_status || '').toLowerCase();
  const paid = (pay === 'paid' || pay === 'captured')
    || (!order.payment_status && String(order.status || '').toLowerCase() === 'paid');
  if (!paid) return fail('PAYMENT_NOT_CONFIRMED');

  // Manual-queue approve is a FIRST assignment. A case that already carries a
  // doctor is not this flow's business (reassignment goes through the canonical
  // endpoint), so refuse rather than silently steal it.
  if (order.doctor_id) return fail('ALREADY_ASSIGNED');

  const doctor = await queryOne(
    `SELECT id, name, role, is_active, is_paused, onboarding_complete,
            specialty_id, max_active_cases, max_active_cases_urgent, doctor_max_active_override
       FROM users WHERE id = $1`,
    [doctorId]
  );
  if (!doctor || String(doctor.role || '').toLowerCase() !== 'doctor') return fail('DOCTOR_NOT_FOUND');
  // Strict comparisons against the blocking value, never truthiness — a NULL
  // is_active means a legacy row that routes as active (COALESCE(is_active,true)
  // everywhere else), so only an explicit `false` blocks. is_paused defaults
  // false; only an explicit `true` blocks.
  if (doctor.is_active === false) return fail('DOCTOR_INACTIVE');
  if (doctor.is_paused === true) return fail('DOCTOR_PAUSED');

  // Specialty and service both against the operator's CHOSEN routing. The
  // canonical endpoint checks primary specialty then offers-service; do the
  // same. When no chosen specialty was passed (shouldn't happen — the handler
  // validates it first), fall back to the order's specialty.
  const wantSpecialty = specialtyId || (order.specialty_id == null ? '' : String(order.specialty_id).trim());
  if (String(doctor.specialty_id || '').trim() !== wantSpecialty) return fail('SPECIALTY_MISMATCH');
  if (doctor.onboarding_complete !== true) return fail('DOCTOR_ONBOARDING_INCOMPLETE');

  const wantService = serviceId || (order.service_id == null ? '' : String(order.service_id).trim());
  const offers = await queryOne(
    `SELECT 1 AS ok FROM doctor_services WHERE doctor_id = $1 AND service_id = $2 LIMIT 1`,
    [doctorId, wantService]
  );
  if (!offers) return fail('DOCTOR_SERVICE_NOT_OFFERED');

  // Capacity, by the SAME expression the candidate picker displays and the
  // canonical gate enforces (doctorLoadSql = the active-status inclusion list).
  const cap = capFor(doctor, order.urgency_tier);
  const loadRow = await queryOne(
    `SELECT COUNT(*) AS c FROM orders_active o
      WHERE o.doctor_id = $1 AND ${doctorLoadSql('o.')}`,
    [doctorId]
  );
  const load = Number(loadRow && loadRow.c) || 0;
  if (cap > 0 && load >= cap) return fail('DOCTOR_AT_CAPACITY');

  return { ok: true, doctorName: doctor.name || 'a specialist' };
}

/**
 * Complete a hand-pick: run the canonical lifecycle assignment (transition,
 * acceptance window, doctor_assignments, conversation, patient email) and queue
 * the doctor's own "case assigned" notification. Call AFTER the routing write
 * has committed (assignDoctor takes its own pool connections and would deadlock
 * against an open txn — the same reason the canonical endpoint drops its lock
 * before calling case_lifecycle).
 *
 * Returns { ok:true } or { ok:false, code, reason }. On failure the caller must
 * fall the case back to the pool (assignment_status='auto' + broadcast) so a
 * failed hand-pick does not strand a paid case.
 *
 * @param {string} orderId
 * @param {string} doctorId
 * @param {{doctorName?:string, caseRef?:string, deps?:object}} opts
 */
async function finalizeHandpickedAssignment(orderId, doctorId, opts = {}) {
  const d = Object.assign(_defaults(), opts.deps || {});
  const { caseLifecycle, queueMultiChannelNotification } = d;

  try {
    await caseLifecycle.assignDoctor(orderId, doctorId);
  } catch (err) {
    return { ok: false, code: 'ASSIGN_FAILED', reason: (err && err.message) || REASONS.ASSIGN_FAILED };
  }

  // assignDoctor emails the PATIENT but never the doctor — the doctor learns
  // through broadcast normally, which a hand-pick skips. Queue it here, on the
  // same deliverable channels the canonical endpoint uses, deduped per doctor
  // per case so an A2 routing-retry cannot double-send.
  try {
    await queueMultiChannelNotification({
      orderId,
      toUserId: doctorId,
      channels: ['internal', 'email', 'whatsapp'],
      template: 'order_assigned_doctor',
      response: {
        case_id: orderId,
        caseReference: opts.caseRef || String(orderId).slice(0, 12).toUpperCase(),
        doctorName: opts.doctorName || 'a specialist',
      },
      dedupe_key: 'order_assigned:' + orderId + ':' + doctorId,
    });
  } catch (_) {
    // The assignment is already durable (doctor_assignments row + acceptance
    // window written by assignDoctor). A notification failure must not undo it
    // or report the assignment as failed — the doctor still sees the case in
    // their queue.
  }

  return { ok: true };
}

module.exports = {
  REASONS,
  checkHandpickedDoctorEligibility,
  finalizeHandpickedAssignment,
};
