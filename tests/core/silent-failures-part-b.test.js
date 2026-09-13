// tests/core/silent-failures-part-b.test.js
//
// Part B item 3 (2026-09-13) — the rest of the silent-failure family.
//
//   (a) manual SLA sweep (superadmin.js) — a failed sweep redirected ?sla_ran=1
//   (b) new files uploaded (patient.js) — the doctor notification result was
//       never read; a doctor who was never told left the case parked
//   (c) turnaround-save (doctor.js) — the failure rode ?success= into the
//       GREEN card
//   (d) reject-files (doctor.js) — a failed status write, or a failed SLA
//       pause, bounced to the case page with no code at all
//   (e) refund opened / approved / denied (superadmin.js) — the patient
//       notification was fire-and-forget inside a swallowing catch, then
//       ?flash=<ok>
//
// Each now carries an honest code the page renders, and the ops-facing
// failures land in case_events under a '%_FAILED' label the
// /ops/silent-failures view lists. The class itself is closed by
// tests/lint/no-success-redirect-after-catch.test.js.
//
// Source-grep. Verified NEGATIVELY: restoring the turnaround ?success= fails
// (c); dropping the sla_sweep_failed branch fails (a); un-awaiting the refund
// queue call fails (e).

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n🔇 Part B-3 — the rest of the silent-failure family fails loudly\n');

