const express = require('express');
const { db } = require('../db');
const { logOrderEvent } = require('../audit');
const { randomUUID } = require('crypto');
const { queueNotification } = require('../notify');
const { computeSla, enforceBreachIfNeeded } = require('../sla_status');
const { recalcSlaBreaches } = require('../sla');
const { safeAll, safeGet, tableExists } = require('../sql-utils');
const caseLifecycle = require('../case_lifecycle');
const { requireRole } = require('../middleware');
const { buildFilters } = require('./superadmin');

const getStatusUi = caseLifecycle.getStatusUi || caseLifecycle;
const toCanonStatus = caseLifecycle.toCanonStatus;
const dbStatusValuesFor = caseLifecycle.dbStatusValuesFor;


const router = express.Router();

function getAdminDashboardStats() {
  const totalDoctors = db.prepare("SELECT COUNT(1) AS c FROM users WHERE role = 'doctor'").get()?.c || 0;
  const activeDoctors = db
    .prepare("SELECT COUNT(1) AS c FROM users WHERE role = 'doctor' AND COALESCE(is_active, 0) = 1")
    .get()?.c || 0;

  const openOrders = db
    .prepare("SELECT COUNT(1) AS c FROM orders WHERE LOWER(COALESCE(status, '')) != 'completed'")
    .get()?.c || 0;
  const newOrders = db
    .prepare("SELECT COUNT(1) AS c FROM orders WHERE LOWER(COALESCE(status, '')) = 'new'")
    .get()?.c || 0;
  const acceptedOrders = db
    .prepare("SELECT COUNT(1) AS c FROM orders WHERE LOWER(COALESCE(status, '')) = 'accepted'")
    .get()?.c || 0;
  const inReviewOrders = db
    .prepare("SELECT COUNT(1) AS c FROM orders WHERE LOWER(COALESCE(status, '')) = 'in_review'")
    .get()?.c || 0;
  const completedOrders = db
    .prepare("SELECT COUNT(1) AS c FROM orders WHERE LOWER(COALESCE(status, '')) = 'completed'")
    .get()?.c || 0;

  // Be tolerant to different naming conventions
  const breachedOrders = db
    .prepare(
      "SELECT COUNT(1) AS c FROM orders WHERE LOWER(COALESCE(status, '')) IN ('breached', 'breached_sla', 'delayed') OR LOWER(COALESCE(status, '')) LIKE '%breach%'"
    )
    .get()?.c || 0;

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

function getRecentActivity(limit = 15) {
  const rows = db
    .prepare(
      `SELECT order_id, label, at, meta
       FROM order_events
       ORDER BY datetime(at) DESC
       LIMIT ?`
    )
    .all([Number(limit) || 15]);

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

function sqlIn(field, values) {
  const vals = (values || []).filter((v) => v != null && String(v).length);
  if (!vals.length) return { clause: '1=0', params: [] };
  const ph = vals.map(() => '?').join(',');
  return { clause: `${field} IN (${ph})`, params: vals };
}

function sqlNotIn(field, values) {
  const vals = (values || []).filter((v) => v != null && String(v).length);
  if (!vals.length) return { clause: '1=1', params: [] };
  const ph = vals.map(() => '?').join(',');
  return { clause: `${field} NOT IN (${ph})`, params: vals };
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

function getLatestAdditionalFilesRequestEvent(orderId) {
  return safeGet(
    `SELECT id, label, meta, at, actor_user_id, actor_role
     FROM order_events
     WHERE order_id = ?
       AND (
         (LOWER(label) LIKE '%request%' AND (LOWER(label) LIKE '%file%' OR LOWER(label) LIKE '%upload%' OR LOWER(label) LIKE '%re-upload%' OR LOWER(label) LIKE '%reupload%'))
         OR LOWER(label) LIKE '%reject file%'
         OR LOWER(label) LIKE '%reupload%'
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

function getPendingAdditionalFilesRequests(limit = 25) {
  // Admin support inbox: show ALL additional-files requests so they are easy to spot,
  // and keep them visible after approve/decline (pill changes by stage).
  // Stage logic:
  // - awaiting_approval: request exists and no later decision
  // - approved: latest decision after request is approved
  // - declined: latest decision after request is rejected/denied/declined

  const rows = db
    .prepare(
      `WITH last_req AS (
          SELECT e1.order_id, MAX(datetime(e1.at)) AS req_at
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
            ON lr.order_id = e.order_id AND datetime(e.at) = lr.req_at
       ), last_dec AS (
          SELECT d1.order_id, MAX(datetime(d1.at)) AS dec_at
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
            ON ld.order_id = d.order_id AND datetime(d.at) = ld.dec_at
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
       ORDER BY datetime(req.requested_at) DESC
       LIMIT ?`
    )
    .all([Number(limit) || 25]);

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

function getOrderKpis(whereSql, params) {
  const completedValsKpi = lowerUniqStrings(statusDbValues('COMPLETED', ['completed']));
  const breachedValsKpi = lowerUniqStrings(
    uniqStrings([
      ...statusDbValues('BREACHED_SLA', ['breached', 'breached_sla']),
      ...statusDbValues('DELAYED', ['delayed'])
    ])
  );

  const completedIn = sqlIn('LOWER(o.status)', completedValsKpi);
  const breachedIn = sqlIn('LOWER(o.status)', breachedValsKpi);

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
  const kpis = safeGet(kpiSql, kpiParams, kpisFallback);

  return {
    totalOrders: kpis?.total_orders || 0,
    completedCount: kpis?.completed || 0,
    breachedCount: kpis?.breached || 0
  };
}

function renderAdminProfile(req, res) {
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

router.get('/admin/profile', requireRole('admin'), renderAdminProfile);

// Redirect entry
router.get('/admin', requireAdmin, (req, res) => {
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

  const { totalOrders, completedCount, breachedCount } = getOrderKpis(whereSql, params);

  const completedVals2 = lowerUniqStrings(statusDbValues('COMPLETED', ['completed']));
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

  const ordersListRaw = safeAll(
    `SELECT o.id, o.created_at, o.status, o.reassigned_count, o.deadline_at, o.completed_at,
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

    return {
      ...o,
      status: effective,
      effectiveStatus: computed.effectiveStatus,
      sla: computed.sla,
      statusUi: safeGetStatusUi(effective, langCode)
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

  const breachedVals3 = lowerUniqStrings(
    uniqStrings([
      ...statusDbValues('BREACHED_SLA', ['breached', 'breached_sla']),
      ...statusDbValues('DELAYED', ['delayed'])
    ])
  );
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

  const specialties = safeAll(
    'SELECT id, name FROM specialties ORDER BY name ASC',
    [],
    []
  );

  const pendingFileRequests = getPendingAdditionalFilesRequests(25);
  const pendingFileRequestsCount = (pendingFileRequests && pendingFileRequests.length) ? pendingFileRequests.length : 0;
  const pendingFileRequestsAwaitingCount = (pendingFileRequests || []).filter(r => r && r.stage === 'awaiting_approval').length;

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
    hideFinancials: true
  });
});

// ORDERS (admin)
router.get('/admin/orders', requireAdmin, (req, res) => {
  const query = req.query || {};
  const from = query.from || '';
  const to = query.to || '';
  const specialty = query.specialty || 'all';
  const langCode = (req.user && req.user.lang) ? req.user.lang : 'en';

  const { whereSql, params } = buildFilters(query);
  const { totalOrders, completedCount, breachedCount } = getOrderKpis(whereSql, params);

  const ordersRaw = safeAll(
    `SELECT o.id, o.created_at, o.status, o.reassigned_count, o.deadline_at, o.completed_at,
            p.name AS patient_name, d.name AS doctor_name,
            sv.name AS service_name, s.name AS specialty_name
     FROM orders o
     LEFT JOIN users p ON p.id = o.patient_id
     LEFT JOIN users d ON d.id = o.doctor_id
     LEFT JOIN services sv ON sv.id = o.service_id
     LEFT JOIN specialties s ON s.id = o.specialty_id
     ${whereSql}
     ORDER BY o.created_at DESC`,
    params,
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
  const events = safeAll(eventsSql, params, []);
  const eventsNormalized = (events || []).map((e) => ({ ...e, status: canonOrOriginal(e.status) }));

  const specialties = safeAll(
    'SELECT id, name FROM specialties ORDER BY name ASC',
    [],
    []
  );

  res.render('admin_orders', {
    user: req.user,
    orders,
    events: eventsNormalized || [],
    totalOrders,
    completedCount,
    breachedCount,
    specialties: specialties || [],
    filters: {
      from,
      to,
      specialty
    },
    hideFinancials: true
  });
});

router.get('/admin/orders/:id', requireAdmin, (req, res) => {
  const orderId = req.params.id;
  const order = db
    .prepare(
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
       WHERE o.id = ?`
    )
    .get(orderId);

  if (!order) {
    return res.redirect('/admin');
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

  const additionalFilesRequest = computeAdditionalFilesRequestState(orderId);

  return res.render('admin_order_detail', {
    user: req.user,
    order,
    events,
    doctors,
    additionalFilesRequest,
    hideFinancials: true
  });
});

router.post('/admin/orders/:id/additional-files/approve', requireAdmin, (req, res) => {
  const orderId = req.params.id;
  const { request_event_id, support_note } = req.body || {};

  const order = db.prepare('SELECT id, patient_id, status FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.redirect('/admin');

  const nowIso = new Date().toISOString();

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
    'Additional files request approved (admin)',
    JSON.stringify({ request_event_id: request_event_id || null, support_note: support_note || null }),
    nowIso,
    req.user.id,
    req.user.role
  );

  if (order.patient_id) {
    queueNotification({
      orderId,
      toUserId: order.patient_id,
      channel: 'internal',
      template: 'additional_files_request_approved_patient',
      status: 'queued'
    });
  }

  return res.redirect(`/admin/orders/${orderId}?additional_files=approved`);
});

router.post('/admin/orders/:id/additional-files/reject', requireAdmin, (req, res) => {
  const orderId = req.params.id;
  const { request_event_id, support_note } = req.body || {};

  const order = db.prepare('SELECT id, patient_id FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.redirect('/admin');

  const nowIso = new Date().toISOString();

  db.prepare(
    `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    orderId,
    'Additional files request rejected (admin)',
    JSON.stringify({ request_event_id: request_event_id || null, support_note: support_note || null }),
    nowIso,
    req.user.id,
    req.user.role
  );

  return res.redirect(`/admin/orders/${orderId}?additional_files=rejected`);
});

router.post('/admin/orders/:id/reassign', requireAdmin, (req, res) => {
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
    return res.redirect(`/admin/orders/${orderId}`);
  }

  const newDoctor = db
    .prepare("SELECT id, name FROM users WHERE id = ? AND role = 'doctor' AND is_active = 1")
    .get(newDoctorId);
  if (!newDoctor) {
    return res.redirect(`/admin/orders/${orderId}`);
  }

  if (order.doctor_id === newDoctor.id) {
    return res.redirect(`/admin/orders/${orderId}`);
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
    label: `Order reassigned from ${order.doctor_name || order.doctor_id || 'Unassigned'} to ${newDoctor.name} by admin`,
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

  return res.redirect(`/admin/orders/${orderId}`);
});

// DOCTORS
router.get('/admin/doctors', requireAdmin, (req, res) => {
  const doctors = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.phone, u.notify_whatsapp, u.is_active, u.specialty_id, s.name AS specialty_name
       FROM users u
       LEFT JOIN specialties s ON s.id = u.specialty_id
       WHERE u.role = 'doctor'
       ORDER BY u.created_at DESC, u.name ASC`
    )
    .all();
  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  const pendingFileRequests = getPendingAdditionalFilesRequests(25);
  const pendingFileRequestsCount = (pendingFileRequests && pendingFileRequests.length) ? pendingFileRequests.length : 0;
  const pendingFileRequestsAwaitingCount = (pendingFileRequests || []).filter(r => r && r.stage === 'awaiting_approval').length;

  const stats = getAdminDashboardStats();
  const recentActivity = getRecentActivity(15);

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
  });
});

router.get('/admin/doctors/new', requireAdmin, (req, res) => {
  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  res.render('admin_doctor_form', { user: req.user, specialties, doctor: null, isEdit: false, error: null, hideFinancials: true });
});

router.post('/admin/doctors/new', requireAdmin, (req, res) => {
  const { name, email, specialty_id, phone, notify_whatsapp, is_active } = req.body || {};
  if (!name || !email) {
    const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
    return res.status(400).render('admin_doctor_form', {
      user: req.user,
      specialties,
      doctor: { name, email, specialty_id, phone, notify_whatsapp, is_active },
      isEdit: false,
      error: 'Name and email are required.',
      hideFinancials: true
    });
  }
  db.prepare(
    `INSERT INTO users (id, email, password_hash, name, role, specialty_id, phone, lang, notify_whatsapp, is_active)
     VALUES (?, ?, ?, ?, 'doctor', ?, ?, 'en', ?, ?)`
  ).run(
    randomUUID(),
    email,
    '',
    name,
    specialty_id || null,
    phone || null,
    notify_whatsapp ? 1 : 0,
    is_active ? 1 : 0
  );
  return res.redirect('/admin/doctors');
});

router.get('/admin/doctors/:id/edit', requireAdmin, (req, res) => {
  const doctor = db
    .prepare("SELECT * FROM users WHERE id = ? AND role = 'doctor'")
    .get(req.params.id);
  if (!doctor) return res.redirect('/admin/doctors');
  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  res.render('admin_doctor_form', { user: req.user, specialties, doctor, isEdit: true, error: null, hideFinancials: true });
});

router.post('/admin/doctors/:id/edit', requireAdmin, (req, res) => {
  const doctor = db
    .prepare("SELECT * FROM users WHERE id = ? AND role = 'doctor'")
    .get(req.params.id);
  if (!doctor) return res.redirect('/admin/doctors');
  const { name, email, specialty_id, phone, notify_whatsapp, is_active } = req.body || {};
  db.prepare(
    `UPDATE users
     SET name = ?, email = ?, specialty_id = ?, phone = ?, notify_whatsapp = ?, is_active = ?
     WHERE id = ? AND role = 'doctor'`
  ).run(
    name || doctor.name,
    email || doctor.email,
    specialty_id || null,
    phone || null,
    notify_whatsapp ? 1 : 0,
    is_active ? 1 : 0,
    req.params.id
  );
  return res.redirect('/admin/doctors');
});

router.post('/admin/doctors/:id/toggle-active', requireAdmin, (req, res) => {
  const doctorId = req.params.id;
  db.prepare(
    `UPDATE users
     SET is_active = CASE is_active WHEN 1 THEN 0 ELSE 1 END
     WHERE id = ? AND role = 'doctor'`
  ).run(doctorId);
  return res.redirect('/admin/doctors');
});

// SERVICES
router.get('/admin/services', requireAdmin, (req, res) => {
  const services = db
    .prepare(
      `SELECT sv.id, sv.code, sv.name, sv.base_price, sv.doctor_fee, sv.currency, sv.payment_link, sp.name AS specialty_name
       FROM services sv
       LEFT JOIN specialties sp ON sp.id = sv.specialty_id
       ORDER BY sp.name ASC, sv.name ASC`
    )
    .all();
  res.render('admin_services', { user: req.user, services, hideFinancials: true });
});

router.get('/admin/services/new', requireAdmin, (req, res) => {
  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  res.render('admin_service_form', { user: req.user, specialties, service: null, isEdit: false, error: null, hideFinancials: true });
});

router.post('/admin/services/new', requireAdmin, (req, res) => {
  const { specialty_id, code, name, base_price, doctor_fee, currency, payment_link } = req.body || {};
  if (!specialty_id || !name) {
    const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
    return res.status(400).render('admin_service_form', {
      user: req.user,
      specialties,
      service: { specialty_id, code, name, base_price, doctor_fee, currency, payment_link },
      isEdit: false,
      error: 'Specialty and name are required.',
      hideFinancials: true
    });
  }
  db.prepare(
    `INSERT INTO services (id, specialty_id, code, name, base_price, doctor_fee, currency, payment_link)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    specialty_id,
    code || null,
    name,
    base_price ? Number(base_price) : null,
    doctor_fee ? Number(doctor_fee) : null,
    currency || 'EGP',
    payment_link || null
  );
  return res.redirect('/admin/services');
});

router.get('/admin/services/:id/edit', requireAdmin, (req, res) => {
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
  if (!service) return res.redirect('/admin/services');
  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  res.render('admin_service_form', { user: req.user, specialties, service, isEdit: true, error: null, hideFinancials: true });
});

router.post('/admin/services/:id/edit', requireAdmin, (req, res) => {
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
  if (!service) return res.redirect('/admin/services');
  const { specialty_id, code, name, base_price, doctor_fee, currency, payment_link } = req.body || {};
  if (!specialty_id || !name) {
    const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
    return res.status(400).render('admin_service_form', {
      user: req.user,
      specialties,
      service: { ...service, ...req.body },
      isEdit: true,
      error: 'Specialty and name are required.',
      hideFinancials: true
    });
  }
  db.prepare(
    `UPDATE services
     SET specialty_id = ?, code = ?, name = ?, base_price = ?, doctor_fee = ?, currency = ?, payment_link = ?
     WHERE id = ?`
  ).run(
    specialty_id,
    code || null,
    name,
    base_price ? Number(base_price) : null,
    doctor_fee ? Number(doctor_fee) : null,
    currency || 'EGP',
    payment_link || null,
    req.params.id
  );
  return res.redirect('/admin/services');
});

// ORDERS (support)
// Admin/Superadmin can temporarily unlock uploads if patient/doctor requests it.
// Integrity rule: never unlock for completed orders.
router.post('/admin/orders/:id/uploads/unlock', requireAdmin, (req, res) => {
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

  const order = db.prepare('SELECT id, status, uploads_locked FROM orders WHERE id = ?').get(orderId);
  if (!order) return fail(404, 'Not found');

  if (String(order.status || '').toLowerCase() === 'completed') {
    return fail(400, 'Cannot unlock uploads for completed orders', { orderId });
  }

  const nowIso = new Date().toISOString();
  db.prepare(
    `UPDATE orders
     SET uploads_locked = 0,
         updated_at = ?
     WHERE id = ?`
  ).run(nowIso, orderId);

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

router.post('/admin/orders/:id/uploads/lock', requireAdmin, (req, res) => {
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

  const order = db.prepare('SELECT id, status, uploads_locked FROM orders WHERE id = ?').get(orderId);
  if (!order) return fail(404, 'Not found');

  const nowIso = new Date().toISOString();
  db.prepare(
    `UPDATE orders
     SET uploads_locked = 1,
         updated_at = ?
     WHERE id = ?`
  ).run(nowIso, orderId);

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

module.exports = router;
