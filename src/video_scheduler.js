// src/video_scheduler.js
// Scheduled tasks for video consultations:
// 1. 5-minute pre-appointment reminders
// 2. No-show auto-detection (30 min after scheduled time)

const cron = require('node-cron');
const { queryAll, execute } = require('./pg');
const { queueNotification } = require('./notify');
const { major: logMajor } = require('./logger');
const dayjs = require('dayjs');

let schedulerTask = null;

function nowIso() {
  return new Date().toISOString();
}

/**
 * Send 10-minute reminders for upcoming appointments.
 * Finds confirmed appointments scheduled within the next 10-11 minutes
 * that haven't already been reminded.
 */
async function dispatchReminders() {
  try {
    const now = dayjs();
    const tenMinFromNow = now.add(11, 'minute').toISOString();
    const nineMinFromNow = now.add(9, 'minute').toISOString();

    // Find appointments in the 9-11 minute window (catches within 1 cron tick)
    const appointments = await queryAll(`
      SELECT a.*, u_doc.name AS doctor_name, u_pat.name AS patient_name
      FROM appointments a
      LEFT JOIN users u_doc ON u_doc.id = a.doctor_id
      LEFT JOIN users u_pat ON u_pat.id = a.patient_id
      WHERE a.status = 'confirmed'
        AND a.scheduled_at > $1
        AND a.scheduled_at <= $2
    `, [nineMinFromNow, tenMinFromNow]);

    for (const appt of appointments) {
      // Remind patient
      await queueNotification({
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

      await queueNotification({
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
      await queueNotification({
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
    }
  } catch (err) {
    console.error('[video-scheduler] Reminder dispatch error:', err.message);
  }
}

/**
 * Auto-detect no-shows: appointments that are 30+ minutes past scheduled time
 * and still in 'confirmed' status (nobody joined).
 */
async function detectNoShows() {
  try {
    const thirtyMinAgo = dayjs().subtract(30, 'minute').toISOString();

    const noShows = await queryAll(`
      SELECT a.*, vc.status AS vc_status, vc.initiated_by
      FROM appointments a
      LEFT JOIN video_calls vc ON vc.id = a.video_call_id
      WHERE a.status = 'confirmed'
        AND a.scheduled_at < $1
    `, [thirtyMinAgo]);

    const now = nowIso();

    for (const appt of noShows) {
      const vcStatus = appt.vc_status || 'pending';
      const initiatedBy = appt.initiated_by;

      if (vcStatus === 'pending') {
        // Nobody joined at all -- mark both as no-show, default to patient no-show
        await execute(`UPDATE appointments SET status = 'no_show_patient', updated_at = $1 WHERE id = $2`,
          [now, appt.id]);

        if (appt.video_call_id) {
          await execute(`UPDATE video_calls SET status = 'cancelled', updated_at = $1 WHERE id = $2`,
            [now, appt.video_call_id]);
        }

        // Doctor keeps payment (patient no-show policy)
        // Create doctor earnings
        const earnedAmount = Math.round(appt.price * (appt.doctor_commission_pct / 100) * 100) / 100;
        await execute(`
          INSERT INTO doctor_earnings (id, doctor_id, appointment_id, gross_amount, commission_pct, earned_amount, status, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
          ON CONFLICT DO NOTHING
        `, [
          `earn-noshow-${appt.id}`, appt.doctor_id, appt.id,
          appt.price, appt.doctor_commission_pct, earnedAmount, now
        ]);

        // Notify patient
        await queueNotification({
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
        // Only one person joined -- determine who the no-show is
        const doctorJoined = initiatedBy === appt.doctor_id ||
          (typeof initiatedBy === 'string' && initiatedBy.startsWith('doctor-'));

        if (doctorJoined) {
          // Doctor joined but patient didn't -- patient no-show
          await execute(`UPDATE appointments SET status = 'no_show_patient', updated_at = $1 WHERE id = $2`,
            [now, appt.id]);

          await queueNotification({
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
          // Patient joined but doctor didn't -- doctor no-show, refund patient
          await execute(`UPDATE appointments SET status = 'no_show_doctor', updated_at = $1 WHERE id = $2`,
            [now, appt.id]);

          if (appt.payment_id) {
            await execute(`UPDATE appointment_payments SET status = 'refunded', refund_reason = 'Doctor no-show (auto)', refunded_at = $1 WHERE id = $2`,
              [now, appt.payment_id]);
          }

          await queueNotification({
            orderId: appt.order_id,
            toUserId: appt.patient_id,
            channel: 'internal',
            template: 'video_no_show_doctor',
            status: 'queued',
            response: JSON.stringify({ appointment_id: appt.id, refund: 'full' }),
            dedupe_key: `video:noshow:${appt.id}:doctor`
          });
          await queueNotification({
            orderId: appt.order_id,
            toUserId: appt.patient_id,
            channel: 'whatsapp',
            template: 'video_no_show_doctor',
            status: 'queued',
            response: JSON.stringify({ appointment_id: appt.id }),
            dedupe_key: `video:noshow:whatsapp:${appt.id}:doctor`
          });

          logMajor(`[video-scheduler] Auto no-show (doctor): appointment ${appt.id} -- patient refunded`);
        }
      }
    }
  } catch (err) {
    console.error('[video-scheduler] No-show detection error:', err.message);
  }
}

/**
 * Sweep stale pending video slots:
 * - 24h with no response → notify admin
 * - 48h with no response → auto-cancel + refund patient
 * Runs on every scheduler tick but uses dedupe keys so notifications fire once.
 */
async function sweepStalePendingSlots() {
  try {
    const now = new Date();

    const staleSlots = await queryAll(
      `SELECT a.id, a.order_id, a.status, a.patient_id, a.doctor_id, a.payment_id,
              a.updated_at, a.created_at,
              u_pat.name AS patient_name, u_pat.email AS patient_email, u_pat.phone AS patient_phone,
              u_doc.name AS doctor_name, u_doc.email AS doctor_email,
              ap.amount AS payment_amount, ap.currency AS payment_currency
       FROM appointments a
       LEFT JOIN users u_pat ON u_pat.id = a.patient_id
       LEFT JOIN users u_doc ON u_doc.id = a.doctor_id
       LEFT JOIN appointment_payments ap ON ap.id = a.payment_id
       WHERE a.status IN ('pending_doctor', 'reschedule_proposed')`,
      []
    );

    for (const slot of staleSlots) {
      const since = slot.updated_at ? new Date(slot.updated_at) : new Date(slot.created_at);
      const ageMs = now - since;
      const ageHours = ageMs / 3600000;

      if (ageHours >= 48) {
        // AUTO-CANCEL: refund patient and mark cancelled
        const iso = now.toISOString();
        await execute(
          `UPDATE appointments SET status = 'cancelled', updated_at = $1 WHERE id = $2 AND status IN ('pending_doctor','reschedule_proposed')`,
          [iso, slot.id]
        );
        if (slot.payment_id) {
          await execute(
            `UPDATE appointment_payments SET status = 'refunded', refund_reason = 'Auto-cancelled: slot unresolved after 48h', refunded_at = $1 WHERE id = $2 AND status != 'refunded'`,
            [iso, slot.payment_id]
          );
        }
        // Notify patient
        if (slot.patient_id) {
          queueNotification({
            userId: slot.patient_id,
            type: 'whatsapp',
            template: 'video_slot_auto_cancelled_patient',
            data: { patient_name: slot.patient_name, amount: slot.payment_amount, currency: slot.payment_currency || 'EGP' },
            orderId: slot.order_id,
            dedupe_key: `video:slot:autocancelled:${slot.id}`
          });
        }
        // Notify admin
        queueNotification({
          type: 'admin_alert',
          template: 'video_slot_auto_cancelled_admin',
          data: { order_id: slot.order_id, doctor_name: slot.doctor_name, patient_name: slot.patient_name, status: slot.status },
          orderId: slot.order_id,
          dedupe_key: `video:slot:autocancelled:admin:${slot.id}`
        });
        logMajor(`[video-scheduler] Auto-cancelled slot ${slot.id} (order ${slot.order_id}) — unresolved 48h`);

      } else if (ageHours >= 24) {
        // ESCALATION: notify admin once at 24h mark
        queueNotification({
          type: 'admin_alert',
          template: 'video_slot_stale_admin',
          data: {
            order_id: slot.order_id,
            doctor_name: slot.doctor_name || '—',
            patient_name: slot.patient_name || '—',
            status: slot.status,
            age_hours: Math.floor(ageHours)
          },
          orderId: slot.order_id,
          dedupe_key: `video:slot:stale24h:${slot.id}`
        });
      }
    }
  } catch (err) {
    console.error('[video-scheduler] Stale slot sweep error:', err.message);
  }
}


/**
 * Start the video consultation scheduler.
 * Runs every minute to check for reminders and no-shows.
 */
function startVideoScheduler() {
  if (schedulerTask) return; // Already running

  logMajor('[video-scheduler] Starting video consultation scheduler (every 1 min)');

  schedulerTask = cron.schedule('* * * * *', async function () {
    await dispatchReminders();
    await detectNoShows();
    await sweepStalePendingSlots();
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
  detectNoShows,
  sweepStalePendingSlots
};