const ROOT = path.join(__dirname, '..', '..');
function code(rel) { return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
function raw(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function check(name, fn) {
  try { const why = fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}
function handler(src, anchor) {
  const start = src.indexOf(anchor);
  if (start < 0) return '';
  const after = src.slice(start + anchor.length);
  const next = after.search(/\nrouter\.(post|get|put|delete)\(/);
  return next > 0 ? after.slice(0, next) : after;
}

const SA = code('src/routes/superadmin.js');
const DR = code('src/routes/doctor.js');
const PT = code('src/routes/patient.js');
const LC = code('src/case_lifecycle.js');
const V_SA = raw('src/views/superadmin.ejs');
const V_REF = raw('src/views/superadmin_refunds.ejs');
const V_SVC = raw('src/views/portal_doctor_services.ejs');

// (a) manual SLA sweep
check('(a) manual SLA sweep: a failed sweep redirects with error=sla_sweep_failed, not sla_ran=1', () => {
  const h = handler(SA, "router.get('/superadmin/tools/run-sla-sweep'");
  if (!h) return 'handler not found';
  if (!/sweepFailed\s*=\s*true/.test(h)) return 'no failure flag in the catch';
  if (!/sweepFailed \? '\/superadmin\?error=sla_sweep_failed' : '\/superadmin\?sla_ran=1'/.test(h)) return 'redirect is not branched on the failure';
});
check('(a) the dashboard renders BOTH outcomes', () => {
  const h = handler(SA, "router.get('/superadmin',");
  if (!/slaRan:\s*String\(query\.sla_ran/.test(h)) return 'slaRan not passed';
  if (!/slaError:\s*String\(query\.error \|\| ''\) === 'sla_sweep_failed'/.test(h)) return 'slaError not passed';
  if (!/_slaError/.test(V_SA) || !/_slaRan/.test(V_SA)) return 'superadmin.ejs renders neither';
  if (!/SLA sweep FAILED/.test(V_SA)) return 'no failure copy in superadmin.ejs';
});

// (b) new files uploaded → doctor
check('(b) upload: the doctor-notify queue result is read, and a total failure is a DOCTOR_FILES_NOTIFY_FAILED case event', () => {
  const h = handler(PT, "router.post('/portal/patient/orders/:id/upload'");
  if (!h) return 'handler not found';
  if (!/const qr = await queueMultiChannelNotification\(/.test(h)) return 'queue call is still fire-and-forget';
  if (!/queueLanded = Object\.keys\(rs\)\.some/.test(h)) return 'queue result not inspected';
  if (!/emailLanded = true/.test(h)) return 'direct email success not recorded';
  if (!/if \(!queueLanded && !emailLanded\)/.test(h)) return 'no both-failed branch';
  if (!/logCaseEvent\(orderId, 'DOCTOR_FILES_NOTIFY_FAILED'/.test(h)) return 'no case event';
});

// (c) turnaround-save
check('(c) turnaround-save: the failure is an ?error= code, never ?success=', () => {
  const h = handler(DR, "router.post('/portal/doctor/turnaround'");
  if (!h) return 'handler not found';
  const c = h.slice(h.lastIndexOf('} catch (err) {'));
  if (/\?success=/.test(c)) return 'the catch still redirects with ?success=';
  if (!/\?error=turnaround_save_failed/.test(c)) return 'the catch does not carry turnaround_save_failed';
});
check('(c) the services page renders that code in its error card', () => {
  const g = handler(DR, "router.get('/portal/doctor/services'");
  if (!/=== 'turnaround_save_failed'/.test(g)) return 'GET does not map the code';
  if (!/_error/.test(V_SVC)) return 'view has no error card';
});

// (d) reject-files
check('(d) reject-files: a failed write and a failed SLA pause each carry a code the case page renders', () => {
  const h = handler(DR, "router.post('/portal/doctor/case/:caseId/reject-files'");
  if (!h) return 'handler not found';
  if (!/\?error=reject_files_failed/.test(h)) return 'write failure has no code';
  if (!/slaPauseFailed\s*=\s*true/.test(h) || !/\?error=reject_files_sla_pause_failed/.test(h)) return 'SLA pause failure has no code';
  if (!/reject_files_failed:\s*\{/.test(DR) || !/reject_files_sla_pause_failed:\s*\{/.test(DR)) return 'REPORT_SUBMIT_ERRORS lacks the entries';
  const rx = DR.slice(DR.indexOf('reject_files_failed: {'), DR.indexOf('reject_files_failed: {') + 900);
  if (!/[؀-ۿ]/.test(rx)) return 'no Arabic copy for the new codes';
});

// (e) refunds
// Part C3 (2026-09-13): patient_refund_paid joins — it was the last one fired and forgotten.
['patient_refund_opened_by_operator', 'patient_refund_approved', 'patient_refund_denied', 'patient_refund_paid'].forEach((tpl) => {
  check('(e) ' + tpl + ': the queue call is awaited, its result read, and a failure warns the operator', () => {
    const i = SA.indexOf("template: '" + tpl + "'");
    if (i < 0) return 'site not found';
    const around = SA.slice(Math.max(0, i - 700), i + 900);
    if (!/const r = await queueMultiChannelNotification\(/.test(around)) return 'still fire-and-forget';
    if (!/patientNotified = refundNotifyLanded\(r\)/.test(around)) return 'result not read';
    if (!/flagRefundNotifyFailed\(/.test(around)) return 'failure not flagged';
    if (!/&warn=patient_not_notified/.test(around)) return 'operator not warned';
  });
});
check('(e) the refund queue renders the warning and the registry lists the event', () => {
  if (!/flashWarn === 'patient_not_notified'/.test(V_REF)) return 'superadmin_refunds.ejs does not render the warn code';
  if (!/flashWarn:\s*String\(\(req\.query && req\.query\.warn\)/.test(SA)) return 'route does not pass flashWarn';
  if (!/logCaseEvent\(orderId, 'REFUND_PATIENT_NOTIFY_FAILED'/.test(SA)) return 'no case event';
  const reg = LC.slice(LC.indexOf('const SILENT_FAILURE_EVENTS'), LC.indexOf('const SILENT_FAILURE_EVENTS') + 1500);
  if (!/'REFUND_PATIENT_NOTIFY_FAILED'/.test(reg) || !/'DOCTOR_FILES_NOTIFY_FAILED'/.test(reg)) return 'SILENT_FAILURE_EVENTS is missing the new labels';
});
check('(e) refundNotifyLanded treats a skipped channel as not-delivered', () => {
  // Pure function extracted by regex so it can be evaluated without loading the router.
  const m = SA.match(/function refundNotifyLanded\(result\) \{[\s\S]*?\n\}/);
  if (!m) return 'helper not found';
  const fn = new Function('return (' + m[0] + ')')();
  if (fn({ ok: true, results: { internal: { ok: true, skipped: true, reason: 'x' }, email: { ok: true, skipped: true, reason: 'no_email' } } })) return 'all-skipped counted as landed';
  if (!fn({ ok: true, results: { internal: { ok: true, id: '1' }, email: { ok: true, skipped: true } } })) return 'internal landing not recognised';
  if (fn({ ok: false, skipped: true, reason: 'invalid_to_user_id' })) return 'invalid recipient counted as landed';
});
