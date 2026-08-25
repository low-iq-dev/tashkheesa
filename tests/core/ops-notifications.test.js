// tests/core/ops-notifications.test.js
//
// NOTIFICATIONS 2026-08-25 — Command app (operator) alerting contract.
//
// The Command app exists to answer one question away from a desk: is anything
// on fire? Every defect below meant the honest answer was "you would not know".

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
function expect(cond, msg) { if (!cond) throw new Error(msg); }

console.log('\n📟 Command app — operator alerting\n');

const ROOT = path.join(__dirname, '..', '..');
const { stripComments } = require(path.join(__dirname, '..', '_helpers', 'strip-comments.js'));
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const OPS = read('src', 'services', 'ops_push.js');
const WATCHDOG = read('src', 'services', 'worker_watchdog.js');
const ADMIN_API = read('src', 'routes', 'api', 'admin.js');
const WATCHER = read('src', 'workers', 'acceptance_watcher.js');
const opsPush = require(path.join(ROOT, 'src', 'services', 'ops_push.js'));

// ── 1. The most severe alert now persists ───────────────────────────────────
try {
  expect(/recordOpsEvent/.test(WATCHDOG),
    'worker_down must write an Activity row — it was push-ONLY, so missing the push while ' +
    'the phone was locked meant the most severe alert on the platform was gone forever');
  const downIdx = WATCHDOG.indexOf("kind: 'worker_down'");
  const recIdx = WATCHDOG.indexOf("kind: 'worker_recovered'");
  expect(downIdx !== -1, 'the down alert must be recorded');
  expect(recIdx !== -1,
    'recovery must be recorded too — a feed showing every "down" and no "back up" reads as ' +
    'an outage that never ended');
  // It must NOT have been routed through pushOpsEvent: that would layer a
  // weaker claim over the watchdog's durable one, and the per-kind budget
  // could suppress a worker-down alert.
  // Comment-stripped: the comment EXPLAINING why the watchdog does not route
  // through pushOpsEvent contains the words "pushOpsEvent", and an earlier
  // version of this assertion matched its own prose. Third time in this repo,
  // hence tests/_helpers/strip-comments.js.
  expect(!/pushOpsEvent/.test(stripComments(WATCHDOG)),
    'the watchdog must keep its own durable admin_settings cooldown, not defer to the weaker ' +
    'per-event claim — and must never be subject to a budget that could suppress it');
  t.pass('worker_down and worker_recovered persist to Activity, keeping the watchdog\'s stronger throttle');
} catch (e) { t.fail('watchdog persistence', e); }

// ── 2. The per-kind budget is real, not just claimed in a comment ───────────
//
// The header said "Per-kind cooldown. Keyed by kind so a noisy class cannot
// drown a quiet one" while the key was kind + ':' + dedupeKey — i.e. per EVENT.
// Twenty refunds in a minute meant twenty pushes.
try {
  expect(/MAX_PER_KIND_PER_WINDOW/.test(OPS), 'a genuine per-kind ceiling must exist');
  expect(/_kindBudgetExceeded/.test(OPS), 'the ceiling must actually be checked');
  expect(opsPush.MAX_PER_KIND_PER_WINDOW && Object.keys(opsPush.MAX_PER_KIND_PER_WINDOW).length >= 8,
    'the budget must cover the new producers too, or they inherit the noise bug');
  // Suppression must still record, and must tell someone.
  expect(/skipped: 'kind_budget', logged: true/.test(OPS),
    'a budget-suppressed event must still be LOGGED — the Activity feed is what an operator ' +
    'scrolls back through to reconstruct a bad hour');
  expect(/_burstTitle/.test(OPS) && /_summarySent/.test(OPS),
    'a burst must produce ONE summary push — suppression that tells nobody is how an alerting ' +
    'system loses trust, and a muted channel is worse than a noisy one');
  t.pass('per-kind budget caps the buzz, keeps the record, and sends one summary');
} catch (e) { t.fail('per-kind budget', e); }

