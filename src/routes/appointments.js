// src/routes/appointments.js
// Doctor availability management only.
// All appointment booking, payment, video calls, and scheduling are handled by video.js.

const express = require('express');
const { randomUUID } = require('crypto');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const { queryAll, execute } = require('../pg');
const { requireRole } = require('../middleware');
const { logErrorToDb } = require('../logger');
dayjs.extend(utc);
dayjs.extend(timezone);

const router = express.Router();

const TIMEZONES = [
  'Africa/Cairo',
  'Asia/Dubai',
  'Europe/London',
  'America/New_York',
  'Asia/Bangkok',
  'Australia/Sydney'
];

// ---------------------------------------------------------------------------
// GET /portal/appointments/availability — Doctor availability settings
// ---------------------------------------------------------------------------
router.get('/portal/appointments/availability', requireRole('doctor'), async (req, res) => {
  const doctorId = req.user.id;

  const availability = await queryAll(`
    SELECT * FROM doctor_availability
    WHERE doctor_id = $1
    ORDER BY day_of_week ASC, start_time ASC
  `, [doctorId]);

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  res.render('appointment_availability', {
    layout: 'portal',
    portalFrame: true,
    portalRole: 'doctor',
    portalActive: 'appointments',
    brand: 'Tashkheesa',
    title: 'Availability',
    availability,
    dayNames,
    timezones: TIMEZONES,
    doctor: req.user,
    user: req.user
  });
});

// ---------------------------------------------------------------------------
// POST /portal/appointments/availability — Save doctor availability
// ---------------------------------------------------------------------------
router.post('/portal/appointments/availability', requireRole('doctor'), async (req, res) => {
  const doctorId = req.user.id;
  const { timezone: tz } = req.body;

  if (!tz || !TIMEZONES.includes(tz)) {
    return res.status(400).json({ ok: false, error: 'Invalid timezone' });
  }

  try {
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

    await execute('DELETE FROM doctor_availability WHERE doctor_id = $1', [doctorId]);

    for (const slot of availability) {
      await execute(`
        INSERT INTO doctor_availability (id, doctor_id, day_of_week, start_time, end_time, timezone, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, true)
      `, [randomUUID(), doctorId, slot.day_of_week, slot.start_time, slot.end_time, tz]);
    }

    return res.json({ ok: true, message: 'Availability updated' });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Redirects: legacy /portal/appointments/* -> video.js canonical routes
// ---------------------------------------------------------------------------
router.get('/portal/appointments', requireRole('patient', 'doctor'), (req, res) => {
  res.redirect(302, '/portal/video/appointments');
});
router.get('/portal/patient/appointments', requireRole('patient'), (req, res) => {
  res.redirect(302, '/portal/video/appointments');
});
router.get('/portal/appointments/book/:orderId', requireRole('patient'), (req, res) => {
  res.redirect(302, `/portal/video/book/${req.params.orderId}`);
});
router.get('/portal/appointments/:id', requireRole('patient', 'doctor'), (req, res) => {
  res.redirect(302, `/portal/video/appointment/${req.params.id}`);
});

module.exports = router;
