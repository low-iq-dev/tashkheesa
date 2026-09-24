// tests/core/batch-c-decline-handback-structure.test.js
//
// BATCH C (fix plan 2026-09-15) — C3 decline + hand-back, C4 columns, C5 RLS.
//
// Structural pins on the properties the brief makes load-bearing. The decline
// and hand-back routes live inside the doctor.js router (which needs a full
// portal boot to instantiate), so like the A-series audits these tests read
// the source and pin the shapes that must not drift:
//
//   * DECLINE must never cost money or count toward auto-pause. That property
//     is not implemented in the route — it FALLS OUT of
//     earnings_writer.markReassignedOnReassignment returning no_main_row (a
//     pre-accept doctor has no earnings row) BEFORE the doctor_sla_events
//    INSERT. If that early-return moves below the INSERT, decline silently
//     starts writing pause-counter events. Pinned here.
//
//   * HAND-BACK's excused reasons must be excluded from the 3-in-30 pause
//     count, or good consultants get auto-paused for going on leave.
//
//   * Both routes must go through case_lifecycle.reassignCase (the canonical
//     path), never a raw doctor_id UPDATE.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🩺 BATCH C — decline/hand-back structure (C3), columns (C4), RLS (C5)\n');

const read = (p) => fs.readFileSync(path.join(__dirname, '../../', p), 'utf8');

function check(name, fn) {
  try { fn(); t.pass(name); } catch (e) { t.fail(name, e); }
}

const doctorSrc = read('src/routes/doctor.js');
const pauseSrc = read('src/services/doctor_pause.js');
const writerSrc = read('src/services/earnings_writer.js');
const viewSrc = read('src/views/portal_doctor_case.ejs');

// ── C3: the routes exist and take the canonical path ──

