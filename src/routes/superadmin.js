// src/routes/superadmin.js
const express = require('express');
const { db } = require('../db');
const { randomUUID } = require('crypto');
const { hash } = require('../auth');
const { requireRole } = require('../middleware');
const { queueNotification, doctorNotify } = require('../notify');
const { getNotificationTitles } = require('../notify/notification_titles');
const { runSlaSweep } = require('../sla_watcher');
const { logOrderEvent } = require('../audit');
const { computeSla, enforceBreachIfNeeded } = require('../sla_status');
const { pickDoctorForOrder } = require('../assign');
const { recalcSlaBreaches } = require('../sla');
const { randomUUID: uuidv4 } = require('crypto');
const { safeAll, safeGet, tableExists } = require('../sql-utils');
const caseLifecycle = require('../case_lifecycle');
const getStatusUi = caseLifecycle.getStatusUi || caseLifecycle;
const toCanonStatus = caseLifecycle.toCanonStatus;
const canonicalizeStatus =
  typeof toCanonStatus === 'function' ? toCanonStatus : caseLifecycle.normalizeStatus;
const dbStatusValuesFor = caseLifecycle.dbStatusValuesFor;

const router = express.Router();

const requireSuperadmin = requireRole('superadmin');

const IS_PROD = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

// Defaults for alerts badge on superadmin pages.
router.use((req, res, next) => {
  res.locals.unseenAlertsCount = 0;
  res.locals.alertsUnseenCount = 0;
  res.locals.hasUnseenAlerts = false;
  return next();
});

