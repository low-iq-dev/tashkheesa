const express = require('express');
const { randomUUID } = require('crypto');
const { queryOne, queryAll, execute } = require('../pg');
var { logOrderEvent } = require('../audit');
const { logErrorToDb } = require('../logger');
var { enqueueCaseIntelligence, enqueueCaseReprocess } = require('../job_queue');
var { rateLimit } = require('express-rate-limit');

// PHASE 2.5 (resolved): order_files.url is an R2 storage key, NOT a viewable URL.
// The /files/:fileId route in src/server.js auth-gates access and 302-redirects
// to a short-lived signed R2 URL (or the legacy Uploadcare URL for pre-Phase-2
// rows). All reader sites below now remap order_files.url to /files/:id before
// returning it to clients:
//   - src/routes/api/cases.js          (mobile API; cdnUrl kept for legacy app builds)
//   - src/routes/patient.js            (patient order detail + upload pages)
//   - src/routes/reports.js            (patient case report)
//   - src/routes/doctor.js             (doctor case view + intelligence view)
// Pre-existing rows containing legacy synthetic local paths (e.g. 'orders/<id>/<filename>')
// are unrecoverable — the disk that held them was wiped on prior Render deploys.
// Migration 011 + the seeder fix landed separately; nothing here depends on them.

// AI processing rate limiter: 10 requests per hour per user (keyed by user ID, falls back to IP)
var aiProcessingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  validate: false,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: function(req) {
    return (req.user && req.user.id) ? 'ai:' + req.user.id : req.ip;
  },
  message: 'AI processing limit reached (10 per hour). Please try again later.'
});

const router = express.Router();

// AUDIT-P0-7: the /order pre-launch guard went with the funnel it guarded.
// Any lingering /order/* URL now falls through to the 404 handler, which is
// the correct answer for a checkout that no longer exists.

async function getOrder(orderId) {
  return await queryOne('SELECT * FROM orders_active WHERE id = $1', [orderId]);
}

function getOrderIdFromReq(req) {
  if (!req.params || !req.params.orderId) return null;
  return String(req.params.orderId);
}

// Launch audit §2: the legacy /order/* checkout chain was mounted with NO auth,
// so it was anonymously reachable (IDOR + anonymous user-creation on POST
// /order/:id/review). The current intake flow is the /patient/new-case wizard;
// these routes are the older checkout. Gate the chain behind a logged-in patient
// who owns the order — closing the anonymous surface WITHOUT touching the
// pricing/urgency logic the payments batch relies on.
// AUDIT-P0-7 FOLLOW-UP (boot crash): requireAuth is imported HERE.
//
// It used to be imported far lower in the file, on the line immediately above
// the two /api/cases/:id/intelligence routes that use it. Deleting the
// /order/* funnel removed a contiguous block that happened to contain that
// import line while leaving those two routes in place — so `requireAuth()` was
// evaluated at module load with nothing bound to the name.
//
// The failure mode: ReferenceError thrown while server.js was requiring this
// router, which kills the process before it listens. `node --check` cannot see
// it (the file parses fine — the name is simply never declared), which is
// exactly why it survived to a deploy.
//
// requireRole is kept even though the routes that used it went with the
// funnel: middleware.js exports it, other files import it the same way, and
// removing it here saves nothing.
const { requireAuth, requireRole } = require('../middleware');

// File upload middleware (memory storage — see src/middleware/upload.js).
// File contents are pushed to Cloudflare R2 in attachFileToOrder() below.

