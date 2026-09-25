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
 *      event log and the notifications. The three audited actions (accept,
 *      decline, request files) RUN THE PORTAL'S OWN EXPRESS HANDLERS through
 *      a response shim (runWebAction below) and translate the redirect they
 *      end in into a JSON code — one handler body, two doors.
 *
 *   3. It never widens what a doctor sees before they accept. The
 *      pre-accept redaction (redactPreAcceptOrderRow / redactPreAcceptFiles)
 *      exists because holding a case id used to be enough to read a
 *      patient's history; the app gets the same brief the web offer screen
 *      gets, and not a field more.
 *
 * Money: a doctor is shown THEIR FEE, never the patient's price. That is
 * why nothing here reads orders.price directly — see stripPricingFields in
 * routes/doctor.js and previewCaseEarnings in services/earnings_writer.js.
 */

const express = require('express');
const { requireJWT, requireRole } = require('../../middleware/requireJWT');
const caseLifecycle = require('../../case_lifecycle');
const reportSubmission = require('../../services/report_submission');
const { computeSla } = require('../../sla_status');
const acceptanceWindow = require('../../acceptance_window');
const {
  CASE_ACCESS,
  doctorCaseAccess,
  doctorHasAcceptedCase,
  redactPreAcceptOrderRow,
  redactPreAcceptFiles,
  redactPatientIdentity,
} = require('../../services/doctor_case_access');

// Portal modules, resolved at CALL time. routes/doctor.js requires this
// file's siblings at module load, and a top-level require here would close a
// cycle through src/server.js. earnings_reader / earnings_writer are late-read
// for the same reason the siblings do it: a hermetic test can point one
// accessor at a stub without touching the require cache (routes/doctor.js
// cannot be required outside a booted server — src/views is not on disk in
// every checkout).
const deps = {
  actions: () => require('../doctor')._actions,
  queue: () => require('../doctor')._queue,
  alerts: () => require('../doctor')._alerts,
  earnings: () => require('../../services/earnings_reader'),
  earningsWriter: () => require('../../services/earnings_writer'),
};

// The portal's own queue builders.
function queue() {
  return deps.queue();
}

// ─── Small pure helpers ────────────────────────────────────────