// Unseen alerts count (superadmin only).
router.use((req, res, next) => {
  try {
    const user = req.user;
    if (!user || String(user.role || '') !== 'superadmin') return next();
    const count = countSuperadminUnseenNotifications(user.id, user.email || '');
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

function getNotificationTableColumns() {
  try {
    const cols = db.prepare("PRAGMA table_info('notifications')").all();
    return Array.isArray(cols) ? cols.map((c) => c.name) : [];
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

function fetchSuperadminNotifications(userId, userEmail = '', limit = 50) {
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

function countSuperadminUnseenNotifications(userId, userEmail = '') {
  try {
    const cols = getNotificationTableColumns();
    const hasUserId = cols.includes('user_id');
    const hasToUserId = cols.includes('to_user_id');
    if (!hasUserId && !hasToUserId) return 0;

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

    if (cols.includes('is_read')) {
      const row = db
        .prepare(`SELECT COUNT(*) as c FROM notifications WHERE ${ownerClause} AND COALESCE(is_read, 0) = 0`)
        .get(...params);
      return row ? Number(row.c) : 0;
    }

    if (cols.includes('status')) {
      const row = db
        .prepare(`SELECT COUNT(*) as c FROM notifications WHERE ${ownerClause} AND COALESCE(LOWER(status), '') NOT IN ('seen','read')`)
        .get(...params);
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
  const isReadVal = row && row.is_read != null ? Number(row.is_read) : null;

  const status = (isReadVal === 1)
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

  const titles = getNotificationTitles(template);

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

function markAllSuperadminNotificationsRead(userId, userEmail = '') {
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

router.get('/superadmin/alerts', requireSuperadmin, (req, res) => {
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';
  const userId = req.user && req.user.id ? String(req.user.id) : '';
  const userEmail = req.user && req.user.email ? String(req.user.email).trim() : '';

  const raw = fetchSuperadminNotifications(userId, userEmail, 50);
  const alerts = (raw || []).map(normalizeSuperadminNotification);

  try {
    if (userId) {
      markAllSuperadminNotificationsRead(userId, userEmail);
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

// ---- Superadmin services visibility toggles (hide/unhide) ----

function getServicesTableColumns() {
  try {
    const cols = db.prepare("PRAGMA table_info('services')").all();
    return Array.isArray(cols) ? cols.map((c) => c.name) : [];
  } catch (_) {
    return [];
  }
}

function ensureServicesVisibilityColumn() {
  // Adds services.is_visible if it doesn't exist.
  // Note: SQLite will set existing rows to NULL, so we backfill to 1.
  const cols = getServicesTableColumns();
  if (cols.includes('is_visible')) return true;

  try {
    db.prepare("ALTER TABLE services ADD COLUMN is_visible INTEGER DEFAULT 1").run();
    try {
      db.prepare("UPDATE services SET is_visible = 1 WHERE is_visible IS NULL").run();
    } catch (_) {
      // non-blocking
    }
    return true;
  } catch (_) {
    return false;
  }
}

function setServiceVisibility(serviceId, isVisible) {
  if (!ensureServicesVisibilityColumn()) {
    return { ok: false, reason: 'missing_is_visible_column' };
  }

  try {
    const r = db
      .prepare('UPDATE services SET is_visible = ? WHERE id = ?')
      .run(isVisible ? 1 : 0, String(serviceId));
    return { ok: true, changes: r && r.changes ? r.changes : 0 };
  } catch (_) {
    return { ok: false, reason: 'update_failed' };
  }
}

// ---- Service country pricing helper ----
function fetchServiceCountryPricing() {
  return safeAll(
    `SELECT scp.service_id,
            scp.country_code,
            scp.price,
            scp.currency,
            s.name AS service_name,
            s.specialty_id
     FROM service_country_pricing scp
     JOIN services s ON s.id = scp.service_id
     WHERE scp.country_code != 'EG'
     ORDER BY s.name ASC, scp.country_code ASC`,
    [],
    []
  );
}

router.post('/superadmin/services/:id/hide', requireSuperadmin, (req, res) => {
  const id = req.params && req.params.id ? String(req.params.id) : '';
  if (id) setServiceVisibility(id, false);
  return res.redirect('/superadmin/services');
});

router.post('/superadmin/services/:id/unhide', requireSuperadmin, (req, res) => {
  const id = req.params && req.params.id ? String(req.params.id) : '';
  if (id) setServiceVisibility(id, true);
  return res.redirect('/superadmin/services');
});

router.post('/superadmin/services/:id/toggle-visibility', requireSuperadmin, (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.redirect('/superadmin/services');

  try {
    ensureServicesVisibilityColumn();
    db.prepare(
      `UPDATE services
       SET is_visible = CASE WHEN COALESCE(is_visible, 1) = 1 THEN 0 ELSE 1 END
       WHERE id = ?`
    ).run(id);
  } catch (_) {
    // non-blocking
  }

  return res.redirect('/superadmin/services');
});

// ---- Superadmin services page ----
router.get('/superadmin/services', requireSuperadmin, (req, res) => {
  // Read selected country from query param (default AE, uppercase)
  const selectedCountry = String(req.query.country || 'AE').toUpperCase();

  // Fetch all services (needed by EJS)
  const services = safeAll(
    `SELECT id, name, specialty_id, is_visible
     FROM services
     ORDER BY name ASC`,
    [],
    []
  );

  // Fetch pricing per country (non-EG only, already inserted via terminal)
  const serviceCountryPricing = fetchServiceCountryPricing();

  return res.render('superadmin_services', {
    user: req.user,
    services,
    serviceCountryPricing,
    selectedCountry
  });
});

// buildFilters: used for dashboard and CSV export
function buildFilters(query) {
  const where = [];
  const params = [];

  if (query.from && query.from.trim()) {
    where.push('DATE(o.created_at) >= DATE(?)');
    params.push(query.from.trim());
  }
  if (query.to && query.to.trim()) {
    where.push('DATE(o.created_at) <= DATE(?)');
    params.push(query.to.trim());
  }
  if (query.specialty && query.specialty.trim() && query.specialty !== 'all') {
    where.push('o.specialty_id = ?');
    params.push(query.specialty.trim());
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return { whereSql, params };
}

function getActiveSuperadmins() {
  return db.prepare("SELECT id, name FROM users WHERE role = 'superadmin' AND is_active = 1").all();
}

function selectSlaRelevantOrders() {
  const slaStatuses = uniqStrings([
    ...statusDbValues('ACCEPTED', ['accepted']),
    ...statusDbValues('IN_REVIEW', ['in_review']),
    ...statusDbValues('AWAITING_FILES', ['awaiting_files'])
  ]);
  const inSql = sqlIn('o.status', slaStatuses);

  return db
    .prepare(
      `SELECT o.*, d.name AS doctor_name
       FROM orders o
       LEFT JOIN users d ON d.id = o.doctor_id
       WHERE ${inSql.clause}
         AND o.accepted_at IS NOT NULL
         AND o.completed_at IS NULL
         AND o.deadline_at IS NOT NULL`
    )
    .all(...inSql.params);
}

function countOpenCasesForDoctor(doctorId) {
  const openStatuses = uniqStrings([
    ...statusDbValues('NEW', ['new']),
    ...statusDbValues('ACCEPTED', ['accepted']),
    ...statusDbValues('IN_REVIEW', ['in_review']),
    ...statusDbValues('AWAITING_FILES', ['awaiting_files']),
    ...statusDbValues('BREACHED_SLA', ['breached'])
  ]);
  const inSql = sqlIn('status', openStatuses);

  const row = db
    .prepare(
      `SELECT COUNT(*) as c
       FROM orders
       WHERE doctor_id = ?
         AND ${inSql.clause}`
    )
    .get(doctorId, ...inSql.params);

  return row ? row.c || 0 : 0;
}

function findBestAlternateDoctor(specialtyId, excludeDoctorId) {
  const doctors = db
    .prepare(
      `SELECT id, name
       FROM users
       WHERE role = 'doctor'
         AND is_active = 1
         AND specialty_id = ?
         AND id != ?`
    )
    .all(specialtyId, excludeDoctorId || '');

  if (!doctors || !doctors.length) return null;

  let best = null;
  doctors.forEach((doc) => {
    const openCount = countOpenCasesForDoctor(doc.id);
    if (!best || openCount < best.openCount) {
      best = { ...doc, openCount };
    }
  });
  return best;
}

function performSlaCheck(now = new Date()) {
  const summary = {
    preBreachWarnings: 0,
    breached: 0,
    reassigned: 0,
    noDoctor: 0
  };

  const orders = selectSlaRelevantOrders();
  const superadmins = getActiveSuperadmins();
  const nowIso = now.toISOString();

  orders.forEach((order) => {
    if (!order.deadline_at) return;

    const deadline = new Date(order.deadline_at);
    const msToDeadline = deadline - now;

    // Breach handling
    if (msToDeadline <= 0) {
      db.prepare(
        `UPDATE orders
         SET status = 'breached',
             breached_at = ?,
             updated_at = ?
         WHERE id = ?`
      ).run(nowIso, nowIso, order.id);

      logOrderEvent({
        orderId: order.id,
        label: 'Order breached SLA',
        actorRole: 'system'
      });
      summary.breached += 1;

      if (order.doctor_id) {
        queueNotification({
          orderId: order.id,
          toUserId: order.doctor_id,
          channel: 'internal',
          template: 'sla_breached_doctor',
          status: 'queued'
        });
      }
      superadmins.forEach((admin) => {
        queueNotification({
          orderId: order.id,
          toUserId: admin.id,
          channel: 'internal',
          template: 'order_breached_superadmin',
          status: 'queued'
        });
      });
      // Notify patient as well (operational transparency)
      if (order.patient_id) {
        queueNotification({
          orderId: order.id,
          toUserId: order.patient_id,
          channel: 'internal',
          template: 'order_breached_patient',
          status: 'queued'
        });
      }

      // Auto-reassign if possible
      const alternateDoctor = findBestAlternateDoctor(order.specialty_id, order.doctor_id);
      if (!alternateDoctor) {
        logOrderEvent({
          orderId: order.id,
          label: 'No available doctor to reassign case',
          actorRole: 'system'
        });
        summary.noDoctor += 1;
        return;
      }

      db.prepare(
        `UPDATE orders
         SET doctor_id = ?,
             status = 'new',
             accepted_at = NULL,
             deadline_at = NULL,
             reassigned_count = COALESCE(reassigned_count, 0) + 1,
             updated_at = ?
         WHERE id = ?`
      ).run(alternateDoctor.id, nowIso, order.id);

      logOrderEvent({
        orderId: order.id,
        label: `Order auto-reassigned from Doctor ${order.doctor_name || order.doctor_id || ''} to Doctor ${alternateDoctor.name} due to SLA breach`,
        actorRole: 'system'
      });

      if (order.doctor_id) {
        queueNotification({
          orderId: order.id,
          toUserId: order.doctor_id,
          channel: 'internal',
          template: 'order_reassigned_from_doctor',
          status: 'queued'
        });
      }
      queueNotification({
        orderId: order.id,
        toUserId: alternateDoctor.id,
        channel: 'internal',
        template: 'order_reassigned_to_doctor',
        status: 'queued'
      });
      superadmins.forEach((admin) => {
        queueNotification({
          orderId: order.id,
          toUserId: admin.id,
          channel: 'internal',
          template: 'order_reassigned_superadmin',
          status: 'queued'
        });
      });
      // Notify patient that their case has been reassigned
      if (order.patient_id) {
        queueNotification({
          orderId: order.id,
          toUserId: order.patient_id,
          channel: 'internal',
          template: 'order_reassigned_patient',
          status: 'queued'
        });
      }
      summary.reassigned += 1;
      return;
    }

    // Pre-breach warning (within 60 minutes)
    if (msToDeadline <= 60 * 60 * 1000 && Number(order.pre_breach_notified || 0) === 0) {
      db.prepare(
        `UPDATE orders
         SET pre_breach_notified = 1,
             updated_at = ?
         WHERE id = ?`
      ).run(nowIso, order.id);

      logOrderEvent({
        orderId: order.id,
        label: 'SLA pre-breach warning sent to superadmins',
        actorRole: 'system'
      });

      superadmins.forEach((admin) => {
        queueNotification({
          orderId: order.id,
          toUserId: admin.id,
          channel: 'internal',
          template: 'order_sla_pre_breach',
          status: 'queued'
        });
      });
      // Also warn the assigned doctor
      if (order.doctor_id) {
        queueNotification({
          orderId: order.id,
          toUserId: order.doctor_id,
          channel: 'internal',
          template: 'sla_reminder_doctor',
          status: 'queued'
        });
      }

      summary.preBreachWarnings += 1;
    }
  });

  return summary;
}

function loadOrderWithPatient(orderId) {
  return db
    .prepare(
      `SELECT o.id, o.status, o.payment_status, o.payment_method, o.payment_reference, o.price, o.currency,
              o.patient_id, u.name AS patient_name, u.email AS patient_email
       FROM orders o
       LEFT JOIN users u ON u.id = o.patient_id
       WHERE o.id = ?`
    )
    .get(orderId);
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

function sqlIn(field, values) {
  const vals = (values || []).filter((v) => v != null && String(v).length);
  if (!vals.length) return { clause: '1=0', params: [] }; // nothing should match
  const ph = vals.map(() => '?').join(',');
  return { clause: `${field} IN (${ph})`, params: vals };
}

function sqlNotIn(field, values) {
  const vals = (values || []).filter((v) => v != null && String(v).length);
  if (!vals.length) return { clause: '1=1', params: [] }; // nothing to exclude
  const ph = vals.map(() => '?').join(',');
  return { clause: `${field} NOT IN (${ph})`, params: vals };
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

// Finds the most recent "doctor requested additional files" style event.
// We keep this fuzzy on purpose to avoid coupling to one exact label.
function getLatestAdditionalFilesRequestEvent(orderId) {
  return safeGet(
    `SELECT id, label, meta, at, actor_user_id, actor_role
     FROM order_events
     WHERE order_id = ?
       AND (
         label = 'doctor_requested_additional_files'
         OR (
           (LOWER(label) LIKE '%request%' AND (LOWER(label) LIKE '%file%' OR LOWER(label) LIKE '%upload%' OR LOWER(label) LIKE '%re-upload%' OR LOWER(label) LIKE '%reupload%'))
           OR LOWER(label) LIKE '%reject file%'
           OR LOWER(label) LIKE '%reupload%'
         )
       )
       AND NOT (
         LOWER(label) LIKE '%additional files request approved%'
         OR LOWER(label) LIKE '%additional files request rejected%'
         OR LOWER(label) LIKE '%additional files request denied%'
       )
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
     WHERE order_id = ?
       AND (
         LOWER(label) LIKE '%additional files request approved%'
         OR LOWER(label) LIKE '%additional files request rejected%'
         OR LOWER(label) LIKE '%additional files request denied%'
       )
     ORDER BY at DESC
     LIMIT 1`,
    [orderId],
    null
  );
}

function computeAdditionalFilesRequestState(orderId) {
  const reqEvent = getLatestAdditionalFilesRequestEvent(orderId);
  const decisionEvent = getLatestAdditionalFilesDecisionEvent(orderId);

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

function getPendingAdditionalFilesRequests(limit = 20) {
  // Inbox-style list of additional-files requests.
  // Requirement:
  // - Show the request in the dashboard inbox even after approve/reject.
  // - Show a status pill that changes based on latest decision after the request.
  // - Do NOT rely on `orders.additional_files_requested` alone or a single legacy label.

  const lim = Number(limit) || 20;

  // Match request-like events (fuzzy) AND the canonical label.
  // NOTE: doctor route now writes `doctor_requested_additional_files` exactly.
  const requestMatch = `(
    e1.label = 'doctor_requested_additional_files'
    OR (
      (LOWER(e1.label) LIKE '%request%' AND (LOWER(e1.label) LIKE '%file%' OR LOWER(e1.label) LIKE '%upload%' OR LOWER(e1.label) LIKE '%re-upload%' OR LOWER(e1.label) LIKE '%reupload%'))
      OR LOWER(e1.label) LIKE '%reject file%'
      OR LOWER(e1.label) LIKE '%reupload%'
    )
  )`;

  // Decision events (written by admin/superadmin flows).
  const decisionMatch = `(
    LOWER(d.label) LIKE '%additional files request approved%'
    OR LOWER(d.label) LIKE '%additional files request rejected%'
    OR LOWER(d.label) LIKE '%additional files request denied%'
  )`;

  const rows = safeAll(
    `WITH req AS (
        SELECT e1.order_id,
               e1.id   AS request_event_id,
               e1.at   AS requested_at,
               e1.label AS request_label,
               e1.meta AS request_meta
        FROM order_events e1
        WHERE ${requestMatch}
          AND NOT (
            LOWER(e1.label) LIKE '%additional files request approved%'
            OR LOWER(e1.label) LIKE '%additional files request rejected%'
            OR LOWER(e1.label) LIKE '%additional files request denied%'
          )
          AND e1.id = (
            SELECT e2.id
            FROM order_events e2
            WHERE e2.order_id = e1.order_id
              AND NOT (
                LOWER(e2.label) LIKE '%additional files request approved%'
                OR LOWER(e2.label) LIKE '%additional files request rejected%'
                OR LOWER(e2.label) LIKE '%additional files request denied%'
              )
              AND (
                e2.label = 'doctor_requested_additional_files'
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
              AND (
                LOWER(d2.label) LIKE '%additional files request approved%'
                OR LOWER(d2.label) LIKE '%additional files request rejected%'
                OR LOWER(d2.label) LIKE '%additional files request denied%'
              )
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
     JOIN orders o ON o.id = req.order_id
     LEFT JOIN specialties s ON s.id = o.specialty_id
     LEFT JOIN users doc ON doc.id = o.doctor_id
     LEFT JOIN users pat ON pat.id = o.patient_id
     LEFT JOIN dec ON dec.order_id = o.id
     ORDER BY req.requested_at DESC
     LIMIT ?`,
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
function renderSuperadminProfile(req, res) {
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';
  const u = req.user || {};

  const title = t(lang, 'My profile', 'ملفي الشخصي');
  const dashboardLabel = t(lang, 'Dashboard', 'لوحة التحكم');
  const doctorsLabel = t(lang, 'Doctors', 'الأطباء');
  const servicesLabel = t(lang, 'Services', 'الخدمات');
  const logoutLabel = t(lang, 'Logout', 'تسجيل الخروج');

  const name = escapeHtml(u.name || '—');
  const email = escapeHtml(u.email || '—');
  const role = escapeHtml(u.role || 'superadmin');

  const specialty = (() => {
    try {
      if (!u.specialty_id) return '—';
      const row = db.prepare('SELECT name FROM specialties WHERE id = ?').get(u.specialty_id);
      return escapeHtml((row && row.name) || '—');
    } catch (_) {
      return '—';
    }
  })();

  const profileDisplayRaw = u.name || u.full_name || u.fullName || u.email || '';
  const profileDisplay = profileDisplayRaw ? escapeHtml(profileDisplayRaw) : '';
  const profileLabel = profileDisplay || escapeHtml(title);
  const csrfFieldHtml = (res.locals && typeof res.locals.csrfField === 'function') ? res.locals.csrfField() : '';
  const nextPath = (req && req.originalUrl && String(req.originalUrl).startsWith('/')) ? String(req.originalUrl) : '/superadmin/profile';

  res.set('Content-Type', 'text/html; charset=utf-8');
  return res.send(`<!doctype html>
<html lang="${isAr ? 'ar' : 'en'}" dir="${isAr ? 'rtl' : 'ltr'}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} - Tashkheesa</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <header class="header">
    <nav class="header-nav" style="display:flex; gap:12px; align-items:center; justify-content:space-between; padding:16px;">
      <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
        <a class="btn btn--ghost" href="/superadmin">${escapeHtml(dashboardLabel)}</a>
        <a class="btn btn--ghost" href="/superadmin/doctors">${escapeHtml(doctorsLabel)}</a>
        <a class="btn btn--ghost" href="/superadmin/services">${escapeHtml(servicesLabel)}</a>
        <span class="btn btn--primary" aria-current="page">${escapeHtml(title)}</span>
      </div>
      <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
        <details class="user-menu">
          <summary class="pill user-menu-trigger" title="${escapeHtml(title)}">👤 ${profileLabel}</summary>
          <div class="user-menu-panel" role="menu" aria-label="${escapeHtml(title)}">
            <a class="user-menu-item" role="menuitem" href="/superadmin/profile">${escapeHtml(title)}</a>
            <form class="logout-form" action="/logout" method="POST" style="margin:0;">
              ${csrfFieldHtml}
              <button class="user-menu-item user-menu-item-danger" type="submit">${escapeHtml(logoutLabel)}</button>
            </form>
          </div>
        </details>
        <div class="lang-switch">
          <a href="/lang/en?next=${encodeURIComponent(nextPath)}">EN</a> | <a href="/lang/ar?next=${encodeURIComponent(nextPath)}">AR</a>
        </div>
      </div>
    </nav>
  </header>

  <main class="container" style="max-width:900px; margin:0 auto; padding:24px;">
    <h1 style="margin:0 0 16px 0;">${escapeHtml(title)}</h1>

    <section class="card" style="padding:16px;">
      <div style="display:grid; grid-template-columns: 1fr; gap:12px;">
        <div><strong>${escapeHtml(t(lang, 'Name', 'الاسم'))}:</strong> ${name}</div>
        <div><strong>${escapeHtml(t(lang, 'Email', 'البريد الإلكتروني'))}:</strong> ${email}</div>
        <div><strong>${escapeHtml(t(lang, 'Role', 'الدور'))}:</strong> ${role}</div>
        <div><strong>${escapeHtml(t(lang, 'Specialty', 'التخصص'))}:</strong> ${specialty}</div>
      </div>

      <hr style="margin:16px 0;" />
      <p style="margin:0; color:#666;">
        ${escapeHtml(t(
          lang,
          'Profile editing will be enabled in a later release. For changes, contact support/admin.',
          'سيتم تفعيل تعديل الملف الشخصي في إصدار لاحق. للتعديلات تواصل مع الدعم/الإدارة.'
        ))}
      </p>
    </section>
  </main>
</body>
</html>`);
}

router.get('/superadmin/profile', requireRole('superadmin'), renderSuperadminProfile);

// MAIN SUPERADMIN DASHBOARD
router.get('/superadmin', requireSuperadmin, (req, res) => {
  // Refresh SLA breaches on each dashboard load
  recalcSlaBreaches();

  const query = req.query || {};
  const from = query.from || '';
  const to = query.to || '';
  const specialty = query.specialty || 'all';
  const langCode =
    (query && query.lang === 'ar') ||
    (req.session && req.session.lang === 'ar')
      ? 'ar'
      : 'en';

  // Update overdue orders to breached on read
  const completedValsOverdue = statusDbValues('COMPLETED', ['completed']);
  const breachedValsOverdue = statusDbValues('BREACHED_SLA', ['breached']);
  const delayedValsOverdue = statusDbValues('DELAYED', ['delayed']);

  const excludedVals = uniqStrings([...completedValsOverdue, ...breachedValsOverdue, ...delayedValsOverdue])
    .map((v) => String(v).toLowerCase());

  const notInSql = sqlNotIn('LOWER(status)', excludedVals);

  const overdueOrders = safeAll(
    `SELECT id, status, deadline_at, completed_at
     FROM orders
     WHERE ${notInSql.clause}
       AND completed_at IS NULL
       AND deadline_at IS NOT NULL
       AND datetime(deadline_at) < datetime('now')`,
    notInSql.params,
    []
  );
  overdueOrders.forEach((o) => enforceBreachIfNeeded(o));

  const { whereSql, params } = buildFilters(query);
  const pendingDoctorsRow = safeGet(
    "SELECT COUNT(*) as c FROM users WHERE role = 'doctor' AND pending_approval = 1",
    [],
    { c: 0 }
  );
  const pendingDoctorsCount = (pendingDoctorsRow && pendingDoctorsRow.c) || 0;

  // KPI aggregates
  const completedValsKpi = statusDbValues('COMPLETED', ['completed']).map((v) => String(v).toLowerCase());
  const breachedValsKpi = uniqStrings([
    ...statusDbValues('BREACHED_SLA', ['breached']),
    ...statusDbValues('DELAYED', ['delayed'])
  ]).map((v) => String(v).toLowerCase());

  const completedIn = sqlIn('LOWER(o.status)', completedValsKpi);
  const breachedIn = sqlIn('LOWER(o.status)', breachedValsKpi);

  // Note: completedIn/breachedIn each include their own placeholders; we embed the clause text.
  const kpiSql = `
    SELECT
      COUNT(*) AS total_orders,
      COALESCE(SUM(o.price), 0) AS revenue,
      COALESCE(SUM(o.price - COALESCE(o.doctor_fee, 0)), 0) AS gross_profit,
      SUM(CASE WHEN ${completedIn.clause} THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN ${breachedIn.clause} THEN 1 ELSE 0 END) AS breached
    FROM orders o
    ${whereSql}
  `;
  const kpisFallback = {
    total_orders: 0,
    revenue: 0,
    gross_profit: 0,
    completed: 0,
    breached: 0
  };
  // IMPORTANT: SQLite binds parameters in the order the `?` placeholders appear in the SQL string.
  // In `kpiSql`, the placeholders inside completedIn/breachedIn (in the SELECT CASE expressions)
  // appear BEFORE the placeholders from `whereSql` (after FROM). So we must bind IN-clause params first.
  const kpiParams = [...completedIn.params, ...breachedIn.params, ...params];
  const kpis = safeGet(kpiSql, kpiParams, kpisFallback);

  // SLA Metrics
  const completedVals2 = statusDbValues('COMPLETED', ['completed']).map((v) => String(v).toLowerCase());
  const completedIn2 = sqlIn('LOWER(o.status)', completedVals2);

  const completedRows = safeAll(
    `
    SELECT accepted_at, completed_at, deadline_at
    FROM orders o
    ${whereSql ? whereSql + ' AND ' : 'WHERE '}
    ${completedIn2.clause}
  `,
    [...params, ...completedIn2.params],
    []
  );

  let onTimeCount = 0;
  let tatSumMinutes = 0;
  let tatCount = 0;

  completedRows.forEach((o) => {
    const accepted = o.accepted_at ? new Date(o.accepted_at) : null;
    const completed = o.completed_at ? new Date(o.completed_at) : null;
    const deadline = o.deadline_at ? new Date(o.deadline_at) : null;

    if (deadline && completed && completed <= deadline) {
      onTimeCount += 1;
    }

    if (accepted && completed) {
      const diffMs = completed - accepted;
      const diffMin = diffMs / 60000;
      if (!Number.isNaN(diffMin) && diffMin >= 0) {
        tatSumMinutes += diffMin;
        tatCount += 1;
      }
    }
  });

  const onTimePercent =
    completedRows.length > 0
      ? Math.round((onTimeCount * 100) / completedRows.length)
      : 0;

  const avgTatMinutes =
    tatCount > 0 ? Math.round(tatSumMinutes / tatCount) : null;

  // Revenue by specialty
  const { whereSql: revWhere, params: revParams } = buildFilters(query);
  const revJoinFilters = revWhere ? revWhere.replace('WHERE', 'AND') : '';

  const revBySpecSql = `
    SELECT
      s.id AS specialty_id,
      s.name AS name,
      COUNT(o.id) AS count,
      COALESCE(SUM(o.price), 0) AS revenue,
      COALESCE(SUM(o.price - COALESCE(o.doctor_fee, 0)), 0) AS gp
    FROM specialties s
    LEFT JOIN orders o ON o.specialty_id = s.id
      ${revJoinFilters}
    GROUP BY s.id, s.name
    HAVING COUNT(o.id) > 0
    ORDER BY revenue DESC
  `;
  const revenueBySpecialty = safeAll(revBySpecSql, revParams, []);

  // Latest events
  const eventsSql = `
    SELECT
      e.id,
      e.at,
      e.label,
      e.order_id,
      o.status,
      o.sla_hours
    FROM order_events e
    JOIN orders o ON o.id = e.order_id
    ${whereSql}
    ORDER BY e.at DESC
    LIMIT 15
  `;
  const events = safeAll(eventsSql, params, []);
  const eventsNormalized = (events || []).map((e) => ({ ...e, status: canonOrOriginal(e.status) }));

  // Recent orders with payment info
  const ordersListRaw = safeAll(
    `SELECT o.id, o.created_at, o.price, o.payment_status, o.payment_link, o.status, o.reassigned_count, o.deadline_at, o.completed_at,
            sv.name AS service_name, s.name AS specialty_name
     FROM orders o
     LEFT JOIN services sv ON sv.id = o.service_id
     LEFT JOIN specialties s ON s.id = o.specialty_id
     ${whereSql}
     ORDER BY o.created_at DESC
     LIMIT 20`,
    params,
    []
  );

  const ordersList = (ordersListRaw || []).map((o) => {
    enforceBreachIfNeeded(o);
    const computed = computeSla(o);
    const effective = canonOrOriginal(computed.effectiveStatus || o.status);
    const normalizedStatus = normalizeStatus(computed.effectiveStatus || o.status);
    let statusUi = null;
    try {
      statusUi = getStatusUi(normalizedStatus, { role: 'admin', lang: langCode });
    } catch (_) {
      statusUi = null;
    }

    // Payment is taken upfront in the product flow; avoid surfacing "unpaid" noise on the dashboard.
    // Keep the raw DB value available as `payment_status_raw` for debugging.
    const paymentStatusRaw = o.payment_status;
    const paymentStatus = paymentStatusRaw ? String(paymentStatusRaw) : null;
    const paymentStatusNormalized = paymentStatus ? paymentStatus.toLowerCase() : null;
    const payment_status_display = paymentStatusNormalized === 'unpaid' ? 'paid' : paymentStatusNormalized;

    return {
      ...o,
      status: effective,
      effectiveStatus: computed.effectiveStatus,
      normalizedStatus,
      sla: computed.sla,
      statusUi,
      payment_status_raw: paymentStatusRaw,
      payment_status: payment_status_display || paymentStatusRaw
    };
  });

  const slaRiskOrdersRaw = safeAll(
    `SELECT o.id, o.deadline_at, s.name AS specialty_name, u.name AS doctor_name,
            (julianday(o.deadline_at) - julianday('now')) * 24 AS hours_remaining
     FROM orders o
     LEFT JOIN specialties s ON s.id = o.specialty_id
     LEFT JOIN users u ON u.id = o.doctor_id
     WHERE o.deadline_at IS NOT NULL
       AND o.completed_at IS NULL
       AND (julianday(o.deadline_at) - julianday('now')) * 24 <= 24
       AND (julianday(o.deadline_at) - julianday('now')) * 24 >= 0
     ORDER BY o.deadline_at ASC
     LIMIT 10`,
    [],
    []
  );
  const slaRiskOrders = (slaRiskOrdersRaw || []).map((order) => ({
    ...order,
    hours_remaining: typeof order.hours_remaining === 'number'
      ? Math.max(0, Number(order.hours_remaining))
      : null
  }));

  const breachedVals3 = uniqStrings([
    ...statusDbValues('BREACHED_SLA', ['breached']),
    ...statusDbValues('DELAYED', ['delayed'])
  ]).map((v) => String(v).toLowerCase());
  const breachedIn3 = sqlIn('LOWER(o.status)', breachedVals3);

  const breachedOrders = safeAll(
    `SELECT o.id, o.breached_at, o.specialty_id, s.name AS specialty_name, u.name AS doctor_name
     FROM orders o
     LEFT JOIN specialties s ON s.id = o.specialty_id
     LEFT JOIN users u ON u.id = o.doctor_id
     WHERE ${breachedIn3.clause}
        OR (o.completed_at IS NOT NULL
            AND o.deadline_at IS NOT NULL
            AND datetime(o.completed_at) > datetime(o.deadline_at))
     ORDER BY COALESCE(o.breached_at, o.completed_at) DESC
     LIMIT 10`,
    breachedIn3.params,
    []
  );
  const totalBreached = (breachedOrders && breachedOrders.length) ? breachedOrders.length : 0;

  const notificationLog = tableExists('notifications')
    ? safeAll(
        `SELECT n.id, n.at, n.order_id, n.channel, n.template, n.status,
                COALESCE(u.name, n.to_user_id) AS doctor_name
         FROM notifications n
         LEFT JOIN users u ON u.id = n.to_user_id
         ORDER BY n.at DESC
         LIMIT 20`,
        [],
        []
      )
    : [];

  const slaEvents = tableExists('order_events')
    ? safeAll(
        `SELECT id, order_id, label, at
         FROM order_events
         WHERE LOWER(label) LIKE '%sla%'
            OR LOWER(label) LIKE '%reassign%'
         ORDER BY at DESC
         LIMIT 20`,
        [],
        []
      )
    : [];

  // Specialty list for filters
  const specialties = safeAll(
    'SELECT id, name FROM specialties ORDER BY name ASC',
    [],
    []
  );

  const totalOrders = kpis?.total_orders || 0;
  const completedCount = kpis?.completed || 0;
  const breachedCount = kpis?.breached || 0;
  const revenue = kpis?.revenue || 0;
  const grossProfit = kpis?.gross_profit || 0;

  // Pending additional-files requests (support inbox)
  const pendingFileRequests = getPendingAdditionalFilesRequests(25);
  const pendingFileRequestsCount = (pendingFileRequests && pendingFileRequests.length) ? pendingFileRequests.length : 0;
  const pendingFileRequestsAwaitingCount = (pendingFileRequests || []).filter((r) => r && r.pending).length;

  // Render page
  res.render('superadmin', {
    user: req.user,
    totalOrders,
    completedCount,
    breachedCount,
    revenue,
    grossProfit,
    onTimePercent,
    avgTatMinutes,
    revenueBySpecialty: revenueBySpecialty || [],
    events: eventsNormalized || [],
    ordersList: ordersList || [],
    slaRiskOrders,
    breachedOrders,
    totalBreached,
    notificationLog: notificationLog || [],
    slaEvents,
    specialties: specialties || [],
    pendingDoctorsCount,
    pendingFileRequests,
    pendingFileRequestsCount,
    pendingFileRequestsAwaitingCount,
    filters: {
      from,
      to,
      specialty
    }
  });
});

// New order form (superadmin)
router.get('/superadmin/orders/new', requireSuperadmin, (req, res) => {
  const patients = db
    .prepare("SELECT id, name, email FROM users WHERE role = 'patient'")
    .all();

  const doctors = db
    .prepare("SELECT id, name, email, specialty_id FROM users WHERE role = 'doctor'")
    .all();

  const specialties = db
    .prepare('SELECT id, name FROM specialties ORDER BY name')
    .all();

  const services = db
    .prepare('SELECT id, specialty_id, code, name, base_price, doctor_fee FROM services ORDER BY name')
    .all();

  const defaultService = services && services.length ? services[0] : null;

  res.render('superadmin_order_new', {
    user: req.user,
    patients,
    doctors,
    specialties,
    services,
    defaults: {
      sla_hours: 72,
      price: defaultService ? defaultService.base_price : undefined,
      doctor_fee: defaultService ? defaultService.doctor_fee : undefined
    },
    error: null
  });
});

// Create manual order (superadmin)
router.post('/superadmin/orders', requireSuperadmin, (req, res) => {
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
    const patients = db
      .prepare("SELECT id, name, email FROM users WHERE role = 'patient'")
      .all();
    const doctors = db
      .prepare("SELECT id, name, email, specialty_id FROM users WHERE role = 'doctor'")
      .all();
    const specialties = db
      .prepare('SELECT id, name FROM specialties ORDER BY name')
      .all();
    const services = db
      .prepare('SELECT id, specialty_id, code, name FROM services ORDER BY name')
      .all();

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

  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(service_id);
  const orderPrice = price ? Number(price) : service ? service.base_price : null;
  const orderDoctorFee = doctor_fee ? Number(doctor_fee) : service ? service.doctor_fee : null;
  const orderPaymentLink = service ? service.payment_link : null;
  const orderCurrency = service ? service.currency || 'EGP' : 'EGP';
  const selectedDoctor = doctor_id
    ? db.prepare("SELECT id, name, email, phone FROM users WHERE id = ? AND role = 'doctor'").get(doctor_id)
    : null;
  const autoDoctor = !doctor_id ? pickDoctorForOrder({ specialtyId: specialty_id }) : null;
  const chosenDoctor = selectedDoctor || autoDoctor;
  const status = chosenDoctor ? 'accepted' : 'new';
  const acceptedAt = chosenDoctor ? createdAt : null;

  db.prepare(
    `INSERT INTO orders (
      id, patient_id, doctor_id, specialty_id, service_id,
      sla_hours, status, price, doctor_fee,
      created_at, accepted_at, deadline_at, completed_at,
      breached_at, reassigned_count, report_url, notes,
      payment_status, payment_method, payment_reference, payment_link
    ) VALUES (
      @id, @patient_id, @doctor_id, @specialty_id, @service_id,
      @sla_hours, @status, @price, @doctor_fee,
      @created_at, @accepted_at, @deadline_at, NULL,
      NULL, 0, NULL, @notes,
      @payment_status, @payment_method, @payment_reference, @payment_link
    )`
  ).run({
    id: orderId,
    patient_id,
    doctor_id: chosenDoctor ? chosenDoctor.id : null,
    specialty_id,
    service_id,
    sla_hours: Number(sla_hours),
    status,
    price: orderPrice,
    doctor_fee: orderDoctorFee,
    created_at: createdAt,
    accepted_at: acceptedAt,
    deadline_at: chosenDoctor ? deadline : null,
    notes: notes || null,
    payment_status: 'paid',
    payment_method: null,
    payment_reference: null,
    payment_link: orderPaymentLink
  });

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
    queueNotification({
      orderId,
      toUserId: chosenDoctor.id,
      channel: 'internal',
      template: 'order_assigned_doctor',
      status: 'queued'
    });
    if (selectedDoctor) {
      doctorNotify({ doctor: selectedDoctor, template: 'order_assigned_doctor', order: { id: orderId } });
    }
    if (autoDoctor) {
      queueNotification({
        orderId,
        toUserId: autoDoctor.id,
        channel: 'internal',
        template: 'order_auto_assigned_doctor',
        status: 'queued'
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

  return res.redirect('/superadmin?created=1');
});

// Order detail (superadmin)
router.get('/superadmin/orders/:id', requireSuperadmin, (req, res) => {
  const orderId = req.params.id;
  const order = db
    .prepare(
      `SELECT o.*,
              p.name AS patient_name, p.email AS patient_email,
              d.name AS doctor_name, d.email AS doctor_email,
              s.name AS specialty_name,
              sv.name AS service_name,
              sv.base_price AS service_price,
              sv.doctor_fee AS service_doctor_fee,
              sv.currency AS service_currency,
              sv.payment_link AS service_payment_link
       FROM orders o
       LEFT JOIN users p ON p.id = o.patient_id
       LEFT JOIN users d ON d.id = o.doctor_id
       LEFT JOIN specialties s ON s.id = o.specialty_id
       LEFT JOIN services sv ON sv.id = o.service_id
       WHERE o.id = ?`
    )
    .get(orderId);

  if (!order) {
    return res.redirect('/superadmin');
  }

  const events = db
    .prepare(
      `SELECT id, label, meta, at
       FROM order_events
       WHERE order_id = ?
       ORDER BY at DESC
       LIMIT 20`
    )
    .all(orderId);

  const doctors = db
    .prepare("SELECT id, name FROM users WHERE role = 'doctor' AND is_active = 1 ORDER BY name ASC")
    .all();

  const displayPrice = order.price != null ? order.price : order.service_price;
  const displayDoctorFee = order.doctor_fee != null ? order.doctor_fee : order.service_doctor_fee;
  const displayCurrency = order.currency || order.service_currency || 'EGP';
  const paymentLink = order.payment_link || order.service_payment_link || null;

  const additionalFilesRequest = computeAdditionalFilesRequestState(orderId);
  const langCode = (req.user && req.user.lang) ? req.user.lang : 'en';

  return res.render('superadmin_order_detail', {
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
router.post('/superadmin/orders/:id/additional-files/approve', requireSuperadmin, (req, res) => {
  const orderId = req.params.id;
  const { request_event_id, support_note } = req.body || {};

  const order = db.prepare('SELECT id, patient_id, status FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.redirect('/superadmin');

  const nowIso = new Date().toISOString();

  // Move order into an "awaiting files" lane (do not override completed)
  db.prepare(
    `UPDATE orders
     SET status = CASE WHEN status = 'completed' THEN status ELSE 'awaiting_files' END,
         updated_at = ?
     WHERE id = ?`
  ).run(nowIso, orderId);

  db.prepare(
    `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    orderId,
    'Additional files request approved (superadmin)',
    JSON.stringify({ request_event_id: request_event_id || null, support_note: support_note || null }),
    nowIso,
    req.user.id,
    'superadmin'
  );

  // Notify patient AFTER approval (routing rule)
  if (order.patient_id) {
    queueNotification({
      orderId,
      toUserId: order.patient_id,
      channel: 'internal',
      template: 'additional_files_requested_patient',
      status: 'queued'
    });
  }

  return res.redirect(`/superadmin/orders/${orderId}?additional_files=approved`);
});

router.post('/superadmin/orders/:id/additional-files/reject', requireSuperadmin, (req, res) => {
  const orderId = req.params.id;
  const { request_event_id, support_note } = req.body || {};

  const order = db.prepare('SELECT id, patient_id FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.redirect('/superadmin');

  const nowIso = new Date().toISOString();

  db.prepare(
    `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    orderId,
    'Additional files request rejected (superadmin)',
    JSON.stringify({ request_event_id: request_event_id || null, support_note: support_note || null }),
    nowIso,
    req.user.id,
    'superadmin'
  );

  return res.redirect(`/superadmin/orders/${orderId}?additional_files=rejected`);
});

// DOCTOR MANAGEMENT
router.get('/superadmin/doctors', requireSuperadmin, (req, res) => {
  const statusFilter = req.query.status || 'all';
  const conditions = ["u.role = 'doctor'"];
  if (statusFilter === 'pending') {
    conditions.push('u.pending_approval = 1');
  } else if (statusFilter === 'approved') {
    conditions.push('u.pending_approval = 0');
    conditions.push('u.is_active = 1');
  } else if (statusFilter === 'rejected') {
    conditions.push('u.pending_approval = 0');
    conditions.push('u.is_active = 0');
    conditions.push('u.rejection_reason IS NOT NULL');
  } else if (statusFilter === 'inactive') {
    conditions.push('u.is_active = 0');
  }

  const doctors = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.phone, u.notify_whatsapp, u.is_active, u.created_at, u.specialty_id,
              u.pending_approval, u.approved_at, u.rejection_reason, u.signup_notes,
              s.name AS specialty_name
       FROM users u
       LEFT JOIN specialties s ON s.id = u.specialty_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY u.pending_approval DESC, u.is_active DESC, u.created_at DESC`
    )
    .all();
  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  const pendingDoctorsRow = db
    .prepare("SELECT COUNT(*) as c FROM users WHERE role = 'doctor' AND pending_approval = 1")
    .get();
  const pendingDoctorsCount = pendingDoctorsRow ? pendingDoctorsRow.c : 0;
  res.render('superadmin_doctors', { user: req.user, doctors, specialties, statusFilter, pendingDoctorsCount });
});

router.get('/superadmin/doctors/new', requireSuperadmin, (req, res) => {
  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  const subSpecialties = db
    .prepare('SELECT id, specialty_id, name FROM services WHERE specialty_id IS NOT NULL ORDER BY name ASC')
    .all();

  res.render('superadmin_doctor_form', {
    user: req.user,
    specialties,
    subSpecialties,
    selectedServiceIds: [],
    error: null,
    doctor: null,
    isEdit: false
  });
});

router.post('/superadmin/doctors/new', requireSuperadmin, (req, res) => {
  const { name, email, specialty_id, phone, notify_whatsapp, is_active, service_ids } = req.body || {};
  if (!name || !email) {
    const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
    const subSpecialties = db
      .prepare('SELECT id, specialty_id, name FROM services WHERE specialty_id IS NOT NULL ORDER BY name ASC')
      .all();
    const selectedServiceIds = Array.isArray(service_ids) ? service_ids : (service_ids ? [service_ids] : []);
    return res.status(400).render('superadmin_doctor_form', {
      user: req.user,
      specialties,
      subSpecialties,
      selectedServiceIds,
      error: 'Name and email are required.',
      doctor: { name, email, specialty_id, phone, notify_whatsapp, is_active },
      isEdit: false
    });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
    const subSpecialties = db
      .prepare('SELECT id, specialty_id, name FROM services WHERE specialty_id IS NOT NULL ORDER BY name ASC')
      .all();
    const selectedServiceIds = Array.isArray(service_ids) ? service_ids : (service_ids ? [service_ids] : []);
    return res.status(400).render('superadmin_doctor_form', {
      user: req.user,
      specialties,
      subSpecialties,
      selectedServiceIds,
      error: 'Email already exists.',
      doctor: { name, email, specialty_id, phone, notify_whatsapp, is_active },
      isEdit: false
    });
  }

  const password_hash = hash('Doctor123!');
  const newDoctorId = randomUUID();
  db.prepare(
    `INSERT INTO users (id, email, password_hash, name, role, specialty_id, phone, lang, notify_whatsapp, is_active)
     VALUES (?, ?, ?, ?, 'doctor', ?, ?, 'en', ?, ?)`
  ).run(
    newDoctorId,
    email,
    password_hash,
    name,
    specialty_id || null,
    phone || null,
    notify_whatsapp ? 1 : 0,
    is_active ? 1 : 0
  );

  // Map selected sub-specialties (services) to the doctor
  const rawServiceIds = Array.isArray(service_ids) ? service_ids : (service_ids ? [service_ids] : []);
  const cleanedServiceIds = rawServiceIds.map((v) => String(v || '').trim()).filter(Boolean);

  if (cleanedServiceIds.length && specialty_id) {
    const ph = cleanedServiceIds.map(() => '?').join(',');
    const allowed = db
      .prepare(`SELECT id FROM services WHERE id IN (${ph}) AND specialty_id = ?`)
      .all(...cleanedServiceIds, specialty_id)
      .map((r) => r.id);

    const ins = db.prepare('INSERT OR IGNORE INTO doctor_services (doctor_id, service_id) VALUES (?, ?)');
    allowed.forEach((sid) => ins.run(newDoctorId, sid));
  }

  return res.redirect('/superadmin/doctors');
});

router.get('/superadmin/doctors/:id/edit', requireSuperadmin, (req, res) => {
  const doctor = db
    .prepare("SELECT * FROM users WHERE id = ? AND role = 'doctor'")
    .get(req.params.id);
  if (!doctor) return res.redirect('/superadmin/doctors');
  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  const subSpecialties = db
    .prepare('SELECT id, specialty_id, name FROM services WHERE specialty_id IS NOT NULL ORDER BY name ASC')
    .all();
  const selectedServiceIds = db
    .prepare('SELECT service_id FROM doctor_services WHERE doctor_id = ?')
    .all(req.params.id)
    .map((r) => r.service_id);
  res.render('superadmin_doctor_form', { user: req.user, specialties, subSpecialties, selectedServiceIds, error: null, doctor, isEdit: true });
});

router.post('/superadmin/doctors/:id/edit', requireSuperadmin, (req, res) => {
  const doctor = db
    .prepare("SELECT * FROM users WHERE id = ? AND role = 'doctor'")
    .get(req.params.id);
  if (!doctor) return res.redirect('/superadmin/doctors');
  const { name, specialty_id, phone, notify_whatsapp, is_active, service_ids } = req.body || {};
  db.prepare(
    `UPDATE users
     SET name = ?, specialty_id = ?, phone = ?, notify_whatsapp = ?, is_active = ?
     WHERE id = ? AND role = 'doctor'`
  ).run(
    name || doctor.name,
    specialty_id || null,
    phone || null,
    notify_whatsapp ? 1 : 0,
    is_active ? 1 : 0,
    req.params.id
  );
  // Refresh sub-specialties (services) mapping
  try {
    db.prepare('DELETE FROM doctor_services WHERE doctor_id = ?').run(req.params.id);

    const rawServiceIds = Array.isArray(service_ids) ? service_ids : (service_ids ? [service_ids] : []);
    const cleanedServiceIds = rawServiceIds.map((v) => String(v || '').trim()).filter(Boolean);

    if (cleanedServiceIds.length && specialty_id) {
      const ph = cleanedServiceIds.map(() => '?').join(',');
      const allowed = db
        .prepare(`SELECT id FROM services WHERE id IN (${ph}) AND specialty_id = ?`)
        .all(...cleanedServiceIds, specialty_id)
        .map((r) => r.id);

      const ins = db.prepare('INSERT OR IGNORE INTO doctor_services (doctor_id, service_id) VALUES (?, ?)');
      allowed.forEach((sid) => ins.run(req.params.id, sid));
    }
  } catch (_) {
    // no-op
  }
  return res.redirect('/superadmin/doctors');
});

router.post('/superadmin/doctors/:id/toggle', requireSuperadmin, (req, res) => {
  const doctorId = req.params.id;
  db.prepare(
    `UPDATE users
     SET is_active = CASE is_active WHEN 1 THEN 0 ELSE 1 END
     WHERE id = ? AND role = 'doctor'`
  ).run(doctorId);
  return res.redirect('/superadmin/doctors');
});

// Doctor detail (approval)
router.get('/superadmin/doctors/:id', requireSuperadmin, (req, res) => {
  const doctorId = req.params.id;
  const doctor = db
    .prepare(
      `SELECT u.*, s.name AS specialty_name
       FROM users u
       LEFT JOIN specialties s ON s.id = u.specialty_id
       WHERE u.id = ? AND u.role = 'doctor'`
    )
    .get(doctorId);
  if (!doctor) return res.redirect('/superadmin/doctors');
  const pendingDoctorsRow = db
    .prepare("SELECT COUNT(*) as c FROM users WHERE role = 'doctor' AND pending_approval = 1")
    .get();
  const pendingDoctorsCount = pendingDoctorsRow ? pendingDoctorsRow.c : 0;
  res.render('superadmin_doctor_detail', { user: req.user, doctor, pendingDoctorsCount });
});

router.post('/superadmin/doctors/:id/approve', requireSuperadmin, (req, res) => {
  const doctorId = req.params.id;
  const doctor = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'doctor'").get(doctorId);
  if (!doctor) return res.redirect('/superadmin/doctors');
  const nowIso = new Date().toISOString();
  db.prepare(
    `UPDATE users
     SET pending_approval = 0,
         is_active = 1,
         approved_at = ?,
         rejection_reason = NULL
     WHERE id = ? AND role = 'doctor'`
  ).run(nowIso, doctorId);

  queueNotification({
    orderId: null,
    toUserId: doctorId,
    channel: 'internal',
    template: 'doctor_approved',
    status: 'queued'
  });

  return res.redirect(`/superadmin/doctors/${doctorId}`);
});

router.post('/superadmin/doctors/:id/reject', requireSuperadmin, (req, res) => {
  const doctorId = req.params.id;
  const doctor = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'doctor'").get(doctorId);
  if (!doctor) return res.redirect('/superadmin/doctors');
  const { rejection_reason } = req.body || {};
  db.prepare(
    `UPDATE users
     SET pending_approval = 0,
         is_active = 0,
         approved_at = NULL,
         rejection_reason = ?
     WHERE id = ? AND role = 'doctor'`
  ).run(rejection_reason || 'Not approved', doctorId);

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
router.get('/superadmin/services', requireSuperadmin, (req, res) => {
  // Ensure the column exists so the UI can reliably render visibility.
  ensureServicesVisibilityColumn();

  const cols = getServicesTableColumns();
  const hasVisible = cols.includes('is_visible');

  const services = db
    .prepare(
      `SELECT sv.id, sv.name, sv.code, sv.base_price, sv.doctor_fee, sv.currency, sv.payment_link,
              ${hasVisible ? 'sv.is_visible' : '1 AS is_visible'},
              sp.name AS specialty_name
       FROM services sv
       LEFT JOIN specialties sp ON sp.id = sv.specialty_id
       ORDER BY specialty_name ASC, sv.name ASC`
    )
    .all();

  const normalized = (services || []).map((s) => ({
    ...s,
    is_visible: Number(s && s.is_visible != null ? s.is_visible : 1) ? 1 : 0
  }));

  return res.render('superadmin_services', { user: req.user, services: normalized });
});

router.get('/superadmin/services/new', requireSuperadmin, (req, res) => {
  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  res.render('superadmin_service_form', { user: req.user, specialties, error: null, service: {}, isEdit: false });
});

router.post('/superadmin/services/new', requireSuperadmin, (req, res) => {
  const { name, code, specialty_id, base_price, doctor_fee, currency, payment_link } = req.body || {};
  if (!name || !specialty_id) {
    const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
    return res.status(400).render('superadmin_service_form', {
      user: req.user,
      specialties,
      error: 'Name and specialty are required.',
      service: req.body,
      isEdit: false
    });
  }
  db.prepare(
    `INSERT INTO services (id, name, code, specialty_id, base_price, doctor_fee, currency, payment_link)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    name,
    code || null,
    specialty_id || null,
    base_price ? Number(base_price) : null,
    doctor_fee ? Number(doctor_fee) : null,
    currency || 'EGP',
    payment_link || null
  );
  return res.redirect('/superadmin/services');
});

router.get('/superadmin/services/:id/edit', requireSuperadmin, (req, res) => {
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
  if (!service) return res.redirect('/superadmin/services');
  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  res.render('superadmin_service_form', { user: req.user, service, specialties, error: null, isEdit: true });
});

router.post('/superadmin/services/:id/edit', requireSuperadmin, (req, res) => {
  const { name, code, specialty_id, base_price, doctor_fee, currency, payment_link } = req.body || {};
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
  if (!service) return res.redirect('/superadmin/services');
  if (!name || !specialty_id) {
    const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
    return res.status(400).render('superadmin_service_form', {
      user: req.user,
      service: { ...service, ...req.body },
      specialties,
      error: 'Name and specialty are required.',
      isEdit: true
    });
  }
  db.prepare(
    `UPDATE services
     SET name=?, code=?, specialty_id=?, base_price=?, doctor_fee=?, currency=?, payment_link=?
     WHERE id=?`
  ).run(
    name,
    code || null,
    specialty_id || null,
    base_price ? Number(base_price) : null,
    doctor_fee ? Number(doctor_fee) : null,
    currency || 'EGP',
    payment_link || null,
    req.params.id
  );
  return res.redirect('/superadmin/services');
});

// PAYMENT FLOW
router.get('/superadmin/orders/:id/payment', requireSuperadmin, (req, res) => {
  const order = loadOrderWithPatient(req.params.id);
  if (!order) return res.redirect('/superadmin');
  const methods = ['cash', 'card', 'bank_transfer', 'online_link'];
  res.render('superadmin_order_payment', { user: req.user, order, methods });
});

router.post('/superadmin/orders/:id/mark-paid', requireSuperadmin, (req, res) => {
  const orderId = String((req.params && req.params.id) || '').trim();
  if (!orderId) return res.redirect('/superadmin');

  const order = loadOrderWithPatient(orderId);
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
    db.prepare(
      `UPDATE orders
       SET payment_status = 'paid',
           payment_method = ?,
           payment_reference = ?,
           paid_at = COALESCE(paid_at, ?),
           updated_at = ?
       WHERE id = ?`
    ).run(method, reference, nowIso, nowIso, orderId);
  } catch (_) {
    // Non-blocking: if schema differs, fall back to minimal update.
    try {
      db.prepare(
        `UPDATE orders
         SET payment_status = 'paid',
             updated_at = ?
         WHERE id = ?`
      ).run(nowIso, orderId);
    } catch (__) {
      return res.redirect(`/superadmin/orders/${orderId}?payment=failed`);
    }
  }

  // Transition to "new" if the order was in an awaiting-payment style state (conservative).
  try {
    const currentStatus = String(order.status || '').toLowerCase();
    if (['awaiting_payment', 'pending_payment', 'unpaid', 'payment_pending'].includes(currentStatus)) {
      db.prepare(
        `UPDATE orders
         SET status = 'new',
             updated_at = ?
         WHERE id = ?`
      ).run(nowIso, orderId);
    }
  } catch (_) {}

  // If no doctor assigned yet, attempt auto-assign (best-effort).
  try {
    const fresh = safeGet(
      `SELECT id, doctor_id, specialty_id, service_id, status, payment_status
       FROM orders
       WHERE id = ?`,
      [orderId],
      null
    );

    const doctorId = fresh && fresh.doctor_id ? String(fresh.doctor_id) : '';
    const pay = fresh && fresh.payment_status ? String(fresh.payment_status).toLowerCase() : '';
    if (!doctorId && pay === 'paid') {
      const picked = pickDoctorForOrder(fresh);
      const pickedId = picked && picked.id ? String(picked.id) : (picked ? String(picked) : '');
      if (pickedId) {
        db.prepare(
          `UPDATE orders
           SET doctor_id = ?,
               updated_at = ?
           WHERE id = ?`
        ).run(pickedId, nowIso, orderId);

        logOrderEvent({
          orderId,
          label: `Order auto-assigned to doctor ${pickedId} after payment marked paid (superadmin)`,
          actorRole: 'system'
        });

        queueNotification({
          orderId,
          toUserId: pickedId,
          channel: 'internal',
          template: 'new_case_assigned_doctor',
          status: 'queued'
        });
      }
    }
  } catch (_) {}

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

  // Optional consistency sweep.
  try { runSlaSweep(); } catch (_) {}

  return res.redirect(`/superadmin/orders/${orderId}?payment=paid`);
});

router.post('/superadmin/orders/:id/mark-unpaid', requireSuperadmin, (req, res) => {
  const orderId = String((req.params && req.params.id) || '').trim();
  if (!orderId) return res.redirect('/superadmin');

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.redirect('/superadmin');

  const nowIso = new Date().toISOString();

  // Idempotent: if already unpaid, don't spam events.
  const current = String(order.payment_status || '').toLowerCase();
  if (current === 'unpaid') {
    return res.redirect(`/superadmin/orders/${orderId}`);
  }

  // Best-effort: clear paid_at if column exists; otherwise fall back.
  try {
    db.prepare(
      `UPDATE orders
       SET payment_status = 'unpaid',
           payment_method = NULL,
           payment_reference = NULL,
           paid_at = NULL,
           updated_at = ?
       WHERE id = ?`
    ).run(nowIso, orderId);
  } catch (_) {
    db.prepare(
      `UPDATE orders
       SET payment_status = 'unpaid',
           payment_method = NULL,
           payment_reference = NULL,
           updated_at = ?
       WHERE id = ?`
    ).run(nowIso, orderId);
  }

  db.prepare(
    `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    orderId,
    'Payment marked as unpaid (superadmin)',
    JSON.stringify({ from: order.payment_status || 'paid', to: 'unpaid' }),
    nowIso,
    req.user.id,
    'superadmin'
  );

  return res.redirect(`/superadmin/orders/${orderId}`);
});

// Unified payment update handler
router.post('/superadmin/orders/:id/payment', requireSuperadmin, (req, res) => {
  const orderId = req.params.id;
  const { payment_status, payment_method, payment_reference } = req.body || {};
  const allowed = ['unpaid', 'paid', 'refunded'];

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.redirect('/superadmin');

  const status = allowed.includes(payment_status) ? payment_status : order.payment_status;
  const nowIso = new Date().toISOString();

  db.prepare(
    `UPDATE orders
     SET payment_status = ?,
         payment_method = ?,
         payment_reference = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(status, payment_method || null, payment_reference || null, nowIso, orderId);

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
router.post('/superadmin/orders/:id/reassign', requireSuperadmin, (req, res) => {
  const orderId = req.params.id;
  const { doctor_id: newDoctorId } = req.body || {};

  const order = db
    .prepare(
      `SELECT o.*, d.name AS doctor_name
       FROM orders o
       LEFT JOIN users d ON d.id = o.doctor_id
       WHERE o.id = ?`
    )
    .get(orderId);

  if (!order || !newDoctorId) {
    return res.redirect(`/superadmin/orders/${orderId}`);
  }

  const newDoctor = db
    .prepare("SELECT id, name FROM users WHERE id = ? AND role = 'doctor' AND is_active = 1")
    .get(newDoctorId);
  if (!newDoctor) {
    return res.redirect(`/superadmin/orders/${orderId}`);
  }

  if (order.doctor_id === newDoctor.id) {
    return res.redirect(`/superadmin/orders/${orderId}`);
  }

  db.prepare(
    `UPDATE orders
     SET doctor_id = ?,
         reassigned_count = COALESCE(reassigned_count,0) + 1,
         updated_at = ?
     WHERE id = ?`
  ).run(newDoctor.id, new Date().toISOString(), orderId);

  logOrderEvent({
    orderId,
    label: `Order reassigned from ${order.doctor_name || order.doctor_id || 'Unassigned'} to ${newDoctor.name} by superadmin`,
    actorUserId: req.user.id,
    actorRole: req.user.role
  });

  queueNotification({
    orderId,
    toUserId: newDoctor.id,
    channel: 'internal',
    template: 'order_reassigned_doctor',
    status: 'queued'
  });

  return res.redirect(`/superadmin/orders/${orderId}`);
});

router.get('/superadmin/run-sla-check', requireSuperadmin, (req, res) => {
  const summary = performSlaCheck();
  const text = `SLA check completed: ${summary.preBreachWarnings} pre-breach warnings, ${summary.breached} breached, ${summary.reassigned} reassigned, ${summary.noDoctor} without doctor.`;

  if ((req.query && req.query.format === 'json') || (req.accepts('json') && !req.accepts('html'))) {
    return res.json(summary);
  }
  return res.send(text);
});

router.get('/superadmin/tools/run-sla-check', requireSuperadmin, (req, res) => {
  performSlaCheck();
  return res.redirect('/superadmin');
});

router.post('/superadmin/sla/recalc', requireSuperadmin, (req, res) => {
  try {
    recalcSlaBreaches();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('SLA recalc failed', err);
  }
  return res.redirect('/superadmin');
});

router.get('/superadmin/tools/run-sla-sweep', requireSuperadmin, (req, res) => {
  runSlaSweep(new Date());
  return res.redirect('/superadmin?sla_ran=1');
});

router.get('/superadmin/debug/reset-link/:userId', requireSuperadmin, (req, res) => {
  const userId = req.params.userId;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).send('User not found');

  const token = uuidv4();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO password_reset_tokens (id, user_id, token, expires_at, used_at, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`
  ).run(uuidv4(), user.id, token, expiresAt, now.toISOString());

  const baseUrl = String(process.env.BASE_URL || '').trim() || (() => {
    try {
      const protoRaw = (req.get('x-forwarded-proto') || req.protocol || 'http');
      const proto = String(protoRaw).split(',')[0].trim() || 'http';
      const host = req.get('x-forwarded-host') || req.get('host');
      return host ? `${proto}://${host}` : '';
    } catch (_) {
      return '';
    }
  })();

  // Prefer absolute URLs when possible; never default to localhost.
  const url = baseUrl ? `${baseUrl}/reset-password/${token}` : `/reset-password/${token}`;

  if (!IS_PROD) {
    // eslint-disable-next-line no-console
    console.log('[RESET LINK DEBUG]', url);
  }

  return res.send(`Reset link: ${url}`);
});

// Global events view
router.get('/superadmin/events', requireSuperadmin, (req, res) => {
  const { role, label, order_id, from, to } = req.query || {};
  const where = [];
  const params = [];

  if (role && role !== 'all') {
    where.push('e.actor_role = ?');
    params.push(role);
  }
  if (label && label.trim()) {
    where.push('e.label LIKE ?');
    params.push(`%${label.trim()}%`);
  }
  if (order_id && order_id.trim()) {
    where.push('e.order_id = ?');
    params.push(order_id.trim());
  }
  if (from && from.trim()) {
    where.push('DATE(e.at) >= DATE(?)');
    params.push(from.trim());
  }
  if (to && to.trim()) {
    where.push('DATE(e.at) <= DATE(?)');
    params.push(to.trim());
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const events = db
    .prepare(
      `SELECT e.*, o.specialty_id, o.service_id,
              d.name AS doctor_name, p.name AS patient_name
       FROM order_events e
       LEFT JOIN orders o ON o.id = e.order_id
       LEFT JOIN users d ON d.id = o.doctor_id
       LEFT JOIN users p ON p.id = o.patient_id
       ${whereSql}
       ORDER BY e.at DESC
       LIMIT 100`
    )
    .all(...params);

  res.render('superadmin_events', {
    user: req.user,
    events,
    filters: { role: role || 'all', label: label || '', order_id: order_id || '', from: from || '', to: to || '' }
  });
});

module.exports = { router, buildFilters };
