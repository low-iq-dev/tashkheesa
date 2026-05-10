// tests/core/theme7-doctor-accept-uses-transitionCase.test.js
//
// Theme 7 sub-issue A regression guard.
//
// Asserts via source inspection that the doctor accept route routes through
// the canonical lifecycle (transitionCase + assignDoctor) instead of writing
// orders.status directly. Catches the regression class where someone
// reintroduces a raw `UPDATE orders SET status='in_review'` shortcut.
//
// Source-grep style — matches the Theme 5 pattern (see
// tests/core/theme5-mark-paid-pool-discipline.test.js).

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🔄 Theme 7 sub-A — doctor accept uses transitionCase (source check)\n');

const SRC = path.join(__dirname, '..', '..', 'src', 'routes', 'doctor.js');
const src = fs.readFileSync(SRC, 'utf8');

const startIdx = src.indexOf("router.post('/portal/doctor/case/:caseId/accept'");
if (startIdx < 0) {
  t.fail('locate accept handler', new Error('accept route not found'));
} else {
  // Slice from the route declaration to the next `router.` declaration so
  // unrelated handlers in the same file don't pollute the assertions.
  const after = src.slice(startIdx);
  const nextRouter = after.indexOf('\nrouter.');
  const body = nextRouter > 0 ? after.slice(0, nextRouter) : after;

  // 1. The raw `UPDATE orders SET ... status = 'in_review' ...` direct
  //    write must be gone (catches the exact pattern P0-STATE-1 was about).
  //    Require an actual SQL invocation (`execute(` or `client.query(`) so
  //    the descriptive code-comment about the legacy pattern doesn't trip
  //    a false positive.
  try {
    const RAW_STATUS_WRITE = /(execute|client\.query)\(\s*`\s*UPDATE\s+orders[\s\S]{0,400}status\s*=\s*'in_review'/i;
    if (RAW_STATUS_WRITE.test(body)) {
      throw new Error("accept handler still contains raw `UPDATE orders SET status='in_review'` SQL call");
    }
    t.pass("no raw UPDATE orders SET status='in_review' SQL call in accept handler");
  } catch (e) { t.fail('no-raw-status-write', e); }

  // 2. Canonical transitionCase call is present, with IN_REVIEW + client.
  try {
    if (!/caseLifecycle\.transitionCase\([\s\S]*?CASE_STATUS\.IN_REVIEW[\s\S]*?,\s*\{\}\s*,\s*client\s*\)/.test(body)) {
      throw new Error('accept handler missing caseLifecycle.transitionCase(orderId, CASE_STATUS.IN_REVIEW, {}, client)');
    }
    t.pass('accept handler calls transitionCase(IN_REVIEW, {}, client)');
  } catch (e) { t.fail('canonical-transition', e); }

  // 3. transitionCase runs inside withTransaction(async (client) => {…}).
  try {
    if (!/withTransaction\(\s*async\s*\(\s*client\s*\)\s*=>/.test(body)) {
      throw new Error('accept handler does not wrap transitionCase in withTransaction(async (client) => …)');
    }
    t.pass('accept handler uses withTransaction with client threading');
  } catch (e) { t.fail('withTransaction-wrap', e); }

  // 4. PAID-broadcast branch routes through assignDoctor canonically.
  try {
    if (!/CASE_STATUS\.PAID[\s\S]*?caseLifecycle\.assignDoctor\(orderId,\s*doctorId\)/.test(body)) {
      throw new Error('accept handler does not call caseLifecycle.assignDoctor(orderId, doctorId) for PAID-broadcast accepts');
    }
    t.pass('PAID-broadcast accepts walk through caseLifecycle.assignDoctor');
  } catch (e) { t.fail('paid-broadcast-canonical', e); }

  // 5. Capacity-overflow branch routes through canonical assignDoctor or
  //    reassignCase (no raw UPDATE doctor_id).
  try {
    if (!/caseLifecycle\.(assignDoctor|reassignCase)\(orderId,\s*nextDoctor\.id/.test(body)) {
      throw new Error('capacity-overflow branch does not route through caseLifecycle.assignDoctor / reassignCase');
    }
    if (/UPDATE\s+orders\s+SET\s+doctor_id\s*=\s*\$1,\s*updated_at\s*=\s*\$2[\s\S]{0,80}WHERE\s+id\s*=\s*\$3/.test(body)) {
      throw new Error('capacity-overflow branch still contains raw UPDATE doctor_id');
    }
    t.pass('capacity-overflow branch routes through canonical assignDoctor / reassignCase');
  } catch (e) { t.fail('capacity-overflow-canonical', e); }

  // 6. Existing patient multi-channel notification preserved.
  try {
    if (!/queueMultiChannelNotification[\s\S]*?order_status_accepted_patient/.test(body)) {
      throw new Error('accept handler dropped queueMultiChannelNotification(order_status_accepted_patient)');
    }
    t.pass('queueMultiChannelNotification(order_status_accepted_patient) preserved');
  } catch (e) { t.fail('patient-notify-preserved', e); }

  // 7. Existing audit log preserved.
  try {
    if (!/logOrderEvent\([\s\S]*?'doctor_accepted_case'/.test(body)) {
      throw new Error("accept handler dropped logOrderEvent('doctor_accepted_case')");
    }
    t.pass("logOrderEvent('doctor_accepted_case') preserved");
  } catch (e) { t.fail('audit-log-preserved', e); }

  // 8. Existing earnings write preserved.
  try {
    if (!/writePendingForCase\(orderId\)/.test(body)) {
      throw new Error('accept handler dropped writePendingForCase(orderId)');
    }
    t.pass('writePendingForCase(orderId) preserved');
  } catch (e) { t.fail('earnings-preserved', e); }

  // 9. Existing markSlaBreach short-circuit call preserved.
  try {
    if (!/markSlaBreach\(orderId\)/.test(body)) {
      throw new Error('accept handler dropped markSlaBreach(orderId) post-accept short-circuit call');
    }
    t.pass('markSlaBreach(orderId) post-accept call preserved');
  } catch (e) { t.fail('markSlaBreach-preserved', e); }

  // 10. Existing ensureConversation preserved.
  try {
    if (!/ensureConversation\(orderId,\s*[A-Za-z_.]+(?:patient_id|patientId)[A-Za-z_.]*,\s*doctorId\)/.test(body)) {
      throw new Error('accept handler dropped ensureConversation(orderId, patient_id, doctorId)');
    }
    t.pass('ensureConversation(orderId, patient_id, doctorId) preserved');
  } catch (e) { t.fail('ensureConversation-preserved', e); }

  // 11. Existing video-slot backfill preserved.
  try {
    if (!/UPDATE\s+appointments\s+SET\s+doctor_id/.test(body)) {
      throw new Error('accept handler dropped UPDATE appointments SET doctor_id slot backfill');
    }
    if (!/UPDATE\s+video_calls\s+SET\s+doctor_id/.test(body)) {
      throw new Error('accept handler dropped UPDATE video_calls SET doctor_id slot backfill');
    }
    t.pass('appointment + video_calls slot backfill preserved');
  } catch (e) { t.fail('slot-backfill-preserved', e); }

  // 12. Final redirect preserved.
  try {
    if (!/res\.redirect\(\s*['"]\/portal\/doctor\/dashboard['"]\s*\)/.test(body)) {
      throw new Error('accept handler missing /portal/doctor/dashboard redirect');
    }
    t.pass('final redirect /portal/doctor/dashboard preserved');
  } catch (e) { t.fail('redirect-preserved', e); }
}
