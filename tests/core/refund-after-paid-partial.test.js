// tests/core/refund-after-paid-partial.test.js
//
// Part B item 8 (2026-09-13) — a paid partial refund locked out the remainder.
//
// Migration 083 let a PAID refund row hold the one-refund-per-order slot
// forever (to stop a second full refund). Consequence: once an operator paid
// out a PARTIAL refund — the SLA-breach uplift, a goodwill amount — no second
// refund row could ever be created on that order, on any of the six create
// paths, and the remainder the patient was still owed was unrefundable by
// construction.
//
// Now: migration 107 narrows the slot to OPEN statuses
// ('pending','auto_approved','approved'), and the invariant that actually
// matters — refunds never exceed what was charged — is carried by
// services/refund_eligibility.remainingRefundableEgp (charge minus refunds
// already PAID), applied as the ceiling / default at every create path and
// inside isEligibleForRefund (already_refunded_in_full).
//
// Pure-unit on the helpers with an injected exec + structural pins on the
// migration and every create site. Verified NEGATIVELY: restoring 'paid' to
// admin_refund's BLOCKING list fails its pin; making remainingRefundableEgp
// ignore paid refunds fails the unit case.

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');
const RE = require('../../src/services/refund_eligibility');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n↩️  Part B-8 — a paid partial refund no longer locks out the remainder\n');

