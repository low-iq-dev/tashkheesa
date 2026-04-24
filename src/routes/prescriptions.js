// src/routes/prescriptions.js
// Prescription Management (Phase 7) — files stored in Cloudflare R2 (Phase 3 migration).
// pdf_url stores an R2 storage key (e.g. 'prescriptions/<uuid>.pdf'). Download routes
// 302-redirect to a short-lived signed URL. Legacy rows where pdf_url is an http(s)
// URL (Uploadcare era) are passed through unchanged.

const express = require('express');
const path = require('path');
const { randomUUID } = require('crypto');
const { execute } = require('../pg');
const { requireRole } = require('../middleware');
const { sanitizeHtml, sanitizeString } = require('../validators/sanitize');
const { logErrorToDb } = require('../logger');
const { safeAll, safeGet } = require('../sql-utils');
const { queueMultiChannelNotification } = require('../notify');
const upload = require('../middleware/upload');
const { uploadFile, getSignedDownloadUrl } = require('../storage');
const { computeDoctorStreakCount } = require('./messaging');

const router = express.Router();

// GET /portal/doctor/case/:caseId/prescribe — Prescription form
router.get('/portal/doctor/case/:caseId/prescribe', requireRole('doctor'), async function(req, res) {
  try {
    var caseId = String(req.params.caseId).trim();
    var doctorId = req.user.id;
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var order = await safeGet(
      `SELECT o.*,
              p.name AS patient_name,
              p.date_of_birth AS patient_dob,
              p.gender AS patient_gender,
              sv.name AS service_name
         FROM orders o
         LEFT JOIN users p ON p.id = o.patient_id
         LEFT JOIN services sv ON sv.id = o.service_id
        WHERE o.id = $1 AND o.doctor_id = $2`,
      [caseId, doctorId], null
    );
    if (!order) return res.status(404).send(isAr ? 'الحالة غير موجودة' : 'Case not found');

    // Check if prescription already exists
    var existing = await safeGet('SELECT id FROM prescriptions WHERE order_id = $1 AND doctor_id = $2', [caseId, doctorId], null);

    res.render('doctor_prescribe', {
      portalFrame: true,
      portalRole: 'doctor',
      portalActive: 'prescriptions',
      brand: 'Tashkheesa',
      title: isAr ? 'وصف العلاج' : 'Write Prescription',
      user: req.user,
      order: order,
      existingPrescriptionId: existing ? existing.id : null,
      lang: lang,
      isAr: isAr,
      pageTitle: isAr ? 'وصف العلاج' : 'Write Prescription'
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).send('Server error');
  }
});

// POST /portal/doctor/case/:caseId/prescribe — Upload prescription file
router.post('/portal/doctor/case/:caseId/prescribe', requireRole('doctor'), upload.single('prescription_file'), async function(req, res) {
  try {
    var caseId = String(req.params.caseId).trim();
    var doctorId = req.user.id;
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var order = await safeGet(
      `SELECT o.*,
              p.name AS patient_name,
              p.email AS patient_email,
              p.date_of_birth AS patient_dob,
              p.gender AS patient_gender,
              sv.name AS service_name
         FROM orders o
         LEFT JOIN users p ON p.id = o.patient_id
         LEFT JOIN services sv ON sv.id = o.service_id
        WHERE o.id = $1 AND o.doctor_id = $2`,
      [caseId, doctorId], null
    );
    if (!order) return res.status(404).send(isAr ? 'الحالة غير موجودة' : 'Case not found');

    var notes = sanitizeHtml(sanitizeString(req.body.notes || '', 5000));
    var diagnosis = sanitizeHtml(sanitizeString(req.body.diagnosis || '', 5000));

    // Build structured medications from form arrays (med_name[], med_dosage[], etc.)
    var medications = [];
    var medNames = [].concat(req.body.med_name || []);
    var medDosages = [].concat(req.body.med_dosage || []);
    var medFrequencies = [].concat(req.body.med_frequency || []);
    var medDurations = [].concat(req.body.med_duration || []);
    for (var i = 0; i < medNames.length; i++) {
      var name = sanitizeString(medNames[i] || '', 200).trim();
      if (!name) continue; // skip empty rows
      medications.push({
        name: name,
        dosage: sanitizeString(medDosages[i] || '', 100),
        frequency: sanitizeString(medFrequencies[i] || '', 200),
        duration: sanitizeString(medDurations[i] || '', 200),
        instructions: ''
      });
    }

    // Require at least one medication OR an uploaded file
    if (!req.file && medications.length === 0) {
      return res.render('doctor_prescribe', {
        portalFrame: true,
        portalRole: 'doctor',
        portalActive: 'prescriptions',
        brand: 'Tashkheesa',
        title: isAr ? 'وصف العلاج' : 'Write Prescription',
        user: req.user,
        order: order,
        existingPrescriptionId: null,
        lang: lang,
        isAr: isAr,
        pageTitle: isAr ? 'وصف العلاج' : 'Write Prescription',
        error: isAr ? 'يرجى إضافة دواء واحد على الأقل أو رفع ملف الوصفة' : 'Please add at least one medication or upload a prescription file'
      });
    }

    var prescriptionId = randomUUID();
    var now = new Date().toISOString();

    // Upload prescription file to R2 (Phase 3). Memory storage from
    // src/middleware/upload.js gives us req.file.buffer. The returned key is
    // stored in pdf_url; download routes generate a signed URL on demand.
    var pdfUrl = null;
    var pdfFileName = null;
    if (req.file) {
      pdfUrl = await uploadFile({
        buffer: req.file.buffer,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        folder: 'prescriptions'
      });
      pdfFileName = req.file.originalname;
    }

    await execute(
      `INSERT INTO prescriptions (id, order_id, doctor_id, patient_id, medications, diagnosis, notes, is_active, valid_until, pdf_url, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, $10, $11)`,
      [prescriptionId, caseId, doctorId, order.patient_id, JSON.stringify(medications), diagnosis || null, notes || null, null, pdfUrl, now, now]
    );

    // Auto-import prescription into medical_records for the patient
    try {
      var recordTitle = isAr ? 'وصفة طبية' : 'Prescription';
      await execute(
        `INSERT INTO medical_records (id, patient_id, record_type, title, description, file_url, file_name, date_of_record, provider, is_shared_with_doctors, created_at)
         VALUES ($1, $2, 'prescription', $3, $4, $5, $6, $7, $8, true, $9)`,
        [
          randomUUID(), order.patient_id, recordTitle,
          notes || null,
          pdfUrl, pdfFileName,
          now.slice(0, 10), req.user.name || 'Doctor', now
        ]
      );
    } catch (recErr) {
      logErrorToDb(recErr, { context: 'prescription_auto_import_medical_records', prescriptionId: prescriptionId });
    }

    // Notify patient that prescription was uploaded
    try {
      queueMultiChannelNotification({
        orderId: caseId,
        toUserId: order.patient_id,
        channels: ['internal', 'email', 'whatsapp'],
        template: 'prescription_uploaded_patient',
        response: {
          case_id: caseId,
          caseReference: caseId.slice(0, 12).toUpperCase(),
          doctorName: req.user.name || 'Your doctor'
        },
        dedupe_key: 'prescription:' + caseId + ':' + prescriptionId
      });
    } catch (_) {}

    return res.redirect('/portal/doctor/case/' + caseId);
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).send('Server error');
  }
});

