// tests/core/unpaid-sweep-ttl.test.js
//
// AUDIT-SWEEP-2026-09-06 — the unpaid sweep destroys cases. Pin what it may
// destroy, and when.
//
// WHY THIS FILE EXISTS. The sweep in src/case_lifecycle.js has now been fixed
// three times (AUDIT-P1-4, AUDIT-2026-08-22, and this). The first two corrected
// which rows it RE-SELECTED; neither asked which statuses it was entitled to
// destroy in the first place, because that was expressed as an EXCLUSION list —
// "everything except COMPLETED, CANCELLED, EXPIRED_UNPAID" — and an exclusion
// list is invisible when it is wrong. DRAFT is not terminal, so every wizard
// draft was expired 24 hours after the patient started it and soft-deleted at
// 48h, out of every patient-facing query. Production: 41 orders, 36
// expired_unpaid, zero in DRAFT / SUBMITTED / PAID / ASSIGNED / IN_REVIEW.
//
// The two assertions that matter, and that nothing else in the suite makes:
//
//   1. A DRAFT one day old is NOT swept. That is the exact bug, as a value.
//   2. Every canonical status is named in EXACTLY ONE of UNPAID_CASE_TTL (has a
//      TTL) or UNPAID_TTL_NEVER_EXPIRES (documented exempt). A status added
//      tomorrow fails this test rather than silently inheriting a destroy timer.
//
// Source-level assertions run through tests/_helpers/strip-comments, because
// the comments in case_lifecycle.js quote the very literals ('24 * 60 * 60',
// 'deleted_at') this file forbids — the trap that has already taken out three
// tests in this repo, and the reason that helper exists.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
function expect(cond, msg) { if (!cond) throw new Error(msg); }

console.log('\n🧹 Unpaid sweep — per-status TTL\n');

const ROOT = path.join(__dirname, '..', '..');
const cl = require('../../src/case_lifecycle');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-06T12:00:00Z');

// A row as the sweep sees it: whatever the clock says, `status` decides.
function row(status, ageMs, opts) {
  const stamp = new Date(NOW - ageMs).toISOString();
  return Object.assign({
    id: 'order-' + status,
    status: status,
    created_at: stamp,
    updated_at: stamp
  }, opts || {});
}

// ── 1. The TTL table, pinned per status ────────────────────────────────────
try {
  const ttl = cl.UNPAID_CASE_TTL;
  expect(ttl && typeof ttl === 'object', 'case_lifecycle must export UNPAID_CASE_TTL');

  expect(ttl.DRAFT && ttl.DRAFT.expireAfterHours === 30 * 24,
    'DRAFT must expire at 30 days (720h); got ' + JSON.stringify(ttl.DRAFT));
  expect(ttl.DRAFT.clock === 'updated_at',
    "DRAFT must be clocked on updated_at (last activity), not created_at — a patient who " +
    'came back yesterday has a live case whatever its birthday says');

  expect(ttl.SUBMITTED && ttl.SUBMITTED.expireAfterHours === 7 * 24,
    'SUBMITTED-but-unpaid must expire at 7 days (168h); got ' + JSON.stringify(ttl.SUBMITTED));
  expect(ttl.SUBMITTED.clock === 'updated_at',
    'SUBMITTED must be clocked on updated_at, for the same reason as DRAFT');

  expect(Object.keys(ttl).length === 2,
    'only DRAFT and SUBMITTED may carry an expiry timer; found ' + Object.keys(ttl).join(', '));
  t.pass('TTL table pinned: DRAFT 720h / SUBMITTED 168h, both on updated_at, nothing else expirable');
} catch (e) { t.fail('TTL table', e); }

// ── 2. THE BUG: a DRAFT is not swept at 24h ────────────────────────────────
// Stated as a value, at several ages, because this is the whole point of the
// file. 25h is the age at which every draft this platform ever created died.
try {
  [1 * HOUR, 24 * HOUR, 25 * HOUR, 2 * DAY, 7 * DAY, 29 * DAY].forEach(function (age) {
    expect(cl.isUnpaidExpiryDue(row('DRAFT', age), NOW) === false,
      'a DRAFT aged ' + Math.round(age / HOUR) + 'h must NOT be swept');
  });
  expect(cl.isUnpaidExpiryDue(row('DRAFT', 30 * DAY + HOUR), NOW) === true,
    'a DRAFT past 30 days must expire');
  // Lowercase is what the raw-SQL writers store; the predicate must fold it.
  expect(cl.isUnpaidExpiryDue(row('draft', 31 * DAY), NOW) === true,
    "lowercase 'draft' must be recognised — orders.status holds both cases");
  t.pass('DRAFT survives 24h, 48h and 29 days; expires only past 30 days (both spellings)');
} catch (e) { t.fail('DRAFT is never swept at 24h', e); }

