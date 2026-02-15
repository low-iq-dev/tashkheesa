const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, acceptOrder, markOrderCompleted } = require('../db');
const { requireRole } = require('../middleware');
const { queueNotification, queueMultiChannelNotification, doctorNotify } = require('../notify');
const { getNotificationTitles } = require('../notify/notification_titles');
const { logOrderEvent } = require('../audit');
const { computeSla, enforceBreachIfNeeded } = require('../sla_status');
const { recalcSlaBreaches } = require('../sla');
const { ensureConversation } = require('./messaging');
const caseLifecycle = require('../case_lifecycle');
const toCanonStatus = caseLifecycle.toCanonStatus;
const toDbStatus = caseLifecycle.toDbStatus;
const dbStatusValuesFor = caseLifecycle.dbStatusValuesFor;
// NOTE: case_lifecycle helpers are kept for legacy flows, but the portal doctor reject-files
// action is implemented directly against the `orders` table to support human-friendly case IDs.
const { generateMedicalReportPdf } = require('../report-generator');
const { assertRenderableView } = require('../renderGuard');

const router = express.Router();
// WhatsApp sender (safe import; do not crash if module is unavailable in some envs)
const wa = require('../notify/whatsapp');
const sendWhatsApp = (wa && typeof wa.sendWhatsApp === 'function') ? wa.sendWhatsApp : null;
// Status buckets:
// - UNACCEPTED: doctor can still accept (including assigned-to-doctor but not yet accepted)
// - ACCEPTED: doctor has accepted and case is actively being worked
const ACCEPTED_STATUSES = [
  'in_review',
  'review',
  'awaiting_files',
  'rejected_files',
  'breached',
  'sla_breach'
];

// Legacy/backward-compat: some flows may have written payment state into `orders.status` (e.g., 'PAID').
// Also treat 'assigned/accepted' as NOT accepted yet (acceptance is when `accepted_at` is set).
const UNACCEPTED_STATUSES = ['new', 'submitted', 'paid', 'assigned', 'accepted'];

// ---- Doctor capacity guardrails ----
const MAX_ACTIVE_CASES = 4;

function countActiveCasesForDoctor(doctorId) {
  return db.prepare(`
    SELECT COUNT(*) AS c
    FROM orders
    WHERE doctor_id = ?
      AND LOWER(status) IN ('assigned','in_review','rejected_files','breached','sla_breach')
  `).get(doctorId).c;
}

function findNextAvailableDoctor(specialtyId, excludeDoctorId) {
  const spec = specialtyId == null ? '' : String(specialtyId);
  const exclude = excludeDoctorId == null ? '' : String(excludeDoctorId);

  // NOTE:
  // Some DB snapshots do not have (or do not consistently use) `doctor_services`.
  // The canonical field for a doctor's specialty in this portal DB is `users.specialty_id`.
  // Keep this selection simple and resilient to schema drift.
  return db.prepare(`
    SELECT u.id
    FROM users u
    WHERE LOWER(COALESCE(u.role, '')) = 'doctor'
      AND COALESCE(u.is_active, 1) = 1
      AND (? = '' OR u.specialty_id = ?)
      AND u.id != ?
      AND (
        SELECT COUNT(*)
        FROM orders o
        WHERE o.doctor_id = u.id
          AND LOWER(o.status) IN ('assigned','in_review','rejected_files','breached','sla_breach')
      ) < ?
    ORDER BY datetime(COALESCE(u.created_at, '1970-01-01')) ASC
    LIMIT 1
  `).get(spec, spec, exclude, MAX_ACTIVE_CASES);
}
function stripPricingFields(order) {
  if (!order || typeof order !== 'object') return order;

  const clone = { ...order };

  // Remove pricing fields (doctors must not see pricing)
  delete clone.price;
  delete clone.doctor_fee;
  delete clone.locked_price;
  delete clone.locked_currency;
  delete clone.price_snapshot_json;

  // Guardrail: NEVER strip payment state. Doctor UI relies on it for gating.
  // (Some earlier versions of this helper deleted these fields.)
  if (order.payment_status != null) clone.payment_status = order.payment_status;
  if (order.payment_method != null) clone.payment_method = order.payment_method;
  if (order.payment_reference != null) clone.payment_reference = order.payment_reference;
  if (order.paid_at != null) clone.paid_at = order.paid_at;

  return clone;
}

const requireDoctor = requireRole('doctor');

// Root doctor path → always redirect to dashboard (prevents 404)
router.get('/portal/doctor', requireDoctor, (req, res) => {
  return res.redirect('/portal/doctor/dashboard');
});

