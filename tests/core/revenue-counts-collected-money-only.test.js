// tests/core/revenue-counts-collected-money-only.test.js
//
// Part B item 7 (2026-09-13) — revenue reports counted uncollected money.
//
// services/superadmin_dashboard.js (the owner cockpit's Finance tab) and
// routes/exports.js (the orders CSV) summed orders.price with no
// payment_status filter: an unpaid submission counted as revenue the moment
// it was created and a refunded one kept counting after the money went back.
// The Command app (routes/api/admin.js) filters payment_status IN
// ('paid','captured'), so the two dashboards disagreed. Both now apply the
// same predicate, inside each aggregate so case COUNTS are unchanged.
//
// Source-grep. Verified NEGATIVELY: dropping the FILTER from one SUM fails
// the first assertion; removing collected_price from the CSV fails the last.

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n💰 Part B-7 — revenue counts collected money only\n');

const ROOT = path.join(__dirname, '..', '..');
function code(rel) { return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
function check(name, fn) {
  try { const why = fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}

const DASH = code('src/services/superadmin_dashboard.js');
const EXP = code('src/routes/exports.js');
const CMD = code('src/routes/api/admin.js');

check('every SUM/AVG over orders.price in the finance tab carries the collected-money predicate', () => {
  const lines = DASH.split('\n').filter((l) => /(SUM|AVG)\((o\.)?price\b/.test(l));
  if (!lines.length) return 'no price aggregates found — has the tab moved?';
  const bare = lines.filter((l) => !/FILTER \(WHERE[^\n]*\$\{COLLECTED(_O)?\}/.test(l));
  if (bare.length) return 'unfiltered:\n    ' + bare.map((l) => l.trim()).join('\n    ');
});

check('the predicate is the Command app\'s (paid/captured), case-folded', () => {
  if (!/const COLLECTED = "LOWER\(COALESCE\(payment_status, ''\)\) IN \('paid','captured'\)"/.test(DASH)) return 'COLLECTED fragment changed';
  if (!/payment_status IN \('paid','captured'\)/.test(CMD)) return 'Command app predicate moved — keep the two in step';
});

check('case counts on the same tab are NOT filtered (only the money is)', () => {
  if (!/COUNT\(\*\) FILTER \(WHERE created_at >= date_trunc\('month', NOW\(\)\)\) AS orders_mtd/.test(DASH)) return 'orders_mtd count changed';
});

check('the orders CSV carries payment_status and a collected_price, and gp is 0 on uncollected orders', () => {
  if (!/AS payment_status,/.test(EXP)) return 'payment_status column missing';
  if (!/THEN COALESCE\(o\.price, 0\) ELSE 0 END AS collected_price/.test(EXP)) return 'collected_price missing';
  if (!/THEN \(COALESCE\(o\.price, 0\) - COALESCE\(o\.doctor_fee, 0\)\) ELSE 0 END AS gp/.test(EXP)) return 'gp still computed on unpaid orders';
  if (!/price,doctor_fee,payment_status,collected_price,gp,reassigned_count/.test(EXP)) return 'CSV header out of step with the columns';
  if (!/r\.payment_status \|\| '',\s*r\.collected_price \?\? 0,\s*r\.gp \?\? 0,/.test(EXP)) return 'CSV row out of step with the header';
});
