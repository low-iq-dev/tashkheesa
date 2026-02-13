// src/video_scheduler.js
// Scheduled tasks for video consultations:
// 1. 5-minute pre-appointment reminders
// 2. No-show auto-detection (30 min after scheduled time)

const cron = require('node-cron');
const { db } = require('./db');
const { queueNotification } = require('./notify');
const { major: logMajor } = require('./logger');
const dayjs = require('dayjs');

let schedulerTask = null;

function nowIso() {
  return new Date().toISOString();
}

/**
 * Send 10-minute reminders for upcoming appointments.
 * Finds confirmed appointments scheduled within the next 10–11 minutes
 * that haven't already been reminded.
 */
function dispatchReminders() {
  try {
    const now = dayjs();
    const tenMinFromNow = now.add(11, 'minute').toISOString();
    const nineMinFromNow = now.add(9, 'minute').toISOString();

    // Find appointments in the 9–11 minute window (catches within 1 cron tick)
    const appointments = db.prepare(`
      SELECT a.*, u_doc.name AS doctor_name, u_pat.name AS patient_name
      FROM appointments a
      LEFT JOIN users u_doc ON u_doc.id = a.doctor_id
      LEFT JOIN users u_pat ON u_pat.id = a.patient_id
      WHERE a.status = 'confirmed'
        AND a.scheduled_at > ?
        AND a.scheduled_at <= ?
    `).all(nineMinFromNow, tenMinFromNow);

    appointments.forEach(function (appt) {
      // Remind patient
      queueNotification({
        orderId: appt.order_id,
        toUserId: appt.patient_id,
        channel: 'internal',
        template: 'video_appointment_reminder',
        status: 'queued',
        response: JSON.stringify({
          appointment_id: appt.id,
          doctor_name: appt.doctor_name,
          scheduled_at: appt.scheduled_at
        }),
        dedupe_key: `video:reminder:${appt.id}:patient`
      });

      queueNotification({
        orderId: appt.order_id,
        toUserId: appt.patient_id,
        channel: 'whatsapp',
        template: 'video_appointment_reminder',
        status: 'queued',
        response: JSON.stringify({
          appointment_id: appt.id,
          doctor_name: appt.doctor_name,
          scheduled_at: appt.scheduled_at
        }),
        dedupe_key: `video:reminder:whatsapp:${appt.id}:patient`
      });

      // Remind doctor
      queueNotification({
        orderId: appt.order_id,
        toUserId: appt.doctor_id,
        channel: 'internal',
        template: 'video_appointment_reminder',
        status: 'queued',
        response: JSON.stringify({
          appointment_id: appt.id,
          patient_name: appt.patient_name,
          scheduled_at: appt.scheduled_at
        }),
        dedupe_key: `video:reminder:${appt.id}:doctor`
      });

      logMajor(`[video-scheduler] Sent 5-min reminder for appointment ${appt.id}`);
    });
  } catch (err) {
    console.error('[video-scheduler] Reminder dispatch error:', err.message);
  }
}

/**
 * Auto-detect no-shows: appointments that are 30+ minutes past scheduled time
 * and still in 'confirmed' status (nobody joined).
 */
