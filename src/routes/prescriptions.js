// src/routes/prescriptions.js
// Prescription Management (Phase 7)

const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { db } = require('../db');
const { requireRole } = require('../middleware');
const { sanitizeHtml, sanitizeString } = require('../validators/sanitize');
const { logErrorToDb } = require('../logger');
const { safeAll, safeGet } = require('../sql-utils');

const router = express.Router();

const PRESCRIPTIONS_DIR = path.join(process.cwd(), 'public', 'prescriptions');

function ensurePrescriptionsDir() {
  try { fs.mkdirSync(PRESCRIPTIONS_DIR, { recursive: true }); } catch (_) {}
  return PRESCRIPTIONS_DIR;
}

// GET /portal/doctor/case/:caseId/prescribe — Prescription form
router.get('/portal/doctor/case/:caseId/prescribe', requireRole('doctor'), function(req, res) {
  try {
    var caseId = String(req.params.caseId).trim();
    var doctorId = req.user.id;
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var order = safeGet(
      'SELECT o.*, p.name as patient_name FROM orders o LEFT JOIN users p ON p.id = o.patient_id WHERE o.id = ? AND o.doctor_id = ?',
      [caseId, doctorId], null
    );
    if (!order) return res.status(404).send(isAr ? 'الحالة غير موجودة' : 'Case not found');

    // Check if prescription already exists
    var existing = safeGet('SELECT id FROM prescriptions WHERE order_id = ? AND doctor_id = ?', [caseId, doctorId], null);

    res.render('doctor_prescribe', {
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

// POST /portal/doctor/case/:caseId/prescribe — Create prescription
router.post('/portal/doctor/case/:caseId/prescribe', requireRole('doctor'), function(req, res) {
  try {
    var caseId = String(req.params.caseId).trim();
    var doctorId = req.user.id;
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var order = safeGet(
      'SELECT o.*, p.name as patient_name, p.email as patient_email FROM orders o LEFT JOIN users p ON p.id = o.patient_id WHERE o.id = ? AND o.doctor_id = ?',
      [caseId, doctorId], null
    );
    if (!order) return res.status(404).json({ ok: false, error: isAr ? 'الحالة غير موجودة' : 'Case not found' });

    // Parse medications (JSON array)
    var medications;
    try {
      medications = JSON.parse(req.body.medications || '[]');
    } catch (_) {
      return res.status(400).json({ ok: false, error: isAr ? 'بيانات الأدوية غير صالحة' : 'Invalid medications data' });
    }

    if (!Array.isArray(medications) || medications.length === 0) {
      return res.status(400).json({ ok: false, error: isAr ? 'يجب إضافة دواء واحد على الأقل' : 'At least one medication is required' });
    }

    // Validate each medication
    for (var i = 0; i < medications.length; i++) {
      var med = medications[i];
      if (!med.name || !med.dosage || !med.frequency) {
        return res.status(400).json({
          ok: false,
          error: isAr ? 'اسم الدواء والجرعة والتكرار مطلوبة' : 'Medication name, dosage, and frequency are required'
        });
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
    var validUntil = sanitizeString(req.body.valid_until || '', 10).trim();

    if (validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) {
      validUntil = '';
    }

    var prescriptionId = randomUUID();
    var now = new Date().toISOString();
    var medicationsJson = JSON.stringify(medications);

    // Generate PDF
    var pdfUrl = null;
    try {
      pdfUrl = generatePrescriptionPdf(prescriptionId, {
        patientName: order.patient_name || 'Patient',
        doctorName: req.user.name || 'Doctor',
        medications: medications,
        diagnosis: diagnosis,
        notes: notes,
        validUntil: validUntil,
        date: now
      });
    } catch (pdfErr) {
      logErrorToDb(pdfErr, { context: 'prescription_pdf_generation', prescriptionId: prescriptionId });
      // Continue without PDF
    }

    db.prepare(
      `INSERT INTO prescriptions (id, order_id, doctor_id, patient_id, medications, diagnosis, notes, is_active, valid_until, pdf_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
    ).run(prescriptionId, caseId, doctorId, order.patient_id, medicationsJson, diagnosis || null, notes || null, validUntil || null, pdfUrl, now, now);

    // Auto-import prescription into medical_records for the patient
    try {
      var medNames = medications.map(function(m) { return m.name; }).join(', ');
      var recordTitle = (isAr ? 'وصفة طبية: ' : 'Prescription: ') + medNames.slice(0, 120);
      db.prepare(
        `INSERT INTO medical_records (id, patient_id, record_type, title, description, file_url, file_name, date_of_record, provider, is_shared_with_doctors, created_at)
         VALUES (?, ?, 'prescription', ?, ?, ?, ?, ?, ?, 1, ?)`
      ).run(
        randomUUID(), order.patient_id, recordTitle,
        diagnosis || notes || null,
        pdfUrl, pdfUrl ? ('rx-' + prescriptionId.slice(0, 8) + '.pdf') : null,
        now.slice(0, 10), req.user.name || 'Doctor', now
      );
    } catch (recErr) {
      logErrorToDb(recErr, { context: 'prescription_auto_import_medical_records', prescriptionId: prescriptionId });
    }

    return res.json({ ok: true, prescriptionId: prescriptionId, message: isAr ? 'تم حفظ الوصفة الطبية' : 'Prescription saved' });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /portal/patient/prescriptions — List all prescriptions
router.get('/portal/patient/prescriptions', requireRole('patient'), function(req, res) {
  try {
    var patientId = req.user.id;
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var prescriptions = safeAll(
      `SELECT p.*, d.name as doctor_name, s.name as specialty_name
       FROM prescriptions p
       LEFT JOIN users d ON d.id = p.doctor_id
       LEFT JOIN orders o ON o.id = p.order_id
       LEFT JOIN specialties s ON s.id = o.specialty_id
       WHERE p.patient_id = ?
       ORDER BY p.created_at DESC`,
      [patientId], []
    );

    res.render('patient_prescriptions', {
      prescriptions: prescriptions,
      lang: lang,
      isAr: isAr,
      pageTitle: isAr ? 'وصفاتي الطبية' : 'My Prescriptions'
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).send('Server error');
  }
});

// GET /portal/patient/prescription/:prescriptionId — View single prescription
router.get('/portal/patient/prescription/:prescriptionId', requireRole('patient'), function(req, res) {
  try {
    var prescriptionId = String(req.params.prescriptionId).trim();
    var patientId = req.user.id;
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var rx = safeGet(
      `SELECT p.*, d.name as doctor_name, d.specialty_id,
              s.name as specialty_name
       FROM prescriptions p
       LEFT JOIN users d ON d.id = p.doctor_id
       LEFT JOIN specialties s ON s.id = d.specialty_id
       WHERE p.id = ? AND p.patient_id = ?`,
      [prescriptionId, patientId], null
    );
    if (!rx) return res.status(404).send(isAr ? 'الوصفة غير موجودة' : 'Prescription not found');

    var medications = [];
    try { medications = JSON.parse(rx.medications || '[]'); } catch (_) {}

    res.render('patient_prescription_detail', {
      prescription: rx,
      medications: medications,
      lang: lang,
      isAr: isAr,
      pageTitle: isAr ? 'تفاصيل الوصفة' : 'Prescription Details'
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).send('Server error');
  }
});

// GET /portal/patient/prescription/:prescriptionId/download — Download PDF
router.get('/portal/patient/prescription/:prescriptionId/download', requireRole('patient'), function(req, res) {
  try {
    var prescriptionId = String(req.params.prescriptionId).trim();
    var patientId = req.user.id;

    var rx = safeGet('SELECT pdf_url FROM prescriptions WHERE id = ? AND patient_id = ?', [prescriptionId, patientId], null);
    if (!rx || !rx.pdf_url) return res.status(404).send('PDF not available');

    var filePath = path.join(process.cwd(), 'public', rx.pdf_url);
    if (!fs.existsSync(filePath)) return res.status(404).send('PDF not found');

    return res.download(filePath, 'prescription-' + prescriptionId.slice(0, 8) + '.pdf');
  } catch (err) {
    return res.status(500).send('Server error');
  }
});

// PUT /portal/doctor/prescription/:prescriptionId — Edit prescription
router.put('/portal/doctor/prescription/:prescriptionId', requireRole('doctor'), function(req, res) {
  try {
    var prescriptionId = String(req.params.prescriptionId).trim();
    var doctorId = req.user.id;
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var rx = safeGet('SELECT * FROM prescriptions WHERE id = ? AND doctor_id = ?', [prescriptionId, doctorId], null);
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

    db.prepare(
      'UPDATE prescriptions SET medications = ?, diagnosis = ?, notes = ?, updated_at = ? WHERE id = ?'
    ).run(JSON.stringify(medications), diagnosis || null, notes || null, now, prescriptionId);

    return res.json({ ok: true, message: isAr ? 'تم تحديث الوصفة' : 'Prescription updated' });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// PDF generation helper
function generatePrescriptionPdf(prescriptionId, data) {
  var PDFDocument;
  try {
    PDFDocument = require('pdfkit');
  } catch (_) {
    return null; // PDFKit not available
  }

  ensurePrescriptionsDir();

  var doc = new PDFDocument({ size: 'A4', margin: 50 });
  var fileName = 'rx-' + prescriptionId.slice(0, 8) + '.pdf';
  var filePath = path.join(PRESCRIPTIONS_DIR, fileName);
  var writeStream = fs.createWriteStream(filePath);
  doc.pipe(writeStream);

  // Header
  doc.fontSize(20).font('Helvetica-Bold').text('Tashkheesa', { align: 'center' });
  doc.fontSize(12).font('Helvetica').text('Medical Prescription', { align: 'center' });
  doc.moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#e2e8f0');
  doc.moveDown(0.5);

  // Patient & Doctor info
  doc.fontSize(10).font('Helvetica-Bold').text('Patient: ', { continued: true }).font('Helvetica').text(data.patientName || '-');
  doc.font('Helvetica-Bold').text('Doctor: ', { continued: true }).font('Helvetica').text('Dr. ' + (data.doctorName || '-'));
  doc.font('Helvetica-Bold').text('Date: ', { continued: true }).font('Helvetica').text(new Date(data.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }));
  if (data.validUntil) {
    doc.font('Helvetica-Bold').text('Valid Until: ', { continued: true }).font('Helvetica').text(data.validUntil);
  }
  doc.moveDown(1);

  // Diagnosis
  if (data.diagnosis) {
    doc.fontSize(11).font('Helvetica-Bold').text('Diagnosis');
    doc.fontSize(10).font('Helvetica').text(data.diagnosis);
    doc.moveDown(0.5);
  }

  // Medications table
  doc.fontSize(11).font('Helvetica-Bold').text('Medications');
  doc.moveDown(0.3);

  var meds = data.medications || [];
  meds.forEach(function(med, idx) {
    doc.fontSize(10).font('Helvetica-Bold').text((idx + 1) + '. ' + (med.name || ''));
    var details = [];
    if (med.dosage) details.push('Dosage: ' + med.dosage);
    if (med.frequency) details.push('Frequency: ' + med.frequency);
    if (med.duration) details.push('Duration: ' + med.duration);
    doc.fontSize(9).font('Helvetica').text('   ' + details.join('  |  '));
    if (med.instructions) {
      doc.fontSize(9).fillColor('#555').text('   Instructions: ' + med.instructions);
      doc.fillColor('#000');
    }
    doc.moveDown(0.3);
  });

  // Notes
  if (data.notes) {
    doc.moveDown(0.5);
    doc.fontSize(11).font('Helvetica-Bold').text('Notes');
    doc.fontSize(10).font('Helvetica').text(data.notes);
  }

  // Footer
  doc.moveDown(2);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#e2e8f0');
  doc.moveDown(0.5);
  doc.fontSize(8).fillColor('#999').text('This prescription is generated by Tashkheesa medical platform. Please consult your healthcare provider before making changes to your treatment.', { align: 'center' });

  doc.end();

  return '/prescriptions/' + fileName;
}

module.exports = router;