check('C3: POST decline and handback routes exist, doctor-gated', () => {
  assert.ok(/router\.post\('\/portal\/doctor\/case\/:caseId\/decline',\s*requireDoctor/.test(doctorSrc));
  assert.ok(/router\.post\('\/portal\/doctor\/case\/:caseId\/handback',\s*requireDoctor/.test(doctorSrc));
});

check('C3: both routes route through case_lifecycle.reassignCase — no raw doctor_id UPDATE', () => {
  const decline = doctorSrc.slice(doctorSrc.indexOf("case/:caseId/decline'"), doctorSrc.indexOf("case/:caseId/handback'"));
  const handback = doctorSrc.slice(doctorSrc.indexOf("case/:caseId/handback'"), doctorSrc.indexOf('---- end decline / hand-back ----'));
  assert.ok(/caseLifecycle\.reassignCase\(/.test(decline), 'decline does not call reassignCase');
  assert.ok(/caseLifecycle\.reassignCase\(/.test(handback), 'handback does not call reassignCase');
  assert.ok(!/UPDATE orders SET doctor_id/i.test(decline + handback), 'raw doctor_id write found');
});

check('C3: decline is PRE-ACCEPT only (guards accepted_at + ASSIGNED), hand-back is POST-ACCEPT only', () => {
  const decline = doctorSrc.slice(doctorSrc.indexOf("case/:caseId/decline'"), doctorSrc.indexOf("case/:caseId/handback'"));
  const handback = doctorSrc.slice(doctorSrc.indexOf("case/:caseId/handback'"), doctorSrc.indexOf('---- end decline / hand-back ----'));
  assert.ok(/order\.accepted_at \|\| toCanonStatus\(order\.status\) !== caseLifecycle\.CASE_STATUS\.ASSIGNED/.test(decline));
  assert.ok(/!order\.accepted_at \|\| order\.completed_at/.test(handback));
});

check('C3: both routes assert ownership (doctor_id === me) before acting', () => {
  const block = doctorSrc.slice(doctorSrc.indexOf("case/:caseId/decline'"), doctorSrc.indexOf('---- end decline / hand-back ----'));
  const matches = block.match(/String\(order\.doctor_id \|\| ''\) !== doctorId/g) || [];
  assert.ok(matches.length >= 2, 'expected the ownership guard in both handlers, found ' + matches.length);
});

check('C3: decline reasons and hand-back reasons are allowlisted; excused set is exactly on_leave / wrong_subspecialty / conflict_of_interest', () => {
  assert.ok(doctorSrc.includes("const DOCTOR_DECLINE_REASONS = ['unavailable', 'wrong_subspecialty', 'conflict_of_interest', 'workload', 'other']"));
  assert.ok(doctorSrc.includes("const DOCTOR_HANDBACK_EXCUSED = ['on_leave', 'wrong_subspecialty', 'conflict_of_interest']"));
});

check("C3: hand-back reason strings — excused → 'doctor_handback:excused:<cat>', otherwise 'doctor_handback:<cat>'", () => {
  assert.ok(doctorSrc.includes("'doctor_handback:excused:' + reasonCategory"));
  assert.ok(doctorSrc.includes("'doctor_handback:' + reasonCategory"));
  assert.ok(doctorSrc.includes("'doctor_declined:' + reasonCategory"));
});

// ── C3: the no-money / no-pause property of decline ──

check('C3 SAFETY: markReassignedOnReassignment returns no_main_row BEFORE the doctor_sla_events INSERT (decline writes neither)', () => {
  const fnStart = writerSrc.indexOf('async function markReassignedOnReassignment');
  assert.ok(fnStart > 0);
  const body = writerSrc.slice(fnStart);
  const noRow = body.indexOf("skipped: 'no_main_row'");
  const evtInsert = body.indexOf('INSERT INTO doctor_sla_events');
  assert.ok(noRow > 0 && evtInsert > 0);
  assert.ok(noRow < evtInsert, 'no_main_row early-return must come before the SLA-event INSERT');
});

check('C3: doctor_pause excludes BOTH admin_manual and doctor_handback:excused from the pause count', () => {
  assert.ok(/NOT LIKE 'admin\\\\_manual%'/.test(pauseSrc));
  assert.ok(/NOT LIKE 'doctor\\\\_handback:excused%'/.test(pauseSrc));
});

check("C3: hand-back does NOT pass operatorInitiated (the doctor's own decision keeps the pause check running)", () => {
  const handback = doctorSrc.slice(doctorSrc.indexOf("case/:caseId/handback'"), doctorSrc.indexOf('---- end decline / hand-back ----'));
  assert.ok(!/operatorInitiated\s*:\s*true/.test(handback));
});

// ── C3: UI is server-gated and honest ──

check('C3: the case page renders decline/hand-back only on server-decided flags (canDecline/canHandback)', () => {
  assert.ok(/canDecline:/.test(doctorSrc) && /canHandback:/.test(doctorSrc));
  assert.ok(/_canDecline/.test(viewSrc) && /_canHandback/.test(viewSrc));
  assert.ok(viewSrc.includes('action="/portal/doctor/case/<%= _orderIdEnc %>/decline"'));
  assert.ok(viewSrc.includes('action="/portal/doctor/case/<%= _orderIdEnc %>/handback"'));
});

check('C3: the hand-back copy states the real consequences (zero earnings; unexcused hand-backs can pause)', () => {
  assert.ok(viewSrc.includes('you earn nothing for it'), 'earnings consequence missing from copy');
  assert.ok(viewSrc.includes('without a legitimate reason can pause'), 'pause consequence missing from copy');
});

// ── C4: the two columns ──

check('C4: migration 111 adds users.appearance_preference and the doctor_phrases table (app DbPhrase shape)', () => {
  const m = read('src/migrations/111_appearance_and_doctor_phrases.sql');
  assert.ok(m.includes('ALTER TABLE users ADD COLUMN IF NOT EXISTS appearance_preference'));
  assert.ok(m.includes('CREATE TABLE IF NOT EXISTS doctor_phrases'));
  for (const col of ['doctor_id', 'text_en', 'text_ar', 'category', 'times_used']) {
    assert.ok(m.includes(col), 'doctor_phrases missing ' + col);
  }
  assert.ok(m.includes('ALTER TABLE doctor_phrases ENABLE ROW LEVEL SECURITY'));
});

// ── C5: RLS on the three uncovered tables ──

check('C5: migration 112 enables RLS on deleted_users, email_delivery_events, email_suppressions AND doctor_sla_events (the 109 miss) — existence-guarded', () => {
  const m = read('src/migrations/112_rls_deleted_users_email_tables.sql');
  for (const tbl of ['deleted_users', 'email_delivery_events', 'email_suppressions', 'doctor_sla_events']) {
    assert.ok(m.includes("to_regclass('public." + tbl + "')"), tbl + ' not guarded');
    assert.ok(m.includes(tbl + ' ENABLE ROW LEVEL SECURITY'), tbl + ' not enabled');
  }
});

// ── C1 storage: migration 116 ──
// (Written as 110; main renumbered it 110 -> 116 to clear the duplicate with
// 110_orders_is_practice.sql, commit 94607e6. Same file, same assertions.)

check('C1: migration 116 creates user_sessions with the unique refresh_token index, seeds legacy rows, enables RLS', () => {
  const m = read('src/migrations/116_user_sessions.sql');
  assert.ok(m.includes('CREATE TABLE IF NOT EXISTS user_sessions'));
  assert.ok(m.includes('CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_sessions_refresh_token'));
  assert.ok(/INSERT INTO user_sessions[\s\S]*FROM users u\s*WHERE u\.refresh_token IS NOT NULL/.test(m), 'legacy seed missing');
  assert.ok(m.includes("device_id"), 'device_id column missing');
  assert.ok(m.includes('ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY'));
});

check('C1: deactivate (web), reject (web) and reject (service) all revoke user_sessions beside the mirror NULL', () => {
  const sa = read('src/routes/superadmin.js');
  const svc = read('src/services/admin_doctor_reject.js');
  const revokes = (sa.match(/UPDATE user_sessions SET revoked_at = NOW\(\) WHERE user_id = \$1 AND revoked_at IS NULL/g) || []).length;
  assert.ok(revokes >= 2, 'expected session revocation at deactivate AND reject in superadmin.js, found ' + revokes);
  assert.ok(/UPDATE user_sessions SET revoked_at = NOW\(\)/.test(svc), 'admin_doctor_reject.js does not revoke sessions');
});

check('C1: push send paths read the per-device sessions UNION the mirror (patient send + superadmin fan-out)', () => {
  const push = read('src/middleware/push.js');
  assert.ok(/_liveTokensForUser/.test(push));
  assert.ok(/FROM user_sessions/.test(push));
  assert.ok(/UNION/.test(push), 'superadmin fan-out does not union session tokens');
});
