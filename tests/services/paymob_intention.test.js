// tests/services/paymob_intention.test.js
//
// Focused unit test for src/services/paymob_intention.js — the MOBILE pay-link
// minter used by GET /api/v1/cases/:id/payment.
//
// Proves the two behaviours that fix "Payment link unavailable":
//   1. A fresh unpaid order with a NULL payment_link → mints once → returns a
//      checkoutUrl and persists it on the order.
//   2. A SECOND call (link now set) → returns the SAME checkoutUrl and does NOT
//      call paymobService.createIntention again (idempotent — mint at most once).
//
// Fully mocked — NO DB, NO network. A fake `../pg` and a fake `./paymob` are
// injected into require.cache, the helper is re-required so it binds them, then
// the cache is restored IMMEDIATELY (synchronously) so no other suite file ever
// sees the fakes. Runs in the default suite; also runnable standalone:
//   node tests/services/paymob_intention.test.js

'use strict';

const assert = require('assert');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🔗 services/paymob_intention (mobile pay-link minter)\n');

// ── Mutable fake order/patient rows ───────────────────────────────────────
const orderRow = {
  id: 'ord-mint-1', patient_id: 'pat-mint-1', payment_status: 'unpaid',
  price: 16486, currency: 'EGP', payment_link: null, addons_json: null, service_id: 'svc-1'
};
const patientRow = {
  id: 'pat-mint-1', name: 'Test Patient', email: 't@t.example',
  phone: '+201234567890', country: 'EG', country_code: 'EG'
};

let createIntentionCalls = 0;
const updates = [];
const events = [];

const fakePg = {
  queryOne: async function (sql, params) {
    if (/FROM orders_active/.test(sql)) {
      return (params[0] === orderRow.id && params[1] === orderRow.patient_id) ? { ...orderRow } : null;
    }
    if (/FROM users/.test(sql)) {
      return (params[0] === patientRow.id) ? { ...patientRow } : null;
    }
    return null;
  },
  execute: async function (sql, params) {
    if (/UPDATE orders SET paymob_intention_id/.test(sql)) {
      orderRow.paymob_intention_id = params[0];
      orderRow.payment_link = params[1]; // so the 2nd call takes the idempotent branch
      updates.push(params);
    } else if (/INSERT INTO payment_events/.test(sql)) {
      const m = sql.match(/'(intention_[a-z]+)'/);
      events.push(m ? m[1] : 'unknown');
    }
    return { rowCount: 1 };
  }
};

const fakePaymob = {
  createIntention: async function (_args) {
    createIntentionCalls += 1;
    return {
      intentionId: 'int-' + createIntentionCalls,
      clientSecret: 'cs-' + createIntentionCalls,
      checkoutUrl: 'https://checkout.example/pay/' + createIntentionCalls
    };
  }
};

// ── Inject fakes, load the helper fresh, then restore the cache immediately ──
function fakeMod(p, exports) {
  return { id: p, filename: p, loaded: true, exports: exports, children: [], paths: [] };
}
const pgPath = require.resolve('../../src/pg');
const paymobPath = require.resolve('../../src/services/paymob');
const helperPath = require.resolve('../../src/services/paymob_intention');

const savedPg = require.cache[pgPath];
const savedPaymob = require.cache[paymobPath];
const savedHelper = require.cache[helperPath];

require.cache[pgPath] = fakeMod(pgPath, fakePg);
require.cache[paymobPath] = fakeMod(paymobPath, fakePaymob);
delete require.cache[helperPath];
const { ensurePaymentLinkForOrder } = require(helperPath); // binds the fakes now

// Restore the global cache synchronously — the helper already captured the fakes,
// so restoring here can't rebind it, but it guarantees no other file sees them.
if (savedPg) require.cache[pgPath] = savedPg; else delete require.cache[pgPath];
if (savedPaymob) require.cache[paymobPath] = savedPaymob; else delete require.cache[paymobPath];
if (savedHelper) require.cache[helperPath] = savedHelper; else delete require.cache[helperPath];

module.exports = (async function run() {
  try {
    // 1) Fresh unpaid order, null link → mints exactly once.
    const r1 = await ensurePaymentLinkForOrder({
      orderId: 'ord-mint-1', patientId: 'pat-mint-1', redirectionUrl: 'https://x/return'
    });
    assert(r1 && typeof r1.checkoutUrl === 'string' && /checkout\.example/.test(r1.checkoutUrl),
      'first call returns a checkoutUrl');
    assert.strictEqual(createIntentionCalls, 1, 'createIntention called exactly once');
    assert.strictEqual(orderRow.payment_link, r1.checkoutUrl, 'payment_link persisted on the order');
    assert(events.includes('intention_created'), 'an intention_created payment_events row was written');
    t.pass('mints a link on the first call (unpaid, null payment_link)');

    // 2) Second call — link now set → reuse WITHOUT a second createIntention.
    const r2 = await ensurePaymentLinkForOrder({
      orderId: 'ord-mint-1', patientId: 'pat-mint-1', redirectionUrl: 'https://x/return'
    });
    assert(r2 && r2.checkoutUrl === r1.checkoutUrl, 'second call returns the SAME checkoutUrl');
    assert.strictEqual(createIntentionCalls, 1, 'createIntention NOT called a second time (idempotent)');
    t.pass('reuses the existing link on the second call (no second createIntention)');

    // 3) A paid order short-circuits to { alreadyPaid: true }.
    orderRow.payment_status = 'paid';
    orderRow.payment_link = null; // even with no link, paid wins
    const r3 = await ensurePaymentLinkForOrder({
      orderId: 'ord-mint-1', patientId: 'pat-mint-1', redirectionUrl: 'https://x/return'
    });
    assert(r3 && r3.alreadyPaid === true && !r3.checkoutUrl, 'paid order returns { alreadyPaid: true }');
    assert.strictEqual(createIntentionCalls, 1, 'paid order does not mint');
    t.pass('a paid order returns alreadyPaid and never mints');
  } catch (e) {
    t.fail('paymob_intention mint-once/idempotent', e);
  }
})();
