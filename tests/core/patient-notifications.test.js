// tests/core/patient-notifications.test.js
//
// NOTIFICATIONS 2026-08-25 — contract guard for patient push and the in-app list.
//
// The three defects this locks down were all SILENT. Nothing threw, no test
// failed, and every one of them was visible only by looking at production rows:
//
//   * The patient app registered a push token on every launch and the server
//     never sent one. Two of the three push helpers had zero callers; the third
//     was imported once and never invoked.
//   * The in-app list had no channel filter, so it showed the patient's emails
//     and WhatsApp messages as if they were app notifications — 40 rows of one
//     reminder for a single patient on live data.
//   * 25 templates had no message body and shipped as a title over blank space,
//     including every refund outcome and every payment failure.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
function expect(cond, msg) { if (!cond) throw new Error(msg); }

console.log('\n🔔 Patient notifications — push + in-app list\n');

const ROOT = path.join(__dirname, '..', '..');
const NOTIFY = fs.readFileSync(path.join(ROOT, 'src', 'notify.js'), 'utf8');
const API = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'api', 'notifications.js'), 'utf8');
const LIFECYCLE = fs.readFileSync(path.join(ROOT, 'src', 'case_lifecycle.js'), 'utf8');
const { renderNotificationMessage } = require(path.join(ROOT, 'src', 'notify.js'));
const push = require(path.join(ROOT, 'src', 'services', 'patient_push.js'));

// ── 1. Every notification body renders, in both languages ───────────────────
//
// Called, not grepped. A template returning null here is exactly how the refund
// notifications shipped blank, and no amount of source-matching would show it.
try {
  const mustRender = [
    ['payment_failed_patient',    { amount: 1300, currency: 'EGP' }],
    ['patient_refund_requested',  { amount: 1300, currency: 'EGP' }],
    ['patient_refund_approved',   { approved_amount: 650, currency: 'EGP' }],
    ['patient_refund_denied',     { denial_reason: 'Report was delivered on time' }],
    ['patient_refund_paid',       { amount_egp: 1300 }],
    ['patient_refund_opened_by_operator', {}],
    ['case_cancelled_patient',    { reference_id: 'TSH-2026-000123' }],
    ['case_routing_updated',      { reference_id: 'TSH-2026-000123' }],
    ['prescription_recommended_patient', {}],
    ['addon_purchased_urgency',   {}],
    ['addon_purchased_video',     {}],
    ['addon_purchased_prescription', {}],
    ['video_payment_confirmed',   {}],
    ['video_slot_proposed',       { when: 'Tuesday 15:00' }],
    ['video_slot_confirmed',      { when: 'Tuesday 15:00' }],
    ['video_appointment_reminder',{ when: 'Tuesday 15:00' }],
    ['video_appointment_rescheduled', { when: 'Wednesday 11:00' }],
    ['video_appointment_cancelled', {}],
    ['video_call_started',        {}],
    ['video_call_ended',          {}],
    ['video_doctor_no_show_patient', {}],
    ['video_no_show_patient',     {}],
    ['video_slot_auto_cancelled_patient', {}],
    ['appointment_reminder',      { when: 'Tuesday 15:00' }],
    ['chat_conduct_warning',      {}],
    ['welcome_patient',           {}],
  ];
  const blank = [];
  for (const [tpl, payload] of mustRender) {
    for (const lang of ['en', 'ar']) {
      const body = renderNotificationMessage(tpl, payload, lang);
      if (!body || !String(body).trim()) blank.push(tpl + '/' + lang);
    }
  }
  expect(blank.length === 0,
    'these render an EMPTY body and would ship as a title over blank space: ' + blank.join(', '));
  t.pass(mustRender.length + ' templates render a non-empty body in BOTH en and ar');
} catch (e) { t.fail('notification bodies', e); }

// ── 2. Money notifications survive a payload with no amount ─────────────────
//
// The amount is interpolated only when present. A money sentence with a blank
// number in it reads as a bug to the person who just lost money.
try {
  for (const tpl of ['payment_failed_patient', 'patient_refund_approved', 'patient_refund_paid']) {
    for (const lang of ['en', 'ar']) {
      const body = renderNotificationMessage(tpl, {}, lang);
      expect(body && body.trim(), tpl + '/' + lang + ' returned nothing without an amount');
      expect(!/undefined|null|NaN/.test(body),
        tpl + '/' + lang + ' leaked a placeholder into patient-facing copy: ' + body);
    }
  }
  t.pass('money templates degrade to an amount-free sentence, never a leaked undefined/NaN');
} catch (e) { t.fail('money copy without an amount', e); }

// ── 3. The denial REASON reaches the patient ────────────────────────────────
// It existed only on the email surface. The in-app row said the request was
// refused and nothing else.
try {
  const en = renderNotificationMessage('patient_refund_denied', { denial_reason: 'Delivered on time' }, 'en');
  const ar = renderNotificationMessage('patient_refund_denied', { denial_reason: 'Delivered on time' }, 'ar');
  expect(/Delivered on time/.test(en), 'the denial reason must appear in the English body');
  expect(/Delivered on time/.test(ar), 'the denial reason must appear in the Arabic body');
  t.pass('a denied refund carries its reason, in both languages');
} catch (e) { t.fail('refund denial reason', e); }

