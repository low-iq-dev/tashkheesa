// src/routes/superadmin.js
const express = require('express');
const { queryOne, queryAll, execute, withTransaction } = require('../pg');
const { randomUUID } = require('crypto');
const { hash } = require('../auth');
const { requireRole } = require('../middleware');
const { queueNotification, queueMultiChannelNotification, doctorNotify } = require('../notify');
const { getNotificationTitles } = require('../notify/notification_titles');
const { runSlaSweep } = require('../sla_watcher');
const { logOrderEvent } = require('../audit');
const { computeSla, enforceBreachIfNeeded } = require('../sla_status');
const { pickDoctorForOrder } = require('../assign');
const { recalcSlaBreaches } = require('../sla');
const { randomUUID: uuidv4 } = require('crypto');
const { safeAll, safeGet, tableExists } = require('../sql-utils');
const { ensureConversation } = require('./messaging');
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
  const slaStatuses = uniqStrings([
    ...statusDbValues('ACCEPTED', ['accepted']),
    ...statusDbValues('IN_REVIEW', ['in_review']),
    ...statusDbValues('AWAITING_FILES', ['awaiting_files'])
  ]);
  const inSql = sqlIn('o.status', slaStatuses);

  return await queryAll(
    `SELECT o.*, d.name AS doctor_name
     FROM orders o
     LEFT JOIN users d ON d.id = o.doctor_id
     WHERE ${inSql.clause}
       AND o.accepted_at IS NOT NULL
       AND o.completed_at IS NULL
       AND o.deadline_at IS NOT NULL`,
    inSql.params
  );
}

