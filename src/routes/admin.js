const express = require('express');
const { queryOne, queryAll, execute, withTransaction } = require('../pg');
const { logOrderEvent } = require('../audit');
const { randomUUID } = require('crypto');
const { queueNotification, queueMultiChannelNotification } = require('../notify');
const { getNotificationTitles } = require('../notify/notification_titles');
const { computeSla, enforceBreachIfNeeded } = require('../sla_status');
const { recalcSlaBreaches } = require('../sla');
const { safeAll, safeGet, tableExists } = require('../sql-utils');
const caseLifecycle = require('../case_lifecycle');
const { requireRole } = require('../middleware');
const { ensureConversation } = require('./messaging');
const { buildFilters } = require('./superadmin');

const getStatusUi = caseLifecycle.getStatusUi || caseLifecycle;
const toCanonStatus = caseLifecycle.toCanonStatus;
const dbStatusValuesFor = caseLifecycle.dbStatusValuesFor;


const router = express.Router();

// Defaults for alerts badge on admin pages.
router.use((req, res, next) => {
  res.locals.unseenAlertsCount = 0;
  res.locals.alertsUnseenCount = 0;
  res.locals.hasUnseenAlerts = false;
  return next();
});

// Unseen alerts count (admin/superadmin).
router.use(async (req, res, next) => {
  try {
    const user = req.user;
    if (!user) return next();
    const role = String(user.role || '');
    if (role !== 'admin' && role !== 'superadmin') return next();
    const count = await countAdminUnseenNotifications(user.id, user.email || '');
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

async function getAdminDashboardStats() {
  const totalDoctors = (await queryOne("SELECT COUNT(1) AS c FROM users WHERE role = 'doctor'"))?.c || 0;
  const activeDoctors = (await queryOne(
    "SELECT COUNT(1) AS c FROM users WHERE role = 'doctor' AND COALESCE(is_active, false) = true"
  ))?.c || 0;

  const openOrders = (await queryOne(
    "SELECT COUNT(1) AS c FROM orders WHERE LOWER(COALESCE(status, '')) != 'completed'"
  ))?.c || 0;
  const newOrders = (await queryOne(
    "SELECT COUNT(1) AS c FROM orders WHERE LOWER(COALESCE(status, '')) = 'new'"
  ))?.c || 0;
  const acceptedOrders = (await queryOne(
    "SELECT COUNT(1) AS c FROM orders WHERE LOWER(COALESCE(status, '')) = 'accepted'"
  ))?.c || 0;
  const inReviewOrders = (await queryOne(
    "SELECT COUNT(1) AS c FROM orders WHERE LOWER(COALESCE(status, '')) = 'in_review'"
  ))?.c || 0;
  const completedOrders = (await queryOne(
    "SELECT COUNT(1) AS c FROM orders WHERE LOWER(COALESCE(status, '')) = 'completed'"
  ))?.c || 0;

  // Be tolerant to different naming conventions
  const breachedOrders = (await queryOne(
    "SELECT COUNT(1) AS c FROM orders WHERE LOWER(COALESCE(status, '')) IN ('breached', 'breached_sla', 'delayed') OR LOWER(COALESCE(status, '')) LIKE '%breach%'"
  ))?.c || 0;

  return {
    totalDoctors,
    activeDoctors,
    openOrders,
    newOrders,
    acceptedOrders,
    inReviewOrders,
    completedOrders,
    breachedOrders
  };
}

async function getRecentActivity(limit = 15) {
  const rows = await queryAll(
    `SELECT order_id, label, at, meta
     FROM order_events
     ORDER BY at DESC
     LIMIT $1`,
    [Number(limit) || 15]
  );

  return (rows || []).map((r) => {
    const meta = safeParseJson(r.meta) || {};
    return {
      order_id: r.order_id,
      label: r.label,
      at: r.at,
      meta
    };
  });
}


const requireAdmin = requireRole('admin', 'superadmin');

function safeParseJson(value) {
  try {
    if (!value) return null;
    if (typeof value === 'object') return value;
    return JSON.parse(String(value));
  } catch (_) {
    return null;
  }
}

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

// ---- Admin alerts (in-app notifications) ----

async function getNotificationTableColumns() {
  try {
    const cols = await queryAll(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'notifications'"
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

async function fetchAdminNotifications(userId, userEmail = '', limit = 50) {
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

  const sql = `SELECT ${selectCols.join(', ')} FROM notifications WHERE (${where.join(' OR ')}) ORDER BY ${tsCol} DESC LIMIT $${paramIdx}`;
  try {
    return await queryAll(sql, [...params, Number(limit)]);
  } catch (_) {
    return [];
  }
}

async function countAdminUnseenNotifications(userId, userEmail = '') {
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

function normalizeAdminNotification(row) {
  const id = row && row.id != null ? String(row.id) : '';
  const orderId = row && row.order_id != null ? String(row.order_id) : '';
  const template = row && row.template != null ? String(row.template) : '';
  const rawStatus = row && row.status != null ? String(row.status) : '';
  const isReadVal = row && row.is_read != null ? (row.is_read === true ? 1 : row.is_read === false ? 0 : Number(row.is_read)) : null;

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
    href: orderId ? `/admin/orders/${orderId}` : ''
  };
}

async function markAllAdminNotificationsRead(userId, userEmail = '') {
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

router.get('/admin/alerts', requireAdmin, async (req, res) => {
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';
  const userId = req.user && req.user.id ? String(req.user.id) : '';
  const userEmail = req.user && req.user.email ? String(req.user.email).trim() : '';

  const raw = await fetchAdminNotifications(userId, userEmail, 50);
  const alerts = (raw || []).map(normalizeAdminNotification);

  try {
    if (userId) {
      await markAllAdminNotificationsRead(userId, userEmail);
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

  return res.render('admin_alerts', {
    brand: 'Tashkheesa',
    user: req.user,
    lang,
    dir: isAr ? 'rtl' : 'ltr',
    isAr,
    activeTab: 'alerts',
    nextPath: '/admin/alerts',
    alerts: Array.isArray(alerts) ? alerts : [],
    notifications: Array.isArray(alerts) ? alerts : [],
    portalFrame: true,
    portalRole: req.user && req.user.role === 'superadmin' ? 'superadmin' : 'admin',
    portalActive: 'alerts'
  });
});

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

function lowerUniqStrings(list) {
  return uniqStrings((list || []).map((v) => String(v).toLowerCase()));
}

function statusDbValues(canon, fallback = []) {
  let vals = [];
  try {
    if (typeof dbStatusValuesFor === 'function') {
      const v = dbStatusValuesFor(canon);
      if (Array.isArray(v) && v.length) vals = v;
    }
  } catch (_) {}

  // Always include fallback values as a safety net (DBs may store legacy/alternate strings).
  return uniqStrings([...(vals || []), ...(fallback || [])]);
}

function sqlIn(field, values, startIdx = 1) {
  const vals = (values || []).filter((v) => v != null && String(v).length);
  if (!vals.length) return { clause: '1=0', params: [], nextIdx: startIdx };
  const ph = vals.map((_, i) => `$${startIdx + i}`).join(',');
  return { clause: `${field} IN (${ph})`, params: vals, nextIdx: startIdx + vals.length };
}

function sqlNotIn(field, values, startIdx = 1) {
  const vals = (values || []).filter((v) => v != null && String(v).length);
  if (!vals.length) return { clause: '1=1', params: [], nextIdx: startIdx };
  const ph = vals.map((_, i) => `$${startIdx + i}`).join(',');
  return { clause: `${field} NOT IN (${ph})`, params: vals, nextIdx: startIdx + vals.length };
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

async function getLatestAdditionalFilesRequestEvent(orderId) {
  return await safeGet(
    `SELECT id, label, meta, at, actor_user_id, actor_role
     FROM order_events
     WHERE order_id = $1
       AND (
         (LOWER(label) ILIKE '%request%' AND (LOWER(label) ILIKE '%file%' OR LOWER(label) ILIKE '%upload%' OR LOWER(label) ILIKE '%re-upload%' OR LOWER(label) ILIKE '%reupload%'))
         OR LOWER(label) ILIKE '%reject file%'
         OR LOWER(label) ILIKE '%reupload%'
       )
     ORDER BY at DESC
     LIMIT 1`,
    [orderId],
    null
  );
}

async function getLatestAdditionalFilesDecisionEvent(orderId) {
  return await safeGet(
    `SELECT id, label, meta, at, actor_user_id, actor_role
     FROM order_events
     WHERE order_id = $1
       AND (
         LOWER(label) ILIKE '%additional files request approved%'
         OR LOWER(label) ILIKE '%additional files request rejected%'
         OR LOWER(label) ILIKE '%additional files request denied%'
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

async function getPendingAdditionalFilesRequests(limit = 25) {
  // Admin support inbox: show ALL additional-files requests so they are easy to spot,
  // and keep them visible after approve/decline (pill changes by stage).
  // Stage logic:
  // - awaiting_approval: request exists and no later decision
  // - approved: latest decision after request is approved
  // - declined: latest decision after request is rejected/denied/declined

  const rows = await queryAll(
    `WITH last_req AS (
        SELECT e1.order_id, MAX(e1.at) AS req_at
        FROM order_events e1
        WHERE (
          LOWER(e1.label) IN ('doctor_requested_additional_files', 'doctor_request_additional_files')
          OR LOWER(e1.label) LIKE '%doctor requested additional files%'
        )
        GROUP BY e1.order_id
     ), req AS (
        SELECT e.order_id, e.id AS request_event_id, e.at AS requested_at, e.meta AS request_meta
        FROM order_events e
        JOIN last_req lr
          ON lr.order_id = e.order_id AND e.at = lr.req_at
     ), last_dec AS (
        SELECT d1.order_id, MAX(d1.at) AS dec_at
        FROM order_events d1
        WHERE (
          LOWER(d1.label) LIKE '%additional files request approved%'
          OR LOWER(d1.label) LIKE '%additional files request rejected%'
          OR LOWER(d1.label) LIKE '%additional files request denied%'
          OR LOWER(d1.label) LIKE '%additional files request declined%'
        )
        GROUP BY d1.order_id
     ), dec AS (
        SELECT d.order_id, d.id AS decision_event_id, d.at AS decided_at, d.label AS decision_label, d.meta AS decision_meta
        FROM order_events d
        JOIN last_dec ld
          ON ld.order_id = d.order_id AND d.at = ld.dec_at
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
        req.request_meta,
        dec.decision_event_id,
        dec.decided_at,
        dec.decision_label,
        dec.decision_meta
     FROM orders o
     JOIN req ON req.order_id = o.id
     LEFT JOIN dec ON dec.order_id = o.id
     LEFT JOIN specialties s ON s.id = o.specialty_id
     LEFT JOIN users doc ON doc.id = o.doctor_id
     LEFT JOIN users pat ON pat.id = o.patient_id
     WHERE LOWER(COALESCE(o.status, '')) NOT IN ('completed','cancelled')
     ORDER BY req.requested_at DESC
     LIMIT $1`,
    [Number(limit) || 25]
  );

  return (rows || []).map((r) => {
    const reqMeta = safeParseJson(r.request_meta) || {};
    const decMeta = safeParseJson(r.decision_meta) || {};

    const reqAt = r.requested_at ? new Date(r.requested_at).getTime() : 0;
    const decAt = r.decided_at ? new Date(r.decided_at).getTime() : 0;

    let stage = 'awaiting_approval';
    if (r.decision_label && decAt >= reqAt) {
      const dl = String(r.decision_label || '').toLowerCase();
      if (dl.includes('approved')) stage = 'approved';
      else stage = 'declined';
    }

    const pill =
      stage === 'approved'
        ? { text: 'APPROVED', className: 'pill pill--success' }
        : stage === 'declined'
          ? { text: 'DECLINED', className: 'pill pill--danger' }
          : { text: 'AWAITING APPROVAL', className: 'pill pill--warning' };

    const reason = (reqMeta && typeof reqMeta === 'object' && reqMeta.reason)
      ? String(reqMeta.reason)
      : '';

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
      request_event_id: r.request_event_id,
      requested_at: r.requested_at,
      decision_event_id: r.decision_event_id || null,
      decided_at: r.decided_at || null,
      decision_label: r.decision_label || null,
      stage,
      pill,
      reason,
      meta: reqMeta,
      decision_meta: decMeta
    };
  });
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
    FROM orders o
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

async function renderAdminProfile(req, res) {
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';
  const u = req.user || {};

  const title = t(lang, 'My profile', 'ملفي الشخصي');
  const dashboardLabel = t(lang, 'Dashboard', 'لوحة التحكم');
  const ordersLabel = t(lang, 'Orders', 'الطلبات');
  const doctorsLabel = t(lang, 'Doctors', 'الأطباء');
  const servicesLabel = t(lang, 'Services', 'الخدمات');
  const logoutLabel = t(lang, 'Logout', 'تسجيل الخروج');

  const name = escapeHtml(u.name || '—');
  const email = escapeHtml(u.email || '—');
  const role = escapeHtml(u.role || 'admin');

  const specialty = await (async () => {
    try {
      if (!u.specialty_id) return '—';
      const row = await queryOne('SELECT name FROM specialties WHERE id = $1', [u.specialty_id]);
      return escapeHtml((row && row.name) || '—');
    } catch (_) {
      return '—';
    }
  })();

  const profileDisplayRaw = u.name || u.full_name || u.fullName || u.email || '';
  const profileDisplay = profileDisplayRaw ? escapeHtml(profileDisplayRaw) : '';
  const profileLabel = profileDisplay || escapeHtml(title);
  const csrfFieldHtml = (res.locals && typeof res.locals.csrfField === 'function') ? res.locals.csrfField() : '';
  const nextPath = (req && req.originalUrl && String(req.originalUrl).startsWith('/')) ? String(req.originalUrl) : '/admin/profile';

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
        <a class="btn btn--ghost" href="/admin">${escapeHtml(dashboardLabel)}</a>
        <a class="btn btn--ghost" href="/admin/orders">${escapeHtml(ordersLabel)}</a>
        <a class="btn btn--ghost" href="/admin/doctors">${escapeHtml(doctorsLabel)}</a>
        <a class="btn btn--ghost" href="/admin/services">${escapeHtml(servicesLabel)}</a>
        <span class="btn btn--primary" aria-current="page">${escapeHtml(title)}</span>
      </div>
      <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
        <details class="user-menu">
          <summary class="pill user-menu-trigger" title="${escapeHtml(title)}">👤 ${profileLabel}</summary>
          <div class="user-menu-panel" role="menu" aria-label="${escapeHtml(title)}">
            <a class="user-menu-item" role="menuitem" href="/admin/profile">${escapeHtml(title)}</a>
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




// First services route removed — consolidated into single route below (line ~1432)


// Redirect entry
router.get('/admin', requireAdmin, async (req, res) => {
  recalcSlaBreaches();

  const query = req.query || {};
  const from = query.from || '';
  const to = query.to || '';
  const specialty = query.specialty || 'all';
  const langCode = (req.user && req.user.lang) ? req.user.lang : 'en';

  const completedValsOverdue = statusDbValues('COMPLETED', ['completed']);
  const breachedValsOverdue = statusDbValues('BREACHED_SLA', ['breached', 'breached_sla']);
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
       AND deadline_at < NOW()`,
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

  const { totalOrders, completedCount, breachedCount } = await getOrderKpis(whereSql, params);

  // Phase 2: Additional KPIs for polished dashboard
  const totalUsersRow = await safeGet('SELECT COUNT(*) AS c FROM users', [], { c: 0 });
  const totalUsers = (totalUsersRow && totalUsersRow.c) || 0;

  const totalPatientsRow = await safeGet("SELECT COUNT(*) AS c FROM users WHERE role = 'patient'", [], { c: 0 });
  const totalPatients = (totalPatientsRow && totalPatientsRow.c) || 0;

  const activeDoctorsRow = await safeGet(
    "SELECT COUNT(*) AS c FROM users WHERE role = 'doctor' AND COALESCE(is_active, false) = true",
    [], { c: 0 }
  );
  const activeDoctorsCount = (activeDoctorsRow && activeDoctorsRow.c) || 0;

  const revenueRow = await safeGet(
    "SELECT COALESCE(SUM(COALESCE(total_price_with_addons, price, 0)), 0) AS total FROM orders WHERE LOWER(COALESCE(payment_status, '')) = 'paid'",
    [], { total: 0 }
  );
  const totalRevenue = (revenueRow && revenueRow.total) || 0;

  // Month-over-month comparison
  const now = new Date();
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();

  const thisMonthOrders = await safeGet(
    "SELECT COUNT(*) AS c FROM orders WHERE created_at >= $1", [thisMonthStart], { c: 0 }
  );
  const lastMonthOrders = await safeGet(
    "SELECT COUNT(*) AS c FROM orders WHERE created_at >= $1 AND created_at < $2",
    [lastMonthStart, thisMonthStart], { c: 0 }
  );
  const thisMonthRevenue = await safeGet(
    "SELECT COALESCE(SUM(COALESCE(total_price_with_addons, price, 0)), 0) AS total FROM orders WHERE LOWER(COALESCE(payment_status, '')) = 'paid' AND created_at >= $1",
    [thisMonthStart], { total: 0 }
  );
  const lastMonthRevenue = await safeGet(
    "SELECT COALESCE(SUM(COALESCE(total_price_with_addons, price, 0)), 0) AS total FROM orders WHERE LOWER(COALESCE(payment_status, '')) = 'paid' AND created_at >= $1 AND created_at < $2",
    [lastMonthStart, thisMonthStart], { total: 0 }
  );
  const thisMonthUsers = await safeGet(
    "SELECT COUNT(*) AS c FROM users WHERE created_at >= $1", [thisMonthStart], { c: 0 }
  );
  const lastMonthUsers = await safeGet(
    "SELECT COUNT(*) AS c FROM users WHERE created_at >= $1 AND created_at < $2",
    [lastMonthStart, thisMonthStart], { c: 0 }
  );

  function calcChange(current, previous) {
    const cur = Number(current) || 0;
    const prev = Number(previous) || 0;
    if (prev === 0) return cur > 0 ? 100 : 0;
    return Math.round(((cur - prev) / prev) * 100);
  }

  const monthComparison = {
    ordersChange: calcChange(thisMonthOrders?.c, lastMonthOrders?.c),
    revenueChange: calcChange(thisMonthRevenue?.total, lastMonthRevenue?.total),
    usersChange: calcChange(thisMonthUsers?.c, lastMonthUsers?.c)
  };

  // Pending orders count (not completed, not breached)
  const pendingOrdersRow = await safeGet(
    "SELECT COUNT(*) AS c FROM orders WHERE LOWER(COALESCE(status, '')) IN ('new', 'accepted', 'in_review')",
    [], { c: 0 }
  );
  const pendingOrders = (pendingOrdersRow && pendingOrdersRow.c) || 0;

  const completedVals2 = lowerUniqStrings(statusDbValues('COMPLETED', ['completed']));
  const completedIn2 = sqlIn('LOWER(o.status)', completedVals2, params.length + 1);

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

  for (const o of completedRows) {
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
  }

  const onTimePercent =
    completedRows.length > 0
      ? Math.round((onTimeCount * 100) / completedRows.length)
      : 0;

  const avgTatMinutes =
    tatCount > 0 ? Math.round(tatSumMinutes / tatCount) : null;

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

  const ordersListRaw = await safeAll(
    `SELECT o.id, o.created_at, o.status, o.reassigned_count, o.deadline_at, o.completed_at,
            o.payment_status, COALESCE(o.total_price_with_addons, o.price) AS amount,
            sv.name AS service_name, s.name AS specialty_name,
            up.name AS patient_name, ud.name AS doctor_name
     FROM orders o
     LEFT JOIN services sv ON sv.id = o.service_id
     LEFT JOIN specialties s ON s.id = o.specialty_id
     LEFT JOIN users up ON up.id = o.patient_id
     LEFT JOIN users ud ON ud.id = o.doctor_id
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

    return {
      ...o,
      status: effective,
      effectiveStatus: computed.effectiveStatus,
      sla: computed.sla,
      statusUi: safeGetStatusUi(effective, langCode)
    };
  });

  const slaRiskOrdersRaw = await safeAll(
    `SELECT o.id, o.deadline_at, s.name AS specialty_name, u.name AS doctor_name,
            (EXTRACT(EPOCH FROM (o.deadline_at - NOW())) / 3600) AS hours_remaining
     FROM orders o
     LEFT JOIN specialties s ON s.id = o.specialty_id
     LEFT JOIN users u ON u.id = o.doctor_id
     WHERE o.deadline_at IS NOT NULL
       AND o.completed_at IS NULL
       AND (EXTRACT(EPOCH FROM (o.deadline_at - NOW())) / 3600) <= 24
       AND (EXTRACT(EPOCH FROM (o.deadline_at - NOW())) / 3600) >= 0
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

  const breachedVals3 = lowerUniqStrings(
    uniqStrings([
      ...statusDbValues('BREACHED_SLA', ['breached', 'breached_sla']),
      ...statusDbValues('DELAYED', ['delayed'])
    ])
  );
  const breachedIn3 = sqlIn('LOWER(o.status)', breachedVals3);

  const breachedOrders = await safeAll(
    `SELECT o.id, o.breached_at, o.specialty_id, s.name AS specialty_name, u.name AS doctor_name
     FROM orders o
     LEFT JOIN specialties s ON s.id = o.specialty_id
     LEFT JOIN users u ON u.id = o.doctor_id
     WHERE ${breachedIn3.clause}
        OR (o.completed_at IS NOT NULL
            AND o.deadline_at IS NOT NULL
            AND o.completed_at > o.deadline_at)
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

  // Phase 5: Notification summary stats
  const notifStats = (await tableExists('notifications'))
    ? await safeGet(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN LOWER(COALESCE(status, '')) IN ('sent', 'delivered') THEN 1 ELSE 0 END) AS sent,
          SUM(CASE WHEN LOWER(COALESCE(status, '')) IN ('failed', 'error') THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN LOWER(COALESCE(status, '')) IN ('queued', 'pending') THEN 1 ELSE 0 END) AS queued
         FROM notifications`,
        [],
        { total: 0, sent: 0, failed: 0, queued: 0 }
      )
    : { total: 0, sent: 0, failed: 0, queued: 0 };

  const slaEvents = (await tableExists('order_events'))
    ? await safeAll(
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

  const specialties = await safeAll(
    'SELECT id, name FROM specialties ORDER BY name ASC',
    [],
    []
  );

  const pendingFileRequests = await getPendingAdditionalFilesRequests(25);
  const pendingFileRequestsCount = (pendingFileRequests && pendingFileRequests.length) ? pendingFileRequests.length : 0;
  const pendingFileRequestsAwaitingCount = (pendingFileRequests || []).filter(r => r && r.stage === 'awaiting_approval').length;

  // Feature 3.1: Pending Doctor Approvals
  const pendingDoctors = await safeAll(`
    SELECT u.id, u.name, u.email, u.created_at,
      s.name as specialties
    FROM users u
    LEFT JOIN specialties s ON s.id = u.specialty_id
    WHERE u.role = 'doctor' AND (u.pending_approval = true OR u.status = 'pending')
    ORDER BY u.created_at DESC
  `, [], []);

  // Feature 3.2: Pending Refund Requests
  const pendingRefunds = await safeAll(`
    SELECT ap.*, a.scheduled_at,
      p.name as patient_name, d.name as doctor_name
    FROM appointment_payments ap
    JOIN appointments a ON ap.appointment_id = a.id
    LEFT JOIN users p ON a.patient_id = p.id
    LEFT JOIN users d ON a.doctor_id = d.id
    WHERE ap.refund_status = 'requested'
    ORDER BY ap.created_at DESC
  `, [], []);

  // Feature 3.3: System Health Indicators
  const lastEmailSent = await safeGet("SELECT MAX(at) as last FROM notification_log WHERE channel = 'email' AND status = 'sent'", [], { last: null });
  const lastWhatsAppSent = await safeGet("SELECT MAX(at) as last FROM notification_log WHERE channel = 'whatsapp' AND status = 'sent'", [], { last: null });
  const errorsLast24h = await safeGet("SELECT COUNT(*) as cnt FROM error_logs WHERE created_at > NOW() - INTERVAL '1 day'", [], { cnt: 0 });

  // Feature 3.5: Financial Summary
  const monthRevenue = await safeGet("SELECT COALESCE(SUM(COALESCE(total_price_with_addons, price, 0)), 0) as total FROM orders WHERE LOWER(COALESCE(payment_status, '')) = 'paid' AND created_at > date_trunc('month', NOW())", [], { total: 0 });
  const pendingPayouts = await safeGet("SELECT COALESCE(SUM(earned_amount), 0) as total FROM doctor_earnings WHERE status = 'pending'", [], { total: 0 });
  const refundsThisMonth = await safeGet("SELECT COALESCE(SUM(amount), 0) as total FROM appointment_payments WHERE refund_status = 'refunded' AND created_at > date_trunc('month', NOW())", [], { total: 0 });

  // Feature 1.4: Open chat reports count
  const openChatReports = await safeGet("SELECT COUNT(*) as cnt FROM chat_reports WHERE status = 'open'", [], { cnt: 0 });

  // Doctor no-shows (today + this week)
  const doctorNoShowsToday = (await tableExists('appointments'))
    ? await safeGet("SELECT COUNT(*) as cnt FROM appointments WHERE status = 'no_show' AND DATE(scheduled_at) = CURRENT_DATE", [], { cnt: 0 })
    : { cnt: 0 };
  const doctorNoShowsWeek = (await tableExists('appointments'))
    ? await safeGet("SELECT COUNT(*) as cnt FROM appointments WHERE status = 'no_show' AND scheduled_at > NOW() - INTERVAL '7 days'", [], { cnt: 0 })
    : { cnt: 0 };

  // Add-ons purchased count (this month)
  const addOnsPurchased = (await tableExists('order_addons'))
    ? await safeGet("SELECT COUNT(*) as cnt FROM order_addons WHERE created_at > date_trunc('month', NOW())", [], { cnt: 0 })
    : { cnt: 0 };

  // Unresolved video slots — pending_doctor or reschedule_proposed, last updated >0h ago
  let unresolvedVideoSlots = [];
  try {
    if (await tableExists('appointments')) {
      unresolvedVideoSlots = await queryAll(
        `SELECT a.id, a.order_id, a.status, a.updated_at AS slot_updated_at, a.created_at,
                u_doc.name AS doctor_name
         FROM appointments a
         LEFT JOIN users u_doc ON u_doc.id = a.doctor_id
         WHERE a.status IN ('pending_doctor','reschedule_proposed')
         ORDER BY a.updated_at ASC
         LIMIT 50`,
        []
      );
    }
  } catch (_) {}

  res.render('admin', {
    user: req.user,
    totalOrders,
    completedCount,
    breachedCount,
    onTimePercent,
    avgTatMinutes,
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
    },
    hideFinancials: false,
    // Phase 2: additional KPIs
    totalUsers,
    totalPatients,
    activeDoctorsCount,
    totalRevenue,
    monthComparison,
    pendingOrders,
    lang: langCode,
    notifStats: notifStats || { total: 0, sent: 0, failed: 0, queued: 0 },
    // Dashboard widgets
    pendingDoctors: pendingDoctors || [],
    pendingRefunds: pendingRefunds || [],
    systemHealth: {
      lastEmailSent: lastEmailSent ? lastEmailSent.last : null,
      lastWhatsAppSent: lastWhatsAppSent ? lastWhatsAppSent.last : null,
      errorsLast24h: errorsLast24h ? errorsLast24h.cnt : 0
    },
    financials: {
      monthRevenue: monthRevenue ? monthRevenue.total : 0,
      pendingPayouts: pendingPayouts ? pendingPayouts.total : 0,
      refundsThisMonth: refundsThisMonth ? refundsThisMonth.total : 0
    },
    openChatReports: openChatReports ? openChatReports.cnt : 0,
    doctorNoShowsToday: doctorNoShowsToday ? doctorNoShowsToday.cnt : 0,
    doctorNoShowsWeek: doctorNoShowsWeek ? doctorNoShowsWeek.cnt : 0,
    addOnsPurchased: addOnsPurchased ? addOnsPurchased.cnt : 0,
    unresolvedVideoSlots,
    pendingRefundsCount: pendingRefunds ? pendingRefunds.length : 0,
    portalFrame: true,
    portalRole: req.user && req.user.role === 'superadmin' ? 'superadmin' : 'admin',
    portalActive: 'dashboard'
  });
});

// ORDERS (admin)
router.get('/admin/orders', requireAdmin, async (req, res) => {
  const query = req.query || {};
  const from = query.from || '';
  const to = query.to || '';
  const specialty = query.specialty || 'all';
  const statusFilter = query.status || 'all';
  const langCode = (req.user && req.user.lang) ? req.user.lang : 'en';

  const { whereSql, params } = buildFilters(query);

  // Add status filter if specified
  let finalWhere = whereSql;
  const finalParams = [...params];
  if (statusFilter && statusFilter !== 'all') {
    const statusVals = lowerUniqStrings(statusDbValues(statusFilter.toUpperCase(), [statusFilter.toLowerCase()]));
    if (statusVals.length) {
      const statusIn = sqlIn('LOWER(o.status)', statusVals, finalParams.length + 1);
      if (finalWhere) {
        finalWhere = finalWhere + ' AND ' + statusIn.clause;
      } else {
        finalWhere = 'WHERE ' + statusIn.clause;
      }
      finalParams.push(...statusIn.params);
    }
  }

  const { totalOrders, completedCount, breachedCount } = await getOrderKpis(finalWhere, finalParams);

  const ordersRaw = await safeAll(
    `SELECT o.id, o.created_at, o.status, o.reassigned_count, o.deadline_at, o.completed_at,
            o.payment_status, o.price,
            p.name AS patient_name, d.name AS doctor_name,
            sv.name AS service_name, s.name AS specialty_name
     FROM orders o
     LEFT JOIN users p ON p.id = o.patient_id
     LEFT JOIN users d ON d.id = o.doctor_id
     LEFT JOIN services sv ON sv.id = o.service_id
     LEFT JOIN specialties s ON s.id = o.specialty_id
     ${finalWhere}
     ORDER BY o.created_at DESC`,
    finalParams,
    []
  );

  const orders = (ordersRaw || []).map((o) => {
    enforceBreachIfNeeded(o);
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

  const specialties = await safeAll(
    'SELECT id, name FROM specialties ORDER BY name ASC',
    [],
    []
  );

  res.render('admin_orders', {
    user: req.user,
    lang: langCode,
    orders,
    events: eventsNormalized || [],
    totalOrders,
    completedCount,
    breachedCount,
    specialties: specialties || [],
    filters: {
      from,
      to,
      specialty,
      status: statusFilter
    },
    hideFinancials: false,
    portalFrame: true,
    portalRole: req.user && req.user.role === 'superadmin' ? 'superadmin' : 'admin',
    portalActive: 'orders'
  });
});

router.get('/admin/orders/:id', requireAdmin, async (req, res) => {
  const orderId = req.params.id;
  const order = await queryOne(
    `SELECT o.*,
            p.name AS patient_name, p.email AS patient_email,
            d.name AS doctor_name, d.email AS doctor_email,
            s.name AS specialty_name,
            sv.name AS service_name
     FROM orders o
     LEFT JOIN users p ON p.id = o.patient_id
     LEFT JOIN users d ON d.id = o.doctor_id
     LEFT JOIN specialties s ON s.id = o.specialty_id
     LEFT JOIN services sv ON sv.id = o.service_id
     WHERE o.id = $1`,
    [orderId]
  );

  if (!order) {
    return res.redirect('/admin');
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

  const additionalFilesRequest = await computeAdditionalFilesRequestState(orderId);

  const langCode = (req.user && req.user.lang) ? req.user.lang : 'en';
  return res.render('admin_order_detail', {
    user: req.user,
    lang: langCode,
    order,
    events,
    doctors,
    additionalFilesRequest,
    hideFinancials: false,
    portalFrame: true,
    portalRole: req.user && req.user.role === 'superadmin' ? 'superadmin' : 'admin',
    portalActive: 'orders'
  });
});

router.post('/admin/orders/:id/additional-files/approve', requireAdmin, async (req, res) => {
  const orderId = req.params.id;
  const { request_event_id, support_note } = req.body || {};

  const order = await queryOne('SELECT id, patient_id, status FROM orders WHERE id = $1', [orderId]);
  if (!order) return res.redirect('/admin');

  const nowIso = new Date().toISOString();

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
      'Additional files request approved (admin)',
      JSON.stringify({ request_event_id: request_event_id || null, support_note: support_note || null }),
      nowIso,
      req.user.id,
      req.user.role
    ]
  );

  if (order.patient_id) {
    queueNotification({
      orderId,
      toUserId: order.patient_id,
      channel: 'internal',
      template: 'additional_files_requested_patient',
      status: 'queued'
    });
  }

  return res.redirect(`/admin/orders/${orderId}?additional_files=approved`);
});

router.post('/admin/orders/:id/additional-files/reject', requireAdmin, async (req, res) => {
  const orderId = req.params.id;
  const { request_event_id, support_note } = req.body || {};

  const order = await queryOne('SELECT id, patient_id FROM orders WHERE id = $1', [orderId]);
  if (!order) return res.redirect('/admin');

  const nowIso = new Date().toISOString();

  await execute(
    `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      randomUUID(),
      orderId,
      'Additional files request rejected (admin)',
      JSON.stringify({ request_event_id: request_event_id || null, support_note: support_note || null }),
      nowIso,
      req.user.id,
      req.user.role
    ]
  );

  return res.redirect(`/admin/orders/${orderId}?additional_files=rejected`);
});

// Mark order as paid manually (admin)
router.post('/admin/orders/:id/mark-paid', requireAdmin, async (req, res) => {
  const orderId = req.params.id;
  const { payment_method, payment_reference } = req.body || {};

  const order = await queryOne('SELECT id, payment_status FROM orders WHERE id = $1', [orderId]);
  if (!order) return res.redirect('/admin');

  const nowIso = new Date().toISOString();
  await execute(
    `UPDATE orders
     SET payment_status = 'paid',
         payment_method = COALESCE($1, payment_method, 'manual'),
         payment_reference = COALESCE($2, payment_reference),
         updated_at = $3
     WHERE id = $4`,
    [payment_method || 'manual', payment_reference || null, nowIso, orderId]
  );

  logOrderEvent({
    orderId,
    label: 'payment_marked_paid_by_admin',
    meta: JSON.stringify({ payment_method: payment_method || 'manual', payment_reference: payment_reference || null }),
    actorUserId: req.user.id,
    actorRole: req.user.role
  });

  return res.redirect(`/admin/orders/${orderId}?payment=marked_paid`);
});

router.post('/admin/orders/:id/reassign', requireAdmin, async (req, res) => {
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
    return res.redirect(`/admin/orders/${orderId}`);
  }

  const newDoctor = await queryOne(
    "SELECT id, name FROM users WHERE id = $1 AND role = 'doctor' AND is_active = true",
    [newDoctorId]
  );
  if (!newDoctor) {
    return res.redirect(`/admin/orders/${orderId}`);
  }

  if (order.doctor_id === newDoctor.id) {
    return res.redirect(`/admin/orders/${orderId}`);
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
    label: `Order reassigned from ${order.doctor_name || order.doctor_id || 'Unassigned'} to ${newDoctor.name} by admin`,
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
  try {
    if (order.patient_id) {
      ensureConversation(orderId, order.patient_id, newDoctor.id);
    }
  } catch (_) {}

  return res.redirect(`/admin/orders/${orderId}`);
});

// DOCTORS
router.get('/admin/doctors', requireAdmin, async (req, res) => {
  const doctors = await queryAll(
    `SELECT u.id, u.name, u.email, u.phone, u.notify_whatsapp, u.is_active, u.specialty_id,
            u.created_at AS joined_at,
            s.name AS specialty_name,
            (SELECT COUNT(*) FROM orders WHERE doctor_id = u.id AND LOWER(COALESCE(status, '')) = 'completed') AS cases_completed,
            (SELECT COUNT(*) FROM orders WHERE doctor_id = u.id) AS total_cases,
            (SELECT COALESCE(SUM(COALESCE(total_price_with_addons, price, 0)), 0) FROM orders WHERE doctor_id = u.id AND LOWER(COALESCE(payment_status, '')) = 'paid') AS total_earnings
     FROM users u
     LEFT JOIN specialties s ON s.id = u.specialty_id
     WHERE u.role = 'doctor'
     ORDER BY u.created_at DESC, u.name ASC`
  );
  const specialties = await queryAll('SELECT id, name FROM specialties ORDER BY name ASC');
  const pendingFileRequests = await getPendingAdditionalFilesRequests(25);
  const pendingFileRequestsCount = (pendingFileRequests && pendingFileRequests.length) ? pendingFileRequests.length : 0;
  const pendingFileRequestsAwaitingCount = (pendingFileRequests || []).filter(r => r && r.stage === 'awaiting_approval').length;

  const stats = await getAdminDashboardStats();
  const recentActivity = await getRecentActivity(15);

  res.render('admin_doctors', {
    user: req.user,
    doctors,
    specialties,
    pendingFileRequests,
    pendingFileRequestsCount,
    pendingFileRequestsAwaitingCount,
    stats,
    recentActivity,
    hideFinancials: true,
    portalFrame: true,
    portalRole: req.user && req.user.role === 'superadmin' ? 'superadmin' : 'admin',
    portalActive: 'doctors'
  });
});

router.get('/admin/doctors/new', requireAdmin, async (req, res) => {
  const specialties = await queryAll('SELECT id, name FROM specialties ORDER BY name ASC');
  res.render('admin_doctor_form', { user: req.user, specialties, doctor: null, isEdit: false, error: null, hideFinancials: true, portalFrame: true, portalRole: req.user && req.user.role === 'superadmin' ? 'superadmin' : 'admin', portalActive: 'doctors' });
});

router.post('/admin/doctors/new', requireAdmin, async (req, res) => {
  const { name, email, specialty_id, phone, notify_whatsapp, is_active } = req.body || {};
  if (!name || !email) {
    const specialties = await queryAll('SELECT id, name FROM specialties ORDER BY name ASC');
    return res.status(400).render('admin_doctor_form', {
      user: req.user,
      specialties,
      doctor: { name, email, specialty_id, phone, notify_whatsapp, is_active },
      isEdit: false,
      error: 'Name and email are required.',
      hideFinancials: true,
      portalFrame: true, portalRole: req.user && req.user.role === 'superadmin' ? 'superadmin' : 'admin', portalActive: 'doctors'
    });
  }
  await execute(
    `INSERT INTO users (id, email, password_hash, name, role, specialty_id, phone, lang, notify_whatsapp, is_active)
     VALUES ($1, $2, $3, $4, 'doctor', $5, $6, 'en', $7, $8)`,
    [
      randomUUID(),
      email,
      '',
      name,
      specialty_id || null,
      phone || null,
      notify_whatsapp ? true : false,
      is_active ? true : false
    ]
  );
  return res.redirect('/admin/doctors');
});

router.get('/admin/doctors/:id/edit', requireAdmin, async (req, res) => {
  const doctor = await queryOne(
    "SELECT * FROM users WHERE id = $1 AND role = 'doctor'",
    [req.params.id]
  );
  if (!doctor) return res.redirect('/admin/doctors');
  const specialties = await queryAll('SELECT id, name FROM specialties ORDER BY name ASC');
  res.render('admin_doctor_form', { user: req.user, specialties, doctor, isEdit: true, error: null, hideFinancials: true, portalFrame: true, portalRole: req.user && req.user.role === 'superadmin' ? 'superadmin' : 'admin', portalActive: 'doctors' });
});

router.post('/admin/doctors/:id/edit', requireAdmin, async (req, res) => {
  const doctor = await queryOne(
    "SELECT * FROM users WHERE id = $1 AND role = 'doctor'",
    [req.params.id]
  );
  if (!doctor) return res.redirect('/admin/doctors');
  const { name, email, specialty_id, phone, notify_whatsapp, is_active } = req.body || {};
  await execute(
    `UPDATE users
     SET name = $1, email = $2, specialty_id = $3, phone = $4, notify_whatsapp = $5, is_active = $6
     WHERE id = $7 AND role = 'doctor'`,
    [
      name || doctor.name,
      email || doctor.email,
      specialty_id || null,
      phone || null,
      notify_whatsapp ? true : false,
      is_active ? true : false,
      req.params.id
    ]
  );
  return res.redirect('/admin/doctors');
});

router.post('/admin/doctors/:id/toggle-active', requireAdmin, async (req, res) => {
  const doctorId = req.params.id;
  await execute(
    `UPDATE users
     SET is_active = NOT COALESCE(is_active, false)
     WHERE id = $1 AND role = 'doctor'`,
    [doctorId]
  );
  return res.redirect('/admin/doctors');
});

async function getServicesTableColumns() {
  try {
    const cols = await queryAll(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'services'"
    );
    return Array.isArray(cols) ? cols.map((c) => c.column_name) : [];
  } catch (_) {
    return [];
  }
}

async function ensureServicesVisibilityColumn() {
  // Adds services.is_visible if it doesn't exist.
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

// SERVICES
router.get('/admin/services', requireAdmin, async (req, res) => {
  const selectedCountry = String(req.query.country || 'AE').toUpperCase();

  const services = await safeAll(
    `SELECT sv.id, sv.name, sv.code, sv.specialty_id, sv.base_price, sv.doctor_fee, sv.currency,
            sp.name AS specialty_name,
            COALESCE(sv.is_visible, true) AS is_visible,
            (SELECT COUNT(*) FROM orders WHERE service_id = sv.id) AS cases_count,
            (SELECT COALESCE(SUM(COALESCE(total_price_with_addons, price, 0)), 0) FROM orders WHERE service_id = sv.id AND LOWER(COALESCE(payment_status, '')) = 'paid') AS service_revenue
     FROM services sv
     LEFT JOIN specialties sp ON sp.id = sv.specialty_id
     ORDER BY sp.name ASC, sv.name ASC`,
    [],
    []
  );

  const serviceCountryPricing = await safeAll(
    `SELECT service_id, country_code, price, currency
     FROM service_country_pricing
     WHERE country_code != 'EG'
     ORDER BY service_id ASC`,
    [],
    []
  );

  res.render('admin_services', {
    user: req.user,
    services,
    serviceCountryPricing,
    selectedCountry,
    hideFinancials: false,
    portalFrame: true,
    portalRole: req.user && req.user.role === 'superadmin' ? 'superadmin' : 'admin',
    portalActive: 'services'
  });
});

router.get('/admin/services/new', requireAdmin, async (req, res) => {
  const specialties = await queryAll('SELECT id, name FROM specialties ORDER BY name ASC');
  res.render('admin_service_form', { user: req.user, specialties, service: null, isEdit: false, error: null, hideFinancials: true, portalFrame: true, portalRole: req.user && req.user.role === 'superadmin' ? 'superadmin' : 'admin', portalActive: 'services' });
});

router.post('/admin/services/new', requireAdmin, async (req, res) => {
  const { specialty_id, code, name, base_price, doctor_fee, currency, payment_link } = req.body || {};
  if (!specialty_id || !name) {
    const specialties = await queryAll('SELECT id, name FROM specialties ORDER BY name ASC');
    return res.status(400).render('admin_service_form', {
      user: req.user,
      specialties,
      service: { specialty_id, code, name, base_price, doctor_fee, currency, payment_link },
      isEdit: false,
      error: 'Specialty and name are required.',
      hideFinancials: true,
      portalFrame: true, portalRole: req.user && req.user.role === 'superadmin' ? 'superadmin' : 'admin', portalActive: 'services'
    });
  }
  await execute(
    `INSERT INTO services (id, specialty_id, code, name, base_price, doctor_fee, currency, payment_link)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      randomUUID(),
      specialty_id,
      code || null,
      name,
      base_price ? Number(base_price) : null,
      doctor_fee ? Number(doctor_fee) : null,
      currency || 'EGP',
      payment_link || null
    ]
  );
  return res.redirect('/admin/services');
});

router.get('/admin/services/:id/edit', requireAdmin, async (req, res) => {
  const service = await queryOne('SELECT * FROM services WHERE id = $1', [req.params.id]);
  if (!service) return res.redirect('/admin/services');
  const specialties = await queryAll('SELECT id, name FROM specialties ORDER BY name ASC');
  res.render('admin_service_form', { user: req.user, specialties, service, isEdit: true, error: null, hideFinancials: true, portalFrame: true, portalRole: req.user && req.user.role === 'superadmin' ? 'superadmin' : 'admin', portalActive: 'services' });
});

router.post('/admin/services/:id/edit', requireAdmin, async (req, res) => {
  const service = await queryOne('SELECT * FROM services WHERE id = $1', [req.params.id]);
  if (!service) return res.redirect('/admin/services');
  const { specialty_id, code, name, base_price, doctor_fee, currency, payment_link } = req.body || {};
  if (!specialty_id || !name) {
    const specialties = await queryAll('SELECT id, name FROM specialties ORDER BY name ASC');
    return res.status(400).render('admin_service_form', {
      user: req.user,
      specialties,
      service: { ...service, ...req.body },
      isEdit: true,
      error: 'Specialty and name are required.',
      hideFinancials: true
    });
  }
  await execute(
    `UPDATE services
     SET specialty_id = $1, code = $2, name = $3, base_price = $4, doctor_fee = $5, currency = $6, payment_link = $7
     WHERE id = $8`,
    [
      specialty_id,
      code || null,
      name,
      base_price ? Number(base_price) : null,
      doctor_fee ? Number(doctor_fee) : null,
      currency || 'EGP',
      payment_link || null,
      req.params.id
    ]
  );
  return res.redirect('/admin/services');
});

router.post('/admin/services/:id/toggle-visibility', requireAdmin, async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.redirect('/admin/services');

  const visibilityReady = await ensureServicesVisibilityColumn();
  try {
    // Flip between true and false, defaulting NULL to visible (true).
    if (visibilityReady) {
      await execute(
        `UPDATE services
         SET is_visible = NOT COALESCE(is_visible, true)
         WHERE id = $1`,
        [id]
      );
    }
  } catch (_) {
    // non-blocking; fall through to redirect
  }

  const ref = String(req.get('Referer') || req.get('Referrer') || '').trim();
  if (ref) {
    try {
      const u = new URL(ref);
      if (String(u.pathname || '').startsWith('/admin/services')) {
        return res.redirect(u.pathname + u.search + u.hash);
      }
    } catch (_) {
      if (ref.includes('/admin/services')) return res.redirect('/admin/services');
    }
  }

  return res.redirect('/admin/services');
});

// ORDERS (support)
// Admin/Superadmin can temporarily unlock uploads if patient/doctor requests it.
// Integrity rule: never unlock for completed orders.
router.post('/admin/orders/:id/uploads/unlock', requireAdmin, async (req, res) => {
  const orderId = req.params.id;
  const reasonRaw = (req.body && req.body.reason) ? String(req.body.reason) : (req.query && req.query.reason ? String(req.query.reason) : '');
  const reason = reasonRaw.trim().slice(0, 240) || 'support_request';

  const accept = String(req.get('Accept') || '');
  const xrw = String(req.get('X-Requested-With') || '');
  const fmt = String((req.query && req.query.format) || '').toLowerCase();
  const refHeader = String(req.get('Referer') || req.get('Referrer') || '').trim();
  const secFetchDest = String(req.get('Sec-Fetch-Dest') || '').toLowerCase();
  const secFetchMode = String(req.get('Sec-Fetch-Mode') || '').toLowerCase();

  const fromSuperadmin = (() => {
    if (!refHeader) return false;
    try {
      const u = new URL(refHeader);
      return String(u.pathname || '').startsWith('/superadmin/orders/');
    } catch (e) {
      return refHeader.includes('/superadmin/orders/');
    }
  })();

  const wantsJson =
    accept.includes('application/json') ||
    xrw.toLowerCase() === 'fetch' ||
    xrw.toLowerCase() === 'xmlhttprequest' ||
    fmt === 'json' ||
    fromSuperadmin ||
    secFetchDest === 'empty' ||
    secFetchMode === 'cors';

  const fail = (status, message, extra) => {
    if (wantsJson) return res.status(status).json({ ok: false, error: message, ...(extra || {}) });
    return res.status(status).send(message);
  };

  const order = await queryOne('SELECT id, status, uploads_locked FROM orders WHERE id = $1', [orderId]);
  if (!order) return fail(404, 'Not found');

  if (String(order.status || '').toLowerCase() === 'completed') {
    return fail(400, 'Cannot unlock uploads for completed orders', { orderId });
  }

  const nowIso = new Date().toISOString();
  await execute(
    `UPDATE orders
     SET uploads_locked = false,
         updated_at = $1
     WHERE id = $2`,
    [nowIso, orderId]
  );

  logOrderEvent({
    orderId,
    label: 'uploads_unlocked',
    meta: JSON.stringify({ reason }),
    actorUserId: req.user && req.user.id,
    actorRole: req.user && req.user.role
  });

  if (wantsJson) {
    return res.status(200).json({ ok: true, orderId, uploads_locked: 0, reason });
  }

  const nextRaw = (req.body && req.body.next) ? String(req.body.next) : (req.query && req.query.next ? String(req.query.next) : '');
  const next = nextRaw.trim();
  if (next && next.startsWith('/') && !next.startsWith('//')) return res.redirect(next);

  const ref = refHeader;
  if (ref) {
    try {
      const u = new URL(ref);
      return res.redirect(u.pathname + u.search + u.hash);
    } catch (e) {}
  }

  if (req.user && String(req.user.role).toLowerCase() === 'superadmin') {
    return res.redirect(`/superadmin/orders/${orderId}`);
  }
  return res.redirect('/admin');
});

router.post('/admin/orders/:id/uploads/lock', requireAdmin, async (req, res) => {
  const orderId = req.params.id;
  const reasonRaw = (req.body && req.body.reason) ? String(req.body.reason) : (req.query && req.query.reason ? String(req.query.reason) : '');
  const reason = reasonRaw.trim().slice(0, 240) || 'support_request';

  const accept = String(req.get('Accept') || '');
  const xrw = String(req.get('X-Requested-With') || '');
  const fmt = String((req.query && req.query.format) || '').toLowerCase();
  const refHeader = String(req.get('Referer') || req.get('Referrer') || '').trim();
  const secFetchDest = String(req.get('Sec-Fetch-Dest') || '').toLowerCase();
  const secFetchMode = String(req.get('Sec-Fetch-Mode') || '').toLowerCase();

  const fromSuperadmin = (() => {
    if (!refHeader) return false;
    try {
      const u = new URL(refHeader);
      return String(u.pathname || '').startsWith('/superadmin/orders/');
    } catch (e) {
      return refHeader.includes('/superadmin/orders/');
    }
  })();

  const wantsJson =
    accept.includes('application/json') ||
    xrw.toLowerCase() === 'fetch' ||
    xrw.toLowerCase() === 'xmlhttprequest' ||
    fmt === 'json' ||
    fromSuperadmin ||
    secFetchDest === 'empty' ||
    secFetchMode === 'cors';

  const fail = (status, message, extra) => {
    if (wantsJson) return res.status(status).json({ ok: false, error: message, ...(extra || {}) });
    return res.status(status).send(message);
  };

  const order = await queryOne('SELECT id, status, uploads_locked FROM orders WHERE id = $1', [orderId]);
  if (!order) return fail(404, 'Not found');

  const nowIso = new Date().toISOString();
  await execute(
    `UPDATE orders
     SET uploads_locked = true,
         updated_at = $1
     WHERE id = $2`,
    [nowIso, orderId]
  );

  logOrderEvent({
    orderId,
    label: 'uploads_locked',
    meta: JSON.stringify({ reason }),
    actorUserId: req.user && req.user.id,
    actorRole: req.user && req.user.role
  });

  if (wantsJson) {
    return res.status(200).json({ ok: true, orderId, uploads_locked: 1, reason });
  }

  const nextRaw = (req.body && req.body.next) ? String(req.body.next) : (req.query && req.query.next ? String(req.query.next) : '');
  const next = nextRaw.trim();
  if (next && next.startsWith('/') && !next.startsWith('//')) return res.redirect(next);

  const ref = refHeader;
  if (ref) {
    try {
      const u = new URL(ref);
      return res.redirect(u.pathname + u.search + u.hash);
    } catch (e) {}
  }

  if (req.user && String(req.user.role).toLowerCase() === 'superadmin') {
    return res.redirect(`/superadmin/orders/${orderId}`);
  }
  return res.redirect('/admin');
});

// ── Phase 8: Admin Notification Dashboard API ────────────────────────────

/**
 * GET /admin/notifications — Paginated notification list with filters
 */
router.get('/admin/notifications', requireAdmin, async (req, res) => {
  const lang = getLang(req, res);
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
  const offset = (page - 1) * limit;

  const channel = req.query.channel || null;
  const status = req.query.status || null;
  const template = req.query.template || null;
  const dateFrom = req.query.date_from || null;
  const dateTo = req.query.date_to || null;

  const conditions = [];
  const params = [];
  let paramIdx = 1;

  if (channel) { conditions.push(`channel = $${paramIdx++}`); params.push(channel); }
  if (status) { conditions.push(`status = $${paramIdx++}`); params.push(status); }
  if (template) { conditions.push(`template = $${paramIdx++}`); params.push(template); }
  if (dateFrom) { conditions.push(`at >= $${paramIdx++}`); params.push(dateFrom); }
  if (dateTo) { conditions.push(`at <= $${paramIdx++}`); params.push(dateTo); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const totalRow = await queryOne(`SELECT COUNT(*) AS c FROM notifications ${where}`, params);
    const total = totalRow ? totalRow.c : 0;
    const rows = await queryAll(
      `SELECT id, order_id, to_user_id, channel, template, status, response, at, attempts, retry_after
       FROM notifications ${where}
       ORDER BY at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, limit, offset]
    );

    return res.json({
      ok: true,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      notifications: rows,
    });
  } catch (err) {
    console.error('[admin] notifications list error', err.message);
    return res.status(500).json({ ok: false, error: 'query_failed' });
  }
});

/**
 * GET /admin/notifications/stats — Delivery statistics by channel and status
 */
router.get('/admin/notifications/stats', requireAdmin, async (req, res) => {
  try {
    const byChannel = await queryAll(
      `SELECT channel, status, COUNT(*) AS count
       FROM notifications
       GROUP BY channel, status
       ORDER BY channel, status`
    );

    const totals = await queryOne(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
         SUM(CASE WHEN status = 'retry' THEN 1 ELSE 0 END) AS retry
       FROM notifications`
    );

    return res.json({ ok: true, totals, byChannel });
  } catch (err) {
    console.error('[admin] notifications stats error', err.message);
    return res.status(500).json({ ok: false, error: 'query_failed' });
  }
});

/**
 * POST /admin/notifications/:id/retry — Manually retry a failed notification
 */
router.post('/admin/notifications/:id/retry', requireAdmin, async (req, res) => {
  const notifId = String(req.params.id);

  try {
    const notification = await queryOne('SELECT * FROM notifications WHERE id = $1', [notifId]);
    if (!notification) {
      return res.status(404).json({ ok: false, error: 'notification_not_found' });
    }

    if (notification.status !== 'failed') {
      return res.status(400).json({ ok: false, error: 'only_failed_notifications_can_be_retried' });
    }

    await execute(
      `UPDATE notifications SET status = 'retry', attempts = 0, retry_after = NULL WHERE id = $1`,
      [notifId]
    );

    return res.json({ ok: true, message: 'notification queued for retry' });
  } catch (err) {
    console.error('[admin] notification retry error', err.message);
    return res.status(500).json({ ok: false, error: 'retry_failed' });
  }
});

/**
 * GET /admin/orders/:id/notifications — Notification history for a specific case
 */
router.get('/admin/orders/:id/notifications', requireAdmin, async (req, res) => {
  const orderId = String(req.params.id);

  try {
    const rows = await queryAll(
      `SELECT id, order_id, to_user_id, channel, template, status, response, at, attempts
       FROM notifications
       WHERE order_id = $1
       ORDER BY at DESC`,
      [orderId]
    );

    return res.json({ ok: true, notifications: rows });
  } catch (err) {
    console.error('[admin] order notifications error', err.message);
    return res.status(500).json({ ok: false, error: 'query_failed' });
  }
});

// === ERROR DASHBOARD ===
router.get('/admin/errors', requireRole('admin', 'superadmin'), async (req, res) => {
  var lang = res.locals.lang || 'en';
  var isAr = lang === 'ar';
  var page = Math.max(1, parseInt(req.query.page, 10) || 1);
  var perPage = 50;
  var offset = (page - 1) * perPage;

  // Filters
  var level = (req.query.level || '').trim();
  var dateFrom = (req.query.date_from || '').trim();
  var dateTo = (req.query.date_to || '').trim();
  var search = (req.query.search || '').trim();

  var whereClauses = [];
  var params = [];
  var paramIdx = 1;

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
    var like = '%' + search + '%';
    params.push(like, like, like);
    paramIdx += 3;
  }

  var whereSql = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

  var totalRow = await safeGet('SELECT COUNT(*) as c FROM error_logs el ' + whereSql, params, { c: 0 });
  var total = totalRow ? totalRow.c : 0;
  var totalPages = Math.max(1, Math.ceil(total / perPage));

  var errors = await safeAll(
    'SELECT el.id, el.error_id, el.level, el.message, el.stack, el.context, el.request_id, el.user_id, el.url, el.method, el.created_at ' +
    'FROM error_logs el ' + whereSql +
    ` ORDER BY el.created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    params.concat([perPage, offset]),
    []
  );

  res.render('admin_errors', {
    errors,
    total,
    page,
    totalPages,
    perPage,
    filters: { level, date_from: dateFrom, date_to: dateTo, search },
    lang,
    isAr,
    pageTitle: isAr ? 'سجل الأخطاء' : 'Error Log',
    portalFrame: true,
    portalRole: req.user && req.user.role === 'superadmin' ? 'superadmin' : 'admin',
    portalActive: 'errors'
  });
});

router.get('/admin/errors/stats', requireRole('admin', 'superadmin'), async (req, res) => {
  // Error count by day (last 30 days)
  var errorsByDay = await safeAll(
    "SELECT TO_CHAR(created_at, 'YYYY-MM-DD') as date, COUNT(*) as count " +
    "FROM error_logs WHERE created_at >= NOW() - INTERVAL '30 days' " +
    "GROUP BY TO_CHAR(created_at, 'YYYY-MM-DD') ORDER BY date ASC",
    [], []
  );

  // Error count by level
  var errorsByLevel = await safeAll(
    'SELECT level, COUNT(*) as count FROM error_logs GROUP BY level ORDER BY count DESC',
    [], []
  );

  // Top 10 error messages
  var topErrors = await safeAll(
    'SELECT message, COUNT(*) as count FROM error_logs GROUP BY message ORDER BY count DESC LIMIT 10',
    [], []
  );

  // Total counts
  var totalRow = await safeGet('SELECT COUNT(*) as c FROM error_logs', [], { c: 0 });
  var last24hRow = await safeGet("SELECT COUNT(*) as c FROM error_logs WHERE created_at >= NOW() - INTERVAL '1 day'", [], { c: 0 });
  var last7dRow = await safeGet("SELECT COUNT(*) as c FROM error_logs WHERE created_at >= NOW() - INTERVAL '7 days'", [], { c: 0 });

  return res.json({
    ok: true,
    errorsByDay,
    errorsByLevel,
    topErrors,
    total: totalRow ? totalRow.c : 0,
    last24h: last24hRow ? last24hRow.c : 0,
    last7d: last7dRow ? last7dRow.c : 0
  });
});

// === REGIONAL PRICING MANAGEMENT ===

// GET /admin/pricing — show regional pricing grid
router.get('/admin/pricing', requireAdmin, async (req, res) => {
  try {
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';
    var countryCode = String(req.query.country || 'EG').trim().toUpperCase();
    var department = String(req.query.department || '').trim();

    var validCountries = ['EG', 'SA', 'AE', 'GB', 'US'];
    if (!validCountries.includes(countryCode)) countryCode = 'EG';

    var query = `
      SELECT srp.*, s.name as service_name, s.specialty_id, sp.name as specialty_name
      FROM service_regional_prices srp
      LEFT JOIN services s ON s.id = srp.service_id
      LEFT JOIN specialties sp ON sp.id = s.specialty_id
      WHERE srp.country_code = $1
    `;
    var params = [countryCode];
    var paramIdx = 2;

    if (department) {
      query += ` AND s.specialty_id = $${paramIdx++}`;
      params.push(department);
    }

    query += ' ORDER BY s.specialty_id, s.name';

    var prices = await safeAll(query, params, []);
    var departments = await safeAll('SELECT DISTINCT id, name FROM specialties ORDER BY name', [], []);

    res.render('admin_pricing', {
      prices: prices,
      departments: departments,
      selectedCountry: countryCode,
      selectedDepartment: department,
      lang: lang,
      isAr: isAr,
      pageTitle: isAr ? 'التسعير الإقليمي' : 'Regional Pricing',
      portalFrame: true,
      portalRole: req.user && req.user.role === 'superadmin' ? 'superadmin' : 'admin',
      portalActive: 'pricing'
    });
  } catch (err) {
    return res.status(500).send('Server error: ' + err.message);
  }
});

// GET /admin/pricing/export — CSV download
router.get('/admin/pricing/export', requireAdmin, async (req, res) => {
  try {
    var countryCode = String(req.query.country || 'EG').trim().toUpperCase();
    var prices = await safeAll(
      `SELECT srp.*, s.name as service_name, s.specialty_id, sp.name as specialty_name
       FROM service_regional_prices srp
       LEFT JOIN services s ON s.id = srp.service_id
       LEFT JOIN specialties sp ON sp.id = s.specialty_id
       WHERE srp.country_code = $1
       ORDER BY s.specialty_id, s.name`,
      [countryCode], []
    );

    var csv = 'Service ID,Service Name,Specialty,Hospital Cost,Tashkheesa Price,Doctor Commission,Currency,Status,Notes\n';
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

// POST /admin/pricing/:id/update — update a single price row
router.post('/admin/pricing/:id/update', requireAdmin, async (req, res) => {
  try {
    var priceId = String(req.params.id).trim();
    var hospitalCost = req.body.hospital_cost;
    var status = String(req.body.status || '').trim();
    var notes = String(req.body.notes || '').trim();

    var validStatuses = ['active', 'needs_clarification', 'not_available', 'external', 'pending_pricing'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ ok: false, error: 'Invalid status' });
    }

    var existing = await safeGet('SELECT * FROM service_regional_prices WHERE id = $1', [priceId], null);
    if (!existing) return res.status(404).json({ ok: false, error: 'Not found' });

    var hc = (hospitalCost !== null && hospitalCost !== '' && hospitalCost !== undefined) ? Number(hospitalCost) : null;
    var tp = (hc !== null && !isNaN(hc)) ? Math.ceil(hc * 1.15) : null;
    var dc = (tp !== null) ? Math.ceil(tp * 0.20) : null;
    var now = new Date().toISOString();

    var sets = ['updated_at = $1'];
    var params = [now];
    var paramIdx = 2;

    sets.push(`hospital_cost = $${paramIdx++}`);
    params.push(hc);
    sets.push(`tashkheesa_price = $${paramIdx++}`);
    params.push(tp);
    sets.push(`doctor_commission = $${paramIdx++}`);
    params.push(dc);

    if (status) {
      sets.push(`status = $${paramIdx++}`);
      params.push(status);
    }
    if (notes !== undefined) {
      sets.push(`notes = $${paramIdx++}`);
      params.push(notes || null);
    }

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

// POST /admin/pricing/bulk-activate — set all pending_pricing to active where prices exist
router.post('/admin/pricing/bulk-activate', requireAdmin, async (req, res) => {
  try {
    var countryCode = String(req.body.country || 'EG').trim().toUpperCase();
    var result = await execute(
      "UPDATE service_regional_prices SET status = 'active', updated_at = $1 WHERE country_code = $2 AND status = 'pending_pricing' AND hospital_cost IS NOT NULL",
      [new Date().toISOString(), countryCode]
    );
    return res.json({ ok: true, updated: result.rowCount });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════
// CHAT MODERATION
// ══════════════════════════════════════════════════

router.get('/admin/chat-moderation', requireAdmin, async function(req, res) {
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

  res.render('admin_chat_moderation', {
    reports,
    openCount: openCount ? openCount.cnt : 0,
    lang: (req.user && req.user.lang) || 'en',
    portalFrame: true,
    portalRole: req.user && req.user.role === 'superadmin' ? 'superadmin' : 'admin',
    portalActive: 'moderation'
  });
});

router.get('/admin/chat-moderation/:reportId', requireAdmin, async function(req, res) {
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

  if (!report) return res.redirect('/admin/chat-moderation');

  // Get ONLY 5 messages before and after the flagged message for context
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

  // Mark report as reviewing
  if (report.status === 'open') {
    try { await execute("UPDATE chat_reports SET status = 'reviewing' WHERE id = $1", [req.params.reportId]); } catch(_) {}
  }

  res.render('admin_chat_moderation_detail', {
    report,
    contextMessages,
    flaggedMessageId: report.message_id,
    lang: (req.user && req.user.lang) || 'en',
    portalFrame: true,
    portalRole: req.user && req.user.role === 'superadmin' ? 'superadmin' : 'admin',
    portalActive: 'moderation'
  });
});

router.post('/admin/chat-moderation/:reportId/resolve', requireAdmin, async function(req, res) {
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

  // If action is 'warn', create notification for the reported user
  if (action === 'warn') {
    try {
      const report = await safeGet('SELECT * FROM chat_reports WHERE id = $1', [req.params.reportId], null);
      if (report && report.message_id) {
        const flaggedMsg = await safeGet('SELECT sender_id FROM messages WHERE id = $1', [report.message_id], null);
        if (flaggedMsg) {
          await execute(`
            INSERT INTO notifications (id, user_id, type, title, message, created_at)
            VALUES ($1, $2, 'chat_warning', 'Chat Conduct Warning', 'Your message was reported and reviewed by our team. Please maintain professional conduct in all communications.', NOW())
          `, [randomUUID(), flaggedMsg.sender_id]);
        }
      }
    } catch(_) {}
  }

  // If action is 'mute', suspend user messaging for 7 days
  if (action === 'mute') {
    try {
      const report = await safeGet('SELECT message_id FROM chat_reports WHERE id = $1', [req.params.reportId], null);
      if (report && report.message_id) {
        const flaggedMsg = await safeGet('SELECT sender_id FROM messages WHERE id = $1', [report.message_id], null);
        if (flaggedMsg) {
          await execute("UPDATE users SET muted_until = NOW() + INTERVAL '7 days' WHERE id = $1", [flaggedMsg.sender_id]);
        }
      }
    } catch(_) {}
  }

  res.redirect('/admin/chat-moderation');
});

// ══════════════════════════════════════════════════
// VIDEO CALL MANAGEMENT
// ══════════════════════════════════════════════════

router.get('/admin/video-calls', requireAdmin, async function(req, res) {
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

  res.render('admin_video_calls', {
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
    portalFrame: true,
    portalRole: req.user && req.user.role === 'superadmin' ? 'superadmin' : 'admin',
    portalActive: 'video-calls'
  });
});

// Pre-Launch Leads Management
router.get('/admin/pre-launch-leads', requireAdmin, async (req, res) => {
  try {
    const leads = await safeAll(
      `SELECT * FROM pre_launch_leads ORDER BY created_at DESC`,
      [],
      []
    );

    return res.render('admin_pre_launch_leads', {
      leads,
      user: req.user,
      brand: 'Tashkheesa',
      portalFrame: true,
      portalRole: req.user && req.user.role === 'superadmin' ? 'superadmin' : 'admin',
      portalActive: 'pre-launch'
    });
  } catch (error) {
    console.error('[ADMIN] Error loading pre-launch leads:', error);
    return res.status(500).send('Error loading leads');
  }
});

module.exports = router;
