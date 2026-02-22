const express = require('express');
const { randomUUID } = require('crypto');
const { queryOne, queryAll, execute, withTransaction } = require('../pg');
const { queueNotification } = require('../notify');
const { logOrderEvent } = require('../audit');

const router = express.Router();

function unauthorized(res) {
  return res.status(401).json({ success: false, error: 'unauthorized' });
}

async function findOrCreatePatient({ email, name, phone, lang }) {
  const existing = await queryOne(
    "SELECT * FROM users WHERE email = $1 AND role = 'patient'",
    [email]
  );
  if (existing) return existing;

  const id = randomUUID();
  await execute(
    `INSERT INTO users (id, email, password_hash, name, role, phone, lang, notify_whatsapp, is_active)
     VALUES ($1, $2, '', $3, 'patient', $4, $5, false, true)`,
    [id, email, name || 'New Patient', phone || null, lang === 'ar' ? 'ar' : 'en']
  );
  return await queryOne('SELECT * FROM users WHERE id = $1', [id]);
}

function mapSlaHours(slaType) {
  if (slaType === 'vip') return 24;
  if (slaType === 'standard') return 72;
  return 72;
}

async function resolveSpecialtyByCode(code) {
  if (!code) return null;
  const specialty = await queryOne(
    'SELECT id, name FROM specialties WHERE LOWER(name) = LOWER($1) OR LOWER(id) = LOWER($2)',
    [code, code]
  );
  return specialty;
}

router.post('/api/public/orders', async (req, res) => {
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
  const patient = await findOrCreatePatient({
    email: patient_email.trim().toLowerCase(),
    name: patient_name || 'New Patient',
    phone: patient_phone || null,
    lang
  });

  const service = await queryOne('SELECT * FROM services WHERE code = $1', [service_code]);
  if (!service) {
    return res.status(400).json({ success: false, error: 'unknown_service_code' });
  }

  const specialty = service.specialty_id
    ? await queryOne('SELECT id, name FROM specialties WHERE id = $1', [service.specialty_id])
    : await resolveSpecialtyByCode(specialty_code);

  const slaHours = mapSlaHours(sla_type);
  const nowIso = new Date().toISOString();
  const orderId = `web-order-${Date.now()}-${randomUUID()}`;
  const deadlineAt =
    slaHours != null
      ? new Date(new Date(nowIso).getTime() + Number(slaHours) * 60 * 60 * 1000).toISOString()
      : null;

  const price = service.base_price != null ? service.base_price : 0;
  const doctorFee = service.doctor_fee != null ? service.doctor_fee : 0;

  try {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO orders (
          id, patient_id, doctor_id, specialty_id, service_id, sla_hours, status,
          price, doctor_fee, created_at, updated_at, accepted_at, deadline_at,
          completed_at, breached_at, reassigned_count, report_url, notes,
          uploads_locked, additional_files_requested, payment_status, payment_method,
          payment_reference, payment_link
        ) VALUES (
          $1, $2, NULL, $3, $4, $5, 'new',
          $6, $7, $8, $9, NULL, $10,
          NULL, NULL, 0, NULL, $11,
          false, false, 'unpaid', NULL,
          NULL, $12
        )`,
        [
          orderId,
          patient.id,
          specialty ? specialty.id : service.specialty_id,
          service.id,
          slaHours,
          price,
          doctorFee,
          nowIso,
          nowIso,
          deadlineAt,
          notes || null,
          service.payment_link || null
        ]
      );

      const files = Array.isArray(file_urls) ? file_urls : [];
      for (const url of files) {
        if (!url) continue;
        await client.query(
          `INSERT INTO order_files (id, order_id, url, label, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), orderId, url, 'Uploaded via website', nowIso]
        );
      }

      logOrderEvent({
        orderId,
        label: 'Order created by patient',
        meta: JSON.stringify({ service_code, specialty_code }),
        actorUserId: patient.id,
        actorRole: 'patient'
      });
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[public orders] insert failed', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }

  // notifications
  const supers = await queryAll(
    "SELECT id FROM users WHERE role = 'superadmin' AND is_active = true"
  );
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

router.post('/sandbox/order-intake', async (req, res) => {
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

  try {
    // Find the POST /api/public/orders route handler and call it directly
    const routeHandler = router.stack.find(
      (layer) => layer.route && layer.route.path === '/api/public/orders' && layer.route.methods.post
    );
    if (routeHandler) {
      await routeHandler.route.stack[0].handle(fakeReq, fakeRes, () => {});
    }
  } catch (e) {
    fakeRes._status = 500;
    fakeRes._json = { error: 'internal_error' };
  }

  if (fakeRes._status === 201 && fakeRes._json && fakeRes._json.success) {
    return res.render('sandbox_order_intake', { result: fakeRes._json, error: null });
  }
  return res.render('sandbox_order_intake', {
    result: null,
    error: fakeRes._json ? fakeRes._json.error : 'unknown_error'
  });
});

module.exports = router;
