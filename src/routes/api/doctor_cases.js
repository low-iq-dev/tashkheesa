'use strict';

/**
 * Tashkheesa — the doctor app's case surface: /api/v1/doctor/*
 *
 * The app is a SECOND CLIENT onto the portal's queue, not a second system.
 * A case accepted on the phone is accepted in the portal, because both call
 * the same functions against the same rows — there is no sync step to get
 * wrong, and no second copy of the rules to drift.
 *
 * Three things this file is deliberately NOT allowed to do:
 *
 *   1. It never re-derives "which cases may this doctor see". That answer
 *      comes from services/doctor_case_access.doctorCaseAccess, the module
 *      the portal's own case page uses, and from the queue builders exported
 *      by routes/doctor.js as `_queue`. A copy here would be a second
 *      opinion, and the two would diverge on the first edit to either.
 *
 *   2. It never writes case state by hand. Every transition goes through
 *      case_lifecycle, which owns the status machine, the SLA clock, the
 *      event log and the notifications.
 *
 *   3. It never widens what a doctor sees before they accept. The
 *      pre-accept redaction (redactPreAcceptOrderRow / redactPreAcceptFiles)
 *      exists because holding a case id used to be enough to read a
 *      patient's history; the app gets the same brief the web offer screen
 *      gets, and not a field more.
 *
 * Money: a doctor is shown THEIR FEE, never the patient's price. That is
 * why nothing here reads orders.price directly — see stripPricingFields in
 * routes/doctor.js and previewCaseEarnings in services/earnings_reader.js.
 */

const express = require('express');
const { requireJWT, requireRole } = require('../../middleware/requireJWT');
const caseLifecycle = require('../../case_lifecycle');
const {
  CASE_ACCESS,
  doctorCaseAccess,
  redactPreAcceptOrderRow,
  redactPreAcceptFiles,
  redactPatientIdentity,
} = require('../../services/doctor_case_access');

// The portal's own queue builders. Required lazily inside the handlers:
// routes/doctor.js requires this file's siblings at module load, and a
// top-level require here would close a cycle through src/server.js.
function queue() {
  return require('../doctor')._queue;
}

