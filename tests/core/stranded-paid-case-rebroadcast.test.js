// tests/core/stranded-paid-case-rebroadcast.test.js
//
// A2 (AUDIT 2026-09-09) — a paid case must always have a durable path to a
// doctor. markCasePaid fires broadcastOrderToSpecialty fire-and-forget; if it
// throws or the process restarts, the case is left status=PAID / doctor_id NULL
// / acceptance_deadline_at NULL and NO worker scans for that shape. This guards
// the durable re-broadcast sweep added to the 5-minute SLA tick.
//
// UNIT: handleStrandedPaidCase (injected deps) re-broadcasts, records a
//   CASE_ROUTING_RETRIED event every attempt, and pushes an ops event to the
//   Activity feed ONLY after the second failed retry — never the first.
// STRUCTURAL: the candidate SELECT carries the exact predicate, the sweep is
//   wired into the tick, and pushOpsEvent is gated on the second failure.
//
// Verified NEGATIVELY: dropping the `attempt >= 2` gate made the "first failure
// stays quiet" assertion fail; restored.

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n♻️  A2 — durable re-broadcast of stranded paid cases\n');

const ROOT = path.join(__dirname, '..', '..');
const worker = require('../../src/case_sla_worker');

async function check(name, fn) {
  try { const why = await fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}

// A recording deps bundle for handleStrandedPaidCase.
function makeDeps({ priorRetries = 0, broadcast }) {
  const events = [];
  const ops = [];
  return {
    events, ops,
    deps: {
      queryOne: async () => ({ c: priorRetries }),
      logCaseEvent: async (caseId, type, payload) => { events.push({ caseId, type, payload }); },
      broadcast,
      pushOpsEvent: async (opts) => { ops.push(opts); return { sent: true }; },
    },
  };
}

// ── UNIT ─────────────────────────────────────────────────────────────────────

check('first failure: re-broadcasts, logs the retry, but does NOT alert ops', async () => {
  const d = makeDeps({ priorRetries: 0, broadcast: async () => ({ ok: false, reason: 'no_specialty' }) });
  const n = await worker.handleStrandedPaidCase({ id: 'ord-1' }, d);
  if (n !== 0) return 'a failed broadcast should count 0 placed';
  const retried = d.events.find((e) => e.type === 'CASE_ROUTING_RETRIED');
  if (!retried) return 'no CASE_ROUTING_RETRIED event was written';
  if (retried.payload.attempt !== 1) return 'attempt should be 1 on the first retry, got ' + retried.payload.attempt;
  if (retried.payload.ok !== false) return 'retry event should record ok:false';
  if (d.ops.length !== 0) return 'ops was alerted on the FIRST failure — must wait for the second';
});

check('second failure: alerts ops on the Activity feed, deduped per order', async () => {
  const d = makeDeps({ priorRetries: 1, broadcast: async () => { throw new Error('db down'); } });
  await worker.handleStrandedPaidCase({ id: 'ord-1' }, d);
  const retried = d.events.find((e) => e.type === 'CASE_ROUTING_RETRIED');
  if (!retried || retried.payload.attempt !== 2) return 'attempt should be 2 on the second retry';
  if (d.ops.length !== 1) return 'ops should be alerted exactly once on the second failure';
  const op = d.ops[0];
  if (op.kind !== 'case_routing_stuck') return 'wrong ops kind: ' + op.kind;
  if (String(op.dedupeKey) !== 'ord-1') return 'ops event not deduped per order';
  if (op.orderId !== 'ord-1') return 'ops event missing orderId (Activity feed link)';
});

check('successful re-broadcast counts as placed and never alerts', async () => {
  const d = makeDeps({ priorRetries: 0, broadcast: async () => ({ ok: true, tier: 'standard', sent: 3 }) });
  const n = await worker.handleStrandedPaidCase({ id: 'ord-1' }, d);
  if (n !== 1) return 'a successful broadcast should count 1 placed';
  const retried = d.events.find((e) => e.type === 'CASE_ROUTING_RETRIED');
  if (!retried || retried.payload.ok !== true) return 'success not recorded on the retry event';
  if (d.ops.length !== 0) return 'ops alerted on a SUCCESSFUL re-broadcast';
});

check('a broadcast that keeps failing keeps alerting only via the deduped ops key', async () => {
  // 3rd attempt still fails → still >= 2, still alerts (pushOpsEvent itself
  // throttles the repeat via its dedupe key; the handler just keeps offering).
  const d = makeDeps({ priorRetries: 2, broadcast: async () => ({ ok: false, reason: 'no_specialty' }) });
  await worker.handleStrandedPaidCase({ id: 'ord-1' }, d);
  if (d.ops.length !== 1) return 'third failure should still offer the (deduped) ops event';
});

// ── STRUCTURAL ───────────────────────────────────────────────────────────────

const src = stripComments(fs.readFileSync(path.join(ROOT, 'src/case_sla_worker.js'), 'utf8'));

check('candidate SELECT carries the exact stranded-paid predicate', () => {
  const m = src.match(/async function fetchStrandedPaidCases[\s\S]*?\n}/);
  if (!m) return 'fetchStrandedPaidCases not found';
  const q = m[0];
  if (!/LOWER\(COALESCE\(status, ''\)\)\s*=\s*'paid'/.test(q)) return "missing LOWER(status)='paid'";
  if (!/doctor_id IS NULL/.test(q)) return 'missing doctor_id IS NULL';
  if (!/acceptance_deadline_at IS NULL/.test(q)) return 'missing acceptance_deadline_at IS NULL';
  if (!/NOT IN \('manual_queue', 'manual_pending', 'manual_claimed'\)/.test(q)) return 'missing manual-queue exclusion';
});

check('the sweep re-broadcasts and records CASE_ROUTING_RETRIED', () => {
  const m = src.match(/async function handleStrandedPaidCase[\s\S]*?\n}\n/);
  if (!m) return 'handleStrandedPaidCase not found';
  const h = m[0];
  if (!/CASE_ROUTING_RETRIED/.test(h)) return 'does not write a CASE_ROUTING_RETRIED event';
  if (!/attempt\s*>=\s*2/.test(h)) return 'ops alert not gated on the second failure (attempt >= 2)';
  if (!/pushOpsEvent|_pushOpsEvent/.test(h)) return 'does not route the ops alert through pushOpsEvent';
});

check('the sweep is wired into the 5-minute tick', () => {
  if (!/stranded\s*=\s*await fetchStrandedPaidCases\(\)/.test(src)) return 'fetchStrandedPaidCases not called in the sweep';
  if (!/handleStrandedPaidCase\(candidate\)/.test(src)) return 'handleStrandedPaidCase not invoked per candidate';
});
