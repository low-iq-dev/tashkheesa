#!/usr/bin/env node
/**
 * One-time backfill: populate notifications.title / message / type / is_read
 * for rows that were inserted before notify.js was taught to write them.
 *
 * Safe to re-run — only touches rows where title IS NULL.
 *
 * Usage:
 *   node scripts/backfill_notification_titles.js          # dry-run (default), uses .env DATABASE_URL
 *   node scripts/backfill_notification_titles.js --apply  # actually write
 *   DATABASE_URL=<prod-url> PG_SSL=true node scripts/backfill_notification_titles.js --apply
 */

// Load .env before requiring db modules (so DATABASE_URL / PG_SSL are set).
try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const { pool } = require('../src/db');
const { getNotificationTitles } = require('../src/notify/notification_titles');

// Mirror of renderNotificationMessage in src/notify.js. Kept inline here so the
// script is self-contained and won't silently drift — if you change the copy
// in notify.js, update this too (or refactor both to import a shared helper).
function renderNotificationMessage(template, payload) {
  const p = (payload && typeof payload === 'object') ? payload : {};
  const ref = p.reference_id || p.reference_code || p.case_ref || null;
  const caseLabel = ref ? `Case ${ref}` : (p.case_id ? 'Your case' : null);
  const doctor = p.doctor_name || null;

  switch (template) {
    case 'order_created_patient':
    case 'public_order_created_patient':
      return caseLabel ? `${caseLabel} submitted. We'll notify you once a doctor is assigned.` : "Case submitted.";
    case 'order_status_accepted_patient':
    case 'order_assigned_patient':
      return doctor
        ? `Dr. ${doctor} has accepted ${caseLabel || 'your case'}.`
        : `${caseLabel || 'Your case'} has been assigned to a doctor.`;
    case 'order_assigned_doctor':
    case 'order_auto_assigned_doctor':
    case 'public_order_assigned_doctor':
      return caseLabel ? `${caseLabel} is ready for your review.` : "A new case is ready for your review.";
    case 'order_reassigned_doctor':
    case 'order_reassigned_to_doctor':
      return caseLabel ? `${caseLabel} has been reassigned to you.` : "A case has been reassigned to you.";
    case 'order_reassigned_from_doctor':
      return caseLabel ? `${caseLabel} has been reassigned to another doctor.` : "A case has been reassigned.";
    case 'order_reassigned_patient':
      return `${caseLabel || 'Your case'} has been assigned to a different doctor.`;
    case 'report_ready_patient':
      return `Your second-opinion report for ${caseLabel || 'your case'} is ready to view.`;
    case 'additional_files_requested_patient':
    case 'additional_files_request_approved_patient':
      return `The doctor needs additional files for ${caseLabel || 'your case'}. Please upload them when you can.`;
    case 'patient_uploaded_files_doctor':
      return `Patient uploaded additional files for ${caseLabel || 'the case'}.`;
    case 'patient_reply_info':
      return `Patient sent additional information on ${caseLabel || 'the case'}.`;
    case 'payment_success_patient':
    case 'payment_marked_paid_patient':
    case 'payment_marked_paid':
      return `Payment received for ${caseLabel || 'your case'}.`;
    case 'payment_success_doctor':
      return `Payment received for ${caseLabel || 'the case'}.`;
    case 'payment_reminder_30m':
      return `Reminder: complete payment for ${caseLabel || 'your case'} to start your second-opinion review.`;
    case 'payment_reminder_6h':
      return `${caseLabel || 'Your case'} is still awaiting payment. Complete it now so a doctor can begin.`;
    case 'sla_reminder_doctor':
    case 'order_sla_pre_breach':
    case 'order_sla_pre_breach_doctor':
      return `${caseLabel || 'A case'} is approaching its SLA deadline. Please review soon.`;
    case 'sla_breached_doctor':
    case 'order_breached_doctor':
      return `${caseLabel || 'A case'} has passed its SLA deadline.`;
    case 'order_breached_patient':
      return `We're sorry — ${caseLabel || 'your case'} is taking longer than expected. We're on it.`;
    case 'order_breached_superadmin':
      return `SLA breached on ${caseLabel || 'a case'}.`;
    case 'prescription_uploaded_patient':
      return `A new prescription is available for ${caseLabel || 'your case'}.`;
    case 'new_message':
      return caseLabel ? `You have a new message about ${caseLabel}.` : "You have a new message.";
    case 'appointment_cancelled':
      return "Your appointment has been cancelled.";
    case 'appointment_rescheduled':
      return "Your appointment has been rescheduled.";
    case 'doctor_signup_pending':
      return "A new doctor signup is awaiting review.";
    case 'doctor_approved':
      return "Your doctor account has been approved.";
    case 'doctor_rejected':
      return "Your doctor application was not approved at this time.";
    default:
      return null;
  }
}

async function main() {
  const apply = process.argv.includes('--apply');

  console.log(`[backfill] mode: ${apply ? 'APPLY (writing)' : 'DRY RUN (no writes — pass --apply to execute)'}`);

  const { rows } = await pool.query(`
    SELECT id, template, response
    FROM notifications
    WHERE title IS NULL OR type IS NULL OR message IS NULL
    ORDER BY at ASC
  `);

  console.log(`[backfill] ${rows.length} rows need backfill.`);

  if (rows.length === 0) {
    await pool.end();
    return;
  }

  let filled = 0;
  let skipped = 0;

  for (const row of rows) {
    let parsed = null;
    try { parsed = row.response ? JSON.parse(row.response) : null; } catch { parsed = null; }

    const titles = getNotificationTitles(row.template);
    const title = titles?.title_en || null;
    const message = renderNotificationMessage(row.template, parsed);
    const type = row.template || null;

    if (!title && !message && !type) {
      skipped++;
      continue;
    }

    if (apply) {
      await pool.query(
        `UPDATE notifications
           SET title   = COALESCE(title, $1),
               message = COALESCE(message, $2),
               type    = COALESCE(type, $3),
               is_read = COALESCE(is_read, false)
         WHERE id = $4`,
        [title, message, type, row.id]
      );
    }
    filled++;
  }

  console.log(`[backfill] ${apply ? 'wrote' : 'would write'} ${filled} rows; skipped ${skipped}.`);
  await pool.end();
}

main().catch(err => {
  console.error('[backfill] fatal:', err);
  process.exit(1);
});