// ── 4. Push is wired, and wired in ONE place ────────────────────────────────
try {
  expect(/pushForNotification/.test(NOTIFY),
    'notify.js must send push — the app has registered tokens all along and got nothing');
  expect((NOTIFY.match(/pushForNotification\(/g) || []).length >= 2,
    'both the insert path AND the requeue path must push; a re-armed row is a fresh event ' +
    'and would otherwise be the one that silently never arrives');
  const hookIdx = NOTIFY.indexOf("if (channel === 'internal')");
  expect(hookIdx !== -1,
    "push must be gated on channel === 'internal' — the email and whatsapp rows describe the " +
    'SAME event, so pushing per channel sends three notifications for one thing');
  t.pass('push fires from queueNotification, on the internal channel only, on both write paths');
} catch (e) { t.fail('push wiring', e); }

// ── 5. The push allowlist says what it means ────────────────────────────────
try {
  expect(push.isPushWorthy('report_ready_patient'),
    'the report is the product — if one push exists it is this one');
  expect(push.isPushWorthy('new_message'), 'a human talking to them should reach the phone');
  expect(push.isPushWorthy('payment_failed_patient'), 'a failed payment needs action');
  for (const quiet of ['sla_reminder_24h', 'sla_reminder_6h', 'sla_reminder_1h']) {
    expect(!push.isPushWorthy(quiet),
      quiet + ' must NOT push — the patient cannot act on a deadline the doctor owns, and ' +
      'three lock-screen alerts counting down to it is anxiety, not information');
  }
  expect(!push.isPushWorthy('case_routing_updated'),
    'internal bookkeeping must not push — nothing changed from the patient\'s point of view');
  t.pass('allowlist pushes what is actionable and stays quiet on what is not');
} catch (e) { t.fail('push allowlist', e); }

// ── 6. The in-app list shows app notifications, not emails ──────────────────
try {
  expect(/WHERE to_user_id = \$1 AND channel = 'internal'/.test(API),
    "the list must filter channel='internal' — without it the app renders the patient's " +
    'emails and WhatsApp messages as in-app notifications (40 rows of one reminder on live data)');
  expect(/channel = 'internal' AND is_read = false/.test(API),
    'the unread badge must use the same filter, or it counts emails the patient cannot ' +
    'mark read from inside the app');
  t.pass("list and unread count both scoped to channel='internal'");
} catch (e) { t.fail('channel filter', e); }

// ── 7. ...and the filter did not silently delete the reminders ─────────────
//
// The SLA and payment reminders went out on whatsapp+email only and appeared in
// the app ONLY because the filter was missing. Adding the filter without this
// would have removed them from the app entirely — a fix that quietly deletes a
// feature is worse than the bug.
try {
  // Anchor on the DISPATCH block, not the function definition — an earlier
  // version of this test matched `queuePaymentReminder({` and landed on the
  // declaration 250 lines above the call sites, then reported a fix that was
  // actually present as missing.
  function dispatchBlock(src, fnName) {
    const marker = 'sent.push(await ' + fnName + '({';
    const first = src.indexOf(marker);
    if (first === -1) return '';
    let last = src.lastIndexOf(marker);
    return src.slice(first, last + 1200);
  }
  const paySection = dispatchBlock(LIFECYCLE, 'queuePaymentReminder');
  expect(paySection, 'payment reminders must still be dispatched');
  expect(/channel: 'internal'/.test(paySection),
    'payment reminders must ALSO queue an internal row, or the channel filter deletes them ' +
    'from the app');
  const slaSection = dispatchBlock(LIFECYCLE, 'queueSlaReminder');
  expect(slaSection, 'SLA reminders must still be dispatched');
  expect(/channel: 'internal'/.test(slaSection),
    'SLA reminders must ALSO queue an internal row for the same reason');
  t.pass('SLA and payment reminders now queue internal rows alongside email/whatsapp');
} catch (e) { t.fail('reminders survive the filter', e); }

// ── 8. The payment nudge can reach the payment screen ──────────────────────
try {
  const q = LIFECYCLE.slice(LIFECYCLE.indexOf('function queuePaymentReminder'), LIFECYCLE.indexOf('function queuePaymentReminder') + 2500);
  expect(/orderId: caseId/.test(q),
    'queuePaymentReminder must pass orderId — every payment_reminder row on production ' +
    'carries order_id NULL, so the one notification whose job is to get the patient to pay ' +
    'went nowhere when tapped');
  expect(/PAYMENT_SCREEN_TEMPLATES/.test(API) && /return 'payment'/.test(API),
    'the API must route payment templates to the payment screen, not the case page');
  t.pass('payment reminders carry an order id and open the payment screen');
} catch (e) { t.fail('payment nudge tap target', e); }

// ── 9. The client can still tell templates apart ───────────────────────────
try {
  expect(!/delete n\.template/.test(API),
    'the API must stop deleting `template` — the app keys its icon/title/body maps on it, and ' +
    'deleting it left the client matching a vocabulary that overlapped reality in ONE value');
  t.pass('template survives to the client');
} catch (e) { t.fail('template retention', e); }
