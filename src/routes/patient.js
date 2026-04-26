// src/routes/patient.js
const express = require('express');
const { requireRole } = require('../middleware');
const { queryOne, queryAll, execute, withTransaction } = require('../pg');
const { queueNotification, queueMultiChannelNotification } = require('../notify');
const { getNotificationTitles } = require('../notify/notification_titles');
const { randomUUID } = require('crypto');
const { logOrderEvent } = require('../audit');
var { enqueueCaseIntelligence } = require('../job_queue');
const { computeSla, enforceBreachIfNeeded } = require('../sla_status');

const caseLifecycle = require('../case_lifecycle');
const { fetchNotifications, countUnseenNotifications, markAllNotificationsRead, normalizeNotification } = require('../utils/notifications');
const { loadReportContentForPatient } = require('../helpers/load-report-content');
const getStatusUi = caseLifecycle.getStatusUi || caseLifecycle;
const toCanonStatus = caseLifecycle.toCanonStatus;
const toDbStatus = caseLifecycle.toDbStatus;
const dbStatusValuesFor = caseLifecycle.dbStatusValuesFor;

let geoip = null;
try {
  geoip = require('geoip-lite');
} catch (_) {
  geoip = null;
}





// ============ WIZARD GATE / KILL SWITCH ============
// Defense-for-rollback: the gate can be flipped forward to take the wizard
// offline mid-flight (Paymob outage, critical bug, etc.). The wizard renders
// a /coming-soon page while gated. Webhook + admin paths intentionally
// bypass this gate.
const WIZARD_AVAILABLE_FROM = new Date('2026-02-28T00:00:00+02:00'); // Cairo time
const isWizardUnavailable = () => new Date() < WIZARD_AVAILABLE_FROM;
// Backwards-compat alias — some pre-3B callers use the old name. Safe to
// remove once nothing references it.
const isPreLaunch = isWizardUnavailable;
// ===================================================

const router = express.Router();
const uploadcareLocals = {
  uploadcarePublicKey: process.env.UPLOADCARE_PUBLIC_KEY || '',
  uploaderConfigured: String(process.env.UPLOADCARE_PUBLIC_KEY || '').trim().length > 0,
};
function renderPatientOrderNew(res, locals) {
  return res.render('patient_order_new', {
    ...uploadcareLocals,
    ...locals
  });
}

// Defaults for alerts badge and portal frame on patient pages.
router.use((req, res, next) => {
  res.locals.unseenAlertsCount = 0;
  res.locals.alertsUnseenCount = 0;
  res.locals.hasUnseenAlerts = false;
  res.locals.portalFrame = true;
  res.locals.portalRole = 'patient';
  return next();
});

