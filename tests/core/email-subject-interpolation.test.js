// tests/core/email-subject-interpolation.test.js
//
// P1-NOTIF-4: lock the 10 warmed subject contracts so they don't silently
// revert in a future PR. Pure-JS — no DB, no network, no transport.
//
// Covers:
//   1. interpolate() resolves {key} from vars
//   2. interpolate() returns '' for missing/null/undefined keys (no
//      "undefined" or literal "{key}" in output)
//   3. interpolate() is safe against null str + missing vars object
//   4. The 10 warmed subjects render with realistic vars
//   5. The 10 warmed subjects render gracefully with vars MISSING (the
//      core point of the user's verification request — what does a
//      missing-var subject actually look like?)

'use strict';

const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n📨 P1-NOTIF-4 subject interpolation contracts\n');

const { getNotificationTitles, interpolate } = require('../../src/notify/notification_titles');

function assert(cond, label, detail) {
  if (cond) t.pass(fileTag + ': ' + label);
  else      t.fail(fileTag + ': ' + label, new Error(detail || 'assertion failed'));
}

// ── 1. interpolate() basics (B1 trim post-process applied) ─────────────
// interpolate() collapses whitespace runs and strips trailing punctuation
// after substitution. These assertions lock B1 behavior.
(function () {
  const r1 = interpolate('Hello {name}', { name: 'Sara' });
  assert(r1 === 'Hello Sara', 'interpolate: basic substitution', JSON.stringify(r1));

  // Empty/null/missing var → empty substitution → trailing space trimmed
  const r2 = interpolate('Hello {name}', { name: '' });
  assert(r2 === 'Hello', 'interpolate: empty value → trimmed', JSON.stringify(r2));

  const r3 = interpolate('Hello {name}', { name: null });
  assert(r3 === 'Hello', 'interpolate: null value → trimmed', JSON.stringify(r3));

  const r4 = interpolate('Hello {name}', {});
  assert(r4 === 'Hello', 'interpolate: missing key → trimmed', JSON.stringify(r4));

  const r5 = interpolate('Hello {name}', null);
  assert(r5 === 'Hello', 'interpolate: null vars → trimmed', JSON.stringify(r5));

  const r6 = interpolate(null, { name: 'Sara' });
  assert(r6 === '', 'interpolate: null str → empty string', JSON.stringify(r6));

  // B1: double-space from missing middle var collapses to single space
  const r7 = interpolate('{a} and {b} and {c}', { a: 'one', c: 'three' });
  assert(r7 === 'one and and three', 'interpolate: partial → collapse double-space', JSON.stringify(r7));

  const r8 = interpolate('No placeholders here', { name: 'Sara' });
  assert(r8 === 'No placeholders here', 'interpolate: no-op when no placeholders', JSON.stringify(r8));

  // Numeric and boolean values stringify correctly
  const r9 = interpolate('Value: {n}', { n: 0 });
  assert(r9 === 'Value: 0', 'interpolate: numeric 0 stringifies', JSON.stringify(r9));
  const r10 = interpolate('Flag: {b}', { b: false });
  assert(r10 === 'Flag: false', 'interpolate: boolean false stringifies', JSON.stringify(r10));

  // B1: strip trailing comma/colon/semicolon/dash + space
  const r11 = interpolate('Welcome, {name}', { name: null });
  assert(r11 === 'Welcome', 'interpolate: trailing comma stripped', JSON.stringify(r11));
  const r12 = interpolate('specialty: {ref}', { ref: null });
  assert(r12 === 'specialty', 'interpolate: trailing colon stripped', JSON.stringify(r12));
  // Arabic comma ، U+060C is in the strip class
  const r13 = interpolate('مرحباً، {name}', { name: null });
  assert(r13 === 'مرحباً', 'interpolate: trailing Arabic comma stripped', JSON.stringify(r13));
})();

