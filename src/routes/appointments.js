// src/routes/appointments.js
// Appointment scheduling: availability management, slot booking, confirmation

const express = require('express');
const { randomUUID } = require('crypto');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const { db } = require('../db');
const { requireRole } = require('../middleware');
const { queueNotification, queueMultiChannelNotification } = require('../notify');

const { t } = require("../i18n");
const { logErrorToDb } = require('../logger');
dayjs.extend(utc);
dayjs.extend(timezone);

const router = express.Router();

// Get language from request
function getLang(req, res) {
  const lang = req.query?.lang || req.user?.lang || "en";
  res.locals.lang = lang;
  return lang;
}

// Supported timezones
const TIMEZONES = [
  'Africa/Cairo',
  'Asia/Dubai',
  'Europe/London',
  'America/New_York',
  'Asia/Bangkok',
  'Australia/Sydney'
];

// ===== DOCTOR AVAILABILITY MANAGEMENT =====

// GET /portal/appointments/availability - Show doctor's availability settings
router.get('/portal/appointments/availability', requireRole('doctor'), (req, res) => {
  const doctorId = req.user.id;
  
  const availability = db.prepare(`
    SELECT * FROM doctor_availability 
    WHERE doctor_id = ? 
    ORDER BY day_of_week ASC, start_time ASC
  `).all(doctorId);

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  res.render('appointment_availability', {
    layout: 'portal',
    availability,
    dayNames,
    timezones: TIMEZONES,
    doctor: req.user
  });
});