// Unseen alerts count (patient role only).
router.use(async (req, res, next) => {
  try {
    const user = req.user;
    if (!user || String(user.role || '') !== 'patient') return next();
    const count = await countPatientUnseenNotifications(user.id, user.email || '');
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
    (req && req.user && req.user.lang) ||
    'en';
  return String(l).toLowerCase() === 'ar' ? 'ar' : 'en';
}

function t(lang, enText, arText) {
  return String(lang).toLowerCase() === 'ar' ? arText : enText;
}

function renderPatientProfile(req, res, extraLocals) {
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';
  const u = req.user || {};

  res.render('patient_profile', {
    profileUser: u,
    lang: lang,
    isAr: isAr,
    pageTitle: isAr ? 'ملفي الشخصي' : 'My Profile',
    success: (extraLocals && extraLocals.success) || null,
    error: (extraLocals && extraLocals.error) || null
  });
}

// Patient profile (My profile)
router.get('/patient/profile', requireRole('patient'), function(req, res) {
  renderPatientProfile(req, res);
});

// POST /patient/profile — Update patient profile
router.post('/patient/profile', requireRole('patient'), async function(req, res) {
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';

  try {
    const userId = req.user.id;
    const name = String(req.body.name || '').trim().slice(0, 200);
    const phone = String(req.body.phone || '').trim().slice(0, 30);
    const prefLang = (req.body.lang === 'ar') ? 'ar' : 'en';
    const notifyWhatsapp = req.body.notify_whatsapp === '1' ? 1 : 0;
    const emailOptOut = req.body.email_marketing_opt_out === '1' ? 1 : 0;
    const dateOfBirth = String(req.body.date_of_birth || '').trim().slice(0, 10) || null;
    const gender = ['male', 'female', 'other'].includes(req.body.gender) ? req.body.gender : null;
    const countryCode = ['EG', 'SA', 'AE', 'GB', 'US'].includes(req.body.country_code) ? req.body.country_code : null;

    if (!name) {
      return renderPatientProfile(req, res, { error: isAr ? 'الاسم مطلوب' : 'Name is required' });
    }

    await execute(
      'UPDATE users SET name = $1, phone = $2, lang = $3, notify_whatsapp = $4, email_marketing_opt_out = $5, date_of_birth = $6, gender = $7, country_code = $8 WHERE id = $9',
      [name, phone || null, prefLang, notifyWhatsapp, emailOptOut, dateOfBirth, gender, countryCode, userId]
    );

    // Refresh user object for re-render
    const updated = await queryOne('SELECT * FROM users WHERE id = $1', [userId]);
    if (updated) req.user = updated;

    return renderPatientProfile(req, res, { success: isAr ? 'تم حفظ التغييرات بنجاح' : 'Changes saved successfully' });
  } catch (err) {
    return renderPatientProfile(req, res, { error: isAr ? 'حدث خطأ أثناء الحفظ' : 'Error saving changes' });
  }
});

// ---- Patient alerts (in-app notifications) ----

async function getNotificationTableColumns() {
  try {
    const cols = await queryAll(
      "SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'notifications'"
    );
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

async function fetchPatientNotifications(userId, userEmail = '', limit = 50) {
  const cols = await getNotificationTableColumns();
  const tsCol = pickNotificationTimestampColumn(cols);
  if (!tsCol) return [];

  const hasUserId = cols.includes('user_id');
  const hasToUserId = cols.includes('to_user_id');
  if (!hasUserId && !hasToUserId) return [];

  const where = [];
  const params = [];
  let paramIdx = 0;
  if (hasUserId) {
    paramIdx++;
    where.push(`user_id = $${paramIdx}`);
    params.push(String(userId));
  }
  if (hasToUserId) {
    paramIdx++;
    where.push(`to_user_id = $${paramIdx}`);
    params.push(String(userId));
    const email = String(userEmail || '').trim();
    if (email) {
      paramIdx++;
      where.push(`to_user_id = $${paramIdx}`);
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

  paramIdx++;
  const sql = `SELECT ${selectCols.join(', ')} FROM notifications WHERE (${where.join(' OR ')}) ORDER BY ${tsCol} DESC LIMIT $${paramIdx}`;
  try {
    return await queryAll(sql, [...params, Number(limit)]);
  } catch (_) {
    return [];
  }
}

async function countPatientUnseenNotifications(userId, userEmail = '') {
  try {
    const cols = await getNotificationTableColumns();
    const hasUserId = cols.includes('user_id');
    const hasToUserId = cols.includes('to_user_id');
    if (!hasUserId && !hasToUserId) return 0;

    const where = [];
    const params = [];
    let paramIdx = 0;
    if (hasUserId) {
      paramIdx++;
      where.push(`user_id = $${paramIdx}`);
      params.push(String(userId));
    }
    if (hasToUserId) {
      paramIdx++;
      where.push(`to_user_id = $${paramIdx}`);
      params.push(String(userId));
      const email = String(userEmail || '').trim();
      if (email) {
        paramIdx++;
        where.push(`to_user_id = $${paramIdx}`);
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

function getPatientNotificationTitles(template) {
  return getNotificationTitles(template);
}

function normalizePatientNotification(row) {
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

  const titles = getPatientNotificationTitles(template);

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
    href: orderId ? `/portal/patient/orders/${orderId}` : ''
  };
}

async function markAllPatientNotificationsRead(userId, userEmail = '') {
  const cols = await getNotificationTableColumns();
  const hasUserId = cols.includes('user_id');
  const hasToUserId = cols.includes('to_user_id');
  if (!hasUserId && !hasToUserId) return { ok: false, reason: 'no_user_column' };

  const where = [];
  const params = [];
  let paramIdx = 0;
  if (hasUserId) {
    paramIdx++;
    where.push(`user_id = $${paramIdx}`);
    params.push(String(userId));
  }
  if (hasToUserId) {
    paramIdx++;
    where.push(`to_user_id = $${paramIdx}`);
    params.push(String(userId));
    const email = String(userEmail || '').trim();
    if (email) {
      paramIdx++;
      where.push(`to_user_id = $${paramIdx}`);
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

router.get('/portal/patient/alerts', requireRole('patient'), async (req, res) => {
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';
  const userId = req.user && req.user.id ? String(req.user.id) : '';
  const userEmail = req.user && req.user.email ? String(req.user.email).trim() : '';

  const raw = await fetchPatientNotifications(userId, userEmail, 50);
  const alerts = (raw || []).map(normalizePatientNotification);

  try {
    if (userId) {
      await markAllPatientNotificationsRead(userId, userEmail);
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

  return res.render('patient_alerts', {
    brand: 'Tashkheesa',
    user: req.user,
    lang,
    isAr,
    activeTab: 'alerts',
    nextPath: '/portal/patient/alerts',
    alerts: Array.isArray(alerts) ? alerts : [],
    notifications: Array.isArray(alerts) ? alerts : []
  });
});

// Map a notification template name → an icon name for the v2 dropdown partial.
function notificationIconForTemplate(tpl) {
  const t = String(tpl || '').toLowerCase();
  if (!t) return 'bell';
  if (t.indexOf('message') !== -1)                        return 'message';
  if (t.indexOf('assign') !== -1 || t.indexOf('accept') !== -1) return 'check';
  if (t.indexOf('report') !== -1 || t.indexOf('delivered') !== -1 || t.indexOf('completed') !== -1) return 'file';
  if (t.indexOf('payment') !== -1 || t.indexOf('paid') !== -1)  return 'shield';
  if (t.indexOf('breach') !== -1 || t.indexOf('overdue') !== -1 || t.indexOf('alert') !== -1) return 'alert';
  if (t.indexOf('upload') !== -1 || t.indexOf('file') !== -1)   return 'file';
  if (t.indexOf('welcome') !== -1)                        return 'heart';
  return 'bell';
}

// Patient-friendly relative time, with sensible fallback to a short date.
function formatRelativeTime(at, isAr) {
  if (!at) return '';
  const d = new Date(at);
  if (isNaN(d.getTime())) return '';
  const now = Date.now();
  const diffSec = Math.max(0, Math.floor((now - d.getTime()) / 1000));
  if (diffSec < 60)        return isAr ? 'الآن'                 : 'just now';
  if (diffSec < 3600)      return (isAr ? 'منذ ' : '') + Math.floor(diffSec / 60)   + (isAr ? ' دقيقة' : 'm ago');
  if (diffSec < 86400)     return (isAr ? 'منذ ' : '') + Math.floor(diffSec / 3600) + (isAr ? ' ساعة'  : 'h ago');
  if (diffSec < 7 * 86400) return (isAr ? 'منذ ' : '') + Math.floor(diffSec / 86400)+ (isAr ? ' يوم'   : 'd ago');
  try { return d.toLocaleDateString(isAr ? 'ar-EG' : 'en-GB', { day: 'numeric', month: 'short' }); }
  catch (_) { return String(at).substring(0, 10); }
}

// Reshape a normalized notification into the dropdown's expected fields.
function shapeNotificationForDropdown(n, isAr) {
  if (!n) return null;
  const status = String(n.status || '').toLowerCase();
  const isNew = !(status === 'seen' || status === 'read');
  const titleField = isAr ? 'title_ar' : 'title_en';
  const title = (n && n[titleField]) ? String(n[titleField]) : (n.message || 'Notification');
  // body: the raw response or message — but never for report content (already filtered upstream).
  const body  = (n && n.message && n.message !== title) ? String(n.message) : '';
  return {
    id: n.id,
    isNew,
    icon: notificationIconForTemplate(n.template),
    title,
    body,
    time: formatRelativeTime(n.at, isAr),
    href: n.href || ''
  };
}

// GET /portal/patient/alerts.json — JSON shape for the topbar bell dropdown.
// Returns the 10 most-recent notifications for the patient. Does NOT mark them read.
router.get('/portal/patient/alerts.json', requireRole('patient'), async (req, res) => {
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';
  const userId = req.user && req.user.id ? String(req.user.id) : '';
  const userEmail = req.user && req.user.email ? String(req.user.email).trim() : '';

  if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });

  let raw = [];
  try {
    raw = await fetchPatientNotifications(userId, userEmail, 10);
  } catch (e) {
    console.error('[alerts.json] fetch failed', e && e.message ? e.message : e);
    raw = [];
  }
  const normalized   = (raw || []).map(normalizePatientNotification);
  const notifications = normalized.map(function(n) { return shapeNotificationForDropdown(n, isAr); }).filter(Boolean);

  let unreadCount = 0;
  try {
    unreadCount = await countPatientUnseenNotifications(userId, userEmail);
  } catch (_) { unreadCount = 0; }

  res.set('Cache-Control', 'no-store');
  return res.json({
    ok: true,
    notifications: notifications,
    unreadCount: Number(unreadCount) || 0,
    markAllUrl: '/portal/patient/alerts/mark-all-read'
  });
});

// POST /portal/patient/alerts/mark-all-read — bulk-mark for the dropdown.
router.post('/portal/patient/alerts/mark-all-read', requireRole('patient'), async (req, res) => {
  const userId = req.user && req.user.id ? String(req.user.id) : '';
  const userEmail = req.user && req.user.email ? String(req.user.email).trim() : '';
  if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });
  try {
    const result = await markAllPatientNotificationsRead(userId, userEmail);
    res.locals.unseenAlertsCount = 0;
    res.locals.alertsUnseenCount = 0;
    res.locals.hasUnseenAlerts = false;
    return res.json({ ok: !!result.ok, changes: result.changes || 0 });
  } catch (e) {
    console.error('[alerts mark-all-read] failed', e && e.message ? e.message : e);
    return res.status(500).json({ ok: false, error: 'mark_all_failed' });
  }
});

// POST /portal/patient/alerts/:id/read — single-notification mark-read for the dropdown.
// Ownership is enforced via the notification's user_id / to_user_id columns.
router.post('/portal/patient/alerts/:id/read', requireRole('patient'), async (req, res) => {
  const userId = req.user && req.user.id ? String(req.user.id) : '';
  const userEmail = req.user && req.user.email ? String(req.user.email).trim() : '';
  const notificationId = String(req.params.id || '').trim();
  if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!notificationId) return res.status(400).json({ ok: false, error: 'id_required' });

  try {
    const cols = await getNotificationTableColumns();
    const hasUserId   = cols.includes('user_id');
    const hasToUserId = cols.includes('to_user_id');
    if (!hasUserId && !hasToUserId) return res.status(500).json({ ok: false, error: 'no_user_column' });

    // Build owner clause to prevent cross-user mark-read.
    const ownerWhere = [];
    const ownerParams = [];
    let pi = 0;
    if (hasUserId)   { pi++; ownerWhere.push('user_id = $' + (pi + 1));   ownerParams.push(userId); }
    if (hasToUserId) { pi++; ownerWhere.push('to_user_id = $' + (pi + 1)); ownerParams.push(userId); }
    if (hasToUserId && userEmail) { pi++; ownerWhere.push('to_user_id = $' + (pi + 1)); ownerParams.push(userEmail); }
    const ownerClause = '(' + ownerWhere.join(' OR ') + ')';

    let result = null;
    if (cols.includes('is_read')) {
      result = await execute(
        'UPDATE notifications SET is_read = true' + (cols.includes('status') ? ", status = 'seen'" : '') +
        ' WHERE id = $1 AND ' + ownerClause + ' AND COALESCE(is_read, false) = false',
        [notificationId, ...ownerParams]
      );
    } else if (cols.includes('status')) {
      result = await execute(
        "UPDATE notifications SET status = 'seen' WHERE id = $1 AND " + ownerClause +
        " AND COALESCE(LOWER(status), '') NOT IN ('seen','read')",
        [notificationId, ...ownerParams]
      );
    } else {
      return res.status(500).json({ ok: false, error: 'no_read_mechanism' });
    }
    return res.json({ ok: true, changes: (result && result.rowCount) ? result.rowCount : 0 });
  } catch (e) {
    console.error('[alerts mark-read] failed', e && e.message ? e.message : e);
    return res.status(500).json({ ok: false, error: 'mark_read_failed' });
  }
});

function sameId(a, b) {
  return String(a) === String(b);
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
  if (!vals.length) return { clause: '1=0', params: [], nextIdx: startIdx };
  const ph = vals.map((_, i) => `$${startIdx + i}`).join(',');
  return { clause: `${field} IN (${ph})`, params: vals, nextIdx: startIdx + vals.length };
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

function dbStatusFor(canon, fallback) {
  try {
    if (typeof toDbStatus === 'function') {
      const v = toDbStatus(canon);
      if (v) return v;
    }
  } catch (_) {
    // ignore
  }
  return fallback;
}

function isCanonStatus(status, canon) {
  const s = canonOrOriginal(status);
  return String(s || '').trim().toUpperCase() === String(canon || '').trim().toUpperCase();
}


// --- schema helpers (keep routes tolerant across DB versions)
const _schemaCache = new Map();
async function hasColumn(tableName, columnName) {
  const key = `${tableName}.${columnName}`;
  if (_schemaCache.has(key)) return _schemaCache.get(key);
  try {
    const row = await queryOne(
      `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2 LIMIT 1`,
      [tableName, columnName]
    );
    const ok = !!row;
    _schemaCache.set(key, ok);
    return ok;
  } catch (e) {
    _schemaCache.set(key, false);
    return false;
  }
}

const SERVICES_VISIBLE_KEY = 'services.is_visible';
async function ensureServicesVisibilityColumn() {
  const cached = _schemaCache.get(SERVICES_VISIBLE_KEY);
  if (cached === true) return true;

  try {
    const row = await queryOne(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'services' AND column_name = 'is_visible' LIMIT 1"
    );
    const hasVisible = !!row;
    _schemaCache.set(SERVICES_VISIBLE_KEY, hasVisible);
    if (hasVisible) return true;
  } catch (_) {
    // fall through to ALTER TABLE
  }

  try {
    await execute("ALTER TABLE services ADD COLUMN is_visible INTEGER DEFAULT 1");
    try {
      await execute("UPDATE services SET is_visible = 1 WHERE is_visible IS NULL");
    } catch (_) {
      // non-blocking
    }
    _schemaCache.set(SERVICES_VISIBLE_KEY, true);
    return true;
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (/already exists/i.test(msg) || /duplicate column/i.test(msg)) {
      _schemaCache.set(SERVICES_VISIBLE_KEY, true);
      return true;
    }
    _schemaCache.set(SERVICES_VISIBLE_KEY, false);
    return false;
  }
}

const { COUNTRY_TO_CURRENCY, getCurrencyForCountry } = require('../country-currency');
const ALLOWED_COUNTRY_CODES = new Set(Object.keys(COUNTRY_TO_CURRENCY));
const COUNTRY_CURRENCY = COUNTRY_TO_CURRENCY;

function normalizeCountryCode(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return '';
  if (raw === 'UK') return 'GB';
  if (/^[A-Z]{2}$/.test(raw)) return raw;
  return '';
}

function normalizeIp(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const first = raw.split(',')[0].trim();
  if (!first) return '';
  if (first.startsWith('::ffff:')) return first.slice(7);
  if (first === '::1') return '127.0.0.1';
  return first;
}

function getRequestIp(req) {
  if (!req) return '';
  const headers = req.headers || {};
  const cf = headers['cf-connecting-ip'];
  if (cf) return normalizeIp(cf);
  const xff = headers['x-forwarded-for'];
  if (xff) return normalizeIp(xff);
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || (req.socket && req.socket.remoteAddress) || '';
  return normalizeIp(ip);
}

function lookupCountryFromIp(ip) {
  if (!geoip || !ip) return '';
  try {
    const res = geoip.lookup(ip);
    return res && res.country ? String(res.country) : '';
  } catch (_) {
    return '';
  }
}

function getCountryCurrency(code) {
  if (!code) return 'EGP';
  const upper = String(code).trim().toUpperCase();
  return getCurrencyForCountry(upper === 'UK' ? 'GB' : upper);
}

async function servicesSlaExpr(alias) {
  // tolerate older/newer DB schemas
  // prefer `sla_hours`, but fall back to `sla` if that's what exists
  if (await hasColumn('services', 'sla_hours')) return alias ? `${alias}.sla_hours` : 'sla_hours';
  if (await hasColumn('services', 'sla')) return alias ? `${alias}.sla` : 'sla';
  return 'NULL';
}

function getUserCountryCode(req) {
  try {
    const fromUser = normalizeCountryCode(req && req.user && (req.user.country_code || req.user.country));
    if (fromUser) return fromUser;

    const headerCountry = normalizeCountryCode(req && req.headers && (req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || req.headers['x-country']));
    if (headerCountry) return headerCountry;

    const ip = getRequestIp(req);
    const fromGeo = normalizeCountryCode(lookupCountryFromIp(ip));
    if (fromGeo) return fromGeo;

    return 'EG';
  } catch (_) {
    return 'EG';
  }
}

async function servicesVisibleClause(alias) {
  // tolerate older/newer DB schemas
  if (!(await ensureServicesVisibilityColumn())) return '1=1';
  const col = alias ? `${alias}.is_visible` : 'is_visible';
  return `COALESCE(${col}, true) = true`;
}

// --- safe schema helpers ---
function _forceSchema(tableName, columnName, value) {
  const key = `${tableName}.${columnName}`;
  _schemaCache.set(key, value);
}

async function insertAdditionalFile(orderId, url, labelValue, nowIso, client) {
  const withLabelSql =
    `INSERT INTO order_additional_files (id, order_id, file_url, label, uploaded_at)
     VALUES ($1, $2, $3, $4, $5)`;
  const noLabelSql =
    `INSERT INTO order_additional_files (id, order_id, file_url, uploaded_at)
     VALUES ($1, $2, $3, $4)`;

  const runWithLabel = async () => {
    const q = client ? client.query.bind(client) : execute;
    await q(withLabelSql, [randomUUID(), orderId, url, labelValue || null, nowIso]);
  };
  const runNoLabel = async () => {
    const q = client ? client.query.bind(client) : execute;
    await q(noLabelSql, [randomUUID(), orderId, url, nowIso]);
  };

  const addHasLabel = await hasColumn('order_additional_files', 'label');
  if (!addHasLabel) return runNoLabel();

  try {
    return await runWithLabel();
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    // Schema cache can be stale across DB variants; retry safely without label.
    if ((/does not exist/i.test(msg) || /no such column/i.test(msg) || /no column named/i.test(msg)) && /label/i.test(msg)) {
      _forceSchema('order_additional_files', 'label', false);
      return await runNoLabel();
    }
    throw err;
  }
}

async function safeAll(sqlFactory, params = []) {
  // sqlFactory: (slaExpr: string) => string
  try {
    const slaExpr = await servicesSlaExpr();
    return await queryAll(sqlFactory(slaExpr), params);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    // If DB schema doesn't actually have sla_hours, retry after forcing cache false
    if (/does not exist/i.test(msg) && /sla_hours/i.test(msg)) {
      _forceSchema('services', 'sla_hours', false);
      const slaExpr = await servicesSlaExpr();
      return await queryAll(sqlFactory(slaExpr), params);
    }
    throw err;
  }
}

async function safeGet(sqlFactory, params = []) {
  // sqlFactory: (slaExpr: string) => string
  try {
    const slaExpr = await servicesSlaExpr();
    return await queryOne(sqlFactory(slaExpr), params);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (/does not exist/i.test(msg) && /sla_hours/i.test(msg)) {
      _forceSchema('services', 'sla_hours', false);
      const slaExpr = await servicesSlaExpr();
      return await queryOne(sqlFactory(slaExpr), params);
    }
    throw err;
  }
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

// ===== AI CASE TYPE ANALYSIS ENDPOINT (Claude-powered) =====
router.post('/api/analyze-case-type', requireRole('patient'), async (req, res) => {
  try {
    const { description } = req.body;
    if (!description || typeof description !== 'string' || description.trim().length < 10) {
      return res.json({ success: false, error: 'Please provide a description of at least 10 characters' });
    }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
    const https = require('https');
    const safeDesc = description.trim().replace(/['"]/g, '');
    const promptText = 'You are a medical triage assistant for Tashkheesa. Patient case: ' + safeDesc + '. Classify into 1-2 types from: imaging, labs, treatment, general. Respond ONLY with JSON: {"types":["imaging"],"reasoning":"One sentence.","confidence":"high"}';
    const body = JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 150, messages: [{ role: 'user', content: promptText }] });
    const aiResponse = await new Promise((resolve, reject) => {
      const r = https.request({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) } }, (res2) => {
        var d = ''; res2.on('data', function(c) { d += c; }); res2.on('end', function() { resolve(JSON.parse(d)); });
      });
      r.on('error', reject); r.write(body); r.end();
    });
    var text = (aiResponse.content && aiResponse.content[0] && aiResponse.content[0].text) || '{}';
    var parsed = JSON.parse(text.trim());
    var typeLabels = { imaging: 'Diagnostic Imaging', labs: 'Laboratory Tests', treatment: 'Treatment Review', general: 'General Medical Question' };
    var suggestedTypes = (parsed.types || ['general']).slice(0, 2).map(function(v) { return { value: v, label: typeLabels[v] || v }; });
    return res.json({ success: true, suggestedTypes: suggestedTypes, reasoning: parsed.reasoning || 'Based on your description, we suggest a case type below.', confidence: parsed.confidence || 'medium' });
  } catch (error) {
    console.error('AI analysis error:', error);
    return res.json({ success: false, error: 'An error occurred during analysis. Please select manually.' });
  }
});

// GET /dashboard – patient home, three states: empty (with optional DRAFT tile) / active / report-ready.
// PRIVACY: this handler must NEVER select report content columns from `orders`
// (notes, diagnosis_text, impression_text, recommendation_text). Defense in depth — if
// the column isn't in the SELECT, it can't accidentally leak via a future template change.
router.get('/dashboard', requireRole('patient'), async (req, res) => {
  const patientId = req.user.id;
  const langCode = (res.locals && res.locals.lang === 'ar') ? 'ar' : 'en';
  const isAr = langCode === 'ar';

  // Explicit, privacy-safe column allowlist for orders.
  const SAFE_ORDER_COLS = [
    'o.id', 'o.reference_code', 'o.status', 'o.payment_status', 'o.doctor_id',
    'o.specialty_id', 'o.service_id', 'o.sla_hours', 'o.deadline_at',
    'o.accepted_at', 'o.paid_at', 'o.completed_at', 'o.created_at', 'o.updated_at',
    'o.urgency_flag', 'o.uploads_locked', 'o.additional_files_requested',
    's.name AS specialty_name',
    'sv.name AS service_name',
    'd.name AS doctor_name'
  ].join(', ');

  // 1. Most recent active case — paid, not completed/cancelled, may be in limbo (PAID + no doctor).
  const activeOrderPromise = queryOne(
    `SELECT ${SAFE_ORDER_COLS}
     FROM orders o
     LEFT JOIN specialties s ON s.id = o.specialty_id
     LEFT JOIN services sv ON sv.id = o.service_id
     LEFT JOIN users d ON d.id = o.doctor_id
     WHERE o.patient_id = $1
       AND LOWER(COALESCE(o.payment_status, '')) = 'paid'
       AND UPPER(COALESCE(o.status, '')) NOT IN ('COMPLETED','CANCELLED','CANCELED','EXPIRED_UNPAID','DRAFT')
     ORDER BY o.created_at DESC
     LIMIT 1`,
    [patientId]
  );

  // 2. Most recent completed case with a delivered report — for the "report ready" state.
  // We deliberately fetch only metadata: report exists? when delivered? doctor name?
  // The report TEXT must never appear in the dashboard query.
  const reportReadyPromise = queryOne(
    `SELECT ${SAFE_ORDER_COLS},
            re.id AS report_export_id,
            re.created_at AS report_delivered_at
     FROM orders o
     LEFT JOIN specialties s ON s.id = o.specialty_id
     LEFT JOIN services sv ON sv.id = o.service_id
     LEFT JOIN users d ON d.id = o.doctor_id
     LEFT JOIN LATERAL (
       SELECT id, created_at FROM report_exports WHERE case_id = o.id
       ORDER BY created_at DESC LIMIT 1
     ) re ON true
     WHERE o.patient_id = $1
       AND UPPER(COALESCE(o.status, '')) IN ('COMPLETED','DONE','DELIVERED','REPORT_READY','REPORT-READY','FINALIZED')
     ORDER BY COALESCE(o.completed_at, o.updated_at, o.created_at) DESC
     LIMIT 1`,
    [patientId]
  );

  // 3. Most recent DRAFT — surfaced as "Continue your case" tile in the empty state.
  // Hygiene: only resurface drafts touched in the last 30 days. Older = patient won't come back.
  const draftPromise = queryOne(
    `SELECT o.id, o.created_at, o.updated_at, s.name AS specialty_name, sv.name AS service_name
     FROM orders o
     LEFT JOIN specialties s ON s.id = o.specialty_id
     LEFT JOIN services sv ON sv.id = o.service_id
     WHERE o.patient_id = $1
       AND UPPER(COALESCE(o.status, '')) = 'DRAFT'
       AND COALESCE(o.updated_at, o.created_at) > NOW() - INTERVAL '30 days'
     ORDER BY COALESCE(o.updated_at, o.created_at) DESC
     LIMIT 1`,
    [patientId]
  );

  let activeOrder = null, reportReadyOrder = null, draftOrder = null;
  try {
    const settled = await Promise.all([activeOrderPromise, reportReadyPromise, draftPromise]);
    activeOrder = settled[0] || null;
    reportReadyOrder = settled[1] || null;
    draftOrder = settled[2] || null;
  } catch (e) {
    console.error('[dashboard] order fetch failed', e && e.message ? e.message : e);
  }

  // Refresh SLA breach + canonical status for the active case (if any).
  if (activeOrder) {
    try { enforceBreachIfNeeded(activeOrder); } catch (_) {}
    try {
      const computed = computeSla(activeOrder);
      activeOrder.effectiveStatus = computed.effectiveStatus || activeOrder.status;
      activeOrder.sla = computed.sla;
      activeOrder.statusUi = getStatusUi(String(activeOrder.effectiveStatus || activeOrder.status || '').toUpperCase(), { role: 'patient', lang: langCode });
    } catch (_) {}
  }

  // Attach unread message count for the active case (sidebar/tabbar badges + dashboard CTA).
  let activeUnreadMessages = 0;
  if (activeOrder && activeOrder.id) {
    try {
      const row = await queryOne(
        `SELECT COUNT(*) AS c FROM messages
         WHERE case_id = $1 AND COALESCE(sender_id, '') <> $2 AND read_at IS NULL`,
        [activeOrder.id, String(patientId)]
      );
      activeUnreadMessages = row ? Number(row.c) || 0 : 0;
    } catch (_) { /* messages table or column may not exist in some envs */ }
  }

  // State precedence: active > report-ready > empty.
  // The DRAFT tile sits ABOVE the empty state when no active/ready case exists.
  let dashboardState = 'empty';
  if (activeOrder) dashboardState = 'active';
  else if (reportReadyOrder && reportReadyOrder.report_export_id) dashboardState = 'ready';

  // Limbo within active: paid but not yet assigned (no doctor). Surfaces in the hero copy.
  const isLimbo = !!(activeOrder
    && String(activeOrder.payment_status || '').toLowerCase() === 'paid'
    && (!activeOrder.doctor_id)
    && String(activeOrder.status || '').toUpperCase() === 'PAID');

  res.render('patient_dashboard', {
    user: req.user,
    lang: langCode,
    isAr,
    dashboardState,
    activeOrder,
    reportReadyOrder,
    draftOrder,
    activeUnreadMessages,
    isLimbo
  });
});

// ════════════════════════════════════════════════════════════════════════════
// NEW-CASE 5-STEP WIZARD (Phase 3)
// ════════════════════════════════════════════════════════════════════════════
// Steps: 1 Condition → 2 Documents → 3 Specialty → 4 Review → 5 Payment.
// Single canonical entry point: /patient/new-case (legacy /portal/patient/orders/new
// 302-redirects here). The wizard creates an `orders` row in DRAFT on Step 1
// submit and updates the same row on each Continue. Step 5 success transitions
// to SUBMITTED. Resume via ?resume=:id (ownership-validated).
//
// Step state is INFERRED from field presence (no schema column yet — see Phase 3
// migration proposal). The inference function below is the single source of truth.

// Field-presence inference fallback. Migration 021 adds orders.draft_step as the
// canonical source; this stays as defense-in-depth for rows the backfill missed
// or any future schema drift. If this fires for a row whose draft_step column
// is already populated and matches, the call is a no-op cost — but if it fires
// and DISAGREES with the column, we log a warning so the divergence is visible.
async function inferDraftStep(orderId) {
  if (!orderId) return 0;
  try {
    const row = await queryOne(
      `SELECT
         o.clinical_question,
         o.specialty_id,
         o.service_id,
         o.payment_status,
         (SELECT 1 FROM order_files WHERE order_id = o.id LIMIT 1) AS has_file
       FROM orders o WHERE o.id = $1`,
      [orderId]
    );
    if (!row) return 0;
    if (String(row.payment_status || '').toLowerCase() === 'paid') return 5;
    let step = 0;
    if (row.clinical_question && String(row.clinical_question).trim().length > 0) step = 1;
    if (step >= 1 && row.has_file) step = 2;
    if (step >= 2 && row.specialty_id && row.service_id) step = 3;
    return step;
  } catch (_) {
    return 0;
  }
}

// Resolve last-completed step for a draft row. Reads orders.draft_step (post-021)
// and falls back to inference if the column is unset. Logs a warning if the
// fallback disagrees with the column — that means a wizard step is bypassing
// the column write somewhere.
async function resolveDraftStep(orderRow) {
  if (!orderRow || !orderRow.id) return 0;
  const colVal = (orderRow.draft_step === null || orderRow.draft_step === undefined)
    ? null
    : Number(orderRow.draft_step) || 0;
  if (colVal !== null && colVal > 0) return colVal;
  const inferred = await inferDraftStep(orderRow.id);
  if (colVal !== null && colVal === 0 && inferred > 0) {
    // The row exists with draft_step=0 but inference says they've made progress.
    // Either pre-021 backfill missed it, or a write path forgot to bump the column.
    console.warn('[wizard] draft_step inference fired post-backfill for order',
      orderRow.id, 'col=0 inferred=' + inferred);
  }
  return inferred;
}

async function loadOwnedDraft(orderId, patientId) {
  if (!orderId || !patientId) return null;
  const row = await queryOne(
    `SELECT o.id, o.patient_id, o.status, o.payment_status, o.draft_step,
            o.clinical_question, o.medical_history, o.current_medications,
            o.specialty_id, o.service_id, o.sla_hours, o.urgency_tier,
            o.notes, o.created_at, o.updated_at,
            s.name AS specialty_name, sv.name AS service_name
     FROM orders o
     LEFT JOIN specialties s ON s.id = o.specialty_id
     LEFT JOIN services sv ON sv.id = o.service_id
     WHERE o.id = $1 AND o.patient_id = $2`,
    [orderId, patientId]
  );
  if (!row) return null;
  // A "DRAFT" can be either an explicit DRAFT status OR a row that's already
  // SUBMITTED but unpaid (legacy patients before this wizard). For the wizard
  // we only treat status=DRAFT as resumable; everything else routes to dashboard.
  if (String(row.status || '').toUpperCase() !== 'DRAFT') return null;
  return row;
}

// GET /patient/new-case — single entry point, 5-step wizard.
// Query params:
//   ?resume=:id — load that specific DRAFT (ownership-checked) and route to
//                 (last_step_completed + 1).
//   ?step=N&id=:id — explicit jump to step N for the given order (also
//                    ownership-checked). Used by Step 4 Review's "Edit" links.
//   no params — auto-resume the user's most recent <30-day DRAFT if one exists,
//               otherwise show fresh Step 1.
router.get('/patient/new-case', requireRole('patient'), async (req, res) => {
  if (isWizardUnavailable()) return res.redirect('/coming-soon');

  const patientId = req.user.id;
  const lang = (res.locals && res.locals.lang) || 'en';
  const isAr = lang === 'ar';
  const resumeId = (req.query && req.query.resume) ? String(req.query.resume) : '';
  const explicitId = (req.query && req.query.id) ? String(req.query.id) : '';
  const explicitStep = Number(req.query && req.query.step) || 0;

  // Helper: resolve the country/currency context (for Step 5 pricing later).
  const countryCode = getUserCountryCode(req);
  const countryCurrency = getCountryCurrency(countryCode);

  // Resolve draft + step.
  let draft = null;
  let step = 1;

  if (resumeId) {
    draft = await loadOwnedDraft(resumeId, patientId);
    if (!draft) {
      // Either not found or not owned — return to dashboard rather than leak existence.
      return res.redirect('/dashboard');
    }
    const lastDone = await resolveDraftStep(draft);
    step = Math.min(5, Math.max(1, lastDone + 1));
  } else if (explicitId) {
    draft = await loadOwnedDraft(explicitId, patientId);
    if (!draft) return res.redirect('/dashboard');
    step = Math.min(5, Math.max(1, explicitStep || 1));
  } else {
    // No params — auto-resume the most recent <30-day DRAFT.
    try {
      const latest = await queryOne(
        `SELECT id FROM orders
         WHERE patient_id = $1
           AND UPPER(COALESCE(status, '')) = 'DRAFT'
           AND COALESCE(updated_at, created_at) > NOW() - INTERVAL '30 days'
         ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 1`,
        [patientId]
      );
      if (latest && latest.id) {
        return res.redirect('/patient/new-case?resume=' + encodeURIComponent(latest.id));
      }
    } catch (_) { /* fall through to fresh Step 1 */ }
    step = 1;
  }

  // For Step 2, hydrate file list. For Step 3+, hydrate specialties/services + pricing.
  let files = [];
  let specialties = [];
  let services = [];
  let pricing = null;
  if (draft && step >= 2) {
    files = await queryAll(
      `SELECT id, url, label, created_at, is_valid
       FROM order_files WHERE order_id = $1
       ORDER BY created_at ASC`,
      [draft.id]
    );
    files.forEach(f => { f.url = '/files/' + f.id; });
  }
  if (draft && step === 3) {
    // Active-doctor gate: only surface specialties that have at least one active
    // doctor on the panel. Sort by doctor count DESC (most-staffed first).
    try {
      specialties = await queryAll(
        `SELECT s.id, s.name,
                COALESCE(d.active_count, 0) AS active_count
         FROM specialties s
         LEFT JOIN (
           SELECT specialty_id, COUNT(*) AS active_count
           FROM users
           WHERE role = 'doctor' AND COALESCE(is_active, true) = true
           GROUP BY specialty_id
         ) d ON d.specialty_id = s.id
         WHERE COALESCE(s.is_visible, true) = true
           AND COALESCE(d.active_count, 0) > 0
         ORDER BY d.active_count DESC, s.name ASC`,
        []
      );
    } catch (_) { specialties = []; }
    // Services for the currently-selected specialty (or all services if not yet picked).
    try {
      const visibleClause = await servicesVisibleClause('sv');
      services = await safeAll(
        (slaExpr) => `SELECT sv.id, sv.specialty_id, sv.name,
                             COALESCE(cp.tashkheesa_price, sv.base_price) AS base_price,
                             COALESCE(cp.currency, sv.currency) AS currency,
                             ${slaExpr} AS sla_hours
                      FROM services sv
                      LEFT JOIN service_regional_prices cp
                        ON cp.service_id = sv.id
                       AND cp.country_code = $1
                       AND COALESCE(cp.status, 'active') = 'active'
                      WHERE ${visibleClause}
                      ORDER BY sv.name ASC`,
        [countryCode]
      );
    } catch (_) { services = []; }
  }
  if (draft && (step === 4 || step === 5)) {
    // Step 4 review: fetch the full case snapshot + selected service pricing.
    files = await queryAll(
      `SELECT id, url, label, created_at FROM order_files WHERE order_id = $1 ORDER BY created_at ASC`,
      [draft.id]
    );
    files.forEach(f => { f.url = '/files/' + f.id; });
    if (draft.service_id) {
      try {
        const visibleClause = await servicesVisibleClause('sv');
        const localPrice = await safeGet(
          (slaExpr) => `SELECT sv.id, sv.name, sv.specialty_id,
                               COALESCE(cp.tashkheesa_price, sv.base_price) AS base_price,
                               COALESCE(cp.currency, sv.currency, 'EGP') AS currency,
                               COALESCE(sv.sla_24hr_price, 0) AS sla_24hr_price,
                               sv.sla_24hr_prices_json AS sla_24hr_prices_json,
                               ${slaExpr} AS sla_hours
                        FROM services sv
                        LEFT JOIN service_regional_prices cp
                          ON cp.service_id = sv.id
                         AND cp.country_code = $1
                         AND COALESCE(cp.status, 'active') = 'active'
                        WHERE sv.id = $2 AND ${visibleClause}`,
          [countryCode, draft.service_id]
        );
        const egpPrice = await safeGet(
          () => `SELECT sv.base_price, sv.currency,
                        COALESCE(cp.tashkheesa_price, sv.base_price) AS tashkheesa_price,
                        COALESCE(cp.currency, sv.currency, 'EGP') AS local_currency
                 FROM services sv
                 LEFT JOIN service_regional_prices cp
                   ON cp.service_id = sv.id
                  AND cp.country_code = 'EG'
                  AND COALESCE(cp.status, 'active') = 'active'
                 WHERE sv.id = $1`,
          [draft.service_id]
        );
        // Resolve 24h premium in local currency from the JSON map.
        let priority24hPremium = Number(localPrice && localPrice.sla_24hr_price) || 0;
        try {
          if (localPrice && localPrice.sla_24hr_prices_json) {
            const map = JSON.parse(localPrice.sla_24hr_prices_json);
            const cur = String((localPrice && localPrice.currency) || countryCurrency || 'EGP').toUpperCase();
            if (map[cur] !== undefined && map[cur] !== null) priority24hPremium = Number(map[cur]) || priority24hPremium;
          }
        } catch (_) { /* keep default */ }

        const localCurrency = String((localPrice && localPrice.currency) || countryCurrency || 'EGP').toUpperCase();
        const showSecondary = localCurrency !== 'EGP';
        pricing = {
          serviceName: localPrice ? localPrice.name : '',
          localCurrency,
          standard: {
            local: Number(localPrice && localPrice.base_price) || 0,
            egp: Number(egpPrice && egpPrice.tashkheesa_price) || 0
          },
          priority: {
            local: (Number(localPrice && localPrice.base_price) || 0) + priority24hPremium,
            egp: (Number(egpPrice && egpPrice.tashkheesa_price) || 0)
          },
          priorityPremiumLocal: priority24hPremium,
          showSecondary
        };
      } catch (e) {
        console.warn('[wizard step4 pricing] failed', e && e.message ? e.message : e);
        pricing = null;
      }
    }
  }

  return res.render('patient_new_case', {
    user: req.user,
    lang,
    isAr,
    step,
    draft,
    files,
    specialties,
    services,
    pricing,
    countryCurrency,
    uploadcarePublicKey: String(process.env.UPLOADCARE_PUBLIC_KEY || '').trim(),
    uploaderConfigured: String(process.env.UPLOADCARE_PUBLIC_KEY || '').trim().length > 0,
    paymobLiveMode: String(process.env.PAYMOB_LIVE_PAYMENTS || '').trim().toLowerCase() === 'true',
    paymentFailed: !!(req.query && req.query.failed),
    queryErr: (req.query && typeof req.query.err === 'string') ? req.query.err : '',
    uploadedFlash: !!(req.query && req.query.uploaded)
  });
});

// Legacy alias — consolidate per Phase 0. Preserves old bookmarks.
router.get('/portal/patient/orders/new', requireRole('patient'), (req, res) => {
  const qs = (req.query && req.query.specialty_id)
    ? '?prefill_specialty=' + encodeURIComponent(String(req.query.specialty_id))
    : '';
  return res.redirect(301, '/patient/new-case' + qs);
});

// POST /patient/new-case/step1 — Condition. Creates DRAFT row if none, else updates.
// Body: id (optional, for resume), clinical_question (required, ≥10 chars),
//       medical_history (optional), current_medications (optional).
router.post('/patient/new-case/step1', requireRole('patient'), async (req, res) => {
  if (isWizardUnavailable()) return res.redirect('/coming-soon');
  const patientId = req.user.id;
  const lang = (res.locals && res.locals.lang) || 'en';
  const isAr = lang === 'ar';

  const body = req.body || {};
  const orderIdInBody = body.id ? String(body.id).trim() : '';
  const clinicalQuestion = String(body.clinical_question || '').trim().slice(0, 4000);
  const medicalHistory = String(body.medical_history || '').trim().slice(0, 4000);
  const currentMedications = String(body.current_medications || '').trim().slice(0, 4000);

  if (clinicalQuestion.length < 10) {
    // Re-render Step 1 with the inline error.
    let draft = null;
    if (orderIdInBody) draft = await loadOwnedDraft(orderIdInBody, patientId);
    return res.status(400).render('patient_new_case', {
      user: req.user,
      lang, isAr,
      step: 1,
      draft: draft || { clinical_question: clinicalQuestion, medical_history: medicalHistory, current_medications: currentMedications },
      files: [],
      countryCurrency: getCountryCurrency(getUserCountryCode(req)),
      error: { step: 1, message: isAr
        ? 'يرجى وصف حالتك بما لا يقل عن 10 أحرف.'
        : 'Please describe your concern in at least 10 characters.' }
    });
  }

  const nowIso = new Date().toISOString();
  let orderId = orderIdInBody;
  try {
    if (orderId) {
      const owned = await loadOwnedDraft(orderId, patientId);
      if (!owned) return res.redirect('/dashboard'); // Don't leak existence on failed ownership check.
      await execute(
        `UPDATE orders
         SET clinical_question = $1, medical_history = $2, current_medications = $3,
             draft_step = GREATEST(COALESCE(draft_step, 0), 1),
             updated_at = $4
         WHERE id = $5 AND patient_id = $6 AND UPPER(COALESCE(status, '')) = 'DRAFT'`,
        [clinicalQuestion, medicalHistory || null, currentMedications || null, nowIso, orderId, patientId]
      );
    } else {
      orderId = randomUUID();
      await execute(
        `INSERT INTO orders
           (id, patient_id, status, language, clinical_question, medical_history, current_medications,
            payment_status, source, draft_step, created_at, updated_at)
         VALUES ($1, $2, 'DRAFT', $3, $4, $5, $6, 'unpaid', 'patient_wizard_v2', 1, $7, $7)`,
        [orderId, patientId, lang, clinicalQuestion, medicalHistory || null, currentMedications || null, nowIso]
      );
      try {
        logOrderEvent({ orderId, label: 'draft_created', actorUserId: patientId, actorRole: 'patient' });
      } catch (_) {}
    }
  } catch (e) {
    console.error('[new-case step1] failed', e && e.message ? e.message : e);
    return res.redirect('/patient/new-case');
  }

  return res.redirect('/patient/new-case?step=2&id=' + encodeURIComponent(orderId));
});

// POST /patient/new-case/step2 — Documents continue button.
// Validates ≥1 file uploaded for this DRAFT, then advances to Step 3.
// (Actual file upload happens via POST /portal/patient/orders/:id/upload, reused
// from existing pipeline — the upload endpoint enqueues the AI validation job.)
router.post('/patient/new-case/step2', requireRole('patient'), async (req, res) => {
  if (isWizardUnavailable()) return res.redirect('/coming-soon');
  const patientId = req.user.id;
  const orderId = req.body && req.body.id ? String(req.body.id).trim() : '';
  if (!orderId) return res.redirect('/patient/new-case');

  const owned = await loadOwnedDraft(orderId, patientId);
  if (!owned) return res.redirect('/dashboard');

  const fileCount = await queryOne(
    'SELECT COUNT(*) AS c FROM order_files WHERE order_id = $1',
    [orderId]
  );
  if (!fileCount || Number(fileCount.c) === 0) {
    // Re-render step 2 with an error
    return res.redirect('/patient/new-case?step=2&id=' + encodeURIComponent(orderId) + '&err=needs_files');
  }

  // Mark Step 2 complete (idempotent — Step 2 == "Documents added").
  await execute(
    `UPDATE orders
     SET draft_step = GREATEST(COALESCE(draft_step, 0), 2),
         updated_at = $1
     WHERE id = $2 AND patient_id = $3 AND UPPER(COALESCE(status, '')) = 'DRAFT'`,
    [new Date().toISOString(), orderId, patientId]
  );

  return res.redirect('/patient/new-case?step=3&id=' + encodeURIComponent(orderId));
});

// POST /patient/new-case/step3 — Specialty + Service selection.
// Body: id, specialty_id, service_id. Validates the chosen service belongs to
// the chosen specialty AND has at least one active doctor on its specialty.
router.post('/patient/new-case/step3', requireRole('patient'), async (req, res) => {
  if (isWizardUnavailable()) return res.redirect('/coming-soon');
  const patientId = req.user.id;
  const orderId = req.body && req.body.id ? String(req.body.id).trim() : '';
  const specialtyId = req.body && req.body.specialty_id ? String(req.body.specialty_id).trim() : '';
  const serviceId = req.body && req.body.service_id ? String(req.body.service_id).trim() : '';

  if (!orderId) return res.redirect('/patient/new-case');
  const owned = await loadOwnedDraft(orderId, patientId);
  if (!owned) return res.redirect('/dashboard');

  if (!specialtyId || !serviceId) {
    return res.redirect('/patient/new-case?step=3&id=' + encodeURIComponent(orderId) + '&err=needs_specialty');
  }

  // Validate specialty has at least one active doctor.
  const docCount = await queryOne(
    `SELECT COUNT(*) AS c FROM users
     WHERE role = 'doctor' AND COALESCE(is_active, true) = true AND specialty_id = $1`,
    [specialtyId]
  );
  if (!docCount || Number(docCount.c) === 0) {
    return res.redirect('/patient/new-case?step=3&id=' + encodeURIComponent(orderId) + '&err=specialty_unavailable');
  }

  // Validate service belongs to specialty and is visible.
  const visibleClause = await servicesVisibleClause('sv');
  const service = await safeGet(
    () => `SELECT sv.id, sv.specialty_id FROM services sv WHERE sv.id = $1 AND ${visibleClause}`,
    [serviceId]
  );
  if (!service || String(service.specialty_id) !== specialtyId) {
    return res.redirect('/patient/new-case?step=3&id=' + encodeURIComponent(orderId) + '&err=invalid_service');
  }

  await execute(
    `UPDATE orders
     SET specialty_id = $1, service_id = $2,
         draft_step = GREATEST(COALESCE(draft_step, 0), 3),
         updated_at = $3
     WHERE id = $4 AND patient_id = $5 AND UPPER(COALESCE(status, '')) = 'DRAFT'`,
    [specialtyId, serviceId, new Date().toISOString(), orderId, patientId]
  );

  return res.redirect('/patient/new-case?step=4&id=' + encodeURIComponent(orderId));
});

// POST /patient/new-case/step4 — Review confirmation + SLA selection.
// Body: id, sla_option ('standard'|'priority'). No default — patient must choose.
router.post('/patient/new-case/step4', requireRole('patient'), async (req, res) => {
  if (isWizardUnavailable()) return res.redirect('/coming-soon');
  const patientId = req.user.id;
  const orderId = req.body && req.body.id ? String(req.body.id).trim() : '';
  const slaOption = req.body && req.body.sla_option ? String(req.body.sla_option).trim().toLowerCase() : '';

  if (!orderId) return res.redirect('/patient/new-case');
  const owned = await loadOwnedDraft(orderId, patientId);
  if (!owned) return res.redirect('/dashboard');

  if (slaOption !== 'standard' && slaOption !== 'priority') {
    return res.redirect('/patient/new-case?step=4&id=' + encodeURIComponent(orderId) + '&err=needs_sla');
  }
  // SLA must remain bookable: priority (24h) only inside the urgent window.
  // For Phase 3B we allow both 24h and 72h to be selected without window check;
  // the case_lifecycle layer enforces window rules at submission/breach time.

  const slaHours = slaOption === 'priority' ? 24 : 72;
  await execute(
    `UPDATE orders
     SET sla_hours = $1, urgency_tier = $2,
         draft_step = GREATEST(COALESCE(draft_step, 0), 4),
         updated_at = $3
     WHERE id = $4 AND patient_id = $5 AND UPPER(COALESCE(status, '')) = 'DRAFT'`,
    [slaHours, slaOption === 'priority' ? 'priority' : 'standard', new Date().toISOString(), orderId, patientId]
  );

  return res.redirect('/patient/new-case?step=5&id=' + encodeURIComponent(orderId));
});

// POST /patient/new-case/step5 — Pay-now CTA. Branches on PAYMOB_LIVE_PAYMENTS.
//   Live mode  → redirect to the canonical Paymob payment URL for this order.
//   Stub mode  → redirect to the in-app stub success route which simulates a
//                successful webhook for Phase 4 testing.
// Either path leaves the DB row at status=DRAFT until success is confirmed by
// the webhook (or the stub route which calls markCasePaid() server-side).
router.post('/patient/new-case/step5', requireRole('patient'), async (req, res) => {
  if (isWizardUnavailable()) return res.redirect('/coming-soon');
  const patientId = req.user.id;
  const orderId = req.body && req.body.id ? String(req.body.id).trim() : '';
  if (!orderId) return res.redirect('/patient/new-case');

  const owned = await loadOwnedDraft(orderId, patientId);
  if (!owned) return res.redirect('/dashboard');
  // Step 5 requires the previous steps complete.
  const lastDone = await resolveDraftStep(owned);
  if (lastDone < 4) {
    return res.redirect('/patient/new-case?step=' + Math.min(5, lastDone + 1) + '&id=' + encodeURIComponent(orderId));
  }

  const liveMode = String(process.env.PAYMOB_LIVE_PAYMENTS || '').trim().toLowerCase() === 'true';

  if (!liveMode) {
    // Stub mode: bounce straight to the success route which calls
    // markCasePaid() server-side. Used for Phase 4 testing without Paymob.
    return res.redirect('/portal/patient/orders/' + encodeURIComponent(orderId) + '/payment-success?stub=1');
  }

  // Live mode: resolve the canonical payment URL via the existing helper.
  // The patient's browser is sent to Paymob's hosted form. After payment Paymob
  // redirects to PAYMOB_RETURN_URL (configured in the Paymob dashboard for each
  // payment link); the webhook (POST /payments/callback) is the source of truth.
  try {
    const { getOrCreatePaymentUrl } = require('./payments');
    const url = await getOrCreatePaymentUrl(owned);
    return res.redirect(url || '/dashboard');
  } catch (e) {
    console.error('[wizard step5 live] payment-url resolve failed', e && e.message ? e.message : e);
    return res.redirect('/patient/new-case?step=5&id=' + encodeURIComponent(orderId) + '&failed=1');
  }
});

// GET /portal/patient/payment-return — generic Paymob redirect landing.
// Paymob's exact redirect query parameter shape isn't known yet, so this
// handler is defensive: it accepts any of merchant_order_id / order /
// order_id / id / merchant_order. First match wins. The full query string is
// logged so we can tighten the handler once a real transaction is observed.
//
// success=true|"success"|"approved" → bounce to /payment-success (which
// re-queries DB and handles the "we're confirming your payment" interim state
// if the webhook hasn't fired yet).
// success=false|other status → bounce to wizard Step 5 with ?failed=1 so the
// patient sees the warm "let's try again" framing. Draft is preserved.
router.get('/portal/patient/payment-return', requireRole('patient'), async (req, res) => {
  const q = req.query || {};
  // Defensive: log entire query (no PII; Paymob params are order ids/status).
  console.log('[paymob-return] query', JSON.stringify(q));

  const orderId = String(
    q.merchant_order_id || q.order || q.order_id || q.id || q.merchant_order || ''
  ).trim();

  // Status detection — Paymob commonly sends "success" / "true" / "approved"
  // for OK and "false" / "failed" / "declined" otherwise. Normalize both.
  const rawStatus = String(q.success || q.status || q.payment_status || '').toLowerCase();
  const isSuccess = ['true', 'success', 'approved', 'paid', '1'].includes(rawStatus);

  if (!orderId) {
    // Can't resolve the order — bounce to dashboard rather than guess.
    return res.redirect('/dashboard');
  }
  // Ownership check — never bounce to a success/failure for an order the
  // current session doesn't own. Silent redirect to dashboard avoids leaking.
  const owned = await queryOne(
    'SELECT id FROM orders WHERE id = $1 AND patient_id = $2',
    [orderId, req.user.id]
  );
  if (!owned) return res.redirect('/dashboard');

  if (isSuccess) {
    return res.redirect('/portal/patient/orders/' + encodeURIComponent(orderId) + '/payment-success');
  }
  return res.redirect('/patient/new-case?step=5&id=' + encodeURIComponent(orderId) + '&failed=1');
});

// GET /portal/patient/orders/:id/payment-success — post-payment landing page.
// Re-queries the DB on every visit; never trusts redirect query params for
// state. Handles the "we're confirming your payment" interim case when the
// browser arrived before the webhook fired.
//
// ?stub=1 → simulates a successful webhook by calling markCasePaid()
// server-side. Only honored when PAYMOB_LIVE_PAYMENTS is not 'true'. This
// lets us exercise the post-payment + limbo flows (Phase 4) without
// touching Paymob.
router.get('/portal/patient/orders/:id/payment-success', requireRole('patient'), async (req, res) => {
  const patientId = req.user.id;
  const orderId = String(req.params.id || '').trim();
  if (!orderId) return res.redirect('/dashboard');

  const liveMode = String(process.env.PAYMOB_LIVE_PAYMENTS || '').trim().toLowerCase() === 'true';
  const wantStub = !!(req.query && req.query.stub) && !liveMode;

  // Ownership check.
  let order = await queryOne(
    `SELECT o.id, o.status, o.payment_status, o.paid_at, o.deadline_at, o.sla_hours,
            o.specialty_id, o.service_id, o.doctor_id, o.draft_step,
            s.name AS specialty_name, sv.name AS service_name,
            d.name AS doctor_name
     FROM orders o
     LEFT JOIN specialties s ON s.id = o.specialty_id
     LEFT JOIN services sv ON sv.id = o.service_id
     LEFT JOIN users d ON d.id = o.doctor_id
     WHERE o.id = $1 AND o.patient_id = $2`,
    [orderId, patientId]
  );
  if (!order) return res.redirect('/dashboard');

  if (wantStub && String(order.payment_status || '').toLowerCase() !== 'paid') {
    // Simulate the webhook server-side. markCasePaid() is the canonical entry.
    try {
      const slaType = (Number(order.sla_hours) === 24) ? 'priority_24h' : 'standard_72h';
      // Use the same lifecycle hook the real webhook uses.
      await caseLifecycle.markCasePaid(orderId, slaType);
      // Also write payment_status / paid_at directly (the webhook normally
      // does this in a transaction; markCasePaid only touches lifecycle).
      const nowIso = new Date().toISOString();
      await execute(
        `UPDATE orders
         SET payment_status = 'paid',
             paid_at = COALESCE(paid_at, $1),
             draft_step = 5,
             payment_method = COALESCE(payment_method, 'stub'),
             updated_at = $1
         WHERE id = $2 AND patient_id = $3`,
        [nowIso, orderId, patientId]
      );
      try {
        logOrderEvent({ orderId, label: 'stub_payment_success', actorUserId: patientId, actorRole: 'patient' });
      } catch (_) {}
      // Re-fetch the post-stub order state.
      order = await queryOne(
        `SELECT o.id, o.status, o.payment_status, o.paid_at, o.deadline_at, o.sla_hours,
                o.specialty_id, o.service_id, o.doctor_id, o.draft_step,
                s.name AS specialty_name, sv.name AS service_name,
                d.name AS doctor_name
         FROM orders o
         LEFT JOIN specialties s ON s.id = o.specialty_id
         LEFT JOIN services sv ON sv.id = o.service_id
         LEFT JOIN users d ON d.id = o.doctor_id
         WHERE o.id = $1 AND o.patient_id = $2`,
        [orderId, patientId]
      );
    } catch (e) {
      console.error('[stub-payment] markCasePaid failed', e && e.message ? e.message : e);
    }
  }

  const lang = (res.locals && res.locals.lang) || 'en';
  const isAr = String(lang).toLowerCase() === 'ar';

  const isPaid = String(order.payment_status || '').toLowerCase() === 'paid';
  // The "we're confirming your payment" interim state — the user landed on
  // the success URL but the webhook hasn't bumped payment_status yet. Render
  // the same page with a different banner. Auto-refresh client-side every 4s
  // up to ~60s, then suggest WhatsApp support.
  return res.render('patient_payment_success', {
    user: req.user,
    lang, isAr,
    order,
    isPaid,
    isStubMode: wantStub
  });
});

// GET /patient/new-case/:id/files.json — light polling endpoint for Step 2.
// Returns the current files with their AI-validation state so the UI can flip
// "Checking…" → "Readable" / "Flagged" without a full page refresh.
router.get('/patient/new-case/:id/files.json', requireRole('patient'), async (req, res) => {
  const patientId = req.user.id;
  const orderId = String(req.params.id || '').trim();
  if (!orderId) return res.status(400).json({ ok: false, error: 'id_required' });

  const owned = await loadOwnedDraft(orderId, patientId);
  if (!owned) return res.status(404).json({ ok: false, error: 'not_found' });

  const rows = await queryAll(
    `SELECT id, url, label, created_at, is_valid
     FROM order_files WHERE order_id = $1
     ORDER BY created_at ASC`,
    [orderId]
  );
  res.set('Cache-Control', 'no-store');
  return res.json({
    ok: true,
    files: (rows || []).map(f => ({
      id: f.id,
      url: '/files/' + f.id,
      label: f.label || '',
      createdAt: f.created_at,
      // is_valid: null = checking, true = readable, false = flagged
      validation: (f.is_valid === true || f.is_valid === 1) ? 'readable'
                : (f.is_valid === false || f.is_valid === 0) ? 'flagged'
                : 'checking'
    }))
  });
});

// Create new case (UploadCare)
router.post('/patient/new-case', requireRole('patient'), async (req, res) => {
  const patientId = req.user.id;
  const countryCode = getUserCountryCode(req);
  const countryCurrency = getCountryCurrency(countryCode);
  const { specialty_id, service_id, notes, file_urls, sla_type } = req.body || {};

  const specialties = await queryAll('SELECT id, name FROM specialties WHERE COALESCE(is_visible, true) = true ORDER BY name ASC');
  const visibleClause = await servicesVisibleClause('sv');
  const services = await safeAll(
    (slaExpr) =>
      `SELECT sv.id,
              sv.specialty_id,
              sv.name,
              COALESCE(cp.tashkheesa_price, sv.base_price) AS base_price,
              COALESCE(cp.doctor_commission, sv.doctor_fee) AS doctor_fee,
              COALESCE(cp.currency, sv.currency) AS currency,
              sv.payment_link AS payment_link,
              ${slaExpr} AS sla_hours
       FROM services sv
       JOIN specialties sp ON sp.id = sv.specialty_id AND COALESCE(sp.is_visible, true) = true
       LEFT JOIN service_regional_prices cp
         ON cp.service_id = sv.id
        AND cp.country_code = $1
        AND COALESCE(cp.status, 'active') = 'active'
       WHERE ${visibleClause}
       ORDER BY sv.name ASC`,
    [countryCode]
  );

  const service = await safeGet(
    (slaExpr) =>
      `SELECT sv.id,
              sv.specialty_id,
              sv.name,
              COALESCE(cp.tashkheesa_price, sv.base_price) AS base_price,
              COALESCE(cp.doctor_commission, sv.doctor_fee) AS doctor_fee,
              COALESCE(cp.currency, sv.currency) AS currency,
              sv.payment_link AS payment_link,
              ${slaExpr} AS sla_hours
       FROM services sv
       LEFT JOIN service_regional_prices cp
         ON cp.service_id = sv.id
        AND cp.country_code = $1
        AND COALESCE(cp.status, 'active') = 'active'
       WHERE sv.id = $2 AND ${visibleClause}`,
    [countryCode, service_id]
  );

  const validSpecialty = specialty_id && await queryOne('SELECT 1 FROM specialties WHERE id = $1', [specialty_id]);
  const serviceMatchesSpecialty = service && String(service.specialty_id) === String(specialty_id);

  let fileList = [];
  if (Array.isArray(file_urls)) {
    fileList = file_urls.filter(Boolean);
  } else if (typeof file_urls === 'string' && file_urls.trim()) {
    fileList = file_urls
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);
  }

  // Hard validation: require at least one file before submitting the case
  if (!Array.isArray(fileList) || fileList.length === 0) {
    return res.status(400).render('patient_new_case', {
      user: req.user,
      specialties,
      services,
      countryCurrency,
      error: 'At least one file upload is required before submitting the case.',
      form: req.body || {}
    });
  }

  if (!validSpecialty || !service || !serviceMatchesSpecialty) {
    return res.status(400).render('patient_new_case', {
      user: req.user,
      specialties,
      services,
      countryCurrency,
      error: 'Please choose a valid specialty/service.',
      form: req.body || {}
    });
  }

  const serviceSla = service && (service.sla_hours != null ? service.sla_hours : (service.sla != null ? service.sla : null));
  const slaHours =
    serviceSla != null
      ? serviceSla
      : sla_type === '24'
        ? 24
        : 72;

  const orderId = randomUUID();
  const fallbackPaymentLink = `/portal/patient/pay/${orderId}`;
  const nowIso = new Date().toISOString();
  const deadlineAt =
    slaHours != null
      ? new Date(new Date(nowIso).getTime() + Number(slaHours) * 60 * 60 * 1000).toISOString()
      : null;
  const price = service.base_price != null ? service.base_price : 0;
  const doctorFee = service.doctor_fee != null ? service.doctor_fee : 0;

  try {
    await withTransaction(async (client) => {
      const ordersHasCountry = await hasColumn('orders', 'country_code');

      const insertSql = ordersHasCountry
        ? `INSERT INTO orders (
          id, patient_id, doctor_id, specialty_id, service_id, sla_hours, status,
          price, doctor_fee, created_at, accepted_at, deadline_at, completed_at,
          breached_at, reassigned_count, report_url, notes,
          uploads_locked, additional_files_requested, payment_status, payment_method,
          payment_reference, payment_link, updated_at,
          country_code
        ) VALUES (
          $1, $2, NULL, $3, $4, $5, $6,
          $7, $8, $9, NULL, $10, NULL,
          NULL, 0, NULL, $11,
          0, 0, 'unpaid', NULL,
          NULL, $12, $9,
          $13
        )`
        : `INSERT INTO orders (
          id, patient_id, doctor_id, specialty_id, service_id, sla_hours, status,
          price, doctor_fee, created_at, accepted_at, deadline_at, completed_at,
          breached_at, reassigned_count, report_url, notes,
          uploads_locked, additional_files_requested, payment_status, payment_method,
          payment_reference, payment_link, updated_at
        ) VALUES (
          $1, $2, NULL, $3, $4, $5, $6,
          $7, $8, $9, NULL, $10, NULL,
          NULL, 0, NULL, $11,
          0, 0, 'unpaid', NULL,
          NULL, $12, $9
        )`;

      const insertParams = ordersHasCountry
        ? [orderId, patientId, specialty_id, service_id, slaHours, dbStatusFor('SUBMITTED', 'new'),
           price, doctorFee, nowIso, deadlineAt, notes || null, service.payment_link || fallbackPaymentLink,
           countryCode]
        : [orderId, patientId, specialty_id, service_id, slaHours, dbStatusFor('SUBMITTED', 'new'),
           price, doctorFee, nowIso, deadlineAt, notes || null, service.payment_link || fallbackPaymentLink];

      await client.query(insertSql, insertParams);

      for (const url of fileList) {
        await client.query(
          `INSERT INTO order_files (id, order_id, url, label, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), orderId, url, null, nowIso]
        );
      }

      logOrderEvent({
        orderId,
        label: 'Order created by patient',
        actorUserId: patientId,
        actorRole: 'patient'
      });
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[patient new-case] failed', err);
    return res.status(500).render('patient_new_case', {
      user: req.user,
      specialties,
      services,
      countryCurrency,
      error: 'Could not submit case. Please try again.',
      form: req.body || {}
    });
  }

  return res.redirect(`/portal/patient/pay/${orderId}`);
});


// Create order (patient)
router.post('/patient/orders', requireRole('patient'), async (req, res) => {
  // PRE-LAUNCH: Block order creation
  if (isPreLaunch()) {
    return res.redirect('/coming-soon');
  }
  const lang = getLang(req, res);
  const patientId = req.user.id;
  const countryCode = getUserCountryCode(req);
  const countryCurrency = getCountryCurrency(countryCode);
  const {
    service_id,
    specialty_id,
    sla_option,
    sla,
    sla_type, // legacy support
    notes,
    initial_file_url,
    clinical_question,
    medical_history,
    current_medications
  } = req.body || {};

  const specialties = await queryAll('SELECT id, name FROM specialties WHERE COALESCE(is_visible, true) = true ORDER BY name ASC');
  const visibleClause = await servicesVisibleClause('sv');
  const services = await safeAll(
    (slaExpr) =>
      `SELECT sv.id, sv.specialty_id, sv.name,
              COALESCE(cp.tashkheesa_price, sv.base_price) AS base_price,
              COALESCE(cp.doctor_commission, sv.doctor_fee) AS doctor_fee,
              COALESCE(cp.currency, sv.currency) AS currency,
              sv.payment_link AS payment_link,
              ${slaExpr} AS sla_hours,
              sp.name AS specialty_name
       FROM services sv
       JOIN specialties sp ON sp.id = sv.specialty_id AND COALESCE(sp.is_visible, true) = true
       LEFT JOIN service_regional_prices cp
         ON cp.service_id = sv.id
        AND cp.country_code = $1
        AND COALESCE(cp.status, 'active') = 'active'
       WHERE ${visibleClause}
       ORDER BY sp.name ASC, sv.name ASC`,
    [countryCode]
  );

  const service = await safeGet(
    (slaExpr) =>
      `SELECT sv.id, sv.specialty_id, sv.name,
              COALESCE(cp.tashkheesa_price, sv.base_price) AS base_price,
              COALESCE(cp.doctor_commission, sv.doctor_fee) AS doctor_fee,
              COALESCE(cp.currency, sv.currency) AS currency,
              sv.payment_link AS payment_link,
              ${slaExpr} AS sla_hours
       FROM services sv
       LEFT JOIN service_regional_prices cp
         ON cp.service_id = sv.id
        AND cp.country_code = $1
        AND COALESCE(cp.status, 'active') = 'active'
       WHERE sv.id = $2 AND ${visibleClause}`,
    [countryCode, service_id]
  );

  // Immutable price/currency/fee snapshot (TASK 2)
  const computedPrice = service.base_price != null ? Number(service.base_price) : 0;
  const computedCurrency = service.currency || countryCurrency;
  const computedDoctorFee = service.doctor_fee != null ? Number(service.doctor_fee) : 0;

  const serviceMatchesSpecialty =
    service && specialty_id && String(service.specialty_id) === String(specialty_id);

  if (!service_id || !service || !specialty_id || !serviceMatchesSpecialty) {
    return res.status(400) && res.render('patient_new_case', {
      user: req.user,
      specialties,
      services,
      countryCurrency,
      error: t(lang, 'Please choose a valid specialty and service.', 'يرجى اختيار تخصص وخدمة صحيحين.'),
      form: req.body || {}
    });
  }

  // IMPORTANT (GUARDRAIL):
  // initial_file_url is the ONLY accepted signal for an initial upload.
  // Do NOT validate against Uploadcare widget state, JS variables, file_urls, or any other field.
  // Missing initial_file_url MUST return 400 and re-render the form.
  // This behavior is intentional and covered by manual regression testing.
  // Soft state: check if an initial upload exists
  const primaryUrlRaw = initial_file_url;
  const primaryUrl = primaryUrlRaw && primaryUrlRaw.trim ? primaryUrlRaw.trim() : null;
  const hasInitialUpload = Boolean(primaryUrl);

  if (!hasInitialUpload) {
    const result = res.status(400) && res.render('patient_new_case', {
      user: req.user,
      specialties,
      services,
      countryCurrency,
      error: t(lang, 'An initial file upload is required before submitting the order.', 'يجب رفع ملف واحد على الأقل قبل إرسال الطلب.'),
      form: req.body || {}
    });
    if (process.env.NODE_ENV !== 'production' && !hasInitialUpload) {
      // eslint-disable-next-line no-console
      console.warn('[GUARD] Blocked order submission: missing initial_file_url');
    }
    return result;
  }

  const serviceSla = service && (service.sla_hours != null ? service.sla_hours : (service.sla != null ? service.sla : null));
  const slaHours =
    serviceSla != null
      ? serviceSla
      : sla_option === '24' || sla_type === 'vip' || sla_type === '24' || sla === '24'
        ? 24
        : 72;

  // Build immutable price snapshot (after slaHours is defined)
  const priceSnapshot = {
    service_id,
    country_code: countryCode,
    currency: computedCurrency,
    base_price: computedPrice,
    doctor_fee: computedDoctorFee,
    sla_hours: slaHours,
    addons: []
  };

  const orderId = randomUUID();
  const fallbackPaymentLink = `/portal/patient/pay/${orderId}`;
  const nowIso = new Date().toISOString();
  // REMOVE mutable price/doctorFee for downstream logic (use locked_* fields)
  // const price = service.base_price != null ? service.base_price : 0;
  // const doctorFee = service.doctor_fee != null ? service.doctor_fee : 0;
  const orderNotes = clinical_question || notes || null;

  try {
    await withTransaction(async (client) => {
      const ordersHasCountry = await hasColumn('orders', 'country_code');

      const insertSql = ordersHasCountry
        ? `INSERT INTO orders (
          id, patient_id, doctor_id, specialty_id, service_id, sla_hours, status,
          price, doctor_fee, created_at, accepted_at, deadline_at, completed_at,
          breached_at, reassigned_count, report_url, notes, medical_history, current_medications,
          uploads_locked, additional_files_requested, payment_status, payment_method,
          payment_reference, payment_link, updated_at,
          country_code,
          locked_price, locked_currency, price_snapshot_json
        ) VALUES (
          $1, $2, NULL, $3, $4, $5, $6,
          $7, $8, $9, NULL, NULL, NULL,
          NULL, 0, NULL, $10, $11, $12,
          0, 0, 'unpaid', NULL,
          NULL, $13, $9,
          $14,
          $15, $16, $17
        )`
        : `INSERT INTO orders (
          id, patient_id, doctor_id, specialty_id, service_id, sla_hours, status,
          price, doctor_fee, created_at, accepted_at, deadline_at, completed_at,
          breached_at, reassigned_count, report_url, notes, medical_history, current_medications,
          uploads_locked, additional_files_requested, payment_status, payment_method,
          payment_reference, payment_link, updated_at,
          locked_price, locked_currency, price_snapshot_json
        ) VALUES (
          $1, $2, NULL, $3, $4, $5, $6,
          $7, $8, $9, NULL, NULL, NULL,
          NULL, 0, NULL, $10, $11, $12,
          0, 0, 'unpaid', NULL,
          NULL, $13, $9,
          $14, $15, $16
        )`;

      const insertParams = ordersHasCountry
        ? [orderId, patientId, specialty_id, service_id, slaHours, dbStatusFor('SUBMITTED', 'new'),
           computedPrice, computedDoctorFee, nowIso, orderNotes, medical_history || null, current_medications || null,
           service.payment_link || fallbackPaymentLink,
           countryCode,
           computedPrice, computedCurrency, JSON.stringify(priceSnapshot)]
        : [orderId, patientId, specialty_id, service_id, slaHours, dbStatusFor('SUBMITTED', 'new'),
           computedPrice, computedDoctorFee, nowIso, orderNotes, medical_history || null, current_medications || null,
           service.payment_link || fallbackPaymentLink,
           computedPrice, computedCurrency, JSON.stringify(priceSnapshot)];

      await client.query(insertSql, insertParams);

      // Only insert file if present (logic unchanged)
      if (primaryUrl) {
        await client.query(
          `INSERT INTO order_files (id, order_id, url, label, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), orderId, primaryUrl, 'Initial upload', nowIso]
        );
        logOrderEvent({
          orderId,
          label: 'Initial files uploaded by patient',
          actorUserId: patientId,
          actorRole: 'patient'
        });
      }

      logOrderEvent({
        orderId,
        label: 'Order created by patient',
        actorUserId: patientId,
        actorRole: 'patient'
      });

      const superadmins = await queryAll(
        "SELECT id FROM users WHERE role = 'superadmin' AND is_active = true"
      );
      for (const admin of superadmins) {
        queueNotification({
          orderId,
          toUserId: admin.id,
          channel: 'internal',
          template: 'order_created_patient',
          status: 'queued'
        });
      }
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[patient order create] failed', err);
    return res.status(500) && res.render('patient_new_case', {
      user: req.user,
      specialties,
      services,
      countryCurrency,
      error: t(lang, 'Could not create order. Please try again.', 'تعذر إنشاء الطلب. يرجى المحاولة مرة أخرى.'),
      form: req.body || {}
    });
  }

  // HARD PAYMENT GATE: always redirect to payment page after order creation
  return res.redirect(`/portal/patient/pay/${orderId}`);
});

/**
 * HARD PAYMENT GATE
 * Patient must complete payment before accessing order details
 */
router.get('/portal/patient/pay/:id', requireRole('patient'), async (req, res) => {
  const orderId = req.params.id;
  const patientId = req.user.id;
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';

  // Expanded query: include service/specialty/price details for payment page
  const order = await queryOne(
    `SELECT o.id,
            o.payment_status,
            o.payment_link,
            o.locked_price,
            o.locked_currency,
            o.service_id,
            o.price,
            sv.name AS service_name,
            sp.name AS specialty_name
     FROM orders o
     LEFT JOIN services sv ON sv.id = o.service_id
     LEFT JOIN specialties sp ON sp.id = o.specialty_id
     WHERE o.id = $1 AND o.patient_id = $2`,
    [orderId, patientId]
  );

  if (!order) {
    return res.redirect('/dashboard');
  }

  if (order.payment_status === 'paid') {
    return res.redirect(`/portal/patient/orders/${orderId}`);
  }

  // Payment link logic: prevent infinite loop if link is just the fallback
  const internalFallbackPrefix = '/portal/patient/pay/';
  const rawPaymentLink = order && order.payment_link ? String(order.payment_link).trim() : '';
  const isInternalFallback = rawPaymentLink && rawPaymentLink.startsWith(internalFallbackPrefix);

  // Keep a copyable link to this payment-required page so the patient can return later.
  const copyLink = req.originalUrl && String(req.originalUrl).startsWith('/')
    ? String(req.originalUrl)
    : `/portal/patient/pay/${orderId}`;

  // Get service and resolve multi-currency add-on prices
  const service = await queryOne('SELECT * FROM services WHERE id = $1', [order.service_id]);
  const countryCode = getUserCountryCode(req);
  const countryCurrency = getCountryCurrency(countryCode);
  const addonCurrency = order.locked_currency || countryCurrency || 'EGP';

  function resolvePriceFromJson(jsonStr, cur, fallback) {
    if (!jsonStr || jsonStr === '{}') return fallback || 0;
    try {
      var p = JSON.parse(jsonStr);
      var c = (cur || 'EGP').toUpperCase();
      if (p[c] !== undefined && p[c] !== null) return Number(p[c]);
      if (p.EGP !== undefined) return Number(p.EGP);
      return fallback || 0;
    } catch (_) { return fallback || 0; }
  }

  const videoConsultationPrice = resolvePriceFromJson(
    service?.video_consultation_prices_json,
    addonCurrency,
    service?.video_consultation_price || 0
  );
  const sla24hrPrice = resolvePriceFromJson(
    service?.sla_24hr_prices_json,
    addonCurrency,
    service?.sla_24hr_price || 100
  );

  // Look up prescription add-on price from service_regional_prices
  const prescriptionRow = await queryOne(
    "SELECT tashkheesa_price FROM service_regional_prices WHERE service_id = 'addon_prescription' AND currency = $1 LIMIT 1",
    [addonCurrency]
  );
  const prescriptionPrice = prescriptionRow ? prescriptionRow.tashkheesa_price : 0;

  // If payment link is missing OR is only the internal fallback, we can't send them to an external checkout yet.
  if (!rawPaymentLink || isInternalFallback) {
    return res.render('patient_payment_required', {
      user: req.user,
      order: {
        ...order,
        display_price: order && order.locked_price != null ? order.locked_price : null,
        display_currency: order && order.locked_currency ? order.locked_currency : null,
      },
      lang,
      isAr,
      paymentLink: copyLink,
      paymentUrl: null,
      price: order?.locked_price || order?.price || 0,
      currency: order?.locked_currency || 'SAR',
      videoConsultationPrice,
      sla24hrPrice,
      prescriptionPrice,
      serviceDetails: service,
      error: t(
        lang,
        'Payment is not configured for this service yet. Please contact support to complete checkout.',
        'الدفع غير مُعدّ لهذه الخدمة حالياً. يرجى التواصل مع الدعم لإكمال الدفع.'
      ),
    });
  }

  return res.render('patient_payment_required', {
    user: req.user,
    order: {
      ...order,
      display_price: order && order.locked_price != null ? order.locked_price : null,
      display_currency: order && order.locked_currency ? order.locked_currency : null,
    },
    lang,
    isAr,
    paymentUrl: rawPaymentLink,
    paymentLink: copyLink,
    price: order?.locked_price || order?.price || 0,
    currency: order?.locked_currency || 'SAR',
    videoConsultationPrice,
    sla24hrPrice,
    prescriptionPrice,
    serviceDetails: service,
    error: null,
  });
});

// loadReportContentForPatient — moved to src/helpers/load-report-content.js.
// Both this route file and routes/reports.js (the legacy /portal/case/:caseId
// /report viewer) now import the same helper, so the Fix 1 privacy invariant
// has a single auditable definition.

// Order detail — V2 tabbed chassis (Phase 4).
// Detects state (limbo / active / completed), renders the V2 layout.
// Fix 1 (privacy): explicit safe column allowlist — NEVER selects
// diagnosis_text, impression_text, recommendation_text, notes. Report content
// is fetched ONLY by the Report tab route in routes/reports.js.
router.get('/portal/patient/orders/:id', requireRole('patient'), async (req, res) => {
  const orderId = req.params.id;
  const patientId = req.user.id;
  const uploadClosed = req.query && req.query.upload_closed === '1';
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';
  const requestedTab = String((req.query && req.query.tab) || '').toLowerCase();
  const validTabs = ['overview', 'documents', 'messages', 'report'];
  let initialTab = validTabs.includes(requestedTab) ? requestedTab : 'overview';

  // Privacy-safe column allowlist. The Report tab fetches its own data via
  // routes/reports.js (which handles the actual report content separately).
  const SAFE_ORDER_COLS = `
    o.id, o.reference_code, o.status, o.payment_status, o.payment_link,
    o.locked_price, o.locked_currency, o.price,
    o.specialty_id, o.service_id, o.doctor_id,
    o.sla_hours, o.deadline_at, o.accepted_at, o.paid_at, o.completed_at,
    o.created_at, o.updated_at, o.urgency_flag, o.urgency_tier,
    o.uploads_locked, o.additional_files_requested,
    s.name AS specialty_name,
    sv.name AS service_name,
    sv.payment_link AS service_payment_link,
    d.name AS doctor_name
  `;

  let order = await queryOne(
    `SELECT ${SAFE_ORDER_COLS}
     FROM orders o
     LEFT JOIN specialties s ON o.specialty_id = s.id
     LEFT JOIN services sv ON o.service_id = sv.id
     LEFT JOIN users d ON d.id = o.doctor_id
     WHERE o.id = $1 AND o.patient_id = $2`,
    [orderId, patientId]
  );

  if (!order) return res.redirect('/dashboard');

  // Defensive backfill (non-blocking, never crash GET).
  try {
    if (
      order.payment_status === 'paid' &&
      (order.deadline_at == null || String(order.deadline_at).trim() === '')
    ) {
      if (typeof caseLifecycle.markCasePaid === 'function') {
        await caseLifecycle.markCasePaid(order.id);
      }
    }
  } catch (e) {
    console.error('[payment_backfill_failed]', { orderId: order.id, error: String(e) });
  }
  // Re-fetch with the privacy-safe column allowlist after any backfill.
  order = await queryOne(
    `SELECT ${SAFE_ORDER_COLS}
     FROM orders o
     LEFT JOIN specialties s ON o.specialty_id = s.id
     LEFT JOIN services sv ON o.service_id = sv.id
     LEFT JOIN users d ON d.id = o.doctor_id
     WHERE o.id = $1 AND o.patient_id = $2`,
    [orderId, patientId]
  );
  if (!order) return res.redirect('/dashboard');

  // Pre-payment: redirect to the existing payment page (preserved behavior).
  if (order.payment_status !== 'paid') {
    return res.redirect('/portal/patient/pay/' + encodeURIComponent(orderId));
  }

  // SLA refresh.
  enforceBreachIfNeeded(order);
  const computed = computeSla(order);
  order.effectiveStatus = computed.effectiveStatus;
  order.status = order.effectiveStatus || order.status;
  const sla = computed.sla;

  // Files for Documents tab. Both order_files (initial upload set) and
  // order_additional_files (post-doctor-request re-uploads) — the patient
  // sees them merged in chronological order (newest first).
  const files = await queryAll(
    `SELECT id, url, label, created_at, is_valid
     FROM order_files WHERE order_id = $1 ORDER BY created_at DESC`,
    [orderId]
  );
  files.forEach(f => { f.url = `/files/${f.id}`; });

  let additionalFiles = [];
  try {
    const addHasLabel = await hasColumn('order_additional_files', 'label');
    additionalFiles = await queryAll(
      `SELECT id,
              file_url AS url,
              ${addHasLabel ? 'label' : 'NULL'} AS label,
              uploaded_at AS created_at,
              NULL AS is_valid
       FROM order_additional_files WHERE order_id = $1 ORDER BY uploaded_at DESC`,
      [orderId]
    );
  } catch (_) { additionalFiles = []; }

  const allFiles = [...files, ...additionalFiles].sort((a, b) => {
    const aDate = new Date(a.created_at || 0).getTime();
    const bDate = new Date(b.created_at || 0).getTime();
    return bDate - aDate;
  });

  // V2 state detection.
  const statusUpper = String(order.effectiveStatus || order.status || '').toUpperCase();
  const completedStates = ['COMPLETED', 'DONE', 'DELIVERED', 'REPORT_READY', 'REPORT-READY', 'FINALIZED'];
  const isCompleted = completedStates.includes(statusUpper);
  const isLimbo = !order.doctor_id && (statusUpper === 'PAID');
  const dashboardState = isCompleted ? 'completed' : (isLimbo ? 'limbo' : 'active');

  // Does a delivered report exist? Used to (a) gate the Report tab being
  // enabled, (b) drive the "completed" state.
  let hasReport = false;
  try {
    const rpt = await queryOne(
      `SELECT id FROM report_exports WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [orderId]
    );
    hasReport = !!rpt;
  } catch (_) { hasReport = false; }

  // Disable initial-tab=report unless a report actually exists.
  if (initialTab === 'report' && !hasReport) initialTab = 'overview';

  // Time elapsed since payment — for limbo "Paid X ago" copy.
  const paidAgoSec = order.paid_at
    ? Math.max(0, Math.floor((Date.now() - new Date(order.paid_at).getTime()) / 1000))
    : null;

  // Conversation + messages for the V2 Messages tab. Uses the existing
  // conversations + messages tables exactly as-is — no new abstraction layer.
  var caseConversationId = null;
  let conversationMessages = [];
  try {
    if (order.doctor_id) {
      const { ensureConversation } = require('./messaging');
      caseConversationId = await ensureConversation(order.id, req.user.id, order.doctor_id);
    } else {
      const convo = await queryOne(
        'SELECT id FROM conversations WHERE order_id = $1 AND patient_id = $2 LIMIT 1',
        [order.id, req.user.id]
      );
      if (convo) caseConversationId = convo.id;
    }
    if (caseConversationId) {
      conversationMessages = await queryAll(
        `SELECT id, sender_id, sender_role, content, message_type, file_url, file_name, is_read, created_at
         FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 500`,
        [caseConversationId]
      );
      // Mark inbound (doctor → patient) messages as read whenever the patient
      // lands on the messages tab. This mirrors the legacy /portal/messages
      // page behavior. Best-effort.
      if (initialTab === 'messages' && conversationMessages.length > 0) {
        try {
          await execute(
            `UPDATE messages SET is_read = true
             WHERE conversation_id = $1 AND sender_id <> $2 AND COALESCE(is_read, false) = false`,
            [caseConversationId, req.user.id]
          );
        } catch (_) { /* non-blocking */ }
      }
    }
  } catch (_) { /* messaging is best-effort here */ }

  // Report content — fetched ONLY when a delivered, non-withdrawn report exists.
  // Privacy: this is the only route in the patient portal that selects report
  // body columns. Do not copy this SELECT shape elsewhere.
  let reportContent = null;
  if (hasReport && isCompleted) {
    reportContent = await loadReportContentForPatient(orderId);
  }

  const langCode = isAr ? 'ar' : 'en';
  const statusUi = getStatusUi(
    String(canonOrOriginal(order.effectiveStatus || order.status) || '').trim().toUpperCase(),
    { role: 'patient', lang: langCode }
  );

  res.render('patient_order', {
    user: req.user,
    lang, isAr,
    order,
    files: allFiles,
    sla,
    statusUi,
    dashboardState,
    isLimbo,
    isCompleted,
    hasReport: !!reportContent,
    reportContent,
    paidAgoSec,
    initialTab,
    caseConversationId,
    conversationMessages,
    uploadClosed,
    uploadSuccess: !!(req.query && req.query.uploaded),
    sent: !!(req.query && req.query.sent),
    msgErr: (req.query && typeof req.query.err === 'string') ? req.query.err : '',
    uploadcarePublicKey: String(process.env.UPLOADCARE_PUBLIC_KEY || '').trim()
  });
});

// POST /portal/patient/orders/:id/messages — Patient sends a message in the
// V2 Messages tab. Optional file_url attaches an Uploadcare-uploaded file as
// a message AND mirrors it into order_additional_files so the doctor sees it
// as both a chat message and a "patient uploaded files" item.
//
// Uses the existing `messages` and `conversations` tables exactly as-is.
// No new abstraction layer per Phase 5 spec.
router.post('/portal/patient/orders/:id/messages', requireRole('patient'), async (req, res) => {
  const patientId = req.user.id;
  const orderId = String(req.params.id || '').trim();
  const body = req.body || {};
  const rawText = String(body.content || '').trim().slice(0, 5000);
  const fileUrl = String(body.file_url || '').trim();
  const fileName = String(body.file_name || '').trim().slice(0, 200);

  // Must have either text or a file.
  if (!rawText && !fileUrl) {
    return res.redirect(`/portal/patient/orders/${encodeURIComponent(orderId)}?tab=messages&err=empty_message`);
  }

  // Validate ownership.
  const order = await queryOne(
    'SELECT id, doctor_id, status FROM orders WHERE id = $1 AND patient_id = $2',
    [orderId, patientId]
  );
  if (!order) return res.redirect('/dashboard');

  // Need a doctor assigned before any message can be sent — limbo state
  // shows the disabled empty-state and never renders the input form, but
  // double-check server-side.
  if (!order.doctor_id) {
    return res.redirect(`/portal/patient/orders/${encodeURIComponent(orderId)}?tab=messages&err=no_doctor_yet`);
  }

  let conversationId = null;
  try {
    const { ensureConversation } = require('./messaging');
    conversationId = await ensureConversation(orderId, patientId, order.doctor_id);
  } catch (e) {
    console.error('[v2-messages] ensureConversation failed', e && e.message ? e.message : e);
  }
  if (!conversationId) {
    return res.redirect(`/portal/patient/orders/${encodeURIComponent(orderId)}?tab=messages&err=conversation_unavailable`);
  }

  const nowIso = new Date().toISOString();

  // 1. If a file is attached, mirror it into order_additional_files (same
  //    contract Phase 3B used for re-uploads after doctor requests). The
  //    file_url is the Uploadcare CDN URL the client widget produced.
  if (fileUrl && /^https?:\/\//i.test(fileUrl)) {
    try {
      await insertAdditionalFile(orderId, fileUrl, fileName || null, nowIso);
    } catch (e) {
      console.warn('[v2-messages] additional-file insert failed', e && e.message ? e.message : e);
    }
  }

  // 2. Insert the message row. message_type = 'file' if attached and no text
  //    body, else 'text'. file_url + file_name carry the attachment.
  const messageId = randomUUID();
  const messageType = (fileUrl && !rawText) ? 'file' : 'text';
  const content = rawText || (fileName || (isAr_safe(req) ? 'ملف' : 'File'));
  try {
    await execute(
      `INSERT INTO messages
         (id, conversation_id, sender_id, sender_role, content, message_type, file_url, file_name, created_at)
       VALUES ($1, $2, $3, 'patient', $4, $5, $6, $7, $8)`,
      [messageId, conversationId, patientId, content, messageType, fileUrl || null, fileName || null, nowIso]
    );
    await execute('UPDATE conversations SET updated_at = $1 WHERE id = $2', [nowIso, conversationId]);
  } catch (e) {
    console.error('[v2-messages] insert failed', e && e.message ? e.message : e);
    return res.redirect(`/portal/patient/orders/${encodeURIComponent(orderId)}?tab=messages&err=send_failed`);
  }

  // 3. Notify the doctor — same dedupe pattern as the legacy /portal/messages send.
  try {
    const dedupeWindow = Math.floor(Date.now() / (10 * 60 * 1000));
    queueMultiChannelNotification({
      orderId,
      toUserId: order.doctor_id,
      channels: ['internal', 'email'],
      template: 'new_message',
      response: {
        case_id: orderId,
        caseReference: orderId.slice(0, 12).toUpperCase(),
        senderName: req.user.name || 'Patient',
        messagePreview: content.slice(0, 100)
      },
      dedupe_key: 'message:' + conversationId + ':' + dedupeWindow
    });
  } catch (_) { /* notification failure must not block the redirect */ }

  return res.redirect(`/portal/patient/orders/${encodeURIComponent(orderId)}?tab=messages&sent=1`);
});

function isAr_safe(req) {
  try { return (req && req.session && req.session.lang === 'ar') ? true : false; } catch (_) { return false; }
}

// Patient initiates messaging — lazy conversation creation then redirect
router.get('/portal/patient/case/:caseId/start-message', requireRole('patient'), async (req, res) => {
  try {
    const patientId = req.user.id;
    const orderId = req.params.caseId;
    const order = await queryOne(
      'SELECT id, doctor_id, patient_id FROM orders WHERE id = $1 AND patient_id = $2',
      [orderId, patientId]
    );
    if (!order) return res.redirect('/dashboard');
    if (!order.doctor_id) {
      // No doctor assigned yet — redirect back to case page
      return res.redirect(`/portal/patient/orders/${orderId}?msg=no_doctor`);
    }
    const { ensureConversation } = require('./messaging');
    const conversationId = await ensureConversation(orderId, patientId, order.doctor_id);
    if (!conversationId) return res.redirect(`/portal/patient/orders/${orderId}`);
    return res.redirect(`/portal/messages/${conversationId}`);
  } catch (err) {
    return res.redirect('/portal/messages');
  }
});

// Patient replies to doctor's clarification request
router.post('/portal/patient/orders/:id/submit-info', requireRole('patient'), async (req, res) => {
  const orderId = req.params.id;
  const patientId = req.user.id;
  const message = (req.body && req.body.message ? String(req.body.message) : '').trim();

  const order = await queryOne(
    'SELECT * FROM orders WHERE id = $1 AND patient_id = $2',
    [orderId, patientId]
  );

  if (!order) {
    return res.redirect('/dashboard');
  }

  const nowIso = new Date().toISOString();
  const meta = message || 'File uploaded';

  logOrderEvent({
    orderId,
    label: 'patient_reply',
    meta,
    actorUserId: patientId,
    actorRole: 'patient'
  });

  // IMPORTANT: do NOT clear additional_files_requested here.
  // That flag is the re-upload workflow gate and should only be cleared when the patient uploads files.
  await execute(
    `UPDATE orders
     SET updated_at = $1
     WHERE id = $2`,
    [nowIso, orderId]
  );

  if (order.doctor_id) {
    queueNotification({
      orderId,
      toUserId: order.doctor_id,
      channel: 'internal',
      template: 'patient_reply_info',
      status: 'queued'
    });
  }

  // Placeholder: file upload handling can be added here if needed.
  return res.redirect(`/portal/patient/orders/${orderId}`);
});

// GET upload page
router.get('/portal/patient/orders/:id/upload', requireRole('patient'), async (req, res) => {
  const orderId = req.params.id;
  const patientId = req.user.id;
  const { locked = '', uploaded = '', error = '' } = req.query || {};

  const order = await queryOne(
    `SELECT o.*, s.name AS specialty_name, sv.name AS service_name
     FROM orders o
     LEFT JOIN specialties s ON o.specialty_id = s.id
     LEFT JOIN services sv ON o.service_id = sv.id
     WHERE o.id = $1 AND o.patient_id = $2`,
    [orderId, patientId]
  );

  if (!order) {
    return res.redirect('/dashboard');
  }

  const files = await queryAll(
    `SELECT id, url, label, created_at
     FROM order_files
     WHERE order_id = $1
     ORDER BY created_at DESC`,
    [orderId]
  );
  // Phase 2.5: see comment on the corresponding block in the order detail
  // route above — route every order_files row through /files/:id.
  files.forEach(f => { f.url = `/files/${f.id}`; });

  const addHasLabel = await hasColumn('order_additional_files', 'label');
  const additionalFiles = await queryAll(
    `SELECT id,
            file_url AS url,
            ${addHasLabel ? 'label' : 'NULL'} AS label,
            uploaded_at AS created_at
     FROM order_additional_files
     WHERE order_id = $1
     ORDER BY uploaded_at DESC`,
    [orderId]
  );

  res.render('patient_order_upload', {
    user: req.user,
    order,
    files: [...files, ...additionalFiles],
    errorCode:
      error === '1'
        ? 'missing'
        : error === 'missing_uploader'
          ? 'missing_uploader'
          : error === 'invalid_url'
            ? 'invalid_url'
            : error === 'too_many'
              ? 'too_many'
              : error === 'locked'
                ? 'locked'
                : null,
    locked: locked === '1',
    uploaded: uploaded === '1',
    uploadcarePublicKey: process.env.UPLOADCARE_PUBLIC_KEY || '',
    uploaderConfigured: String(process.env.UPLOADCARE_PUBLIC_KEY || '').trim().length > 0
  });
});

// POST upload
router.post('/portal/patient/orders/:id/upload', requireRole('patient'), async (req, res) => {
  const orderId = req.params.id;
  const patientId = req.user.id;
  const { file_url, file_urls, label } = req.body || {};

  const uploaderConfigured = String(process.env.UPLOADCARE_PUBLIC_KEY || '').trim().length > 0;
  const cleanLabel = (label && String(label).trim()) ? String(label).trim().slice(0, 120) : null;

  const order = await queryOne(
    'SELECT * FROM orders WHERE id = $1 AND patient_id = $2',
    [orderId, patientId]
  );

  if (!order) {
    return res.redirect('/dashboard');
  }

  const uploadsLocked = Number(order.uploads_locked) === 1;
  const isCompleted = isCanonStatus(order.status, 'COMPLETED');

  if (uploadsLocked || isCompleted) {
    return res.redirect(`/portal/patient/orders/${orderId}/upload?error=locked`);
  }

  const urls = [];
  if (file_url && String(file_url).trim()) urls.push(String(file_url).trim());
  if (Array.isArray(file_urls)) {
    file_urls.forEach((u) => {
      if (u && String(u).trim()) urls.push(String(u).trim());
    });
  }

  if (urls.length === 0) {
    // If uploader isn't configured, fail with a clear message.
    if (!uploaderConfigured) {
      return res.redirect(`/portal/patient/orders/${orderId}/upload?error=missing_uploader`);
    }
    return res.redirect(`/portal/patient/orders/${orderId}/upload?error=missing`);
  }

  // Basic URL validation: accept only http/https to avoid junk strings
  const filtered = urls
    .map((u) => u.slice(0, 2048))
    .filter((u) => /^https?:\/\//i.test(u));

  const MAX_FILES_PER_REQUEST = 10;
  if (filtered.length > MAX_FILES_PER_REQUEST) {
    return res.redirect(`/portal/patient/orders/${orderId}/upload?error=too_many`);
  }

  if (filtered.length === 0) {
    return res.redirect(`/portal/patient/orders/${orderId}/upload?error=invalid_url`);
  }

  const now = new Date().toISOString();

  // Determine if order was in additional-files-requested state
  const isCompletedStatus = isCanonStatus(order.status, 'COMPLETED');
  const wasAdditionalFilesRequested = Number(order.additional_files_requested) === 1;
  // DRAFT mode: this is a NEW case being assembled in the wizard. Files belong
  // in order_files (the canonical pre-submission table the validation worker
  // reads), not order_additional_files (the post-doctor-request re-upload table).
  // Same upload endpoint, same enqueueCaseIntelligence call below — no changes
  // to the pg-boss queue payload, job name, or worker.
  const isDraft = String(order.status || '').toUpperCase() === 'DRAFT';

  try {
    await withTransaction(async (client) => {
      for (const u of filtered) {
        if (isDraft) {
          await client.query(
            `INSERT INTO order_files (id, order_id, url, label, created_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [randomUUID(), orderId, u, cleanLabel, now]
          );
        } else {
          await insertAdditionalFile(orderId, u, cleanLabel, now, client);
        }
      }

      logOrderEvent({
        orderId,
        label: isDraft ? 'patient_uploaded_draft_file' : 'patient_uploaded_additional_files',
        meta: `count=${filtered.length}${cleanLabel ? `;label=${cleanLabel}` : ''}`,
        actorUserId: patientId,
        actorRole: 'patient'
      });

      // If doctor requested more files, clear the flag once patient uploads.
      // Optional guardrail: re-lock uploads after the re-upload so the case doesn't drift.
      if (wasAdditionalFilesRequested) {
        await client.query(
          `UPDATE orders
           SET additional_files_requested = 0,
               uploads_locked = 1,
               updated_at = $1
           WHERE id = $2`,
          [now, orderId]
        );
      } else {
        await client.query(
          `UPDATE orders
           SET additional_files_requested = 0,
               updated_at = $1
           WHERE id = $2`,
          [now, orderId]
        );
      }
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[patient upload] failed', err);
    return res.redirect(`/portal/patient/orders/${orderId}/upload?error=invalid_url`);
  }

  // Case intelligence pipeline (queued via pg-boss for crash recovery)
  enqueueCaseIntelligence(orderId).catch(function(err) {
    console.error('Case intelligence enqueue failed:', err);
  });

  // Notify assigned doctor that additional files were uploaded.
  if (order.doctor_id) {
    queueMultiChannelNotification({
      orderId,
      toUserId: order.doctor_id,
      channels: ['internal', 'email', 'whatsapp'],
      template: 'patient_uploaded_files_doctor',
      response: {
        case_id: orderId,
        caseReference: orderId.slice(0, 12).toUpperCase(),
        patientName: req.user.name || 'Patient'
      },
      dedupe_key: 'patient_uploaded:' + orderId + ':' + Date.now()
    });

    // Phase 4: parallel direct email to the doctor so the notification lands
    // even if the queueMultiChannelNotification system is gated off
    // (EMAIL_ENABLED=false). Fire-and-forget — failure must never break
    // the upload response.
    try {
      const emailService = require('../services/emailService');
      const doctor = await queryOne('SELECT email FROM users WHERE id = $1', [order.doctor_id]);
      const refRow = await queryOne(
        'SELECT COALESCE(o.reference_id, c.reference_code) AS reference_id FROM orders o LEFT JOIN cases c ON c.id = o.id WHERE o.id = $1',
        [orderId]
      );
      const refId = (refRow && refRow.reference_id) || String(orderId).slice(0, 12).toUpperCase();
      if (doctor && doctor.email) {
        await emailService.notifyDoctorFileUploaded(doctor.email, refId, req.user.name || 'Patient');
      }
    } catch (err) {
      console.error('[EMAIL] notifyDoctorFileUploaded failed:', err && err.message);
    }
  }

  // For DRAFT-mode uploads (the new 5-step wizard) redirect back to Step 2 of
  // the wizard so the patient stays in the flow. Otherwise preserve the
  // existing post-doctor-request behavior.
  if (isDraft) {
    return res.redirect('/patient/new-case?step=2&id=' + encodeURIComponent(orderId) + '&uploaded=1');
  }
  return res.redirect('/portal/patient/orders/' + orderId + '?uploaded=1');
});

module.exports = router;
