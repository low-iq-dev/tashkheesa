'use strict';

// services/patient_push.js — push notifications to the patient app.
//
// 2026-08-25.
//
// THE STATE THIS REPLACES. The patient app did everything right: it registered
// an Expo token on launch, stored it via POST /api/v1/profile, and installed tap
// handlers for incoming notifications. The server never sent one. Of the three
// patient push helpers in middleware/push.js, two had ZERO callers anywhere in
// src/ and the third was imported in routes/api/conversations.js and never
// invoked. Every live push on the platform went to notifySuperadmins — the
// Command app.
//
// So "your report is ready" did not reach a locked phone. Neither did a new
// message from the doctor, a payment confirmation, or a refund decision. A
// patient learned their report existed by opening the app and looking.
//
// ── Why this hooks into notify.js instead of the call sites ─────────────────
//
// The obvious fix is to call notifyCaseUpdate() from the fifty-odd places that
// change case state. That is fifty chances to forget one, and those helpers
// hardcode English copy — on a platform where half the patients read Arabic.
//
// Every notification already flows through queueNotification, which by that
// point has resolved the recipient's language and rendered the exact title and
// body the in-app row will show. Pushing from there means:
//
//   * one wiring point, not fifty
//   * the push is bilingual for free, because the title already is
//   * the push and the in-app row can never disagree about what happened
//   * a new template gets push by adding one line to the list below
//
// ── Why an allowlist ────────────────────────────────────────────────────────
//
// "Everything that makes sense" is the requirement, and not every internal
// notification makes sense as a push. Some are operator-facing bookkeeping the
// patient has no action to take on. An explicit list is greppable, reviewable,
// and each entry can be justified — a denylist would silently push anything
// added later.

// pool from ../pg, matching services/ops_push.js — going through ../db here
// would pull in the migration runner on a module every notification touches.
const { pool } = require('../pg');
const { sendPushNotification } = require('../middleware/push');

// Templates worth interrupting someone's day for. Grouped by why.
const PUSH_TEMPLATES = Object.freeze({
  // The report is the product. This is the single most important push on the
  // platform and it is the one that was missing.
  report_ready_patient:              { screen: 'case-detail' },

  // Money left or returned to their account. Always worth telling them.
  payment_success_patient:           { screen: 'case-detail' },
  payment_marked_paid_patient:       { screen: 'case-detail' },
  payment_failed_patient:            { screen: 'payment' },
  patient_refund_approved:           { screen: 'case-detail' },
  patient_refund_denied:             { screen: 'case-detail' },
  patient_refund_paid:               { screen: 'case-detail' },
  patient_refund_requested:          { screen: 'case-detail' },
  patient_refund_opened_by_operator: { screen: 'case-detail' },

  // Their case moved, or someone is waiting on them.
  order_status_accepted_patient:     { screen: 'case-detail' },
  case_cancelled_patient:            { screen: 'case-detail' },
  case_auto_deleted_unpaid_patient:  { screen: 'case-detail' },
  additional_files_requested_patient:{ screen: 'case-detail' },
  prescription_uploaded_patient:     { screen: 'case-detail' },
  prescription_recommended_patient:  { screen: 'case-detail' },

  // A human is talking to them.
  new_message:                       { screen: 'chat' },

  // Deadlines — theirs to act on.
  payment_reminder_30m:              { screen: 'payment' },
  payment_reminder_6h:               { screen: 'payment' },
  payment_reminder_24h:              { screen: 'payment' },

  // Video consultation: a time-bound commitment they can miss.
  video_slot_confirmed:              { screen: 'case-detail' },
  video_appointment_reminder:        { screen: 'case-detail' },
  video_appointment_rescheduled:     { screen: 'case-detail' },
  video_appointment_cancelled:       { screen: 'case-detail' },
  video_call_started:                { screen: 'case-detail' },
});

// Deliberately NOT pushed, recorded here so the next person does not have to
// guess whether the omission was a decision or an oversight:
//
//   sla_reminder_24h / _6h / _1h  — these tell the patient their report is due
//     soon. They cannot act on it, and three pushes per case counting down to a
//     deadline the DOCTOR owns is pure anxiety. They stay in the in-app list.
//   case_routing_updated          — internal bookkeeping; the patient's case is
//     unchanged from their point of view.
//   welcome_patient               — they are holding the phone; they just
//     signed up.
//   chat_conduct_warning          — delivered in the thread where it belongs.

function isPushWorthy(template) {
  return Object.prototype.hasOwnProperty.call(PUSH_TEMPLATES, String(template || ''));
}

/**
 * Send the push that matches an internal notification row.
 *
 * Fire-and-forget and non-throwing by contract: this is called from inside
 * queueNotification, and a push failure must never cost the patient the in-app
 * notification or fail the request that triggered it. A patient with no token
 * (web-only, or never granted permission) costs one indexed lookup inside
 * sendPushNotification and nothing else.
 *
 * @param {object} args
 * @param {string} args.userId    recipient
 * @param {string} args.template  notification template name
 * @param {string} args.title     already localised by the caller
 * @param {string} args.body      already localised by the caller; may be null
 * @param {string} [args.orderId] for tap-through
 * @param {object} [args.payload] the parsed notification payload
 */
async function pushForNotification({ userId, template, title, body, orderId, payload }) {
  try {
    if (!userId || !isPushWorthy(template)) return;
    if (!title) return;   // nothing readable to show on a lock screen

    const spec = PUSH_TEMPLATES[template];

    // Tap target. The in-app list synthesises { screen:'case-detail', caseId }
    // from order_id; push carries the same shape so both surfaces land the
    // patient in the same place.
    const data = { screen: spec.screen, template: template };
    if (orderId) data.caseId = orderId;
    if (spec.screen === 'chat') {
      const convoId = payload && (payload.conversation_id || payload.conversationId);
      if (convoId) data.conversationId = String(convoId);
      // Without a conversation id there is nothing to open; fall back to the
      // case rather than opening an empty thread.
      else if (orderId) data.screen = 'case-detail';
    }

    await sendPushNotification(pool, userId, {
      title: title,
      // An empty body is legal on Expo but reads as a bug on a lock screen.
      body: body || '',
      data
    });
  } catch (err) {
    // Swallowed on purpose — see the contract above.
    console.error('[patient-push] failed for template ' + template + ':', err && err.message);
  }
}

module.exports = { pushForNotification, isPushWorthy, PUSH_TEMPLATES };