// ── 3. SUBMITTED-but-unpaid: 7 days, on last activity ──────────────────────
try {
  expect(cl.isUnpaidExpiryDue(row('SUBMITTED', 25 * HOUR), NOW) === false,
    'a SUBMITTED unpaid case must survive 24h');
  expect(cl.isUnpaidExpiryDue(row('SUBMITTED', 6 * DAY), NOW) === false,
    'a SUBMITTED unpaid case must survive 6 days');
  expect(cl.isUnpaidExpiryDue(row('SUBMITTED', 8 * DAY), NOW) === true,
    'a SUBMITTED unpaid case must expire past 7 days');

  // The clock is LAST ACTIVITY. An old case touched an hour ago is alive.
  const touched = {
    id: 'o1',
    status: 'SUBMITTED',
    created_at: new Date(NOW - 60 * DAY).toISOString(),
    updated_at: new Date(NOW - 1 * HOUR).toISOString()
  };
  expect(cl.isUnpaidExpiryDue(touched, NOW) === false,
    'a 60-day-old case touched an hour ago must NOT expire — updated_at is the clock, not created_at');
  t.pass('SUBMITTED expires at 7 days, measured on last activity');
} catch (e) { t.fail('SUBMITTED TTL', e); }

// ── 4. Nothing else is expirable, and the enum is fully accounted for ──────
// This is the guard against the NEXT one: a status that appears in neither
// table fails here, so it cannot silently inherit a destroy timer.
try {
  ['PAID', 'ASSIGNED', 'IN_REVIEW', 'REJECTED_FILES', 'SLA_BREACH', 'REASSIGNED',
   'COMPLETED', 'CANCELLED', 'REFUNDED', 'EXPIRED_UNPAID', 'PENDING_REVIEW'
  ].forEach(function (s) {
    expect(cl.unpaidTtlFor(s) === null, s + ' must have no TTL — the sweep must never expire it');
    expect(cl.isUnpaidExpiryDue(row(s, 400 * DAY), NOW) === false,
      s + ' must not be swept even after 400 days');
  });

  const withTtl = Object.keys(cl.UNPAID_CASE_TTL);
  const exempt = Object.keys(cl.UNPAID_TTL_NEVER_EXPIRES || {});
  const overlap = withTtl.filter(function (k) { return exempt.indexOf(k) !== -1; });
  expect(overlap.length === 0, 'a status cannot be both expirable and exempt: ' + overlap.join(', '));

  const declared = withTtl.concat(exempt).sort();
  const canonical = Object.keys(cl.CASE_STATUS).map(function (k) { return cl.CASE_STATUS[k]; });
  const missing = canonical.filter(function (s) { return declared.indexOf(s) === -1; });
  expect(missing.length === 0,
    'every canonical status must be declared in UNPAID_CASE_TTL or UNPAID_TTL_NEVER_EXPIRES. ' +
    'Undeclared: ' + missing.join(', ') + ' — decide whether the unpaid sweep may destroy it');
  t.pass('all ' + canonical.length + ' canonical statuses accounted for; ' + exempt.length + ' explicitly never expire');
} catch (e) { t.fail('status coverage', e); }

// ── 5. The reminder copy no longer carries a dead constant ─────────────────
// hoursRemaining is interpolated into "we hold cases for a final N hours".
// Hardcoded at 48 it told a 30-day draft it had none left.
try {
  expect(cl.unpaidTtlHoursRemaining(row('DRAFT', 1 * DAY), NOW) === 29 * 24,
    'a 1-day-old draft has 29 days left');
  expect(cl.unpaidTtlHoursRemaining(row('SUBMITTED', 1 * DAY), NOW) === 6 * 24,
    'a 1-day-old submitted case has 6 days left');
  expect(cl.unpaidTtlHoursRemaining(row('DRAFT', 40 * DAY), NOW) === 0,
    'never negative');
  expect(cl.unpaidTtlHoursRemaining(row('PAID', 1 * DAY), NOW) === null,
    'a status with no TTL has no remaining-hours answer');
  t.pass('hours-remaining derives from the TTL table, per status');
} catch (e) { t.fail('hours remaining', e); }