// GET /portal/patient/prescriptions — List all prescriptions
router.get('/portal/patient/prescriptions', requireRole('patient'), async function(req, res) {
  try {
    var patientId = req.user.id;
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var prescriptions = await safeAll(
      `SELECT p.*, d.name as doctor_name, s.name as specialty_name
       FROM prescriptions p
       LEFT JOIN users d ON d.id = p.doctor_id
       LEFT JOIN orders o ON o.id = p.order_id
       LEFT JOIN specialties s ON s.id = o.specialty_id
       WHERE p.patient_id = $1
       ORDER BY p.created_at DESC`,
      [patientId], []
    );
    // Phase 3: pdf_url is an R2 storage key — route through the patient
    // download endpoint so the template's truthy check + href both work.
    prescriptions.forEach(function(rx) {
      if (rx.pdf_url) rx.pdf_url = '/portal/patient/prescription/' + rx.id + '/download';
    });

    res.render('patient_prescriptions', {
      prescriptions: prescriptions,
      lang: lang,
      isAr: isAr,
      portalFrame: true,
      portalRole: 'patient',
      portalActive: 'prescriptions',
      brand: 'Tashkheesa',
      title: isAr ? 'وصفاتي الطبية' : 'My Prescriptions',
      user: req.user,
      pageTitle: isAr ? 'وصفاتي الطبية' : 'My Prescriptions'
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).send('Server error');
  }
});

// GET /portal/patient/prescription/:prescriptionId — View single prescription
router.get('/portal/patient/prescription/:prescriptionId', requireRole('patient'), async function(req, res) {
  try {
    var prescriptionId = String(req.params.prescriptionId).trim();
    var patientId = req.user.id;
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var rx = await safeGet(
      `SELECT p.*, d.name as doctor_name, d.specialty_id,
              s.name as specialty_name
       FROM prescriptions p
       LEFT JOIN users d ON d.id = p.doctor_id
       LEFT JOIN specialties s ON s.id = d.specialty_id
       WHERE p.id = $1 AND p.patient_id = $2`,
      [prescriptionId, patientId], null
    );
    if (!rx) return res.status(404).send(isAr ? 'الوصفة غير موجودة' : 'Prescription not found');

    var medications = [];
    try { medications = JSON.parse(rx.medications || '[]'); } catch (_) {}

    // Phase 3: detect file type from the original R2 key BEFORE remapping
    // pdf_url to the download endpoint (the template can't infer ext from
    // a /download URL).
    var pdfIsImage = !!(rx.pdf_url && /\.(jpg|jpeg|png|webp|heic)$/i.test(rx.pdf_url));
    var pdfIsPdf = !!(rx.pdf_url && /\.pdf$/i.test(rx.pdf_url));
    if (rx.pdf_url) rx.pdf_url = '/portal/patient/prescription/' + rx.id + '/download';

    res.render('patient_prescription_detail', {
      prescription: rx,
      medications: medications,
      pdfIsImage: pdfIsImage,
      pdfIsPdf: pdfIsPdf,
      lang: lang,
      isAr: isAr,
      portalFrame: true,
      portalRole: 'patient',
      portalActive: 'prescriptions',
      brand: 'Tashkheesa',
      title: isAr ? 'تفاصيل الوصفة' : 'Prescription Details',
      user: req.user,
      pageTitle: isAr ? 'تفاصيل الوصفة' : 'Prescription Details'
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).send('Server error');
  }
});

// GET /portal/patient/prescription/:prescriptionId/download — 302 to signed R2 URL
router.get('/portal/patient/prescription/:prescriptionId/download', requireRole('patient'), async function(req, res) {
  try {
    var prescriptionId = String(req.params.prescriptionId).trim();
    var patientId = req.user.id;

    var rx = await safeGet('SELECT pdf_url FROM prescriptions WHERE id = $1 AND patient_id = $2', [prescriptionId, patientId], null);
    if (!rx || !rx.pdf_url) return res.status(404).send('PDF not available');

    var key = String(rx.pdf_url).trim();
    // Legacy: pre-Phase-3 rows may store an http(s) URL (e.g. Uploadcare). Pass through.
    if (/^https?:\/\//i.test(key)) {
      return res.redirect(302, key);
    }

    var ext = path.extname(key) || '.pdf';
    var downloadName = 'prescription-' + prescriptionId.slice(0, 8) + ext;
    var signedUrl = await getSignedDownloadUrl(key, 3600, { downloadName: downloadName });
    return res.redirect(302, signedUrl);
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user && req.user.id });
    return res.status(500).send('Server error');
  }
});

