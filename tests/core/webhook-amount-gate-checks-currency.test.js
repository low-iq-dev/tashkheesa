// tests/core/webhook-amount-gate-checks-currency.test.js
//
// Part B item 9 (2026-09-13) — the Paymob webhook's amount gate compared the
// NUMBER of cents and never the CURRENCY, so a transaction of the same
// numeric amount in a weaker currency would have marked an EGP order paid.
// The gate now requires txn.currency to equal the order's currency (missing
// counts as mismatch), and both currencies are recorded on the
// amount_mismatch payment_event and the order event for triage.
//
// Source-grep — the webhook test proper (tests/core/paymob-webhook.test.js)
// needs a DB. Verified NEGATIVELY: dropping `|| paidCurrency !== owedCurrency`
// fails the first assertion.

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n💱 Part B-9 — webhook amount gate checks the currency too\n');

const ROOT = path.join(__dirname, '..', '..');
const P = stripComments(fs.readFileSync(path.join(ROOT, 'src/routes/payments.js'), 'utf8'));
function check(name, fn) {
  try { const why = fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}

const gate = P.slice(P.indexOf('const owedCents = owedCentsForOrder(order);'), P.indexOf('const owedCents = owedCentsForOrder(order);') + 1200);

check('the mismatch branch fires on a currency mismatch as well as an amount mismatch', () => {
  if (!/if \(!Number\.isFinite\(paidCents\) \|\| paidCents !== owedCents \|\| paidCurrency !== owedCurrency\)/.test(gate)) return 'gate does not compare currency';
});
check('the order currency defaults to EGP and the txn currency defaults to "" (missing = mismatch), both upper-cased', () => {
  if (!/const owedCurrency = String\(order\.currency \|\| 'EGP'\)\.toUpperCase\(\);/.test(gate)) return 'owedCurrency wrong';
  if (!/const paidCurrency = String\(txnBody\.currency \|\| ''\)\.toUpperCase\(\);/.test(gate)) return 'paidCurrency wrong';
});
check('the amount_mismatch payment_event records both currencies', () => {
  if (!/owed_currency: owedCurrency,/.test(gate)) return 'owed_currency missing from the payment_event payload';
  if (!/currency: txnBody\.currency \|\| null,/.test(gate)) return 'paid currency missing from the payment_event payload';
});
check('owedCentsForOrder itself is untouched (do-not-touch zone)', () => {
  const OP = stripComments(fs.readFileSync(path.join(ROOT, 'src/services/order_pricing.js'), 'utf8'));
  if (!/function owedCentsForOrder\(/.test(OP)) return 'owedCentsForOrder moved';
  if (/currency/i.test(OP.slice(OP.indexOf('function owedCentsForOrder('), OP.indexOf('function owedCentsForOrder(') + 1500).replace(/currency: 'EGP'|\/\/[^\n]*/g, ''))) return 'owedCentsForOrder grew a currency branch — it must stay the intention/webhook parity number';
});
