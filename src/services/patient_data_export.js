// src/services/patient_data_export.js
//
// PDPL Article 2(d) portability. privacy.ejs §5 has promised patients "the
// right to request a portable copy of your data" since the policy went up;
// until now nothing implemented it. src/routes/exports.js is superadmin-only,
// thirteen business columns wide, and deliberately carries no PII — it is a
// finance report, not a subject-access response.
//
// DESIGN NOTE — every SELECT below names its columns explicitly instead of
// using SELECT *. That is not style. `users` alone holds password_hash,
// refresh_token, reset_token, push_token and national_id_encrypted; a
// SELECT * export would hand all five to anyone who clicked the button, and
// the next migration to add a secret column would re-open the hole silently.
// An allow-list fails closed: a new column is simply absent until someone
// decides it belongs.
//
// This module is READ-ONLY. It runs no writes and takes no locks.

const { queryAll, queryOne } = require('../pg');

// Columns of `users` a patient may have back. Everything omitted here is
// either a credential, a doctor-only field, or an internal moderation flag.
const USER_COLUMNS = [
  'id', 'email', 'name', 'role', 'phone', 'lang', 'country', 'country_code',
  'date_of_birth', 'gender', 'known_conditions', 'current_medications',
  'allergies', 'previous_surgeries', 'family_history',
  'notify_whatsapp', 'email_marketing_opt_out', 'referred_by_code',
  'onboarding_complete', 'is_active', 'created_at', 'first_login_at',
  'last_seen_at',
];

const ORDER_COLUMNS = [
  'id', 'reference_id', 'specialty_id', 'service_id', 'doctor_id', 'status',
  'language', 'tier', 'urgency_tier', 'urgency_flag', 'sla_hours',
  'clinical_question', 'medical_history', 'current_medications', 'notes',
  'diagnosis_text', 'impression_text', 'recommendation_text', 'report_url',
  'price', 'base_price', 'currency', 'display_price', 'display_currency',
  'locked_price', 'locked_currency', 'total_price_with_addons',
  'urgency_uplift_amount', 'referral_code', 'referral_discount',
  'payment_status', 'payment_method', 'payment_reference', 'paid_at',
  'created_at', 'updated_at', 'accepted_at', 'deadline_at', 'sla_deadline',
  'completed_at', 'breached_at', 'deleted_at', 'country', 'source',
];

// Per-order child tables: [key, table, column allow-list].
const ORDER_CHILDREN = [
  ['files', 'order_files',
    ['id', 'order_id', 'url', 'label', 'filename', 'mime_type', 'size', 'created_at']],
  ['additional_files', 'order_additional_files',
    ['id', 'order_id', 'file_url', 'label', 'uploaded_at']],
  ['timeline', 'order_timeline',
    ['id', 'order_id', 'status', 'description', 'created_at']],
  ['events', 'order_events',
    ['id', 'order_id', 'label', 'at']],
  ['addons', 'order_addons',
    ['id', 'order_id', 'addon_service_id', 'status', 'price_at_purchase_egp',
      'price_at_purchase_currency', 'price_at_purchase_amount', 'created_at',
      'fulfilled_at', 'cancelled_at', 'refunded_at']],
  ['refunds', 'refunds',
    ['id', 'order_id', 'amount_egp', 'requested_amount', 'approved_amount',
      'status', 'patient_reason', 'denial_reason', 'instapay_handle',
      'instapay_reference', 'refunded_at', 'reviewed_at', 'paid_at']],
  ['prescriptions', 'prescriptions',
    ['id', 'order_id', 'doctor_id', 'medications', 'diagnosis', 'notes',
      'is_active', 'valid_until', 'pdf_url', 'created_at', 'updated_at']],
  ['reviews', 'reviews',
    ['id', 'order_id', 'doctor_id', 'rating', 'review_text', 'is_anonymous',
      'created_at', 'updated_at']],
];

// Deliberately NOT exported, and each for a reason:
//
//   payment_events   — raw Paymob webhook envelopes. Contains acquirer and
//                      merchant fields that are ours, not the patient's, and
//                      no personal data of theirs that `orders` lacks.
//   error_logs       — diagnostic stack traces and request context. The
//                      user_id is theirs but the payload routinely quotes
//                      internal state and, in a shared-request trace, other
//                      people's identifiers. Exporting it would leak outward.
//   file_ai_checks   — our automated triage scores on their uploads. Internal
//                      QA signal, not data they gave us.
//   ops_push_log     — operator-side alerting.
//   password_reset_tokens — live credentials.
//
// If a regulator asks for any of these they can still be produced by hand;
// what must not happen is a self-service button that ships them.

function cols(list, alias) {
  const p = alias ? alias + '.' : '';
  return list.map((c) => p + c).join(', ');
}

/**
 * Build the full portable export for one patient.
 *
 * Soft-deleted orders ARE included: `orders.deleted_at` means "unpaid and
 * abandoned for 48 hours", not "erased". The patient still submitted it and
 * it is still their data.
 *
 * @param {string} userId
 * @returns {Promise<object|null>} null when the user does not exist
 */
