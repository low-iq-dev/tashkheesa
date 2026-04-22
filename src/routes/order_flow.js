const path = require('path');
const fs = require('fs');
const express = require('express');
const { randomUUID } = require('crypto');
const { createDraftCase, submitCase } = require('../case_lifecycle');
const { queryOne, queryAll, execute } = require('../pg');
const { queueMultiChannelNotification } = require('../notify');
var { logOrderEvent } = require('../audit');
const { logError, logErrorToDb } = require('../logger');
const { validateIntakeForm, validateFiles } = require('../validators/orders');
const { sanitizeString } = require('../validators/sanitize');
const { validateMedicalImage, isImageMime, isImageExtension } = require('../ai_image_check');
var { enqueueCaseIntelligence, enqueueCaseReprocess } = require('../job_queue');
var { rateLimit } = require('express-rate-limit');
const upload = require('../middleware/upload');
const { uploadFile } = require('../storage');

// PHASE 2.5 (resolved): order_files.url is an R2 storage key, NOT a viewable URL.
// The /files/:fileId route in src/server.js auth-gates access and 302-redirects
// to a short-lived signed R2 URL (or the legacy Uploadcare URL for pre-Phase-2
// rows). All reader sites below now remap order_files.url to /files/:id before
// returning it to clients:
//   - src/routes/api/cases.js          (mobile API; cdnUrl kept for legacy app builds)
//   - src/routes/patient.js            (patient order detail + upload pages)
//   - src/routes/reports.js            (patient case report)
//   - src/routes/doctor.js             (doctor case view + intelligence view)
// Pre-existing rows containing legacy synthetic local paths (e.g. 'orders/<id>/<filename>')
// are unrecoverable — the disk that held them was wiped on prior Render deploys.
// Migration 011 + the seeder fix landed separately; nothing here depends on them.

// AI processing rate limiter: 10 requests per hour per user (keyed by user ID, falls back to IP)
var aiProcessingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  validate: false,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: function(req) {
    return (req.user && req.user.id) ? 'ai:' + req.user.id : req.ip;
  },
  message: 'AI processing limit reached (10 per hour). Please try again later.'
});

const router = express.Router();

// ═══════════════════════════════════════════════════════════
// PRE-LAUNCH GUARD: Block ALL order flow routes
// Remove this block after Feb 28 launch
// ═══════════════════════════════════════════════════════════
const PRE_LAUNCH_MODE = false;
router.use('/order', (req, res, next) => {
  if (PRE_LAUNCH_MODE) {
    return res.redirect('/coming-soon');
  }
  next();
});

async function getOrder(orderId) {
  return await queryOne('SELECT * FROM orders WHERE id = $1', [orderId]);
}

function getOrderIdFromReq(req) {
  if (!req.params || !req.params.orderId) return null;
  return String(req.params.orderId);
}

// File upload middleware (memory storage — see src/middleware/upload.js).
// File contents are pushed to Cloudflare R2 in attachFileToOrder() below.

