// tests/lint/admin-money-from-real-charge.test.js
//
// AUDIT-ADDONS-IN-ADMIN (2026-08-29) — no admin money figure may come from
// orders.total_price_with_addons.
//
// THE BUG. Every money surface in the Command admin API derived its "grand
// total" from `COALESCE(total_price_with_addons, price)`. That column has 35
// readers across src/ and ZERO writers — there is no INSERT or UPDATE anywhere
// in this codebase that sets it, and it is NULL on every row in production
// (verified 2026-08-29: 39 orders, 0 with a value). So the COALESCE collapsed to
// `o.price` and the add-ons were invisible.
//
// That is not just a display bug. The refund sheet CAPS on grandTotal, so on a
// case with a prescription or a video consultation the operator could not refund
// what the patient had actually been charged — while the server's own ceiling,
// services/refund_eligibility.maxRefundableEgp, would happily have allowed it.
//
// THE RULE. The charged amount comes from services/order_pricing —
// owedCentsForOrder in JS (chargedEgpForOrder) or its SQL mirror
// (chargedEgpSql) — because that is the single source of truth for what Paymob
// was asked to charge and what the webhook verified. And the case payloads must
// ship `maxRefundable`, the server's own ceiling, so the app caps on the exact
// number the server enforces instead of deriving its own.
//
// Comments are stripped first (tests/_helpers/strip-comments): the block above
// and the equally long notes in admin.js explaining why the column is banned
// name it repeatedly, and a naive grep would read its own explanation as a
// violation. That trap has caught three tests in this repo already.

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments, stripSqlComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n🧾 Admin money figures come from the amount actually charged\n');

const ROOT = path.join(__dirname, '..', '..');
const ADMIN_REL = path.join('src', 'routes', 'api', 'admin.js');
const ADMIN = path.join(ROOT, ADMIN_REL);

function check(name, fn) {
  try { fn(); t.pass(fileTag + ': ' + name); }
  catch (e) { t.fail(fileTag + ': ' + name, e); }
}

const adminCode = stripSqlComments(stripComments(fs.readFileSync(ADMIN, 'utf8')));

check('the admin API reads total_price_with_addons nowhere', function () {
  const hits = [];
  adminCode.split('\n').forEach((line, i) => {
    if (line.indexOf('total_price_with_addons') !== -1) hits.push(`line ${i + 1}: ${line.trim()}`);
  });
  if (hits.length) {
    throw new Error(
      ADMIN_REL + ' still reads orders.total_price_with_addons:\n  ' + hits.join('\n  ') +
      '\n\nNothing writes that column, so the value is always NULL and the figure it produces is ' +
      '`price` with every add-on silently dropped. Use services/order_pricing.chargedEgpSql (SQL) ' +
      'or chargedEgpForOrder (JS).'
    );
  }
});

check('order_pricing exports the charged-amount helpers', function () {
  const pricing = require(path.join(ROOT, 'src', 'services', 'order_pricing.js'));
  ['owedCentsForOrder', 'chargedEgpForOrder', 'chargedEgpSql'].forEach((fn) => {
    if (typeof pricing[fn] !== 'function') {
      throw new Error(`src/services/order_pricing.js does not export ${fn}.`);
    }
  });
  // chargedEgpForOrder must literally BE owedCentsForOrder in EGP — the number
  // routes/payments.js charges — not a second pricing rule.
  const order = {
    price: 1600,
    addons_json: JSON.stringify({
      video_consultation: true, video_consultation_price: 300,
      prescription: true, prescription_price: 250,
    }),
  };
  const expected = pricing.owedCentsForOrder(order) / 100;
  if (pricing.chargedEgpForOrder(order) !== expected) {
    throw new Error(
      'chargedEgpForOrder no longer equals owedCentsForOrder / 100. Those two MUST agree: the ' +
      'second is what Paymob was asked to charge and what the webhook verified.'
    );
  }
  if (expected !== 2150) {
    throw new Error(`price 1600 + video 300 + prescription 250 should be 2150 EGP, got ${expected}.`);
  }
});

check('chargedEgpSql mirrors every input owedCentsForOrder reads', function () {
  const { chargedEgpSql } = require(path.join(ROOT, 'src', 'services', 'order_pricing.js'));
  const sql = chargedEgpSql('o.');
  [
    'o.price',
    'o.addons_json',
    'video_consultation',
    'video_consultation_price',
    'prescription',
    'prescription_price',
    // the legacy fallbacks parseSelectedAddons carries
    'o.video_consultation_selected',
    'o.video_consultation_price',
  ].forEach((needle) => {
    if (sql.indexOf(needle) === -1) {
      throw new Error(
        `chargedEgpSql('o.') does not reference ${needle}. It is the SQL transcription of ` +
        'owedCentsForOrder and has to read the same inputs, legacy fallbacks included, or a tile ' +
        'and the row list beneath it will price the same order differently.'
      );
    }
  });
  // The ::jsonb cast must stay gated. addons_json is TEXT with no CHECK; one
  // malformed legacy row would otherwise make the cast throw for the WHOLE
  // query and take the entire money screen down.
  if (sql.indexOf('IS JSON OBJECT') === -1) {
    throw new Error(
      'chargedEgpSql casts addons_json to jsonb without the `IS JSON OBJECT` guard. A single ' +
      'malformed row would then raise for every row in the query.'
    );
  }
});

