const multer = require('multer');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { randomUUID } = require('crypto');
const { createDraftCase, submitCase } = require('../case_lifecycle');
const { db } = require('../db');
const { queueMultiChannelNotification } = require('../notify');
const { logError, logErrorToDb } = require('../logger');
const { validateIntakeForm, validateFiles } = require('../validators/orders');
const { sanitizeString } = require('../validators/sanitize');

const router = express.Router();

function getOrder(orderId) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
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

function attachFileToOrder(orderId, file) {
  // Store internal path only (no public exposure)
  const internalPath = path.join('orders', String(orderId), file.filename);
  db.prepare(
    `INSERT INTO order_files (id, order_id, url, label, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`
  ).run(randomUUID(), orderId, internalPath, file.originalname);
}

function upsertCaseContext(orderId, { reason_for_review, language, urgency_flag }) {
  const exists = db.prepare('SELECT 1 FROM case_context WHERE case_id = ?').get(orderId);

  if (exists) {
    db.prepare(
      `UPDATE case_context
       SET reason_for_review = ?, urgency_flag = ?, language = ?
       WHERE case_id = ?`
    ).run(reason_for_review || '', urgency_flag ? 1 : 0, language || 'en', orderId);
  } else {
    db.prepare(
      `INSERT INTO case_context (case_id, reason_for_review, urgency_flag, language)
       VALUES (?, ?, ?, ?)`
    ).run(orderId, reason_for_review || '', urgency_flag ? 1 : 0, language || 'en', orderId);
  }

  // Mirror to orders table
  db.prepare(
    `UPDATE orders
     SET language = ?, urgency_flag = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(language || 'en', urgency_flag ? 1 : 0, orderId);
}

router.get('/order/start', (req, res) => {
  const orderId = createDraftCase({
    language: 'en',
    urgency_flag: false,
    reason_for_review: ''
  });

  return res.redirect(`/order/${orderId}/upload`);
});

router.get('/order/:orderId/upload', (req, res) => {
  const orderId = String(req.params.orderId);
  const order = getOrder(orderId);
  if (!order) return res.status(404).send('Order not found');

  const existingFiles = db
    .prepare('SELECT url, label FROM order_files WHERE order_id = ? ORDER BY created_at DESC')
    .all(orderId);

  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  const services = db.prepare(
    `SELECT id, name, specialty_id
     FROM services
     ORDER BY name ASC`
  ).all();

  return res.render('order_upload', {
    sessionToken: orderId,
    existingFiles,
    form: {},
    specialties,
    services
  });
});

router.post('/order/:orderId/review', upload.array('files'), (req, res, next) => {
  try {
  const orderId = String(req.params.orderId);
  const order = getOrder(orderId);
  if (!order) return res.status(404).send('Order not found');

  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  const services = db.prepare('SELECT id, name, specialty_id FROM services ORDER BY name ASC').all();

  const reason = (req.body.reason || '').trim();
  const language = (req.body.language || 'en').trim();

  const urgencyFlag = req.body.urgency === 'priority';
  const urgency = urgencyFlag ? 'priority' : 'standard';
  const slaHours = urgencyFlag ? 24 : 72;

  const patientEmail = (req.body.patient_email || '').trim();
  const patientPhone = (req.body.patient_phone || '').trim();
  const patientName = (req.body.patient_name || '').trim();

  if (!patientEmail || !patientPhone || !patientName) {
    const existingFiles = db
      .prepare('SELECT url, label FROM order_files WHERE order_id = ? ORDER BY created_at DESC')
      .all(orderId);

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
    const existingFiles = db
      .prepare('SELECT url, label FROM order_files WHERE order_id = ? ORDER BY created_at DESC')
      .all(orderId);

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
    const existingFiles = db
      .prepare('SELECT url, label FROM order_files WHERE order_id = ? ORDER BY created_at DESC')
      .all(orderId);

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
  const existingFileCount = db.prepare('SELECT COUNT(*) as c FROM order_files WHERE order_id = ?').get(orderId);
  const fileValidation = validateFiles(req.files || [], (existingFileCount && existingFileCount.c) || 0, language);
  if (!fileValidation.valid) {
    const existingFiles2 = db
      .prepare('SELECT url, label FROM order_files WHERE order_id = ? ORDER BY created_at DESC')
      .all(orderId);
    return res.status(400).render('order_upload', {
      sessionToken: orderId,
      existingFiles: existingFiles2,
      form: req.body || {},
      specialties,
      services,
      error: fileValidation.errors.join('. ')
    });
  }

  db.prepare(
    `UPDATE orders
     SET specialty_id = ?, service_id = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(specialtyId, serviceId, orderId);

  // Create/find patient
  let patient = db.prepare('SELECT id FROM users WHERE email = ?').get(patientEmail);
  if (!patient) {
    const patientId = randomUUID();
    db.prepare(
      `INSERT INTO users (id, email, phone, name, role, lang)
       VALUES (?, ?, ?, ?, 'patient', ?)`
    ).run(patientId, patientEmail, patientPhone, patientName, language);
    patient = { id: patientId };
  }

  db.prepare(
    `UPDATE orders SET patient_id = ?, language = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(patient.id, language, orderId);

  // Persist context
  upsertCaseContext(orderId, {
    reason_for_review: reason,
    language,
    urgency_flag: urgencyFlag
  });

  // Persist files
  const uploadedFiles = (req.files || []).map(f => ({
    filename: f.filename,
    originalname: f.originalname
  }));

  uploadedFiles.forEach((file) => attachFileToOrder(orderId, file));

  const allFiles = db
    .prepare('SELECT url, label FROM order_files WHERE order_id = ? ORDER BY created_at DESC')
    .all(orderId)
    .map(f => ({ originalname: f.label, url: f.url }));

  return res.render('order_review', {
    sessionToken: orderId,
    reason,
    language,
    urgency,
    files: allFiles,
    patient_name: patientName,
    patient_email: patientEmail,
    patient_phone: patientPhone,
    sla_hours: slaHours
  });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return next(err);
  }
});

router.post('/order/:orderId/payment', (req, res, next) => {
  try {
  const orderId = String(req.params.orderId);
  if (!req.body.sla_choice) return res.status(400).send('SLA choice is required');

  const order = getOrder(orderId);
  if (!order) return res.status(404).send('Order not found');

  const slaHours = req.body.sla_choice === 'priority' ? 24 : 72;

  db.prepare(
    `UPDATE orders
     SET sla_hours = ?, urgency_flag = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(slaHours, slaHours === 24 ? 1 : 0, orderId);

  return res.redirect(`/order/${orderId}/confirmation`);
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return next(err);
  }
});

router.get('/order/:orderId/confirmation', (req, res, next) => {
  try {
  const orderId = String(req.params.orderId);
  const order = getOrder(orderId);
  if (!order) return res.status(404).send('Order not found');

  // Submit once
  if (order.status !== 'submitted') {
    submitCase(orderId);

    // Notify patient of case submission via email + whatsapp
    if (order.patient_id) {
      try {
        const specialty = order.specialty_id
          ? db.prepare('SELECT name FROM specialties WHERE id = ?').get(order.specialty_id)
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

  const currentOrder = getOrder(orderId);
  const context = db
    .prepare('SELECT reason_for_review, urgency_flag, language FROM case_context WHERE case_id = ?')
    .get(orderId) || {};

  const files = db
    .prepare('SELECT url, label, created_at FROM order_files WHERE order_id = ? ORDER BY created_at DESC')
    .all(orderId)
    .map(f => ({ ...f, originalname: f.label }));

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