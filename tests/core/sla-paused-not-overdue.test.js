// tests/core/sla-paused-not-overdue.test.js
//
// A9 (AUDIT 2026-09-09) — a paused SLA must not render as "Overdue" in list
// views. pauseSla freezes the clock and banks the remainder, but leaves the now-
// stale deadline_at in place; computeSla had no sla_paused_at branch, so every
// list view read the past deadline as a breach ("Overdue Nh") while the doctor
// case page — which had its own pause check — showed it on hold. The fix folds
// pause into computeSla (the one helper both use) and gives the paused pseudo-
// status a bilingual "Paused — waiting for files" label in getStatusUi.
//
// Pure-unit — computeSla + getStatusUi are pure. Verified NEGATIVELY: removing
// the pause branch makes the paused case read as breached again.

'use strict';

const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n⏸️  A9 — a paused SLA is not "Overdue"\n');

const { computeSla } = require('../../src/sla_status');
const { getStatusUi } = require('../../src/case_lifecycle');

function check(name, fn) {
  try { const why = fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}

const pastDeadline = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago

check('a paused case with a past deadline is PAUSED, not breached', () => {
  const r = computeSla({
    status: 'rejected_files',
    deadline_at: pastDeadline,
    sla_paused_at: new Date().toISOString(),
    sla_remaining_seconds: 7200,
  });
  if (r.sla.isBreached) return 'a paused case was flagged breached (would show Overdue)';
  if (!r.sla.isPaused) return 'isPaused not set';
  if (r.effectiveStatus !== 'paused') return 'effectiveStatus should be paused, got ' + r.effectiveStatus;
  if (r.sla.minutesRemaining !== 120) return 'frozen remainder not surfaced (want 120, got ' + r.sla.minutesRemaining + ')';
  if (r.sla.minutesOverdue != null) return 'a paused case must have no overdue minutes';
});

check('the SAME case without a pause IS breached (the pause is the discriminator)', () => {
  const r = computeSla({ status: 'rejected_files', deadline_at: pastDeadline });
  if (!r.sla.isBreached) return 'a genuinely overdue case is no longer breached — the branch is too greedy';
  if (r.sla.isPaused) return 'a non-paused case was flagged paused';
});

check('pause wins over a past deadline regardless of order (runs before the deadline branch)', () => {
  // Even with a wildly-past deadline, pause must hold.
  const r = computeSla({
    status: 'in_review',
    deadline_at: '2020-01-01T00:00:00Z',
    sla_paused_at: '2026-09-09T10:00:00Z',
  });
  if (r.sla.isBreached) return 'a stale deadline overrode the pause';
  if (!r.sla.isPaused) return 'pause not detected';
});

check('a completed case still short-circuits before pause', () => {
  const r = computeSla({ status: 'completed', sla_paused_at: new Date().toISOString() });
  if (r.effectiveStatus !== 'completed') return 'completed must win over paused';
  if (r.sla.isPaused) return 'a completed case should not read as paused';
});

check('getStatusUi renders "Paused — waiting for files" in both languages', () => {
  const en = getStatusUi('paused', { role: 'doctor', lang: 'en' });
  const ar = getStatusUi('paused', { role: 'doctor', lang: 'ar' });
  if (!/paused/i.test(en.title) || /^PAUSED$/.test(en.title)) return 'EN label missing/raw: ' + en.title;
  if (!ar.title || ar.title === en.title || /^PAUSED$/.test(ar.title)) return 'AR label missing/untranslated: ' + ar.title;
});