// GET /portal/doctor/prescription/:prescriptionId/download — 302 to signed R2 URL
// Mirrors the patient route but with doctor auth + doctor_id ownership check.
// Added in Phase 3 because the doctor prescriptions list template links straight
// to pdf_url and post-migration that's an R2 key, not a viewable URL.
router.get('/portal/doctor/prescription/:prescriptionId/download', requireRole('doctor'), async function(req, res) {
  try {
    var prescriptionId = String(req.params.prescriptionId).trim();
    var doctorId = req.user.id;

    var rx = await safeGet('SELECT pdf_url FROM prescriptions WHERE id = $1 AND doctor_id = $2', [prescriptionId, doctorId], null);
    if (!rx || !rx.pdf_url) return res.status(404).send('PDF not available');

    var key = String(rx.pdf_url).trim();
    if (/^https?:\/\//i.test(key)) {
      return res.redirect(302, key);
    }

    var ext = path.extname(key) || '.pdf';
    var downloadName = 'prescription-' + prescriptionId.slice(0, 8) + ext;
    var signedUrl = await getSignedDownloadUrl(key, 3600, { downloadName: downloadName });
    return res.redirect(302, signedUrl);
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user && req.user.id });
    return res.status(500).send('Server error');
  }
});

// PUT /portal/doctor/prescription/:prescriptionId — Edit prescription
router.put('/portal/doctor/prescription/:prescriptionId', requireRole('doctor'), async function(req, res) {
  try {
    var prescriptionId = String(req.params.prescriptionId).trim();
    var doctorId = req.user.id;
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var rx = await safeGet('SELECT * FROM prescriptions WHERE id = $1 AND doctor_id = $2', [prescriptionId, doctorId], null);
    if (!rx) return res.status(404).json({ ok: false, error: isAr ? 'الوصفة غير موجودة' : 'Prescription not found' });

    var medications;
    try {
      medications = JSON.parse(req.body.medications || '[]');
    } catch (_) {
      return res.status(400).json({ ok: false, error: 'Invalid medications data' });
    }

    if (!Array.isArray(medications) || medications.length === 0) {
      return res.status(400).json({ ok: false, error: isAr ? 'يجب إضافة دواء واحد على الأقل' : 'At least one medication is required' });
    }

    for (var i = 0; i < medications.length; i++) {
      var med = medications[i];
      if (!med.name || !med.dosage || !med.frequency) {
        return res.status(400).json({ ok: false, error: 'Name, dosage, and frequency required' });
      }
      medications[i] = {
        name: sanitizeString(med.name, 200),
        dosage: sanitizeString(med.dosage, 100),
        frequency: sanitizeString(med.frequency, 200),
        duration: sanitizeString(med.duration || '', 200),
        instructions: sanitizeString(med.instructions || '', 500)
      };
    }

    var diagnosis = sanitizeHtml(sanitizeString(req.body.diagnosis || '', 5000));
    var notes = sanitizeHtml(sanitizeString(req.body.notes || '', 5000));
    var now = new Date().toISOString();

    await execute(
      'UPDATE prescriptions SET medications = $1, diagnosis = $2, notes = $3, updated_at = $4 WHERE id = $5',
      [JSON.stringify(medications), diagnosis || null, notes || null, now, prescriptionId]
    );

    return res.json({ ok: true, message: isAr ? 'تم تحديث الوصفة' : 'Prescription updated' });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /portal/doctor/prescriptions — Doctor's prescriptions list
router.get('/portal/doctor/prescriptions', requireRole('doctor'), async function(req, res) {
  try {
    var doctorId = req.user.id;
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var prescriptions = await safeAll(
      `SELECT p.*, u.name AS patient_name, sv.name AS service_name
       FROM prescriptions p
       LEFT JOIN users u ON u.id = p.patient_id
       LEFT JOIN orders o ON o.id = p.order_id
       LEFT JOIN services sv ON sv.id = o.service_id
       WHERE p.doctor_id = $1
       ORDER BY p.created_at DESC`,
      [doctorId], []
    );
    // Phase 3: pdf_url is an R2 storage key — route through the doctor
    // download endpoint so the template's anchor href resolves to a signed URL.
    prescriptions.forEach(function(rx) {
      if (rx.pdf_url) rx.pdf_url = '/portal/doctor/prescription/' + rx.id + '/download';
    });

    const streakCount = await computeDoctorStreakCount(doctorId);

    res.render('doctor_prescriptions_list', {
      prescriptions: prescriptions,
      lang: lang,
      isAr: isAr,
      user: req.user,
      brand: process.env.BRAND_NAME || 'Tashkheesa',
      portalFrame: true,
      portalRole: 'doctor',
      portalActive: 'prescriptions',
      streakCount
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).send('Server error');
  }
});

module.exports = router;
