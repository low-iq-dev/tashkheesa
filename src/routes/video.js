const dayjs = require('dayjs');
// src/routes/video.js
// Video Consultation routes: appointment booking, payment, video calls, reschedule, cancel, no-show.

const express = require('express');
const { randomUUID } = require('crypto');
const { queryOne, queryAll, execute, withTransaction } = require('../pg');
const { requireRole } = require('../middleware');
const { queueNotification } = require('../notify');
const { logOrderEvent } = require('../audit');
const { generateToken, getRoomName, isVideoEnabled } = require('../video_helpers');

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLang(req) {
  return (req.cookies && req.cookies.lang) || (req.user && req.user.lang) || 'en';
}

function t(lang, en, ar) {
  return String(lang).toLowerCase() === 'ar' ? ar : en;
}

function nowIso() {
  return new Date().toISOString();
}

function hoursUntil(isoDate) {
  return dayjs(isoDate).diff(dayjs(), 'hour', true);
}

function minutesUntil(isoDate) {
  return dayjs(isoDate).diff(dayjs(), 'minute', true);
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function ensureParticipant(appointment, userId) {
  return appointment.patient_id === userId || appointment.doctor_id === userId;
}

/**
 * Resolve price from a JSON prices column based on currency.
 * @param {string|null} pricesJson - JSON string like '{"EGP":200,"SAR":50,"GBP":15}'
 * @param {string} currency - Target currency code (e.g. 'EGP', 'SAR')
 * @param {number} fallbackPrice - Default price if currency not found
 * @returns {{ price: number, currency: string }}
 */
function resolvePrice(pricesJson, currency, fallbackPrice) {
  if (!pricesJson || pricesJson === '{}') {
    return { price: fallbackPrice || 0, currency: currency || 'EGP' };
  }
  try {
    const prices = JSON.parse(pricesJson);
    const cur = (currency || 'EGP').toUpperCase();
    if (prices[cur] !== undefined && prices[cur] !== null) {
      return { price: Number(prices[cur]), currency: cur };
    }
    // Fallback to EGP if available
    if (prices.EGP !== undefined) {
      return { price: Number(prices.EGP), currency: 'EGP' };
    }
    return { price: fallbackPrice || 0, currency: cur };
  } catch (_) {
    return { price: fallbackPrice || 0, currency: currency || 'EGP' };
  }
}

function getPatientCurrency(req) {
  // Check order's locked currency, then user's country, then default
  const userCountry = (req.user && req.user.country_code) || '';
  const COUNTRY_MAP = { EG: 'EGP', GB: 'GBP', SA: 'SAR', AE: 'AED', KW: 'KWD', QA: 'QAR', BH: 'BHD', OM: 'OMR' };
  const code = userCountry.toUpperCase();
  return COUNTRY_MAP[code] || 'EGP';
}

// ---------------------------------------------------------------------------
// GET /portal/video/book/:orderId — Show booking form (patient)
// ---------------------------------------------------------------------------
router.get('/portal/video/book/:orderId', requireRole('patient'), async (req, res) => {
  const lang = getLang(req);
  const { orderId } = req.params;

  const order = await queryOne('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!order || order.patient_id !== req.user.id) {
    return res.status(404).render('error', {
      layout: 'portal', title: 'Not Found',
      message: t(lang, 'Order not found', 'الطلب غير موجود'), lang
    });
  }

  const service = order.service_id
    ? await queryOne('SELECT * FROM services WHERE id = $1', [order.service_id])
    : null;

  const patientCurrency = order.locked_currency || getPatientCurrency(req);
  const resolved = resolvePrice(
    service && service.video_consultation_prices_json,
    patientCurrency,
    (service && service.video_consultation_price) ? service.video_consultation_price : 200
  );

  // Check for existing pending appointment on this order
  const existingAppointment = await queryOne(
    `SELECT * FROM appointments WHERE order_id = $1 AND patient_id = $2
     AND status NOT IN ('cancelled','no_show_patient','no_show_doctor')
     ORDER BY created_at DESC LIMIT 1`,
    [orderId, req.user.id]
  );

  res.render('video_appointment', {
    layout: 'portal',
    title: t(lang, 'Book Video Consultation', 'حجز استشارة فيديو'),
    lang,
    portalFrame: true,
    portalRole: 'patient',
    portalActive: 'dashboard',
    mode: 'book',
    order,
    doctor: null,
    service,
    price: resolved.price,
    priceCurrency: resolved.currency,
    commissionPct: (service && service.video_doctor_commission_pct) ? service.video_doctor_commission_pct : 70,
    existingAppointment,
    appointment: null,
    videoEnabled: isVideoEnabled()
  });
});

// ---------------------------------------------------------------------------
// POST /portal/video/book — Patient picks preferred slot, pay, await doctor
// ---------------------------------------------------------------------------
router.post('/portal/video/book', requireRole('patient'), async (req, res) => {
  const lang = getLang(req);
  const { order_id, scheduled_at } = req.body;

  if (!order_id || !scheduled_at) {
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  }

  const scheduledDate = dayjs(scheduled_at);
  if (!scheduledDate.isValid() || scheduledDate.isBefore(dayjs().add(1, 'hour'))) {
    return res.status(400).json({ ok: false, error: 'Date must be at least 1 hour from now' });
  }

  const order = await queryOne('SELECT * FROM orders WHERE id = $1 AND patient_id = $2', [order_id, req.user.id]);
  if (!order) return res.status(404).json({ ok: false, error: 'Order not found' });

  const service = order.service_id
    ? await queryOne('SELECT * FROM services WHERE id = $1', [order.service_id])
    : null;

  const patientCurrency = order.locked_currency || getPatientCurrency(req);
  const resolved = resolvePrice(
    service && service.video_consultation_prices_json,
    patientCurrency,
    (service && service.video_consultation_price) ? Number(service.video_consultation_price) : 200
  );
  const price = resolved.price;
  const priceCurrency = resolved.currency;
  const commissionPct = (service && service.video_doctor_commission_pct) ? Number(service.video_doctor_commission_pct) : 70;

  try {
    const result = await withTransaction(async (client) => {
      const appointmentId = `appt-${randomUUID()}`;
      const paymentId = `vpay-${randomUUID()}`;
      const videoCallId = `vcall-${randomUUID()}`;
      const now = nowIso();

      await client.query(`
        INSERT INTO appointment_payments (id, appointment_id, patient_id, amount, currency, status, created_at)
        VALUES ($1, $2, $3, $4, $5, 'pending', $6)
      `, [paymentId, appointmentId, req.user.id, price, priceCurrency, now]);

      // status = 'pending_payment' — slot requested, awaiting payment
      await client.query(`
        INSERT INTO appointments
          (id, order_id, patient_id, doctor_id, specialty_id, scheduled_at, status,
           video_call_id, payment_id, price, doctor_commission_pct,
           patient_requested_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'pending_payment', $7, $8, $9, $10, $11, $12, $13)
      `, [
        appointmentId, order_id,
        req.user.id,
        order.doctor_id || null,       // may be null if no doctor yet — assigned on acceptance
        order.specialty_id || null,
        scheduledDate.toISOString(),
        videoCallId, paymentId, price, commissionPct,
        now, now, now
      ]);

      await client.query(`
        INSERT INTO video_calls (id, appointment_id, patient_id, doctor_id, status, twilio_room_name, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7)
      `, [videoCallId, appointmentId, req.user.id, order.doctor_id || null, getRoomName(appointmentId), now, now]);

      return { appointmentId, paymentId };
    });

    logOrderEvent({
      orderId: order_id,
      label: 'video_slot_requested',
      meta: JSON.stringify({ appointment_id: result.appointmentId, preferred_slot: scheduledDate.toISOString(), price }),
      actorUserId: req.user.id,
      actorRole: 'patient'
    });

    return res.redirect(`/portal/video/pay/${result.appointmentId}`);
  } catch (err) {
    console.error('[video] Booking failed:', err.message);
    return res.status(500).json({ ok: false, error: 'Booking failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /portal/video/pay/:appointmentId — Video payment page (Paymob hosted)
// ---------------------------------------------------------------------------
router.get('/portal/video/pay/:appointmentId', requireRole('patient'), async (req, res) => {
  const lang = getLang(req);
  const appointment = await queryOne('SELECT * FROM appointments WHERE id = $1', [req.params.appointmentId]);

  if (!appointment || appointment.patient_id !== req.user.id) {
    return res.status(404).render('error', {
      layout: 'portal', title: 'Not Found',
      message: t(lang, 'Appointment not found', 'الموعد غير موجود'), lang
    });
  }

  if (appointment.status === 'confirmed') {
    // Already paid — go straight to appointment detail
    return res.redirect(`/portal/video/appointment/${appointment.id}`);
  }

  const payment = appointment.payment_id
    ? await queryOne('SELECT * FROM appointment_payments WHERE id = $1', [appointment.payment_id])
    : null;

  if (payment && payment.status === 'paid') {
    return res.redirect(`/portal/video/appointment/${appointment.id}`);
  }

  const doctor = await queryOne('SELECT id, name FROM users WHERE id = $1', [appointment.doctor_id]);
  const PAYMOB_PUBLIC_KEY = process.env.PAYMOB_PUBLIC_KEY || '';
  const callbackUrl = `${process.env.BASE_URL || ''}/portal/video/payment/callback`;
  const returnUrl = `${process.env.BASE_URL || ''}/portal/video/appointment/${appointment.id}`;

  res.render('video_appointment', {
    layout: 'portal',
    title: t(lang, 'Pay for Video Consultation', 'الدفع للاستشارة المرئية'),
    lang,
    portalFrame: true,
    portalRole: 'patient',
    portalActive: 'dashboard',
    mode: 'pay',
    appointment,
    doctor,
    payment,
    price: appointment.price,
    priceCurrency: payment ? payment.currency : 'EGP',
    paymobPublicKey: PAYMOB_PUBLIC_KEY,
    callbackUrl,
    returnUrl,
    videoEnabled: isVideoEnabled(),
    order: null,
    service: null,
    existingAppointment: null
  });
});

// ---------------------------------------------------------------------------
// POST /portal/video/payment/callback — Paymob webhook for video payment
// ---------------------------------------------------------------------------
router.post('/portal/video/payment/callback', async (req, res) => {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ ok: false, error: 'webhook_not_configured' });

  const providedSecret = req.headers['x-webhook-secret'] || req.query.secret;
  if (secret !== providedSecret) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const { payment_id, status, reference } = req.body || {};
  if (!payment_id) return res.status(400).json({ ok: false, error: 'payment_id required' });

  const payment = await queryOne('SELECT * FROM appointment_payments WHERE id = $1', [payment_id]);
  if (!payment) return res.status(404).json({ ok: false, error: 'payment not found' });

  const normalizedStatus = String(status || '').toLowerCase();
  if (!['success', 'paid', 'complete', 'completed'].includes(normalizedStatus)) {
    return res.json({ ok: true, note: 'non-success status' });
  }

  if (payment.status === 'paid') return res.json({ ok: true, note: 'already paid' });

  const now = nowIso();
  await execute(`UPDATE appointment_payments SET status = 'paid', paid_at = $1, method = 'paymob', reference = $2 WHERE id = $3`, [now, reference || null, payment_id]);

  // Move to pending_doctor — paid, slot requested, waiting for doctor to accept/reschedule
  await execute(`
    UPDATE appointments SET status = 'pending_doctor', updated_at = $1
    WHERE id = $2
  `, [now, payment.appointment_id]);

  const appointment = await queryOne('SELECT * FROM appointments WHERE id = $1', [payment.appointment_id]);
  if (appointment) {
    // Notify patient: payment confirmed, doctor will review slot
    queueNotification({
      orderId: appointment.order_id,
      toUserId: appointment.patient_id,
      channel: 'internal',
      template: 'video_payment_confirmed',
      status: 'queued',
      response: JSON.stringify({
        appointment_id: appointment.id,
        scheduled_at: appointment.scheduled_at
      })
    });
    queueNotification({
      orderId: appointment.order_id,
      toUserId: appointment.patient_id,
      channel: 'whatsapp',
      template: 'video_payment_confirmed',
      status: 'queued',
      response: JSON.stringify({ appointment_id: appointment.id, scheduled_at: appointment.scheduled_at })
    });

    // Notify doctor (if assigned) to review the slot request
    if (appointment.doctor_id) {
      queueNotification({
        orderId: appointment.order_id,
        toUserId: appointment.doctor_id,
        channel: 'internal',
        template: 'video_slot_review_requested',
        status: 'queued',
        response: JSON.stringify({
          appointment_id: appointment.id,
          patient_preferred_slot: appointment.scheduled_at
        })
      });
    }
  }

  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /portal/video/appointment/:id — View appointment detail
// ---------------------------------------------------------------------------
router.get('/portal/video/appointment/:id', requireRole('patient', 'doctor'), async (req, res) => {
  const lang = getLang(req);
  const appointment = await queryOne('SELECT * FROM appointments WHERE id = $1', [req.params.id]);

  if (!appointment || !ensureParticipant(appointment, req.user.id)) {
    return res.status(404).render('error', {
      layout: 'portal', title: 'Not Found',
      message: t(lang, 'Appointment not found', 'الموعد غير موجود'), lang
    });
  }

  const doctor = await queryOne('SELECT id, name, email, specialty_id FROM users WHERE id = $1', [appointment.doctor_id]);
  const patient = await queryOne('SELECT id, name, email FROM users WHERE id = $1', [appointment.patient_id]);
  const payment = appointment.payment_id
    ? await queryOne('SELECT * FROM appointment_payments WHERE id = $1', [appointment.payment_id])
    : null;
  const videoCall = appointment.video_call_id
    ? await queryOne('SELECT * FROM video_calls WHERE id = $1', [appointment.video_call_id])
    : null;

  const hoursAway = hoursUntil(appointment.scheduled_at);
  const minsAway = minutesUntil(appointment.scheduled_at);
  const canJoin = minsAway <= 15 && minsAway >= -60 && ['confirmed', 'started'].includes(appointment.status);
  const canReschedule = hoursAway > 24 && ['pending_doctor', 'confirmed'].includes(appointment.status);
  const canCancel = ['pending_payment', 'pending_doctor', 'confirmed'].includes(appointment.status);
  const refundEligible = hoursAway > 24;

  const isDoctor = req.user.role === 'doctor';
  const earnings = isDoctor
    ? await queryOne('SELECT * FROM doctor_earnings WHERE appointment_id = $1', [appointment.id])
    : null;

  res.render('video_appointment', {
    layout: 'portal',
    title: t(lang, 'Video Consultation', 'استشارة فيديو'),
    lang,
    portalFrame: true,
    portalRole: isDoctor ? 'doctor' : 'patient',
    portalActive: 'dashboard',
    mode: 'view',
    appointment,
    doctor,
    patient,
    payment,
    videoCall,
    canJoin,
    canReschedule,
    canCancel,
    refundEligible,
    hoursAway,
    earnings,
    videoEnabled: isVideoEnabled(),
    order: null,
    service: null,
    price: appointment.price,
    existingAppointment: null
  });
});

// ---------------------------------------------------------------------------
// POST /portal/video/appointment/:id/reschedule — Reschedule appointment
// ---------------------------------------------------------------------------
router.post('/portal/video/appointment/:id/reschedule', requireRole('patient', 'doctor'), async (req, res) => {
  const lang = getLang(req);
  const appointment = await queryOne('SELECT * FROM appointments WHERE id = $1', [req.params.id]);

  if (!appointment || !ensureParticipant(appointment, req.user.id)) {
    return res.status(404).json({ ok: false, error: 'Appointment not found' });
  }

  if (!['pending_doctor', 'confirmed'].includes(appointment.status)) {
    return res.status(400).json({ ok: false, error: 'Cannot reschedule this appointment' });
  }

  if (hoursUntil(appointment.scheduled_at) < 24) {
    return res.status(400).json({ ok: false, error: 'Cannot reschedule within 24 hours of appointment' });
  }

  const { new_scheduled_at } = req.body;
  const newDate = dayjs(new_scheduled_at);
  if (!newDate.isValid() || newDate.isBefore(dayjs())) {
    return res.status(400).json({ ok: false, error: 'Invalid or past date' });
  }

  // Validate new time falls within doctor's availability
  const newDayOfWeek = newDate.day();
  const newTimeStr = newDate.format('HH:mm');
  const doctorAvail = await queryOne(`
    SELECT * FROM doctor_availability
    WHERE doctor_id = $1 AND day_of_week = $2 AND is_active = true
    AND start_time <= $3 AND end_time > $4
  `, [appointment.doctor_id, newDayOfWeek, newTimeStr, newTimeStr]);

  if (!doctorAvail) {
    return res.status(400).json({ ok: false, error: t(lang, 'Selected time is outside doctor availability', 'الوقت المحدد خارج أوقات عمل الطبيب') });
  }

  // Check for SLA conflict on linked order
  if (appointment.order_id) {
    const order = await queryOne('SELECT * FROM orders WHERE id = $1', [appointment.order_id]);
    if (order && order.sla_24hr_deadline) {
      const slaDeadline = dayjs(order.sla_24hr_deadline);
      if (newDate.isAfter(slaDeadline)) {
        return res.status(400).json({
          ok: false,
          error: t(lang, 'New time exceeds the 24h SLA deadline for this case', 'الوقت الجديد يتجاوز الموعد النهائي لاتفاقية 24 ساعة')
        });
      }
    }
  }

  // Check for conflicting appointments at the same time
  const conflict = await queryOne(`
    SELECT id FROM appointments
    WHERE doctor_id = $1 AND id != $2
    AND status IN ('pending', 'confirmed')
    AND scheduled_at = $3
  `, [appointment.doctor_id, appointment.id, newDate.toISOString()]);

  if (conflict) {
    return res.status(400).json({ ok: false, error: t(lang, 'Doctor already has an appointment at this time', 'الطبيب لديه موعد آخر في هذا الوقت') });
  }

  const now = nowIso();
  const oldScheduledAt = appointment.scheduled_at;

  await execute(`
    UPDATE appointments
    SET scheduled_at = $1, rescheduled_from = $2, rescheduled_at = $3, updated_at = $4
    WHERE id = $5
  `, [newDate.toISOString(), oldScheduledAt, now, now, appointment.id]);

  // Notify both participants
  const otherUserId = req.user.id === appointment.patient_id ? appointment.doctor_id : appointment.patient_id;
  queueNotification({
    orderId: appointment.order_id,
    toUserId: otherUserId,
    channel: 'internal',
    template: 'video_appointment_rescheduled',
    status: 'queued',
    response: JSON.stringify({
      appointment_id: appointment.id,
      old_time: oldScheduledAt,
      new_time: newDate.toISOString()
    })
  });
  queueNotification({
    orderId: appointment.order_id,
    toUserId: otherUserId,
    channel: 'whatsapp',
    template: 'video_appointment_rescheduled',
    status: 'queued',
    response: JSON.stringify({
      appointment_id: appointment.id,
      new_time: newDate.toISOString()
    })
  });

  logOrderEvent({
    orderId: appointment.order_id,
    label: 'video_appointment_rescheduled',
    meta: JSON.stringify({ appointment_id: appointment.id, from: oldScheduledAt, to: newDate.toISOString() }),
    actorUserId: req.user.id,
    actorRole: req.user.role
  });

  return res.redirect(`/portal/video/appointment/${appointment.id}`);
});

// ---------------------------------------------------------------------------
// POST /portal/video/appointment/:id/cancel — Cancel appointment
// ---------------------------------------------------------------------------
router.post('/portal/video/appointment/:id/cancel', requireRole('patient', 'doctor'), async (req, res) => {
  const lang = getLang(req);
  const appointment = await queryOne('SELECT * FROM appointments WHERE id = $1', [req.params.id]);

  if (!appointment || !ensureParticipant(appointment, req.user.id)) {
    return res.status(404).json({ ok: false, error: 'Appointment not found' });
  }

  if (!['pending_payment', 'pending_doctor', 'confirmed'].includes(appointment.status)) {
    return res.status(400).json({ ok: false, error: 'Cannot cancel this appointment' });
  }

  // Pre-payment: hard delete — nothing was charged, nothing to record
  if (appointment.status === 'pending_payment') {
    const now = nowIso();
    if (appointment.video_call_id) {
      await execute(`DELETE FROM video_calls WHERE id = $1`, [appointment.video_call_id]);
    }
    if (appointment.payment_id) {
      await execute(`DELETE FROM appointment_payments WHERE id = $1`, [appointment.payment_id]);
    }
    await execute(`DELETE FROM appointments WHERE id = $1`, [appointment.id]);
    logOrderEvent({
      orderId: appointment.order_id,
      label: 'video_slot_cancelled_pre_payment',
      meta: JSON.stringify({ appointment_id: appointment.id }),
      actorUserId: req.user.id,
      actorRole: req.user.role
    });
    return res.redirect('/portal/video/appointments');
  }

  const now = nowIso();
  const hoursAway = hoursUntil(appointment.scheduled_at);
  const reason = req.body.reason || '';
  const isDoctor = req.user.role === 'doctor';

  // Doctors cannot cancel pending_doctor or reschedule_proposed — they must accept or propose
  if (isDoctor && ['pending_doctor', 'reschedule_proposed'].includes(appointment.status)) {
    return res.status(403).json({ ok: false, error: 'Use accept or propose to respond to this appointment' });
  }

  // Determine refund eligibility
  // Doctor-initiated cancellations always get full refund for the patient
  const isDoctorCancel = req.user.role === 'doctor';
  let refundStatus = 'no_refund';
  if (isDoctorCancel || hoursAway > 24) {
    refundStatus = 'full_refund';
    const refundReason = isDoctorCancel
      ? 'Cancelled by doctor'
      : 'Cancelled 24h+ before appointment';
    if (appointment.payment_id) {
      await execute(`UPDATE appointment_payments SET status = 'refunded', refund_reason = $1, refunded_at = $2 WHERE id = $3`,
        [refundReason, now, appointment.payment_id]);
    }
  }

  // Cancel appointment
  await execute(`UPDATE appointments SET status = 'cancelled', cancel_reason = $1, updated_at = $2 WHERE id = $3`,
    [reason || `Cancelled by ${req.user.role}`, now, appointment.id]);

  // Cancel video call
  if (appointment.video_call_id) {
    await execute(`UPDATE video_calls SET status = 'cancelled', updated_at = $1 WHERE id = $2`,
      [now, appointment.video_call_id]);
  }

  // Notify other participant
  const otherUserId = req.user.id === appointment.patient_id ? appointment.doctor_id : appointment.patient_id;
  queueNotification({
    orderId: appointment.order_id,
    toUserId: otherUserId,
    channel: 'internal',
    template: 'video_appointment_cancelled',
    status: 'queued',
    response: JSON.stringify({
      appointment_id: appointment.id,
      refund_status: refundStatus,
      cancelled_by: req.user.role
    })
  });
  queueNotification({
    orderId: appointment.order_id,
    toUserId: appointment.patient_id,
    channel: 'whatsapp',
    template: 'video_appointment_cancelled',
    status: 'queued',
    response: JSON.stringify({
      appointment_id: appointment.id,
      refund_status: refundStatus
    })
  });

  logOrderEvent({
    orderId: appointment.order_id,
    label: 'video_appointment_cancelled',
    meta: JSON.stringify({ appointment_id: appointment.id, refund_status: refundStatus, reason }),
    actorUserId: req.user.id,
    actorRole: req.user.role
  });

  return res.redirect(`/portal/video/appointment/${appointment.id}`);
});

// ---------------------------------------------------------------------------
// GET /portal/video/call/:appointmentId — Render video call room
// ---------------------------------------------------------------------------
router.get('/portal/video/call/:appointmentId', requireRole('patient', 'doctor'), async (req, res) => {
  const lang = getLang(req);
  const appointment = await queryOne('SELECT * FROM appointments WHERE id = $1', [req.params.appointmentId]);

  if (!appointment || !ensureParticipant(appointment, req.user.id)) {
    return res.status(404).render('error', {
      layout: 'portal', title: 'Not Found',
      message: t(lang, 'Appointment not found', 'الموعد غير موجود'), lang
    });
  }

  if (!['confirmed', 'started'].includes(appointment.status)) {
    return res.redirect(`/portal/video/appointment/${appointment.id}`);
  }

  // Check if within join window (5 min before to 60 min after)
  const minsAway = minutesUntil(appointment.scheduled_at);
  if (minsAway > 15) {
    return res.redirect(`/portal/video/appointment/${appointment.id}`);
  }

  const doctor = await queryOne('SELECT id, name, email FROM users WHERE id = $1', [appointment.doctor_id]);
  const patient = await queryOne('SELECT id, name, email FROM users WHERE id = $1', [appointment.patient_id]);
  const videoCall = appointment.video_call_id
    ? await queryOne('SELECT * FROM video_calls WHERE id = $1', [appointment.video_call_id])
    : null;

  const isDoctor = req.user.role === 'doctor';
  const roomName = getRoomName(appointment.id);

  res.render('video_call_room', {
    layout: 'portal',
    title: t(lang, 'Video Call', 'مكالمة فيديو'),
    lang,
    portalFrame: false,
    showFooter: false,
    showNav: false,
    appointment,
    doctor,
    patient,
    videoCall,
    roomName,
    isDoctor,
    participantName: isDoctor ? (doctor && doctor.name) : (patient && patient.name),
    otherName: isDoctor ? (patient && patient.name) : (doctor && doctor.name)
  });
});

// ---------------------------------------------------------------------------
// POST /api/video/token/:appointmentId — Generate Twilio access token (JSON)
// ---------------------------------------------------------------------------
router.post('/api/video/token/:appointmentId', requireRole('patient', 'doctor'), async (req, res) => {
  const appointment = await queryOne('SELECT * FROM appointments WHERE id = $1', [req.params.appointmentId]);

  if (!appointment || !ensureParticipant(appointment, req.user.id)) {
    return res.status(404).json({ ok: false, error: 'Appointment not found' });
  }

  if (!['confirmed', 'started'].includes(appointment.status)) {
    return res.status(400).json({ ok: false, error: 'Appointment not in joinable state' });
  }

  if (!isVideoEnabled()) {
    return res.status(503).json({ ok: false, error: 'Video consultation is not configured. Set TWILIO credentials in .env' });
  }

  try {
    const roomName = getRoomName(appointment.id);
    const identity = `${req.user.role}-${req.user.id}`;
    const result = generateToken(roomName, identity);

    // Mark appointment as started if first join
    const now = nowIso();
    if (appointment.status === 'confirmed') {
      await execute(`UPDATE appointments SET status = 'started', updated_at = $1 WHERE id = $2`, [now, appointment.id]);
    }

    // Update video call
    if (appointment.video_call_id) {
      const vc = await queryOne('SELECT * FROM video_calls WHERE id = $1', [appointment.video_call_id]);
      if (vc && vc.status === 'pending') {
        await execute(`UPDATE video_calls SET status = 'active', initiated_by = $1, started_at = $2, updated_at = $3 WHERE id = $4`,
          [req.user.id, now, now, appointment.video_call_id]);
      }
    }

    // Notify other participant
    const otherUserId = req.user.id === appointment.patient_id ? appointment.doctor_id : appointment.patient_id;
    queueNotification({
      orderId: appointment.order_id,
      toUserId: otherUserId,
      channel: 'internal',
      template: 'video_call_started',
      status: 'queued',
      response: JSON.stringify({
        appointment_id: appointment.id,
        joined_by: req.user.role,
        joined_name: req.user.name || req.user.email
      }),
      dedupe_key: `video:joined:${appointment.id}:${req.user.id}`
    });

    return res.json({
      ok: true,
      token: result.token,
      roomName: result.roomName,
      identity
    });
  } catch (err) {
    console.error('[video] Token generation failed:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to generate video token' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/video/end/:appointmentId — End call, calc duration, create earnings
// ---------------------------------------------------------------------------
router.post('/api/video/end/:appointmentId', requireRole('patient', 'doctor'), async (req, res) => {
  const appointment = await queryOne('SELECT * FROM appointments WHERE id = $1', [req.params.appointmentId]);

  if (!appointment || !ensureParticipant(appointment, req.user.id)) {
    return res.status(404).json({ ok: false, error: 'Appointment not found' });
  }

  const now = nowIso();
  const videoCall = appointment.video_call_id
    ? await queryOne('SELECT * FROM video_calls WHERE id = $1', [appointment.video_call_id])
    : null;

  let durationSeconds = 0;
  if (videoCall && videoCall.started_at) {
    durationSeconds = Math.max(0, Math.round(dayjs(now).diff(dayjs(videoCall.started_at), 'second')));
  }

  try {
    const result = await withTransaction(async (client) => {
      // End video call
      if (videoCall && videoCall.status === 'active') {
        await client.query(`
          UPDATE video_calls SET status = 'ended', ended_at = $1, duration_seconds = $2, updated_at = $3
          WHERE id = $4
        `, [now, durationSeconds, now, videoCall.id]);
      }

      // Complete appointment
      await client.query(`UPDATE appointments SET status = 'completed', updated_at = $1 WHERE id = $2`,
        [now, appointment.id]);

      // Create doctor earnings
      const earnedAmount = Math.round(appointment.price * (appointment.doctor_commission_pct / 100) * 100) / 100;
      const earningsId = `earn-${randomUUID()}`;
      await client.query(`
        INSERT INTO doctor_earnings (id, doctor_id, appointment_id, gross_amount, commission_pct, earned_amount, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
      `, [earningsId, appointment.doctor_id, appointment.id, appointment.price, appointment.doctor_commission_pct, earnedAmount, now]);

      return { durationSeconds, earnedAmount, earningsId };
    });

    // Notify both participants
    for (const uid of [appointment.patient_id, appointment.doctor_id]) {
      queueNotification({
        orderId: appointment.order_id,
        toUserId: uid,
        channel: 'internal',
        template: 'video_call_ended',
        status: 'queued',
        response: JSON.stringify({
          appointment_id: appointment.id,
          duration_seconds: result.durationSeconds,
          duration_formatted: formatDuration(result.durationSeconds)
        })
      });
    }

    // WhatsApp to patient
    queueNotification({
      orderId: appointment.order_id,
      toUserId: appointment.patient_id,
      channel: 'whatsapp',
      template: 'video_call_ended',
      status: 'queued',
      response: JSON.stringify({
        appointment_id: appointment.id,
        duration: formatDuration(result.durationSeconds)
      })
    });

    logOrderEvent({
      orderId: appointment.order_id,
      label: 'video_call_ended',
      meta: JSON.stringify({
        appointment_id: appointment.id,
        duration_seconds: result.durationSeconds,
        earned: result.earnedAmount
      }),
      actorUserId: req.user.id,
      actorRole: req.user.role
    });

    return res.json({
      ok: true,
      duration_seconds: result.durationSeconds,
      duration_formatted: formatDuration(result.durationSeconds),
      earned_amount: result.earnedAmount,
      redirect: `/portal/video/ended/${appointment.id}`
    });
  } catch (err) {
    console.error('[video] End call failed:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to end call' });
  }
});

// ---------------------------------------------------------------------------
// GET /portal/video/ended/:appointmentId — Post-call summary
// ---------------------------------------------------------------------------
router.get('/portal/video/ended/:appointmentId', requireRole('patient', 'doctor'), async (req, res) => {
  const lang = getLang(req);
  const appointment = await queryOne('SELECT * FROM appointments WHERE id = $1', [req.params.appointmentId]);

  if (!appointment || !ensureParticipant(appointment, req.user.id)) {
    return res.status(404).render('error', {
      layout: 'portal', title: 'Not Found',
      message: t(lang, 'Appointment not found', 'الموعد غير موجود'), lang
    });
  }

  const doctor = await queryOne('SELECT id, name, email FROM users WHERE id = $1', [appointment.doctor_id]);
  const patient = await queryOne('SELECT id, name, email FROM users WHERE id = $1', [appointment.patient_id]);
  const videoCall = appointment.video_call_id
    ? await queryOne('SELECT * FROM video_calls WHERE id = $1', [appointment.video_call_id])
    : null;

  const isDoctor = req.user.role === 'doctor';
  const earnings = isDoctor
    ? await queryOne('SELECT * FROM doctor_earnings WHERE appointment_id = $1', [appointment.id])
    : null;

  res.render('video_call_ended', {
    layout: 'portal',
    title: t(lang, 'Call Ended', 'انتهت المكالمة'),
    lang,
    portalFrame: true,
    portalRole: isDoctor ? 'doctor' : 'patient',
    portalActive: 'dashboard',
    appointment,
    doctor,
    patient,
    videoCall,
    earnings,
    isDoctor,
    durationFormatted: videoCall ? formatDuration(videoCall.duration_seconds || 0) : '0s'
  });
});

// ---------------------------------------------------------------------------
// POST /portal/video/appointment/:id/no-show — Mark no-show
// ---------------------------------------------------------------------------
router.post('/portal/video/appointment/:id/no-show', requireRole('doctor', 'superadmin'), async (req, res) => {
  const appointment = await queryOne('SELECT * FROM appointments WHERE id = $1', [req.params.id]);

  if (!appointment) {
    return res.status(404).json({ ok: false, error: 'Appointment not found' });
  }

  if (!['confirmed', 'started'].includes(appointment.status)) {
    return res.status(400).json({ ok: false, error: 'Cannot mark no-show for this appointment' });
  }

  const { no_show_type } = req.body;
  const now = nowIso();

  if (no_show_type === 'doctor') {
    // Doctor no-show: full refund to patient
    await execute(`UPDATE appointments SET status = 'no_show_doctor', updated_at = $1 WHERE id = $2`, [now, appointment.id]);

    if (appointment.payment_id) {
      await execute(`UPDATE appointment_payments SET status = 'refunded', refund_reason = 'Doctor no-show', refunded_at = $1 WHERE id = $2`,
        [now, appointment.payment_id]);
    }

    queueNotification({
      orderId: appointment.order_id,
      toUserId: appointment.patient_id,
      channel: 'internal',
      template: 'video_no_show_doctor',
      status: 'queued',
      response: JSON.stringify({ appointment_id: appointment.id, refund: 'full' })
    });
    queueNotification({
      orderId: appointment.order_id,
      toUserId: appointment.patient_id,
      channel: 'whatsapp',
      template: 'video_no_show_doctor',
      status: 'queued',
      response: JSON.stringify({ appointment_id: appointment.id })
    });
  } else {
    // Patient no-show: no refund, doctor keeps payment
    await execute(`UPDATE appointments SET status = 'no_show_patient', updated_at = $1 WHERE id = $2`, [now, appointment.id]);

    // Create doctor earnings even for no-show
    const earnedAmount = Math.round(appointment.price * (appointment.doctor_commission_pct / 100) * 100) / 100;
    await execute(`
      INSERT INTO doctor_earnings (id, doctor_id, appointment_id, gross_amount, commission_pct, earned_amount, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
    `, [`earn-${randomUUID()}`, appointment.doctor_id, appointment.id, appointment.price, appointment.doctor_commission_pct, earnedAmount, now]);

    queueNotification({
      orderId: appointment.order_id,
      toUserId: appointment.patient_id,
      channel: 'internal',
      template: 'video_no_show_patient',
      status: 'queued',
      response: JSON.stringify({ appointment_id: appointment.id, charged: appointment.price })
    });
    queueNotification({
      orderId: appointment.order_id,
      toUserId: appointment.patient_id,
      channel: 'whatsapp',
      template: 'video_no_show_patient',
      status: 'queued',
      response: JSON.stringify({ appointment_id: appointment.id })
    });
  }

  if (appointment.video_call_id) {
    await execute(`UPDATE video_calls SET status = 'cancelled', updated_at = $1 WHERE id = $2`, [now, appointment.video_call_id]);
  }

  logOrderEvent({
    orderId: appointment.order_id,
    label: `video_no_show_${no_show_type || 'patient'}`,
    meta: JSON.stringify({ appointment_id: appointment.id }),
    actorUserId: req.user.id,
    actorRole: req.user.role
  });

  return res.redirect(`/portal/video/appointment/${appointment.id}`);
});

// ---------------------------------------------------------------------------
// POST /portal/video/appointment/:id/accept-slot — Doctor accepts patient's slot
// ---------------------------------------------------------------------------
router.post('/portal/video/appointment/:id/accept-slot', requireRole('doctor'), async (req, res) => {
  const appointment = await queryOne('SELECT * FROM appointments WHERE id = $1', [req.params.id]);
  if (!appointment || appointment.doctor_id !== req.user.id) {
    return res.status(404).json({ ok: false, error: 'Appointment not found' });
  }
  if (appointment.status !== 'pending_doctor') {
    return res.status(400).json({ ok: false, error: 'Appointment is not awaiting doctor confirmation' });
  }

  const now = nowIso();
  await execute(`
    UPDATE appointments SET status = 'confirmed', updated_at = $1 WHERE id = $2
  `, [now, appointment.id]);

  queueNotification({
    orderId: appointment.order_id,
    toUserId: appointment.patient_id,
    channel: 'internal',
    template: 'video_slot_accepted',
    status: 'queued',
    response: JSON.stringify({ appointment_id: appointment.id, scheduled_at: appointment.scheduled_at })
  });
  queueNotification({
    orderId: appointment.order_id,
    toUserId: appointment.patient_id,
    channel: 'whatsapp',
    template: 'video_slot_accepted',
    status: 'queued',
    response: JSON.stringify({ appointment_id: appointment.id, scheduled_at: appointment.scheduled_at })
  });

  logOrderEvent({
    orderId: appointment.order_id,
    label: 'video_slot_accepted_by_doctor',
    meta: JSON.stringify({ appointment_id: appointment.id, scheduled_at: appointment.scheduled_at }),
    actorUserId: req.user.id,
    actorRole: 'doctor'
  });

  return res.redirect(`/portal/video/appointment/${appointment.id}`);
});

// ---------------------------------------------------------------------------
// POST /portal/video/appointment/:id/propose-slot — Doctor proposes alternate time
// ---------------------------------------------------------------------------
router.post('/portal/video/appointment/:id/propose-slot', requireRole('doctor'), async (req, res) => {
  const lang = getLang(req);
  const appointment = await queryOne('SELECT * FROM appointments WHERE id = $1', [req.params.id]);
  if (!appointment || appointment.doctor_id !== req.user.id) {
    return res.status(404).json({ ok: false, error: 'Appointment not found' });
  }
  if (appointment.status !== 'pending_doctor') {
    return res.status(400).json({ ok: false, error: 'Appointment is not awaiting doctor confirmation' });
  }

  const { proposed_time, slot_notes } = req.body;
  const proposed = dayjs(proposed_time);
  if (!proposed.isValid() || proposed.isBefore(dayjs().add(1, 'hour'))) {
    return res.status(400).json({ ok: false, error: 'Proposed time must be at least 1 hour from now' });
  }

  const now = nowIso();
  await execute(`
    UPDATE appointments
    SET status = 'reschedule_proposed', doctor_proposed_time = $1, doctor_proposed_at = $2,
        slot_notes = $3, updated_at = $4
    WHERE id = $5
  `, [proposed.toISOString(), now, slot_notes || null, now, appointment.id]);

  queueNotification({
    orderId: appointment.order_id,
    toUserId: appointment.patient_id,
    channel: 'internal',
    template: 'video_slot_proposed',
    status: 'queued',
    response: JSON.stringify({
      appointment_id: appointment.id,
      original_slot: appointment.scheduled_at,
      proposed_slot: proposed.toISOString(),
      notes: slot_notes || ''
    })
  });
  queueNotification({
    orderId: appointment.order_id,
    toUserId: appointment.patient_id,
    channel: 'whatsapp',
    template: 'video_slot_proposed',
    status: 'queued',
    response: JSON.stringify({
      appointment_id: appointment.id,
      proposed_slot: proposed.toISOString()
    })
  });

  logOrderEvent({
    orderId: appointment.order_id,
    label: 'video_slot_proposed_by_doctor',
    meta: JSON.stringify({ appointment_id: appointment.id, proposed: proposed.toISOString() }),
    actorUserId: req.user.id,
    actorRole: 'doctor'
  });

  return res.redirect(`/portal/video/appointment/${appointment.id}`);
});

// ---------------------------------------------------------------------------
// POST /portal/video/appointment/:id/confirm-slot — Patient confirms doctor's proposal
// ---------------------------------------------------------------------------
router.post('/portal/video/appointment/:id/confirm-slot', requireRole('patient'), async (req, res) => {
  const appointment = await queryOne('SELECT * FROM appointments WHERE id = $1', [req.params.id]);
  if (!appointment || appointment.patient_id !== req.user.id) {
    return res.status(404).json({ ok: false, error: 'Appointment not found' });
  }
  if (appointment.status !== 'reschedule_proposed') {
    return res.status(400).json({ ok: false, error: 'No pending proposal to confirm' });
  }

  const now = nowIso();
  await execute(`
    UPDATE appointments
    SET status = 'confirmed',
        scheduled_at = doctor_proposed_time,
        rescheduled_from = scheduled_at,
        rescheduled_at = $1,
        patient_confirmed_at = $2,
        updated_at = $3
    WHERE id = $4
  `, [now, now, now, appointment.id]);

  queueNotification({
    orderId: appointment.order_id,
    toUserId: appointment.doctor_id,
    channel: 'internal',
    template: 'video_slot_confirmed',
    status: 'queued',
    response: JSON.stringify({
      appointment_id: appointment.id,
      confirmed_slot: appointment.doctor_proposed_time
    })
  });
  queueNotification({
    orderId: appointment.order_id,
    toUserId: appointment.patient_id,
    channel: 'whatsapp',
    template: 'video_slot_confirmed',
    status: 'queued',
    response: JSON.stringify({ appointment_id: appointment.id, confirmed_slot: appointment.doctor_proposed_time })
  });

  logOrderEvent({
    orderId: appointment.order_id,
    label: 'video_slot_confirmed_by_patient',
    meta: JSON.stringify({ appointment_id: appointment.id }),
    actorUserId: req.user.id,
    actorRole: 'patient'
  });

  return res.redirect(`/portal/video/appointment/${appointment.id}`);
});

// ---------------------------------------------------------------------------
// GET /portal/video/appointments — List all appointments for current user
// ---------------------------------------------------------------------------
router.get('/portal/video/appointments', requireRole('patient', 'doctor'), async (req, res) => {
  const lang = getLang(req);
  const isDoctor = req.user.role === 'doctor';
  const col = isDoctor ? 'doctor_id' : 'patient_id';
  const joinCol = isDoctor ? 'a.patient_id' : 'a.doctor_id';

  const appointments = await queryAll(`
    SELECT a.*, u.name AS other_name
    FROM appointments a
    LEFT JOIN users u ON u.id = ${joinCol}
    WHERE a.${col} = $1
    ORDER BY a.scheduled_at DESC
    LIMIT 50
  `, [req.user.id]);

  const ACTION_REQUIRED_STATUSES = ['pending_doctor', 'reschedule_proposed'];
  const UPCOMING_STATUSES = ['confirmed'];

  const actionRequired = appointments.filter(a => ACTION_REQUIRED_STATUSES.includes(a.status));
  const upcoming = appointments.filter(a => UPCOMING_STATUSES.includes(a.status) && dayjs(a.scheduled_at).isAfter(dayjs()));
  const past = appointments.filter(a =>
    !ACTION_REQUIRED_STATUSES.includes(a.status) &&
    (!UPCOMING_STATUSES.includes(a.status) || dayjs(a.scheduled_at).isBefore(dayjs()))
  );

  res.render('video_appointment', {
    layout: 'portal',
    title: t(lang, 'Video Consultations', 'استشارات الفيديو'),
    lang,
    portalFrame: true,
    portalRole: isDoctor ? 'doctor' : 'patient',
    portalActive: 'dashboard',
    mode: 'list',
    upcoming,
    past,
    actionRequired,
    appointment: null,
    order: null,
    doctor: null,
    patient: null,
    service: null,
    payment: null,
    videoCall: null,
    canJoin: false,
    canReschedule: false,
    canCancel: false,
    refundEligible: false,
    hoursAway: 0,
    earnings: null,
    videoEnabled: isVideoEnabled(),
    price: 0,
    existingAppointment: null
  });
});

// ---------------------------------------------------------------------------
// GET /portal/doctor/appointments — Doctor appointments dashboard
// ---------------------------------------------------------------------------
router.get('/portal/doctor/appointments', requireRole('doctor'), async (req, res) => {
  const lang = getLang(req);
  const isAr = String(lang).toLowerCase() === 'ar';
  const doctorId = req.user.id;

  // Parse filters from query string
  const filterStatus = req.query.status || 'all';
  const filterPeriod = req.query.period || 'all';

  // Build date range based on period filter
  let dateFrom = null;
  let dateTo = null;
  const now = dayjs();

  if (filterPeriod === 'today') {
    dateFrom = now.startOf('day').toISOString();
    dateTo = now.endOf('day').toISOString();
  } else if (filterPeriod === 'week') {
    dateFrom = now.startOf('week').toISOString();
    dateTo = now.endOf('week').toISOString();
  } else if (filterPeriod === 'month') {
    dateFrom = now.startOf('month').toISOString();
    dateTo = now.endOf('month').toISOString();
  }

  // Build query with filters — use numbered placeholders
  let whereClauses = ['a.doctor_id = $1'];
  let params = [doctorId];
  let paramIdx = 2;

  if (filterStatus !== 'all') {
    whereClauses.push(`a.status = $${paramIdx}`);
    params.push(filterStatus);
    paramIdx++;
  }

  if (dateFrom && dateTo) {
    whereClauses.push(`a.scheduled_at >= $${paramIdx} AND a.scheduled_at <= $${paramIdx + 1}`);
    params.push(dateFrom, dateTo);
    paramIdx += 2;
  }

  const allAppointments = await queryAll(`
    SELECT a.*,
           u_pat.name AS patient_name,
           u_pat.email AS patient_email,
           s.name AS service_name,
           vc.status AS vc_status,
           ap.status AS payment_status,
           ap.amount AS payment_amount,
           ap.currency AS currency
    FROM appointments a
    LEFT JOIN users u_pat ON u_pat.id = a.patient_id
    LEFT JOIN services s ON s.id = a.specialty_id
    LEFT JOIN video_calls vc ON vc.id = a.video_call_id
    LEFT JOIN appointment_payments ap ON ap.id = a.payment_id
    WHERE ${whereClauses.join(' AND ')}
    ORDER BY a.scheduled_at ASC
    LIMIT 100
  `, params);

  // Separate into categories
  const upcoming = allAppointments.filter(a =>
    ['pending', 'confirmed'].includes(a.status) && dayjs(a.scheduled_at).isAfter(now)
  );
  const todayAppts = allAppointments.filter(a =>
    ['pending', 'confirmed', 'started'].includes(a.status) &&
    dayjs(a.scheduled_at).isSame(now, 'day')
  );
  const past = allAppointments.filter(a =>
    ['completed', 'cancelled', 'no_show_patient', 'no_show_doctor'].includes(a.status)
  );

  // Compute stats
  const totalEarnings = await queryOne(`
    SELECT COALESCE(SUM(earned_amount), 0) as total
    FROM doctor_earnings
    WHERE doctor_id = $1 AND status IN ('pending', 'paid')
  `, [doctorId]);

  const monthEarnings = await queryOne(`
    SELECT COALESCE(SUM(earned_amount), 0) as total
    FROM doctor_earnings
    WHERE doctor_id = $1 AND created_at >= $2
  `, [doctorId, now.startOf('month').toISOString()]);

  const completedCount = await queryOne(`
    SELECT COUNT(*) as count FROM appointments
    WHERE doctor_id = $1 AND status = 'completed'
  `, [doctorId]);

  const noShowCount = await queryOne(`
    SELECT COUNT(*) as count FROM appointments
    WHERE doctor_id = $1 AND status IN ('no_show_patient', 'no_show_doctor')
  `, [doctorId]);

  // For each appointment, compute join eligibility
  const appointmentsWithMeta = allAppointments.map(a => {
    const minsAway = minutesUntil(a.scheduled_at);
    const hrsAway = hoursUntil(a.scheduled_at);
    return {
      ...a,
      canJoin: minsAway <= 10 && minsAway >= -60 && ['confirmed', 'started'].includes(a.status),
      canReschedule: hrsAway > 24 && ['pending', 'confirmed'].includes(a.status),
      canCancel: ['pending', 'confirmed'].includes(a.status),
      canMarkNoShow: ['confirmed', 'started'].includes(a.status) && minsAway < -30,
      minsAway: Math.round(minsAway),
      hrsAway: Math.round(hrsAway * 10) / 10,
      isToday: dayjs(a.scheduled_at).isSame(now, 'day'),
      isPast: dayjs(a.scheduled_at).isBefore(now)
    };
  });

  res.render('doctor_appointments', {
    layout: 'portal',
    title: isAr ? 'مواعيد الاستشارات' : 'Video Consultations',
    lang,
    isAr,
    portalFrame: true,
    portalRole: 'doctor',
    portalActive: 'appointments',
    user: req.user,
    appointments: appointmentsWithMeta,
    upcoming,
    todayAppts,
    past,
    filters: { status: filterStatus, period: filterPeriod },
    stats: {
      totalEarnings: totalEarnings.total,
      monthEarnings: monthEarnings.total,
      completedCount: completedCount.count,
      noShowCount: noShowCount.count
    }
  });
});

module.exports = router;
