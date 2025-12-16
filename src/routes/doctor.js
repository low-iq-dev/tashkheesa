const express = require('express');
const { db } = require('../db');
const { requireRole } = require('../middleware');
const { queueNotification, doctorNotify } = require('../notify');
const { logOrderEvent } = require('../audit');
const { computeSla, enforceBreachIfNeeded } = require('../sla_status');
const { recalcSlaBreaches } = require('../sla');
const {
  markOrderInReview,
  markOrderRejectedFiles,
  markOrderCompleted
} = require('../case_lifecycle');
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

function humanStatusText(status) {
  const normalized = (status || '').toLowerCase();
  const map = {
    new: 'New',
    accepted: 'Accepted',
    in_review: 'In review',
    completed: 'Completed',
    breached: 'Overdue',
    rejected_files: 'Awaiting files',
    cancelled: 'Cancelled'
  };
  return map[normalized] || (normalized ? normalized.replace(/_/g, ' ') : 'Status');
}

function formatSlaLabel(order, sla) {
  if (!sla) return 'SLA pending';
  if (sla.isBreached || sla.minutesOverdue) {
    const overdueHours = Math.max(1, Math.ceil((sla.minutesOverdue || 0) / 60));
    return `Overdue by ${overdueHours}h`;
  }
  if (typeof sla.minutesRemaining === 'number') {
    if (sla.minutesRemaining <= 0) return 'Due now';
    if (sla.minutesRemaining < 60) return `Due in ${sla.minutesRemaining}m`;
    const hours = Math.max(1, Math.ceil(sla.minutesRemaining / 60));
    return `Due in ${hours}h`;
  }
  if (sla.isNew) return 'Awaiting acceptance';
  if (order && order.status === 'completed') return 'Completed';
  return 'Deadline pending';
}

function buildPortalCases(doctorId, statuses, limit = 6) {
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
    statusLabel: humanStatusText(order.status),
    slaLabel: formatSlaLabel(order, order.sla),
    href: `/portal/doctor/case/${order.id}`
  }));
}

function buildPortalNotifications(newCases, reviewCases) {
  const notifications = [];

  if (newCases && newCases.length) {
    const latest = newCases[0];
    notifications.push(`You have a new case assigned (${latest.reference}). ${latest.slaLabel}.`);
  } else {
    notifications.push('No new assignments right now. Stay ready for incoming cases.');
  }

  const urgent = (reviewCases || []).find(
    (c) => c.sla && typeof c.sla.minutesRemaining === 'number' && c.sla.minutesRemaining <= 6 * 60
  );
  if (urgent) {
    const hours = Math.max(1, Math.ceil(urgent.sla.minutesRemaining / 60));
    notifications.push(`SLA reminder: case ${urgent.reference} requires attention in ${hours}h.`);
  } else {
    notifications.push('SLA reminders: no immediate deadlines falling within 6h.');
  }

  const reassigned = (reviewCases || []).find((c) => Number(c.reassigned_count) > 0);
  if (reassigned) {
    notifications.push(`Case ${reassigned.reference} was reassigned to you after a follow-up review.`);
  } else {
    notifications.push('No recent reassignments. Keep pushing your current reviews forward.');
  }

  return notifications;
}

function portalCaseStage(status) {
  const normalized = (status || '').toLowerCase();
  if (normalized === 'new') return 'accept';
  if (normalized === 'completed') return 'completed';
  if (normalized === 'rejected_files') return 'rejected';
  if (normalized === 'accepted' || normalized === 'in_review') return 'review';
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
  const activeConditions = ['o.doctor_id = ?', "o.status IN ('accepted','in_review')"];
  const activeParams = [doctorId];
  if (filters.sla) {
    activeConditions.push('o.sla_hours = ?');
    activeParams.push(filters.sla);
  }
  if (filters.specialty) {
    activeConditions.push('o.specialty_id = ?');
    activeParams.push(filters.specialty);
  }
  if (status === 'accepted' || status === 'in_review') {
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
  const doctorId = req.user.id;
  const orderId = req.params.caseId;
  const order = findOrderForDoctor(orderId);

  if (!order) return res.status(404).send('Case not found');
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
    order,
    slaLabel: formatSlaLabel(order, computed.sla),
    sla: computed.sla,
    files: files.map((file) => ({
      name: file.label || extractFileName(file.url),
      url: file.url
    })),
    annotatedFiles: additionalFiles.map((row) => row.file_url),
    clinicalContext,
    stage,
    statusLabel: humanStatusText(order.status),
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
  const doctorId = req.user.id;

  const newCases = buildPortalCases(doctorId, ['new'], 6);
  const reviewCases = buildPortalCases(doctorId, ['accepted', 'in_review'], 8);
  const completedCases = buildPortalCases(doctorId, ['completed'], 6);
  const notifications = buildPortalNotifications(newCases, reviewCases);

  assertRenderableView('portal_doctor_dashboard');
  res.render('portal_doctor_dashboard', {
    user: req.user,
    newCases,
    reviewCases,
    completedCases,
    notifications
  });
});

