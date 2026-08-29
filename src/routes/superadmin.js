// src/routes/superadmin.js
const express = require('express');
const { pool, queryOne, queryAll, execute, withTransaction } = require('../pg');
const { logErrorToDb } = require('../logger');
const { resyncComingSoon } = require('../services/services_coming_soon_sync');
const { randomUUID } = require('crypto');
const { requireRole } = require('../middleware');
const { isLaunchMarket } = require('../launch-market');
const { queueNotification, queueMultiChannelNotification, doctorNotify } = require('../notify');
const { getNotificationTitles } = require('../notify/notification_titles');
// Side issue #47 — sla_watcher.runSlaSweep was a no-op; callers below
// removed. case_sla_worker.runCaseSlaSweep is the canonical sweep.
const { logOrderEvent } = require('../audit');
const { computeSla } = require('../sla_status');
// NB: no longer used by POST /superadmin/orders/:id/mark-paid (that route's
// hand-rolled inline assign was replaced by caseLifecycle.markCasePaid →
// enqueueAutoAssign on 2026-08-17). Still used by the manual order-create form.
const { pickDoctorForOrder } = require('../assign');
const { recalcSlaBreaches } = require('../case_lifecycle'); // sla.js deleted, use case_lifecycle shim
const { randomUUID: uuidv4 } = require('crypto');
const { safeAll, safeGet, tableExists } = require('../sql-utils');
const { ensureConversation } = require('./messaging');
const caseLifecycle = require('../case_lifecycle');
const { fetchNotifications, countUnseenNotifications, markAllNotificationsRead, normalizeNotification } = require('../utils/notifications');
const emailService = require('../services/emailService');
const { logAdminAudit } = require('../services/admin_audit');
const { bulkWelcomePasswordlessDoctors, DEFAULT_COOLDOWN_HOURS: BULK_WELCOME_COOLDOWN_HOURS } = require('../services/admin_doctor_bulk_invite');
const { assertRenderableView } = require('../renderGuard');
const { inviteDoctor } = require('../services/admin_doctor_invite');
const { WELCOME_EXPIRY_HOURS, SERVICES_READY_SQL } = require('../services/doctor_welcome_payload');
const rateLimit = require('express-rate-limit');
const adminSettings = require('../services/admin_settings');
const superadminDashboard = require('../services/superadmin_dashboard');
const { getAiHealth } = require('../services/ai_health');
// Theme 14 Phase 5 — manual-queue approve flow re-engages auto-assign +
// broadcast once admin clears the manual_queue state.
const { enqueueAutoAssign } = require('../job_queue');
const { broadcastOrderToSpecialty } = require('../notify/broadcast');
const { sendCriticalAlert } = require('../critical-alert');
// Refund ceiling — the single source of truth for "how much of this order may
// be returned to the patient". See services/refund_eligibility.maxRefundableEgp.
const { maxRefundableEgp } = require('../services/refund_eligibility');
// Refund → orders.payment_status. Shared with the Command API's mark-paid
// (routes/api/admin.js → services/admin_refund_mark_paid.setRefundPaid) so the
// two mark-paid surfaces cannot diverge on when an order becomes 'refunded'.
const { applyRefundedPaymentStatus } = require('../services/admin_refund_mark_paid');
// Mailer helpers shared with routes/campaigns.js (do not duplicate — see the
// "Used by:" comments above each function definition in campaigns.js).
const { populateRecipients, processCampaign } = require('./campaigns');
// Sanitizers shared with routes/campaigns.js. Same source module to avoid
// drift on input validation.
const { sanitizeHtml, sanitizeString } = require('../validators/sanitize');
const getStatusUi = caseLifecycle.getStatusUi || caseLifecycle;
const toCanonStatus = caseLifecycle.toCanonStatus;
const canonicalizeStatus =
  typeof toCanonStatus === 'function' ? toCanonStatus : caseLifecycle.normalizeStatus;
const dbStatusValuesFor = caseLifecycle.dbStatusValuesFor;

const router = express.Router();

const requireSuperadmin = requireRole('superadmin');

// Package 2 (T28 send-side): per-IP limiter for the welcome-SEND surfaces
// (resend-welcome + bulk-welcome). Superadmin-gated defense-in-depth — caps a
// scripted/compromised operator; sits AFTER requireSuperadmin so only
// authenticated requests count. Sized PER-OPERATOR (10 sends / 15 min per IP),
// NOT per-doctor: the bulk route is ONE request that invites the whole cohort
// internally, so a 28-doctor batch is a SINGLE limiter tick — never throttled.
const welcomeSendIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, validate: false,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'too_many_requests' },
});

const IS_PROD = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

// Mirrors src/routes/auth.js portal flow — keep in sync. AUDIT-2026-08-23: the
// only consumer left in this file is the manual /superadmin debug reset-link
// tool; "Create Doctor" no longer mints its own token at all (it delegates to
// services/admin_doctor_invite, which uses the 7-day WELCOME_EXPIRY_HOURS).
const RESET_EXPIRY_HOURS = 2;     // forgot-password / manual reset — user is actively requesting, short window
// P1-NOTIF-5: doctor approval + admin-created doctor first-time setup —
// recipient is passive (didn't request the email), may not check inbox
// for days. 7 days matches industry-standard onboarding email expiry.
// WELCOME_EXPIRY_HOURS is single-sourced from ../services/doctor_welcome_payload
// (imported at the top — Task 25); do NOT redeclare it here.

// Defaults for alerts badge on superadmin pages.
router.use((req, res, next) => {
  res.locals.unseenAlertsCount = 0;
  res.locals.alertsUnseenCount = 0;
  res.locals.hasUnseenAlerts = false;
  return next();
});

// Unseen alerts count (superadmin only).
router.use(async (req, res, next) => {
  try {
    const user = req.user;
    if (!user || String(user.role || '') !== 'superadmin') return next();
    const count = await countSuperadminUnseenNotifications(user.id, user.email || '');
    res.locals.unseenAlertsCount = count;
    res.locals.alertsUnseenCount = count;
    res.locals.hasUnseenAlerts = count > 0;
  } catch (_) {
    res.locals.unseenAlertsCount = 0;
    res.locals.alertsUnseenCount = 0;
    res.locals.hasUnseenAlerts = false;
  }
  return next();
});

// Sidebar badges + topbar pills — plumb both into res.locals so every view
// rendered through this router gets the chrome data automatically via the
// EJS locals merge. Without this only the dashboard route called these
// explicitly, leaving every other page with empty badges + missing topbar
// pills. Both services cache for 30s internally (see getCached), so this
// middleware costs at most one DB roundtrip pair per 30s per process.
// Skipped on non-GET requests since POSTs redirect and never render chrome.
router.use(async (req, res, next) => {
  if (req.method !== 'GET') return next();
  try {
    const user = req.user;
    if (!user || String(user.role || '') !== 'superadmin') return next();
    const [badges, pills] = await Promise.all([
      superadminDashboard.getSidebarBadges().catch(() => ({})),
      superadminDashboard.getStatusPills().catch(() => [])
    ]);
    res.locals.sidebarBadges = badges;
    res.locals.pills = pills;
  } catch (_) {
    res.locals.sidebarBadges = {};
    res.locals.pills = [];
  }
  return next();
});

function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getLang(req, res) {
  const l =
    (res && res.locals && res.locals.lang) ||
    (req && req.query && req.query.lang) ||
    (req && req.session && req.session.lang) ||
    (req && req.user && req.user.lang) ||
    'en';
  return String(l).toLowerCase() === 'ar' ? 'ar' : 'en';
}

function t(lang, enText, arText) {
  return String(lang).toLowerCase() === 'ar' ? arText : enText;
}

// ---- Superadmin alerts (in-app notifications) ----

// AUDIT (2026-08-17) — see the note on getNotificationTitles below: the bell
// titles carry {caseReference}-style placeholders and need the notification's
// stored payload as `vars`, or every placeholder renders empty. Parse
// defensively: `response` is TEXT that sometimes holds a worker debug payload.
function parseNotificationVars(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch (_) {
    return null;
  }
}

async function getNotificationTableColumns() {
  try {
    const cols = await queryAll(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
      ['notifications']
    );
    return Array.isArray(cols) ? cols.map((c) => c.column_name) : [];
  } catch (_) {
    return [];
  }
}

function pickNotificationTimestampColumn(cols) {
  const c = cols || [];
  if (c.includes('at')) return 'at';
  if (c.includes('created_at')) return 'created_at';
  if (c.includes('timestamp')) return 'timestamp';
  return null;
}

async function fetchSuperadminNotifications(userId, userEmail = '', limit = 50) {
  const cols = await getNotificationTableColumns();
  const tsCol = pickNotificationTimestampColumn(cols);
  if (!tsCol) return [];

  const hasUserId = cols.includes('user_id');
  const hasToUserId = cols.includes('to_user_id');
  if (!hasUserId && !hasToUserId) return [];

  const where = [];
  const params = [];
  let paramIdx = 1;
  if (hasUserId) {
    where.push(`user_id = $${paramIdx++}`);
    params.push(String(userId));
  }
  if (hasToUserId) {
    where.push(`to_user_id = $${paramIdx++}`);
    params.push(String(userId));
    const email = String(userEmail || '').trim();
    if (email) {
      where.push(`to_user_id = $${paramIdx++}`);
      params.push(email);
    }
  }

  const selectCols = [
    'id',
    cols.includes('order_id') ? 'order_id' : null,
    cols.includes('channel') ? 'channel' : null,
    cols.includes('template') ? 'template' : null,
    cols.includes('status') ? 'status' : null,
    cols.includes('is_read') ? 'is_read' : null,
    cols.includes('response') ? 'response' : null,
    tsCol
  ].filter(Boolean);

  const sql = `SELECT ${selectCols.join(', ')} FROM notifications WHERE (${where.join(' OR ')}) ORDER BY ${tsCol} DESC, id DESC LIMIT $${paramIdx}`;
  params.push(Number(limit));
  try {
    return await queryAll(sql, params);
  } catch (_) {
    return [];
  }
}

async function countSuperadminUnseenNotifications(userId, userEmail = '') {
  try {
    const cols = await getNotificationTableColumns();
    const hasUserId = cols.includes('user_id');
    const hasToUserId = cols.includes('to_user_id');
    if (!hasUserId && !hasToUserId) return 0;

    const where = [];
    const params = [];
    let paramIdx = 1;
    if (hasUserId) {
      where.push(`user_id = $${paramIdx++}`);
      params.push(String(userId));
    }
    if (hasToUserId) {
      where.push(`to_user_id = $${paramIdx++}`);
      params.push(String(userId));
      const email = String(userEmail || '').trim();
      if (email) {
        where.push(`to_user_id = $${paramIdx++}`);
        params.push(email);
      }
    }

    const ownerClause = `(${where.join(' OR ')})`;

    if (cols.includes('is_read')) {
      const row = await queryOne(
        `SELECT COUNT(*) as c FROM notifications WHERE ${ownerClause} AND COALESCE(is_read, false) = false`,
        params
      );
      return row ? Number(row.c) : 0;
    }

    if (cols.includes('status')) {
      const row = await queryOne(
        `SELECT COUNT(*) as c FROM notifications WHERE ${ownerClause} AND COALESCE(LOWER(status), '') NOT IN ('seen','read')`,
        params
      );
      return row ? Number(row.c) : 0;
    }
  } catch (_) {
    return 0;
  }

  return 0;
}

function normalizeSuperadminNotification(row) {
  const id = row && row.id != null ? String(row.id) : '';
  const orderId = row && row.order_id != null ? String(row.order_id) : '';
  const template = row && row.template != null ? String(row.template) : '';
  const rawStatus = row && row.status != null ? String(row.status) : '';
  const isReadVal = row && row.is_read != null ? row.is_read : null;

  const status = (isReadVal === true || isReadVal === 1)
    ? 'seen'
    : (String(rawStatus || '').toLowerCase() === 'read')
      ? 'seen'
      : (rawStatus && rawStatus.trim())
        ? rawStatus
        : 'queued';
  const response = row && row.response != null ? String(row.response) : '';
  const at = row && (row.at || row.created_at || row.timestamp) ? String(row.at || row.created_at || row.timestamp) : '';

  const message = (response && response.trim())
    ? response
    : (template && template.trim())
      ? template
      : 'Notification';

  const titles = getNotificationTitles(template, parseNotificationVars(response));

  return {
    id,
    orderId,
    order_id: orderId,
    status,
    at,
    message,
    template,
    title_en: titles.title_en,
    title_ar: titles.title_ar,
    href: orderId ? `/superadmin/orders/${orderId}` : ''
  };
}

async function markAllSuperadminNotificationsRead(userId, userEmail = '') {
  const cols = await getNotificationTableColumns();
  const hasUserId = cols.includes('user_id');
  const hasToUserId = cols.includes('to_user_id');
  if (!hasUserId && !hasToUserId) return { ok: false, reason: 'no_user_column' };

  const where = [];
  const params = [];
  let paramIdx = 1;
  if (hasUserId) {
    where.push(`user_id = $${paramIdx++}`);
    params.push(String(userId));
  }
  if (hasToUserId) {
    where.push(`to_user_id = $${paramIdx++}`);
    params.push(String(userId));
    const email = String(userEmail || '').trim();
    if (email) {
      where.push(`to_user_id = $${paramIdx++}`);
      params.push(email);
    }
  }
  const ownerClause = `(${where.join(' OR ')})`;

  if (cols.includes('is_read')) {
    try {
      const r = await execute(
        `UPDATE notifications SET is_read = true${cols.includes('status') ? ", status = 'seen'" : ''} WHERE ${ownerClause} AND COALESCE(is_read, false) = false`,
        params
      );
      return { ok: true, mode: 'is_read', changes: (r && r.rowCount) ? r.rowCount : 0 };
    } catch (_) {
      return { ok: false, reason: 'update_failed' };
    }
  }

  if (cols.includes('status')) {
    try {
      const r = await execute(
        `UPDATE notifications SET status = 'seen' WHERE ${ownerClause} AND COALESCE(LOWER(status), '') NOT IN ('seen','read')`,
        params
      );
      return { ok: true, mode: 'status', changes: (r && r.rowCount) ? r.rowCount : 0 };
    } catch (_) {
      return { ok: false, reason: 'update_failed' };
    }
  }

  return { ok: false, reason: 'no_read_mechanism' };
}

router.get('/superadmin/alerts', requireSuperadmin, async (req, res) => {
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';
  const userId = req.user && req.user.id ? String(req.user.id) : '';
  const userEmail = req.user && req.user.email ? String(req.user.email).trim() : '';

  const raw = await fetchSuperadminNotifications(userId, userEmail, 50);
  const alerts = (raw || []).map(normalizeSuperadminNotification);

  try {
    if (userId) {
      await markAllSuperadminNotificationsRead(userId, userEmail);
      res.locals.unseenAlertsCount = 0;
      res.locals.alertsUnseenCount = 0;
      res.locals.hasUnseenAlerts = false;
      alerts.forEach((a) => {
        if (a && a.status && String(a.status).toLowerCase() !== 'seen') a.status = 'seen';
      });
    }
  } catch (_) {
    // non-blocking
  }

  return res.render('superadmin_alerts', {
    brand: 'Tashkheesa',
    aiHealth: await getAiHealth(),
    user: req.user,
    lang,
    dir: isAr ? 'rtl' : 'ltr',
    isAr,
    activeTab: 'alerts',
    nextPath: '/superadmin/alerts',
    alerts: Array.isArray(alerts) ? alerts : [],
    notifications: Array.isArray(alerts) ? alerts : []
  });
});

// ---- Superadmin settings — umbrella settings page (Theme 14 Phase 4) ----
//
// Single page today (the classifier thresholds section), but structured as
// an umbrella index so future settings sections can land without a new
// route. Reads/writes admin_settings rows (key/value/updated_by/updated_at
// PK on key) seeded by migration 061, and calls
// src/services/admin_settings.js invalidateCache() after a successful
// write so the admin sees their edit immediately on the next page render
// without waiting for the 60s TTL.

const CLASSIFIER_THRESHOLD_KEYS = Object.freeze([
  'classifier_threshold_locked',
  'classifier_threshold_auto',
  'classifier_threshold_minimum'
]);

// ─── Classifier learning ────────────────────────────────────────────────────
//
// 2026-08-25. specialty_classification_overrides has recorded, for every case,
// what the AI picked against what a human actually picked — since migration
// 056/058, written from the patient wizard, admin triage and here. Nothing had
// ever read it back.
//
// This screen is where that data becomes a decision. The nightly job
// (job_queue: classifier-learning) only ever produces CANDIDATES. Nothing is
// put in front of the model until a superadmin accepts one here, and accepted
// corrections are shown to it as observed history rather than as rules.
//
// Deliberately a review queue and not an automatic pipeline: a system silently
// rewriting how patients' cases route is not something anyone should have to
// discover from a support ticket.
router.get('/superadmin/classifier', requireSuperadmin, async (req, res) => {
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';

  let candidates = [];
  let accepted = [];
  let accuracy = null;
  try {
    const learning = require('../services/classifier_learning');
    candidates = await queryAll(
      `SELECT c.*, fs.name AS from_specialty_name, ts.name AS to_specialty_name,
              fsv.name AS from_service_name, tsv.name AS to_service_name
         FROM classifier_corrections c
         LEFT JOIN specialties fs  ON fs.id  = c.from_specialty_id
         LEFT JOIN specialties ts  ON ts.id  = c.to_specialty_id
         LEFT JOIN services    fsv ON fsv.id = c.from_service_id
         LEFT JOIN services    tsv ON tsv.id = c.to_service_id
        WHERE c.status = 'candidate'
        ORDER BY c.weighted_score DESC
        LIMIT 50`
    );
    accepted = await queryAll(
      `SELECT c.*, fs.name AS from_specialty_name, ts.name AS to_specialty_name,
              fsv.name AS from_service_name, tsv.name AS to_service_name
         FROM classifier_corrections c
         LEFT JOIN specialties fs  ON fs.id  = c.from_specialty_id
         LEFT JOIN specialties ts  ON ts.id  = c.to_specialty_id
         LEFT JOIN services    fsv ON fsv.id = c.from_service_id
         LEFT JOIN services    tsv ON tsv.id = c.to_service_id
        WHERE c.status = 'accepted'
        ORDER BY c.weighted_score DESC
        LIMIT 50`
    );
    accuracy = await learning.getAccuracyStats();
  } catch (err) {
    // The table may not exist yet on a clone that has not run migration 095.
    // An empty screen is the right degradation — this page steers nothing on
    // its own, so failing to render it costs a review, not a patient.
    logErrorToDb(err, {
      context: 'superadmin.classifier_get',
      requestId: req.requestId,
      userId: req.user && req.user.id,
      url: req.originalUrl,
      method: req.method,
      category: 'superadmin_action'
    });
  }

  return res.render('superadmin_classifier', {
    brand: 'Tashkheesa',
    aiHealth: await getAiHealth(),
    user: req.user,
    lang,
    dir: isAr ? 'rtl' : 'ltr',
    isAr,
    activeTab: 'settings',
    nextPath: '/superadmin/classifier',
    candidates,
    accepted,
    accuracy,
    saved: req.query && req.query.saved ? String(req.query.saved) : null
  });
});

// Accept or reject one candidate. This is the only thing that can put a
// correction in front of the classifier, or take one away.
router.post('/superadmin/classifier/review', requireSuperadmin, async (req, res) => {
  const id = req.body && req.body.id ? String(req.body.id).trim() : '';
  const decision = req.body && req.body.decision === 'accept' ? 'accept' : 'reject';
  if (!id) return res.redirect('/superadmin/classifier');

  try {
    const learning = require('../services/classifier_learning');
    await learning.reviewCorrection(id, decision, req.user && req.user.id, null);
    // Audited like any other superadmin action that changes platform behaviour
    // — accepting a correction changes how every subsequent case is routed.
    try {
      logAdminAudit({
        req,
        action: 'classifier_correction_' + (decision === 'accept' ? 'accepted' : 'rejected'),
        target: id,
        // Explicit message: the helper's default is the hardcoded string
        // "viewed payout data: <target>", which would file a change to how
        // every future case is routed as a page view. An audit line that
        // misdescribes what happened is worse than none, because it is believed.
        message: 'classifier correction ' + (decision === 'accept'
          ? 'ACCEPTED — now shown to the classifier on every case'
          : 'REJECTED — removed from the classifier prompt')
      });
    } catch (_) { /* audit failure must not block the decision */ }
  } catch (err) {
    logErrorToDb(err, {
      context: 'superadmin.classifier_review',
      requestId: req.requestId,
      userId: req.user && req.user.id,
      url: req.originalUrl,
      method: req.method,
      category: 'superadmin_action'
    });
    return res.redirect('/superadmin/classifier');
  }
  return res.redirect('/superadmin/classifier?saved=1');
});

router.get('/superadmin/settings', requireSuperadmin, async (req, res) => {
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';

  // Read directly (NOT via adminSettings.getThresholds()) so we can surface
  // the updated_by / updated_at audit metadata, which the helper hides.
  let rows = [];
  try {
    rows = await queryAll(
      `SELECT key, value, updated_by, updated_at FROM admin_settings
       WHERE key = ANY($1::text[])`,
      [Array.from(CLASSIFIER_THRESHOLD_KEYS)]
    );
  } catch (err) {
    logErrorToDb(err, {
      context: 'superadmin.settings_get',
      requestId: req.requestId,
      userId: req.user && req.user.id,
      url: req.originalUrl,
      method: req.method,
      category: 'superadmin_action'
    });
  }
  const byKey = {};
  for (const r of (rows || [])) byKey[r.key] = r;

  // 2026-08-25 — auto-assign. This flag has existed since June and has been
  // 'false' the whole time, with NO route or view anywhere that writes it: the
  // only way to turn automatic case assignment on was a hand-written SQL
  // UPDATE against production. A switch that decides whether paid cases reach
  // a doctor should not live in a psql session.
  let autoAssign = null;
  try {
    autoAssign = await queryOne(
      `SELECT key, value, updated_by, updated_at FROM admin_settings
        WHERE key = 'auto_assign_enabled'`
    );
  } catch (_) { autoAssign = null; }
  const autoAssignOn = (function () {
    const v = String((autoAssign && autoAssign.value) || '').toLowerCase().trim();
    // Mirrors isAutoAssignEnabled() in src/auto_assign.js exactly — if the two
    // ever disagree the page would show a state the engine does not act on.
    return v === 'true' || v === '1' || v === 'yes';
  })();

  // Readiness context, so the toggle is not a switch in the dark. Turning
  // auto-assign on when nothing downstream works produces silent failures that
  // look exactly like it being off; the operator should see that first.
  //
  // Counted at SERVICE level, not specialty level — a correction from review.
  // The first version asked "does this specialty have any eligible doctor with
  // any doctor_services row", but eligibleDoctorsFor gates on the ORDER'S
  // service (auto_assign.js: ds.service_id = $3). Cardiology has three eligible
  // doctors mapped to 9 of its 11 services, so the specialty-level question
  // answered "staffed" while an order on Event Monitor Review or Pre-Op Cardiac
  // Clearance still had nobody and fell straight into the manual queue. A
  // readiness panel that misses exactly the cases it exists to warn about is
  // worse than no panel.
  let autoAssignReadiness = null;
  try {
    const r = await queryOne(
      `WITH eligible AS (
         SELECT u.id, u.specialty_id
           FROM users u
          WHERE u.role = 'doctor'
            AND COALESCE(u.is_active, true) = true
            AND COALESCE(u.is_paused, false) = false
            AND COALESCE(u.pending_approval, false) = false
            AND COALESCE(u.onboarding_complete, false) = true
            AND u.specialty_id IS NOT NULL
       ),
       bookable AS (
         SELECT sv.id, sv.specialty_id
           FROM services sv
           JOIN specialties sp ON sp.id = sv.specialty_id
          WHERE COALESCE(sv.is_visible, true) = true
            AND COALESCE(sv.coming_soon, false) = false
            AND COALESCE(sp.is_visible, true) = true
       ),
       covered AS (
         SELECT b.id, b.specialty_id,
                EXISTS (
                  SELECT 1 FROM doctor_services ds
                    JOIN eligible e ON e.id = ds.doctor_id
                   WHERE ds.service_id = b.id
                     AND e.specialty_id = b.specialty_id
                ) AS has_doctor
           FROM bookable b
       )
       SELECT
         (SELECT count(*) FROM eligible e
           WHERE EXISTS (SELECT 1 FROM doctor_services ds WHERE ds.doctor_id = e.id)
         ) AS assignable_doctors,
         (SELECT count(*) FROM covered) AS bookable_services,
         (SELECT count(*) FROM covered WHERE NOT has_doctor) AS uncovered_services,
         (SELECT count(DISTINCT specialty_id) FROM covered WHERE NOT has_doctor) AS specialties_with_gaps,
         -- Only orders that are genuinely still waiting. orders_active is just
         -- "not soft-deleted" — no status and no payment filter — so the first
         -- version's count included an expired_unpaid order and would have
         -- permanently counted every cancelled or refunded case that ever
         -- passed through the queue.
         (SELECT count(*) FROM orders_active o
           WHERE o.assignment_status IN ('manual_queue', 'manual_pending')
             AND o.doctor_id IS NULL
             AND LOWER(COALESCE(o.payment_status, '')) IN ('paid', 'captured')
             AND LOWER(COALESCE(o.status, '')) NOT IN
                 ('completed', 'cancelled', 'canceled', 'refunded', 'expired_unpaid', 'rejected')
         ) AS awaiting_manual`
    );
    autoAssignReadiness = r || null;
  } catch (_) { autoAssignReadiness = null; }

  return res.render('superadmin_settings', {
    brand: 'Tashkheesa',
    user: req.user,
    lang,
    dir: isAr ? 'rtl' : 'ltr',
    isAr,
    nextPath: '/superadmin/settings',
    thresholds: {
      locked:  byKey.classifier_threshold_locked  || null,
      auto:    byKey.classifier_threshold_auto    || null,
      minimum: byKey.classifier_threshold_minimum || null
    },
    defaults: adminSettings.DEFAULTS,
    autoAssign,
    autoAssignOn,
    autoAssignReadiness,
    // The confirmation banner is shown only when the query string AND the
    // stored value agree. Review round 2: deriving it from the query string
    // alone meant GET /superadmin/settings?autoassign=on rendered a green
    // "Automatic assignment is on" directly above a status pill reading OFF —
    // reachable by bookmarking the post-save URL, re-sharing it, or reloading
    // it after someone else switched the flag back. A banner that contradicts
    // the state one line below it is worse than no banner.
    autoAssignSavedTo: (req.query && req.query.autoassign === 'on'  && autoAssignOn)  ? 'on'
                     : (req.query && req.query.autoassign === 'off' && !autoAssignOn) ? 'off'
                     : null,
    saved: !!(req.query && req.query.saved === '1'),
    queryErr: (req.query && typeof req.query.err === 'string') ? req.query.err : ''
  });
});

router.post('/superadmin/settings', requireSuperadmin, async (req, res) => {
  const body = req.body || {};
  const updates = [];
  const errors = [];

  // Validation per Ziad Q (light validation): each value must parse to a
  // finite number in [0, 1]. Hard reject NaN / non-finite / out-of-range.
  // The locked > auto > minimum ordering is a SOFT warning rendered by the
  // view; not enforced here (defer hard ordering checks per brief scope).
  for (const key of CLASSIFIER_THRESHOLD_KEYS) {
    const raw = body[key];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      errors.push(key + ':missing');
      continue;
    }
    const parsed = Number(raw);
    if (!isFinite(parsed) || parsed < 0 || parsed > 1) {
      errors.push(key + ':invalid');
      continue;
    }
    updates.push({ key: key, value: String(parsed) });
  }

  if (errors.length > 0) {
    return res.redirect('/superadmin/settings?err=' + encodeURIComponent(errors.join(',')));
  }

  const userId = req.user && req.user.id ? String(req.user.id) : null;
  try {
    await withTransaction(async (client) => {
      for (const u of updates) {
        await client.query(
          `INSERT INTO admin_settings (key, value, updated_by, updated_at)
             VALUES ($1, $2, $3, NOW())
           ON CONFLICT (key) DO UPDATE
             SET value = EXCLUDED.value,
                 updated_by = EXCLUDED.updated_by,
                 updated_at = EXCLUDED.updated_at`,
          [u.key, u.value, userId]
        );
      }
    });
    adminSettings.invalidateCache();
  } catch (err) {
    logErrorToDb(err, {
      context: 'superadmin.settings_post',
      requestId: req.requestId,
      userId: userId,
      url: req.originalUrl,
      method: req.method,
      category: 'superadmin_action'
    });
    return res.redirect('/superadmin/settings?err=write_failed');
  }

  return res.redirect('/superadmin/settings?saved=1');
});

// POST /superadmin/settings/auto-assign — turn automatic case assignment on or off.
//
// 2026-08-25. admin_settings.auto_assign_enabled has been 'false' since
// 2026-06-01 and NOTHING in the codebase wrote it — the only way to change it
// was a manual SQL UPDATE against production. That is the switch deciding
// whether a paid case is routed to a doctor automatically or sits waiting for
// somebody to notice, so it belongs on a page with an audit trail.
//
// Separate route from POST /superadmin/settings on purpose: that handler
// requires all three classifier thresholds to be present and rejects the whole
// submission if any is missing, so folding a checkbox into the same form would
// couple two unrelated settings and make each one able to block the other.
//
// Checkbox semantics: an unchecked box submits NOTHING, so absence means off.
// The explicit intent field distinguishes "the operator submitted this form and
// left it unchecked" from "something posted here with no body at all" — without
// it, a malformed request would read as a deliberate disable.
router.post('/superadmin/settings/auto-assign', requireSuperadmin, async (req, res) => {
  const body = req.body || {};
  if (String(body.intent || '') !== 'set_auto_assign') {
    return res.redirect('/superadmin/settings?err=auto_assign_bad_request');
  }

  const enable = String(body.auto_assign_enabled || '') === 'on';
  const userId = req.user && req.user.id ? String(req.user.id) : null;

  try {
    // Written as the literal 'true' / 'false' text isAutoAssignEnabled() parses
    // (src/auto_assign.js also accepts '1' and 'yes', but one canonical spelling
    // in the table beats three).
    await execute(
      `INSERT INTO admin_settings (key, value, updated_by, updated_at)
            VALUES ('auto_assign_enabled', $1, $2, NOW())
       ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value,
                updated_by = EXCLUDED.updated_by,
                updated_at = EXCLUDED.updated_at`,
      [enable ? 'true' : 'false', userId]
    );
  } catch (err) {
    logErrorToDb(err, {
      context: 'superadmin.auto_assign_toggle',
      requestId: req.requestId,
      userId: userId,
      url: req.originalUrl,
      method: req.method,
      category: 'superadmin_action'
    });
    return res.redirect('/superadmin/settings?err=auto_assign_write_failed');
  }

  // Audit separately from the row's own updated_by: that column holds only the
  // LAST writer, so a flag flipped on and off again leaves no trace of the
  // first change. This is a routing-behaviour switch — the history matters.
  try {
    logAdminAudit({
      req,
      action: enable ? 'auto_assign_enabled' : 'auto_assign_disabled',
      target: 'admin_settings.auto_assign_enabled',
      // Explicit message: the helper's default is the hardcoded string
      // "viewed payout data: <target>", which would have filed this flag flip
      // as a page view. An audit line that misdescribes what happened is worse
      // than none, because it gets believed.
      message: 'automatic case assignment turned ' + (enable ? 'ON' : 'OFF')
    });
  } catch (_) {}

  return res.redirect('/superadmin/settings?autoassign=' + (enable ? 'on' : 'off'));
});

// ---- Superadmin services visibility toggles (hide/unhide) ----

async function getServicesTableColumns() {
  try {
    const cols = await queryAll(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
      ['services']
    );
    return Array.isArray(cols) ? cols.map((c) => c.column_name) : [];
  } catch (_) {
    return [];
  }
}

async function ensureServicesVisibilityColumn() {
  // Adds services.is_visible if it doesn't exist.
  // Note: PostgreSQL will set existing rows to NULL, so we backfill to true.
  const cols = await getServicesTableColumns();
  if (cols.includes('is_visible')) return true;

  try {
    await execute("ALTER TABLE services ADD COLUMN is_visible BOOLEAN DEFAULT true");
    try {
      await execute("UPDATE services SET is_visible = true WHERE is_visible IS NULL");
    } catch (_) {
      // non-blocking
    }
    return true;
  } catch (_) {
    return false;
  }
}

async function setServiceVisibility(serviceId, isVisible) {
  if (!(await ensureServicesVisibilityColumn())) {
    return { ok: false, reason: 'missing_is_visible_column' };
  }

  try {
    const r = await execute(
      'UPDATE services SET is_visible = $1 WHERE id = $2',
      [isVisible ? true : false, String(serviceId)]
    );
    return { ok: true, changes: r && r.rowCount ? r.rowCount : 0 };
  } catch (_) {
    return { ok: false, reason: 'update_failed' };
  }
}

// ---- Service country pricing helper ----
function fetchServiceCountryPricing() {
  return safeAll(
    `SELECT scp.service_id,
            scp.country_code,
            scp.tashkheesa_price AS price,
            scp.currency,
            s.name AS service_name,
            s.specialty_id
     FROM service_regional_prices scp
     JOIN services s ON s.id = scp.service_id
     WHERE scp.country_code != 'EG'
     ORDER BY s.name ASC, scp.country_code ASC`,
    [],
    []
  );
}

router.post('/superadmin/services/:id/hide', requireSuperadmin, async (req, res) => {
  const id = req.params && req.params.id ? String(req.params.id) : '';
  if (id) await setServiceVisibility(id, false);
  return res.redirect('/superadmin/services');
});

router.post('/superadmin/services/:id/unhide', requireSuperadmin, async (req, res) => {
  const id = req.params && req.params.id ? String(req.params.id) : '';
  if (id) await setServiceVisibility(id, true);
  return res.redirect('/superadmin/services');
});

