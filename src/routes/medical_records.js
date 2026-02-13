// src/routes/medical_records.js
// Medical Records / EHR Lite (Phase 8)

const express = require('express');
const { randomUUID } = require('crypto');
const { db } = require('../db');
const { requireRole } = require('../middleware');
const { sanitizeHtml, sanitizeString } = require('../validators/sanitize');
const { logErrorToDb } = require('../logger');
const { safeAll, safeGet } = require('../sql-utils');

const router = express.Router();

const VALID_RECORD_TYPES = ['lab_result', 'imaging', 'prescription', 'discharge_summary', 'surgical_report', 'vaccination', 'allergy', 'chronic_condition', 'other'];

// GET /portal/patient/records — List all records
router.get('/portal/patient/records', requireRole('patient'), function(req, res) {
  try {
    var patientId = req.user.id;
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var typeFilter = sanitizeString(req.query.type || '', 50).trim();
    var search = sanitizeString(req.query.q || '', 200).trim();

    var where = ['patient_id = ?', 'is_hidden = 0'];
    var params = [patientId];

    if (typeFilter && VALID_RECORD_TYPES.includes(typeFilter)) {
      where.push('record_type = ?');
      params.push(typeFilter);
    }
    if (search) {
      where.push('(title LIKE ? OR description LIKE ? OR provider LIKE ?)');
      params.push('%' + search + '%', '%' + search + '%', '%' + search + '%');
    }

    var records = safeAll(
      'SELECT * FROM medical_records WHERE ' + where.join(' AND ') + ' ORDER BY date_of_record DESC, created_at DESC',
      params, []
    );

    res.render('patient_records', {
      records: records,
      recordTypes: VALID_RECORD_TYPES,
      filters: { type: typeFilter, q: search },
      lang: lang,
      isAr: isAr,
      pageTitle: isAr ? 'سجلاتي الطبية' : 'My Medical Records'
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).send('Server error');
  }
});

// POST /portal/patient/records — Create new record
router.post('/portal/patient/records', requireRole('patient'), function(req, res) {
  try {
    var patientId = req.user.id;
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var title = sanitizeString(req.body.title || '', 500).trim();
    var recordType = sanitizeString(req.body.record_type || '', 50).trim();
    var description = sanitizeHtml(sanitizeString(req.body.description || '', 5000));
    var fileUrl = sanitizeString(req.body.file_url || '', 2000).trim();
    var fileName = sanitizeString(req.body.file_name || '', 500).trim();
    var dateOfRecord = sanitizeString(req.body.date_of_record || '', 10).trim();
    var provider = sanitizeString(req.body.provider || '', 200).trim();
    var tags = sanitizeString(req.body.tags || '', 500).trim();
    var isShared = req.body.is_shared_with_doctors === '1' ? 1 : 0;

    if (!title) {
      return res.status(400).json({ ok: false, error: isAr ? 'العنوان مطلوب' : 'Title is required' });
    }
    if (!recordType || !VALID_RECORD_TYPES.includes(recordType)) {
      return res.status(400).json({ ok: false, error: isAr ? 'نوع السجل غير صالح' : 'Invalid record type' });
    }

    if (dateOfRecord && !/^\d{4}-\d{2}-\d{2}$/.test(dateOfRecord)) {
      dateOfRecord = '';
    }

    var id = randomUUID();
    var now = new Date().toISOString();

    db.prepare(
      `INSERT INTO medical_records (id, patient_id, record_type, title, description, file_url, file_name, date_of_record, provider, tags, is_shared_with_doctors, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, patientId, recordType, title, description || null, fileUrl || null, fileName || null, dateOfRecord || null, provider || null, tags || null, isShared, now);

    return res.json({ ok: true, id: id, message: isAr ? 'تم حفظ السجل' : 'Record saved' });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /portal/patient/records/:recordId — View record detail
router.get('/portal/patient/records/:recordId', requireRole('patient'), function(req, res) {
  try {
    var recordId = String(req.params.recordId).trim();
    var patientId = req.user.id;
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var record = safeGet(
      'SELECT * FROM medical_records WHERE id = ? AND patient_id = ? AND is_hidden = 0',
      [recordId, patientId], null
    );
    if (!record) return res.status(404).send(isAr ? 'السجل غير موجود' : 'Record not found');

    return res.json({ ok: true, record: record });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// PUT /portal/patient/records/:recordId — Edit record metadata
router.put('/portal/patient/records/:recordId', requireRole('patient'), function(req, res) {
  try {
    var recordId = String(req.params.recordId).trim();
    var patientId = req.user.id;
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    var record = safeGet('SELECT id FROM medical_records WHERE id = ? AND patient_id = ?', [recordId, patientId], null);
    if (!record) return res.status(404).json({ ok: false, error: 'Not found' });

    var title = sanitizeString(req.body.title || '', 500).trim();
    var description = sanitizeHtml(sanitizeString(req.body.description || '', 5000));
    var provider = sanitizeString(req.body.provider || '', 200).trim();
    var tags = sanitizeString(req.body.tags || '', 500).trim();

    if (!title) return res.status(400).json({ ok: false, error: isAr ? 'العنوان مطلوب' : 'Title is required' });

    db.prepare('UPDATE medical_records SET title = ?, description = ?, provider = ?, tags = ? WHERE id = ?')
      .run(title, description || null, provider || null, tags || null, recordId);

    return res.json({ ok: true, message: isAr ? 'تم التحديث' : 'Updated' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// DELETE /portal/patient/records/:recordId — Soft delete
router.delete('/portal/patient/records/:recordId', requireRole('patient'), function(req, res) {
  try {
    var recordId = String(req.params.recordId).trim();
    var patientId = req.user.id;

    db.prepare('UPDATE medical_records SET is_hidden = 1 WHERE id = ? AND patient_id = ?').run(recordId, patientId);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /portal/patient/records/:recordId/share — Toggle sharing
router.post('/portal/patient/records/:recordId/share', requireRole('patient'), function(req, res) {
  try {
    var recordId = String(req.params.recordId).trim();
    var patientId = req.user.id;
    var share = req.body.share === '1' || req.body.share === 1 ? 1 : 0;

    db.prepare('UPDATE medical_records SET is_shared_with_doctors = ? WHERE id = ? AND patient_id = ?')
      .run(share, recordId, patientId);

    return res.json({ ok: true, shared: share });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /portal/doctor/case/:caseId/patient-records — Doctor views shared records
router.get('/portal/doctor/case/:caseId/patient-records', requireRole('doctor'), function(req, res) {
  try {
    var caseId = String(req.params.caseId).trim();
    var doctorId = req.user.id;
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';

    // Verify doctor is assigned to this case
    var order = safeGet('SELECT patient_id FROM orders WHERE id = ? AND doctor_id = ?', [caseId, doctorId], null);
    if (!order) return res.status(403).json({ ok: false, error: 'Forbidden' });

    var records = safeAll(
      'SELECT id, record_type, title, description, file_url, file_name, date_of_record, provider, tags, created_at FROM medical_records WHERE patient_id = ? AND is_shared_with_doctors = 1 AND is_hidden = 0 ORDER BY date_of_record DESC, created_at DESC',
      [order.patient_id], []
    );

    return res.json({ ok: true, records: records });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