// Doctor dashboard (MAIN landing page)
router.get('/portal/doctor/dashboard', requireDoctor, (req, res) => {
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';
  const doctorId = req.user && req.user.id ? String(req.user.id) : '';
  const doctorSpecialtyId = req.user && req.user.specialty_id ? String(req.user.specialty_id) : '';

  // HARD-LOCK dashboard buckets to avoid lifecycle resolver mismatches
  const newStatuses = UNACCEPTED_STATUSES;
  const reviewStatuses = ACCEPTED_STATUSES;
  const completedStatuses = ['completed'];

  // New cases come from two sources:
  // 1) unassigned pool (doctor_id is NULL) that matches the doctor's specialty
  // 2) already assigned to THIS doctor but not yet accepted (status assigned/accepted, accepted_at is NULL)
  const assignedPendingCases = db
    .prepare(
      `SELECT o.*,
              s.name AS specialty_name,
              sv.name AS service_name
       FROM orders o
       LEFT JOIN specialties s ON o.specialty_id = s.id
       LEFT JOIN services sv ON o.service_id = sv.id
       WHERE o.doctor_id = ?
         AND COALESCE(o.accepted_at, '') = ''
         AND LOWER(COALESCE(o.status,'')) IN ('assigned','accepted')
       ORDER BY datetime(COALESCE(o.updated_at, o.created_at)) DESC
       LIMIT ?`
    )
    .all(doctorId, 6);
  const assignedPendingTotal = countAssignedPendingCases(doctorId);

  const assignedPendingMapped = enrichOrders(assignedPendingCases).map((order) => {
    const ps = String(order.payment_status || '').toLowerCase();
    const isPaid = ps === 'paid' || ps === 'captured';
    return mapPortalCaseItem(order, lang, { isPaid });
  });

  const poolNewCases = buildPortalCasesUnassigned(doctorSpecialtyId, newStatuses, 6, lang);
  const poolUnassignedTotal = countPortalCasesUnassigned(doctorSpecialtyId, newStatuses);
  const newCasesTotal = assignedPendingTotal + poolUnassignedTotal;
  const newCases = [...assignedPendingMapped, ...poolNewCases].slice(0, 6);

  const reviewCases = buildPortalCases(doctorId, reviewStatuses, 6, lang);
  const inReviewTotal = countPortalCasesByStatuses(doctorId, reviewStatuses);
  const completedCases = buildPortalCases(doctorId, completedStatuses, 6, lang);
  const completedTotal = countPortalCasesByStatuses(doctorId, completedStatuses);
  if (process.env.DEBUG_DASHBOARD_SLA === '1') {
    const reviewTotal = inReviewTotal;
    const reviewWithSlaObject = reviewCases.filter((c) => c && c.sla && typeof c.sla === 'object').length;
    const reviewWithNumericSla = reviewCases.filter((c) => hasNumericSlaWindow(c && c.sla)).length;
    const reviewSample = reviewCases.slice(0, 3).map((c) => ({
      id: c && c.id,
      status: c && c.status,
      minutesRemaining: c && c.sla ? c.sla.minutesRemaining : undefined,
      minutesOverdue: c && c.sla ? c.sla.minutesOverdue : undefined,
      isBreached: Boolean(c && c.sla && c.sla.isBreached)
    }));
    // Temporary diagnostic for SLA alert readiness coverage.
    // eslint-disable-next-line no-console
    console.log(
      `[doctor.dashboard.sla] review_total=${reviewTotal} review_with_sla=${reviewWithSlaObject} review_with_numeric_sla=${reviewWithNumericSla}`
    );
    // eslint-disable-next-line no-console
    console.log('[doctor.dashboard.sla.sample]', reviewSample);
  }
  const alerts = doctorId
    ? buildDashboardAlerts({
        doctorId,
        lang,
        assignedCases: assignedPendingMapped,
        reviewCases,
        completedCases
      })
    : [];

  const payload = {
    brand: 'Tashkheesa',
    user: req.user,
    lang,
    isAr,
    activeTab: 'dashboard',
    nextPath: '/portal/doctor/dashboard',
    newCases,
    newCasesTotal,
    reviewCases,
    inReviewTotal,
    availableCases: newCases,
    activeCases: reviewCases,
    inReviewCases: reviewCases,
    completedCases,
    completedTotal,
    alerts: Array.isArray(alerts) ? alerts : [],
    notifications: buildPortalNotifications(newCases, reviewCases, lang)
  };

  try {
    assertRenderableView('portal_doctor_dashboard');
    return res.render('portal_doctor_dashboard', payload);
  } catch (_) {
    // Safe fallback (never 404)
    return res.status(200).send(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Doctor Dashboard</title>
          <link rel="stylesheet" href="/styles.css" />
        </head>
        <body>
          <div class="container" style="max-width:900px;margin:32px auto;">
            <h1>Doctor Dashboard</h1>
            <p>New cases: ${newCasesTotal}</p>
            <p>Cases in review: ${inReviewTotal}</p>
            <p>Completed cases: ${completedTotal}</p>
            <p><a href="/portal/doctor/profile">Profile</a></p>
          </div>
        </body>
      </html>
    `);
  }
});

// Doctor queue list (filterable, paginated)
router.get('/portal/doctor/queue', requireDoctor, (req, res) => {
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';
  const doctorId = req.user && req.user.id ? String(req.user.id) : '';
  const doctorSpecialtyId = req.user && req.user.specialty_id ? String(req.user.specialty_id) : '';

  const bucket = normalizeQueueBucket(req.query.bucket, 'review');
  const q = normalizeTextQuery(req.query.q);
  const page = parsePositiveInt(req.query.page, 1);
  const limit = parsePositiveInt(req.query.limit, 20, 100);
  const offset = (page - 1) * limit;

  const newBucketTotal = countQueueNewCases(doctorId, doctorSpecialtyId, UNACCEPTED_STATUSES, '');
  const reviewBucketTotal = countPortalCasesByStatuses(doctorId, ACCEPTED_STATUSES, '');

  const cases = bucket === 'new'
    ? buildQueueNewCasesPaged(doctorId, doctorSpecialtyId, UNACCEPTED_STATUSES, limit, offset, lang, q)
    : buildPortalCasesPaged(doctorId, ACCEPTED_STATUSES, limit, offset, lang, q);
  const total = bucket === 'new'
    ? countQueueNewCases(doctorId, doctorSpecialtyId, UNACCEPTED_STATUSES, q)
    : countPortalCasesByStatuses(doctorId, ACCEPTED_STATUSES, q);

  const showingFrom = total > 0 ? offset + 1 : 0;
  const showingTo = total > 0 ? Math.min(offset + cases.length, total) : 0;
  const hasMore = (offset + cases.length) < total;

  return res.render('portal_doctor_queue', {
    brand: 'Tashkheesa',
    user: req.user,
    lang,
    isAr,
    activeTab: 'queue',
    nextPath: '/portal/doctor/queue',
    bucket,
    q,
    page,
    limit,
    total,
    showingFrom,
    showingTo,
    hasMore,
    newBucketTotal,
    reviewBucketTotal,
    cases: Array.isArray(cases) ? cases : []
  });
});

// Doctor completed list (paginated)
router.get('/portal/doctor/completed', requireDoctor, (req, res) => {
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';
  const doctorId = req.user && req.user.id ? String(req.user.id) : '';

  const q = normalizeTextQuery(req.query.q);
  const page = parsePositiveInt(req.query.page, 1);
  const limit = parsePositiveInt(req.query.limit, 20, 100);
  const offset = (page - 1) * limit;

  const completedStatuses = ['completed'];
  const cases = buildPortalCasesPaged(doctorId, completedStatuses, limit, offset, lang, q);
  const total = countPortalCasesByStatuses(doctorId, completedStatuses, q);
  const showingFrom = total > 0 ? offset + 1 : 0;
  const showingTo = total > 0 ? Math.min(offset + cases.length, total) : 0;
  const hasMore = (offset + cases.length) < total;

  return res.render('portal_doctor_completed', {
    brand: 'Tashkheesa',
    user: req.user,
    lang,
    isAr,
    activeTab: 'completed',
    nextPath: '/portal/doctor/completed',
    q,
    page,
    limit,
    total,
    showingFrom,
    showingTo,
    hasMore,
    cases: Array.isArray(cases) ? cases : []
  });
});

// Always provide defaults so views can safely render the alert badge.
// `alertsUnseenCount` is the shared variable used by nav templates across roles.
router.use((req, res, next) => {
  res.locals.doctorAlertCount = 0;
  res.locals.alertsUnseenCount = 0;
  res.locals.unseenAlertsCount = 0;
  res.locals.hasUnseenAlerts = false;
  return next();
});

// Doctor alert badge count middleware (only for doctor routes)
router.use(['/portal/doctor', '/doctor'], requireDoctor, (req, res, next) => {
  try {
    const uid = (req.user && req.user.id) ? String(req.user.id) : '';
    const uemail = (req.user && req.user.email) ? String(req.user.email).trim() : '';
    const cols = getNotificationTableColumns();
    const hasUserId = cols.includes('user_id');
    const hasToUserId = cols.includes('to_user_id');
    const hasIsRead = cols.includes('is_read');

    // If we can, count unread across both schemas.
    if (uid && hasIsRead && (hasUserId || hasToUserId)) {
      const where = [];
      const params = [];
      if (hasUserId) {
        where.push('user_id = ?');
        params.push(uid);
      }
      if (hasToUserId) {
        where.push('to_user_id = ?');
        params.push(uid);
        // Legacy rows may target the doctor's email instead of id
        if (uemail) {
          where.push('to_user_id = ?');
          params.push(uemail);
        }
      }

      const row = db
        .prepare(
          `SELECT COUNT(*) as c FROM notifications WHERE (${where.join(' OR ')}) AND COALESCE(is_read, 0) = 0`
        )
        .get(...params);

      const count = row ? Number(row.c) : 0;
      res.locals.doctorAlertCount = count;
      res.locals.alertsUnseenCount = count;
      res.locals.unseenAlertsCount = count;
      res.locals.hasUnseenAlerts = count > 0;
      return next();
    }

    // Force legacy fallback when new-schema columns aren't available.
    throw new Error('legacy_notifications_schema');
  } catch (e) {
    try {
      // Legacy schema fallback
      const uid = (req.user && req.user.id) ? String(req.user.id) : '';
      const uemail = (req.user && req.user.email) ? String(req.user.email).trim() : '';
      const row = db
        .prepare(
          "SELECT COUNT(*) as c FROM notifications WHERE (to_user_id = ? OR to_user_id = ?) AND COALESCE(LOWER(status), '') NOT IN ('seen','read')"
        )
        .get(uid, uemail);
      const count = row ? Number(row.c) : 0;
      res.locals.doctorAlertCount = count;
      res.locals.alertsUnseenCount = count;
      res.locals.unseenAlertsCount = count;
      res.locals.hasUnseenAlerts = count > 0;
    } catch (_) {
      res.locals.doctorAlertCount = 0;
      res.locals.alertsUnseenCount = 0;
      res.locals.unseenAlertsCount = 0;
      res.locals.hasUnseenAlerts = false;
    }
    return next();
  }
});

// ---- Doctor alerts (in-app notifications) ----

function getNotificationTableColumns() {
  try {
    const cols = db.prepare("PRAGMA table_info('notifications')").all();
    return Array.isArray(cols) ? cols.map((c) => c.name) : [];
  } catch (_) {
    return [];
  }
}

function pickNotificationUserColumn(cols) {
  const c = cols || [];
  if (c.includes('user_id')) return 'user_id';
  if (c.includes('to_user_id')) return 'to_user_id';
  return null;
}

function pickNotificationReadColumn(cols) {
  const c = cols || [];
  if (c.includes('is_read')) return 'is_read';
  return null;
}

function pickNotificationTimestampColumn(cols) {
  const c = cols || [];
  if (c.includes('at')) return 'at';
  if (c.includes('created_at')) return 'created_at';
  if (c.includes('timestamp')) return 'timestamp';
  return null;
}

function fetchDoctorNotifications(userId, userEmail = '', limit = 50) {
  const cols = getNotificationTableColumns();
  const tsCol = pickNotificationTimestampColumn(cols);
  if (!tsCol) return [];

  const hasUserId = cols.includes('user_id');
  const hasToUserId = cols.includes('to_user_id');
  if (!hasUserId && !hasToUserId) return [];

  const where = [];
  const params = [];
  if (hasUserId) {
    where.push('user_id = ?');
    params.push(String(userId));
  }
  if (hasToUserId) {
    where.push('to_user_id = ?');
    params.push(String(userId));
    const email = String(userEmail || '').trim();
    if (email) {
      where.push('to_user_id = ?');
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

  const sql = `SELECT ${selectCols.join(', ')} FROM notifications WHERE (${where.join(' OR ')}) ORDER BY ${tsCol} DESC, rowid DESC LIMIT ?`;
  try {
    return db.prepare(sql).all(...params, Number(limit));
  } catch (_) {
    return [];
  }
}

function normalizeDoctorNotification(row) {
  const id = row && row.id != null ? String(row.id) : '';
  const orderId = row && row.order_id != null ? String(row.order_id) : '';
  const template = row && row.template != null ? String(row.template) : '';
  const rawStatus = row && row.status != null ? String(row.status) : '';
  const isReadVal = row && row.is_read != null ? Number(row.is_read) : null;

  // Display status: prefer is_read when available; otherwise normalize legacy status.
  const status = (isReadVal === 1)
    ? 'seen'
    : (String(rawStatus || '').toLowerCase() === 'read')
      ? 'seen'
      : (rawStatus && rawStatus.trim())
        ? rawStatus
        : 'queued';
  const response = row && row.response != null ? String(row.response) : '';
  const at = row && (row.at || row.created_at || row.timestamp) ? String(row.at || row.created_at || row.timestamp) : '';

  // Best-effort message: prefer response, then template, otherwise a safe default.
  const message = (response && response.trim())
    ? response
    : (template && template.trim())
      ? template
      : 'Notification';

  const titles = getDoctorNotificationTitles(template);

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
    href: orderId ? `/portal/doctor/case/${orderId}` : ''
  };
}

function getDoctorNotificationTitles(template) {
  return getNotificationTitles(template);
}

function markDoctorNotificationRead(userId, userEmail, notificationId) {
  const cols = getNotificationTableColumns();
  const hasUserId = cols.includes('user_id');
  const hasToUserId = cols.includes('to_user_id');
  if (!hasUserId && !hasToUserId) return { ok: false, reason: 'no_user_column' };

  const where = [];
  const params = [];
  if (hasUserId) {
    where.push('user_id = ?');
    params.push(String(userId));
  }
  if (hasToUserId) {
    where.push('to_user_id = ?');
    params.push(String(userId));
    const email = String(userEmail || '').trim();
    if (email) {
      where.push('to_user_id = ?');
      params.push(email);
    }
  }
  const ownerClause = `(${where.join(' OR ')})`;

  // New schema
  if (cols.includes('is_read')) {
    try {
      const r = db
        .prepare(`UPDATE notifications SET is_read = 1${cols.includes('status') ? ", status = 'seen'" : ''} WHERE id = ? AND ${ownerClause}`)
        .run(String(notificationId), ...params);
      return { ok: !!(r && r.changes), mode: 'is_read' };
    } catch (_) {
      return { ok: false, reason: 'update_failed' };
    }
  }

  // Legacy schema: flip status to 'read'
  if (cols.includes('status')) {
    try {
      const r = db
        .prepare(`UPDATE notifications SET status = 'seen' WHERE id = ? AND ${ownerClause}`)
        .run(String(notificationId), ...params);
      return { ok: !!(r && r.changes), mode: 'status' };
    } catch (_) {
      return { ok: false, reason: 'update_failed' };
    }
  }

  return { ok: false, reason: 'no_read_mechanism' };
}

function markAllDoctorNotificationsRead(userId, userEmail = '') {
  const cols = getNotificationTableColumns();
  const hasUserId = cols.includes('user_id');
  const hasToUserId = cols.includes('to_user_id');
  if (!hasUserId && !hasToUserId) return { ok: false, reason: 'no_user_column' };

  const where = [];
  const params = [];
  if (hasUserId) {
    where.push('user_id = ?');
    params.push(String(userId));
  }
  if (hasToUserId) {
    where.push('to_user_id = ?');
    params.push(String(userId));
    const email = String(userEmail || '').trim();
    if (email) {
      where.push('to_user_id = ?');
      params.push(email);
    }
  }
  const ownerClause = `(${where.join(' OR ')})`;

  // New schema
  if (cols.includes('is_read')) {
    try {
      const r = db
        .prepare(`UPDATE notifications SET is_read = 1${cols.includes('status') ? ", status = 'seen'" : ''} WHERE ${ownerClause} AND COALESCE(is_read, 0) = 0`)
        .run(...params);
      return { ok: true, mode: 'is_read', changes: (r && r.changes) ? r.changes : 0 };
    } catch (_) {
      return { ok: false, reason: 'update_failed' };
    }
  }

  // Legacy schema
  if (cols.includes('status')) {
    try {
      const r = db
        .prepare(`UPDATE notifications SET status = 'seen' WHERE ${ownerClause} AND COALESCE(LOWER(status), '') NOT IN ('seen','read')`)
        .run(...params);
      return { ok: true, mode: 'status', changes: (r && r.changes) ? r.changes : 0 };
    } catch (_) {
      return { ok: false, reason: 'update_failed' };
    }
  }

  return { ok: false, reason: 'no_read_mechanism' };
}

// Alerts inbox
router.get('/portal/doctor/alerts', requireDoctor, (req, res) => {
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';
  const userId = req.user && req.user.id ? String(req.user.id) : '';
  const userEmail = req.user && req.user.email ? String(req.user.email).trim() : '';

  const raw = fetchDoctorNotifications(userId, userEmail, 50);
  const alerts = (raw || []).map(normalizeDoctorNotification);

  // Mark as seen AFTER fetching for display.
  try {
    if (userId) {
      markAllDoctorNotificationsRead(userId, userEmail);
      res.locals.doctorAlertCount = 0;
      res.locals.alertsUnseenCount = 0;
      res.locals.unseenAlertsCount = 0;
      res.locals.hasUnseenAlerts = false;
      alerts.forEach((a) => {
        if (a && a.status && String(a.status).toLowerCase() !== 'seen') a.status = 'seen';
      });
    }
  } catch (_) {
    // non-blocking
  }

  const payload = {
    brand: 'Tashkheesa',
    user: req.user,
    lang,
    isAr,
    activeTab: 'alerts',
    nextPath: '/portal/doctor/alerts',
    alerts: Array.isArray(alerts) ? alerts : [],
    notifications: Array.isArray(alerts) ? alerts : []
  };

  // Try common template names; fall back to a simple HTML page if none exist.
  const candidates = ['portal_doctor_alerts', 'portal_doctor_alert', 'doctor_alerts', 'doctor_alert'];
  for (const viewName of candidates) {
    try {
      assertRenderableView(viewName);
      return res.render(viewName, payload);
    } catch (_) {
      // keep trying
    }
  }

  const title = isAr ? 'التنبيهات' : 'Alerts';
  const empty = isAr ? 'لا توجد تنبيهات حالياً.' : 'No alerts yet.';
  const rows = alerts.length
    ? alerts
        .map((a) => {
          const when = a.at ? ` — ${formatDisplayDate(a.at)}` : '';
          const link = a.href ? `<a href="${a.href}">${isAr ? 'فتح الحالة' : 'Open case'}</a>` : '';
          return `<li style="margin:8px 0;">${escapeHtml(a.message)}${when} ${link}</li>`;
        })
        .join('')
    : `<li>${empty}</li>`;

  return res.status(200).send(`<!doctype html>
  <html lang="${isAr ? 'ar' : 'en'}">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${title} — Tashkheesa</title>
      <link rel="stylesheet" href="/styles.css" />
    </head>
    <body>
      <div class="container" style="max-width: 900px; margin: 32px auto;">
        <h1 style="margin-bottom: 16px;">${title}</h1>
        <div class="card" style="padding: 16px;">
          <ul style="margin:0; padding-left: 18px;">${rows}</ul>
          <div style="margin-top:16px;"><a href="/portal/doctor">${isAr ? 'العودة للوحة الطبيب' : 'Back to Doctor Dashboard'}</a></div>
        </div>
      </div>
    </body>
  </html>`);
});

// Mark a notification as read (optional endpoint; UI can call it later)
router.post('/portal/doctor/alerts/:id/read', requireDoctor, (req, res) => {
  const userId = req.user && req.user.id ? String(req.user.id) : '';
  const id = req.params && req.params.id ? String(req.params.id) : '';
  if (!id) return res.status(400).json({ ok: false, reason: 'missing_id' });
  const userEmail = req.user && req.user.email ? String(req.user.email).trim() : '';
  const r = markDoctorNotificationRead(userId, userEmail, id);
  return res.status(r.ok ? 200 : 400).json(r);
});

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ---- end doctor alerts ----

// ---- Portal doctor case view ----
router.get('/portal/doctor/case/:caseId', requireDoctor, (req, res) => {
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';
  const orderId = String(req.params.caseId || '');
  const msg = (req.query && req.query.msg) ? String(req.query.msg) : '';
  const capacityMessage = msg === 'capacity'
    ? (isAr
        ? 'لقد وصلت للحد الأقصى للحالات النشطة (4). أكمل حالاتك أولاً ثم حاول مرة أخرى.'
        : 'Active case limit reached (4). Complete cases first, then try accepting again.')
    : null;
  // Guardrail: never render or redirect with an undefined case id.
  if (!orderId) return res.redirect('/portal/doctor/dashboard');

  const rawOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  // Fetch order files for doctor view
  let files = [];
  try {
    const urlCol = getOrderFilesUrlColumnName();
    const labelCol = getOrderFilesLabelColumnName();
    const atCol = getOrderFilesCreatedAtColumnName();

    if (urlCol) {
      const rows = db.prepare(
        `SELECT ${urlCol} AS url, ${labelCol || urlCol} AS name
         FROM order_files
         WHERE order_id = ?
         ORDER BY ${atCol || 'rowid'} ASC`
      ).all(orderId);

      files = (rows || []).map(r => ({
        url: r.url,
        name: r.name || 'Uploaded file'
      }));
    }
  } catch (e) {
    files = [];
  }
  // Access/visibility guard
  const doctorId = req.user && req.user.id ? String(req.user.id) : '';
  const assignedDoctorId = rawOrder && rawOrder.doctor_id ? String(rawOrder.doctor_id) : '';
  const normalizedStatus = String(rawOrder && rawOrder.status || '').toLowerCase();
  const paymentStatus = String(rawOrder && rawOrder.payment_status || '').toLowerCase();
  const isPaid = paymentStatus === 'paid' || paymentStatus === 'captured';
  const isCompleted = normalizedStatus === 'completed';
  const isUnaccepted = UNACCEPTED_STATUSES.includes(normalizedStatus);
  const isAcceptedStatus = ACCEPTED_STATUSES.includes(normalizedStatus);
  // Guardrail: only the accepting doctor can view full details.
  const isAcceptedByThisDoctor = (isAcceptedStatus || isCompleted) && assignedDoctorId && assignedDoctorId === doctorId;
  const isAssignedToOtherDoctor = assignedDoctorId && assignedDoctorId !== doctorId;

  // Defensive: always strip pricing fields
  const order = stripPricingFields(rawOrder);
  if (!order) {
    return res.status(404).render('404', {
      message: 'Case not found'
    });
  }

  // If assigned to another doctor, deny access
  if (isAssignedToOtherDoctor) {
    try {
      assertRenderableView('portal_doctor_case');
      return res.status(403).render('portal_doctor_case', {
        brand: 'Tashkheesa',
        user: req.user,
        lang,
        isAr,
        order: null,
        blurred: false,
        canViewDetails: false,
        accessDenied: true,
        reason: 'assigned_to_other_doctor',
        activeTab: 'cases',
        nextPath: `/portal/doctor/case/${orderId}`,
        acceptActionUrl: `/portal/doctor/case/${orderId}/accept`
      });
    } catch (_) {
      return res.status(403).send(`
        <!doctype html>
        <html>
          <head>
            <meta charset="utf-8" />
            <title>Access Denied</title>
            <link rel="stylesheet" href="/styles.css" />
          </head>
          <body>
            <div class="container" style="max-width:900px;margin:32px auto;">
              <h1>Access Denied</h1>
              <p>This case is assigned to another doctor.</p>
              <p><a href="/portal/doctor">Back to dashboard</a></p>
            </div>
          </body>
        </html>
      `);
    }
  }

  // Accept eligibility logic
const canAccept =
  isPaid &&
  isUnaccepted &&
  (!assignedDoctorId || assignedDoctorId === doctorId);
  const acceptBlockedReason = !isPaid
    ? 'This case has not been paid for yet. Acceptance will be enabled once payment is completed.'
    : null;

  const queryReportUrl = (req.query && req.query.reportUrl) ? String(req.query.reportUrl) : '';
  const reportUrl = queryReportUrl || readReportUrlFromOrder(order);
  const reportAvailable = isReportUrlAvailable(reportUrl);
  const reportMissingMessage =
    isCompleted && !reportAvailable
      ? (isAr ? 'التقرير غير متوفر بعد.' : 'Report not available yet.')
      : null;

  const viewStatus = isUnaccepted ? normalizedStatus : 'in_review';
  const viewReportUrl = reportAvailable ? reportUrl : null;

  // IMPORTANT: When a case is unaccepted we still pass a minimal `order` object
  // so the template can read `order.payment_status` without leaking case details.
  const viewOrder = isUnaccepted
    ? {
        id: orderId,
        status: viewStatus,
        payment_status: paymentStatus || null
      }
    : {
        ...order,
        status: viewStatus,
        report_url: viewReportUrl || null,
        reportUrl: viewReportUrl || null
      };

  let viewQuery = null;
  if (isCompleted) {
    viewQuery = { ...(req.query || {}) };
    if (!viewQuery.report) viewQuery.report = 'locked';
    if (!reportAvailable && viewQuery.reportUrl) delete viewQuery.reportUrl;
  }

  // Load annotations for this case's files
  let annotatedFiles = [];
  try {
    annotatedFiles = db.prepare(`
      SELECT ca.id, ca.image_id AS imageId, ca.doctor_id AS doctorId,
             ca.annotations_count AS annotationsCount,
             ca.created_at AS createdAt, ca.updated_at AS updatedAt,
             u.name AS doctorName
      FROM case_annotations ca
      LEFT JOIN users u ON u.id = ca.doctor_id
      WHERE ca.case_id = ?
      ORDER BY ca.updated_at DESC
    `).all(orderId);
  } catch (_annErr) {
    annotatedFiles = [];
  }

  // Lookup conversation for "Message Patient" button
  var caseConversationId = null;
  try {
    var convo = db.prepare(
      'SELECT id FROM conversations WHERE order_id = ? AND doctor_id = ? LIMIT 1'
    ).get(orderId, doctorId);
    if (convo) caseConversationId = convo.id;
  } catch (_) {}

  // Load AI image quality checks for this case
  var fileAiChecks = {};
  try {
    var checks = db.prepare(
      'SELECT file_id, is_medical_image, image_quality, quality_issues, detected_scan_type, matches_expected, confidence, recommendation FROM file_ai_checks WHERE order_id = ?'
    ).all(orderId);
    (checks || []).forEach(function(c) {
      if (c.file_id) fileAiChecks[c.file_id] = c;
    });
  } catch (_) {}

  const payload = {
    brand: 'Tashkheesa',
    user: req.user,
    lang,
    isAr,
    order: viewOrder,
    files,
    annotatedFiles,
    blurred: isUnaccepted,
    canViewDetails: isAcceptedByThisDoctor,
    accessDenied: false,
    activeTab: 'cases',
    nextPath: `/portal/doctor/case/${orderId}`,
    acceptActionUrl: `/portal/doctor/case/${orderId}/accept`,
    showAcceptButton: canAccept,
    acceptBlockedReason,
    isPaid,
    caseConversationId,
    fileAiChecks,
    ...(reportMissingMessage ? { errorMessage: reportMissingMessage } : {}),
    ...(viewQuery ? { query: viewQuery } : {}),
    ...(capacityMessage ? { errorMessage: capacityMessage } : {}),
  };

  // Try canonical template name first
  try {
    assertRenderableView('portal_doctor_case');
    return res.render('portal_doctor_case', payload);
  } catch (_) {
    // Fallback: minimal safe rendering to avoid 404 loops
    return res.status(200).send(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Case ${orderId}</title>
          <link rel="stylesheet" href="/styles.css" />
        </head>
        <body>
          <div class="container" style="max-width:900px;margin:32px auto;">
            <h1>Case ${orderId}</h1>
            <p>Status: ${order.status || '—'}</p>
            <p><a href="/portal/doctor">Back to dashboard</a></p>
          </div>
        </body>
      </html>
    `);
  }
});
// ---- end portal doctor case view ----