async function buildPatientExport(userId) {
  const user = await queryOne(
    `SELECT ${cols(USER_COLUMNS)} FROM users WHERE id = $1`, [userId]
  );
  if (!user) return null;

  // include-deleted-ok: portability covers abandoned drafts too.
  const orders = await queryAll(
    `SELECT ${cols(ORDER_COLUMNS)} FROM orders WHERE patient_id = $1 ORDER BY created_at`,
    [userId]
  );
  const orderIds = orders.map((o) => o.id);

  const byOrder = {};
  for (const [key, table, list] of ORDER_CHILDREN) {
    byOrder[key] = orderIds.length
      ? await queryAll(
          `SELECT ${cols(list)} FROM ${table} WHERE order_id = ANY($1::text[]) ORDER BY order_id`,
          [orderIds]
        )
      : [];
  }

  // Conversations: both sides. A patient's own messages without the
  // specialist's replies is not their medical correspondence, it is half of
  // it — and the half without the clinical content.
  const conversations = await queryAll(
    `SELECT id, order_id, doctor_id, status, created_at, updated_at, closed_at
       FROM conversations WHERE patient_id = $1 ORDER BY created_at`,
    [userId]
  );
  const convIds = conversations.map((c) => c.id);
  const messages = convIds.length
    ? await queryAll(
        `SELECT id, conversation_id, sender_role, content, message_type,
                file_url, file_name, created_at
           FROM messages WHERE conversation_id = ANY($1::text[])
          ORDER BY conversation_id, created_at`,
        [convIds]
      )
    : [];

  const appointments = await queryAll(
    `SELECT id, order_id, doctor_id, specialty_id, scheduled_at, duration_minutes,
            status, price, cancel_reason, created_at, updated_at
       FROM appointments WHERE patient_id = $1 ORDER BY created_at`,
    [userId]
  );
  const appointmentPayments = await queryAll(
    `SELECT id, appointment_id, amount, currency, status, method, reference,
            refund_reason, refunded_at, paid_at, created_at
       FROM appointment_payments WHERE patient_id = $1 ORDER BY created_at`,
    [userId]
  );
  const videoCalls = await queryAll(
    `SELECT id, appointment_id, doctor_id, status, started_at, ended_at,
            duration_seconds, patient_joined_at, created_at
       FROM video_calls WHERE patient_id = $1 ORDER BY created_at`,
    [userId]
  );
  const medicalRecords = await queryAll(
    `SELECT id, order_id, doctor_id, record_type, title, description, file_url,
            file_name, date_of_record, provider, tags, is_shared_with_doctors,
            created_at
       FROM medical_records WHERE patient_id = $1 ORDER BY created_at`,
    [userId]
  );
  const notifications = await queryAll(
    `SELECT id, order_id, channel, template, type, title, message, status,
            is_read, at
       FROM notifications WHERE to_user_id = $1 ORDER BY at`,
    [userId]
  );
  const referralCodes = await queryAll(
    `SELECT id, code, type, reward_type, reward_value, max_uses, times_used,
            is_active, created_at
       FROM referral_codes WHERE user_id = $1 ORDER BY created_at`,
    [userId]
  );
  const referralRedemptions = await queryAll(
    `SELECT id, referral_code_id, referrer_id, referred_id, order_id,
            reward_granted, created_at
       FROM referral_redemptions
      WHERE referrer_id = $1 OR referred_id = $1
      ORDER BY created_at`,
    [userId]
  );
  const emailCampaigns = await queryAll(
    `SELECT id, campaign_id, email, status, sent_at, created_at
       FROM campaign_recipients WHERE user_id = $1 ORDER BY created_at`,
    [userId]
  );

  const group = (rows) => {
    const m = {};
    for (const r of rows) {
      const k = r.order_id;
      if (!m[k]) m[k] = [];
      m[k].push(r);
    }
    return m;
  };
  const grouped = {};
  for (const [key] of ORDER_CHILDREN) grouped[key] = group(byOrder[key]);

  const messagesByConv = {};
  for (const m of messages) {
    if (!messagesByConv[m.conversation_id]) messagesByConv[m.conversation_id] = [];
    messagesByConv[m.conversation_id].push(m);
  }

  return {
    export_format_version: 1,
    generated_at: new Date().toISOString(),
    // Stated plainly so the file is self-describing if a regulator reads it
    // without us in the room.
    notes: [
      'This file contains the personal and medical data Tashkheesa holds about this account.',
      'Uploaded files are listed with their download URLs; the file contents themselves are not embedded in this document.',
      'Cases marked with a deleted_at timestamp were started but never paid for, and were closed automatically after 48 hours.',
      'Operational logs, payment-processor webhook envelopes and automated quality checks are excluded — they are internal records rather than data you provided.',
    ],
    account: user,
    cases: orders.map((o) => Object.assign({}, o, {
      files: grouped.files[o.id] || [],
      additional_files: grouped.additional_files[o.id] || [],
      timeline: grouped.timeline[o.id] || [],
      events: grouped.events[o.id] || [],
      addons: grouped.addons[o.id] || [],
      refunds: grouped.refunds[o.id] || [],
      prescriptions: grouped.prescriptions[o.id] || [],
      reviews: grouped.reviews[o.id] || [],
    })),
    conversations: conversations.map((c) => Object.assign({}, c, {
      messages: messagesByConv[c.id] || [],
    })),
    appointments: appointments,
    appointment_payments: appointmentPayments,
    video_calls: videoCalls,
    medical_records: medicalRecords,
    notifications: notifications,
    referral_codes: referralCodes,
    referral_redemptions: referralRedemptions,
    marketing_emails: emailCampaigns,
  };
}

/** Filename for the download. Stable, sortable, no PII in the name itself. */
function exportFilename(userId, now) {
  const d = (now || new Date()).toISOString().slice(0, 10);
  return `tashkheesa-data-export-${String(userId).slice(0, 8)}-${d}.json`;
}

module.exports = { buildPatientExport, exportFilename, USER_COLUMNS, ORDER_COLUMNS };
