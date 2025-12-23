const express = require('express');
const { db } = require('../db');
const { randomUUID } = require('crypto');
const { requireRole } = require('../middleware');

const router = express.Router();

const requireAdmin = requireRole('admin', 'superadmin');


// Redirect entry
router.get('/admin', requireAdmin, (req, res) => {
  return res.redirect('/admin/doctors');
});

// DOCTORS
router.get('/admin/doctors', requireAdmin, (req, res) => {
  const doctors = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.phone, u.notify_whatsapp, u.is_active, u.specialty_id, s.name AS specialty_name
       FROM users u
       LEFT JOIN specialties s ON s.id = u.specialty_id
       WHERE u.role = 'doctor'
       ORDER BY u.created_at DESC, u.name ASC`
    )
    .all();
  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  res.render('admin_doctors', { user: req.user, doctors, specialties });
});

router.get('/admin/doctors/new', requireAdmin, (req, res) => {
  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  res.render('admin_doctor_form', { user: req.user, specialties, doctor: null, isEdit: false, error: null });
});

router.post('/admin/doctors/new', requireAdmin, (req, res) => {
  const { name, email, specialty_id, phone, notify_whatsapp, is_active } = req.body || {};
  if (!name || !email) {
    const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
    return res.status(400).render('admin_doctor_form', {
      user: req.user,
      specialties,
      doctor: { name, email, specialty_id, phone, notify_whatsapp, is_active },
      isEdit: false,
      error: 'Name and email are required.'
    });
  }
  db.prepare(
    `INSERT INTO users (id, email, password_hash, name, role, specialty_id, phone, lang, notify_whatsapp, is_active)
     VALUES (?, ?, ?, ?, 'doctor', ?, ?, 'en', ?, ?)`
  ).run(
    randomUUID(),
    email,
    '',
    name,
    specialty_id || null,
    phone || null,
    notify_whatsapp ? 1 : 0,
    is_active ? 1 : 0
  );
  return res.redirect('/admin/doctors');
});

router.get('/admin/doctors/:id/edit', requireAdmin, (req, res) => {
  const doctor = db
    .prepare("SELECT * FROM users WHERE id = ? AND role = 'doctor'")
    .get(req.params.id);
  if (!doctor) return res.redirect('/admin/doctors');
  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  res.render('admin_doctor_form', { user: req.user, specialties, doctor, isEdit: true, error: null });
});

router.post('/admin/doctors/:id/edit', requireAdmin, (req, res) => {
  const doctor = db
    .prepare("SELECT * FROM users WHERE id = ? AND role = 'doctor'")
    .get(req.params.id);
  if (!doctor) return res.redirect('/admin/doctors');
  const { name, email, specialty_id, phone, notify_whatsapp, is_active } = req.body || {};
  db.prepare(
    `UPDATE users
     SET name = ?, email = ?, specialty_id = ?, phone = ?, notify_whatsapp = ?, is_active = ?
     WHERE id = ? AND role = 'doctor'`
  ).run(
    name || doctor.name,
    email || doctor.email,
    specialty_id || null,
    phone || null,
    notify_whatsapp ? 1 : 0,
    is_active ? 1 : 0,
    req.params.id
  );
  return res.redirect('/admin/doctors');
});

router.post('/admin/doctors/:id/toggle-active', requireAdmin, (req, res) => {
  const doctorId = req.params.id;
  db.prepare(
    `UPDATE users
     SET is_active = CASE is_active WHEN 1 THEN 0 ELSE 1 END
     WHERE id = ? AND role = 'doctor'`
  ).run(doctorId);
  return res.redirect('/admin/doctors');
});

// SERVICES
router.get('/admin/services', requireAdmin, (req, res) => {
  const services = db
    .prepare(
      `SELECT sv.id, sv.code, sv.name, sv.base_price, sv.doctor_fee, sv.currency, sv.payment_link, sp.name AS specialty_name
       FROM services sv
       LEFT JOIN specialties sp ON sp.id = sv.specialty_id
       ORDER BY sp.name ASC, sv.name ASC`
    )
    .all();
  res.render('admin_services', { user: req.user, services });
});

router.get('/admin/services/new', requireAdmin, (req, res) => {
  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  res.render('admin_service_form', { user: req.user, specialties, service: null, isEdit: false, error: null });
});

router.post('/admin/services/new', requireAdmin, (req, res) => {
  const { specialty_id, code, name, base_price, doctor_fee, currency, payment_link } = req.body || {};
  if (!specialty_id || !name) {
    const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
    return res.status(400).render('admin_service_form', {
      user: req.user,
      specialties,
      service: { specialty_id, code, name, base_price, doctor_fee, currency, payment_link },
      isEdit: false,
      error: 'Specialty and name are required.'
    });
  }
  db.prepare(
    `INSERT INTO services (id, specialty_id, code, name, base_price, doctor_fee, currency, payment_link)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    specialty_id,
    code || null,
    name,
    base_price ? Number(base_price) : null,
    doctor_fee ? Number(doctor_fee) : null,
    currency || 'EGP',
    payment_link || null
  );
  return res.redirect('/admin/services');
});

router.get('/admin/services/:id/edit', requireAdmin, (req, res) => {
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
  if (!service) return res.redirect('/admin/services');
  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  res.render('admin_service_form', { user: req.user, specialties, service, isEdit: true, error: null });
});

router.post('/admin/services/:id/edit', requireAdmin, (req, res) => {
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
  if (!service) return res.redirect('/admin/services');
  const { specialty_id, code, name, base_price, doctor_fee, currency, payment_link } = req.body || {};
  if (!specialty_id || !name) {
    const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
    return res.status(400).render('admin_service_form', {
      user: req.user,
      specialties,
      service: { ...service, ...req.body },
      isEdit: true,
      error: 'Specialty and name are required.'
    });
  }
  db.prepare(
    `UPDATE services
     SET specialty_id = ?, code = ?, name = ?, base_price = ?, doctor_fee = ?, currency = ?, payment_link = ?
     WHERE id = ?`
  ).run(
    specialty_id,
    code || null,
    name,
    base_price ? Number(base_price) : null,
    doctor_fee ? Number(doctor_fee) : null,
    currency || 'EGP',
    payment_link || null,
    req.params.id
  );
  return res.redirect('/admin/services');
});

module.exports = router;
