/**
 * Tashkheesa Command — Admin API  (/api/v1/admin/*)
 *
 * Superadmin-only, READ-ONLY namespace for the Command mobile app.
 * v1 performs NO writes to production business data. The ONE write here is
 * auth-infra: rotating the superadmin's own users.refresh_token on login/
 * refresh (mirrors the patient auth pattern, enables server-side revocation).
 *
 * Mounting (see src/routes/api_v1.js): this router is mounted at `/admin`
 * BEFORE the global requireJWT + requireRole('patient') gate, so:
 *   - POST /admin/auth/login     → public (issues superadmin tokens)
 *   - POST /admin/auth/refresh   → public (rotates against stored token)
 *   - everything else            → requireJWT + requireRole('superadmin')
 *
 * Factory signature mirrors the patient sub-routers: (db, helpers, deploy).
 *   db      - the pg Pool (for pool.* connection metrics)
 *   helpers - { safeGet, safeAll, safeRun }
 *   deploy  - { gitSha, startedAt, startedAtIso, version, mode } from server.js
 *
 * See docs/COMMAND_APP_PHASE0_AUDIT.md for the audit + decisions this implements.
 */

'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const {
  requireJWT,
  requireRole,
  generateAdminTokens,
  verifyRefreshToken,
} = require('../../middleware/requireJWT');
const { buildHealthPayload, WORKER_SPECS } = require('../../services/admin_health');
const { randomUUID } = require('crypto');

// ─── AUDIT-TZ-3 — revenue bucketing timezone ────────────────────────────────
// Two SQL fragments, defined once so the KPI tile and the list it links to can
// never drift apart. See the long note at the collected-revenue query.
//
//   COLLECTED_AT_CAIRO — the moment an order's money was collected, expressed
//   as Cairo wall-clock. paid_at is timestamptz; created_at is timestamp
//   WITHOUT time zone holding UTC digits, so it is labelled UTC explicitly
//   rather than left to the session default.
//
//   NOW_CAIRO — "now" as Cairo wall-clock, so date_trunc() cuts the business
//   day at Cairo midnight rather than UTC midnight.
//
// Both sides of every comparison are therefore naive Cairo timestamps.
// 'Africa/Cairo' matches src/services/urgency_window.js and tracks the IANA
// database, so DST is handled for free.
// Migration 081 made created_at timestamptz, so both arms of the COALESCE now
// carry their zone and the value only has to be converted ONCE, to Cairo. The
// labelling created_at as UTC was correct while the column was naive; leaving
// that label after 081 would be actively wrong — on a timestamptz input
// AT TIME ZONE strips the zone, and the outer conversion would then reinterpret
// those naive digits as Cairo, shifting every figure by the Cairo offset.
const BUSINESS_TZ = 'Africa/Cairo';
const NOW_CAIRO = `(NOW() AT TIME ZONE '${BUSINESS_TZ}')`;
const COLLECTED_AT_CAIRO =
  `(COALESCE(paid_at, created_at) AT TIME ZONE '${BUSINESS_TZ}')`;
const COLLECTED_AT_CAIRO_O =
  `(COALESCE(o.paid_at, o.created_at) AT TIME ZONE '${BUSINESS_TZ}')`;

// ─── AUDIT-BREACH-COST — Cairo bucketing for the ledgers /breach-cost reads ──
// Migration 081 converted the naive timestamp columns on `orders` and
// `doctor_assignments` ONLY. `refunds.refunded_at` (declared TIMESTAMP by
// migration 028) and `doctor_earnings.clawback_applied_at` (TIMESTAMP, 054) are
// still `timestamp WITHOUT time zone` holding UTC digits — every writer is
// either a JS ISO string or SQL NOW() under the UTC-pinned session (src/pg.js).
//
// So these two need the pre-081 TWO-step: label the digits UTC, THEN convert to
// Cairo. Doing only the second step would reinterpret UTC digits as Cairo wall
// clock and shift every figure by the Cairo offset — the exact bug the module
// header above warns about, in the opposite direction.
const REFUNDED_AT_CAIRO_R =
  `(r.refunded_at AT TIME ZONE 'UTC' AT TIME ZONE '${BUSINESS_TZ}')`;
const CLAWBACK_AT_CAIRO_DE =
  `(de.clawback_applied_at AT TIME ZONE 'UTC' AT TIME ZONE '${BUSINESS_TZ}')`;

// ?period= → the Cairo-wall-clock lower bound of the window, as a CONSTANT SQL
// fragment. Whitelisted keys only; the values never contain user text, which is
// what makes interpolating them safe. GET /revenue parameterizes date_trunc's
// unit ($1) because 'day'/'month' is its only variable; here the 30d/90d arms
// need an INTERVAL literal, which cannot be a bind parameter in the same shape,
// so the whole bound is chosen from this table instead.
const BREACH_COST_PERIODS = {
  mtd: `date_trunc('month', ${NOW_CAIRO})`,
  '30d': `(${NOW_CAIRO} - INTERVAL '30 days')`,
  '90d': `(${NOW_CAIRO} - INTERVAL '90 days')`,
};

// "Refunded EGP" = COMMITTED refunds, the identical set the /refunds
// refundedMTD KPI already sums, so the two surfaces can never disagree.
// 'pending' is an obligation that may still be denied and 'denied' never
// becomes money, so neither is a cost. SLA-breach auto-refunds land as
// 'auto_approved' (services/sla_breach.js), which is inside this set from the
// moment the breach is detected.
const COMMITTED_REFUND_STATUSES = "('paid','approved','auto_approved')";

// Shared pure helpers for the /cases endpoints (status/tier normalization,
// tier-support, capacity, acceptance window). Extracted to a single source of
// truth so the candidates picker, single-assign write, queue/detail readers,
// and the bulk-auto-assign write all agree. See ./_assign_helpers.js.
const {
  STATUS_RAW,
  TIER_RAW,
  normalizeStatus,
  normalizeTier,
  doctorSupportsTier,
  capFor,
  acceptByIsoForOrder,
} = require('./_assign_helpers');
const { bulkAutoAssign } = require('../../services/admin_bulk_assign');
const { issueRefund } = require('../../services/admin_refund');
const { setDoctorPause } = require('../../services/admin_doctor_pause');
const { setDoctorApproval } = require('../../services/admin_doctor_approve');
const { setDoctorRejection } = require('../../services/admin_doctor_reject');
const { setRefundApproval } = require('../../services/admin_refund_approve');
const { setRefundDenial } = require('../../services/admin_refund_deny');
const { setRefundPaid } = require('../../services/admin_refund_mark_paid');
const { reviewPaymentEvent } = require('../../services/payment_event_review');

// Single-account lock (decision 1): the app authenticates ONLY the Shifa
// superadmin. Email allowlist is defense-in-depth on top of the role gate.
const SUPERADMIN_EMAIL = String(process.env.SUPERADMIN_EMAIL || 'ziad.wahsh@shifaegypt.com')
  .trim()
  .toLowerCase();

function normEmail(v) {
  return String(v || '').trim().toLowerCase();
}

function isAllowedAdminEmail(email) {
  return normEmail(email) === SUPERADMIN_EMAIL;
}

// Never leak password_hash / refresh_token / PII the app doesn't need.
function sanitizeAdmin(user) {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

// ─── /pulse helpers (pure) ─────────────────────────────────────
// The prototype invented patient age/sex; real rows carry users.date_of_birth
// (TEXT, usually ISO) + users.gender ("male"/"female"). Derive best-effort —
// either may be null. Western numerals throughout.
function deriveAgeSex(dob, gender) {
  let age = null;
  if (dob) {
    const t = Date.parse(String(dob));
    if (!Number.isNaN(t)) {
      const yrs = Math.floor((Date.now() - t) / (365.25 * 24 * 3600 * 1000));
      if (yrs >= 0 && yrs < 130) age = yrs;
    }
  }
  const g = String(gender || '').trim().toLowerCase();
  const sex = g === 'male' || g === 'm' ? 'M' : g === 'female' || g === 'f' ? 'F' : null;
  if (age != null && sex) return `${age}${sex}`;
  if (age != null) return String(age);
  if (sex) return sex;
  return null;
}

function cap(s) {
  const str = String(s || '');
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
}

// order_events.label is free-text (no event-type enum), so "kind" is a
// best-effort classification used only for the activity dot colour.
function classifyActivity(label) {
  const l = String(label || '').toLowerCase();
  if (/refund/.test(l)) return 'refund';
  if (/assign/.test(l)) return 'assignment';
  if (/approv|reject/.test(l)) return 'approval';
  if (/overrid/.test(l)) return 'override';
  if (/paid|payment/.test(l)) return 'payment';
  if (/submit|report/.test(l)) return 'submit';
  if (/upload|file/.test(l)) return 'files';
  if (/draft|created/.test(l)) return 'draft';
  return 'event';
}

// snake_case machine labels → human; sentence labels pass through unchanged.
function humanizeLabel(label) {
  const s = String(label || '').trim();
  if (!s) return '—';
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(s)) {
    return s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  }
  return s;
}

// reference_id is NULL in prod → fall back to the raw order id.
function refDetail(referenceId, orderId) {
  const ref = referenceId || (orderId ? String(orderId).slice(0, 8) : null);
  return ref ? `Case ${ref}` : null;
}

function toIso(v) {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

// EGP, 2dp. pg returns NUMERIC as a STRING (amount_egp is NUMERIC(10,2)) and
// DOUBLE PRECISION as a float (doctor_earnings.earned_amount), so every money
// figure crossing into JSON goes through here: Number() first, then round to
// piastres so a float sum can never surface as 1349.9999999999998. NULL/'' —
// which is what SUM() returns over an empty group — becomes 0, not NaN.
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

// status/tier normalization (STATUS_RAW, TIER_RAW, normalizeStatus,
// normalizeTier) now live in ./_assign_helpers.js — imported at the top.

// order_files in prod often carries only the R2 storage key (filename/label
// NULL) — derive a display name from the key's last path segment.
function basenameFromKey(key) {
  if (!key) return null;
  const seg = String(key).split('?')[0].split('/').filter(Boolean).pop();
  try {
    return seg ? decodeURIComponent(seg) : null;
  } catch (_) {
    return seg || null;
  }
}
// Coarse file kind from mime then filename extension (no file_type column).
function fileKind(mime, name) {
  const m = String(mime || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  if (m.startsWith('image/') || /\.(jpe?g|png|gif|webp|heic|dcm|dicom)$/.test(n)) return 'image';
  if (m === 'application/pdf' || /\.pdf$/.test(n)) return 'pdf';
  return 'file';
}

// /assign helpers (doctorSupportsTier, capFor, acceptByIsoForOrder) now live in
// ./_assign_helpers.js — imported at the top.

// Package 2 (Task 28): per-IP limiter for the Command-API doctor invite. It is
// already superadmin-gated (requireJWT + requireRole below), so this is
// defense-in-depth — caps runaway/scripted (re)sends. Module-level so it's a
// single shared instance (one in-memory store) across the router's lifetime.
const inviteIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, validate: false,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'too_many_requests' },
});

// ─── AUDIT-MANUAL-QUEUE — patient-facing copy for "mark unsuitable" ─────────
// MIRROR of MANUAL_QUEUE_UNSUITABLE_REASONS in routes/superadmin.js (the web
// console's mark-unsuitable handler). Same codes, same sentences, both
// languages — the patient must receive identical wording whether an operator
// acts from the phone or the desktop console. KEEP THE TWO IN SYNC: this is a
// copy, not an import, because routes/superadmin.js is a mounted router module
// with side effects at require time and must not be pulled into the API tree.
//
// The body's `reason` accepts either a bare code, a free-text sentence, or the
// web's combined "code | free-text" form; resolution below matches the web.
const MANUAL_QUEUE_UNSUITABLE_REASONS = {
  scope_outside_capability:        { en: 'This case falls outside the scope of our platform.', ar: 'الحالة دي خارج نطاق خدمات المنصة.' },
  insufficient_info_after_review:  { en: 'After review, the information provided was not sufficient for a second opinion.', ar: 'بعد المراجعة، المعلومات المقدمة مكانتش كافية لرأي طبي ثاني.' },
  not_second_opinion_case:         { en: 'This case is not a medical second-opinion request.', ar: 'الحالة دي مش طلب رأي طبي ثاني.' },
  other:                           { en: '', ar: '' }
};

// ─── AUDIT-EVENTS — human labels for the ops_push kinds ────────────────────
// One entry per `kind` string that services/ops_push.js is actually called
// with. Verified by grepping every pushOpsEvent() call site:
//   workers/acceptance_watcher.js  → 'urgent_unaccepted'
//   case_lifecycle.js              → 'sla_breach_first'
//   routes/patient.js              → 'refund_requested'
//   routes/payments.js             → 'payment_mismatch'
//   routes/apply.js, routes/auth.js→ 'doctor_application'
//   services/doctor_pause.js       → 'doctor_auto_paused'
// These are the same six keys COOLDOWN_MS_BY_KIND declares in ops_push.js.
//
// A kind NOT in this map is NOT dropped — humanizeLabel() turns the raw
// snake_case into a sentence, so a new producer shows up on the phone with a
// readable (if generic) label on the day it ships rather than after someone
// remembers to edit this table.
const OPS_PUSH_KIND_LABELS = {
  urgent_unaccepted: 'Urgent case unaccepted',
  sla_breach_first: 'First SLA breach of the day',
  refund_requested: 'Refund requested',
  payment_mismatch: 'Payment amount mismatch',
  doctor_application: 'Doctor application',
  doctor_auto_paused: 'Doctor auto-paused',
};

// ─── AUDIT-PAYOUTS / AUDIT-ERRORS — Cairo bucketing for the naive tables ───
//
// Migration 081 converted `orders` and `doctor_assignments` ONLY. Everything
// these three surfaces read is either still `timestamp WITHOUT time zone`
// holding UTC digits (doctor_earnings.created_at/paid_at from migration 004,
// error_logs.created_at and case_events.created_at from 001, order_events.at
// from 001) or already timestamptz (ops_push_log.sent_at, migration 082).
//
// The naive columns therefore need their zone stated before any Cairo
// conversion. The house form for that is the two-step `AT TIME ZONE 'UTC'
// AT TIME ZONE <tz>` (see CLAWBACK_AT_CAIRO_DE above) — but guard 13 in
// tests/lint/audit-2026-08-regressions.test.js blanket-matches that first step
// applied to ANY column named created_at, anywhere in this file, because on
// orders.created_at (timestamptz since 081) it double-shifts. The guard is
// deliberately coarse and this file is deliberately not the place to argue
// with it. So the equivalent `::timestamptz` cast is used instead: on a naive column it reads
// the digits in the SESSION zone, which src/pg.js pins to UTC, making it the
// same instant as the two-step form. This is exactly the reasoning — and the
// exact form — GET /manual-queue already uses on
// specialty_classifications.created_at.
//
// PAID_AT_CAIRO_DE coalesces paid_at → created_at deliberately: earnings_writer
// always stamps paid_at when it flips a row to 'paid', but the video/no-show
// writers (routes/video.js, video_scheduler.js) insert rows with no paid_at at
// all. Without the fallback a paid row from those paths would silently drop
// out of "paid this month" instead of being counted on the day it was written.
const MONTH_START_CAIRO = `date_trunc('month', ${NOW_CAIRO})`;
const PAID_AT_CAIRO_DE =
  `(COALESCE(de.paid_at, de.created_at)::timestamptz AT TIME ZONE '${BUSINESS_TZ}')`;

// The four suffixes that mean "code ran and did nothing useful". VERBATIM the
// set routes/ops.js's /silent-failures view and the ops dashboard card use
// (SILENT_FAILURE_SUFFIXES there), so the phone and the web agree on what
// counts. ESCAPE '\' because `_` is a LIKE wildcard — without it '%_FAILED'
// matches any 7-plus-character tail and the count is nonsense.
const SILENT_FAILURE_LIKE = (col) =>
  `(${col} LIKE '%\\_SKIPPED' ESCAPE '\\'` +
  ` OR ${col} LIKE '%\\_FAILED' ESCAPE '\\'` +
  ` OR ${col} LIKE '%\\_DROPPED' ESCAPE '\\'` +
  ` OR ${col} LIKE '%\\_NO\\_OP' ESCAPE '\\')`;