// ---- Portal doctor accept case ----
router.post('/portal/doctor/case/:caseId/accept', requireDoctor, async (req, res) => {
  const orderId = String(req.params.caseId || '');
  const doctorId = req.user && req.user.id ? String(req.user.id) : '';

  if (!orderId || !doctorId) {
    // Guardrail: never redirect or render with a missing case id.
    return res.redirect('/portal/doctor/dashboard');
  }

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) {
    // Guardrail: missing case should safely return to dashboard.
    return res.redirect('/portal/doctor/dashboard');
  }

  const normalizedStatus = String(order.status || '').toLowerCase();
  const assignedDoctorId = order.doctor_id ? String(order.doctor_id) : '';
  const inReviewStatuses = ACCEPTED_STATUSES;

  // Guardrail: Only allow if paid
  const paymentStatus = String(order.payment_status || '').toLowerCase();
  const isPaid = paymentStatus === 'paid' || paymentStatus === 'captured';
  if (!isPaid) {
    return res.redirect(`/portal/doctor/case/${orderId}`);
  }

  // Guardrail 1: Idempotency — if already accepted by THIS doctor, just return safely
  if (inReviewStatuses.includes(normalizedStatus) && assignedDoctorId === doctorId) {
    return res.redirect('/portal/doctor/dashboard');
  }

  // Guardrail 2: Prevent stealing or double-accept
  if (assignedDoctorId && assignedDoctorId !== doctorId) {
    // Guardrail: never allow accepting cases assigned to another doctor.
    return res.redirect(`/portal/doctor/case/${orderId}`);
  }

  // Guardrail 3: Only allow canonical new/submitted states
  if (!UNACCEPTED_STATUSES.includes(normalizedStatus)) {
    // Guardrail: accept flow only applies to new/submitted cases.
    return res.redirect(`/portal/doctor/case/${orderId}`);
  }

  // Guardrail 4: Doctor capacity (max active cases)
  const activeCount = countActiveCasesForDoctor(doctorId);

  if (activeCount >= MAX_ACTIVE_CASES) {
    const nextDoctor = findNextAvailableDoctor(order.specialty_id, doctorId);

    if (nextDoctor && nextDoctor.id) {
      db.prepare(`
        UPDATE orders
        SET doctor_id = ?, updated_at = ?
        WHERE id = ?
      `).run(
        nextDoctor.id,
        new Date().toISOString(),
        orderId
      );

      try {
        logOrderEvent(orderId, 'case_auto_reassigned_capacity', {
          from_doctor: doctorId,
          to_doctor: nextDoctor.id
        });
      } catch (_) {}

      return res.redirect('/portal/doctor/dashboard');
    }

    // No available doctor → block acceptance (show a clear message)
    return res.redirect(`/portal/doctor/case/${orderId}?msg=capacity`);
  }

  // Canonical state transition — single source of truth
  const nowIso = new Date().toISOString();

  const result = db.prepare(
    `UPDATE orders
     SET doctor_id = ?,
         accepted_at = COALESCE(accepted_at, ?),
         status = 'in_review',
         updated_at = ?
     WHERE id = ?
       AND (doctor_id IS NULL OR doctor_id = '' OR doctor_id = ?)
       AND LOWER(COALESCE(status, '')) IN ('new','submitted','paid','assigned','accepted')`
  ).run(doctorId, nowIso, nowIso, orderId, doctorId);

  // If nothing was updated, do NOT let the case disappear
  if (!result || result.changes === 0) {
    return res.redirect(`/portal/doctor/case/${orderId}`);
  }

  // SLA model: deadline starts at acceptance.
  // Acceptance may happen long after payment; ensure deadline_at is derived from accepted_at.
  try {
    db.prepare(
      `UPDATE orders
       SET deadline_at =
         replace(
           datetime(
             replace(substr(accepted_at, 1, 19), 'T', ' '),
             printf('+%d hours', sla_hours)
           ),
           ' ',
           'T'
         ) || 'Z'
       WHERE id = ?
         AND accepted_at IS NOT NULL
         AND sla_hours IS NOT NULL
         AND (deadline_at IS NULL OR deadline_at = '')`
    ).run(orderId);
  } catch (_) {
    // non-blocking: never prevent acceptance due to deadline computation
  }

  try {
    logOrderEvent(orderId, 'doctor_accepted_case', { doctor_id: doctorId });
  } catch (_) {}

  try {
    recalcSlaBreaches(orderId);
  } catch (_) {}

  // Auto-create messaging conversation for this case (Phase 6)
  try {
    var freshOrderForConv = db.prepare('SELECT patient_id FROM orders WHERE id = ?').get(orderId);
    if (freshOrderForConv && freshOrderForConv.patient_id) {
      ensureConversation(orderId, freshOrderForConv.patient_id, doctorId);
    }
  } catch (_) {}

  // Notify patient: case accepted by doctor (multi-channel)
  try {
    const freshOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (freshOrder && freshOrder.patient_id) {
      queueMultiChannelNotification({
        orderId,
        toUserId: freshOrder.patient_id,
        channels: ['internal', 'email', 'whatsapp'],
        template: 'order_status_accepted_patient',
        response: {
          case_id: orderId,
          caseReference: orderId.slice(0, 12).toUpperCase(),
          doctorName: req.user.name || ''
        },
        dedupe_key: 'order_accepted:' + orderId + ':patient'
      });
    }
  } catch (_) {
    // Never block acceptance on messaging failures
  }

  // Always land back on dashboard (never 404, never JSON by default)
  return res.redirect('/portal/doctor/dashboard');
});
// ---- end accept case ----

