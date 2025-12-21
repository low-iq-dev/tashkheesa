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
const { markOrderRejectedFiles } = caseLifecycle;
const { generateMedicalReportPdf } = require('../report-generator');
const { assertRenderableView } = require('../renderGuard');

const router = express.Router();

/**
 * Doctor alert badge count middleware
 */

router.use((req, res, next) => {
  if (req.user && req.user.role === 'doctor') {
    const row = db
      .prepare(
        "SELECT COUNT(*) as c FROM notifications WHERE to_user_id = ? AND status = 'queued'"
      )
      .get(req.user.id);
    res.locals.doctorAlertCount = row ? row.c : 0;
  }
  next();
});

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
    accepted: 'Accepted',
    review: 'In review',
    in_review: 'In review',
    completed: 'Completed',
    breached: 'Overdue',
    rejected_files: 'Awaiting files',
    cancelled: 'Cancelled'
  };
  const ar = {
    new: 'جديدة',
    accepted: 'مقبولة',
    review: 'قيد المراجعة',
    in_review: 'قيد المراجعة',
    completed: 'مكتملة',
    breached: 'متأخرة',
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
    specialtyLabel: order.specialty_name || order.service_name || '—',
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

function portalCaseStage(status) {
  const normalized = (status || '').toLowerCase();
  if (normalized === 'new') return 'accept';
  if (normalized === 'completed') return 'completed';
  if (normalized === 'rejected_files') return 'rejected';
  if (['accepted', 'in_review', 'review'].includes(normalized)) return 'review';
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

  // Always mark completed.
  sets.push("status = 'completed'");

  // Only set timestamps if those columns exist in this DB schema.
  const orderCols = getOrdersColumns();
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


// ---- end report completion helpers ----

/**
 * GET /doctor/queue (legacy queue page)
 */
router.get('/doctor/queue', requireRole('doctor'), (req, res) => {
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
  if (order.doctor_id && order.doctor_id !== doctorId) {
    return res.status(403).send('Not your order');
  }

  enforceBreachIfNeeded(order);
  const computed = computeSla(order);
  order.status = computed.effectiveStatus || order.status;

  const files = db
    .prepare(
      `SELECT id, url, label
       FROM order_files
       WHERE order_id = ?
       ORDER BY created_at DESC`
    )
    .all(orderId);

  const additionalFiles = db
    .prepare(
      `SELECT file_url
       FROM order_additional_files
       WHERE order_id = ?
       ORDER BY uploaded_at DESC`
    )
    .all(orderId);

  const stage = portalCaseStage(order.status);

  const clinicalContext = {
    question: order.notes,
    medicalHistory: order.medical_history,
    medications: order.current_medications
  };

  assertRenderableView('portal_doctor_case');
  return res.render('portal_doctor_case', {
    user: req.user,
    lang,
    // Keep success/fail flags from the URL, but also inject the latest reportUrl from DB/events
    query: (() => {
      const q = { ...(req.query || {}) };
      if (!q.reportUrl) {
        const persistedUrl = readReportUrlFromOrder(order);
        if (persistedUrl) q.reportUrl = persistedUrl;
      }
      return q;
    })(),
    order,
    slaLabel: formatSlaLabel(order, computed.sla, lang),
    sla: computed.sla,
    files: files.map((file) => ({
      name: file.label || extractFileName(file.url),
      url: file.url
    })),
    annotatedFiles: additionalFiles.map((row) => row.file_url),
    clinicalContext,
    stage,
    statusLabel: humanStatusText(order.status, lang),
    errorMessage: extras.errorMessage || null,
    successMessage: extras.successMessage || null
  });
}

function loadReportAssets(order) {
  if (!order || !order.id) return { files: [], patient: null, doctor: null, specialty: null };

  const files = db
    .prepare(
      `SELECT id, url, label
       FROM order_files
       WHERE order_id = ?
       ORDER BY created_at DESC`
    )
    .all(order.id);

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

/**
 * Portal doctor dashboard
 */
router.get('/portal/doctor', requireRole('doctor'), (req, res) => {
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
  const activeCases = enrichOrders(
    db.prepare(
      `
      SELECT o.*,
             s.name AS specialty_name,
             sv.name AS service_name
      FROM orders o
      LEFT JOIN specialties s ON o.specialty_id = s.id
      LEFT JOIN services sv ON o.service_id = sv.id
WHERE o.doctor_id = ?
  AND o.status IN ('new', 'accepted', 'review', 'rejected_files')
        ORDER BY o.updated_at DESC
      LIMIT 10
      `
    ).all(doctorId)
  ).map(order => ({
    ...order,
    reference: order.id,
    specialtyLabel: order.specialty_name || order.service_name || '—',
    statusLabel: humanStatusText(order.status, lang),
    slaLabel: formatSlaLabel(order, order.sla, lang),
    href: `/portal/doctor/case/${order.id}`
  }));

  /**
   * AVAILABLE CASES
   * - Unassigned
   * - Eligible for this doctor (specialty-aware, v1)
   */
  const availableCases = enrichOrders(
    db.prepare(
      `
      SELECT o.*,
             s.name AS specialty_name,
             sv.name AS service_name
      FROM orders o
      LEFT JOIN specialties s ON o.specialty_id = s.id
      LEFT JOIN services sv ON o.service_id = sv.id
      WHERE o.doctor_id IS NULL
        AND o.status = 'new'
        AND (
          ? IS NULL OR o.specialty_id = ?
        )
      ORDER BY o.created_at ASC
      LIMIT 10
      `
    ).all(doctorSpecialtyId, doctorSpecialtyId)
  ).map(order => ({
    ...order,
    reference: order.id,
    specialtyLabel: order.specialty_name || order.service_name || '—',
    statusLabel: humanStatusText(order.status, lang),
    slaLabel: formatSlaLabel(order, order.sla, lang),
    href: `/portal/doctor/case/${order.id}`
  }));

  /**
   * COMPLETED CASES
   * - Finished by this doctor
   */
  const completedCases = enrichOrders(
    db.prepare(
      `
      SELECT o.*,
             s.name AS specialty_name,
             sv.name AS service_name
      FROM orders o
      LEFT JOIN specialties s ON o.specialty_id = s.id
      LEFT JOIN services sv ON o.service_id = sv.id
      WHERE o.doctor_id = ?
        AND o.status = 'completed'
      ORDER BY o.completed_at DESC
      LIMIT 10
      `
    ).all(doctorId)
  ).map(order => ({
    ...order,
    reference: order.id,
    specialtyLabel: order.specialty_name || order.service_name || '—',
    statusLabel: humanStatusText(order.status, lang),
    slaLabel: formatSlaLabel(order, order.sla, lang),
    href: `/portal/doctor/case/${order.id}`
  }));

  const notifications = buildPortalNotifications(availableCases, activeCases, lang);

  assertRenderableView('portal_doctor_dashboard');
  res.render('portal_doctor_dashboard', {
    user: req.user,
    lang,
    activeCases,
    availableCases,
    completedCases,
    notifications,
    query: req.query
  });
});

router.get('/portal/doctor/case/:caseId', requireRole('doctor'), (req, res) => {
  return renderPortalCasePage(req, res);
});

router.post('/portal/doctor/case/:caseId/accept', requireRole('doctor'), (req, res) => {
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
  if (order.doctor_id && order.doctor_id !== doctorId) {
    return res.status(403).send('Not your order');
  }
  if (order.status !== 'new') {
    return res.redirect(`/portal/doctor/case/${orderId}`);
  }

  acceptOrder(orderId, doctorId);
  return res.redirect(`/portal/doctor/case/${orderId}`);
});

router.post('/portal/doctor/case/:caseId/reject-files', requireRole('doctor'), (req, res) => {
  const doctorId = req.user.id;
  const orderId = req.params.caseId;
  const order = findOrderForDoctor(orderId);

  if (!order) return res.status(404).send('Case not found');
  if (order.doctor_id && order.doctor_id !== doctorId) {
    return res.status(403).send('Not your order');
  }

  const reason = req.body && req.body.reason ? String(req.body.reason).trim() : '';
  if (!reason) {
    return renderPortalCasePage(req, res, {
      errorMessage: 'Provide a short summary of why additional information is required.'
    });
  }

  markOrderRejectedFiles({ orderId, doctorId, reason });
  return res.redirect(`/portal/doctor/case/${orderId}`);
});

router.post('/portal/doctor/case/:caseId/diagnosis', requireRole('doctor'), (req, res) => {
  const doctorId = req.user.id;
  const orderId = req.params.caseId;
  const order = findOrderForDoctor(orderId);

  if (!order) return res.status(404).send('Case not found');
  if (order.doctor_id && order.doctor_id !== doctorId) {
    return res.status(403).send('Not your order');
  }
  // Prevent edits after a report has been generated (avoid duplicate/conflicting reports)
  if (isOrderReportLocked(order)) {
    return res.redirect(`/portal/doctor/case/${orderId}?report=locked`);
  }

  const findingsText = req.body && req.body.diagnosis ? String(req.body.diagnosis).trim() : '';
  const impressionText = req.body && req.body.impression ? String(req.body.impression).trim() : '';
  const recommendationsText =
    req.body && req.body.recommendations ? String(req.body.recommendations).trim() : '';

  // Persist as one combined note blob so we don't require DB schema changes.
  const diagnosisText = [
    findingsText ? `Findings:\n${findingsText}` : '',
    impressionText ? `Impression:\n${impressionText}` : '',
    recommendationsText ? `Recommendations:\n${recommendationsText}` : ''
  ]
    .filter(Boolean)
    .join('\n\n');
  const nowIso = new Date().toISOString();

  // Write diagnosis to whichever column exists in this DB schema.
  const diagnosisCol = getDiagnosisColumnName();

  try {
    if (diagnosisCol) {
      // Column name is chosen from a fixed allow-list above.
      const orderCols = getOrdersColumns();
      if (orderCols.includes('updated_at')) {
        db.prepare(
          `UPDATE orders
           SET ${diagnosisCol} = ?,
               updated_at = ?
           WHERE id = ?`
        ).run(diagnosisText || null, nowIso, orderId);
      } else {
        db.prepare(
          `UPDATE orders
           SET ${diagnosisCol} = ?
           WHERE id = ?`
        ).run(diagnosisText || null, orderId);
      }
    } else {
      // No diagnosis column exists yet; still persist via events so nothing breaks.
      const orderCols = getOrdersColumns();
      if (orderCols.includes('updated_at')) {
        db.prepare(
          `UPDATE orders
           SET updated_at = ?
           WHERE id = ?`
        ).run(nowIso, orderId);
      }

      db.prepare(
        `INSERT INTO order_events (id, order_id, label, meta, at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        require('crypto').randomUUID(),
        orderId,
        'doctor_diagnosis_saved',
        JSON.stringify({ via: 'doctor_portal', diagnosisText: diagnosisText || null }),
        nowIso
      );
    }

    logOrderEvent({
      orderId,
      label: 'Doctor saved medical opinion',
      meta: JSON.stringify({ via: 'doctor_portal', diagnosis_saved: !!diagnosisText, storage: diagnosisCol || 'order_events' }),
      actorUserId: doctorId,
      actorRole: 'doctor'
    });

    return renderPortalCasePage(req, res, { successMessage: 'Notes saved.' });
  } catch (err) {
    console.error('[doctor diagnosis] save failed', err);
    return renderPortalCasePage(req, res, {
      errorMessage: 'Could not save the medical opinion. Please try again.'
    });
  }
});

router.post('/portal/doctor/case/:caseId/report', requireRole('doctor'), async (req, res) => {
  const doctorId = req.user.id;
  const orderId = req.params.caseId;
  const order = findOrderForDoctor(orderId);

  if (!order) return res.status(404).send('Case not found');
  if (order.doctor_id && order.doctor_id !== doctorId) {
    return res.status(403).send('Not your order');
  }
  // Block duplicate report generation if a report already exists
  if (isOrderReportLocked(order)) {
    return res.redirect(`/portal/doctor/case/${orderId}?report=locked`);
  }

  // 1) Expand actionable statuses list
  const actionable = ['accepted', 'in_review', 'review', 'rejected_files'];
  if (!actionable.includes(order.status)) {
    return res.redirect(`/portal/doctor/case/${orderId}`);
  }

  // 2) Accept multiple textarea field names for diagnosis/notes
  const findingsRaw =
    (req.body && (req.body.diagnosis || req.body.findings || req.body.medical_notes || req.body.medicalNotes || req.body.notes)) || '';
  const findingsText = String(findingsRaw).trim();
  const impressionText = req.body && req.body.impression ? String(req.body.impression).trim() : '';
  const recommendationsText =
    req.body && req.body.recommendations ? String(req.body.recommendations).trim() : '';

  const combinedNotes = [
    findingsText ? `Findings:\n${findingsText}` : '',
    impressionText ? `Impression:\n${impressionText}` : '',
    recommendationsText ? `Recommendations:\n${recommendationsText}` : ''
  ]
    .filter(Boolean)
    .join('\n\n');
  const annotatedRaw = req.body && req.body.annotated_files ? String(req.body.annotated_files) : '';
  const annotatedFiles = annotatedRaw
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value);

  if (!combinedNotes) {
    return renderPortalCasePage(req, res, {
      errorMessage: 'Please add your notes (Findings, and optionally Impression/Recommendations) before generating the report.'
    });
  }

  const reportAssets = loadReportAssets(order);
  // Ensure expected report output folder exists (generator may write here)
  ensureReportsDir();
  try {
    // 3) Replace payload to match report generator expectations
    const generatedReportUrl = await generateMedicalReportPdf({
      caseId: order.id,
      doctorName:
        (reportAssets.doctor && reportAssets.doctor.name) ||
        (req.user && (req.user.display_name || req.user.name)) ||
        '—',
      specialty:
        (reportAssets.specialty && reportAssets.specialty.name) ||
        order.specialty_name ||
        order.service_name ||
        '—',
      createdAt: new Date().toISOString(),
      notes: combinedNotes,
      findings: findingsText,
      impression: impressionText,
      recommendations: recommendationsText,
      // keep extras for future formatting (ignored by generator today)
      annotatedFiles,
      files: reportAssets.files,
      patient: reportAssets.patient
    });

// Persist completion using the canonical DB helper
markOrderCompleted({
  orderId,
  doctorId,
  reportUrl: generatedReportUrl,
  diagnosisText: combinedNotes,
  annotatedFiles
});

    return res.redirect(
      `/portal/doctor/case/${orderId}?report=ok&reportUrl=${encodeURIComponent(generatedReportUrl)}`
    );
  } catch (err) {
    console.error('[report] PDF workflow failed', err);
    return res.redirect(`/portal/doctor/case/${orderId}?report=fail`);
  }
});

/**
 * LEGACY: /doctor/orders/:id MUST NEVER RENDER A VIEW.
 * Always redirect to the portal case page.
 */
router.get('/doctor/orders/:id', requireRole('doctor'), (req, res) => {
  return res.redirect(302, `/portal/doctor/case/${req.params.id}`);
});

/**
 * LEGACY doctor actions kept alive (always route back to portal)
 */
function acceptHandler(req, res) {
  const doctorId = req.user.id;
  const orderId = req.params.id;
  const order = findOrderForDoctor(orderId);

  if (!order) return res.status(404).send('Order not found');
  if (order.doctor_id && order.doctor_id !== doctorId) {
    return res.status(403).send('Not your order');
  }

  if (order.status !== 'new') {
    return res.redirect(`/portal/doctor/case/${orderId}`);
  }

  acceptOrder(orderId, doctorId);
  return res.redirect(`/portal/doctor/case/${orderId}`);
}

function completeHandler(req, res) {
  // Keep legacy endpoint but route to portal completion flow
  const orderId = req.params.id;
  return res.redirect(`/portal/doctor/case/${orderId}`);
}

// Doctor requests clarification/info from patient (legacy endpoint kept)
router.post('/doctor/orders/:id/request-info', requireRole('doctor'), (req, res) => {
  const doctorId = req.user.id;
  const orderId = req.params.id;
  const message = (req.body && req.body.message ? String(req.body.message) : '').trim();

  const order = findOrderForDoctor(orderId);
  if (!order || order.doctor_id !== doctorId) {
    return res.status(403).send('Not your order');
  }

  const nowIso = new Date().toISOString();
  const eventText = message || 'Doctor requested more information';

  logOrderEvent({
    orderId,
    label: 'doctor_request',
    meta: eventText,
    actorUserId: doctorId,
    actorRole: 'doctor'
  });

  db.prepare(
    `UPDATE orders
     SET additional_files_requested = 1,
         updated_at = ?
     WHERE id = ?`
  ).run(nowIso, orderId);

  queueNotification({
    orderId,
    toUserId: order.patient_id,
    channel: 'internal',
    template: 'doctor_request_info',
    status: 'queued'
  });

  return res.redirect(`/portal/doctor/case/${orderId}`);
});

// Legacy endpoints kept
router.post('/doctor/orders/:id/accept', requireRole('doctor'), acceptHandler);
router.post('/doctor/orders/:id/complete', requireRole('doctor'), completeHandler);
router.post('/doctor/orders/:id/completed', requireRole('doctor'), completeHandler);

router.post('/doctor/orders/:id/reject', requireRole('doctor'), (req, res) => {
  const doctorId = req.user.id;
  const orderId = req.params.id;

  const order = findOrderForDoctor(orderId);
  if (!order) return res.status(404).send('Order not found');
  if (order.doctor_id !== doctorId) {
    return res.status(403).send('Not your order');
  }

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE orders
     SET status = 'cancelled',
         updated_at = ?
     WHERE id = ?`
  ).run(now, orderId);

  db.prepare(
    `INSERT INTO order_events (id, order_id, label, meta, at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(require('crypto').randomUUID(), orderId, 'Doctor rejected case', null, now);

  return res.redirect('/doctor/queue');
});

function startReviewHandler(req, res) {
  const doctorId = req.user.id;
  const orderId = req.params.id;
  const order = findOrderForDoctor(orderId);

  if (!order || order.doctor_id !== doctorId) {
    return res.status(403).send('Not your order');
  }

  if (order.status !== 'accepted' && order.status !== 'in_review') {
    return res.redirect('/doctor/queue');
  }

  const now = new Date().toISOString();
  const acceptTime = order.accepted_at || now;
  const deadlineTime =
    order.deadline_at ||
    new Date(new Date(acceptTime).getTime() + Number(order.sla_hours || 0) * 60 * 60 * 1000).toISOString();

  db.prepare(
    `UPDATE orders
     SET status = 'in_review',
         updated_at = ?,
         accepted_at = COALESCE(accepted_at, ?),
         deadline_at = COALESCE(deadline_at, ?)
     WHERE id = ?`
  ).run(now, acceptTime, deadlineTime, orderId);

  logOrderEvent({
    orderId,
    label: 'Case marked in review',
    actorUserId: doctorId,
    actorRole: 'doctor'
  });

  doctorNotify({ doctor: req.user, template: 'order_in_review', order });

  return res.redirect(`/portal/doctor/case/${orderId}`);
}

// Legacy route support
router.post('/doctor/orders/:id/start-review', requireRole('doctor'), startReviewHandler);
router.post('/doctor/orders/:id/in_review', requireRole('doctor'), startReviewHandler);
router.post('/doctor/orders/:id/in-review', requireRole('doctor'), startReviewHandler);

/**
 * Doctor alerts (portal)
 *
 * Canonical route:
 *   GET /portal/doctor/alerts
 * Legacy route:
 *   GET /doctor/alerts  -> redirects to portal
 */
router.get('/portal/doctor/alerts', requireRole('doctor'), (req, res) => {
  const doctorId = req.user.id;

  // Mark queued alerts as seen when doctor opens the alerts page.
  db.prepare("UPDATE notifications SET status='seen' WHERE to_user_id=? AND status='queued'").run(
    doctorId
  );

  // Keep the badge accurate on the page render.
  res.locals.doctorAlertCount = 0;

  const notifications = db
    .prepare(
      `SELECT id, order_id, template, status, at
       FROM notifications
       WHERE to_user_id = ?
       ORDER BY at DESC
       LIMIT 20`
    )
    .all(doctorId);

  // NOTE: For now we reuse the existing alerts view.
  // We'll upgrade it to the portal header / nav when you open the view file.
  assertRenderableView('doctor_alerts');
  return res.render('doctor_alerts', { user: req.user, notifications, lang: getLang(req, res) });
});

// Legacy URL -> keep working, but always redirect to the portal route.
router.get('/doctor/alerts', requireRole('doctor'), (req, res) => {
  return res.redirect(302, '/portal/doctor/alerts');
});

/**
 * POST /orders/:id/request-additional-files
 */
router.post('/orders/:id/request-additional-files', requireRole('doctor'), (req, res) => {
  const doctorId = req.user.id;
  const orderId = req.params.id;

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);

  if (!order || order.doctor_id !== doctorId) {
    return res.status(403).send('Not your order');
  }

  const now = new Date();

  db.prepare(
    `UPDATE orders
     SET additional_files_requested = 1,
         uploads_locked = 0,
         updated_at = ?
     WHERE id = ?`
  ).run(now.toISOString(), orderId);

  db.prepare(
    `INSERT INTO order_events (id, order_id, label, meta, at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(require('crypto').randomUUID(), orderId, 'Doctor requested additional files', null, now.toISOString());

  return res.redirect(`/portal/doctor/case/${orderId}`);
});

module.exports = router;