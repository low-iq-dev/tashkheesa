const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, acceptOrder, markOrderCompleted } = require('../db');
const { requireRole } = require('../middleware');
const { queueNotification, doctorNotify } = require('../notify');
const { logOrderEvent } = require('../audit');
const { computeSla, enforceBreachIfNeeded } = require('../sla_status');
const { recalcSlaBreaches } = require('../sla');
const caseLifecycle = require('../case_lifecycle');
const toCanonStatus = caseLifecycle.toCanonStatus;
const toDbStatus = caseLifecycle.toDbStatus;
const dbStatusValuesFor = caseLifecycle.dbStatusValuesFor;
// NOTE: case_lifecycle helpers are kept for legacy flows, but the portal doctor reject-files
// action is implemented directly against the `orders` table to support human-friendly case IDs.
const { generateMedicalReportPdf } = require('../report-generator');
const { assertRenderableView } = require('../renderGuard');

const router = express.Router();

const requireDoctor = requireRole('doctor');

// Always provide a default so views can safely render the badge.
router.use((req, res, next) => {
  res.locals.doctorAlertCount = 0;
  return next();
});

// Doctor alert badge count middleware (only for doctor routes)
router.use(['/portal/doctor', '/doctor'], requireDoctor, (req, res, next) => {
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) as c FROM notifications WHERE to_user_id = ? AND status = 'queued'"
      )
      .get(req.user.id);
    res.locals.doctorAlertCount = row ? row.c : 0;
  } catch (e) {
    res.locals.doctorAlertCount = 0;
  }
  return next();
});

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