function isoOrNull(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function msOrNull(v) {
  const iso = isoOrNull(v);
  return iso ? Date.parse(iso) : null;
}

function lower(v) {
  return String(v == null ? '' : v).toLowerCase();
}

// The stored status of a row. The queue builders (enrichOrders) overwrite
// `status` with computeSla's effective status ('breached', 'paused', ...) and
// keep the DB value in `db_status`; every predicate below wants the DB value.
function rawStatus(order) {
  return lower(order && (order.db_status || order.status));
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseJson(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

// The status vocabularies the tabs are built from. Spellings come from
// case_lifecycle.DB_STATUS_VARIANTS, never typed here, so a legacy row
// ('done', 'canceled', ...) lands in the same tab the web pages put it in.
function variants(canon) {
  return caseLifecycle.dbStatusValuesFor(canon).map((s) => String(s).toLowerCase());
}
function uniq(list) {
  return Array.from(new Set(list));
}
const COMPLETED_VALUES = uniq(variants('COMPLETED'));
const REFUNDED_VALUES = uniq(variants('REFUNDED').concat(variants('CANCELLED')));
const AWAITING_VALUES = ['awaiting_files', 'rejected_files'];
const BREACHED_VALUES = ['breached', 'sla_breach'];

// The doctor-facing tier, normalised to the three the app knows. urgency_tier
// is the creation-time column (acceptance_window.js documents why the other
// tier column must not be read); normalizeTier folds the legacy spellings.
function tierOf(order) {
  return acceptanceWindow.normalizeTier(order && order.urgency_tier);
}

/**
 * SlaState — the one clock object every list row and the case detail carry.
 *   paused            = sla_paused_at set
 *   remaining_seconds = the banked remainder while paused, else null (the app
 *                       counts down from deadline_at itself)
 *   breached          = breached_at set, or a breach status, or the deadline
 *                       has passed on an open, unpaused case (computeSla's
 *                       own verdict — a paused clock is never overdue).
 */
function slaStateOf(order, now = new Date()) {
  const o = order || {};
  const status = rawStatus(o);
  const paused = !!o.sla_paused_at;
  const completed = !!o.completed_at || COMPLETED_VALUES.includes(status);
  const computed = computeSla({ ...o, status }, now);
  const breached =
    !!o.breached_at ||
    BREACHED_VALUES.includes(status) ||
    (!completed && !paused && !!(computed && computed.sla && computed.sla.isBreached));
  return {
    tier: tierOf(o),
    accepted_at: isoOrNull(o.accepted_at),
    deadline_at: isoOrNull(o.deadline_at),
    paused,
    remaining_seconds: paused ? numOrNull(o.sla_remaining_seconds) : null,
    breached,
  };
}

function isCompletedRow(order) {
  return !!(order && (order.completed_at || COMPLETED_VALUES.includes(rawStatus(order))));
}
function isRefundedRow(order) {
  return !!(order && REFUNDED_VALUES.includes(rawStatus(order)));
}
function isAwaitingRow(order) {
  return !!(order && (order.sla_paused_at || AWAITING_VALUES.includes(rawStatus(order))));
}
function hasDraft(order) {
  return !!(order && (String(order.diagnosis_text || '').trim() || String(order.impression_text || '').trim()));
}

// status_label for a CaseRow. Offer is decided by the caller (the row came
// from an offers arm); the rest is read off the row in priority order.
function statusLabelOf(order, isOffer) {
  if (isOffer) return 'offer';
  if (isRefundedRow(order)) return 'refunded';
  if (isCompletedRow(order)) return 'completed';
  if (slaStateOf(order).breached) return 'breached';
  if (isAwaitingRow(order)) return 'awaiting_files';
  if (String(order.diagnosis_text || '').trim()) return 'drafting';
  return 'accepted';
}

// Acceptance deadline of a POOL offer. broadcast writes
// orders.acceptance_deadline_at when the case is fanned out; a paid case that
// has not been broadcast yet has no window running, and the app is told so
// (null) rather than handed a deadline nobody enforces.
function poolAcceptBy(order) {
  if (!order) return null;
  if (order.acceptance_deadline_at) return isoOrNull(order.acceptance_deadline_at);
  const sentMs = msOrNull(order.broadcast_sent_at);
  if (sentMs == null) return null;
  return acceptanceWindow.acceptanceDeadlineIso(acceptanceWindow.acceptanceMinutesForOrder(order), sentMs);
}

// Map a redirect URL the web handler ended in onto {path, msg, error}.
function parseRedirect(url) {
  let u;
  try { u = new URL(String(url || ''), 'http://portal.local'); } catch (_) { return { path: '', msg: '', error: '' }; }
  return {
    path: u.pathname || '',
    msg: u.searchParams.get('msg') || '',
    error: u.searchParams.get('error') || '',
  };
}

const ACCEPT_MSG_CODES = Object.freeze({
  already_taken: [409, 'CASE_TAKEN'],
  capacity: [409, 'CAPACITY_FULL'],
  specialty: [409, 'SPECIALTY_MISMATCH'],
  tier_not_supported: [409, 'TIER_NOT_SUPPORTED'],
  case_unroutable: [409, 'CASE_UNROUTABLE'],
  account_check_failed: [503, 'ACCOUNT_CHECK_FAILED'],
  account_inactive: [403, 'ACCOUNT_INACTIVE'],
  paused: [403, 'ACCOUNT_PAUSED'],
  pending_approval: [403, 'ACCOUNT_PENDING'],
});

// Arabic for the four missing-document sentences case-intelligence.js writes.
// Anything else (a future entry) is returned in English on both keys rather
// than dropped.
const MISSING_DOC_AR = Object.freeze({
  'No lab/blood work results': 'لا توجد نتائج تحاليل معملية',
  'No imaging reports (X-ray, CT, MRI, ultrasound)': 'لا توجد تقارير أشعة (إكس راي، مقطعية، رنين، سونار)',
  'No referral letter or physician notes': 'لا يوجد خطاب تحويل أو ملاحظات طبيب',
  'No current medication list or prescriptions': 'لا توجد قائمة أدوية حالية أو روشتات',
});

// order_files.ai_quality_status values case_image_quality.js writes that mean
// "this file is not usable as uploaded" (routes/patient.js AI_QUALITY_FLAGGED
// minus 'error', which means the check itself failed, not the file).
const QUALITY_FLAGGED = Object.freeze(['poor_quality', 'not_medical', 'wrong_type']);

module.exports = function (db, helpers) {
  const { safeGet, safeAll } = helpers || {};
  const router = express.Router();

  // Everything below is a signed-in doctor. requireRole('doctor') is the same
  // guard the portal's requireDoctor applies, expressed for the JWT surface.
  router.use(requireJWT);
  router.use(requireRole('doctor'));

  const meId = (req) => (req.user && req.user.id ? String(req.user.id) : '');
  const langOf = (req) => (String(req.query.lang || '').toLowerCase() === 'ar' ? 'ar' : 'en');
  const notAvailable = (res) => res.fail('Case not available', 404, 'CASE_NOT_AVAILABLE');

  // Live doctor row. Read fresh rather than trusted from the JWT: specialty,
  // tier switches and account state all change under a token that can be up
  // to twelve hours old, and every gate below depends on them.
  async function liveDoctorRow(doctorId) {
    return await safeGet(
      `SELECT id, role, specialty_id, is_active, onboarding_complete,
              sla_tiers_supported, max_active_cases, max_active_cases_urgent,
              is_paused, paused_at, pause_reason, pending_approval,
              rejection_reason, approved_at, name, name_ar, lang, email,
              profile_photo_url, signature_url, is_available,
              doctor_max_active_override
         FROM users WHERE id = $1 LIMIT 1`,
      [doctorId], null
    );
  }

  async function readOrder(orderId) {
    return await safeGet('SELECT * FROM orders_active WHERE id = $1 LIMIT 1', [orderId], null);
  }

  // The FULL-access gate shared by every post-accept read and write below:
  // the same question the web intelligence, records and prescribe pages ask
  // (doctorHasAcceptedCase — assignment is not acceptance). Sends the one
  // 404 shape itself and returns null when the caller must stop.
  async function requireAcceptedCase(req, res) {
    const doctorId = meId(req);
    const orderId = String(req.params.id || '');
    if (!doctorId || !orderId) { notAvailable(res); return null; }
    const order = await readOrder(orderId);
    if (!order || !doctorHasAcceptedCase(order, doctorId)) { notAvailable(res); return null; }
    return { order, orderId, doctorId };
  }

  // ─── Batched per-order context ─────────────────────────────

  // The scheduling facts a list row carries (age, sex, report language, file
  // count), the Arabic service name and the patient's rating — one query for
  // a whole page of rows. Age and sex are on the pre-accept allowlist
  // (PRE_ACCEPT_LIST_FIELDS: patient_age / patient_gender); the name and date
  // of birth themselves never leave this function.
  async function caseMetaByOrder(orderIds) {
    const out = Object.create(null);
    const ids = (orderIds || []).filter(Boolean).map(String);
    if (!ids.length) return out;
    const rows = await safeAll(
      `SELECT o.id, o.language, o.completed_at,
              pu.date_of_birth AS patient_dob, pu.gender AS patient_gender,
              sv.name AS service_name, sv.name_ar AS service_name_ar, sv.sla_hours AS service_sla_hours,
              (SELECT COUNT(*) FROM order_files f WHERE f.order_id = o.id) AS files_count,
              (SELECT r.rating FROM reviews r WHERE r.order_id = o.id AND COALESCE(r.is_visible, true) = true LIMIT 1) AS rating
         FROM orders_active o
         LEFT JOIN users pu ON pu.id = o.patient_id
         LEFT JOIN services sv ON sv.id = o.service_id
        WHERE o.id = ANY($1)`,
      [ids], []
    );
    for (const r of rows || []) {
      out[String(r.id)] = {
        patient_age: reportSubmission.computeAgeFromDob(r.patient_dob),
        patient_sex: r.patient_gender == null ? null : String(r.patient_gender),
        report_language: r.language == null ? null : String(r.language),
        service_name: r.service_name == null ? null : String(r.service_name),
        service_name_ar: r.service_name_ar == null ? null : String(r.service_name_ar),
        service_sla_hours: numOrNull(r.service_sla_hours),
        files_count: Number(r.files_count) || 0,
        rating: numOrNull(r.rating),
      };
    }
    return out;
  }

  // Unread patient messages per order, for every conversation this doctor
  // holds (or a subset of orders). Same predicate as the inbox list:
  // is_read = false AND sender_id != me.
  async function unreadByOrder(doctorId, orderIds) {
    const out = Object.create(null);
    const restrict = Array.isArray(orderIds);
    const ids = restrict ? orderIds.filter(Boolean).map(String) : null;
    if (restrict && !ids.length) return out;
    const rows = await safeAll(
      `SELECT c.order_id, COUNT(*) AS unread
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE c.doctor_id = $1
          AND m.is_read = false
          AND m.sender_id != $1
          ${restrict ? 'AND c.order_id = ANY($2)' : ''}
        GROUP BY c.order_id`,
      restrict ? [doctorId, ids] : [doctorId], []
    );
    for (const r of rows || []) {
      if (r.order_id != null) out[String(r.order_id)] = Number(r.unread) || 0;
    }
    return out;
  }

  // accept_by_at of the OPEN doctor_assignments row per assigned case — the
  // window case_sla_worker.fetchDoctorTimeouts enforces.
  async function assignmentAcceptBy(doctorId, orderIds) {
    const out = Object.create(null);
    const ids = (orderIds || []).filter(Boolean).map(String);
    if (!ids.length) return out;
    const rows = await safeAll(
      `SELECT case_id, MAX(accept_by_at) AS accept_by_at
         FROM doctor_assignments
        WHERE doctor_id = $1 AND case_id = ANY($2) AND completed_at IS NULL
        GROUP BY case_id`,
      [doctorId, ids], []
    );
    for (const r of rows || []) out[String(r.case_id)] = isoOrNull(r.accept_by_at);
    return out;
  }

  // The doctor's fee for one case — the SAME snapshot + calc that writes the
  // ledger row at acceptance. null when it cannot be computed; never a guess.
  async function feePreview(orderId) {
    try {
      const fee = await deps.earningsWriter().previewCaseEarnings(orderId);
      return fee || null;
    } catch (_) {
      return null;
    }
  }

  // ─── The offers, in the shape the app lists them ───────────
  //
  // Same two arms, same order and same redaction as GET /offers and the
  // portal dashboard's "New cases": cases assigned to this doctor but not
  // yet accepted, then the open pool for their specialty under their LIVE
  // tier switches.
  async function buildOfferRows(doctorId, doctorRow, lang, limit) {
    const q = queue();
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
    const assigned = q.enrichOrders(assignedPending || []).map((o) => redactPreAcceptOrderRow(o));
    const tiers = await q.readDoctorSlaTiersRaw(doctorId);
    const pool = await q.buildPortalCasesUnassigned(
      doctorRow.specialty_id, tiers, q.UNACCEPTED_STATUSES, limit, lang
    );

    const arms = [
      ...assigned.map((o) => ({ order: o, kind: 'assigned' })),
      ...(pool || []).map((o) => ({ order: o, kind: 'pool' })),
    ].slice(0, limit);

    const ids = arms.map((a) => String(a.order.id));
    const meta = await caseMetaByOrder(ids);
    const acceptBy = await assignmentAcceptBy(doctorId, arms.filter((a) => a.kind === 'assigned').map((a) => String(a.order.id)));

    const rows = [];
    for (const { order, kind } of arms) {
      const id = String(order.id);
      const m = meta[id] || {};
      const fee = await feePreview(id);
      rows.push({
        order_id: id,
        reference_id: order.reference_id == null ? null : String(order.reference_id),
        tier: tierOf(order),
        accept_by_at: kind === 'assigned'
          ? (acceptBy[id] || isoOrNull(order.acceptance_deadline_at))
          : poolAcceptBy(order),
        service_name: order.service_name || m.service_name || null,
        service_name_ar: m.service_name_ar || null,
        sla_hours: numOrNull(order.sla_hours) != null ? numOrNull(order.sla_hours) : (m.service_sla_hours != null ? m.service_sla_hours : null),
        patient_sex: m.patient_sex == null ? null : m.patient_sex,
        patient_age: m.patient_age == null ? null : m.patient_age,
        files_count: m.files_count || 0,
        report_language: m.report_language || (order.language == null ? null : String(order.language)),
        fee_total: fee && Number.isFinite(Number(fee.total)) ? Number(fee.total) : null,
        // Carried for the CaseRow mapping below; not part of OfferRow.
        _order: order,
      });
    }
    return rows;
  }

  // ─── Running the portal's own action handlers ──────────────
  //
  // accept / decline / reject-files carry the platform's safety gates and
  // end in res.redirect(url). We give them a req-like object and a res shim
  // that captures the redirect, then translate the URL. Nothing about the
  // case is decided here; a new refusal added to the web handler surfaces
  // as a new ?msg= and lands in the generic mapping until it is named.
  async function runWebAction(handler, { orderId, doctorId, doctorName, body, req }) {
    if (typeof handler !== 'function') throw new Error('web action handler unavailable');
    let captured = null;
    let status = null;
    let sent;
    const fakeReq = {
      params: { caseId: orderId },
      user: { id: doctorId, name: doctorName || '', role: 'doctor' },
      body: body || {},
      query: {},
      requestId: req && req.requestId,
      originalUrl: req && req.originalUrl,
      method: 'POST',
      headers: {},
      get: () => '',
    };
    const fakeRes = {
      redirect(a, b) { captured = String(b == null ? a : b); return this; },
      status(c) { status = c; return this; },
      send(t) { sent = t; return this; },
      json(o) { sent = o; return this; },
      render(v, o) { sent = { view: v, locals: o }; return this; },
      set() { return this; },
      setHeader() { return this; },
    };
    await handler(fakeReq, fakeRes);
    return { redirect: captured, status, sent };
  }

  // ─── GET /dashboard ───────────────────────────────────────
  // The app's home screen, from the same counters and builders as the web
  // dashboard: what to accept, what is running, this month's money.
  router.get('/dashboard', async (req, res) => {
    const doctorId = meId(req);
    const lang = langOf(req);
    const q = queue();

    const row = await liveDoctorRow(doctorId);
    if (!row) return res.fail('Doctor not found', 404, 'NOT_FOUND');

    const tiers = await q.readDoctorSlaTiersRaw(doctorId);
    const assignedTotal = await q.countAssignedPendingCases(doctorId);
    const poolTotal = await q.countPortalCasesUnassigned(row.specialty_id, tiers, q.UNACCEPTED_STATUSES);
    const inProgress = await q.countPortalCasesByStatuses(doctorId, q.ACCEPTED_STATUSES);

    let monthEgp = null;
    try {
      const summary = await deps.earnings().getDoctorMonthSummary(doctorId);
      monthEgp = summary && Number.isFinite(Number(summary.total)) ? Number(summary.total) : null;
    } catch (_) { monthEgp = null; }

    const offers = (await buildOfferRows(doctorId, row, lang, 20)).map(({ _order, ...o }) => o);

    const runningRaw = await q.buildPortalCases(doctorId, q.ACCEPTED_STATUSES, 50, lang);
    const unread = await unreadByOrder(doctorId, null);
    const running = (runningRaw || []).map((o) => ({
      order_id: String(o.id),
      reference_id: o.reference_id == null ? null : String(o.reference_id),
      status: o.db_status || o.status || null,
      sla: slaStateOf(o),
      has_draft: hasDraft(o),
      awaiting_files: isAwaitingRow(o),
      unread_messages: unread[String(o.id)] || 0,
    }));

    let unreadAlerts = 0;
    try {
      unreadAlerts = Number(await deps.alerts().countDoctorUnseenNotifications(doctorId, row.email || '')) || 0;
    } catch (_) { unreadAlerts = 0; }
    const unreadMessages = Object.keys(unread).reduce((sum, k) => sum + (unread[k] || 0), 0);

    return res.ok({
      doctor: {
        id: String(row.id),
        name: row.name || null,
        name_ar: row.name_ar || null,
        photo_url: row.profile_photo_url || null,
        taking_cases: !row.is_paused,
      },
      stats: {
        to_accept: (Number(assignedTotal) || 0) + (Number(poolTotal) || 0),
        in_progress: Number(inProgress) || 0,
        month_egp: monthEgp,
      },
      offers,
      running,
      unread_alerts: unreadAlerts,
      unread_messages: unreadMessages,
    });
  });

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
  // The doctor's own cases.
  //   ?tab=open|awaiting|done|all  → { cases: CaseRow[], tab }   (the app)
  //   ?status=in_review|completed  → the original portal-row shape, kept for
  //                                  the clients written against it.
  router.get('/cases', async (req, res) => {
    const doctorId = meId(req);
    const lang = langOf(req);
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const q = queue();

    if (req.query.status != null && req.query.tab == null) {
      const want = String(req.query.status || 'in_review').toLowerCase();
      const statuses = want === 'completed' ? ['completed'] : q.ACCEPTED_STATUSES;

      const cases = await q.buildPortalCases(doctorId, statuses, limit, lang);
      const total = await q.countPortalCasesByStatuses(doctorId, statuses);
      return res.ok({ cases, total, status: want });
    }

    const tab = ['open', 'awaiting', 'done', 'all'].includes(lower(req.query.tab)) ? lower(req.query.tab) : 'open';
    const pageLimit = Math.min(Number(req.query.limit) || 50, 50);

    const runningStatuses = q.ACCEPTED_STATUSES.filter((s) => !AWAITING_VALUES.includes(lower(s)));
    const doneStatuses = uniq(COMPLETED_VALUES.concat(REFUNDED_VALUES));

    let offers = [];
    let running = [];
    let awaiting = [];
    let done = [];

    if (tab === 'open' || tab === 'all') {
      const row = await liveDoctorRow(doctorId);
      if (row) offers = await buildOfferRows(doctorId, row, lang, pageLimit);
      running = (await q.buildPortalCases(doctorId, runningStatuses, pageLimit, lang)) || [];
    }
    if (tab === 'awaiting' || tab === 'all') {
      awaiting = (await q.buildPortalCases(doctorId, AWAITING_VALUES, pageLimit, lang)) || [];
    }
    if (tab === 'done' || tab === 'all') {
      done = (await q.buildPortalCases(doctorId, doneStatuses, pageLimit, lang)) || [];
    }

    const owned = [...running, ...awaiting, ...done];
    const ownedIds = owned.map((o) => String(o.id));
    const meta = await caseMetaByOrder(ownedIds);
    const unread = await unreadByOrder(doctorId, ownedIds.concat(offers.map((o) => o.order_id)));

    const offerRows = offers.map((o) => ({
      id: o.order_id,
      reference_id: o.reference_id,
      service_name: o.service_name,
      service_name_ar: o.service_name_ar,
      status: o._order.db_status || o._order.status || null,
      status_label: 'offer',
      sla: slaStateOf(o._order),
      accept_by_at: o.accept_by_at,
      unread_messages: 0,
      patient_sex: o.patient_sex,
      patient_age: o.patient_age,
      files_count: o.files_count,
      report_language: o.report_language,
      completed_at: null,
      rating: null,
      refunded: false,
    }));

    const ownedRow = (o) => {
      const id = String(o.id);
      const m = meta[id] || {};
      return {
        id,
        reference_id: o.reference_id == null ? null : String(o.reference_id),
        service_name: o.service_name || m.service_name || null,
        service_name_ar: m.service_name_ar || null,
        status: o.db_status || o.status || null,
        status_label: statusLabelOf(o, false),
        sla: slaStateOf(o),
        accept_by_at: null,
        unread_messages: unread[id] || 0,
        patient_sex: m.patient_sex == null ? null : m.patient_sex,
        patient_age: m.patient_age == null ? null : m.patient_age,
        files_count: m.files_count || 0,
        report_language: m.report_language || (o.language == null ? null : String(o.language)),
        completed_at: isoOrNull(o.completed_at),
        rating: m.rating == null ? null : m.rating,
        refunded: isRefundedRow(o),
      };
    };

    const byAsc = (key) => (a, b) => {
      const av = a[key] ? Date.parse(a[key]) : Infinity;
      const bv = b[key] ? Date.parse(b[key]) : Infinity;
      return av - bv;
    };
    offerRows.sort(byAsc('accept_by_at'));
    const runningRows = running.map(ownedRow).sort((a, b) => byAsc('deadline_at')(a.sla, b.sla));
    const awaitingRows = awaiting.map(ownedRow).sort((a, b) => byAsc('deadline_at')(a.sla, b.sla));
    const doneRows = done.map(ownedRow).sort((a, b) => {
      const av = a.completed_at ? Date.parse(a.completed_at) : -Infinity;
      const bv = b.completed_at ? Date.parse(b.completed_at) : -Infinity;
      return bv - av;
    });

    let cases;
    if (tab === 'open') cases = [...offerRows, ...runningRows];
    else if (tab === 'awaiting') cases = awaitingRows;
    else if (tab === 'done') cases = doneRows;
    else cases = [...offerRows, ...runningRows, ...awaitingRows, ...doneRows];

    return res.ok({ cases, tab });
  });

  // ─── GET /cases/:id ───────────────────────────────────────
  // One case, at whatever level this doctor is entitled to. The level is
  // decided by doctorCaseAccess, never by possession of the id.
  router.get('/cases/:id', async (req, res) => {
    const doctorId = meId(req);
    const orderId = String(req.params.id || '');
    const q = queue();

    const order = await readOrder(orderId);
    const doctorRow = await liveDoctorRow(doctorId);
    if (!order || !doctorRow) return notAvailable(res);

    const activeCaseCount = await q.countActiveCasesForDoctor(doctorId, orderId);
    const access = doctorCaseAccess({ order, doctorId, doctorRow, activeCaseCount });

    if (access.level === CASE_ACCESS.DENIED) {
      // One refusal shape for "not yours" and "does not exist": a doctor who
      // guesses an id learns nothing from the difference.
      return notAvailable(res);
    }

    // Service, assignment and (post-accept only) patient context. The name,
    // history and medications read here are handed out ONLY on the FULL
    // branch below; the pre-accept branch takes age, sex and language, which
    // are on the pre-accept allowlist.
    const ctx = (await safeGet(
      `SELECT sv.name AS service_name, sv.name_ar AS service_name_ar,
              sv.sla_hours AS service_sla_hours, sv.urgency_uplift_doctor_pct,
              pu.name AS patient_name, pu.date_of_birth AS patient_dob, pu.gender AS patient_gender
         FROM orders_active o
         LEFT JOIN services sv ON sv.id = o.service_id
         LEFT JOIN users pu ON pu.id = o.patient_id
        WHERE o.id = $1 LIMIT 1`,
      [orderId], null
    )) || {};

    const acceptBy = await assignmentAcceptBy(doctorId, [orderId]);
    const sla = slaStateOf(order);
    const referenceId = order.reference_id == null ? null : String(order.reference_id);
    const service = {
      name: ctx.service_name || null,
      name_ar: ctx.service_name_ar || null,
      sla_hours: numOrNull(order.sla_hours) != null ? numOrNull(order.sla_hours) : numOrNull(ctx.service_sla_hours),
    };
    const assignment = {
      accept_by_at: acceptBy[orderId] || isoOrNull(order.acceptance_deadline_at) || null,
    };
    const feeRaw = await feePreview(orderId);
    const fee = feeRaw ? {
      service_fee: Number(feeRaw.baseShare) || 0,
      uplift_share: Number(feeRaw.upliftShare) || 0,
      uplift_pct: ctx.urgency_uplift_doctor_pct == null ? 30 : Number(ctx.urgency_uplift_doctor_pct),
      total: Number(feeRaw.total) || 0,
    } : null;

    const files = await safeAll(
      `SELECT id, url, filename, label, mime_type, size, created_at, ai_quality_status, ai_quality_note
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
        case: q.stripPricingFields(redactPreAcceptOrderRow(order)),
        files: redactPreAcceptFiles(mapped),
        reference_id: referenceId,
        sla,
        service,
        assignment,
        fee,
        patient: {
          age: reportSubmission.computeAgeFromDob(ctx.patient_dob),
          sex: ctx.patient_gender == null ? null : String(ctx.patient_gender),
          report_language: order.language == null ? null : String(order.language),
          name: null,
          history: null,
          medications: null,
        },
        conversation_id: null,
        unread_messages: 0,
        intelligence: {
          ready: lower(order.intelligence_status) === 'ready',
          documents_count: null,
          lab_values_count: null,
          missing_count: null,
        },
        shared_records_count: 0,
      });
    }

    // FULL: everything the web case page shows the accepting doctor.
    const requestState = await q.getAdditionalFilesRequestState(orderId);
    const requestedMs = msOrNull(requestState && requestState.requestedAt);
    const addedAfter = (at) => {
      const ms = msOrNull(at);
      return requestedMs != null && ms != null && ms > requestedMs;
    };

    const fullFiles = (files || []).map((f) => ({
      id: f.id,
      source: 'order_files',
      name: f.label || f.filename || 'Uploaded file',
      label: f.label || f.filename || 'Uploaded file',
      filename: f.filename || null,
      mime_type: f.mime_type || null,
      size: f.size || null,
      url: '/files/' + f.id,
      created_at: isoOrNull(f.created_at),
      quality_flag: f.ai_quality_status || null,
      quality_note: f.ai_quality_note || null,
      added_after_request: addedAfter(f.created_at),
    }));

    // Files the patient uploads AFTER submitting (the request-files flow)
    // land in order_additional_files. /files/:id already authorises that
    // table for the assigned doctor, so emitting the ids is enough.
    const additional = await safeAll(
      `SELECT id, label, uploaded_at
         FROM order_additional_files WHERE order_id = $1 ORDER BY uploaded_at ASC`,
      [orderId], []
    );
    for (const f of additional || []) {
      fullFiles.push({
        id: f.id,
        source: 'order_additional_files',
        name: f.label || 'Additional file',
        label: f.label || 'Additional file',
        filename: null,
        mime_type: null,
        size: null,
        url: '/files/' + f.id,
        created_at: isoOrNull(f.uploaded_at),
        quality_flag: null,
        quality_note: null,
        added_after_request: addedAfter(f.uploaded_at),
      });
    }

    const conversation = await safeGet(
      'SELECT id FROM conversations WHERE order_id = $1 AND doctor_id = $2 ORDER BY created_at DESC LIMIT 1',
      [orderId, doctorId], null
    );
    const unread = await unreadByOrder(doctorId, [orderId]);

    const extraction = await safeGet(
      'SELECT documents_inventory, lab_values, missing_documents, updated_at FROM case_extractions WHERE case_id = $1 LIMIT 1',
      [orderId], null
    );
    const countOf = (v) => { const a = parseJson(v); return Array.isArray(a) ? a.length : 0; };

    const recordsRow = order.patient_id ? await safeGet(
      'SELECT COUNT(*) AS c FROM medical_records WHERE patient_id = $1 AND is_shared_with_doctors = true AND is_hidden = false',
      [order.patient_id], null
    ) : null;

    return res.ok({
      access: 'full',
      case: q.stripPricingFields(redactPatientIdentity(order)),
      files: fullFiles,
      reference_id: referenceId,
      sla,
      service,
      assignment,
      fee,
      patient: {
        age: reportSubmission.computeAgeFromDob(ctx.patient_dob),
        sex: ctx.patient_gender == null ? null : String(ctx.patient_gender),
        report_language: order.language == null ? null : String(order.language),
        name: ctx.patient_name == null ? null : String(ctx.patient_name),
        history: order.medical_history == null ? null : String(order.medical_history),
        medications: order.current_medications == null ? null : String(order.current_medications),
      },
      conversation_id: conversation && conversation.id != null ? String(conversation.id) : null,
      unread_messages: unread[orderId] || 0,
      intelligence: {
        ready: lower(order.intelligence_status) === 'ready',
        documents_count: extraction ? countOf(extraction.documents_inventory) : 0,
        lab_values_count: extraction ? countOf(extraction.lab_values) : 0,
        missing_count: extraction ? countOf(extraction.missing_documents) : 0,
      },
      shared_records_count: recordsRow ? Number(recordsRow.c) || 0 : 0,
    });
  });

  // ─── GET /cases/:id/draft ─────────────────────────────────
  // The report as saved so far, split the way the editor splits it
  // (buildReportDraftFields — the one parser the web editor and the PDF use).
  router.get('/cases/:id/draft', async (req, res) => {
    const ctx = await requireAcceptedCase(req, res);
    if (!ctx) return;
    const fields = reportSubmission.buildReportDraftFields(ctx.order);
    // Migration 121 — the Arabic half of the editor, '' / false on a row (or a
    // database) that has none.
    const ar = reportSubmission.buildReportDraftFieldsAr(ctx.order);
    return res.ok({
      order_id: ctx.orderId,
      findings: fields.findings || '',
      impression: fields.impression || '',
      recommendation: fields.recommendations || '',
      findings_ar: ar.findings_ar || '',
      impression_ar: ar.impression_ar || '',
      recommendation_ar: ar.recommendation_ar || '',
      arabic_approved: !!ar.arabic_approved,
      saved_at: isoOrNull(ctx.order.updated_at),
    });
  });

  // ─── PUT /cases/:id/draft ─────────────────────────────────
  // Partial save: fields absent from the body keep their saved text. The
  // write is persistReportText — the same draft-shaped UPDATE the web editor
  // and the submit path use — which refuses terminal statuses itself.
  router.put('/cases/:id/draft', async (req, res) => {
    const ctx = await requireAcceptedCase(req, res);
    if (!ctx) return;
    const body = req.body || {};
    for (const k of ['findings', 'impression', 'recommendation', 'findings_ar', 'impression_ar', 'recommendation_ar']) {
      if (body[k] != null && typeof body[k] !== 'string') {
        return res.fail('Invalid request', 400, 'INVALID_REQUEST');
      }
    }
    if (body.arabic_approved != null && typeof body.arabic_approved !== 'boolean') {
      return res.fail('Invalid request', 400, 'INVALID_REQUEST');
    }
    if (isCompletedRow(ctx.order)) return res.fail('Case already completed', 409, 'CASE_COMPLETED');

    const current = reportSubmission.buildReportDraftFields(ctx.order);
    const pick = (k, cur) => (typeof body[k] === 'string' ? body[k] : (cur || ''));
    const diagnosisText = pick('findings', current.findings);
    const impressionText = pick('impression', current.impression);
    const recommendationsText = pick('recommendation', current.recommendations);

    // Migration 121 — the Arabic fields are passed ONLY when the body carries
    // them, so an English-only save (and the web editor, which never sends
    // them) leaves the Arabic text and its approval untouched.
    const persistArgs = { orderId: ctx.orderId, diagnosisText, impressionText, recommendationsText };
    if (typeof body.findings_ar === 'string') persistArgs.diagnosisTextAr = body.findings_ar;
    if (typeof body.impression_ar === 'string') persistArgs.impressionTextAr = body.impression_ar;
    if (typeof body.recommendation_ar === 'string') persistArgs.recommendationsTextAr = body.recommendation_ar;
    if (typeof body.arabic_approved === 'boolean') persistArgs.arabicApproved = body.arabic_approved;

    let changed = 0;
    try {
      changed = await reportSubmission.persistReportText(persistArgs);
    } catch (_) {
      return res.fail('Draft could not be saved', 500, 'DRAFT_SAVE_FAILED');
    }
    if (!changed) return res.fail('Case is not open', 409, 'CASE_NOT_OPEN');
    return res.ok({ saved_at: new Date().toISOString() });
  });

  // ─── GET /cases/:id/intelligence ──────────────────────────
  // The AI extractions, raw. Same gate as the web intelligence page
  // (doctorHasAcceptedCase): the extractions carry the patient's name.
  router.get('/cases/:id/intelligence', async (req, res) => {
    const ctx = await requireAcceptedCase(req, res);
    if (!ctx) return;
    const extraction = await safeGet(
      'SELECT lab_values, patient_info, documents_inventory, missing_documents, updated_at FROM case_extractions WHERE case_id = $1 LIMIT 1',
      [ctx.orderId], null
    );
    return res.ok({
      status: lower(ctx.order.intelligence_status) || 'none',
      updated_at: extraction ? isoOrNull(extraction.updated_at) : null,
      documents: extraction ? (parseJson(extraction.documents_inventory) || []) : [],
      lab_values: extraction ? (parseJson(extraction.lab_values) || []) : [],
      missing_documents: extraction ? (parseJson(extraction.missing_documents) || []) : [],
      patient_info: extraction ? (parseJson(extraction.patient_info) || null) : null,
    });
  });

  // ─── GET /cases/:id/records ───────────────────────────────
  // The patient's shared record history — the web patient-records JSON,
  // same query, same acceptance gate.
  router.get('/cases/:id/records', async (req, res) => {
    const ctx = await requireAcceptedCase(req, res);
    if (!ctx) return;
    const rows = ctx.order.patient_id ? await safeAll(
      'SELECT id, record_type, title, description, file_url, file_name, date_of_record, provider, tags, created_at FROM medical_records WHERE patient_id = $1 AND is_shared_with_doctors = true AND is_hidden = false ORDER BY date_of_record DESC, created_at DESC',
      [ctx.order.patient_id], []
    ) : [];
    return res.ok({
      records: (rows || []).map((r) => ({
        id: String(r.id),
        record_type: r.record_type == null ? null : String(r.record_type),
        title: r.title == null ? null : String(r.title),
        description: r.description == null ? null : String(r.description),
        file_url: r.file_url == null ? null : String(r.file_url),
        file_name: r.file_name == null ? null : String(r.file_name),
        date_of_record: r.date_of_record == null ? null : String(r.date_of_record),
        provider: r.provider == null ? null : String(r.provider),
        tags: r.tags == null ? null : r.tags,
        created_at: isoOrNull(r.created_at),
      })),
    });
  });

  // ─── GET /cases/:id/timeline ──────────────────────────────
  // order_events for the case plus the milestones the row itself records.
  // Labels are returned raw; the app localises the ones it knows.
  router.get('/cases/:id/timeline', async (req, res) => {
    const ctx = await requireAcceptedCase(req, res);
    if (!ctx) return;
    const o = ctx.order;
    const rows = await safeAll(
      'SELECT id, label, meta, at, actor_role FROM order_events WHERE order_id = $1 ORDER BY at ASC, id ASC',
      [ctx.orderId], []
    );
    const events = (rows || []).map((r) => ({
      label: r.label == null ? null : String(r.label),
      at: isoOrNull(r.at),
      meta: parseJson(r.meta),
      actor_role: r.actor_role == null ? null : String(r.actor_role),
      future: false,
    }));
    const have = new Set(events.map((e) => e.label));
    const synth = (label, at, extra) => {
      const iso = isoOrNull(at);
      if (!iso || have.has(label)) return;
      events.push({ label, at: iso, meta: null, actor_role: 'system', future: false, ...(extra || {}) });
    };
    synth('order_created', o.created_at);
    synth('doctor_accepted_case', o.accepted_at);
    if (o.deadline_at && !isCompletedRow(o)) {
      const iso = isoOrNull(o.deadline_at);
      if (iso) events.push({ label: 'report_due', at: iso, meta: null, actor_role: 'system', future: Date.parse(iso) > Date.now() });
    }
    synth('report_delivered', o.completed_at);
    events.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
    return res.ok({ events });
  });

  // ─── File suggestions (shared by GET and by request-files) ─
  async function buildFileSuggestions(orderId) {
    const out = [];
    const extraction = await safeGet(
      'SELECT missing_documents FROM case_extractions WHERE case_id = $1 LIMIT 1',
      [orderId], null
    );
    const missing = extraction ? parseJson(extraction.missing_documents) : null;
    if (Array.isArray(missing)) {
      missing.forEach((entry, index) => {
        const title = typeof entry === 'string' ? entry : (entry && (entry.label || entry.title || entry.name)) || '';
        if (!String(title).trim()) return;
        out.push({
          key: 'missing:' + index,
          title_en: String(title),
          title_ar: MISSING_DOC_AR[String(title)] || String(title),
          source: 'missing',
        });
      });
    }
    const flagged = await safeAll(
      `SELECT id, label, filename, ai_quality_status
         FROM order_files WHERE order_id = $1 AND LOWER(COALESCE(ai_quality_status, '')) = ANY($2)
        ORDER BY created_at ASC`,
      [orderId, QUALITY_FLAGGED], []
    );
    for (const f of flagged || []) {
      const label = f.label || f.filename || 'file';
      out.push({
        key: 'quality:' + f.id,
        title_en: 'Clearer copy of ' + label,
        title_ar: 'نسخة أوضح من ' + label,
        source: 'quality',
      });
    }
    out.push({ key: 'std:opnote', title_en: 'Previous operative note', title_ar: 'تقرير العملية السابق', source: 'standard' });
    out.push({ key: 'std:bloods', title_en: 'Recent blood tests', title_ar: 'تحاليل دم حديثة', source: 'standard' });
    return out;
  }

  // ─── GET /cases/:id/file-suggestions ──────────────────────
  router.get('/cases/:id/file-suggestions', async (req, res) => {
    const ctx = await requireAcceptedCase(req, res);
    if (!ctx) return;
    return res.ok({ suggestions: await buildFileSuggestions(ctx.orderId) });
  });

  // ─── POST /cases/:id/accept ───────────────────────────────
  // Runs the portal's accept handler (routes/doctor.js) and maps its redirect.
  // The handler has three silent bounces (unpaid, taken, wrong status) and
  // one silent success (already mine) that all end at the same two URLs, so
  // those are settled by re-reading the row rather than guessed.
  router.post('/cases/:id/accept', async (req, res) => {
    const doctorId = meId(req);
    const orderId = String(req.params.id || '');
    if (!doctorId || !orderId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');

    const before = await readOrder(orderId);
    const wasMine = !!(before && String(before.doctor_id || '') === doctorId && before.accepted_at);

    let out;
    try {
      out = await runWebAction(deps.actions().accept, {
        orderId, doctorId, doctorName: req.user && req.user.name, body: {}, req,
      });
    } catch (_) {
      return res.fail('Accept failed', 500, 'ACCEPT_FAILED');
    }

    if (!out.redirect) return res.fail('Accept failed', 500, 'ACCEPT_FAILED');
    const r = parseRedirect(out.redirect);

    if (r.msg) {
      const known = ACCEPT_MSG_CODES[r.msg];
      if (known) return res.fail('Accept refused: ' + r.msg, known[0], known[1]);
      return res.fail(r.msg, 409, 'ACCEPT_REFUSED');
    }
    if (r.error) {
      return res.fail('Accept failed', 500, 'ACCEPT_FAILED');
    }

    // Ambiguous: dashboard or bare case page. Decide from the truth.
    const after = await readOrder(orderId);
    if (!after) return notAvailable(res);
    const holder = String(after.doctor_id || '');
    if (holder === doctorId && after.accepted_at) {
      return res.ok({
        accepted: true,
        already: wasMine,
        deadline_at: isoOrNull(after.deadline_at),
        reference_id: after.reference_id == null ? null : String(after.reference_id),
        sla: slaStateOf(after),
      });
    }
    if (holder && holder !== doctorId) return res.fail('Case taken by another doctor', 409, 'CASE_TAKEN');
    const ps = lower(after.payment_status);
    if (ps !== 'paid' && ps !== 'captured') return res.fail('Case is not paid', 402, 'CASE_UNPAID');
    return res.fail('Case cannot be accepted', 409, 'CASE_NOT_ACCEPTABLE');
  });

  // ─── POST /cases/:id/decline ──────────────────────────────
  // body { reason: one of _queue.DOCTOR_DECLINE_REASONS, note? }
  router.post('/cases/:id/decline', async (req, res) => {
    const doctorId = meId(req);
    const orderId = String(req.params.id || '');
    if (!doctorId || !orderId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');

    const body = req.body || {};
    const reason = String(body.reason || '').trim();
    const allowed = queue().DOCTOR_DECLINE_REASONS || [];
    if (!allowed.includes(reason)) return res.fail('Invalid decline reason', 400, 'INVALID_REASON');
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';

    let out;
    try {
      out = await runWebAction(deps.actions().decline, {
        orderId, doctorId, doctorName: req.user && req.user.name, body: { reason, note }, req,
      });
    } catch (_) {
      return res.fail('Decline failed', 500, 'DECLINE_FAILED');
    }
    if (!out.redirect) return res.fail('Decline failed', 500, 'DECLINE_FAILED');
    const r = parseRedirect(out.redirect);

    if (r.msg === 'case_declined') return res.ok({ declined: true });
    if (r.error === 'decline_not_pending') return res.fail('Case is not pending acceptance', 409, 'DECLINE_NOT_PENDING');
    if (r.error === 'reason_required') return res.fail('Invalid decline reason', 400, 'INVALID_REASON');
    if (r.error === 'decline_failed') return res.fail('Decline failed', 500, 'DECLINE_FAILED');

    // Bare dashboard: the handler found no case of ours to decline.
    const after = await readOrder(orderId);
    if (!after || String(after.doctor_id || '') !== doctorId) return notAvailable(res);
    return res.fail('Decline failed', 500, 'DECLINE_FAILED');
  });

  // ─── request-files / reject-file → the web reject-files handler ─
  async function runRejectFiles(req, res, { orderId, doctorId, reason }) {
    let out;
    try {
      out = await runWebAction(deps.actions().rejectFiles, {
        orderId, doctorId, doctorName: req.user && req.user.name, body: { reason }, req,
      });
    } catch (_) {
      return res.fail('File request failed', 500, 'REQUEST_FAILED');
    }
    if (!out.redirect) return res.fail('File request failed', 500, 'REQUEST_FAILED');
    const r = parseRedirect(out.redirect);

    if (r.error === 'reason_required') return res.fail('Nothing to request', 400, 'EMPTY_REQUEST');
    if (r.error === 'reject_files_failed') return res.fail('File request failed', 500, 'REQUEST_FAILED');
    if (r.error === 'reject_files_sla_pause_failed') {
      // The request DID go out; only the clock did not stop. Say exactly that.
      return res.ok({ requested: true, sla_paused: false, warning: 'SLA_PAUSE_FAILED' });
    }
    if (r.error || r.msg) return res.fail('File request failed', 500, 'REQUEST_FAILED');
    if (/\/portal\/doctor\/dashboard\/?$/.test(r.path)) return notAvailable(res);

    const after = await readOrder(orderId);
    return res.ok({ requested: true, sla_paused: !!(after && after.sla_paused_at) });
  }

  // ─── POST /cases/:id/request-files ────────────────────────
  // body { items: string[] } — suggestion keys from GET /file-suggestions,
  // or 'custom:<free text>'. The reason the web handler records, shows the
  // admins and relays to the patient is the human titles joined.
  router.post('/cases/:id/request-files', async (req, res) => {
    const ctx = await requireAcceptedCase(req, res);
    if (!ctx) return;
    const lang = langOf(req);
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : null;
    if (!items || !items.length) return res.fail('Nothing to request', 400, 'EMPTY_REQUEST');

    const suggestions = await buildFileSuggestions(ctx.orderId);
    const byKey = Object.create(null);
    for (const s of suggestions) byKey[s.key] = s;

    const parts = [];
    for (const raw of items) {
      const key = String(raw == null ? '' : raw).trim();
      if (!key) continue;
      if (key.startsWith('custom:')) {
        const text = key.slice('custom:'.length).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
        if (text) parts.push(text);
        continue;
      }
      const s = byKey[key];
      if (!s) return res.fail('Unknown request item: ' + key, 400, 'INVALID_ITEM');
      parts.push(lang === 'ar' ? s.title_ar : s.title_en);
    }
    if (!parts.length) return res.fail('Nothing to request', 400, 'EMPTY_REQUEST');
    const reason = parts.join(' · ').slice(0, 300);

    return runRejectFiles(req, res, { orderId: ctx.orderId, doctorId: ctx.doctorId, reason });
  });

  // ─── POST /cases/:id/reject-file ──────────────────────────
  // body { file_id, reason } — one named file is unusable; same handler,
  // reason "File <label>: <reason>".
  router.post('/cases/:id/reject-file', async (req, res) => {
    const ctx = await requireAcceptedCase(req, res);
    if (!ctx) return;
    const body = req.body || {};
    const fileId = String(body.file_id || '').trim();
    const why = typeof body.reason === 'string' ? body.reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : '';
    if (!fileId || !why) return res.fail('file_id and reason are required', 400, 'INVALID_REQUEST');

    let file = await safeGet(
      'SELECT id, label, filename FROM order_files WHERE id = $1 AND order_id = $2 LIMIT 1',
      [fileId, ctx.orderId], null
    );
    if (!file) {
      file = await safeGet(
        'SELECT id, label FROM order_additional_files WHERE id = $1 AND order_id = $2 LIMIT 1',
        [fileId, ctx.orderId], null
      );
    }
    if (!file) return res.fail('File not found on this case', 404, 'FILE_NOT_FOUND');
    const label = file.label || file.filename || fileId;
    const reason = ('File ' + label + ': ' + why).slice(0, 300);

    return runRejectFiles(req, res, { orderId: ctx.orderId, doctorId: ctx.doctorId, reason });
  });

  // ─── POST /cases/:id/submit ───────────────────────────────
  // Deliver the report. This is the SAME call the portal's submit button
  // makes (routes/doctor.js handlePortalDoctorGenerateReport →
  // services/report_submission.submitDoctorReport), so a report submitted
  // from the phone completes the case, renders the identical PDF, settles
  // the earnings and notifies the patient exactly the way the web does — in
  // one atomic transaction, gated by a conditional completion UPDATE, so a
  // retry from a flaky connection produces one report and one notification.
  //
  // Nothing about the case is decided here. This handler validates the body,
  // calls the service, and maps its result codes onto HTTP. The app must not
  // send its own patient notification: the service already does, and only
  // from the submission that won the completion race.
  router.post('/cases/:id/submit', async (req, res) => {
    const doctorId = meId(req);
    const orderId = String(req.params.id || '');
    if (!doctorId || !orderId) return res.fail('Invalid request', 400, 'INVALID_REQUEST');

    const body = req.body || {};
    const text = (v) => (typeof v === 'string' ? v.trim() : '');

    const submitArgs = {
      orderId,
      doctorId,
      diagnosisText: text(body.findings ?? body.diagnosis ?? body.diagnosis_text),
      impressionText: text(body.impression ?? body.impression_text),
      recommendationsText: text(body.recommendation ?? body.recommendations ?? body.recommendation_text),
      via: 'doctor_app_report',
    };
    // Migration 121 — optional Arabic body, forwarded only when sent: the
    // service falls back to the stored Arabic draft for anything omitted, and
    // an app build that predates the Arabic editor submits exactly as before.
    const textAr = (v) => (typeof v === 'string' ? v.trim() : undefined);
    const findingsAr = textAr(body.findings_ar ?? body.diagnosis_text_ar);
    const impressionAr = textAr(body.impression_ar ?? body.impression_text_ar);
    const recommendationsAr = textAr(body.recommendation_ar ?? body.recommendations_ar ?? body.recommendation_text_ar);
    if (findingsAr !== undefined) submitArgs.diagnosisTextAr = findingsAr;
    if (impressionAr !== undefined) submitArgs.impressionTextAr = impressionAr;
    if (recommendationsAr !== undefined) submitArgs.recommendationsTextAr = recommendationsAr;
    if (typeof body.arabic_approved === 'boolean') submitArgs.arabicApproved = body.arabic_approved;

    const result = await reportSubmission.submitDoctorReport(submitArgs);

    if (result.ok) {
      const earnings = result.earnings || null;
      const earned =
        earnings && Number.isFinite(Number(earnings.earnedAmount)) ? Number(earnings.earnedAmount) : null;
      return res.ok({
        completed: true,
        // A retry of a submit that already landed: no side effects ran, and
        // the app should treat it as success, not as a failure to explain.
        already_completed: !!result.alreadyCompleted,
        report_url: result.reportUrl || null,
        earned_amount: earned,
        completed_at: new Date().toISOString(),
      });
    }

    switch (result.code) {
      case 'invalid_request':
        return res.fail('Invalid request', 400, 'INVALID_REQUEST');
      case 'not_found':
      case 'forbidden':
        // One refusal shape for "not yours" and "does not exist", as GET does.
        return res.fail('Case not available', 404, 'CASE_NOT_AVAILABLE');
      case 'report_empty':
        // Findings and impression are the load-bearing sections; the text is
        // already saved as a draft, so nothing the doctor typed is lost.
        return res.fail('Report incomplete', 422, 'REPORT_INCOMPLETE');
      case 'case_not_open':
        // Cancelled, refunded or otherwise closed under the doctor.
        return res.fail('Case is not open', 409, 'CASE_NOT_OPEN');
      case 'report_save_failed':
        return res.fail('Report could not be saved', 500, 'REPORT_SAVE_FAILED');
      case 'report_pdf_failed':
        // Text saved, case still open, retryable.
        return res.fail('Report PDF could not be generated', 502, 'REPORT_PDF_FAILED');
      case 'report_complete_failed':
        // Text and PDF saved; the atomic completion rolled back whole.
        return res.fail('Report could not be completed', 500, 'REPORT_COMPLETE_FAILED');
      default:
        return res.fail('Report submission failed', 500, 'REPORT_SUBMIT_FAILED');
    }
  });

  return router;
};

// The late-bound portal modules, exposed so a hermetic test can point one at
// a stub (routes/doctor.js needs a booted server to load).
module.exports._deps = deps;
// Pure helpers, exported for the tests that pin their behaviour.
module.exports._helpers = { slaStateOf, statusLabelOf, poolAcceptBy, parseRedirect, tierOf };