async function attachFileToOrder(orderId, file) {
  // Push to R2; store the returned R2 key in order_files.url.
  // The /files/:fileId route in src/server.js generates a signed URL at read time.
  const key = await uploadFile({
    buffer: file.buffer,
    originalname: file.originalname,
    mimetype: file.mimetype,
    folder: 'orders/' + String(orderId),
  });
  await execute(
    `INSERT INTO order_files (id, order_id, url, label, created_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [randomUUID(), orderId, key, file.originalname]
  );
}

async function upsertCaseContext(orderId, { reason_for_review, language, urgency_flag }) {
  const exists = await queryOne('SELECT 1 FROM case_context WHERE case_id = $1', [orderId]);

  if (exists) {
    await execute(
      `UPDATE case_context
       SET reason_for_review = $1, urgency_flag = $2, language = $3
       WHERE case_id = $4`,
      [reason_for_review || '', urgency_flag ? true : false, language || 'en', orderId]
    );
  } else {
    await execute(
      `INSERT INTO case_context (case_id, reason_for_review, urgency_flag, language)
       VALUES ($1, $2, $3, $4)`,
      [orderId, reason_for_review || '', urgency_flag ? true : false, language || 'en']
    );
  }

  // Mirror to orders table
  await execute(
    `UPDATE orders
     SET language = $1, urgency_flag = $2, updated_at = NOW()
     WHERE id = $3`,
    [language || 'en', urgency_flag ? true : false, orderId]
  );
}

// PRE-LAUNCH: Redirect /order/start to Coming Soon page
router.get('/order/start', (req, res) => {
  return res.render('coming_soon');
});

/* ORIGINAL ORDER START — uncomment when ready to launch
router.get('/order/start', (req, res) => {
  const orderId = createDraftCase({
    language: 'en',
    urgency_flag: false,
    reason_for_review: ''
  });

  return res.redirect(`/order/${orderId}/upload`);
});
*/

router.get('/order/:orderId/upload', async (req, res) => {
  const orderId = String(req.params.orderId);
  const order = await getOrder(orderId);
  if (!order) return res.status(404).send('Order not found');

  // Ownership check: if a logged-in patient tries to access another patient's order, block it
  if (req.user && req.user.role === 'patient' && order.patient_id && String(order.patient_id) !== String(req.user.id)) {
    return res.status(403).send('Forbidden');
  }

  const existingFiles = await queryAll(
    'SELECT id, url, label FROM order_files WHERE order_id = $1 ORDER BY created_at DESC',
    [orderId]
  );

  const specialties = await queryAll('SELECT id, name FROM specialties WHERE COALESCE(is_visible, true) = true ORDER BY name ASC');
  const services = await queryAll(
    `SELECT sv.id, sv.name, sv.specialty_id
     FROM services sv
     JOIN specialties sp ON sp.id = sv.specialty_id AND COALESCE(sp.is_visible, true) = true
     WHERE COALESCE(sv.is_visible, true) = true
     ORDER BY sv.name ASC`
  );

  return res.render('order_upload', {
    sessionToken: orderId,
    existingFiles,
    form: {},
    specialties,
    services
  });
});

router.post('/order/:orderId/review', aiProcessingLimiter, upload.array('files'), async (req, res, next) => {
  try {
  const orderId = String(req.params.orderId);
  const order = await getOrder(orderId);
  if (!order) return res.status(404).send('Order not found');

  // Ownership check: block logged-in patients from submitting another patient's order
  if (req.user && req.user.role === 'patient' && order.patient_id && String(order.patient_id) !== String(req.user.id)) {
    return res.status(403).send('Forbidden');
  }

  const specialties = await queryAll('SELECT id, name FROM specialties WHERE COALESCE(is_visible, true) = true ORDER BY name ASC');
  const services = await queryAll(
    `SELECT sv.id, sv.name, sv.specialty_id
     FROM services sv
     JOIN specialties sp ON sp.id = sv.specialty_id AND COALESCE(sp.is_visible, true) = true
     WHERE COALESCE(sv.is_visible, true) = true
     ORDER BY sv.name ASC`
  );

  const reason = (req.body.reason || '').trim();
  const language = (req.body.language || 'en').trim();

  const urgencyChoice = req.body.urgency;
  const urgencyFlag = urgencyChoice === 'priority' || urgencyChoice === 'urgent';
  const urgency = urgencyChoice === 'urgent' ? 'urgent' : urgencyChoice === 'priority' ? 'priority' : 'standard';
  const slaHours = urgencyChoice === 'urgent' ? 4 : urgencyChoice === 'priority' ? 24 : 72;

  const patientEmail = (req.body.patient_email || '').trim();
  const patientPhone = (req.body.patient_phone || '').trim();
  const patientName = (req.body.patient_name || '').trim();

  if (!patientEmail || !patientPhone || !patientName) {
    const existingFiles = await queryAll(
      'SELECT id, url, label FROM order_files WHERE order_id = $1 ORDER BY created_at DESC',
      [orderId]
    );

    return res.status(400).render('order_upload', {
      sessionToken: orderId,
      existingFiles,
      form: req.body || {},
      specialties,
      services,
      error: 'Email and phone are required to continue.'
    });
  }

  if (!req.body.consent) {
    const existingFiles = await queryAll(
      'SELECT id, url, label FROM order_files WHERE order_id = $1 ORDER BY created_at DESC',
      [orderId]
    );

    return res.status(400).render('order_upload', {
      sessionToken: orderId,
      existingFiles,
      form: req.body || {},
      specialties,
      services,
      error: 'You must accept the Terms & Privacy Policy before continuing.'
    });
  }

  const specialtyId = req.body.specialty_id || null;
  const serviceId = req.body.service_id || null;

  if (!specialtyId || !serviceId) {
    const existingFiles = await queryAll(
      'SELECT id, url, label FROM order_files WHERE order_id = $1 ORDER BY created_at DESC',
      [orderId]
    );

    return res.status(400).render('order_upload', {
      sessionToken: orderId,
      existingFiles,
      form: req.body || {},
      specialties,
      services,
      error: 'Please select a specialty and service.'
    });
  }

  // Validate uploaded files (reject executables, oversized files)
  const existingFileCount = await queryOne('SELECT COUNT(*) as c FROM order_files WHERE order_id = $1', [orderId]);
  const fileValidation = validateFiles(req.files || [], (existingFileCount && existingFileCount.c) || 0, language);
  if (!fileValidation.valid) {
    const existingFiles2 = await queryAll(
      'SELECT id, url, label FROM order_files WHERE order_id = $1 ORDER BY created_at DESC',
      [orderId]
    );
    return res.status(400).render('order_upload', {
      sessionToken: orderId,
      existingFiles: existingFiles2,
      form: req.body || {},
      specialties,
      services,
      error: fileValidation.errors.join('. ')
    });
  }

  await execute(
    `UPDATE orders
     SET specialty_id = $1, service_id = $2, updated_at = NOW()
     WHERE id = $3`,
    [specialtyId, serviceId, orderId]
  );

  // Create/find patient
  let patient = await queryOne('SELECT id FROM users WHERE email = $1', [patientEmail]);
  if (!patient) {
    const patientId = randomUUID();
    await execute(
      `INSERT INTO users (id, email, phone, name, role, lang)
       VALUES ($1, $2, $3, $4, 'patient', $5)`,
      [patientId, patientEmail, patientPhone, patientName, language]
    );
    patient = { id: patientId };
  }

  await execute(
    `UPDATE orders SET patient_id = $1, language = $2, updated_at = NOW() WHERE id = $3`,
    [patient.id, language, orderId]
  );

  // Persist context
  await upsertCaseContext(orderId, {
    reason_for_review: reason,
    language,
    urgency_flag: urgencyFlag
  });

  // Persist files: each is uploaded to R2 inside attachFileToOrder().
  for (const file of (req.files || [])) {
    await attachFileToOrder(orderId, file);
  }

  // Case intelligence pipeline (queued via pg-boss for crash recovery)
  enqueueCaseIntelligence(orderId).catch(function(err) {
    console.error('Case intelligence enqueue failed:', err);
  });

  // AI Image Quality Check (non-blocking, best-effort)
  var aiWarnings = [];
  if (process.env.ANTHROPIC_API_KEY) {
    var service = serviceId ? await queryOne('SELECT name FROM services WHERE id = $1', [serviceId]) : null;
    var expectedType = service ? service.name : '';
    for (var fi = 0; fi < (req.files || []).length; fi++) {
      var f = req.files[fi];
      if (isImageMime(f.mimetype) || isImageExtension(f.originalname)) {
        try {
          // Memory storage: file contents already in-memory as f.buffer (no disk read needed).
          if (f.buffer) {
            var aiResult = await validateMedicalImage(f.buffer, f.mimetype, expectedType);
            if (aiResult && !aiResult.skipped) {
              // Store AI result
              try {
                var fileRec = await queryOne(
                  'SELECT id FROM order_files WHERE order_id = $1 AND label = $2 ORDER BY created_at DESC LIMIT 1',
                  [orderId, f.originalname]
                );
                await execute(
                  `INSERT INTO file_ai_checks (id, file_id, order_id, is_medical_image, image_quality, quality_issues, detected_scan_type, matches_expected, confidence, recommendation, checked_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
                  [
                    randomUUID(),
                    fileRec ? fileRec.id : null,
                    orderId,
                    aiResult.is_medical_image ? true : false,
                    aiResult.image_quality || 'unknown',
                    JSON.stringify(aiResult.quality_issues || []),
                    aiResult.detected_scan_type || 'unknown',
                    aiResult.matches_expected === true ? true : (aiResult.matches_expected === false ? false : null),
                    aiResult.confidence || 0,
                    aiResult.recommendation || ''
                  ]
                );
              } catch (_) {}
              // Collect warnings for poor quality or mismatched scans
              if (aiResult.image_quality === 'poor' || aiResult.matches_expected === false) {
                aiWarnings.push({
                  file: f.originalname,
                  quality: aiResult.image_quality,
                  issues: aiResult.quality_issues || [],
                  recommendation: aiResult.recommendation || ''
                });
              }
            }
          }
        } catch (aiErr) {
          // Non-blocking: continue if AI check fails
        }
      }
    }
  }

  const allFiles = (await queryAll(
    'SELECT id, url, label FROM order_files WHERE order_id = $1 ORDER BY created_at DESC',
    [orderId]
  )).map(f => ({ originalname: f.label, url: f.url }));

  return res.render('order_review', {
    sessionToken: orderId,
    reason,
    language,
    urgency,
    files: allFiles,
    patient_name: patientName,
    patient_email: patientEmail,
    patient_phone: patientPhone,
    sla_hours: slaHours,
    aiWarnings: aiWarnings
  });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return next(err);
  }
});

