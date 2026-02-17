// src/routes/patient.js
const express = require('express');
const { requireRole } = require('../middleware');
const { db } = require('../db');
const { queueNotification, queueMultiChannelNotification } = require('../notify');
const { getNotificationTitles } = require('../notify/notification_titles');
const { randomUUID } = require('crypto');
const { logOrderEvent } = require('../audit');
const { computeSla, enforceBreachIfNeeded } = require('../sla_status');

const caseLifecycle = require('../case_lifecycle');
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





// ============ PRE-LAUNCH GATE ============
const LAUNCH_DATE = new Date('2026-02-28T00:00:00+02:00'); // Cairo time
const isPreLaunch = () => new Date() < LAUNCH_DATE;
// ==========================================

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

// Defaults for alerts badge on patient pages.
router.use((req, res, next) => {
  res.locals.unseenAlertsCount = 0;
  res.locals.alertsUnseenCount = 0;
  res.locals.hasUnseenAlerts = false;
  return next();
});

// Unseen alerts count (patient role only).
router.use((req, res, next) => {
  try {
    const user = req.user;
    if (!user || String(user.role || '') !== 'patient') return next();
    const count = countPatientUnseenNotifications(user.id, user.email || '');
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
router.post('/patient/profile', requireRole('patient'), function(req, res) {
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

    db.prepare(
      'UPDATE users SET name = ?, phone = ?, lang = ?, notify_whatsapp = ?, email_marketing_opt_out = ?, date_of_birth = ?, gender = ?, country_code = ? WHERE id = ?'
    ).run(name, phone || null, prefLang, notifyWhatsapp, emailOptOut, dateOfBirth, gender, countryCode, userId);

    // Refresh user object for re-render
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (updated) req.user = updated;

    return renderPatientProfile(req, res, { success: isAr ? 'تم حفظ التغييرات بنجاح' : 'Changes saved successfully' });
  } catch (err) {
    return renderPatientProfile(req, res, { error: isAr ? 'حدث خطأ أثناء الحفظ' : 'Error saving changes' });
  }
});

// ---- Patient alerts (in-app notifications) ----

function getNotificationTableColumns() {
  try {
    const cols = db.prepare('PRAGMA table_info(notifications)').all();
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

function fetchPatientNotifications(userId, userEmail = '', limit = 50) {
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

function countPatientUnseenNotifications(userId, userEmail = '') {
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

function markAllPatientNotificationsRead(userId, userEmail = '') {
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

router.get('/portal/patient/alerts', requireRole('patient'), (req, res) => {
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';
  const userId = req.user && req.user.id ? String(req.user.id) : '';
  const userEmail = req.user && req.user.email ? String(req.user.email).trim() : '';

  const raw = fetchPatientNotifications(userId, userEmail, 50);
  const alerts = (raw || []).map(normalizePatientNotification);

  try {
    if (userId) {
      markAllPatientNotificationsRead(userId, userEmail);
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
function hasColumn(tableName, columnName) {
  const key = `${tableName}.${columnName}`;
  if (_schemaCache.has(key)) return _schemaCache.get(key);
  try {
    const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
    const ok = Array.isArray(cols) && cols.some((c) => c && c.name === columnName);
    _schemaCache.set(key, ok);
    return ok;
  } catch (e) {
    _schemaCache.set(key, false);
    return false;
  }
}

const SERVICES_VISIBLE_KEY = 'services.is_visible';
function ensureServicesVisibilityColumn() {
  const cached = _schemaCache.get(SERVICES_VISIBLE_KEY);
  if (cached === true) return true;

  try {
    const cols = db.prepare("PRAGMA table_info('services')").all();
    const hasVisible = Array.isArray(cols) && cols.some((c) => c && c.name === 'is_visible');
    _schemaCache.set(SERVICES_VISIBLE_KEY, hasVisible);
    if (hasVisible) return true;
  } catch (_) {
    // fall through to ALTER TABLE
  }

  try {
    db.prepare("ALTER TABLE services ADD COLUMN is_visible INTEGER DEFAULT 1").run();
    try {
      db.prepare("UPDATE services SET is_visible = 1 WHERE is_visible IS NULL").run();
    } catch (_) {
      // non-blocking
    }
    _schemaCache.set(SERVICES_VISIBLE_KEY, true);
    return true;
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (/duplicate column/i.test(msg)) {
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

function servicesSlaExpr(alias) {
  // tolerate older/newer DB schemas
  // prefer `sla_hours`, but fall back to `sla` if that's what exists
  if (hasColumn('services', 'sla_hours')) return alias ? `${alias}.sla_hours` : 'sla_hours';
  if (hasColumn('services', 'sla')) return alias ? `${alias}.sla` : 'sla';
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

function servicesVisibleClause(alias) {
  // tolerate older/newer DB schemas
  if (!ensureServicesVisibilityColumn()) return '1=1';
  const col = alias ? `${alias}.is_visible` : 'is_visible';
  return `COALESCE(${col}, 1) = 1`;
}

// --- safe schema helpers ---
function _forceSchema(tableName, columnName, value) {
  const key = `${tableName}.${columnName}`;
  _schemaCache.set(key, value);
}

function insertAdditionalFile(orderId, url, labelValue, nowIso) {
  const withLabelSql =
    `INSERT INTO order_additional_files (id, order_id, file_url, label, uploaded_at)
     VALUES (?, ?, ?, ?, ?)`;
  const noLabelSql =
    `INSERT INTO order_additional_files (id, order_id, file_url, uploaded_at)
     VALUES (?, ?, ?, ?)`;

  const runWithLabel = () => {
    db.prepare(withLabelSql).run(randomUUID(), orderId, url, labelValue || null, nowIso);
  };
  const runNoLabel = () => {
    db.prepare(noLabelSql).run(randomUUID(), orderId, url, nowIso);
  };

  const addHasLabel = hasColumn('order_additional_files', 'label');
  if (!addHasLabel) return runNoLabel();

  try {
    return runWithLabel();
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    // Schema cache can be stale across DB variants; retry safely without label.
    if ((/no such column:/i.test(msg) || /no column named/i.test(msg)) && /label/i.test(msg)) {
      _forceSchema('order_additional_files', 'label', false);
      return runNoLabel();
    }
    throw err;
  }
}

function safeAll(sqlFactory, params = []) {
  // sqlFactory: (slaExpr: string) => string
  try {
    return db.prepare(sqlFactory(servicesSlaExpr())).all(...params);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    // If DB schema doesn’t actually have sla_hours, retry after forcing cache false
    if (/no such column:/i.test(msg) && /sla_hours/i.test(msg)) {
      _forceSchema('services', 'sla_hours', false);
      return db.prepare(sqlFactory(servicesSlaExpr())).all(...params);
    }
    throw err;
  }
}

function safeGet(sqlFactory, params = []) {
  // sqlFactory: (slaExpr: string) => string
  try {
    return db.prepare(sqlFactory(servicesSlaExpr())).get(...params);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (/no such column:/i.test(msg) && /sla_hours/i.test(msg)) {
      _forceSchema('services', 'sla_hours', false);
      return db.prepare(sqlFactory(servicesSlaExpr())).get(...params);
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

// ===== AI CASE TYPE ANALYSIS ENDPOINT =====
router.post('/api/analyze-case-type', requireRole('patient'), async (req, res) => {
  try {
    const { description } = req.body;
    
    if (!description || typeof description !== 'string' || description.trim().length < 10) {
      return res.json({
        success: false,
        error: 'Please provide a description of at least 10 characters'
      });
    }

    // Simple keyword-based AI analysis (can be replaced with actual AI later)
    const text = description.toLowerCase();
    
    let suggestedTypes = [];
    let reasoning = '';
    
    // Imaging keywords
    const imagingKeywords = ['x-ray', 'xray', 'mri', 'ct', 'scan', 'imaging', 'ultrasound', 'mammogram', 'radiology', 'fracture', 'bone'];
    const hasImaging = imagingKeywords.some(kw => text.includes(kw));
    
    // Labs keywords
    const labsKeywords = ['blood', 'test', 'lab', 'laboratory', 'cbc', 'cholesterol', 'glucose', 'thyroid', 'pathology', 'biopsy', 'urinalysis'];
    const hasLabs = labsKeywords.some(kw => text.includes(kw));
    
    // Treatment keywords
    const treatmentKeywords = ['surgery', 'surgical', 'operation', 'procedure', 'medication', 'treatment', 'therapy', 'chemo', 'radiation'];
    const hasTreatment = treatmentKeywords.some(kw => text.includes(kw));
    
    // General keywords
    const generalKeywords = ['diagnosis', 'symptom', 'pain', 'question', 'opinion', 'advice', 'consultation'];
    const hasGeneral = generalKeywords.some(kw => text.includes(kw));
    
    // Determine primary type
    if (hasImaging) {
      suggestedTypes.push({ value: 'imaging', label: 'Diagnostic Imaging' });
      reasoning = 'Your description mentions imaging studies like X-rays, MRIs, or CT scans.';
    }
    
    if (hasLabs) {
      suggestedTypes.push({ value: 'labs', label: 'Laboratory Tests' });
      if (reasoning) reasoning += ' You also mentioned lab tests or blood work.';
      else reasoning = 'Your description mentions laboratory tests or blood work.';
    }
    
    if (hasTreatment) {
      suggestedTypes.push({ value: 'treatment', label: 'Treatment Review' });
      if (reasoning) reasoning += ' You also mentioned treatment, surgery, or medications.';
      else reasoning = 'Your description mentions treatments, surgery, or medications.';
    }
    
    if (hasGeneral || suggestedTypes.length === 0) {
      suggestedTypes.push({ value: 'general', label: 'General Medical Question' });
      if (!reasoning) reasoning = 'This appears to be a general medical question or consultation need.';
    }
    
    // Limit to top 2 suggestions
    suggestedTypes = suggestedTypes.slice(0, 2);
    
    return res.json({
      success: true,
      suggestedTypes,
      reasoning,
      confidence: suggestedTypes.length === 1 ? 'high' : 'medium'
    });
    
  } catch (error) {
    console.error('AI analysis error:', error);
    return res.json({
      success: false,
      error: 'An error occurred during analysis. Please select manually.'
    });
  }
});

// GET /dashboard – patient home with order list (with filters)
router.get('/dashboard', requireRole('patient'), (req, res) => {
  const patientId = req.user.id;
  const { status = '', specialty = '', q = '' } = req.query || {};
  const selectedStatus = status === 'all' ? '' : status;
  const selectedSpecialty = specialty === 'all' ? '' : specialty;
  const searchTerm = q && q.trim() ? q.trim() : '';

  const where = ['o.patient_id = ?'];
  const params = [patientId];

  if (selectedStatus) {
    const canon = canonOrOriginal(selectedStatus);
    const vals = statusDbValues(String(canon || '').toUpperCase(), [selectedStatus]);
    const inSql = sqlIn('o.status', vals);
    where.push(inSql.clause);
    params.push(...inSql.params);
  }
  if (selectedSpecialty) {
    where.push('o.specialty_id = ?');
    params.push(selectedSpecialty);
  }
  if (searchTerm) {
    where.push('(sv.name LIKE ? OR o.notes LIKE ? OR o.id LIKE ?)');
    params.push(`%${searchTerm}%`, `%${searchTerm}%`, `%${searchTerm}%`);
  }

  const orders = db
    .prepare(
      `SELECT o.*,
              s.name AS specialty_name,
              sv.name AS service_name,
              d.name AS doctor_name
       FROM orders o
       LEFT JOIN specialties s ON o.specialty_id = s.id
       LEFT JOIN services sv ON o.service_id = sv.id
       LEFT JOIN users d ON d.id = o.doctor_id
       WHERE ${where.join(' AND ')}
       ORDER BY o.created_at DESC`
    )
    .all(...params);

  const enhancedOrders = orders.map((o) => {
    enforceBreachIfNeeded(o);
    const computed = computeSla(o);
    return { ...o, status: computed.effectiveStatus || o.status, effectiveStatus: computed.effectiveStatus, sla: computed.sla };
  });

  // Attach canonical status UI mapping (templates must not use require())
  const langCode = (res.locals && res.locals.lang === 'ar') ? 'ar' : 'en';
  const normalizeStatus = (val) => {
    const canon = canonOrOriginal(val);
    return canon ? String(canon).trim().toUpperCase() : '';
  };
  const enhancedOrdersWithUi = (enhancedOrders || []).map((o) => {
    const normalizedStatus = normalizeStatus(o.effectiveStatus || o.status);
    return { ...o, statusUi: getStatusUi(normalizedStatus, { role: 'patient', lang: langCode }) };
  });

  const specialties = db
    .prepare('SELECT id, name FROM specialties ORDER BY name ASC')
    .all();

  // Check onboarding status for banner
  var onboardingComplete = 1;
  try {
    var userRow = db.prepare('SELECT onboarding_complete FROM users WHERE id = ?').get(patientId);
    if (userRow && userRow.onboarding_complete === 0) onboardingComplete = 0;
  } catch (_) { /* column may not exist yet */ }

  res.render('patient_dashboard', {
    user: req.user,
    orders: enhancedOrdersWithUi || [],
    specialties: specialties || [],
    onboardingComplete: onboardingComplete,
    filters: {
      status: selectedStatus,
      specialty: selectedSpecialty,
      q: searchTerm
    }
  });
});

// New case page (UploadCare)
router.get('/patient/new-case', requireRole('patient'), (req, res) => {
  const qs = req.query && req.query.specialty_id
    ? `?specialty_id=${encodeURIComponent(String(req.query.specialty_id))}`
    : '';
  return res.redirect(`/portal/patient/orders/new${qs}`);
});

// Alias: direct access to /portal/patient/orders/new (new-case form)
// PRE-LAUNCH: Block new case creation — redirect to coming soon
router.get('/portal/patient/orders/new', requireRole('patient'), (req, res) => {
  return res.redirect('/coming-soon');
});
router.post('/patient/new-case', requireRole('patient'), (req, res) => {
  return res.redirect('/coming-soon');
});
router.get('/patient/new-case', requireRole('patient'), (req, res) => {
  return res.redirect('/coming-soon');
});

/* ORIGINAL NEW CASE ROUTES — uncomment after launch
router.get('/portal/patient/orders/new', requireRole('patient'), (req, res) => {
  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  const selectedSpecialtyId =
    (req.query && req.query.specialty_id) ||
    (specialties && specialties.length ? specialties[0].id : null);

  const countryCode = getUserCountryCode(req);
  const countryCurrency = getCountryCurrency(countryCode);

  const services = safeAll(
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
        AND cp.country_code = ?
        AND COALESCE(cp.status, 'active') = 'active'
       WHERE ${servicesVisibleClause('sv')}
       ORDER BY sv.name ASC`,
    [countryCode]
  );

  return renderPatientOrderNew(res, {
    user: req.user,
    specialties,
    services,
    selectedSpecialtyId,
    countryCurrency,
    error: null,
    form: {}
  });
});

// Create new case (UploadCare)
router.post('/patient/new-case', requireRole('patient'), (req, res) => {
  const patientId = req.user.id;
  const countryCode = getUserCountryCode(req);
  const countryCurrency = getCountryCurrency(countryCode);
  const { specialty_id, service_id, notes, file_urls, sla_type } = req.body || {};

  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  const services = safeAll(
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
        AND cp.country_code = ?
        AND COALESCE(cp.status, 'active') = 'active'
       WHERE ${servicesVisibleClause('sv')}
       ORDER BY sv.name ASC`,
    [countryCode]
  );

  const service = safeGet(
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
        AND cp.country_code = ?
        AND COALESCE(cp.status, 'active') = 'active'
       WHERE sv.id = ? AND ${servicesVisibleClause('sv')}`,
    [countryCode, service_id]
  );

  const validSpecialty = specialty_id && db.prepare('SELECT 1 FROM specialties WHERE id = ?').get(specialty_id);
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

  const tx = db.transaction(() => {
    const ordersHasCountry = hasColumn('orders', 'country_code');

    const insertSql = ordersHasCountry
      ? `INSERT INTO orders (
        id, patient_id, doctor_id, specialty_id, service_id, sla_hours, status,
        price, doctor_fee, created_at, accepted_at, deadline_at, completed_at,
        breached_at, reassigned_count, report_url, notes,
        uploads_locked, additional_files_requested, payment_status, payment_method,
        payment_reference, payment_link, updated_at,
        country_code
      ) VALUES (
        @id, @patient_id, NULL, @specialty_id, @service_id, @sla_hours, @status,
        @price, @doctor_fee, @created_at, NULL, @deadline_at, NULL,
        NULL, 0, NULL, @notes,
        0, 0, 'unpaid', NULL,
        NULL, @payment_link, @created_at,
        @country_code
      )`
      : `INSERT INTO orders (
        id, patient_id, doctor_id, specialty_id, service_id, sla_hours, status,
        price, doctor_fee, created_at, accepted_at, deadline_at, completed_at,
        breached_at, reassigned_count, report_url, notes,
        uploads_locked, additional_files_requested, payment_status, payment_method,
        payment_reference, payment_link, updated_at
      ) VALUES (
        @id, @patient_id, NULL, @specialty_id, @service_id, @sla_hours, @status,
        @price, @doctor_fee, @created_at, NULL, @deadline_at, NULL,
        NULL, 0, NULL, @notes,
        0, 0, 'unpaid', NULL,
        NULL, @payment_link, @created_at
      )`;

    db.prepare(insertSql).run({
      id: orderId,
      patient_id: patientId,
      specialty_id,
      service_id,
      sla_hours: slaHours,
      price,
      doctor_fee: doctorFee,
      created_at: nowIso,
      deadline_at: deadlineAt,
      notes: notes || null,
      payment_link: service.payment_link || fallbackPaymentLink,
      status: dbStatusFor('SUBMITTED', 'new'),
      country_code: ordersHasCountry ? countryCode : undefined
    });

    const insertFile = db.prepare(
      `INSERT INTO order_files (id, order_id, url, label, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    fileList.forEach((url) => {
      insertFile.run(randomUUID(), orderId, url, null, nowIso);
    });

    logOrderEvent({
      orderId,
      label: 'Order created by patient',
      actorUserId: patientId,
      actorRole: 'patient'
    });
  });

  try {
    tx();
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
router.post('/patient/orders', requireRole('patient'), (req, res) => {
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

  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  const services = safeAll(
    (slaExpr) =>
      `SELECT sv.id, sv.specialty_id, sv.name,
              COALESCE(cp.tashkheesa_price, sv.base_price) AS base_price,
              COALESCE(cp.doctor_commission, sv.doctor_fee) AS doctor_fee,
              COALESCE(cp.currency, sv.currency) AS currency,
              sv.payment_link AS payment_link,
              ${slaExpr} AS sla_hours,
              sp.name AS specialty_name
       FROM services sv
       LEFT JOIN specialties sp ON sp.id = sv.specialty_id
       LEFT JOIN service_regional_prices cp
         ON cp.service_id = sv.id
        AND cp.country_code = ?
        AND COALESCE(cp.status, 'active') = 'active'
       WHERE ${servicesVisibleClause('sv')}
       ORDER BY sp.name ASC, sv.name ASC`,
    [countryCode]
  );

  const service = safeGet(
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
        AND cp.country_code = ?
        AND COALESCE(cp.status, 'active') = 'active'
       WHERE sv.id = ? AND ${servicesVisibleClause('sv')}`,
    [countryCode, service_id]
  );

  // Immutable price/currency/fee snapshot (TASK 2)
  const computedPrice = service.base_price != null ? Number(service.base_price) : 0;
  const computedCurrency = service.currency || countryCurrency;
  const computedDoctorFee = service.doctor_fee != null ? Number(service.doctor_fee) : 0;

  const serviceMatchesSpecialty =
    service && specialty_id && String(service.specialty_id) === String(specialty_id);

  if (!service_id || !service || !specialty_id || !serviceMatchesSpecialty) {
    return res.status(400) && renderPatientOrderNew(res, {
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
    const result = res.status(400) && renderPatientOrderNew(res, {
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

  const tx = db.transaction(() => {
    const ordersHasCountry = hasColumn('orders', 'country_code');

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
        @id, @patient_id, NULL, @specialty_id, @service_id, @sla_hours, @status,
        @price, @doctor_fee, @created_at, NULL, NULL, NULL,
        NULL, 0, NULL, @notes, @medical_history, @current_medications,
        0, 0, 'unpaid', NULL,
        NULL, @payment_link, @created_at,
        @country_code,
        @locked_price, @locked_currency, @price_snapshot_json
      )`
      : `INSERT INTO orders (
        id, patient_id, doctor_id, specialty_id, service_id, sla_hours, status,
        price, doctor_fee, created_at, accepted_at, deadline_at, completed_at,
        breached_at, reassigned_count, report_url, notes, medical_history, current_medications,
        uploads_locked, additional_files_requested, payment_status, payment_method,
        payment_reference, payment_link, updated_at,
        locked_price, locked_currency, price_snapshot_json
      ) VALUES (
        @id, @patient_id, NULL, @specialty_id, @service_id, @sla_hours, @status,
        @price, @doctor_fee, @created_at, NULL, NULL, NULL,
        NULL, 0, NULL, @notes, @medical_history, @current_medications,
        0, 0, 'unpaid', NULL,
        NULL, @payment_link, @created_at,
        @locked_price, @locked_currency, @price_snapshot_json
      )`;

    db.prepare(insertSql).run({
      id: orderId,
      patient_id: patientId,
      specialty_id,
      service_id,
      sla_hours: slaHours,
      price: computedPrice,
      doctor_fee: computedDoctorFee,
      created_at: nowIso,
      notes: orderNotes,
      medical_history: medical_history || null,
      current_medications: current_medications || null,
      payment_link: service.payment_link || fallbackPaymentLink,
      status: dbStatusFor('SUBMITTED', 'new'),
      country_code: ordersHasCountry ? countryCode : undefined,
      locked_price: computedPrice,
      locked_currency: computedCurrency,
      price_snapshot_json: JSON.stringify(priceSnapshot)
    });

    // Only insert file if present (logic unchanged)
    if (primaryUrl) {
      db.prepare(
        `INSERT INTO order_files (id, order_id, url, label, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(randomUUID(), orderId, primaryUrl, 'Initial upload', nowIso);
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

    const superadmins = db
      .prepare("SELECT id FROM users WHERE role = 'superadmin' AND is_active = 1")
      .all();
    superadmins.forEach((admin) => {
      queueNotification({
        orderId,
        toUserId: admin.id,
        channel: 'internal',
        template: 'order_created_patient',
        status: 'queued'
      });
    });
  });

  try {
    tx();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[patient order create] failed', err);
    return res.status(500) && renderPatientOrderNew(res, {
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
router.get('/portal/patient/pay/:id', requireRole('patient'), (req, res) => {
  const orderId = req.params.id;
  const patientId = req.user.id;
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';

  // Expanded query: include service/specialty/price details for payment page
  const order = db.prepare(
    `SELECT o.id,
            o.payment_status,
            o.payment_link,
            o.locked_price,
            o.locked_currency,
            sv.name AS service_name,
            sp.name AS specialty_name
     FROM orders o
     LEFT JOIN services sv ON sv.id = o.service_id
     LEFT JOIN specialties sp ON sp.id = o.specialty_id
     WHERE o.id = ? AND o.patient_id = ?`
  ).get(orderId, patientId);

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
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(order.service_id);
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
    serviceDetails: service,
    error: null,
  });
});

// Order detail
router.get('/portal/patient/orders/:id', requireRole('patient'), (req, res) => {
  const orderId = req.params.id;
  const patientId = req.user.id;
  const uploadClosed = req.query && req.query.upload_closed === '1';
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';

  let order = db
    .prepare(
      `SELECT o.*,
              s.name AS specialty_name,
              sv.name AS service_name,
              sv.payment_link AS service_payment_link,
              sv.base_price AS service_price,
              sv.currency AS service_currency,
              sv.doctor_fee AS service_doctor_fee,
              d.name AS doctor_name
       FROM orders o
       LEFT JOIN specialties s ON o.specialty_id = s.id
       LEFT JOIN services sv ON o.service_id = sv.id
       LEFT JOIN users d ON d.id = o.doctor_id
       WHERE o.id = ? AND o.patient_id = ?`
    )
    .get(orderId, patientId);

  if (!order) return res.redirect('/dashboard');

 // Defensive backfill (non-blocking, never crash GET)
try {
  if (
    order.payment_status === 'paid' &&
    (order.deadline_at == null || String(order.deadline_at).trim() === '')
  ) {
    if (typeof caseLifecycle.markCasePaid === 'function') {
      caseLifecycle.markCasePaid(order.id);
    }
  }
} catch (e) {
  console.error('[payment_backfill_failed]', { orderId: order.id, error: String(e) });
}
    // Re-fetch the order to ensure updated status/deadline/SLA
    order = db
      .prepare(
        `SELECT o.*,
                s.name AS specialty_name,
                sv.name AS service_name,
                sv.payment_link AS service_payment_link,
                sv.base_price AS service_price,
                sv.currency AS service_currency,
                sv.doctor_fee AS service_doctor_fee,
                d.name AS doctor_name
         FROM orders o
         LEFT JOIN specialties s ON o.specialty_id = s.id
         LEFT JOIN services sv ON o.service_id = sv.id
         LEFT JOIN users d ON d.id = o.doctor_id
         WHERE o.id = ? AND o.patient_id = ?`
      )
      .get(orderId, patientId);
  

  enforceBreachIfNeeded(order);
  const computed = computeSla(order);
  order.effectiveStatus = computed.effectiveStatus;
  order.status = order.effectiveStatus || order.status;
  const sla = computed.sla;

  const files = db
    .prepare(
      `SELECT id, url, label, created_at
       FROM order_files
       WHERE order_id = ?
       ORDER BY created_at DESC`
    )
    .all(orderId);

  const addHasLabel = hasColumn('order_additional_files', 'label');
  const additionalFiles = db
    .prepare(
      `SELECT id,
              file_url AS url,
              ${addHasLabel ? 'label' : 'NULL'} AS label,
              uploaded_at AS created_at
       FROM order_additional_files
       WHERE order_id = ?
       ORDER BY uploaded_at DESC`
    )
    .all(orderId);

  const allFiles = [...files, ...additionalFiles].sort((a, b) => {
    const aDate = new Date(a.created_at || 0).getTime();
    const bDate = new Date(b.created_at || 0).getTime();
    return bDate - aDate;
  });

  const events = db
    .prepare(
      `SELECT id, label, at
       FROM order_events
       WHERE order_id = ?
       ORDER BY at DESC
       LIMIT 25`
    )
    .all(orderId);
  const timeline = events.map((ev) => ({ ...ev, formattedAt: formatDisplayDate(ev.at) }));

  const messages = db
    .prepare(
      `SELECT id, label, meta, at
       FROM order_events
       WHERE order_id = ?
         AND label IN ('doctor_request', 'patient_reply')
       ORDER BY at ASC`
    )
    .all(orderId)
    .map((msg) => ({ ...msg, atFormatted: formatDisplayDate(msg.at) }));

  const paymentLink = order.payment_link || null;

  // Get video consultation price from service
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(order.service_id);
  const videoConsultationPrice = service?.video_consultation_price || 0;

  if (order.payment_status === 'unpaid') {
    return res.render('patient_payment_required', {
      user: req.user,
      order,
      lang,
      isAr,
      paymentLink,
      paymentUrl: paymentLink,
      price: order?.locked_price || order?.price || 0,
      currency: order?.locked_currency || 'SAR',
      videoConsultationPrice,
      serviceDetails: service,
    });
  }

  // HARD GUARDRAIL: pricing must always be locked at order creation
if (order.locked_price == null || !order.locked_currency) {
  console.error('[pricing_integrity_violation]', { orderId: order.id });
  return res.status(409).render('patient_payment_required', {
    user: req.user,
    order,
    lang,
    isAr,
    paymentLink,
    paymentUrl: paymentLink,
    price: order?.locked_price || order?.price || 0,
    currency: order?.locked_currency || 'SAR',
    videoConsultationPrice,
    serviceDetails: service,
  });
}

  const displayPrice = order.locked_price;
  const displayCurrency = order.locked_currency;
  const uploadsLocked = Number(order.uploads_locked) === 1;
  const isCompleted = isCanonStatus(order.status, 'COMPLETED');
  const canUploadMore = !isCompleted && !uploadsLocked;
  const isUnpaid = order.payment_status === 'unpaid';
  const hasPaymentLink = !!paymentLink;
  const normalizedStatus = String(canonOrOriginal(order.effectiveStatus || order.status) || '').trim().toUpperCase();
  const langCode = (res.locals && res.locals.lang === 'ar') ? 'ar' : 'en';
  const statusUi = getStatusUi(normalizedStatus, { role: 'patient', lang: langCode });

  // Lookup conversation for "Message Doctor" button
  var caseConversationId = null;
  try {
    var convo = db.prepare(
      'SELECT id FROM conversations WHERE order_id = ? AND patient_id = ? LIMIT 1'
    ).get(order.id, req.user.id);
    if (convo) caseConversationId = convo.id;
  } catch (_) {}

  // Load annotations for this case's files
  var annotatedFiles = [];
  try {
    annotatedFiles = db.prepare(
      `SELECT ca.id, ca.image_id AS imageId, ca.doctor_id AS doctorId,
              ca.annotations_count AS annotationsCount,
              ca.created_at AS createdAt, ca.updated_at AS updatedAt,
              u.name AS doctorName
       FROM case_annotations ca
       LEFT JOIN users u ON u.id = ca.doctor_id
       WHERE ca.case_id = ?
       ORDER BY ca.updated_at DESC`
    ).all(order.id);
  } catch (_) {
    annotatedFiles = [];
  }

  res.render('patient_order', {
    user: req.user,
    order: {
      ...order,
      payment_link: paymentLink,
      display_price: displayPrice,
      display_currency: displayCurrency
    },
    sla,
    doctor_photo: null,
    files: allFiles,
    order_additional_files: additionalFiles,
    timeline,
    events,
    messages,
    uploadClosed,
    canUploadMore,
    isUnpaid,
    hasPaymentLink,
    statusUi,
    caseConversationId,
    annotatedFiles
  });
});

// Patient replies to doctor's clarification request
router.post('/portal/patient/orders/:id/submit-info', requireRole('patient'), (req, res) => {
  const orderId = req.params.id;
  const patientId = req.user.id;
  const message = (req.body && req.body.message ? String(req.body.message) : '').trim();

  const order = db
    .prepare('SELECT * FROM orders WHERE id = ? AND patient_id = ?')
    .get(orderId, patientId);

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
  db.prepare(
    `UPDATE orders
     SET updated_at = ?
     WHERE id = ?`
  ).run(nowIso, orderId);

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
router.get('/portal/patient/orders/:id/upload', requireRole('patient'), (req, res) => {
  const orderId = req.params.id;
  const patientId = req.user.id;
  const { locked = '', uploaded = '', error = '' } = req.query || {};

  const order = db
    .prepare(
      `SELECT o.*, s.name AS specialty_name, sv.name AS service_name
       FROM orders o
       LEFT JOIN specialties s ON o.specialty_id = s.id
       LEFT JOIN services sv ON o.service_id = sv.id
       WHERE o.id = ? AND o.patient_id = ?`
    )
    .get(orderId, patientId);

  if (!order) {
    return res.redirect('/dashboard');
  }

  const files = db
    .prepare(
      `SELECT id, url, label, created_at
       FROM order_files
       WHERE order_id = ?
       ORDER BY created_at DESC`
    )
    .all(orderId);

  const addHasLabel = hasColumn('order_additional_files', 'label');
  const additionalFiles = db
    .prepare(
      `SELECT id,
              file_url AS url,
              ${addHasLabel ? 'label' : 'NULL'} AS label,
              uploaded_at AS created_at
       FROM order_additional_files
       WHERE order_id = ?
       ORDER BY uploaded_at DESC`
    )
    .all(orderId);

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
router.post('/portal/patient/orders/:id/upload', requireRole('patient'), (req, res) => {
  const orderId = req.params.id;
  const patientId = req.user.id;
  const { file_url, file_urls, label } = req.body || {};

  const uploaderConfigured = String(process.env.UPLOADCARE_PUBLIC_KEY || '').trim().length > 0;
  const cleanLabel = (label && String(label).trim()) ? String(label).trim().slice(0, 120) : null;

  const order = db
    .prepare('SELECT * FROM orders WHERE id = ? AND patient_id = ?')
    .get(orderId, patientId);

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
    // If uploader isn’t configured, fail with a clear message.
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

  const tx = db.transaction(() => {
    filtered.forEach((u) => {
      insertAdditionalFile(orderId, u, cleanLabel, now);
    });

    logOrderEvent({
      orderId,
      label: 'patient_uploaded_additional_files',
      meta: `count=${filtered.length}${cleanLabel ? `;label=${cleanLabel}` : ''}`,
      actorUserId: patientId,
      actorRole: 'patient'
    });

    // If doctor requested more files, clear the flag once patient uploads.
    // Optional guardrail: re-lock uploads after the re-upload so the case doesn't drift.
    if (wasAdditionalFilesRequested) {
      db.prepare(
        `UPDATE orders
         SET additional_files_requested = 0,
             uploads_locked = 1,
             updated_at = ?
         WHERE id = ?`
      ).run(now, orderId);
    } else {
      db.prepare(
        `UPDATE orders
         SET additional_files_requested = 0,
             updated_at = ?
         WHERE id = ?`
      ).run(now, orderId);
    }
  });

  try {
    tx();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[patient upload] failed', err);
    return res.redirect(`/portal/patient/orders/${orderId}/upload?error=invalid_url`);
  }

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
  }

  return res.redirect(`/portal/patient/orders/${orderId}/upload?uploaded=1`);
});

module.exports = router;