function enrichOrders(rows) {
  return rows.map((row) => {
    enforceBreachIfNeeded(row);
    const computed = computeSla(row);
    return {
      ...row,
      status: computed.effectiveStatus || row.status,
      effectiveStatus: computed.effectiveStatus,
      sla: computed.sla
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

  if (sla.isBreached || sla.minutesOverdue) {
    const overdueHours = Math.max(1, Math.ceil((sla.minutesOverdue || 0) / 60));
    return t(lang, `Overdue by ${overdueHours}h`, `متأخر بـ ${overdueHours}س`);
  }

  if (typeof sla.minutesRemaining === 'number') {
    if (sla.minutesRemaining <= 0) return t(lang, 'Due now', 'حان الموعد');
    if (sla.minutesRemaining < 60) {
      return t(lang, `Due in ${sla.minutesRemaining}m`, `بعد ${sla.minutesRemaining}د`);
    }
    const hours = Math.max(1, Math.ceil(sla.minutesRemaining / 60));
    return t(lang, `Due in ${hours}h`, `بعد ${hours}س`);
  }

  if (sla.isNew) return t(lang, 'Awaiting acceptance', 'بانتظار القبول');
  if (order && String(order.status || '').toLowerCase() === 'completed') return t(lang, 'Completed', 'مكتملة');
  return t(lang, 'Deadline pending', 'الموعد غير محدد');
}

function buildPortalCases(doctorId, statuses, limit = 6, lang = 'en') {
  if (!Array.isArray(statuses) || !statuses.length) return [];
  const placeholders = statuses.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT o.*,
              s.name AS specialty_name,
              sv.name AS service_name
       FROM orders o
       LEFT JOIN specialties s ON o.specialty_id = s.id
       LEFT JOIN services sv ON o.service_id = sv.id
       WHERE o.doctor_id = ?
         AND o.status IN (${placeholders})
       ORDER BY o.updated_at DESC
       LIMIT ?`
    )
    .all(doctorId, ...statuses, limit);

  return enrichOrders(rows).map((order) => ({
    ...order,
    reference: order.id,
    specialtyLabel: [order.specialty_name, order.service_name].filter(Boolean).join(' • ') || '—',
    statusLabel: humanStatusText(order.status, lang),
    slaLabel: formatSlaLabel(order, order.sla, lang),
    href: `/portal/doctor/case/${order.id}`
  }));
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
  return s === 'new' || s === 'submitted';
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

function portalCaseStage(status) {
  const normalized = normalizeStatus(status);

  // Keep details blurred/locked until explicit acceptance.
  if (normalized === 'new' || normalized === 'submitted') return 'accept';

  if (normalized === 'completed') return 'completed';
  if (normalized === 'cancelled') return 'cancelled';

  if (normalized === 'rejected_files') return 'rejected';

  if (['accepted', 'assigned', 'in_review', 'review', 'breached', 'sla_breach'].includes(normalized)) {
    return 'review';
  }

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

/**
 * POST handler for generating a PDF report from the portal doctor case page.
 * Fixes: POST /portal/doctor/case/:caseId/report returning 404.
 */
async function handlePortalDoctorGenerateReport(req, res) {
  const doctorId = req.user && req.user.id;
  const orderId = req.params.caseId;
  const responseDone = () => {
    return Boolean(res.headersSent || res.writableEnded || res.finished);
  };

  const sendOnce = (status, message) => {
    if (responseDone()) return null;
    return res.status(status).send(message);
  };

  const redirectOnce = (url) => {
    if (responseDone()) return null;
    return res.redirect(url);
  };

  const order = findOrderForDoctor(orderId);
  if (!order) return sendOnce(404, 'Case not found');

// Ownership / eligibility checks:
// - If the case is already assigned, only the assigned doctor can view it.
// - If the case is unassigned, only allow view if it is still unaccepted AND matches the doctor's specialty (v1).
if (order.doctor_id) {
  if (!idsEqual(order.doctor_id, doctorId)) {
    return sendOnce(403, 'Not your order');
  }
} else {
  // Unassigned case: only allow minimal access pre-acceptance.
  if (!isUnacceptedStatus(order.status)) {
    return sendOnce(403, 'Not your order');
  }

  // Enforce specialty match (same rule as accept route).
  if (req.user.specialty_id && order.specialty_id && req.user.specialty_id !== order.specialty_id) {
    return sendOnce(403, 'Case not in your specialty');
  }
}
  // Must be accepted before generating a report.
  if (isUnacceptedStatus(order.status)) {
    return redirectOnce(`/portal/doctor/case/${orderId}?report=fail&reason=not_accepted`);
  }

  // Prevent duplicate report generation.
  if (isOrderReportLocked(order)) {
    const reportUrl = readReportUrlFromOrder(order);
    const qs = new URLSearchParams({ report: 'locked' });
    if (reportUrl) qs.set('reportUrl', reportUrl);
    return redirectOnce(`/portal/doctor/case/${orderId}?${qs.toString()}`);
  }

  // Pull latest diagnosis/notes (DB/events) but allow the current form submit to override.
  let diagnosisText = readDiagnosisFromOrder(order);
  if (!String(diagnosisText || '').trim()) {
    diagnosisText = readLatestDiagnosisFromEvents(orderId);
  }

  // If the generate-report POST includes note fields, prefer them so the PDF matches what the doctor just typed.
  const body = (req && req.body) ? req.body : {};
  const pickBodyText = (...keys) => {
    for (const k of keys) {
      if (!k) continue;
      const v = body[k];
      if (v == null) continue;
      const s = String(v).trim();
      if (s) return s;
    }
    return '';
  };

  const findingsKeyCandidates = [
    'findings',
    'findings_text',
    'findingsText',
    'notes_findings',
    'observations',
    'observations_text',
    'notes_observations',
    'diagnosis',
    'diagnosis_text',
    'medical_notes',
    'notes'
  ];

  const findingsBody = pickBodyText(...findingsKeyCandidates);
  const impressionBody = pickBodyText('impression', 'impression_text', 'impressionText', 'notes_impression', 'conclusion');
  const recommendationsBody = pickBodyText('recommendations', 'recommendations_text', 'recommendationsText', 'notes_recommendations');

  const parsedFields = parseCombinedNotesToFields(diagnosisText);
  const findingsText = findingsBody || parsedFields.findings || '';
  const impressionText = impressionBody || parsedFields.impression || '';
  const recommendationsText = recommendationsBody || parsedFields.recommendations || '';
  const hasBodyNotes = Boolean(findingsBody || impressionBody || recommendationsBody);

  if (process.env.NODE_ENV !== 'production') {
    const findingsKeyHits = findingsKeyCandidates.filter((k) => body[k] != null && String(body[k]).trim());
    const fallbackLabel = !findingsKeyHits.length && findingsText ? ' (from diagnosisText)' : '';
    console.info(`[report] findings keys: ${findingsKeyHits.length ? findingsKeyHits.join(',') : 'none'}${fallbackLabel}`);
  }

  if (hasBodyNotes) {
    diagnosisText = `Findings:\n${findingsText || ''}\n\nImpression:\n${impressionText || ''}\n\nRecommendations:\n${recommendationsText || ''}`;
  }

  // Persist the latest notes so refresh/open-report reflects the same content.
  try {
  const nowIso = new Date().toISOString();
const diagnosisCol = getDiagnosisColumnName();
if (diagnosisCol) {
  const orderCols = getOrdersColumns();
  const sets = [`${diagnosisCol} = ?`];
  const params = [diagnosisText || null];

  if (orderCols.includes('updated_at')) {
    sets.push('updated_at = ?');
    params.push(nowIso);
  }

  params.push(orderId);
  db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}
    db.prepare(
      `INSERT INTO order_events (id, order_id, label, meta, at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      require('crypto').randomUUID(),
      orderId,
      'doctor_diagnosis_saved',
      JSON.stringify({ diagnosisText: diagnosisText || '' }),
      nowIso
    );
  } catch (_) {
    // non-blocking
  }

  try {
    // Load assets for the report generator.
    let { files, patient, doctor, specialty } = loadReportAssets(order);

    // Also collect any additional/annotated files if present.
    let annotatedFiles = [];
    try {
      const additionalFilesUrlCol = getAdditionalFilesUrlColumnName();
      if (additionalFilesUrlCol) {
        annotatedFiles = db
          .prepare(
            `SELECT ${additionalFilesUrlCol} AS url
             FROM order_additional_files
             WHERE order_id = ?
             ORDER BY rowid DESC`
          )
          .all(orderId)
          .map((r) => (r && r.url ? String(r.url) : ''))
          .filter((u) => u && u.trim());
      }
    } catch (_) {
      annotatedFiles = [];
    }

    // Defensive fallbacks: ensure the generator always receives plain strings + objects
    if (!doctor) {
      doctor = {
        id: (req.user && req.user.id) || null,
        name: (req.user && (req.user.name || req.user.full_name)) || (req.user && req.user.email) || '—',
        email: (req.user && req.user.email) || null,
        specialty_id: (req.user && req.user.specialty_id) || null
      };
    }

    if (!specialty) {
      try {
        const sid = (order && order.specialty_id) || (req.user && req.user.specialty_id) || null;
        if (sid) specialty = db.prepare('SELECT id, name FROM specialties WHERE id = ?').get(sid);
      } catch (_) {
        // ignore
      }
    }

    // Ensure we have a patient object when possible
    if (!patient) {
      try {
        if (order && order.patient_id) {
          patient = db.prepare('SELECT id, name, email, lang FROM users WHERE id = ?').get(order.patient_id);
        }
      } catch (_) {
        // ignore
      }
    }

    // Ensure output directory exists.
    ensureReportsDir();

    // Prefer explicit field values when present; otherwise parse the combined notes blob.
    const noteFields = {
      findings: String(findingsText || '').trim(),
      impression: String(impressionText || '').trim(),
      recommendations: String(recommendationsText || '').trim()
    };

    // Support both sync and async implementations of generateMedicalReportPdf.
    const result = await Promise.resolve(
      generateMedicalReportPdf({
        order,
        // Common identifiers (different templates/generators expect different keys)
        reference: order && order.id ? String(order.id) : '',
        caseReference: order && order.id ? String(order.id) : '',

        patient,
        patientName: (patient && patient.name) ? String(patient.name) : '',

        doctor,
        doctorName: (doctor && typeof doctor === 'object')
          ? String(doctor.name || doctor.full_name || doctor.email || '—')
          : String(doctor || '—'),

        specialty,
        specialtyName: (specialty && typeof specialty === 'object')
          ? String(specialty.name || '—')
          : String(specialty || '—'),

        files,
        annotatedFiles,

        // Notes (send in multiple shapes to satisfy older/newer generators)
        diagnosisText,
        findings: noteFields.findings || '',
        impression: noteFields.impression || '',
        recommendations: noteFields.recommendations || '',

        findings_text: noteFields.findings || '',
        impression_text: noteFields.impression || '',
        recommendations_text: noteFields.recommendations || '',

        noteFields,
        notes: noteFields,
        fields: noteFields,
        sections: {
          findings: noteFields.findings || '',
          impression: noteFields.impression || '',
          recommendations: noteFields.recommendations || ''
        }
      })
    );

    // Normalize report URL from whatever the generator returns.
    let reportUrl = '';
    if (typeof result === 'string') {
      reportUrl = result;
    } else if (result && typeof result === 'object') {
      reportUrl = result.reportUrl || result.url || result.href || result.path || '';
    }

    // If the generator returned a filesystem path under /public, convert it to a public URL.
    try {
      if (reportUrl && !/^https?:\/\//i.test(reportUrl)) {
        const publicToken = `${path.sep}public${path.sep}`;
        const idx = reportUrl.lastIndexOf(publicToken);
        if (idx !== -1) {
          const rel = reportUrl.slice(idx + publicToken.length).split(path.sep).join('/');
          reportUrl = `/${rel}`;
        }
      }
    } catch (_) {}

    // Persist completion. Prefer the centralized helper when compatible; fallback is always safe.
    let completedOk = false;
    try {
      if (typeof markOrderCompleted === 'function') {
        // Attempt common signatures without breaking runtime.
        if (markOrderCompleted.length === 1) {
          markOrderCompleted({ orderId, doctorId, reportUrl, diagnosisText, annotatedFiles });
        } else if (markOrderCompleted.length === 2) {
          markOrderCompleted(orderId, reportUrl);
        } else if (markOrderCompleted.length === 3) {
          markOrderCompleted(orderId, reportUrl, diagnosisText);
        } else {
          // Last-resort call shape.
          markOrderCompleted(orderId, doctorId, reportUrl, diagnosisText);
        }
        completedOk = true;
      }
    } catch (e) {
      completedOk = false;
    }

    if (!completedOk) {
      markOrderCompletedFallback({ orderId, doctorId, reportUrl, diagnosisText, annotatedFiles });
    }

    // Redirect back to case page with success flag and report URL.
    const qs = new URLSearchParams({ report: 'ok' });
    if (reportUrl) qs.set('reportUrl', reportUrl);
    return redirectOnce(`/portal/doctor/case/${orderId}?${qs.toString()}`);
  } catch (e) {
    if (responseDone()) return null;
    const errorCode = 'report_generate_failed';
    console.warn(`[report] portal doctor report generation failed (${errorCode})`, e);
    return redirectOnce(`/portal/doctor/case/${orderId}?report=error`);
  }
}


// ---- end report completion helpers ----

/**
 * GET /doctor/queue (legacy queue page)
 */
router.get('/doctor/queue', requireDoctor, (req, res) => {
  recalcSlaBreaches();
  const doctorId = req.user.id;
  const { status = 'all', sla = 'all', specialty = 'all' } = req.query || {};

  const filters = {
    sla: sla === '24' || sla === '72' ? Number(sla) : null,
    specialty: specialty && specialty !== 'all' ? specialty : null,
    status
  };

  // Unassigned NEW cases
  const unassignedConditions = ["o.status = 'new'", 'o.doctor_id IS NULL'];
  const unassignedParams = [];
  if (filters.sla) {
    unassignedConditions.push('o.sla_hours = ?');
    unassignedParams.push(filters.sla);
  }
  if (filters.specialty) {
    unassignedConditions.push('o.specialty_id = ?');
    unassignedParams.push(filters.specialty);
  }

  const shouldShowUnassigned = status === 'all' || status === 'new';
  const unassignedOrders = shouldShowUnassigned
    ? enrichOrders(
        db
          .prepare(
            `SELECT o.*,
                    s.name AS specialty_name,
                    sv.name AS service_name,
                    (SELECT COUNT(*) FROM order_additional_files f WHERE f.order_id = o.id) AS extra_files_count
             FROM orders o
             LEFT JOIN specialties s ON o.specialty_id = s.id
             LEFT JOIN services sv ON o.service_id = sv.id
             WHERE ${unassignedConditions.join(' AND ')}
             ORDER BY o.created_at DESC`
          )
          .all(...unassignedParams)
      )
    : [];

  // Active cases
  const activeConditions = [
    'o.doctor_id = ?',
    "o.status IN ('accepted','in_review','review','rejected_files')"
  ];
  const activeParams = [doctorId];
  if (filters.sla) {
    activeConditions.push('o.sla_hours = ?');
    activeParams.push(filters.sla);
  }
  if (filters.specialty) {
    activeConditions.push('o.specialty_id = ?');
    activeParams.push(filters.specialty);
  }
  if (status === 'accepted' || status === 'in_review' || status === 'review' || status === 'rejected_files') {
    activeConditions.push('o.status = ?');
    activeParams.push(status);
  }

  const activeOrders = enrichOrders(
    db
      .prepare(
        `SELECT o.*,
                s.name AS specialty_name,
                sv.name AS service_name,
                (SELECT COUNT(*) FROM order_additional_files f WHERE f.order_id = o.id) AS extra_files_count
         FROM orders o
         LEFT JOIN specialties s ON o.specialty_id = s.id
         LEFT JOIN services sv ON o.service_id = sv.id
         WHERE ${activeConditions.join(' AND ')}
         ORDER BY o.created_at DESC`
      )
      .all(...activeParams)
  );

  // Closed cases
  const closedConditions = ['o.doctor_id = ?', "o.status IN ('completed','breached')"];
  const closedParams = [doctorId];
  if (filters.sla) {
    closedConditions.push('o.sla_hours = ?');
    closedParams.push(filters.sla);
  }
  if (filters.specialty) {
    closedConditions.push('o.specialty_id = ?');
    closedParams.push(filters.specialty);
  }
  if (status === 'completed' || status === 'breached') {
    closedConditions.push('o.status = ?');
    closedParams.push(status);
  }

  const closedOrders = db
    .prepare(
      `SELECT o.*,
              s.name AS specialty_name,
              sv.name AS service_name,
              (SELECT COUNT(*) FROM order_additional_files f WHERE f.order_id = o.id) AS extra_files_count
       FROM orders o
       LEFT JOIN specialties s ON o.specialty_id = s.id
       LEFT JOIN services sv ON o.service_id = sv.id
       WHERE ${closedConditions.join(' AND ')}
       ORDER BY o.updated_at DESC, o.completed_at DESC`
    )
    .all(...closedParams);

  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();

  res.render('doctor_queue', {
    user: req.user,
    activeOrders,
    unassignedOrders,
    closedOrders,
    filters: { status, sla, specialty },
    specialties
  });
});

function findOrderForDoctor(orderId) {
  return db
    .prepare(
      `SELECT o.*,
              s.name AS specialty_name,
              sv.name AS service_name
       FROM orders o
       LEFT JOIN specialties s ON o.specialty_id = s.id
       LEFT JOIN services sv ON o.service_id = sv.id
       WHERE o.id = ?`
    )
    .get(orderId);
}

function renderPortalCasePage(req, res, extras = {}) {
  recalcSlaBreaches();
  const lang = getLang(req, res);
  const doctorId = req.user.id;
  const orderId = req.params.caseId;
  const order = findOrderForDoctor(orderId);

  if (!order) return res.status(404).send('Case not found');
  // Defensive: normalize diagnosis field for the EJS view
  order.diagnosis_text = readDiagnosisFromOrder(order);
  // If this DB schema has no diagnosis column, drafts are stored in order_events.
  if (!String(order.diagnosis_text || '').trim()) {
    const fromEvents = readLatestDiagnosisFromEvents(orderId);
    if (fromEvents) order.diagnosis_text = fromEvents;
  }
  if (order.doctor_id && !idsEqual(order.doctor_id, doctorId)) {
    return res.status(403).send('Not your order');
  }

  enforceBreachIfNeeded(order);
  const computed = computeSla(order);
  order.status = computed.effectiveStatus || order.status;

  const stage = portalCaseStage(order.status);
  const isAccepted = stage !== 'accept';

  const orderFilesUrlCol = getOrderFilesUrlColumnName();
  const orderFilesLabelCol = getOrderFilesLabelColumnName();
  const orderFilesAtCol = getOrderFilesCreatedAtColumnName();
  const additionalFilesUrlCol = getAdditionalFilesUrlColumnName();
  const additionalFilesAtCol = getAdditionalFilesUploadedAtColumnName();

  // Gate sensitive data until doctor accepts the case.
  const primaryFiles =
    isAccepted && orderFilesUrlCol
      ? (() => {
          const selectParts = [`id`, `${orderFilesUrlCol} AS url`];
          if (orderFilesLabelCol) selectParts.push(`${orderFilesLabelCol} AS label`);
          const orderBy = orderFilesAtCol ? `${orderFilesAtCol} DESC` : 'id DESC';
          return db
            .prepare(
              `SELECT ${selectParts.join(', ')}
               FROM order_files
               WHERE order_id = ?
               ORDER BY ${orderBy}`
            )
            .all(orderId);
        })()
      : [];

  const additionalFiles =
    isAccepted && additionalFilesUrlCol
      ? (() => {
          const orderBy = additionalFilesAtCol ? `${additionalFilesAtCol} DESC` : 'rowid DESC';
          return db
            .prepare(
              `SELECT ${additionalFilesUrlCol} AS url
               FROM order_additional_files
               WHERE order_id = ?
               ORDER BY ${orderBy}`
            )
            .all(orderId);
        })()
      : [];

  // Merge primary + additional uploads into a single list for the doctor UI.
  // The patient "Upload additional files" flow writes into `order_additional_files`,
  // so we surface those here alongside the original `order_files` list.
  const mergedFiles = [];
  if (isAccepted) {
    for (const f of primaryFiles || []) {
      if (!f || !f.url) continue;
      mergedFiles.push({
        name: f.label || extractFileName(f.url),
        url: f.url
      });
    }

    for (const af of additionalFiles || []) {
      const url = af && (af.url || af.file_url) ? String(af.url || af.file_url) : '';
      if (!url) continue;
      mergedFiles.push({
        name: extractFileName(url),
        url
      });
    }
  }

  const clinicalContext = isAccepted
    ? {
        question: order.notes,
        medicalHistory: order.medical_history,
        medications: order.current_medications
      }
    : {
        question: '',
        medicalHistory: '',
        medications: ''
      };

  // Prefill for the 3 medical note fields (draft-safe)
  // Priority: explicit extras -> persisted order blob
  const persistedFields = parseCombinedNotesToFields(order.diagnosis_text);
  const notesPrefill = extras && extras.prefillNotes ? extras.prefillNotes : persistedFields;

  // Global banner (rendered by partials/doctor_header.ejs)
  // Priority: explicit extras -> report query flags
  let uiBanner = null;
  if (extras && extras.errorMessage) {
    uiBanner = { type: 'error', message: extras.errorMessage };
  } else if (extras && extras.successMessage) {
    uiBanner = { type: 'success', message: extras.successMessage };
  } else {
    const reportFlag = req && req.query ? String(req.query.report || '') : '';
    if (reportFlag === 'ok') {
      uiBanner = { type: 'success', message: t(lang, 'Report generated successfully.', 'تم إنشاء التقرير بنجاح.') };
    } else if (reportFlag === 'fail' || reportFlag === 'error') {
      uiBanner = { type: 'error', message: t(lang, 'Report generation failed. Please try again.', 'فشل إنشاء التقرير. حاول مرة أخرى.') };
    } else if (reportFlag === 'locked') {
      uiBanner = { type: 'info', message: t(lang, 'This case is locked because a report already exists.', 'هذه الحالة مقفلة لأن تقريراً موجود بالفعل.') };
    }
  }

  // If a report already exists, show a persistent lock banner on normal page loads too.
  if (!uiBanner && isOrderReportLocked(order)) {
    uiBanner = {
      type: 'info',
      message: t(
        lang,
        'Report already generated. Notes are read-only to prevent duplicates.',
        'تم إنشاء التقرير بالفعل. الملاحظات أصبحت للقراءة فقط لتجنب التكرار.'
      )
    };
  }

  // Default guidance banner for unaccepted cases
  if (!uiBanner && stage === 'accept') {
    uiBanner = {
      type: 'info',
      message: t(
        lang,
        'Accept case to view details and files.',
        'اقبل الحالة لعرض التفاصيل والملفات.'
      )
    };
  }

  // Additional-files request banner (source of truth: order_events).
  // Avoid relying on legacy query flags like `?additionalFilesRequested=1`.
  if (!uiBanner && isAccepted) {
    const af = getAdditionalFilesRequestState(orderId);

    if (af && af.state === 'pending') {
      uiBanner = {
        type: 'info',
        message: t(
          lang,
          'Waiting for support approval.',
          'بانتظار موافقة الدعم.'
        )
      };
    } else if (af && af.state === 'approved_awaiting_patient') {
      uiBanner = {
        type: 'info',
        message: t(
          lang,
          'Support approved the additional files request. Waiting for patient upload.',
          'تمت الموافقة على طلب الملفات الإضافية. بانتظار رفع المريض للملفات.'
        )
      };
    } else if (af && af.state === 'denied') {
      uiBanner = {
        type: 'error',
        message: t(
          lang,
          'Support rejected the additional files request.',
          'تم رفض طلب الملفات الإضافية من قبل الدعم.'
        )
      };
    } else if (af && af.state === 'satisfied') {
      uiBanner = {
        type: 'success',
        message: t(
          lang,
          'Patient uploaded the requested additional files.',
          'قام المريض برفع الملفات الإضافية المطلوبة.'
        )
      };
    }
  }

  if (order && order.status) order.status = canonOrOriginal(order.status);

  const inlineErrorMessage = uiBanner ? null : (extras.errorMessage || null);
  const inlineSuccessMessage = uiBanner ? null : (extras.successMessage || null);

  assertRenderableView('portal_doctor_case');
  return res.render('portal_doctor_case', {
    user: req.user,
    lang,
    uiBanner,
    // Keep success/fail flags from the URL, but also inject the latest reportUrl from DB/events
    query: (() => {
      const q = { ...(req.query || {}) };
      if (Object.prototype.hasOwnProperty.call(q, 'additionalFilesRequested')) {
        delete q.additionalFilesRequested;
      }
      if (!q.reportUrl) {
        const persistedUrl = readReportUrlFromOrder(order);
        if (persistedUrl) q.reportUrl = persistedUrl;
      }
      return q;
    })(),
    order,
    notesPrefill,
    // New fields for accept action (placed near stage/detailsLocked)
    detailsLocked: stage === 'accept',
    acceptActionUrl: `/portal/doctor/case/${orderId}/accept`,
    acceptCtaText: t(lang, 'Accept case', 'اقبل الحالة'),
    slaLabel: formatSlaLabel(order, computed.sla, lang),
    sla: computed.sla,
    files: mergedFiles,
    annotatedFiles: (additionalFiles || []).map((row) =>
      row && (row.url || row.file_url) ? String(row.url || row.file_url) : ''
    ),
    clinicalContext,
    stage,
    statusLabel: humanStatusText(order.status, lang),
    errorMessage: inlineErrorMessage,
    successMessage: inlineSuccessMessage
  });
}

function loadReportAssets(order) {
  if (!order || !order.id) return { files: [], patient: null, doctor: null, specialty: null };

  const orderFilesUrlCol = getOrderFilesUrlColumnName();
  const orderFilesLabelCol = getOrderFilesLabelColumnName();
  const orderFilesAtCol = getOrderFilesCreatedAtColumnName();

  const files = orderFilesUrlCol
    ? (() => {
        const selectParts = [`id`, `${orderFilesUrlCol} AS url`];
        if (orderFilesLabelCol) selectParts.push(`${orderFilesLabelCol} AS label`);
        const orderBy = orderFilesAtCol ? `${orderFilesAtCol} DESC` : 'id DESC';
        return db
          .prepare(
            `SELECT ${selectParts.join(', ')}
             FROM order_files
             WHERE order_id = ?
             ORDER BY ${orderBy}`
          )
          .all(order.id);
      })()
    : [];

  const patient = order.patient_id
    ? db.prepare('SELECT id, name, lang FROM users WHERE id = ?').get(order.patient_id)
    : null;

  const doctor = order.doctor_id
    ? db.prepare('SELECT id, name FROM users WHERE id = ?').get(order.doctor_id)
    : null;

  const specialty = order.specialty_id
    ? db.prepare('SELECT id, name FROM specialties WHERE id = ?').get(order.specialty_id)
    : null;

  return { files, patient, doctor, specialty };
}

function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Portal doctor profile (read-only for now)
 */
function renderDoctorProfile(req, res) {
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';
  const u = req.user || {};

  const title = t(lang, 'My profile', 'ملفي الشخصي');
  const dashboardLabel = t(lang, 'Dashboard', 'لوحة التحكم');
  const alertsLabel = t(lang, 'Alerts', 'التنبيهات');
  const logoutLabel = t(lang, 'Logout', 'تسجيل الخروج');

  const name = escapeHtml(u.name || '—');
  const email = escapeHtml(u.email || '—');
  const role = escapeHtml(u.role || 'doctor');

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
  const nextPath = (req && req.originalUrl && String(req.originalUrl).startsWith('/')) ? String(req.originalUrl) : '/doctor/profile';

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
        <a class="btn btn--ghost" href="/portal/doctor">${escapeHtml(dashboardLabel)}</a>
        <a class="btn btn--ghost" href="/portal/doctor/alerts">${escapeHtml(alertsLabel)}</a>
        <span class="btn btn--primary" aria-current="page">${escapeHtml(title)}</span>
      </div>
      <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
        <details class="user-menu">
          <summary class="pill user-menu-trigger" title="${escapeHtml(title)}">👤 ${profileLabel}</summary>
          <div class="user-menu-panel" role="menu" aria-label="${escapeHtml(title)}">
            <a class="user-menu-item" role="menuitem" href="/doctor/profile">${escapeHtml(title)}</a>
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

router.get('/portal/doctor/profile', requireDoctor, renderDoctorProfile);
// Alias route (some older UI/greps expect this path)
router.get('/doctor/profile', requireDoctor, renderDoctorProfile);

/**
 * Portal doctor alerts (simple list)
 */
router.get('/portal/doctor/alerts', requireDoctor, (req, res) => {
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';
  const u = req.user || {};

  const title = t(lang, 'Alerts', 'التنبيهات');
  const dashboardLabel = t(lang, 'Dashboard', 'لوحة التحكم');
  const profileLabel = t(lang, 'My profile', 'ملفي الشخصي');
  const logoutLabel = t(lang, 'Logout', 'تسجيل الخروج');

  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT id, title, body, message, meta, status, created_at
         FROM notifications
         WHERE to_user_id = ?
         ORDER BY COALESCE(created_at, id) DESC
         LIMIT 50`
      )
      .all(u.id);
  } catch (e) {
    try {
      rows = db
        .prepare(
          `SELECT *
           FROM notifications
           WHERE to_user_id = ?
           ORDER BY rowid DESC
           LIMIT 50`
        )
        .all(u.id);
    } catch (_) {
      rows = [];
    }
  }

  const items = (rows || []).map((r) => {
    const txt = r.title || r.message || r.body || '';
    const when = r.created_at ? formatDisplayDate(r.created_at) : '';
    const status = r.status ? String(r.status) : '';
    const line = `${txt}${when ? ' — ' + when : ''}${status ? ' (' + status + ')' : ''}`;
    return `<li style="padding:10px 0; border-bottom:1px solid rgba(0,0,0,0.06);">${escapeHtml(line || '—')}</li>`;
  }).join('');

  const empty = `<p style="margin:0; color:#666;">${escapeHtml(t(lang, 'No alerts right now.', 'لا توجد تنبيهات حالياً.'))}</p>`;

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
        <a class="btn btn--ghost" href="/portal/doctor">${escapeHtml(dashboardLabel)}</a>
        <span class="btn btn--primary" aria-current="page">${escapeHtml(title)}</span>
        <a class="btn btn--ghost" href="/portal/doctor/profile">${escapeHtml(profileLabel)}</a>
      </div>
      <form class="logout-form" action="/logout" method="POST" style="margin:0;">
        <button class="btn btn--outline" type="submit">${escapeHtml(logoutLabel)}</button>
      </form>
    </nav>
  </header>

  <main class="container" style="max-width:900px; margin:0 auto; padding:24px;">
    <h1 style="margin:0 0 16px 0;">${escapeHtml(title)}</h1>
    <section class="card" style="padding:16px;">
      ${items ? `<ul style="list-style:none; padding:0; margin:0;">${items}</ul>` : empty}
    </section>
  </main>
</body>
</html>`);
});

/**
 * Portal doctor dashboard
 */
router.get('/portal/doctor', requireDoctor, (req, res) => {
  recalcSlaBreaches();

  const lang = getLang(req, res);
  const doctorId = req.user.id;
  const doctorSpecialtyId = req.user.specialty_id || null;
  const doctorSubSpecialtyId = req.user.sub_specialty_id || null;

  /**
   * ACTIVE CASES
   * - Assigned to this doctor (picked OR assigned)
   * - Not completed
   */
  const activeStatuses = uniqStrings([
    ...statusDbValues('SUBMITTED', ['new']),
    ...statusDbValues('ASSIGNED', ['accepted']),
    ...statusDbValues('IN_REVIEW', ['in_review']),
    ...statusDbValues('REJECTED_FILES', ['rejected_files']),
    ...statusDbValues('SLA_BREACH', ['breached'])
  ]);
  const inSql = sqlIn('o.status', activeStatuses);

  const activeCasesRaw = enrichOrders(
    db.prepare(
      `
      SELECT o.*,
             s.name AS specialty_name,
             sv.name AS service_name
      FROM orders o
      LEFT JOIN specialties s ON o.specialty_id = s.id
      LEFT JOIN services sv ON o.service_id = sv.id
WHERE o.doctor_id = ?
  AND ${inSql.clause}
        ORDER BY o.updated_at DESC
      LIMIT 10
      `
    ).all(doctorId, ...inSql.params)
  ).map(order => ({
    ...order,
    reference: order.id,
    specialtyLabel: [order.specialty_name, order.service_name].filter(Boolean).join(' • ') || '—',
    statusLabel: humanStatusText(order.status, lang),
    slaLabel: formatSlaLabel(order, order.sla, lang),
    href: `/portal/doctor/case/${order.id}`
  }));
  const activeCases = (activeCasesRaw || []).map((o) => ({ ...o, status: canonOrOriginal(o.status) }));

  /**
   * AVAILABLE CASES
   * - Unassigned
   * - Eligible for this doctor (specialty-aware, v1)
   */
  const availableStatuses = statusDbValues('SUBMITTED', ['new']);
  const availableIn = sqlIn('o.status', availableStatuses);
  const availableCasesRaw = enrichOrders(
    db.prepare(
      `
      SELECT o.*,
             s.name AS specialty_name,
             sv.name AS service_name
      FROM orders o
      LEFT JOIN specialties s ON o.specialty_id = s.id
      LEFT JOIN services sv ON o.service_id = sv.id
      WHERE o.doctor_id IS NULL
        AND (
          ? IS NULL OR o.specialty_id = ?
        )
        AND ${availableIn.clause}
      ORDER BY o.created_at ASC
      LIMIT 10
      `
    ).all(doctorSpecialtyId, doctorSpecialtyId, ...availableIn.params)
  ).map(order => ({
    ...order,
    reference: order.id,
    specialtyLabel: [order.specialty_name, order.service_name].filter(Boolean).join(' • ') || '—',
    statusLabel: humanStatusText(order.status, lang),
    slaLabel: formatSlaLabel(order, order.sla, lang),
    href: `/portal/doctor/case/${order.id}`
  }));
  const availableCases = (availableCasesRaw || []).map((o) => ({ ...o, status: canonOrOriginal(o.status) }));

  /**
   * COMPLETED CASES
   * - Finished by this doctor
   */
  const completedStatuses = statusDbValues('COMPLETED', ['completed', 'Completed', 'COMPLETED']);
  const completedLower = uniqStrings((completedStatuses || []).map((s) => String(s).toLowerCase()));
  const completedIn = sqlIn('LOWER(o.status)', completedLower);
  // Defensive: consider completed if status matches OR completed_at exists OR report URL exists
  const orderCols = getOrdersColumns();
  const completedWhereParts = [completedIn.clause];
  const completedParams = [...completedIn.params];

  if (orderCols.includes('completed_at')) {
    completedWhereParts.push('o.completed_at IS NOT NULL');
  }

  const reportCol = getReportUrlColumnName();
  if (reportCol) {
    completedWhereParts.push(`o.${reportCol} IS NOT NULL AND TRIM(o.${reportCol}) != ''`);
  }

  const completedWhere = `(${completedWhereParts.join(' OR ')})`;

  const completedOrderBy = orderCols.includes('completed_at') && orderCols.includes('updated_at')
    ? 'COALESCE(o.completed_at, o.updated_at) DESC'
    : orderCols.includes('completed_at')
    ? 'o.completed_at DESC'
    : orderCols.includes('updated_at')
    ? 'o.updated_at DESC'
    : 'o.rowid DESC';

  const completedCasesRaw = enrichOrders(
    db
      .prepare(
        `
      SELECT o.*,
             s.name AS specialty_name,
             sv.name AS service_name
      FROM orders o
      LEFT JOIN specialties s ON o.specialty_id = s.id
      LEFT JOIN services sv ON o.service_id = sv.id
      WHERE o.doctor_id = ?
        AND ${completedWhere}
      ORDER BY ${completedOrderBy}
      LIMIT 10
      `
      )
      .all(doctorId, ...completedParams)
  ).map((order) => ({
    ...order,
    reference: order.id,
    specialtyLabel: [order.specialty_name, order.service_name].filter(Boolean).join(' • ') || '—',
    statusLabel: humanStatusText(order.status, lang),
    slaLabel: formatSlaLabel(order, order.sla, lang),
    href: `/portal/doctor/case/${order.id}`
  }));

  const completedCases = (completedCasesRaw || []).map((o) => ({ ...o, status: canonOrOriginal(o.status) }));

// Notifications should reflect the doctor's assigned workload, not the unassigned pool.
const newAssignedCases = (activeCases || []).filter((c) => isUnacceptedStatus(c.status));
const reviewCases = (activeCases || []).filter((c) => !isUnacceptedStatus(c.status));
const notifications = buildPortalNotifications(newAssignedCases, reviewCases, lang);

  assertRenderableView('portal_doctor_dashboard');
  res.render('portal_doctor_dashboard', {
    user: req.user,
    lang,

    // New portal naming
    activeCases,
    availableCases,
    completedCases,

    // Backward-compatible aliases (some templates/partials still expect legacy names)
    activeOrders: activeCases,
    unassignedOrders: availableCases,
    closedOrders: completedCases,

    notifications,
    query: req.query
  });
});

router.get('/portal/doctor/case/:caseId', requireDoctor, (req, res) => {
  return renderPortalCasePage(req, res);
});

router.post('/portal/doctor/case/:caseId/accept', requireDoctor, (req, res) => {
  const doctorId = req.user.id;
  const orderId = req.params.caseId;
  const order = findOrderForDoctor(orderId);

  if (!order) return res.status(404).send('Case not found');

  // Enforce specialty match (v1)
  if (
    req.user.specialty_id &&
    order.specialty_id &&
    req.user.specialty_id !== order.specialty_id
  ) {
    return res.status(403).send('Case not in your specialty');
  }

  if (order.doctor_id && !idsEqual(order.doctor_id, doctorId)) {
    return res.status(403).send('Not your order');
  }

  if (!isUnacceptedStatus(order.status)) {
    return res.redirect(`/portal/doctor/case/${orderId}`);
  }

  try {
    acceptOrder(orderId, doctorId);
  } catch (e) {
    console.error('[doctor accept] acceptOrder failed', e);
    return res.status(500).send('Failed to accept case');
  }

  try {
    setOrderStatusCanon(orderId, 'ASSIGNED');
  } catch (e) {
    console.error('[doctor accept] setOrderStatusCanon failed', e);
  }

  try {
    logOrderEvent({
      orderId,
      label: 'Doctor accepted case',
      meta: JSON.stringify({ via: 'doctor_portal', toStatus: 'ASSIGNED' }),
      actorUserId: doctorId,
      actorRole: 'doctor'
    });
  } catch (e) {}

  return res.redirect(`/portal/doctor/case/${orderId}?accepted=1`);
});

router.post('/portal/doctor/case/:caseId/reject-files', requireDoctor, (req, res) => {
  const doctorId = req.user.id;
  const orderId = req.params.caseId;
  const order = findOrderForDoctor(orderId);

  if (!order) return res.status(404).send('Case not found');
  if (order.doctor_id && !idsEqual(order.doctor_id, doctorId)) {
    return res.status(403).send('Not your order');
  }

  // Must accept before taking any action
  if (!order.doctor_id || !idsEqual(order.doctor_id, doctorId) || isUnacceptedStatus(order.status)) {
    return renderPortalCasePage(req, res, {
      errorMessage: 'Accept the case before requesting additional files.'
    });
  }

  const locked = redirectIfLocked(req, res, orderId, order);
  if (locked) return locked;

  const reason = req.body && req.body.reason ? String(req.body.reason).trim() : '';
  if (!reason) {
    return renderPortalCasePage(req, res, {
      errorMessage: 'Provide a short summary of why additional information is required.'
    });
  }

  // Guardrail: do not allow duplicate or conflicting additional-files requests.
  const reqState = getAdditionalFilesRequestState(orderId);
  if (reqState.state === 'pending') {
    return renderPortalCasePage(req, res, {
      errorMessage: 'An additional files request is already pending support approval.'
    });
  }
  if (reqState.state === 'approved_awaiting_patient') {
    return renderPortalCasePage(req, res, {
      errorMessage: 'Additional files request already approved. Waiting for the patient to re-upload.'
    });
  }

  // IMPORTANT:
  // This request must go to Admin/Superadmin first (approval), not directly to the patient.
  // We implement this flow directly on `orders` because the portal allows non-UUID case IDs.
  try {
    const nowIso = new Date().toISOString();
    const orderCols = getOrdersColumns();

    // 1) Update order status (canonical write path) and any optional flags if the schema has them
    const sets = ['status = ?'];
    const params = [dbStatusFor('REJECTED_FILES', DB_STATUS.REJECTED_FILES)];

    if (orderCols.includes('additional_files_requested')) {
      sets.push('additional_files_requested = 1');
    }
    // If this schema supports upload locking, ensure uploads are UNLOCKED for the re-upload flow.
    // (Primary uploads may be locked after payment, but additional-files requests must allow patient uploads.)
    if (orderCols.includes('uploads_locked')) {
      sets.push('uploads_locked = 0');
    }
    if (orderCols.includes('updated_at')) {
      sets.push('updated_at = ?');
      params.push(nowIso);
    }

    db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...params, orderId);

    // Normalize to canonical status in audit trail
    try {
      logOrderEvent({
        orderId,
        label: 'Doctor requested additional files',
        meta: JSON.stringify({ via: 'doctor_portal', toStatus: 'REJECTED_FILES', reason }),
        actorUserId: doctorId,
        actorRole: 'doctor'
      });
    } catch (e) {
      // ignore
    }

    // Source-of-truth event for dashboards/inboxes (Superadmin/Admin).
    // IMPORTANT: This label must be exact to match dashboard queries.
    try {
      db.prepare(
        `INSERT INTO order_events (id, order_id, label, meta, at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        require('crypto').randomUUID(),
        orderId,
        'doctor_requested_additional_files',
        JSON.stringify({ via: 'doctor_portal', reason }),
        nowIso
      );
    } catch (e) {
      // ignore
    }

    return res.redirect(`/portal/doctor/case/${orderId}`);
  } catch (e) {
    console.error('[doctor additional files] failed', e);
    return renderPortalCasePage(req, res, {
      errorMessage: 'Failed to request additional files. Please try again.'
    });
  }
});

module.exports = router;
