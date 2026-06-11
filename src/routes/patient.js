// src/routes/patient.js
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { requireRole } = require('../middleware');
const { queryOne, queryAll, execute, withTransaction } = require('../pg');
const { logErrorToDb } = require('../logger');
const { queueNotification, queueMultiChannelNotification, notifyAdmins } = require('../notify');
const { getNotificationTitles } = require('../notify/notification_titles');
const { randomUUID } = require('crypto');
const { logOrderEvent } = require('../audit');
var { enqueueCaseIntelligence } = require('../job_queue');
const { computeSla, enforceBreachIfNeeded } = require('../sla_status');
const { buildWizardPricing, buildStep4Persistence } = require('../services/wizard_pricing');
const { isUrgentWindowOpen, nextSevenAmCairoUtc } = require('../services/urgency_window');
const { modelHaiku } = require('../config/anthropic');
const { getThresholds } = require('../services/admin_settings');

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

// ============ AI QUALITY → wizard validation shape ============
// The wizard polling code + Step 2 hydration + case-detail Documents tab
// historically read a `is_valid` boolean column from order_files. That
// column does not exist — Phase 3A introduced the SELECT but the schema
// only has `ai_quality_status` (text). The text values are written by
// src/routes/api/cases.js when the AI image checker finishes:
//   'pending'                                → checking (null)
//   'ok' | 'acceptable' | 'skipped'          → readable (true)
//   'poor_quality' | 'not_medical' |
//     'wrong_type' | 'error'                 → flagged (false)
//   null                                     → checking (null)
//
// `mapAiQualityToIsValid` keeps the wizard/template/poll API stable
// (each consumer still reads `f.is_valid`) while the underlying column
// rename is absorbed here. If a future migration renames the column
// or adds states, change this helper in one place.
const AI_QUALITY_READABLE = new Set(['ok', 'acceptable', 'skipped']);
const AI_QUALITY_FLAGGED  = new Set(['poor_quality', 'not_medical', 'wrong_type', 'error']);
function mapAiQualityToIsValid(rawStatus) {
  const s = (rawStatus == null ? '' : String(rawStatus)).toLowerCase();
  if (!s || s === 'pending') return null;
  if (AI_QUALITY_READABLE.has(s)) return true;
  if (AI_QUALITY_FLAGGED.has(s))  return false;
  return null; // unknown future state — treat as still-checking
}
// ==============================================================