function detectNoShows() {
  try {
    const thirtyMinAgo = dayjs().subtract(30, 'minute').toISOString();

    const noShows = db.prepare(`
      SELECT a.*, vc.status AS vc_status, vc.initiated_by
      FROM appointments a
      LEFT JOIN video_calls vc ON vc.id = a.video_call_id
      WHERE a.status = 'confirmed'
        AND a.scheduled_at < ?
    `).all(thirtyMinAgo);

    const now = nowIso();

    noShows.forEach(function (appt) {
      const vcStatus = appt.vc_status || 'pending';
      const initiatedBy = appt.initiated_by;

      if (vcStatus === 'pending') {
        // Nobody joined at all — mark both as no-show, default to patient no-show
        db.prepare(`UPDATE appointments SET status = 'no_show_patient', updated_at = ? WHERE id = ?`)
          .run(now, appt.id);

        if (appt.video_call_id) {
          db.prepare(`UPDATE video_calls SET status = 'cancelled', updated_at = ? WHERE id = ?`)
            .run(now, appt.video_call_id);
        }

        // Doctor keeps payment (patient no-show policy)
        // Create doctor earnings
        const earnedAmount = Math.round(appt.price * (appt.doctor_commission_pct / 100) * 100) / 100;
        db.prepare(`
          INSERT OR IGNORE INTO doctor_earnings (id, doctor_id, appointment_id, gross_amount, commission_pct, earned_amount, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
        `).run(
          `earn-noshow-${appt.id}`, appt.doctor_id, appt.id,
          appt.price, appt.doctor_commission_pct, earnedAmount, now
        );

        // Notify patient
        queueNotification({
          orderId: appt.order_id,
          toUserId: appt.patient_id,
          channel: 'internal',
          template: 'video_no_show_patient',
          status: 'queued',
          response: JSON.stringify({ appointment_id: appt.id, charged: appt.price }),
          dedupe_key: `video:noshow:${appt.id}:patient`
        });

        logMajor(`[video-scheduler] Auto no-show (patient): appointment ${appt.id}`);

      } else if (vcStatus === 'active' && initiatedBy) {
        // Only one person joined — determine who the no-show is
        const doctorJoined = initiatedBy === appt.doctor_id ||
          (typeof initiatedBy === 'string' && initiatedBy.startsWith('doctor-'));

        if (doctorJoined) {
          // Doctor joined but patient didn't — patient no-show
          db.prepare(`UPDATE appointments SET status = 'no_show_patient', updated_at = ? WHERE id = ?`)
            .run(now, appt.id);

          queueNotification({
            orderId: appt.order_id,
            toUserId: appt.patient_id,
            channel: 'internal',
            template: 'video_no_show_patient',
            status: 'queued',
            response: JSON.stringify({ appointment_id: appt.id }),
            dedupe_key: `video:noshow:${appt.id}:patient`
          });

          logMajor(`[video-scheduler] Auto no-show (patient, doctor joined): appointment ${appt.id}`);
        } else {
          // Patient joined but doctor didn't — doctor no-show, refund patient
          db.prepare(`UPDATE appointments SET status = 'no_show_doctor', updated_at = ? WHERE id = ?`)
            .run(now, appt.id);

          if (appt.payment_id) {
            db.prepare(`UPDATE appointment_payments SET status = 'refunded', refund_reason = 'Doctor no-show (auto)', refunded_at = ? WHERE id = ?`)
              .run(now, appt.payment_id);
          }

          queueNotification({
            orderId: appt.order_id,
            toUserId: appt.patient_id,
            channel: 'internal',
            template: 'video_no_show_doctor',
            status: 'queued',
            response: JSON.stringify({ appointment_id: appt.id, refund: 'full' }),
            dedupe_key: `video:noshow:${appt.id}:doctor`
          });
          queueNotification({
            orderId: appt.order_id,
            toUserId: appt.patient_id,
            channel: 'whatsapp',
            template: 'video_no_show_doctor',
            status: 'queued',
            response: JSON.stringify({ appointment_id: appt.id }),
            dedupe_key: `video:noshow:whatsapp:${appt.id}:doctor`
          });

          logMajor(`[video-scheduler] Auto no-show (doctor): appointment ${appt.id} — patient refunded`);
        }
      }
    });
  } catch (err) {
    console.error('[video-scheduler] No-show detection error:', err.message);
  }
}

/**
 * Start the video consultation scheduler.
 * Runs every minute to check for reminders and no-shows.
 */
function startVideoScheduler() {
  if (schedulerTask) return; // Already running

  logMajor('[video-scheduler] Starting video consultation scheduler (every 1 min)');

  schedulerTask = cron.schedule('* * * * *', function () {
    dispatchReminders();
    detectNoShows();
  });
}

function stopVideoScheduler() {
  if (schedulerTask) {
    schedulerTask.stop();
    schedulerTask = null;
    logMajor('[video-scheduler] Stopped video consultation scheduler');
  }
}

module.exports = {
  startVideoScheduler,
  stopVideoScheduler,
  dispatchReminders,
  detectNoShows
};