// ── The payloads the Command app reads ──────────────────────────────────────
function handlerBody(startMarker, endMarker) {
  const a = adminCode.indexOf(startMarker);
  if (a === -1) throw new Error(`handler ${startMarker} not found in ${ADMIN_REL}`);
  const b = endMarker ? adminCode.indexOf(endMarker, a) : -1;
  return adminCode.slice(a, b === -1 ? adminCode.length : b);
}

check('GET /cases/:id exposes maxRefundable from the server-enforced ceiling', function () {
  const body = handlerBody("router.get('/cases/:id'", "router.get('/cases/:id/candidates'");
  if (!/maxRefundable:\s*maxRefundableEgp\(row\)/.test(body)) {
    throw new Error(
      'The case-detail payment payload does not expose `maxRefundable: maxRefundableEgp(row)`. ' +
      'Without it the app has to guess the refund ceiling from grandTotal — and the two are ' +
      'legitimately different on a case whose video consultation the patient has already claimed, ' +
      'so the app would offer a refund the server then rejects.'
    );
  }
  if (!/grandTotal:\s*chargedEgpForOrder\(row\)/.test(body)) {
    throw new Error('The case-detail grandTotal is not chargedEgpForOrder(row) — the amount actually charged.');
  }
});

check('GET /cases rows expose the real charge and the same ceiling', function () {
  const body = handlerBody("router.get('/cases'", "router.get('/cases/:id'");
  if (!/grandTotal:\s*chargedEgpForOrder\(r\)/.test(body)) {
    throw new Error('The /cases queue row grandTotal is not chargedEgpForOrder(r).');
  }
  if (!/maxRefundable:\s*maxRefundableEgp\(r\)/.test(body)) {
    throw new Error(
      'The /cases queue row does not expose maxRefundable. A refund started from the queue would ' +
      'cap on a different number from one started from the detail screen.'
    );
  }
});

check('the row queries actually SELECT every column the pricing helpers read', function () {
  // MONEY_COLS_O is the one fragment; if a query stopped using it, a missing
  // addons_json would silently price every add-on at zero — the exact shape of
  // the bug this file guards.
  if (!/const MONEY_COLS_O\s*=/.test(adminCode)) {
    throw new Error('MONEY_COLS_O is gone. Each money query would then select its own column set.');
  }
  const needed = ['o.price', 'o.base_price', 'o.addons_json', 'o.video_consultation_selected', 'o.video_consultation_price'];
  const frag = adminCode.slice(adminCode.indexOf('const MONEY_COLS_O'), adminCode.indexOf('const MONEY_COLS_O') + 400);
  needed.forEach((c) => {
    if (frag.indexOf(c) === -1) throw new Error(`MONEY_COLS_O no longer selects ${c}.`);
  });
  // Every payload that prices a row must select the fragment.
  const users = (adminCode.match(/\$\{MONEY_COLS_O\}/g) || []).length;
  const pricers = (adminCode.match(/chargedEgpForOrder\(|maxRefundableEgp\(/g) || []).length;
  if (users < 3) {
    throw new Error(
      `only ${users} query/ies select MONEY_COLS_O; expected at least 3 (/cases, /cases/:id, ` +
      '/manual-queue). A row priced from a partially-selected SELECT reports the add-ons as zero.'
    );
  }
  if (pricers < users) {
    throw new Error(`MONEY_COLS_O is selected ${users} time(s) but only ${pricers} call(s) price a row from it.`);
  }
});

check('the collected-revenue tile and the /revenue list sum the same expression', function () {
  // Both must go through CHARGED_EGP / CHARGED_EGP_O, which are chargedEgpSql.
  if (!/const CHARGED_EGP\s*=\s*chargedEgpSql\(''\)/.test(adminCode)
      || !/const CHARGED_EGP_O\s*=\s*chargedEgpSql\('o\.'\)/.test(adminCode)) {
    throw new Error('CHARGED_EGP / CHARGED_EGP_O are no longer built from chargedEgpSql().');
  }
  const refunds = handlerBody("router.get('/refunds'", "router.get('/revenue'");
  if (!/SUM\(\$\{CHARGED_EGP\}\)/.test(refunds)) {
    throw new Error('The collected today/MTD tiles no longer SUM the charged-amount expression.');
  }
  const revenue = handlerBody("router.get('/revenue'", "router.get('/ai-usage'");
  if (!/\$\{CHARGED_EGP_O\} AS charged_egp/.test(revenue) || !/grandTotal\s*=\s*money\(o\.charged_egp\)/.test(revenue)) {
    throw new Error(
      'GET /revenue no longer computes each row from the same charged-amount expression the tile ' +
      'sums. The list total is what the tile links to; they have to be the same arithmetic.'
    );
  }
});