async function countOpenCasesForDoctor(doctorId) {
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
     FROM orders
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
  const summary = {
    preBreachWarnings: 0,
    breached: 0,
    reassigned: 0,
    noDoctor: 0
  };

  const orders = await selectSlaRelevantOrders();
  const superadmins = await getActiveSuperadmins();
  const nowIso = now.toISOString();

  for (const order of orders) {
    if (!order.deadline_at) continue;

    const deadline = new Date(order.deadline_at);
    const msToDeadline = deadline - now;

    // Breach handling
    if (msToDeadline <= 0) {
      await execute(
        `UPDATE orders
         SET status = 'breached',
             breached_at = $1,
             updated_at = $2
         WHERE id = $3`,
        [nowIso, nowIso, order.id]
      );

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
      const alternateDoctor = await findBestAlternateDoctor(order.specialty_id, order.doctor_id);
      if (!alternateDoctor) {
        logOrderEvent({
          orderId: order.id,
          label: 'No available doctor to reassign case',
          actorRole: 'system'
        });
        summary.noDoctor += 1;
        continue;
      }

      await execute(
        `UPDATE orders
         SET doctor_id = $1,
             status = 'new',
             accepted_at = NULL,
             deadline_at = NULL,
             reassigned_count = COALESCE(reassigned_count, 0) + 1,
             updated_at = $2
         WHERE id = $3`,
        [alternateDoctor.id, nowIso, order.id]
      );

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
      queueMultiChannelNotification({
        orderId: order.id,
        toUserId: alternateDoctor.id,
        channels: ['internal', 'email', 'whatsapp'],
        template: 'order_reassigned_to_doctor',
        response: { case_id: order.id, caseReference: order.id.slice(0, 12).toUpperCase() },
        dedupe_key: 'order_reassigned_to:' + order.id + ':' + alternateDoctor.id
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
        queueMultiChannelNotification({
          orderId: order.id,
          toUserId: order.patient_id,
          channels: ['internal', 'email', 'whatsapp'],
          template: 'order_reassigned_patient',
          response: { case_id: order.id, caseReference: order.id.slice(0, 12).toUpperCase() },
          dedupe_key: 'order_reassigned:' + order.id + ':patient'
        });
      }
      summary.reassigned += 1;
      continue;
    }

    // Pre-breach warning (within 60 minutes)
    if (msToDeadline <= 60 * 60 * 1000 && !order.pre_breach_notified) {
      await execute(
        `UPDATE orders
         SET pre_breach_notified = true,
             updated_at = $1
         WHERE id = $2`,
        [nowIso, order.id]
      );

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
  }

  return summary;
}

async function loadOrderWithPatient(orderId) {
  return await queryOne(
    `SELECT o.id, o.status, o.payment_status, o.payment_method, o.payment_reference, o.price, o.currency,
            o.patient_id, u.name AS patient_name, u.email AS patient_email
     FROM orders o
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

// Finds the most recent "doctor requested additional files" style event.
// We keep this fuzzy on purpose to avoid coupling to one exact label.
function getLatestAdditionalFilesRequestEvent(orderId) {
  return safeGet(
    `SELECT id, label, meta, at, actor_user_id, actor_role
     FROM order_events
     WHERE order_id = $1
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
     WHERE order_id = $1
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

  const rows = await safeAll(
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
router.get('/superadmin', requireSuperadmin, async (req, res) => {
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

  const overdueOrders = await safeAll(
    `SELECT id, status, deadline_at, completed_at
     FROM orders
     WHERE ${notInSql.clause}
       AND completed_at IS NULL
       AND deadline_at IS NOT NULL
       AND deadline_at::timestamptz < NOW()`,
    notInSql.params,
    []
  );
  for (const o of overdueOrders) { enforceBreachIfNeeded(o); }

  const { whereSql, params } = buildFilters(query);
  const pendingDoctorsRow = await safeGet(
    "SELECT COUNT(*) as c FROM users WHERE role = 'doctor' AND pending_approval = true",
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
  // PostgreSQL numbered placeholders -- completedIn/breachedIn placeholders appear
  // BEFORE the placeholders from `whereSql` (after FROM). So we bind IN-clause params first.
  const kpiParams = [...completedIn.params, ...breachedIn.params, ...params];
  const kpis = await safeGet(kpiSql, kpiParams, kpisFallback);

  // SLA Metrics
  const completedVals2 = statusDbValues('COMPLETED', ['completed']).map((v) => String(v).toLowerCase());
  const completedIn2 = sqlIn('LOWER(o.status)', completedVals2);

  const completedRows = await safeAll(
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
  const revenueBySpecialty = await safeAll(revBySpecSql, revParams, []);

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
  const events = await safeAll(eventsSql, params, []);
  const eventsNormalized = (events || []).map((e) => ({ ...e, status: canonOrOriginal(e.status) }));

  // Recent orders with payment info
  const ordersListRaw = await safeAll(
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

  const slaRiskOrdersRaw = await safeAll(
    `SELECT o.id, o.deadline_at, s.name AS specialty_name, u.name AS doctor_name,
            EXTRACT(EPOCH FROM (o.deadline_at::timestamptz - NOW())) / 3600 AS hours_remaining
     FROM orders o
     LEFT JOIN specialties s ON s.id = o.specialty_id
     LEFT JOIN users u ON u.id = o.doctor_id
     WHERE o.deadline_at IS NOT NULL
       AND o.completed_at IS NULL
       AND EXTRACT(EPOCH FROM (o.deadline_at::timestamptz - NOW())) / 3600 <= 24
       AND EXTRACT(EPOCH FROM (o.deadline_at::timestamptz - NOW())) / 3600 >= 0
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

  const breachedOrders = await safeAll(
    `SELECT o.id, o.breached_at, o.specialty_id, s.name AS specialty_name, u.name AS doctor_name
     FROM orders o
     LEFT JOIN specialties s ON s.id = o.specialty_id
     LEFT JOIN users u ON u.id = o.doctor_id
     WHERE ${breachedIn3.clause}
        OR (o.completed_at IS NOT NULL
            AND o.deadline_at IS NOT NULL
            AND o.completed_at::timestamptz > o.deadline_at::timestamptz)
     ORDER BY COALESCE(o.breached_at, o.completed_at) DESC
     LIMIT 10`,
    breachedIn3.params,
    []
  );
  const totalBreached = (breachedOrders && breachedOrders.length) ? breachedOrders.length : 0;

  const notificationLog = (await tableExists('notifications'))
    ? await safeAll(
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

  const slaEvents = (await tableExists('order_events'))
    ? await safeAll(
        `SELECT id, order_id, label, at
         FROM order_events
         WHERE LOWER(label) ILIKE '%sla%'
            OR LOWER(label) ILIKE '%reassign%'
         ORDER BY at DESC
         LIMIT 20`,
        [],
        []
      )
    : [];

  // Specialty list for filters
  const specialties = await safeAll(
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
  const pendingFileRequests = await getPendingAdditionalFilesRequests(25);
  const pendingFileRequestsCount = (pendingFileRequests && pendingFileRequests.length) ? pendingFileRequests.length : 0;
  const pendingFileRequestsAwaitingCount = (pendingFileRequests || []).filter((r) => r && r.pending).length;

  // === GLASS TOWER: Additional data ===

  // Helper for safe queries on tables that may not exist
  async function safeCountQuery(sql, qParams) {
    try {
      const r = await safeGet(sql, qParams || [], null);
      return r ? (r.cnt !== undefined ? r.cnt : (r.total !== undefined ? r.total : 0)) : 0;
    } catch (e) { return 0; }
  }

  // Financial
  const doctorPayoutsPendingVal = await safeCountQuery(
    "SELECT COALESCE(SUM(earned_amount), 0) as total FROM doctor_earnings WHERE status = 'pending'", []);
  const doctorPayoutsPaidVal = await safeCountQuery(
    `SELECT COALESCE(SUM(earned_amount), 0) as total FROM doctor_earnings WHERE status = 'paid'`, []);
  const refundRow = (await tableExists('appointment_payments'))
    ? await safeGet("SELECT COUNT(*) as cnt, COALESCE(SUM(amount), 0) as total FROM appointment_payments WHERE refund_status = 'requested' OR refund_status = 'refunded'", [], { cnt: 0, total: 0 })
    : { cnt: 0, total: 0 };
  const videoRevenueVal = (await tableExists('appointment_payments'))
    ? await safeCountQuery("SELECT COALESCE(SUM(amount), 0) as total FROM appointment_payments WHERE status = 'paid'", [])
    : 0;
  const avgOrderVal = await safeGet(
    `SELECT COALESCE(AVG(price), 0) as avg FROM orders WHERE payment_status = 'paid' OR price > 0`, [], { avg: 0 });
  const paymentFailRow = await safeGet(
    "SELECT COUNT(*) as cnt FROM orders WHERE payment_status = 'failed'", [], { cnt: 0 });
  const totalPaymentsRow = await safeGet(
    "SELECT COUNT(*) as cnt FROM orders WHERE payment_status IS NOT NULL AND payment_status != ''", [], { cnt: 0 });

  // People
  const totalPatientsRow = await safeGet(
    "SELECT COUNT(*) as cnt FROM users WHERE role = 'patient'", [], { cnt: 0 });
  const newPatientsMonthRow = await safeGet(
    "SELECT COUNT(*) as cnt FROM users WHERE role = 'patient' AND created_at > date_trunc('month', NOW())", [], { cnt: 0 });
  const busyDoctorsRow = await safeGet(
    "SELECT COUNT(DISTINCT doctor_id) as cnt FROM orders WHERE status IN ('assigned', 'accepted', 'in_review') AND doctor_id IS NOT NULL", [], { cnt: 0 });
  const totalActiveDoctorsRow = await safeGet(
    "SELECT COUNT(*) as cnt FROM users WHERE role = 'doctor' AND (status = 'active' OR pending_approval = false OR pending_approval IS NULL)", [], { cnt: 0 });

  // System Health
  const lastEmailRow = (await tableExists('notifications'))
    ? await safeGet("SELECT MAX(at) as ts FROM notifications WHERE channel = 'email' AND status = 'sent'", [], { ts: null })
    : { ts: null };
  const lastWhatsAppRow = (await tableExists('notifications'))
    ? await safeGet("SELECT MAX(at) as ts FROM notifications WHERE channel = 'whatsapp' AND status = 'sent'", [], { ts: null })
    : { ts: null };
  const errorsLast24hVal = (await tableExists('error_logs'))
    ? await safeCountQuery("SELECT COUNT(*) as cnt FROM error_logs WHERE created_at > NOW() - INTERVAL '1 day'", [])
    : 0;

  // Notifications
  const notifTotalVal = (await tableExists('notifications'))
    ? await safeCountQuery("SELECT COUNT(*) as cnt FROM notifications", []) : 0;
  const notifDeliveredVal = (await tableExists('notifications'))
    ? await safeCountQuery("SELECT COUNT(*) as cnt FROM notifications WHERE status = 'sent'", []) : 0;
  const notifFailedVal = (await tableExists('notifications'))
    ? await safeCountQuery("SELECT COUNT(*) as cnt FROM notifications WHERE status = 'failed'", []) : 0;
  const notifQueuedVal = (await tableExists('notifications'))
    ? await safeCountQuery("SELECT COUNT(*) as cnt FROM notifications WHERE status IN ('pending', 'queued')", []) : 0;

  // Attention items
  const pendingRefunds = (await tableExists('appointment_payments'))
    ? await safeAll(
        `SELECT ap.id, ap.amount, ap.refund_status, ap.created_at,
                a.scheduled_at, p.name as patient_name, d.name as doctor_name
         FROM appointment_payments ap
         JOIN appointments a ON ap.appointment_id = a.id
         LEFT JOIN users p ON a.patient_id = p.id
         LEFT JOIN users d ON a.doctor_id = d.id
         WHERE ap.refund_status = 'requested'
         ORDER BY ap.created_at DESC LIMIT 5`, [], [])
    : [];
  const openChatReportsVal = (await tableExists('chat_reports'))
    ? await safeCountQuery("SELECT COUNT(*) as cnt FROM chat_reports WHERE status = 'open'", []) : 0;
  const doctorNoShowsTodayVal = (await tableExists('appointments'))
    ? await safeCountQuery("SELECT COUNT(*) as cnt FROM appointments WHERE status = 'no_show' AND scheduled_at::date = CURRENT_DATE", []) : 0;

  // Referrals
  const referralCodesUsedVal = (await tableExists('referral_redemptions'))
    ? await safeCountQuery("SELECT COUNT(*) as cnt FROM referral_redemptions", []) : 0;
  const referralRevenueVal = await safeCountQuery(
    "SELECT COALESCE(SUM(o.price), 0) as total FROM orders o WHERE o.referral_code IS NOT NULL AND (o.payment_status = 'paid' OR o.price > 0)", []);

  const payFailRate = (totalPaymentsRow && totalPaymentsRow.cnt > 0 && paymentFailRow)
    ? Math.round((paymentFailRow.cnt / totalPaymentsRow.cnt) * 100) : 0;
  const busyDocs = busyDoctorsRow ? busyDoctorsRow.cnt : 0;
  const activeDocs = totalActiveDoctorsRow ? totalActiveDoctorsRow.cnt : 0;
  const idleDocs = Math.max(0, activeDocs - busyDocs);

  // Render page
  res.render('superadmin', {
    user: req.user,
    lang: langCode,
    portalFrame: true,
    portalRole: 'superadmin',
    portalActive: 'dashboard',
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
    // Glass Tower data
    doctorPayoutsPending: doctorPayoutsPendingVal,
    doctorPayoutsPaid: doctorPayoutsPaidVal,
    refundCount: refundRow ? refundRow.cnt : 0,
    refundTotal: refundRow ? refundRow.total : 0,
    videoRevenue: videoRevenueVal,
    avgOrderValue: avgOrderVal ? Math.round(avgOrderVal.avg) : 0,
    paymentFailRate: payFailRate,
    totalPatients: totalPatientsRow ? totalPatientsRow.cnt : 0,
    newPatientsThisMonth: newPatientsMonthRow ? newPatientsMonthRow.cnt : 0,
    busyDoctors: busyDocs,
    idleDoctors: idleDocs,
    lastEmailSent: lastEmailRow ? lastEmailRow.ts : null,
    lastWhatsAppSent: lastWhatsAppRow ? lastWhatsAppRow.ts : null,
    errorsLast24h: errorsLast24hVal,
    notifTotal: notifTotalVal,
    notifDelivered: notifDeliveredVal,
    notifFailed: notifFailedVal,
    notifQueued: notifQueuedVal,
    pendingRefunds: pendingRefunds || [],
    openChatReports: openChatReportsVal,
    doctorNoShowsToday: doctorNoShowsTodayVal,
    referralCodesUsed: referralCodesUsedVal,
    referralRevenue: referralRevenueVal,
    filters: {
      from,
      to,
      specialty
    }
  });
});

// New order form (superadmin)
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
      sla_hours: 72,
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
  const autoDoctor = !doctor_id ? pickDoctorForOrder({ specialtyId: specialty_id }) : null;
  const chosenDoctor = selectedDoctor || autoDoctor;
  const status = chosenDoctor ? 'accepted' : 'new';
  const acceptedAt = chosenDoctor ? createdAt : null;

  await execute(
    `INSERT INTO orders (
      id, patient_id, doctor_id, specialty_id, service_id,
      sla_hours, status, price, doctor_fee,
      created_at, accepted_at, deadline_at, completed_at,
      breached_at, reassigned_count, report_url, notes,
      payment_status, payment_method, payment_reference, payment_link
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9,
      $10, $11, $12, NULL,
      NULL, 0, NULL, $13,
      $14, $15, $16, $17
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
      orderPaymentLink
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
     FROM orders o
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

  const order = await queryOne('SELECT id, patient_id, status FROM orders WHERE id = $1', [orderId]);
  if (!order) return res.redirect('/superadmin');

  const nowIso = new Date().toISOString();

  // Move order into an "awaiting files" lane (do not override completed)
  await execute(
    `UPDATE orders
     SET status = CASE WHEN status = 'completed' THEN status ELSE 'awaiting_files' END,
         updated_at = $1
     WHERE id = $2`,
    [nowIso, orderId]
  );

  await execute(
    `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      randomUUID(),
      orderId,
      'Additional files request approved (superadmin)',
      JSON.stringify({ request_event_id: request_event_id || null, support_note: support_note || null }),
      nowIso,
      req.user.id,
      'superadmin'
    ]
  );

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
  }

  return res.redirect(`/superadmin/orders/${orderId}?additional_files=approved`);
});

router.post('/superadmin/orders/:id/additional-files/reject', requireSuperadmin, async (req, res) => {
  const orderId = req.params.id;
  const { request_event_id, support_note } = req.body || {};

  const order = await queryOne('SELECT id, patient_id FROM orders WHERE id = $1', [orderId]);
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
  }

  const doctors = await queryAll(
      `SELECT u.id, u.name, u.email, u.phone, u.notify_whatsapp, u.is_active, u.created_at, u.specialty_id,
              u.pending_approval, u.approved_at, u.rejection_reason, u.signup_notes,
              s.name AS specialty_name
       FROM users u
       LEFT JOIN specialties s ON s.id = u.specialty_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY u.pending_approval DESC, u.is_active DESC, u.created_at DESC`
  );
  const specialties = await queryAll('SELECT id, name FROM specialties ORDER BY name ASC');
  const pendingDoctorsRow = await queryOne(
    "SELECT COUNT(*) as c FROM users WHERE role = 'doctor' AND pending_approval = true"
  );
  const pendingDoctorsCount = pendingDoctorsRow ? pendingDoctorsRow.c : 0;
  res.render('superadmin_doctors', { user: req.user, doctors, specialties, statusFilter, pendingDoctorsCount });
});

router.get('/superadmin/doctors/new', requireSuperadmin, async (req, res) => {
  const specialties = await queryAll('SELECT id, name FROM specialties ORDER BY name ASC');
  const subSpecialties = await queryAll(
    'SELECT id, specialty_id, name FROM services WHERE specialty_id IS NOT NULL ORDER BY name ASC'
  );

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

router.post('/superadmin/doctors/new', requireSuperadmin, async (req, res) => {
  const { name, email, specialty_id, phone, notify_whatsapp, is_active, service_ids } = req.body || {};
  if (!name || !email) {
    const specialties = await queryAll('SELECT id, name FROM specialties ORDER BY name ASC');
    const subSpecialties = await queryAll('SELECT id, specialty_id, name FROM services WHERE specialty_id IS NOT NULL ORDER BY name ASC');
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

  const existing = await queryOne('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) {
    const specialties = await queryAll('SELECT id, name FROM specialties ORDER BY name ASC');
    const subSpecialties = await queryAll('SELECT id, specialty_id, name FROM services WHERE specialty_id IS NOT NULL ORDER BY name ASC');
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
  await execute(
    `INSERT INTO users (id, email, password_hash, name, role, specialty_id, phone, lang, notify_whatsapp, is_active)
     VALUES ($1, $2, $3, $4, 'doctor', $5, $6, 'en', $7, $8)`,
    [
      newDoctorId,
      email,
      password_hash,
      name,
      specialty_id || null,
      phone || null,
      notify_whatsapp ? true : false,
      is_active ? true : false
    ]
  );

  // Map selected sub-specialties (services) to the doctor
  const rawServiceIds = Array.isArray(service_ids) ? service_ids : (service_ids ? [service_ids] : []);
  const cleanedServiceIds = rawServiceIds.map((v) => String(v || '').trim()).filter(Boolean);

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

  return res.redirect('/superadmin/doctors');
});

router.get('/superadmin/doctors/:id/edit', requireSuperadmin, async (req, res) => {
  const doctor = await queryOne("SELECT * FROM users WHERE id = $1 AND role = 'doctor'", [req.params.id]);
  if (!doctor) return res.redirect('/superadmin/doctors');
  const specialties = await queryAll('SELECT id, name FROM specialties ORDER BY name ASC');
  const subSpecialties = await queryAll('SELECT id, specialty_id, name FROM services WHERE specialty_id IS NOT NULL ORDER BY name ASC');
  const selectedServiceIds = (await queryAll('SELECT service_id FROM doctor_services WHERE doctor_id = $1', [req.params.id]))
    .map((r) => r.service_id);
  res.render('superadmin_doctor_form', { user: req.user, specialties, subSpecialties, selectedServiceIds, error: null, doctor, isEdit: true });
});

router.post('/superadmin/doctors/:id/edit', requireSuperadmin, async (req, res) => {
  const doctor = await queryOne("SELECT * FROM users WHERE id = $1 AND role = 'doctor'", [req.params.id]);
  if (!doctor) return res.redirect('/superadmin/doctors');
  const { name, specialty_id, phone, notify_whatsapp, is_active, service_ids } = req.body || {};
  await execute(
    `UPDATE users
     SET name = $1, specialty_id = $2, phone = $3, notify_whatsapp = $4, is_active = $5
     WHERE id = $6 AND role = 'doctor'`,
    [
      name || doctor.name,
      specialty_id || null,
      phone || null,
      notify_whatsapp ? true : false,
      is_active ? true : false,
      req.params.id
    ]
  );
  // Refresh sub-specialties (services) mapping
  try {
    await execute('DELETE FROM doctor_services WHERE doctor_id = $1', [req.params.id]);

    const rawServiceIds = Array.isArray(service_ids) ? service_ids : (service_ids ? [service_ids] : []);
    const cleanedServiceIds = rawServiceIds.map((v) => String(v || '').trim()).filter(Boolean);

    if (cleanedServiceIds.length && specialty_id) {
      const ph = cleanedServiceIds.map((_, i) => `$${i + 1}`).join(',');
      const allowed = (await queryAll(
        `SELECT id FROM services WHERE id IN (${ph}) AND specialty_id = $${cleanedServiceIds.length + 1}`,
        [...cleanedServiceIds, specialty_id]
      )).map((r) => r.id);

      for (const sid of allowed) {
        await execute('INSERT INTO doctor_services (doctor_id, service_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, sid]);
      }
    }
  } catch (_) {
    // no-op
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
  res.render('superadmin_doctor_detail', { user: req.user, doctor, pendingDoctorsCount });
});

router.post('/superadmin/doctors/:id/approve', requireSuperadmin, async (req, res) => {
  const doctorId = req.params.id;
  const doctor = await queryOne("SELECT * FROM users WHERE id = $1 AND role = 'doctor'", [doctorId]);
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

  queueMultiChannelNotification({
    orderId: null,
    toUserId: doctorId,
    channels: ['internal', 'email', 'whatsapp'],
    template: 'doctor_approved',
    response: {},
    dedupe_key: 'doctor_approved:' + doctorId
  });

  return res.redirect(`/superadmin/doctors/${doctorId}`);
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
  } catch (_) {
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

  // Transition to "new" if the order was in an awaiting-payment style state (conservative).
  try {
    const currentStatus = String(order.status || '').toLowerCase();
    if (['awaiting_payment', 'pending_payment', 'unpaid', 'payment_pending'].includes(currentStatus)) {
      await execute(
        `UPDATE orders
         SET status = 'new',
             updated_at = $1
         WHERE id = $2`,
        [nowIso, orderId]
      );
    }
  } catch (_) {}

  // If no doctor assigned yet, attempt auto-assign (best-effort).
  try {
    const fresh = await safeGet(
      `SELECT id, doctor_id, specialty_id, service_id, status, payment_status
       FROM orders
       WHERE id = $1`,
      [orderId],
      null
    );

    const doctorId = fresh && fresh.doctor_id ? String(fresh.doctor_id) : '';
    const pay = fresh && fresh.payment_status ? String(fresh.payment_status).toLowerCase() : '';
    if (!doctorId && pay === 'paid') {
      const picked = await pickDoctorForOrder(fresh);
      const pickedId = picked && picked.id ? String(picked.id) : (picked ? String(picked) : '');
      if (pickedId) {
        await execute(
          `UPDATE orders
           SET doctor_id = $1,
               updated_at = $2
           WHERE id = $3`,
          [pickedId, nowIso, orderId]
        );

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

        // Auto-create conversation for case-scoped messaging
        if (fresh.patient_id || order.patient_id) {
          try { ensureConversation(orderId, fresh.patient_id || order.patient_id, pickedId); } catch (_) {}
        }
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

router.post('/superadmin/orders/:id/mark-unpaid', requireSuperadmin, async (req, res) => {
  const orderId = String((req.params && req.params.id) || '').trim();
  if (!orderId) return res.redirect('/superadmin');

  const order = await queryOne('SELECT * FROM orders WHERE id = $1', [orderId]);
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

  const order = await queryOne('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!order) return res.redirect('/superadmin');

  const status = allowed.includes(payment_status) ? payment_status : order.payment_status;
  const nowIso = new Date().toISOString();

  await execute(
    `UPDATE orders
     SET payment_status = $1,
         payment_method = $2,
         payment_reference = $3,
         updated_at = $4
     WHERE id = $5`,
    [status, payment_method || null, payment_reference || null, nowIso, orderId]
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
     FROM orders o
     LEFT JOIN users d ON d.id = o.doctor_id
     WHERE o.id = $1`,
    [orderId]
  );

  if (!order || !newDoctorId) {
    return res.redirect(`/superadmin/orders/${orderId}`);
  }

  const newDoctor = await queryOne("SELECT id, name FROM users WHERE id = $1 AND role = 'doctor' AND is_active = true", [newDoctorId]);
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
  const order = await queryOne('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!order) return res.status(404).send('Order not found');

  await execute(
    "UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1",
    [orderId]
  );

  logOrderEvent({
    orderId,
    label: 'Order cancelled by superadmin',
    meta: JSON.stringify({ previous_status: order.status }),
    actorRole: 'superadmin',
    actorId: req.user.id
  });

  return res.redirect(`/superadmin/orders/${orderId}`);
});

// Extend SLA deadline
router.post('/superadmin/orders/:id/extend-sla', requireSuperadmin, async (req, res) => {
  const orderId = req.params.id;
  const order = await queryOne('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!order) return res.status(404).send('Order not found');

  const extraHours = Math.min(168, Math.max(1, parseInt(req.body.extra_hours) || 24));
  const currentDeadline = order.deadline_at ? new Date(order.deadline_at) : new Date();
  const newDeadline = new Date(currentDeadline.getTime() + extraHours * 60 * 60 * 1000);

  await execute(
    "UPDATE orders SET deadline_at = $1, sla_hours = COALESCE(sla_hours, 72) + $2, updated_at = NOW() WHERE id = $3",
    [newDeadline.toISOString(), extraHours, orderId]
  );

  // If order was breached, un-breach it
  if (String(order.status).toLowerCase() === 'breached') {
    const prevStatus = order.doctor_id ? 'assigned' : 'submitted';
    await execute("UPDATE orders SET status = $1 WHERE id = $2", [prevStatus, orderId]);
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

router.get('/superadmin/debug/reset-link/:userId', requireSuperadmin, async (req, res) => {
  const userId = req.params.userId;
  const user = await queryOne('SELECT * FROM users WHERE id = $1', [userId]);
  if (!user) return res.status(404).send('User not found');

  const token = uuidv4();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
  await execute(
    `INSERT INTO password_reset_tokens (id, user_id, token, expires_at, used_at, created_at)
     VALUES ($1, $2, $3, $4, NULL, $5)`,
    [uuidv4(), user.id, token, expiresAt, now.toISOString()]
  );

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
     LEFT JOIN orders o ON o.id = e.order_id
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
      brand: 'Tashkheesa', portalFrame: true, portalRole: 'superadmin',
      portalActive: 'instagram', portalNext: '/superadmin',
      posts, stats: { totalPosts, published, scheduled: approved, pending },
      brandConfig: {}, user: req.user, showAll,
    });
  } catch (err) {
    res.render('superadmin_instagram', {
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
    res.redirect('/superadmin/instagram');
  }
});

module.exports = { router, buildFilters };
