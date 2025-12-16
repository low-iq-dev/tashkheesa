const express = require('express');
const { randomUUID } = require('crypto');
const { db } = require('../db');
const { queueNotification } = require('../notify');
const { logOrderEvent } = require('../audit');

const router = express.Router();

function unauthorized(res) {
  return res.status(401).json({ success: false, error: 'unauthorized' });
}

function findOrCreatePatient({ email, name, phone, lang }) {
  const existing = db
    .prepare("SELECT * FROM users WHERE email = ? AND role = 'patient'")
    .get(email);
  if (existing) return existing;

  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (id, email, password_hash, name, role, phone, lang, notify_whatsapp, is_active)
     VALUES (?, ?, '', ?, 'patient', ?, ?, 0, 1)`
  ).run(id, email, name || 'New Patient', phone || null, lang === 'ar' ? 'ar' : 'en');
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function mapSlaHours(slaType) {
  if (slaType === 'vip') return 24;
  if (slaType === 'standard') return 72;
  return 72;
}

function resolveSpecialtyByCode(code) {
  if (!code) return null;
  const specialty = db.prepare('SELECT id, name FROM specialties WHERE LOWER(name) = LOWER(?) OR LOWER(id) = LOWER(?)').get(code, code);
  return specialty;
}

router.post('/api/public/orders', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const apiKey = process.env.PUBLIC_ORDER_API_KEY;
  if (!apiKey || req.body.api_key !== apiKey) {
    return unauthorized(res);
  }

  const {
    patient_name,
    patient_email,
    patient_phone,
    preferred_lang,
    specialty_code,
    service_code,
    sla_type,
    notes,
    file_urls
  } = req.body || {};

  if (!patient_email || !service_code || !sla_type) {
    return res.status(400).json({ success: false, error: 'invalid_payload' });
  }

  const lang = preferred_lang === 'ar' ? 'ar' : 'en';
  const patient = findOrCreatePatient({
    email: patient_email.trim().toLowerCase(),
    name: patient_name || 'New Patient',
    phone: patient_phone || null,
    lang
  });

  const service = db.prepare('SELECT * FROM services WHERE code = ?').get(service_code);
  if (!service) {
    return res.status(400).json({ success: false, error: 'unknown_service_code' });
  }

  const specialty = service.specialty_id
    ? db.prepare('SELECT id, name FROM specialties WHERE id = ?').get(service.specialty_id)
    : resolveSpecialtyByCode(specialty_code);

  const slaHours = mapSlaHours(sla_type);
  const nowIso = new Date().toISOString();
  const orderId = `web-order-${Date.now()}-${randomUUID()}`;
  const deadlineAt =
    slaHours != null
      ? new Date(new Date(nowIso).getTime() + Number(slaHours) * 60 * 60 * 1000).toISOString()
      : null;

  const price = service.base_price != null ? service.base_price : 0;
  const doctorFee = service.doctor_fee != null ? service.doctor_fee : 0;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO orders (
        id, patient_id, doctor_id, specialty_id, service_id, sla_hours, status,
        price, doctor_fee, created_at, updated_at, accepted_at, deadline_at,
        completed_at, breached_at, reassigned_count, report_url, notes,
        uploads_locked, additional_files_requested, payment_status, payment_method,
        payment_reference, payment_link
      ) VALUES (
        @id, @patient_id, NULL, @specialty_id, @service_id, @sla_hours, 'new',
        @price, @doctor_fee, @created_at, @updated_at, NULL, @deadline_at,
        NULL, NULL, 0, NULL, @notes,
        0, 0, 'unpaid', NULL,
        NULL, @payment_link
      )`
    ).run({
      id: orderId,
      patient_id: patient.id,
      specialty_id: specialty ? specialty.id : service.specialty_id,
      service_id: service.id,
      sla_hours: slaHours,
      price,
      doctor_fee: doctorFee,
      created_at: nowIso,
      updated_at: nowIso,
      deadline_at: deadlineAt,
      notes: notes || null,
      payment_link: service.payment_link || null
    });

    const files = Array.isArray(file_urls) ? file_urls : [];
    const insertFile = db.prepare(
      `INSERT INTO order_files (id, order_id, url, label, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    files.forEach((url) => {
      if (!url) return;
      insertFile.run(randomUUID(), orderId, url, 'Uploaded via website', nowIso);
    });

    logOrderEvent({
      orderId,
      label: 'Order created by patient',
      meta: JSON.stringify({ service_code, specialty_code }),
      actorUserId: patient.id,
      actorRole: 'patient'
    });
  });

  try {
    tx();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[public orders] insert failed', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }

  // notifications
  const supers = db
    .prepare("SELECT id FROM users WHERE role = 'superadmin' AND is_active = 1")
    .all();
  supers.forEach((u) =>
    queueNotification({
      orderId,
      toUserId: u.id,
      channel: 'internal',
      template: 'public_order_created_superadmin',
      status: 'queued'
    })
  );
  queueNotification({
    orderId,
    toUserId: patient.id,
    channel: 'internal',
    template: 'public_order_created_patient',
    status: 'queued'
  });

  return res.status(201).json({
    success: true,
    order_id: orderId,
    patient_id: patient.id,
    payment_link: service.payment_link || null
  });
});

router.get('/sandbox/order-intake', (req, res) => {
  res.render('sandbox_order_intake', { result: null, error: null });
});

router.post('/sandbox/order-intake', (req, res) => {
  const body = req.body || {};
  const urls =
    typeof body.file_urls === 'string'
      ? body.file_urls
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      : [];

  const payload = {
    api_key: body.api_key,
    patient_name: body.patient_name,
    patient_email: body.patient_email,
    patient_phone: body.patient_phone,
    preferred_lang: body.preferred_lang,
    specialty_code: body.specialty_code,
    service_code: body.service_code,
    sla_type: body.sla_type,
    notes: body.notes,
    file_urls: urls
  };

  // call internal handler by simulating req/res
  const fakeReq = { body: payload, get: () => payload.api_key };
  const fakeRes = {
    _status: 200,
    _json: null,
    status(code) {
      this._status = code;
      return this;
    },
    json(obj) {
      this._json = obj;
      return this;
    },
    setHeader() {}
  };
  router.handle(fakeReq, fakeRes, () => {});

  if (fakeRes._status === 201 && fakeRes._json && fakeRes._json.success) {
    return res.render('sandbox_order_intake', { result: fakeRes._json, error: null });
  }
  return res.render('sandbox_order_intake', {
    result: null,
    error: fakeRes._json ? fakeRes._json.error : 'unknown_error'
  });
});

module.exports = router;