const ROOT = path.join(__dirname, '..', '..');
function code(rel) { return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
function raw(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function check(name, fn) {
  try { const why = fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}
async function checkAsync(name, fn) {
  try { const why = await fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}
const execWithPaid = (total) => async () => [{ total }];
const order = { id: 'o1', price: 1000, base_price: 800, urgency_uplift_amount: 200, addons_json: null, payment_status: 'paid', status: 'IN_REVIEW' };

(async () => {
  await checkAsync('unit: remainingRefundableEgp = charge minus refunds already PAID', async () => {
    const r = await RE.remainingRefundableEgp(order, execWithPaid(300));
    if (r !== 700) return 'got ' + r;
  });
  await checkAsync('unit: nothing paid back yet → the whole charge', async () => {
    const r = await RE.remainingRefundableEgp(order, execWithPaid(0));
    if (r !== 1000) return 'got ' + r;
  });
  await checkAsync('unit: paid back in full (or over) → 0, never negative', async () => {
    if (await RE.remainingRefundableEgp(order, execWithPaid(1000)) !== 0) return 'full not 0';
    if (await RE.remainingRefundableEgp(order, execWithPaid(1200)) !== 0) return 'over not 0';
  });
  await checkAsync('unit: piastre arithmetic (999.99 paid of 1000 → 0.01)', async () => {
    const r = await RE.remainingRefundableEgp(order, execWithPaid(999.99));
    if (r !== 0.01) return 'got ' + r;
  });
  await checkAsync('unit: paidRefundedEgp sums status=paid rows only (the SQL says so)', async () => {
    let sql = '';
    await RE.paidRefundedEgp('o1', async (s) => { sql = s; return [{ total: 0 }]; });
    if (!/status = 'paid'/.test(sql)) return 'query does not restrict to paid rows';
    if (!/COALESCE\(amount_egp, approved_amount, requested_amount, 0\)/.test(sql)) return 'COALESCE chain differs from mark-paid / closure';
  });
  await checkAsync('unit: isEligibleForRefund refuses a case whose charge is already fully paid back', async () => {
    const v = await RE.isEligibleForRefund(order, 'p1', execWithPaid(1000));
    if (v.eligible || v.reason !== 'already_refunded_in_full') return JSON.stringify(v);
  });
  await checkAsync('unit: …and passes the remaining amount through when something is still owed', async () => {
    const v = await RE.isEligibleForRefund(order, 'p1', execWithPaid(300));
    if (!v.eligible || v.remainingEgp !== 700 || v.reason !== 'post_in_review_review_required') return JSON.stringify(v);
  });
  await checkAsync('unit: a DB error while establishing the ceiling fails CLOSED', async () => {
    const v = await RE.isEligibleForRefund(order, 'p1', async () => { throw new Error('db down'); });
    if (v.eligible || v.reason !== 'eligibility_check_failed') return JSON.stringify(v);
  });

  check('migration 107 narrows uniq_refunds_open_per_order to OPEN statuses (no paid), with pre- and post-flight', () => {
    const m = raw('src/migrations/107_refunds_open_slot_excludes_paid.sql');
    if (!/DROP INDEX IF EXISTS uniq_refunds_open_per_order;/.test(m)) return 'old index not dropped';
    if (!/CREATE UNIQUE INDEX IF NOT EXISTS uniq_refunds_open_per_order\s+ON refunds\(order_id\)\s+WHERE status IN \('pending', 'auto_approved', 'approved'\);/.test(m)) return 'new predicate wrong';
    if (/WHERE status IN \('pending', 'auto_approved', 'approved', 'paid'\)/.test(m)) return "'paid' still in the predicate";
    if (!/RAISE EXCEPTION/.test(m) || !/^BEGIN;/m.test(m) || !/^COMMIT;/m.test(m)) return 'pre-flight / transaction missing';
  });

  check('no create path still treats a PAID refund as blocking (the four-status list is gone from src/*.js)', () => {
    const hits = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '__tests__' || e.name === 'migrations') continue;
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) walk(rel);
        else if (e.isFile() && e.name.endsWith('.js') && /'pending',\s*'auto_approved',\s*'approved',\s*'paid'/.test(code(rel))) hits.push(rel);
      }
    })('src');
    if (hits.length) return hits.join(', ');
  });

  check('admin_refund: BLOCKING_REFUND_STATUSES is the open set and both ceilings are remainingRefundableEgp', () => {
    const s = code('src/services/admin_refund.js');
    if (!/const BLOCKING_REFUND_STATUSES = \['pending', 'auto_approved', 'approved'\];/.test(s)) return 'blocking list still has paid (or changed shape)';
    if ((s.match(/await remainingRefundableEgp\(order, /g) || []).length !== 2) return 'create + supersede ceilings not both on remaining';
    if (/const maxAmount = maxRefundableEgp\(order\);/.test(s)) return 'a ceiling still uses the raw charge';
  });

  check('patient.js: request form + POST use the remaining amount and the open-set guard', () => {
    const s = code('src/routes/patient.js');
    if ((s.match(/const requestedAmount = await remainingRefundableEgp\(order\);/g) || []).length !== 2) return 'requestedAmount not on remaining at both sites';
    if (/const requestedAmount = maxRefundableEgp\(order\);/.test(s)) return 'a requestedAmount still uses the raw charge';
    if (!/uniq_refunds_\(open\|pending\)_per_order/.test(s)) return 'duplicate-race regex does not match the live index name';
  });

  check('superadmin.js: cancel-with-refund, create form and create POST use the remaining amount', () => {
    const s = code('src/routes/superadmin.js');
    if (!/const remainingEgp = await remainingRefundableEgp\(order\);\s*if \(!existing && remainingEgp > 0\)/.test(s)) return 'cancel-with-refund not gated on remaining';
    if (!/const defaultAmount = await remainingRefundableEgp\(order\);/.test(s)) return 'form default not remaining';
    if (!/const maxAmount = await remainingRefundableEgp\(order\);/.test(s)) return 'POST ceiling not remaining';
    if (/= maxRefundableEgp\(order\);/.test(s)) return 'a superadmin site still uses the raw charge';
  });

  check('api/admin.js: Command-app cancel caps the opened amount at the remaining and opens nothing at 0', () => {
    const s = code('src/routes/api/admin.js');
    if (!/const remainingEgp = await remainingRefundableEgp\(o, /.test(s)) return 'no remaining computed';
    if (!/else if \(remainingEgp <= 0\) \{\s*refund = null;/.test(s)) return 'no zero-remaining branch';
    if (!/Math\.min\(Number\(o\.base_price \|\| 0\) \+ Number\(o\.urgency_uplift_amount \|\| 0\), remainingEgp\)/.test(s)) return 'amount not capped';
    // Slice 1 B5 (2026-09-25): is_practice rides in the same projection so the
    // handler can refuse training cases before any of this money logic runs.
    if (!/price, addons_json, video_consultation_selected, video_consultation_price, is_practice\s+FROM orders WHERE id = \$1 AND deleted_at IS NULL FOR UPDATE/.test(s)) return 'projection lacks the ceiling columns';
  });

  check('sla_breach.js: only an OPEN row blocks the uplift obligation', () => {
    const s = code('src/services/sla_breach.js');
    if ((s.match(/AND status IN \('pending','auto_approved','approved'\)/g) || []).length < 2) return 'pre-check and 23505 diagnostic not both on the open set';
  });
})();