// ── 6. Source: the 24h/48h hard stops and the soft-delete are gone ─────────
// Comments stripped first — the block explaining WHY the 48h soft-delete was
// removed necessarily says "deleted_at" and "48".
try {
  const CODE = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'case_lifecycle.js'), 'utf8'));
  const sweepStart = CODE.indexOf('async function dispatchUnpaidCaseReminders');
  expect(sweepStart !== -1, 'dispatchUnpaidCaseReminders must exist');
  const sweep = CODE.slice(sweepStart, CODE.indexOf('const CASE_STATUS = Object.freeze', sweepStart));
  expect(sweep.length > 500, 'failed to slice the sweep body — this guard would pass over nothing');

  expect(!/24\s*\*\s*60\s*\*\s*60/.test(sweep.replace(/\{\s*level:[^}]*\}/g, '')),
    "the 24h expiry hard-stop must be gone from the sweep — expiry comes from UNPAID_CASE_TTL");
  expect(!/48\s*\*\s*60\s*\*\s*60/.test(sweep),
    'the 48h hard-stop must be gone from the sweep');
  expect(!/deleted_at\s*=\s*\$/.test(sweep),
    'the sweep must not soft-delete: deleted_at drops the row out of orders_active, i.e. out of ' +
    'every patient-facing query, which is what made an expired case unrecoverable AND invisible');
  expect(/unpaidTtlFor\s*\(/.test(sweep) && /isUnpaidExpiryDue\s*\(/.test(sweep),
    'the sweep must decide expiry through the TTL helpers');
  t.pass('sweep carries no 24h/48h constants and no soft-delete; expiry runs through UNPAID_CASE_TTL');
} catch (e) { t.fail('sweep source shape', e); }

// ── 7. An expired case stays visible and resumable ─────────────────────────
// The other half of the original bug: expired_unpaid rows were filtered out of
// /patient/cases, so the case did not merely stop — it vanished.
try {
  const PATIENT = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'routes', 'patient.js'), 'utf8'));
  const start = PATIENT.indexOf("router.get('/patient/cases'");
  expect(start !== -1, "GET /patient/cases must exist");
  const handler = PATIENT.slice(start, start + 3000);
  expect(!/EXPIRED_UNPAID/.test(handler),
    '/patient/cases must not filter out EXPIRED_UNPAID — the status has patient-facing copy ' +
    '("Payment window closed") and is revivable by paying; hiding it removed both the ' +
    'explanation and the way back');
  expect(!/INTERVAL '30 days'/.test(handler),
    'the draft age cutoff belongs to the sweep (UNPAID_CASE_TTL), not to this list');

  // And the retention window that IS still expressed here is generated, not typed.
  expect(/DRAFT_RETENTION_SQL_INTERVAL/.test(PATIENT),
    'the dashboard resume tile and wizard auto-resume must derive their window from ' +
    'case_lifecycle.unpaidTtlHoursFor, not from a hardcoded interval');
  expect(!/INTERVAL '30 days'/.test(PATIENT),
    "no hardcoded INTERVAL '30 days' may remain in routes/patient.js — it drifted from the " +
    'sweep for the whole life of the feature');
  t.pass('expired cases stay listed; the draft window is generated from the TTL table');
} catch (e) { t.fail('patient visibility', e); }

// ── 8. Expiry tells the patient ────────────────────────────────────────────
// The notification lived inside the 48h soft-delete, which the 24h expiry made
// unreachable, so nobody was ever told anything.
try {
  const CODE = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'case_lifecycle.js'), 'utf8'));
  expect(/case_expired_unpaid_patient/.test(CODE),
    'expiry must queue a patient notification');
  const titles = fs.readFileSync(path.join(ROOT, 'src', 'notify', 'notification_titles.js'), 'utf8');
  expect(/case_expired_unpaid_patient/.test(stripComments(titles)),
    'the template must be registered in notification_titles or the bell shows a humanized slug');
  const { getNotificationTitles } = require('../../src/notify/notification_titles');
  const rendered = getNotificationTitles('case_expired_unpaid_patient', {});
  expect(rendered.title_en && rendered.title_en !== 'Case Expired Unpaid Patient',
    'the template must have a real EN title, not the humanized-slug fallback');
  expect(rendered.title_ar && !/\{\w+\}/.test(rendered.title_ar),
    'the template must have an AR title with no un-interpolated placeholders');
  t.pass('expiry notifies the patient, and the template is registered in both languages');
} catch (e) { t.fail('expiry notification', e); }