// ── 2. The 10 warmed subjects with realistic vars ──────────────────────
const sampleVars = {
  doctorName: 'Nancy Mohamed',
  patientName: 'Sara Ahmed',
  caseReference: 'TC-1042',
  appointmentDate: 'Friday, May 8',
  appointmentTime: '10:00 AM'
};

const expectedHappy = [
  // notification template key, expected EN, expected AR
  ['order_created_patient',           'Your case is in our queue',                          'حالتك في قائمة الانتظار'],
  ['payment_success_patient',         'Payment confirmed — case in motion',                 'تم تأكيد الدفع — تشخيصة بدأت العمل'],
  ['order_status_accepted_patient',   'Dr. Nancy Mohamed has accepted your case',           'د. Nancy Mohamed قبل حالتك'],
  ['report_ready_patient',            'Your second opinion is ready',                       'رأيك الطبي الثاني جاهز'],
  ['order_sla_pre_breach_doctor',     'Action needed: case approaching deadline',           'إجراء مطلوب: حالة تقترب من الموعد النهائي'],
  ['order_assigned_doctor',           'New case in your specialty: TC-1042',                'حالة جديدة في تخصصك: TC-1042'],
  ['appointment_booked',              'Your appointment is set: Friday, May 8 at 10:00 AM', 'تم تحديد موعدك: Friday, May 8 في 10:00 AM'],
  ['payment_failed_patient',          "Payment didn't go through — let's try again",        'لم تتم عملية الدفع — لنحاول مرة أخرى'],
  ['welcome_patient',                 'Welcome to Tashkheesa, Sara Ahmed',                  'مرحباً بك في تشخيصة، Sara Ahmed']
];

console.log('\n  --- happy path: realistic vars ---');
expectedHappy.forEach(function (row) {
  const tpl = row[0], wantEn = row[1], wantAr = row[2];
  const r = getNotificationTitles(tpl, sampleVars);
  assert(r.title_en === wantEn, tpl + ' EN', 'got: ' + JSON.stringify(r.title_en));
  assert(r.title_ar === wantAr, tpl + ' AR', 'got: ' + JSON.stringify(r.title_ar));
});

// ── 3. Missing-var renders (B1 trim post-process applied) ──────────────
// Per P1-NOTIF-4 decision: option B1 — interpolate() collapses whitespace
// runs and strips trailing comma/colon/semicolon/dash. Cleans 5 of the 7
// missing-var awkward edges to readable output. Two residual edges remain
// (case-accepted internal "Dr. has", appointment internal " at ") — both
// still semantically readable; would require per-template fallback to fix.
console.log('\n  --- missing-var renders (B1 trim applied) ---');

const missingVarCases = [
  // Cleaned by trim:
  {
    name: 'welcome EN: patientName=null',
    template: 'welcome_patient',
    vars: { patientName: null },
    expectedEn: 'Welcome to Tashkheesa'
  },
  {
    name: 'welcome AR: patientName=null',
    template: 'welcome_patient',
    vars: { patientName: null },
    expectedAr: 'مرحباً بك في تشخيصة'
  },
  {
    name: 'case-assigned EN: caseReference=null',
    template: 'order_assigned_doctor',
    vars: { caseReference: null },
    expectedEn: 'New case in your specialty'
  },
  {
    name: 'case-assigned AR: caseReference=null',
    template: 'order_assigned_doctor',
    vars: { caseReference: null },
    expectedAr: 'حالة جديدة في تخصصك'
  },
  // Trim collapses double space but leaves an awkward-but-readable internal gap:
  {
    name: 'case-accepted EN: doctorName=null (residual)',
    template: 'order_status_accepted_patient',
    vars: { doctorName: null },
    expectedEn: 'Dr. has accepted your case'
  },
  {
    name: 'case-accepted AR: doctorName=null (residual)',
    template: 'order_status_accepted_patient',
    vars: { doctorName: null },
    expectedAr: 'د. قبل حالتك'
  },
  {
    name: 'appointment EN: both dates null (residual)',
    template: 'appointment_booked',
    vars: {},
    expectedEn: 'Your appointment is set: at'
  }
];

