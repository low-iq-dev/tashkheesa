// src/routes/superadmin.js
const express = require('express');
const { queryOne, queryAll, execute, withTransaction } = require('../pg');
const { logErrorToDb } = require('../logger');
const { randomUUID } = require('crypto');
const { requireRole } = require('../middleware');
const { queueNotification, queueMultiChannelNotification, doctorNotify } = require('../notify');
const { getNotificationTitles } = require('../notify/notification_titles');
// Side issue #47 — sla_watcher.runSlaSweep was a no-op; callers below
// removed. case_sla_worker.runCaseSlaSweep is the canonical sweep.
const { logOrderEvent } = require('../audit');
const { computeSla, enforceBreachIfNeeded } = require('../sla_status');
const { pickDoctorForOrder } = require('../assign');
const { recalcSlaBreaches } = require('../case_lifecycle'); // sla.js deleted, use case_lifecycle shim
const { randomUUID: uuidv4 } = require('crypto');
const { safeAll, safeGet, tableExists } = require('../sql-utils');
const { ensureConversation } = require('./messaging');
const caseLifecycle = require('../case_lifecycle');
const { fetchNotifications, countUnseenNotifications, markAllNotificationsRead, normalizeNotification } = require('../utils/notifications');
const emailService = require('../services/emailService');
const { logAdminAudit } = require('../services/admin_audit');
const adminSettings = require('../services/admin_settings');
const superadminDashboard = require('../services/superadmin_dashboard');
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

const IS_PROD = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

// Mirrors src/routes/auth.js portal flow — keep in sync. Used by the
// superadmin "Create Doctor" handler when it issues a one-time setup
// link to the new doctor instead of generating a temporary password.
const RESET_EXPIRY_HOURS = 2;     // forgot-password / manual reset — user is actively requesting, short window
// P1-NOTIF-5: doctor approval + admin-created doctor first-time setup —
// recipient is passive (didn't request the email), may not check inbox
// for days. 7 days matches industry-standard onboarding email expiry.
const WELCOME_EXPIRY_HOURS = 168;

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

// Phase 1 design-system preview. Owner-only. Removed before final merge.
// Exercises every superadmin partial + component with hardcoded data.
router.get('/superadmin/__preview', requireSuperadmin, async (req, res) => {
  return res.render('superadmin__preview', {
    user: req.user,
    cspNonce: (res.locals && res.locals.cspNonce) || ''
  });
});

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
         -- Theme 7 sub-issue D: explicit short identifiers written by
         -- the admin/superadmin approve handlers as of 2026-05-10.
         label = 'admin_approved_files_request'
         OR label = 'superadmin_approved_files_request'
         OR
         -- Backward-compat for in-flight pre-Theme-7 rows (descriptive
         -- English labels). The 'approved' substring also matches the
         -- new short identifiers, so this branch is fully redundant for
         -- post-migration rows but preserved as belt-and-suspenders.
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
  res.render('superadmin_doctors', { user: req.user, doctors, specialties, statusFilter, pendingDoctorsCount, pausedDoctorsCount });
});