// POST /portal/appointments/availability - Save doctor's availability
router.post('/portal/appointments/availability', requireRole('doctor'), (req, res) => {
  const doctorId = req.user.id;
  const { timezone: tz } = req.body;

  if (!tz || !TIMEZONES.includes(tz)) {
    return res.status(400).json({ ok: false, error: 'Invalid timezone' });
  }

  try {
    // Parse availability from form data (start_0, end_0, start_1, end_1, etc)
    const availability = [];
    for (let day = 0; day < 7; day++) {
      const startKey = `start_${day}`;
      const endKey = `end_${day}`;
      
      if (req.body[startKey] && req.body[endKey]) {
        availability.push({
          day_of_week: day,
          start_time: req.body[startKey],
          end_time: req.body[endKey]
        });
      }
    }

    // Clear existing availability for this doctor
    db.prepare('DELETE FROM doctor_availability WHERE doctor_id = ?').run(doctorId);

    // Save new availability
    const stmt = db.prepare(`
      INSERT INTO doctor_availability 
      (id, doctor_id, day_of_week, start_time, end_time, timezone, is_active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `);

    for (const slot of availability) {
      stmt.run(
        randomUUID(),
        doctorId,
        slot.day_of_week,
        slot.start_time,
        slot.end_time,
        tz
      );
    }

    res.json({ ok: true, message: 'Availability updated' });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== PATIENT BOOKING =====

// GET /portal/appointments/book/:orderId - Show booking form with available slots
router.get('/portal/appointments/book/:orderId', requireRole('patient'), (req, res) => {
  const { orderId } = req.params;
  const patientId = req.user.id;

  // Get order/case details
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) {
    return res.status(404).send('Order not found');
  }

  // Get assigned doctor
  const doctor = db.prepare('SELECT * FROM users WHERE id = ?').get(order.doctor_id);
  if (!doctor) {
    return res.status(404).send('Doctor not found');
  }

  // Get service/specialty pricing
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(order.service_id);
  const appointmentPrice = service?.appointment_price || 0;

  // Get doctor's availability
  const availability = db.prepare(`
    SELECT * FROM doctor_availability 
    WHERE doctor_id = ? AND is_active = 1
    ORDER BY day_of_week, start_time
  `).all(order.doctor_id);

  // Generate available slots for next 30 days
  const slots = generateAvailableSlots(doctor.id, availability, 30);

  res.render('appointment_booking', {
    layout: 'portal',
    order,
    doctor,
    appointmentPrice,
    slots,
    timezones: TIMEZONES,
    patient: req.user
  });
});

// POST /portal/appointments/book - Create appointment and payment
router.post('/portal/appointments/book', requireRole('patient'), (req, res) => {
  const { order_id, doctor_id, scheduled_at, timezone: tz } = req.body;
  const patientId = req.user.id;

  if (!scheduled_at || !tz) {
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  }

  try {
    // Get order details
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(order_id);
    if (!order) return res.status(404).json({ ok: false, error: 'Order not found' });

    // Get service pricing
    const service = db.prepare('SELECT * FROM services WHERE id = ?').get(order.service_id);
    const price = service?.appointment_price || 0;
    const commissionPct = service?.doctor_commission_pct || 70;

    // Create appointment
    const appointmentId = randomUUID();
    db.prepare(`
      INSERT INTO appointments 
      (id, order_id, patient_id, doctor_id, specialty_id, scheduled_at, price, doctor_commission_pct, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(appointmentId, order_id, patientId, doctor_id, order.service_id, scheduled_at, price, commissionPct);

    // Create payment record
    const paymentId = randomUUID();
    db.prepare(`
      INSERT INTO appointment_payments 
      (id, appointment_id, patient_id, amount, currency, status, method)
      VALUES (?, ?, ?, ?, 'EGP', 'pending', 'paymob')
    `).run(paymentId, appointmentId, patientId, price);

    // Notify patient of booking (email + whatsapp + internal)
    const doctorRow = db.prepare('SELECT name FROM users WHERE id = ?').get(doctor_id);
    queueMultiChannelNotification({
      orderId: order_id,
      toUserId: patientId,
      channels: ['email', 'whatsapp', 'internal'],
      template: 'appointment_booked',
      response: {
        doctor_name: doctorRow ? doctorRow.name : '',
        appointment_time: scheduled_at,
        appointmentDate: scheduled_at,
        price,
      },
    });

    // Notify doctor of new appointment
    queueMultiChannelNotification({
      orderId: order_id,
      toUserId: doctor_id,
      channels: ['email', 'internal'],
      template: 'appointment_booked',
      response: {
        appointment_time: scheduled_at,
        appointmentDate: scheduled_at,
        price,
      },
    });

    // Redirect to payment
    res.json({ ok: true, appointment_id: appointmentId, payment_id: paymentId });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /portal/appointments/:id - View appointment details
router.get('/portal/appointments/:id', requireRole('patient', 'doctor'), (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  const appointment = db.prepare(`
    SELECT a.*, 
           u.name as doctor_name,
           o.notes as case_notes
    FROM appointments a
    LEFT JOIN users u ON u.id = a.doctor_id
    LEFT JOIN orders o ON o.id = a.order_id
    WHERE a.id = ? AND (a.patient_id = ? OR a.doctor_id = ?)
  `).get(id, userId, userId);

  if (!appointment) {
    return res.status(404).send('Appointment not found');
  }

  res.render('appointment_detail', {
    layout: 'portal',
    appointment,
    user: req.user
  });
});

// POST /portal/appointments/:id/cancel - Cancel appointment with refund
router.post('/portal/appointments/:id/cancel', requireRole('patient', 'doctor'), (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const { reason } = req.body;

  try {
    const appointment = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
    if (!appointment) {
      return res.status(404).json({ ok: false, error: 'Appointment not found' });
    }

    // Calculate hours until appointment
    const now = dayjs();
    const scheduled = dayjs(appointment.scheduled_at);
    const hoursDiff = scheduled.diff(now, 'hours');

    // Determine refund eligibility
    let refundAmount = 0;
    if (hoursDiff > 24) {
      refundAmount = appointment.price; // Full refund
    }
    // else: no refund if < 24h

    // Update appointment status
    db.prepare('UPDATE appointments SET status = ?, cancel_reason = ? WHERE id = ?')
      .run('cancelled', reason, id);

    // Create refund record if applicable
    if (refundAmount > 0) {
      db.prepare(`
        UPDATE appointment_payments 
        SET status = 'refunded', refund_reason = ?, refunded_at = ?
        WHERE appointment_id = ?
      `).run(reason, new Date().toISOString(), id);

      // Notify patient
      queueMultiChannelNotification({
        orderId: appointment.order_id,
        toUserId: appointment.patient_id,
        channels: ['internal', 'email', 'whatsapp'],
        template: 'appointment_cancelled',
        response: {
          refund_amount: refundAmount,
          reason,
          appointmentDate: appointment.scheduled_at,
          doctorName: ''
        },
        dedupe_key: 'appt_cancel:' + id + ':patient'
      });
    }
    // Also notify doctor
    if (appointment.doctor_id) {
      queueMultiChannelNotification({
        orderId: appointment.order_id,
        toUserId: appointment.doctor_id,
        channels: ['internal', 'email'],
        template: 'appointment_cancelled',
        response: {
          appointmentDate: appointment.scheduled_at,
          patientName: ''
        },
        dedupe_key: 'appt_cancel:' + id + ':doctor'
      });
    }

    res.json({ ok: true, refund_amount: refundAmount });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /portal/appointments/:id/reschedule - Reschedule appointment
router.post('/portal/appointments/:id/reschedule', requireRole('patient', 'doctor'), (req, res) => {
  const { id } = req.params;
  const { new_scheduled_at } = req.body;
  const userId = req.user.id;

  try {
    const appointment = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
    if (!appointment) {
      return res.status(404).json({ ok: false, error: 'Appointment not found' });
    }

    // Check 24h rule
    const now = dayjs();
    const scheduled = dayjs(appointment.scheduled_at);
    const hoursDiff = scheduled.diff(now, 'hours');

    if (hoursDiff < 24) {
      return res.status(400).json({ ok: false, error: 'Cannot reschedule within 24 hours' });
    }

    // Update appointment
    db.prepare(`
      UPDATE appointments 
      SET scheduled_at = ?, rescheduled_from = ?, rescheduled_at = ?, updated_at = ?
      WHERE id = ?
    `).run(new_scheduled_at, appointment.scheduled_at, new Date().toISOString(), new Date().toISOString(), id);

    // Notify patient
    queueMultiChannelNotification({
      orderId: appointment.order_id,
      toUserId: appointment.patient_id,
      channels: ['internal', 'email', 'whatsapp'],
      template: 'appointment_rescheduled',
      response: {
        old_time: appointment.scheduled_at,
        new_time: new_scheduled_at,
        appointmentDate: new_scheduled_at,
        doctorName: ''
      },
      dedupe_key: 'appt_reschedule:' + id + ':patient'
    });
    // Also notify doctor
    if (appointment.doctor_id) {
      queueMultiChannelNotification({
        orderId: appointment.order_id,
        toUserId: appointment.doctor_id,
        channels: ['internal', 'email'],
        template: 'appointment_rescheduled',
        response: {
          old_time: appointment.scheduled_at,
          new_time: new_scheduled_at,
          appointmentDate: new_scheduled_at,
          patientName: ''
        },
        dedupe_key: 'appt_reschedule:' + id + ':doctor'
      });
    }

    res.json({ ok: true, message: 'Appointment rescheduled' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== HELPERS =====

function generateAvailableSlots(doctorId, availability, daysAhead = 30) {
  const slots = [];
  const now = dayjs();

  for (let i = 1; i <= daysAhead; i++) {
    const checkDate = now.add(i, 'day');
    const dayOfWeek = checkDate.day();

    // Find availability for this day
    const dayAvail = availability.filter(a => a.day_of_week === dayOfWeek);

    for (const avail of dayAvail) {
      // Generate 30-min slots between start and end time
      let slotTime = dayjs(`${checkDate.format('YYYY-MM-DD')} ${avail.start_time}`);
      const endTime = dayjs(`${checkDate.format('YYYY-MM-DD')} ${avail.end_time}`);

      while (slotTime.isBefore(endTime)) {
        // Check if slot is already booked
        const booked = db.prepare(`
          SELECT id FROM appointment_slots 
          WHERE doctor_id = ? AND available_at = ? AND is_booked = 1
        `).get(doctorId, slotTime.toISOString());

        if (!booked) {
          slots.push({
            id: randomUUID(),
            time: slotTime.toISOString(),
            display: slotTime.format('MMM DD, HH:mm'),
            timezone: avail.timezone
          });
        }

        slotTime = slotTime.add(30, 'minutes');
      }
    }
  }

  return slots;
}

// GET /portal/appointments - List patient's appointments
router.get('/portal/appointments', requireRole('patient'), (req, res) => {
  const patientId = req.user.id;
  const lang = getLang(req, res);
  const isAr = String(lang).toLowerCase() === 'ar';

  const appointments = db.prepare(`
    SELECT a.*, u.name as doctor_name, s.name as specialty_name
    FROM appointments a
    LEFT JOIN users u ON a.doctor_id = u.id
    LEFT JOIN specialties s ON a.specialty_id = s.id
    WHERE a.patient_id = ?
    ORDER BY a.scheduled_at DESC
  `).all(patientId);

  res.render('patient_appointments_list', {
    user: req.user,
    appointments,
    lang,
    isAr,
    pageTitle: isAr ? 'مواعيدي' : 'My Appointments'
  });
});

// GET /portal/patient/appointments — Redirect to /portal/appointments
router.get('/portal/patient/appointments', requireRole('patient'), (req, res) => {
  res.redirect(302, '/portal/appointments');
});

module.exports = router;