router.post('/superadmin/services/:id/toggle-visibility', requireSuperadmin, async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.redirect('/superadmin/services');

  try {
    await ensureServicesVisibilityColumn();
    await execute(
      `UPDATE services
       SET is_visible = CASE WHEN COALESCE(is_visible, true) = true THEN false ELSE true END
       WHERE id = $1`,
      [id]
    );
  } catch (_) {
    // non-blocking
  }

  return res.redirect('/superadmin/services');
});

// ---- Superadmin services page ----
router.get('/superadmin/services', requireSuperadmin, async (req, res) => {
  const services = await safeAll(
    `SELECT sv.id, sv.name, sv.code, sv.is_visible,
            sp.name AS specialty_name
     FROM services sv
     LEFT JOIN specialties sp ON sp.id = sv.specialty_id
     ORDER BY specialty_name ASC, sv.name ASC`,
    [],
    []
  );

  return res.render('superadmin_services', {
    user: req.user,
    services
  });
});

// ─── REGIONAL PRICING ─────────────────────────────────────────────────
// Forked from src/routes/admin.js:2438 (GET), 2488 (export), 2526 (update),
// 2581 (bulk-activate). requirePayoutViewer in admin.js = requireRole('superadmin'),
// so the role gate is identical here.

router.get('/superadmin/pricing', requireSuperadmin, async (req, res) => {
  logAdminAudit({ req, action: 'viewed_payout_data', target: '/superadmin/pricing' });
  try {
    const lang = (res.locals && res.locals.lang) || 'en';
    const isAr = lang === 'ar';
    let countryCode = String(req.query.country || 'EG').trim().toUpperCase();
    const department = String(req.query.department || '').trim();

    const validCountries = ['EG', 'SA', 'AE', 'GB', 'US'];
    if (!validCountries.includes(countryCode)) countryCode = 'EG';

    let query = `
      SELECT srp.*, s.name as service_name, s.specialty_id, sp.name as specialty_name
      FROM service_regional_prices srp
      LEFT JOIN services s ON s.id = srp.service_id
      LEFT JOIN specialties sp ON sp.id = s.specialty_id
      WHERE srp.country_code = $1
    `;
    const params = [countryCode];
    let paramIdx = 2;
    if (department) {
      query += ` AND s.specialty_id = $${paramIdx++}`;
      params.push(department);
    }
    query += ' ORDER BY s.specialty_id, s.name';

    const prices = await safeAll(query, params, []);
    const departments = await safeAll('SELECT DISTINCT id, name FROM specialties ORDER BY name', [], []);

    res.render('superadmin_pricing', {
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
      prices, departments,
      selectedCountry: countryCode,
      selectedDepartment: department,
      lang, isAr,
      user: req.user
    });
  } catch (err) {
    return res.status(500).send('Server error: ' + err.message);
  }
});