function resolvePatientPhoneFromOrder(order) {
  if (!order) return '';

  // 1) Direct order fields (schema may vary)
  const directCandidates = [
    order.patient_phone,
    order.phone,
    order.phone_number,
    order.mobile,
    order.mobile_number,
    order.patient_mobile
  ];
  for (const c of directCandidates) {
    const v = String(c || '').trim();
    if (v) return v;
  }

  // 2) Join to users table if we have a patient/user id
  const patientId = String(order.user_id || order.patient_id || order.customer_id || '').trim();
  if (patientId) {
    try {
      const row = db
        .prepare(
          `SELECT
             COALESCE(phone, phone_number, mobile, mobile_number, whatsapp, whatsapp_number, '') AS phone
           FROM users
           WHERE id = ?
           LIMIT 1`
        )
        .get(patientId);
      const v = row && row.phone ? String(row.phone).trim() : '';
      if (v) return v;
    } catch (_) {
      // ignore (users table/columns may not exist in some snapshots)
    }
  }

  return '';
}

// ---- Portal doctor report routes (Generate PDF) ----
// GET is a safe redirect so direct navigation never shows a 404.
router.get('/portal/doctor/case/:caseId/report', requireDoctor, (req, res) => {
  const orderId = req.params.caseId;
  return res.redirect(`/portal/doctor/case/${orderId}`);
});

// POST generates the PDF report and marks the case completed.
router.post('/portal/doctor/case/:caseId/report', requireDoctor, handlePortalDoctorGenerateReport);
// ---- end portal report routes ----

// ---- Portal doctor profile route ----
// Keep this route defensive: if the view doesn't exist yet, fall back to a simple HTML page
// so the header link never 404s or crashes in dev.
router.get('/portal/doctor/profile', requireDoctor, (req, res) => {
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';
  const payload = {
    brand: 'Tashkheesa',
    user: req.user,
    lang,
    isAr,
    activeTab: 'profile',
    nextPath: '/portal/doctor/profile'
  };

  try {
    // If you later add `src/views/portal_doctor_profile.ejs`, this will render it.
    assertRenderableView('portal_doctor_profile');
    return res.render('portal_doctor_profile', payload);
  } catch (_) {
    // Fallback (no template yet): still give the doctor a working profile page.
    const name = (req.user && (req.user.display_name || req.user.name || req.user.full_name || req.user.email)) || '—';
    const email = (req.user && req.user.email) || '—';
    const specialty = (req.user && (req.user.specialty_name || req.user.specialty || req.user.specialty_id)) || '—';

    return res.status(200).send(`
      <!doctype html>
      <html lang="${isAr ? 'ar' : 'en'}">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>${isAr ? 'الملف الشخصي' : 'My Profile'} — Tashkheesa</title>
          <link rel="stylesheet" href="/styles.css" />
        </head>
        <body>
          <div class="container" style="max-width: 900px; margin: 32px auto;">
            <h1 style="margin-bottom: 16px;">${isAr ? 'الملف الشخصي' : 'My Profile'}</h1>
            <div class="card" style="padding: 16px;">
              <p><strong>${isAr ? 'الاسم' : 'Name'}:</strong> ${String(name)}</p>
              <p><strong>${isAr ? 'البريد الإلكتروني' : 'Email'}:</strong> ${String(email)}</p>
              <p><strong>${isAr ? 'التخصص' : 'Specialty'}:</strong> ${String(specialty)}</p>
              <p style="margin-top: 16px;"><a href="/portal/doctor">${isAr ? 'العودة للوحة الطبيب' : 'Back to Doctor Dashboard'}</a></p>
            </div>
          </div>
        </body>
      </html>
    `);
  }
});
// ---- end portal profile route ----

// ---- Language helpers ----
function getLang(req, res) {
  const l =
    (res && res.locals && res.locals.lang) ||
    (req && req.query && req.query.lang) ||
    (req && req.user && req.user.lang) ||
    'en';
  return String(l).toLowerCase() === 'ar' ? 'ar' : 'en';
}

function t(lang, enText, arText) {
  return String(lang).toLowerCase() === 'ar' ? arText : enText;
}

function parsePositiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function normalizeTextQuery(value, maxLen = 120) {
  return String(value || '').trim().slice(0, maxLen);
}

function toLikeValue(q) {
  return q ? `%${q}%` : '';
}

function normalizeQueueBucket(value, fallback = 'review') {
  const bucket = String(value || '').trim().toLowerCase();
  if (bucket === 'new' || bucket === 'review') return bucket;
  return fallback;
}

function coerceSlaNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function normalizeSla(order, slaInput) {
  let base = (slaInput && typeof slaInput === 'object') ? slaInput : null;
  if (!base) {
    try {
      const computed = computeSla(order || {});
      base = (computed && computed.sla && typeof computed.sla === 'object') ? computed.sla : {};
    } catch (_) {
      base = {};
    }
  }

  const minutesRemaining = coerceSlaNumber(base.minutesRemaining);
  const minutesOverdue = coerceSlaNumber(base.minutesOverdue);
  return {
    ...base,
    minutesRemaining,
    minutesOverdue,
    isBreached: Boolean(base.isBreached) || (Number.isFinite(minutesOverdue) && minutesOverdue > 0)
  };
}

function hasNumericSlaWindow(sla) {
  if (!sla || typeof sla !== 'object') return false;
  const remaining = Number(sla.minutesRemaining);
  const overdue = Number(sla.minutesOverdue);
  return Number.isFinite(remaining) || Number.isFinite(overdue);
}

function mapPortalCaseItem(order, lang = 'en', extra = {}) {
  const safeOrder = stripPricingFields(order);
  const rawId = order && order.id != null ? order.id : '';
  const encodedId = rawId != null && String(rawId).trim()
    ? encodeURIComponent(String(rawId))
    : '';
  return {
    ...safeOrder,
    reference: order && order.id != null ? order.id : '',
    specialtyLabel: [order && order.specialty_name, order && order.service_name].filter(Boolean).join(' • ') || '—',
    statusLabel: humanStatusText(order && order.status, lang),
    slaLabel: formatSlaLabel(order, order && order.sla, lang),
    href: encodedId ? `/portal/doctor/case/${encodedId}` : '',
    ...extra
  };
}

function enrichOrders(rows) {
  return rows.map((row) => {
    enforceBreachIfNeeded(row);
    const computed = computeSla(row);
    return {
      ...row,
      db_status: row.status,
      status: computed.effectiveStatus || row.status,
      effectiveStatus: computed.effectiveStatus,
      sla: normalizeSla(row, computed.sla)
    };
  });
}

function humanStatusText(status, lang = 'en') {
  const normalized = (status || '').toLowerCase();
  const en = {
    new: 'New',
    submitted: 'New',
    accepted: 'Accepted',
    assigned: 'Assigned',
    review: 'In review',
    in_review: 'In review',
    completed: 'Completed',
    breached: 'Overdue',
    sla_breach: 'Overdue',
    awaiting_files: 'Awaiting files',
    rejected_files: 'Awaiting files',
    cancelled: 'Cancelled'
  };
  const ar = {
    new: 'جديدة',
    submitted: 'جديدة',
    accepted: 'مقبولة',
    assigned: 'تم التعيين',
    review: 'قيد المراجعة',
    in_review: 'قيد المراجعة',
    completed: 'مكتملة',
    breached: 'متأخرة',
    sla_breach: 'متأخرة',
    awaiting_files: 'بانتظار الملفات',
    rejected_files: 'بانتظار الملفات',
    cancelled: 'ملغاة'
  };

  const table = String(lang).toLowerCase() === 'ar' ? ar : en;
  return (
    table[normalized] ||
    (normalized ? normalized.replace(/_/g, ' ') : t(lang, 'Status', 'الحالة'))
  );
}

function formatSlaLabel(order, sla, lang = 'en') {
  if (!sla) return t(lang, 'SLA pending', 'بانتظار SLA');

  const minutesOverdue = Number(sla.minutesOverdue);
  if (sla.isBreached || (Number.isFinite(minutesOverdue) && minutesOverdue > 0)) {
    const overdueHours = Math.max(1, Math.ceil((Number.isFinite(minutesOverdue) ? minutesOverdue : 0) / 60));
    return t(lang, `Overdue by ${overdueHours}h`, `متأخر بـ ${overdueHours}س`);
  }

  const minutesRemaining = Number(sla.minutesRemaining);
  if (Number.isFinite(minutesRemaining)) {
    if (minutesRemaining <= 0) return t(lang, 'Due now', 'حان الموعد');
    if (minutesRemaining < 60) {
      return t(lang, `Due in ${minutesRemaining}m`, `بعد ${minutesRemaining}د`);
    }
    const hours = Math.max(1, Math.ceil(minutesRemaining / 60));
    return t(lang, `Due in ${hours}h`, `بعد ${hours}س`);
  }

  if (sla.isNew) return t(lang, 'Awaiting acceptance', 'بانتظار القبول');
  if (order) {
    const status = String(order.status || '').toLowerCase();
    if (status === 'completed') return t(lang, 'Completed', 'مكتملة');
  }
  return t(lang, 'Deadline pending', 'الموعد غير محدد');
}

function countAssignedPendingCases(doctorId, q = '') {
  const textQuery = normalizeTextQuery(q);
  const like = toLikeValue(textQuery);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM orders o
       WHERE o.doctor_id = ?
         AND COALESCE(o.accepted_at, '') = ''
         AND LOWER(COALESCE(o.status,'')) IN ('assigned','accepted')
         AND (? = '' OR CAST(o.id AS TEXT) LIKE ?)`
    )
    .get(doctorId, textQuery, like);
  return row ? Number(row.c) || 0 : 0;
}

function countPortalCasesUnassigned(doctorSpecialtyId, statuses, q = '') {
  if (!Array.isArray(statuses) || !statuses.length) return 0;
  const textQuery = normalizeTextQuery(q);
  const like = toLikeValue(textQuery);
  const normalizedStatuses = statuses.map((s) => String(s).toLowerCase());
  const placeholders = normalizedStatuses.map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM orders o
       WHERE (o.doctor_id IS NULL OR o.doctor_id = '')
         AND (? = '' OR o.specialty_id = ?)
         AND (
               LOWER(o.status) IN (${placeholders})
               OR (
                    LOWER(o.status) = 'paid'
                    AND LOWER(COALESCE(o.payment_status,'')) = 'paid'
                  )
             )
         AND (? = '' OR CAST(o.id AS TEXT) LIKE ?)`
    )
    .get(doctorSpecialtyId, doctorSpecialtyId, ...normalizedStatuses, textQuery, like);
  return row ? Number(row.c) || 0 : 0;
}

function countPortalCasesByStatuses(doctorId, statuses, q = '') {
  if (!Array.isArray(statuses) || !statuses.length) return 0;
  const textQuery = normalizeTextQuery(q);
  const like = toLikeValue(textQuery);
  const normalizedStatuses = statuses.map((s) => String(s).toLowerCase());
  const placeholders = normalizedStatuses.map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM orders o
       WHERE o.doctor_id = ?
         AND LOWER(o.status) IN (${placeholders})
         AND (? = '' OR CAST(o.id AS TEXT) LIKE ?)`
    )
    .get(doctorId, ...normalizedStatuses, textQuery, like);
  return row ? Number(row.c) || 0 : 0;
}

function buildPortalCasesUnassigned(doctorSpecialtyId, statuses, limit = 6, lang = 'en', q = '') {
  if (!Array.isArray(statuses) || !statuses.length) return [];
  const textQuery = normalizeTextQuery(q);
  const like = toLikeValue(textQuery);
  const normalizedStatuses = statuses.map((s) => String(s).toLowerCase());
  const placeholders = normalizedStatuses.map(() => '?').join(',');
  // IMPORTANT: statuses are normalized at READ time to handle legacy/mixed-case data
  const rows = db
    .prepare(
      `SELECT o.*,
             o.payment_status,
             s.name AS specialty_name,
             sv.name AS service_name
       FROM orders o
       LEFT JOIN specialties s ON o.specialty_id = s.id
       LEFT JOIN services sv ON o.service_id = sv.id
       WHERE (o.doctor_id IS NULL OR o.doctor_id = '')
         AND (? = '' OR o.specialty_id = ?)
         AND (
               LOWER(o.status) IN (${placeholders})
               OR (
                    LOWER(o.status) = 'paid'
                    AND LOWER(COALESCE(o.payment_status,'')) = 'paid'
                  )
             )
         AND (? = '' OR CAST(o.id AS TEXT) LIKE ?)
       ORDER BY datetime(COALESCE(o.updated_at, o.created_at)) DESC
       LIMIT ?`
    )
    .all(doctorSpecialtyId, doctorSpecialtyId, ...normalizedStatuses, textQuery, like, limit);

  const statusSet = new Set(normalizedStatuses);
  const enriched = enrichOrders(rows).filter((order) => {
    const key = String(order.db_status || order.status || '').toLowerCase();
    return statusSet.has(key);
  });

  return enriched.map((order) => {
    const isPaid = String(order.payment_status || '').toLowerCase() === 'paid';
    return mapPortalCaseItem(order, lang, { isPaid });
  });
}

function buildPortalCasesPaged(doctorId, statuses, limit = 20, offset = 0, lang = 'en', q = '') {
  if (!Array.isArray(statuses) || !statuses.length) return [];
  const textQuery = normalizeTextQuery(q);
  const like = toLikeValue(textQuery);
  const normalizedStatuses = statuses.map((s) => String(s).toLowerCase());
  const placeholders = normalizedStatuses.map(() => '?').join(',');
  // IMPORTANT: statuses are normalized at READ time to handle legacy/mixed-case data
  const rows = db
    .prepare(
      `SELECT o.*,
              s.name AS specialty_name,
              sv.name AS service_name
       FROM orders o
       LEFT JOIN specialties s ON o.specialty_id = s.id
       LEFT JOIN services sv ON o.service_id = sv.id
       WHERE o.doctor_id = ?
         AND LOWER(o.status) IN (${placeholders})
         AND (? = '' OR CAST(o.id AS TEXT) LIKE ?)
       ORDER BY datetime(COALESCE(o.updated_at, o.created_at)) DESC
       LIMIT ?
       OFFSET ?`
    )
    .all(doctorId, ...normalizedStatuses, textQuery, like, limit, offset);

  const statusSet = new Set(normalizedStatuses);
  const enriched = enrichOrders(rows).filter((order) => {
    const key = String(order.db_status || order.status || '').toLowerCase();
    return statusSet.has(key);
  });

  return enriched.map((order) => mapPortalCaseItem(order, lang));
}

function buildPortalCases(doctorId, statuses, limit = 6, lang = 'en') {
  return buildPortalCasesPaged(doctorId, statuses, limit, 0, lang, '');
}

function countQueueNewCases(doctorId, doctorSpecialtyId, statuses, q = '') {
  if (!Array.isArray(statuses) || !statuses.length) return 0;
  const normalizedStatuses = statuses.map((s) => String(s).toLowerCase());
  const placeholders = normalizedStatuses.map(() => '?').join(',');
  const textQuery = normalizeTextQuery(q);
  const like = toLikeValue(textQuery);

  const row = db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM (
         SELECT o.id
         FROM orders o
         WHERE o.doctor_id = ?
           AND COALESCE(o.accepted_at, '') = ''
           AND LOWER(COALESCE(o.status,'')) IN ('assigned','accepted')
           AND (? = '' OR CAST(o.id AS TEXT) LIKE ?)
         UNION ALL
         SELECT o.id
         FROM orders o
         WHERE (o.doctor_id IS NULL OR o.doctor_id = '')
           AND (? = '' OR o.specialty_id = ?)
           AND (
                 LOWER(o.status) IN (${placeholders})
                 OR (
                      LOWER(o.status) = 'paid'
                      AND LOWER(COALESCE(o.payment_status,'')) = 'paid'
                    )
               )
           AND (? = '' OR CAST(o.id AS TEXT) LIKE ?)
       ) queue_new`
    )
    .get(
      doctorId,
      textQuery,
      like,
      doctorSpecialtyId,
      doctorSpecialtyId,
      ...normalizedStatuses,
      textQuery,
      like
    );

  return row ? Number(row.c) || 0 : 0;
}