module.exports = function (db, helpers) {
  const { safeGet, safeAll } = helpers || {};
  const router = express.Router();

  // Everything below is a signed-in doctor. requireRole('doctor') is the same
  // guard the portal's requireDoctor applies, expressed for the JWT surface.
  router.use(requireJWT);
  router.use(requireRole('doctor'));

  const meId = (req) => (req.user && req.user.id ? String(req.user.id) : '');
  const langOf = (req) => (String(req.query.lang || '').toLowerCase() === 'ar' ? 'ar' : 'en');

  // Live doctor row. Read fresh rather than trusted from the JWT: specialty,
  // tier switches and account state all change under a token that can be up
  // to twelve hours old, and every gate below depends on them.
  async function liveDoctorRow(doctorId) {
    return await safeGet(
      `SELECT id, role, specialty_id, is_active, onboarding_complete,
              sla_tiers_supported, max_active_cases, paused_until,
              deactivated_at, approved_at
         FROM users WHERE id = $1 LIMIT 1`,
      [doctorId], null
    );
  }

  // ─── GET /offers ──────────────────────────────────────────
  // What the doctor could take: cases assigned to them but not yet accepted,
  // plus the open pool for their specialty. Same two arms, same order and
  // same redaction as the portal dashboard's "New cases".
  router.get('/offers', async (req, res) => {
    const doctorId = meId(req);
    const lang = langOf(req);
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const q = queue();

    const row = await liveDoctorRow(doctorId);
    if (!row) return res.fail('Doctor not found', 404, 'NOT_FOUND');

    const assignedPending = await safeAll(
      `SELECT o.*, s.name AS specialty_name, s.name_ar AS specialty_name_ar,
              sv.name AS service_name
         FROM orders_active o
         LEFT JOIN specialties s ON o.specialty_id = s.id
         LEFT JOIN services sv ON o.service_id = sv.id
        WHERE o.doctor_id = $1
          AND COALESCE(o.accepted_at::text, '') = ''
          AND LOWER(COALESCE(o.status,'')) IN ('assigned','accepted')
        ORDER BY COALESCE(o.updated_at, o.created_at)::timestamp DESC
        LIMIT $2`,
      [doctorId, limit], []
    );

    const assignedMapped = q.enrichOrders(assignedPending).map((order) => {
      const ps = String(order.payment_status || '').toLowerCase();
      const isPaid = ps === 'paid' || ps === 'captured';
      return q.mapPortalCaseItem(redactPreAcceptOrderRow(order), lang, { isPaid });
    });

    // The pool arm reads the doctor's LIVE tier switches, so the app never
    // offers a case the accept gate would then refuse.
    const tiers = await q.readDoctorSlaTiersRaw(doctorId);
    const pool = await q.buildPortalCasesUnassigned(
      row.specialty_id, tiers, q.UNACCEPTED_STATUSES, limit, lang
    );

    const assignedTotal = await q.countAssignedPendingCases(doctorId);
    const poolTotal = await q.countPortalCasesUnassigned(row.specialty_id, tiers, q.UNACCEPTED_STATUSES);

    return res.ok({
      offers: [...assignedMapped, ...pool].slice(0, limit),
      total: assignedTotal + poolTotal,
    });
  });

  // ─── GET /cases ───────────────────────────────────────────
  // The doctor's own cases. ?status=in_review (default) | completed
  router.get('/cases', async (req, res) => {
    const doctorId = meId(req);
    const lang = langOf(req);
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const q = queue();

    const want = String(req.query.status || 'in_review').toLowerCase();
    const statuses = want === 'completed' ? ['completed'] : q.ACCEPTED_STATUSES;

    const cases = await q.buildPortalCases(doctorId, statuses, limit, lang);
    const total = await q.countPortalCasesByStatuses(doctorId, statuses);
    return res.ok({ cases, total, status: want });
  });

  // ─── GET /cases/:id ───────────────────────────────────────
  // One case, at whatever level this doctor is entitled to. The level is
  // decided by doctorCaseAccess, never by possession of the id.
  router.get('/cases/:id', async (req, res) => {
    const doctorId = meId(req);
    const orderId = String(req.params.id || '');
    const q = queue();

    const order = await safeGet('SELECT * FROM orders_active WHERE id = $1 LIMIT 1', [orderId], null);
    const doctorRow = await liveDoctorRow(doctorId);
    if (!order || !doctorRow) return res.fail('Case not available', 404, 'CASE_NOT_AVAILABLE');

    const activeCaseCount = await q.countActiveCasesForDoctor(doctorId, orderId);
    const access = doctorCaseAccess({ order, doctorId, doctorRow, activeCaseCount });

    if (access.level === CASE_ACCESS.DENIED) {
      // One refusal shape for "not yours" and "does not exist": a doctor who
      // guesses an id learns nothing from the difference.
      return res.fail('Case not available', 404, 'CASE_NOT_AVAILABLE');
    }

    const files = await safeAll(
      `SELECT id, url, filename, label, mime_type, size, created_at
         FROM order_files WHERE order_id = $1 ORDER BY created_at ASC`,
      [orderId], []
    );

    // url is an R2 key; /files/:id signs it on demand and re-checks access.
    const mapped = (files || []).map((f) => ({
      id: f.id,
      name: f.label || f.filename || 'Uploaded file',
      mime_type: f.mime_type || null,
      size: f.size || null,
      url: '/files/' + f.id,
    }));

    if (access.level === CASE_ACCESS.OFFER) {
      return res.ok({
        access: 'offer',
        case: redactPreAcceptOrderRow(order),
        files: redactPreAcceptFiles(mapped),
      });
    }

    return res.ok({
      access: 'full',
      case: redactPatientIdentity(order),
      files: mapped,
    });
  });

  return router;
};
