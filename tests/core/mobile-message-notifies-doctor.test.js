// tests/core/mobile-message-notifies-doctor.test.js
//
// Part B item 1 (2026-09-13) — patient push notifications.
//
// The 2026-08-25 change (d5f15a0) hooked pushForNotification into
// queueNotification's 'internal' path, filtered GET /api/v1/notifications to
// channel='internal', added 'internal' rows to the SLA and payment-reminder
// dispatchers and stopped deleting `template` from the response. That is
// pinned by tests/core/patient-notifications.test.js.
//
// What was still missing: the mobile message POST
// (routes/api/conversations.js) notified the doctor with a raw INSERT into
// notifications — no channel, no template, no dedupe key — and imported
// middleware/push.notifyNewMessage without ever calling it. The doctor got a
// channel-NULL row and no email. It now routes through the same
// queueMultiChannelNotification call the web send uses.
//
// Source-grep (the change is a call-site swap). Verified NEGATIVELY: restoring
// the raw INSERT fails the first assertion; restoring the dead import fails
// the second.

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n📱 Part B-1 — mobile message notifies the doctor through the shared helper\n');

const ROOT = path.join(__dirname, '..', '..');
function code(rel) { return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
function check(name, fn) {
  try { const why = fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}

const CONV = code('src/routes/api/conversations.js');
const PUSH = code('src/services/patient_push.js');
const NOTIFY = code('src/notify.js');

check('api/conversations.js no longer writes a raw channel-less notifications row', () => {
  if (/INSERT INTO notifications/.test(CONV)) return 'raw INSERT INTO notifications still present';
});

check('api/conversations.js does not import the never-called notifyNewMessage', () => {
  if (/notifyNewMessage/.test(CONV)) return 'dead notifyNewMessage import still present';
});

check('the message POST queues new_message on internal + email with a 10-minute dedupe window', () => {
  const start = CONV.indexOf("router.post('/:id/messages'");
  if (start < 0) return 'message POST handler not found';
  const h = CONV.slice(start, start + 4000);
  if (!/queueMultiChannelNotification\(\{/.test(h)) return 'not routed through queueMultiChannelNotification';
  if (!/template:\s*'new_message'/.test(h)) return 'template is not new_message';
  if (!/channels:\s*\['internal',\s*'email'\]/.test(h)) return 'channels are not internal + email';
  if (!/toUserId:\s*convo\.doctor_id/.test(h)) return 'recipient is not the conversation doctor';
  if (!/dedupe_key:\s*'message:'\s*\+\s*convo\.id\s*\+\s*':'\s*\+\s*dedupeWindow/.test(h)) return 'dedupe key does not match the web send';
  if (!/10 \* 60 \* 1000/.test(h)) return 'dedupe window is not 10 minutes';
});

check('the message POST passes conversation_id so a push (if the recipient is a patient) opens the thread', () => {
  const start = CONV.indexOf("router.post('/:id/messages'");
  const h = CONV.slice(start, start + 4000);
  if (!/conversation_id:\s*convo\.id/.test(h)) return 'conversation_id missing from the payload';
});

// The six pushes that matter, all present in the allowlist the notify hook
// consults. Report ready, payment confirmed (gateway + operator mark-paid),
// doctor accepted, new message, more files requested, refund decision
// (approved + denied + paid).
check('the six pushes that matter are in PUSH_TEMPLATES', () => {
  const need = [
    'report_ready_patient',
    'payment_success_patient', 'payment_marked_paid_patient',
    'order_status_accepted_patient',
    'new_message',
    'additional_files_requested_patient',
    'patient_refund_approved', 'patient_refund_denied', 'patient_refund_paid'
  ];
  const missing = need.filter((k) => !new RegExp('\\b' + k + ':').test(PUSH));
  if (missing.length) return 'missing from PUSH_TEMPLATES: ' + missing.join(', ');
});

check('queueNotification pushes on the internal channel (insert + re-arm paths)', () => {
  const n = (NOTIFY.match(/pushForNotification\(\{/g) || []).length;
  if (n < 2) return 'expected pushForNotification on both the insert and the requeue path, found ' + n;
});