function buildQueueNewCasesPaged(doctorId, doctorSpecialtyId, statuses, limit = 20, offset = 0, lang = 'en', q = '') {
  if (!Array.isArray(statuses) || !statuses.length) return [];
  const normalizedStatuses = statuses.map((s) => String(s).toLowerCase());
  const placeholders = normalizedStatuses.map(() => '?').join(',');
  const textQuery = normalizeTextQuery(q);
  const like = toLikeValue(textQuery);

  const rows = db
    .prepare(
      `SELECT queue_rows.*,
              s.name AS specialty_name,
              sv.name AS service_name
       FROM (
         SELECT o.*
         FROM orders o
         WHERE o.doctor_id = ?
           AND COALESCE(o.accepted_at, '') = ''
           AND LOWER(COALESCE(o.status,'')) IN ('assigned','accepted')
           AND (? = '' OR CAST(o.id AS TEXT) LIKE ?)
         UNION ALL
         SELECT o.*
         FROM orders o
         WHERE (o.doctor_id IS NULL OR o.doctor_id = '')
           AND (? = '' OR o.specialty_id = ?)
           AND (
                 LOWER(o.status) IN (${placeholders})
                 OR (
                      LOWER(o.status) = 'paid'
                      AND LOWER(COALESCE(o.payment_status,'')) = 'paid'
                    )
               )
           AND (? = '' OR CAST(o.id AS TEXT) LIKE ?)
       ) queue_rows
       LEFT JOIN specialties s ON queue_rows.specialty_id = s.id
       LEFT JOIN services sv ON queue_rows.service_id = sv.id
       ORDER BY datetime(COALESCE(queue_rows.updated_at, queue_rows.created_at)) DESC
       LIMIT ?
       OFFSET ?`
    )
    .all(
      doctorId,
      textQuery,
      like,
      doctorSpecialtyId,
      doctorSpecialtyId,
      ...normalizedStatuses,
      textQuery,
      like,
      limit,
      offset
    );

  return enrichOrders(rows).map((order) => {
    const ps = String(order.payment_status || '').toLowerCase();
    const isPaid = ps === 'paid' || ps === 'captured';
    return mapPortalCaseItem(order, lang, { isPaid });
  });
}

function buildPortalNotifications(newCases, reviewCases, lang = 'en') {
  const notifications = [];

  if (newCases && newCases.length) {
    const latest = newCases[0];
    notifications.push(
      t(
        lang,
        `You have a new case assigned (${latest.reference}). ${latest.slaLabel}.`,
        `لديك حالة جديدة (${latest.reference}). ${latest.slaLabel}.`
      )
    );
  } else {
    notifications.push(
      t(lang, 'No new assignments right now. Stay ready for incoming cases.', 'لا توجد حالات جديدة حالياً. كن مستعداً للحالات القادمة.')
    );
  }

  const urgent = (reviewCases || []).find(
    (c) => c.sla && typeof c.sla.minutesRemaining === 'number' && c.sla.minutesRemaining <= 6 * 60
  );
  if (urgent) {
    const hours = Math.max(1, Math.ceil(urgent.sla.minutesRemaining / 60));
    notifications.push(
      t(
        lang,
        `SLA reminder: case ${urgent.reference} requires attention in ${hours}h.`,
        `تذكير SLA: الحالة ${urgent.reference} تحتاج اهتماماً خلال ${hours}س.`
      )
    );
  } else {
    notifications.push(
      t(lang, 'SLA reminders: no immediate deadlines falling within 6h.', 'تذكيرات SLA: لا توجد مواعيد نهائية خلال 6 ساعات القادمة.')
    );
  }

  const reassigned = (reviewCases || []).find((c) => Number(c.reassigned_count) > 0);
  if (reassigned) {
    notifications.push(
      t(
        lang,
        `Case ${reassigned.reference} was reassigned to you after a follow-up review.`,
        `تمت إعادة تعيين الحالة ${reassigned.reference} لك بعد مراجعة متابعة.`
      )
    );
  } else {
    notifications.push(
      t(lang, 'No recent reassignments. Keep pushing your current reviews forward.', 'لا توجد إعادة تعيين حديثة. استمر في إنهاء المراجعات الحالية.')
    );
  }

  return notifications;
}

function parseDateToMs(value) {
  if (!value) return 0;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

function caseTimestampMs(order) {
  if (!order || typeof order !== 'object') return 0;
  return (
    parseDateToMs(order.updated_at) ||
    parseDateToMs(order.completed_at) ||
    parseDateToMs(order.accepted_at) ||
    parseDateToMs(order.created_at) ||
    0
  );
}

function caseReference(order) {
  if (!order || typeof order !== 'object') return '';
  const ref = order.reference || order.reference_code || order.case_ref || order.human_case_id || order.id;
  return String(ref || '').trim();
}

function caseHref(order) {
  const rawId = order && (order.id != null ? order.id : order.reference);
  const id = rawId == null ? '' : String(rawId).trim();
  return id ? `/portal/doctor/case/${encodeURIComponent(id)}` : '/portal/doctor/dashboard';
}

function dueTimeLabel(sla, lang = 'en') {
  if (!sla || typeof sla !== 'object') return t(lang, 'Today', 'اليوم');

  const minutesOverdue = Number(sla.minutesOverdue);
  const minutesRemaining = Number(sla.minutesRemaining);
  const isBreached =
    Boolean(sla.isBreached) ||
    (Number.isFinite(minutesOverdue) && minutesOverdue > 0) ||
    (Number.isFinite(minutesRemaining) && minutesRemaining <= 0);

  if (isBreached) return t(lang, 'Overdue', 'متأخر');
  if (!Number.isFinite(minutesRemaining)) return t(lang, 'Today', 'اليوم');
  if (minutesRemaining < 60) return t(lang, `Due in ${Math.max(1, Math.ceil(minutesRemaining))}m`, `خلال ${Math.max(1, Math.ceil(minutesRemaining))}د`);
  return t(lang, `Due in ${Math.max(1, Math.ceil(minutesRemaining / 60))}h`, `خلال ${Math.max(1, Math.ceil(minutesRemaining / 60))}س`);
}

function relativeTimeLabel(ts, lang = 'en') {
  if (!ts) return t(lang, 'Today', 'اليوم');
  const now = Date.now();
  const diff = now - ts;
  if (diff <= 60 * 60 * 1000) return t(lang, 'Now', 'الآن');
  if (diff <= 24 * 60 * 60 * 1000) return t(lang, 'Today', 'اليوم');
  const days = Math.max(1, Math.round(diff / (24 * 60 * 60 * 1000)));
  return t(lang, `${days}d ago`, `منذ ${days}ي`);
}

function buildDashboardAlerts({ doctorId, assignedCases, reviewCases, completedCases, lang = 'en' } = {}) {
  if (!doctorId) return [];

  const alerts = [];
  const inReview = Array.isArray(reviewCases) ? reviewCases : [];
  const assigned = Array.isArray(assignedCases) ? assignedCases : [];
  const completed = Array.isArray(completedCases) ? completedCases : [];

  const pushAlert = (priority, order, alert) => {
    if (!alert || typeof alert !== 'object') return;
    alerts.push({
      _priority: priority,
      _ts: caseTimestampMs(order),
      ...alert
    });
  };

  const hasSlaSignals = inReview.some((c) => {
    const sla = c && c.sla;
    return (sla && sla.isBreached) || hasNumericSlaWindow(sla);
  });
  if (hasSlaSignals) {
    inReview.forEach((c) => {
      const sla = c && c.sla;
      if (!sla || typeof sla !== 'object') return;

      const minutesOverdue = Number(sla.minutesOverdue);
      const minutesRemaining = Number(sla.minutesRemaining);
      const hasMinutesRemaining = Number.isFinite(minutesRemaining);
      const isUrgent =
        Boolean(sla.isBreached) ||
        (Number.isFinite(minutesOverdue) && minutesOverdue > 0) ||
        (hasMinutesRemaining && minutesRemaining <= 6 * 60);

      if (isUrgent) {
        const ref = caseReference(c) || t(lang, 'this case', 'هذه الحالة');
        pushAlert(1, c, {
          type: 'urgent',
          title: t(lang, 'Urgent SLA case needs action now', 'حالة SLA عاجلة تحتاج إجراء الآن'),
          message: t(
            lang,
            `Case ${ref} is overdue or due within 6 hours.`,
            `الحالة ${ref} متأخرة أو موعدها خلال 6 ساعات.`
          ),
          timeLabel: dueTimeLabel(sla, lang),
          href: caseHref(c)
        });
        return;
      }

      if (hasMinutesRemaining && minutesRemaining <= 24 * 60) {
        const ref = caseReference(c) || t(lang, 'this case', 'هذه الحالة');
        pushAlert(2, c, {
          type: 'warning',
          title: t(lang, 'SLA case due within 24 hours', 'حالة SLA موعدها خلال 24 ساعة'),
          message: t(
            lang,
            `Case ${ref} should be reviewed before deadline.`,
            `يجب مراجعة الحالة ${ref} قبل الموعد النهائي.`
          ),
          timeLabel: dueTimeLabel(sla, lang),
          href: caseHref(c)
        });
      }
    });
  } else {
    // TODO: SLA minutes fields are unavailable on some snapshots; keep INFO/SUCCESS alerts until SLA timing fields are present.
  }

  if (assigned.length) {
    const newestAssigned = assigned
      .slice()
      .sort((a, b) => caseTimestampMs(b) - caseTimestampMs(a))[0];
    const ref = caseReference(newestAssigned) || t(lang, 'a case', 'حالة');
    pushAlert(3, newestAssigned, {
      type: 'info',
      title: t(lang, 'New assigned case needs acceptance', 'حالة جديدة تحتاج قبولك'),
      message: t(
        lang,
        `Case ${ref} is assigned and ready to open.`,
        `الحالة ${ref} مُعيّنة وجاهزة للفتح.`
      ),
      timeLabel: relativeTimeLabel(caseTimestampMs(newestAssigned), lang),
      href: caseHref(newestAssigned)
    });
  }

  if (completed.length) {
    const now = Date.now();
    const completedWithTs = completed
      .map((c) => ({
        order: c,
        ts: parseDateToMs(c && (c.completed_at || c.updated_at || c.created_at))
      }))
      .sort((a, b) => b.ts - a.ts);

    const recentCompleted = completedWithTs.find((entry) => entry.ts && (now - entry.ts) <= 48 * 60 * 60 * 1000);
    const fallbackCompleted = !recentCompleted ? completedWithTs[0] : null;
    const completedEntry = recentCompleted || fallbackCompleted;

    if (completedEntry && completedEntry.order) {
      const ref = caseReference(completedEntry.order) || t(lang, 'a case', 'حالة');
      pushAlert(4, completedEntry.order, {
        type: 'success',
        title: t(lang, 'Recent case completed successfully', 'تم إكمال حالة بنجاح مؤخراً'),
        message: t(
          lang,
          `Case ${ref} was finalized successfully.`,
          `تم إنهاء الحالة ${ref} بنجاح.`
        ),
        timeLabel: relativeTimeLabel(completedEntry.ts, lang),
        href: caseHref(completedEntry.order)
      });
    }
  }

  return alerts
    .sort((a, b) => {
      if (a._priority !== b._priority) return a._priority - b._priority;
      return b._ts - a._ts;
    })
    .slice(0, 5)
    .map(({ _priority, _ts, ...alert }) => alert);
}

function idsEqual(a, b) {
  const aa = a == null ? '' : String(a);
  const bb = b == null ? '' : String(b);
  return aa === bb;
}

function normalizeStatus(status) {
  return String(status || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/-/g, '_');
}

// Canonical status keys (UI/state-model) mapped to current DB values
// NOTE: DB currently stores legacy values like 'new', 'accepted', 'breached'.
const DB_STATUS = Object.freeze({
  SUBMITTED: 'new',
  ASSIGNED: 'accepted',
  IN_REVIEW: 'in_review',
  REJECTED_FILES: 'rejected_files',
  COMPLETED: 'completed',
  SLA_BREACH: 'breached',
  CANCELLED: 'cancelled'
});

function isUnacceptedStatus(status) {
  const s = normalizeStatus(status);
  return ['new','submitted','paid','assigned','accepted'].includes(s);
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
  } catch (_) {}
  return uniqStrings(fallback);
}