async function attachFileToOrder(orderId, file) {
  // Push to R2; store the returned R2 key in order_files.url.
  // The /files/:fileId route in src/server.js generates a signed URL at read time.
  const key = await uploadFile({
    buffer: file.buffer,
    originalname: file.originalname,
    mimetype: file.mimetype,
    folder: 'orders/' + String(orderId),
  });
  await execute(
    `INSERT INTO order_files (id, order_id, url, label, created_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [randomUUID(), orderId, key, file.originalname]
  );
}

async function upsertCaseContext(orderId, { reason_for_review, language, urgency_flag }) {
  const exists = await queryOne('SELECT 1 FROM case_context WHERE case_id = $1', [orderId]);

  if (exists) {
    await execute(
      `UPDATE case_context
       SET reason_for_review = $1, urgency_flag = $2, language = $3
       WHERE case_id = $4`,
      [reason_for_review || '', urgency_flag ? true : false, language || 'en', orderId]
    );
  } else {
    await execute(
      `INSERT INTO case_context (case_id, reason_for_review, urgency_flag, language)
       VALUES ($1, $2, $3, $4)`,
      [orderId, reason_for_review || '', urgency_flag ? true : false, language || 'en']
    );
  }

  // Mirror to orders table
  await execute(
    `UPDATE orders
     SET language = $1, urgency_flag = $2, updated_at = NOW()
     WHERE id = $3`,
    [language || 'en', urgency_flag ? true : false, orderId]
  );
}

// Launch audit §2: the legacy anonymous checkout entry point is retired. No
// current CTA links here (all intake CTAs point at /patient/new-case) and its
// real create-draft body has been commented out for ages — 301 to the current
// intake flow so a stale bookmark lands in the right place.
// ══════════════════════════════════════════════════════════════════════
// AUDIT-P0-7 — the /order/:orderId/* guest checkout was REMOVED.
//
// It was a second, divergent checkout (GET /order/start -> /upload -> POST
// /review -> POST /payment -> /confirmation) reachable only by typing a URL:
// no view, route or email in the tree linked into it. The canonical funnel is
// the patient wizard (routes/patient.js, patient_new_case.ejs steps 1-5).
//
// Three money/ownership defects lived here and died with it:
//
//   1. POST /order/:orderId/payment had no payment_status guard, so a patient
//      could re-post it AFTER paying and upgrade Standard -> Urgent for free.
//      That rewrote sla_hours/urgency_tier/urgency_uplift_amount on a paid
//      order; case_lifecycle then recomputed deadline_at retroactively, the
//      case instantly breached, and services/sla_breach.issueBreachRefund —
//      which checks only `urgency_uplift_amount > 0`, never that the uplift
//      was PAID — opened a refund for money that was never collected, while
//      clawing back the doctor's uplift share.
//      (issueBreachRefund is separately gated on payment_status now.)
//   2. The same handler set price = base_price, which is never populated for
//      orders created via routes/public_orders.js — silently zeroing them.
//   3. POST /order/:orderId/review reassigned the order to whatever
//      patient_email was posted, creating a passwordless user row if the
//      address was unknown: order theft plus an unbounded account-creation
//      primitive. Its ensureOrderOwner guard also treated a NULL patient_id
//      as "allowed", so any logged-in patient could claim any unclaimed draft.
//
// Views deleted with it: order_upload.ejs, order_review.ejs,
// order_urgency_conflict.ejs, order_confirmation.ejs.
// ══════════════════════════════════════════════════════════════════════

router.get('/api/cases/:id/intelligence', requireAuth(), async function(req, res) {
  try {
    var caseId = String(req.params.id);

    var caseRow = await queryOne('SELECT id, patient_id, doctor_id, intelligence_status FROM orders_active WHERE id = $1', [caseId]);
    if (!caseRow) return res.status(404).json({ error: 'Case not found' });

    // Ownership: only the case's patient, the assigned doctor, or an admin
    // may read extracted clinical data (lab_values / patient_info / files).
    var user = req.user;
    var isStaff = user && (user.role === 'admin' || user.role === 'superadmin');
    var isPatientOwner = user && caseRow.patient_id && String(caseRow.patient_id) === String(user.id);
    var isAssignedDoctor = user && caseRow.doctor_id && String(caseRow.doctor_id) === String(user.id);
    if (!isStaff && !isPatientOwner && !isAssignedDoctor) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    var status = (caseRow && caseRow.intelligence_status) || 'none';

    if (status === 'processing') {
      return res.json({ status: 'processing' });
    }

    var extraction = await queryOne(
      'SELECT lab_values, patient_info, documents_inventory, missing_documents, extraction_metadata, created_at, updated_at FROM case_extractions WHERE case_id = $1',
      [caseId]
    );

    var files = await queryAll(
      'SELECT filename, file_type, processing_status, document_category, language_detected FROM case_files WHERE case_id = $1 ORDER BY uploaded_at ASC',
      [caseId]
    );

    return res.json({
      status: status,
      extraction: extraction || null,
      files: files
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user && req.user.id });
    return res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/api/cases/:id/intelligence/reprocess', requireAuth(), aiProcessingLimiter, async function(req, res) {
  try {
    var caseId = String(req.params.id);
    var user = req.user;

    // Doctor auth only
    if (!user || user.role !== 'doctor') {
      return res.status(403).json({ error: 'Doctor access required' });
    }

    // Verify case exists
    var orderRow = await queryOne('SELECT id, doctor_id FROM orders_active WHERE id = $1', [caseId]);
    if (!orderRow) return res.status(404).json({ error: 'Case not found' });

    // Verify this doctor is assigned
    if (orderRow.doctor_id && String(orderRow.doctor_id) !== String(user.id)) {
      return res.status(403).json({ error: 'Not assigned to this case' });
    }

    // Queue reprocessing via pg-boss for crash recovery
    enqueueCaseReprocess(caseId).catch(function(err) {
      console.error('Case reprocess enqueue failed:', err);
    });

    return res.json({ status: 'processing', message: 'Reprocessing started' });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user && req.user.id });
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ---------------------------------------------------------------------------
// Request additional files from patient
// ---------------------------------------------------------------------------
var DEFAULT_REQUEST_FILES_EN = 'Your doctor has reviewed your uploaded files and would like you to upload additional documents for a more complete review. Please log in to your Tashkheesa portal to upload more files.';
var DEFAULT_REQUEST_FILES_AR = 'قام طبيبك بمراجعة ملفاتك المرفوعة ويرغب في رفع مستندات إضافية لمراجعة أكثر شمولاً. يرجى تسجيل الدخول إلى بوابة تشخيصة لرفع المزيد من الملفات.';

// AUDIT-P0-7 — POST /api/cases/:id/request-files REMOVED.
//
// A second "doctor requests more files" implementation with no UI anywhere in
// the tree. Unlike the canonical doctor.js reject-files route it did NOT change
// the case status and did NOT pause the SLA, and unlike
// case_lifecycle.markOrderRejectedFiles it notified the PATIENT directly with
// no admin approval. Any doctor session could therefore email + WhatsApp a
// patient an unapproved file request while the SLA clock kept running against
// the doctor. Use POST /portal/doctor/case/:caseId/reject-files.

module.exports = router;