const router = express.Router();
// Theme 13 Sub-issue B: `r2DirectEnabled` joins the wizard locals so the
// new patient_new_case.ejs script branch can render the FormData uploader
// in place of the Uploadcare widget. Both code paths coexist in the EJS;
// the flag controls which one renders. See THEME_13_R2_MIGRATION_FIX_PLAN.md
// §7 for the rollback playbook.
//
// `uploadcarePublicKey` now trims at the source (was inconsistent — the GET
// wizard handler trimmed; the spread sites did not). Phase 5 cleanup
// (Sub-issue G) renames this object once the legacy widget retires.
const uploadcareLocals = {
  uploadcarePublicKey: String(process.env.UPLOADCARE_PUBLIC_KEY || '').trim(),
  uploaderConfigured: String(process.env.UPLOADCARE_PUBLIC_KEY || '').trim().length > 0,
  r2DirectEnabled: String(process.env.UPLOAD_R2_DIRECT_ENABLED || '').toLowerCase() === 'true',
  // Theme 13 Sub-issue C2.C: parallel flag for the messages-attach widget.
  // AND-gated with r2DirectEnabled in patient_order.ejs (per §8 Q3) so the
  // operator can never end up in the misconfigured state "wizard on R2,
  // messages on Uploadcare." Independent rollback per surface.
  messagesR2Enabled: String(process.env.MESSAGES_R2_ENABLED || '').toLowerCase() === 'true',
};

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
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
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
    const rawPhone = String(req.body.phone || '').trim();
    const prefLang = (req.body.lang === 'ar') ? 'ar' : 'en';
    const notifyWhatsapp = req.body.notify_whatsapp === '1' ? 1 : 0;
    const emailOptOut = req.body.email_marketing_opt_out === '1' ? 1 : 0;
    const dateOfBirth = String(req.body.date_of_birth || '').trim().slice(0, 10) || null;
    const gender = ['male', 'female', 'other'].includes(req.body.gender) ? req.body.gender : null;
    const countryCode = isLaunchMarket(req.body.country_code) ? String(req.body.country_code).trim().toUpperCase() : null;

    if (!name) {
      return renderPatientProfile(req, res, { error: isAr ? 'الاسم مطلوب' : 'Name is required' });
    }

    // P0-FORM-1: phone is required + must validate to E.164. Profile is
    // an exempt route from requirePhone() so users can edit it, but they
    // cannot blank it (would re-trigger the gate on next request anyway,
    // and would silently break WhatsApp dispatch in the meantime).
    if (!rawPhone) {
      return renderPatientProfile(req, res, {
        error: isAr ? 'رقم الهاتف مطلوب — لا يمكن مسحه.' : 'Phone number is required — it cannot be cleared.'
      });
    }
    const { validatePhoneE164 } = require('../validators/phone');
    const phoneCheck = validatePhoneE164(rawPhone, lang);
    if (!phoneCheck.ok) {
      return renderPatientProfile(req, res, { error: phoneCheck.error });
    }
    const phone = phoneCheck.normalized;

    await execute(
      'UPDATE users SET name = $1, phone = $2, lang = $3, notify_whatsapp = $4, email_marketing_opt_out = $5, date_of_birth = $6, gender = $7, country_code = $8 WHERE id = $9',
      [name, phone, prefLang, notifyWhatsapp, emailOptOut, dateOfBirth, gender, countryCode, userId]
    );

    // P0-FORM-1: re-sign cookie with fresh phone/name/lang/country so
    // requirePhone() gate sees the updated value on the next request.
    try {
      const { refreshSessionCookie } = require('../auth');
      refreshSessionCookie(res, Object.assign({}, req.user, {
        name: name,
        phone: phone,
        lang: prefLang,
        country_code: countryCode
      }));
    } catch (_) { /* cookie refresh is non-critical */ }

    // Refresh user object for re-render
    const updated = await queryOne('SELECT * FROM users WHERE id = $1', [userId]);
    if (updated) req.user = updated;

    return renderPatientProfile(req, res, { success: isAr ? 'تم حفظ التغييرات بنجاح' : 'Changes saved successfully' });
  } catch (err) {
    logErrorToDb(err, {
      context: 'patient.profile_update',
      requestId: req.requestId,
      userId: req.user?.id,
      url: req.originalUrl,
      method: req.method,
      category: 'patient_action'
    });
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

  // The `response` column is the queue worker's internal debug payload
  // ({"ok":true}, {"error":"..."}). It must never be surfaced to the patient.
  // We only show the human title (looked up from getPatientNotificationTitles
  // in the view) — no body text. If a future schema adds a localised body
  // column, surface it here instead.
  const message = '';

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
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
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
    logErrorToDb(e, {
      context: 'patient.alerts_json_fetch',
      requestId: req.requestId,
      userId: req.user?.id,
      url: req.originalUrl,
      method: req.method,
      category: 'patient_case'
    });
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
    logErrorToDb(e, {
      context: 'patient.alerts_mark_all_read',
      requestId: req.requestId,
      userId: req.user?.id,
      url: req.originalUrl,
      method: req.method,
      category: 'patient_case'
    });
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
    logErrorToDb(e, {
      context: 'patient.alerts_mark_read',
      requestId: req.requestId,
      userId: req.user?.id,
      url: req.originalUrl,
      method: req.method,
      category: 'patient_case'
    });
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
const { coerceCountry, isLaunchMarket } = require('../launch-market');
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
  // LAUNCH GATE (src/launch-market.js): pricing country is clamped to a launch
  // market (EG today). Re-enable a market by widening LAUNCH_MARKETS.
  try {
    const fromUser = normalizeCountryCode(req && req.user && (req.user.country_code || req.user.country));
    if (fromUser) return coerceCountry(fromUser);

    const headerCountry = normalizeCountryCode(req && req.headers && (req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || req.headers['x-country']));
    if (headerCountry) return coerceCountry(headerCountry);

    const ip = getRequestIp(req);
    const fromGeo = normalizeCountryCode(lookupCountryFromIp(ip));
    if (fromGeo) return coerceCountry(fromGeo);

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

async function insertAdditionalFile(orderId, url, labelValue, nowIso, client, key) {
  // Theme 13 Sub-issue C2.F — opt-in `key` 6th arg writes to file_key column
  // instead of file_url. Caller is responsible for exactly-one-of-two
  // (the unified /files/:id resolver applies file_key || file_url precedence
  // per Q-C, so both-set wouldn't crash, but the contract is XOR). When
  // key is non-null, url is ignored.
  const useKey = !!(key && String(key).trim());
  const targetCol = useKey ? 'file_key' : 'file_url';
  const writeValue = useKey ? String(key).trim() : url;

  const withLabelSql =
    `INSERT INTO order_additional_files (id, order_id, ${targetCol}, label, uploaded_at)
     VALUES ($1, $2, $3, $4, $5)`;
  const noLabelSql =
    `INSERT INTO order_additional_files (id, order_id, ${targetCol}, uploaded_at)
     VALUES ($1, $2, $3, $4)`;

  const runWithLabel = async () => {
    const q = client ? client.query.bind(client) : execute;
    await q(withLabelSql, [randomUUID(), orderId, writeValue, labelValue || null, nowIso]);
  };
  const runNoLabel = async () => {
    const q = client ? client.query.bind(client) : execute;
    await q(noLabelSql, [randomUUID(), orderId, writeValue, nowIso]);
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
    const body = JSON.stringify({ model: modelHaiku(), max_tokens: 150, messages: [{ role: 'user', content: promptText }] });
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
    logErrorToDb(error, {
      context: 'patient.analyze_case_type',
      requestId: req.requestId,
      userId: req.user?.id,
      url: req.originalUrl,
      method: req.method,
      category: 'patient_case'
    });
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
    'o.id', 'o.reference_id', 'o.status', 'o.payment_status', 'o.doctor_id',
    'o.specialty_id', 'o.service_id', 'o.sla_hours', 'o.deadline_at',
    'o.accepted_at', 'o.paid_at', 'o.completed_at', 'o.created_at', 'o.updated_at',
    'o.urgency_flag', 'o.uploads_locked', 'o.additional_files_requested',
    's.name AS specialty_name',
    's.name_ar AS specialty_name_ar',
    'sv.name AS service_name',
    'd.name AS doctor_name'
  ].join(', ');

  // 1. Most recent active case — paid, not completed/cancelled, may be in limbo (PAID + no doctor).
  const activeOrderPromise = queryOne(
    `SELECT ${SAFE_ORDER_COLS}
     FROM orders_active o
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
     FROM orders_active o
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
    `SELECT o.id, o.created_at, o.updated_at, s.name AS specialty_name, s.name_ar AS specialty_name_ar, sv.name AS service_name
     FROM orders_active o
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
    logErrorToDb(e, {
      context: 'patient.dashboard_order_fetch',
      requestId: req.requestId,
      userId: req.user?.id,
      url: req.originalUrl,
      method: req.method,
      category: 'patient_case'
    });
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
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
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
       FROM orders_active o WHERE o.id = $1`,
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
    // THEME8-LINT-EXEMPT-HELPER: diagnostic warning only — fires when draft_step
    // column-stored value diverges from inferred value. Not an error; signals a
    // wizard-step write path missed the column bump. Has no `req` available here
    // (helper) and no associated catch — wrapping with logErrorToDb would
    // synthesize a fake Error for a non-error code path.
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
            o.base_price, o.urgency_uplift_amount, o.price, o.urgency_flag,
            o.notes, o.created_at, o.updated_at,
            s.name AS specialty_name, s.name_ar AS specialty_name_ar, sv.name AS service_name
     FROM orders_active o
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
    // Side issue #84 — explicit "fresh case" intent (?fresh=1) bypasses
    // the 30-day-DRAFT auto-resume. Fired by the sidebar / mobile-tabbar
    // "New case" entries and by the dashboard "Discard & start fresh"
    // POST redirect. Without this gate, returning patients couldn't start
    // a second case while a draft was still open — every entry point
    // landed them back on the draft.
    const isFresh = String(req.query && req.query.fresh) === '1';
    if (!isFresh) {
      // No fresh-intent — auto-resume the most recent <30-day DRAFT.
      try {
        const latest = await queryOne(
          `SELECT id FROM orders_active
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
    }
    step = 1;
  }

  // For Step 2, hydrate file list. For Step 3+, hydrate specialties/services + pricing.
  let files = [];
  let specialties = [];
  let services = [];
  let pricing = null;
  // Theme 14 Phase 3 — AI specialty recommendation for Step 3. Populated from
  // the latest specialty_classifications row for this case. Null when no
  // classification exists yet (Step 2 POST classifier failure → graceful
  // fallback to the supply-blind legacy grid in the EJS).
  let specialtyRec = null;
  if (draft && step >= 2) {
    files = await queryAll(
      `SELECT id, url, label, created_at, ai_quality_status
       FROM order_files WHERE order_id = $1
       ORDER BY created_at ASC`,
      [draft.id]
    );
    files.forEach(f => {
      f.url = '/files/' + f.id;
      f.is_valid = mapAiQualityToIsValid(f.ai_quality_status);
    });
  }
  if (draft && step === 3) {
    // Theme 14 Phase 3 — supply-blind specialty list. Active-doctor count
    // is no longer surfaced to patients (UX fix A removed the per-card
    // "X consultants available" display; UX fix B removed the parent
    // subtext). Doctor availability is decided downstream at auto-assign
    // time. The previous LEFT JOIN on the active-doctor sub-query is dead
    // weight post-polish and dropped here.
    try {
      specialties = await queryAll(
        `SELECT id, name, name_ar
         FROM specialties
         WHERE COALESCE(is_visible, true) = true
         ORDER BY name ASC`,
        []
      );
    } catch (_) { specialties = []; }
    // Theme 14 Phase 3 + polish — load the latest AI classification.
    // Post-polish, the row also carries the AI's service_id pick. Null
    // service_id is fine (ambiguous-case path); EJS handles it via the
    // legacy services-card filtering on the chosen specialty.
    try {
      const classRow = await queryOne(
        `SELECT specialty_id, service_id, confidence, reasoning
         FROM specialty_classifications
         WHERE case_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [draft.id]
      );
      if (classRow) {
        specialtyRec = {
          specialty_id: classRow.specialty_id,
          service_id:   classRow.service_id,
          confidence:   Number(classRow.confidence) || 0,
          reasoning:    classRow.reasoning || ''
        };
      }
    } catch (_) { specialtyRec = null; }
    // Async classifier UX: when no classification row exists yet on Step 3,
    // the view shows a polling banner above the legacy grid and reloads when
    // the row lands. See patient_new_case.ejs step-3 default-grid branch.
    var classifierPending = (specialtyRec === null);
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
                               sv.vip_multiplier, sv.urgent_multiplier,
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

        const localCurrency = String((localPrice && localPrice.currency) || countryCurrency || 'EGP').toUpperCase();
        pricing = buildWizardPricing({
          serviceName: localPrice ? localPrice.name : '',
          localBase: Number(localPrice && localPrice.base_price) || 0,
          egpBase: Number(egpPrice && egpPrice.tashkheesa_price) || 0,
          localCurrency,
          vipMultiplier: localPrice && localPrice.vip_multiplier,
          urgentMultiplier: localPrice && localPrice.urgent_multiplier
        });
      } catch (e) {
        logErrorToDb(e, {
          context: 'patient.wizard_step4_pricing',
          requestId: req.requestId,
          userId: req.user?.id,
          url: req.originalUrl,
          method: req.method,
          category: 'patient_case'
        });
        console.warn('[wizard step4 pricing] failed', e && e.message ? e.message : e);
        pricing = null;
      }
    }
  }

  // Theme 14 Phase 4 — classifier tier thresholds, live-tunable from
  // /superadmin/settings (migration 061 seeded the rows; helper caches
  // for 60s + falls back to hardcoded defaults on DB error). Only Step 3
  // actually consumes these; the other steps render the same template
  // but the recommendation card block at patient_new_case.ejs:343-352
  // only engages when specialtyRecommendation is non-null.
  const thresholds = await getThresholds();

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
    ...uploadcareLocals,
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
    paymentFailed: !!(req.query && req.query.failed),
    queryErr: (req.query && typeof req.query.err === 'string') ? req.query.err : '',
    uploadedFlash: !!(req.query && req.query.uploaded),
    // Theme 14 Phase 3 — AI specialty recommendation. Populated by the
    // step===3 branch above from the latest specialty_classifications row
    // for this case; null when no classification exists (classifier failure
    // at Step 2 POST → graceful EJS fallback to the supply-blind grid).
    specialtyRecommendation: specialtyRec,
    thresholds,
    // Async classifier banner trigger: true when Step 3 loaded but no row
    // yet (worker still running or failed). View polls classification.json
    // and reloads on status==='ready'.
    classifierPending: (typeof classifierPending !== 'undefined') ? classifierPending : false
  });
});

// Legacy alias — consolidate per Phase 0. Preserves old bookmarks.
router.get('/portal/patient/orders/new', requireRole('patient'), (req, res) => {
  const qs = (req.query && req.query.specialty_id)
    ? '?prefill_specialty=' + encodeURIComponent(String(req.query.specialty_id))
    : '';
  return res.redirect(301, '/patient/new-case' + qs);
});

// Side issue #73 — bare /portal/patient collection URLs 404 today because
// no router.get exists for them (only parametrized children exist). Surface
// to the v2 dashboard via 302. Type-302 (not 301) because the dashboard
// route is the canonical destination and we want browser-caching to remain
// flexible if the dashboard ever moves.
router.get('/portal/patient',         requireRole('patient'), (req, res) => res.redirect(302, '/dashboard'));
router.get('/portal/patient/orders',  requireRole('patient'), (req, res) => res.redirect(302, '/dashboard'));

// GET /patient/cases — patient-facing list of all the patient's cases (side
// issue #83). Renders the same patient/ chrome as /dashboard but with the
// sidebar's "cases" key active. Until this landed, the sidebar's "My cases"
// nav entry routed back to /dashboard and the patient effectively had no
// per-case list view. Filters: drop EXPIRED_UNPAID + EXPIRED_DRAFT (terminal
// hygiene) and drop DRAFT rows older than 30 days (matches the dashboard
// resume-tile cutoff at patient.js:1069).
router.get('/patient/cases', requireRole('patient'), async (req, res) => {
  const patientId = req.user.id;
  const langCode = (res.locals && res.locals.lang === 'ar') ? 'ar' : 'en';
  const isAr = langCode === 'ar';

  // Privacy-safe column allowlist — mirrors patient.js:1012 (dashboard).
  // No report-content columns (notes, diagnosis_text, etc.); defense in
  // depth so a future template change can't accidentally leak them.
  const SAFE_ORDER_COLS = [
    'o.id', 'o.reference_id', 'o.status', 'o.payment_status',
    'o.specialty_id', 'o.service_id', 'o.doctor_id',
    'o.sla_hours', 'o.deadline_at', 'o.created_at', 'o.updated_at', 'o.completed_at',
    's.name AS specialty_name',
    's.name_ar AS specialty_name_ar',
    'sv.name AS service_name',
    'd.name AS doctor_name'
  ].join(', ');

  let cases = [];
  try {
    cases = await queryAll(
      `SELECT ${SAFE_ORDER_COLS}
       FROM orders_active o
       LEFT JOIN specialties s ON s.id = o.specialty_id
       LEFT JOIN services sv ON sv.id = o.service_id
       LEFT JOIN users d ON d.id = o.doctor_id
       WHERE o.patient_id = $1
         AND UPPER(COALESCE(o.status, '')) NOT IN ('EXPIRED_UNPAID', 'EXPIRED_DRAFT')
         AND NOT (
           UPPER(COALESCE(o.status, '')) = 'DRAFT'
           AND COALESCE(o.updated_at, o.created_at) <= NOW() - INTERVAL '30 days'
         )
       ORDER BY o.created_at DESC
       LIMIT 100`,
      [patientId]
    );
  } catch (err) {
    logErrorToDb(err, {
      context: 'patient.cases_list',
      requestId: req.requestId,
      userId: patientId,
      url: req.originalUrl,
      method: req.method,
      category: 'patient_case'
    });
    console.error('[/patient/cases] fetch failed', err && err.message ? err.message : err);
  }

  // Resolve a per-row statusUi so the view can render the badge without
  // pulling caseLifecycle into the EJS scope.
  for (const c of cases) {
    try {
      c.statusUi = getStatusUi(String(c.status || '').toUpperCase(), { role: 'patient', lang: langCode });
    } catch (_) { c.statusUi = null; }
  }

  return res.render('patient_cases', {
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
    user: req.user,
    lang: langCode,
    isAr,
    cases
  });
});

// Side issue #82 — sidebar + mobile tabbar pointed at /portal/patient/messages
// for the patient inbox; the canonical handler lives at /portal/messages
// (src/routes/messaging.js:72, shared with doctors). Defensive 302 alias
// matches the doctor-side pattern at src/routes/doctor.js:915. Type-302 (not
// 301) keeps a future dedicated /portal/patient/messages page reversible.
router.get('/portal/patient/messages', requireRole('patient'), (req, res) => res.redirect(302, '/portal/messages'));

// POST /patient/new-case/discard-draft — Side issue #84.
//
// Fired by the dashboard's "Discard & start fresh" secondary link below the
// draft resume banner. Marks the named draft as CANCELLED (ownership +
// status guarded — the UPDATE only touches a row that's still owned by
// the patient AND still in DRAFT), then redirects to /patient/new-case?fresh=1
// so the wizard's auto-resume gate (added above at the GET handler) lets
// the patient land on a clean Step 1. Status change (not DELETE) preserves
// the row for audit + lets future restore tooling reverse the discard if
// needed.
router.post('/patient/new-case/discard-draft', requireRole('patient'), async (req, res) => {
  const patientId = req.user.id;
  const draftId = req.body && req.body.draft_id ? String(req.body.draft_id).trim() : '';
  if (!draftId) {
    return res.redirect('/patient/new-case?fresh=1');
  }
  try {
    await execute(
      `UPDATE orders_active
          SET status = 'CANCELLED', updated_at = NOW()
        WHERE id = $1 AND patient_id = $2
          AND UPPER(COALESCE(status, '')) = 'DRAFT'`,
      [draftId, patientId]
    );
  } catch (err) {
    logErrorToDb(err, {
      context: 'patient.discard_draft',
      requestId: req.requestId,
      userId: patientId,
      url: req.originalUrl,
      method: req.method,
      category: 'patient_case',
      orderId: draftId
    });
    console.error('[discard_draft] failed', err && err.message ? err.message : err);
    // Fall through — even on error we still want to land on a fresh wizard.
  }
  return res.redirect('/patient/new-case?fresh=1');
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
      ...uploadcareLocals,
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
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
    logErrorToDb(e, {
      context: 'patient.new_case_step1',
      requestId: req.requestId,
      userId: req.user?.id,
      url: req.originalUrl,
      method: req.method,
      category: 'patient_case'
    });
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

  // ── Theme 14 — classify the case at case-create.
  // Logic moved to src/services/classify_job.js so both pg-boss worker and
  // the inline rollback path call one function. Default path enqueues via
  // pg-boss so the step 2 → step 3 redirect is no longer blocked on the
  // ~2-3s Haiku call. Step 3 GET handles a missing classification row by
  // passing specialtyRecommendation=null to the view (legacy supply-blind
  // grid + "analysing…" banner that polls /classification.json and reloads
  // when the row lands).
  //
  // Rollback: set CLASSIFIER_ASYNC=false in Render env (no redeploy needed)
  // to restore the previous inline-await behaviour.
  if (process.env.CLASSIFIER_ASYNC !== 'false') {
    try {
      const { enqueueSpecialtyClassify } = require('../job_queue');
      await enqueueSpecialtyClassify(orderId);
    } catch (err) {
      logErrorToDb(err, {
        context: 'patient.enqueue_classify',
        requestId: req.requestId,
        userId: patientId,
        url: req.originalUrl,
        method: req.method,
        category: 'patient_case',
        orderId
      });
    }
  } else {
    // Legacy inline path — preserved for rollback. Runs the same function as
    // the worker; the only difference vs. pre-refactor behaviour is the
    // step 2 → step 3 redirect waits for the Haiku call to complete.
    try {
      const { runClassification } = require('../services/classify_job');
      await runClassification(orderId);
    } catch (err) {
      logErrorToDb(err, {
        context: 'patient.theme14_classify_inline',
        requestId: req.requestId,
        userId: patientId,
        url: req.originalUrl,
        method: req.method,
        category: 'patient_case',
        orderId
      });
    }
  }

  return res.redirect('/patient/new-case?step=3&id=' + encodeURIComponent(orderId));
});

// POST /patient/new-case/step3 — Specialty + Service selection.
//
// Theme 14 Phase 3 + polish:
//   - Doctor-count gate DROPPED. Supply-blind; downstream auto-assign
//     handles "no doctor available" by transitioning to manual_pending.
//   - At low AI confidence (<0.55), the patient picks specialty + service
//     themselves from the supply-blind grid (UX fix C). The order flows
//     through normal validation; auto-assign decides routing. No
//     short-circuit to manual_pending at submit time — the "operator
//     triages" outcome happens via auto_assign's no_doctors_available
//     transition (already wired in Phase 3).
//   - override flag (patient picked a specialty OR service different from
//     the AI's top recommendation via the SLA-disclaimer modal) logs to
//     specialty_classification_overrides (now with ai/patient service_id
//     columns) AND flips orders.no_sla_refund_eligibility=true. Refund
//     eligibility logic in services/refund_eligibility.js short-circuits
//     SLA-breach refund for these orders.
//   - Locked-tier defense (>=0.95): UI hides the override link entirely;
//     reject any submission where specialty_id OR service_id differs
//     from the AI's pick with err=override_not_permitted.
router.post('/patient/new-case/step3', requireRole('patient'), async (req, res) => {
  if (isWizardUnavailable()) return res.redirect('/coming-soon');
  const patientId = req.user.id;
  const orderId = req.body && req.body.id ? String(req.body.id).trim() : '';
  const specialtyId = req.body && req.body.specialty_id ? String(req.body.specialty_id).trim() : '';
  const serviceId = req.body && req.body.service_id ? String(req.body.service_id).trim() : '';
  const isOverride = String((req.body && req.body.override) || '0') === '1';

  if (!orderId) return res.redirect('/patient/new-case');
  const owned = await loadOwnedDraft(orderId, patientId);
  if (!owned) return res.redirect('/dashboard');

  const nowIso = new Date().toISOString();

  if (!specialtyId || !serviceId) {
    return res.redirect('/patient/new-case?step=3&id=' + encodeURIComponent(orderId) + '&err=needs_specialty');
  }

  // Validate service belongs to specialty and is visible (unchanged from
  // pre-Theme-14 behavior).
  const visibleClause = await servicesVisibleClause('sv');
  const service = await safeGet(
    () => `SELECT sv.id, sv.specialty_id FROM services sv WHERE sv.id = $1 AND ${visibleClause}`,
    [serviceId]
  );
  if (!service || String(service.specialty_id) !== specialtyId) {
    return res.redirect('/patient/new-case?step=3&id=' + encodeURIComponent(orderId) + '&err=invalid_service');
  }

  // Override path: patient submitted a specialty OR service different from
  // the AI's top pick under the SLA-disclaimer modal (Q4 locked).
  // Phase 3 polish: an override fires when EITHER dimension changed —
  // not just specialty. The locked-tier defense is also dual-dimension.
  if (isOverride) {
    try {
      const classRow = await queryOne(
        `SELECT specialty_id, service_id, confidence FROM specialty_classifications
         WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [orderId]
      );
      // Locked-tier defense — forged form submission. At confidence >=
      // the live lock threshold (default 0.95, tunable via
      // /superadmin/settings since Theme 14 Phase 4) the UI hides the
      // override link entirely; reaching this branch with a mismatched
      // specialty OR service is a forged submission.
      const { lock: lockThreshold } = await getThresholds();
      if (classRow && Number(classRow.confidence) >= lockThreshold) {
        const specialtyMismatch = classRow.specialty_id && String(classRow.specialty_id) !== specialtyId;
        const serviceMismatch   = classRow.service_id   && String(classRow.service_id)   !== serviceId;
        if (specialtyMismatch || serviceMismatch) {
          return res.redirect('/patient/new-case?step=3&id=' + encodeURIComponent(orderId) + '&err=override_not_permitted');
        }
      }
      await execute(
        `INSERT INTO specialty_classification_overrides
           (id, case_id,
            ai_specialty_id, ai_service_id, ai_confidence,
            patient_specialty_id, patient_service_id, override_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [randomUUID(), orderId,
         classRow ? classRow.specialty_id : null,
         classRow ? classRow.service_id   : null,
         classRow ? Number(classRow.confidence) : null,
         specialtyId, serviceId, nowIso]
      );
      await execute(
        `UPDATE orders SET no_sla_refund_eligibility = true, updated_at = $1 WHERE id = $2`,
        [nowIso, orderId]
      );
    } catch (err) {
      logErrorToDb(err, {
        context: 'patient.theme14_override',
        requestId: req.requestId,
        userId: patientId,
        url: req.originalUrl,
        method: req.method,
        category: 'patient_case',
        orderId
      });
      // Don't block submission on logging failure — patient proceeds.
    }
  }

  await execute(
    `UPDATE orders
     SET specialty_id = $1, service_id = $2,
         draft_step = GREATEST(COALESCE(draft_step, 0), 3),
         updated_at = $3
     WHERE id = $4 AND patient_id = $5 AND UPPER(COALESCE(status, '')) = 'DRAFT'`,
    [specialtyId, serviceId, nowIso, orderId, patientId]
  );

  return res.redirect('/patient/new-case?step=4&id=' + encodeURIComponent(orderId));
});

// POST /patient/new-case/step4 — tier selection (canonical 'standard' / 'vip' / 'urgent').
//
// Server-side authority for pricing: the body carries ONLY tier. Base price,
// uplift, and total are computed server-side from the catalog snapshot via
// computeOrderPricing — never trusts client-supplied amounts.  Persisted
// fields per docs/PAYOUT_AND_URGENCY_POLICY.md §2:
//   - urgency_tier             canonical tier name
//   - sla_hours                48 / 18 / 4 per tier
//   - base_price               catalog snapshot at order time (mirrors doctor_fee)
//   - urgency_uplift_amount    pricing.upliftAmount (refundable on SLA breach)
//   - price                    pricing.totalPrice (= base + uplift)
//   - urgency_flag             true for non-standard tiers
router.post('/patient/new-case/step4', requireRole('patient'), async (req, res) => {
  if (isWizardUnavailable()) return res.redirect('/coming-soon');
  const patientId = req.user.id;
  const orderId = req.body && req.body.id ? String(req.body.id).trim() : '';
  const tier = req.body && req.body.tier ? String(req.body.tier).trim().toLowerCase() : '';

  if (!orderId) return res.redirect('/patient/new-case');
  const owned = await loadOwnedDraft(orderId, patientId);
  if (!owned) return res.redirect('/dashboard');

  if (tier !== 'standard' && tier !== 'vip' && tier !== 'urgent') {
    return res.redirect('/patient/new-case?step=4&id=' + encodeURIComponent(orderId) + '&err=invalid_tier');
  }

  // Urgent cut-off — policy §3.  Outside 7am-7pm Cairo time, do NOT
  // silently transform the request: re-render Step 4 with an inline
  // conflict block so the patient explicitly picks "wait until 7am"
  // or "downgrade to VIP".
  if (tier === 'urgent' && !isUrgentWindowOpen()) {
    return res.redirect('/patient/new-case?step=4&id=' + encodeURIComponent(orderId) + '&err=urgent_outside_window');
  }

  // Look up the service catalog snapshot for this order's region.
  // Multipliers come straight from the services row — per-service
  // overrides win over platform defaults inside computeOrderPricing.
  const countryCode = getUserCountryCode(req);
  const visibleClause = await servicesVisibleClause('sv');
  const service = await safeGet(
    () => `SELECT sv.id, sv.vip_multiplier, sv.urgent_multiplier,
                  COALESCE(cp.tashkheesa_price, sv.base_price) AS base_price,
                  COALESCE(cp.currency, sv.currency, 'EGP') AS currency
           FROM services sv
           LEFT JOIN service_regional_prices cp
             ON cp.service_id = sv.id AND cp.country_code = $1
            AND COALESCE(cp.status, 'active') = 'active'
           WHERE sv.id = $2 AND ${visibleClause}`,
    [countryCode, owned.service_id]
  );
  if (!service) {
    return res.redirect('/patient/new-case?step=3&id=' + encodeURIComponent(orderId) + '&err=invalid_service');
  }

  const persist = buildStep4Persistence({ tier, serviceRow: service });
  if (!persist.ok) {
    return res.redirect('/patient/new-case?step=4&id=' + encodeURIComponent(orderId) + '&err=' + persist.error);
  }

  await execute(
    `UPDATE orders
     SET urgency_tier = $1,
         sla_hours = $2,
         base_price = $3,
         urgency_uplift_amount = $4,
         price = $5,
         urgency_flag = $6,
         draft_step = GREATEST(COALESCE(draft_step, 0), 4),
         updated_at = $7
     WHERE id = $8 AND patient_id = $9 AND UPPER(COALESCE(status, '')) = 'DRAFT'`,
    [
      persist.tier,
      persist.slaHours,
      persist.basePrice,
      persist.upliftAmount,
      persist.totalPrice,
      persist.urgencyFlag,
      new Date().toISOString(),
      orderId,
      patientId
    ]
  );

  return res.redirect('/patient/new-case?step=5&id=' + encodeURIComponent(orderId));
});

// POST /patient/new-case/step4/urgency-resolve — Policy §3 conflict UX.
// When the patient picks Urgent outside 7am-7pm Cairo, Step 4 redirects
// here with two choices rendered inline:
//   choice='wait'           — stay urgent, anchor sla_deadline at next 7am Cairo + 4h
//   choice='downgrade_vip'  — switch tier to VIP (1.3× / 18h), processed immediately
//
// TODO(P1-PATIENT-1 follow-up): the 'wait' branch sets sla_deadline as a
// hint, but auto_assign.js does not currently pause matching until 7am.
// In practice that means Wait branch orders may still be picked up
// before 7am by tier-eligible doctors who happen to be online — strictly
// faster-than-promised service. A proper auto-assign-pause is out of
// scope for this PR; tracked for a later follow-up.
router.post('/patient/new-case/step4/urgency-resolve', requireRole('patient'), async (req, res) => {
  if (isWizardUnavailable()) return res.redirect('/coming-soon');
  const patientId = req.user.id;
  const orderId = req.body && req.body.id ? String(req.body.id).trim() : '';
  const choice = req.body && req.body.choice ? String(req.body.choice).trim().toLowerCase() : '';

  if (!orderId) return res.redirect('/patient/new-case');
  const owned = await loadOwnedDraft(orderId, patientId);
  if (!owned) return res.redirect('/dashboard');

  if (choice !== 'wait' && choice !== 'downgrade_vip') {
    return res.redirect('/patient/new-case?step=4&id=' + encodeURIComponent(orderId) + '&err=urgent_outside_window');
  }

  const countryCode = getUserCountryCode(req);
  const visibleClause = await servicesVisibleClause('sv');
  const service = await safeGet(
    () => `SELECT sv.id, sv.vip_multiplier, sv.urgent_multiplier,
                  COALESCE(cp.tashkheesa_price, sv.base_price) AS base_price
           FROM services sv
           LEFT JOIN service_regional_prices cp
             ON cp.service_id = sv.id AND cp.country_code = $1
            AND COALESCE(cp.status, 'active') = 'active'
           WHERE sv.id = $2 AND ${visibleClause}`,
    [countryCode, owned.service_id]
  );
  if (!service) {
    return res.redirect('/patient/new-case?step=3&id=' + encodeURIComponent(orderId) + '&err=invalid_service');
  }

  const resolvedTier = choice === 'wait' ? 'urgent' : 'vip';
  const persist = buildStep4Persistence({ tier: resolvedTier, serviceRow: service });
  if (!persist.ok) {
    return res.redirect('/patient/new-case?step=4&id=' + encodeURIComponent(orderId) + '&err=' + persist.error);
  }

  // For the Wait branch, anchor sla_deadline at next 7am Cairo + 4h
  // per policy §3.  For Downgrade, leave sla_deadline NULL — VIP cases
  // use deadlineFromAcceptance like every other order.
  const slaDeadline = choice === 'wait'
    ? new Date(nextSevenAmCairoUtc().getTime() + 4 * 60 * 60 * 1000).toISOString()
    : null;

  await execute(
    `UPDATE orders
     SET urgency_tier = $1,
         sla_hours = $2,
         base_price = $3,
         urgency_uplift_amount = $4,
         price = $5,
         urgency_flag = $6,
         sla_deadline = $7,
         draft_step = GREATEST(COALESCE(draft_step, 0), 4),
         updated_at = $8
     WHERE id = $9 AND patient_id = $10 AND UPPER(COALESCE(status, '')) = 'DRAFT'`,
    [
      persist.tier,
      persist.slaHours,
      persist.basePrice,
      persist.upliftAmount,
      persist.totalPrice,
      persist.urgencyFlag,
      slaDeadline,
      new Date().toISOString(),
      orderId,
      patientId
    ]
  );

  return res.redirect('/patient/new-case?step=5&id=' + encodeURIComponent(orderId));
});

// POST /patient/new-case/step5 — Pay-now CTA.
// Routes the patient based on PAYMENT_MODE (read per-request, no boot
// caching, so a Render env-var flip takes effect on the next click):
//
//   PAYMENT_MODE=stub (default) → bounce to /payment-success?stub=1,
//     which calls markCasePaid() server-side. The post-payment hook in
//     case_lifecycle.markCasePaid then runs auto-assign + specialty
//     broadcast just as the live webhook path would.
//
//   PAYMENT_MODE=live → call payments.getOrCreatePaymentUrl(owned) and
//     redirect to its return value (/portal/patient/pay/:id, which posts
//     to /payments/paymob/create-intention and hands off to Paymob).
//
// PAYMOB_MODE is independent: services/paymob.js still hard-throws unless
// PAYMOB_MODE=test (paymob.js:39-46), so PAYMENT_MODE=live + PAYMOB_MODE=test
// is the safe testing posture (wizard reaches Paymob *sandbox*, real card
// flow with test cards). PAYMOB_MODE=live is a separate deliberate flip at
// the very end — not in this PR.
// Final-submit rate limit — applied ONLY to this submit verb (not the whole
// /patient/new-case prefix, which used to throttle ordinary wizard browsing and
// editing) and keyed on the authenticated patient rather than req.ip, so patients
// sharing one hospital/clinic/carrier-NAT IP never collide. Runs AFTER
// requireRole('patient'), so req.user.id is always present. QA bypass: dev/staging
// only, behind RATE_LIMIT_DISABLED=true, for repeated Paymob sandbox submit loops.
const NEWCASE_RL_IS_PROD = String(process.env.MODE || process.env.NODE_ENV || 'development').toLowerCase() === 'production';
const newCaseSubmitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  validate: false,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user && req.user.id) ? 'user:' + String(req.user.id) : 'ip:' + req.ip,
  skip: () => !NEWCASE_RL_IS_PROD && String(process.env.RATE_LIMIT_DISABLED || '').toLowerCase() === 'true',
  message: 'Too many case submissions. Please wait 15 minutes and try again.'
});

router.post('/patient/new-case/step5', requireRole('patient'), newCaseSubmitLimiter, async (req, res) => {
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

  // Move the completed case DRAFT -> SUBMITTED before payment so markCasePaid
  // (SUBMITTED -> PAID) succeeds in both stub and live/webhook modes. submitCase
  // is idempotent (SUBMITTED -> SUBMITTED no-ops); loadOwnedDraft above guarantees
  // the row is still DRAFT here.
  try {
    await caseLifecycle.submitCase(orderId);
  } catch (e) {
    logErrorToDb(e, {
      context: 'patient.new_case_step5_submit',
      requestId: req.requestId,
      userId: req.user?.id,
      url: req.originalUrl,
      method: req.method,
      category: 'patient_case'
    });
    return res.redirect('/patient/new-case?step=5&id=' + encodeURIComponent(orderId) + '&err=submit_failed');
  }

  const paymentMode = String(process.env.PAYMENT_MODE || 'stub').toLowerCase();
  if (paymentMode === 'live') {
    const { getOrCreatePaymentUrl } = require('./payments');
    const payUrl = await getOrCreatePaymentUrl(owned);
    return res.redirect(payUrl);
  }
  return res.redirect('/portal/patient/orders/' + encodeURIComponent(orderId) + '/payment-success?stub=1');
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
// P1-PATIENT-3: Paymob's redirect query string is NOT trusted. The webhook
// at POST /payments/callback is the sole source of truth for payment
// status; this handler simply resolves which order the patient came back
// for and bounces them to /payment-success, which re-queries the DB and
// renders the correct state (paid / "we're confirming your payment"
// interim / unpaid retry path).
router.get('/portal/patient/payment-return', requireRole('patient'), async (req, res) => {
  const q = req.query || {};
  // Defensive: log entire query (no PII; Paymob params are order ids/status).
  console.log('[paymob-return] query', JSON.stringify(q));

  const orderId = String(
    q.merchant_order_id || q.order || q.order_id || q.id || q.merchant_order || ''
  ).trim();

  if (!orderId) {
    // Can't resolve the order — bounce to dashboard rather than guess.
    return res.redirect('/dashboard');
  }
  // Ownership check — never bounce to a success/failure for an order the
  // current session doesn't own. Silent redirect to dashboard avoids leaking.
  const owned = await queryOne(
    'SELECT id FROM orders_active WHERE id = $1 AND patient_id = $2',
    [orderId, req.user.id]
  );
  if (!owned) return res.redirect('/dashboard');

  // Always send the patient to /payment-success. That route re-queries the
  // DB and renders one of three states based on actual payment_status:
  //   - 'paid'      → success card
  //   - 'unpaid'    → "we're confirming your payment" interim with auto-refresh
  //                   (covers the legitimate case where the webhook hasn't fired yet)
  //   - never paid  → patient eventually links back to the wizard themselves
  return res.redirect('/portal/patient/orders/' + encodeURIComponent(orderId) + '/payment-success');
});

// GET /portal/patient/orders/:id/payment-success — post-payment landing page.
// Re-queries the DB on every visit; never trusts redirect query params for
// state. Handles the "we're confirming your payment" interim case when the
// browser arrived before the webhook fired.
//
// ?stub=1 → simulates a successful webhook by calling markCasePaid()
// server-side. Currently always honored (test mode is the only mode pre-launch).
// When live Paymob is enabled (see header on POST /step5 above), this branch
// must be regated so live patients can't promote their own orders to PAID.
router.get('/portal/patient/orders/:id/payment-success', requireRole('patient'), async (req, res) => {
  const patientId = req.user.id;
  const orderId = String(req.params.id || '').trim();
  if (!orderId) return res.redirect('/dashboard');

  const wantStub = !!(req.query && req.query.stub);

  // Ownership check.
  let order = await queryOne(
    `SELECT o.id, o.status, o.payment_status, o.paid_at, o.deadline_at, o.sla_hours,
            o.specialty_id, o.service_id, o.doctor_id, o.draft_step,
            s.name AS specialty_name, s.name_ar AS specialty_name_ar, sv.name AS service_name,
            d.name AS doctor_name
     FROM orders_active o
     LEFT JOIN specialties s ON s.id = o.specialty_id
     LEFT JOIN services sv ON sv.id = o.service_id
     LEFT JOIN users d ON d.id = o.doctor_id
     WHERE o.id = $1 AND o.patient_id = $2`,
    [orderId, patientId]
  );
  if (!order) return res.redirect('/dashboard');

  // Defense: when PAYMENT_MODE=live, refuse to honour ?stub=1 so a real
  // patient cannot promote their own order to PAID via URL tampering.
  // The stub branch only runs when the server is in stub payment mode.
  const inLivePaymentMode = String(process.env.PAYMENT_MODE || 'stub').toLowerCase() === 'live';
  if (!inLivePaymentMode && wantStub && String(order.payment_status || '').toLowerCase() !== 'paid') {
    // Simulate the webhook server-side. markCasePaid() is the canonical entry.
    try {
      // Set payment_status / paid_at FIRST (mirrors the Paymob webhook ordering)
      // so markCasePaid's payment gate permits SUBMITTED -> PAID. The wizard
      // already moved the case DRAFT -> SUBMITTED at step5. markCasePaid then only
      // locks lifecycle fields (sla_hours, paid_at) and fires auto-assign/broadcast.
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
      // markCasePaid reads orders.sla_hours / orders.urgency_tier directly.
      await caseLifecycle.markCasePaid(orderId);
      try {
        logOrderEvent({ orderId, label: 'stub_payment_success', actorUserId: patientId, actorRole: 'patient' });
      } catch (_) {}
      // Re-fetch the post-stub order state.
      order = await queryOne(
        `SELECT o.id, o.status, o.payment_status, o.paid_at, o.deadline_at, o.sla_hours,
                o.specialty_id, o.service_id, o.doctor_id, o.draft_step,
                s.name AS specialty_name, s.name_ar AS specialty_name_ar, sv.name AS service_name,
                d.name AS doctor_name
         FROM orders_active o
         LEFT JOIN specialties s ON s.id = o.specialty_id
         LEFT JOIN services sv ON sv.id = o.service_id
         LEFT JOIN users d ON d.id = o.doctor_id
         WHERE o.id = $1 AND o.patient_id = $2`,
        [orderId, patientId]
      );
    } catch (e) {
      logErrorToDb(e, {
        context: 'patient.stub_payment_mark_paid',
        requestId: req.requestId,
        userId: req.user?.id,
        url: req.originalUrl,
        method: req.method,
        category: 'patient_payment'
      });
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
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
    user: req.user,
    lang, isAr,
    order,
    isPaid,
    isStubMode: wantStub
  });
});

// GET /patient/new-case/:id/classification.json — polling endpoint for the
// async specialty classifier (Step 3 banner). Returns status='ready' once
// the worker has inserted a specialty_classifications row for this case;
// 'pending' until then. Mirrors files.json shape + caching semantics.
router.get('/patient/new-case/:id/classification.json', requireRole('patient'), async (req, res) => {
  const patientId = req.user.id;
  const orderId = String(req.params.id || '').trim();
  if (!orderId) return res.status(400).json({ ok: false, error: 'id_required' });
  const owned = await loadOwnedDraft(orderId, patientId);
  if (!owned) return res.status(404).json({ ok: false, error: 'not_found' });
  const row = await queryOne(
    `SELECT specialty_id, service_id, confidence, reasoning FROM specialty_classifications
      WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [orderId]
  );
  res.set('Cache-Control', 'no-store');
  return res.json({ ok: true, status: row ? 'ready' : 'pending' });
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
    `SELECT id, url, label, created_at, ai_quality_status
     FROM order_files WHERE order_id = $1
     ORDER BY created_at ASC`,
    [orderId]
  );
  res.set('Cache-Control', 'no-store');
  return res.json({
    ok: true,
    files: (rows || []).map(f => {
      const isValid = mapAiQualityToIsValid(f.ai_quality_status);
      // validation shape: 'readable' | 'flagged' | 'checking' (wizard contract)
      const validation = isValid === true  ? 'readable'
                       : isValid === false ? 'flagged'
                       :                     'checking';
      return {
        id: f.id,
        url: '/files/' + f.id,
        label: f.label || '',
        createdAt: f.created_at,
        validation
      };
    })
  });
});

// Create new case (UploadCare)
router.post('/patient/new-case', requireRole('patient'), async (req, res) => {
  const patientId = req.user.id;
  const countryCode = getUserCountryCode(req);
  const countryCurrency = getCountryCurrency(countryCode);
  const { specialty_id, service_id, notes, file_urls, sla_type } = req.body || {};

  const specialties = await queryAll('SELECT id, name, name_ar FROM specialties WHERE COALESCE(is_visible, true) = true ORDER BY name ASC');
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
      ...uploadcareLocals,
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
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
      ...uploadcareLocals,
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
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
          false, false, 'unpaid', NULL,
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
          false, false, 'unpaid', NULL,
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
    logErrorToDb(err, {
      context: 'patient.new_case_create',
      requestId: req.requestId,
      userId: req.user?.id,
      url: req.originalUrl,
      method: req.method,
      category: 'patient_case'
    });
    // eslint-disable-next-line no-console
    console.error('[patient new-case] failed', err);
    return res.status(500).render('patient_new_case', {
      ...uploadcareLocals,
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
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

  const specialties = await queryAll('SELECT id, name, name_ar FROM specialties WHERE COALESCE(is_visible, true) = true ORDER BY name ASC');
  const visibleClause = await servicesVisibleClause('sv');
  const services = await safeAll(
    (slaExpr) =>
      `SELECT sv.id, sv.specialty_id, sv.name,
              COALESCE(cp.tashkheesa_price, sv.base_price) AS base_price,
              COALESCE(cp.doctor_commission, sv.doctor_fee) AS doctor_fee,
              COALESCE(cp.currency, sv.currency) AS currency,
              sv.payment_link AS payment_link,
              ${slaExpr} AS sla_hours,
              sp.name AS specialty_name,
              sp.name_ar AS specialty_name_ar
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
      ...uploadcareLocals,
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
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
      ...uploadcareLocals,
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
      user: req.user,
      specialties,
      services,
      countryCurrency,
      error: t(lang, 'An initial file upload is required before submitting the order.', 'يجب رفع ملف واحد على الأقل قبل إرسال الطلب.'),
      form: req.body || {}
    });
    if (process.env.NODE_ENV !== 'production' && !hasInitialUpload) {
      // THEME8-LINT-EXEMPT-HELPER: dev-only guard breach warning, NODE_ENV
      // gated. Not an error and not in a catch — it's a diagnostic for
      // local dev when the client-side uploader handshake misbehaves.
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
          false, false, 'unpaid', NULL,
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
          false, false, 'unpaid', NULL,
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

      // Theme 7b Phase 1: superadmin fan-out delegated to the canonical
      // notifyAdmins helper. Original code had no dedupe key — this
      // adds one (`order_created:<orderId>:sa` → notifyAdmins suffixes
      // `:${r.id}` per recipient), making re-fires idempotent under the
      // unique index on notifications(dedupe_key, channel, to_user_id).
      // Fire-and-forget retained: notifyAdmins is internally try/catch-
      // wrapped per recipient so the floating Promise never rejects.
      notifyAdmins({
        template: 'order_created_patient',
        dedupeKey: 'order_created:' + orderId + ':sa',
        orderId,
      });
    });
  } catch (err) {
    logErrorToDb(err, {
      context: 'patient.orders_create',
      requestId: req.requestId,
      userId: req.user?.id,
      url: req.originalUrl,
      method: req.method,
      category: 'patient_case'
    });
    // eslint-disable-next-line no-console
    console.error('[patient order create] failed', err);
    return res.status(500) && res.render('patient_new_case', {
      ...uploadcareLocals,
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
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
  // Side issue #53 — thread videoEnabled into both render() calls below
  // so the addon checkbox can render disabled with a "Coming soon" label
  // when VIDEO_CONSULTATION_ENABLED=false instead of silently dropping
  // the submitted value at routes/payments.js:480.
  const { isVideoEnabled } = require('../video_helpers');
  const videoEnabled = isVideoEnabled();

  // Expanded query: include service/specialty/price details for payment page
  const order = await queryOne(
    `SELECT o.id,
            o.payment_status,
            o.payment_link,
            NULL::numeric AS locked_price,
            NULL::text AS locked_currency,
            o.service_id,
            o.price,
            sv.name AS service_name,
            sp.name AS specialty_name,
            sp.name_ar AS specialty_name_ar
     FROM orders_active o
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
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
      user: req.user,
      order: {
        ...order,
        display_price: order && order.locked_price != null ? order.locked_price : null,
        display_currency: order && order.locked_currency ? order.locked_currency : null,
      },
      lang,
      isAr,
      paymentLink: null,
      paymentUrl: null,
      price: order?.locked_price || order?.price || 0,
      currency: order?.locked_currency || order?.currency || 'EGP',
      videoConsultationPrice,
      sla24hrPrice,
      prescriptionPrice,
      videoEnabled,
      serviceDetails: service,
      error: null,
    });
  }

  return res.render('patient_payment_required', {
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
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
    currency: order?.locked_currency || order?.currency || 'EGP',
    videoConsultationPrice,
    sla24hrPrice,
    prescriptionPrice,
    videoEnabled,
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
    o.id, o.reference_id, o.status, o.payment_status, o.payment_link,
    NULL::numeric AS locked_price, NULL::text AS locked_currency, o.price,
    o.specialty_id, o.service_id, o.doctor_id,
    o.sla_hours, o.deadline_at, o.accepted_at, o.paid_at, o.completed_at,
    o.created_at, o.updated_at, o.urgency_flag, o.urgency_tier,
    o.uploads_locked, o.additional_files_requested,
    o.no_sla_refund_eligibility,
    s.name AS specialty_name,
    s.name_ar AS specialty_name_ar,
    sv.name AS service_name,
    sv.payment_link AS service_payment_link,
    d.name AS doctor_name
  `;

  let order = await queryOne(
    `SELECT ${SAFE_ORDER_COLS}
     FROM orders_active o
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
    logErrorToDb(e, {
      context: 'patient.payment_backfill',
      requestId: req.requestId,
      userId: req.user?.id,
      url: req.originalUrl,
      method: req.method,
      category: 'patient_payment',
      orderId: order.id
    });
    console.error('[payment_backfill_failed]', { orderId: order.id, error: String(e) });
  }
  // Re-fetch with the privacy-safe column allowlist after any backfill.
  order = await queryOne(
    `SELECT ${SAFE_ORDER_COLS}
     FROM orders_active o
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
    `SELECT id, url, label, created_at, ai_quality_status
     FROM order_files WHERE order_id = $1 ORDER BY created_at DESC`,
    [orderId]
  );
  files.forEach(f => {
    f.url = `/files/${f.id}`;
    f.is_valid = mapAiQualityToIsValid(f.ai_quality_status);
  });

  let additionalFiles = [];
  try {
    const addHasLabel = await hasColumn('order_additional_files', 'label');
    additionalFiles = await queryAll(
      `SELECT id,
              ${addHasLabel ? 'label' : 'NULL'} AS label,
              uploaded_at AS created_at,
              NULL AS is_valid
       FROM order_additional_files WHERE order_id = $1 ORDER BY uploaded_at DESC`,
      [orderId]
    );
    // Theme 13 Sub-issue C2.D — always proxy through /files/<id>. Pre-C2.D this
    // SELECT returned `file_url AS url` (raw Uploadcare CDN URL passed straight
    // to file-tile.ejs). After C2.D we route through the unified reader so
    // (a) auth fires (pre-C2.D the CDN URL was publicly addressable — see
    // UPLOAD_PROVIDER_AUDIT.md §6a), and (b) post-C2.E the resolver also
    // walks order_additional_files.file_key for R2-stored rows.
    additionalFiles.forEach(f => { f.url = '/files/' + f.id; });
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

  // Theme 7b Phase 2 — refund affordance locals.
  // The view shows ONE of three states:
  //   (a) "Request refund" CTA  — when eligibility passes + no existing refund
  //   (b) Status banner          — when an existing refund row exists (any status)
  //   (c) Nothing                — when ineligible AND no existing refund
  // Eligibility is re-checked at the form GET + POST routes (defence-in-depth
  // against stale UI). Failures here are non-fatal for the case page render.
  let refundEligibility = null;
  let existingRefund = null;
  try {
    const { isEligibleForRefund } = require('../services/refund_eligibility');
    refundEligibility = await isEligibleForRefund(order, patientId);
  } catch (e) {
    refundEligibility = null;
  }
  try {
    existingRefund = await queryOne(
      `SELECT id, status, requested_amount, instapay_handle, instapay_reference,
              denial_reason, refunded_at
         FROM refunds
        WHERE order_id = $1 AND reason = 'patient_request'
        ORDER BY refunded_at DESC
        LIMIT 1`,
      [orderId]
    );
  } catch (e) {
    existingRefund = null;
  }

  res.render('patient_order', {
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
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
    refundEligibility,
    existingRefund,
    // Theme 13 Sub-issue C: spread the locals object so the patient_order
    // view also receives r2DirectEnabled (alongside uploadcarePublicKey +
    // uploaderConfigured). The view doesn't yet branch on r2DirectEnabled —
    // the messages-attach widget at lines 645+ stays on Uploadcare until
    // Sub-issue C2 (deferred — see THEME_13_R2_MIGRATION_FIX_PLAN.md §4 C2
    // for why the messages contract is materially more involved than the
    // wizard upload). This spread keeps locals consistent across all wizard
    // + order render sites and unblocks the future C2 widget rewrite.
    ...uploadcareLocals
  });
});

// ─── Theme 7b Phase 2 — patient refund request flow ─────────────────
// Three routes:
//   GET  /portal/patient/orders/:id/request-refund        — form view
//   POST /portal/patient/orders/:id/request-refund        — submit
//   POST /portal/patient/orders/:id/refund-request/cancel — self-cancel within 1h

router.get('/portal/patient/orders/:id/request-refund', requireRole('patient'), async (req, res) => {
  const orderId = req.params.id;
  const patientId = req.user.id;
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';

  const order = await queryOne(
    `SELECT id, reference_id, status, payment_status, base_price, urgency_uplift_amount,
            patient_id, no_sla_refund_eligibility
       FROM orders_active
      WHERE id = $1 AND patient_id = $2`,
    [orderId, patientId]
  );
  if (!order) return res.redirect('/dashboard');

  const { isEligibleForRefund } = require('../services/refund_eligibility');
  const eligibility = await isEligibleForRefund(order, patientId);
  if (!eligibility || !eligibility.eligible) {
    return res.redirect('/portal/patient/orders/' + encodeURIComponent(orderId));
  }

  // Reject if a pending request already exists (the partial-unique index
  // would also block, but redirecting earlier is friendlier UX).
  const existing = await queryOne(
    "SELECT id FROM refunds WHERE order_id = $1 AND status IN ('pending','auto_approved') LIMIT 1",
    [orderId]
  );
  if (existing) {
    return res.redirect('/portal/patient/orders/' + encodeURIComponent(orderId));
  }

  const requestedAmount =
    Number(order.base_price || 0) + Number(order.urgency_uplift_amount || 0);

  res.render('patient_refund_request', {
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
    user: req.user,
    lang, isAr,
    order,
    eligibility,
    requestedAmount,
    formError: '',
    formValues: {}
  });
});

router.post('/portal/patient/orders/:id/request-refund', requireRole('patient'), async (req, res) => {
  const orderId = req.params.id;
  const patientId = req.user.id;
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';

  // Sanitize inputs (match patient.js's existing String(...).trim() pattern;
  // EJS auto-escapes on render, so XSS is handled at the output boundary).
  const reasonRaw = String((req.body && req.body.reason) || '').trim();
  const instapayRaw = String((req.body && req.body.instapay_handle) || '').trim();

  const order = await queryOne(
    `SELECT id, reference_id, status, payment_status, base_price, urgency_uplift_amount,
            patient_id, no_sla_refund_eligibility
       FROM orders_active
      WHERE id = $1 AND patient_id = $2`,
    [orderId, patientId]
  );
  if (!order) return res.redirect('/dashboard');

  // Re-check eligibility at submit time (defence against stale form data).
  const { isEligibleForRefund } = require('../services/refund_eligibility');
  const eligibility = await isEligibleForRefund(order, patientId);
  const requestedAmount =
    Number(order.base_price || 0) + Number(order.urgency_uplift_amount || 0);

  function rerender(errKey) {
    return res.render('patient_refund_request', {
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
      user: req.user,
      lang, isAr,
      order,
      eligibility,
      requestedAmount,
      formError: errKey,
      formValues: { reason: reasonRaw, instapay_handle: instapayRaw }
    });
  }

  if (!eligibility || !eligibility.eligible) return rerender('ineligible');

  // Validate input. Length caps mirror the form's maxlength attrs.
  if (!reasonRaw || reasonRaw.length < 3) return rerender('reason_required');
  if (reasonRaw.length > 1000) return rerender('reason_required');
  if (!instapayRaw || instapayRaw.length < 3) return rerender('instapay_required');
  if (instapayRaw.length > 100) return rerender('instapay_required');

  // Per OQ-4: full case price by default; superadmin can edit down on approve.
  const refundId = randomUUID();
  const status = eligibility.autoApprove ? 'auto_approved' : 'pending';

  // amount_egp doubles as the approved/paid amount on system rows
  // (status='paid') and the requested amount on patient rows
  // (status='pending'/'auto_approved'). The status field disambiguates.
  // Phase 3's superadmin approve action edits amount_egp if approving
  // a partial refund. Existing readers (services/sla_breach.js) rely
  // on amount_egp as the canonical money figure.
  try {
    await execute(
      `INSERT INTO refunds (
         id, order_id, amount_egp, requested_amount, approved_amount,
         reason, patient_reason, instapay_handle, status,
         requested_by, refunded_at, refunded_by, notes
       ) VALUES ($1, $2, $3, $3, NULL, 'patient_request', $4, $5, $6, $7, NOW(), $7,
                 'Patient-initiated refund request')`,
      [refundId, orderId, requestedAmount, reasonRaw, instapayRaw, status, patientId]
    );
  } catch (err) {
    // Partial-unique index uniq_refunds_pending_per_order may have caught
    // a race (a second submit landing while a pending row exists).
    logErrorToDb(err, {
      context: 'patient.refund_request_insert',
      requestId: req.requestId,
      userId: req.user?.id,
      url: req.originalUrl,
      method: req.method,
      category: 'refund'
    });
    if (err && /uniq_refunds_pending_per_order/.test(String(err.message || ''))) {
      return rerender('duplicate');
    }
    console.error('[patient-refund-request] insert failed', err);
    return rerender('ineligible');
  }

  // Audit
  logOrderEvent({
    orderId,
    label: 'patient_refund_requested',
    meta: { refund_id: refundId, requested_amount_egp: requestedAmount, status },
    actorUserId: patientId,
    actorRole: 'patient'
  });

  // Patient confirmation (in-app + email; no WhatsApp until Phase 4 Meta approval).
  try {
    queueMultiChannelNotification({
      orderId,
      toUserId: patientId,
      channels: ['internal', 'email'],
      template: 'patient_refund_requested',
      response: {
        case_id: orderId,
        caseReference: orderId.slice(0, 12).toUpperCase(),
        requestedAmount: requestedAmount.toFixed(2),
        instapayHandle: instapayRaw,
        patientName: req.user.name || ''
      },
      dedupe_key: 'refund_requested:' + refundId + ':patient'
    });
  } catch (_) { /* notification failure must not block the redirect */ }

  // Admin queue alert via canonical fan-out (Phase 1 helper).
  try {
    notifyAdmins({
      template: 'admin_refund_request_received',
      payload: {
        case_id: orderId,
        caseReference: orderId.slice(0, 12).toUpperCase(),
        refund_id: refundId,
        requested_amount: requestedAmount.toFixed(2),
        status,
        patientName: req.user.name || '',
        reasonPreview: reasonRaw.slice(0, 100)
      },
      dedupeKey: 'refund_requested:' + refundId + ':sa',
      orderId
    });
  } catch (_) { /* fan-out failure must not block the redirect */ }

  return res.redirect(
    '/portal/patient/orders/' + encodeURIComponent(orderId) + '?refund_status=submitted'
  );
});

router.post('/portal/patient/orders/:id/refund-request/cancel', requireRole('patient'), async (req, res) => {
  const orderId = req.params.id;
  const patientId = req.user.id;

  // Validate ownership of the order.
  const order = await queryOne(
    "SELECT id FROM orders_active WHERE id = $1 AND patient_id = $2",
    [orderId, patientId]
  );
  if (!order) return res.redirect('/dashboard');

  // Find the latest pending/auto_approved patient-initiated refund.
  const refund = await queryOne(
    `SELECT id, status, requested_amount, instapay_handle, refunded_at, requested_by
       FROM refunds
      WHERE order_id = $1 AND reason = 'patient_request'
        AND status IN ('pending','auto_approved')
      ORDER BY refunded_at DESC
      LIMIT 1`,
    [orderId]
  );
  if (!refund) {
    return res.redirect('/portal/patient/orders/' + encodeURIComponent(orderId));
  }

  // Owner check: only the patient who created the request can cancel it.
  if (String(refund.requested_by || '') !== String(patientId)) {
    return res.redirect('/portal/patient/orders/' + encodeURIComponent(orderId));
  }

  // 1-hour cancel window from refunded_at (the row's created-at timestamp).
  const createdMs = (() => {
    try { return new Date(refund.refunded_at).getTime(); } catch (_) { return NaN; }
  })();
  if (!Number.isFinite(createdMs) || (Date.now() - createdMs) >= 60 * 60 * 1000) {
    return res.redirect(
      '/portal/patient/orders/' + encodeURIComponent(orderId) + '?refund_error=cancel_window_expired'
    );
  }

  // Hard-delete per OQ-3 (no 'cancelled_by_patient' enum value).
  try {
    await execute("DELETE FROM refunds WHERE id = $1 AND status IN ('pending','auto_approved')", [refund.id]);
  } catch (err) {
    logErrorToDb(err, {
      context: 'patient.refund_cancel_delete',
      requestId: req.requestId,
      userId: req.user?.id,
      url: req.originalUrl,
      method: req.method,
      category: 'refund'
    });
    console.error('[patient-refund-cancel] delete failed', err);
    return res.redirect('/portal/patient/orders/' + encodeURIComponent(orderId));
  }

  // Audit — preserve the deleted row's identity in meta.
  logOrderEvent({
    orderId,
    label: 'patient_refund_cancelled',
    meta: {
      refund_id: refund.id,
      requested_amount_egp: Number(refund.requested_amount || 0),
      prior_status: refund.status
    },
    actorUserId: patientId,
    actorRole: 'patient'
  });

  // Notify admins so they don't waste time reviewing.
  try {
    notifyAdmins({
      template: 'admin_refund_cancelled_by_patient',
      payload: {
        case_id: orderId,
        caseReference: orderId.slice(0, 12).toUpperCase(),
        refund_id: refund.id,
        patientName: req.user.name || ''
      },
      dedupeKey: 'refund_cancelled:' + refund.id + ':sa',
      orderId
    });
  } catch (_) { /* notification failure must not block the redirect */ }

  return res.redirect(
    '/portal/patient/orders/' + encodeURIComponent(orderId) + '?refund_status=cancelled'
  );
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
  // Theme 13 Sub-issue C2.F — file_key is the new R2-direct path (populated
  // by the patient_order.ejs widget when MESSAGES_R2_ENABLED is on per
  // Sub-issue C2.C). file_url stays as the legacy Uploadcare CDN URL field.
  const fileKey = String(body.file_key || '').trim();
  const fileName = String(body.file_name || '').trim().slice(0, 200);

  // Must have either text or a file (URL or key).
  if (!rawText && !fileUrl && !fileKey) {
    return res.redirect(`/portal/patient/orders/${encodeURIComponent(orderId)}?tab=messages&err=empty_message`);
  }
  // Exactly-one-of-two for file fields. The unified /files/:id resolver
  // applies file_key||file_url precedence (Q-C), so both-set would still
  // resolve, but the contract is XOR — reject both-set as malformed input.
  if (fileUrl && fileKey) {
    return res.redirect(`/portal/patient/orders/${encodeURIComponent(orderId)}?tab=messages&err=invalid_file`);
  }
  // R2 key shape pinned to the messages-attach folder (matches the C2.B
  // allowlist value the widget posts to /portal/patient/files). Forbids
  // path traversal via this entry point.
  if (fileKey && !/^messages-attach\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(fileKey)) {
    return res.redirect(`/portal/patient/orders/${encodeURIComponent(orderId)}?tab=messages&err=invalid_file`);
  }

  // Validate ownership.
  const order = await queryOne(
    'SELECT id, doctor_id, status FROM orders_active WHERE id = $1 AND patient_id = $2',
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
    logErrorToDb(e, {
      context: 'patient.messages_ensure_conversation',
      requestId: req.requestId,
      userId: req.user?.id,
      url: req.originalUrl,
      method: req.method,
      category: 'patient_case'
    });
    console.error('[v2-messages] ensureConversation failed', e && e.message ? e.message : e);
  }
  if (!conversationId) {
    return res.redirect(`/portal/patient/orders/${encodeURIComponent(orderId)}?tab=messages&err=conversation_unavailable`);
  }

  const nowIso = new Date().toISOString();

  // 1. If a file is attached, mirror it into order_additional_files (same
  //    contract Phase 3B used for re-uploads after doctor requests). Theme 13
  //    Sub-issue C2.F: handle both shapes — legacy Uploadcare CDN URL goes to
  //    order_additional_files.file_url; new R2 key goes to file_key (helper
  //    extended in C2.F to write to either column based on which arg is set).
  if (fileUrl && /^https?:\/\//i.test(fileUrl)) {
    try {
      await insertAdditionalFile(orderId, fileUrl, fileName || null, nowIso);
    } catch (e) {
      // THEME8-LINT-EXEMPT-HELPER: best-effort additional-file insert during
      // message send. The primary message insert is the next try-block down
      // (which IS wrapped). If the additional file fails to insert here, the
      // text message still goes through — surfacing this to /ops/errors would
      // duplicate signal already captured by the wrapped message insert catch
      // when there's a systemic issue.
      console.warn('[v2-messages] additional-file insert failed (URL)', e && e.message ? e.message : e);
    }
  } else if (fileKey) {
    try {
      // Pass key as 6th arg (5th = client = null since no transaction context here).
      await insertAdditionalFile(orderId, null, fileName || null, nowIso, null, fileKey);
    } catch (e) {
      // THEME8-LINT-EXEMPT-HELPER: same rationale as the URL branch above.
      console.warn('[v2-messages] additional-file insert failed (key)', e && e.message ? e.message : e);
    }
  }

  // 2. Insert the message row. message_type = 'file' if attached and no text
  //    body, else 'text'. file_url OR file_key + file_name carry the attachment
  //    (XOR enforced above; both columns populated in INSERT, exactly one is
  //    non-null per row).
  const messageId = randomUUID();
  const messageType = ((fileUrl || fileKey) && !rawText) ? 'file' : 'text';
  const content = rawText || (fileName || (isAr_safe(req) ? 'ملف' : 'File'));
  try {
    await execute(
      `INSERT INTO messages
         (id, conversation_id, sender_id, sender_role, content, message_type, file_url, file_key, file_name, created_at)
       VALUES ($1, $2, $3, 'patient', $4, $5, $6, $7, $8, $9)`,
      [messageId, conversationId, patientId, content, messageType, fileUrl || null, fileKey || null, fileName || null, nowIso]
    );
    await execute('UPDATE conversations SET updated_at = $1 WHERE id = $2', [nowIso, conversationId]);
  } catch (e) {
    logErrorToDb(e, {
      context: 'patient.messages_insert',
      requestId: req.requestId,
      userId: req.user?.id,
      url: req.originalUrl,
      method: req.method,
      category: 'patient_case'
    });
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
      'SELECT id, doctor_id, patient_id FROM orders_active WHERE id = $1 AND patient_id = $2',
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
    logErrorToDb(err, {
      context: 'patient.start_message',
      requestId: req.requestId,
      userId: req.user?.id,
      url: req.originalUrl,
      method: req.method,
      category: 'patient_case'
    });
    return res.redirect('/portal/messages');
  }
});

// Patient replies to doctor's clarification request
router.post('/portal/patient/orders/:id/submit-info', requireRole('patient'), async (req, res) => {
  const orderId = req.params.id;
  const patientId = req.user.id;
  const message = (req.body && req.body.message ? String(req.body.message) : '').trim();

  const order = await queryOne(
    'SELECT * FROM orders_active WHERE id = $1 AND patient_id = $2',
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

// GET upload page — RETIRED. The standalone uploader view (patient_order_upload.ejs)
// has been removed; both the new-case wizard's Step 2 and the order detail page
// already render Uploadcare correctly. Branch on order status:
//   - DRAFT      → wizard Step 2 (the case is still being assembled).
//   - non-DRAFT  → order detail page (post-submission file additions live there).
// The POST handler below at /portal/patient/orders/:id/upload is unchanged and
// continues to serve as the canonical upload endpoint for both paths.
router.get('/portal/patient/orders/:id/upload', requireRole('patient'), async (req, res) => {
  const orderId = req.params.id;
  const patientId = req.user.id;

  const order = await queryOne(
    'SELECT id, status FROM orders_active WHERE id = $1 AND patient_id = $2',
    [orderId, patientId]
  );
  if (!order) return res.redirect('/dashboard');

  const isDraft = String(order.status || '').toUpperCase() === 'DRAFT';
  if (isDraft) {
    return res.redirect('/patient/new-case?step=2&id=' + encodeURIComponent(orderId));
  }
  return res.redirect('/portal/patient/orders/' + encodeURIComponent(orderId));
});

// POST upload
router.post('/portal/patient/orders/:id/upload', requireRole('patient'), async (req, res) => {
  const orderId = req.params.id;
  const patientId = req.user.id;
  // Theme 13 Sub-issue B: `file_key` is the new R2-direct-upload field
  // (populated by the wizard's FormData script when UPLOAD_R2_DIRECT_ENABLED).
  // `file_url` / `file_urls` remain the legacy Uploadcare-CDN-URL fields. The
  // unified /files/:id reader (src/server.js:507-510) disambiguates by
  // ^https?:// regex at read time, so both populate the same `order_files.url`
  // column. Exactly one of `file_url` or `file_key` is set per upload (the
  // wizard's two scripts are mutually exclusive — see patient_new_case.ejs).
  const { file_url, file_urls, file_key, label } = req.body || {};

  const uploaderConfigured = String(process.env.UPLOADCARE_PUBLIC_KEY || '').trim().length > 0;
  const r2DirectEnabled = String(process.env.UPLOAD_R2_DIRECT_ENABLED || '').toLowerCase() === 'true';
  const cleanLabel = (label && String(label).trim()) ? String(label).trim().slice(0, 120) : null;

  const order = await queryOne(
    'SELECT * FROM orders_active WHERE id = $1 AND patient_id = $2',
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

  // Theme 13 Sub-issue B: collect R2 keys separately — they don't pass the
  // ^https?:// validation that URLs do, but must still land in order_files.url.
  const keys = [];
  if (file_key && String(file_key).trim()) keys.push(String(file_key).trim());

  if (urls.length === 0 && keys.length === 0) {
    // Nothing posted at all. If neither uploader is configured, surface that
    // distinct error; otherwise the patient probably mis-clicked submit.
    if (!uploaderConfigured && !r2DirectEnabled) {
      return res.redirect(`/portal/patient/orders/${orderId}/upload?error=missing_uploader`);
    }
    return res.redirect(`/portal/patient/orders/${orderId}/upload?error=missing`);
  }

  // Basic URL validation: accept only http/https to avoid junk strings
  const filteredUrls = urls
    .map((u) => u.slice(0, 2048))
    .filter((u) => /^https?:\/\//i.test(u));

  // R2 key validation: must match the orders/draft/<patientId>/<filename>
  // shape produced by src/routes/patient_files.js (Sub-issue A). The regex
  // pins the prefix and forbids path traversal — anything else is junk.
  const filteredKeys = keys
    .map((k) => k.slice(0, 2048))
    .filter((k) => /^orders\/draft\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(k));

  const filtered = filteredUrls.concat(filteredKeys);

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
  const wasAdditionalFilesRequested = order.additional_files_requested === true;
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
          // Theme 13 Sub-issue C2.F — `filtered` mixes HTTP URLs (legacy
          // Uploadcare path) and R2 keys (new patient_files.js path, post
          // Phase 2). Disambiguate by scheme so each lands in the right
          // order_additional_files column (file_url vs file_key).
          if (/^https?:\/\//i.test(u)) {
            await insertAdditionalFile(orderId, u, cleanLabel, now, client);          // legacy URL → file_url
          } else {
            await insertAdditionalFile(orderId, null, cleanLabel, now, client, u);    // R2 key → file_key
          }
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
           SET additional_files_requested = false,
               uploads_locked = true,
               updated_at = $1
           WHERE id = $2`,
          [now, orderId]
        );
      } else {
        await client.query(
          `UPDATE orders
           SET additional_files_requested = false,
               updated_at = $1
           WHERE id = $2`,
          [now, orderId]
        );
      }
    });
  } catch (err) {
    logErrorToDb(err, {
      context: 'patient.order_upload',
      requestId: req.requestId,
      userId: req.user?.id,
      url: req.originalUrl,
      method: req.method,
      category: 'patient_upload',
      orderId
    });
    // eslint-disable-next-line no-console
    console.error('[patient upload] failed', err);
    return res.redirect(`/portal/patient/orders/${orderId}/upload?error=invalid_url`);
  }

  // Case intelligence pipeline (queued via pg-boss for crash recovery)
  enqueueCaseIntelligence(orderId).catch(function(err) {
    logErrorToDb(err, {
      context: 'patient.case_intelligence_enqueue',
      orderId,
      category: 'patient_case'
    });
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
        'SELECT COALESCE(o.reference_id, c.reference_code) AS reference_id FROM orders_active o LEFT JOIN cases c ON c.id = o.id WHERE o.id = $1',
        [orderId]
      );
      const refId = (refRow && refRow.reference_id) || String(orderId).slice(0, 12).toUpperCase();
      if (doctor && doctor.email) {
        await emailService.notifyDoctorFileUploaded(doctor.email, refId, req.user.name || 'Patient');
      }
    } catch (err) {
      logErrorToDb(err, {
        context: 'patient.notify_doctor_file_uploaded',
        requestId: req.requestId,
        userId: req.user?.id,
        url: req.originalUrl,
        method: req.method,
        category: 'patient_case',
        orderId
      });
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

// Test-only export so tests/core/wizard-files-poll.test.js can verify the
// AI-quality-status mapping without spinning up the full HTTP stack. Not part
// of the public router contract — do not consume in production code.
router.__test_mapAiQualityToIsValid = mapAiQualityToIsValid;

module.exports = router;