function sqlIn(field, values) {
  const vals = (values || []).filter((v) => v != null && String(v).length);
  if (!vals.length) return { clause: '1=0', params: [] };
  const ph = vals.map(() => '?').join(',');
  return { clause: `${field} IN (${ph})`, params: vals };
}

function canonOrOriginal(status) {
  try {
    if (typeof toCanonStatus === 'function') {
      const c = toCanonStatus(status);
      return c || status;
    }
  } catch (_) {}
  return status;
}


function dbStatusFor(canon, fallback) {
  try {
    if (typeof toDbStatus === 'function') {
      const v = toDbStatus(canon);
      if (v) return v;
    }
  } catch (_) {}
  return fallback;
}

// Single write-path for order status updates (prevents raw status strings drifting).
function setOrderStatusCanon(orderId, canonStatus, opts = {}) {
  const nowIso = new Date().toISOString();
  const orderCols = getOrdersColumns();

  const fallbackDb = (DB_STATUS && DB_STATUS[canonStatus]) ? DB_STATUS[canonStatus] : String(canonStatus || '');
  const dbStatus = dbStatusFor(canonStatus, fallbackDb);

  const sets = ['status = ?'];
  const params = [dbStatus];

  if (opts.setCompletedAt && orderCols.includes('completed_at')) {
    sets.push('completed_at = COALESCE(completed_at, ?)');
    params.push(nowIso);
  }

  if (orderCols.includes('updated_at')) {
    sets.push('updated_at = ?');
    params.push(nowIso);
  }

  db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...params, orderId);
  return { dbStatus, nowIso };
}

function portalCaseActionFromStatus(status) {
  const normalized = normalizeStatus(status);

  // Keep details blurred/locked until explicit acceptance.
  // NOTE: Acceptance is when `accepted_at` is set and the case moves to `in_review`.
  // Legacy DBs may still use `accepted` to mean "assigned but not yet accepted".
  if (['new', 'submitted', 'paid', 'assigned', 'accepted'].includes(normalized)) return 'accept';

  if (normalized === 'completed') return 'completed';
  if (normalized === 'cancelled') return 'cancelled';

  if (normalized === 'rejected_files') return 'rejected';

  // Actively worked states (details visible)
  if (['in_review', 'review', 'breached', 'sla_breach'].includes(normalized)) return 'review';

  return 'review';
}

function extractFileName(url) {
  if (!url) return 'Uploaded file';
  const parts = url.split(/[\\/]/);
  return parts[parts.length - 1] || url;
}

function formatDisplayDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  const dd = pad(d.getDate());
  const mm = pad(d.getMonth() + 1);
  const yyyy = d.getFullYear();
  let hh = d.getHours();
  const min = pad(d.getMinutes());
  const ampm = hh >= 12 ? 'PM' : 'AM';
  hh = hh % 12;
  if (hh === 0) hh = 12;
  return `${dd}/${mm}/${yyyy} ${hh}:${min} ${ampm}`;
}

// ---- DB column helpers (defensive) ----
const SAFE_SCHEMA_TABLES = new Set([
  'orders',
  'order_files',
  'order_additional_files',
  'order_events'
]);
const _tableColumnsCache = Object.create(null);

function getTableColumns(tableName) {
  if (!tableName || !SAFE_SCHEMA_TABLES.has(tableName)) return [];
  if (_tableColumnsCache[tableName]) return _tableColumnsCache[tableName];
  try {
    const cols = db.prepare(`PRAGMA table_info('${tableName}')`).all();
    _tableColumnsCache[tableName] = Array.isArray(cols) ? cols.map((c) => c.name) : [];
  } catch (e) {
    _tableColumnsCache[tableName] = [];
  }
  return _tableColumnsCache[tableName];
}

function pickFirstExistingTableColumn(tableName, candidates) {
  const cols = getTableColumns(tableName);
  for (const name of candidates) {
    if (cols.includes(name)) return name;
  }
  return null;
}

function getOrderFilesUrlColumnName() {
  return pickFirstExistingTableColumn('order_files', ['url', 'file_url', 'cdn_url']);
}

function getOrderFilesLabelColumnName() {
  return pickFirstExistingTableColumn('order_files', ['label', 'file_label', 'name']);
}

function getOrderFilesCreatedAtColumnName() {
  return pickFirstExistingTableColumn('order_files', ['created_at', 'uploaded_at', 'at', 'timestamp']);
}

function getAdditionalFilesUrlColumnName() {
  return pickFirstExistingTableColumn('order_additional_files', ['file_url', 'url', 'cdn_url']);
}

function getAdditionalFilesUploadedAtColumnName() {
  return pickFirstExistingTableColumn('order_additional_files', [
    'uploaded_at',
    'created_at',
    'at',
    'timestamp'
  ]);
}

let _ordersColumnCache = null;
function getOrdersColumns() {
  if (_ordersColumnCache) return _ordersColumnCache;
  try {
    const cols = db.prepare("PRAGMA table_info('orders')").all();
    _ordersColumnCache = Array.isArray(cols) ? cols.map((c) => c.name) : [];
  } catch (e) {
    _ordersColumnCache = [];
  }
  return _ordersColumnCache;
}

function pickFirstExistingOrderColumn(candidates) {
  const cols = getOrdersColumns();
  for (const name of candidates) {
    if (cols.includes(name)) return name;
  }
  return null;
}

function getDiagnosisColumnName() {
  // Keep this list tight to avoid SQL injection risk.
  return pickFirstExistingOrderColumn([
    'diagnosis_text',
    'doctor_diagnosis',
    'diagnosis',
    'medical_opinion',
    'opinion_text'
  ]);
}


function readDiagnosisFromOrder(order) {
  if (!order) return '';
  return (
    order.diagnosis_text ||
    order.doctor_diagnosis ||
    order.diagnosis ||
    order.medical_opinion ||
    order.opinion_text ||
    ''
  );
}

function readLatestDiagnosisFromEvents(orderId) {
  if (!orderId) return '';
  try {
    const row = db
      .prepare(
        `SELECT meta
         FROM order_events
         WHERE order_id = ?
           AND label = 'doctor_diagnosis_saved'
         ORDER BY at DESC
         LIMIT 1`
      )
      .get(orderId);

    if (!row || !row.meta) return '';

    let parsed = null;
    try {
      parsed = JSON.parse(row.meta);
    } catch (_) {
      parsed = null;
    }

    const text = parsed && parsed.diagnosisText ? String(parsed.diagnosisText) : '';
    return text.trim();
  } catch (e) {
    return '';
  }
}

function parseCombinedNotesToFields(text) {
  const raw = (text || '').toString();
  const out = { findings: '', impression: '', recommendations: '' };
  if (!raw.trim()) return out;

  const s = raw.replace(/\r\n/g, '\n');

  const mFindings = s.match(/(?:^|\n)Findings:\n([\s\S]*?)(?=(?:\n\nImpression:\n|\n\nRecommendations:\n|$))/i);
  const mImpression = s.match(/(?:^|\n)Impression:\n([\s\S]*?)(?=(?:\n\nRecommendations:\n|$))/i);
  const mRecs = s.match(/(?:^|\n)Recommendations:\n([\s\S]*?)$/i);

  if (mFindings && mFindings[1]) out.findings = String(mFindings[1]).trim();
  if (mImpression && mImpression[1]) out.impression = String(mImpression[1]).trim();
  if (mRecs && mRecs[1]) out.recommendations = String(mRecs[1]).trim();

  // Fallback: if headings are missing, keep everything as findings.
  if (!out.findings && !out.impression && !out.recommendations) {
    out.findings = s.trim();
  }

  return out;
}

function readReportUrlFromOrder(order) {
  if (!order) return '';

  // 1) Prefer the actual report URL column if present.
  const reportCol = getReportUrlColumnName();
  if (reportCol && order[reportCol]) return String(order[reportCol]);

  // 2) Fallback to common property names.
  const direct =
    order.report_url ||
    order.final_report_url ||
    order.final_report_link ||
    order.report_pdf_url ||
    '';
  if (direct) return String(direct);

  // 3) Last resort: read the latest completion event meta and extract reportUrl.
  try {
    const rows = db
      .prepare(
        `SELECT label, meta, at
         FROM order_events
         WHERE order_id = ?
         ORDER BY at DESC
         LIMIT 10`
      )
      .all(order.id);

    for (const r of rows) {
      if (!r || !r.meta) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(r.meta);
      } catch (_) {
        parsed = null;
      }
      if (parsed && parsed.reportUrl) return String(parsed.reportUrl);
    }
  } catch (e) {
    // ignore
  }

  return '';
}

