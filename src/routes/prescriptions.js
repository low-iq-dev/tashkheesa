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
const { queryOne } = require('../pg');
const { getAddon } = require('../services/addons/registry');
const { resolvePrescriptionAccess, ensurePrescriptionAddonRow } = require('../services/addons/prescription_access');
const { prescriptionsComingSoon } = require('../services/prescriptions_flag');

// AUDIT-2026-08-23 (C4) — the paywall this route never had.
//
// `prescription` is a paid add-on with a purchase -> fulfil -> earnings
// lifecycle in src/services/addons/prescription.js. Neither handler below
// consulted it: any doctor assigned to any case could write and deliver a
// prescription, so the add-on was free to every patient who never bought one.
//
// Review round 2 caught the obvious first draft of this gate being WORSE than
// no gate: it read only `order_addons`, which is written solely through
// safeDualWrite and is empty in production, so every patient who HAD paid at
// checkout would have been told they had not. resolvePrescriptionAccess reads
// both that table and orders.addons_json (the record the payment is actually
// tied to) — see src/services/addons/prescription_access.js.
//
// A doctor who believes a prescription is indicated on a case that did not buy
// one raises a request instead: POST /portal/doctor/case/:id/request-prescription.

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
         FROM orders_active o
         LEFT JOIN users p ON p.id = o.patient_id
         LEFT JOIN services sv ON sv.id = o.service_id
        WHERE o.id = $1 AND o.doctor_id = $2`,
      [caseId, doctorId], null
    );
    if (!order) return res.status(404).send(isAr ? 'الحالة غير موجودة' : 'Case not found');

    // Coming soon (2026-08-24) — checked BEFORE the add-on gate, so a doctor
    // who reaches this URL while the feature is held back gets "not live yet",
    // not "the patient has not purchased one". Two different statements, and
    // only one of them is true right now.
    if (prescriptionsComingSoon()) {
      return res.status(403).render('doctor_prescription_locked', {
        cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
        portalFrame: true, portalRole: 'doctor', portalActive: 'prescriptions',
        brand: 'Tashkheesa',
        title: isAr ? 'الروشتة قريباً' : 'Prescriptions coming soon',
        user: req.user, caseId: caseId,
        addonStatus: null, comingSoon: true, requestUrl: null,
        lang: lang, isAr: isAr
      });
    }

    // AUDIT-2026-08-23 (C4): no purchased add-on, no prescription form.
    var rxAccess = await resolvePrescriptionAccess(order);
    if (!rxAccess.canWrite) {
      return res.status(403).render('doctor_prescription_locked', {
        cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
        portalFrame: true,
        portalRole: 'doctor',
        portalActive: 'prescriptions',
        brand: 'Tashkheesa',
        title: isAr ? 'الوصفة غير متاحة' : 'Prescription not available',
        user: req.user,
        caseId: caseId,
        addonStatus: rxAccess.status,
        requestUrl: '/portal/doctor/case/' + encodeURIComponent(caseId) + '/request-prescription',
        lang: lang,
        isAr: isAr
      });
    }

    // Check if a prescription already exists ON THE CASE — see round 4 note on
    // the eligible-cases query. Doctor-scoped, this rendered a clean form to
    // the second specialist on a reassigned case, whose submit the POST then
    // refuses with a 409.
    var existing = await safeGet(
      'SELECT id, doctor_id FROM prescriptions WHERE order_id = $1 ORDER BY created_at ASC LIMIT 1',
      [caseId], null
    );

    // Review round 4: a case that already has a prescription gets the blocked
    // page, not the form. The POST refuses it with a 409 either way, so
    // rendering a full medication editor the doctor cannot submit only invites
    // them to type it out first — which is exactly what happened to the second
    // specialist on a reassigned case.
    if (existing) {
      return res.status(409).render('doctor_prescription_locked', {
        cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
        portalFrame: true,
        portalRole: 'doctor',
        portalActive: 'prescriptions',
        brand: 'Tashkheesa',
        title: isAr ? 'الوصفة غير متاحة' : 'Prescription not available',
        user: req.user,
        caseId: caseId,
        addonStatus: rxAccess.status,
        alreadyIssued: true,
        alreadyIssuedByMe: String(existing.doctor_id || '') === String(doctorId),
        existingPrescriptionId: (String(existing.doctor_id || '') === String(doctorId)) ? existing.id : null,
        requestUrl: null,
        lang: lang,
        isAr: isAr
      });
    }

    res.render('doctor_prescribe', {
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
      portalFrame: true,
      portalRole: 'doctor',
      portalActive: 'prescriptions',
      brand: 'Tashkheesa',
      title: isAr ? 'وصف العلاج' : 'Write Prescription',
      user: req.user,
      order: order,
      // Only linkable when it is this doctor's — the detail route authorises
      // on doctor_id. For anyone else it is still a hard block, just not a link.
      existingPrescriptionId: (existing && String(existing.doctor_id || '') === String(doctorId)) ? existing.id : null,
      prescriptionExistsOnCase: !!existing,
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
              sv.name AS service_name,
              ds.name AS doctor_specialty_name
         FROM orders_active o
         LEFT JOIN users p ON p.id = o.patient_id
         LEFT JOIN services sv ON sv.id = o.service_id
         LEFT JOIN users d ON d.id = o.doctor_id
         LEFT JOIN specialties ds ON ds.id = d.specialty_id
        WHERE o.id = $1 AND o.doctor_id = $2`,
      [caseId, doctorId], null
    );
    if (!order) return res.status(404).send(isAr ? 'الحالة غير موجودة' : 'Case not found');

    // Coming soon (2026-08-24), enforced on the write as well as the form —
    // gating only the GET would leave the POST openly craftable.
    if (prescriptionsComingSoon()) {
      return res.status(403).send(isAr
        ? 'خدمة الروشتة الرقمية غير مفعّلة بعد.'
        : 'Digital prescriptions are not live yet.');
    }

    // AUDIT-2026-08-23 (C4): enforced on the WRITE too, not only on the form.
    // Gating the GET alone would leave the POST openly craftable.
    var rxAccess = await resolvePrescriptionAccess(order);
    if (!rxAccess.canWrite) {
      return res.status(403).send(isAr
        ? 'الروشتة خدمة إضافية لم يشترها المريض لهذه الحالة.'
        : 'A prescription is a paid add-on and has not been purchased for this case.');
    }

    // Review round 3 — one prescription per case, whoever holds it.
    //
    // The GET form surfaced existingPrescriptionId but the POST checked
    // nothing, and the existence probe was scoped to the current doctor. On a
    // reassigned case the second specialist saw a clean form and could deliver
    // a second signed prescription against a single purchase — two clinicians
    // prescribing to one patient on one order, both auto-imported into their
    // medical records.
    var already = await safeGet(
      'SELECT id FROM prescriptions WHERE order_id = $1 LIMIT 1', [caseId], null
    );
    if (already) {
      return res.status(409).send(isAr
        ? 'صدرت بالفعل روشتة لهذه الحالة.'
        : 'A prescription has already been issued on this case.');
    }

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
        cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
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

    // AUDIT-2026-08-23 (C4): close the add-on lifecycle.
    //
    // Without this the add-on stays at 'paid' forever, prescription.onComplete
    // hard-refuses anything not 'fulfilled' (deliberately), and the doctor is
    // never paid the commission. prescription.onFulfill had no caller anywhere
    // in the codebase before now.
    //
    // Deliberately NOT wrapped in safeDualWrite: that helper no-ops entirely
    // when ADDON_SYSTEM_V2 is off, which would leave the paywall live and the
    // settlement dead — the doctor blocked from writing unpaid prescriptions
    // AND unpaid for the ones they do write. Fulfilment is bookkeeping on a
    // row that already exists; it is correct to run it either way. The
    // try/catch keeps a bookkeeping failure from losing the prescription the
    // doctor just wrote, which is already committed above.
    try {
      var rxSvc = getAddon('prescription');
      // Review round 3 — materialise the order_addons row when the purchase
      // exists only in orders.addons_json.
      //
      // The paywall above accepts a checkout purchase, but every downstream
      // money step needs a row: onFulfill takes one, onComplete refuses
      // anything not 'fulfilled', and addon_earnings is the only record of
      // add-on revenue. That row is written solely by onPurchase via
      // safeDualWrite, which no-ops when ADDON_SYSTEM_V2 is off. Without this
      // the doctor writes the prescription, the `if` below falls through in
      // silence, and the commission is never inserted.
      var rxRow = rxAccess.addon;
      if (!rxRow && rxAccess.needsBackfill) {
        rxRow = await ensurePrescriptionAddonRow(order, rxAccess);
      }
      if (rxSvc && rxRow && String(rxRow.status || '').toLowerCase() === 'paid') {
        var fulfilled = await rxSvc.onFulfill({
          order: order,
          addon: rxRow,
          doctor: req.user,
          payload: {
            pdf_storage_key: pdfUrl || null,
            // onFulfill requires at least one of the two. A prescription with
            // structured medications and no uploaded PDF is valid, so fall
            // back to the medication list as the text body rather than
            // letting the fulfilment throw and silently not happen.
            text_body: pdfUrl ? null : JSON.stringify({ medications: medications, diagnosis: diagnosis || null }),
            attached_by: doctorId
          }
        });

        // AUDIT-2026-08-23 (C4, review round 2) — settle immediately when the
        // case is ALREADY completed.
        //
        // Writing a prescription after the report is submitted is explicitly
        // supported: the eligible-cases query below includes 'completed' and
        // neither prescribe handler gates on status. But onComplete is only
        // called from the completion path in routes/doctor.js, which runs once
        // at report submit — i.e. before this prescription existed. Without
        // this branch the row sits at 'fulfilled' forever, no addon_earnings
        // is ever inserted, and the doctor works for free.
        var isCompletedCase = String(order.status || '').toLowerCase() === 'completed';
        if (fulfilled && isCompletedCase) {
          try {
            await rxSvc.onComplete({ order: order, addon: fulfilled, doctorId: doctorId });
          } catch (settleErr) {
            logErrorToDb(settleErr, { context: 'prescription_addon_late_settle', orderId: caseId });
          }
        }
      }
      else if (rxSvc) {
        // Round 4: this used to fire only when there was NO row, so a row in
        // any OTHER state fell through both branches in total silence. Two
        // ways that happens: canWrite is also true for an already-'fulfilled'
        // add-on, and the backfill's ON CONFLICT DO NOTHING + re-SELECT can
        // hand back a 'pending' row inserted concurrently. Either way the
        // prescription is delivered and nothing settles it, which is exactly
        // the state that has to be loud rather than silent.
        logErrorToDb(
          new Error('prescription delivered but add-on not settled (order_addons status: '
                    + (rxRow ? String(rxRow.status) : 'no row') + ') — doctor unpaid'),
          { context: 'prescription_addon_unsettled', orderId: caseId });
      }
    } catch (fulfilErr) {
      logErrorToDb(fulfilErr, { context: 'prescription_addon_fulfil', orderId: caseId });
    }

    // Future ML feed — see PHASE_2_BACKLOG.md "Medication learning loop".
    // Each signed medication entry is logged with full context (diagnosis +
    // specialty + raw medication name + dose / frequency / duration) so
    // future analysis can mine medication recommendations by diagnosis,
    // brand-vs-generic preference patterns, per-specialty norms, and
    // off-protocol anomaly detection. Internal-only — never surfaced to
    // patients or doctors directly. Wrapped in try/catch so a logging
    // failure never blocks the user-visible prescription path.
    try {
      for (var j = 0; j < medications.length; j++) {
        var m = medications[j];
        await execute(
          `INSERT INTO prescribed_medications_log
             (id, prescription_id, doctor_id, case_id, diagnosis_text,
              specialty, medication_name_raw, dosage, frequency, duration,
              instructions, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            randomUUID(), prescriptionId, doctorId, caseId,
            diagnosis || null,
            order.doctor_specialty_name || null,
            m.name,
            m.dosage || null,
            m.frequency || null,
            m.duration || null,
            m.instructions || null,
            now
          ]
        );
      }
    } catch (logErr) {
      logErrorToDb(logErr, { context: 'prescribed_medications_log_insert', prescriptionId: prescriptionId });
    }

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
      `SELECT p.*, d.name as doctor_name, s.name as specialty_name, s.name_ar as specialty_name_ar
       FROM prescriptions p
       LEFT JOIN users d ON d.id = p.doctor_id
       LEFT JOIN orders_active o ON o.id = p.order_id
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
              s.name as specialty_name,
              s.name_ar as specialty_name_ar
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

// GET /portal/doctor/prescription/:prescriptionId — Doctor's view of an issued prescription
// Mirrors the patient detail route but with doctor auth + doctor_id ownership check.
router.get('/portal/doctor/prescription/:prescriptionId', requireRole('doctor'), async function(req, res) {
  try {
    var prescriptionId = String(req.params.prescriptionId).trim();
    var doctorId = req.user.id;
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var rx = await safeGet(
      `SELECT p.*, u.name AS patient_name, u.email AS patient_email,
              u.date_of_birth AS patient_dob, u.gender AS patient_gender,
              o.id AS order_id, sv.name AS service_name
       FROM prescriptions p
       LEFT JOIN users u ON u.id = p.patient_id
       LEFT JOIN orders_active o ON o.id = p.order_id
       LEFT JOIN services sv ON sv.id = o.service_id
       WHERE p.id = $1 AND p.doctor_id = $2`,
      [prescriptionId, doctorId], null
    );
    if (!rx) return res.status(404).send(isAr ? 'الوصفة غير موجودة' : 'Prescription not found');

    var medications = [];
    try { medications = JSON.parse(rx.medications || '[]'); } catch (_) {}

    // Detect file kind BEFORE remapping pdf_url to the download endpoint
    var pdfIsImage = !!(rx.pdf_url && /\.(jpg|jpeg|png|webp|heic)$/i.test(rx.pdf_url));
    var pdfIsPdf = !!(rx.pdf_url && /\.pdf$/i.test(rx.pdf_url));
    if (rx.pdf_url) rx.pdf_url = '/portal/doctor/prescription/' + rx.id + '/download';

    res.render('doctor_prescription_detail', {
      prescription: rx,
      medications: medications,
      pdfIsImage: pdfIsImage,
      pdfIsPdf: pdfIsPdf,
      lang: lang,
      isAr: isAr,
      user: req.user,
      portalFrame: true,
      portalRole: 'doctor',
      portalActive: 'prescriptions',
      activeNav: 'prescriptions',
      brand: 'Tashkheesa',
      title: isAr ? 'تفاصيل الوصفة' : 'Prescription Details',
      pageTitle: isAr ? 'تفاصيل الوصفة' : 'Prescription Details'
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).send('Server error');
  }
});

// GET /portal/doctor/prescriptions — Doctor's prescriptions list
// Two sections:
//   1. Eligible cases — accepted by this doctor, no prescription yet (clicking opens prescribe form)
//   2. Issued prescriptions — already issued by this doctor (clicking opens detail page)
router.get('/portal/doctor/prescriptions', requireRole('doctor'), async function(req, res) {
  try {
    var doctorId = req.user.id;
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    // Eligible cases: doctor has ACTUALLY accepted (accepted_at set) AND no prescription yet.
    //
    // The `accepted_at IS NOT NULL` gate matters because the canonical
    // "doctor accepted" signal is the timestamp, not the `status` column —
    // status='accepted' is a misleading legacy state meaning 'assigned but
    // doctor has not yet clicked Accept'. See ACCEPTED_STATUSES /
    // UNACCEPTED_STATUSES in src/routes/doctor.js for context.
    //
    // Status filter mirrors ACCEPTED_STATUSES + 'completed' (a doctor may
    // write a prescription after the report is submitted). Anything else
    // — cancelled, refunded, awaiting_payment, plus the legacy 'assigned'
    // and 'accepted' states — is excluded.
    var eligibleCases = await safeAll(
      `SELECT o.id, o.status, o.created_at, o.completed_at, o.accepted_at,
              u.name AS patient_name,
              sv.name AS service_name
         FROM orders_active o
         LEFT JOIN users u ON u.id = o.patient_id
         LEFT JOIN services sv ON sv.id = o.service_id
         -- Review round 4: order-scoped, NOT doctor-scoped. Scoped to the
         -- doctor, a case whose previous specialist had already prescribed
         -- came back as "eligible" after reassignment; the new doctor filled
         -- in the whole form and the POST answered 409, throwing the work
         -- away. One prescription per case, and the list has to agree with
         -- the write gate.
         LEFT JOIN prescriptions p ON p.order_id = o.id
         LEFT JOIN order_addons oa
           ON oa.order_id = o.id
          AND oa.addon_service_id = 'prescription'
        WHERE o.doctor_id = $1
          AND p.id IS NULL
          -- AUDIT-2026-08-23 (C4): "eligible" means the patient actually bought
          -- the prescription add-on. Listing every accepted case offered the
          -- doctor a form /prescribe now refuses, and before the gate existed
          -- it handed out a paid product for free.
          --
          -- Review round 2: this must mirror resolvePrescriptionAccess exactly,
          -- or the list and the form disagree. An INNER JOIN on order_addons —
          -- the obvious first draft — would have hidden every case the patient
          -- paid for at checkout, because that row is written only through
          -- safeDualWrite and order_addons is empty in production. The real
          -- purchase record is orders.addons_json.prescription.
          --
          -- Matched with a regex rather than a ::jsonb cast on purpose:
          -- orders.addons_json is a TEXT column, and a single malformed row
          -- anywhere in the table would make the cast throw and take the whole
          -- doctor prescriptions page down with it. The pattern matches what
          -- JSON.stringify actually writes ("prescription":true) and tolerates
          -- whitespace; it can never raise.
          --
          -- The addons_json branch additionally requires the ORDER to be paid:
          -- routes/payments.js writes the selection at create-intention time,
          -- before the patient pays, so the flag alone is a shopping basket,
          -- not a receipt. Mirrors resolvePrescriptionAccess exactly.
          AND (
                (
                  o.addons_json ~ '"prescription"[[:space:]]*:[[:space:]]*true'
                  AND LOWER(COALESCE(o.payment_status, '')) IN ('paid', 'captured')
                )
                OR LOWER(COALESCE(oa.status, '')) IN ('paid', 'fulfilled')
              )
          -- An explicit cancellation/refund is newer information than the
          -- checkout flag it cancels, so it wins.
          AND LOWER(COALESCE(oa.status, '')) NOT IN ('cancelled', 'refunded')
          -- Theme 7 sub-issue D (2026-05-10): 'awaiting_files' is a
          -- transitional fallback. Migration 047 converts to
          -- 'REJECTED_FILES'; new code never writes the legacy value.
          -- Removed in a follow-up cleanup PR after 30 days.
          AND LOWER(COALESCE(o.status, '')) IN ('in_review', 'review', 'awaiting_files', 'rejected_files', 'breached', 'sla_breach', 'completed')
          AND (o.accepted_at IS NOT NULL OR LOWER(COALESCE(o.status,'')) = 'completed')
        ORDER BY o.completed_at DESC NULLS LAST, o.accepted_at DESC NULLS LAST, o.created_at DESC
        LIMIT 50`,
      [doctorId], []
    );

    // Issued prescriptions
    var prescriptions = await safeAll(
      `SELECT p.*, u.name AS patient_name, sv.name AS service_name, o.id AS order_id
       FROM prescriptions p
       LEFT JOIN users u ON u.id = p.patient_id
       LEFT JOIN orders_active o ON o.id = p.order_id
       LEFT JOIN services sv ON sv.id = o.service_id
       WHERE p.doctor_id = $1
       ORDER BY p.created_at DESC`,
      [doctorId], []
    );
    // Parse meds count for each (used for the list summary line)
    prescriptions.forEach(function(rx) {
      var count = 0;
      try { var arr = JSON.parse(rx.medications || '[]'); if (Array.isArray(arr)) count = arr.length; } catch (_) {}
      rx.medications_count = count;
    });

    const streakCount = await computeDoctorStreakCount(doctorId);

    res.render('doctor_prescriptions_list', {
      eligibleCases: eligibleCases,
      prescriptions: prescriptions,
      lang: lang,
      isAr: isAr,
      user: req.user,
      brand: process.env.BRAND_NAME || 'Tashkheesa',
      portalFrame: true,
      portalRole: 'doctor',
      portalActive: 'prescriptions',
      activeNav: 'prescriptions',
      title: isAr ? 'الوصفات' : 'Prescriptions',
      pageTitle: isAr ? 'الوصفات' : 'Prescriptions',
      streakCount
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).send('Server error');
  }
});

module.exports = router;