router.get('/portal/doctor/case/:caseId', requireRole('doctor'), (req, res) => {
  console.log('✅ HIT PORTAL CASE ROUTE:', req.params.caseId);
  return renderPortalCasePage(req, res);
});

router.post('/portal/doctor/case/:caseId/accept', requireRole('doctor'), (req, res) => {
  const doctorId = req.user.id;
  const orderId = req.params.caseId;
  const order = findOrderForDoctor(orderId);

  if (!order) return res.status(404).send('Case not found');
  if (order.doctor_id && order.doctor_id !== doctorId) {
    return res.status(403).send('Not your order');
  }
  if (order.status !== 'new') {
    return res.redirect(`/portal/doctor/case/${orderId}`);
  }

  markOrderInReview({ orderId, doctorId });
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

  const diagnosisText = req.body && req.body.diagnosis ? String(req.body.diagnosis).trim() : '';
  const nowIso = new Date().toISOString();

  db.prepare(
    `UPDATE orders
     SET diagnosis_text = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(diagnosisText || null, nowIso, orderId);

  logOrderEvent({
    orderId,
    label: 'Doctor saved medical opinion',
    meta: JSON.stringify({ via: 'doctor_portal', diagnosis_saved: !!diagnosisText }),
    actorUserId: doctorId,
    actorRole: 'doctor'
  });

  return renderPortalCasePage(req, res, { successMessage: 'Medical opinion saved.' });
});

router.post('/portal/doctor/case/:caseId/report', requireRole('doctor'), (req, res) => {
  const doctorId = req.user.id;
  const orderId = req.params.caseId;
  const order = findOrderForDoctor(orderId);

  if (!order) return res.status(404).send('Case not found');
  if (order.doctor_id && order.doctor_id !== doctorId) {
    return res.status(403).send('Not your order');
  }

  const actionable = ['accepted', 'in_review', 'rejected_files'];
  if (!actionable.includes(order.status)) {
    return res.redirect(`/portal/doctor/case/${orderId}`);
  }

  const diagnosisText = req.body && req.body.diagnosis ? String(req.body.diagnosis).trim() : '';
  const annotatedRaw = req.body && req.body.annotated_files ? String(req.body.annotated_files) : '';
  const annotatedFiles = annotatedRaw
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value);

  if (!diagnosisText) {
    return renderPortalCasePage(req, res, {
      errorMessage: 'Please provide the final diagnosis before completing the case.'
    });
  }

  const reportAssets = loadReportAssets(order);
  try {
    const generatedReportUrl = generateMedicalReportPdf({
      order,
      patient: reportAssets.patient,
      doctor: reportAssets.doctor,
      specialty: reportAssets.specialty,
      diagnosisText,
      files: reportAssets.files,
      annotatedFiles,
      doctorId
    });

    markOrderCompleted({
      orderId,
      doctorId,
      reportUrl: generatedReportUrl,
      diagnosisText,
      annotatedFiles
    });

    return res.redirect(`/portal/doctor/case/${orderId}`);
  } catch (err) {
    console.error('[report] PDF workflow failed', err);
    return renderPortalCasePage(req, res, {
      errorMessage: 'Report generation failed. Please try again or contact support.'
    });
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

  markOrderInReview({ orderId, doctorId });
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
 * Doctor alerts
 */
router.get('/doctor/alerts', requireRole('doctor'), (req, res) => {
  const doctorId = req.user.id;
  db.prepare("UPDATE notifications SET status='seen' WHERE to_user_id=? AND status='queued'").run(
    doctorId
  );
  const notifications = db
    .prepare(
      `SELECT id, order_id, template, status, at
       FROM notifications
       WHERE to_user_id = ?
       ORDER BY at DESC
       LIMIT 20`
    )
    .all(doctorId);
  res.render('doctor_alerts', { user: req.user, notifications });
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