missingVarCases.forEach(function (c) {
  const r = getNotificationTitles(c.template, c.vars);
  if (c.expectedEn != null) {
    assert(r.title_en === c.expectedEn, c.name, 'got: ' + JSON.stringify(r.title_en));
  }
  if (c.expectedAr != null) {
    assert(r.title_ar === c.expectedAr, c.name, 'got: ' + JSON.stringify(r.title_ar));
  }
});

// ── 4. Negative invariants — these must NEVER appear in output ─────────
console.log('\n  --- invariants: never render literal "{key}" or "undefined" ---');

const allKeys = Object.keys(require('../../src/notify/notification_titles')).length === 0
  ? null
  : null; // module exports {getNotificationTitles, interpolate} — derive list from TEMPLATE_TITLES via probe

// Probe by calling getNotificationTitles for each known template key with
// EMPTY vars and ensuring no literal "{x}" survives in the output.
const TEMPLATE_KEYS = [
  'order_assigned_doctor', 'order_reassigned_doctor', 'sla_reminder_doctor',
  'sla_breached_doctor', 'patient_reply_info', 'additional_files_requested_patient',
  'patient_uploaded_files_doctor', 'report_ready_patient', 'smoke_test',
  'order_auto_assigned_doctor', 'order_reassigned_to_doctor',
  'order_reassigned_from_doctor', 'public_order_assigned_doctor',
  'order_status_accepted_patient', 'additional_files_request_approved_patient',
  'order_created_patient', 'public_order_created_patient',
  'public_order_created_superadmin', 'order_reassigned_patient',
  'order_breached_patient', 'order_sla_pre_breach', 'order_breached_superadmin',
  'order_sla_pre_breach_doctor', 'order_breached_doctor',
  'case_auto_deleted_unpaid_patient', 'payment_success_patient',
  'payment_success_doctor', 'payment_marked_paid_patient', 'payment_marked_paid',
  'payment_failed_patient', 'doctor_signup_pending', 'doctor_approved',
  'doctor_rejected', 'prescription_uploaded_patient', 'new_message',
  'appointment_booked', 'appointment_rescheduled', 'appointment_cancelled',
  'welcome_patient'
];

let leakCount = 0;
TEMPLATE_KEYS.forEach(function (k) {
  const r = getNotificationTitles(k, {});
  if (/\{\w+\}/.test(r.title_en)) { leakCount++; console.error('  literal {key} in EN: ' + k + ' → ' + r.title_en); }
  if (/\{\w+\}/.test(r.title_ar)) { leakCount++; console.error('  literal {key} in AR: ' + k + ' → ' + r.title_ar); }
  if (/undefined/.test(r.title_en)) { leakCount++; console.error('  "undefined" in EN: ' + k + ' → ' + r.title_en); }
  if (/undefined/.test(r.title_ar)) { leakCount++; console.error('  "undefined" in AR: ' + k + ' → ' + r.title_ar); }
});
assert(leakCount === 0, 'no literal "{key}" or "undefined" in any subject (' + TEMPLATE_KEYS.length + ' templates probed)',
  'leaks: ' + leakCount);

// ── 5. Backward compat — calling without vars is safe ──────────────────
const r0 = getNotificationTitles('order_created_patient');
assert(r0.title_en === 'Your case is in our queue', 'no-vars call: non-interpolated subject works',
  'got: ' + JSON.stringify(r0.title_en));

const rUnknown = getNotificationTitles('totally_unknown_key', { foo: 'bar' });
assert(rUnknown.title_en === 'Totally Unknown Key', 'unknown template: humanized fallback EN',
  'got: ' + JSON.stringify(rUnknown.title_en));
assert(rUnknown.title_ar === 'Totally Unknown Key', 'unknown template: humanized fallback AR (mirrors EN)',
  'got: ' + JSON.stringify(rUnknown.title_ar));