router.get('/superadmin/doctors/new', requireSuperadmin, async (req, res) => {
  const specialties = await queryAll('SELECT id, name FROM specialties ORDER BY name ASC');
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

  // No password is generated here. The doctor sets their own password by
  // following a one-time link delivered via email — same machinery as the
  // portal POST /forgot-password handler in src/routes/auth.js. This keeps
  // any plaintext credential out of stdout, the database, and the inbox.
  const newDoctorId = randomUUID();
  await execute(
    `INSERT INTO users (id, email, password_hash, name, role, specialty_id, phone, lang, notify_whatsapp, is_active)
     VALUES ($1, $2, NULL, $3, 'doctor', $4, $5, 'en', $6, $7)`,
    [
      newDoctorId,
      email,
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

  // Issue a one-time password-setup token and email it to the doctor.
  // Mirrors the token-issuance shape used by POST /forgot-password
  // (src/routes/auth.js:280-329) so a token issued here is redeemable
  // on the same /reset-password/:token page.
  // P1-NOTIF-5: uses WELCOME_EXPIRY_HOURS (7d) not RESET_EXPIRY_HOURS (2h) —
  // an admin-created doctor wasn't actively requesting this email and may
  // not check inbox for days. Same threat model as the doctor-approval
  // welcome email below.
  const resetToken = randomUUID();
  const tokenNow = new Date();
  const tokenExpiresAt = new Date(tokenNow.getTime() + WELCOME_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
  await execute(
    `INSERT INTO password_reset_tokens (id, user_id, token, expires_at, used_at, created_at)
     VALUES ($1, $2, $3, $4, NULL, $5)`,
    [randomUUID(), newDoctorId, resetToken, tokenExpiresAt, tokenNow.toISOString()]
  );

  // Resolve the public base URL the same way the manual reset-link
  // generator below does (env var first, request headers as fallback;
  // never default to localhost in prod).
  let baseUrl = String(process.env.BASE_URL || process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    try {
      const protoRaw = (req.get('x-forwarded-proto') || req.protocol || 'http');
      const proto = String(protoRaw).split(',')[0].trim() || 'http';
      const host = req.get('x-forwarded-host') || req.get('host');
      baseUrl = host ? `${proto}://${host}` : '';
    } catch (_) { baseUrl = ''; }
  }
  const resetLink = baseUrl ? `${baseUrl}/reset-password/${resetToken}?lang=en` : null;

  let emailOk = false;
  let emailErrorMsg = null;
  if (!resetLink) {
    emailErrorMsg = 'base_url_unresolved';
  } else {
    try {
      const result = await emailService.sendEmail({
        to: email,
        subject: 'Set up your Tashkheesa doctor account',
        template: 'password-reset',
        lang: 'en',
        data: {
          patientName: name || 'Doctor',
          resetLink: resetLink,
          expiryHours: WELCOME_EXPIRY_HOURS
        }
      });
      emailOk = !!(result && result.ok);
      if (!emailOk) emailErrorMsg = (result && (result.error || result.reason)) || 'send_failed';
    } catch (err) {
      logErrorToDb(err, {
        context: 'superadmin.doctor_approve_email',
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
    // Doctor record is already saved — do NOT roll back. Surface a clear
    // failure to the superadmin so they can retry via the manual
    // reset-link tool. Never include the token in the response or logs.
    // THEME8-LINT-EXEMPT-HELPER: downstream diagnostic — the originating
    // error is already captured by the wrapped catch at the email-send call
    // site above (context='superadmin.doctor_approve_email'). This line is
    // a human-readable summary including the masked email for stdout triage;
    // duplicating to /ops/errors would create two rows for one event.
    console.warn('[doctor-create] reset-email send failed for ' + email + ': ' + emailErrorMsg);
    return res
      .status(200)
      .type('text/plain')
      .send(
        'Doctor created for ' + email + ', but the password-setup email failed to send (' + emailErrorMsg + '). ' +
        'Use the superadmin reset-link tool to retry, then return to /superadmin/doctors.'
      );
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
  res.render('superadmin_doctor_form', { cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '', user: req.user, specialties, subSpecialties, selectedServiceIds, error: null, doctor, isEdit: true });
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
  // P1-NOTIF-5: pass req.query so the view can read ?approved=1 and
  // ?resend=ok|failed|skipped_pending flash flags.
  res.render('superadmin_doctor_detail', { user: req.user, doctor, pendingDoctorsCount, query: req.query });
});

// P1-NOTIF-5: helper used by both /approve and /resend-welcome to issue a
// 7-day magic-login token + queue the doctor-welcome email. Returns a
// payload object suitable for queueMultiChannelNotification.response.
// Side-effect: writes one row to password_reset_tokens.
async function _issueDoctorWelcomePayload(doctor, req) {
  const token = randomUUID();
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + WELCOME_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
  await execute(
    `INSERT INTO password_reset_tokens (id, user_id, token, expires_at, used_at, created_at)
     VALUES ($1, $2, $3, $4, NULL, $5)`,
    [randomUUID(), doctor.id, token, expiresAt, nowIso]
  );

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

  return {
    doctorName: doctor.name || (lang === 'ar' ? 'الطبيب' : 'Doctor'),
    magicLinkUrl: magicLinkUrl,
    portalUrl: portalUrl,
    expiryDays: Math.round(WELCOME_EXPIRY_HOURS / 24)
  };
}

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
// Issues a fresh token (existing unexpired tokens remain valid; magic-login
// marks them used on first redemption — collision-safe). Audit-logged.
router.post('/superadmin/doctors/:id/resend-welcome', requireSuperadmin, async (req, res) => {
  const doctorId = req.params.id;
  const doctor = await queryOne("SELECT * FROM users WHERE id = $1 AND role = 'doctor'", [doctorId]);
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
       FROM orders_active
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
     FROM orders_active o
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
      `SELECT id, base_price, urgency_uplift_amount FROM orders_active WHERE id = $1`,
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

  const order = await queryOne(
    `SELECT o.id, o.patient_id, o.payment_status, o.base_price, o.urgency_uplift_amount,
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
  const existingRefund = await queryOne(
    `SELECT id, status FROM refunds
      WHERE order_id = $1
        AND status IN ('pending','auto_approved','approved','paid')
      LIMIT 1`,
    [orderId]
  );

  const lang = (res.locals && res.locals.lang) || 'en';
  const isAr = String(lang).toLowerCase() === 'ar';
  const defaultAmount = Number(order.base_price || 0) + Number(order.urgency_uplift_amount || 0);

  res.render('superadmin_refund_create', {
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
    user: req.user,
    lang, isAr,
    order: order,
    defaultAmount: defaultAmount,
    existingRefund: existingRefund || null,
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
    `SELECT id, patient_id, payment_status, base_price, urgency_uplift_amount
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
  const existingRefund = await queryOne(
    `SELECT id FROM refunds
      WHERE order_id = $1
        AND status IN ('pending','auto_approved','approved','paid')
      LIMIT 1`,
    [orderId]
  );
  if (existingRefund) {
    return res.redirect(
      '/superadmin/refunds/create?order_id=' + encodeURIComponent(orderId) + '&error=refund_already_exists'
    );
  }

  // Amount: required, > 0, <= full case price (base + uplift).
  const maxAmount = Number(order.base_price || 0) + Number(order.urgency_uplift_amount || 0);
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

  logOrderEvent({
    orderId: refund.order_id,
    label: 'superadmin_refund_marked_paid',
    meta: {
      refund_id: refundId,
      amount_egp: finalAmount,
      instapay_reference: reference,
      payer_id: payerId
    },
    actorUserId: payerId,
    actorRole: 'superadmin'
  });

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
    const refundRow = await queryOne(
      "SELECT reason FROM refunds WHERE id = $1", [refundId]
    );
    if (refundRow && refundRow.reason) {
      await recomputeOnRefund(refund.order_id, { reason: refundRow.reason });
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

module.exports = { router, buildFilters };