// ── 3. The budget fails OPEN, the claim fails CLOSED ────────────────────────
// Opposite directions, on purpose: a duplicate is annoying, a missed alert is
// not recoverable.
try {
  const budgetFn = OPS.slice(OPS.indexOf('async function _kindBudgetExceeded'), OPS.indexOf('function _burstTitle'));
  expect(/return null;/.test(budgetFn.slice(budgetFn.indexOf('catch'))),
    'a budget check that cannot run must NOT silence an alert');
  const claimFn = OPS.slice(OPS.indexOf('async function _claim'), OPS.indexOf('async function _kindBudgetExceeded'));
  expect(/Fail CLOSED/.test(claimFn),
    'the claim must still fail closed, or a DB blip becomes a duplicate storm');
  t.pass('budget fails open, claim fails closed — deliberately opposite');
} catch (e) { t.fail('failure directions', e); }

// ── 4. The five silent operational events now speak ────────────────────────
try {
  const wired = [
    ['assignment_failed',      'src/auto_assign.js',            'a PAID case with no eligible doctor'],
    ['classifier_parked',      'src/services/classify_job.js',  'a paid case parked with no doctor and no SLA clock'],
    ['payment_capture_failed', 'src/routes/payments.js',        'the patient was CHARGED and the case may never have been queued'],
    ['sla_prebreach',          'src/case_sla_worker.js',         'the one alert that can still PREVENT a breach'],
    ['chat_reported',          'src/routes/messaging.js',        'a patient reporting a doctor'],
  ];
  for (const [kind, file, why] of wired) {
    const src = read(...file.split('/'));
    expect(src.includes("kind: '" + kind + "'"),
      file + ' must raise ' + kind + ' — ' + why + ' reached nobody');
    expect(/pushOpsEvent/.test(src), file + ' must go through pushOpsEvent so it is throttled and logged');
  }
  t.pass('all five previously-silent operational events now push and persist');
} catch (e) { t.fail('silent events', e); }

// ── 5. An alert must never break the thing it is watching ──────────────────
try {
  for (const file of ['src/auto_assign.js', 'src/services/classify_job.js',
                      'src/routes/payments.js', 'src/case_sla_worker.js',
                      'src/routes/messaging.js']) {
    const src = read(...file.split('/'));
    const i = src.indexOf('pushOpsEvent');
    const around = src.slice(Math.max(0, i - 700), i + 700);
    expect(/try \{/.test(around) && /catch/.test(around),
      file + ': the push must be wrapped — an alerting failure must never fail a payment ' +
      'webhook, an assignment, or a classification');
  }
  t.pass('every new alert is wrapped; none can break its host path');
} catch (e) { t.fail('alert isolation', e); }

// ── 6. The manual queue stops under-reporting ──────────────────────────────
try {
  expect(/o\.assignment_status IN \('manual_queue', 'manual_pending'\)/.test(ADMIN_API),
    "the phone's manual queue must cover BOTH manual states — it filtered 'manual_queue' alone " +
    'while the web counted both, so a paid case with no available doctor did not appear on the ' +
    'phone at all');
  expect(/NOT IN \('draft', 'expired_unpaid', 'cancelled', 'refunded'\)/.test(ADMIN_API),
    'the unpaid-noise filter must survive the widening — that narrowing was about UNPAID rows ' +
    'and is still right');
  t.pass('manual queue covers both manual states, still excluding unpaid noise');
} catch (e) { t.fail('manual queue', e); }

// ── 7. The hourly-forever loop is gone ─────────────────────────────────────
try {
  expect(/MAX_ALERT_HOURS/.test(WATCHER),
    'urgent_unaccepted must stop pushing eventually — it re-fired hourly, forever, with the ' +
    'same words and no escalation, which is what teaches an operator to mute a channel');
  expect(/dedupeKey: order\.id \+ ':h' \+ hoursWaiting/.test(WATCHER),
    'the dedupe key must be banded by hour, or every hour collapses into one throttled key');
  expect(/recordOpsEvent/.test(WATCHER),
    'past the alert window the case must still be RECORDED — it does not stop mattering, it ' +
    'stops being a push');
  expect(/o\.paid_at,/.test(WATCHER),
    'paid_at must be SELECTed — without it hoursWaiting is permanently 0, so the alert never ' +
    'escalates and never stops, which is exactly the loop this fixes');
  t.pass('urgent_unaccepted escalates for a few hours, then records instead of pushing');
} catch (e) { t.fail('escalate-then-stop', e); }
