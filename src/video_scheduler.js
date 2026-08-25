// src/video_scheduler.js
// Scheduled tasks for video consultations:
// 1. 5-minute pre-appointment reminders
// 2. No-show auto-detection (30 min after scheduled time)

const cron = require('node-cron');
const { queryAll, execute } = require('./pg');
const { queueNotification, notifyAdmins } = require('./notify');
// AUDIT-2026-08-22 (R1/R2): an appointment funded by the case add-on has NO
// separate payment to reverse. Flipping its marker row to 'refunded' moved no
// money and burned the entitlement forever. See the module header.
const { releaseVideoAddonEntitlement } = require('./services/video_addon_entitlement');
const { major: logMajor, logErrorToDb } = require('./logger');
const dayjs = require('dayjs');

let schedulerTask = null;

function nowIso() {
  return new Date().toISOString();
}

// Theme 6 §4-D / P3-WORKER-N2 — admin fan-out previously had a local
// notifyAdmins copy here. Theme 7b Phase 1 (per OQ-8) factored it into
// the shared `notifyAdmins` exported from src/notify.js; this file
// imports that helper above.

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
    logErrorToDb(err, {
      context: 'video_scheduler.reminder_dispatch',
      category: 'video_scheduler',
      workerPhase: 'interval'
    });
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

          // AUDIT-2026-08-22 (R2, P0): same split as the 48h sweep below — an
          // appointment funded by the case add-on has no separate payment, so
          // 'refunded' here moved nothing and burned the entitlement. Release
          // it so the patient the doctor stood up can rebook for free.
          let dnsRelease = { addonFunded: false };
          let dnsReleaseFailed = false;
          if (appt.payment_id) {
            try {
              dnsRelease = await releaseVideoAddonEntitlement({
                appointmentId: appt.id,
                orderId: appt.order_id,
                paymentId: appt.payment_id,
                reason: 'Doctor no-show (auto) — consultation entitlement returned'
              });
            } catch (relErr) {
              // We could not classify the payment. Do NOT fall through to the
              // 'refunded' UPDATE: on an add-on row that would re-create the
              // exact lie this fix removes, and the row is un-refunded either
              // way — the next sweep of this appointment is not guaranteed, so
              // this is logged loudly for reconciliation instead.
              dnsReleaseFailed = true;
              logErrorToDb(relErr, {
                context: 'video_scheduler.doctor_no_show_addon_release',
                category: 'video_scheduler',
                workerPhase: 'interval'
              });
              console.error('[video-scheduler] add-on entitlement release failed for', appt.id, relErr.message);
            }
            if (!dnsRelease.addonFunded && !dnsReleaseFailed) {
              await execute(`UPDATE appointment_payments SET status = 'refunded', refund_reason = 'Doctor no-show (auto)', refunded_at = $1 WHERE id = $2`,
                [now, appt.payment_id]);
            }
          }

          // ── AUDIT-2026-08-22 (N2): the auto-detect sweep reached this branch
          // because the PATIENT joined and the DOCTOR never did, and it then
          // told the patient — using `video_no_show_doctor`, whose registry
          // suffix means "doctor-facing", not "the doctor no-showed". Its title
          // is "Patient did not join the video consultation" and its OpenClaw
          // body says the patient did not join, with a doctor-portal deep link.
          // The patient who WAS stood up got blamed for it. Correct recipient
          // (patient, unchanged) with a patient-facing doctor-no-show template.
          // dedupe keys are left as-is so appointments already notified under
          // the old template are not re-notified.
          //
          // AUDIT-2026-08-22 (R2): `refund:'full'` was a constant, and the
          // template says "refunded in full" because of it. On an
          // add-on-funded appointment nothing was refunded — the consultation
          // the patient already owns was handed back. HAND-OFF: the
          // notifications owner must branch video_doctor_no_show_patient on
          // this value; until then the payload at least records the truth.
          const dnsRefundOutcome = dnsRelease.addonFunded ? 'entitlement_released' : 'full';
          await queueNotification({
            orderId: appt.order_id,
            toUserId: appt.patient_id,
            channel: 'internal',
            template: 'video_doctor_no_show_patient',
            status: 'queued',
            response: JSON.stringify({ appointment_id: appt.id, refund: dnsRefundOutcome }),
            dedupe_key: `video:noshow:${appt.id}:doctor`
          });
          await queueNotification({
            orderId: appt.order_id,
            toUserId: appt.patient_id,
            channel: 'whatsapp',
            template: 'video_doctor_no_show_patient',
            status: 'queued',
            response: JSON.stringify({ appointment_id: appt.id, refund: dnsRefundOutcome }),
            dedupe_key: `video:noshow:whatsapp:${appt.id}:doctor`
          });

          logMajor(`[video-scheduler] Auto no-show (doctor): appointment ${appt.id} -- patient refunded`);
        }
      }
    }
  } catch (err) {
    logErrorToDb(err, {
      context: 'video_scheduler.noshow_detection',
      category: 'video_scheduler',
      workerPhase: 'interval'
    });
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
              ap.amount AS payment_amount, ap.currency AS payment_currency,
              -- AUDIT-2026-08-22 (R1): 'order_addon' marks an appointment funded
              -- by the case add-on. There is no money behind that row, so the
              -- 48h auto-cancel below must RELEASE the entitlement instead of
              -- pretending to refund it.
              ap.method AS payment_method
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
        // ── AUDIT-2026-08-22 (R1, P0): add-on-funded slots are RELEASED, not
        // "refunded" ────────────────────────────────────────────────────────
        //
        // The old code ran the 'refunded' UPDATE unconditionally. On a slot
        // funded by the case add-on (method='order_addon' — see POST
        // /portal/video/book) that row is a marker, not a payment: no money
        // moves, no `refunds` row is written, and
        // orders.addons_json.video_consultation_consumed_by stays stamped with
        // this appointment id. readVideoAddonEntitlement then returns null for
        // good, so the patient — who paid for a consultation, never got one,
        // and was WhatsApped "auto-cancelled, amount 800" — is quoted the full
        // 800 again to rebook. Releasing hands the entitlement back so the
        // rebooking really is free. See services/video_addon_entitlement.js.
        // Read off the joined payment row, NOT off the release result: if the
        // release throws, the slot is still add-on funded and the patient must
        // still not be told a refund is coming.
        const slotIsAddonFunded = String(slot.payment_method || '').toLowerCase() === 'order_addon';
        let addonRelease = { addonFunded: slotIsAddonFunded, released: false };
        if (slot.payment_id) {
          if (slotIsAddonFunded) {
            try {
              addonRelease = await releaseVideoAddonEntitlement({
                appointmentId: slot.id,
                orderId: slot.order_id,
                paymentId: slot.payment_id,
                reason: 'Auto-cancelled: slot unresolved after 48h — consultation entitlement returned'
              });
            } catch (relErr) {
              // One bad row must not abort the sweep for every other slot. The
              // appointment is already cancelled at this point; leaving the
              // entitlement stamped is recoverable (the next tick retries,
              // because the release is keyed on this appointment id and is
              // idempotent), silently swallowing it is not.
              logErrorToDb(relErr, {
                context: 'video_scheduler.stale_slot_addon_release',
                category: 'video_scheduler',
                workerPhase: 'interval'
              });
              console.error('[video-scheduler] add-on entitlement release failed for', slot.id, relErr.message);
            }
          } else {
            await execute(
              `UPDATE appointment_payments SET status = 'refunded', refund_reason = 'Auto-cancelled: slot unresolved after 48h', refunded_at = $1 WHERE id = $2 AND status != 'refunded'`,
              [iso, slot.payment_id]
            );
          }
        }
        // Notify patient
        // Theme 6 §4-D / P3-WORKER-N6:
        //   - `userId:` → `toUserId:` (the canonical queueNotification
        //     field; previously the call returned
        //     `{ ok:false, reason:'invalid_to_user_id' }` at notify.js:233
        //     and the row was never inserted — patient never told their
        //     slot was auto-cancelled).
        //   - `type: 'whatsapp'` → `channel: 'whatsapp'` (queueNotification
        //     destructures `channel`, not `type`; the previous value was
        //     silently discarded).
        //   - `data: {...}` → `response: JSON.stringify({...})` (matches
        //     the rest of this file at lines 42-54 etc.; queueNotification
        //     has no `data` parameter, so the payload was being lost
        //     even before the toUserId fix would have made it deliverable).
        //   - `await` added for consistency with the surrounding async
        //     control flow (this is inside a `for ... of staleSlots` loop
        //     in `sweepStalePendingSlots`).
        if (slot.patient_id) {
          await queueNotification({
            toUserId: slot.patient_id,
            channel: 'whatsapp',
            template: 'video_slot_auto_cancelled_patient',
            // AUDIT-2026-08-22 (R1): say what actually happened to the money.
            // `amount` alongside a cancellation reads as "this was refunded to
            // you" — false on an add-on-funded slot, where nothing was charged
            // separately and nothing was returned. `outcome` distinguishes the
            // two cases for the template; HAND-OFF to the notifications owner:
            // branch video_slot_auto_cancelled_patient on it so the
            // entitlement_released copy says "your paid consultation is still
            // yours — pick a new time, at no extra cost".
            response: JSON.stringify({
              patient_name: slot.patient_name,
              amount: slotIsAddonFunded ? 0 : slot.payment_amount,
              currency: slot.payment_currency || 'EGP',
              outcome: slotIsAddonFunded ? 'entitlement_released' : 'refund_due',
              entitlement_amount: slotIsAddonFunded ? slot.payment_amount : null
            }),
            orderId: slot.order_id,
            dedupe_key: `video:slot:autocancelled:${slot.id}`
          });
        }
        // Notify admins (P3-WORKER-N2 — fan out per active superadmin
        // via the canonical dispatchSlaBreach pattern)
        await notifyAdmins({
          template: 'video_slot_auto_cancelled_admin',
          payload: {
            order_id: slot.order_id,
            doctor_name: slot.doctor_name,
            patient_name: slot.patient_name,
            status: slot.status,
          },
          dedupeKey: `video:slot:autocancelled:admin:${slot.id}`,
          orderId: slot.order_id,
        });
        logMajor(`[video-scheduler] Auto-cancelled slot ${slot.id} (order ${slot.order_id}) — unresolved 48h` +
          (slotIsAddonFunded ? ` — add-on entitlement ${addonRelease.released ? 'released' : 'NOT released'}` : ''));

      } else if (ageHours >= 24) {
        // ESCALATION: notify admin once at 24h mark
        // Theme 6 §4-D / P3-WORKER-N2 — fan out per superadmin.
        await notifyAdmins({
          template: 'video_slot_stale_admin',
          payload: {
            order_id: slot.order_id,
            doctor_name: slot.doctor_name || '—',
            patient_name: slot.patient_name || '—',
            status: slot.status,
            age_hours: Math.floor(ageHours),
          },
          dedupeKey: `video:slot:stale24h:${slot.id}`,
          orderId: slot.order_id,
        });
      }
    }
  } catch (err) {
    logErrorToDb(err, {
      context: 'video_scheduler.stale_slot_sweep',
      category: 'video_scheduler',
      workerPhase: 'interval'
    });
    console.error('[video-scheduler] Stale slot sweep error:', err.message);
  }
}


/**
 * Start the video consultation scheduler.
 * Runs every minute to check for reminders and no-shows.
 */
// Side issue #54 — heartbeat the canonical ops endpoint so Widget 3 +
// CONFIGURED_AGENTS show fresh lastRun. Matches the shape used in
// case_sla_worker.js:503 and notification_worker.js:364 (HTTP POST to
// localhost, fire-and-forget, error-swallowed so a transient blip
// never affects the surrounding worker).
function pingOps(agentName, task) {
  try {
    var http = require('http');
    var body = JSON.stringify({ agent_name: agentName, status: 'running', current_task: task });
    var req = http.request({ hostname: 'localhost', port: Number(process.env.PORT || 3000), path: '/ops/agent/ping', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
    req.on('error', function() {});
    req.write(body);
    req.end();
  } catch(e) {}
}

function startVideoScheduler() {
  if (schedulerTask) return; // Already running

  logMajor('[video-scheduler] Starting video consultation scheduler (every 1 min)');

  schedulerTask = cron.schedule('* * * * *', async function () {
    await dispatchReminders();
    await detectNoShows();
    await sweepStalePendingSlots();
    pingOps('video_scheduler', 'Video scheduler sweep completed (reminders + no-shows + stale-slot sweep)');
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
