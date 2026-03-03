const multer = require('multer');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { randomUUID } = require('crypto');
const { createDraftCase, submitCase } = require('../case_lifecycle');
const { queryOne, queryAll, execute } = require('../pg');
const { queueMultiChannelNotification } = require('../notify');
const { logError, logErrorToDb } = require('../logger');
const { validateIntakeForm, validateFiles } = require('../validators/orders');
const { sanitizeString } = require('../validators/sanitize');
const { validateMedicalImage, isImageMime, isImageExtension } = require('../ai_image_check');

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

const upload = multer({ storage });

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

router.post('/order/:orderId/review', upload.array('files'), async (req, res, next) => {
  try {
  const orderId = String(req.params.orderId);
  const order = await getOrder(orderId);
  if (!order) return res.status(404).send('Order not found');

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

module.exports = router;