router.post('/order/:orderId/payment', async (req, res, next) => {
  try {
  const orderId = String(req.params.orderId);
  if (!req.body.sla_choice) return res.status(400).send('SLA choice is required');

  const order = await getOrder(orderId);
  if (!order) return res.status(404).send('Order not found');

  const slaChoice = req.body.sla_choice;
  const slaHours = slaChoice === 'urgent' ? 4 : slaChoice === 'priority' ? 24 : 72;
  const urgencyTier = slaChoice === 'urgent' ? 'urgent' : slaChoice === 'priority' ? 'fast_track' : 'standard';

  // Urgent order cutoff: only 07:00-19:00 Cairo time (UTC+2)
  if (slaHours <= 4) {
    const now = new Date();
    const cairoHour = new Date(now.getTime() + 2 * 60 * 60 * 1000).getUTCHours();
    if (cairoHour < 7 || cairoHour >= 19) {
      return res.status(400).json({
        error: 'urgent_unavailable',
        message: 'Urgent orders are only available between 7:00am and 7:00pm Cairo time.'
      });
    }
  }

  await execute(
    `UPDATE orders
     SET sla_hours = $1, urgency_flag = $2, urgency_tier = $3, updated_at = NOW()
     WHERE id = $4`,
    [slaHours, slaHours <= 24, urgencyTier, orderId]
  );

  return res.redirect(`/order/${orderId}/confirmation`);
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return next(err);
  }
});

