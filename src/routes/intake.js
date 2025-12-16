const express = require('express');
const { randomUUID } = require('crypto');
const { db } = require('../db');
const { hash } = require('../auth');

const router = express.Router();
const TEMP_PASSWORD = 'Client123!';

function fetchServices() {
  return db
    .prepare(
      `SELECT sv.id,
              sv.name AS service_name,
              sv.base_price,
              sv.currency,
              sv.doctor_fee,
              sv.payment_link,
              s.id AS specialty_id,
              s.name AS specialty_name
       FROM services sv
       LEFT JOIN specialties s ON sv.specialty_id = s.id
       ORDER BY s.name ASC, sv.name ASC`
    )
    .all();
}

function findOrCreatePatient({ fullName, email, phone, preferredLang }) {
  const existing = db
    .prepare("SELECT * FROM users WHERE email = ? AND role = 'patient'")
    .get(email);
  if (existing) return existing;

  const id = randomUUID();
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, password_hash, name, role, phone, lang, is_active, created_at)
     VALUES (?, ?, ?, ?, 'patient', ?, ?, 1, ?)`
  ).run(
    id,
    email,
    hash(TEMP_PASSWORD),
    fullName || 'New Patient',
    phone || null,
    preferredLang === 'ar' ? 'ar' : 'en',
    nowIso
  );

  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function mapSlaHours(slaType) {
  if (slaType === 'vip') return 24;
  return 72;
}

router.get('/intake', (req, res) => {
  const services = fetchServices();
  res.render('intake_form', { services, error: null, form: {} });
});

router.post('/intake', (req, res) => {
  const body = req.body || {};
  const fullName = (body.full_name || '').trim();
  const email = (body.email || '').trim().toLowerCase();
  const phone = (body.phone || '').trim() || null;
  const preferredLang = (body.preferred_lang || 'en').trim().toLowerCase() === 'ar' ? 'ar' : 'en';
  const serviceId = body.service_id || '';
  const slaType = body.sla_type === 'vip' ? 'vip' : 'standard';
  const notes = (body.notes || '').trim() || null;

  const services = fetchServices();

  if (!fullName || !email || !serviceId) {
    return res.status(400).render('intake_form', {
      services,
      error: 'Please fill name, email, and service.',
      form: body
    });
  }

  const service = db
    .prepare(
      `SELECT sv.*, s.id AS specialty_id
       FROM services sv
       LEFT JOIN specialties s ON s.id = sv.specialty_id
       WHERE sv.id = ?`
    )
    .get(serviceId);

  if (!service) {
    return res.status(400).render('intake_form', {
      services,
      error: 'Service not found.',
      form: body
    });
  }

  const patient = findOrCreatePatient({
    fullName,
    email,
    phone,
    preferredLang
  });

  const slaHours = mapSlaHours(slaType);
  const nowIso = new Date().toISOString();
  const orderId = randomUUID();
  const price = service.base_price != null ? service.base_price : 0;
  const doctorFee = service.doctor_fee != null ? service.doctor_fee : 0;
  const deadlineAt =
    slaHours != null
      ? new Date(new Date(nowIso).getTime() + Number(slaHours) * 60 * 60 * 1000).toISOString()
      : null;

  db.prepare(
    `INSERT INTO orders (
       id, patient_id, doctor_id, specialty_id, service_id, sla_hours, status,
       price, doctor_fee, created_at, updated_at, accepted_at, deadline_at,
       completed_at, breached_at, reassigned_count, report_url, notes,
       uploads_locked, additional_files_requested, payment_status, payment_method,
       payment_reference, payment_link
     ) VALUES (
       ?, ?, NULL, ?, ?, ?, 'new',
       ?, ?, ?, ?, NULL, ?,
       NULL, NULL, 0, NULL, ?, 
       0, 0, 'unpaid', NULL,
       NULL, ?
     )`
  ).run(
    orderId,
    patient.id,
    service.specialty_id,
    service.id,
    slaHours,
    price,
    doctorFee,
    nowIso,
    nowIso,
    deadlineAt,
    notes,
    service.payment_link || null
  );

  logOrderEvent({
    orderId,
    label: 'Order created by patient',
    meta: JSON.stringify({ email, service_name: service.name }),
    actorUserId: patient.id,
    actorRole: 'patient'
  });

  return res.redirect(`/intake/thank-you?email=${encodeURIComponent(email)}&temp=1`);
});

router.get('/intake/thank-you', (req, res) => {
  const email = (req.query && req.query.email) || '';
  const showTemp = req.query && req.query.temp === '1';
  res.render('intake_thank_you', { email, showTemp, tempPassword: TEMP_PASSWORD });
});

module.exports = router;