module.exports = function (db, helpers, deploy, deps) {
  const { safeGet, safeAll, safeRun } = helpers;
  const router = express.Router();

  // Post-commit notification helpers for POST /cases/:id/assign. Injectable so
  // the atomic assign write stays hermetically testable; default to the real
  // implementations at mount time. NB: ensureConversation /
  // queueMultiChannelNotification / notifyCaseAssigned each run on their OWN
  // module-level pool — they are fired strictly AFTER the assignment COMMIT,
  // never on the txn client, so a notification can never touch the atomic write.
  const assignDeps = deps || {};
  const ensureConversation = assignDeps.ensureConversation
    || require('../messaging').ensureConversation;
  const queueMultiChannelNotification = assignDeps.queueMultiChannelNotification
    || require('../../notify').queueMultiChannelNotification;
  const notifyCaseAssigned = assignDeps.notifyCaseAssigned
    || require('../../services/emailService').notifyCaseAssigned;
  // Slice 2b: the doctor-welcome token issuer (atomically issues a magic-login
  // token + welcome stamp + audit on the txn client; see services/admin_doctor_invite.js).
  // Injectable so POST /doctors/:id/invite stays hermetically testable; defaults
  // to the real service. In prod (api_v1.js passes no 4th arg) this
  // require-fallback is what runs — same pattern as the assign notifiers above.
  const issueDoctorWelcome = assignDeps.issueDoctorWelcome
    || require('../../services/admin_doctor_invite').inviteDoctor;
  // Slice 6: doctor-earnings clawback at refund mark-paid. Injectable so the
  // route test can stub it (the real one is DB-only via its own pool); defaults
  // to the existing earnings_writer.recomputeOnRefund — fired POST-COMMIT,
  // best-effort. We only CALL it; the clawback policy lives inside that function.
  const recomputeOnRefund = assignDeps.recomputeOnRefund
    || require('../../services/earnings_writer').recomputeOnRefund;
  // Manual-queue routing re-engagement + its error sink. Same injectable
  // pattern as the assign notifiers above: the real modules are the default,
  // tests pass stubs. enqueueAutoAssign / broadcastOrderToSpecialty are the two
  // calls POST /manual-queue/:id/approve fires POST-COMMIT to release a case
  // back into the normal routing flow; logErrorToDb is where their failures go
  // (see the AUDIT-H1 note at that handler — they must NOT go to stdout) and
  // logCaseEvent puts the same failure on the case's own timeline.
  const enqueueAutoAssign = assignDeps.enqueueAutoAssign
    || require('../../job_queue').enqueueAutoAssign;
  const broadcastOrderToSpecialty = assignDeps.broadcastOrderToSpecialty
    || require('../../notify/broadcast').broadcastOrderToSpecialty;
  const logErrorToDb = assignDeps.logErrorToDb
    || require('../../logger').logErrorToDb;
  const logCaseEvent = assignDeps.logCaseEvent
    || require('../../case_lifecycle').logCaseEvent;

  // ─── POST /auth/login (public) ─────────────────────────────
  // Generic 401 INVALID_CREDENTIALS for every failure mode — no account
  // enumeration, no leak of which check failed.
  router.post('/auth/login', async (req, res) => {
    const email = normEmail(req.body && req.body.email);
    const password = req.body && req.body.password;

    if (!email || !password || typeof password !== 'string') {
      return res.fail('Invalid email or password.', 401, 'INVALID_CREDENTIALS');
    }

    // Allowlist first — never even look up a non-superadmin identity.
    if (!isAllowedAdminEmail(email)) {
      return res.fail('Invalid email or password.', 401, 'INVALID_CREDENTIALS');
    }

    const user = await safeGet(
      "SELECT * FROM users WHERE email = $1 AND role = 'superadmin'",
      [email]
    );
    // Defense-in-depth: the query filters role, but re-check in code in case
    // an injected/odd row comes back.
    if (!user || user.role !== 'superadmin') {
      return res.fail('Invalid email or password.', 401, 'INVALID_CREDENTIALS');
    }

    const valid = !!user.password_hash && (await bcrypt.compare(password, user.password_hash));
    if (!valid) {
      return res.fail('Invalid email or password.', 401, 'INVALID_CREDENTIALS');
    }

    const tokens = generateAdminTokens(user);
    // The single auth-infra write: rotate this superadmin's stored refresh token.
    await safeRun('UPDATE users SET refresh_token = $1 WHERE id = $2', [tokens.refreshToken, user.id]);

    return res.ok({
      user: sanitizeAdmin(user),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  });

  // ─── POST /auth/refresh (public) ───────────────────────────
  router.post('/auth/refresh', async (req, res) => {
    const refreshToken = req.body && req.body.refreshToken;
    if (!refreshToken) {
      return res.fail('Refresh token required', 401, 'NO_REFRESH_TOKEN');
    }

    const decoded = verifyRefreshToken(refreshToken);
    if (!decoded) {
      return res.fail('Invalid refresh token', 401, 'INVALID_REFRESH');
    }

    // Rotation + role re-check: the stored token must match AND the account
    // must still be a superadmin.
    const user = await safeGet(
      "SELECT * FROM users WHERE id = $1 AND refresh_token = $2 AND role = 'superadmin'",
      [decoded.id, refreshToken]
    );
    if (!user) {
      return res.fail('Refresh token revoked', 401, 'REFRESH_REVOKED');
    }

    const tokens = generateAdminTokens(user);
    await safeRun('UPDATE users SET refresh_token = $1 WHERE id = $2', [tokens.refreshToken, user.id]);

    return res.ok({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  });

  // ─── Everything below is superadmin-gated ──────────────────
  router.use(requireJWT);
  router.use(requireRole('superadmin'));

  // ─── GET /health ───────────────────────────────────────────
  // Aggregates the Pulse status strip: API reachable, DB connected, the two
  // cron workers' liveness (from agent_heartbeats), and the deploy SHA/time.
  // Fully read-only.
  router.get('/health', async (req, res) => {
    const names = WORKER_SPECS.map((w) => w.key);

    let heartbeatRows = [];
    let dbConnected = true;
    try {
      heartbeatRows = await safeAll(
        'SELECT agent_name, MAX(pinged_at) AS last_run FROM agent_heartbeats' +
          ' WHERE agent_name = ANY($1::text[]) GROUP BY agent_name',
        [names]
      );
    } catch (e) {
      // If even this catalog-light read fails, the DB pill is the story.
      dbConnected = false;
    }

    const payload = buildHealthPayload({
      uptimeSec: Math.floor(process.uptime()),
      pool: db,
      heartbeatRows,
      deploy: deploy || {},
      now: Date.now(),
    });

    if (!dbConnected) {
      payload.db.connected = false;
      payload.db.pool = null;
    }

    return res.ok(payload);
  });

  // ─── GET /pulse ────────────────────────────────────────────
  // The Command dashboard's at-a-glance operational view. READ-ONLY:
  // aggregates over orders_active + users + order_events via the owner pool.
  // No writes, no Supabase SDK.
  //
  // Active set = paid/in_progress/submitted/assigned (decision A). "Pending
  // assignment" = active AND doctor_id IS NULL (there is no pending_assignment
  // status). The SLA spectrum is deliberately PARTIAL (decision B): the SLA
  // clock only starts at doctor acceptance (deadline_at = accepted_at +
  // sla_hours) and prod has no accepted cases yet, so healthy/approaching are
  // returned null — not fabricated — and fill in for real once acceptance data
  // exists. Only Breached (past deadline) and "No active timer" (active, no
  // deadline) are computed. Identity falls back to orders.id when reference_id
  // is null; the case "summary" is the real services.name (no free-text column).
  // AUDIT 2026-08-17 — this list is compared against orders.status, and it was
  // compared CASE-SENSITIVELY while the writers in this very file store the
  // canonical UPPERCASE value:
  //
  //     UPDATE orders SET status = 'ASSIGNED' ...   (assign, :1196)
  //     UPDATE orders SET status = 'ASSIGNED' ...   (bulk auto-assign)
  //     ... status = 'IN_REVIEW' ...                (SLA override, :1445)
  //
  // Verified against production Postgres: 'ASSIGNED' IN (...) is FALSE.
  //
  // So assigning a case from the Command app did not move it between dashboard
  // tiles — it dropped out of ALL of them (active, awaiting review, pending
  // assignment, breached, no-timer) while remaining correctly badged in the
  // Cases queue, which folds case via LOWER(). The two screens disagreed and
  // the dashboard was the wrong one.
  //
  // Every comparison below now folds case. ACTIVE_STATUS_LIST is the single
  // definition; tests/lint/status-comparisons-fold-case.test.js fails the build
  // if a status comparison is hand-written without LOWER() again.
  // AUDIT-2026-08-22 — 'sla_breach', 'breached' and 'reassigned' added.
  //
  // This one list drives the /pulse "Active cases", "Awaiting review"(no),
  // "Pending assign", "Breached" and "No active timer" tiles AND the Cases
  // screen's ?active=1 / ?timer=none filters. Omitting the breach statuses
  // meant a case DROPPED OUT of every active tile the instant it breached —
  // while the standalone deadline-based `breached` facet below (which has no
  // status predicate at all) went on counting it. The dashboard therefore
  // disagreed with itself on exactly the cases that need attention: the
  // breach count could exceed the active count it was supposedly a subset of.
  // 'breached' is the legacy lowercase spelling of SLA_BREACH that still
  // exists in this table (see case_lifecycle DB_STATUS_VARIANTS).
  //
  // 'reassigned' is here for the P0 above it: reassignCase with no alternate
  // doctor parks a PAID case at REASSIGNED with doctor_id NULL. That case is
  // unassigned, un-worked and waiting — the definition of something ops must
  // see — and it was in no tile at all.
  //
  // Left out deliberately: the remaining SLA_BREACH spellings
  // ('breached_sla', 'sla_breached', 'delayed', 'overdue'). No writer in this
  // codebase produces them; they exist only in the alias map. Add them here if
  // one is ever found in prod.
  const ACTIVE_STATUS_LIST = ['paid', 'in_progress', 'in_review', 'submitted', 'assigned', 'rejected_files', 'sla_breach', 'breached', 'reassigned'];
  const ACTIVE_STATUSES = '(' + ACTIVE_STATUS_LIST.map((s) => "'" + s + "'").join(',') + ')';
  // Case-folded column reference, for use on either side of an IN.
  const ST = "LOWER(COALESCE(status, ''))";
  const ST_O = "LOWER(COALESCE(o.status, ''))";

  router.get('/pulse', async (req, res) => {
    try {
      const [agg, backlog, breachedRows, pendingRows, activityRows] = await Promise.all([
        safeGet(
          `SELECT
              COUNT(*) FILTER (WHERE completed_at IS NULL AND ${ST} IN ${ACTIVE_STATUSES}) AS active_cases,
              COUNT(*) FILTER (WHERE completed_at IS NULL AND doctor_id IS NOT NULL AND ${ST} IN ('in_progress','in_review','assigned')) AS awaiting_review,
              COUNT(*) FILTER (WHERE completed_at IS NULL AND doctor_id IS NULL AND ${ST} IN ${ACTIVE_STATUSES}) AS pending_assignment,
              COUNT(*) FILTER (WHERE completed_at IS NULL AND ${ST} IN ${ACTIVE_STATUSES} AND deadline_at IS NOT NULL AND deadline_at::timestamptz < NOW()) AS sla_breached,
              COUNT(*) FILTER (WHERE completed_at IS NULL AND ${ST} IN ${ACTIVE_STATUSES} AND deadline_at IS NULL) AS no_sla_timer,
              ROUND(EXTRACT(EPOCH FROM (NOW() - MIN(created_at::timestamptz) FILTER (
                WHERE completed_at IS NULL AND doctor_id IS NULL AND ${ST} IN ${ACTIVE_STATUSES}
              ))) / 60) AS oldest_pending_mins
           FROM orders_active`,
          []
        ),
        safeGet(
          `SELECT COUNT(*) AS pending_approvals FROM users WHERE role = 'doctor' AND pending_approval = true`,
          []
        ),
        safeAll(
          `SELECT o.id, o.reference_id,
                  COALESCE(p.name, '—') AS patient,
                  COALESCE(sp.name, '—') AS specialty,
                  ROUND(EXTRACT(EPOCH FROM (o.deadline_at::timestamptz - NOW())) / 60) AS sla_mins
             FROM orders_active o
             LEFT JOIN users p ON p.id = o.patient_id
             LEFT JOIN specialties sp ON sp.id = o.specialty_id
            WHERE o.completed_at IS NULL AND ${ST_O} IN ${ACTIVE_STATUSES}
              AND o.deadline_at IS NOT NULL AND o.deadline_at::timestamptz < NOW()
            ORDER BY o.deadline_at::timestamptz ASC
            LIMIT 3`,
          []
        ),
        safeAll(
          `SELECT o.id, o.reference_id, o.status, o.urgency_tier,
                  COALESCE(p.name, '—') AS patient, p.gender, p.date_of_birth,
                  COALESCE(sp.name, '—') AS specialty,
                  COALESCE(sv.name, '—') AS service,
                  ROUND(EXTRACT(EPOCH FROM (o.deadline_at::timestamptz - NOW())) / 60) AS sla_mins
             FROM orders_active o
             LEFT JOIN users p ON p.id = o.patient_id
             LEFT JOIN specialties sp ON sp.id = o.specialty_id
             LEFT JOIN services sv ON sv.id = o.service_id
            WHERE o.completed_at IS NULL AND o.doctor_id IS NULL AND ${ST_O} IN ${ACTIVE_STATUSES}
            ORDER BY (o.deadline_at IS NULL), o.deadline_at::timestamptz ASC, o.created_at ASC
            LIMIT 6`,
          []
        ),
        safeAll(
          `SELECT e.id, e.label, e.at, e.actor_role,
                  u.name AS actor_name, o.reference_id, o.id AS order_id
             FROM order_events e
             LEFT JOIN users u ON u.id = e.actor_user_id
             -- include-deleted-ok: audit activity feed. Showing the
             -- reference of an expired case is correct, and the LEFT JOIN
             -- means filtering would change nothing anyway.
             LEFT JOIN orders o ON o.id = e.order_id
            ORDER BY e.at DESC
            LIMIT 8`,
          []
        ),
      ]);

      const a = agg || {};
      const n = (v) => Number(v) || 0;

      const payload = {
        operator: { name: (req.user && req.user.name) || null },
        generatedAt: new Date().toISOString(),
        kpis: {
          activeCases: n(a.active_cases),
          awaitingReview: n(a.awaiting_review),
          pendingAssignment: n(a.pending_assignment),
          oldestPendingMins: a.oldest_pending_mins == null ? null : n(a.oldest_pending_mins),
          slaBreached: n(a.sla_breached),
          slaApproaching: null, // deferred — SLA clock unstarted (no accepted cases yet)
          noSlaTimer: n(a.no_sla_timer),
        },
        sla: {
          healthy: null, // deferred — do not fabricate the spectrum
          approaching: null, // deferred — fills in once acceptance data exists
          breached: n(a.sla_breached),
          noTimer: n(a.no_sla_timer),
        },
        needsAction: {
          breached: (breachedRows || []).map((r) => ({
            id: r.reference_id || r.id,
            patient: r.patient,
            specialty: r.specialty,
            slaMins: r.sla_mins == null ? null : Number(r.sla_mins),
          })),
          pendingAssignmentCount: n(a.pending_assignment),
        },
        pendingAssignment: (pendingRows || []).map((r) => ({
          id: r.reference_id || r.id,
          patient: r.patient,
          ageSex: deriveAgeSex(r.date_of_birth, r.gender),
          specialty: r.specialty,
          service: r.service,
          tier: r.urgency_tier || 'standard',
          status: r.status,
          slaMins: r.sla_mins == null ? null : Number(r.sla_mins),
        })),
        doctorBacklog: { pendingApprovals: n(backlog && backlog.pending_approvals) },
        recentActivity: (activityRows || []).map((e) => ({
          id: String(e.id),
          at: toIso(e.at),
          kind: classifyActivity(e.label),
          actor: e.actor_name || (e.actor_role ? cap(e.actor_role) : 'System'),
          title: humanizeLabel(e.label),
          detail: refDetail(e.reference_id, e.order_id),
        })),
      };

      return res.ok(payload);
    } catch (err) {
      // Honest failure over fabricated zeros — the app renders its error state.
      return res.fail('Failed to compute pulse', 500, 'PULSE_ERROR');
    }
  });

  // ─── GET /refunds (read-only refund queue + revenue KPIs) ─────
  // The Payments tab. Three status buckets joined to the PATIENT VIA THE ORDER
  // (o.patient_id) — NOT via r.requested_by, which the web /superadmin/refunds
  // uses and which mislabels operator-initiated refunds. KPIs reuse the
  // authoritative dashboard/finance formulas verbatim:
  //   - collected = SUM(orders_active.price) WHERE payment_status IN ('paid','captured')
  //   - refundedMTD = committed refunds (status paid/approved/auto_approved) this month
  //     (identical to superadmin_dashboard so the two never disagree)
  //   - refundsOwed = the OPERATIONAL unpaid obligation (pending/approved/auto_approved),
  //     kept SEPARATE from refundedMTD.
  router.get('/refunds', async (req, res) => {
    try {
      const n = (v) => Number(v) || 0;

      // One row's columns — shared across the three buckets. Patient via the
      // order; reference_id is the display ref (NULL in prod → app falls back).
      const ROW = `r.id, r.order_id, r.amount_egp, r.requested_amount, r.approved_amount,
                   r.status, r.reason, r.instapay_handle, r.instapay_reference,
                   r.refunded_at, r.reviewed_at, r.paid_at,
                   p.name AS patient_name, o.reference_id, o.service_id, o.price, o.currency
              FROM refunds r
              -- include-deleted-ok: every refund-insert path gates on
              -- payment_status='paid', and soft-delete only ever touches
              -- unpaid expired drafts — so this join cannot produce a
              -- deleted row.
              JOIN orders o ON o.id = r.order_id
              LEFT JOIN users p ON p.id = o.patient_id`;

      const [pendingRows, awaitingRows, recentRows, refundedMtdRows, rev, ref] = await Promise.all([
        // pending — FIFO, oldest obligation first
        safeAll(`SELECT ${ROW} WHERE r.status = 'pending' ORDER BY r.refunded_at ASC`),
        // approved but not yet paid out
        safeAll(`SELECT ${ROW} WHERE r.status IN ('approved','auto_approved') ORDER BY r.refunded_at ASC`),
        // recently closed (paid or denied), last 30d — no reason filter (show
        // operator refunds too, unlike the web queue). Left UNCHANGED.
        safeAll(
          `SELECT ${ROW} WHERE r.status IN ('paid','denied')
             AND r.refunded_at > NOW() - INTERVAL '30 days'
           ORDER BY r.refunded_at DESC LIMIT 50`
        ),
        // Refunded-MTD list — the EXACT set behind the refundedMTD KPI: committed
        // refunds (paid/approved/auto_approved) this calendar MONTH, so this list's
        // total equals the tile. Distinct from `recent` (30d rolling + denied).
        safeAll(
          `SELECT ${ROW} WHERE r.status IN ('paid','approved','auto_approved')
             AND r.refunded_at >= date_trunc('month', NOW())
           ORDER BY r.refunded_at DESC`
        ),
        // Collected revenue (paid/captured) — orders_active. Sums grandTotal
        // = COALESCE(total_price_with_addons, price), bucketed by
        // the collected-date expression below — the SAME amount column and date
        // as the GET /revenue list total, so the tile always equals the list
        // (including orders with file add-ons).
        //
        // AUDIT-TZ-3 — the date expression is explicit about BOTH timezones, for
        // two separate reasons:
        //
        //   1. paid_at is timestamptz; created_at is timestamp WITHOUT time zone
        //      holding UTC digits. A bare COALESCE of the two makes Postgres
        //      cast created_at using the SESSION timezone. That silently
        //      produced wrong buckets while the session was Africa/Cairo, and
        //      would break again if anyone changed the session default. The
        //      `AT TIME ZONE 'UTC'` states what the digits actually are.
        //
        //   2. "Today" means today IN CAIRO, not in UTC. Pinning the session to
        //      UTC (src/pg.js) silently redefined date_trunc('day', NOW()) from
        //      a Cairo day to a UTC day, which moves the cutoff to 2am Cairo —
        //      so a sale at 00:30 Cairo would land in yesterday's figure. The
        //      business day is bucketed in Cairo explicitly.
        //
        // Keep this expression identical to the one in GET /revenue below, or
        // the tile and the list it links to will disagree.
        safeGet(
          `SELECT
             COALESCE(SUM(COALESCE(total_price_with_addons, price)) FILTER (WHERE ${COLLECTED_AT_CAIRO} >= date_trunc('day', ${NOW_CAIRO})), 0) AS collected_today,
             COALESCE(SUM(COALESCE(total_price_with_addons, price)) FILTER (WHERE ${COLLECTED_AT_CAIRO} >= date_trunc('month', ${NOW_CAIRO})), 0) AS collected_mtd
           FROM orders_active
           WHERE payment_status IN ('paid','captured')`
        ),
        // refundedMTD (committed) + refundsOwed (operational obligation), one pass.
        safeGet(
          `SELECT
             COALESCE(SUM(amount_egp) FILTER (
               WHERE refunded_at >= date_trunc('month', NOW())
                 AND status IN ('paid','approved','auto_approved')), 0) AS refunded_mtd,
             COUNT(*) FILTER (WHERE status IN ('pending','approved','auto_approved')) AS owed_count,
             COALESCE(SUM(amount_egp) FILTER (WHERE status IN ('pending','approved','auto_approved')), 0) AS owed_total
           FROM refunds`
        ),
      ]);

      const mapRefund = (r) => ({
        id: r.id,
        orderId: r.order_id,
        patientName: r.patient_name || null,
        orderReference: r.reference_id || null,
        serviceId: r.service_id || null,
        price: r.price == null ? null : Number(r.price),
        currency: r.currency || null,
        amountEgp: n(r.amount_egp),
        requestedAmount: r.requested_amount == null ? null : Number(r.requested_amount),
        approvedAmount: r.approved_amount == null ? null : Number(r.approved_amount),
        status: r.status,
        reason: r.reason || null,
        instapayHandle: r.instapay_handle || null,
        instapayReference: r.instapay_reference || null,
        refundedAt: toIso(r.refunded_at),
        reviewedAt: toIso(r.reviewed_at),
        paidAt: toIso(r.paid_at),
      });

      const pending = (pendingRows || []).map(mapRefund);
      const awaitingPayment = (awaitingRows || []).map(mapRefund);
      const recent = (recentRows || []).map(mapRefund);
      const refundedMtd = (refundedMtdRows || []).map(mapRefund);
      const r1 = rev || {};
      const r2 = ref || {};

      return res.ok({
        queue: { pending, awaitingPayment, recent, refundedMtd },
        kpis: {
          collectedToday: n(r1.collected_today),
          collectedMTD: n(r1.collected_mtd),
          refundedMTD: n(r2.refunded_mtd),
          refundsOwed: { count: n(r2.owed_count), total: n(r2.owed_total) },
        },
        counts: { pending: pending.length, awaitingPayment: awaitingPayment.length },
      });
    } catch (err) {
      return res.fail('Failed to load refunds', 500, 'REFUNDS_ERROR');
    }
  });

  // ─── GET /revenue?scope=today|mtd (read-only paid-orders list) ─
  // The list behind the Collected today / Collected MTD tiles. Buckets by the
  // SAME Cairo-day expression the collected KPI sums on (AUDIT-TZ-3, see the
  // long note there) — so this list's row set matches the tile's window.
  router.get('/revenue', async (req, res) => {
    try {
      const n = (v) => Number(v) || 0;
      const scope = String((req.query && req.query.scope) || '').toLowerCase();
      const unit = scope === 'today' ? 'day' : scope === 'mtd' ? 'month' : null;
      if (!unit) return res.fail("scope must be 'today' or 'mtd'", 400, 'BAD_REQUEST');

      const rows = await safeAll(
        `SELECT o.id, o.reference_id, COALESCE(p.name,'—') AS patient, COALESCE(sv.name,'—') AS service,
                o.base_price, o.price, o.total_price_with_addons, o.currency, o.payment_method,
                COALESCE(o.paid_at, o.created_at) AS collected_at
           FROM orders_active o
           LEFT JOIN users p     ON p.id = o.patient_id
           LEFT JOIN services sv ON sv.id = o.service_id
          WHERE LOWER(COALESCE(o.payment_status,'')) IN ('paid','captured')
            AND ${COLLECTED_AT_CAIRO_O} >= date_trunc($1, ${NOW_CAIRO})
          ORDER BY COALESCE(o.paid_at, o.created_at) DESC`,
        [unit]
      );

      const orders = (rows || []).map((o) => {
        const grandTotal = n(o.total_price_with_addons != null ? o.total_price_with_addons : o.price);
        return {
          id: o.id,
          orderReference: o.reference_id || null,
          patient: o.patient,
          service: o.service,
          basePrice: n(o.base_price),
          price: n(o.price),
          grandTotal,
          currency: o.currency || null,
          paymentMethod: o.payment_method || null,
          collectedAt: toIso(o.collected_at),
        };
      });
      const amount = orders.reduce((s, o) => s + o.grandTotal, 0);

      return res.ok({ scope, orders, total: { count: orders.length, amount } });
    } catch (err) {
      return res.fail('Failed to load revenue', 500, 'REVENUE_ERROR');
    }
  });

  // ─── GET /cases (filterable / sortable / paginated list) ────
  // READ-ONLY triage queue over orders_active. Default scope excludes
  // expired_unpaid + draft (dead/pre-payment noise) UNLESS an explicit status
  // filter requests them. Facet counts are global over orders_active (every
  // status) so the chips show the full landscape regardless of the active
  // filter. Identity, SLA, service-as-summary handled exactly like /pulse.
  router.get('/cases', async (req, res) => {
    try {
      const q = req.query || {};
      const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 25));
      const offset = Math.max(0, parseInt(q.offset, 10) || 0);
      const n = (v) => Number(v) || 0;

      // Parameterized dynamic WHERE.
      const cond = [];
      const params = [];
      const ph = () => '$' + params.length;

      if (q.status) {
        params.push(STATUS_RAW[normalizeStatus(q.status)] || [String(q.status).toLowerCase()]);
        cond.push(`LOWER(o.status) = ANY(${ph()}::text[])`);
      } else {
        cond.push("LOWER(COALESCE(o.status,'')) NOT IN ('expired_unpaid','draft')");
      }
      if (q.specialty) {
        params.push(q.specialty);
        cond.push(`o.specialty_id = ${ph()}`);
      }
      if (q.tier) {
        params.push(TIER_RAW[normalizeTier(q.tier)] || [normalizeTier(q.tier)]);
        cond.push(`LOWER(COALESCE(o.urgency_tier,'standard')) = ANY(${ph()}::text[])`);
      }
      if (q.payment) {
        params.push(String(q.payment).toLowerCase());
        cond.push(`LOWER(COALESCE(o.payment_status,'unpaid')) = ${ph()}`);
      }
      if (q.assigned === 'unassigned') cond.push('o.doctor_id IS NULL');
      else if (q.assigned === 'assigned') cond.push('o.doctor_id IS NOT NULL');
      if (q.breached === '1' || q.breached === 'true') {
        cond.push("o.completed_at IS NULL AND o.deadline_at IS NOT NULL AND o.deadline_at::timestamptz < NOW()");
      }
      // Active = the pulse "Active cases" KPI set (the ACTIVE_STATUSES constant),
      // not yet completed. This ANDs with assigned=unassigned to yield the EXACT
      // pulse "Pending assign" definition — so the loose `assigned` filter the
      // Cases screen relies on is left unchanged (tightening is gated behind active).
      if (q.active === '1' || q.active === 'true') {
        cond.push(`o.completed_at IS NULL AND LOWER(o.status) IN ${ACTIVE_STATUSES}`);
      }
      // No active timer = the pulse "No active timer" KPI: active, not completed,
      // and no SLA clock yet (deadline_at NULL — case not yet accepted).
      if (q.timer === 'none') {
        cond.push(`o.completed_at IS NULL AND o.deadline_at IS NULL AND LOWER(o.status) IN ${ACTIVE_STATUSES}`);
      }
      if (q.q) {
        params.push('%' + String(q.q).trim() + '%');
        const i = ph();
        cond.push(`(p.name ILIKE ${i} OR o.reference_id ILIKE ${i} OR o.id ILIKE ${i} OR sv.name ILIKE ${i} OR sp.name ILIKE ${i})`);
      }
      const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
      const orderBy = String(q.sort) === 'created'
        ? 'ORDER BY o.created_at DESC'
        : 'ORDER BY (o.deadline_at IS NULL), o.deadline_at::timestamptz ASC, o.created_at DESC';

      const fromJoins = `
          FROM orders_active o
          LEFT JOIN users p ON p.id = o.patient_id
          LEFT JOIN users d ON d.id = o.doctor_id
          LEFT JOIN specialties sp ON sp.id = o.specialty_id
          LEFT JOIN services sv ON sv.id = o.service_id`;

      const [rows, totalRow, facets] = await Promise.all([
        safeAll(
          `SELECT o.id, o.reference_id, o.status, o.urgency_tier, o.payment_status, o.doctor_id, o.created_at,
                  o.deadline_at, o.completed_at,
                  o.base_price, o.price, o.total_price_with_addons,
                  COALESCE(p.name,'—') AS patient, p.gender, p.date_of_birth,
                  COALESCE(sp.name,'—') AS specialty, COALESCE(sv.name,'—') AS service,
                  d.name AS doctor_name,
                  ROUND(EXTRACT(EPOCH FROM (o.deadline_at::timestamptz - NOW())) / 60) AS sla_mins
             ${fromJoins} ${where} ${orderBy} LIMIT ${limit} OFFSET ${offset}`,
          params
        ),
        safeGet(`SELECT COUNT(*) AS total ${fromJoins} ${where}`, params),
        safeAll(
          `SELECT LOWER(o.status) AS s, COUNT(*) AS n,
                  -- AUDIT-2026-08-22 — 'reassigned' joins 'paid'. A case that
                  -- breached with no alternate doctor is parked at REASSIGNED
                  -- with doctor_id NULL; it is unassigned in every sense that
                  -- matters and was missing from this count entirely.
                  COUNT(*) FILTER (WHERE o.doctor_id IS NULL AND o.completed_at IS NULL AND LOWER(o.status) IN ('paid','reassigned')) AS unassigned,
                  COUNT(*) FILTER (WHERE o.completed_at IS NULL AND o.deadline_at IS NOT NULL AND o.deadline_at::timestamptz < NOW()) AS breached
             FROM orders_active o GROUP BY LOWER(o.status)`,
          []
        ),
      ]);

      const byStatus = {};
      let all = 0;
      let unassigned = 0;
      let breached = 0;
      (facets || []).forEach((f) => {
        const k = normalizeStatus(f.s);
        byStatus[k] = (byStatus[k] || 0) + Number(f.n || 0);
        all += Number(f.n || 0);
        unassigned += Number(f.unassigned || 0);
        breached += Number(f.breached || 0);
      });

      const cases = (rows || []).map((r) => {
        const norm = normalizeStatus(r.status);
        return {
          id: r.id, // raw orders.id — the routing key for /cases/:id
          reference: r.reference_id || null,
          patient: r.patient,
          ageSex: deriveAgeSex(r.date_of_birth, r.gender),
          specialty: r.specialty,
          service: r.service,
          doctor: r.doctor_name || null,
          tier: normalizeTier(r.urgency_tier),
          status: norm,
          payment: String(r.payment_status || 'unpaid').toLowerCase(),
          slaMins: r.sla_mins == null ? null : Number(r.sla_mins),
          breached: !r.completed_at && r.sla_mins != null && Number(r.sla_mins) < 0,
          // AUDIT-2026-08-22 — mirrors the `unassigned` facet above.
          unassigned: !r.doctor_id && (norm === 'paid' || norm === 'reassigned'),
          createdAt: toIso(r.created_at),
          // Money (additive). base = base_price; price = charged (urgency incl.);
          // grandTotal = COALESCE(total_price_with_addons, price) (incl. add-ons).
          basePrice: n(r.base_price),
          price: n(r.price),
          grandTotal: n(r.total_price_with_addons != null ? r.total_price_with_addons : r.price),
        };
      });

      return res.ok({ cases, total: Number((totalRow && totalRow.total) || 0), limit, offset, counts: { all, breached, unassigned, byStatus } });
    } catch (err) {
      return res.fail('Failed to load cases', 500, 'CASES_ERROR');
    }
  });

  // ─── GET /cases/:id (full detail) ──────────────────────────
  // READ-ONLY. Report = real orders columns (single-language structured
  // opinion + report_url PDF; "signed" == completed). AI = latest
  // specialty_classifications row. Files = order_files ∪ order_additional_files
  // (name/kind derived from key+mime; download via the existing /files/:id).
  // Doctor load/SLA%/rating computed from the dashboard leaderboard pattern.
  router.get('/cases/:id', async (req, res) => {
    const id = req.params.id;
    try {
      const [row, orderFiles, addlFiles, ai, events, doctor, refund] = await Promise.all([
        safeGet(
          `SELECT o.id, o.reference_id, o.status, o.urgency_tier, o.payment_status, o.paid_at, o.payment_method,
                  o.price, o.created_at, o.completed_at, o.accepted_at, o.deadline_at, o.sla_hours,
                  o.doctor_id, o.specialty_id, o.service_id,
                  o.diagnosis_text, o.impression_text, o.recommendation_text, o.clinical_question, o.report_url,
                  COALESCE(p.name,'—') AS patient_name, p.gender, p.date_of_birth,
                  d.name AS doctor_name, sp.name AS specialty, sv.name AS service, dsp.name AS doctor_specialty,
                  ROUND(EXTRACT(EPOCH FROM (o.deadline_at::timestamptz - NOW())) / 60) AS sla_mins
             FROM orders_active o
             LEFT JOIN users p ON p.id = o.patient_id
             LEFT JOIN users d ON d.id = o.doctor_id
             LEFT JOIN specialties sp ON sp.id = o.specialty_id
             LEFT JOIN services sv ON sv.id = o.service_id
             LEFT JOIN specialties dsp ON dsp.id = d.specialty_id
            WHERE o.id = $1`,
          [id]
        ),
        safeAll(`SELECT id, filename, label, mime_type, size, url, created_at FROM order_files WHERE order_id = $1 ORDER BY created_at ASC`, [id]),
        safeAll(`SELECT id, label, file_url, file_key, uploaded_at FROM order_additional_files WHERE order_id = $1 ORDER BY uploaded_at ASC`, [id]),
        safeGet(
          `SELECT c.specialty_id, c.service_id, c.confidence, c.reasoning, c.model,
                  sp.name AS ai_specialty, sv.name AS ai_service
             FROM specialty_classifications c
             LEFT JOIN specialties sp ON sp.id = c.specialty_id
             LEFT JOIN services sv ON sv.id = c.service_id
            WHERE c.case_id = $1 ORDER BY c.created_at DESC LIMIT 1`,
          [id]
        ),
        safeAll(
          `SELECT e.id, e.label, e.at, e.actor_role, u.name AS actor_name
             FROM order_events e LEFT JOIN users u ON u.id = e.actor_user_id
            WHERE e.order_id = $1 ORDER BY e.at ASC LIMIT 50`,
          [id]
        ),
        safeGet(
          `SELECT u.max_active_cases AS cap,
                  (SELECT COUNT(*) FROM orders_active o WHERE o.doctor_id = u.id AND o.completed_at IS NULL
                     AND LOWER(o.status) NOT IN ('completed','cancelled','expired_unpaid')) AS load,
                  (SELECT COUNT(*) FILTER (WHERE o.completed_at IS NOT NULL AND o.deadline_at IS NOT NULL
                            AND o.completed_at::timestamptz <= o.deadline_at::timestamptz)::float
                          / NULLIF(COUNT(*) FILTER (WHERE o.completed_at IS NOT NULL), 0)
                     FROM orders_active o WHERE o.doctor_id = u.id) AS sla_hit,
                  (SELECT AVG(rating)::numeric(3,1) FROM reviews r WHERE r.doctor_id = u.id) AS rating
             FROM users u WHERE u.id = (SELECT doctor_id FROM orders_active WHERE id = $1)`,
          [id]
        ),
        safeGet(`SELECT amount_egp, status, reason, refunded_at FROM refunds WHERE order_id = $1 ORDER BY refunded_at DESC NULLS LAST LIMIT 1`, [id]),
      ]);

      if (!row) return res.fail('Case not found', 404, 'NOT_FOUND');

      const norm = normalizeStatus(row.status);

      const files = [];
      (orderFiles || []).forEach((f) => {
        const name = f.filename || f.label || basenameFromKey(f.url) || 'File';
        files.push({ id: String(f.id), name, kind: fileKind(f.mime_type, name), sizeBytes: f.size == null ? null : Number(f.size), downloadPath: `/files/${f.id}` });
      });
      (addlFiles || []).forEach((f) => {
        const name = f.label || basenameFromKey(f.file_key || f.file_url) || 'File';
        files.push({ id: String(f.id), name, kind: fileKind(null, name), sizeBytes: null, downloadPath: `/files/${f.id}` });
      });

      const reportPresent = !!(row.diagnosis_text || row.impression_text || row.recommendation_text || row.clinical_question || row.report_url);

      const payload = {
        id: row.id,
        reference: row.reference_id || null,
        status: norm,
        patient: { name: row.patient_name, ageSex: deriveAgeSex(row.date_of_birth, row.gender), gender: row.gender || null },
        routing: { specialty: row.specialty || '—', service: row.service || '—', tier: normalizeTier(row.urgency_tier) },
        sla: {
          deadlineAt: toIso(row.deadline_at),
          slaMins: row.sla_mins == null ? null : Number(row.sla_mins),
          slaHours: row.sla_hours == null ? null : Number(row.sla_hours),
          breached: !row.completed_at && row.sla_mins != null && Number(row.sla_mins) < 0,
          hasTimer: row.deadline_at != null,
        },
        payment: {
          state: String(row.payment_status || 'unpaid').toLowerCase(),
          price: row.price == null ? null : Number(row.price),
          paidAt: toIso(row.paid_at),
          method: row.payment_method || null,
          createdAt: toIso(row.created_at),
          refund: refund ? { amount: Number(refund.amount_egp) || 0, state: refund.status || null, reason: refund.reason || null, at: toIso(refund.refunded_at) } : null,
        },
        assignment: row.doctor_id
          ? {
              doctor: {
                name: row.doctor_name || '—',
                specialty: row.doctor_specialty || '—',
                load: doctor ? Number(doctor.load) || 0 : 0,
                cap: doctor && doctor.cap != null ? Number(doctor.cap) : null,
                slaPct: doctor && doctor.sla_hit != null ? Math.round(Number(doctor.sla_hit) * 100) : null,
                rating: doctor && doctor.rating != null ? Number(doctor.rating) : null,
              },
            }
          : null,
        ai: ai
          ? {
              specialty: ai.ai_specialty || ai.specialty_id || '—',
              service: ai.ai_service || ai.service_id || '—',
              confidencePct: ai.confidence == null ? null : Math.round(Number(ai.confidence) * 100),
              reasoning: ai.reasoning || null,
              model: ai.model || null,
              matchesRouting: ai.specialty_id != null && ai.specialty_id === row.specialty_id,
            }
          : null,
        files,
        report: reportPresent
          ? {
              present: true,
              findings: row.diagnosis_text || null,
              impression: row.impression_text || null,
              recommendation: row.recommendation_text || null,
              clinicalQuestion: row.clinical_question || null,
              pdfPath: row.report_url || null,
              signed: norm === 'completed',
            }
          : { present: false, findings: null, impression: null, recommendation: null, clinicalQuestion: null, pdfPath: null, signed: false },
        timeline: (events || []).map((e) => ({
          id: String(e.id),
          at: toIso(e.at),
          kind: classifyActivity(e.label),
          actor: e.actor_name || (e.actor_role ? cap(e.actor_role) : 'System'),
          title: humanizeLabel(e.label),
          detail: null,
        })),
      };

      return res.ok(payload);
    } catch (err) {
      return res.fail('Failed to load case', 500, 'CASE_DETAIL_ERROR');
    }
  });

  // ─── GET /cases/:id/candidates (doctor picker; read-only) ──
  // Specialty-matched doctors with load/cap + eligibility flags. The operator
  // chooses informed; the assign write re-validates everything server-side.
  router.get('/cases/:id/candidates', async (req, res) => {
    try {
      const c = await safeGet(
        `SELECT o.id, o.specialty_id, o.service_id, o.urgency_tier, o.doctor_id, COALESCE(sp.name,'—') AS specialty
           FROM orders_active o LEFT JOIN specialties sp ON sp.id = o.specialty_id WHERE o.id = $1`,
        [req.params.id]
      );
      if (!c) return res.fail('Case not found', 404, 'NOT_FOUND');

      const docs = c.specialty_id
        ? await safeAll(
            `SELECT u.id, u.name, u.is_active, u.is_paused, u.onboarding_complete, u.specialty_id, COALESCE(sp.name,'—') AS specialty,
                    u.max_active_cases, u.max_active_cases_urgent, u.sla_tiers_supported,
                    EXISTS (SELECT 1 FROM doctor_services ds WHERE ds.doctor_id = u.id AND ds.service_id = $2) AS offers_service,
                    (SELECT COUNT(*) FROM orders_active o WHERE o.doctor_id = u.id
                       AND LOWER(COALESCE(o.status,'')) NOT IN ('completed','cancelled','expired_unpaid','refunded')) AS load
               FROM users u LEFT JOIN specialties sp ON sp.id = u.specialty_id
              WHERE u.role = 'doctor' AND u.specialty_id = $1 ORDER BY u.name ASC`,
            [c.specialty_id, c.service_id]
          )
        : [];

      const candidates = (docs || [])
        .map((d) => {
          const cap = capFor(d, c.urgency_tier);
          const load = Number(d.load) || 0;
          const atCapacity = cap > 0 && load >= cap;
          const active = !!d.is_active;
          const paused = !!d.is_paused;
          const onboarded = !!d.onboarding_complete;
          const offersService = !!d.offers_service;
          return {
            id: d.id,
            name: d.name,
            specialty: d.specialty,
            specialtyMatch: true,
            active,
            paused,
            onboarded,
            offersService,
            load,
            cap,
            atCapacity,
            supportsTier: doctorSupportsTier(d.sla_tiers_supported, c.urgency_tier),
            eligible: active && !paused && onboarded && offersService && !atCapacity && d.id !== c.doctor_id,
          };
        })
        .sort((a, b) => (a.eligible === b.eligible ? a.load - b.load : a.eligible ? -1 : 1));

      return res.ok({ case: { id: c.id, specialty: c.specialty, specialtyId: c.specialty_id || null, tier: normalizeTier(c.urgency_tier) }, candidates });
    } catch (err) {
      return res.fail('Failed to load candidates', 500, 'CANDIDATES_ERROR');
    }
  });

  // ─── GET /doctors (read-only roster) ──────────────────────────
  // The Doctors-tab roster: every doctor with computed active load, SLA hit-rate,
  // and rating, plus a derived status and a per-specialty active-supply summary.
  // Reuses the canonical patterns verbatim: load = active-case COUNT over
  // orders_active using the /candidates exclusion list (the single canonical
  // form), sla_hit = the case-detail card's completed-within-deadline ratio,
  // rating = AVG(reviews.rating). No filters in v1 — the full roster (~14 rows)
  // is returned and the app filters client-side.
  router.get('/doctors', async (req, res) => {
    try {
      const n = (v) => Number(v) || 0;
      // sla_tiers_supported is stored as JSON (sometimes a string). Parse it the
      // same defensive way doctorSupportsTier does, but keep the array for output.
      const parseTiers = (raw) => {
        let arr = raw;
        if (typeof arr === 'string') {
          try { arr = JSON.parse(arr); } catch (_) { arr = null; }
        }
        return Array.isArray(arr) ? arr.map((s) => String(s)) : [];
      };

      const rows = await safeAll(
        `SELECT u.id, u.name, u.name_ar, u.display_name, u.email, u.phone,
                u.specialty_id, COALESCE(sp.name, '—') AS specialty,
                u.is_active, u.is_paused, u.is_available, u.pending_approval,
                u.max_active_cases, u.max_active_cases_urgent, u.sla_tiers_supported,
                u.years_of_experience, u.medical_license_number,
                u.created_at, u.approved_at, u.last_seen_at, u.welcome_email_last_sent_at,
                (SELECT COUNT(*) FROM orders_active o WHERE o.doctor_id = u.id
                   AND LOWER(COALESCE(o.status,'')) NOT IN ('completed','cancelled','expired_unpaid','refunded')) AS load,
                (SELECT COUNT(*) FILTER (WHERE o.completed_at IS NOT NULL AND o.deadline_at IS NOT NULL
                          AND o.completed_at::timestamptz <= o.deadline_at::timestamptz)::float
                        / NULLIF(COUNT(*) FILTER (WHERE o.completed_at IS NOT NULL), 0)
                   FROM orders_active o WHERE o.doctor_id = u.id) AS sla_hit,
                (SELECT AVG(rating)::numeric(3,1) FROM reviews r WHERE r.doctor_id = u.id) AS rating,
                (SELECT COUNT(*) FROM reviews r WHERE r.doctor_id = u.id) AS rating_count
           FROM users u LEFT JOIN specialties sp ON sp.id = u.specialty_id
          WHERE u.role = 'doctor'
          ORDER BY u.name ASC`
      );

      const doctors = (rows || []).map((d) => {
        // Status precedence: a pending application outranks paused/active; an
        // explicitly paused doctor outranks the active flag.
        const status = d.pending_approval ? 'pending'
          : d.is_paused ? 'paused'
          : d.is_active ? 'active'
          : 'inactive';
        return {
          id: d.id,
          name: d.name,
          nameAr: d.name_ar || null,
          displayName: d.display_name || null,
          email: d.email || null,
          phone: d.phone || null,
          specialtyId: d.specialty_id || null,
          specialty: d.specialty,
          status,
          isAvailable: !!d.is_available,
          load: { active: n(d.load), max: n(d.max_active_cases), maxUrgent: n(d.max_active_cases_urgent) },
          slaTiersSupported: parseTiers(d.sla_tiers_supported),
          slaHitRate: d.sla_hit == null ? null : Number(d.sla_hit),
          rating: { avg: d.rating == null ? null : Number(d.rating), count: n(d.rating_count) },
          yearsOfExperience: d.years_of_experience == null ? null : n(d.years_of_experience),
          medicalLicenseNumber: d.medical_license_number || null,
          createdAt: toIso(d.created_at),
          approvedAt: toIso(d.approved_at),
          lastSeenAt: toIso(d.last_seen_at),
          // slice 2b: null = never invited; non-null = welcome (re)sent at (lets
          // the app show invited-state + warn before a resend).
          lastInvitedAt: toIso(d.welcome_email_last_sent_at),
        };
      });

      // Roster ordering: pending applications first (they need a decision), then
      // ascending active load (most-available first) — the same load metric the
      // assignment picker sorts on.
      doctors.sort((a, b) => {
        const ap = a.status === 'pending' ? 0 : 1;
        const bp = b.status === 'pending' ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return a.load.active - b.load.active;
      });

      // Summary computed in JS from the fetched rows (no extra count queries).
      const byStatus = { active: 0, pending: 0, paused: 0, inactive: 0 };
      const specOrder = [];
      const specMap = new Map();
      for (const doc of doctors) {
        if (Object.prototype.hasOwnProperty.call(byStatus, doc.status)) byStatus[doc.status] += 1;
        if (doc.specialtyId) {
          let entry = specMap.get(doc.specialtyId);
          if (!entry) {
            entry = { specialtyId: doc.specialtyId, specialty: doc.specialty, activeCount: 0 };
            specMap.set(doc.specialtyId, entry);
            specOrder.push(entry);
          }
          if (doc.status === 'active') entry.activeCount += 1;
        }
      }
      const bySpecialty = specOrder.sort((a, b) => a.specialty.localeCompare(b.specialty));

      return res.ok({
        doctors,
        summary: { total: doctors.length, byStatus, bySpecialty },
      });
    } catch (err) {
      return res.fail('Failed to load doctors', 500, 'DOCTORS_ERROR');
    }
  });

  // ─── POST /cases/:id/assign ──
  // FIRST ASSIGN is one all-or-nothing transaction: SELECT … FOR UPDATE,
  // re-validate all 10 rules from fresh in-txn reads (client never trusted),
  // then 4 writes (orders UPDATE + doctor_assignments INSERT + order_events +
  // admin_audit error_logs). Silent by design: NO accepted_at/deadline_at (the
  // SLA clock starts at acceptance). Reassign-to-same-doctor rejected.
  //
  // REASSIGN (AUDIT-2026-08-22) no longer writes raw SQL. It validates under
  // the same lock, releases it, and calls case_lifecycle.reassignCase — see the
  // long note at that branch. Two deliberate consequences of that switch:
  //   * reassign is no longer atomic with the audit rows (the lifecycle write
  //     commits first; the audit rows are best-effort after it);
  //   * reassign now HAS earnings side-effects. reassignCase runs
  //     markPartialPayOnReassignment, so the outgoing doctor is moved to 10%
  //     partial pay exactly as an automatic reassignment already does. This
  //     endpoint used to be the one reassignment path in the system that left
  //     the original doctor on full pay for work someone else finished.
  router.post('/cases/:id/assign', async (req, res) => {
    const id = req.params.id;
    const doctorId = req.body && req.body.doctorId;
    const reason = req.body && req.body.reason ? String(req.body.reason).slice(0, 500) : null;
    if (!doctorId || typeof doctorId !== 'string') return res.fail('doctorId is required', 400, 'BAD_REQUEST');

    // Throw-to-reject: attaches an HTTP status + code carried out of the txn.
    const af = (msg, http, code) => {
      const e = new Error(msg);
      e.http = http;
      e.code = code;
      throw e;
    };

    let client;
    try {
      client = await db.connect();
      await client.query('BEGIN');

      const o = (await client.query(
        // AUDIT-2026-08-22 — `tier` added: acceptance_window resolves the
        // window from `tier || urgency_tier`, and `tier` is what
        // notify/broadcast.js writes. Selecting only urgency_tier silently
        // demoted every broadcast case to the sla_hours fallback bucket.
        `SELECT id, doctor_id, status, payment_status, paid_at, specialty_id, service_id, tier, urgency_tier, sla_hours
           FROM orders WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [id]
      )).rows[0];
      if (!o) af('Case not found', 404, 'NOT_FOUND');

      const paid = !!o.paid_at && (String(o.payment_status || '').toLowerCase() === 'paid'
        || (!o.payment_status && String(o.status || '').toLowerCase() === 'paid'));
      if (!paid) af('Payment is not confirmed for this case', 409, 'PAYMENT_NOT_CONFIRMED');

      const status = normalizeStatus(o.status);
      const isReassign = !!o.doctor_id;
      if (!isReassign && status !== 'paid') af(`Case is not assignable (status: ${status})`, 409, 'NOT_ASSIGNABLE');
      if (isReassign && !['assigned', 'in_review', 'sla_breach', 'reassigned'].includes(status)) af(`Case is not reassignable (status: ${status})`, 409, 'NOT_REASSIGNABLE');
      if (isReassign && o.doctor_id === doctorId) af('Case is already assigned to this doctor', 409, 'ALREADY_ASSIGNED_TO_DOCTOR');

      const d = (await client.query(
        `SELECT id, name, role, is_active, is_paused, onboarding_complete, specialty_id, max_active_cases, max_active_cases_urgent
           FROM users WHERE id = $1`,
        [doctorId]
      )).rows[0];
      if (!d || d.role !== 'doctor') af('Doctor not found', 404, 'DOCTOR_NOT_FOUND');
      if (!d.is_active) af('Doctor is inactive', 409, 'DOCTOR_INACTIVE');
      if (d.is_paused) af('Doctor is paused', 409, 'DOCTOR_PAUSED');
      if (d.specialty_id !== o.specialty_id) af("Doctor's specialty does not match the case", 409, 'SPECIALTY_MISMATCH');
      if (!d.onboarding_complete) af('Doctor has not completed onboarding', 409, 'DOCTOR_ONBOARDING_INCOMPLETE');
      const offersService = !!(await client.query(
        `SELECT 1 FROM doctor_services WHERE doctor_id = $1 AND service_id = $2 LIMIT 1`,
        [doctorId, o.service_id]
      )).rows[0];
      if (!offersService) af('Doctor does not offer this service', 409, 'DOCTOR_SERVICE_NOT_OFFERED');

      const cap = capFor(d, o.urgency_tier);
      const load = Number((await client.query(
        `SELECT COUNT(*) AS c FROM orders WHERE doctor_id = $1 AND deleted_at IS NULL
           AND LOWER(COALESCE(status,'')) NOT IN ('completed','cancelled','expired_unpaid','refunded')`,
        [doctorId]
      )).rows[0].c) || 0;
      if (cap > 0 && load >= cap) af(`Doctor is at capacity (${load}/${cap})`, 409, 'DOCTOR_AT_CAPACITY');

      const now = new Date().toISOString();
      const fromDoctor = o.doctor_id || null;

      if (isReassign) {
        // ─── AUDIT-2026-08-22 (P0) — reassign goes through the lifecycle ───
        //
        // This branch used to write doctor_id, reassigned_count,
        // reassigned_to_doctor_id, reassigned_at and reassignment_reason, and
        // nothing else. It bypassed case_lifecycle entirely, so:
        //   * the SLA reset in assignDoctor (accepted_at / deadline_at /
        //     breached_at -> NULL) never ran, and
        //   * `status` was left exactly as it was.
        // Reassigning out of sla_breach — which is the normal reason to
        // reassign at all — therefore handed doctor #2 a case that:
        //   * carries a deadline already in the past, so every countdown in the
        //     product shows a negative number;
        //   * can never breach again (fetchSlaCandidates filters
        //     breached_at IS NULL);
        //   * can never time out (fetchDoctorTimeouts filters
        //     accepted_at IS NULL, and the inherited accepted_at is not null);
        //   * and that they CANNOT ACCEPT, because 'sla_breach' is not in
        //     routes/doctor.js's UNACCEPTED_STATUSES. A case handed to a doctor
        //     who has no button to take it.
        // reassignCase -> transitionCase(REASSIGNED) -> assignDoctor performs
        // the reset and the status transition every other reassignment in the
        // system gets, writes the doctor_assignments row with the shared
        // acceptance window, closes the previous assignment, and records the
        // earnings/partial-pay consequence for the outgoing doctor.
        //
        // WHY THE TRANSACTION IS DROPPED FIRST. The validations above ran under
        // SELECT … FOR UPDATE; case_lifecycle takes its own pool connections, so
        // calling it while this txn still holds the row lock self-deadlocks.
        // We ROLLBACK (no writes have happened on this client — every statement
        // so far is a SELECT) purely to release the lock, then call the
        // lifecycle. The window between the two is safe: assignDoctor re-reads
        // the row and re-asserts payment and status, and reassignCase rejects
        // any status outside ASSIGNED/IN_REVIEW/SLA_BREACH/REASSIGNED, so a
        // racing second reassign is refused rather than applied twice.
        await client.query('ROLLBACK');
        client.release();
        client = null;

        // Lazy require: case_lifecycle -> notify -> ... closes a boot-order
        // loop back to the routers if taken at module scope (same reason as
        // the lazy logCaseEvent require at the top of this file).
        const { reassignCase } = require('../../case_lifecycle');
        try {
          // AUDIT-2026-08-22 — flag this as operator-initiated, and keep the
          // 'admin_manual' marker at the FRONT of the free-text reason.
          //
          // reassignCase -> _checkPauseAsync -> doctor_pause.checkAndAutoPauseDoctor
          // counts every reassignment earnings row a doctor accumulates in 30
          // days and auto-pauses at 3, labelled 'auto:sla_breach_threshold'. The
          // Command reassign is used for reasons that are not the doctor's fault
          // at all (on leave, patient asked for a different reader, wrong
          // subspecialty), so three of those in a month silently removed a good
          // doctor from findAlternateDoctor and every broadcast. The flag
          // suppresses the check; the reason prefix is what
          // doctor_pause's own query filters on, so an operator's free text
          // ("covering for annual leave") cannot defeat it.
          const lifecycleReason = reason ? ('admin_manual: ' + reason).slice(0, 500) : 'admin_manual';
          await reassignCase(id, doctorId, {
            reason: lifecycleReason,
            operatorInitiated: true
          });
        } catch (e) {
          // The lifecycle re-validates on its own reads and can legitimately
          // refuse (another operator got there first, the case moved on).
          // Surface its reason instead of the generic ASSIGN_ERROR, which
          // would read as "the server broke" for what is a lost race.
          console.error('[admin/assign] reassignCase failed:', e && e.message);
          af('Reassignment failed: ' + ((e && e.message) || 'lifecycle error'), 500, 'REASSIGN_FAILED');
        }

        // reassignCase writes reassigned_to_doctor_id / reassigned_at /
        // reassignment_reason but not the counter, which is this app's own
        // column. Kept as a separate statement so the Command app's
        // reassigned_count semantics are unchanged.
        try {
          await safeRun('UPDATE orders SET reassigned_count = COALESCE(reassigned_count,0) + 1 WHERE id = $1', [id]);
        } catch (e) {
          console.error('[admin/assign] reassigned_count bump failed:', e && e.message);
        }
      } else {
        // AUDIT-2026-08-22 — ONE acceptance window, from the shared resolver, and
        // it lands on BOTH columns that claim to hold it: doctor_assignments
        // .accept_by_at (what case_sla_worker.fetchDoctorTimeouts enforces) and
        // orders.acceptance_deadline_at (what acceptance_watcher's expiry sweep
        // reads). The orders column used to be left holding whatever
        // notify/broadcast.js wrote at payment time — long past, and describing a
        // broadcast rather than this assignment.
        //
        // Declared HERE, not above the branch: the reassign path hands the whole
        // job to case_lifecycle.assignDoctor, which computes and writes its own
        // window from the same resolver, so a copy computed out here was dead.
        const acceptByAt = acceptByIsoForOrder(o);
        await client.query(
          `UPDATE orders SET doctor_id = $1, status = 'ASSIGNED', assignment_status = 'assigned',
             acceptance_deadline_at = $3, updated_at = NOW() WHERE id = $2`,
          [doctorId, id, acceptByAt]
        );
        await client.query(
          `INSERT INTO doctor_assignments (id, case_id, doctor_id, assigned_at, accept_by_at, reassigned_from_doctor_id)
             VALUES ($1, $2, $3, $4, $5, NULL)`,
          [randomUUID(), id, doctorId, now, acceptByAt]
        );
      }

      // Audit rows. On the first-assign path they are still part of the atomic
      // transaction; on the reassign path the lifecycle write has already
      // committed, so they are best-effort on the pool (an audit-row failure
      // must not report a reassignment that actually happened as a 500).
      const label = `Case ${isReassign ? 'reassigned' : 'assigned'} to ${d.name} by superadmin`;
      const auditStatements = [
        [`INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
           VALUES ($1, $2, $3, $4, NOW(), $5, 'superadmin')`,
          [randomUUID(), id, label, JSON.stringify({ doctorId, from: fromDoctor, reason }), req.user.id]],
        [`INSERT INTO error_logs (id, level, category, message, user_id, context)
           VALUES ($1, 'audit', 'admin_audit', $2, $3, $4)`,
          [randomUUID(), `${isReassign ? 'reassigned' : 'assigned'} case ${id} to doctor ${doctorId}`, req.user.id,
            JSON.stringify({ action: isReassign ? 'case_reassigned' : 'case_assigned', caseId: id, doctorId, from: fromDoctor, reason })]],
      ];
      if (client) {
        for (const [sql, params] of auditStatements) await client.query(sql, params);
        await client.query('COMMIT');
      } else {
        for (const [sql, params] of auditStatements) {
          try { await safeRun(sql, params); } catch (e) {
            console.error('[admin/assign] audit row failed:', e && e.message);
          }
        }
      }

      // ─── Post-commit notifications (best-effort) ─────────────────────────
      // The atomic assignment above is the source of truth and is already
      // committed. Everything below runs AFTER commit, on separate pools, and
      // can NEVER roll the assignment back: a conversation row, queued
      // notification rows (notification_worker.js does the real email/WhatsApp
      // send out-of-band), and the canonical inline patient email. Every path
      // is idempotent — queueNotification dedupes on (dedupe_key, channel,
      // to_user_id) and ensureConversation SELECT-guards on
      // (order_id, patient_id, doctor_id) — so a retried or partially-run block
      // never double-notifies. Channels are limited to those the worker can
      // actually deliver (verified against notification_worker TEMPLATE_TO_EMAIL
      // + whatsappTemplateMap) to avoid enqueuing undeliverable rows. Any
      // failure is logged and surfaced as a per-target flag; the assignment
      // itself still returns success.
      const nstat = { conversation: 'pending', doctor: 'pending', patient: 'pending' };
      if (isReassign) nstat.previousDoctor = 'pending';
      else nstat.patientEmail = 'pending';

      const safeQueue = async (opts) => {
        try {
          const r = await queueMultiChannelNotification(opts);
          return (r && r.ok === false) ? 'failed' : 'queued';
        } catch (e) {
          console.error('[admin/assign] notify failed:', opts && opts.template, e && e.message);
          return 'failed';
        }
      };

      try {
        const meta = await safeGet(
          `SELECT o.patient_id, o.reference_id, p.email AS patient_email, p.name AS patient_name
             FROM orders o LEFT JOIN users p ON p.id = o.patient_id WHERE o.id = $1 AND o.deleted_at IS NULL`,
          [id]
        );
        const patientId = meta && meta.patient_id ? meta.patient_id : null;
        const caseRef = (meta && meta.reference_id) || id;
        const doctorName = d.name || 'a specialist';

        // 1) Conversation (patient ↔ assigned doctor) — idempotent SELECT-guard.
        if (patientId) {
          try {
            const convoId = await ensureConversation(id, patientId, doctorId);
            nstat.conversation = convoId ? 'ok' : 'failed';
          } catch (e) {
            nstat.conversation = 'failed';
            console.error('[admin/assign] ensureConversation failed:', e && e.message);
          }
        } else {
          nstat.conversation = 'skipped_no_patient';
        }

        // 2) Incoming doctor — fully deliverable (internal + email + whatsapp).
        nstat.doctor = await safeQueue({
          orderId: id,
          toUserId: doctorId,
          channels: ['internal', 'email', 'whatsapp'],
          template: isReassign ? 'order_reassigned_doctor' : 'order_assigned_doctor',
          response: { case_id: id, caseReference: caseRef, doctorName },
          dedupe_key: `${isReassign ? 'order_reassigned' : 'order_assigned'}:${id}:${doctorId}`,
        });

        if (isReassign) {
          // 3a) Patient (reassignment): in-app + WhatsApp. No patient
          // reassignment email template exists in the system.
          if (patientId) {
            nstat.patient = await safeQueue({
              orderId: id,
              toUserId: patientId,
              channels: ['internal', 'whatsapp'],
              template: 'order_reassigned_patient',
              response: { case_id: id, caseReference: caseRef, doctorName },
              dedupe_key: `order_reassigned_patient:${id}:${doctorId}`,
            });
          } else {
            nstat.patient = 'skipped_no_patient';
          }

          // 3b) Previous doctor — NOT queued here.
          //
          // AUDIT-2026-08-22 — this was a duplicate. Since the reassign path
          // was routed through case_lifecycle.reassignCase (above), the
          // lifecycle's _queueOriginalDoctorNotification already queues
          // 'order_reassigned_from_doctor' to this same doctor for this same
          // event, on ['internal','email'], with dedupe key
          // 'reassign:from:<case>:<doctor>'. The key here was different, so
          // neither deduped the other and the booted doctor got the message
          // twice — and this copy passed no partialPct/partialAmount, so the
          // 'case-reassigned-original' email rendered its partial-pay box as
          // "You'll receive % partial pay (EGP )". The lifecycle copy is the
          // one that knows the figures, so it is the single owner now.
          nstat.previousDoctor = fromDoctor ? 'queued_by_lifecycle' : 'skipped';
        } else if (patientId) {
          // 3) Patient (first assignment): in-app bell (internal only — the
          // email/WhatsApp channels are unmapped for this template) PLUS the
          // canonical inline assignment email (the only deliverable one).
          nstat.patient = await safeQueue({
            orderId: id,
            toUserId: patientId,
            channels: ['internal'],
            template: 'order_assigned_patient',
            response: { case_id: id, caseReference: caseRef, doctorName },
            dedupe_key: `order_assigned_patient:${id}:${doctorId}`,
          });
          if (meta && meta.patient_email) {
            try {
              const r = await notifyCaseAssigned(
                { name: meta.patient_name, email: meta.patient_email },
                caseRef, doctorName, o.sla_hours
              );
              nstat.patientEmail = (r && r.ok === false) ? 'failed' : 'sent';
            } catch (e) {
              nstat.patientEmail = 'failed';
              console.error('[admin/assign] notifyCaseAssigned failed:', e && e.message);
            }
          } else {
            nstat.patientEmail = 'skipped_no_email';
          }
        } else {
          nstat.patient = 'skipped_no_patient';
          nstat.patientEmail = 'skipped_no_patient';
        }

        // Timeline note — best-effort, on the pool (not the committed txn).
        const anyFailed = Object.keys(nstat).some((k) => nstat[k] === 'failed');
        try {
          await safeRun(
            `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
               VALUES ($1, $2, $3, $4, NOW(), $5, 'superadmin')`,
            [randomUUID(), id,
              anyFailed ? 'Assignment notifications partially failed' : 'Assignment notifications dispatched',
              JSON.stringify(nstat), req.user.id]
          );
        } catch (_) { /* the timeline note is itself best-effort */ }
      } catch (e) {
        // Defensive umbrella: nothing in the post-commit step may break the
        // already-committed assignment response.
        console.error('[admin/assign] post-commit notifications failed:', e && e.message);
      }

      return res.ok({
        // AUDIT-2026-08-22 — reassign now transitions through
        // REASSIGNED -> ASSIGNED like every other reassignment, so it reports
        // 'assigned' too. It used to echo back the UNCHANGED prior status
        // (typically 'sla_breach'), which was accurate about the bug and
        // therefore told the operator the swap had worked when it had not.
        id,
        status: 'assigned',
        reassigned: isReassign,
        doctor: { id: d.id, name: d.name },
        notifications: nstat,
      });
    } catch (err) {
      if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* no-op */ } }
      if (err && err.http) return res.fail(err.message, err.http, err.code);
      console.error('[admin/assign] failed:', err && err.message);
      return res.fail('Assignment failed', 500, 'ASSIGN_ERROR');
    } finally {
      if (client && client.release) client.release();
    }
  });

  // ─── POST /cases/:id/sla-override (real WRITE — atomic) ──
  // Extend the report-SLA deadline by +N hours. The SLA clock starts at DOCTOR
  // ACCEPTANCE (deadline_at = accepted_at + sla_hours), so override applies ONLY
  // to cases with a live clock (accepted_at + deadline_at both non-null);
  // unaccepted / paused / terminal cases are rejected. Extend-only (N >= 1).
  // Clobber-proof: bumps sla_hours AND deadline_at by the SAME +N together, so
  // case_lifecycle.updateCase's `deadline_at = accepted_at + sla_hours` recompute
  // stays a no-op (no silent revert). The future-guard lives in the UPDATE WHERE
  // (worker-consistent: breach is `deadline_at <= NOW()`), and a future result is
  // what makes clearing breached_at + flipping sla_breach->IN_REVIEW safe. Both
  // audit rows (order_events + admin_audit/error_logs) are written on the txn
  // client — atomic with the deadline change. No notifications (internal ops).
  const SLA_OVERRIDE_MAX_HOURS = 168; // 7-day cap on a single extension; adjustable.
  router.post('/cases/:id/sla-override', async (req, res) => {
    const id = req.params.id;
    const extendHours = req.body && req.body.extendHours;
    const reason = req.body && req.body.reason ? String(req.body.reason).trim().slice(0, 500) : '';

    // Input shape (pre-txn): extend-only integer within the cap, reason required.
    if (!Number.isInteger(extendHours) || extendHours < 1 || extendHours > SLA_OVERRIDE_MAX_HOURS) {
      return res.fail(`extendHours must be an integer between 1 and ${SLA_OVERRIDE_MAX_HOURS}`, 400, 'BAD_REQUEST');
    }
    if (!reason) return res.fail('reason is required', 400, 'BAD_REQUEST');

    // Throw-to-reject: attaches an HTTP status + code carried out of the txn.
    const af = (msg, http, code) => {
      const e = new Error(msg);
      e.http = http;
      e.code = code;
      throw e;
    };

    let client;
    try {
      client = await db.connect();
      await client.query('BEGIN');

      const o = (await client.query(
        `SELECT id, status, accepted_at, deadline_at, sla_hours, sla_paused_at, breached_at
           FROM orders WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [id]
      )).rows[0];
      if (!o) af('Case not found', 404, 'NOT_FOUND');

      const status = normalizeStatus(o.status);
      if (['completed', 'cancelled', 'refunded', 'expired_unpaid'].includes(status)) {
        af(`Case is not overridable (status: ${status})`, 409, 'NOT_OVERRIDABLE');
      }
      // SLA clock starts at doctor acceptance — nothing to override until then.
      if (!o.accepted_at || !o.deadline_at) {
        af('SLA clock has not started (no doctor acceptance yet) — no deadline to override', 409, 'SLA_NOT_STARTED');
      }
      if (o.sla_paused_at) af('SLA is paused — resume it before overriding', 409, 'SLA_PAUSED');

      const prevDeadlineIso = toIso(o.deadline_at);

      // Atomic write. The WHERE guard enforces "resulting deadline in the future"
      // using the same comparison the breach worker uses (deadline_at vs NOW());
      // a 0-row result means the guard failed → DEADLINE_IN_PAST. Bumping both
      // sla_hours and deadline_at by +N keeps the acceptance invariant intact.
      const upd = await client.query(
        `UPDATE orders
            SET sla_hours = COALESCE(sla_hours, 0) + $2::int,
                deadline_at = deadline_at + make_interval(hours => $2::int),
                breached_at = NULL,
                pre_breach_notified = false,
                sla_reminder_sent = false,
                status = CASE WHEN LOWER(COALESCE(status, '')) IN ('sla_breach', 'breached') THEN 'IN_REVIEW' ELSE status END,
                updated_at = NOW()
          WHERE id = $1
            AND deadline_at + make_interval(hours => $2::int) > NOW()
        RETURNING deadline_at, sla_hours`,
        [id, extendHours]
      );
      if (!upd.rows[0]) af('Resulting deadline would still be in the past — extend by more hours', 409, 'DEADLINE_IN_PAST');

      const newDeadlineIso = toIso(upd.rows[0].deadline_at);

      await client.query(
        `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
           VALUES ($1, $2, $3, $4, NOW(), $5, 'superadmin')`,
        [randomUUID(), id, `SLA deadline extended +${extendHours}h by superadmin`,
          JSON.stringify({ from: prevDeadlineIso, to: newDeadlineIso, extendHours, reason }), req.user.id]
      );
      await client.query(
        `INSERT INTO error_logs (id, level, category, message, user_id, context)
           VALUES ($1, 'audit', 'admin_audit', $2, $3, $4)`,
        [randomUUID(), `sla_override case ${id} +${extendHours}h`, req.user.id,
          JSON.stringify({ action: 'sla_override', caseId: id, extendHours, from: prevDeadlineIso, to: newDeadlineIso, reason })]
      );

      await client.query('COMMIT');

      return res.ok({
        id,
        sla: {
          deadlineAt: newDeadlineIso,
          slaHours: Number(upd.rows[0].sla_hours),
          breached: false,
          hasTimer: true,
        },
        extendedHours: extendHours,
        previousDeadlineAt: prevDeadlineIso,
      });
    } catch (err) {
      if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* no-op */ } }
      if (err && err.http) return res.fail(err.message, err.http, err.code);
      console.error('[admin/sla-override] failed:', err && err.message);
      return res.fail('SLA override failed', 500, 'SLA_OVERRIDE_ERROR');
    } finally {
      if (client && client.release) client.release();
    }
  });

  // ─── POST /cases/bulk-auto-assign (production WRITE — atomic, multi-order) ──
  // Auto-assign many unassigned cases at once. Selection = least active caseload
  // within specialty (the established rule); eligibility + per-case write =
  // single-assign's first-assign branch verbatim. ONE outer txn with a SAVEPOINT
  // per case → per-case atomicity + cumulative capacity + partial success.
  // manual_queue/manual_pending/manual_claimed are excluded (skipped
  // flagged_manual_review), never auto-routed. Silent (v1): no notifications.
  // dryRun runs the identical plan then ROLLBACKs (recap source + prove-it-safe).
  // See services/admin_bulk_assign.js. requireJWT + requireRole('superadmin')
  // are inherited from the router-level gate.
  router.post('/cases/bulk-auto-assign', async (req, res) => {
    const body = req.body || {};
    const dryRun = body.dryRun === true || body.dryRun === 'true' || body.dryRun === 1;
    let caseIds = Array.isArray(body.caseIds) ? body.caseIds : null;
    if (!caseIds || caseIds.length === 0) {
      return res.fail('caseIds (non-empty array) is required', 400, 'BAD_REQUEST');
    }
    if (!caseIds.every((x) => typeof x === 'string' && x.trim())) {
      return res.fail('caseIds must be non-empty strings', 400, 'BAD_REQUEST');
    }
    caseIds = [...new Set(caseIds.map((x) => x.trim()))];
    if (caseIds.length > 50) {
      return res.fail('Too many cases (max 50 per batch)', 400, 'TOO_MANY');
    }

    let client;
    try {
      client = await db.connect();
      const result = await bulkAutoAssign(client, { caseIds, actorId: req.user.id, dryRun });
      return res.ok(result);
    } catch (err) {
      // bulkAutoAssign already rolled the whole batch back before re-throwing.
      console.error('[admin/bulk-auto-assign] failed:', err && err.message);
      return res.fail('Bulk auto-assign failed', 500, 'BULK_ASSIGN_ERROR');
    } finally {
      if (client && client.release) client.release();
    }
  });

  // ─── POST /cases/:id/refund (production MONEY-PATH WRITE — atomic) ──
  // Operator-initiated refund: records a PENDING refund row (a payout
  // OBLIGATION) + both audit rows in ONE atomic txn, mirroring the validated
  // web-superadmin create. Money is returned MANUALLY via InstaPay; completion
  // (approve/mark-paid) stays on web. v1 touches the orders row not at all, no
  // earnings clawback, no notification (silent). The order is locked FOR UPDATE
  // so concurrent refund attempts on the same order serialize (no double-refund).
  // requireJWT + requireRole('superadmin') inherited from the router-level gate.
  router.post('/cases/:id/refund', async (req, res) => {
    const id = req.params.id;
    const body = req.body || {};
    const amount = Number(body.amount);
    const instapayHandle = body.instapayHandle != null ? String(body.instapayHandle).trim() : '';
    const notes = body.notes != null ? String(body.notes).slice(0, 1000) : '';

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.fail('amount must be a positive number', 400, 'BAD_REQUEST');
    }
    if (instapayHandle.length < 3 || instapayHandle.length > 100) {
      return res.fail('instapayHandle is required (3–100 chars)', 400, 'BAD_REQUEST');
    }

    let client;
    try {
      client = await db.connect();
      const refund = await issueRefund(client, { orderId: id, amount, instapayHandle, notes, actorId: req.user.id });
      return res.ok({ refund });
    } catch (err) {
      // issueRefund already rolled back before re-throwing; map known rejects.
      if (err && err.http) return res.fail(err.message, err.http, err.code);
      console.error('[admin/refund] failed:', err && err.message);
      return res.fail('Refund failed', 500, 'REFUND_ERROR');
    } finally {
      if (client && client.release) client.release();
    }
  });

  // ─── POST /doctors/:id/pause + /reactivate (operator pause, atomic WRITES) ──
  // The FIRST mutating writes in the Command app. is_paused removes the doctor
  // from assignment eligibility (assign/candidates/bulk-auto-assign all gate on
  // it) — a pure flag flip + audit, no case or availability cascade. Asymmetric:
  // pause requires a reason, reactivate clears it. requireJWT +
  // requireRole('superadmin') inherited from the router-level gate.
  router.post('/doctors/:id/pause', async (req, res) => {
    const reason = req.body && req.body.reason != null ? String(req.body.reason).trim() : '';
    if (!reason) return res.fail('Pause reason required', 400, 'REASON_REQUIRED');
    let client;
    try {
      client = await db.connect();
      const doctor = await setDoctorPause(client, { doctorId: req.params.id, paused: true, reason, actorId: req.user.id });
      return res.ok({ doctor });
    } catch (err) {
      // setDoctorPause already rolled back before re-throwing; map known rejects.
      if (err && err.http) return res.fail(err.message, err.http, err.code);
      console.error('[admin/doctor-pause] failed:', err && err.message);
      return res.fail('Pause update failed', 500, 'PAUSE_ERROR');
    } finally {
      if (client && client.release) client.release();
    }
  });

  router.post('/doctors/:id/reactivate', async (req, res) => {
    let client;
    try {
      client = await db.connect();
      const doctor = await setDoctorPause(client, { doctorId: req.params.id, paused: false, reason: null, actorId: req.user.id });
      return res.ok({ doctor });
    } catch (err) {
      if (err && err.http) return res.fail(err.message, err.http, err.code);
      console.error('[admin/doctor-reactivate] failed:', err && err.message);
      return res.fail('Pause update failed', 500, 'PAUSE_ERROR');
    } finally {
      if (client && client.release) client.release();
    }
  });

  // ─── POST /doctors/:id/approve (pending → active, SILENT + atomic WRITE) ──
  // Slice 2a: flips pending_approval=false, is_active=true, stamps approved_at +
  // approved_by, clears rejection_reason. SILENT by design — NO welcome token,
  // NO email/WhatsApp/notification (the web approve does those; deferred to slice
  // 2b, like assign→assign-notifications). requireJWT + requireRole('superadmin')
  // inherited from the router-level gate.
  router.post('/doctors/:id/approve', async (req, res) => {
    let client;
    try {
      client = await db.connect();
      const doctor = await setDoctorApproval(client, { doctorId: req.params.id, actorId: req.user.id });
      return res.ok({ doctor });
    } catch (err) {
      // setDoctorApproval already rolled back before re-throwing; map known rejects.
      if (err && err.http) return res.fail(err.message, err.http, err.code);
      console.error('[admin/doctor-approve] failed:', err && err.message);
      return res.fail('Approve failed', 500, 'APPROVE_ERROR');
    } finally {
      if (client && client.release) client.release();
    }
  });

  // ─── POST /doctors/:id/reject (pending → rejected, atomic WRITE) ──────────
  // Slice 3: flips pending_approval=false, is_active=false, clears approved_at,
  // stamps rejection_reason; audits (with the reason in context — no
  // rejected_by/at column exists). THEN fires an INTERNAL-ONLY in-app notice
  // ('doctor_rejected' has no email/WhatsApp template) post-commit/off-txn, so a
  // notify failure can't roll back the rejection. rejection_reason is OPTIONAL —
  // defaults to 'Not approved' (matches the web reject). NOT_PENDING guards a
  // non-pending doctor (the web omits this; we add it for symmetry with approve).
  // requireJWT + requireRole('superadmin') inherited from the router-level gate.
  router.post('/doctors/:id/reject', async (req, res) => {
    const doctorId = req.params.id;
    const body = req.body || {};
    const reason = (typeof body.rejection_reason === 'string' && body.rejection_reason.trim())
      ? body.rejection_reason.trim()
      : 'Not approved';

    let client;
    try {
      client = await db.connect();
      const doctor = await setDoctorRejection(client, { doctorId, reason, actorId: req.user.id });

      // Post-commit, best-effort, OFF the txn: the internal-only in-app notice.
      // safeQueue maps the result to queued/failed; the outer umbrella guarantees
      // nothing thrown post-commit can break the already-committed rejection. A
      // fixed dedupe_key per doctor is fine — reject is not a resend.
      let notification = 'queued';
      try {
        const safeQueue = async (opts) => {
          try {
            const r = await queueMultiChannelNotification(opts);
            return (r && r.ok === false) ? 'failed' : 'queued';
          } catch (e) {
            console.error('[admin/doctor-reject] notify failed:', opts && opts.template, e && e.message);
            return 'failed';
          }
        };
        notification = await safeQueue({
          orderId: null,
          toUserId: doctorId,
          channels: ['internal'],
          template: 'doctor_rejected',
          dedupe_key: 'doctor_rejected:' + doctorId,
        });
      } catch (e) {
        console.error('[admin/doctor-reject] post-commit notification failed:', e && e.message);
        notification = 'failed';
      }

      return res.ok({ doctor, notification });
    } catch (err) {
      // setDoctorRejection already rolled back before re-throwing; map known rejects.
      if (err && err.http) return res.fail(err.message, err.http, err.code);
      console.error('[admin/doctor-reject] failed:', err && err.message);
      return res.fail('Reject failed', 500, 'REJECT_ERROR');
    } finally {
      if (client && client.release) client.release();
    }
  });

  // ─── POST /doctors/:id/invite (welcome magic-login link — slice 2b WRITE) ──
  // STANDALONE "send welcome invite" for any ACTIVE doctor. inviteDoctor
  // atomically issues a 7-day magic-login token, stamps welcome_email_last_sent_at,
  // and audits (one txn); THEN this fires the doctor_approved welcome
  // notification OFF the committed txn. Optional body { channels: ('email'|
  // 'whatsapp')[] } selects the CONTACT channels; the in-app 'internal' record
  // is always sent. Omitted → BOTH (backward-compatible). Serves as BOTH
  // first-invite AND resend — the app warns before a resend, the backend always
  // (re)sends. Deliberately decoupled from /approve, which stays SILENT (slice
  // 2a). requireJWT + requireRole('superadmin') inherited from the router gate.
  router.post('/doctors/:id/invite', inviteIpLimiter, async (req, res) => {
    const doctorId = req.params.id;

    // Channel selection (optional). 'internal' (the in-app bell / notification
    // record) is ALWAYS sent — it's the system record, not a "contact the
    // doctor" channel; the operator only toggles email / whatsapp. Validate
    // BEFORE db.connect so an invalid request writes nothing (no token / stamp /
    // audit). Omitted → BOTH (preserves the prior always-both behavior).
    const CONTACT_CHANNELS = ['email', 'whatsapp'];
    let selectedContact = CONTACT_CHANNELS;
    if (req.body && req.body.channels !== undefined) {
      const sel = req.body.channels;
      const valid = Array.isArray(sel) && sel.length > 0 && sel.every((c) => CONTACT_CHANNELS.includes(c));
      if (!valid) {
        return res.fail("channels must be a non-empty subset of ['email','whatsapp']", 400, 'INVALID_CHANNELS');
      }
      selectedContact = sel;
    }
    // internal always first, then the selected contact channels in a stable
    // order (the filter also dedups, e.g. against ['email','email']).
    const channels = ['internal', ...CONTACT_CHANNELS.filter((c) => selectedContact.includes(c))];

    // baseUrl (pure, no DB) — env first, request headers fallback; mirrors
    // superadmin.js _issueDoctorWelcomePayload. A null baseUrl yields a null
    // magicLinkUrl (the email gates its CTA on it) — never throws.
    let baseUrl = String(process.env.BASE_URL || process.env.APP_URL || '').trim().replace(/\/+$/, '');
    if (!baseUrl) {
      try {
        const protoRaw = (req.get('x-forwarded-proto') || req.protocol || 'http');
        const proto = String(protoRaw).split(',')[0].trim() || 'http';
        const host = req.get('x-forwarded-host') || req.get('host');
        baseUrl = host ? `${proto}://${host}` : '';
      } catch (_) { baseUrl = ''; }
    }

    let client;
    try {
      client = await db.connect();
      const { welcomePayload, lastInvitedAt } = await issueDoctorWelcome(client, {
        doctorId, baseUrl: baseUrl || null, actorId: req.user.id,
      });

      // Post-commit, best-effort, OFF the txn: fire the welcome notification.
      // UNIQUE/timestamped dedupe_key per call — /invite is ALWAYS a potential
      // resend and the worker dedupes PERMANENTLY on dedupe_key, so a fixed key
      // would let the first send through and silently DROP every resend (same
      // posture as the web resend, superadmin.js:3285). safeQueue maps the
      // result to queued/failed; the outer umbrella guarantees nothing thrown
      // post-commit can break the already-committed invite response.
      let notification = 'queued';
      try {
        const safeQueue = async (opts) => {
          try {
            const r = await queueMultiChannelNotification(opts);
            return (r && r.ok === false) ? 'failed' : 'queued';
          } catch (e) {
            console.error('[admin/doctor-invite] notify failed:', opts && opts.template, e && e.message);
            return 'failed';
          }
        };
        notification = await safeQueue({
          orderId: null,
          toUserId: doctorId,
          channels,
          template: 'doctor_approved',
          response: welcomePayload,
          dedupe_key: 'doctor_invite:' + doctorId + ':' + Date.now(),
        });
      } catch (e) {
        console.error('[admin/doctor-invite] post-commit notification failed:', e && e.message);
        notification = 'failed';
      }

      return res.ok({ invited: true, notification, lastInvitedAt });
    } catch (err) {
      // inviteDoctor already rolled back before re-throwing; map known rejects.
      if (err && err.http) return res.fail(err.message, err.http, err.code);
      console.error('[admin/doctor-invite] failed:', err && err.message);
      return res.fail('Invite failed', 500, 'INVITE_ERROR');
    } finally {
      if (client && client.release) client.release();
    }
  });

  // ─── POST /refunds/:id/approve (refund lifecycle — slice 4, money-path WRITE) ──
  // Approve a pending refund (supports PARTIAL: operator-supplied approved_amount,
  // validated in-txn >0 and <= requested). setRefundApproval owns the txn:
  // SELECT…FOR UPDATE → af guards → UPDATE (status='approved', approved_amount AND
  // amount_egp = approved [coherence for the money KPIs]) → in-txn order_events +
  // error_logs audit → COMMIT. THEN fires the internal+email patient notice
  // OFF-txn/best-effort. The recipient is the ORDER's patient_id (NOT
  // refunds.requested_by, which is the operator for operator refunds).
  // requireJWT + requireRole('superadmin') inherited from the router-level gate.
  router.post('/refunds/:id/approve', async (req, res) => {
    const refundId = req.params.id;
    const body = req.body || {};
    const approvedAmount = Number(body.approved_amount);
    // Shallow validation only — present + a finite number. Deep checks (>0,
    // <= requested) run in-txn against the locked row.
    if (!Number.isFinite(approvedAmount)) {
      return res.fail('Approved amount required', 400, 'AMOUNT_REQUIRED');
    }
    const notes = body.notes != null ? String(body.notes).slice(0, 1000) : '';

    let client;
    try {
      client = await db.connect();
      const refund = await setRefundApproval(client, { refundId, approvedAmount, notes, actorId: req.user.id });

      // Post-commit, off-txn, best-effort: notify the PATIENT (resolved via the
      // order's patient_id). safeQueue maps to queued/failed; the outer umbrella
      // guarantees nothing post-commit can unwind the committed approval.
      let notification = 'queued';
      try {
        const safeQueue = async (opts) => {
          try {
            const r = await queueMultiChannelNotification(opts);
            return (r && r.ok === false) ? 'failed' : 'queued';
          } catch (e) {
            console.error('[admin/refund-approve] notify failed:', opts && opts.template, e && e.message);
            return 'failed';
          }
        };
        // include-deleted-ok: addressing the patient's refund notification.
        // Refunds only exist for paid orders, which are never soft-deleted;
        // and if one somehow were, you would still want to tell the patient
        // about their money.
        const ord = await safeGet('SELECT patient_id FROM orders WHERE id = $1', [refund.orderId]);
        const patientUserId = ord && ord.patient_id ? ord.patient_id : null;
        notification = await safeQueue({
          orderId: refund.orderId,
          toUserId: patientUserId,
          channels: ['internal', 'email'],
          template: 'patient_refund_approved',
          response: {
            case_id: refund.orderId,
            caseReference: String(refund.orderId || '').slice(0, 12).toUpperCase(),
            approvedAmount: Number(refund.approvedAmount).toFixed(2),
          },
          dedupe_key: 'refund_approved:' + refundId,
        });
      } catch (e) {
        console.error('[admin/refund-approve] post-commit notification failed:', e && e.message);
        notification = 'failed';
      }

      return res.ok({ refund, notification });
    } catch (err) {
      // setRefundApproval already rolled back before re-throwing; map known rejects.
      if (err && err.http) return res.fail(err.message, err.http, err.code);
      console.error('[admin/refund-approve] failed:', err && err.message);
      return res.fail('Approve failed', 500, 'REFUND_APPROVE_ERROR');
    } finally {
      if (client && client.release) client.release();
    }
  });

  // ─── POST /refunds/:id/deny (refund lifecycle — slice 5, status flip) ──────────
  // Deny a pending refund with a REQUIRED reason. setRefundDenial owns the txn:
  // SELECT…FOR UPDATE → af guards → UPDATE (status='denied', denial_reason, reviewer
  // stamp; NO amount changes — denied is excluded from the money KPIs) → in-txn
  // order_events + error_logs audit → COMMIT. THEN fires the internal+email patient
  // notice OFF-txn/best-effort (recipient = the ORDER's patient_id, not
  // refunds.requested_by). requireJWT + requireRole('superadmin') inherited gate.
  router.post('/refunds/:id/deny', async (req, res) => {
    const refundId = req.params.id;
    const body = req.body || {};
    const denialReason = String((body.denial_reason != null ? body.denial_reason : '')).trim();
    // Shallow validation — required, 1–1000 chars (mirrors the web's bound).
    if (denialReason.length < 1 || denialReason.length > 1000) {
      return res.fail('Denial reason required', 400, 'DENIAL_REASON_REQUIRED');
    }

    let client;
    try {
      client = await db.connect();
      const refund = await setRefundDenial(client, { refundId, denialReason, actorId: req.user.id });

      // Post-commit, off-txn, best-effort: notify the PATIENT (resolved via the
      // order's patient_id). safeQueue maps to queued/failed; the outer umbrella
      // guarantees nothing post-commit can unwind the committed denial.
      let notification = 'queued';
      try {
        const safeQueue = async (opts) => {
          try {
            const r = await queueMultiChannelNotification(opts);
            return (r && r.ok === false) ? 'failed' : 'queued';
          } catch (e) {
            console.error('[admin/refund-deny] notify failed:', opts && opts.template, e && e.message);
            return 'failed';
          }
        };
        // include-deleted-ok: addressing the patient's refund notification.
        // Refunds only exist for paid orders, which are never soft-deleted;
        // and if one somehow were, you would still want to tell the patient
        // about their money.
        const ord = await safeGet('SELECT patient_id FROM orders WHERE id = $1', [refund.orderId]);
        const patientUserId = ord && ord.patient_id ? ord.patient_id : null;
        notification = await safeQueue({
          orderId: refund.orderId,
          toUserId: patientUserId,
          channels: ['internal', 'email'],
          template: 'patient_refund_denied',
          response: {
            case_id: refund.orderId,
            caseReference: String(refund.orderId || '').slice(0, 12).toUpperCase(),
            denialReason: refund.denialReason,
          },
          dedupe_key: 'refund_denied:' + refundId,
        });
      } catch (e) {
        console.error('[admin/refund-deny] post-commit notification failed:', e && e.message);
        notification = 'failed';
      }

      return res.ok({ refund, notification });
    } catch (err) {
      // setRefundDenial already rolled back before re-throwing; map known rejects.
      if (err && err.http) return res.fail(err.message, err.http, err.code);
      console.error('[admin/refund-deny] failed:', err && err.message);
      return res.fail('Deny failed', 500, 'REFUND_DENY_ERROR');
    } finally {
      if (client && client.release) client.release();
    }
  });

  // ─── POST /refunds/:id/mark-paid (refund lifecycle — slice 6, RECORDS-ONLY) ────
  // Records that an InstaPay transfer happened out-of-band — NO payout API call.
  // setRefundPaid owns the txn: SELECT…FOR UPDATE → af guards → UPDATE
  // (status='paid', instapay_reference, paid_at, amount_egp = finalAmount,
  // approved_amount backfilled) → in-txn order_events + audit → COMMIT. THEN,
  // post-commit/off-txn, each in its own try/catch: (1) the doctor-earnings
  // clawback (recomputeOnRefund — replicating the web; DB-only, idempotency-
  // guarded) and (2) the internal+email patient notice. Neither can unwind the
  // committed paid status. requireJWT + requireRole('superadmin') inherited gate.
  router.post('/refunds/:id/mark-paid', async (req, res) => {
    const refundId = req.params.id;
    const body = req.body || {};
    const instapayReference = String((body.instapay_reference != null ? body.instapay_reference : '')).trim();
    // Shallow validation — required, 1–100 chars (mirrors the web's bound).
    if (instapayReference.length < 1 || instapayReference.length > 100) {
      return res.fail('InstaPay reference required', 400, 'INSTAPAY_REFERENCE_REQUIRED');
    }

    let client;
    try {
      client = await db.connect();
      const refund = await setRefundPaid(client, { refundId, instapayReference, actorId: req.user.id });

      // (1) Doctor-earnings clawback — post-commit, off-txn, best-effort. Mirrors
      //     the web: recomputeOnRefund(orderId, { reason }). DB-only + idempotent,
      //     so a failure must NOT unwind the committed paid status.
      //     AUDIT (2026-08-17): recomputeOnRefund now scales the clawback
      //     LINEARLY by the refund ratio, but only when it is given
      //     refundAmountEgp; without it the helper degrades to the old
      //     all-or-nothing 90% clawback (deliberately — it fails towards the
      //     platform). Passing the amount is what makes a PARTIAL refund claw
      //     back a proportional share instead of gutting the doctor's whole fee.
      //     setRefundPaid already returns the settled figures (approvedAmount is
      //     backfilled with finalAmount inside its txn), so no extra read.
      let clawback = 'skipped';
      try {
        if (refund.reason) {
          const r = await recomputeOnRefund(refund.orderId, {
            reason: refund.reason,
            refundAmountEgp:
              Number(refund.approvedAmount ?? refund.requestedAmount ?? refund.amountEgp) || null
          });
          clawback = r && r.skipped ? 'skipped' : 'applied';
        }
      } catch (e) {
        console.error('[admin/refund-mark-paid] clawback failed:', e && e.message);
        clawback = 'failed';
      }

      // (2) Patient notify — post-commit, off-txn, best-effort (own try/catch).
      let notification = 'queued';
      try {
        const safeQueue = async (opts) => {
          try {
            const q = await queueMultiChannelNotification(opts);
            return (q && q.ok === false) ? 'failed' : 'queued';
          } catch (e) {
            console.error('[admin/refund-mark-paid] notify failed:', opts && opts.template, e && e.message);
            return 'failed';
          }
        };
        // include-deleted-ok: addressing the patient's refund notification.
        // Refunds only exist for paid orders, which are never soft-deleted;
        // and if one somehow were, you would still want to tell the patient
        // about their money.
        const ord = await safeGet('SELECT patient_id FROM orders WHERE id = $1', [refund.orderId]);
        const patientUserId = ord && ord.patient_id ? ord.patient_id : null;
        notification = await safeQueue({
          orderId: refund.orderId,
          toUserId: patientUserId,
          channels: ['internal', 'email'],
          template: 'patient_refund_paid',
          response: {
            case_id: refund.orderId,
            caseReference: String(refund.orderId || '').slice(0, 12).toUpperCase(),
            amount: Number(refund.finalAmount).toFixed(2),
            instapayReference: refund.instapayReference,
          },
          dedupe_key: 'refund_paid:' + refundId,
        });
      } catch (e) {
        console.error('[admin/refund-mark-paid] post-commit notification failed:', e && e.message);
        notification = 'failed';
      }

      return res.ok({ refund, notification, clawback });
    } catch (err) {
      // setRefundPaid already rolled back before re-throwing; map known rejects.
      if (err && err.http) return res.fail(err.message, err.http, err.code);
      console.error('[admin/refund-mark-paid] failed:', err && err.message);
      return res.fail('Mark-paid failed', 500, 'REFUND_MARK_PAID_ERROR');
    } finally {
      if (client && client.release) client.release();
    }
  });

  // ─── GET /payment-events?type=amount_mismatch (amount-mismatch triage) ──────
  // Read-only queue behind the Payments-tab "Mismatches" section. A mismatch =
  // Paymob reported a paid amount != owed; the webhook (b1a20b7) parks the order
  // UNPAID and writes an amount_mismatch payment_events row. owed/paid/currency/
  // txn live inside payload_json — the paymob_transaction_id COLUMN is left NULL
  // for these rows by design (see payments.js), so we read the txn from the
  // payload and never join on the column. reviewed{} comes from the
  // payment_event_reviews overlay (migration 075). requireJWT +
  // requireRole('superadmin') inherited from the router-level gate.
  router.get('/payment-events', async (req, res) => {
    const type = String((req.query && req.query.type) || 'amount_mismatch').toLowerCase();
    // Only the mismatch triage type is exposed here — other event types can
    // carry raw gateway payloads we don't want to surface through this queue.
    if (type !== 'amount_mismatch') {
      return res.fail("type must be 'amount_mismatch'", 400, 'BAD_REQUEST');
    }
    try {
      const rows = await safeAll(
        `SELECT pe.id, pe.order_id, pe.received_at, pe.payload_json,
                o.reference_id, o.payment_status, (o.deleted_at IS NOT NULL) AS order_deleted,
                u.name AS patient_name, u.phone AS patient_phone, u.email AS patient_email,
                rev.reviewed_by, rev.reviewed_at AS review_reviewed_at, rev.note AS review_note
           FROM payment_events pe
           -- include-deleted-ok: mismatches on soft-deleted orders MUST stay
           -- visible for accounting, so this LEFT JOINs orders, not orders_active.
           LEFT JOIN orders o ON o.id = pe.order_id
           LEFT JOIN users u ON u.id = o.patient_id
           LEFT JOIN payment_event_reviews rev ON rev.payment_event_id = pe.id
          WHERE pe.event_type = $1
          ORDER BY pe.received_at DESC`,
        [type]
      );

      const asInt = (v) => (v == null ? null : Number(v));
      const parsePayload = (p) => {
        if (p && typeof p === 'object') return p;
        try { return JSON.parse(p || '{}'); } catch (_) { return {}; }
      };

      const events = (rows || []).map((r) => {
        const p = parsePayload(r.payload_json);
        const hasPatient = !!(r.patient_name || r.patient_phone || r.patient_email);
        const isReviewed = !!(r.reviewed_by || r.review_reviewed_at || r.review_note);
        return {
          id: r.id,
          orderId: r.order_id || null,
          orderReference: r.reference_id || null,
          orderPaymentStatus: r.payment_status || null,
          orderDeleted: !!r.order_deleted,
          receivedAt: toIso(r.received_at),
          owedCents: asInt(p.owed_cents),
          paidCents: asInt(p.paid_cents),
          currency: p.currency || null,
          paymobTransactionId: p.paymob_transaction_id || null,
          patient: hasPatient
            ? { name: r.patient_name || null, phone: r.patient_phone || null, email: r.patient_email || null }
            : null,
          reviewed: isReviewed
            ? { by: r.reviewed_by || null, at: toIso(r.review_reviewed_at), note: r.review_note || null }
            : null,
        };
      });

      const unreviewed = events.filter((e) => !e.reviewed).length;
      return res.ok({ events, counts: { total: events.length, unreviewed } });
    } catch (err) {
      console.error('[admin/payment-events] failed:', err && err.message);
      return res.fail('Failed to load payment events', 500, 'PAYMENT_EVENTS_ERROR');
    }
  });

  // ─── POST /payment-events/:id/review (mark an amount_mismatch reviewed) ─────
  // Marks a payment_event reviewed with an optional note. UPSERT on the overlay
  // (re-review updates note + reviewed_at in place). No status machine and no
  // resolution workflow — resolution actions happen via deep-link to the case.
  // reviewPaymentEvent owns the txn (BEGIN → 404 guard → UPSERT → in-txn
  // order_events + error_logs audit → COMMIT). requireJWT +
  // requireRole('superadmin') inherited from the router-level gate.
  router.post('/payment-events/:id/review', async (req, res) => {
    const paymentEventId = req.params.id;
    const body = req.body || {};
    const note = body.note != null ? String(body.note) : null;

    let client;
    try {
      client = await db.connect();
      const review = await reviewPaymentEvent(client, { paymentEventId, note, actorId: req.user.id });
      return res.ok({ review });
    } catch (err) {
      // reviewPaymentEvent already rolled back before re-throwing; map known rejects.
      if (err && err.http) return res.fail(err.message, err.http, err.code);
      console.error('[admin/payment-event-review] failed:', err && err.message);
      return res.fail('Review failed', 500, 'REVIEW_ERROR');
    } finally {
      if (client && client.release) client.release();
    }
  });

  // ─── POST /push-token (register THIS superadmin's Expo push token) ───────────
  // The Command app calls this after obtaining an Expo push token so that
  // watchdog-triggered worker-down pushes (middleware/push.notifySuperadmins)
  // can reach the device. Reuses users.push_token — the SAME column the patient
  // path writes — for the authenticated superadmin's own row (req.user.id).
  // Validation mirrors the patient route in routes/api/profile.js (trim +
  // notEmpty + Expo format), but this is superadmin-gated and does NOT touch
  // that patient route. requireJWT + requireRole('superadmin') inherited gate.
  router.post('/push-token', async (req, res) => {
    // AUDIT-P1-5 — an explicit null clears the registration.
    //
    // The Command app had no way to unregister, and logout() cleared only the
    // local tokens. users.push_token therefore kept pointing at a signed-out
    // device, and middleware/push.notifySuperadmins (fired by
    // services/worker_watchdog) kept pushing production worker-down alerts to
    // whoever now held that phone.
    if (req.body && req.body.token === null) {
      try {
        await safeRun('UPDATE users SET push_token = NULL WHERE id = $1', [req.user.id]);
        return res.ok({ message: 'Push token cleared' });
      } catch (err) {
        console.error('[admin/push-token] clear failed:', err && err.message);
        return res.fail('Failed to clear push token', 500, 'PUSH_TOKEN_ERROR');
      }
    }

    const token = req.body && typeof req.body.token === 'string' ? req.body.token.trim() : '';
    if (!token) {
      return res.fail('Push token required', 400, 'INVALID_PUSH_TOKEN');
    }
    // Validate Expo push token format (same check as the patient route + core send).
    if (!token.startsWith('ExponentPushToken[') && !token.startsWith('ExpoPushToken[')) {
      return res.fail('Invalid push token format', 400, 'INVALID_PUSH_TOKEN');
    }
    try {
      await safeRun('UPDATE users SET push_token = $1 WHERE id = $2', [token, req.user.id]);
      return res.ok({ message: 'Push token registered' });
    } catch (err) {
      console.error('[admin/push-token] failed:', err && err.message);
      return res.fail('Failed to register push token', 500, 'PUSH_TOKEN_ERROR');
    }
  });

  // ─── GET /files/:fileId (Bearer-authenticated case-file download) ──────────
  //
  // AUDIT-P1-5 — the Command app's lib/files.ts fetched
  // `${ROOT_BASE}/files/:id` with an Authorization: Bearer header, but that
  // root route (server.js) reads req.user from the SESSION COOKIE only — it
  // never looks at the Authorization header. With no cookie, req.user was null
  // and the route 302'd to /login?next=... . React Native's fetch follows
  // redirects, so res.ok came back true and Linking.openURL() opened the
  // portal's LOGIN PAGE instead of the patient's scan, with no error raised
  // anywhere. The comments at lib/files.ts and in the case-detail handler both
  // asserted the route was "superadmin-gated"; it is not, it is cookie-gated.
  //
  // This is the Bearer-authenticated equivalent, inheriting the router-level
  // requireJWT + requireRole('superadmin') gate. Superadmins can already read
  // every case file through the portal, so this adds no new authority — it
  // only makes that authority reachable with a token instead of a cookie.
  router.get('/files/:fileId', async (req, res) => {
    const fileId = String(req.params.fileId || '').trim();
    if (!fileId) return res.fail('Missing file id', 400, 'INVALID_FILE_ID');

    let key = '';
    let url = '';
    let label = '';

    // Same three-table lookup order as server.js /files/:fileId.
    const ofRow = await safeGet('SELECT id, url, label FROM order_files WHERE id = $1 LIMIT 1', [fileId], null);
    if (ofRow) {
      url = String(ofRow.url || '').trim();
      label = ofRow.label || '';
    } else {
      const adfRow = await safeGet(
        'SELECT id, file_url, file_key, label FROM order_additional_files WHERE id = $1 LIMIT 1',
        [fileId], null
      );
      if (adfRow) {
        url = String(adfRow.file_url || '').trim();
        key = String(adfRow.file_key || '').trim();
        label = adfRow.label || '';
      } else {
        const msgRow = await safeGet(
          'SELECT id, file_url, file_key, file_name FROM messages WHERE id = $1 AND (file_url IS NOT NULL OR file_key IS NOT NULL) LIMIT 1',
          [fileId], null
        );
        if (msgRow) {
          url = String(msgRow.file_url || '').trim();
          key = String(msgRow.file_key || '').trim();
          label = msgRow.file_name || '';
        }
      }
    }

    // Legacy rows store a full HTTP URL; newer rows store an R2 key.
    if (!key && /^https?:\/\//i.test(url)) {
      return res.ok({ url, name: label || null });
    }
    const objectKey = key || url;
    if (!objectKey) return res.fail('File not found', 404, 'FILE_NOT_FOUND');

    try {
      const { getSignedDownloadUrl } = require('../../storage');
      const signed = await getSignedDownloadUrl(objectKey, 3600, { downloadName: label || undefined });
      // Returns the URL in the standard envelope rather than 302-ing, so the
      // app can hand a real, resolvable URL to Linking.openURL and surface a
      // proper error when there isn't one.
      return res.ok({ url: signed, name: label || null });
    } catch (err) {
      console.error('[admin/files] signing failed:', err && err.message);
      return res.fail('Could not prepare download', 500, 'FILE_SIGN_ERROR');
    }
  });

  // ─── GET /breach-cost?period=mtd|30d|90d (what SLA breaches COST) ──────────
  //
  // AUDIT — WHY THIS SURFACE EXISTS.
  //
  // An SLA breach is not a status badge, it is money leaving the business, and
  // NOTHING on any surface totals it today. /pulse counts breached cases,
  // /cases can filter to them, /refunds lists refund rows one at a time — but
  // no screen, mobile or desktop, answers "what did breaching cost us this
  // month, and which specialty / which doctor is generating it". That is a
  // direct, controllable P&L line and it is currently invisible, which means it
  // has never been managed.
  //
  // WHAT A BREACH COSTS, PRECISELY (services/sla_breach.js + PAYOUT policy §4):
  //   - the patient is auto-refunded the URGENCY UPLIFT only, never the whole
  //     case — refunds row, reason='sla_breach', status='auto_approved'
  //     (system-approved, awaiting the manual InstaPay payout);
  //   - orders.urgency_uplift_amount is zeroed and the doctor's earnings are
  //     recomputed as if the case were Standard tier (earnings_writer
  //     .recomputeOnBreach), then fully clawed back at refund mark-paid
  //     (recomputeOnRefund, policy 'sla_breach_full_clawback').
  // So the platform's cash cost is the uplift; the doctor's cost is the payout
  // clawback. Both are reported here, separately, because they are different
  // people's money.
  //
  // MONEY DEFINITIONS — deliberately the SAME as the existing surfaces:
  //   refunded  = SUM(refunds.amount_egp) over COMMITTED refunds only
  //               (paid/approved/auto_approved) — identical to the /refunds
  //               refundedMTD KPI, so the two can never disagree. Pending is an
  //               obligation that may still be denied; denied never becomes money.
  //   collected = SUM(COALESCE(total_price_with_addons, price)) over
  //               orders_active with payment_status paid/captured — verbatim
  //               the GET /revenue + /refunds collected formula.
  // Every SUM is wrapped in COALESCE(...,0) so an empty period returns 0, not
  // NULL, and every figure is rounded to piastres on the way out (money()).
  //
  // BUCKETING: the Cairo business day, same as /revenue. refunds.refunded_at
  // and doctor_earnings.clawback_applied_at are still naive-UTC columns
  // (migration 081 converted only orders + doctor_assignments), so they take
  // the two-step UTC→Cairo conversion — see REFUNDED_AT_CAIRO_R at the top.
  //
  // READ-ONLY. requireJWT + requireRole('superadmin') inherited from the router.
  router.get('/breach-cost', async (req, res) => {
    const period = String((req.query && req.query.period) || 'mtd').toLowerCase();
    const from = BREACH_COST_PERIODS[period];
    if (!from) return res.fail("period must be 'mtd', '30d' or '90d'", 400, 'BAD_REQUEST');

    // Shared predicates. `r.status` is the REFUNDS workflow column — single
    // writer set, no casing hazard (unlike orders.status). The breach filter
    // folds reason anyway because it is free TEXT with no CHECK (migration 028).
    const inPeriod = `r.status IN ${COMMITTED_REFUND_STATUSES} AND ${REFUNDED_AT_CAIRO_R} >= ${from}`;
    const isBreach = `LOWER(COALESCE(r.reason,'')) = 'sla_breach'`;

    try {
      const [reasonRows, specialtyRows, doctorRows, tierRows, collectedRow, clawbackRows] =
        await Promise.all([
          // (1) Every committed refund in the window, split by reason. Drives
          //     BOTH the by-reason breakdown and the refund-rate numerator, so
          //     the two are arithmetically consistent by construction.
          safeAll(
            `SELECT LOWER(COALESCE(r.reason,'')) AS reason,
                    COUNT(*)::int AS n,
                    COALESCE(SUM(r.amount_egp), 0) AS egp
               FROM refunds r
              WHERE ${inPeriod}
              GROUP BY 1`
          ),
          // (2) Breaches by specialty. Joins `orders` (not orders_active) with
          //     the same include-deleted-ok reasoning as GET /refunds: every
          //     refund-insert path gates on a paid order, and soft-delete only
          //     ever touches unpaid expired drafts — so this join cannot
          //     produce a deleted row, and if it somehow did you would still
          //     want the cost counted.
          safeAll(
            `SELECT o.specialty_id AS id, COALESCE(sp.name, '—') AS name,
                    COUNT(*)::int AS n,
                    COALESCE(SUM(r.amount_egp), 0) AS egp
               FROM refunds r
               -- include-deleted-ok: driven by refunds. The money moved
               -- whether or not the order was later soft-deleted; excluding
               -- those rows would understate what breaches cost.
               JOIN orders o ON o.id = r.order_id
               LEFT JOIN specialties sp ON sp.id = o.specialty_id
              WHERE ${isBreach} AND ${inPeriod}
              GROUP BY o.specialty_id, sp.name
              ORDER BY egp DESC, n DESC`
          ),
          // (3) Breaches by doctor. LEFT JOIN + a null bucket: a case can breach
          //     with no doctor on it (the acceptance handshake never completed),
          //     and dropping those rows would under-report the total.
          safeAll(
            `SELECT o.doctor_id AS id, d.name AS name,
                    COUNT(*)::int AS n,
                    COALESCE(SUM(r.amount_egp), 0) AS egp
               FROM refunds r
               -- include-deleted-ok: driven by refunds. The money moved
               -- whether or not the order was later soft-deleted; excluding
               -- those rows would understate what breaches cost.
               JOIN orders o ON o.id = r.order_id
               LEFT JOIN users d ON d.id = o.doctor_id
              WHERE ${isBreach} AND ${inPeriod}
              GROUP BY o.doctor_id, d.name
              ORDER BY egp DESC, n DESC`
          ),
          // (4) Breaches by urgency tier. Raw tiers are folded here and
          //     normalized again in JS (normalizeTier maps the legacy
          //     'fast_track' onto 'vip'), so two raw rows can collapse into one
          //     output bucket — hence the merge below rather than a direct map.
          safeAll(
            `SELECT LOWER(COALESCE(o.urgency_tier,'standard')) AS tier,
                    COUNT(*)::int AS n,
                    COALESCE(SUM(r.amount_egp), 0) AS egp
               FROM refunds r
               -- include-deleted-ok: driven by refunds. The money moved
               -- whether or not the order was later soft-deleted; excluding
               -- those rows would understate what breaches cost.
               JOIN orders o ON o.id = r.order_id
              WHERE ${isBreach} AND ${inPeriod}
              GROUP BY 1`
          ),
          // (5) Refund-rate denominator + the window's Cairo lower bound, echoed
          //     back so the app can label the period without recomputing it.
          safeGet(
            `SELECT COALESCE(SUM(COALESCE(o.total_price_with_addons, o.price)), 0) AS collected,
                    to_char(${from}, 'YYYY-MM-DD"T"HH24:MI:SS') AS period_start_cairo
               FROM orders_active o
              WHERE LOWER(COALESCE(o.payment_status,'')) IN ('paid','captured')
                AND ${COLLECTED_AT_CAIRO_O} >= ${from}`
          ),
          // (6) Doctor-earnings clawback in the window.
          //
          //     doctor_earnings has NO order_id: main-case rows overload
          //     appointment_id with the order id and are identified by the
          //     'earn-main-' id prefix (services/earnings_writer.js header), so
          //     that is the join and the filter. clawback_reason /
          //     clawback_applied_at are migration 054.
          //
          //     The clawed-back AMOUNT is not stored — recomputeOnRefund
          //     OVERWRITES earned_amount in place — so it is derived from the
          //     policy that fired, which IS stored:
          //       'sla_breach_full_clawback'  → earned_amount driven to 0, and
          //         the pre-clawback value was the base share, which
          //         earnings_calc defines as the absolute orders.doctor_fee
          //         (uplift was already zeroed at breach detection). Clawback =
          //         orders.doctor_fee.
          //       '...90pct_clawback'          → earned_amount := 0.10 × full,
          //         so full = 10 × earned and the clawback = 9 × earned. Exact.
          //     Any other/unknown policy contributes 0 EGP but is still counted,
          //     so a new policy string shows up as an unpriced row instead of
          //     silently vanishing from the total.
          safeAll(
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
               -- include-deleted-ok: an earnings clawback is settled money and
               -- must stay countable even if the order were ever soft-deleted.
               JOIN orders o ON o.id = de.appointment_id
              WHERE de.clawback_applied_at IS NOT NULL
                AND de.id LIKE 'earn-main-%'
                AND ${CLAWBACK_AT_CAIRO_DE} >= ${from}
              GROUP BY 1
              ORDER BY egp DESC`
          ),
        ]);

      // ── by-reason: the three known reasons always present (zeros when the
      // period has none), plus an `other` catch-all so the parts always sum to
      // the total. A reason the ledger grows later shows up in `other` rather
      // than being dropped on the floor.
      const REASONS = ['sla_breach', 'patient_request', 'operator_refund'];
      const byReason = {};
      REASONS.forEach((k) => { byReason[k] = { count: 0, egp: 0 }; });
      byReason.other = { count: 0, egp: 0 };
      let refundedTotal = 0;
      let refundedCount = 0;
      (reasonRows || []).forEach((r) => {
        const key = REASONS.includes(r.reason) ? r.reason : 'other';
        byReason[key].count += Number(r.n) || 0;
        byReason[key].egp = money(byReason[key].egp + money(r.egp));
        refundedCount += Number(r.n) || 0;
        refundedTotal = money(refundedTotal + money(r.egp));
      });

      const mapGroup = (rows) => (rows || []).map((r) => ({
        id: r.id || null,
        name: r.name || null,
        count: Number(r.n) || 0,
        egp: money(r.egp),
      }));

      // Tier buckets merged post-normalization (vip ← fast_track), then sorted
      // highest-cost first like the other breakdowns.
      const tierMap = new Map();
      (tierRows || []).forEach((r) => {
        const tier = normalizeTier(r.tier);
        const cur = tierMap.get(tier) || { tier, count: 0, egp: 0 };
        cur.count += Number(r.n) || 0;
        cur.egp = money(cur.egp + money(r.egp));
        tierMap.set(tier, cur);
      });
      const byTier = Array.from(tierMap.values()).sort((a, b) => b.egp - a.egp || b.count - a.count);

      const collected = money(collectedRow && collectedRow.collected);
      const clawback = (clawbackRows || []).map((r) => ({
        policy: r.policy,
        count: Number(r.n) || 0,
        egp: money(r.egp),
      }));
      const clawbackTotal = clawback.reduce((s, c) => money(s + c.egp), 0);
      const clawbackCount = clawback.reduce((s, c) => s + c.count, 0);

      return res.ok({
        period,
        window: {
          startCairo: (collectedRow && collectedRow.period_start_cairo) || null,
          timezone: BUSINESS_TZ,
        },
        breaches: {
          count: byReason.sla_breach.count,
          refundedEgp: byReason.sla_breach.egp,
          bySpecialty: mapGroup(specialtyRows),
          byDoctor: mapGroup(doctorRows),
          byTier,
        },
        refunds: {
          total: { count: refundedCount, egp: refundedTotal },
          byReason,
        },
        refundRate: {
          refundedEgp: refundedTotal,
          collectedEgp: collected,
          // null, never 0 and never Infinity: with nothing collected there is
          // no rate to report, and a fabricated 0% would read as "healthy".
          pct: collected > 0 ? Math.round((refundedTotal / collected) * 10000) / 100 : null,
        },
        earningsClawback: {
          count: clawbackCount,
          egp: clawbackTotal,
          byPolicy: clawback,
          // The amount is DERIVED from the stored policy, not stored itself —
          // see query (6). Flagged so the app never presents it as ledgered.
          basis: 'derived_from_clawback_policy',
        },
        basis: {
          refunds: 'committed refunds (status paid/approved/auto_approved), SUM(amount_egp)',
          collected: 'orders_active payment_status paid/captured, SUM(COALESCE(total_price_with_addons, price))',
          bucketing: 'Cairo business day (Africa/Cairo)',
        },
      });
    } catch (err) {
      console.error('[admin/breach-cost] failed:', err && err.message);
      return res.fail('Failed to load breach cost', 500, 'BREACH_COST_ERROR');
    }
  });

  // ─── GET /manual-queue (cases the classifier could not route) ──────────────
  //
  // AUDIT — WHY THIS SURFACE EXISTS.
  //
  // When the Theme 14 specialty classifier's confidence falls below the live
  // threshold it parks the order at assignment_status='manual_queue' and BOTH
  // auto_assign.js and notify/broadcast.js short-circuit on that state. The
  // case is PAID and it does not move again until a human routes it.
  //
  // The Command app folded these into an undifferentiated "pending assignment"
  // count with no way to act on them, so they rot silently: the patient has
  // paid, no doctor has been told the case exists, no SLA clock is running (it
  // starts at acceptance) and nothing on the phone says a person is required.
  // This list, plus the two POSTs below, is the phone-side equivalent of
  // /superadmin/manual-queue.
  //
  // Row set is deliberately IDENTICAL to the web list (routes/superadmin.js
  // ~2185): completed_at IS NULL AND assignment_status='manual_queue',
  // oldest-first (FIFO — the longest wait is the most urgent triage), capped at
  // 200. No status filter, exactly like the web: mark-unsuitable flips
  // assignment_status to 'cancelled', so cancelled cases leave the queue on
  // that column and a second, unfolded status predicate would only add a
  // case-sensitivity hazard for no gain.
  //
  // Beyond the web's columns it carries what the phone needs to triage without
  // a second round-trip: money (base / charged / grand total), tier, payment
  // state, the chosen-vs-predicted specialty pair, and the wait.
  // READ-ONLY. requireJWT + requireRole('superadmin') inherited.
  router.get('/manual-queue', async (req, res) => {
    try {
      const n = (v) => Number(v) || 0;
      const rows = await safeAll(
        `SELECT o.id, o.reference_id, o.created_at, o.status, o.payment_status,
                o.urgency_tier, o.base_price, o.price, o.total_price_with_addons,
                o.specialty_id AS chosen_specialty_id, o.service_id AS chosen_service_id,
                COALESCE(p.name,'—') AS patient_name, p.gender, p.date_of_birth,
                sp_chosen.name AS chosen_specialty_name,
                sv_chosen.name AS chosen_service_name,
                sc.specialty_id  AS predicted_specialty_id,
                sc.service_id    AS predicted_service_id,
                sc.confidence    AS predicted_confidence,
                sc.created_at    AS predicted_at,
                sp_pred.name AS predicted_specialty_name,
                sv_pred.name AS predicted_service_name,
                -- Both arms cast to timestamptz so the subtraction is an
                -- INSTANT difference, never a wall-clock one. o.created_at is
                -- already timestamptz (migration 081) and the cast is a no-op;
                -- specialty_classifications.created_at is still naive-UTC (056,
                -- outside 081's two-table scope) and the cast reads it in the
                -- session zone, which src/pg.js pins to UTC — the same
                -- ::timestamptz form GET /cases uses on deadline_at.
                ROUND(EXTRACT(EPOCH FROM (
                  NOW() - COALESCE(sc.created_at::timestamptz, o.created_at::timestamptz)
                )) / 60) AS waiting_mins
           FROM orders_active o
           LEFT JOIN users p ON p.id = o.patient_id
           LEFT JOIN specialties sp_chosen ON sp_chosen.id = o.specialty_id
           LEFT JOIN services   sv_chosen  ON sv_chosen.id  = o.service_id
           -- Latest classification per case (the web's LATERAL, verbatim).
           LEFT JOIN LATERAL (
             SELECT specialty_id, service_id, confidence, created_at
               FROM specialty_classifications
              WHERE case_id = o.id
              ORDER BY created_at DESC
              LIMIT 1
           ) sc ON true
           LEFT JOIN specialties sp_pred ON sp_pred.id = sc.specialty_id
           LEFT JOIN services   sv_pred  ON sv_pred.id  = sc.service_id
          WHERE o.completed_at IS NULL
            AND o.assignment_status = 'manual_queue'
            -- AUDIT — narrower than the web list, deliberately.
            --
            -- The web console shows everything with assignment_status =
            -- 'manual_queue'. Checked against production on 2026-08-17: both
            -- rows in that queue were unpaid — one a DRAFT from the day before,
            -- one EXPIRED_UNPAID and sitting there for 33 days. Neither is
            -- actionable: there is no money to protect and nothing to route.
            --
            -- This surface exists to answer one question on a phone — "is there
            -- a PAID case nobody is watching?" — and a queue whose visible
            -- contents are permanently two un-actionable rows is a queue the
            -- operator stops opening. Drafts and expired-unpaid carts are
            -- excluded; genuinely stuck paid work is not.
            AND LOWER(COALESCE(o.status, '')) NOT IN ('draft', 'expired_unpaid', 'cancelled', 'refunded')
          ORDER BY o.created_at ASC
          LIMIT 200`
      );

      const cases = (rows || []).map((r) => ({
        id: r.id, // raw orders.id — the routing key for the two POSTs below
        reference: r.reference_id || null,
        patient: r.patient_name,
        ageSex: deriveAgeSex(r.date_of_birth, r.gender),
        // predicted = what the AI thought; chosen = what is on the order right
        // now (the patient's wizard pick). The operator is resolving exactly
        // this disagreement, so both sides ship on every row.
        specialtyPredicted: r.predicted_specialty_name || null,
        specialtyPredictedId: r.predicted_specialty_id || null,
        specialtyChosen: r.chosen_specialty_name || null,
        specialtyChosenId: r.chosen_specialty_id || null,
        servicePredicted: r.predicted_service_name || null,
        servicePredictedId: r.predicted_service_id || null,
        service: r.chosen_service_name || null,
        serviceId: r.chosen_service_id || null,
        // 0..1 as written by the classifier (DOUBLE PRECISION, may be NULL on
        // rows parked before the classifier could score them).
        confidence: r.predicted_confidence == null ? null : Number(r.predicted_confidence),
        predictedAt: toIso(r.predicted_at),
        tier: normalizeTier(r.urgency_tier),
        status: normalizeStatus(r.status),
        payment: String(r.payment_status || 'unpaid').toLowerCase(),
        basePrice: n(r.base_price),
        price: n(r.price),
        grandTotal: n(r.total_price_with_addons != null ? r.total_price_with_addons : r.price),
        // How long this case has been waiting for a human, in minutes, measured
        // from the classification that parked it (falling back to order
        // creation when no classification row exists).
        waitingMins: r.waiting_mins == null ? null : Number(r.waiting_mins),
        createdAt: toIso(r.created_at),
      }));

      const paid = cases.filter((c) => c.payment === 'paid' || c.payment === 'captured').length;
      return res.ok({
        cases,
        counts: { total: cases.length, paid, unpaid: cases.length - paid },
      });
    } catch (err) {
      console.error('[admin/manual-queue] failed:', err && err.message);
      return res.fail('Failed to load manual queue', 500, 'MANUAL_QUEUE_ERROR');
    }
  });

  // ─── POST /manual-queue/:id/approve (real WRITE — atomic) ──────────────────
  //
  // Routes a parked case: sets its specialty + service (and optionally a
  // hand-picked doctor), releases assignment_status, and re-engages the normal
  // post-payment routing flow. Same effects as the web handler
  // (routes/superadmin.js ~2343), in ONE transaction on the txn client:
  //   1. SELECT … FOR UPDATE + re-validate every guard from fresh in-txn reads
  //   2. UPDATE orders (specialty, service, doctor?, assignment_status)
  //   3. INSERT specialty_classification_overrides — AI pick vs operator pick,
  //      side by side (the prompt-iteration signal; the patient_* column names
  //      are preserved from the patient-self-override flow)
  //   4. INSERT order_events 'manual_queue_resolved'
  //   5. INSERT error_logs admin_audit 'manual_queue_assigned'
  // then POST-COMMIT, off-txn: the patient routing-changed notice and the two
  // routing calls.
  //
  // IDEMPOTENCY-SAFE: the state is re-validated INSIDE the UPDATE's WHERE
  // (assignment_status = 'manual_queue'), not only in the pre-read — the same
  // shape the refund handlers use. Two operators approving the same case
  // concurrently: the first commits, the second's UPDATE matches 0 rows and
  // gets 409 NOT_IN_QUEUE instead of writing a second override row and firing
  // a second broadcast.
  //
  // PARITY NOTE: like the web, picking a doctor here sets orders.doctor_id +
  // assignment_status='assigned' but does NOT open a doctor_assignments row or
  // start the acceptance handshake — the full assignment path with all ten
  // eligibility rules is POST /cases/:id/assign. This endpoint only ROUTES.
  router.post('/manual-queue/:id/approve', async (req, res) => {
    const id = req.params.id;
    const body = req.body || {};
    // camelCase is the Command app's convention (see /cases/:id/assign);
    // snake_case is accepted so a payload copied from the web form also works.
    const specialtyId = String(body.specialtyId || body.specialty_id || '').trim();
    const serviceId = String(body.serviceId || body.service_id || '').trim();
    const doctorId = String(body.doctorId || body.doctor_id || '').trim();
    const reason = String(body.reason || body.override_reason || '').trim().slice(0, 1000);

    if (!specialtyId || !serviceId) {
      return res.fail('specialtyId and serviceId are required', 400, 'BAD_REQUEST');
    }

    // Throw-to-reject: attaches an HTTP status + code carried out of the txn.
    const af = (msg, http, code) => {
      const e = new Error(msg);
      e.http = http;
      e.code = code;
      throw e;
    };

    let client;
    let committed = null;
    try {
      client = await db.connect();
      await client.query('BEGIN');

      const o = (await client.query(
        `SELECT id, patient_id, assignment_status, payment_status, specialty_id, service_id
           FROM orders WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [id]
      )).rows[0];
      if (!o) af('Case not found', 404, 'NOT_FOUND');
      if (String(o.assignment_status || '') !== 'manual_queue') {
        af('Case is not in the manual queue', 409, 'NOT_IN_QUEUE');
      }

      // Service must exist, be visible, and belong to the chosen specialty —
      // the web's guard, re-read in-txn so the catalog cannot shift under us.
      const svc = (await client.query(
        `SELECT id, specialty_id FROM services
          WHERE id = $1 AND COALESCE(is_visible, true) = true`,
        [serviceId]
      )).rows[0];
      if (!svc || String(svc.specialty_id) !== specialtyId) {
        af('Service does not belong to the chosen specialty', 409, 'INVALID_SERVICE');
      }

      // Doctor (only when hand-picked) must be an active doctor carrying the
      // chosen specialty on the doctor_specialties junction — the same
      // eligibility model the broadcast flow uses.
      if (doctorId) {
        const ok = (await client.query(
          `SELECT u.id FROM users u
             JOIN doctor_specialties ds ON ds.doctor_id = u.id
            WHERE u.id = $1 AND u.role = 'doctor'
              AND COALESCE(u.is_active, true) = true
              AND ds.specialty_id = $2 LIMIT 1`,
          [doctorId, specialtyId]
        )).rows[0];
        if (!ok) af('Doctor is not eligible for the chosen specialty', 409, 'INVALID_DOCTOR');
      }

      // The AI's latest call, recorded alongside the operator's pick.
      const ai = (await client.query(
        `SELECT specialty_id, service_id, confidence FROM specialty_classifications
          WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [id]
      )).rows[0] || null;

      const nextAssignmentStatus = doctorId ? 'assigned' : 'auto';

      // The write. The WHERE re-asserts the queue state (see IDEMPOTENCY note):
      // a 0-row result means another operator got there first.
      const upd = doctorId
        ? await client.query(
            `UPDATE orders
                SET specialty_id = $1, service_id = $2, doctor_id = $3,
                    assignment_status = $4, updated_at = NOW()
              WHERE id = $5 AND assignment_status = 'manual_queue'
            RETURNING id`,
            [specialtyId, serviceId, doctorId, nextAssignmentStatus, id]
          )
        : await client.query(
            `UPDATE orders
                SET specialty_id = $1, service_id = $2,
                    assignment_status = $3, updated_at = NOW()
              WHERE id = $4 AND assignment_status = 'manual_queue'
            RETURNING id`,
            [specialtyId, serviceId, nextAssignmentStatus, id]
          );
      if (!upd.rows[0]) af('Case is not in the manual queue', 409, 'NOT_IN_QUEUE');

      await client.query(
        `INSERT INTO specialty_classification_overrides
           (id, case_id, ai_specialty_id, ai_service_id, ai_confidence,
            patient_specialty_id, patient_service_id, override_at, override_reason,
            actor_role)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, 'admin')`,
        [randomUUID(), id,
          ai ? ai.specialty_id : null,
          ai ? ai.service_id : null,
          ai && ai.confidence != null ? Number(ai.confidence) : null,
          specialtyId, serviceId,
          reason ? ('command_manual_queue: ' + reason) : 'command_manual_queue']
      );

      await client.query(
        `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
           VALUES ($1, $2, 'manual_queue_resolved', $3, NOW(), $4, 'superadmin')`,
        [randomUUID(), id, JSON.stringify({
          operator_user_id: req.user.id,
          ai_specialty_id: ai ? ai.specialty_id : null,
          ai_service_id: ai ? ai.service_id : null,
          ai_confidence: ai && ai.confidence != null ? Number(ai.confidence) : null,
          chosen_specialty_id: specialtyId,
          chosen_service_id: serviceId,
          doctor_picked_manually: !!doctorId,
          manual_doctor_id: doctorId || null,
          override_reason_preview: reason.slice(0, 100),
          via: 'command_api',
        }), req.user.id]
      );
      await client.query(
        `INSERT INTO error_logs (id, level, category, message, user_id, context)
           VALUES ($1, 'audit', 'admin_audit', $2, $3, $4)`,
        [randomUUID(), `manual_queue_assigned case ${id}`, req.user.id,
          JSON.stringify({
            action: 'manual_queue_assigned', caseId: id,
            specialtyId, serviceId, doctorId: doctorId || null, reason: reason || null,
          })]
      );

      await client.query('COMMIT');
      committed = {
        patientId: o.patient_id || null,
        previousSpecialtyId: o.specialty_id || null,
        paymentStatus: String(o.payment_status || '').toLowerCase(),
        ai,
        nextAssignmentStatus,
      };
    } catch (err) {
      if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* no-op */ } }
      if (err && err.http) return res.fail(err.message, err.http, err.code);
      console.error('[admin/manual-queue-approve] failed:', err && err.message);
      return res.fail('Manual queue approval failed', 500, 'MANUAL_QUEUE_APPROVE_ERROR');
    } finally {
      if (client && client.release) client.release();
    }

    // ── Post-commit, off-txn, best-effort. Nothing below can unwind the
    // committed routing decision.

    // (1) Patient notice — Q2-locked to a SPECIALTY change only (not a
    //     service-within-the-same-specialty change), identical to the web.
    const specialtyChanged = !!committed.previousSpecialtyId
      && String(committed.previousSpecialtyId) !== specialtyId;
    let notification = 'skipped';
    if (specialtyChanged && committed.patientId) {
      try {
        const r = await queueMultiChannelNotification({
          orderId: id,
          toUserId: committed.patientId,
          channels: ['internal', 'email', 'whatsapp'],
          template: 'case_routing_updated',
          response: {
            case_id: id,
            caseReference: String(id).slice(0, 12).toUpperCase(),
            patientName: '', // resolved by notification_worker from users.name
          },
          dedupe_key: 'case_routing_updated:' + id,
        });
        notification = (r && r.ok === false) ? 'failed' : 'queued';
      } catch (e) {
        console.error('[admin/manual-queue-approve] notify failed:', e && e.message);
        notification = 'failed';
      }
    }

    // (2) Re-engage routing when no doctor was hand-picked and the money is in.
    //     The manual_queue gates in auto_assign.js / notify/broadcast.js
    //     released the moment assignment_status flipped above.
    //
    //     AUDIT-H1 — the web's equivalent shipped these as
    //     `.catch(console.error)`. If either rejected, the response still
    //     reported success, nothing reached /ops/errors, and the case became
    //     UNREACHABLE: the acceptance watcher only picks up orders that have an
    //     acceptance_deadline_at (which the failed broadcast never set) and the
    //     SLA sweep only scans IN_REVIEW / REJECTED_FILES. A paid case would
    //     sit forever with no doctor and no signal to anyone. That was fixed in
    //     routes/superadmin.js and the fix is carried here from the start:
    //     failures go to error_logs (surfacing on /ops/errors and in the
    //     silent-failures view) AND onto the case timeline as
    //     CASE_ROUTING_FAILED. They are NOT awaited — broadcast fans out to
    //     every eligible doctor and must not hold the operator's request open.
    const isPaid = ['paid', 'captured'].includes(committed.paymentStatus);
    let routing = 'skipped_manual_doctor';
    if (!doctorId) routing = isPaid ? 'requested' : 'skipped_not_paid';
    if (!doctorId && isPaid) {
      const onRoutingError = (stage) => (err) => {
        try {
          logErrorToDb(err, {
            context: 'admin_api.manual_queue_approve.' + stage,
            category: 'assignment',
            orderId: id,
            userId: req.user && req.user.id,
            requestId: req.requestId,
          });
        } catch (_) { /* the sink itself must never throw into the response */ }
        Promise.resolve(logCaseEvent(id, 'CASE_ROUTING_FAILED', {
          stage, reason: err && err.message, via: 'command_manual_queue_approve',
        })).catch(function () {});
      };
      // Each call is additionally wrapped because a SYNCHRONOUS throw (a bad
      // require, a missing export) would escape .catch() entirely, reject this
      // async handler after the transaction had already committed, and — under
      // express 4, which does not catch async rejections — leave the operator's
      // request hanging with no response at all.
      const fire = (fn, stage) => {
        try { Promise.resolve(fn(id)).catch(onRoutingError(stage)); }
        catch (e) { onRoutingError(stage)(e); }
      };
      fire(enqueueAutoAssign, 'auto_assign');
      fire(broadcastOrderToSpecialty, 'broadcast');
    }

    return res.ok({
      id,
      assignmentStatus: committed.nextAssignmentStatus,
      specialtyId,
      serviceId,
      doctorId: doctorId || null,
      specialtyChanged,
      ai: committed.ai
        ? {
            specialtyId: committed.ai.specialty_id || null,
            serviceId: committed.ai.service_id || null,
            confidence: committed.ai.confidence == null ? null : Number(committed.ai.confidence),
          }
        : null,
      routing,
      notification,
    });
  });

  // ─── POST /manual-queue/:id/unsuitable (real WRITE — atomic) ───────────────
  //
  // The other exit from the queue: the case cannot be served at all. Mirrors
  // the web's mark-unsuitable (routes/superadmin.js ~2559) in ONE transaction:
  //   1. SELECT … FOR UPDATE + queue-state guard
  //   2. UPDATE orders → status='cancelled', assignment_status='cancelled'
  //   3. If the money was taken → open ONE pending refund row
  //      (reason='operator_refund') unless a live refund already exists
  //   4. INSERT order_events 'manual_queue_marked_unsuitable'
  //   5. INSERT error_logs admin_audit
  // then, post-commit, the patient cancellation notice.
  //
  // `reason` is REQUIRED — this cancels a paid case and the patient is told
  // why. Accepts a preset code, free text, or the web's "code | free-text".
  //
  // IDEMPOTENCY-SAFE: the queue state is re-asserted in the UPDATE's WHERE, so
  // a double-tap cancels once and the second call gets 409 NOT_IN_QUEUE. The
  // refund INSERT is additionally guarded by an in-txn SELECT for any live
  // refund on the order (and, underneath, by the uniq_refunds_pending_per_order
  // partial index from migration 048).
  //
  // DELIBERATE DIVERGENCE from the web, stated plainly: the web opens the
  // refund only when payment_status = 'paid', while its own approve handler two
  // routes above treats paid AND captured as "the money is in". A captured
  // order that is marked unsuitable on the web therefore keeps the patient's
  // money with no refund row anywhere. This endpoint uses the paid/captured set
  // that the rest of this file uses. It changes nothing about the web handler.
  router.post('/manual-queue/:id/unsuitable', async (req, res) => {
    const id = req.params.id;
    const body = req.body || {};
    const reasonRaw = String(body.reason || '').trim().slice(0, 500);
    if (!reasonRaw) return res.fail('reason is required', 400, 'REASON_REQUIRED');

    // "code | free-text" resolution — the web's parser, verbatim, so the
    // sentence the patient receives is the same from either console.
    const parts = reasonRaw.split('|').map((s) => s.trim());
    const reasonCode = parts[0] || '';
    const reasonFree = parts.slice(1).join(' | ').trim();
    const lang = (req.user && req.user.lang) === 'ar' ? 'ar' : 'en';
    const preset = MANUAL_QUEUE_UNSUITABLE_REASONS[reasonCode];
    let reasonForPatient;
    if (reasonCode === 'other') {
      reasonForPatient = reasonFree || (lang === 'ar' ? 'الحالة غير مناسبة.' : 'This case is not suitable.');
    } else if (preset) {
      reasonForPatient = preset[lang] + (reasonFree ? ' ' + reasonFree : '');
    } else {
      reasonForPatient = reasonRaw;
    }

    const af = (msg, http, code) => {
      const e = new Error(msg);
      e.http = http;
      e.code = code;
      throw e;
    };

    let client;
    let committed = null;
    try {
      client = await db.connect();
      await client.query('BEGIN');

      const o = (await client.query(
        `SELECT id, patient_id, assignment_status, status, payment_status,
                base_price, urgency_uplift_amount
           FROM orders WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [id]
      )).rows[0];
      if (!o) af('Case not found', 404, 'NOT_FOUND');
      if (String(o.assignment_status || '') !== 'manual_queue') {
        af('Case is not in the manual queue', 409, 'NOT_IN_QUEUE');
      }

      const upd = await client.query(
        `UPDATE orders
            SET status = 'cancelled', assignment_status = 'cancelled', updated_at = NOW()
          WHERE id = $1 AND assignment_status = 'manual_queue'
        RETURNING id`,
        [id]
      );
      if (!upd.rows[0]) af('Case is not in the manual queue', 409, 'NOT_IN_QUEUE');

      // Refund: only when the money was actually taken. Amount = base_price +
      // urgency_uplift_amount, the web's figure (the patient's full case price;
      // file add-ons are settled separately and are NOT swept in here).
      // instapay_handle is unknown at cancellation time — 'awaiting_patient' is
      // the web's placeholder so the row is creatable and the refund queue
      // prompts for the handle later.
      let refund = null;
      const paid = ['paid', 'captured'].includes(String(o.payment_status || '').toLowerCase());
      if (paid) {
        const live = (await client.query(
          `SELECT id, status, amount_egp FROM refunds
            WHERE order_id = $1 AND status IN ('pending','auto_approved','approved','paid')
            LIMIT 1`,
          [id]
        )).rows[0];
        if (live) {
          refund = { id: live.id, status: live.status, amountEgp: money(live.amount_egp), created: false };
        } else {
          const amount = money(Number(o.base_price || 0) + Number(o.urgency_uplift_amount || 0));
          const refundId = randomUUID();
          await client.query(
            `INSERT INTO refunds (
               id, order_id, amount_egp, requested_amount, approved_amount,
               reason, patient_reason, instapay_handle, status,
               requested_by, refunded_at, refunded_by, notes
             ) VALUES ($1, $2, $3, $3, NULL, 'operator_refund', NULL, $4, 'pending',
                       $5, NOW(), $5, $6)`,
            [refundId, id, amount, 'awaiting_patient', req.user.id,
              'manual_queue_unsuitable: ' + reasonRaw]
          );
          refund = { id: refundId, status: 'pending', amountEgp: amount, created: true };
        }
      }

      await client.query(
        `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
           VALUES ($1, $2, 'manual_queue_marked_unsuitable', $3, NOW(), $4, 'superadmin')`,
        [randomUUID(), id, JSON.stringify({
          operator_user_id: req.user.id,
          reason: reasonRaw,
          was_paid: paid,
          refund_id: refund ? refund.id : null,
          via: 'command_api',
        }), req.user.id]
      );
      await client.query(
        `INSERT INTO error_logs (id, level, category, message, user_id, context)
           VALUES ($1, 'audit', 'admin_audit', $2, $3, $4)`,
        [randomUUID(), `manual_queue_marked_unsuitable case ${id}`, req.user.id,
          JSON.stringify({
            action: 'manual_queue_marked_unsuitable', caseId: id,
            reason: reasonRaw, wasPaid: paid, refundId: refund ? refund.id : null,
          })]
      );

      await client.query('COMMIT');
      committed = { patientId: o.patient_id || null, refund };
    } catch (err) {
      if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* no-op */ } }
      if (err && err.http) return res.fail(err.message, err.http, err.code);
      console.error('[admin/manual-queue-unsuitable] failed:', err && err.message);
      return res.fail('Mark unsuitable failed', 500, 'MANUAL_QUEUE_UNSUITABLE_ERROR');
    } finally {
      if (client && client.release) client.release();
    }

    // Post-commit, off-txn, best-effort: tell the patient, with the resolved
    // sentence. Cannot unwind the committed cancellation.
    let notification = 'skipped';
    if (committed.patientId) {
      try {
        const r = await queueMultiChannelNotification({
          orderId: id,
          toUserId: committed.patientId,
          channels: ['internal', 'email', 'whatsapp'],
          template: 'case_cancelled_patient',
          response: {
            order_id: id,
            caseReference: String(id).slice(0, 12).toUpperCase(),
            reason: reasonForPatient,
          },
          dedupe_key: 'case_cancelled:' + id,
        });
        notification = (r && r.ok === false) ? 'failed' : 'queued';
      } catch (e) {
        console.error('[admin/manual-queue-unsuitable] notify failed:', e && e.message);
        notification = 'failed';
      }
    }

    return res.ok({
      id,
      status: 'cancelled',
      assignmentStatus: 'cancelled',
      reason: reasonRaw,
      refund: committed.refund,
      notification,
    });
  });

  // ─── GET /events?limit=&kind= (what the app has PUSHED at the operator) ────
  //
  // AUDIT — WHY THIS SURFACE EXISTS.
  //
  // services/ops_push.js writes one ops_push_log row for every business-event
  // push: an urgent case nobody accepted inside its 15-minute window, the first
  // SLA breach of the Cairo day, a refund request, a payment whose amount did
  // not match what was owed, a doctor application, a doctor hitting the
  // auto-pause threshold. Six producers, all of them things the founder has to
  // act on.
  //
  // Push is fire-and-forget and that is the whole problem. The phone is on
  // silent overnight, iOS collapses a notification stack, a thumb swipes the
  // wrong way — and the event is simply GONE. Nothing in the product reads
  // ops_push_log today, so there is no second place to look. An alert missed at
  // 02:00 is an alert that never happened.
  //
  // This is that second place: the durable, in-app feed of everything the
  // system has tried to tell the operator, newest first.
  //
  // sentCount=0 IS THE POINT, NOT A DETAIL. ops_push.js counts the superadmins
  // holding a registered device BEFORE it sends, and stores that count. Zero
  // means the event fired correctly and NOBODY was told — a revoked or expired
  // Expo token, a reinstalled app, a logged-out device. That failure is
  // completely invisible from the sending side (notifySuperadmins swallows
  // per-device errors and reports nothing), so it is surfaced here per row AND
  // rolled up as `undelivered` in the summary. NULL is a different thing again:
  // the row was claimed but the count-back UPDATE never landed, so it is
  // reported as null rather than coerced to 0.
  //
  // ops_push_log.sent_at is TIMESTAMPTZ (migration 082 declared it so from the
  // start), which is why nothing here needs the UTC→Cairo two-step the payouts
  // and errors surfaces below do — NOW() - INTERVAL is already an instant
  // comparison against it.
  //
  // READ-ONLY. requireJWT + requireRole('superadmin') inherited from the router.
  router.get('/events', async (req, res) => {
    const q = req.query || {};
    // Same shape as GET /cases: clamp hard, never trust the client. 200 is the
    // ceiling because this renders as one scrolling list on a phone.
    const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 50));
    // `kind` is written only from the six literals in ops_push.js's call sites,
    // all lowercase — but it is a bare TEXT column with no CHECK, so both sides
    // are folded rather than trusting the writers to stay disciplined. Bound as
    // a parameter, so an arbitrary query string can never reach the SQL.
    const kind = String(q.kind || '').trim().toLowerCase();

    try {
      const kindFilter = kind ? `WHERE LOWER(COALESCE(kind,'')) = $1` : '';
      const kindParams = kind ? [kind] : [];

      const [rows, summaryRows, totalRow] = await Promise.all([
        safeAll(
          `SELECT id, sent_at, kind, title, body, order_id, sent_count
             FROM ops_push_log
             ${kindFilter}
            ORDER BY sent_at DESC, id DESC
            LIMIT ${limit}`,
          kindParams
        ),
        // "What has been noisy" — 7 days, every kind, DELIBERATELY unfiltered by
        // ?kind=. The summary is how the operator decides which kind to filter
        // TO, so narrowing it with the filter would hide the choice.
        safeAll(
          `SELECT LOWER(COALESCE(kind,'')) AS kind,
                  COUNT(*)::int AS n,
                  COUNT(*) FILTER (WHERE sent_count = 0)::int AS undelivered,
                  MAX(sent_at) AS last_at
             FROM ops_push_log
            WHERE sent_at >= NOW() - INTERVAL '7 days'
            GROUP BY 1
            ORDER BY n DESC, kind ASC`
        ),
        // Total matching the ACTIVE filter, so the app can say "50 of 312"
        // without paging the whole table down the wire.
        safeGet(
          `SELECT COUNT(*)::int AS total FROM ops_push_log ${kindFilter}`,
          kindParams,
          { total: 0 }
        ),
      ]);

      const events = (rows || []).map((r) => {
        // NULL ≠ 0. NULL = "never recorded" (the count-back UPDATE lost);
        // 0 = "recorded, and it reached nobody". Only the second is a failure.
        const sentCount = r.sent_count == null ? null : Number(r.sent_count);
        return {
          id: r.id == null ? null : Number(r.id),
          sentAt: toIso(r.sent_at),
          kind: r.kind || null,
          kindLabel: OPS_PUSH_KIND_LABELS[String(r.kind || '').toLowerCase()]
            || humanizeLabel(r.kind),
          title: r.title || null,
          body: r.body || null,
          // Raw orders.id — the routing key the app already uses to deep-link
          // into GET /cases/:id. NULL for the day-keyed events.
          orderId: r.order_id || null,
          sentCount,
          // Precomputed so the screen cannot get the NULL-vs-0 test wrong.
          reachedNobody: sentCount === 0,
        };
      });

      const byKind = (summaryRows || []).map((r) => ({
        kind: r.kind || null,
        kindLabel: OPS_PUSH_KIND_LABELS[r.kind] || humanizeLabel(r.kind),
        count: Number(r.n) || 0,
        undelivered: Number(r.undelivered) || 0,
        lastAt: toIso(r.last_at),
      }));

      return res.ok({
        events,
        filter: { kind: kind || null, limit },
        total: (totalRow && Number(totalRow.total)) || 0,
        summary7d: {
          total: byKind.reduce((s, k) => s + k.count, 0),
          // How many of the last 7 days' events reached zero devices. If this
          // is non-zero the push channel is broken, not quiet.
          undelivered: byKind.reduce((s, k) => s + k.undelivered, 0),
          byKind,
        },
        basis: {
          source: 'ops_push_log (migration 082) — one row per business-event push attempt',
          sentCount: 'superadmins holding a registered device at send time; 0 = nobody was told, null = count never recorded',
        },
      });
    } catch (err) {
      console.error('[admin/events] failed:', err && err.message);
      return res.fail('Failed to load events', 500, 'EVENTS_ERROR');
    }
  });

  // ─── GET /payouts (doctor earnings owed) ───────────────────────────────────
  //
  // AUDIT — WHY THIS SURFACE EXISTS.
  //
  // Money owed to doctors is the largest recurring liability the business
  // carries, it is settled by hand over InstaPay, and until now it existed on
  // exactly one screen: the web console's finance tab. There was no mobile view
  // at all — /revenue and /breach-cost report what came IN and what leaked OUT,
  // and nothing reported what is STILL OWED. A liability you can only see from
  // a desktop is a liability that gets paid late.
  //
  // DEFINITION OF "OWED" — deliberately IDENTICAL to the web console.
  // services/superadmin_dashboard.js computes it in two places (the finance
  // payouts ledger ~line 543 and the doctor-performance table ~line 689) as:
  //
  //     SUM(doctor_earnings.earned_amount) WHERE status = 'pending'
  //
  // and that is reproduced verbatim here so the two surfaces can never
  // disagree. Three consequences of reusing it, all deliberate:
  //
  //   1. NO 'earn-main-' PREFIX FILTER. doctor_earnings.appointment_id is
  //      overloaded — main-case rows carry the ORDER id under an 'earn-main-'
  //      id prefix (services/earnings_writer.js header), while the video-consult
  //      and no-show paths (routes/video.js, video_scheduler.js) carry an
  //      appointments UUID under 'earn-' / 'earn-noshow-'. The web totals BOTH,
  //      because the founder owes both. So does this. (GET /breach-cost filters
  //      to 'earn-main-%' for the opposite reason: it JOINs orders, and only
  //      main rows have an order id to join on.)
  //   2. status='reassigned' IS EXCLUDED. earnings_writer.recomputeOnReassign
  //      flips the original doctor's row to 'reassigned' and writes a separate
  //      partial-pay row — also 'reassigned' — so counting them would double the
  //      liability on every reassigned case.
  //   3. status='paid' ON THIS TABLE MEANS "CASE COMPLETED, EARNING CRYSTALLISED"
  //      — it is set by markCaseEarningsPaid at case completion, not by an
  //      InstaPay transfer. The platform has no bank-transfer ledger, so "paid
  //      this month" is the best signal that exists and is labelled as such in
  //      `basis` rather than presented as settled cash.
  //
  // TIMESTAMPS. doctor_earnings.created_at / paid_at are naive-UTC (migration
  // 004; 081 converted orders + doctor_assignments only). "This month" is the
  // CAIRO month — see PAID_AT_CAIRO_DE at the top of this file for the
  // conversion and why it is spelled with ::timestamptz. The two dates that
  // just get echoed out (oldest unpaid, last paid) need no conversion at all:
  // node-pg materialises a naive timestamp in the PROCESS zone, which is pinned
  // to UTC (guard 6 of the audit regression lint), so toIso() is already right.
  //
  // MONEY. earned_amount is DOUBLE PRECISION, so every figure goes through
  // money() — Number() then round to piastres — and every SUM is wrapped in
  // COALESCE(...,0) so a doctor with no rows in a bucket reports 0, not null.
  //
  // READ-ONLY. requireJWT + requireRole('superadmin') inherited from the router.
  router.get('/payouts', async (req, res) => {
    // The per-doctor "paid this month" predicate, written once and reused in
    // SELECT, HAVING (which cannot see a SELECT alias) and the totals query, so
    // the list and the header total can never be computed differently.
    const PAID_THIS_MONTH = `de.status = 'paid' AND ${PAID_AT_CAIRO_DE} >= ${MONTH_START_CAIRO}`;

    try {
      const [rows, totalsRow] = await Promise.all([
        // INNER JOIN, not the web's LEFT JOIN: a doctor with no earnings row at
        // all owes nothing and has nothing to show, and on a phone every such
        // row is a line the operator has to scroll past. Same reason for the
        // HAVING — a doctor fully settled and inactive this month is not a
        // payout, and dropping them is what keeps this screen readable.
        safeAll(
          // 2026-08-24 — owed spans BOTH payout ledgers.
          //
          // This screen is the one an operator actually pays InstaPay from, and
          // it was the only surface left summing doctor_earnings alone after
          // the web console, the doctors tab, the /admin tile and the doctor's
          // own earnings page were all moved to the total. Its own doc block
          // promises the definition is "identical to the web console" — that
          // promise is what makes leaving it behind a defect rather than an
          // omission: an operator would have transferred a number the platform
          // itself no longer believed, short by every add-on commission owed.
          //
          // addon_earnings is LEFT JOINed as a pre-aggregated subquery rather
          // than a second JOIN onto the same GROUP BY, which would multiply the
          // doctor_earnings rows by the addon_earnings rows and inflate both.
          //
          // An INNER JOIN on doctor_earnings is kept deliberately: a doctor
          // with add-on commission but no case earnings is not a real state
          // (add-ons only settle at case completion, which writes the case
          // earning first), and switching to a FULL JOIN to chase it would
          // change what the HAVING trims off the phone screen.
          `SELECT u.id AS doctor_id,
                  COALESCE(u.name, '—') AS doctor_name,
                  COALESCE(SUM(de.earned_amount) FILTER (WHERE de.status = 'pending'), 0)
                    + COALESCE(ae.owed_addons, 0) AS owed,
                  COALESCE(SUM(de.earned_amount) FILTER (WHERE de.status = 'pending'), 0) AS owed_cases,
                  COALESCE(ae.owed_addons, 0) AS owed_addons,
                  COUNT(*) FILTER (WHERE de.status = 'pending')::int AS unpaid_cases,
                  MIN(de.created_at) FILTER (WHERE de.status = 'pending') AS oldest_unpaid_at,
                  MAX(COALESCE(de.paid_at, de.created_at)) FILTER (WHERE de.status = 'paid') AS last_paid_at,
                  COALESCE(SUM(de.earned_amount) FILTER (WHERE ${PAID_THIS_MONTH}), 0) AS paid_this_month
             FROM users u
             JOIN doctor_earnings de ON de.doctor_id = u.id
             LEFT JOIN (
               SELECT doctor_id, SUM(earned_amount_egp) AS owed_addons
                 FROM addon_earnings WHERE status = 'pending' GROUP BY doctor_id
             ) ae ON ae.doctor_id = u.id
            WHERE u.role = 'doctor'
            GROUP BY u.id, u.name, ae.owed_addons
           HAVING COALESCE(SUM(de.earned_amount) FILTER (WHERE de.status = 'pending'), 0)
                    + COALESCE(ae.owed_addons, 0) > 0
               OR COALESCE(SUM(de.earned_amount) FILTER (WHERE ${PAID_THIS_MONTH}), 0) > 0
            ORDER BY owed DESC, paid_this_month DESC, doctor_name ASC
            LIMIT 200`
        ),
        // Totals over the WHOLE table, never over the trimmed list above — so
        // the headline liability stays true even if the list is capped or a
        // doctor row was filtered out by the HAVING.
        safeGet(
          `SELECT COALESCE(SUM(de.earned_amount) FILTER (WHERE de.status = 'pending'), 0)
                    + COALESCE((SELECT SUM(earned_amount_egp) FROM addon_earnings WHERE status = 'pending'), 0)
                    AS owed_total,
                  COALESCE(SUM(de.earned_amount) FILTER (WHERE de.status = 'pending'), 0) AS owed_cases_total,
                  COALESCE((SELECT SUM(earned_amount_egp) FROM addon_earnings WHERE status = 'pending'), 0) AS owed_addons_total,
                  COUNT(*) FILTER (WHERE de.status = 'pending')::int AS unpaid_cases_total,
                  COUNT(DISTINCT de.doctor_id) FILTER (WHERE de.status = 'pending')::int AS doctors_owed,
                  MIN(de.created_at) FILTER (WHERE de.status = 'pending') AS oldest_unpaid_at,
                  COALESCE(SUM(de.earned_amount) FILTER (WHERE ${PAID_THIS_MONTH}), 0) AS paid_this_month,
                  COUNT(*) FILTER (WHERE ${PAID_THIS_MONTH})::int AS paid_this_month_cases,
                  to_char(${MONTH_START_CAIRO}, 'YYYY-MM-DD"T"HH24:MI:SS') AS month_start_cairo
             FROM doctor_earnings de`,
          [],
          null
        ),
      ]);

      const doctors = (rows || []).map((r) => ({
        id: r.doctor_id,
        name: r.doctor_name,
        owedEgp: money(r.owed),
        // The split, so an operator paying from the phone can see why a total
        // differs from the case count times a fee.
        owedCasesEgp: money(r.owed_cases),
        owedAddonsEgp: money(r.owed_addons),
        unpaidCases: Number(r.unpaid_cases) || 0,
        oldestUnpaidAt: toIso(r.oldest_unpaid_at),
        lastPaidAt: toIso(r.last_paid_at),
        paidThisMonthEgp: money(r.paid_this_month),
      }));

      return res.ok({
        totals: {
          owedEgp: money(totalsRow && totalsRow.owed_total),
          owedCasesEgp: money(totalsRow && totalsRow.owed_cases_total),
          owedAddonsEgp: money(totalsRow && totalsRow.owed_addons_total),
          unpaidCases: (totalsRow && Number(totalsRow.unpaid_cases_total)) || 0,
          doctorsOwed: (totalsRow && Number(totalsRow.doctors_owed)) || 0,
          // The single most useful number on the screen: how long the oldest
          // unpaid case has been sitting there.
          oldestUnpaidAt: toIso(totalsRow && totalsRow.oldest_unpaid_at),
          paidThisMonthEgp: money(totalsRow && totalsRow.paid_this_month),
          paidThisMonthCases: (totalsRow && Number(totalsRow.paid_this_month_cases)) || 0,
        },
        month: {
          startCairo: (totalsRow && totalsRow.month_start_cairo) || null,
          timezone: BUSINESS_TZ,
        },
        doctors,
        basis: {
          owed: "doctor_earnings status='pending' SUM(earned_amount) PLUS addon_earnings status='pending' SUM(earned_amount_egp) — identical to the web console finance tab. Case fees and add-on commissions settle in two separate ledgers (earnings_writer keeps add-ons out of doctor_earnings by design); only the sum is what the doctor is shown on their own earnings page.",
          paid: "doctor_earnings status='paid' — set at CASE COMPLETION by earnings_writer.markCaseEarningsPaid, not by a bank transfer. There is no InstaPay settlement ledger.",
          scope: 'all earnings rows for the doctor: main-case, video-consult and no-show alike, plus add-on commissions (video consult, prescription) from addon_earnings',
          bucketing: 'Cairo business month (Africa/Cairo)',
          listing: 'doctors with EGP owed or paid this month; capped at 200. Totals are over the whole table.',
        },
      });
    } catch (err) {
      console.error('[admin/payouts] failed:', err && err.message);
      return res.fail('Failed to load payouts', 500, 'PAYOUTS_ERROR');
    }
  });

  // ─── GET /errors (the platform breaking, on a phone) ───────────────────────
  //
  // AUDIT — WHY THIS SURFACE EXISTS.
  //
  // The Command app's ONLY failure signal today is GET /health's worker-liveness
  // block: "a background worker stopped heartbeating". That catches a process
  // dying. It catches nothing else. A payment webhook rejecting every HMAC, the
  // WhatsApp token 401-ing, a notification worker throwing on every row, a
  // classifier silently no-op-ing — all of it lands in error_logs and
  // case_events, both of which are readable ONLY from the ops dashboard behind
  // a separate password on a desktop. So the operating picture on the phone is
  // "the workers are alive", which is not the same claim as "the platform works".
  //
  // TWO SOURCES, both mirroring what the web already reads:
  //
  //   (a) error_logs — the logErrorToDb sink (src/logger.js). Columns verified
  //       against migration 001 (id, level, message, stack, context, request_id,
  //       user_id, url, method, created_at) plus `category` from migration 035.
  //       Queries mirror routes/ops.js /errors and superadmin_dashboard's health
  //       tab (~line 993).
  //
  //   (b) SILENT FAILURES — case_events whose event_type carries one of the four
  //       suffixes that mean "code ran and did nothing useful". Same LIKE set,
  //       same 7-day window, as routes/ops.js /silent-failures and the ops
  //       dashboard card, so the headline number agrees with the web exactly.
  //
  // level='audit' IS EXCLUDED, AND THAT IS THE LOAD-BEARING DECISION HERE.
  // error_logs is not only an error sink: eight services (admin_refund_approve,
  // admin_refund_deny, admin_doctor_approve/reject, admin_doctor_invite,
  // admin_bulk_assign, payment_event_review, admin_doctor_pause) write the
  // superadmin AUDIT TRAIL into the same table as level='audit',
  // category='admin_audit' — that is what migration 035 was added for. Counting
  // them would mean every refund the founder approves from this very app
  // appears on his phone as a platform error, and the busier he is the more
  // "broken" the platform looks. The unfiltered ops-dashboard count has this
  // bug; this surface does not.
  //
  // ORDER IDS. error_logs has no order_id column — call sites pass it inside the
  // JSON `context` blob under the key `orderId` (16 call sites, verified by
  // grep). `context` is TEXT, and legacy rows are not guaranteed to be valid
  // JSON, so it is read with a regex substring() rather than a ::jsonb cast: a
  // single unparseable row would make the cast throw for the WHOLE query and
  // safeGet would hand back an empty error list — a monitoring screen that goes
  // blank precisely when something is malformed.
  //
  // PHONE BUDGET. Messages are truncated server-side (180 chars) and context to
  // 240, because error_logs.message is stored up to 2000 chars and stack traces
  // are not readable on a 390pt-wide screen anyway.
  //
  // TIMESTAMPS. error_logs.created_at and case_events.created_at are naive-UTC
  // (migration 001, outside 081's two-table scope), so every window comparison
  // casts to ::timestamptz to make it an INSTANT comparison rather than one that
  // depends on the session zone. See the note at PAID_AT_CAIRO_DE for why the
  // cast rather than the two-step form.
  //
  // READ-ONLY. requireJWT + requireRole('superadmin') inherited from the router.
  router.get('/errors', async (req, res) => {
    // Audit-trail rows are not errors — see the block comment above. Folded,
    // because `level` is a bare TEXT column with a default, not an enum.
    //
    // AUDIT — `info` is excluded for the same reason, and it is the LARGER
    // polluter. Checked against production on 2026-08-17, last 30 days:
    //
    //     error / worker_down                142
    //     info  / worker_down                141   <-- not an error
    //     audit / admin_audit                 34   <-- not an error
    //     warn  / email_send                   6
    //     error / notification_queue_failure   2
    //     error / notification_worker          2
    //     error / instagram_scheduler          1
    //
    // The watchdog writes an `info` row every time a worker RECOVERS, so a
    // naive count of this table reports the good news as bad news, roughly
    // doubling the apparent error rate. Counting all 326 rows as errors, when
    // 153 are a recovery log and an audit trail, is how a monitoring screen
    // teaches its operator to ignore it.
    //
    // Only genuine severities count: error, warn, fatal, critical. An unknown
    // or empty level counts too — a row nobody classified is more likely to be
    // an unhandled failure than a deliberate note, and silently dropping it is
    // the mistake this whole audit kept finding.
    const NOT_AUDIT = `LOWER(COALESCE(e.level,'')) NOT IN ('audit', 'info', 'debug', 'trace')`;

    try {
      const [countRow, byCategory, byLevel, recentRows, silentCountRow, silentByType, silentRecent, silentOrderEventsRow] =
        await Promise.all([
          // (1) The two headline counts, from ONE scan so 24h can never exceed 7d.
          safeGet(
            `SELECT COUNT(*) FILTER (WHERE e.created_at::timestamptz >= NOW() - INTERVAL '24 hours')::int AS n_24h,
                    COUNT(*)::int AS n_7d,
                    COUNT(DISTINCT e.message) FILTER (WHERE e.created_at::timestamptz >= NOW() - INTERVAL '24 hours')::int AS unique_24h
               FROM error_logs e
              WHERE ${NOT_AUDIT}
                AND e.created_at::timestamptz >= NOW() - INTERVAL '7 days'`,
            [],
            null
          ),
          // (2) Breakdown by category over 7d. category is NULL on most rows
          //     (migration 035 added it and deliberately did not backfill), so
          //     the nulls collect in an explicit 'uncategorized' bucket rather
          //     than vanishing from a GROUP BY the app then can't reconcile.
          safeAll(
            `SELECT COALESCE(NULLIF(TRIM(e.category), ''), 'uncategorized') AS category,
                    COUNT(*)::int AS n,
                    COUNT(*) FILTER (WHERE e.created_at::timestamptz >= NOW() - INTERVAL '24 hours')::int AS n_24h,
                    MAX(e.created_at) AS last_at
               FROM error_logs e
              WHERE ${NOT_AUDIT}
                AND e.created_at::timestamptz >= NOW() - INTERVAL '7 days'
              GROUP BY 1
              ORDER BY n DESC, category ASC`
          ),
          // (3) Breakdown by level over 7d — 'fatal' vs 'warn' is the difference
          //     between opening the laptop now and reading it tomorrow.
          safeAll(
            `SELECT LOWER(COALESCE(NULLIF(TRIM(e.level), ''), 'error')) AS level,
                    COUNT(*)::int AS n
               FROM error_logs e
              WHERE ${NOT_AUDIT}
                AND e.created_at::timestamptz >= NOW() - INTERVAL '7 days'
              GROUP BY 1
              ORDER BY n DESC`
          ),
          // (4) The ~30 most recent rows. url/method come along because on a
          //     500 they are the whole diagnosis, and they cost nothing.
          safeAll(
            `SELECT e.id,
                    e.created_at,
                    COALESCE(NULLIF(TRIM(e.category), ''), 'uncategorized') AS category,
                    LOWER(COALESCE(NULLIF(TRIM(e.level), ''), 'error')) AS level,
                    LEFT(COALESCE(e.message, ''), 180) AS message,
                    LENGTH(COALESCE(e.message, '')) AS message_len,
                    LEFT(COALESCE(e.context, ''), 240) AS context,
                    e.url, e.method, e.request_id,
                    -- No order_id column on this table; the id lives in the JSON
                    -- context under "orderId". Regex, not ::jsonb — see the note
                    -- above about one bad row blanking the whole list.
                    substring(COALESCE(e.context, '') from '"orderId"\\s*:\\s*"([^"]+)"') AS order_id
               FROM error_logs e
              WHERE ${NOT_AUDIT}
              ORDER BY e.created_at DESC
              LIMIT 30`
          ),
          // (5) Silent failures, 7 days. IDENTICAL predicate to routes/ops.js so
          //     this number and the ops dashboard card cannot disagree.
          safeGet(
            `SELECT COUNT(*)::int AS n
               FROM case_events
              WHERE created_at::timestamptz >= NOW() - INTERVAL '7 days'
                AND ${SILENT_FAILURE_LIKE('event_type')}`,
            [],
            { n: 0 }
          ),
          safeAll(
            `SELECT event_type, COUNT(*)::int AS n, MAX(created_at) AS last_at
               FROM case_events
              WHERE created_at::timestamptz >= NOW() - INTERVAL '7 days'
                AND ${SILENT_FAILURE_LIKE('event_type')}
              GROUP BY event_type
              ORDER BY n DESC, event_type ASC`
          ),
          safeAll(
            `SELECT id, case_id, event_type, created_at,
                    LEFT(COALESCE(event_payload, ''), 240) AS event_payload
               FROM case_events
              WHERE created_at::timestamptz >= NOW() - INTERVAL '7 days'
                AND ${SILENT_FAILURE_LIKE('event_type')}
              ORDER BY created_at DESC
              LIMIT 30`
          ),
          // (6) The same convention applied to order_events, reported SEPARATELY
          //     rather than folded into the count above.
          //
          //     order_events has no `event_type` column at all — the free-text
          //     verb lives in `label` (migration 001) — and no writer in the
          //     codebase currently emits a label with one of the four suffixes,
          //     so this is 0 today. It is scanned anyway, and kept out of the
          //     headline number, so that the day a silent failure IS recorded on
          //     the order timeline instead of the case timeline it shows up here
          //     rather than nowhere, WITHOUT the headline silently diverging
          //     from the web console's figure. UPPER() because case_events uses
          //     SCREAMING_CASE and order_events labels are lowercase.
          safeGet(
            `SELECT COUNT(*)::int AS n
               FROM order_events
              WHERE at::timestamptz >= NOW() - INTERVAL '7 days'
                AND ${SILENT_FAILURE_LIKE('UPPER(COALESCE(label, \'\'))')}`,
            [],
            { n: 0 }
          ),
        ]);

      const errors = (recentRows || []).map((r) => ({
        id: r.id,
        at: toIso(r.created_at),
        category: r.category,
        level: r.level,
        message: r.message || '',
        // So the app can render an ellipsis honestly instead of guessing.
        messageTruncated: Number(r.message_len || 0) > 180,
        context: r.context || null,
        orderId: r.order_id || null,
        url: r.url || null,
        method: r.method || null,
        requestId: r.request_id || null,
      }));

      const silentRows = (silentRecent || []).map((r) => {
        // case_events.event_payload is TEXT holding JSON; legacy rows may not
        // parse. Same tolerance as routes/ops.js — fall back to no reason
        // rather than dropping the row.
        let reason = null;
        if (r.event_payload) {
          try {
            const p = JSON.parse(r.event_payload);
            if (p && p.reason) reason = String(p.reason);
          } catch (_) { reason = null; }
        }
        return {
          id: r.id,
          at: toIso(r.created_at),
          eventType: r.event_type || null,
          label: humanizeLabel(String(r.event_type || '').toLowerCase()),
          orderId: r.case_id || null, // case_events.case_id IS the order id
          reason,
        };
      });

      return res.ok({
        counts: {
          last24h: (countRow && Number(countRow.n_24h)) || 0,
          last7d: (countRow && Number(countRow.n_7d)) || 0,
          unique24h: (countRow && Number(countRow.unique_24h)) || 0,
        },
        byCategory: (byCategory || []).map((r) => ({
          category: r.category,
          count: Number(r.n) || 0,
          last24h: Number(r.n_24h) || 0,
          lastAt: toIso(r.last_at),
        })),
        byLevel: (byLevel || []).map((r) => ({
          level: r.level,
          count: Number(r.n) || 0,
        })),
        errors,
        silentFailures: {
          last7d: (silentCountRow && Number(silentCountRow.n)) || 0,
          byType: (silentByType || []).map((r) => ({
            eventType: r.event_type,
            label: humanizeLabel(String(r.event_type || '').toLowerCase()),
            count: Number(r.n) || 0,
            lastAt: toIso(r.last_at),
          })),
          recent: silentRows,
          // Kept out of last7d on purpose — see query (6).
          orderEventsLast7d: (silentOrderEventsRow && Number(silentOrderEventsRow.n)) || 0,
        },
        basis: {
          errors: "error_logs, level<>'audit' (the admin_audit trail shares this table and is NOT an error)",
          window: 'counts over the last 24h / 7d; the recent list is the newest 30 rows regardless of age',
          silentFailures: "case_events event_type ending _SKIPPED/_FAILED/_DROPPED/_NO_OP, 7 days — identical to the /ops dashboard",
          truncation: 'message truncated to 180 chars, context to 240',
        },
      });
    } catch (err) {
      console.error('[admin/errors] failed:', err && err.message);
      return res.fail('Failed to load errors', 500, 'ERRORS_ERROR');
    }
  });

  return router;
};

// Exported for unit tests / reuse.
module.exports.isAllowedAdminEmail = isAllowedAdminEmail;
module.exports.SUPERADMIN_EMAIL = SUPERADMIN_EMAIL;