router.get('/order/:orderId/confirmation', async (req, res, next) => {
  try {
  const orderId = String(req.params.orderId);
  const order = await getOrder(orderId);
  if (!order) return res.status(404).send('Order not found');

  // Submit once
  if (order.status !== 'submitted') {
    submitCase(orderId);

    // Notify patient of case submission via email + whatsapp
    if (order.patient_id) {
      try {
        const specialty = order.specialty_id
          ? await queryOne('SELECT name FROM specialties WHERE id = $1', [order.specialty_id])
          : null;
        queueMultiChannelNotification({
          orderId,
          toUserId: order.patient_id,
          channels: ['email', 'whatsapp', 'internal'],
          template: 'order_created_patient',
          response: {
            caseReference: String(orderId).slice(0, 12).toUpperCase(),
            specialty: specialty ? specialty.name : '',
            slaHours: order.sla_hours || 72,
          },
        });
      } catch (e) {
        console.error('[order_flow] notification failed after submission', e.message);
      }
    }
  }

  const currentOrder = await getOrder(orderId);
  const context = await queryOne(
    'SELECT reason_for_review, urgency_flag, language FROM case_context WHERE case_id = $1',
    [orderId]
  ) || {};

  const files = (await queryAll(
    'SELECT id, url, label, created_at FROM order_files WHERE order_id = $1 ORDER BY created_at DESC',
    [orderId]
  )).map(f => ({ ...f, originalname: f.label }));

  return res.render('order_confirmation', {
    order: {
      id: currentOrder.id,
      reason: context.reason_for_review || '',
      language: context.language || 'en',
      urgency: context.urgency_flag ? 'priority' : 'standard',
      sla_hours: currentOrder.sla_hours,
      files
    },
    reference: currentOrder.id,
    slaType: currentOrder.sla_hours <= 4 ? 'Urgent (4h)'
          : currentOrder.sla_hours === 24 ? 'Fast Track (24h)' : 'Standard (72h)',
    slaDeadline: currentOrder.sla_hours <= 4 ? '4 hours'
              : currentOrder.sla_hours === 24 ? '24 hours' : '72 hours',
    supportEmail: 'info@tashkheesa.com'
  });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Case intelligence API
// ---------------------------------------------------------------------------
var { requireAuth } = require('../middleware');

router.get('/api/cases/:id/intelligence', requireAuth(), async function(req, res) {
  try {
    var caseId = String(req.params.id);

    var caseRow = await queryOne('SELECT id, intelligence_status FROM orders WHERE id = $1', [caseId]);
    if (!caseRow) return res.status(404).json({ error: 'Case not found' });

    var status = (caseRow && caseRow.intelligence_status) || 'none';

    if (status === 'processing') {
      return res.json({ status: 'processing' });
    }

    var extraction = await queryOne(
      'SELECT lab_values, patient_info, documents_inventory, missing_documents, extraction_metadata, created_at, updated_at FROM case_extractions WHERE case_id = $1',
      [caseId]
    );

    var files = await queryAll(
      'SELECT filename, file_type, processing_status, document_category, language_detected FROM case_files WHERE case_id = $1 ORDER BY uploaded_at ASC',
      [caseId]
    );

    return res.json({
      status: status,
      extraction: extraction || null,
      files: files
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user && req.user.id });
    return res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/api/cases/:id/intelligence/reprocess', requireAuth(), aiProcessingLimiter, async function(req, res) {
  try {
    var caseId = String(req.params.id);
    var user = req.user;

    // Doctor auth only
    if (!user || user.role !== 'doctor') {
      return res.status(403).json({ error: 'Doctor access required' });
    }

    // Verify case exists
    var orderRow = await queryOne('SELECT id, doctor_id FROM orders WHERE id = $1', [caseId]);
    if (!orderRow) return res.status(404).json({ error: 'Case not found' });

    // Verify this doctor is assigned
    if (orderRow.doctor_id && String(orderRow.doctor_id) !== String(user.id)) {
      return res.status(403).json({ error: 'Not assigned to this case' });
    }

    // Queue reprocessing via pg-boss for crash recovery
    enqueueCaseReprocess(caseId).catch(function(err) {
      console.error('Case reprocess enqueue failed:', err);
    });

    return res.json({ status: 'processing', message: 'Reprocessing started' });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user && req.user.id });
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ---------------------------------------------------------------------------
// Request additional files from patient
// ---------------------------------------------------------------------------
var DEFAULT_REQUEST_FILES_EN = 'Your doctor has reviewed your uploaded files and would like you to upload additional documents for a more complete review. Please log in to your Tashkheesa portal to upload more files.';
var DEFAULT_REQUEST_FILES_AR = 'قام طبيبك بمراجعة ملفاتك المرفوعة ويرغب في رفع مستندات إضافية لمراجعة أكثر شمولاً. يرجى تسجيل الدخول إلى بوابة تشخيصة لرفع المزيد من الملفات.';

router.post('/api/cases/:id/request-files', requireAuth(), async function(req, res) {
  try {
    var caseId = String(req.params.id);
    var user = req.user;

    // Doctor auth only
    if (!user || user.role !== 'doctor') {
      return res.status(403).json({ error: 'Doctor access required' });
    }

    var order = await queryOne('SELECT id, doctor_id, patient_id, language FROM orders WHERE id = $1', [caseId]);
    if (!order) return res.status(404).json({ error: 'Case not found' });

    // Verify this doctor is assigned
    if (order.doctor_id && String(order.doctor_id) !== String(user.id)) {
      return res.status(403).json({ error: 'Not assigned to this case' });
    }

    if (!order.patient_id) {
      return res.status(400).json({ error: 'No patient linked to this case' });
    }

    // Determine message and language
    var patientLang = String(order.language || 'en').toLowerCase();
    var isAr = patientLang === 'ar';
    var customMessage = (req.body && req.body.message) ? String(req.body.message).trim() : '';
    var reason = customMessage || (isAr ? DEFAULT_REQUEST_FILES_AR : DEFAULT_REQUEST_FILES_EN);

    // Fetch patient name for email template
    var patient = await queryOne('SELECT name, lang FROM users WHERE id = $1', [order.patient_id]);
    var patientName = (patient && patient.name) || (isAr ? 'المريض' : 'Patient');
    // Use patient's own lang preference if available
    if (patient && patient.lang) {
      patientLang = String(patient.lang).toLowerCase();
      isAr = patientLang === 'ar';
      if (!customMessage) {
        reason = isAr ? DEFAULT_REQUEST_FILES_AR : DEFAULT_REQUEST_FILES_EN;
      }
    }

    var baseUrl = String(process.env.BASE_URL || process.env.APP_URL || '').replace(/\/+$/, '');
    var dashboardUrl = baseUrl ? baseUrl + '/patient/dashboard' : '/patient/dashboard';

    // Mark the order as needing additional files
    await execute(
      "UPDATE orders SET additional_files_requested = true, updated_at = NOW() WHERE id = $1",
      [caseId]
    );

    // Log to audit trail
    await logOrderEvent({
      orderId: caseId,
      label: 'doctor_requested_additional_files',
      meta: { doctorId: user.id, doctorName: user.name || '', reason: reason.slice(0, 500) },
      actorUserId: user.id,
      actorRole: 'doctor'
    });

    // Notify patient via all channels
    await queueMultiChannelNotification({
      orderId: caseId,
      toUserId: order.patient_id,
      channels: ['internal', 'email', 'whatsapp'],
      template: 'additional_files_requested_patient',
      response: {
        case_id: caseId,
        caseReference: caseId.slice(0, 12).toUpperCase(),
        patientName: patientName,
        reason: reason,
        dashboardUrl: dashboardUrl,
        doctorName: user.name || ''
      },
      dedupe_key: 'request_files:' + caseId + ':' + Date.now()
    });

    return res.json({ ok: true, message: 'File request sent to patient' });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user && req.user.id });
    return res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