function isReportUrlAvailable(url) {
  if (!url) return false;
  const raw = String(url || '');
  if (/^https?:\/\//i.test(raw)) return true;
  const clean = raw.split('?')[0].split('#')[0];
  const rel = clean.startsWith('/') ? clean.slice(1) : clean;
  if (!rel.startsWith('reports/')) return true;
  try {
    const fullPath = path.join(process.cwd(), 'public', rel);
    return fs.existsSync(fullPath);
  } catch (_) {
    return false;
  }
}

function isOrderReportLocked(order) {
  if (!order) return false;
  const status = String(order.status || '').toLowerCase();
  if (status === 'completed') return true;

  // If a report URL exists (in DB columns OR events fallback), treat as locked.
  const url = readReportUrlFromOrder(order);
  return !!(url && String(url).trim());
}

// Redirect helper: if locked, always route back to the portal case page
// and include the latest reportUrl when available.
function redirectIfLocked(req, res, orderId, order) {
  if (!isOrderReportLocked(order)) return null;

  const reportUrl = readReportUrlFromOrder(order);

  // If this is an AJAX/JSON caller, do not redirect — return an explicit conflict.
  if (wantsJson(req)) {
    return res.status(409).json({
      ok: false,
      locked: true,
      reason: 'report_exists',
      reportUrl: reportUrl || null
    });
  }

  const qs = new URLSearchParams({ report: 'locked' });
  if (reportUrl) qs.set('reportUrl', reportUrl);

  return res.redirect(`/portal/doctor/case/${orderId}?${qs.toString()}`);
}

function wantsJson(req) {
  try {
    const accept = String((req && req.get && req.get('Accept')) || '').toLowerCase();
    const xrw = String((req && req.get && req.get('X-Requested-With')) || '').toLowerCase();
    const fmt = req && req.query ? String(req.query.format || '') : '';
    if (fmt.toLowerCase() === 'json') return true;
    if (xrw === 'xmlhttprequest') return true;
    return accept.includes('application/json');
  } catch (_) {
    return false;
  }
}

// Determine current additional-files request state for an order.
// States:
// - none: no request exists
// - pending: requested, no admin decision yet
// - approved_awaiting_patient: approved, but patient has not re-uploaded yet
// - satisfied: approved and patient has uploaded after the request
// - denied: rejected/denied by support
function getAdditionalFilesRequestState(orderId) {
  try {
    const reqRow = db
      .prepare(
        `SELECT id, at
         FROM order_events
         WHERE order_id = ?
           AND label = 'doctor_requested_additional_files'
         ORDER BY at DESC, id DESC
         LIMIT 1`
      )
      .get(orderId);

    if (!reqRow || !reqRow.at) return { state: 'none', requestedAt: null };

    const requestedAt = String(reqRow.at);
    const requestId = reqRow.id ? String(reqRow.id) : '';

    const decisionRow = db
      .prepare(
        `SELECT label, at
         FROM order_events
         WHERE order_id = ?
           AND (
             label IN ('additional_files_request_approved','additional_files_request_rejected','additional_files_request_denied')
             OR LOWER(label) LIKE '%additional%files%request%approved%'
             OR LOWER(label) LIKE '%additional%files%request%rejected%'
             OR LOWER(label) LIKE '%additional%files%request%denied%'
             OR LOWER(label) LIKE '%additional%files%approved%'
             OR LOWER(label) LIKE '%additional%files%rejected%'
             OR LOWER(label) LIKE '%additional%files%denied%'
           )
           AND (at > ? OR (at = ? AND id != ?))
         ORDER BY at DESC, id DESC
         LIMIT 1`
      )
      .get(orderId, requestedAt, requestedAt, requestId);

    if (!decisionRow || !decisionRow.label) {
      return { state: 'pending', requestedAt };
    }

    const decisionLabel = String(decisionRow.label);
    const decisionNorm = decisionLabel.toLowerCase();

    if (decisionNorm.includes('approved')) {
      // If patient uploaded additional files after the request, consider it satisfied.
      let hasUploadAfter = false;

      try {
        const patientEvent = db
          .prepare(
            `SELECT at
             FROM order_events
             WHERE order_id = ?
               AND label = 'patient_uploaded_additional_files'
               AND at > ?
             ORDER BY at DESC
             LIMIT 1`
          )
          .get(orderId, requestedAt);
        if (patientEvent && patientEvent.at) hasUploadAfter = true;
      } catch (_) {}

      try {
        const atCol = getAdditionalFilesUploadedAtColumnName();
        if (atCol) {
          const row = db
            .prepare(
              `SELECT 1 AS ok
               FROM order_additional_files
               WHERE order_id = ?
                 AND ${atCol} > ?
               LIMIT 1`
            )
            .get(orderId, requestedAt);
          if (row) hasUploadAfter = true;
        }
      } catch (_) {}

      if (hasUploadAfter) {
        return { state: 'satisfied', requestedAt };
      }

      return { state: 'approved_awaiting_patient', requestedAt };
    }

    // Any explicit non-approval decision means support denied/rejected the request.
    if (decisionNorm.includes('rejected') || decisionNorm.includes('denied')) {
      return { state: 'denied', requestedAt };
    }

    // Fallback: if we matched a decision label pattern but couldn't classify it, treat as pending.
    return { state: 'pending', requestedAt };
  } catch (e) {
    return { state: 'none', requestedAt: null };
  }
}

// ---- end helpers ----

// ---- report completion helpers (defensive) ----
function getReportUrlColumnName() {
  // Keep allow-list tight.
  return pickFirstExistingOrderColumn([
    'report_url',
    'final_report_url',
    'final_report_link',
    'report_pdf_url'
  ]);
}

function ensureReportsDir() {
  const dir = path.join(process.cwd(), 'public', 'reports');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    // ignore
  }
  return dir;
}

function markOrderCompletedFallback({ orderId, doctorId, reportUrl, diagnosisText, annotatedFiles }) {
  const nowIso = new Date().toISOString();
  const diagnosisCol = getDiagnosisColumnName();
  const reportCol = getReportUrlColumnName();

  const sets = [];
  const params = [];

  if (diagnosisCol) {
    sets.push(`${diagnosisCol} = ?`);
    params.push(diagnosisText || null);
  }

  if (reportCol) {
    sets.push(`${reportCol} = ?`);
    params.push(reportUrl || null);
  }

// Only set timestamps if those columns exist in this DB schema.
const orderCols = getOrdersColumns();

// Ensure the order remains attributable to the doctor who completed it (helps dashboard visibility).
if (orderCols.includes('doctor_id') && doctorId) {
  sets.push('doctor_id = COALESCE(doctor_id, ?)');
  params.push(doctorId);
}

// Always mark completed (canonical write path).
sets.push('status = ?');
params.push(dbStatusFor('COMPLETED', DB_STATUS.COMPLETED));
  if (orderCols.includes('completed_at')) {
    sets.push('completed_at = COALESCE(completed_at, ?)');
    params.push(nowIso);
  }
  if (orderCols.includes('updated_at')) {
    sets.push('updated_at = ?');
    params.push(nowIso);
  }

  db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...params, orderId);

  // Persist an event for audit/debug.
  try {
    db.prepare(
      `INSERT INTO order_events (id, order_id, label, meta, at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      require('crypto').randomUUID(),
      orderId,
      'order_completed',
      JSON.stringify({
        via: 'doctor_portal_report',
        reportUrl: reportUrl || null,
        annotatedFiles: Array.isArray(annotatedFiles) ? annotatedFiles : [],
        hasDiagnosis: !!(diagnosisText && String(diagnosisText).trim())
      }),
      nowIso
    );
  } catch (e) {
    console.warn('[report] could not write order_events for completion', e);
  }

  try {
    logOrderEvent({
      orderId,
      label: 'Case completed (fallback)',
      meta: JSON.stringify({ reportUrl: reportUrl || null, via: 'doctor_portal_report_fallback' }),
      actorUserId: doctorId,
      actorRole: 'doctor'
    });
  } catch (e) {
    // ignore
  }
}

async function handlePortalDoctorGenerateReport(req, res) {
  try {
    const doctorId = req.user && req.user.id;
    const orderId = req.params.caseId;

    if (!doctorId || !orderId) {
      return res.status(400).send('Invalid request');
    }

    // Load order defensively
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) {
      return res.status(404).send('Case not found');
    }

    // If already completed / locked, redirect back
    const status = String(order.status || '').toLowerCase();
    if (status === 'completed') {
      return res.redirect(`/portal/doctor/case/${orderId}`);
    }

    // Minimal required inputs
    const diagnosisText =
      (req.body && (req.body.diagnosis || req.body.diagnosis_text)) || '';

    const reportsDir = ensureReportsDir();
    const outPath = path.join(reportsDir, `report_${orderId}.pdf`);

    await generateMedicalReportPdf({
      order,
      diagnosisText,
      outPath
    });

    const reportUrl = `/reports/report_${orderId}.pdf`;

    markOrderCompletedFallback({
      orderId,
      doctorId,
      reportUrl,
      diagnosisText,
      annotatedFiles: []
    });

    // Auto-save case report to medical records
    try {
      if (order.patient_id) {
        var serviceName = '';
        try {
          var svc = order.service_id ? db.prepare('SELECT name FROM services WHERE id = ?').get(order.service_id) : null;
          serviceName = svc ? svc.name : '';
        } catch (_) {}
        var recId = require('crypto').randomUUID();
        db.prepare(
          `INSERT OR IGNORE INTO medical_records (id, patient_id, record_type, title, description, file_url, order_id, doctor_id, is_shared_with_doctors, created_at)
           VALUES (?, ?, 'case_report', ?, ?, ?, ?, ?, 1, ?)`
        ).run(
          recId,
          order.patient_id,
          'Case Report - ' + (serviceName || 'Medical Review'),
          'Auto-saved from completed case #' + String(orderId).slice(0, 8),
          reportUrl || null,
          orderId,
          doctorId,
          new Date().toISOString()
        );
      }
    } catch (_) {}

    // Notify patient that report is ready (email + whatsapp + internal)
    if (order.patient_id) {
      try {
        const doctor = db.prepare('SELECT name FROM users WHERE id = ?').get(doctorId);
        const specialty = order.specialty_id
          ? db.prepare('SELECT name FROM specialties WHERE id = ?').get(order.specialty_id)
          : null;
        queueMultiChannelNotification({
          orderId,
          toUserId: order.patient_id,
          channels: ['email', 'whatsapp', 'internal'],
          template: 'report_ready_patient',
          response: {
            caseReference: String(orderId).slice(0, 12).toUpperCase(),
            doctorName: doctor ? doctor.name : '',
            specialty: specialty ? specialty.name : '',
            reportUrl: `${process.env.APP_URL || 'https://tashkheesa.com'}${reportUrl}`,
          },
        });
      } catch (notifErr) {
        console.error('[doctor][report] notification failed', notifErr.message);
      }
    }

    return res.redirect(`/portal/doctor/case/${orderId}`);
  } catch (e) {
    console.error('[doctor][report] failed', e);
    return res.status(500).send('Report generation failed');
  }
}
module.exports = router;