router.get('/superadmin/pricing/export', requireSuperadmin, async (req, res) => {
  logAdminAudit({ req, action: 'viewed_payout_data', target: '/superadmin/pricing/export' });
  try {
    const countryCode = String(req.query.country || 'EG').trim().toUpperCase();
    const prices = await safeAll(
      `SELECT srp.*, s.name as service_name, s.specialty_id, sp.name as specialty_name
         FROM service_regional_prices srp
         LEFT JOIN services s ON s.id = srp.service_id
         LEFT JOIN specialties sp ON sp.id = s.specialty_id
        WHERE srp.country_code = $1
        ORDER BY s.specialty_id, s.name`,
      [countryCode], []
    );
    let csv = 'Service ID,Service Name,Specialty,Hospital Cost,Tashkheesa Price,Doctor Commission,Currency,Status,Notes\n';
    prices.forEach(function(p) {
      csv += [
        p.service_id,
        '"' + (p.service_name || '').replace(/"/g, '""') + '"',
        '"' + (p.specialty_name || '').replace(/"/g, '""') + '"',
        p.hospital_cost != null ? p.hospital_cost : '',
        p.tashkheesa_price != null ? p.tashkheesa_price : '',
        p.doctor_commission != null ? p.doctor_commission : '',
        p.currency,
        p.status,
        '"' + (p.notes || '').replace(/"/g, '""') + '"'
      ].join(',') + '\n';
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=pricing_' + countryCode + '.csv');
    return res.send(csv);
  } catch (err) {
    return res.status(500).send('Export error');
  }
});

// PRICING MULTIPLIER POLICY — three copies kept in sync:
//   1. This handler (server source of truth)        — Math.ceil(hc * 1.15), Math.ceil(tp * 0.20) below
//   2. src/routes/admin.js:2542-2543 (legacy admin) — same constants
//   3. src/views/superadmin_pricing.ejs inline JS   — same constants for UI auto-preview
// Grep on "1.15" or "0.20" finds all three. If pricing policy changes (bulk
// adjustment, zone-specific overrides, etc.), update every site.
router.post('/superadmin/pricing/:id/update', requireSuperadmin, async (req, res) => {
  try {
    const priceId = String(req.params.id).trim();
    const hospitalCost = req.body.hospital_cost;
    const status = String(req.body.status || '').trim();
    const notes = String(req.body.notes || '').trim();

    const validStatuses = ['active', 'needs_clarification', 'not_available', 'external', 'pending_pricing'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ ok: false, error: 'Invalid status' });
    }

    const existing = await safeGet('SELECT * FROM service_regional_prices WHERE id = $1', [priceId], null);
    if (!existing) return res.status(404).json({ ok: false, error: 'Not found' });

    const hc = (hospitalCost !== null && hospitalCost !== '' && hospitalCost !== undefined) ? Number(hospitalCost) : null;
    const tp = (hc !== null && !isNaN(hc)) ? Math.ceil(hc * 1.15) : null;
    const dc = (tp !== null) ? Math.ceil(tp * 0.20) : null;
    const now = new Date().toISOString();

    const sets = ['updated_at = $1'];
    const params = [now];
    let paramIdx = 2;
    sets.push(`hospital_cost = $${paramIdx++}`); params.push(hc);
    sets.push(`tashkheesa_price = $${paramIdx++}`); params.push(tp);
    sets.push(`doctor_commission = $${paramIdx++}`); params.push(dc);
    if (status) { sets.push(`status = $${paramIdx++}`); params.push(status); }
    if (notes !== undefined) { sets.push(`notes = $${paramIdx++}`); params.push(notes || null); }
    params.push(priceId);

    await execute('UPDATE service_regional_prices SET ' + sets.join(', ') + ` WHERE id = $${paramIdx}`, params);

    return res.json({
      ok: true,
      hospital_cost: hc,
      tashkheesa_price: tp,
      doctor_commission: dc
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/superadmin/pricing/bulk-activate', requireSuperadmin, async (req, res) => {
  try {
    const countryCode = String(req.body.country || 'EG').trim().toUpperCase();
    if (!isLaunchMarket(countryCode)) {  // LAUNCH GATE: cannot activate a deferred market's pricing
      return res.status(403).json({ ok: false, error: 'Non-launch market disabled - see src/launch-market.js' });
    }
    const result = await execute(
      "UPDATE service_regional_prices SET status = 'active', updated_at = $1 WHERE country_code = $2 AND status = 'pending_pricing' AND hospital_cost IS NOT NULL",
      [new Date().toISOString(), countryCode]
    );
    return res.json({ ok: true, updated: result.rowCount });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── EMAIL CAMPAIGNS ──────────────────────────────────────────────────
// Forked from src/routes/campaigns.js:51 onward. Reuses populateRecipients +
// processCampaign from campaigns.js (imported above) to keep mailer mechanics
// identical between admin and superadmin call sites.

router.get('/superadmin/campaigns', requireSuperadmin, async (req, res) => {
  try {
    const lang = (res.locals && res.locals.lang) || 'en';
    const isAr = lang === 'ar';
    const campaigns = await queryAll(
      'SELECT * FROM email_campaigns ORDER BY created_at DESC LIMIT 100', []
    );
    res.render('superadmin_campaigns', {
      campaigns, lang, isAr, user: req.user,
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || ''
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).send('Server error');
  }
});

router.get('/superadmin/campaigns/new', requireSuperadmin, async (req, res) => {
  const lang = (res.locals && res.locals.lang) || 'en';
  res.render('superadmin_campaign_new', {
    lang, isAr: lang === 'ar', user: req.user,
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || ''
  });
});

router.post('/superadmin/campaigns', requireSuperadmin, async (req, res) => {
  try {
    const lang = (res.locals && res.locals.lang) || 'en';
    const isAr = lang === 'ar';
    const name = sanitizeString(req.body.name || '', 200).trim();
    const subjectEn = sanitizeString(req.body.subject_en || '', 500).trim();
    const subjectAr = sanitizeString(req.body.subject_ar || '', 500).trim();
    const template = sanitizeHtml(sanitizeString(req.body.template || '', 50000));
    let targetAudience = sanitizeString(req.body.target_audience || 'all', 50).trim();
    const scheduledAt = sanitizeString(req.body.scheduled_at || '', 30).trim();

    if (!name || !subjectEn || !template) {
      return res.status(400).json({ ok: false, error: isAr ? 'الاسم والموضوع والقالب مطلوبة' : 'Name, subject, and template are required' });
    }
    const validAudiences = ['all', 'patients', 'doctors', 'completed_cases', 'inactive_30d'];
    if (!validAudiences.includes(targetAudience)) targetAudience = 'all';

    const id = randomUUID();
    const status = scheduledAt ? 'scheduled' : 'draft';
    const now = new Date().toISOString();

    await execute(
      `INSERT INTO email_campaigns (id, name, subject_en, subject_ar, template, target_audience, status, scheduled_at, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, name, subjectEn, subjectAr || null, template, targetAudience, status, scheduledAt || null, req.user.id, now]
    );

    const recipientCount = await populateRecipients(id, targetAudience);
    await execute('UPDATE email_campaigns SET total_recipients = $1 WHERE id = $2', [recipientCount, id]);

    return res.json({ ok: true, id, message: isAr ? 'تم إنشاء الحملة' : 'Campaign created', recipientCount });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.get('/superadmin/campaigns/:id', requireSuperadmin, async (req, res) => {
  try {
    const campaignId = String(req.params.id).trim();
    const lang = (res.locals && res.locals.lang) || 'en';
    const isAr = lang === 'ar';
    const campaign = await queryOne('SELECT * FROM email_campaigns WHERE id = $1', [campaignId]);
    if (!campaign) return res.status(404).send('Campaign not found');
    const recipients = await queryAll(
      'SELECT * FROM campaign_recipients WHERE campaign_id = $1 ORDER BY status, created_at LIMIT 200',
      [campaignId]
    );
    res.render('superadmin_campaign_detail', {
      campaign, recipients, lang, isAr, user: req.user,
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || ''
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).send('Server error');
  }
});

router.post('/superadmin/campaigns/:id/send', requireSuperadmin, async (req, res) => {
  try {
    const campaignId = String(req.params.id).trim();
    const campaign = await queryOne('SELECT * FROM email_campaigns WHERE id = $1', [campaignId]);
    if (!campaign) return res.status(404).json({ ok: false, error: 'Not found' });
    if (campaign.status === 'sent') return res.status(400).json({ ok: false, error: 'Campaign already sent' });

    await execute("UPDATE email_campaigns SET status = 'sending' WHERE id = $1", [campaignId]);
    setImmediate(function() {
      try { processCampaign(campaignId); } catch (_) { /* mailer handles its own errors */ }
    });
    return res.json({ ok: true, message: 'Campaign sending started' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

router.post('/superadmin/campaigns/:id/cancel', requireSuperadmin, async (req, res) => {
  try {
    const campaignId = String(req.params.id).trim();
    await execute("UPDATE email_campaigns SET status = 'cancelled' WHERE id = $1 AND status IN ('draft', 'scheduled')", [campaignId]);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// Human-approval gate (mirrors admin.js:2438 → campaigns.js:210). The 5-min
// cron at server.js only auto-fires campaigns where approved_by IS NOT NULL.
router.post('/superadmin/campaigns/:id/approve', requireSuperadmin, async (req, res) => {
  try {
    const campaignId = String(req.params.id).trim();
    const approverId = req.user && req.user.id;
    if (!approverId) return res.status(401).json({ ok: false, error: 'Unauthenticated' });

    const existing = await queryOne('SELECT id, status, approved_by FROM email_campaigns WHERE id = $1', [campaignId]);
    if (!existing) return res.status(404).json({ ok: false, error: 'Not found' });
    if (existing.approved_by) {
      return res.status(409).json({ ok: false, error: 'Already approved', approvedBy: existing.approved_by });
    }
    if (existing.status !== 'scheduled' && existing.status !== 'draft') {
      return res.status(409).json({ ok: false, error: 'Cannot approve campaign in status ' + existing.status });
    }
    const nextStatus = existing.status === 'draft' ? 'scheduled' : existing.status;
    const nowIso = new Date().toISOString();
    await execute(
      'UPDATE email_campaigns SET status = $1, approved_by = $2, approved_at = $3 WHERE id = $4 AND approved_by IS NULL',
      [nextStatus, approverId, nowIso, campaignId]
    );
    const updated = await queryOne('SELECT id, status, approved_by, approved_at, scheduled_at FROM email_campaigns WHERE id = $1', [campaignId]);
    return res.json({ ok: true, campaign: updated });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ─── REFERRALS ────────────────────────────────────────────────────────
// Forked from routes/referrals.js:213. POST /api/referral/grant-reward stays
// shared (see MIGRATION_NOTES → "Shared JSON endpoints, intentionally not
// forked").
router.get('/superadmin/referrals', requireSuperadmin, async (req, res) => {
  try {
    const lang = (res.locals && res.locals.lang) || 'en';
    const isAr = lang === 'ar';
    const codes = await safeAll(
      `SELECT rc.*, u.name as user_name, u.email as user_email
         FROM referral_codes rc
         LEFT JOIN users u ON u.id = rc.user_id
        ORDER BY rc.times_used DESC, rc.created_at DESC
        LIMIT 200`,
      [], []
    );
    const totalCodes = codes.length;
    const totalRedemptions = await safeGet('SELECT COUNT(*) as count FROM referral_redemptions', [], { count: 0 });
    const totalRewarded = await safeGet('SELECT COUNT(*) as count FROM referral_redemptions WHERE reward_granted = true', [], { count: 0 });
    res.render('superadmin_referrals', {
      codes,
      totalCodes,
      totalRedemptions: totalRedemptions ? totalRedemptions.count : 0,
      totalRewarded: totalRewarded ? totalRewarded.count : 0,
      lang, isAr, user: req.user,
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || ''
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).send('Server error');
  }
});

// ─── CHAT MODERATION ──────────────────────────────────────────────────
// Forked from src/routes/admin.js:2598 (list), 2631 (detail), 2689 (resolve).

router.get('/superadmin/chat-moderation', requireSuperadmin, async (req, res) => {
  const reports = await safeAll(`
    SELECT cr.*,
      reporter.name as reporter_name, reporter.role as reporter_user_role,
      c.order_id, c.patient_id, c.doctor_id,
      p.name as patient_name, d.name as doctor_name,
      m.content as flagged_message_content, m.sender_id as flagged_sender_id,
      resolver.name as resolved_by_name
    FROM chat_reports cr
    JOIN conversations c ON cr.conversation_id = c.id
    LEFT JOIN users reporter ON cr.reported_by = reporter.id
    LEFT JOIN users p ON c.patient_id = p.id
    LEFT JOIN users d ON c.doctor_id = d.id
    LEFT JOIN messages m ON cr.message_id = m.id
    LEFT JOIN users resolver ON cr.resolved_by = resolver.id
    ORDER BY
      CASE cr.status WHEN 'open' THEN 0 WHEN 'reviewing' THEN 1 ELSE 2 END,
      cr.created_at DESC
    LIMIT 50
  `, [], []);
  const openCount = await safeGet("SELECT COUNT(*) as cnt FROM chat_reports WHERE status = 'open'", [], { cnt: 0 });
  res.render('superadmin_chat_moderation', {
    reports,
    openCount: openCount ? openCount.cnt : 0,
    lang: (req.user && req.user.lang) || 'en',
    user: req.user,
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || ''
  });
});

// BEHAVIOUR PRESERVED: this handler flips report.status from 'open' to
// 'reviewing' on first view (write-on-read side effect). Matches the
// legacy admin behaviour exactly. Tracked in MIGRATION_NOTES under
// "Behaviour observed, not changed" as a future cleanup candidate.
router.get('/superadmin/chat-moderation/:reportId', requireSuperadmin, async (req, res) => {
  const report = await safeGet(`
    SELECT cr.*, c.order_id, c.patient_id, c.doctor_id,
      p.name as patient_name, d.name as doctor_name,
      m.content as flagged_content, m.created_at as flagged_at,
      resolver.name as resolved_by_name
    FROM chat_reports cr
    JOIN conversations c ON cr.conversation_id = c.id
    LEFT JOIN users p ON c.patient_id = p.id
    LEFT JOIN users d ON c.doctor_id = d.id
    LEFT JOIN messages m ON cr.message_id = m.id
    LEFT JOIN users resolver ON cr.resolved_by = resolver.id
    WHERE cr.id = $1
  `, [req.params.reportId], null);
  if (!report) return res.redirect('/superadmin/chat-moderation');

  let contextMessages = [];
  if (report.message_id) {
    contextMessages = await safeAll(`
      SELECT m.*, u.name as sender_name, u.role as sender_role
      FROM messages m
      LEFT JOIN users u ON m.sender_id = u.id
      WHERE m.conversation_id = $1
      AND m.id IN (
        SELECT id FROM (
          SELECT id, created_at FROM messages
          WHERE conversation_id = $2 AND created_at <= (SELECT created_at FROM messages WHERE id = $3)
          ORDER BY created_at DESC LIMIT 6
        ) sub1
        UNION
        SELECT id FROM (
          SELECT id, created_at FROM messages
          WHERE conversation_id = $4 AND created_at > (SELECT created_at FROM messages WHERE id = $5)
          ORDER BY created_at ASC LIMIT 5
        ) sub2
      )
      ORDER BY m.created_at ASC
    `, [report.conversation_id, report.conversation_id, report.message_id, report.conversation_id, report.message_id], []);
  }

  if (report.status === 'open') {
    try { await execute("UPDATE chat_reports SET status = 'reviewing' WHERE id = $1", [req.params.reportId]); } catch (_) {}
  }

  res.render('superadmin_chat_moderation_detail', {
    report,
    contextMessages,
    flaggedMessageId: report.message_id,
    lang: (req.user && req.user.lang) || 'en',
    user: req.user,
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || ''
  });
});

router.post('/superadmin/chat-moderation/:reportId/resolve', requireSuperadmin, async (req, res) => {
  const { action, admin_notes } = req.body;
  await execute(`
    UPDATE chat_reports SET status = $1, admin_notes = $2, resolved_by = $3, resolved_at = NOW()
    WHERE id = $4
  `, [
    action === 'dismiss' ? 'dismissed' : 'resolved',
    admin_notes || null,
    req.user.id,
    req.params.reportId
  ]);

  if (action === 'warn') {
    try {
      const report = await safeGet('SELECT * FROM chat_reports WHERE id = $1', [req.params.reportId], null);
      if (report && report.message_id) {
        const flaggedMsg = await safeGet('SELECT sender_id FROM messages WHERE id = $1', [report.message_id], null);
        if (flaggedMsg) {
          await execute(`
            -- AUDIT-P1-2: the notifications table has to_user_id and at.
            -- There is no user_id and no created_at column, so this INSERT
            -- threw on every warn action — and both call sites wrapped it in a
            -- bare catch(_){} with no logging. The report was marked resolved,
            -- the mute applied, and the warned user was never notified, with
            -- zero signal anywhere.
            INSERT INTO notifications (id, to_user_id, channel, template, status, response, at)
            VALUES ($1, $2, 'internal', 'chat_conduct_warning', 'queued', $3, NOW())
          `, [randomUUID(), flaggedMsg.sender_id, JSON.stringify({
            title: 'Chat Conduct Warning',
            message: 'Your message was reported and reviewed by our team. Please maintain professional conduct in all communications.'
          })]);
        }
      }
    } catch (e) {
      // AUDIT-P1-2: was catch(_){} — a swallowed failure here is invisible.
      // AUDIT-M1: stdout is not visibility either. Route it to error_logs so a
      // conduct warning that never reached the doctor shows on /ops/errors.
      logErrorToDb(e, {
        context: 'chat_moderation.conduct_warning_notification',
        category: 'moderation'
      });
    }
  }

  // CHAT MODERATION POLICY — mute duration: 7 days.
  // Two call sites, kept in sync:
  //   1. routes/admin.js POST /admin/chat-moderation/:reportId/resolve
  //   2. routes/superadmin.js (this handler)
  // Grep anchor: INTERVAL '7 days'. If the mute window changes, update
  // both sites at once.
  if (action === 'mute') {
    try {
      const report = await safeGet('SELECT message_id FROM chat_reports WHERE id = $1', [req.params.reportId], null);
      if (report && report.message_id) {
        const flaggedMsg = await safeGet('SELECT sender_id FROM messages WHERE id = $1', [report.message_id], null);
        if (flaggedMsg) {
          await execute("UPDATE users SET muted_until = NOW() + INTERVAL '7 days' WHERE id = $1", [flaggedMsg.sender_id]);
        }
      }
    } catch (_) {}
  }

  res.redirect('/superadmin/chat-moderation');
});

// ─── VIDEO CALLS ──────────────────────────────────────────────────────
// Forked from src/routes/admin.js:2738. Read-only — no POSTs.
router.get('/superadmin/video-calls', requireSuperadmin, async (req, res) => {
  const appointments = await safeAll(`
    SELECT a.*,
      p.name as patient_name, p.email as patient_email,
      d.name as doctor_name, d.email as doctor_email,
      s.name as specialty_name,
      vc.id as call_id, vc.status as call_status,
      vc.started_at as call_started, vc.ended_at as call_ended,
      vc.duration_minutes as call_duration,
      vc.patient_joined_at, vc.doctor_joined_at,
      ap.amount as payment_amount, ap.status as payment_status, ap.refund_status
    FROM appointments a
    LEFT JOIN users p ON a.patient_id = p.id
    LEFT JOIN users d ON a.doctor_id = d.id
    LEFT JOIN specialties s ON a.specialty_id = s.id
    LEFT JOIN video_calls vc ON vc.appointment_id = a.id
    LEFT JOIN appointment_payments ap ON ap.appointment_id = a.id
    ORDER BY a.scheduled_at DESC
    LIMIT 100
  `, [], []);

  const totalAppointments = await safeGet('SELECT COUNT(*) as cnt FROM appointments', [], { cnt: 0 });
  const completedCalls = await safeGet("SELECT COUNT(*) as cnt FROM video_calls WHERE status = 'completed'", [], { cnt: 0 });
  const noShows = await safeGet("SELECT COUNT(*) as cnt FROM appointments WHERE status = 'no_show'", [], { cnt: 0 });
  const cancelledCalls = await safeGet("SELECT COUNT(*) as cnt FROM appointments WHERE status = 'cancelled'", [], { cnt: 0 });
  const avgDuration = await safeGet("SELECT AVG(duration_minutes) as avg FROM video_calls WHERE status = 'completed'", [], { avg: 0 });
  const upcomingToday = await safeAll(`
    SELECT a.*, p.name as patient_name, d.name as doctor_name
    FROM appointments a
    LEFT JOIN users p ON a.patient_id = p.id
    LEFT JOIN users d ON a.doctor_id = d.id
    WHERE DATE(a.scheduled_at) = CURRENT_DATE
    AND a.status IN ('confirmed', 'scheduled', 'pending')
    ORDER BY a.scheduled_at ASC
  `, [], []);

  const patientNoShows = await safeGet("SELECT COUNT(*) as cnt FROM appointments WHERE status = 'no_show' AND no_show_party = 'patient'", [], { cnt: 0 });
  const doctorNoShows = await safeGet("SELECT COUNT(*) as cnt FROM appointments WHERE status = 'no_show' AND no_show_party = 'doctor'", [], { cnt: 0 });

  res.render('superadmin_video_calls', {
    appointments,
    totalAppointments: totalAppointments ? totalAppointments.cnt : 0,
    completedCalls: completedCalls ? completedCalls.cnt : 0,
    noShows: noShows ? noShows.cnt : 0,
    cancelledCalls: cancelledCalls ? cancelledCalls.cnt : 0,
    avgDuration: avgDuration && avgDuration.avg ? Math.round(avgDuration.avg) : 0,
    upcomingToday,
    patientNoShows: patientNoShows ? patientNoShows.cnt : 0,
    doctorNoShows: doctorNoShows ? doctorNoShows.cnt : 0,
    lang: (req.user && req.user.lang) || 'en',
    user: req.user,
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || ''
  });
});

// ─── REVIEWS ──────────────────────────────────────────────────────────
// Forked from src/routes/reviews.js:264. Hide/Flag actions stay shared at
// DELETE /portal/admin/review/:id (see MIGRATION_NOTES → "Shared JSON
// endpoints, intentionally not forked").
router.get('/superadmin/reviews', requireSuperadmin, async (req, res) => {
  try {
    const lang = (res.locals && res.locals.lang) || 'en';
    const isAr = lang === 'ar';
    const reviews = await safeAll(
      `SELECT r.*, u.name as patient_name, d.name as doctor_name
         FROM reviews r
         LEFT JOIN users u ON u.id = r.patient_id
         LEFT JOIN users d ON d.id = r.doctor_id
        ORDER BY r.created_at DESC LIMIT 200`,
      [], []
    );
    res.render('superadmin_reviews', {
      reviews, lang, isAr, user: req.user,
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || ''
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).send('Server error');
  }
});

// buildFilters: used for dashboard and CSV export
function buildFilters(query, startIdx = 1) {
  const where = [];
  const params = [];
  let paramIdx = startIdx;

  if (query.from && query.from.trim()) {
    where.push(`DATE(o.created_at) >= DATE($${paramIdx++})`);
    params.push(query.from.trim());
  }
  if (query.to && query.to.trim()) {
    where.push(`DATE(o.created_at) <= DATE($${paramIdx++})`);
    params.push(query.to.trim());
  }
  if (query.specialty && query.specialty.trim() && query.specialty !== 'all') {
    where.push(`o.specialty_id = $${paramIdx++}`);
    params.push(query.specialty.trim());
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return { whereSql, params, nextIdx: paramIdx };
}

async function getActiveSuperadmins() {
  return await queryAll("SELECT id, name FROM users WHERE role = 'superadmin' AND is_active = true");
}

async function selectSlaRelevantOrders() {
  // Theme 7 sub-issue D (2026-05-10): 'awaiting_files' is a transitional
  // fallback. Migration 047 converts existing rows to 'REJECTED_FILES';
  // new code never writes 'awaiting_files'. Removed in a follow-up
  // cleanup PR after 30 days of stable behaviour.
  const slaStatuses = uniqStrings([
    ...statusDbValues('ACCEPTED', ['accepted']),
    ...statusDbValues('IN_REVIEW', ['in_review']),
    ...statusDbValues('AWAITING_FILES', ['awaiting_files'])
  ]);
  const inSql = sqlIn('o.status', slaStatuses);

  return await queryAll(
    `SELECT o.*, d.name AS doctor_name
     FROM orders_active o
     LEFT JOIN users d ON d.id = o.doctor_id
     WHERE ${inSql.clause}
       AND o.accepted_at IS NOT NULL
       AND o.completed_at IS NULL
       AND o.deadline_at IS NOT NULL`,
    inSql.params
  );
}

async function countOpenCasesForDoctor(doctorId) {
  // Theme 7 sub-issue D (2026-05-10): 'awaiting_files' transitional
  // fallback — same rationale as selectSlaRelevantOrders above.
  const openStatuses = uniqStrings([
    ...statusDbValues('NEW', ['new']),
    ...statusDbValues('ACCEPTED', ['accepted']),
    ...statusDbValues('IN_REVIEW', ['in_review']),
    ...statusDbValues('AWAITING_FILES', ['awaiting_files']),
    ...statusDbValues('BREACHED_SLA', ['breached'])
  ]);
  const inSql = sqlIn('status', openStatuses, 2);

  const row = await queryOne(
    `SELECT COUNT(*) as c
     FROM orders_active
     WHERE doctor_id = $1
       AND ${inSql.clause}`,
    [doctorId, ...inSql.params]
  );

  return row ? row.c || 0 : 0;
}

async function findBestAlternateDoctor(specialtyId, excludeDoctorId) {
  const doctors = await queryAll(
    `SELECT id, name
     FROM users
     WHERE role = 'doctor'
       AND is_active = true
       AND specialty_id = $1
       AND id != $2`,
    [specialtyId, excludeDoctorId || '']
  );

  if (!doctors || !doctors.length) return null;

  let best = null;
  for (const doc of doctors) {
    const openCount = await countOpenCasesForDoctor(doc.id);
    if (!best || openCount < best.openCount) {
      best = { ...doc, openCount };
    }
  }
  return best;
}

async function performSlaCheck(now = new Date()) {
  // Theme 7 sub-issue B: delegates to canonical case_sla_worker.runCaseSlaSweep.
  //
  // The previous body wrote `status='breached'` raw, then on reassign
  // reset status to `'new'` with accepted_at=NULL/deadline_at=NULL
  // (P0-STATE-2 in the audit) — losing the breach event trail and
  // bypassing partial-pay accounting. It also managed its own
  // `pre_breach_notified` column flag, now replaced by `case_events
  // 'SLA pre-breach alert'` row dedupe.
  //
  // Notification fan-out is now consolidated:
  //   - Patient breach bell (`order_breached_patient`): fired by
  //     case_lifecycle.markSlaBreach.
  //   - Patient reassign bell (`order_reassigned_patient`): DROPPED in
  //     favour of the email canonical reassignCase already sends via
  //     emailService.notifyCaseReassigned (case_lifecycle.js:1995).
  //   - Doctor breach bell (`sla_breached_doctor`): DROPPED in favour of
  //     WhatsApp via sendSlaReminder({level:'breach'}).
  //   - Superadmin breach bell (`order_breached_superadmin`): DROPPED in
  //     favour of WhatsApp via dispatchSlaBreach (now queries real
  //     superadmins, not the hardcoded 'superadmin-1' placeholder).
  //   - New-doctor reassign bell (`order_reassigned_to_doctor`): DROPPED;
  //     new doctor learns of case via dashboard refresh.
  //   - Superadmin reassign bell (`order_reassigned_superadmin`): DROPPED
  //     (rare, low-impact).
  //
  // Summary-object contract preserved — callers at /superadmin/run-sla-check
  // and /superadmin/tools/run-sla-check render {breached, reassigned,
  // preBreachWarnings, noDoctor} counts.
  const summary = {
    preBreachWarnings: 0,
    breached: 0,
    reassigned: 0,
    noDoctor: 0
  };
  try {
    const { runCaseSlaSweep } = require('../case_sla_worker');
    const result = await runCaseSlaSweep(now);
    summary.preBreachWarnings = (result && result.preBreaches) || 0;
    summary.breached = (result && result.breaches) || 0;
    summary.reassigned = (result && result.timeouts) || 0;
  } catch (err) {
    logErrorToDb(err, {
      context: 'superadmin.perform_sla_check',
      category: 'superadmin_action'
    });
    console.error('[performSlaCheck] delegation to runCaseSlaSweep failed:', err && err.message);
  }
  return summary;
}

async function loadOrderWithPatient(orderId) {
  return await queryOne(
    `SELECT o.id, o.status, o.payment_status, o.payment_method, o.payment_reference, o.price, o.currency,
            o.patient_id, u.name AS patient_name, u.email AS patient_email
     FROM orders_active o
     LEFT JOIN users u ON u.id = o.patient_id
     WHERE o.id = $1`,
    [orderId]
  );
}

function safeParseJson(value) {
  try {
    if (!value) return null;
    if (typeof value === 'object') return value;
    return JSON.parse(String(value));
  } catch (_) {
    return null;
  }
}

function safeGetStatusUi(status, langCode) {
  try {
    // Most common signature: (status, lang)
    return getStatusUi(status, langCode);
  } catch (_) {
    try {
      // Alternate signature: ({ status, langCode })
      return getStatusUi({ status, langCode });
    } catch (__) {
      try {
        // Alternate signature: ({ status, lang })
        return getStatusUi({ status, lang: langCode });
      } catch (___) {
        return null;
      }
    }
  }
}

function normalizeStatus(value) {
  try {
    if (typeof canonicalizeStatus === 'function') {
      const canon = canonicalizeStatus(value);
      return canon ? String(canon).trim().toUpperCase() : '';
    }
  } catch (_) {
    // ignore
  }
  if (!value) return '';
  return String(value).trim().toUpperCase();
}

function uniqStrings(list) {
  const out = [];
  const seen = new Set();
  (list || []).forEach((v) => {
    if (v == null) return;
    const s = String(v);
    if (!s) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  });
  return out;
}

function statusDbValues(canon, fallback = []) {
  try {
    if (typeof dbStatusValuesFor === 'function') {
      const vals = dbStatusValuesFor(canon);
      if (Array.isArray(vals) && vals.length) return uniqStrings(vals);
    }
  } catch (_) {
    // ignore
  }
  return uniqStrings(fallback);
}

function sqlIn(field, values, startIdx = 1) {
  const vals = (values || []).filter((v) => v != null && String(v).length);
  if (!vals.length) return { clause: '1=0', params: [], nextIdx: startIdx }; // nothing should match
  const ph = vals.map((_, i) => `$${startIdx + i}`).join(',');
  return { clause: `${field} IN (${ph})`, params: vals, nextIdx: startIdx + vals.length };
}

function sqlNotIn(field, values, startIdx = 1) {
  const vals = (values || []).filter((v) => v != null && String(v).length);
  if (!vals.length) return { clause: '1=1', params: [], nextIdx: startIdx }; // nothing to exclude
  const ph = vals.map((_, i) => `$${startIdx + i}`).join(',');
  return { clause: `${field} NOT IN (${ph})`, params: vals, nextIdx: startIdx + vals.length };
}

function canonOrOriginal(status) {
  try {
    if (typeof toCanonStatus === 'function') {
      const c = toCanonStatus(status);
      return c || status;
    }
  } catch (_) {
    // ignore
  }
  return status;
}

// Phase 3 batch 1 — forked from src/routes/admin.js:429 + admin.js:651.
// Kept inline rather than extracted to src/services/ per the fork rule
// (small enough to duplicate). If admin.js changes its KPI shape, mirror
// here.
function lowerUniqStrings(list) {
  return uniqStrings((list || []).map((v) => String(v).toLowerCase()));
}

async function getOrderKpis(whereSql, params) {
  const completedValsKpi = lowerUniqStrings(statusDbValues('COMPLETED', ['completed']));
  const breachedValsKpi = lowerUniqStrings(
    uniqStrings([
      ...statusDbValues('BREACHED_SLA', ['breached', 'breached_sla']),
      ...statusDbValues('DELAYED', ['delayed'])
    ])
  );
  const nextIdx = params.length + 1;
  const completedIn = sqlIn('LOWER(o.status)', completedValsKpi, nextIdx);
  const breachedIn = sqlIn('LOWER(o.status)', breachedValsKpi, completedIn.nextIdx);
  const kpiSql = `
    SELECT
      COUNT(*) AS total_orders,
      SUM(CASE WHEN ${completedIn.clause} THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN ${breachedIn.clause} THEN 1 ELSE 0 END) AS breached
    FROM orders_active o
    ${whereSql}
  `;
  const kpisFallback = { total_orders: 0, completed: 0, breached: 0 };
  const kpiParams = [...params, ...completedIn.params, ...breachedIn.params];
  const kpis = await safeGet(kpiSql, kpiParams, kpisFallback);
  return {
    totalOrders: kpis?.total_orders || 0,
    completedCount: kpis?.completed || 0,
    breachedCount: kpis?.breached || 0
  };
}

// ── Additional-files DECISION predicate — one definition, three call sites ──
//
// AUDIT (2026-08-17). The approval writers emit the short canonical identifiers
// 'admin_approved_files_request' (routes/admin.js) and
// 'superadmin_approved_files_request' (below). getLatestAdditionalFilesDecisionEvent
// matched those explicitly, but the /superadmin inbox queue
// (getPendingAdditionalFilesRequests) carried its OWN copy of the predicate with
// only the three descriptive `LIKE '%additional files request approved%'`
// branches — which the short identifiers do not match. Consequences, both live:
//
//   * No decision row was ever found for an approved request, so `dec` stayed
//     NULL, stage stayed 'awaiting_approval', and the pill stayed PENDING. An
//     approved request never left the admin inbox.
//   * Worse in the other direction: 'admin_approved_files_request' contains
//     both 'request' and 'files', so it MATCHES the fuzzy REQUEST predicate,
//     and the NOT(...) exclusion beside it only listed the three descriptive
//     labels. The approval event was therefore also read as a brand-new
//     additional-files request, dated after the real one — the queue
//     re-pinned the row it had just resolved.
//
// Hoisted here so the decision vocabulary has exactly one definition. Used for
// (a) matching decisions and (b) EXCLUDING decisions from the request match.
// `col` is the qualified column expression at the call site ('label',
// 'd.label', 'e2.label', ...).
function additionalFilesDecisionPredicate(col) {
  const c = String(col);
  return `(
         -- Theme 7 sub-issue D: explicit short identifiers written by the
         -- admin/superadmin approve handlers as of 2026-05-10.
         ${c} = 'admin_approved_files_request'
         OR ${c} = 'superadmin_approved_files_request'
         -- Backward-compat for in-flight pre-Theme-7 rows (descriptive
         -- English labels written by the older handlers and the reject paths).
         OR LOWER(${c}) LIKE '%additional files request approved%'
         OR LOWER(${c}) LIKE '%additional files request rejected%'
         OR LOWER(${c}) LIKE '%additional files request denied%'
       )`;
}

// Finds the most recent "doctor requested additional files" style event.
// We keep this fuzzy on purpose to avoid coupling to one exact label.
function getLatestAdditionalFilesRequestEvent(orderId) {
  return safeGet(
    `SELECT id, label, meta, at, actor_user_id, actor_role
     FROM order_events
     WHERE order_id = $1
       AND (
         label IN ('doctor_requested_additional_files', 'doctor_rejected_files')
         OR (
           (LOWER(label) LIKE '%request%' AND (LOWER(label) LIKE '%file%' OR LOWER(label) LIKE '%upload%' OR LOWER(label) LIKE '%re-upload%' OR LOWER(label) LIKE '%reupload%'))
           OR LOWER(label) LIKE '%reject file%'
           OR LOWER(label) LIKE '%reupload%'
         )
       )
       AND NOT ${additionalFilesDecisionPredicate('label')}
     ORDER BY at DESC
     LIMIT 1`,
    [orderId],
    null
  );
}

function getLatestAdditionalFilesDecisionEvent(orderId) {
  return safeGet(
    `SELECT id, label, meta, at, actor_user_id, actor_role
     FROM order_events
     WHERE order_id = $1
       AND ${additionalFilesDecisionPredicate('label')}
     ORDER BY at DESC
     LIMIT 1`,
    [orderId],
    null
  );
}

async function computeAdditionalFilesRequestState(orderId) {
  const reqEvent = await getLatestAdditionalFilesRequestEvent(orderId);
  const decisionEvent = await getLatestAdditionalFilesDecisionEvent(orderId);

  const reqAt = reqEvent && reqEvent.at ? new Date(reqEvent.at).getTime() : 0;
  const decAt = decisionEvent && decisionEvent.at ? new Date(decisionEvent.at).getTime() : 0;

  const pending = Boolean(reqEvent) && (!decisionEvent || decAt < reqAt);

  return {
    pending,
    request: reqEvent
      ? { ...reqEvent, meta: safeParseJson(reqEvent.meta) }
      : null,
    decision: decisionEvent
      ? { ...decisionEvent, meta: safeParseJson(decisionEvent.meta) }
      : null
  };
}

async function getPendingAdditionalFilesRequests(limit = 20) {
  // Inbox-style list of additional-files requests.
  // Requirement:
  // - Show the request in the dashboard inbox even after approve/reject.
  // - Show a status pill that changes based on latest decision after the request.
  // - Do NOT rely on `orders.additional_files_requested` alone or a single legacy label.

  const lim = Number(limit) || 20;

  // Match request-like events (fuzzy) AND the canonical label.
  // AUDIT-P0-4: the doctor route wrote `doctor_rejected_files`, which matched
  // NEITHER the exact label NOR the fuzzy fallback ('%reject file%' has a space,
  // the label has an underscore) — so this queue was permanently empty. The
  // writer now emits the canonical label; the legacy one is matched here so
  // historical requests still surface.
  const requestMatch = `(
    e1.label IN ('doctor_requested_additional_files', 'doctor_rejected_files')
    OR (
      (LOWER(e1.label) LIKE '%request%' AND (LOWER(e1.label) LIKE '%file%' OR LOWER(e1.label) LIKE '%upload%' OR LOWER(e1.label) LIKE '%re-upload%' OR LOWER(e1.label) LIKE '%reupload%'))
      OR LOWER(e1.label) LIKE '%reject file%'
      OR LOWER(e1.label) LIKE '%reupload%'
    )
  )`;

  // Decision events (written by admin/superadmin flows). Shared predicate —
  // this used to be a local 3-branch copy that missed the short canonical
  // identifiers, so an approved request never left this inbox.
  const decisionMatch = additionalFilesDecisionPredicate('d.label');

  const rows = await safeAll(
    `WITH req AS (
        SELECT e1.order_id,
               e1.id   AS request_event_id,
               e1.at   AS requested_at,
               e1.label AS request_label,
               e1.meta AS request_meta
        FROM order_events e1
        WHERE ${requestMatch}
          AND NOT ${additionalFilesDecisionPredicate('e1.label')}
          AND e1.id = (
            SELECT e2.id
            FROM order_events e2
            WHERE e2.order_id = e1.order_id
              AND NOT ${additionalFilesDecisionPredicate('e2.label')}
              AND (
                e2.label IN ('doctor_requested_additional_files', 'doctor_rejected_files')
                OR (
                  (LOWER(e2.label) LIKE '%request%' AND (LOWER(e2.label) LIKE '%file%' OR LOWER(e2.label) LIKE '%upload%' OR LOWER(e2.label) LIKE '%re-upload%' OR LOWER(e2.label) LIKE '%reupload%'))
                  OR LOWER(e2.label) LIKE '%reject file%'
                  OR LOWER(e2.label) LIKE '%reupload%'
                )
              )
            ORDER BY e2.at DESC, e2.id DESC
            LIMIT 1
          )
     ), dec AS (
        SELECT d.order_id,
               d.id    AS decision_event_id,
               d.at    AS decided_at,
               d.label AS decision_label,
               d.meta  AS decision_meta
        FROM order_events d
        JOIN req ON req.order_id = d.order_id
        WHERE (d.at > req.requested_at OR (d.at = req.requested_at AND d.id != req.request_event_id))
          AND ${decisionMatch}
          AND d.id = (
            SELECT d2.id
            FROM order_events d2
            WHERE d2.order_id = d.order_id
              AND (d2.at > req.requested_at OR (d2.at = req.requested_at AND d2.id != req.request_event_id))
              AND ${additionalFilesDecisionPredicate('d2.label')}
            ORDER BY d2.at DESC, d2.id DESC
            LIMIT 1
          )
     )
     SELECT
        o.id AS order_id,
        o.status,
        o.created_at,
        o.updated_at,
        o.specialty_id,
        s.name AS specialty_name,
        o.doctor_id,
        doc.name AS doctor_name,
        o.patient_id,
        pat.name AS patient_name,
        req.request_event_id,
        req.requested_at,
        req.request_label,
        req.request_meta,
        dec.decision_event_id,
        dec.decided_at,
        dec.decision_label,
        dec.decision_meta
     FROM req
     JOIN orders_active o ON o.id = req.order_id
     LEFT JOIN specialties s ON s.id = o.specialty_id
     LEFT JOIN users doc ON doc.id = o.doctor_id
     LEFT JOIN users pat ON pat.id = o.patient_id
     LEFT JOIN dec ON dec.order_id = o.id
     ORDER BY req.requested_at DESC
     LIMIT $1`,
    [lim],
    []
  );

  return (rows || []).map((r) => {
    const meta = safeParseJson(r.request_meta) || {};
    const decLabel = r.decision_label ? String(r.decision_label).toLowerCase() : '';

    let stage = 'awaiting_approval';
    if (r.decision_event_id) {
      stage = decLabel.includes('approved') ? 'approved' : 'rejected';
    }

    const pending = stage === 'awaiting_approval';

    const pill = pending
      ? { text: 'PENDING', className: 'status-pill status-pill--pending' }
      : stage === 'approved'
        ? { text: 'APPROVED', className: 'status-pill status-pill--approved' }
        : { text: 'REJECTED', className: 'status-pill status-pill--rejected' };

    return {
      orderId: r.order_id,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at,
      specialty_id: r.specialty_id,
      specialty_name: r.specialty_name,
      doctor_id: r.doctor_id,
      doctor_name: r.doctor_name,
      patient_id: r.patient_id,
      patient_name: r.patient_name,

      // Request
      request_event_id: r.request_event_id,
      requested_at: r.requested_at,
      request_label: r.request_label,
      reason: (meta && typeof meta === 'object' && meta.reason) ? String(meta.reason) : '',
      meta,

      // Decision
      decision_event_id: r.decision_event_id || null,
      decided_at: r.decided_at || null,
      decision_label: r.decision_label || null,
      decision_meta: safeParseJson(r.decision_meta) || null,

      // Computed
      pending,
      stage,
      pill
    };
  });
}
async function renderSuperadminProfile(req, res) {
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';
  const u = req.user || {};

  const title = t(lang, 'My profile', 'ملفي الشخصي');
  const name = u.name || '—';
  const email = u.email || '—';
  const role = u.role || 'superadmin';

  let specialty = '—';
  try {
    if (u.specialty_id) {
      const row = await queryOne('SELECT name FROM specialties WHERE id = $1', [u.specialty_id]);
      specialty = (row && row.name) || '—';
    }
  } catch (_) {
    specialty = '—';
  }

  const nextPath = (req && req.originalUrl && String(req.originalUrl).startsWith('/')) ? String(req.originalUrl) : '/superadmin/profile';

  return res.render('superadmin_profile', {
    brand: 'Tashkheesa',
    user: req.user,
    lang,
    dir: isAr ? 'rtl' : 'ltr',
    isAr,
    title,
    nextPath,
    profile: {
      name,
      email,
      role,
      specialty
    },
    labels: {
      name: t(lang, 'Name', 'الاسم'),
      email: t(lang, 'Email', 'البريد الإلكتروني'),
      role: t(lang, 'Role', 'الدور'),
      specialty: t(lang, 'Specialty', 'التخصص'),
      note: t(
        lang,
        'Profile editing will be enabled in a later release. For changes, contact support/admin.',
        'سيتم تفعيل تعديل الملف الشخصي في إصدار لاحق. للتعديلات تواصل مع الدعم/الإدارة.'
      )
    }
  });
}

router.get('/superadmin/profile', requireRole('superadmin'), renderSuperadminProfile);

// MAIN SUPERADMIN DASHBOARD
//
// Data sourced from src/services/superadmin_dashboard.js. Tab fetchers
// parallelize their own queries; the outer Promise.all runs the nine
// concurrent waves (pills + banner + badges + 6 tabs). 60s in-process
// TTL cache absorbs repeat hits.
//
// Phase 2 perf rework: removed inline recalcSlaBreaches() (covered by
// pg-boss SLA sweep, server.js:1095-1101) and the overdue-orders
// enforceBreachIfNeeded loop (same — pg-boss runCaseSlaSweep). Both
// were write-on-read side effects fired on every dashboard load.
router.get('/superadmin', requireSuperadmin, async (req, res) => {
  const t0 = Date.now();
  const query = req.query || {};
  const range = (() => {
    const r = String(query.range || '7d').toLowerCase();
    return ['today', '7d', '30d', 'mtd'].indexOf(r) >= 0 ? r : '7d';
  })();
  const activeTab = (() => {
    const t = String(query.tab || '').toLowerCase();
    return ['operations', 'finance', 'doctors', 'patients', 'marketing', 'health'].indexOf(t) >= 0 ? t : 'operations';
  })();
  const langCode =
    (query.lang === 'ar') ||
    (req.session && req.session.lang === 'ar')
      ? 'ar'
      : 'en';

  const [
    pills,
    attention,
    sidebarBadges,
    ops,
    finance,
    doctors,
    patients,
    marketing,
    health
  ] = await Promise.all([
    superadminDashboard.getStatusPills().catch((err) => {
      logErrorToDb(err, { context: 'superadmin.dashboard.pills', userId: req.user?.id, category: 'superadmin_action' });
      return [];
    }),
    superadminDashboard.getAttentionItems().catch((err) => {
      logErrorToDb(err, { context: 'superadmin.dashboard.attention', userId: req.user?.id, category: 'superadmin_action' });
      return { items: [], severity: 'amber' };
    }),
    superadminDashboard.getSidebarBadges().catch((err) => {
      logErrorToDb(err, { context: 'superadmin.dashboard.badges', userId: req.user?.id, category: 'superadmin_action' });
      return {};
    }),
    superadminDashboard.getOperationsTabData({ range }).catch((err) => {
      logErrorToDb(err, { context: 'superadmin.dashboard.tab.operations', userId: req.user?.id, category: 'superadmin_action' });
      return { kpis: [], slaBuckets: [], tierStrip: [], cases: [], doctors: [] };
    }),
    superadminDashboard.getFinanceTabData({ range }).catch((err) => {
      logErrorToDb(err, { context: 'superadmin.dashboard.tab.finance', userId: req.user?.id, category: 'superadmin_action' });
      return { kpis: [], revenueBySpecialty: [], urgencyTier: [], fxZone: [], payouts: [], paymob: { today: {}, recent: [] } };
    }),
    superadminDashboard.getDoctorsTabData({ range }).catch((err) => {
      logErrorToDb(err, { context: 'superadmin.dashboard.tab.doctors', userId: req.user?.id, category: 'superadmin_action' });
      return { kpis: [], leaderboard: [], pipeline: [], coverage: [] };
    }),
    superadminDashboard.getPatientsTabData({ range }).catch((err) => {
      logErrorToDb(err, { context: 'superadmin.dashboard.tab.patients', userId: req.user?.id, category: 'superadmin_action' });
      return { kpis: [], sources: null, cohorts: null, geo: [], reviews: [] };
    }),
    superadminDashboard.getMarketingTabData({ range }).catch((err) => {
      logErrorToDb(err, { context: 'superadmin.dashboard.tab.marketing', userId: req.user?.id, category: 'superadmin_action' });
      return { kpis: [], campaigns: [], instagram: {}, referrals: [], waTemplates: null };
    }),
    superadminDashboard.getHealthTabData({ range }).catch((err) => {
      logErrorToDb(err, { context: 'superadmin.dashboard.tab.health', userId: req.user?.id, category: 'superadmin_action' });
      return { kpis: [], services: null, errors: [], crons: [], workers: null };
    })
  ]);

  const dataMs = Date.now() - t0;
  res.render('superadmin', {
    aiHealth: await getAiHealth(),
    user: req.user,
    lang: langCode,
    range,
    activeTab,
    pills,
    attentionItems: (attention && attention.items) || [],
    attentionSeverity: (attention && attention.severity) || 'amber',
    sidebarBadges,
    ops,
    finance,
    doctors,
    patients,
    marketing,
    health,
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || ''
  });
  console.log('[superadmin_dashboard] data=' + dataMs + 'ms render+data=' + (Date.now() - t0) + 'ms range=' + range);
});

// New order form (superadmin)
// LIST · forked from admin.js:1238. Same data shape, same filters, new chrome.
// Sibling routes (POST actions, GET /superadmin/orders/:id, etc.) already exist
// further down — this is the missing list view that the owner sidebar's "Cases"
// link now points to.
router.get('/superadmin/orders', requireSuperadmin, async (req, res) => {
  const t0 = Date.now();
  const query = req.query || {};
  const from = query.from || '';
  const to = query.to || '';
  const specialty = query.specialty || 'all';
  const statusFilter = query.status || 'all';
  const langCode = (req.user && req.user.lang) ? req.user.lang : 'en';

  const { whereSql, params } = buildFilters(query);

  let finalWhere = whereSql;
  const finalParams = [...params];
  if (statusFilter && statusFilter !== 'all') {
    const statusVals = lowerUniqStrings(statusDbValues(statusFilter.toUpperCase(), [statusFilter.toLowerCase()]));
    if (statusVals.length) {
      const statusIn = sqlIn('LOWER(o.status)', statusVals, finalParams.length + 1);
      finalWhere = finalWhere ? (finalWhere + ' AND ' + statusIn.clause) : ('WHERE ' + statusIn.clause);
      finalParams.push(...statusIn.params);
    }
  }

  const [kpis, ordersRaw, events, specialties, sidebarBadges] = await Promise.all([
    getOrderKpis(finalWhere, finalParams),
    safeAll(
      `SELECT o.id, o.reference_id, o.created_at, o.status, o.reassigned_count, o.deadline_at, o.completed_at,
              o.payment_status, o.price,
              p.name AS patient_name, d.name AS doctor_name,
              sv.name AS service_name, sp.name AS specialty_name
         FROM orders_active o
         LEFT JOIN users p ON p.id = o.patient_id
         LEFT JOIN users d ON d.id = o.doctor_id
         LEFT JOIN services sv ON sv.id = o.service_id
         LEFT JOIN specialties sp ON sp.id = o.specialty_id
         ${finalWhere}
        ORDER BY o.created_at DESC
        LIMIT 200`,
      finalParams, []
    ),
    safeAll(
      `SELECT e.id, e.at, e.label, e.order_id, o.status
         FROM order_events e
         JOIN orders_active o ON o.id = e.order_id
         ${whereSql}
        ORDER BY e.at DESC
        LIMIT 15`,
      params, []
    ),
    safeAll('SELECT id, name FROM specialties ORDER BY name ASC', [], []),
    superadminDashboard.getSidebarBadges().catch(() => ({}))
  ]);

  const orders = (ordersRaw || []).map((o) => {
    const computed = computeSla(o);
    const effective = canonOrOriginal(computed.effectiveStatus || o.status);
    return {
      ...o,
      status: effective,
      effectiveStatus: computed.effectiveStatus,
      sla: computed.sla,
      statusUi: safeGetStatusUi(effective, langCode)
    };
  });

  res.render('superadmin_orders', {
    user: req.user,
    lang: langCode,
    orders,
    events: (events || []).map((e) => ({ ...e, status: canonOrOriginal(e.status) })),
    totalOrders: kpis.totalOrders,
    completedCount: kpis.completedCount,
    breachedCount: kpis.breachedCount,
    specialties: specialties || [],
    filters: { from, to, specialty, status: statusFilter },
    sidebarBadges,
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || ''
  });
  console.log('[superadmin_orders] list rendered in ' + (Date.now() - t0) + 'ms');
});

router.get('/superadmin/orders/new', requireSuperadmin, async (req, res) => {
  const patients = await queryAll(
    "SELECT id, name, email FROM users WHERE role = 'patient'"
  );

  const doctors = await queryAll(
    "SELECT id, name, email, specialty_id FROM users WHERE role = 'doctor'"
  );

  const specialties = await queryAll(
    'SELECT id, name FROM specialties ORDER BY name'
  );

  const services = await queryAll(
    'SELECT id, specialty_id, code, name, base_price, doctor_fee FROM services ORDER BY name'
  );

  const defaultService = services && services.length ? services[0] : null;

  res.render('superadmin_order_new', {
    user: req.user,
    patients,
    doctors,
    specialties,
    services,
    defaults: {
      sla_hours: 48,
      price: defaultService ? defaultService.base_price : undefined,
      doctor_fee: defaultService ? defaultService.doctor_fee : undefined
    },
    error: null
  });
});

// Create manual order (superadmin)
router.post('/superadmin/orders', requireSuperadmin, async (req, res) => {
  const {
    patient_id,
    doctor_id,
    specialty_id,
    service_id,
    sla_hours,
    price,
    doctor_fee,
    notes
  } = req.body || {};

  const requiredMissing = !patient_id || !specialty_id || !service_id || !sla_hours;
  if (requiredMissing) {
    const patients = await queryAll(
      "SELECT id, name, email FROM users WHERE role = 'patient'"
    );
    const doctors = await queryAll(
      "SELECT id, name, email, specialty_id FROM users WHERE role = 'doctor'"
    );
    const specialties = await queryAll(
      'SELECT id, name FROM specialties ORDER BY name'
    );
    const services = await queryAll(
      'SELECT id, specialty_id, code, name FROM services ORDER BY name'
    );

    return res.status(400).render('superadmin_order_new', {
      user: req.user,
      patients,
      doctors,
      specialties,
      services,
      defaults: { sla_hours: Number(sla_hours) || 72, price, doctor_fee, notes },
      error: 'Please fill all required fields.'
    });
  }

  const now = new Date();
  const createdAt = now.toISOString();
  const deadline = doctor_id
    ? new Date(now.getTime() + Number(sla_hours || 0) * 60 * 60 * 1000).toISOString()
    : null;
  const orderId = `manual-order-${Date.now()}`;

  const service = await queryOne('SELECT * FROM services WHERE id = $1', [service_id]);
  const orderPrice = price ? Number(price) : service ? service.base_price : null;
  const orderDoctorFee = doctor_fee ? Number(doctor_fee) : service ? service.doctor_fee : null;
  const orderPaymentLink = service ? service.payment_link : null;
  const orderCurrency = service ? service.currency || 'EGP' : 'EGP';
  const selectedDoctor = doctor_id
    ? await queryOne("SELECT id, name, email, phone FROM users WHERE id = $1 AND role = 'doctor'", [doctor_id])
    : null;
  const autoDoctor = !doctor_id ? await pickDoctorForOrder({ specialtyId: specialty_id, serviceId: service_id }) : null;
  const chosenDoctor = selectedDoctor || autoDoctor;
  const status = chosenDoctor ? 'accepted' : 'new';
  const acceptedAt = chosenDoctor ? createdAt : null;

  // AUDIT (2026-08-17) — base_price was never written by this path, so every
  // operator-created order had a refund ceiling of 0 and was PERMANENTLY
  // UNREFUNDABLE (services/refund_eligibility.maxRefundableEgp, and the legacy
  // base_price + urgency_uplift_amount formula it replaces, both read it). No
  // urgency tier is applied here, so base_price = the order's charge base and
  // the migration-037 invariant base_price + urgency_uplift_amount = price
  // holds with uplift NULL. These rows are created as payment_status='paid'
  // outright, which makes them immediately refund-eligible — precisely the
  // population that needs a non-zero ceiling.
  //
  // AUDIT (2026-08-17, regression F6) — paid_at was never written either, and
  // payment_status='paid' with paid_at NULL is not a state the rest of the
  // system accepts. It is the pair, not the column, that means "paid":
  // routes/admin.js force-assign now refuses on `!order.paid_at`, so EVERY
  // operator-created order became unassignable by the one recovery path a human
  // drives (before this series force-assign was a raw UPDATE and did not care).
  // Written as created_at, the same instant the order is declared paid, so the
  // paid_at-based revenue/aging reads see a real timestamp rather than a NULL
  // they must COALESCE around.
  await execute(
    `INSERT INTO orders (
      id, patient_id, doctor_id, specialty_id, service_id,
      sla_hours, status, price, base_price, doctor_fee,
      created_at, accepted_at, deadline_at, completed_at,
      breached_at, reassigned_count, report_url, notes,
      payment_status, payment_method, payment_reference, payment_link,
      paid_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $18, $9,
      $10, $11, $12, NULL,
      NULL, 0, NULL, $13,
      $14, $15, $16, $17,
      $10
    )`,
    [
      orderId,
      patient_id,
      chosenDoctor ? chosenDoctor.id : null,
      specialty_id,
      service_id,
      Number(sla_hours),
      status,
      orderPrice,
      orderDoctorFee,
      createdAt,
      acceptedAt,
      chosenDoctor ? deadline : null,
      notes || null,
      'paid',
      null,
      null,
      orderPaymentLink,
      orderPrice
    ]
  );

  logOrderEvent({
    orderId,
    label: 'Order created by superadmin',
    actorUserId: req.user.id,
    actorRole: req.user.role
  });
  if (chosenDoctor) {
    logOrderEvent({
      orderId,
      label: selectedDoctor
        ? `Assigned to doctor ${doctor_id}`
        : `Auto-assigned to Dr. ${autoDoctor.name}`,
      actorUserId: req.user.id,
      actorRole: req.user.role
    });
    queueMultiChannelNotification({
      orderId,
      toUserId: chosenDoctor.id,
      channels: ['internal', 'email', 'whatsapp'],
      template: 'order_assigned_doctor',
      response: { case_id: orderId, caseReference: orderId.slice(0, 12).toUpperCase() },
      dedupe_key: 'order_assigned:' + orderId + ':doctor'
    });
    if (autoDoctor) {
      queueMultiChannelNotification({
        orderId,
        toUserId: autoDoctor.id,
        channels: ['internal', 'email', 'whatsapp'],
        template: 'order_auto_assigned_doctor',
        response: { case_id: orderId, caseReference: orderId.slice(0, 12).toUpperCase() },
        dedupe_key: 'order_auto_assigned:' + orderId + ':doctor'
      });
    }
  } else {
    logOrderEvent({
      orderId,
      label: 'Order created without assigned doctor',
      actorUserId: req.user.id,
      actorRole: req.user.role
    });
  }

  // Auto-create conversation for case-scoped messaging
  if (chosenDoctor && patient_id) {
    try { ensureConversation(orderId, patient_id, chosenDoctor.id); } catch (_) {}
  }

  return res.redirect('/superadmin?created=1');
});

// ─── Deleted Orders (Trash) ──────────────────────────────────
// Soft-delete fires automatically when an order is unpaid 48h after
// creation (case_lifecycle.js#dispatchUnpaidCaseReminders, sets
// status='expired_unpaid' + deleted_at=NOW()). This is the operator
// surface for reviewing what auto-expired and, if needed, restoring
// an order whose patient subsequently paid via a late channel.
//
// Declared BEFORE the parametrized /superadmin/orders/:id route so
// Express does not match "trash" as an :id.
router.get('/superadmin/orders/trash', requireSuperadmin, async (req, res) => {
  const orders = await safeAll(
    `SELECT o.id,
            o.status,
            o.deleted_at,
            o.created_at,
            o.payment_status,
            COALESCE(o.reference_id, c.reference_code) AS reference_id,
            o.patient_id,
            u.name  AS patient_name,
            u.email AS patient_email,
            u.phone AS patient_phone
       FROM orders o   -- include-deleted-ok: trash view shows soft-deleted rows
       LEFT JOIN users u ON u.id = o.patient_id
       LEFT JOIN cases c ON c.id = o.id
      WHERE o.deleted_at IS NOT NULL
      ORDER BY o.deleted_at DESC
      LIMIT 200`,
    [],
    []
  );

  return res.render('superadmin_orders_trash', {
    user: req.user,
    orders: orders,
    restored: req.query.restored === '1',
    restoreError: req.query.error || null
  });
});

// Theme 14 Phase 5 — Manual Queue list page.
//
// Orders with assignment_status='manual_queue' are parked here for ops
// triage. The classifier writes this state at Step 2 POST when confidence
// falls below the live `minimum` threshold (default 0.55, tunable from
// /superadmin/settings). auto_assign.js and notify/broadcast.js both
// short-circuit on this state, so the order does not route to a doctor
// until an admin clears it via the Phase 5 approve flow (Commit 2).
//
// Sort: oldest-first (FIFO) — the oldest case has waited longest for
// triage. Joins the latest specialty_classifications row per case to
// surface the AI's best-effort prediction alongside confidence.
router.get('/superadmin/manual-queue', requireSuperadmin, async (req, res) => {
  const langCode = (req.user && req.user.lang) ? req.user.lang : 'en';

  const [rows, sidebarBadges] = await Promise.all([
    safeAll(
      `SELECT o.id,
              o.reference_id,
              o.created_at,
              o.status,
              o.payment_status,
              p.name  AS patient_name,
              p.email AS patient_email,
              sp_pred.name AS predicted_specialty_name,
              sv_pred.name AS predicted_service_name,
              sc.confidence AS predicted_confidence,
              sc.created_at AS predicted_at
         FROM orders_active o
         LEFT JOIN users p ON p.id = o.patient_id
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
        ORDER BY o.created_at ASC
        LIMIT 200`,
      [], []
    ),
    superadminDashboard.getSidebarBadges().catch(() => ({}))
  ]);

  res.render('superadmin_manual_queue', {
    user: req.user,
    lang: langCode,
    orders: rows || [],
    sidebarBadges,
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || ''
  });
});

// Theme 14 Phase 5 — Manual queue detail page.
//
// Loads the order + patient summary + AI prediction (latest
// specialty_classifications row, including alternates_json if populated)
// + cascade specialty/service catalog + doctor pool filtered to the
// predicted specialty. Form posts to /approve or /mark-unsuitable below.
router.get('/superadmin/manual-queue/:id', requireSuperadmin, async (req, res) => {
  const orderId = req.params.id;
  const langCode = (req.user && req.user.lang) ? req.user.lang : 'en';

  const order = await queryOne(
    `SELECT o.id, o.reference_id, o.created_at, o.status, o.payment_status,
            o.base_price, o.urgency_uplift_amount, o.urgency_tier,
            o.clinical_question, o.medical_history, o.current_medications,
            o.specialty_id, o.service_id, o.assignment_status,
            p.id   AS patient_id,
            p.name AS patient_name, p.email AS patient_email, p.phone AS patient_phone,
            -- 2026-08-25: was p.dob. There is no such column — users has
            -- date_of_birth — so this query raised 42703 every single time the
            -- page was opened. The rejection escaped as an unhandledRejection
            -- and src/server.js:379 turned it into process.exit(1), so opening
            -- a manual-queue case restarted the server for every user on it.
            -- error_logs records the crash twice on 2026-08-23 alone, and two
            -- orders are sitting in manual_queue right now.
            p.gender AS patient_gender, p.date_of_birth AS patient_dob
       FROM orders_active o
       LEFT JOIN users p ON p.id = o.patient_id
      WHERE o.id = $1`,
    [orderId]
  );
  if (!order) return res.status(404).send('Order not found');
  if (order.assignment_status !== 'manual_queue') {
    return res.redirect('/superadmin/manual-queue?error=not_in_queue');
  }

  // Latest AI prediction for this case + the uploaded files inventory.
  const [classification, files, specialtiesRaw, servicesRaw] = await Promise.all([
    queryOne(
      `SELECT specialty_id, service_id, confidence, reasoning, alternates_json, created_at
         FROM specialty_classifications
        WHERE case_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [orderId]
    ),
    safeAll(
      `SELECT id, label, url, created_at FROM order_files WHERE order_id = $1 ORDER BY created_at ASC`,
      [orderId], []
    ),
    safeAll(
      `SELECT id, name, name_ar FROM specialties WHERE COALESCE(is_visible, true) = true ORDER BY name ASC`,
      [], []
    ),
    safeAll(
      `SELECT id, specialty_id, name, base_price, currency
         FROM services WHERE COALESCE(is_visible, true) = true
         ORDER BY specialty_id ASC, name ASC`,
      [], []
    )
  ]);

  // Pre-resolve predicted specialty/service names for the AI summary chip.
  const predSpecialtyName = classification && classification.specialty_id
    ? (await queryOne('SELECT name FROM specialties WHERE id = $1', [classification.specialty_id]) || {}).name
    : null;
  const predServiceName = classification && classification.service_id
    ? (await queryOne('SELECT name FROM services WHERE id = $1', [classification.service_id]) || {}).name
    : null;

  // Doctor pool filtered to the predicted specialty (or any specialty if
  // no prediction). The cascade JS on the page re-filters when the admin
  // changes the specialty selection — see the detail view. doctor_specialties
  // is the multi-specialty junction; using it rather than users.specialty_id
  // matches the broadcast flow's eligibility model (notify/broadcast.js).
  const doctorsRaw = await safeAll(
    `SELECT DISTINCT u.id, u.name, ds.specialty_id
       FROM users u
       JOIN doctor_specialties ds ON ds.doctor_id = u.id
      WHERE u.role = 'doctor'
        AND COALESCE(u.is_active, true) = true
      ORDER BY u.name ASC`,
    [], []
  );

  const sidebarBadges = await superadminDashboard.getSidebarBadges().catch(() => ({}));

  res.render('superadmin_manual_queue_detail', {
    user: req.user,
    lang: langCode,
    order,
    classification: classification || null,
    predictedSpecialtyName: predSpecialtyName || null,
    predictedServiceName: predServiceName || null,
    files: files || [],
    specialties: specialtiesRaw || [],
    services: servicesRaw || [],
    doctors: doctorsRaw || [],
    sidebarBadges,
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || ''
  });
});

// Theme 14 Phase 5 — Approve manual-queue triage.
//
// Body: specialty_id (req), service_id (req), doctor_id (opt),
//       override_reason (opt, free-text, 1000 char cap).
//
// Effects:
//   1. UPDATE orders SET specialty_id, service_id, assignment_status='auto'
//      (or 'assigned' when doctor_id is set), doctor_id when manually picked
//   2. INSERT specialty_classification_overrides (ai_* vs patient_*, here
//      "patient_*" is the admin's chosen route — column name preserved for
//      schema compatibility with the patient-self-override flow)
//   3. logOrderEvent label='manual_queue_resolved'
//   4. logAdminAudit action='manual_queue_assigned'
//   5. If chosen specialty differs from AI prediction → queue
//      case_routing_updated notification to the patient (Q2-locked: notify
//      only on specialty change, not service-within-same-specialty)
//   6. If no doctor_id chosen AND order is paid → enqueueAutoAssign +
//      broadcastOrderToSpecialty (the manual_queue gates in those flows
//      release once assignment_status flips to 'auto')
router.post('/superadmin/manual-queue/:id/approve', requireSuperadmin, async (req, res) => {
  const orderId = req.params.id;
  const operatorId = req.user.id;
  const specialtyId = String((req.body && req.body.specialty_id) || '').trim();
  const serviceId = String((req.body && req.body.service_id) || '').trim();
  const doctorId = String((req.body && req.body.doctor_id) || '').trim();
  const overrideReason = String((req.body && req.body.override_reason) || '').trim().slice(0, 1000);

  if (!specialtyId || !serviceId) {
    return res.redirect('/superadmin/manual-queue/' + encodeURIComponent(orderId) + '?error=needs_specialty_service');
  }

  const order = await queryOne(
    `SELECT id, patient_id, assignment_status, payment_status, specialty_id, service_id
       FROM orders_active WHERE id = $1`,
    [orderId]
  );
  if (!order) return res.status(404).send('Order not found');
  if (order.assignment_status !== 'manual_queue') {
    return res.redirect('/superadmin/manual-queue?error=not_in_queue');
  }

  // Validate service belongs to the chosen specialty (and is visible).
  const service = await queryOne(
    `SELECT id, specialty_id FROM services
      WHERE id = $1 AND COALESCE(is_visible, true) = true`,
    [serviceId]
  );
  if (!service || String(service.specialty_id) !== specialtyId) {
    return res.redirect('/superadmin/manual-queue/' + encodeURIComponent(orderId) + '?error=invalid_service');
  }

  // Validate doctor (if picked manually) is in the chosen specialty.
  if (doctorId) {
    const doctorOk = await queryOne(
      `SELECT u.id FROM users u
         JOIN doctor_specialties ds ON ds.doctor_id = u.id
        WHERE u.id = $1 AND u.role = 'doctor'
          AND COALESCE(u.is_active, true) = true
          AND ds.specialty_id = $2 LIMIT 1`,
      [doctorId, specialtyId]
    );
    if (!doctorOk) {
      return res.redirect('/superadmin/manual-queue/' + encodeURIComponent(orderId) + '?error=invalid_doctor');
    }
  }

  // Pull AI prediction so the override row records side-by-side AI vs
  // admin pick (gold-standard prompt-iteration signal).
  const aiRow = await queryOne(
    `SELECT specialty_id, service_id, confidence FROM specialty_classifications
      WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [orderId]
  );

  const nowIso = new Date().toISOString();
  const nextAssignmentStatus = doctorId ? 'assigned' : 'auto';

  try {
    if (doctorId) {
      await execute(
        `UPDATE orders
            SET specialty_id = $1, service_id = $2, doctor_id = $3,
                assignment_status = $4, updated_at = $5
          WHERE id = $6`,
        [specialtyId, serviceId, doctorId, nextAssignmentStatus, nowIso, orderId]
      );
    } else {
      await execute(
        `UPDATE orders
            SET specialty_id = $1, service_id = $2,
                assignment_status = $3, updated_at = $4
          WHERE id = $5`,
        [specialtyId, serviceId, nextAssignmentStatus, nowIso, orderId]
      );
    }

    await execute(
      `INSERT INTO specialty_classification_overrides
         (id, case_id, ai_specialty_id, ai_service_id, ai_confidence,
          patient_specialty_id, patient_service_id, override_at, override_reason,
          actor_role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'superadmin')`,
      [randomUUID(), orderId,
       aiRow ? aiRow.specialty_id : null,
       aiRow ? aiRow.service_id   : null,
       aiRow ? Number(aiRow.confidence) : null,
       specialtyId, serviceId, nowIso,
       overrideReason ? ('superadmin_manual_queue: ' + overrideReason) : 'superadmin_manual_queue']
    );
  } catch (err) {
    logErrorToDb(err, {
      context: 'superadmin.manual_queue_approve',
      requestId: req.requestId,
      userId: operatorId,
      orderId,
      category: 'superadmin_action'
    });
    return res.redirect('/superadmin/manual-queue/' + encodeURIComponent(orderId) + '?error=approve_failed');
  }

  logOrderEvent({
    orderId,
    label: 'manual_queue_resolved',
    meta: {
      operator_user_id: operatorId,
      ai_specialty_id: aiRow ? aiRow.specialty_id : null,
      ai_service_id:   aiRow ? aiRow.service_id   : null,
      ai_confidence:   aiRow ? Number(aiRow.confidence) : null,
      chosen_specialty_id: specialtyId,
      chosen_service_id:   serviceId,
      doctor_picked_manually: !!doctorId,
      manual_doctor_id: doctorId || null,
      override_reason_preview: overrideReason.slice(0, 100)
    },
    actorUserId: operatorId,
    actorRole: 'superadmin'
  });

  logAdminAudit({ req, action: 'manual_queue_assigned', target: '/superadmin/manual-queue/' + orderId });

  // Q2-locked: notify patient ONLY when the specialty changed (not for
  // service-within-same-specialty changes). The patient's wizard-picked
  // specialty is in order.specialty_id at the time of triage; the
  // pre-triage value before this UPDATE is the relevant "before" state.
  const specialtyChanged = order.specialty_id && String(order.specialty_id) !== specialtyId;
  if (specialtyChanged && order.patient_id) {
    try {
      const refId = String(orderId).slice(0, 12).toUpperCase();
      queueMultiChannelNotification({
        orderId,
        toUserId: order.patient_id,
        channels: ['internal', 'email', 'whatsapp'],
        template: 'case_routing_updated',
        response: {
          case_id: orderId,
          caseReference: refId,
          patientName: '' // resolved by notification_worker from users.name
        },
        dedupe_key: 'case_routing_updated:' + orderId
      });
    } catch (_) { /* best-effort */ }
  }

  // If no doctor was manually picked AND the order is paid, re-engage
  // the post-payment routing flow (the manual_queue gates in
  // auto_assign.js / notify/broadcast.js released as soon as we flipped
  // assignment_status above).
  if (!doctorId) {
    const isPaid = ['paid', 'captured'].includes(String(order.payment_status || '').toLowerCase());
    if (isPaid) {
      // AUDIT-H1 — these were `.catch(console.error)`. If either rejected, the
      // redirect below still reported success, nothing reached /ops/errors, and
      // the case became UNREACHABLE: the acceptance watcher only picks up
      // orders that have an acceptance_deadline_at (which the failed broadcast
      // never set), and the SLA sweep only scans IN_REVIEW / REJECTED_FILES. A
      // paid case would sit forever with no doctor and no signal to anyone.
      //
      // Both failures now land in error_logs — surfacing on /ops/errors and in
      // the silent-failures view — and a CASE_ROUTING_FAILED event goes on the
      // case timeline so the order itself carries the evidence.
      enqueueAutoAssign(orderId).catch(function (err) {
        logErrorToDb(err, {
          context: 'manual_queue_approve.enqueueAutoAssign',
          category: 'assignment',
          orderId: orderId,
          userId: req.user && req.user.id,
          requestId: req.requestId
        });
        Promise.resolve(caseLifecycle.logCaseEvent(orderId, 'CASE_ROUTING_FAILED', {
          stage: 'auto_assign', reason: err && err.message, via: 'manual_queue_approve'
        })).catch(function () {});
      });
      broadcastOrderToSpecialty(orderId).catch(function (err) {
        logErrorToDb(err, {
          context: 'manual_queue_approve.broadcast',
          category: 'assignment',
          orderId: orderId,
          userId: req.user && req.user.id,
          requestId: req.requestId
        });
        Promise.resolve(caseLifecycle.logCaseEvent(orderId, 'CASE_ROUTING_FAILED', {
          stage: 'broadcast', reason: err && err.message, via: 'manual_queue_approve'
        })).catch(function () {});
      });
    }
  }

  return res.redirect('/superadmin/manual-queue?flash=approved');
});

// Theme 14 Phase 5 — Mark a manual-queue case unsuitable.
//
// Body: reason (req — one of the preset codes OR free-text).
//
// Effects:
//   1. UPDATE orders SET status='cancelled', assignment_status='cancelled'
//   2. If payment_status='paid' → INSERT refunds row (status='pending',
//      reason='operator_refund', requested_amount = base_price+uplift,
//      instapay_handle pulled from order.refund_instapay_handle if set,
//      else 'awaiting_patient' placeholder so the row is still creatable
//      and the refund queue can prompt the patient). The full operator-
//      refund flow lives at POST /superadmin/refunds/create; we duplicate
//      the minimum INSERT here so "mark unsuitable" is a single click.
//   3. logOrderEvent + logAdminAudit
//   4. Queue case_cancelled_patient notification with reason
// Preset reason codes → patient-facing copy. The form posts a combined
// string of "code | free-text"; this map resolves the leading code to a
// readable phrase before the cancellation notification ships. The raw
// combined string is still preserved in order_events.meta for analytics.
const MANUAL_QUEUE_UNSUITABLE_REASONS = {
  scope_outside_capability:        { en: 'This case falls outside the scope of our platform.', ar: 'الحالة دي خارج نطاق خدمات المنصة.' },
  insufficient_info_after_review:  { en: 'After review, the information provided was not sufficient for a second opinion.', ar: 'بعد المراجعة، المعلومات المقدمة مكانتش كافية لرأي طبي ثاني.' },
  not_second_opinion_case:         { en: 'This case is not a medical second-opinion request.', ar: 'الحالة دي مش طلب رأي طبي ثاني.' },
  other:                           { en: '', ar: '' }
};

router.post('/superadmin/manual-queue/:id/mark-unsuitable', requireSuperadmin, async (req, res) => {
  const orderId = req.params.id;
  const operatorId = req.user.id;
  const reasonRaw = String((req.body && req.body.reason) || '').trim().slice(0, 500);

  if (!reasonRaw) {
    return res.redirect('/superadmin/manual-queue/' + encodeURIComponent(orderId) + '?error=reason_required');
  }

  // Parse "code | free-text" submitted by the view's combiner. The free-
  // text portion (if any) is the operator's elaboration. For "other" we
  // use the free-text only; for known codes we prepend the canonical
  // sentence and append the elaboration when present.
  const parts = reasonRaw.split('|').map(function(s){ return s.trim(); });
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

  // AUDIT (2026-08-17) — the SELECT now fetches everything maxRefundableEgp
  // needs (price + the add-on columns), not just the two legacy snapshot fields.
  const order = await queryOne(
    `SELECT id, patient_id, assignment_status, status, payment_status,
            price, base_price, urgency_uplift_amount, addons_json,
            video_consultation_selected, video_consultation_price
       FROM orders_active WHERE id = $1`,
    [orderId]
  );
  if (!order) return res.status(404).send('Order not found');
  if (order.assignment_status !== 'manual_queue') {
    return res.redirect('/superadmin/manual-queue?error=not_in_queue');
  }

  const nowIso = new Date().toISOString();

  try {
    await execute(
      `UPDATE orders
          SET status = 'cancelled', assignment_status = 'cancelled', updated_at = $1
        WHERE id = $2`,
      [nowIso, orderId]
    );

    // Open a pending refund if the case was already paid. instapay_handle
    // is unknown at this stage — the refund queue will prompt the patient
    // (or the operator) to complete it via POST /superadmin/refunds/:id/...
    const isPaid = String(order.payment_status || '').toLowerCase() === 'paid';
    if (isPaid) {
      const existing = await queryOne(
        `SELECT id FROM refunds
          WHERE order_id = $1 AND status IN ('pending','auto_approved','approved','paid')
          LIMIT 1`,
        [orderId]
      );
      if (!existing) {
        // AUDIT (2026-08-17) — was `base_price + urgency_uplift_amount`, which
        // is wrong twice over: it omits every add-on the patient actually paid
        // for (video consultation, prescription — all priced into the Paymob
        // intention by services/order_pricing.owedCentsForOrder), and it
        // evaluates to 0 for the orders whose creation path never wrote
        // base_price, opening a refund for nothing at all. maxRefundableEgp is
        // the single source of truth: price + selected add-ons, i.e. literally
        // what the gateway charged, with the base+uplift sum kept only as a
        // legacy reconstruction fallback.
        const refundAmount = maxRefundableEgp(order);
        await execute(
          `INSERT INTO refunds (
             id, order_id, amount_egp, requested_amount, approved_amount,
             reason, patient_reason, instapay_handle, status,
             requested_by, refunded_at, refunded_by, notes
           ) VALUES ($1, $2, $3, $3, NULL, 'operator_refund', NULL, $4, 'pending',
                     $5, NOW(), $5, $6)`,
          [randomUUID(), orderId, refundAmount, 'awaiting_patient', operatorId,
           'manual_queue_unsuitable: ' + reasonRaw]
        );
      }
    }
  } catch (err) {
    logErrorToDb(err, {
      context: 'superadmin.manual_queue_mark_unsuitable',
      requestId: req.requestId,
      userId: operatorId,
      orderId,
      category: 'superadmin_action'
    });
    return res.redirect('/superadmin/manual-queue/' + encodeURIComponent(orderId) + '?error=mark_failed');
  }

  logOrderEvent({
    orderId,
    label: 'manual_queue_marked_unsuitable',
    meta: {
      operator_user_id: operatorId,
      reason: reasonRaw,
      was_paid: String(order.payment_status || '').toLowerCase() === 'paid'
    },
    actorUserId: operatorId,
    actorRole: 'superadmin'
  });

  logAdminAudit({ req, action: 'manual_queue_marked_unsuitable', target: '/superadmin/manual-queue/' + orderId });

  if (order.patient_id) {
    try {
      const refId = String(orderId).slice(0, 12).toUpperCase();
      queueMultiChannelNotification({
        orderId,
        toUserId: order.patient_id,
        channels: ['internal', 'email', 'whatsapp'],
        template: 'case_cancelled_patient',
        response: {
          order_id: orderId,
          caseReference: refId,
          reason: reasonForPatient
        },
        dedupe_key: 'case_cancelled:' + orderId
      });
    } catch (_) { /* best-effort */ }
  }

  return res.redirect('/superadmin/manual-queue?flash=marked_unsuitable');
});

// Order detail (superadmin)
router.get('/superadmin/orders/:id', requireSuperadmin, async (req, res) => {
  const orderId = req.params.id;
  const order = await queryOne(
    `SELECT o.*,
            p.name AS patient_name, p.email AS patient_email,
            d.name AS doctor_name, d.email AS doctor_email,
            s.name AS specialty_name,
            sv.name AS service_name,
            sv.base_price AS service_price,
            sv.doctor_fee AS service_doctor_fee,
            sv.currency AS service_currency,
            sv.payment_link AS service_payment_link
     FROM orders_active o
     LEFT JOIN users p ON p.id = o.patient_id
     LEFT JOIN users d ON d.id = o.doctor_id
     LEFT JOIN specialties s ON s.id = o.specialty_id
     LEFT JOIN services sv ON sv.id = o.service_id
     WHERE o.id = $1`,
    [orderId]
  );

  if (!order) {
    return res.redirect('/superadmin');
  }

  const events = await queryAll(
    `SELECT id, label, meta, at
     FROM order_events
     WHERE order_id = $1
     ORDER BY at DESC
     LIMIT 20`,
    [orderId]
  );

  const doctors = await queryAll(
    "SELECT id, name FROM users WHERE role = 'doctor' AND is_active = true ORDER BY name ASC"
  );

  const displayPrice = order.price != null ? order.price : order.service_price;
  const displayDoctorFee = order.doctor_fee != null ? order.doctor_fee : order.service_doctor_fee;
  const displayCurrency = order.currency || order.service_currency || 'EGP';
  const paymentLink = order.payment_link || order.service_payment_link || null;

  const additionalFilesRequest = await computeAdditionalFilesRequestState(orderId);
  const langCode = (req.user && req.user.lang) ? req.user.lang : 'en';

  return res.render('superadmin_order_detail', {
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
    user: req.user,
    order: {
      ...order,
      displayPrice,
      displayDoctorFee,
      displayCurrency,
      // Backward-compatible aliases for templates
      payment_link: paymentLink,
      paymentLink: paymentLink,
      currency: displayCurrency
    },
    statusUi: safeGetStatusUi(order.status, langCode),
    events,
    doctors,
    additionalFilesRequest
  });
});

// Approve / reject doctor's request for additional files (superadmin)
router.post('/superadmin/orders/:id/additional-files/approve', requireSuperadmin, async (req, res) => {
  const orderId = req.params.id;
  const { request_event_id, support_note } = req.body || {};

  const order = await queryOne('SELECT id, patient_id, status FROM orders_active WHERE id = $1', [orderId]);
  if (!order) return res.redirect('/superadmin');

  const nowIso = new Date().toISOString();

  // Theme 7 sub-issue D (2026-05-10): alias 'awaiting_files' → REJECTED_FILES.
  // The doctor reject-files route already writes status='rejected_files'
  // raw before this superadmin approval lands. If the case is in a
  // pre-rejected-files state at the moment of approval, defensively
  // transition via the canonical helper, which also pauses the SLA.
  // Skip if already in REJECTED_FILES (or its legacy alias
  // 'awaiting_files') or COMPLETED.
  const currentLower = String(order.status || '').toLowerCase();
  const inRejectedFiles =
    currentLower === 'rejected_files' || currentLower === 'awaiting_files';
  if (currentLower !== 'completed' && !inRejectedFiles) {
    try {
      await caseLifecycle.markOrderRejectedFiles({
        caseId: orderId,
        doctorId: req.user && req.user.id,
        reason: support_note || 'Additional files request approved (superadmin)',
        opts: { requireAdminApproval: false }
      });
    } catch (err) {
      logErrorToDb(err, {
        context: 'superadmin.additional_files_approve_mark_rejected',
        requestId: req.requestId,
        userId: req.user?.id,
        url: req.originalUrl,
        method: req.method,
        category: 'superadmin_action'
      });
      console.error('[superadmin.additional-files.approve] markOrderRejectedFiles failed:', err && err.message);
    }
  }

  await execute(
    `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      randomUUID(),
      orderId,
      // Theme 7 sub-issue D: 'superadmin_approved_files_request' is the
      // canonical short identifier. The substring 'approved' keeps the
      // existing fuzzy LIKE '%approved%' decision-event matchers
      // working without code changes; an explicit-literal match was
      // also added to those matchers for clarity.
      'superadmin_approved_files_request',
      JSON.stringify({ request_event_id: request_event_id || null, support_note: support_note || null }),
      nowIso,
      req.user.id,
      'superadmin'
    ]
  );

  // AUDIT (2026-08-17) — approving the request must also UNLOCK uploads.
  // orders.uploads_locked is set to true at payment (routes/payments.js webhook)
  // and routes/patient.js hard-blocks the patient upload POST on it. So on a
  // case locked at payment, the patient was told "your specialist needs more
  // files", clicked upload, and was bounced with ?error=locked — the request
  // could never be satisfied and the case sat in REJECTED_FILES with a paused
  // SLA until someone found the separate manual unlock endpoint
  // (POST /admin/orders/:id/uploads/unlock), which was the ONLY writer that
  // cleared the flag. routes/admin.js's approve handler now does the same.
  // Same guard as the manual endpoint: never unlock a completed case.
  if (currentLower !== 'completed') {
    try {
      await execute(
        'UPDATE orders SET uploads_locked = false, updated_at = $1 WHERE id = $2',
        [nowIso, orderId]
      );
      logOrderEvent({
        orderId,
        label: 'uploads_unlocked',
        meta: JSON.stringify({ reason: 'additional_files_request_approved' }),
        actorUserId: req.user && req.user.id,
        actorRole: 'superadmin'
      });
    } catch (err) {
      logErrorToDb(err, {
        context: 'superadmin.additional_files_approve_unlock_uploads',
        requestId: req.requestId,
        userId: req.user?.id,
        orderId,
        category: 'superadmin_action'
      });
    }
  }

  // Notify patient AFTER approval (routing rule)
  if (order.patient_id) {
    queueMultiChannelNotification({
      orderId,
      toUserId: order.patient_id,
      channels: ['internal', 'email', 'whatsapp'],
      template: 'additional_files_requested_patient',
      response: {
        case_id: orderId,
        caseReference: orderId.slice(0, 12).toUpperCase(),
        reason: support_note || 'Additional files needed'
      },
      dedupe_key: 'additional_files_request:' + orderId + ':' + Date.now()
    });

    // Phase 4: parallel direct email so the notification lands even if the
    // queueMultiChannelNotification system is gated off (EMAIL_ENABLED=false).
    // Wired here, not in case_lifecycle.markOrderRejectedFiles, because the
    // existing routing rule says "no patient notification until admin approves"
    // (see case_lifecycle.js comment around line 1455).
    try {
      const recipient = await queryOne(
        'SELECT u.email, u.name, COALESCE(o.reference_id, c.reference_code) AS reference_id'
        + ' FROM orders_active o LEFT JOIN users u ON u.id = o.patient_id LEFT JOIN cases c ON c.id = o.id'
        + ' WHERE o.id = $1',
        [orderId]
      );
      if (recipient && recipient.email) {
        const refId = recipient.reference_id || String(orderId).slice(0, 12).toUpperCase();
        await emailService.notifyMoreInfoRequested(
          { email: recipient.email, name: recipient.name },
          refId,
          support_note || ''
        );
      }
    } catch (err) {
      logErrorToDb(err, {
        context: 'superadmin.additional_files_approve_notify_more_info',
        requestId: req.requestId,
        userId: req.user?.id,
        url: req.originalUrl,
        method: req.method,
        category: 'superadmin_action'
      });
      console.error('[EMAIL] notifyMoreInfoRequested failed:', err && err.message);
    }
  }

  return res.redirect(`/superadmin/orders/${orderId}?additional_files=approved`);
});

router.post('/superadmin/orders/:id/additional-files/reject', requireSuperadmin, async (req, res) => {
  const orderId = req.params.id;
  const { request_event_id, support_note } = req.body || {};

  const order = await queryOne('SELECT id, patient_id FROM orders_active WHERE id = $1', [orderId]);
  if (!order) return res.redirect('/superadmin');

  const nowIso = new Date().toISOString();

  await execute(
    `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      randomUUID(),
      orderId,
      'Additional files request rejected (superadmin)',
      JSON.stringify({ request_event_id: request_event_id || null, support_note: support_note || null }),
      nowIso,
      req.user.id,
      'superadmin'
    ]
  );

  return res.redirect(`/superadmin/orders/${orderId}?additional_files=rejected`);
});

// DOCTOR MANAGEMENT

// AUDIT-2026-08-23 (P0-DOC-FORM) — the doctor create/edit form and these two
// routes disagreed about every field name it posts: the form sent full_name /
// active / send_whatsapp_alerts / service_ids_csv, the routes read name /
// is_active / notify_whatsapp / service_ids. Nothing lined up, so "Add doctor"
// always 400'd on `!name` and "Edit doctor" wrote is_active=false,
// notify_whatsapp=false and deleted every doctor_services row for the doctor.
//
// The view now posts the canonical names (the users column names) and these
// helpers keep accepting the old spellings, so a bookmarked POST, a cached
// page still open in an admin's tab, or any other caller keeps working instead
// of silently doing the wrong thing.

// First non-empty value among `keys`. Empty string counts as absent so that
// `name=&full_name=Dr+X` resolves to the value the caller actually filled in.
function pickDoctorField(body, keys) {
  const b = body || {};
  for (const k of keys) {
    const v = b[k];
    if (v === undefined || v === null) continue;
    if (String(v).trim() === '') continue;
    return v;
  }
  return undefined;
}

// A checkbox that is not ticked posts NOTHING, which makes `undefined`
// ambiguous between "the admin unticked it" and "this caller never sent the
// field at all". The form pairs each checkbox with a hidden companion of the
// same name carrying "0", posted first — so unticked arrives as "0" and, when
// ticked, qs gives ["0","1"] and the last value wins. A field that is truly
// absent returns `fallback`, which is how the edit route preserves the stored
// value instead of stamping false over it.
// AUDIT-2026-08-23 (AUDIT-DOCTOR-LANG-1) — the doctor's email language.
// Create used to hardcode `lang: 'en'` and Edit never wrote the column at all,
// so for 27 of 30 doctors `users.lang` was an untouched default rather than a
// stated preference. The welcome email picks its template directory from this
// value, so the default decided which language a consultant saw first and
// nobody was ever asked. Only 'ar' and 'en' are accepted; anything else falls
// back rather than writing a value the template loader cannot resolve.
function readDoctorLang(body, fallback) {
  const raw = String((body && (body.lang != null ? body.lang : body.language)) || '')
    .trim().toLowerCase();
  if (raw === 'ar' || raw === 'en') return raw;
  return (fallback === 'ar') ? 'ar' : 'en';
}

function readDoctorFlag(body, keys, fallback) {
  const b = body || {};
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) continue;
    let v = b[k];
    if (Array.isArray(v)) v = v.length ? v[v.length - 1] : '';
    const sv = String(v == null ? '' : v).trim().toLowerCase();
    return !(sv === '' || sv === '0' || sv === 'false' || sv === 'off' || sv === 'no');
  }
  return fallback;
}

// The sub-specialty picker serialises to CSV in two hidden inputs
// (service_ids_csv + the legacy sub_specialties_csv mirror, both written by
// public/js/superadmin_doctor_form.js as a bare comma-joined id list, no
// spaces, empty string when nothing is selected). It never posts a
// `service_ids` array — accept all three shapes.
//
// Returns null when the request carried no service field and no
// `service_ids_submitted` marker, i.e. the caller said nothing about services.
// The edit route MUST NOT touch doctor_services in that case: a doctor with no
// doctor_services rows is unassignable forever (see the EXISTS gate in
// src/services/doctor_eligibility.js), and that deletion used to happen on
// every single save.
function readDoctorServiceIds(body) {
  const b = body || {};
  let present = Object.prototype.hasOwnProperty.call(b, 'service_ids_submitted');
  const seen = new Set();
  const out = [];
  for (const key of ['service_ids', 'service_ids_csv', 'sub_specialties_csv']) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) continue;
    present = true;
    const chunks = Array.isArray(b[key]) ? b[key] : [b[key]];
    for (const chunk of chunks) {
      String(chunk == null ? '' : chunk).split(',').forEach((piece) => {
        const v = piece.trim();
        if (v && !seen.has(v)) { seen.add(v); out.push(v); }
      });
    }
  }
  return present ? out : null;
}

// Specialties an admin may actually put a doctor on.
//
// AUDIT-2026-08-23 (P0-DOC-FORM): the pickers listed every row in the table —
// specialties deliberately hidden from patients (migrations 060 psychiatry,
// 066 oncology, …) and the internal 'addon' bucket from migration 041, which
// is not a clinical specialty at all but a parent for cross-specialty add-ons.
// Assigning a doctor there produces a doctor no patient can ever reach.
//
// `keepId` re-admits one specific row: a doctor already sitting on a
// now-hidden specialty must keep seeing their real value on the edit form,
// otherwise the <select> renders blank and the next save silently clears
// users.specialty_id.
async function loadAssignableSpecialties(keepId) {
  const keep = keepId ? String(keepId) : '';
  return queryAll(
    `SELECT id, name
       FROM specialties
      WHERE (COALESCE(is_visible, true) = true AND id <> 'addon')
         OR ($1::text <> '' AND id = $1::text)
      ORDER BY name ASC`,
    [keep]
  );
}

router.get('/superadmin/doctors', requireSuperadmin, async (req, res) => {
  const statusFilter = req.query.status || 'all';
  const conditions = ["u.role = 'doctor'"];
  if (statusFilter === 'pending') {
    conditions.push('u.pending_approval = true');
  } else if (statusFilter === 'approved') {
    conditions.push('u.pending_approval = false');
    conditions.push('u.is_active = true');
  } else if (statusFilter === 'rejected') {
    conditions.push('u.pending_approval = false');
    conditions.push('u.is_active = false');
    conditions.push('u.rejection_reason IS NOT NULL');
  } else if (statusFilter === 'inactive') {
    conditions.push('u.is_active = false');
  } else if (statusFilter === 'paused') {
    // P1-FIN-2: filter to auto-paused / manually-paused doctors
    conditions.push('COALESCE(u.is_paused, false) = true');
  }

  const doctors = await queryAll(
      `SELECT u.id, u.name, u.email, u.phone, u.notify_whatsapp, u.is_active, u.created_at, u.specialty_id,
              u.pending_approval, u.approved_at, u.rejection_reason, u.signup_notes,
              u.is_paused, u.paused_at, u.pause_reason,
              -- Migration 064: tracks last welcome-email queue time so the
              -- view can show "Welcome sent Xh ago" and gate the resend button.
              u.welcome_email_last_sent_at,
              -- Derived boolean: true once the doctor has set their password
              -- (i.e. completed the magic-login → /set-password flow). Used
              -- to disable the Resend-welcome button so admins don't email
              -- a setup link to someone who's already onboarded.
              (u.password_hash IS NOT NULL) AS has_password,
              s.name AS specialty_name
       FROM users u
       LEFT JOIN specialties s ON s.id = u.specialty_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY u.pending_approval DESC, COALESCE(u.is_paused, false) DESC, u.is_active DESC, u.created_at DESC`
  );
  const specialties = await queryAll('SELECT id, name FROM specialties ORDER BY name ASC');
  const pendingDoctorsRow = await queryOne(
    "SELECT COUNT(*) as c FROM users WHERE role = 'doctor' AND pending_approval = true"
  );
  const pausedDoctorsRow = await queryOne(
    "SELECT COUNT(*) as c FROM users WHERE role = 'doctor' AND COALESCE(is_paused, false) = true"
  );
  const pendingDoctorsCount = pendingDoctorsRow ? pendingDoctorsRow.c : 0;
  const pausedDoctorsCount = pausedDoctorsRow ? pausedDoctorsRow.c : 0;

  // How many the "Email all" button would actually send to right now. Mirrors
  // bulkWelcomePasswordlessDoctors' cohort EXACTLY — same predicate, same
  // DEFAULT_COOLDOWN_HOURS, computed in SQL so it is TZ-safe — because a button
  // that says "23" and then sends 4 is worse than no button.
  let bulkWelcomeEligible = 0;
  let bulkWelcomeCooling = 0;
  try {
    const cohort = await queryOne(
      `SELECT COUNT(*) FILTER (WHERE welcome_email_last_sent_at IS NULL
                                  OR welcome_email_last_sent_at < NOW() - ($1::int * interval '1 hour'))::int AS eligible,
              COUNT(*) FILTER (WHERE welcome_email_last_sent_at IS NOT NULL
                                 AND welcome_email_last_sent_at >= NOW() - ($1::int * interval '1 hour'))::int AS cooling
         FROM users
        WHERE role = 'doctor' AND is_active = true AND password_hash IS NULL`,
      [BULK_WELCOME_COOLDOWN_HOURS]
    );
    bulkWelcomeEligible = cohort ? Number(cohort.eligible) || 0 : 0;
    bulkWelcomeCooling  = cohort ? Number(cohort.cooling)  || 0 : 0;
  } catch (_) { /* best-effort: the page renders, the button just says nothing */ }

  res.render('superadmin_doctors', {
    user: req.user, doctors, specialties, statusFilter,
    pendingDoctorsCount, pausedDoctorsCount,
    bulkWelcomeEligible, bulkWelcomeCooling,
    bulkWelcomeCooldownHours: BULK_WELCOME_COOLDOWN_HOURS,
    welcomeSent:    req.query.welcome_sent    != null ? Number(req.query.welcome_sent)    || 0 : null,
    welcomeSkipped: req.query.welcome_skipped != null ? Number(req.query.welcome_skipped) || 0 : null,
    welcomeFailed:  req.query.welcome_failed  != null ? Number(req.query.welcome_failed)  || 0 : null,
    welcomeError:   req.query.welcome_error === '1',
    welcomeBusy:    req.query.welcome_busy === '1'
  });
});

router.get('/superadmin/doctors/new', requireSuperadmin, async (req, res) => {
  const specialties = await loadAssignableSpecialties(null);
  const subSpecialties = await queryAll(
    'SELECT id, specialty_id, name FROM services WHERE specialty_id IS NOT NULL ORDER BY name ASC'
  );

  res.render('superadmin_doctor_form', {
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
    user: req.user,
    specialties,
    subSpecialties,
    selectedServiceIds: [],
    error: null,
    doctor: null,
    isEdit: false
  });
});

router.post('/superadmin/doctors/new', requireSuperadmin, async (req, res) => {
  // AUDIT-2026-08-23 (P0-DOC-FORM): the form posts full_name / active /
  // send_whatsapp_alerts / service_ids_csv, this route only ever read name /
  // is_active / notify_whatsapp / service_ids — so `!name` was true on every
  // submission and this form has never created a doctor. Accept both spellings.
  const body = req.body || {};
  const name = pickDoctorField(body, ['name', 'full_name']);
  const email = pickDoctorField(body, ['email']);
  const specialty_id = pickDoctorField(body, ['specialty_id']);
  const phone = pickDoctorField(body, ['phone']);
  // A new doctor with is_active absent stays active (the form's previous,
  // intended default) rather than being created switched off.
  const notify_whatsapp = readDoctorFlag(body, ['notify_whatsapp', 'send_whatsapp_alerts'], false);
  const is_active = readDoctorFlag(body, ['is_active', 'active'], true);
  const lang = readDoctorLang(body, 'en');
  const submittedServiceIds = readDoctorServiceIds(body);

  // Re-render helper for the two 400 paths below — same locals, one message.
  const renderInvalid = async (message) => {
    const specialties = await loadAssignableSpecialties(specialty_id);
    const subSpecialties = await queryAll('SELECT id, specialty_id, name FROM services WHERE specialty_id IS NOT NULL ORDER BY name ASC');
    return res.status(400).render('superadmin_doctor_form', {
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
      user: req.user,
      specialties,
      subSpecialties,
      selectedServiceIds: submittedServiceIds || [],
      error: message,
      // Repopulation only — deliberately carries no `id`, and `isEdit: false`
      // keeps the page titled "Add doctor" (the view used to flip to "Edit
      // doctor" here purely because this object is truthy).
      doctor: {
        name: name || '',
        email: email || '',
        specialty_id: specialty_id || '',
        phone: phone || '',
        lang,
        notify_whatsapp,
        is_active
      },
      isEdit: false
    });
  };

  if (!name || !email) {
    return renderInvalid('Name and email are required.');
  }

  const existing = await queryOne('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) {
    return renderInvalid('Email already exists.');
  }

  // No password is generated here. The doctor sets their own password by
  // following a one-time link delivered via email — same machinery as the
  // portal POST /forgot-password handler in src/routes/auth.js. This keeps
  // any plaintext credential out of stdout, the database, and the inbox.
  const newDoctorId = randomUUID();
  await execute(
    `INSERT INTO users (id, email, password_hash, name, role, specialty_id, phone, lang, notify_whatsapp, is_active)
     VALUES ($1, $2, NULL, $3, 'doctor', $4, $5, $6, $7, $8)`,
    [
      newDoctorId,
      email,
      name,
      specialty_id || null,
      phone || null,
      lang,
      notify_whatsapp ? true : false,
      is_active ? true : false
    ]
  );


  // 2026-08-25 — mirror the primary specialty into doctor_specialties.
  //
  // That table is what notify/broadcast.js and the assign dropdowns on this
  // very page key off, but only self-signup ever wrote it — so every doctor an
  // operator created here was invisible to case broadcast and unpickable in
  // the assign list, while looking perfectly normal everywhere else. 18 of 31
  // doctors were in that state before migration 091 backfilled them; without
  // this line the drift starts again with the next doctor created.
  //
  // id is text NOT NULL with no default on this table, hence the explicit
  // randomUUID(). The anti-join keeps it idempotent — there is no unique
  // constraint on (doctor_id, specialty_id) to hang ON CONFLICT off.
  if (specialty_id) {
    try {
      await execute(
        `INSERT INTO doctor_specialties (id, doctor_id, specialty_id, created_at)
         SELECT $1, $2, $3, NOW()
          WHERE NOT EXISTS (
                SELECT 1 FROM doctor_specialties
                 WHERE doctor_id = $2 AND specialty_id = $3
              )`,
        [randomUUID(), newDoctorId, specialty_id]
      );
    } catch (e) {
      // Never block doctor creation on the mirror — broadcast also matches
      // users.specialty_id directly now, so a miss here degrades rather than
      // hides the doctor. But it must be visible.
      logErrorToDb(e, { context: 'superadmin.doctor_create_specialty_mirror', userId: newDoctorId });
    }
  }

  // Map selected sub-specialties (services) to the doctor
  const cleanedServiceIds = submittedServiceIds || [];

  if (cleanedServiceIds.length && specialty_id) {
    const ph = cleanedServiceIds.map((_, i) => `$${i + 1}`).join(',');
    const allowed = (await queryAll(
      `SELECT id FROM services WHERE id IN (${ph}) AND specialty_id = $${cleanedServiceIds.length + 1}`,
      [...cleanedServiceIds, specialty_id]
    )).map((r) => r.id);

    for (const sid of allowed) {
      await execute('INSERT INTO doctor_services (doctor_id, service_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [newDoctorId, sid]);
    }
  }

  // AUDIT-2026-08-23 (P0-DOC-WELCOME): this route used to hand-roll its own
  // token and then send the GENERIC 'password-reset' template — English-only,
  // blue-branded, "We received a request to reset the password for your
  // Tashkheesa account", addressed to `patientName`. A doctor created here
  // requested nothing, and EVERY other onboarding path (/approve,
  // /resend-welcome, /bulk-welcome-passwordless, the Command app) sends the
  // bilingual v5 doctor-welcome instead. The create path now goes through the
  // SAME service as the Command app and the bulk invite —
  // services/admin_doctor_invite.inviteDoctor (remint-DELETE + 7-day token +
  // welcome stamp + audit in one txn) -> buildDoctorWelcomePayload -> template
  // 'doctor_approved' -> doctor-welcome.hbs. One welcome email, one place that
  // mints its token. It also means a normal create now produces exactly ONE
  // email, so there is no second send to silently invalidate the first link.

  // Resolve the public base URL from CONFIGURATION ONLY.
  //
  // AUDIT-2026-08-22 (AUDIT-RESET-HOST-1) — this used to fall back to
  // `x-forwarded-host || host`, i.e. to a request header, when BASE_URL and
  // APP_URL were both empty. That puts an attacker-controllable value into the
  // body of an EMAILED password-setup link: anyone who can reach this service on
  // a hostname of their choosing gets the token delivered to their own host. The
  // route is superadmin-gated and BASE_URL is set in render.yaml, so this was
  // mitigated rather than exploitable — but "never derives a link from the
  // request" is a property the codebase claims, and it only actually held in
  // src/routes/auth.js. It holds here now too.
  //
  // No link is better than a wrong link: with neither env var set the caller
  // below reports `base_url_unresolved` and the operator fixes the config.
  //
  // AUDIT-2026-08-23: this property SURVIVES the switch to the shared service
  // only because inviteDoctor takes `baseUrl` as a parameter and never sees
  // `req` — unlike _issueDoctorWelcomePayload (below), which still falls back to
  // request headers for /approve and /resend-welcome.
  const baseUrl = String(process.env.BASE_URL || process.env.APP_URL || '')
    .trim().replace(/\/+$/, '');

  let emailOk = false;
  let emailErrorMsg = null;
  if (!baseUrl) {
    emailErrorMsg = 'base_url_unresolved';
  } else if (!is_active) {
    // AUDIT-2026-08-23: inviteDoctor refuses a non-active doctor by design
    // (approve/activate first, then invite). Creating a doctor switched OFF is a
    // deliberate "not yet", so mint nothing and send nothing rather than mailing
    // "your account is ready" to an account the operator just disabled. The
    // record is still saved and the message below points at Resend welcome.
    emailErrorMsg = 'doctor_not_active';
  } else {
    const inviteClient = await pool.connect();
    try {
      const { welcomePayload } = await inviteDoctor(inviteClient, {
        doctorId: newDoctorId,
        baseUrl,
        actorId: req.user && req.user.id
      });
      // POST-COMMIT, and identical to /approve + /resend-welcome in channels,
      // template and payload. Awaited (those two fire-and-forget) purely so a
      // queue-insert failure can still be surfaced to the operator below.
      const queued = await queueMultiChannelNotification({
        orderId: null,
        toUserId: newDoctorId,
        channels: ['internal', 'email', 'whatsapp'],
        template: 'doctor_approved',
        response: welcomePayload,
        // Stable key: a given doctor id is created exactly once, so this can
        // never suppress a legitimate later resend (those carry their own
        // timestamped keys).
        dedupe_key: 'doctor_welcome_create:' + newDoctorId
      });
      const emailQueued = queued && queued.results && queued.results.email;
      emailOk = !!(emailQueued && emailQueued.ok && !emailQueued.skipped);
      if (!emailOk) {
        emailErrorMsg = (emailQueued && (emailQueued.reason || emailQueued.error || emailQueued.skipped)) || 'queue_failed';
      }
    } catch (err) {
      logErrorToDb(err, {
        context: 'superadmin.doctor_create_welcome',
        requestId: req.requestId,
        userId: req.user?.id,
        url: req.originalUrl,
        method: req.method,
        category: 'superadmin_auth'
      });
      emailErrorMsg = (err && err.message) || 'send_failed';
    } finally {
      inviteClient.release();
    }
  }

  if (!emailOk) {
    // Doctor record is already saved — do NOT roll back. Surface a clear
    // failure to the superadmin so they can retry from the doctor's page.
    // Never include the token in the response or logs.
    // THEME8-LINT-EXEMPT-HELPER: downstream diagnostic — the originating
    // error is already captured by the wrapped catch at the send call site
    // above (context='superadmin.doctor_create_welcome'). This line is a
    // human-readable summary including the masked email for stdout triage;
    // duplicating to /ops/errors would create two rows for one event.
    console.warn('[doctor-create] welcome-email send failed for ' + email + ': ' + emailErrorMsg);
    return res
      .status(200)
      .type('text/plain')
      .send(
        'Doctor created for ' + email + ', but the welcome email was not sent (' + emailErrorMsg + '). ' +
        'The record is saved — open /superadmin/doctors/' + newDoctorId + ' and use "Resend welcome" to retry.'
      );
  }

  return res.redirect('/superadmin/doctors');
});

// ROUTE ORDER MATTERS: this literal path MUST stay above
// /superadmin/doctors/:id (and /:id/edit). Express matches in registration
// order, so when this sat below them '/superadmin/doctors/bulk-welcome' bound
// :id='bulk-welcome', found no such doctor, and redirected back to the list —
// the button looked like it did nothing. /superadmin/doctors/new is above them
// for exactly this reason; this one was not, and should have been.
// GET the review page for the bulk invite.
//
// 2026-08-25 — the first version of this feature guarded a 23-recipient,
// irreversible send with onsubmit="return confirm(...)". The CSP at
// server.js:487 is `script-src 'self' 'unsafe-eval' 'nonce-...'` with NO
// 'unsafe-inline', and a nonce does not authorise inline EVENT HANDLER
// attributes — only 'unsafe-inline' or 'unsafe-hashes' does. So the browser
// refused to run the handler, the submit default was never cancelled, and one
// click sent all 23 with no prompt at all. (The two pre-existing confirms on
// this page have never run either, for the same reason.)
//
// A page cannot be disabled by a content policy. This lists exactly who is
// about to be emailed, and the POST lives here — so the operator sees the
// names before the click, not a number.
router.get('/superadmin/doctors/bulk-welcome', requireSuperadmin, async (req, res) => {
  // 2026-08-25 — this handler took production down in a restart loop, and the
  // mechanism is worth writing out because it is not obvious.
  //
  // assertRenderableView THROWS when a view is absent from views/registry.js.
  // I added superadmin_bulk_welcome.ejs and never registered it. Express 4
  // does not catch a rejection from an async handler, so the throw became an
  // unhandledRejection, and server.js turns those into process.exit(1). Every
  // click on "Email all" therefore killed the process: 502, Render restarts,
  // click again, 502.
  //
  // The registry entry is the actual fix. This try/catch is the second lock:
  // a page that lists doctors must not be able to take the platform down, and
  // ANY throw in here — a schema drift on the SELECT, a missing partial, a
  // template typo — had exactly the same reach.
  try {
    // Same cohort the send uses, but with names, so this is a review and not a
    // restatement of the count.
    const rows = await queryAll(
      `SELECT id, name, email, lang, welcome_email_last_sent_at,
              (welcome_email_last_sent_at IS NULL
               OR welcome_email_last_sent_at < NOW() - ($1::int * interval '1 hour')) AS eligible
         FROM users
        WHERE role = 'doctor' AND is_active = true AND password_hash IS NULL
        ORDER BY eligible DESC, name ASC`,
      [BULK_WELCOME_COOLDOWN_HOURS]
    );
    assertRenderableView('superadmin_bulk_welcome');
    return res.render('superadmin_bulk_welcome', {
      user: req.user,
      lang: (res.locals && res.locals.lang) || 'en',
      doctors: rows || [],
      cooldownHours: BULK_WELCOME_COOLDOWN_HOURS
    });
  } catch (err) {
    logErrorToDb(err, {
      context: 'superadmin.doctors_bulk_welcome_review',
      requestId: req.requestId,
      userId: req.user && req.user.id,
      url: req.originalUrl,
      method: req.method,
      category: 'superadmin_action'
    });
    console.error('[bulk-welcome] review page failed:', err && err.message ? err.message : err);
    // Send the operator somewhere real with a reason, rather than a 502.
    return res.redirect('/superadmin/doctors?welcome_error=1');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DOCTOR OUTREACH CONSOLE
//
// ROUTE ORDER IS LOAD-BEARING. Everything here is a literal path under
// /superadmin/doctors/ and MUST stay above the /:id routes below. Express
// matches in registration order; put these underneath and '/outreach' binds
// :id='outreach', finds no doctor, and redirects to the list — which is
// exactly how "Email all" silently did nothing on 25 August.
// tests/lint/superadmin-route-order.test.js enforces this.
//
// WHY IT EXISTS. /bulk-welcome selected on `password_hash IS NULL`, which is
// an implementation detail, not a cohort. On 29 August that sent 22 doctors a
// "set your password" email and structurally excluded the six who had logged
// in three weeks earlier and set one — the six closest to taking a case, and
// the only ones the platform had no way to contact.
// ─────────────────────────────────────────────────────────────────────────────

// Sends are per-doctor-transactional and can run long (one invite = one
// transaction). Same IP limiter as the other welcome paths.
router.get('/superadmin/doctors/outreach', requireSuperadmin, async (req, res) => {
  try {
    const { loadDoctorOutreach, waLink } = require('../services/doctor_outreach');
    const data = await loadDoctorOutreach({ cooldownHours: BULK_WELCOME_COOLDOWN_HOURS });

    // WhatsApp delivery health, read from what actually happened rather than
    // from config: if every WhatsApp row in the last 24h failed, say so and
    // give the operator the manual link instead of letting them believe the
    // message went.
    let waHealth = { total: 0, failed: 0, down: false, lastError: null };
    try {
      const wa = await queryOne(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status <> 'sent')::int AS failed,
                (ARRAY_AGG(response ORDER BY at DESC) FILTER (WHERE status <> 'sent'))[1] AS last_error
           FROM notifications
          WHERE channel = 'whatsapp' AND at > NOW() - interval '24 hours'`
      );
      if (wa) {
        waHealth.total = wa.total || 0;
        waHealth.failed = wa.failed || 0;
        waHealth.down = (wa.total || 0) > 0 && wa.failed === wa.total;
        waHealth.lastError = wa.last_error || null;
      }
    } catch (_) { /* the banner is advisory; never block the page on it */ }

    for (const d of data.doctors) d.waLink = d.template ? waLink(d, d.template) : null;

    assertRenderableView('superadmin_doctor_outreach');
    return res.render('superadmin_doctor_outreach', {
      user: req.user,
      lang: (res.locals && res.locals.lang) || 'en',
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
      data: data,
      waHealth: waHealth,
      flash: {
        sent: req.query.sent || null,
        skipped: req.query.skipped || null,
        failed: req.query.failed || null,
        error: req.query.error || null,
        busy: req.query.busy || null,
        toggled: req.query.toggled || null,
      }
    });
  } catch (err) {
    // A page that lists doctors must never be able to take the platform down.
    // assertRenderableView throws, and before express-async-errors was
    // confirmed present that throw reached unhandledRejection and exited the
    // process. Belt and braces.
    logErrorToDb(err, {
      context: 'superadmin.doctor_outreach',
      requestId: req.requestId, userId: req.user && req.user.id,
      url: req.originalUrl, method: req.method, category: 'superadmin_auth'
    });
    return res.redirect('/superadmin/doctors?outreach_error=1');
  }
});

// CSV of the whole list, so the operator can work it by phone or hand it on.
router.get('/superadmin/doctors/outreach.csv', requireSuperadmin, async (req, res) => {
  try {
    const { loadDoctorOutreach } = require('../services/doctor_outreach');
    const data = await loadDoctorOutreach({ cooldownHours: BULK_WELCOME_COOLDOWN_HOURS });
    const esc = (v) => {
      const t = String(v == null ? '' : v);
      // Leading =,+,-,@ are formula triggers in Excel. Prefix with a quote so
      // a specialty or name can never execute in someone's spreadsheet.
      const safe = /^[=+\-@]/.test(t) ? "'" + t : t;
      return '"' + safe.replace(/"/g, '""') + '"';
    };
    const head = ['name','email','phone','specialty','segment','logged_in','confirmed','services_ticked','last_invite'];
    const lines = [head.join(',')];
    for (const d of data.doctors) {
      lines.push([
        esc(d.name), esc(d.email), esc(d.phone), esc(d.specialty), esc(d.segment),
        esc(d.firstLoginAt ? String(d.firstLoginAt).slice(0, 10) : ''),
        esc(d.confirmedAt ? String(d.confirmedAt).slice(0, 10) : ''),
        esc(d.servicesTicked),
        esc(d.lastSentAt ? String(d.lastSentAt).slice(0, 10) : ''),
      ].join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="doctor-outreach-' + new Date().toISOString().slice(0, 10) + '.csv"');
    res.setHeader('Cache-Control', 'no-store, private');
    // BOM so Excel reads the Arabic names as UTF-8 instead of mojibake.
    return res.send('﻿' + lines.join('\n'));
  } catch (err) {
    logErrorToDb(err, {
      context: 'superadmin.doctor_outreach_csv',
      requestId: req.requestId, userId: req.user && req.user.id,
      url: req.originalUrl, method: req.method, category: 'superadmin_auth'
    });
    return res.redirect('/superadmin/doctors/outreach?error=csv');
  }
});

// ONE send endpoint for all three shapes — a single doctor, a tick-box
// selection, and a whole segment. They are the same operation with a
// different list of ids, and three endpoints would be three places to get the
// cooldown and the locking wrong.
router.post('/superadmin/doctors/outreach/send', requireSuperadmin, welcomeSendIpLimiter, async (req, res) => {
  const back = '/superadmin/doctors/outreach';
  const client = await pool.connect();
  try {
    const { loadDoctorOutreach } = require('../services/doctor_outreach');

    await client.query('BEGIN');
    // Same advisory lock the bulk welcome uses, and the same key: two
    // overlapping outreach runs would both read the cohort before either
    // stamped welcome_email_last_sent_at, and the second run's re-mint would
    // invalidate the magic links the first one had already emailed.
    const lock = await client.query('SELECT pg_try_advisory_xact_lock(4242, 1) AS ok');
    if (!lock.rows[0] || lock.rows[0].ok !== true) {
      await client.query('ROLLBACK');
      return res.redirect(back + '?busy=1');
    }

    const raw = req.body && (req.body.ids || req.body.id);
    let ids = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    const segment = String((req.body && req.body.segment) || '').trim();

    const data = await loadDoctorOutreach({ cooldownHours: BULK_WELCOME_COOLDOWN_HOURS });
    if (segment) {
      ids = (data.bySegment[segment] || []).map((d) => d.id);
    }
    ids = ids.map(String).filter(Boolean);

    // Resolve every id against the loaded cohort. An id the operator did not
    // see on the page, or one whose segment is not sendable, is dropped here
    // rather than trusted from the form.
    const byId = new Map(data.doctors.map((d) => [d.id, d]));
    const force = String((req.body && req.body.force) || '') === '1';
    const targets = [];
    let skipped = 0;
    for (const id of ids) {
      const d = byId.get(id);
      if (!d || !d.sendable) { skipped++; continue; }
      if (d.cooling && !force) { skipped++; continue; }
      targets.push(d);
    }

    await client.query('COMMIT');

    let sent = 0, failed = 0;
    for (const d of targets) {
      try {
        if (d.template === 'doctor_approved') {
          // Re-mints the 7-day magic link and stamps welcome_email_last_sent_at.
          const doctor = await queryOne('SELECT * FROM users WHERE id = $1 AND role = $2', [d.id, 'doctor']);
          if (!doctor) { failed++; continue; }
          const payload = await _issueDoctorWelcomePayload(doctor, req);
          queueMultiChannelNotification({
            orderId: null, toUserId: d.id,
            channels: ['internal', 'email', 'whatsapp'],
            template: 'doctor_approved', response: payload,
            dedupe_key: 'doctor_outreach_welcome:' + d.id + ':' + Date.now(),
          });
        } else {
          // doctor_confirm_services: no token. These doctors already have a
          // password; minting a magic link for them would be a second live
          // credential emailed for no reason.
          let baseUrl = String(process.env.BASE_URL || process.env.APP_URL || '').trim().replace(/\/+$/, '');
          if (!baseUrl) {
            try {
              const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
              const host = req.get('x-forwarded-host') || req.get('host');
              baseUrl = host ? proto + '://' + host : '';
            } catch (_) { baseUrl = ''; }
          }
          queueMultiChannelNotification({
            orderId: null, toUserId: d.id,
            channels: ['internal', 'email', 'whatsapp'],
            template: 'doctor_confirm_services',
            response: {
              firstName: String(d.name || '').replace(/^\s*(?:Dr\.?|د\.?)\s+/i, '').trim().split(/\s+/)[0] || 'Doctor',
              nameAr: d.nameAr || d.name || '',
              specialtyEn: d.specialty || '',
              specialtyAr: d.specialtyAr || d.specialty || '',
              servicesCount: d.servicesTicked || null,
              servicesUrl: baseUrl ? baseUrl + '/portal/doctor/services' : '/portal/doctor/services',
              doctorName: d.name || '',
            },
            dedupe_key: 'doctor_outreach_tiers:' + d.id + ':' + Date.now(),
          });
          // Stamp so the cooldown applies to this template too — otherwise the
          // reminder has no throttle at all and a doctor can be mailed on
          // every page refresh.
          await execute('UPDATE users SET welcome_email_last_sent_at = $1 WHERE id = $2',
            [new Date().toISOString(), d.id]);
        }
        sent++;
      } catch (e) {
        failed++;
        logErrorToDb(e, {
          context: 'superadmin.doctor_outreach_send_one',
          requestId: req.requestId, userId: req.user && req.user.id,
          url: req.originalUrl, method: req.method, category: 'superadmin_action'
        });
      }
    }

    logAdminAudit({ req, action: 'doctor_outreach_send', target: segment || ('ids:' + targets.length) });
    const q = new URLSearchParams({ sent: String(sent), skipped: String(skipped), failed: String(failed) });
    return res.redirect(back + '?' + q.toString());
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already aborted */ }
    logErrorToDb(err, {
      context: 'superadmin.doctor_outreach_send',
      requestId: req.requestId, userId: req.user && req.user.id,
      url: req.originalUrl, method: req.method, category: 'superadmin_auth'
    });
    return res.redirect(back + '?error=send');
  } finally {
    client.release();
  }
});

// Pause / deactivate from the row. Both are reversible, both are one UPDATE,
// and the confirmation is the operator having to pick which button — there is
// no inline confirm() available under this CSP (no 'unsafe-inline'), and a
// dialog that silently never fires is worse than none.
router.post('/superadmin/doctors/outreach/state', requireSuperadmin, async (req, res) => {
  const back = '/superadmin/doctors/outreach';
  try {
    const id = String((req.body && req.body.id) || '').trim();
    const action = String((req.body && req.body.action) || '').trim();
    if (!id) return res.redirect(back + '?error=state');

    let sql = null;
    if (action === 'deactivate')      sql = "UPDATE users SET is_active = false WHERE id = $1 AND role = 'doctor'";
    else if (action === 'activate')   sql = "UPDATE users SET is_active = true  WHERE id = $1 AND role = 'doctor'";
    else if (action === 'pause')      sql = "UPDATE users SET is_paused = true,  paused_at = NOW() WHERE id = $1 AND role = 'doctor'";
    else if (action === 'unpause')    sql = "UPDATE users SET is_paused = false, paused_at = NULL   WHERE id = $1 AND role = 'doctor'";
    else return res.redirect(back + '?error=state');

    await execute(sql, [id]);
    logAdminAudit({ req, action: 'doctor_outreach_' + action, target: id });

    // Availability changed, so the coming-soon computation is stale.
    try { await resyncComingSoon(); } catch (e) {
      logErrorToDb(e, { context: 'superadmin.doctor_outreach_state_resync', userId: req.user && req.user.id, url: req.originalUrl, method: req.method, category: 'superadmin_auth' });
    }
    return res.redirect(back + '?toggled=' + encodeURIComponent(action));
  } catch (err) {
    logErrorToDb(err, {
      context: 'superadmin.doctor_outreach_state',
      requestId: req.requestId, userId: req.user && req.user.id,
      url: req.originalUrl, method: req.method, category: 'superadmin_auth'
    });
    return res.redirect(back + '?error=state');
  }
});

router.get('/superadmin/doctors/:id/edit', requireSuperadmin, async (req, res) => {
  const doctor = await queryOne("SELECT * FROM users WHERE id = $1 AND role = 'doctor'", [req.params.id]);
  if (!doctor) return res.redirect('/superadmin/doctors');
  // Pass the doctor's current specialty as `keepId` so a doctor sitting on a
  // specialty that has since been hidden still sees it selected (AUDIT-2026-08-23).
  const specialties = await loadAssignableSpecialties(doctor.specialty_id);
  const subSpecialties = await queryAll('SELECT id, specialty_id, name FROM services WHERE specialty_id IS NOT NULL ORDER BY name ASC');
  const selectedServiceIds = (await queryAll('SELECT service_id FROM doctor_services WHERE doctor_id = $1', [req.params.id]))
    .map((r) => r.service_id);
  res.render('superadmin_doctor_form', { cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '', user: req.user, specialties, subSpecialties, selectedServiceIds, error: null, doctor, isEdit: true });
});

router.post('/superadmin/doctors/:id/edit', requireSuperadmin, async (req, res) => {
  const doctor = await queryOne("SELECT * FROM users WHERE id = $1 AND role = 'doctor'", [req.params.id]);
  if (!doctor) return res.redirect('/superadmin/doctors');
  // AUDIT-2026-08-23 (P0-DOC-FORM): this destructured is_active /
  // notify_whatsapp / service_ids, none of which the form posts. Every save
  // therefore wrote is_active=false (deactivating the doctor), wiped
  // notify_whatsapp, and — via the unconditional DELETE below — destroyed the
  // doctor's whole doctor_services mapping, all while redirecting as if it had
  // worked. Accept both spellings, and treat an absent field as "unchanged"
  // rather than as false.
  const body = req.body || {};
  const name = pickDoctorField(body, ['name', 'full_name']);
  const phone = pickDoctorField(body, ['phone']);
  const hasSpecialtyField = Object.prototype.hasOwnProperty.call(body, 'specialty_id');
  const specialty_id = pickDoctorField(body, ['specialty_id']);
  const notify_whatsapp = readDoctorFlag(body, ['notify_whatsapp', 'send_whatsapp_alerts'], doctor.notify_whatsapp === true);
  const is_active = readDoctorFlag(body, ['is_active', 'active'], doctor.is_active === true);
  const lang = readDoctorLang(body, doctor.lang);
  const submittedServiceIds = readDoctorServiceIds(body);
  // Same rule for the specialty: only clear it when the form actually sent an
  // empty specialty_id, never because the field was missing from the request.
  const nextSpecialtyId = hasSpecialtyField ? (specialty_id || null) : (doctor.specialty_id || null);

  await execute(
    `UPDATE users
     SET name = $1, specialty_id = $2, phone = $3, lang = $4, notify_whatsapp = $5, is_active = $6
     WHERE id = $7 AND role = 'doctor'`,
    [
      name || doctor.name,
      nextSpecialtyId,
      phone || null,
      lang,
      notify_whatsapp ? true : false,
      is_active ? true : false,
      req.params.id
    ]
  );
  // 2026-08-25 — keep the doctor_specialties mirror in step with a specialty
  // change. Same reasoning as the create path: broadcast and the assign
  // dropdowns key off that table, and an edit that moves a doctor to a new
  // specialty without it leaves them unreachable under the new one.
  //
  // INSERT ONLY — deliberately no DELETE of the previous row. doctor_specialties
  // has no is_primary column (id, doctor_id, specialty_id, created_at), and
  // self-signup writes the primary AND every secondary specialty into it. So a
  // row that is not the current primary is indistinguishable from a legitimate
  // secondary, and clearing "the old one" would silently destroy a doctor's
  // secondary specialties on any unrelated edit — this form has no field for
  // them and must not be the thing that deletes them.
  //
  // The cost is that a doctor moved between specialties stays broadcastable
  // under the old one until someone cleans the row up by hand. That is the
  // safer failure: a case offered slightly too widely, versus a doctor's
  // record quietly losing data the form never showed them.
  if (nextSpecialtyId) {
    try {
      await execute(
        `INSERT INTO doctor_specialties (id, doctor_id, specialty_id, created_at)
         SELECT $1, $2, $3, NOW()
          WHERE NOT EXISTS (
                SELECT 1 FROM doctor_specialties
                 WHERE doctor_id = $2 AND specialty_id = $3
              )`,
        [randomUUID(), req.params.id, nextSpecialtyId]
      );
    } catch (e) {
      logErrorToDb(e, { context: 'superadmin.doctor_edit_specialty_mirror', userId: req.params.id });
    }
  }

  // Refresh sub-specialties (services) mapping.
  //
  // AUDIT-2026-08-23 (P0-DOC-FORM): `submittedServiceIds === null` means the
  // request said nothing about services — leave the existing rows alone. A
  // doctor with zero doctor_services rows fails the EXISTS gate in
  // src/services/doctor_eligibility.js and can never be assigned a case again,
  // so an unconditional DELETE here is not a recoverable mistake.
  if (submittedServiceIds !== null) {
    try {
      const cleanedServiceIds = submittedServiceIds;
      let allowed = [];

      if (cleanedServiceIds.length && nextSpecialtyId) {
        const ph = cleanedServiceIds.map((_, i) => `$${i + 1}`).join(',');
        allowed = (await queryAll(
          `SELECT id FROM services WHERE id IN (${ph}) AND specialty_id = $${cleanedServiceIds.length + 1}`,
          [...cleanedServiceIds, nextSpecialtyId]
        )).map((r) => r.id);
      }

      // Resolve the replacement set BEFORE deleting. If the admin submitted a
      // non-empty selection but none of it validated (ids from another
      // specialty, or no specialty at all), keep what the doctor already has
      // rather than leaving them with nothing — that is a bad submission, not
      // an instruction to unassign. An explicitly empty selection still clears.
      if (allowed.length || cleanedServiceIds.length === 0) {
        await execute('DELETE FROM doctor_services WHERE doctor_id = $1', [req.params.id]);

        for (const sid of allowed) {
          await execute('INSERT INTO doctor_services (doctor_id, service_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, sid]);
        }
      } else {
        await logErrorToDb(
          new Error('doctor_services rewrite skipped: no submitted service id belongs to specialty ' + String(nextSpecialtyId)),
          { context: 'superadmin.doctor_edit_services', level: 'warn', userId: req.user?.id, url: req.originalUrl, method: req.method, category: 'superadmin_action' }
        );
      }
    } catch (err) {
      // Was a bare `catch (_) { /* no-op */ }`. The DELETE can succeed and the
      // re-INSERT fail, stripping a doctor of every service with no trace while
      // the route redirects as if the save worked. Non-fatal for the profile
      // update, but it must be visible in /ops/errors.
      logErrorToDb(err, { context: 'superadmin.doctor_edit_services', userId: req.user?.id, url: req.originalUrl, method: req.method, category: 'superadmin_action' });
    }
  }
  // Edit can flip is_active AND rewrite doctor_services → both change supply.
  // Recompute coming_soon after the mapping rewrite (§4.3), best-effort.
  try {
    await resyncComingSoon();
  } catch (e) {
    logErrorToDb(e, { context: 'superadmin.doctor_edit_resync', userId: req.user?.id, url: req.originalUrl, method: req.method, category: 'superadmin_auth' });
  }
  return res.redirect('/superadmin/doctors');
});

router.post('/superadmin/doctors/:id/toggle', requireSuperadmin, async (req, res) => {
  const doctorId = req.params.id;
  await execute(
    `UPDATE users
     SET is_active = CASE WHEN is_active = true THEN false ELSE true END
     WHERE id = $1 AND role = 'doctor'`,
    [doctorId]
  );
  // Toggling is_active changes supply → recompute coming_soon (§4.3), best-effort.
  try {
    await resyncComingSoon();
  } catch (e) {
    logErrorToDb(e, { context: 'superadmin.doctor_toggle_resync', userId: req.user?.id, url: req.originalUrl, method: req.method, category: 'superadmin_auth' });
  }
  return res.redirect('/superadmin/doctors');
});

// Doctor detail (approval)
router.get('/superadmin/doctors/:id', requireSuperadmin, async (req, res) => {
  const doctorId = req.params.id;
  const doctor = await queryOne(
    `SELECT u.*, s.name AS specialty_name
     FROM users u
     LEFT JOIN specialties s ON s.id = u.specialty_id
     WHERE u.id = $1 AND u.role = 'doctor'`,
    [doctorId]
  );
  if (!doctor) return res.redirect('/superadmin/doctors');
  const pendingDoctorsRow = await queryOne("SELECT COUNT(*) as c FROM users WHERE role = 'doctor' AND pending_approval = true");
  const pendingDoctorsCount = pendingDoctorsRow ? pendingDoctorsRow.c : 0;
  // P1-NOTIF-5: pass req.query so the view can read ?approved=1 and
  // ?resend=ok|failed|skipped_pending flash flags.
  res.render('superadmin_doctor_detail', { user: req.user, doctor, pendingDoctorsCount, query: req.query });
});

// Doctor row + specialty labels, for the two routes that feed
// _issueDoctorWelcomePayload. The v5 doctor-welcome template greets with
// "د. {{nameAr}}" and names the specialty in both languages, so the payload
// needs users.name_ar (already in SELECT *) plus specialties.name/name_ar
// (which SELECT * cannot reach — hence the LEFT JOIN). `u.*` keeps every
// existing consumer of this row working; the two aliases are purely additive.
// LEFT (not INNER) JOIN: users.specialty_id is nullable and one doctor has none
// — an inner join would silently drop them from approve/resend entirely.
const DOCTOR_WITH_SPECIALTY_SQL = `
  SELECT u.*, sp.name AS specialty_name, sp.name_ar AS specialty_name_ar,
         -- 2026-08-25: gates the welcome email's "your services are already
         -- selected" clause. This query feeds /approve AND the Resend welcome
         -- button, and without the column {{#if servicesReady}} silently took
         -- the else branch — telling a doctor with a full service list that
         -- their specialty was still being set up. Shared fragment so the
         -- three send paths cannot drift apart.
         ${SERVICES_READY_SQL}
    FROM users u
    LEFT JOIN specialties sp ON sp.id = u.specialty_id
   WHERE u.id = $1 AND u.role = 'doctor'`;

// P1-NOTIF-5: helper used by both /approve and /resend-welcome to issue a
// 7-day magic-login token + queue the doctor-welcome email. Returns a
// payload object suitable for queueMultiChannelNotification.response.
// Side-effects: writes one row to password_reset_tokens and updates
// users.welcome_email_last_sent_at (migration 064) so the admin doctors
// list can display "Welcome sent Xh ago" and gate against double-sends.
async function _issueDoctorWelcomePayload(doctor, req) {
  const token = randomUUID();
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + WELCOME_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
  // Remint invalidation (Package 2): burn prior unused tokens before minting.
  await execute(
    `DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL`,
    [doctor.id]
  );
  await execute(
    `INSERT INTO password_reset_tokens (id, user_id, token, expires_at, used_at, created_at)
     VALUES ($1, $2, $3, $4, NULL, $5)`,
    [randomUUID(), doctor.id, token, expiresAt, nowIso]
  );

  // Stamp the last-sent timestamp on the user row. Best-effort: a failure
  // here must not block token issuance (the email/notification is the
  // primary side-effect; the timestamp is for admin UI hinting only).
  try {
    await execute(
      `UPDATE users SET welcome_email_last_sent_at = $1 WHERE id = $2`,
      [nowIso, doctor.id]
    );
  } catch (e) {
    // AUDIT-M1: non-blocking by design (the email is the real side-effect), but
    // a persistent failure leaves the admin UI's "last sent" hint permanently
    // wrong, which reads as "never sent".
    logErrorToDb(e, {
      context: 'doctor_welcome.last_sent_at_update',
      category: 'doctor_admin',
      userId: doctor && doctor.id
    });
  }

  // Resolve baseUrl the same way superadmin.js:2027-2042 does — env first,
  // request headers as fallback, never localhost in prod.
  let baseUrl = String(process.env.BASE_URL || process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    try {
      const protoRaw = (req.get('x-forwarded-proto') || req.protocol || 'http');
      const proto = String(protoRaw).split(',')[0].trim() || 'http';
      const host = req.get('x-forwarded-host') || req.get('host');
      baseUrl = host ? `${proto}://${host}` : '';
    } catch (_) { baseUrl = ''; }
  }

  const lang = (doctor.lang === 'ar') ? 'ar' : 'en';
  const magicLinkUrl = baseUrl ? `${baseUrl}/magic-login/${token}?lang=${lang}` : null;
  const portalUrl = baseUrl ? `${baseUrl}/portal/doctor/today` : null;

  // Derive a first name for the warm salutation in doctor-welcome.hbs.
  // Mirrors the stripDr() pattern from openclawTemplates.js:151 so both
  // English "Dr." and Arabic "د." prefixes are stripped, then takes the
  // first whitespace-delimited token. Falls back to the localized
  // "Doctor" label when no name is on file.
  const rawName = String(doctor.name || '').trim();
  const stripped = rawName.replace(/^\s*(?:Dr\.?|د\.?)\s+/i, '').trim();
  const firstName = stripped.split(/\s+/)[0]
    || (lang === 'ar' ? 'الطبيب' : 'Doctor');

  // v5 doctor-welcome additions — kept a verbatim mirror of
  // services/doctor_welcome_payload.js (see its comments for the rationale on
  // the Dr./د. strip, the name_ar→name fallback and the specialty guards).
  const nameAr = String(doctor.name_ar || '').trim()
    .replace(/^\s*(?:Dr\.?|د\.?)\s+/i, '').trim()
    || stripped
    || 'الطبيب';
  const specName = String(doctor.specialty_name || '').trim();
  const specNameAr = String(doctor.specialty_name_ar || '').trim();

  return {
    doctorName: doctor.name || (lang === 'ar' ? 'الطبيب' : 'Doctor'),
    firstName,
    nameAr,
    specialtyAr: specNameAr || specName,
    specialtyEn: specName || specNameAr,
    // Supplied by DOCTOR_WITH_SPECIALTY_SQL's SERVICES_READY_SQL column. Same
    // strict === true as the pure builder: an absent column must read false,
    // never truthy-by-accident.
    servicesReady: doctor.services_ready === true,
    magicLinkUrl,
    // #66/Ziad-locked: Ziad's bilingual welcome copy references
    // {{password_setup_link}}; expose as an alias of magicLinkUrl so the
    // template renders without any template-side fallback logic.
    password_setup_link: magicLinkUrl,
    portalUrl,
    expiryDays: Math.round(WELCOME_EXPIRY_HOURS / 24)
  };
}

router.post('/superadmin/doctors/:id/approve', requireSuperadmin, async (req, res) => {
  const doctorId = req.params.id;
  const doctor = await queryOne(DOCTOR_WITH_SPECIALTY_SQL, [doctorId]);
  if (!doctor) return res.redirect('/superadmin/doctors');
  const nowIso = new Date().toISOString();
  await execute(
    `UPDATE users
     SET pending_approval = false,
         is_active = true,
         approved_at = $1,
         rejection_reason = NULL
     WHERE id = $2 AND role = 'doctor'`,
    [nowIso, doctorId]
  );

  // Approving flips is_active → recompute services.coming_soon (design §4.3).
  // Post-commit + best-effort: a re-sync failure must not break approval.
  try {
    await resyncComingSoon();
  } catch (e) {
    logErrorToDb(e, { context: 'superadmin.doctor_approve_resync', userId: req.user?.id, url: req.originalUrl, method: req.method, category: 'superadmin_auth' });
  }

  // P1-NOTIF-5: audit the approval action durably, BEFORE the (async) email
  // queue. Approval state is committed in the UPDATE above; logging the
  // action is independent of email-send success.
  logAdminAudit({ req, action: 'approved_doctor', target: '/superadmin/doctors/' + doctorId });

  // P1-NOTIF-5: issue a 7-day magic-login token and embed in the welcome
  // email payload. Soft-fail wrapped — if token issuance fails (DB error),
  // approval still succeeds and admin can retry via /resend-welcome.
  let welcomePayload = {};
  try {
    welcomePayload = await _issueDoctorWelcomePayload(doctor, req);
  } catch (err) {
    logErrorToDb(err, {
      context: 'superadmin.doctor_approve_token',
      requestId: req.requestId,
      userId: req.user?.id,
      url: req.originalUrl,
      method: req.method,
      category: 'superadmin_auth'
    });
    console.error('[doctor-approve] token issuance failed:', err && err.message ? err.message : err);
  }

  queueMultiChannelNotification({
    orderId: null,
    toUserId: doctorId,
    channels: ['internal', 'email', 'whatsapp'],
    template: 'doctor_approved',
    response: welcomePayload,
    dedupe_key: 'doctor_approved:' + doctorId
  });

  return res.redirect(`/superadmin/doctors/${doctorId}?approved=1`);
});

// P1-NOTIF-5: resend the welcome email to an already-approved doctor.
// Useful when the original email was lost or expired before activation.
// Issues a fresh token; since T27, _issueDoctorWelcomePayload first DELETEs this
// doctor's prior UNUSED tokens (remint), so exactly one welcome link is ever live
// — an old link can't still be redeemed. Audit-logged.
router.post('/superadmin/doctors/:id/resend-welcome', requireSuperadmin, welcomeSendIpLimiter, async (req, res) => {
  const doctorId = req.params.id;
  const doctor = await queryOne(DOCTOR_WITH_SPECIALTY_SQL, [doctorId]);
  if (!doctor) return res.redirect('/superadmin/doctors');
  if (doctor.pending_approval) {
    // Approval not yet complete — admin should approve first; resend has no
    // useful target. Redirect back without action.
    return res.redirect(`/superadmin/doctors/${doctorId}?resend=skipped_pending`);
  }

  logAdminAudit({ req, action: 'resent_doctor_welcome', target: '/superadmin/doctors/' + doctorId });

  let welcomePayload = {};
  let resendOk = true;
  try {
    welcomePayload = await _issueDoctorWelcomePayload(doctor, req);
  } catch (err) {
    logErrorToDb(err, {
      context: 'superadmin.doctor_resend_welcome_token',
      requestId: req.requestId,
      userId: req.user?.id,
      url: req.originalUrl,
      method: req.method,
      category: 'superadmin_auth'
    });
    console.error('[doctor-resend-welcome] token issuance failed:', err && err.message ? err.message : err);
    resendOk = false;
  }

  if (resendOk) {
    queueMultiChannelNotification({
      orderId: null,
      toUserId: doctorId,
      channels: ['internal', 'email', 'whatsapp'],
      template: 'doctor_approved',
      response: welcomePayload,
      // Distinct dedupe_key per resend so the worker doesn't drop it as a
      // duplicate of the original approval-time notification.
      dedupe_key: 'doctor_welcome_resend:' + doctorId + ':' + Date.now()
    });
  }

  return res.redirect(`/superadmin/doctors/${doctorId}?resend=${resendOk ? 'ok' : 'failed'}`);
});

// Package 2 (T29/T31) — reusable BULK welcome-to-passwordless. Invites every
// password-less ACTIVE doctor (role='doctor' AND is_active=true AND password_hash
// IS NULL) so the never-logged-in cohort can set a password and confirm services.
// Delegates to bulkWelcomePasswordlessDoctors: one txn/doctor via inviteDoctor
// (token mint + remint-burn + welcome stamp + audit), skips password-holders and
// anyone still inside the welcome cooldown, IDEMPOTENT (remint-DELETE → one live
// token; cooldown skips a same-batch re-run → no double send). Notifications fire
// POST-COMMIT per doctor with a per-doctor dedupe key. MUST SHIP IN THE SAME
// RELEASE AS THE ASSIGNMENT GATE (spec §9): the gate makes every
// onboarding_complete=false doctor unassignable, so without a way to send invites
// the whole roster is stranded. requireSuperadmin + welcomeSendIpLimiter (10/15min
// per IP; ONE tick per bulk call — the 28-doctor loop is internal, never throttled).
router.post('/superadmin/doctors/bulk-welcome-passwordless', requireSuperadmin, welcomeSendIpLimiter, async (req, res) => {
  logAdminAudit({ req, action: 'bulk_welcome_passwordless_doctors', target: '/superadmin/doctors' });

  // baseUrl the same way _issueDoctorWelcomePayload resolves it (env first,
  // request headers fallback) so the magic links are absolute. A null baseUrl
  // still yields a valid (link-less) payload — never throws.
  let baseUrl = String(process.env.BASE_URL || process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    try {
      const protoRaw = (req.get('x-forwarded-proto') || req.protocol || 'http');
      const proto = String(protoRaw).split(',')[0].trim() || 'http';
      const host = req.get('x-forwarded-host') || req.get('host');
      baseUrl = host ? `${proto}://${host}` : '';
    } catch (_) { baseUrl = ''; }
  }

  const client = await pool.connect();
  try {
    // ONE batch at a time, process-wide and instance-wide.
    //
    // 2026-08-25 — there was no guard of any kind, and the request takes
    // seconds (23 doctors x a transaction each) with no visible feedback. Two
    // overlapping batches BOTH read the cohort before either stamps
    // welcome_email_last_sent_at, so both see 23 eligible; inviteDoctor
    // re-checks role and is_active but NOT the cooldown, so batch B re-mints
    // for all 23 — and its remint-DELETE removes batch A's tokens. Batch A's
    // emails are already queued. Result: every doctor gets two invites and the
    // first link is dead.
    //
    // pg_try_advisory_xact_lock, not the blocking form: a queued second batch
    // would just do the damage a moment later. Refuse it and say so.
    // Transaction-scoped so it releases on COMMIT/ROLLBACK/disconnect and
    // cannot leak on a crash. The key is an arbitrary constant, namespaced by
    // the first arg to keep it clear of other advisory-lock users.
    await client.query('BEGIN');
    const lock = await client.query('SELECT pg_try_advisory_xact_lock(4242, 1) AS ok');
    if (!lock.rows[0] || lock.rows[0].ok !== true) {
      await client.query('ROLLBACK');
      if (String((req.body && req.body.redirect) || '') === '1') {
        return res.redirect('/superadmin/doctors?welcome_busy=1');
      }
      return res.status(409).json({ error: 'A bulk welcome send is already running' });
    }

    // The bulk service reuses `client` only for the read-side SELECT; each
    // inviteDoctor runs on its own fresh pool client (own txn). Notifications
    // fire post-commit via onInvited — per-doctor dedupe_key with a timestamp so
    // the worker (which dedupes permanently) never drops a legitimately re-sent
    // invite in a later batch, and a same-batch duplicate is impossible (each
    // doctor appears once in the cohort).
    const result = await bulkWelcomePasswordlessDoctors(client, {
      actorId: req.user && req.user.id,
      baseUrl: baseUrl || null,
      onInvited: (doctorId, welcomePayload) => {
        try {
          queueMultiChannelNotification({
            orderId: null,
            toUserId: doctorId,
            channels: ['internal', 'email', 'whatsapp'],
            template: 'doctor_approved',
            response: welcomePayload,
            dedupe_key: 'doctor_bulk_welcome:' + doctorId + ':' + Date.now(),
          });
        } catch (e) {
          // 2026-08-25 — logged to error_logs, not just to stdout.
          //
          // This is the per-doctor failure path of a BULK invite: one bad
          // recipient in a run of 23 leaves that doctor never welcomed, and a
          // console line on Render is not somewhere anyone will look for it.
          // /ops/errors is. (Also what tests/core/theme8-route-errlog-coverage
          // enforces on this file.)
          try {
            logErrorToDb(e, {
              context: 'superadmin.bulk_welcome_notify',
              requestId: req.requestId,
              userId: req.user && req.user.id,
              url: req.originalUrl,
              method: req.method,
              category: 'superadmin_action'
            });
          } catch (_) {}
          console.error('[bulk-welcome] notify failed:', doctorId, e && e.message ? e.message : e);
        }
      },
    });
    // 2026-08-25 — this route has existed since it was written and NOTHING in
    // the UI posted to it, so 23 doctors were being invited one button-click at
    // a time against a 10-per-15-minutes IP limiter: three passes and about
    // 35 minutes, with clicks 11-20 in each window failing silently. The bulk
    // path is ONE request, so the limiter never bites.
    //
    // The JSON response is kept for the Command app and for curl. A plain form
    // post (redirect=1) gets a redirect instead, which is what lets the button
    // exist at all without inline JS under the CSP.
    await client.query('COMMIT');

    if (String((req.body && req.body.redirect) || '') === '1') {
      const q = new URLSearchParams({
        welcome_sent: String(result.sent),
        welcome_skipped: String(result.skipped),
        welcome_failed: String(result.failed)
      });
      return res.redirect('/superadmin/doctors?' + q.toString());
    }
    return res.json({ sent: result.sent, skipped: result.skipped, failed: result.failed });
  } catch (err) {
    logErrorToDb(err, {
      context: 'superadmin.doctors_bulk_welcome_passwordless',
      requestId: req.requestId,
      userId: req.user && req.user.id,
      url: req.originalUrl,
      method: req.method,
      category: 'superadmin_auth',
    });
    console.error('[bulk-welcome] batch failed:', err && err.message ? err.message : err);
    try { await client.query('ROLLBACK'); } catch (_) { /* already aborted */ }
    if (String((req.body && req.body.redirect) || '') === '1') {
      return res.redirect('/superadmin/doctors?welcome_error=1');
    }
    return res.status(500).json({ error: 'Bulk welcome failed' });
  } finally {
    client.release();
  }
});

router.post('/superadmin/doctors/:id/reject', requireSuperadmin, async (req, res) => {
  const doctorId = req.params.id;
  const doctor = await queryOne("SELECT * FROM users WHERE id = $1 AND role = 'doctor'", [doctorId]);
  if (!doctor) return res.redirect('/superadmin/doctors');
  const { rejection_reason } = req.body || {};
  await execute(
    `UPDATE users
     SET pending_approval = false,
         is_active = false,
         approved_at = NULL,
         rejection_reason = $1
     WHERE id = $2 AND role = 'doctor'`,
    [rejection_reason || 'Not approved', doctorId]
  );

  // Rejecting deactivates the doctor (is_active→false) → recompute coming_soon
  // so a service losing its last active doctor is flagged (§4.3), best-effort.
  try {
    await resyncComingSoon();
  } catch (e) {
    logErrorToDb(e, { context: 'superadmin.doctor_reject_resync', userId: req.user?.id, url: req.originalUrl, method: req.method, category: 'superadmin_auth' });
  }

  queueNotification({
    orderId: null,
    toUserId: doctorId,
    channel: 'internal',
    template: 'doctor_rejected',
    status: 'queued'
  });

  return res.redirect(`/superadmin/doctors/${doctorId}`);
});

// SERVICE CATALOG
router.get('/superadmin/services/new', requireSuperadmin, async (req, res) => {
  const specialties = await queryAll('SELECT id, name FROM specialties ORDER BY name ASC');
  res.render('superadmin_service_form', { user: req.user, specialties, error: null, service: {}, isEdit: false });
});

router.post('/superadmin/services/new', requireSuperadmin, async (req, res) => {
  const { name, code, specialty_id, base_price, doctor_fee, currency, payment_link } = req.body || {};
  if (!name || !specialty_id) {
    const specialties = await queryAll('SELECT id, name FROM specialties ORDER BY name ASC');
    return res.status(400).render('superadmin_service_form', {
      user: req.user,
      specialties,
      error: 'Name and specialty are required.',
      service: req.body,
      isEdit: false
    });
  }
  await execute(
    `INSERT INTO services (id, name, code, specialty_id, base_price, doctor_fee, currency, payment_link)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      randomUUID(),
      name,
      code || null,
      specialty_id || null,
      base_price ? Number(base_price) : null,
      doctor_fee ? Number(doctor_fee) : null,
      currency || 'EGP',
      payment_link || null
    ]
  );
  return res.redirect('/superadmin/services');
});

router.get('/superadmin/services/:id/edit', requireSuperadmin, async (req, res) => {
  const service = await queryOne('SELECT * FROM services WHERE id = $1', [req.params.id]);
  if (!service) return res.redirect('/superadmin/services');
  const specialties = await queryAll('SELECT id, name FROM specialties ORDER BY name ASC');
  res.render('superadmin_service_form', { user: req.user, service, specialties, error: null, isEdit: true });
});

router.post('/superadmin/services/:id/edit', requireSuperadmin, async (req, res) => {
  const { name, code, specialty_id, base_price, doctor_fee, currency, payment_link } = req.body || {};
  const service = await queryOne('SELECT * FROM services WHERE id = $1', [req.params.id]);
  if (!service) return res.redirect('/superadmin/services');
  if (!name || !specialty_id) {
    const specialties = await queryAll('SELECT id, name FROM specialties ORDER BY name ASC');
    return res.status(400).render('superadmin_service_form', {
      user: req.user,
      service: { ...service, ...req.body },
      specialties,
      error: 'Name and specialty are required.',
      isEdit: true
    });
  }
  await execute(
    `UPDATE services
     SET name=$1, code=$2, specialty_id=$3, base_price=$4, doctor_fee=$5, currency=$6, payment_link=$7
     WHERE id=$8`,
    [
      name,
      code || null,
      specialty_id || null,
      base_price ? Number(base_price) : null,
      doctor_fee ? Number(doctor_fee) : null,
      currency || 'EGP',
      payment_link || null,
      req.params.id
    ]
  );
  return res.redirect('/superadmin/services');
});

// PAYMENT FLOW
router.get('/superadmin/orders/:id/payment', requireSuperadmin, async (req, res) => {
  const order = await loadOrderWithPatient(req.params.id);
  if (!order) return res.redirect('/superadmin');
  const methods = ['cash', 'card', 'bank_transfer', 'online_link'];
  res.render('superadmin_order_payment', { user: req.user, order, methods });
});

router.post('/superadmin/orders/:id/mark-paid', requireSuperadmin, async (req, res) => {
  const orderId = String((req.params && req.params.id) || '').trim();
  if (!orderId) return res.redirect('/superadmin');

  const order = await loadOrderWithPatient(orderId);
  if (!order) return res.redirect('/superadmin');

  const nowIso = new Date().toISOString();

  // Idempotent: if already paid, just return to order.
  const existingPaymentStatus = String(order.payment_status || '').toLowerCase();
  if (existingPaymentStatus === 'paid') {
    return res.redirect(`/superadmin/orders/${orderId}`);
  }

  // Allow setting a method/reference from the payment page form, but keep safe defaults.
  const method = String((req.body && (req.body.method || req.body.payment_method)) || order.payment_method || 'manual').trim();
  const reference = String((req.body && (req.body.reference || req.body.payment_reference)) || '').trim() || `manual_${randomUUID()}`;

  const pm = String((req.body && (req.body.payment_method || req.body.method)) || '').trim() || null;
  const pr = String((req.body && (req.body.payment_reference || req.body.reference)) || '').trim() || null;

  try {
    // Mark payment paid.
    await execute(
      `UPDATE orders
       SET payment_status = 'paid',
           payment_method = $1,
           payment_reference = $2,
           paid_at = COALESCE(paid_at, $3),
           updated_at = $4
       WHERE id = $5`,
      [method, reference, nowIso, nowIso, orderId]
    );
  } catch (err) {
    logErrorToDb(err, {
      context: 'superadmin.mark_paid_schema_fallback',
      requestId: req.requestId,
      userId: req.user?.id,
      url: req.originalUrl,
      method: req.method,
      category: 'superadmin_action'
    });
    // Non-blocking: if schema differs, fall back to minimal update.
    try {
      await execute(
        `UPDATE orders
         SET payment_status = 'paid',
             updated_at = $1
         WHERE id = $2`,
        [nowIso, orderId]
      );
    } catch (__) {
      return res.redirect(`/superadmin/orders/${orderId}?payment=failed`);
    }
  }

  // AUDIT (2026-08-17) — the canonical payment boundary. This route previously
  // hand-rolled two substitutes for it, and both were wrong:
  //
  //   (1) A "conservative" transition to status='new'. 'new' aliases to the
  //       canonical SUBMITTED, NOT PAID — so the case stayed pre-payment as far
  //       as the state machine was concerned, sla_hours was never locked, and
  //       assertTransition('SUBMITTED','IN_REVIEW') threw the instant the doctor
  //       pressed Accept. The case was permanently unacceptable.
  //   (2) An inline pickDoctorForOrder + `UPDATE orders SET doctor_id` assign
  //       that bypassed caseLifecycle.assignDoctor entirely: it left status
  //       untouched, wrote no doctor_assignments row, no accept_by_at, no
  //       CASE_ASSIGNED event — exactly the orphaned-case shape AUDIT-P0-2
  //       removed from auto_assign.js. Worse, it applied no eligibility gate at
  //       all beyond whatever pickDoctorForOrder happens to do.
  //
  // markCasePaid replaces both. It transitions to PAID, locks sla_hours, writes
  // PAYMENT_CONFIRMED / CASE_READY_FOR_ASSIGNMENT, handles the urgent-window
  // deferral, and its post-commit hook fires enqueueAutoAssign +
  // broadcastOrderToSpecialty — the same pipeline the Paymob webhook uses. So
  // the auto-assign the deleted block was trying to do still happens, through
  // the canonical writer.
  //
  // Failure handling mirrors routes/payments.js:886 — money is already recorded
  // as taken, so anything that is not recognisably a benign re-entry is logged
  // to error_logs and pages on-call.
  try {
    await caseLifecycle.markCasePaid(orderId);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    const benign = /already\s+(paid|assigned|processed)|idempotent|no[-\s]?op/i.test(msg);

    logOrderEvent({
      orderId,
      label: benign
        ? 'Payment lifecycle transition skipped (idempotent)'
        : 'Payment lifecycle transition FAILED — case may not have entered the pipeline',
      meta: JSON.stringify({ error: msg, benign, source: 'superadmin_mark_paid' }),
      actorUserId: req.user && req.user.id ? String(req.user.id) : null,
      actorRole: 'superadmin'
    });

    if (!benign) {
      try {
        logErrorToDb(e, {
          context: 'superadmin.mark_paid.markCasePaid',
          orderId,
          requestId: req.requestId,
          userId: req.user?.id,
          url: req.originalUrl,
          method: req.method,
          category: 'payment',
          payment_captured: true
        });
      } catch (_) {}
      try {
        sendCriticalAlert(
          'markCasePaid FAILED for order ' + orderId + ' after a SUPERADMIN marked it paid: ' +
          msg.slice(0, 300) + ' — case is paid but is not in the assignment queue',
          'markcasepaid_failed'
        );
      } catch (_) {}
    }
  }


  // === ADD-ONS: RECORD AS OUTSTANDING, DO NOT SETTLE (2026-08-24) ===
  //
  // Marking the base fee paid is NOT evidence that an add-on was paid for.
  //
  // This handler has no amount field anywhere in it — it records
  // payment_method and payment_reference and nothing about how much arrived.
  // orders.addons_json, meanwhile, is written when the patient TICKS the box at
  // create-intention time, before any money moves, and survives an abandoned
  // gateway. So "addons_json says video_consultation" plus "an operator pressed
  // Mark paid" does not add up to "the patient paid for a video consultation" —
  // and settling on that basis would email them a confirmation for something
  // they never bought and accrue the doctor 85% of 200 EGP against nothing.
  //
  // An earlier draft of this change did exactly that. It is called out here
  // because it reads like an obvious convenience and is not.
  //
  // Instead: flag it. The admin order page surfaces any selected-but-unsettled
  // add-on with a separate Settle button — a human explicitly asserting that
  // the money for THOSE LINES arrived, recorded against their user id.
  try {
    const { parseSelectedAddons } = require('../services/order_pricing');
    const _o = await queryOne('SELECT addons_json, video_consultation_selected FROM orders WHERE id = $1', [orderId]);
    const _sel = parseSelectedAddons(_o || {});
    const _pending = [];
    if (_sel.video_consultation) _pending.push('video_consult');
    if (_sel.prescription) _pending.push('prescription');
    if (_pending.length) {
      const _existing = await queryAll('SELECT addon_service_id FROM order_addons WHERE order_id = $1', [orderId]);
      const _have = new Set((_existing || []).map(function (r) { return String(r.addon_service_id); }));
      const _outstanding = _pending.filter(function (id) { return !_have.has(id); });
      if (_outstanding.length) {
        logOrderEvent({
          orderId,
          label: 'Add-ons awaiting settlement',
          meta: JSON.stringify({ addons: _outstanding, reason: 'marked paid without amount verification', via: 'superadmin_mark_paid' }),
          actorUserId: req.user && req.user.id,
          actorRole: 'superadmin'
        });
      }
    }
  } catch (e) {
    try { logErrorToDb(e, { context: 'superadmin.mark_paid.flag_addons', orderId }); } catch (_) {}
  }

  // Audit log.
  try {
    logOrderEvent(
      {
        orderId,
        label: 'Payment marked as paid (superadmin)',
        meta: JSON.stringify({
          from: order.payment_status || null,
          to: 'paid',
          payment_method: pm,
          payment_reference: pr
        }),
        actor_user_id: req.user && req.user.id ? String(req.user.id) : null,
        actor_role: 'superadmin'
      },
      'Payment marked as paid (superadmin)',
      'superadmin'
    );
  } catch (_) {}

  try {
    if (order.patient_id) {
      queueNotification({
        orderId,
        toUserId: order.patient_id,
        channel: 'internal',
        template: 'payment_marked_paid_patient',
        status: 'queued'
      });
    }
  } catch (_) {}

  // Side issue #47 — removed `try { runSlaSweep(); } catch (_) {}` call
  // here. The underlying sla_watcher.runSlaSweep was a no-op stub;
  // case_sla_worker.runCaseSlaSweep runs every 5 min via pg-boss and
  // picks up post-payment state changes naturally on the next tick.

  return res.redirect(`/superadmin/orders/${orderId}?payment=paid`);
});

router.post('/superadmin/orders/:id/mark-unpaid', requireSuperadmin, async (req, res) => {
  const orderId = String((req.params && req.params.id) || '').trim();
  if (!orderId) return res.redirect('/superadmin');

  const order = await queryOne('SELECT * FROM orders_active WHERE id = $1', [orderId]);
  if (!order) return res.redirect('/superadmin');

  const nowIso = new Date().toISOString();

  // Idempotent: if already unpaid, don't spam events.
  const current = String(order.payment_status || '').toLowerCase();
  if (current === 'unpaid') {
    return res.redirect(`/superadmin/orders/${orderId}`);
  }

  // Best-effort: clear paid_at if column exists; otherwise fall back.
  try {
    await execute(
      `UPDATE orders
       SET payment_status = 'unpaid',
           payment_method = NULL,
           payment_reference = NULL,
           paid_at = NULL,
           updated_at = $1
       WHERE id = $2`,
      [nowIso, orderId]
    );
  } catch (_) {
    await execute(
      `UPDATE orders
       SET payment_status = 'unpaid',
           payment_method = NULL,
           payment_reference = NULL,
           updated_at = $1
       WHERE id = $2`,
      [nowIso, orderId]
    );
  }

  await execute(
    `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      randomUUID(),
      orderId,
      'Payment marked as unpaid (superadmin)',
      JSON.stringify({ from: order.payment_status || 'paid', to: 'unpaid' }),
      nowIso,
      req.user.id,
      'superadmin'
    ]
  );

  return res.redirect(`/superadmin/orders/${orderId}`);
});

// Unified payment update handler
router.post('/superadmin/orders/:id/payment', requireSuperadmin, async (req, res) => {
  const orderId = req.params.id;
  const { payment_status, payment_method, payment_reference } = req.body || {};
  const allowed = ['unpaid', 'paid', 'refunded'];

  const order = await queryOne('SELECT * FROM orders_active WHERE id = $1', [orderId]);
  if (!order) return res.redirect('/superadmin');

  const status = allowed.includes(payment_status) ? payment_status : order.payment_status;
  const nowIso = new Date().toISOString();

  // Theme 7b Phase 3 (per OQ-14): the legacy `payment_status='refunded'`
  // path bypassed the canonical refunds table and the workflow it
  // anchors. Redirect to the new /superadmin/refunds queue with a
  // prefill hint so the operator can issue a proper refund row
  // (status='approved' → mark-paid). An audit event is written so we
  // can track if anyone hits this URL after launch.
  if (status === 'refunded') {
    logOrderEvent({
      orderId,
      label: 'legacy_refund_path_deprecated',
      meta: { attempted_payment_method: payment_method || null,
              attempted_payment_reference: payment_reference || null },
      actorUserId: req.user.id,
      actorRole: req.user.role
    });
    return res.redirect('/superadmin/refunds?prefill_order=' + encodeURIComponent(orderId));
  }

  // AUDIT (2026-08-17, regression F6) — the paid_at half. This route could set
  // payment_status='paid' while leaving paid_at NULL, and "paid" is the PAIR:
  // routes/admin.js force-assign refuses on `!order.paid_at`, and the
  // paid_at-based revenue/aging reads would see a NULL. The sibling routes
  // already get this right (/mark-paid COALESCEs it in, /mark-unpaid NULLs it),
  // so this one was the odd path out. CASE-guarded rather than unconditional:
  // flipping to 'unpaid' here must not stamp a payment time. COALESCE keeps the
  // ORIGINAL payment instant when an already-paid order is re-saved with a new
  // method/reference.
  await execute(
    `UPDATE orders
     SET payment_status = $1,
         payment_method = $2,
         payment_reference = $3,
         paid_at = CASE WHEN $1 = 'paid' THEN COALESCE(paid_at, $6) ELSE paid_at END,
         updated_at = $4
     WHERE id = $5`,
    // $4 and $6 are the same instant but SEPARATE placeholders on purpose:
    // orders.updated_at is TIMESTAMP while orders.paid_at is TIMESTAMPTZ, and
    // one shared placeholder would make the parameter's deduced type depend on
    // which context Postgres resolves first. Same split the /mark-paid route
    // above already uses.
    [status, payment_method || null, payment_reference || null, nowIso, orderId, nowIso]
  );

  let label = null;
  if (status === 'paid') label = 'Payment marked as PAID';
  if (status === 'unpaid') label = 'Payment marked as UNPAID';
  if (status === 'refunded') label = 'Payment marked as REFUNDED';
  if (label) {
    logOrderEvent({
      orderId,
      label,
      actorUserId: req.user.id,
      actorRole: req.user.role
    });
  }

  // 2026-08-25 — this route set payment_status='paid' and stopped there.
  //
  // "Paid" is not a column, it is a transition. Its two sibling routes
  // (/mark-paid here, and routes/admin.js) both call markCasePaid, which locks
  // sla_hours, writes PAYMENT_CONFIRMED and CASE_READY_FOR_ASSIGNMENT, handles
  // the urgent-window deferral, and post-commit fires enqueueAutoAssign +
  // broadcastOrderToSpecialty. Without it the order is paid, out of the unpaid
  // sweep, invisible to the assignment pipeline and silently unroutable — a
  // patient's money taken for a case no doctor will ever be offered. Nothing in
  // the UI posts here today, but it is a live authenticated route and that is
  // not a safety property.
  //
  // Same failure handling as the sibling: money is recorded as taken, so
  // anything that is not a benign re-entry is logged and pages on-call.
  if (status === 'paid' && order.payment_status !== 'paid') {
    try {
      await caseLifecycle.markCasePaid(orderId);
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      const benign = /already\s+(paid|assigned|processed)|idempotent|no[-\s]?op/i.test(msg);

      logOrderEvent({
        orderId,
        label: benign
          ? 'Payment lifecycle transition skipped (idempotent)'
          : 'Payment lifecycle transition FAILED — case may not have entered the pipeline',
        meta: JSON.stringify({ error: msg, benign, source: 'superadmin_unified_payment' }),
        actorUserId: req.user && req.user.id ? String(req.user.id) : null,
        actorRole: 'superadmin'
      });

      if (!benign) {
        try {
          logErrorToDb(e, {
            context: 'superadmin.payment.markCasePaid',
            orderId,
            userId: req.user && req.user.id,
            url: req.originalUrl,
            method: req.method,
            category: 'payment'
          });
        } catch (_) { /* logging must not mask the original */ }
        try {
          const { sendCriticalAlert } = require('../critical-alert');
          sendCriticalAlert(
            'markCasePaid FAILED for order ' + orderId + ' after a SUPERADMIN marked it paid ' +
            'via the unified payment form: ' + msg + ' — the case is PAID but may not be assignable.',
            'mark_paid_lifecycle_failed'
          );
        } catch (_) { /* alerting is best-effort */ }
      }
    }
  }

  // Optional notify patient on paid
  if (order.patient_id && order.payment_status !== 'paid' && status === 'paid') {
    queueNotification({
      orderId,
      toUserId: order.patient_id,
      channel: 'internal',
      template: 'payment_marked_paid',
      status: 'queued'
    });
  }

  return res.redirect('/superadmin');
});

// Reassign order to a different doctor (superadmin)
router.post('/superadmin/orders/:id/reassign', requireSuperadmin, async (req, res) => {
  const orderId = req.params.id;
  const { doctor_id: newDoctorId } = req.body || {};

  const order = await queryOne(
    `SELECT o.*, d.name AS doctor_name
     FROM orders_active o
     LEFT JOIN users d ON d.id = o.doctor_id
     WHERE o.id = $1`,
    [orderId]
  );

  if (!order || !newDoctorId) {
    return res.redirect(`/superadmin/orders/${orderId}`);
  }

  const newDoctor = await queryOne(
    `SELECT id, name FROM users u
      WHERE u.id = $1
        AND u.role = 'doctor'
        AND COALESCE(u.is_active, true) = true
        AND COALESCE(u.is_paused, false) = false
        AND COALESCE(u.onboarding_complete, false) = true
        AND EXISTS (SELECT 1 FROM doctor_services ds WHERE ds.doctor_id = u.id AND ds.service_id = $2)`,
    [newDoctorId, order.service_id]
  );
  if (!newDoctor) {
    return res.redirect(`/superadmin/orders/${orderId}`);
  }

  if (order.doctor_id === newDoctor.id) {
    return res.redirect(`/superadmin/orders/${orderId}`);
  }

  await execute(
    `UPDATE orders
     SET doctor_id = $1,
         reassigned_count = COALESCE(reassigned_count,0) + 1,
         updated_at = $2
     WHERE id = $3`,
    [newDoctor.id, new Date().toISOString(), orderId]
  );

  logOrderEvent({
    orderId,
    label: `Order reassigned from ${order.doctor_name || order.doctor_id || 'Unassigned'} to ${newDoctor.name} by superadmin`,
    actorUserId: req.user.id,
    actorRole: req.user.role
  });

  queueMultiChannelNotification({
    orderId,
    toUserId: newDoctor.id,
    channels: ['internal', 'email', 'whatsapp'],
    template: 'order_reassigned_doctor',
    response: { case_id: orderId, caseReference: orderId.slice(0, 12).toUpperCase() },
    dedupe_key: 'order_reassigned:' + orderId + ':' + newDoctor.id
  });

  // Auto-create conversation for case-scoped messaging
  if (order.patient_id) {
    try { ensureConversation(orderId, order.patient_id, newDoctor.id); } catch (_) {}
  }

  return res.redirect(`/superadmin/orders/${orderId}`);
});

// Cancel order
router.post('/superadmin/orders/:id/cancel', requireSuperadmin, async (req, res) => {
  const orderId = req.params.id;
  const order = await queryOne('SELECT * FROM orders_active WHERE id = $1', [orderId]);
  if (!order) return res.status(404).send('Order not found');

  const reason = (req.body && req.body.reason) ? String(req.body.reason).trim() : '';

  await execute(
    "UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1",
    [orderId]
  );

  logOrderEvent({
    orderId,
    label: 'Order cancelled by superadmin',
    meta: JSON.stringify({ previous_status: order.status, reason: reason || null }),
    actorRole: 'superadmin',
    actorId: req.user.id
  });

  // Notify the patient that their case was cancelled. Queue-ified
  // (WhatsApp-via-OpenClaw rollout): the notification_worker now
  // dispatches both email and WhatsApp from a single canonical event,
  // replacing the prior inline emailService.notifyCaseCancelled() call.
  // Fire-and-forget — a queue failure must NEVER block the cancellation.
  if (order.patient_id) {
    try {
      const refId = String(orderId).slice(0, 12).toUpperCase();
      await queueMultiChannelNotification({
        orderId,
        toUserId: order.patient_id,
        channels: ['email', 'whatsapp', 'internal'],
        template: 'case_cancelled_patient',
        response: {
          order_id: orderId,
          caseReference: refId,
          reason: reason || null
        }
      });
    } catch (err) {
      logErrorToDb(err, {
        context: 'superadmin.cancel_notify_queue',
        requestId: req.requestId,
        userId: req.user?.id,
        url: req.originalUrl,
        method: req.method,
        category: 'superadmin_action'
      });
      console.error('[notify] queueMultiChannelNotification(case_cancelled_patient) failed:', err && err.message);
    }
  }

  return res.redirect(`/superadmin/orders/${orderId}`);
});

// Restore a soft-deleted order back into the live set.
// Used from the /superadmin/orders/trash view. Idempotent — only
// flips deleted_at when the row is actually soft-deleted.
router.post('/superadmin/orders/:id/restore', requireSuperadmin, async (req, res) => {
  const orderId = req.params.id;

  // include-deleted-ok: target row is by definition soft-deleted.
  const order = await queryOne(
    'SELECT id, status, deleted_at FROM orders WHERE id = $1 AND deleted_at IS NOT NULL',
    [orderId]
  );
  if (!order) {
    return res.redirect('/superadmin/orders/trash?error=not_deleted');
  }

  await execute(
    'UPDATE orders SET deleted_at = NULL, updated_at = NOW() WHERE id = $1 AND deleted_at IS NOT NULL',
    [orderId]
  );

  await logOrderEvent({
    orderId: orderId,
    label: 'Order restored from trash by superadmin',
    meta: { previous_deleted_at: order.deleted_at, status_at_restore: order.status },
    actorRole: 'superadmin',
    actorUserId: req.user.id
  });

  return res.redirect('/superadmin/orders/trash?restored=1');
});

// Extend SLA deadline
router.post('/superadmin/orders/:id/extend-sla', requireSuperadmin, async (req, res) => {
  const orderId = req.params.id;
  const order = await queryOne('SELECT * FROM orders_active WHERE id = $1', [orderId]);
  if (!order) return res.status(404).send('Order not found');

  const extraHours = Math.min(168, Math.max(1, parseInt(req.body.extra_hours) || 24));
  const currentDeadline = order.deadline_at ? new Date(order.deadline_at) : new Date();
  const newDeadline = new Date(currentDeadline.getTime() + extraHours * 60 * 60 * 1000);

  await execute(
    "UPDATE orders SET deadline_at = $1, sla_hours = COALESCE(sla_hours, 72) + $2, updated_at = NOW() WHERE id = $3",
    [newDeadline.toISOString(), extraHours, orderId]
  );

  // AUDIT (2026-08-17) — un-breach, twice broken.
  //
  // (1) The test compared against the literal 'breached'. Nothing writes that
  //     value: the canonical write is 'SLA_BREACH' (case_lifecycle.markSlaBreach
  //     → DB_STATUS[CASE_STATUS.SLA_BREACH]). 'breached' is only a historical
  //     ALIAS in DB_STATUS_VARIANTS. So this branch never fired and extending
  //     the SLA on a breached case left it breached — the case stayed out of
  //     fetchSlaCandidates (breached_at IS NOT NULL) with a deadline that had
  //     just been moved, i.e. the extension did nothing the operator asked for.
  //     dbStatusValuesFor('SLA_BREACH') is the whole alias list including the
  //     canonical value, so the test now matches every historical spelling.
  //
  // (2) The restore target. `submitted` for a case with no doctor is a DEAD END
  //     for a PAID case: SUBMITTED is the pre-payment state, so the doctor's
  //     Accept throws on assertTransition('SUBMITTED','IN_REVIEW') and
  //     assignDoctor refuses anything that is not PAID or REASSIGNED. The case
  //     would be unassignable and unacceptable forever. Restore to the state
  //     the case was actually in: IN_REVIEW when a doctor holds it, PAID when
  //     it is back in the assignment pool (which is also what auto-assign and
  //     the breach sweep expect to find). breached_at is cleared with it — it
  //     is the flag fetchSlaCandidates uses to refuse to ever breach the case
  //     again, and leaving it set would make the extension unenforceable.
  const breachDbValues = lowerUniqStrings(statusDbValues('SLA_BREACH', ['sla_breach', 'breached']));
  if (breachDbValues.includes(String(order.status || '').toLowerCase())) {
    const restoreTo = order.doctor_id
      ? caseLifecycle.toDbStatus('IN_REVIEW')
      : caseLifecycle.toDbStatus('PAID');
    await execute(
      "UPDATE orders SET status = $1, breached_at = NULL, updated_at = NOW() WHERE id = $2",
      [restoreTo, orderId]
    );
    logOrderEvent({
      orderId,
      label: 'sla_breach_cleared_by_superadmin',
      meta: JSON.stringify({ from: order.status, to: restoreTo, reason: 'sla_extended' }),
      actorRole: 'superadmin',
      actorUserId: req.user.id
    });
  }

  logOrderEvent({
    orderId,
    label: `SLA extended by ${extraHours}h by superadmin`,
    meta: JSON.stringify({ extra_hours: extraHours, new_deadline: newDeadline.toISOString(), previous_deadline: order.deadline_at }),
    actorRole: 'superadmin',
    actorId: req.user.id
  });

  return res.redirect(`/superadmin/orders/${orderId}`);
});

router.get('/superadmin/run-sla-check', requireSuperadmin, async (req, res) => {
  const summary = await performSlaCheck();
  const text = `SLA check completed: ${summary.preBreachWarnings} pre-breach warnings, ${summary.breached} breached, ${summary.reassigned} reassigned, ${summary.noDoctor} without doctor.`;

  if ((req.query && req.query.format === 'json') || (req.accepts('json') && !req.accepts('html'))) {
    return res.json(summary);
  }
  return res.send(text);
});

router.get('/superadmin/tools/run-sla-check', requireSuperadmin, async (req, res) => {
  await performSlaCheck();
  return res.redirect('/superadmin');
});

router.post('/superadmin/sla/recalc', requireSuperadmin, (req, res) => {
  // Fire-and-forget; the sync try/catch this used to wrap couldn't see
  // an async rejection, which is the bug we just fixed. .catch handles
  // any DB error inside the sweep so this never produces an
  // UnhandledRejection.
  recalcSlaBreaches().catch((err) => {
    logErrorToDb(err, {
      context: 'superadmin.recalc_sla_breaches_manual',
      userId: req.user?.id,
      category: 'superadmin_action'
    });
    console.error('[recalcSlaBreaches] sweep failed:', err);
  });
  return res.redirect('/superadmin');
});

router.get('/superadmin/tools/run-sla-sweep', requireSuperadmin, async (req, res) => {
  // Side issue #47 — was `runSlaSweep(new Date())` against the no-op
  // sla_watcher stub. Repointed at the canonical worker so the
  // operator-triggered manual sweep actually does something.
  try {
    const { runCaseSlaSweep } = require('../case_sla_worker');
    await runCaseSlaSweep(new Date());
  } catch (e) {
    // Best-effort manual trigger; surface in error_logs if it fails.
    require('../logger').logErrorToDb(e, {
      context: 'superadmin.run_sla_sweep_manual',
      userId: req.user && req.user.id,
      category: 'superadmin_action'
    });
  }
  return res.redirect('/superadmin?sla_ran=1');
});

// P1-SEC-1: Email the reset link via the existing password-reset template
// instead of returning the token in the response body. The token must
// never appear in HTTP responses, browser caches, screenshots, or
// over-the-shoulder views — even on a superadmin page. Every issuance is
// audit-logged to error_logs (category='admin_audit').
router.get('/superadmin/debug/reset-link/:userId', requireSuperadmin, async (req, res) => {
  const userId = req.params.userId;
  const user = await queryOne('SELECT * FROM users WHERE id = $1', [userId]);
  if (!user) return res.status(404).send('User not found');

  const token = uuidv4();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RESET_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
  // Remint invalidation (Package 2): burn prior unused tokens before minting.
  await execute(
    `DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL`,
    [user.id]
  );
  await execute(
    `INSERT INTO password_reset_tokens (id, user_id, token, expires_at, used_at, created_at)
     VALUES ($1, $2, $3, $4, NULL, $5)`,
    [uuidv4(), user.id, token, expiresAt, now.toISOString()]
  );

  // AUDIT-2026-08-22 (AUDIT-RESET-HOST-1) — configuration only; the
  // `x-forwarded-host || host` fallback is gone. See the identical note on the
  // doctor-welcome reset link above: this value is emailed with a live reset
  // token in it, so it must never be derived from the request. APP_URL is
  // accepted as a second source because render.yaml sets both to the same value
  // and the welcome-link path above already reads it.
  const baseUrl = String(process.env.BASE_URL || process.env.APP_URL || '')
    .trim().replace(/\/+$/, '');

  const emailLang = (user.lang === 'ar') ? 'ar' : 'en';
  // Prefer absolute URLs when possible; never default to localhost.
  const resetLink = baseUrl
    ? `${baseUrl}/reset-password/${token}?lang=${emailLang}`
    : `/reset-password/${token}?lang=${emailLang}`;

  // Always audit-log issuance (best-effort, but recorded).
  logAdminAudit({
    req,
    action: 'generated_reset_link',
    target: '/superadmin/debug/reset-link/' + userId
  });

  // Dev-only: print the link to stdout so devs without SMTP can still
  // test the reset flow. Mirrors auth.js:302-305 forgot-password behaviour.
  // Production logs MUST never contain the token.
  if (!IS_PROD) {
    // eslint-disable-next-line no-console
    console.log('[RESET LINK DEBUG]', resetLink);
  }

  let emailOk = false;
  let emailErrorMsg = null;
  if (!user.email) {
    emailErrorMsg = 'user_has_no_email';
  } else {
    try {
      const result = await emailService.sendEmail({
        to: user.email,
        subject: emailLang === 'ar' ? 'إعادة تعيين كلمة مرور تشخيصة' : 'Reset your Tashkheesa password',
        template: 'password-reset',
        lang: emailLang,
        data: {
          patientName: user.name || (emailLang === 'ar' ? 'عميلنا العزيز' : 'there'),
          resetLink: resetLink,
          expiryHours: RESET_EXPIRY_HOURS
        }
      });
      emailOk = !!(result && result.ok);
      if (!emailOk) emailErrorMsg = (result && (result.error || result.reason)) || 'send_failed';
    } catch (err) {
      logErrorToDb(err, {
        context: 'superadmin.reset_link_email',
        requestId: req.requestId,
        userId: req.user?.id,
        url: req.originalUrl,
        method: req.method,
        category: 'superadmin_auth'
      });
      emailErrorMsg = (err && err.message) || 'send_failed';
    }
  }

  if (!emailOk) {
    // Surface a clear failure WITHOUT leaking the token. The token is
    // already stored in password_reset_tokens — the superadmin can retry,
    // and the row will get cleaned up by expiry.
    return res
      .status(500)
      .send('Failed to send reset email (' + (emailErrorMsg || 'unknown') + '). Token is stored; retry the request.');
  }

  return res.send('Reset link emailed to ' + user.email + '. Expires in ' + RESET_EXPIRY_HOURS + ' hours.');
});

// Global events view
router.get('/superadmin/events', requireSuperadmin, async (req, res) => {
  const { role, label, order_id, from, to } = req.query || {};
  const where = [];
  const params = [];
  let paramIdx = 1;

  if (role && role !== 'all') {
    where.push(`e.actor_role = $${paramIdx++}`);
    params.push(role);
  }
  if (label && label.trim()) {
    where.push(`e.label ILIKE $${paramIdx++}`);
    params.push(`%${label.trim()}%`);
  }
  if (order_id && order_id.trim()) {
    where.push(`e.order_id = $${paramIdx++}`);
    params.push(order_id.trim());
  }
  if (from && from.trim()) {
    where.push(`DATE(e.at) >= DATE($${paramIdx++})`);
    params.push(from.trim());
  }
  if (to && to.trim()) {
    where.push(`DATE(e.at) <= DATE($${paramIdx++})`);
    params.push(to.trim());
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const events = await queryAll(
    `SELECT e.*, o.specialty_id, o.service_id,
            d.name AS doctor_name, p.name AS patient_name
     FROM order_events e
     LEFT JOIN orders_active o ON o.id = e.order_id
     LEFT JOIN users d ON d.id = o.doctor_id
     LEFT JOIN users p ON p.id = o.patient_id
     ${whereSql}
     ORDER BY e.at DESC
     LIMIT 100`,
    params
  );

  res.render('superadmin_events', {
    user: req.user,
    events,
    filters: { role: role || 'all', label: label || '', order_id: order_id || '', from: from || '', to: to || '' }
  });
});

// ── Error log (fork of /admin/errors — Batch 7) ──
// View: superadmin_errors.ejs. The KPI/stats fetch in the view targets the
// SHARED /admin/errors/stats endpoint (Q1: not forked — see MIGRATION_NOTES
// "Shared JSON endpoints, intentionally not forked"). Query/filter logic
// mirrors admin.js GET /admin/errors verbatim.
router.get('/superadmin/errors', requireSuperadmin, async (req, res) => {
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = 50;
  const offset = (page - 1) * perPage;

  const level = (req.query.level || '').trim();
  const dateFrom = (req.query.date_from || '').trim();
  const dateTo = (req.query.date_to || '').trim();
  const search = (req.query.search || '').trim();

  const whereClauses = [];
  const params = [];
  let paramIdx = 1;

  if (level) {
    whereClauses.push(`el.level = $${paramIdx++}`);
    params.push(level);
  }
  if (dateFrom) {
    whereClauses.push(`el.created_at >= $${paramIdx++}`);
    params.push(dateFrom);
  }
  if (dateTo) {
    whereClauses.push(`el.created_at <= $${paramIdx++}`);
    params.push(dateTo + 'T23:59:59');
  }
  if (search) {
    whereClauses.push(`(el.message ILIKE $${paramIdx} OR el.url ILIKE $${paramIdx + 1} OR el.error_id ILIKE $${paramIdx + 2})`);
    const like = '%' + search + '%';
    params.push(like, like, like);
    paramIdx += 3;
  }

  const whereSql = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

  const totalRow = await safeGet('SELECT COUNT(*) as c FROM error_logs el ' + whereSql, params, { c: 0 });
  const total = totalRow ? totalRow.c : 0;
  const totalPages = Math.max(1, Math.ceil(total / perPage));

  const errors = await safeAll(
    'SELECT el.id, el.error_id, el.level, el.message, el.stack, el.context, el.request_id, el.user_id, el.url, el.method, el.created_at ' +
    'FROM error_logs el ' + whereSql +
    ` ORDER BY el.created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    params.concat([perPage, offset]),
    []
  );

  res.render('superadmin_errors', {
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
    errors,
    total,
    page,
    totalPages,
    perPage,
    filters: { level, date_from: dateFrom, date_to: dateTo, search },
    lang,
    isAr,
    user: req.user
  });
});

// ── Analytics dashboard (fork of /portal/admin/analytics — Batch 7) ──
//
// View: superadmin_analytics.ejs. Query logic mirrored verbatim from
// routes/analytics.js GET /portal/admin/analytics (lines 60-266). Locals
// shape (kpis, charts, attention, period, isAr) is BYTE-IDENTICAL — the
// view's inline Chart.js bootstrap uses JSON.stringify on charts.*, any
// drift silently breaks charts.
//
// Helpers periodStartDate / prevPeriodStartDate / pctChange are duplicated
// inline below (Q5 ruling — same precedent as safeGet/safeAll). The CSV
// export endpoint /api/analytics/export stays shared (Q2; see
// MIGRATION_NOTES "Shared JSON endpoints").
function _saPeriodStartDate(period) {
  const d = new Date();
  if (period === '7d')  d.setDate(d.getDate() - 7);
  else if (period === '30d') d.setDate(d.getDate() - 30);
  else if (period === '90d') d.setDate(d.getDate() - 90);
  else d.setMonth(d.getMonth() - 12); // default 12m
  return d.toISOString();
}
function _saPrevPeriodStartDate(period) {
  const d = new Date();
  if (period === '7d')  d.setDate(d.getDate() - 14);
  else if (period === '30d') d.setDate(d.getDate() - 60);
  else if (period === '90d') d.setDate(d.getDate() - 180);
  else d.setMonth(d.getMonth() - 24);
  return d.toISOString();
}
function _saPctChange(current, previous) {
  if (!previous || previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
}

router.get('/superadmin/analytics', requireSuperadmin, async (req, res) => {
  logAdminAudit({ req, action: 'viewed_payout_data', target: '/superadmin/analytics' });
  try {
    const period = req.query.period || '30d';
    const startDate = _saPeriodStartDate(period);
    const prevStart = _saPrevPeriodStartDate(period);
    const lang = (req.user && req.user.lang) || 'en';
    const isAr = lang === 'ar';

    // ── KPIs (current period) ──
    const totalCases = (await safeGet(
      "SELECT COUNT(*) as c FROM orders_active WHERE created_at >= $1",
      [startDate], { c: 0 }
    ) || {}).c || 0;

    const paidCases = (await safeGet(
      "SELECT COUNT(*) as c FROM orders_active WHERE payment_status IN ('paid','captured') AND created_at >= $1",
      [startDate], { c: 0 }
    ) || {}).c || 0;

    const totalRevenue = (await safeGet(
      "SELECT COALESCE(SUM(price), 0) as t FROM orders_active WHERE payment_status IN ('paid','captured') AND created_at >= $1",
      [startDate], { t: 0 }
    ) || {}).t || 0;

    const avgCaseValue = paidCases > 0 ? Math.round(totalRevenue / paidCases) : 0;

    const totalUsers = (await safeGet(
      "SELECT COUNT(*) as c FROM users WHERE created_at >= $1",
      [startDate], { c: 0 }
    ) || {}).c || 0;

    const activeDoctors = (await safeGet(
      "SELECT COUNT(*) as c FROM users WHERE role='doctor' AND is_active=true",
      [], { c: 0 }
    ) || {}).c || 0;

    const completedCases = (await safeGet(
      "SELECT COUNT(*) as c FROM orders_active WHERE LOWER(COALESCE(status, '')) IN ('completed','done','delivered') AND created_at >= $1",
      [startDate], { c: 0 }
    ) || {}).c || 0;

    const onTimeCases = (await safeGet(
      "SELECT COUNT(*) as c FROM orders_active WHERE LOWER(COALESCE(status, '')) IN ('completed','done','delivered') AND completed_at IS NOT NULL AND deadline_at IS NOT NULL AND completed_at <= deadline_at AND created_at >= $1",
      [startDate], { c: 0 }
    ) || {}).c || 0;

    const slaCompliance = completedCases > 0 ? Math.round((onTimeCases / completedCases) * 100 * 10) / 10 : 100;

    // Previous period
    const prevCases = (await safeGet(
      "SELECT COUNT(*) as c FROM orders_active WHERE created_at >= $1 AND created_at < $2",
      [prevStart, startDate], { c: 0 }
    ) || {}).c || 0;

    const prevRevenue = (await safeGet(
      "SELECT COALESCE(SUM(price), 0) as t FROM orders_active WHERE payment_status IN ('paid','captured') AND created_at >= $1 AND created_at < $2",
      [prevStart, startDate], { t: 0 }
    ) || {}).t || 0;

    const prevUsers = (await safeGet(
      "SELECT COUNT(*) as c FROM users WHERE created_at >= $1 AND created_at < $2",
      [prevStart, startDate], { c: 0 }
    ) || {}).c || 0;

    // Attention counts (all-time)
    // AUDIT (2026-08-17) — this compared status against the literal 'breached',
    // which nothing writes (the canonical value is 'SLA_BREACH'; 'breached' is
    // only a historical alias). The dashboard's "needs attention → breached"
    // tile was therefore permanently 0, so the one place ops looks to notice a
    // breached case never showed one. Match the full alias list, case-insensitively.
    const breachedAttentionIn = sqlIn(
      "LOWER(COALESCE(status, ''))",
      lowerUniqStrings(statusDbValues('SLA_BREACH', ['sla_breach', 'breached'])),
      1
    );
    const breachedAttention = (await safeGet(
      `SELECT COUNT(*) as c FROM orders_active WHERE ${breachedAttentionIn.clause}`,
      breachedAttentionIn.params, { c: 0 }
    ) || {}).c || 0;

    const unpaidAttention = (await safeGet(
      "SELECT COUNT(*) as c FROM orders_active WHERE payment_status = 'unpaid' AND LOWER(COALESCE(status, '')) NOT IN ('expired_unpaid','cancelled')",
      [], { c: 0 }
    ) || {}).c || 0;

    const expiredAttention = (await safeGet(
      "SELECT COUNT(*) as c FROM orders_active WHERE LOWER(COALESCE(status, '')) = 'expired_unpaid'",
      [], { c: 0 }
    ) || {}).c || 0;

    // Charts
    const revenueTrend = await safeAll(
      "SELECT TO_CHAR(created_at, 'YYYY-MM') as month, COALESCE(SUM(price), 0) as revenue, COUNT(*) as cases FROM orders_active WHERE payment_status IN ('paid','captured') AND created_at >= $1 GROUP BY TO_CHAR(created_at, 'YYYY-MM') ORDER BY month ASC",
      [startDate], []
    );

    const revenueByService = await safeAll(
      "SELECT COALESCE(sv.name, 'Unknown') as name, COALESCE(SUM(o.price), 0) as revenue, COUNT(o.id) as cases FROM orders_active o LEFT JOIN services sv ON sv.id = o.service_id WHERE o.payment_status IN ('paid','captured') AND o.created_at >= $1 GROUP BY o.service_id, sv.name ORDER BY revenue DESC LIMIT 8",
      [startDate], []
    );

    const casesByStatus = await safeAll(
      "SELECT LOWER(status) as status, COUNT(*) as count FROM orders_active WHERE created_at >= $1 GROUP BY LOWER(status) ORDER BY count DESC",
      [startDate], []
    );

    const userGrowth = await safeAll(
      "SELECT TO_CHAR(created_at, 'YYYY-MM-DD') as date, role, COUNT(*) as count FROM users WHERE created_at >= $1 GROUP BY date, role ORDER BY date ASC",
      [startDate], []
    );

    const topDoctors = await safeAll(
      "SELECT u.id, u.name, u.specialty_id, COALESCE(sp.name, '') as specialty_name, COUNT(o.id) as cases, COALESCE(SUM(o.price), 0) as revenue FROM users u LEFT JOIN orders_active o ON u.id = o.doctor_id AND o.payment_status IN ('paid','captured') AND o.created_at >= $1 LEFT JOIN specialties sp ON sp.id = u.specialty_id WHERE u.role = 'doctor' AND u.is_active = true GROUP BY u.id, u.name, u.specialty_id, sp.name ORDER BY revenue DESC LIMIT 10",
      [startDate], []
    );

    const slaTrend = await safeAll(
      "SELECT TO_CHAR(completed_at, 'YYYY-MM-DD') as date, COUNT(*) as total, SUM(CASE WHEN completed_at <= deadline_at THEN 1 ELSE 0 END) as on_time FROM orders_active WHERE LOWER(COALESCE(status, '')) IN ('completed','done','delivered') AND completed_at IS NOT NULL AND deadline_at IS NOT NULL AND created_at >= $1 GROUP BY TO_CHAR(completed_at, 'YYYY-MM-DD') ORDER BY date ASC",
      [startDate], []
    );

    const avgTat = (await safeGet(
      "SELECT AVG(EXTRACT(EPOCH FROM (completed_at - accepted_at)) / 3600) as hours FROM orders_active WHERE completed_at IS NOT NULL AND accepted_at IS NOT NULL AND created_at >= $1",
      [startDate], { hours: 0 }
    ) || {}).hours || 0;

    const paymentMethods = await safeAll(
      "SELECT COALESCE(payment_method, 'unknown') as method, COUNT(*) as count, COALESCE(SUM(COALESCE(total_price_with_addons, price, 0)), 0) as revenue FROM orders_active WHERE payment_status IN ('paid','captured') AND created_at >= $1 GROUP BY COALESCE(payment_method, 'unknown') ORDER BY count DESC",
      [startDate], []
    );

    let notificationStats = [];
    if (await tableExists('notifications')) {
      notificationStats = await safeAll(
        "SELECT COALESCE(channel, 'unknown') as channel, status, COUNT(*) as count FROM notifications WHERE at >= $1 GROUP BY channel, status ORDER BY channel, status",
        [startDate], []
      );
    }

    const doctorWorkload = await safeAll(
      "SELECT COALESCE(u.name, 'Unassigned') as name, COUNT(o.id) as cases FROM orders_active o LEFT JOIN users u ON u.id = o.doctor_id WHERE o.created_at >= $1 GROUP BY o.doctor_id, u.name HAVING COUNT(o.id) > 0 ORDER BY cases DESC LIMIT 15",
      [startDate], []
    );

    res.render('superadmin_analytics', {
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
      user: req.user,
      lang: lang,
      isAr: isAr,
      period: period,
      kpis: {
        totalCases: totalCases,
        paidCases: paidCases,
        totalRevenue: totalRevenue,
        avgCaseValue: avgCaseValue,
        totalUsers: totalUsers,
        activeDoctors: activeDoctors,
        completedCases: completedCases,
        slaCompliance: slaCompliance,
        avgTatHours: Math.round(avgTat * 10) / 10,
        casesChange: _saPctChange(totalCases, prevCases),
        revenueChange: _saPctChange(totalRevenue, prevRevenue),
        usersChange: _saPctChange(totalUsers, prevUsers)
      },
      charts: {
        revenueTrend: revenueTrend,
        revenueByService: revenueByService,
        casesByStatus: casesByStatus,
        userGrowth: userGrowth,
        topDoctors: topDoctors,
        slaTrend: slaTrend,
        paymentMethods: paymentMethods,
        notificationStats: notificationStats,
        doctorWorkload: doctorWorkload
      },
      attention: {
        breached: breachedAttention,
        unpaid: unpaidAttention,
        expired: expiredAttention
      }
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user && req.user.id, context: 'superadmin.analytics' });
    res.status(500).render('superadmin_analytics', {
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
      user: req.user,
      lang: 'en',
      isAr: false,
      period: '30d',
      kpis: {},
      charts: {},
      attention: {},
      error: 'Failed to load analytics'
    });
  }
});

// ── Instagram Campaign Manager (DB-backed) ──
router.get('/superadmin/instagram', requireSuperadmin, async (req, res) => {
  try {
    const showAll = req.query.all === '1';
    const filterSql = showAll
      ? 'SELECT * FROM ig_scheduled_posts ORDER BY day_number ASC, scheduled_at ASC'
      : `SELECT * FROM ig_scheduled_posts
         WHERE scheduled_at::timestamptz >= NOW() - INTERVAL '1 day'
            OR status IN ('pending_approval', 'rejected')
         ORDER BY day_number ASC, scheduled_at ASC`;
    const postsRaw = await queryAll(filterSql);

    const posts = postsRaw.map(p => {
      let imgUrl = null;
      try { const urls = JSON.parse(p.image_urls || '[]'); imgUrl = urls[0] || null; } catch (_) {}
      return {
        ...p,
        publishDate: p.scheduled_at,
        imageUrl: imgUrl,
        igId: p.ig_media_id,
        publishedAt: p.published_at,
        theme: p.caption_en ? p.caption_en.split('\n')[0].substring(0, 60) : (p.post_type || 'Post'),
      };
    });

    const totalAll = await queryOne('SELECT COUNT(*) as c FROM ig_scheduled_posts');
    const totalPosts = totalAll ? Number(totalAll.c) : posts.length;
    const published = posts.filter(p => p.status === 'published').length;
    const approved = posts.filter(p => p.status === 'approved').length;
    const pending = posts.filter(p => p.status === 'pending_approval').length;

    res.render('superadmin_instagram', {
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
      brand: 'Tashkheesa', portalFrame: true, portalRole: 'superadmin',
      portalActive: 'instagram', portalNext: '/superadmin',
      posts, stats: { totalPosts, published, scheduled: approved, pending },
      brandConfig: {}, user: req.user, showAll,
    });
  } catch (err) {
    logErrorToDb(err, {
      context: 'superadmin.instagram_dashboard',
      requestId: req.requestId,
      userId: req.user?.id,
      url: req.originalUrl,
      method: req.method,
      category: 'superadmin_action'
    });
    res.render('superadmin_instagram', {
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
      brand: 'Tashkheesa', portalFrame: true, portalRole: 'superadmin',
      portalActive: 'instagram', portalNext: '/superadmin',
      posts: [], stats: { totalPosts: 0, published: 0, scheduled: 0, pending: 0 },
      brandConfig: {}, user: req.user, error: err.message, showAll: false,
    });
  }
});

router.post('/superadmin/instagram/approve/:postId', requireSuperadmin, async (req, res) => {
  try {
    const now = new Date().toISOString();
    await execute(
      `UPDATE ig_scheduled_posts SET status = 'approved', approved_by = $1, approved_at = $2, updated_at = $3 WHERE id = $4 AND status = 'pending_approval'`,
      [req.user.id, now, now, req.params.postId]
    );
    res.json({ success: true });
  } catch (err) {
    logErrorToDb(err, {
      context: 'superadmin.instagram_approve',
      requestId: req.requestId,
      userId: req.user?.id,
      url: req.originalUrl,
      method: req.method,
      category: 'superadmin_action'
    });
    res.json({ success: false, error: err.message });
  }
});

router.post('/superadmin/instagram/reject/:postId', requireSuperadmin, async (req, res) => {
  try {
    const feedback = (req.body && req.body.feedback) || null;
    const now = new Date().toISOString();
    await execute(
      `UPDATE ig_scheduled_posts SET status = 'rejected', rejection_feedback = $1, updated_at = $2 WHERE id = $3`,
      [feedback, now, req.params.postId]
    );
    res.json({ success: true });
  } catch (err) {
    logErrorToDb(err, {
      context: 'superadmin.instagram_reject',
      requestId: req.requestId,
      userId: req.user?.id,
      url: req.originalUrl,
      method: req.method,
      category: 'superadmin_action'
    });
    res.json({ success: false, error: err.message });
  }
});

router.post('/superadmin/instagram/publish/:postId', requireSuperadmin, async (req, res) => {
  try {
    const { execSync } = require('child_process');
    const postId = req.params.postId;
    const result = execSync(
      `node scripts/instagram-publish-campaign.js --post ${postId}`,
      { cwd: require('path').join(__dirname, '../..'), encoding: 'utf-8', timeout: 60000 }
    );
    res.json({ success: true, output: result });
  } catch (err) {
    logErrorToDb(err, {
      context: 'superadmin.instagram_publish',
      requestId: req.requestId,
      userId: req.user?.id,
      url: req.originalUrl,
      method: req.method,
      category: 'superadmin_action'
    });
    res.json({ success: false, error: err.stderr || err.message });
  }
});

router.post('/superadmin/instagram/edit/:postId', requireSuperadmin, async (req, res) => {
  try {
    const { caption_en, caption_ar } = req.body;
    const now = new Date().toISOString();
    const hashtags = req.body.hashtags || '[]';

    // Rebuild combined caption
    const caption = `${caption_en || ''}\n\n---\n\n${caption_ar || ''}\n\n${JSON.parse(hashtags).join(' ')}`;

    await execute(
      `UPDATE ig_scheduled_posts SET caption_en = $1, caption_ar = $2, caption = $3, hashtags = $4, updated_at = $5 WHERE id = $6`,
      [caption_en, caption_ar, caption, hashtags, now, req.params.postId]
    );
    res.json({ success: true });
  } catch (err) {
    logErrorToDb(err, {
      context: 'superadmin.instagram_edit',
      requestId: req.requestId,
      userId: req.user?.id,
      url: req.originalUrl,
      method: req.method,
      category: 'superadmin_action'
    });
    res.json({ success: false, error: err.message });
  }
});

router.post('/superadmin/instagram/add-post', requireSuperadmin, async (req, res) => {
  try {
    const { randomUUID } = require('crypto');
    const { caption_en, caption_ar, post_type, scheduled_at, image_prompt } = req.body;
    const now = new Date().toISOString();
    const id = `ig-custom-${randomUUID()}`;
    const caption = `${caption_en || ''}\n\n---\n\n${caption_ar || ''}`;

    await execute(
      `INSERT INTO ig_scheduled_posts (id, post_type, caption_en, caption_ar, caption, image_urls, image_prompt, scheduled_at, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending_approval', $9, $10)`,
      [id, post_type || 'IMAGE', caption_en, caption_ar, caption, '[]', image_prompt || null, scheduled_at || now, now, now]
    );
    res.redirect('/superadmin/instagram');
  } catch (err) {
    logErrorToDb(err, {
      context: 'superadmin.instagram_add_post',
      requestId: req.requestId,
      userId: req.user?.id,
      url: req.originalUrl,
      method: req.method,
      category: 'superadmin_action'
    });
    res.redirect('/superadmin/instagram');
  }
});

// ─── Theme 7b Phase 3 — superadmin refund queue + actions ──────────
//   GET  /superadmin/refunds                       — queue page
//   POST /superadmin/refunds/:id/approve           — set status='approved'
//   POST /superadmin/refunds/:id/deny              — set status='denied'
//   POST /superadmin/refunds/:id/mark-paid         — set status='paid'

router.get('/superadmin/refunds', requireSuperadmin, async (req, res) => {
  const lang = (res.locals && res.locals.lang) || 'en';
  const isAr = String(lang).toLowerCase() === 'ar';
  const flash = String((req.query && req.query.flash) || '').trim();
  const flashError = String((req.query && req.query.error) || '').trim();
  const prefillOrder = String((req.query && req.query.prefill_order) || '').trim();

  // Pending review (oldest first — FIFO so the operator picks them up
  // in order). Auto_approved + approved go to the "awaiting payment"
  // bucket. Paid + denied go to the "recent" bucket (last 30 days).
  const pending = await safeAll(
    `SELECT r.*, u.name AS patient_name
       FROM refunds r
       LEFT JOIN users u ON u.id = r.requested_by
      WHERE r.status = 'pending'
      ORDER BY r.refunded_at ASC`,
    []
  );
  const awaitingPayment = await safeAll(
    `SELECT r.*, u.name AS patient_name
       FROM refunds r
       LEFT JOIN users u ON u.id = r.requested_by
      WHERE r.status IN ('auto_approved','approved')
      ORDER BY r.refunded_at ASC`,
    []
  );
  const recent = await safeAll(
    `SELECT r.*, u.name AS patient_name
       FROM refunds r
       LEFT JOIN users u ON u.id = r.requested_by
      WHERE r.status IN ('paid','denied')
        AND r.refunded_at > NOW() - INTERVAL '30 days'
        AND r.reason = 'patient_request'
      ORDER BY r.refunded_at DESC
      LIMIT 50`,
    []
  );

  // If prefill_order is set (legacy redirect from
  // /superadmin/orders/:id/payment with payment_status=refunded),
  // load the order's details so the queue can show a "create refund
  // for this case" affordance at the top.
  let prefillOrderRow = null;
  if (prefillOrder) {
    prefillOrderRow = await queryOne(
      `SELECT id, price, base_price, urgency_uplift_amount, addons_json, video_consultation_selected, video_consultation_price FROM orders_active WHERE id = $1`,
      [prefillOrder]
    );
  }

  res.render('superadmin_refunds', {
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
    user: req.user,
    lang, isAr,
    pending: pending || [],
    awaitingPayment: awaitingPayment || [],
    recent: recent || [],
    flash,
    flashError,
    prefillOrder,
    prefillOrderRow
  });
});

// ── Side issue #44 — operator-initiated refund creation ───────────────
//
// Per the legacy `payment_status='refunded'` redirect (line 2640) and
// Theme 7b audit OQ-14, operators need to be able to issue a refund on
// a patient's behalf (phone call, in-person request, etc.) without the
// patient having to log in and self-submit.
//
// Shape mirrors the patient flow (refunds row INSERT) but with:
//   - reason='operator_refund'           (vs 'patient_request')
//   - requested_by=operator's user_id    (the operator owns the record)
//   - status='pending' always            (skip the auto-approve gate;
//                                         the operator IS the approver)
//   - patient_reason=fixed string        (no patient prose; operator
//                                         provides context via notes)
//
// Migration NOT needed — every column already exists. Validation skips
// `isEligibleForRefund` since that checks patient-ownership which doesn't
// apply when the operator initiates; we re-derive the basic eligibility
// (order exists, payment_status='paid', no pending/approved refund row)
// inline.

router.get('/superadmin/refunds/create', requireSuperadmin, async (req, res) => {
  const orderId = String((req.query && req.query.order_id) || '').trim();
  if (!orderId) {
    return res.redirect('/superadmin/refunds?error=order_id_required');
  }

  // AUDIT (2026-08-17) — widened for maxRefundableEgp (needs price + add-ons).
  const order = await queryOne(
    `SELECT o.id, o.patient_id, o.payment_status,
            o.price, o.base_price, o.urgency_uplift_amount, o.addons_json,
            o.video_consultation_selected, o.video_consultation_price,
            o.reference_id, u.name AS patient_name, u.email AS patient_email
       FROM orders_active o
       LEFT JOIN users u ON u.id = o.patient_id
      WHERE o.id = $1`,
    [orderId]
  );
  if (!order) {
    return res.redirect('/superadmin/refunds?error=order_not_found');
  }

  // Check for an existing non-terminal refund row (pending / auto_approved /
  // approved / paid). If one exists, operator should use the queue, not
  // create another.
  // AUDIT-2026-08-22 (M7): `reason` projected so the form can tell the operator
  // that an unpaid SLA-breach auto-refund is a TOP-UP, not a dead end — the
  // POST below supersedes it in place. See services/admin_refund.
  const existingRefund = await queryOne(
    `SELECT id, status, reason FROM refunds
      WHERE order_id = $1
        AND status IN ('pending','auto_approved','approved','paid')
      LIMIT 1`,
    [orderId]
  );

  const lang = (res.locals && res.locals.lang) || 'en';
  const isAr = String(lang).toLowerCase() === 'ar';
  // AUDIT (2026-08-17) — same legacy formula as the manual-queue site: it
  // omitted add-ons and returned 0 for every order whose creation path never
  // wrote base_price, pre-filling the operator form with a zero refund.
  const defaultAmount = maxRefundableEgp(order);

  // AUDIT-2026-08-22 (M7): an UNPAID SLA-breach auto-refund must not hide the
  // form. superadmin_refund_create.ejs renders a "refund already exists — use
  // the queue" dead end whenever `existingRefund` is set, and the queue has no
  // top-up action, so a case that breached (uplift refunded automatically) and
  // then failed outright had no route to a real refund at all — the operator
  // could not even open the form. Passing null lets the form render; the POST
  // handler recognises the same blocker and SUPERSEDES the breach row in place
  // (services/admin_refund.supersedeBreachRefund) instead of inserting a second
  // row, which migration 083's uniq_refunds_open_per_order forbids. All the
  // policy is enforced server-side in the POST, never here.
  //
  // HANDOFF (view owner): superadmin_refund_create.ejs should say so — "topping
  // up the automatic SLA-breach refund of X EGP" — rather than presenting this
  // as a fresh refund. `supersedingBreachRefund` is passed for exactly that and
  // is currently unused by the template.
  const supersedableBreach = !!(existingRefund
    && String(existingRefund.reason) === 'sla_breach'
    && String(existingRefund.status) !== 'paid');

  res.render('superadmin_refund_create', {
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
    user: req.user,
    lang, isAr,
    order: order,
    defaultAmount: defaultAmount,
    existingRefund: supersedableBreach ? null : (existingRefund || null),
    supersedingBreachRefund: supersedableBreach ? existingRefund : null,
    formError: String((req.query && req.query.error) || '').trim() || null
  });
});

router.post('/superadmin/refunds/create', requireSuperadmin, async (req, res) => {
  const orderId      = String((req.body && req.body.order_id) || '').trim();
  const amountRaw    = Number((req.body && req.body.amount));
  const instapayRaw  = String((req.body && req.body.instapay_handle) || '').trim();
  const notesRaw     = String((req.body && req.body.notes) || '').trim().slice(0, 1000);

  if (!orderId) {
    return res.redirect('/superadmin/refunds?error=order_id_required');
  }

  const order = await queryOne(
    `SELECT id, patient_id, payment_status, price, base_price, urgency_uplift_amount, addons_json, video_consultation_selected, video_consultation_price
       FROM orders_active WHERE id = $1`,
    [orderId]
  );
  if (!order) {
    return res.redirect('/superadmin/refunds?error=order_not_found');
  }
  if (String(order.payment_status || '').toLowerCase() !== 'paid') {
    return res.redirect(
      '/superadmin/refunds/create?order_id=' + encodeURIComponent(orderId) + '&error=order_not_paid'
    );
  }

  // Re-check the no-existing-refund gate inside the POST so a race
  // between two operators can't double-write.
  // AUDIT-2026-08-22 (M7): `reason` projected — see the supersede branch below.
  const existingRefund = await queryOne(
    `SELECT id, status, reason FROM refunds
      WHERE order_id = $1
        AND status IN ('pending','auto_approved','approved','paid')
      LIMIT 1`,
    [orderId]
  );
  // ── AUDIT-2026-08-22 (M7): SLA-breach auto-refunds are TOPPED UP, not blocked
  //
  // services/sla_breach opens an automatic refund of the urgency uplift only,
  // reason='sla_breach', status='auto_approved'. Migration 083's
  // uniq_refunds_open_per_order permits exactly ONE refund row per order across
  // ('pending','auto_approved','approved','paid'), so that row used to bounce
  // every operator refund on the case with `refund_already_exists` — for good.
  // A case that breached and then failed outright could be given back its 200
  // EGP uplift and NOTHING of the 1000 EGP the patient paid for the report.
  //
  // There is no second row to be had (the index forbids it), so the supported
  // resolution is to raise the row that exists. All the policy — breach-only,
  // unpaid-only, up-only, reason preserved — lives in
  // services/admin_refund.supersedeBreachRefund; this is the wiring.
  if (existingRefund
      && String(existingRefund.reason) === 'sla_breach'
      && String(existingRefund.status) !== 'paid') {
    if (!Number.isFinite(amountRaw) || amountRaw <= 0) {
      return res.redirect(
        '/superadmin/refunds/create?order_id=' + encodeURIComponent(orderId) + '&error=invalid_amount'
      );
    }
    // Same handle requirement as a fresh operator refund: the auto-created
    // breach row carries NO instapay_handle (services/sla_breach's INSERT does
    // not set one), so this is the operator's chance to supply the payout
    // target rather than leaving the queue with nowhere to send the money.
    if (!instapayRaw || instapayRaw.length < 3 || instapayRaw.length > 100) {
      return res.redirect(
        '/superadmin/refunds/create?order_id=' + encodeURIComponent(orderId) + '&error=instapay_required'
      );
    }
    const { supersedeBreachRefund } = require('../services/admin_refund');
    const client = await pool.connect();
    try {
      const out = await supersedeBreachRefund(client, {
        orderId,
        amount: amountRaw,
        instapayHandle: instapayRaw,
        notes: notesRaw,
        actorId: req.user.id
      });
      logOrderEvent({
        orderId: orderId,
        label: 'operator_refund_superseded_breach',
        meta: {
          refund_id: out.id,
          previous_amount_egp: out.previousAmountEgp,
          amount_egp: out.amountEgp,
          operator_user_id: req.user.id
        },
        actorUserId: req.user.id,
        actorRole: 'superadmin'
      });
      return res.redirect('/superadmin/refunds?flash=superseded');
    } catch (err) {
      logErrorToDb(err, {
        context: 'superadmin.operator_refund_supersede_breach',
        requestId: req.requestId,
        userId: req.user.id,
        orderId: orderId,
        category: 'refund'
      });
      // The service's codes map onto the form's existing error keys where one
      // fits; anything else falls through to the generic message.
      const code = String((err && err.code) || '');
      const errKey =
        code === 'AMOUNT_EXCEEDS_MAX'   ? 'amount_exceeds_max' :
        code === 'INVALID_AMOUNT'       ? 'invalid_amount' :
        code === 'AMOUNT_NOT_A_TOPUP'   ? 'amount_not_a_topup' :
        code === 'REFUND_ALREADY_PAID'  ? 'refund_already_paid' :
                                          'refund_already_exists';
      return res.redirect(
        '/superadmin/refunds/create?order_id=' + encodeURIComponent(orderId) + '&error=' + errKey
      );
    } finally {
      client.release();
    }
  }
  if (existingRefund) {
    return res.redirect(
      '/superadmin/refunds/create?order_id=' + encodeURIComponent(orderId) + '&error=refund_already_exists'
    );
  }

  // Amount: required, > 0, <= everything the patient was actually charged.
  // AUDIT (2026-08-17) — the old base+uplift ceiling both under-counted (no
  // add-ons) and, on the several INSERT paths that never wrote base_price,
  // evaluated to 0 — so `amountRaw > maxAmount` rejected EVERY amount and the
  // operator could not create a refund for those orders at all.
  const maxAmount = maxRefundableEgp(order);
  if (!Number.isFinite(amountRaw) || amountRaw <= 0) {
    return res.redirect(
      '/superadmin/refunds/create?order_id=' + encodeURIComponent(orderId) + '&error=invalid_amount'
    );
  }
  if (amountRaw > maxAmount + 0.001) {
    return res.redirect(
      '/superadmin/refunds/create?order_id=' + encodeURIComponent(orderId) + '&error=amount_exceeds_max'
    );
  }
  if (!instapayRaw || instapayRaw.length < 3 || instapayRaw.length > 100) {
    return res.redirect(
      '/superadmin/refunds/create?order_id=' + encodeURIComponent(orderId) + '&error=instapay_required'
    );
  }

  const refundId = require('crypto').randomUUID();
  const operatorId = req.user.id;
  const combinedNotes = 'Operator-initiated refund — see audit log'
    + (notesRaw ? ' — ' + notesRaw : '');

  try {
    await execute(
      `INSERT INTO refunds (
         id, order_id, amount_egp, requested_amount, approved_amount,
         reason, patient_reason, instapay_handle, status,
         requested_by, refunded_at, refunded_by, notes
       ) VALUES ($1, $2, $3, $3, NULL, 'operator_refund', NULL, $4, 'pending',
                 $5, NOW(), $5, $6)`,
      [refundId, orderId, amountRaw, instapayRaw, operatorId, combinedNotes]
    );
  } catch (err) {
    logErrorToDb(err, {
      context: 'superadmin.operator_refund_create',
      requestId: req.requestId,
      userId: operatorId,
      orderId: orderId,
      category: 'refund'
    });
    return res.redirect(
      '/superadmin/refunds/create?order_id=' + encodeURIComponent(orderId) + '&error=insert_failed'
    );
  }

  // Audit
  logOrderEvent({
    orderId: orderId,
    label: 'operator_refund_created',
    meta: {
      refund_id: refundId,
      amount_egp: amountRaw,
      instapay_handle: instapayRaw,
      operator_user_id: operatorId,
      operator_notes_preview: notesRaw.slice(0, 100)
    },
    actorUserId: operatorId,
    actorRole: 'superadmin'
  });

  // Notify patient — honest copy ("opened on your behalf"), not the
  // patient-self-initiated template. Skip admin fan-out: the operator
  // IS the admin.
  if (order.patient_id) {
    try {
      queueMultiChannelNotification({
        orderId: orderId,
        toUserId: order.patient_id,
        channels: ['internal', 'email'],
        template: 'patient_refund_opened_by_operator',
        response: {
          case_id: orderId,
          caseReference: orderId.slice(0, 12).toUpperCase(),
          requestedAmount: amountRaw.toFixed(2),
          instapayHandle: instapayRaw,
          patientName: '' // resolved by notification_worker from users.name
        },
        dedupe_key: 'refund_opened_by_operator:' + refundId + ':patient'
      });
    } catch (_) { /* best-effort — never block the redirect */ }
  }

  return res.redirect('/superadmin/refunds?flash=created');
});

router.post('/superadmin/refunds/:id/approve', requireSuperadmin, async (req, res) => {
  const refundId = req.params.id;
  const reviewerId = req.user.id;
  const approvedAmountRaw = Number(req.body && req.body.approved_amount);
  const notesRaw = String((req.body && req.body.notes) || '').trim().slice(0, 1000);

  const refund = await queryOne(
    "SELECT id, order_id, status, requested_amount FROM refunds WHERE id = $1",
    [refundId]
  );
  if (!refund) return res.redirect('/superadmin/refunds?error=not_found');
  if (!['pending', 'auto_approved'].includes(String(refund.status))) {
    return res.redirect('/superadmin/refunds?error=invalid_state');
  }

  // Validate amount: required, > 0, <= requested_amount.
  if (!Number.isFinite(approvedAmountRaw) || approvedAmountRaw <= 0) {
    return res.redirect('/superadmin/refunds?error=invalid_amount');
  }
  const requestedAmount = Number(refund.requested_amount || 0);
  if (approvedAmountRaw > requestedAmount + 0.001) {
    // Tiny epsilon to absorb float weirdness. No upgrades.
    return res.redirect('/superadmin/refunds?error=amount_exceeds_requested');
  }

  // Re-validate state in the UPDATE to defend against concurrent admins.
  const result = await execute(
    `UPDATE refunds
        SET status = 'approved',
            approved_amount = $1,
            reviewed_by = $2,
            reviewed_at = NOW(),
            notes = COALESCE(NULLIF($3, ''), notes)
      WHERE id = $4 AND status IN ('pending','auto_approved')`,
    [approvedAmountRaw, reviewerId, notesRaw, refundId]
  );
  if (!result || result.rowCount === 0) {
    return res.redirect('/superadmin/refunds?error=invalid_state');
  }

  logOrderEvent({
    orderId: refund.order_id,
    label: 'superadmin_refund_approved',
    meta: { refund_id: refundId, approved_amount_egp: approvedAmountRaw, reviewer_id: reviewerId },
    actorUserId: reviewerId,
    actorRole: 'superadmin'
  });

  // Patient notification (in-app + email).
  try {
    const patient = await queryOne(
      "SELECT requested_by FROM refunds WHERE id = $1", [refundId]);
    if (patient && patient.requested_by) {
      queueMultiChannelNotification({
        orderId: refund.order_id,
        toUserId: patient.requested_by,
        channels: ['internal', 'email'],
        template: 'patient_refund_approved',
        response: {
          case_id: refund.order_id,
          caseReference: refund.order_id.slice(0, 12).toUpperCase(),
          approvedAmount: approvedAmountRaw.toFixed(2)
        },
        dedupe_key: 'refund_approved:' + refundId + ':patient'
      });
    }
  } catch (_) { /* best-effort */ }

  return res.redirect('/superadmin/refunds?flash=approved');
});

router.post('/superadmin/refunds/:id/deny', requireSuperadmin, async (req, res) => {
  const refundId = req.params.id;
  const reviewerId = req.user.id;
  const denialReason = String((req.body && req.body.denial_reason) || '').trim();

  if (!denialReason || denialReason.length < 1 || denialReason.length > 1000) {
    return res.redirect('/superadmin/refunds?error=denial_reason_required');
  }

  const refund = await queryOne(
    "SELECT id, order_id, status, requested_by FROM refunds WHERE id = $1",
    [refundId]
  );
  if (!refund) return res.redirect('/superadmin/refunds?error=not_found');
  if (!['pending', 'auto_approved'].includes(String(refund.status))) {
    return res.redirect('/superadmin/refunds?error=invalid_state');
  }

  const result = await execute(
    `UPDATE refunds
        SET status = 'denied',
            denial_reason = $1,
            reviewed_by = $2,
            reviewed_at = NOW()
      WHERE id = $3 AND status IN ('pending','auto_approved')`,
    [denialReason, reviewerId, refundId]
  );
  if (!result || result.rowCount === 0) {
    return res.redirect('/superadmin/refunds?error=invalid_state');
  }

  logOrderEvent({
    orderId: refund.order_id,
    label: 'superadmin_refund_denied',
    meta: { refund_id: refundId, denial_reason: denialReason.slice(0, 200), reviewer_id: reviewerId },
    actorUserId: reviewerId,
    actorRole: 'superadmin'
  });

  try {
    if (refund.requested_by) {
      queueMultiChannelNotification({
        orderId: refund.order_id,
        toUserId: refund.requested_by,
        channels: ['internal', 'email'],
        template: 'patient_refund_denied',
        response: {
          case_id: refund.order_id,
          caseReference: refund.order_id.slice(0, 12).toUpperCase(),
          denialReason
        },
        dedupe_key: 'refund_denied:' + refundId + ':patient'
      });
    }
  } catch (_) { /* best-effort */ }

  return res.redirect('/superadmin/refunds?flash=denied');
});

router.post('/superadmin/refunds/:id/mark-paid', requireSuperadmin, async (req, res) => {
  const refundId = req.params.id;
  const payerId = req.user.id;
  const reference = String((req.body && req.body.instapay_reference) || '').trim();

  if (!reference || reference.length < 1 || reference.length > 100) {
    return res.redirect('/superadmin/refunds?error=instapay_reference_required');
  }

  const refund = await queryOne(
    "SELECT id, order_id, status, approved_amount, requested_amount, requested_by FROM refunds WHERE id = $1",
    [refundId]
  );
  if (!refund) return res.redirect('/superadmin/refunds?error=not_found');
  if (!['approved', 'auto_approved'].includes(String(refund.status))) {
    return res.redirect('/superadmin/refunds?error=invalid_state');
  }

  // Per the brief: amount_egp = approved_amount (or requested_amount
  // for auto_approved → paid direct path). The status field disambiguates
  // the row's role for existing readers (services/sla_breach.js etc.).
  const finalAmount = Number(
    refund.approved_amount != null ? refund.approved_amount : refund.requested_amount
  ) || 0;

  const result = await execute(
    `UPDATE refunds
        SET status = 'paid',
            instapay_reference = $1,
            paid_at = NOW(),
            amount_egp = $2,
            approved_amount = COALESCE(approved_amount, $2)
      WHERE id = $3 AND status IN ('approved','auto_approved')`,
    [reference, finalAmount, refundId]
  );
  if (!result || result.rowCount === 0) {
    return res.redirect('/superadmin/refunds?error=invalid_state');
  }

  // AUDIT (2026-08-17) — DOUBLE-REFUND, second half. Marking a refund paid
  // never touched the ORDER, so orders.payment_status stayed 'paid' forever.
  // services/refund_eligibility.isEligibleForRefund gates purely on that
  // column plus the case status, so a fully-refunded pre-accept case still
  // read back as "eligible, auto-approve" and the patient could request a
  // second full refund the moment this row left the ('pending','auto_approved')
  // partial-unique index. Closing the money loop here makes the order itself
  // carry the refunded fact: eligibility then returns 'not_paid' and every
  // downstream reader (patient case page CTA, superadmin queue, the operator
  // create-refund form) agrees without needing its own refunds lookup.
  // Best-effort by design — the refund IS paid from the patient's POV, so a
  // failure here must not 500 the operator; it is logged for reconciliation.
  //
  // AUDIT (2026-08-17, regression F1) — this and the Command service's
  // in-txn write are now ONE implementation
  // (services/admin_refund_mark_paid.applyRefundedPaymentStatus): same
  // full-vs-partial test, same rounding, same updated_at, and a rowCount check
  // that neither had. Critically it only flips on a FULL refund — a partial
  // one leaves the order 'paid', because every consumer of payment_status
  // treats "not 'paid'" as "unpaid", which soft-deletes the case at the 48h
  // unpaid hard stop and erases the whole order value from revenue.
  let psOutcome = { flipped: false, reason: 'not_attempted' };
  try {
    psOutcome = await applyRefundedPaymentStatus(execute, refund.order_id);
  } catch (e) {
    psOutcome = { flipped: false, reason: 'error' };
    logErrorToDb(e, {
      context: 'superadmin.refund_mark_paid.order_payment_status',
      orderId: refund.order_id,
      refundId: refundId,
      category: 'refund'
    });
  }
  if (!psOutcome.flipped && !['partial_refund', 'already_refunded'].includes(psOutcome.reason)) {
    // 'partial_refund' and 'already_refunded' are correct no-ops. Anything else
    // means the double-refund eligibility loop is still open on this order and
    // a human needs to reconcile it (migration 082's
    // uniq_refunds_open_per_order remains the DB-level backstop meanwhile).
    try {
      logErrorToDb(new Error('refund mark-paid did not close orders.payment_status: ' + psOutcome.reason), {
        context: 'superadmin.refund_mark_paid.order_payment_status_not_closed',
        orderId: refund.order_id,
        refundId: refundId,
        category: 'refund'
      });
    } catch (_) { /* best-effort */ }
  }

  logOrderEvent({
    orderId: refund.order_id,
    label: 'superadmin_refund_marked_paid',
    meta: {
      refund_id: refundId,
      amount_egp: finalAmount,
      instapay_reference: reference,
      payer_id: payerId,
      order_payment_status: psOutcome.flipped ? 'refunded' : 'unchanged',
      order_payment_status_reason: psOutcome.reason,
      total_refunded_egp: psOutcome.refundedEgp != null ? psOutcome.refundedEgp : null,
      refund_ceiling_egp: psOutcome.ceilingEgp != null ? psOutcome.ceilingEgp : null
    },
    actorUserId: payerId,
    actorRole: 'superadmin'
  });

  // AUDIT 2026-08-17 — close the case when the refunds paid against it cover
  // what the patient was charged. Until now nothing here touched `orders`, so a
  // fully refunded case stayed active forever: still counted in the KPIs, still
  // occupying one of its doctor's four slots, still reassignable, still showing
  // in the Command app's "needs action" card, with payment_status='paid'.
  //
  // Deliberately AFTER the refunds UPDATE above: the closure decision sums
  // refunds WHERE status='paid', so this row must already be marked paid for it
  // to count. Non-throwing by construction — a failure here must never leave a
  // patient's refund unrecorded.
  try {
    const { closeOrderIfFullyRefunded } = require('../services/refund_closure');
    await closeOrderIfFullyRefunded(refund.order_id, { actorUserId: payerId });
  } catch (e) {
    logErrorToDb(e, {
      context: 'superadmin.refund_mark_paid.closeOrderIfFullyRefunded',
      orderId: refund.order_id,
      refundId: refundId,
      category: 'refund'
    });
  }

  // Side issue #43 — apply doctor-earnings clawback policy per refund reason.
  // Hooks decoupled by design:
  //   - recomputeOnBreach (Site 3, fires at SLA breach detection) zeroes
  //     only the urgency uplift mid-flight.
  //   - recomputeOnRefund (Site 4, this call) fires at refund mark-paid
  //     and applies the final clawback per Ziad's 2026-05-12 policy:
  //       reason='sla_breach'             → earned_amount = 0 (full clawback)
  //       reason='patient_request' OR
  //       reason='operator_refund'        → keep 10% of (baseShare + upliftShare)
  //       (else)                          → skip (pre-acceptance, no earnings row)
  //   Idempotency guard inside recomputeOnRefund prevents double-claw on
  //   operator double-click or retry.
  try {
    const { recomputeOnRefund } = require('../services/earnings_writer');
    // AUDIT (2026-08-17): recomputeOnRefund now scales the doctor's clawback
    // LINEARLY by the refund ratio (a 25% partial refund claws back ~25% of
    // the doctor's share, not the whole thing) — but only when it is handed
    // refundAmountEgp. Without it the helper falls back to the old
    // all-or-nothing clawback, so a partially-refunded case would still zero
    // the doctor to the 10% floor. The SELECT below therefore re-reads the
    // amount columns as well as the reason; it runs AFTER the UPDATE, so
    // approved_amount has already been backfilled with finalAmount.
    const refundRow = await queryOne(
      "SELECT reason, approved_amount, requested_amount FROM refunds WHERE id = $1", [refundId]
    );
    if (refundRow && refundRow.reason) {
      await recomputeOnRefund(refund.order_id, {
        reason: refundRow.reason,
        refundAmountEgp: Number(refundRow.approved_amount ?? refundRow.requested_amount) || null
      });
    }
  } catch (e) {
    logErrorToDb(e, {
      context: 'superadmin.refund_mark_paid.recomputeOnRefund',
      orderId: refund.order_id,
      refundId: refundId,
      category: 'refund'
    });
    // Best-effort: a clawback failure must not block the refund mark-paid
    // operation. The refund is already paid from the patient's POV; the
    // earnings recompute can be retried via the manual earnings UI.
  }

  try {
    if (refund.requested_by) {
      queueMultiChannelNotification({
        orderId: refund.order_id,
        toUserId: refund.requested_by,
        channels: ['internal', 'email'],
        template: 'patient_refund_paid',
        response: {
          case_id: refund.order_id,
          caseReference: refund.order_id.slice(0, 12).toUpperCase(),
          amount: finalAmount.toFixed(2),
          instapayReference: reference
        },
        dedupe_key: 'refund_paid:' + refundId + ':patient'
      });
    }
  } catch (_) { /* best-effort */ }

  return res.redirect('/superadmin/refunds?flash=paid');
});

// additionalFilesDecisionPredicate is exported so routes/admin.js uses the SAME
// definition rather than keeping the fourth copy of this vocabulary — the
// divergence between copies is precisely what left approved file requests
// pinned in the inbox forever (see the function's header).
module.exports = { router, buildFilters, additionalFilesDecisionPredicate };
