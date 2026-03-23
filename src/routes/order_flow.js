const multer = require('multer');
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
var { processCaseIntelligence, reprocessCase } = require('../case-intelligence');
var { rateLimit } = require('express-rate-limit');

// AI processing rate limiter: 10 requests per hour per user (keyed by user ID, falls back to IP)
var aiProcessingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
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

const uploadRoot = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(uploadRoot)) fs.mkdirSync(uploadRoot, { recursive: true });

function getOrderIdFromReq(req) {
  if (!req.params || !req.params.orderId) return null;
  return String(req.params.orderId);
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const orderId = getOrderIdFromReq(req);
    if (!orderId) return cb(new Error('order_id_missing'));
    const dir = path.join(uploadRoot, 'orders', String(orderId));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, Date.now() + '_' + safeName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // P1 #8: 50 MB max per file
  fileFilter: function(req, file, cb) {
    // P1-B FIX: Validate MIME type before accepting file to disk
    const ALLOWED_MIMES = new Set([
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/tiff',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/dicom', 'application/octet-stream' // DICOM files
    ]);
    const DANGEROUS_EXTS = new Set(['.exe','.bat','.cmd','.sh','.ps1','.vbs','.js','.msi','.com','.scr','.pif','.php','.py','.rb','.pl']);
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (DANGEROUS_EXTS.has(ext)) {
      return cb(new Error('File type not allowed: ' + file.originalname));
    }
    if (!ALLOWED_MIMES.has(file.mimetype)) {
      // Allow unknown MIME for DICOM (.dcm) which browsers often report as application/octet-stream
      if (ext !== '.dcm' && ext !== '.doc' && ext !== '.docx' && ext !== '.pdf') {
        return cb(new Error('File MIME type not allowed: ' + file.mimetype));
      }
    }
    cb(null, true);
  }
});

async function attachFileToOrder(orderId, file) {
  // Store internal path only (no public exposure)
  const internalPath = path.join('orders', String(orderId), file.filename);
  await execute(
    `INSERT INTO order_files (id, order_id, url, label, created_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [randomUUID(), orderId, internalPath, file.originalname]
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
    'SELECT url, label FROM order_files WHERE order_id = $1 ORDER BY created_at DESC',
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

  const urgencyFlag = req.body.urgency === 'priority';
  const urgency = urgencyFlag ? 'priority' : 'standard';
  const slaHours = urgencyFlag ? 24 : 72;

  const patientEmail = (req.body.patient_email || '').trim();
  const patientPhone = (req.body.patient_phone || '').trim();
  const patientName = (req.body.patient_name || '').trim();

  if (!patientEmail || !patientPhone || !patientName) {
    const existingFiles = await queryAll(
      'SELECT url, label FROM order_files WHERE order_id = $1 ORDER BY created_at DESC',
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
      'SELECT url, label FROM order_files WHERE order_id = $1 ORDER BY created_at DESC',
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
      'SELECT url, label FROM order_files WHERE order_id = $1 ORDER BY created_at DESC',
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
      'SELECT url, label FROM order_files WHERE order_id = $1 ORDER BY created_at DESC',
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

  // Persist files
  const uploadedFiles = (req.files || []).map(f => ({
    filename: f.filename,
    originalname: f.originalname
  }));

  for (const file of uploadedFiles) {
    await attachFileToOrder(orderId, file);
  }

  // Case intelligence pipeline (async — runs in background, does not block response)
  processCaseIntelligence(orderId).catch(function(err) {
    console.error('Case intelligence failed:', err);
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
          var filePath = path.resolve(__dirname, '..', '..', 'uploads', 'orders', orderId, f.filename);
          if (fs.existsSync(filePath)) {
            var imgBuf = fs.readFileSync(filePath);
            var aiResult = await validateMedicalImage(imgBuf, f.mimetype, expectedType);
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
    'SELECT url, label FROM order_files WHERE order_id = $1 ORDER BY created_at DESC',
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

  const slaHours = req.body.sla_choice === 'priority' ? 24 : 72;

  await execute(
    `UPDATE orders
     SET sla_hours = $1, urgency_flag = $2, updated_at = NOW()
     WHERE id = $3`,
    [slaHours, slaHours === 24 ? true : false, orderId]
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
    'SELECT url, label, created_at FROM order_files WHERE order_id = $1 ORDER BY created_at DESC',
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
    slaType: currentOrder.sla_hours === 24 ? 'Fast Track (24h)' : 'Standard (72h)',
    slaDeadline: currentOrder.sla_hours === 24 ? '24 hours' : '72 hours',
    supportEmail: 'support@tashkheesa.com'
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

    var caseRow = await queryOne('SELECT id, intelligence_status FROM cases WHERE id = $1', [caseId]);
    if (!caseRow) {
      // Fall back to orders table (orders use the same id namespace)
      var orderRow = await queryOne('SELECT id FROM orders WHERE id = $1', [caseId]);
      if (!orderRow) return res.status(404).json({ error: 'Case not found' });
    }

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

    // Fire reprocessing in background
    reprocessCase(caseId).catch(function(err) {
      console.error('Case reprocess failed:', err);
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
