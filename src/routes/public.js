const express = require('express');
const { randomUUID } = require('crypto');
const { db } = require('../db');
const { queueNotification } = require('../notify');

const router = express.Router();

router.post('/public/orders', (req, res) => {
  try {
    const body = req.body || {};
    const patientName = (body.patient_name || '').trim();
    const patientEmail = (body.patient_email || '').trim().toLowerCase();
    const patientPhone = (body.patient_phone || '').trim();
    const serviceId = body.service_id || null;
    const serviceCode = body.service_code || null;
    const specialtyId = body.specialty_id || null;
    const slaType = (body.sla_type || 'standard').toLowerCase();
    const slaHours = slaType === 'fast' ? 24 : 72;
    const reason = body.reason || '';

    if (!patientName || !patientEmail || (!serviceId && !serviceCode && !specialtyId)) {
      return res.status(400).json({ ok: false, error: 'missing_required_fields' });
    }

    // Find or create patient
    let patient = db.prepare('SELECT * FROM users WHERE email = ?').get(patientEmail);
    if (!patient) {
      const newId = randomUUID();
      db.prepare(
        `INSERT INTO users (id, name, email, phone, role, password_hash, lang, is_active, created_at)
         VALUES (?, ?, ?, ?, 'patient', '', 'en', 1, CURRENT_TIMESTAMP)`
      ).run(newId, patientName, patientEmail, patientPhone || null);
      patient = db.prepare('SELECT * FROM users WHERE id = ?').get(newId);
    }

    // Resolve service
    let service = null;
    if (serviceId) {
      service = db.prepare('SELECT * FROM services WHERE id = ?').get(serviceId);
    } else if (serviceCode) {
      service = db.prepare('SELECT * FROM services WHERE code = ?').get(serviceCode);
    }

    let resolvedSpecialtyId = specialtyId;
    if (service && service.specialty_id) {
      resolvedSpecialtyId = service.specialty_id;
    }

    if (!service && !resolvedSpecialtyId) {
      return res.status(400).json({ ok: false, error: 'invalid_service_or_specialty' });
    }

    const price = service && service.base_price != null ? service.base_price : 0;
    const doctorFee = service && service.doctor_fee != null ? service.doctor_fee : 0;
    const paymentLink = service ? service.payment_link : null;

    // Pick a doctor (simple, first active in specialty)
    const doctor = resolvedSpecialtyId
      ? db
          .prepare(
            `SELECT id, name FROM users
             WHERE role = 'doctor' AND is_active = 1 AND specialty_id = ?
             ORDER BY created_at ASC LIMIT 1`
          )
          .get(resolvedSpecialtyId)
      : null;

    const orderId = randomUUID();
    const nowIso = new Date().toISOString();

    db.prepare(
      `INSERT INTO orders (
        id, patient_id, doctor_id, specialty_id, service_id,
        sla_hours, status, price, doctor_fee,
        created_at, accepted_at, deadline_at, completed_at,
        breached_at, reassigned_count, report_url, notes,
        uploads_locked, additional_files_requested, payment_status, payment_method,
        payment_reference, payment_link
      ) VALUES (
        @id, @patient_id, @doctor_id, @specialty_id, @service_id,
        @sla_hours, 'new', @price, @doctor_fee,
        @created_at, NULL, NULL, NULL,
        NULL, 0, NULL, @notes,
        0, 0, 'unpaid', NULL,
        NULL, @payment_link
      )`
    ).run({
      id: orderId,
      patient_id: patient.id,
      doctor_id: doctor ? doctor.id : null,
      specialty_id: resolvedSpecialtyId || null,
      service_id: service ? service.id : null,
      sla_hours: slaHours,
      price,
      doctor_fee: doctorFee,
      created_at: nowIso,
      notes: reason ? `Created via public intake. ${reason}` : 'Created via public intake.',
      payment_link: paymentLink
    });

    db.prepare(
      `INSERT INTO order_events (id, order_id, label, meta, at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(randomUUID(), orderId, 'Order submitted via website', JSON.stringify({ source: 'public', sla_type: slaType }));

    // Notifications (best effort)
    try {
      if (doctor) {
        queueNotification({
          orderId,
          toUserId: doctor.id,
          channel: 'internal',
          template: 'public_order_assigned_doctor',
          status: 'queued'
        });
      } else {
        const superadmin = db.prepare("SELECT id FROM users WHERE role = 'superadmin' LIMIT 1").get();
        if (superadmin) {
          queueNotification({
            orderId,
            toUserId: superadmin.id,
            channel: 'internal',
            template: 'public_order_unassigned',
            status: 'queued'
          });
        }
      }
    } catch (err) {
      // silent: do not break response
    }

    return res.json({
      ok: true,
      orderId,
      patientId: patient.id,
      patientEmail: patient.email,
      sla_hours: slaHours,
      status: 'new'
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('public intake error', err);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

module.exports = router;
